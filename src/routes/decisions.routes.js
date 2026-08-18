'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { isManagerScope } = require('../rbac/scope');
const { audit } = require('../notifications/events');
const { projectWithAccess } = require('../services/access');

route('POST', '/api/projects/:projectId/decisions', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const result = await db.run('INSERT INTO decisions(project_id,title,detail,owner,status,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', [projectId, requiredString(body.title, 'Decision title', 2, 220), requiredString(body.detail, 'Decision detail', 3, 10000), cleanString(body.owner, 160), 'approved', 'manual', user.id, db.utcnow()]);
  await audit(project.organization_id, projectId, user.id, 'decision', result.lastInsertRowid, 'created');
  jsonResponse(res, 201, await db.get('SELECT * FROM decisions WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/projects/:projectId/decisions', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) return jsonResponse(res, 200, []);
  jsonResponse(res, 200, await db.all('SELECT * FROM decisions WHERE project_id=? ORDER BY created_at DESC', [projectId]));
});
