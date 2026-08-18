'use strict';

const db = require('../database/client');
const ai = require('../ai/engine');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, integer, booleanInt } = require('../utils/validation');
const { FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { isManagerScope } = require('../rbac/scope');
const { audit } = require('../notifications/events');
const { activeOrganizationMembers } = require('../services/organizations');
const { projectWithAccess } = require('../services/access');

route('POST', '/api/projects/:projectId/risks/scan', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const tasks = await db.all('SELECT * FROM tasks WHERE project_id=? AND rejected=0', [projectId]);
  const dependencies = await db.all('SELECT d.* FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]);
  const aiResult = await ai.scanRisksWithAi(tasks, await activeOrganizationMembers(project.organization_id), dependencies, project);
  const risks = aiResult.items;
  await db.run('DELETE FROM risks WHERE project_id=? AND ai_generated=1 AND approved=0', [projectId]);
  const ids = [];
  for (const item of risks) {
    const inserted = await db.run(
      'INSERT INTO risks(project_id,risk_type,severity,title,description,evidence,status,ai_generated,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [projectId, item.risk_type, item.severity, item.title, item.description, item.evidence, 'open', 1, 0, db.utcnow(), db.utcnow()]
    );
    ids.push(inserted.lastInsertRowid);
  }
  await audit(project.organization_id, projectId, user.id, 'project', projectId, 'risk_scan_completed', { risk_ids: ids, provider: aiResult.provider, fallback: aiResult.fallback });
  jsonResponse(res, 201, { created_risk_ids: ids, count: ids.length, ai_provider: aiResult.provider, fallback_used: aiResult.fallback });
});

route('GET', '/api/projects/:projectId/risks', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) return jsonResponse(res, 200, []);
  jsonResponse(res, 200, await db.all('SELECT * FROM risks WHERE project_id=? ORDER BY status,severity DESC,id DESC', [projectId]));
});

route('PATCH', '/api/risks/:riskId', async ({ res, user, params, body }) => {
  const riskId = integer(params.riskId, 'risk id');
  const risk = await db.get('SELECT * FROM risks WHERE id=?', [riskId]);
  if (!risk) throw new HttpError(404, 'Risk not found');
  const { project } = await projectWithAccess(user.id, Number(risk.project_id), FULL_ACCESS_ROLES);
  const fields = [];
  const values = [];
  if (body.status !== undefined) { fields.push('status=?'); values.push(cleanString(body.status, 30)); }
  if (body.approved !== undefined) { fields.push('approved=?'); values.push(booleanInt(body.approved)); }
  if (!fields.length) throw new HttpError(400, 'No supported risk fields were provided');
  fields.push('updated_at=?'); values.push(db.utcnow(), riskId);
  await db.run(`UPDATE risks SET ${fields.join(',')} WHERE id=?`, values);
  await audit(project.organization_id, risk.project_id, user.id, 'risk', riskId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM risks WHERE id=?', [riskId]));
});
