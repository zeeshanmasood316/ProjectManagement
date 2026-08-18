'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { requiredString, cleanString, integer } = require('../utils/validation');
const { requireMembership, FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { audit, notifyUser } = require('../notifications/events');
const { channelWithAccess } = require('../services/access');
const { createSseHub } = require('../realtime/sseHub');

const channelHub = createSseHub();

route('GET', '/api/organizations/:organizationId/channels', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const channels = await db.all(
    `SELECT c.*, u.full_name created_by_name,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id=c.id) message_count
     FROM channels c JOIN users u ON u.id=c.created_by
     WHERE c.organization_id=? AND c.archived=0 ORDER BY c.name`,
    [organizationId]
  );
  jsonResponse(res, 200, channels);
});

route('POST', '/api/organizations/:organizationId/channels', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, FULL_ACCESS_ROLES);
  const name = requiredString(body.name, 'Channel name', 2, 60).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
  if (name.length < 2) throw new HttpError(400, 'Channel name must contain letters or numbers');
  const topic = cleanString(body.topic, 240);
  if (await db.get('SELECT id FROM channels WHERE organization_id=? AND name=?', [organizationId, name])) throw new HttpError(409, 'A channel with this name already exists');
  const result = await db.run('INSERT INTO channels(organization_id,name,topic,created_by,created_at) VALUES(?,?,?,?,?)', [organizationId, name, topic, user.id, db.utcnow()]);
  await audit(organizationId, null, user.id, 'channel', result.lastInsertRowid, 'created', { name, topic });
  jsonResponse(res, 201, await db.get('SELECT * FROM channels WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/channels/:channelId/messages', async ({ res, user, params, query }) => {
  const channelId = integer(params.channelId, 'channel id');
  await channelWithAccess(user.id, channelId);
  const before = query.get('before');
  const paramsList = [channelId];
  let condition = '';
  if (before) { condition = 'AND m.id < ?'; paramsList.push(integer(before, 'before')); }
  const items = (await db.all(
    `SELECT m.*,u.username,u.full_name FROM messages m JOIN users u ON u.id=m.user_id
     WHERE m.channel_id=? ${condition} ORDER BY m.id DESC LIMIT 100`,
    paramsList
  )).reverse();
  jsonResponse(res, 200, items);
});

route('GET', '/api/channels/:channelId/messages/stream', async ({ req, res, params, user }) => {
  const channelId = integer(params.channelId, 'channel id');
  await channelWithAccess(user.id, channelId);
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  channelHub.add(channelId, res);
  req.on('close', () => channelHub.remove(channelId, res));
});

route('POST', '/api/channels/:channelId/messages', async ({ res, user, params, body }) => {
  const channelId = integer(params.channelId, 'channel id');
  const { channel } = await channelWithAccess(user.id, channelId);
  const message = requiredString(body.body, 'Message', 1, 4000);
  const result = await db.run('INSERT INTO messages(channel_id,user_id,body,created_at) VALUES(?,?,?,?)', [channelId, user.id, message, db.utcnow()]);
  await audit(channel.organization_id, null, user.id, 'message', result.lastInsertRowid, 'created', { channel_id: channelId });
  const mentionedUsernames = [...new Set([...message.matchAll(/@([a-z0-9._-]{3,40})/gi)].map(match => match[1].toLowerCase()))];
  for (const username of mentionedUsernames) {
    const mentioned = await db.get(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.username=? AND m.organization_id=? AND m.status='active'`, [username, channel.organization_id]);
    if (mentioned && Number(mentioned.id) !== Number(user.id)) await notifyUser(mentioned.id, 'mention', `${user.full_name} mentioned you`, `#${channel.name}: ${message.slice(0, 180)}`, channel.organization_id, 'chat');
  }
  const created = await db.get('SELECT m.*,u.username,u.full_name FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?', [result.lastInsertRowid]);
  channelHub.broadcast(channelId, created);
  jsonResponse(res, 201, created);
});
