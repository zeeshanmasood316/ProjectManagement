'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { requireMembership, membership, ADMIN_ROLES, canManageDepartment } = require('../rbac/permissions');
const { resolveAccessScope, scopeDepartmentList } = require('../rbac/scope');
const { audit } = require('../notifications/events');
const { departmentWithAccess } = require('../services/access');

route('GET', '/api/organizations/:organizationId/departments', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const scope = await resolveAccessScope(user.id, organizationId, member);
  const departments = await db.all(
    `SELECT d.*,u.full_name manager_name,
      (SELECT COUNT(*) FROM memberships m WHERE m.department_id=d.id AND m.status='active') member_count,
      (SELECT COUNT(*) FROM teams t WHERE t.department_id=d.id) team_count
     FROM departments d LEFT JOIN users u ON u.id=d.manager_user_id
     WHERE d.organization_id=? ORDER BY d.name`,
    [organizationId]
  );
  jsonResponse(res, 200, scopeDepartmentList(scope, departments));
});

route('POST', '/api/organizations/:organizationId/departments', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ADMIN_ROLES);
  const name = requiredString(body.name, 'Department name', 2, 120);
  const managerUserId = body.manager_user_id ? integer(body.manager_user_id, 'manager_user_id') : null;
  if (managerUserId && !await membership(managerUserId, organizationId, true)) throw new HttpError(400, 'manager_user_id must be an active organization member');
  const now = db.utcnow();
  let result;
  try {
    result = await db.run('INSERT INTO departments(organization_id,name,description,manager_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', [organizationId, name, cleanString(body.description), managerUserId, now, now]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'A department with this name already exists');
    throw error;
  }
  await audit(organizationId, null, user.id, 'department', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM departments WHERE id=?', [result.lastInsertRowid]));
});

route('PATCH', '/api/departments/:departmentId', async ({ res, user, params, body }) => {
  const departmentId = integer(params.departmentId, 'department id');
  const { department, member } = await departmentWithAccess(user.id, departmentId);
  if (!canManageDepartment(department, member)) throw new HttpError(403, 'Only CEO, admin, or the department manager can edit this department');
  const allowed = {
    name: value => requiredString(value, 'Department name', 2, 120),
    description: value => cleanString(value),
    manager_user_id: value => value ? integer(value, 'manager_user_id') : null
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'manager_user_id') {
        if (!ADMIN_ROLES.includes(member.role)) throw new HttpError(403, 'Only CEO or admin can reassign the department manager');
        if (value && !await membership(value, department.organization_id, true)) throw new HttpError(400, 'manager_user_id must be an active organization member');
      }
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), departmentId);
    await db.run(`UPDATE departments SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(department.organization_id, null, user.id, 'department', departmentId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM departments WHERE id=?', [departmentId]));
});

route('DELETE', '/api/departments/:departmentId', async ({ res, user, params }) => {
  const departmentId = integer(params.departmentId, 'department id');
  const { department } = await departmentWithAccess(user.id, departmentId, ADMIN_ROLES);
  await db.run('UPDATE memberships SET department_id=NULL WHERE department_id=?', [departmentId]);
  await db.run('UPDATE teams SET department_id=NULL WHERE department_id=?', [departmentId]);
  await db.run('UPDATE stories SET department_id=NULL WHERE department_id=?', [departmentId]);
  await db.run('DELETE FROM departments WHERE id=?', [departmentId]);
  await audit(department.organization_id, null, user.id, 'department', departmentId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});
