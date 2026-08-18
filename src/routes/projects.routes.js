'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { membership, FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { audit } = require('../notifications/events');
const { projectWithAccess } = require('../services/access');
const { getProject, createPlan, listProjectsForOrganization, PROJECT_PRIORITIES, handleCreateProject } = require('../services/projects');

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
  jsonResponse(res, 200, await getProject(projectId));
});

route('POST', '/api/projects/:projectId/generate-plan', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const result = await createPlan(projectId, user.id, body.brief || '', Boolean(body.replace_unapproved));
  jsonResponse(res, 201, { created_task_ids: result.ids, ai_provider: result.aiResult.provider, fallback_used: result.aiResult.fallback, warning: result.aiResult.warning || null, message: 'AI proposals created. Review and approve or edit them.' });
});
