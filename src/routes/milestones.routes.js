'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { membership, FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { audit } = require('../notifications/events');
const { projectWithAccess, milestoneWithAccess } = require('../services/access');

route('GET', '/api/projects/:projectId/milestones', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  const milestones = await db.all(
    `SELECT m.*,u.full_name owner_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id=m.id AND t.rejected=0) task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id=m.id AND t.rejected=0 AND t.status='done') done_task_count
     FROM milestones m LEFT JOIN users u ON u.id=m.owner_id
     WHERE m.project_id=? ORDER BY (m.due_date IS NULL),m.due_date,m.id`,
    [projectId]
  );
  jsonResponse(res, 200, milestones);
});

route('POST', '/api/projects/:projectId/milestones', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const name = requiredString(body.name, 'Milestone name', 2, 160);
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Milestone owner must be an active organization member');
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO milestones(project_id,name,description,due_date,owner_id,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [projectId, name, cleanString(body.description), cleanString(body.due_date, 10) || null, ownerId, 'planned', user.id, now, now]
  );
  await audit(project.organization_id, projectId, user.id, 'milestone', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM milestones WHERE id=?', [result.lastInsertRowid]));
});

route('PATCH', '/api/milestones/:milestoneId', async ({ res, user, params, body }) => {
  const milestoneId = integer(params.milestoneId, 'milestone id');
  const { milestone, project } = await milestoneWithAccess(user.id, milestoneId, FULL_ACCESS_ROLES);
  const allowed = {
    name: value => requiredString(value, 'Milestone name', 2, 160),
    description: value => cleanString(value),
    due_date: value => cleanString(value, 10) || null,
    status: value => { if (!['planned', 'in_progress', 'at_risk', 'done'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    owner_id: value => value ? integer(value, 'owner_id') : null
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'owner_id' && value && !await membership(value, project.organization_id, true)) throw new HttpError(400, 'Milestone owner must be an active organization member');
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), milestoneId);
    await db.run(`UPDATE milestones SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(project.organization_id, milestone.project_id, user.id, 'milestone', milestoneId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM milestones WHERE id=?', [milestoneId]));
});

route('DELETE', '/api/milestones/:milestoneId', async ({ res, user, params }) => {
  const milestoneId = integer(params.milestoneId, 'milestone id');
  const { milestone, project } = await milestoneWithAccess(user.id, milestoneId, FULL_ACCESS_ROLES);
  await db.run('UPDATE tasks SET milestone_id=NULL WHERE milestone_id=?', [milestoneId]);
  await db.run('DELETE FROM milestones WHERE id=?', [milestoneId]);
  await audit(project.organization_id, milestone.project_id, user.id, 'milestone', milestoneId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});
