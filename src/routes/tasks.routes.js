'use strict';

const db = require('../database/client');
const ai = require('../ai/engine');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer, booleanInt } = require('../utils/validation');
const { membership, isFullAccessRole, FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { isManagerScope, scopeTaskList, taskInScope, taskManagedByScope } = require('../rbac/scope');
const { audit } = require('../notifications/events');
const { activeOrganizationMembers } = require('../services/organizations');
const { projectWithAccess, validTeamId } = require('../services/access');
const { taskDetail, ensureBoardColumns } = require('../services/projects');
const { canAssignTask, recordTaskAssignment, validateTaskLink, wouldCreateDependencyCycle } = require('../services/tasks');

route('GET', '/api/projects/:projectId/tasks', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  const allTasks = await db.all(
    `SELECT t.*,u.full_name owner_name,u.username owner_username,tm.name team_name,lead.full_name team_manager_name,s.team_id story_team_id
     FROM tasks t LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN teams tm ON tm.id=t.team_id LEFT JOIN users lead ON lead.id=tm.lead_user_id
     LEFT JOIN stories s ON s.id=t.story_id
     WHERE t.project_id=? AND t.rejected=0 ORDER BY t.phase,t.id`,
    [projectId]
  );
  const tasks = scopeTaskList(scope, allTasks);
  const visibleIds = new Set(tasks.map(task => Number(task.id)));
  const dependencies = await db.all('SELECT d.* FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]);
  const byTask = new Map();
  for (const item of dependencies) {
    if (!visibleIds.has(Number(item.task_id)) || !visibleIds.has(Number(item.depends_on_task_id))) continue;
    const list = byTask.get(Number(item.task_id)) || [];
    list.push(Number(item.depends_on_task_id));
    byTask.set(Number(item.task_id), list);
  }
  tasks.forEach(task => { task.dependencies = byTask.get(Number(task.id)) || []; });
  jsonResponse(res, 200, tasks);
});

route('POST', '/api/projects/:projectId/tasks', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project, scope } = await projectWithAccess(user.id, projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) throw new HttpError(403, 'You do not have permission to create tasks');
  const title = requiredString(body.title, 'Task title', 2, 220);
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
  const priority = ['low', 'medium', 'high', 'critical'].includes(body.priority) ? body.priority : 'medium';
  let status = ['not_started', 'in_progress', 'blocked', 'done'].includes(body.status) ? body.status : 'not_started';
  const progress = Math.min(100, Math.max(0, Number(body.progress || 0)));
  const columnId = body.column_id ? integer(body.column_id, 'column_id') : null;
  let boardPosition = 0;
  if (columnId) {
    const column = await db.get('SELECT * FROM board_columns WHERE id=? AND project_id=?', [columnId, projectId]);
    if (!column) throw new HttpError(400, 'column_id must reference a board column in the same project');
    status = column.maps_to_status;
    const maxPositionRow = await db.get('SELECT COALESCE(MAX(board_position),-1) AS maxPos FROM tasks WHERE column_id=?', [columnId]);
    boardPosition = Number(maxPositionRow.maxPos) + 1;
  }
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,start_date,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at,column_id,board_position)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [projectId, cleanString(body.phase, 120) || 'General', title, cleanString(body.description), ownerId, priority, status, progress, cleanString(body.acceptance_criteria), cleanString(body.due_date, 10) || null, cleanString(body.start_date, 10) || null, 'manual', 0, 1, 0, user.id, now, now, columnId, boardPosition]
  );
  const taskId = result.lastInsertRowid;
  const parentTaskId = await validateTaskLink(projectId, taskId, body.parent_task_id, 'parent_task_id');
  const milestoneId = body.milestone_id ? integer(body.milestone_id, 'milestone_id') : null;
  if (milestoneId && !await db.get('SELECT id FROM milestones WHERE id=? AND project_id=?', [milestoneId, projectId])) throw new HttpError(400, 'milestone_id must reference a milestone in the same project');
  const storyId = body.story_id ? integer(body.story_id, 'story_id') : null;
  if (storyId && !await db.get('SELECT id FROM stories WHERE id=? AND project_id=?', [storyId, projectId])) throw new HttpError(400, 'story_id must reference a story in the same project');
  const team = await validTeamId(body.team_id, project.organization_id);
  if (team && !scope.fullAccess && !scope.managedTeamIds.includes(Number(team.id))) throw new HttpError(403, 'You can only create tasks for a team you manage');
  if (ownerId && !scope.fullAccess && !scope.managedTeamUserIds.has(ownerId)) throw new HttpError(403, 'You can only assign tasks to a worker on your own team');
  if (parentTaskId !== null || milestoneId !== null || storyId !== null || team !== null) await db.run('UPDATE tasks SET parent_task_id=?,milestone_id=?,story_id=?,team_id=? WHERE id=?', [parentTaskId, milestoneId, storyId, team?.id || null, taskId]);
  const dependencyIds = [];
  for (const dependencyId of Array.isArray(body.dependencies) ? body.dependencies : []) {
    const dep = await validateTaskLink(projectId, taskId, dependencyId, 'dependency id');
    if (dep !== null) dependencyIds.push(dep);
  }
  if (dependencyIds.length) {
    for (const dep of dependencyIds) await db.run('INSERT OR IGNORE INTO dependencies(task_id,depends_on_task_id) VALUES(?,?)', [taskId, dep]);
  }
  await audit(project.organization_id, projectId, user.id, 'task', taskId, 'created', body);
  // A task created with an owner already set is an assignment, same as PATCH-ing owner_id later —
  // the new owner must be notified either way, not just when reassigned after the fact.
  if (ownerId) await recordTaskAssignment(project, taskId, user.id, null, ownerId);
  jsonResponse(res, 201, await taskDetail(taskId));
});

route('GET', '/api/tasks/:taskId', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { scope } = await projectWithAccess(user.id, Number(task.project_id));
  if (!taskInScope(scope, task)) throw new HttpError(403, 'You do not have access to this task');
  jsonResponse(res, 200, task);
});

route('GET', '/api/projects/:projectId/board-columns', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  jsonResponse(res, 200, await ensureBoardColumns(projectId));
});

route('POST', '/api/projects/:projectId/board-columns', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  await ensureBoardColumns(projectId);
  const name = requiredString(body.name, 'Column name', 1, 80);
  const mapsToStatus = ['not_started', 'in_progress', 'blocked', 'done'].includes(body.maps_to_status) ? body.maps_to_status : 'not_started';
  const color = cleanString(body.color, 30);
  const maxPositionRow = await db.get('SELECT COALESCE(MAX(position),-1) AS maxPos FROM board_columns WHERE project_id=?', [projectId]);
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO board_columns(project_id,name,color,maps_to_status,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    [projectId, name, color, mapsToStatus, Number(maxPositionRow.maxPos) + 1, now, now]
  );
  await audit(project.organization_id, projectId, user.id, 'board_column', result.lastInsertRowid, 'created', body);
  jsonResponse(res, 201, await db.get('SELECT * FROM board_columns WHERE id=?', [result.lastInsertRowid]));
});

route('PATCH', '/api/board-columns/:columnId', async ({ res, user, params, body }) => {
  const columnId = integer(params.columnId, 'column id');
  const column = await db.get('SELECT * FROM board_columns WHERE id=?', [columnId]);
  if (!column) throw new HttpError(404, 'Column not found');
  const { project } = await projectWithAccess(user.id, Number(column.project_id), FULL_ACCESS_ROLES);
  const fields = [];
  const values = [];
  if (body.name !== undefined) { fields.push('name=?'); values.push(requiredString(body.name, 'Column name', 1, 80)); }
  if (body.color !== undefined) { fields.push('color=?'); values.push(cleanString(body.color, 30)); }
  if (body.position !== undefined) {
    const position = Number(body.position);
    if (!Number.isInteger(position) || position < 0) throw new HttpError(400, 'position must be a non-negative integer');
    fields.push('position=?'); values.push(position);
  }
  let newStatus = null;
  if (body.maps_to_status !== undefined) {
    if (!['not_started', 'in_progress', 'blocked', 'done'].includes(body.maps_to_status)) throw new HttpError(400, 'Invalid maps_to_status');
    newStatus = body.maps_to_status;
    fields.push('maps_to_status=?'); values.push(newStatus);
  }
  if (!fields.length) throw new HttpError(400, 'No changes supplied');
  fields.push('updated_at=?'); values.push(db.utcnow(), columnId);
  await db.run(`UPDATE board_columns SET ${fields.join(',')} WHERE id=?`, values);
  if (newStatus) await db.run('UPDATE tasks SET status=?, updated_at=? WHERE column_id=?', [newStatus, db.utcnow(), columnId]);
  await audit(project.organization_id, column.project_id, user.id, 'board_column', columnId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM board_columns WHERE id=?', [columnId]));
});

route('DELETE', '/api/board-columns/:columnId', async ({ res, user, params, body }) => {
  const columnId = integer(params.columnId, 'column id');
  const column = await db.get('SELECT * FROM board_columns WHERE id=?', [columnId]);
  if (!column) throw new HttpError(404, 'Column not found');
  const { project } = await projectWithAccess(user.id, Number(column.project_id), FULL_ACCESS_ROLES);
  const remainingColumns = await db.get('SELECT COUNT(*) AS count FROM board_columns WHERE project_id=?', [column.project_id]);
  if (Number(remainingColumns.count) <= 1) throw new HttpError(400, 'A board must have at least one column');
  const taskCountRow = await db.get('SELECT COUNT(*) AS count FROM tasks WHERE column_id=? AND rejected=0', [columnId]);
  const taskCount = Number(taskCountRow.count);
  if (taskCount > 0) {
    const targetColumnId = body.move_tasks_to_column_id ? integer(body.move_tasks_to_column_id, 'move_tasks_to_column_id') : null;
    if (!targetColumnId) {
      jsonResponse(res, 409, {
        detail: `This column contains ${taskCount} task${taskCount === 1 ? '' : 's'}. Choose where to move them before deleting.`,
        code: 'COLUMN_HAS_TASKS',
        task_count: taskCount
      });
      return;
    }
    if (targetColumnId === columnId) throw new HttpError(400, 'Choose a different column to move tasks into');
    const targetColumn = await db.get('SELECT * FROM board_columns WHERE id=? AND project_id=?', [targetColumnId, column.project_id]);
    if (!targetColumn) throw new HttpError(400, 'move_tasks_to_column_id must reference a column in the same project');
    const maxPositionRow = await db.get('SELECT COALESCE(MAX(board_position),-1) AS maxPos FROM tasks WHERE column_id=?', [targetColumnId]);
    let nextPosition = Number(maxPositionRow.maxPos) + 1;
    const tasksToMove = await db.all('SELECT id FROM tasks WHERE column_id=? ORDER BY board_position,id', [columnId]);
    for (const task of tasksToMove) {
      await db.run('UPDATE tasks SET column_id=?, board_position=?, status=?, updated_at=? WHERE id=?', [targetColumnId, nextPosition, targetColumn.maps_to_status, db.utcnow(), task.id]);
      nextPosition += 1;
    }
  }
  await db.run('DELETE FROM board_columns WHERE id=?', [columnId]);
  await audit(project.organization_id, column.project_id, user.id, 'board_column', columnId, 'deleted', { moved_task_count: taskCount });
  jsonResponse(res, 200, { ok: true, moved_task_count: taskCount });
});

// Fields a plain Worker may change on a task they own but do not manage — status/progress
// updates and moving their own card between board columns (which just maps to a status change).
const WORKER_SELF_EDIT_FIELDS = new Set(['status', 'progress', 'column_id', 'board_position']);

route('PATCH', '/api/tasks/:taskId', async ({ res, user, params, body }) => {
  const taskId = integer(params.taskId, 'task id');
  const existing = await taskDetail(taskId);
  const { project, member, scope } = await projectWithAccess(user.id, Number(existing.project_id));
  if (!taskInScope(scope, existing)) throw new HttpError(403, 'You do not have access to this task');
  if ((body.approved !== undefined || body.rejected !== undefined) && !isFullAccessRole(member.role)) throw new HttpError(403, 'Only CEO, admin, or moderator can approve/reject AI work');
  let ownerChanged = false;
  let newOwnerId = existing.owner_id;
  if (body.owner_id !== undefined) {
    newOwnerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
    if (newOwnerId && !await membership(newOwnerId, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
    if (!await canAssignTask(existing, member, newOwnerId)) throw new HttpError(403, 'You do not have permission to assign this task.');
    ownerChanged = Number(newOwnerId || 0) !== Number(existing.owner_id || 0);
  }
  // A Worker who owns this task but doesn't manage its team may only move status/progress —
  // every other field (title, description, priority, dates, links, etc.) requires managing the
  // task's team or full-access. (owner_id/approved/rejected are already gated above/below.)
  if (!taskManagedByScope(scope, existing)) {
    const restrictedFields = Object.keys(body).filter(key => !['owner_id', 'approved', 'rejected'].includes(key) && !WORKER_SELF_EDIT_FIELDS.has(key));
    if (restrictedFields.length) throw new HttpError(403, `You can only update status and progress on your own tasks (not: ${restrictedFields.join(', ')})`);
  }
  const allowed = {
    phase: value => cleanString(value, 120) || 'General',
    title: value => requiredString(value, 'Task title', 2, 220),
    description: value => cleanString(value),
    owner_id: value => value ? integer(value, 'owner_id') : null,
    priority: value => { if (!['low', 'medium', 'high', 'critical'].includes(value)) throw new HttpError(400, 'Invalid priority'); return value; },
    status: value => { if (!['not_started', 'in_progress', 'blocked', 'done'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    progress: value => { const output = Number(value); if (!Number.isFinite(output) || output < 0 || output > 100) throw new HttpError(400, 'Progress must be between 0 and 100'); return Math.round(output); },
    acceptance_criteria: value => cleanString(value),
    due_date: value => cleanString(value, 10) || null,
    start_date: value => cleanString(value, 10) || null,
    approved: value => booleanInt(value),
    rejected: value => booleanInt(value)
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (body.team_id !== undefined) {
    if (!isFullAccessRole(member.role)) throw new HttpError(403, 'Only CEO, admin, or moderator can change a task’s team');
    const team = await validTeamId(body.team_id, project.organization_id);
    fields.push('team_id=?'); values.push(team?.id || null);
  }
  if (body.parent_task_id !== undefined) {
    const parentTaskId = await validateTaskLink(Number(existing.project_id), taskId, body.parent_task_id, 'parent_task_id');
    fields.push('parent_task_id=?'); values.push(parentTaskId);
  }
  if (body.milestone_id !== undefined) {
    const milestoneId = body.milestone_id ? integer(body.milestone_id, 'milestone_id') : null;
    if (milestoneId && !await db.get('SELECT id FROM milestones WHERE id=? AND project_id=?', [milestoneId, existing.project_id])) throw new HttpError(400, 'milestone_id must reference a milestone in the same project');
    fields.push('milestone_id=?'); values.push(milestoneId);
  }
  if (body.story_id !== undefined) {
    const storyId = body.story_id ? integer(body.story_id, 'story_id') : null;
    if (storyId && !await db.get('SELECT id FROM stories WHERE id=? AND project_id=?', [storyId, existing.project_id])) throw new HttpError(400, 'story_id must reference a story in the same project');
    fields.push('story_id=?'); values.push(storyId);
  }
  if (body.column_id !== undefined) {
    const columnId = body.column_id ? integer(body.column_id, 'column_id') : null;
    let mapsToStatus = null;
    if (columnId) {
      const column = await db.get('SELECT id, maps_to_status FROM board_columns WHERE id=? AND project_id=?', [columnId, existing.project_id]);
      if (!column) throw new HttpError(400, 'column_id must reference a board column in the same project');
      mapsToStatus = column.maps_to_status;
    }
    fields.push('column_id=?'); values.push(columnId);
    if (mapsToStatus) {
      const statusIndex = fields.indexOf('status=?');
      if (statusIndex !== -1) { fields.splice(statusIndex, 1); values.splice(statusIndex, 1); }
      fields.push('status=?'); values.push(mapsToStatus);
    }
  }
  if (body.board_position !== undefined) {
    const boardPosition = Number(body.board_position);
    if (!Number.isFinite(boardPosition)) throw new HttpError(400, 'board_position must be a number');
    fields.push('board_position=?'); values.push(Math.round(boardPosition));
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), taskId);
    await db.run(`UPDATE tasks SET ${fields.join(',')} WHERE id=?`, values);
  }
  if (Array.isArray(body.dependencies)) {
    const dependencyIds = [];
    for (const dependencyId of body.dependencies) {
      const dep = await validateTaskLink(Number(existing.project_id), taskId, dependencyId, 'dependency id');
      if (dep !== null) dependencyIds.push(dep);
    }
    if (await wouldCreateDependencyCycle(Number(existing.project_id), taskId, dependencyIds)) {
      throw new HttpError(400, 'That dependency would create a circular chain');
    }
    await db.run('DELETE FROM dependencies WHERE task_id=?', [taskId]);
    for (const dep of dependencyIds) await db.run('INSERT OR IGNORE INTO dependencies(task_id,depends_on_task_id) VALUES(?,?)', [taskId, dep]);
  }
  await audit(project.organization_id, existing.project_id, user.id, 'task', taskId, 'updated', body);
  if (ownerChanged) await recordTaskAssignment(project, taskId, user.id, existing.owner_id, newOwnerId);
  jsonResponse(res, 200, await taskDetail(taskId));
});

route('POST', '/api/tasks/bulk-assign', async ({ res, user, body }) => {
  const taskIds = [...new Set((Array.isArray(body.task_ids) ? body.task_ids : []).map(id => integer(id, 'task_ids')))];
  if (!taskIds.length) throw new HttpError(400, 'task_ids must be a non-empty array');
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  const assignedTaskIds = [];
  for (const taskId of taskIds) {
    const existing = await taskDetail(taskId);
    const { project, member } = await projectWithAccess(user.id, Number(existing.project_id));
    if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
    if (!await canAssignTask(existing, member, ownerId)) throw new HttpError(403, `You do not have permission to assign task #${taskId}.`);
    if (Number(ownerId || 0) !== Number(existing.owner_id || 0)) {
      await db.run('UPDATE tasks SET owner_id=?,updated_at=? WHERE id=?', [ownerId, db.utcnow(), taskId]);
      await recordTaskAssignment(project, taskId, user.id, existing.owner_id, ownerId);
    }
    assignedTaskIds.push(taskId);
  }
  jsonResponse(res, 200, { assigned_task_ids: assignedTaskIds, owner_id: ownerId });
});

route('POST', '/api/tasks/:taskId/assign-with-subtasks', async ({ res, user, params, body }) => {
  const taskId = integer(params.taskId, 'task id');
  const existing = await taskDetail(taskId);
  const { project, member } = await projectWithAccess(user.id, Number(existing.project_id));
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
  if (!await canAssignTask(existing, member, ownerId)) throw new HttpError(403, 'You do not have permission to assign this task.');
  if (Number(ownerId || 0) !== Number(existing.owner_id || 0)) {
    await db.run('UPDATE tasks SET owner_id=?,updated_at=? WHERE id=?', [ownerId, db.utcnow(), taskId]);
    await recordTaskAssignment(project, taskId, user.id, existing.owner_id, ownerId);
  }
  const assignedSubtaskIds = [];
  if (body.include_unassigned_subtasks) {
    // Only fills subtasks that have no assignee yet — an existing subtask assignment is never overwritten.
    const subtasks = await db.all('SELECT id,owner_id,team_id FROM tasks WHERE parent_task_id=? AND owner_id IS NULL AND rejected=0', [taskId]);
    for (const subtask of subtasks) {
      if (!await canAssignTask(subtask, member, ownerId)) continue;
      await db.run('UPDATE tasks SET owner_id=?,updated_at=? WHERE id=?', [ownerId, db.utcnow(), subtask.id]);
      await recordTaskAssignment(project, subtask.id, user.id, null, ownerId);
      assignedSubtaskIds.push(subtask.id);
    }
  }
  jsonResponse(res, 200, { task_id: taskId, assigned_subtask_ids: assignedSubtaskIds, owner_id: ownerId });
});

route('POST', '/api/tasks/:taskId/regenerate', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { project } = await projectWithAccess(user.id, Number(task.project_id), FULL_ACCESS_ROLES);
  const aiResult = await ai.regenerateTask(task, project, await activeOrganizationMembers(project.organization_id));
  await db.run('UPDATE tasks SET description=?,acceptance_criteria=?,approved=0,rejected=0,ai_generated=1,updated_at=? WHERE id=?', [aiResult.item.description, aiResult.item.acceptance_criteria, db.utcnow(), taskId]);
  await audit(project.organization_id, task.project_id, user.id, 'task', taskId, 'ai_regenerated', { provider: aiResult.provider, fallback: aiResult.fallback });
  const updated = await taskDetail(taskId);
  updated.ai_provider = aiResult.provider;
  updated.fallback_used = aiResult.fallback;
  jsonResponse(res, 200, updated);
});
