'use strict';

const db = require('../database/client');
const { HttpError } = require('../middleware/http');
const { integer } = require('../utils/validation');
const { isFullAccessRole } = require('../rbac/permissions');
const { activity, audit, notifyUser } = require('../notifications/events');

// ADMIN/PROJECT MANAGER (ceo/admin/moderator) can always assign. A TEAM MANAGER (the lead of the
// task's own team) may only assign within their own team. A plain WORKER can never assign work.
async function canAssignTask(task, member, targetOwnerId) {
  if (isFullAccessRole(member.role)) return true;
  if (!task.team_id) return false;
  const team = await db.get('SELECT * FROM teams WHERE id=?', [task.team_id]);
  if (!team) return false;
  const isLead = Number(team.lead_user_id) === Number(member.user_id);
  // A department manager also manages every team under their department, not only teams they
  // personally lead — matches resolveAccessScope()'s managedTeamIds expansion for the same reason.
  const isDepartmentManager = team.department_id
    ? Boolean(await db.get('SELECT 1 found FROM departments WHERE id=? AND manager_user_id=?', [team.department_id, member.user_id]))
    : false;
  if (!isLead && !isDepartmentManager) return false;
  if (!targetOwnerId) return true;
  return Boolean(await db.get('SELECT id FROM team_members WHERE team_id=? AND user_id=?', [task.team_id, targetOwnerId]));
}

async function recordTaskAssignment(project, taskId, actorUserId, previousOwnerId, newOwnerId) {
  await audit(project.organization_id, project.id, actorUserId, 'task', taskId, 'assigned', { previous_owner_id: previousOwnerId || null, new_owner_id: newOwnerId || null });
  if (newOwnerId && Number(newOwnerId) !== Number(actorUserId)) {
    const task = await db.get('SELECT title FROM tasks WHERE id=?', [taskId]);
    const verb = previousOwnerId ? 'reassigned to you' : 'assigned to you';
    await notifyUser(newOwnerId, 'task_assignment', previousOwnerId ? 'Task reassigned to you' : 'New task assigned to you', `"${task?.title || 'A task'}" was ${verb}.`, project.organization_id, `work:${taskId}`);
    await activity(newOwnerId, 'task_assigned', previousOwnerId ? 'Task reassigned to you' : 'New task assigned to you', task?.title || '', project.organization_id);
  }
}

async function validateTaskLink(projectId, taskId, value, field) {
  if (!value) return null;
  const linked = integer(value, field);
  if (linked === taskId) throw new HttpError(400, `${field} cannot reference the task itself`);
  const row = await db.get('SELECT id FROM tasks WHERE id=? AND project_id=?', [linked, projectId]);
  if (!row) throw new HttpError(400, `${field} must reference a task in the same project`);
  return linked;
}

async function wouldCreateDependencyCycle(projectId, taskId, newDependsOn) {
  const rows = await db.all('SELECT d.task_id,d.depends_on_task_id FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]);
  const graph = new Map();
  for (const row of rows) {
    const list = graph.get(Number(row.task_id)) || [];
    list.push(Number(row.depends_on_task_id));
    graph.set(Number(row.task_id), list);
  }
  graph.set(taskId, newDependsOn.map(Number));
  const visiting = new Set();
  const visited = new Set();
  const hasCycle = node => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) || []) if (hasCycle(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return hasCycle(taskId);
}

module.exports = { canAssignTask, recordTaskAssignment, validateTaskLink, wouldCreateDependencyCycle };
