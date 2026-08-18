'use strict';

const db = require('../database/client');
const { HttpError, jsonResponse } = require('../middleware/http');
const ai = require('../ai/engine');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { membership, requireMembership, FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { resolveAccessScope, scopeProjectList } = require('../rbac/scope');
const { audit } = require('../notifications/events');
const { activeOrganizationMembers } = require('./organizations');

async function getProject(projectId) {
  const project = await db.get('SELECT * FROM projects WHERE id=?', [projectId]);
  if (!project) throw new HttpError(404, 'Project not found');
  project.team_members = await activeOrganizationMembers(project.organization_id);
  project.sources = await db.all('SELECT * FROM source_records WHERE project_id=? ORDER BY created_at DESC', [projectId]);
  return project;
}

async function taskDetail(taskId) {
  const task = await db.get(
    `SELECT t.*,u.full_name owner_name,u.username owner_username,tm.name team_name,lead.id team_manager_id,lead.full_name team_manager_name,s.team_id story_team_id
     FROM tasks t LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN teams tm ON tm.id=t.team_id LEFT JOIN users lead ON lead.id=tm.lead_user_id
     LEFT JOIN stories s ON s.id=t.story_id
     WHERE t.id=?`,
    [taskId]
  );
  if (!task) throw new HttpError(404, 'Task not found');
  task.dependencies = (await db.all('SELECT depends_on_task_id FROM dependencies WHERE task_id=?', [taskId])).map(item => Number(item.depends_on_task_id));
  return task;
}

const DEFAULT_BOARD_COLUMNS = [
  { name: 'Not Started', maps_to_status: 'not_started', color: '' },
  { name: 'In Progress', maps_to_status: 'in_progress', color: '' },
  { name: 'Blocked', maps_to_status: 'blocked', color: '' },
  { name: 'Done', maps_to_status: 'done', color: '' }
];

async function ensureBoardColumns(projectId) {
  let columns = await db.all('SELECT * FROM board_columns WHERE project_id=? ORDER BY position,id', [projectId]);
  if (!columns.length) {
    const now = db.utcnow();
    for (let index = 0; index < DEFAULT_BOARD_COLUMNS.length; index += 1) {
      const preset = DEFAULT_BOARD_COLUMNS[index];
      await db.run('INSERT INTO board_columns(project_id,name,color,maps_to_status,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [projectId, preset.name, preset.color, preset.maps_to_status, index, now, now]);
    }
    columns = await db.all('SELECT * FROM board_columns WHERE project_id=? ORDER BY position,id', [projectId]);
  }
  const orphanTasks = await db.all('SELECT id, status FROM tasks WHERE project_id=? AND column_id IS NULL AND rejected=0 ORDER BY id', [projectId]);
  if (orphanTasks.length) {
    const byStatus = new Map(columns.map(column => [column.maps_to_status, column]));
    const nextPosition = new Map();
    for (const column of columns) {
      const maxRow = await db.get('SELECT COALESCE(MAX(board_position),-1) AS maxPos FROM tasks WHERE column_id=?', [column.id]);
      nextPosition.set(column.id, Number(maxRow.maxPos) + 1);
    }
    for (const task of orphanTasks) {
      const column = byStatus.get(task.status) || columns[0];
      const position = nextPosition.get(column.id) ?? 0;
      nextPosition.set(column.id, position + 1);
      await db.run('UPDATE tasks SET column_id=?, board_position=? WHERE id=?', [column.id, position, task.id]);
    }
  }
  return columns;
}

async function createPlan(projectId, actorUserId, brief = '', replaceUnapproved = false) {
  const project = await getProject(projectId);
  if (replaceUnapproved) await db.run('DELETE FROM tasks WHERE project_id=? AND ai_generated=1 AND approved=0', [projectId]);
  let sourceBrief = cleanString(brief, 20000);
  if (!sourceBrief) {
    const source = await db.get("SELECT content FROM source_records WHERE project_id=? AND record_type='project_brief' ORDER BY id DESC LIMIT 1", [projectId]);
    sourceBrief = source?.content || '';
  }
  if (sourceBrief) await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [projectId, 'plan_input', sourceBrief, actorUserId, db.utcnow()]);
  const members = await activeOrganizationMembers(project.organization_id);
  const aiResult = await ai.generatePlan(project, members, sourceBrief);
  const proposals = aiResult.items;
  const created = await db.transaction(async () => {
    const ids = [];
    for (const proposal of proposals) {
      const inserted = await db.run(
        `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [projectId, proposal.phase, proposal.title, proposal.description, proposal.owner_id, proposal.priority, proposal.status, proposal.progress, proposal.acceptance_criteria, proposal.due_date, 'ai_plan', 1, 0, 0, actorUserId, db.utcnow(), db.utcnow()]
      );
      ids.push(inserted.lastInsertRowid);
    }
    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index];
      for (const dependencyIndex of proposal.depends_on_proposal_indexes || []) {
        if (ids[dependencyIndex] && ids[dependencyIndex] !== ids[index]) {
          await db.run('INSERT OR IGNORE INTO dependencies(task_id,depends_on_task_id) VALUES(?,?)', [ids[index], ids[dependencyIndex]]);
        }
      }
    }
    return ids;
  });
  await audit(project.organization_id, projectId, actorUserId, 'project', projectId, 'ai_plan_generated', { created_task_ids: created, provider: aiResult.provider, fallback: aiResult.fallback });
  return { ids: created, aiResult };
}

async function projectReport(projectId) {
  const project = await getProject(projectId);
  const tasks = await db.all(
    `SELECT t.*,u.full_name owner_name FROM tasks t LEFT JOIN users u ON u.id=t.owner_id
     WHERE t.project_id=? AND t.rejected=0 ORDER BY t.id`,
    [projectId]
  );
  const blockers = tasks.filter(task => task.status === 'blocked');
  const approvedTasks = tasks.filter(task => Number(task.approved) === 1);
  const complete = approvedTasks.filter(task => task.status === 'done');
  const overall = approvedTasks.length ? Math.round(approvedTasks.reduce((sum, task) => sum + Number(task.progress), 0) / approvedTasks.length) : 0;
  return {
    generated_at: db.utcnow(),
    project: { id: project.id, name: project.name, objective: project.objective, scope: project.scope, status: project.status },
    overall_progress_percent: overall,
    approved_task_count: approvedTasks.length,
    completed_task_count: complete.length,
    blockers,
    open_risks: await db.all("SELECT * FROM risks WHERE project_id=? AND status='open' ORDER BY severity DESC,id DESC", [projectId]),
    approved_decisions: await db.all("SELECT * FROM decisions WHERE project_id=? AND status='approved' ORDER BY created_at DESC", [projectId]),
    pending_changes: await db.all("SELECT * FROM changes WHERE project_id=? AND status='pending' ORDER BY created_at DESC", [projectId]),
    recent_updates: await db.all('SELECT * FROM updates WHERE project_id=? ORDER BY created_at DESC LIMIT 20', [projectId]),
    reliability_note: 'Progress, completion, blockers, decisions, and changes are assembled from stored records. AI-generated items remain unapproved until an authorized human reviews them.'
  };
}

async function listProjectsForOrganization(userId, organizationId) {
  const member = await requireMembership(userId, organizationId);
  const scope = await resolveAccessScope(userId, organizationId, member);
  const projects = await db.all(
    `SELECT p.*,u.full_name created_by_name,o.full_name owner_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.rejected=0) task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.rejected=0 AND t.status='done') done_task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.rejected=0 AND t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date<date('now')) overdue_task_count,
      (SELECT COUNT(*) FROM risks r WHERE r.project_id=p.id AND r.status='open') open_risk_count
     FROM projects p JOIN users u ON u.id=p.created_by
     LEFT JOIN users o ON o.id=p.owner_id
     WHERE p.organization_id=? ORDER BY p.updated_at DESC`,
    [organizationId]
  );
  return await scopeProjectList(scope, projects);
}

const PROJECT_PRIORITIES = ['low', 'medium', 'high', 'critical'];

async function handleCreateProject({ res, user, body, organizationId }) {
  await requireMembership(user.id, organizationId, FULL_ACCESS_ROLES);
  const name = requiredString(body.name, 'Project name', 2, 160);
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : user.id;
  if (ownerId !== user.id && !await membership(ownerId, organizationId, true)) throw new HttpError(400, 'Project owner must be an active organization member');
  const priority = PROJECT_PRIORITIES.includes(body.priority) ? body.priority : 'medium';
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO projects(organization_id,name,objective,scope,constraints,assumptions,status,owner_id,priority,start_date,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [organizationId, name, cleanString(body.objective), cleanString(body.scope), cleanString(body.constraints), cleanString(body.assumptions), 'active', ownerId, priority, cleanString(body.start_date, 10) || null, cleanString(body.due_date, 10) || null, user.id, now, now]
  );
  const brief = cleanString(body.brief, 20000);
  if (brief) await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [result.lastInsertRowid, 'project_brief', brief, user.id, now]);
  await audit(organizationId, result.lastInsertRowid, user.id, 'project', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await getProject(result.lastInsertRowid));
}

module.exports = {
  getProject,
  taskDetail,
  DEFAULT_BOARD_COLUMNS,
  ensureBoardColumns,
  createPlan,
  projectReport,
  listProjectsForOrganization,
  PROJECT_PRIORITIES,
  handleCreateProject
};
