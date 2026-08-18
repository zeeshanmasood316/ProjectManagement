'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { requiredString, integer } = require('../utils/validation');
const { requireMembership, ADMIN_ROLES } = require('../rbac/permissions');
const { audit } = require('../notifications/events');

route('GET', '/api/organizations/:organizationId/job-roles', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  jsonResponse(res, 200, await db.all('SELECT * FROM job_roles WHERE organization_id=? ORDER BY name', [organizationId]));
});

route('POST', '/api/organizations/:organizationId/job-roles', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ADMIN_ROLES);
  const name = requiredString(body.name, 'Job role name', 2, 80);
  const now = db.utcnow();
  let result;
  try {
    result = await db.run('INSERT INTO job_roles(organization_id,name,created_at) VALUES(?,?,?)', [organizationId, name, now]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'This job role already exists');
    throw error;
  }
  await audit(organizationId, null, user.id, 'job_role', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM job_roles WHERE id=?', [result.lastInsertRowid]));
});

route('DELETE', '/api/job-roles/:jobRoleId', async ({ res, user, params }) => {
  const jobRoleId = integer(params.jobRoleId, 'job role id');
  const jobRole = await db.get('SELECT * FROM job_roles WHERE id=?', [jobRoleId]);
  if (!jobRole) throw new HttpError(404, 'Job role not found');
  await requireMembership(user.id, Number(jobRole.organization_id), ADMIN_ROLES);
  await db.run('UPDATE memberships SET job_role_id=NULL WHERE job_role_id=?', [jobRoleId]);
  await db.run('DELETE FROM job_roles WHERE id=?', [jobRoleId]);
  await audit(jobRole.organization_id, null, user.id, 'job_role', jobRoleId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});
