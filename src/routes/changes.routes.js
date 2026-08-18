'use strict';

const db = require('../database/client');
const ai = require('../ai/engine');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { isManagerScope } = require('../rbac/scope');
const { audit } = require('../notifications/events');
const { projectWithAccess } = require('../services/access');
const { broadcastToUsers } = require('../realtime/userEvents');

route('POST', '/api/projects/:projectId/changes', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId);
  const title = requiredString(body.title, 'Change title', 2, 220);
  const description = requiredString(body.description, 'Change description', 3, 10000);
  const taskCount = Number((await db.get('SELECT COUNT(*) count FROM tasks WHERE project_id=? AND rejected=0', [projectId]))?.count || 0);
  const ownerCounts = Object.fromEntries((await db.all(
    `SELECT u.full_name name,COUNT(*) count FROM tasks t JOIN users u ON u.id=t.owner_id
     WHERE t.project_id=? AND t.status!='done' AND t.rejected=0 GROUP BY u.id,u.full_name`, [projectId]
  )).map(row => [row.name, Number(row.count)]));
  const existingTasks = await db.all('SELECT id,phase,title,owner_id,priority,status,due_date FROM tasks WHERE project_id=? AND rejected=0 ORDER BY id', [projectId]);
  const aiResult = await ai.analyzeChangeWithAi(description, taskCount, ownerCounts, project, existingTasks);
  const impact = aiResult.item;
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO changes(project_id,title,description,impact_scope,impact_effort,impact_dependencies,impact_workload,status,requested_by,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [projectId, title, description, impact.impact_scope, impact.impact_effort, impact.impact_dependencies, impact.impact_workload, 'pending', cleanString(body.requested_by, 160), user.id, now, now]
  );
  await audit(project.organization_id, projectId, user.id, 'change', result.lastInsertRowid, 'created', { title, impact, provider: aiResult.provider, fallback: aiResult.fallback });
  const createdChange = await db.get('SELECT * FROM changes WHERE id=?', [result.lastInsertRowid]);
  createdChange.ai_provider = aiResult.provider;
  createdChange.fallback_used = aiResult.fallback;
  // Invalidation event only — the actual pending/approved tiering logic is Phase 5's, not this
  // phase's; broadcasting the event itself at the create/approve/reject points that already exist
  // today is all Phase 3 owns here (see plan's "what NOT to touch").
  broadcastToUsers([project.owner_id, user.id], { type: 'change_updated', entity: 'change', id: result.lastInsertRowid, organization_id: project.organization_id, payload: { project_id: projectId, status: createdChange.status } });
  jsonResponse(res, 201, createdChange);
});

route('GET', '/api/projects/:projectId/changes', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) return jsonResponse(res, 200, []);
  jsonResponse(res, 200, await db.all('SELECT * FROM changes WHERE project_id=? ORDER BY created_at DESC', [projectId]));
});

route('POST', '/api/changes/:changeId/:action', async ({ res, user, params }) => {
  const changeId = integer(params.changeId, 'change id');
  const action = cleanString(params.action, 20).toLowerCase();
  if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'Action must be approve or reject');
  const change = await db.get('SELECT * FROM changes WHERE id=?', [changeId]);
  if (!change) throw new HttpError(404, 'Change not found');
  const { project } = await projectWithAccess(user.id, Number(change.project_id), FULL_ACCESS_ROLES);
  await db.run('UPDATE changes SET status=?,updated_at=? WHERE id=?', [action === 'approve' ? 'approved' : 'rejected', db.utcnow(), changeId]);
  await audit(project.organization_id, change.project_id, user.id, 'change', changeId, action + 'd');
  const updatedChange = await db.get('SELECT * FROM changes WHERE id=?', [changeId]);
  broadcastToUsers([project.owner_id, change.created_by, user.id], { type: 'change_updated', entity: 'change', id: changeId, organization_id: project.organization_id, payload: { project_id: Number(change.project_id), status: updatedChange.status } });
  jsonResponse(res, 200, updatedChange);
});
