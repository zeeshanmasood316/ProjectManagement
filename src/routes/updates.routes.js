'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { audit } = require('../notifications/events');
const { projectWithAccess } = require('../services/access');

route('POST', '/api/projects/:projectId/updates', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId);
  const taskId = body.task_id ? integer(body.task_id, 'task_id') : null;
  if (taskId && !await db.get('SELECT id FROM tasks WHERE id=? AND project_id=?', [taskId, projectId])) throw new HttpError(400, 'Task does not belong to this project');
  const result = await db.run('INSERT INTO updates(project_id,task_id,note,update_type,created_by,created_at) VALUES(?,?,?,?,?,?)', [projectId, taskId, requiredString(body.note, 'Update note', 2, 10000), cleanString(body.update_type, 40) || 'progress', user.id, db.utcnow()]);
  await audit(project.organization_id, projectId, user.id, 'update', result.lastInsertRowid, 'created');
  jsonResponse(res, 201, await db.get('SELECT * FROM updates WHERE id=?', [result.lastInsertRowid]));
});
