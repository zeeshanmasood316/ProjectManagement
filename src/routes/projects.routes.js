'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { membership, FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { audit } = require('../notifications/events');
const { projectWithAccess } = require('../services/access');
const { getProject, createPlan, listProjectsForOrganization, PROJECT_PRIORITIES, handleCreateProject } = require('../services/projects');
const { broadcastToUsers } = require('../realtime/userEvents');

route('GET', '/api/projects', async ({ res, user, query }) => {
  const organizationId = integer(query.get('organization_id'), 'organization_id');
  jsonResponse(res, 200, await listProjectsForOrganization(user.id, organizationId));
});

route('GET', '/api/organizations/:organizationId/projects', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  jsonResponse(res, 200, await listProjectsForOrganization(user.id, organizationId));
});

route('POST', '/api/projects', async context => {
  const organizationId = integer(context.body.organization_id, 'organization_id');
  await handleCreateProject({ ...context, organizationId });
});

route('POST', '/api/organizations/:organizationId/projects', async context => {
  const organizationId = integer(context.params.organizationId, 'organization id');
  await handleCreateProject({ ...context, organizationId });
});

route('GET', '/api/projects/:projectId', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  jsonResponse(res, 200, await getProject(projectId));
});

route('PATCH', '/api/projects/:projectId', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const allowed = {
    name: value => requiredString(value, 'Project name', 2, 160),
    objective: value => cleanString(value),
    scope: value => cleanString(value),
    constraints: value => cleanString(value),
    assumptions: value => cleanString(value),
    status: value => { if (!['active', 'on_hold', 'completed', 'archived'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    priority: value => { if (!PROJECT_PRIORITIES.includes(value)) throw new HttpError(400, 'Invalid priority'); return value; },
    start_date: value => cleanString(value, 10) || null,
    due_date: value => cleanString(value, 10) || null,
    health_override: value => { if (value && !['healthy', 'at_risk', 'critical'].includes(value)) throw new HttpError(400, 'Invalid health override'); return value || null; },
    owner_id: value => value ? integer(value, 'owner_id') : null
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'owner_id' && value && !await membership(value, project.organization_id, true)) throw new HttpError(400, 'Project owner must be an active organization member');
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), projectId);
    await db.run(`UPDATE projects SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(project.organization_id, projectId, user.id, 'project', projectId, 'updated', body);
  const updatedProject = await getProject(projectId);
  broadcastToUsers([project.owner_id, updatedProject.owner_id, user.id], { type: 'project_updated', entity: 'project', id: projectId, organization_id: project.organization_id, payload: {} });
  jsonResponse(res, 200, updatedProject);
});

// Explicit, ordered manual cascade rather than relying solely on the schema's ON DELETE CASCADE
// declarations — local SQLite has PRAGMA foreign_keys=ON (src/database/client.js) so those would
// cascade there, but the Turso/libsql connection path never sets that pragma, so a bare
// `DELETE FROM projects` could silently leave orphaned rows in production. This works correctly
// regardless of which backend or pragma state is active, and only ever touches rows scoped to
// this one project — never users, teams, departments, memberships, or channels.
route('DELETE', '/api/projects/:projectId', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const confirmName = cleanString(body?.confirm_name, 160);
  if (confirmName !== project.name) throw new HttpError(400, 'Type the exact project name to confirm deletion');
  await db.transaction(async () => {
    await db.run('DELETE FROM dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) OR depends_on_task_id IN (SELECT id FROM tasks WHERE project_id=?)', [projectId, projectId]);
    await db.run('DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)', [projectId]);
    await db.run('DELETE FROM updates WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM suggestions WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM changes WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM decisions WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM risks WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM tasks WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM stories WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM milestones WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM board_columns WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM source_records WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM ai_brief_sessions WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM audit_log WHERE project_id=?', [projectId]);
    await db.run('DELETE FROM projects WHERE id=?', [projectId]);
  });
  // Recorded after the transaction, with project_id left null (the project — and its own audit
  // history — no longer exists) but the name/id preserved in details so the deletion itself
  // remains a permanent, organization-level record.
  await audit(project.organization_id, null, user.id, 'project', projectId, 'deleted', { name: project.name, project_id: projectId });
  jsonResponse(res, 200, { removed: true });
});

route('POST', '/api/projects/:projectId/generate-plan', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const result = await createPlan(projectId, user.id, body.brief || '', Boolean(body.replace_unapproved));
  jsonResponse(res, 201, { created_task_ids: result.ids, ai_provider: result.aiResult.provider, fallback_used: result.aiResult.fallback, warning: result.aiResult.warning || null, message: 'AI proposals created. Review and approve or edit them.' });
});
