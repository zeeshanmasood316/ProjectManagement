'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { membership, FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { scopeStoryList } = require('../rbac/scope');
const { audit } = require('../notifications/events');
const { projectWithAccess, storyWithAccess, validTeamId } = require('../services/access');

route('GET', '/api/projects/:projectId/stories', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  const stories = await db.all(
    `SELECT s.*,u.full_name owner_name,d.name department_name,t.name team_name,lead.full_name team_manager_name,
      (SELECT COUNT(*) FROM tasks t2 WHERE t2.story_id=s.id AND t2.rejected=0) task_count,
      (SELECT COUNT(*) FROM tasks t2 WHERE t2.story_id=s.id AND t2.rejected=0 AND t2.status='done') done_task_count
     FROM stories s LEFT JOIN users u ON u.id=s.owner_id LEFT JOIN departments d ON d.id=s.department_id
     LEFT JOIN teams t ON t.id=s.team_id LEFT JOIN users lead ON lead.id=t.lead_user_id
     WHERE s.project_id=? ORDER BY s.position,s.id`,
    [projectId]
  );
  jsonResponse(res, 200, scopeStoryList(scope, stories));
});

route('POST', '/api/projects/:projectId/stories', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const name = requiredString(body.name, 'Story name', 2, 160);
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Story owner must be an active organization member');
  const departmentId = body.department_id ? integer(body.department_id, 'department_id') : null;
  if (departmentId && !await db.get('SELECT id FROM departments WHERE id=? AND organization_id=?', [departmentId, project.organization_id])) throw new HttpError(400, 'department_id must reference a department in this organization');
  const team = await validTeamId(body.team_id, project.organization_id);
  const priority = ['low', 'medium', 'high', 'critical'].includes(body.priority) ? body.priority : 'medium';
  const maxPosition = await db.get('SELECT COALESCE(MAX(position),-1) AS maxPos FROM stories WHERE project_id=?', [projectId]);
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO stories(project_id,name,description,owner_id,department_id,priority,status,start_date,due_date,position,team_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [projectId, name, cleanString(body.description), ownerId, departmentId, priority, 'not_started', cleanString(body.start_date, 10) || null, cleanString(body.due_date, 10) || null, Number(maxPosition.maxPos) + 1, team?.id || null, user.id, now, now]
  );
  await audit(project.organization_id, projectId, user.id, 'story', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM stories WHERE id=?', [result.lastInsertRowid]));
});

route('PATCH', '/api/stories/:storyId', async ({ res, user, params, body }) => {
  const storyId = integer(params.storyId, 'story id');
  const { story, project } = await storyWithAccess(user.id, storyId, FULL_ACCESS_ROLES);
  const allowed = {
    name: value => requiredString(value, 'Story name', 2, 160),
    description: value => cleanString(value),
    priority: value => { if (!['low', 'medium', 'high', 'critical'].includes(value)) throw new HttpError(400, 'Invalid priority'); return value; },
    status: value => { if (!['not_started', 'in_progress', 'at_risk', 'done'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    start_date: value => cleanString(value, 10) || null,
    due_date: value => cleanString(value, 10) || null,
    owner_id: value => value ? integer(value, 'owner_id') : null,
    position: value => { const output = Number(value); if (!Number.isFinite(output)) throw new HttpError(400, 'Invalid position'); return Math.round(output); }
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'owner_id' && value && !await membership(value, project.organization_id, true)) throw new HttpError(400, 'Story owner must be an active organization member');
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (body.department_id !== undefined) {
    const departmentId = body.department_id ? integer(body.department_id, 'department_id') : null;
    if (departmentId && !await db.get('SELECT id FROM departments WHERE id=? AND organization_id=?', [departmentId, project.organization_id])) throw new HttpError(400, 'department_id must reference a department in this organization');
    fields.push('department_id=?'); values.push(departmentId);
  }
  if (body.team_id !== undefined) {
    const team = await validTeamId(body.team_id, project.organization_id);
    fields.push('team_id=?'); values.push(team?.id || null);
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), storyId);
    await db.run(`UPDATE stories SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(project.organization_id, story.project_id, user.id, 'story', storyId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM stories WHERE id=?', [storyId]));
});

route('DELETE', '/api/stories/:storyId', async ({ res, user, params }) => {
  const storyId = integer(params.storyId, 'story id');
  const { story, project } = await storyWithAccess(user.id, storyId, FULL_ACCESS_ROLES);
  await db.run('UPDATE tasks SET story_id=NULL WHERE story_id=?', [storyId]);
  await db.run('DELETE FROM stories WHERE id=?', [storyId]);
  await audit(project.organization_id, story.project_id, user.id, 'story', storyId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});
