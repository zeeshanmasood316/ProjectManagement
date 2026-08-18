'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { requiredString, integer } = require('../utils/validation');
const { taskInScope } = require('../rbac/scope');
const { audit, notifyUser } = require('../notifications/events');
const { projectWithAccess } = require('../services/access');
const { taskDetail } = require('../services/projects');
const { createSseHub } = require('../realtime/sseHub');

const taskCommentHub = createSseHub();

route('GET', '/api/tasks/:taskId/comments', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { scope } = await projectWithAccess(user.id, Number(task.project_id));
  if (!taskInScope(scope, task)) throw new HttpError(403, 'You do not have access to this task');
  const comments = await db.all(
    'SELECT c.*,u.username,u.full_name FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.id',
    [taskId]
  );
  jsonResponse(res, 200, comments);
});

route('GET', '/api/tasks/:taskId/comments/stream', async ({ req, res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { scope } = await projectWithAccess(user.id, Number(task.project_id));
  if (!taskInScope(scope, task)) throw new HttpError(403, 'You do not have access to this task');
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  taskCommentHub.add(taskId, res);
  req.on('close', () => taskCommentHub.remove(taskId, res));
});

route('POST', '/api/tasks/:taskId/comments', async ({ res, user, params, body }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { project, scope } = await projectWithAccess(user.id, Number(task.project_id));
  if (!taskInScope(scope, task)) throw new HttpError(403, 'You do not have access to this task');
  const commentBody = requiredString(body.body, 'Comment', 1, 4000);
  const result = await db.run('INSERT INTO task_comments(task_id,user_id,body,created_at) VALUES(?,?,?,?)', [taskId, user.id, commentBody, db.utcnow()]);
  await audit(project.organization_id, task.project_id, user.id, 'task_comment', result.lastInsertRowid, 'created', { task_id: taskId });
  const mentionedUsernames = [...new Set([...commentBody.matchAll(/@([a-z0-9._-]{3,40})/gi)].map(match => match[1].toLowerCase()))];
  for (const username of mentionedUsernames) {
    const mentioned = await db.get(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.username=? AND m.organization_id=? AND m.status='active'`, [username, project.organization_id]);
    if (mentioned && Number(mentioned.id) !== Number(user.id)) await notifyUser(mentioned.id, 'mention', `${user.full_name} mentioned you`, `${task.title}: ${commentBody.slice(0, 180)}`, project.organization_id, 'work');
  }
  if (task.owner_id && Number(task.owner_id) !== Number(user.id)) {
    await notifyUser(task.owner_id, 'activity', `${user.full_name} commented on ${task.title}`, commentBody.slice(0, 180), project.organization_id, 'work');
  }
  const created = await db.get('SELECT c.*,u.username,u.full_name FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.id=?', [result.lastInsertRowid]);
  taskCommentHub.broadcast(taskId, created);
  jsonResponse(res, 201, created);
});
