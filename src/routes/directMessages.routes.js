'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { requiredString, integer } = require('../utils/validation');
const { requireMembership, membership } = require('../rbac/permissions');
const { directConversationWithAccess } = require('../services/access');
const { createSseHub } = require('../realtime/sseHub');
const { broadcastToUsers } = require('../realtime/userEvents');

route('GET', '/api/organizations/:organizationId/direct-conversations', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const conversations = await db.all(
    `SELECT dc.id, dc.created_at,
      (SELECT u.id FROM direct_conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=dc.id AND m.user_id<>? LIMIT 1) other_user_id,
      (SELECT last_read_at FROM direct_conversation_members WHERE conversation_id=dc.id AND user_id=?) my_last_read_at
     FROM direct_conversations dc
     WHERE dc.organization_id=? AND EXISTS (SELECT 1 FROM direct_conversation_members m WHERE m.conversation_id=dc.id AND m.user_id=?)`,
    [user.id, user.id, organizationId, user.id]
  );
  const result = [];
  for (const conversation of conversations) {
    const other = conversation.other_user_id ? await db.get('SELECT id,full_name,username,avatar_url FROM users WHERE id=?', [conversation.other_user_id]) : null;
    const lastMessage = await db.get('SELECT body,created_at FROM direct_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1', [conversation.id]);
    const unread = await db.get('SELECT COUNT(*) count FROM direct_messages WHERE conversation_id=? AND created_at > ? AND user_id<>?', [conversation.id, conversation.my_last_read_at || '0000-01-01T00:00:00Z', user.id]);
    result.push({ id: conversation.id, other_user: other, last_message: lastMessage?.body || '', last_message_at: lastMessage?.created_at || conversation.created_at, unread_count: Number(unread.count) });
  }
  result.sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
  jsonResponse(res, 200, result);
});

route('POST', '/api/organizations/:organizationId/direct-conversations', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const targetUserId = integer(body.user_id, 'user_id');
  if (targetUserId === user.id) throw new HttpError(400, 'You cannot start a conversation with yourself');
  if (!await membership(targetUserId, organizationId, true)) throw new HttpError(400, 'That person is not an active member of this organization');
  const existing = await db.get(
    `SELECT dc.id FROM direct_conversations dc
     WHERE dc.organization_id=?
     AND EXISTS (SELECT 1 FROM direct_conversation_members m1 WHERE m1.conversation_id=dc.id AND m1.user_id=?)
     AND EXISTS (SELECT 1 FROM direct_conversation_members m2 WHERE m2.conversation_id=dc.id AND m2.user_id=?)
     AND (SELECT COUNT(*) FROM direct_conversation_members m WHERE m.conversation_id=dc.id)=2`,
    [organizationId, user.id, targetUserId]
  );
  if (existing) { jsonResponse(res, 200, { id: existing.id, created: false }); return; }
  const now = db.utcnow();
  const result = await db.run('INSERT INTO direct_conversations(organization_id,created_at) VALUES(?,?)', [organizationId, now]);
  await db.run('INSERT INTO direct_conversation_members(conversation_id,user_id,last_read_at) VALUES(?,?,?)', [result.lastInsertRowid, user.id, now]);
  await db.run('INSERT INTO direct_conversation_members(conversation_id,user_id,last_read_at) VALUES(?,?,?)', [result.lastInsertRowid, targetUserId, null]);
  jsonResponse(res, 201, { id: result.lastInsertRowid, created: true });
});

route('GET', '/api/direct-conversations/:conversationId/messages', async ({ res, user, params, query }) => {
  const conversationId = integer(params.conversationId, 'conversation id');
  await directConversationWithAccess(user.id, conversationId);
  const parentMessageId = query.get('parent_message_id');
  if (parentMessageId) {
    // Thread view: every reply to one message, oldest first (mirrors channels.routes.js).
    const replies = await db.all(
      `SELECT dm.*,u.username,u.full_name FROM direct_messages dm JOIN users u ON u.id=dm.user_id
       WHERE dm.conversation_id=? AND dm.parent_message_id=? ORDER BY dm.id`,
      [conversationId, integer(parentMessageId, 'parent_message_id')]
    );
    jsonResponse(res, 200, replies);
    return;
  }
  const before = query.get('before');
  const paramsList = [conversationId];
  let condition = '';
  if (before) { condition = 'AND dm.id < ?'; paramsList.push(integer(before, 'before')); }
  const items = (await db.all(
    `SELECT dm.*,u.username,u.full_name FROM direct_messages dm JOIN users u ON u.id=dm.user_id WHERE dm.conversation_id=? ${condition} ORDER BY dm.id DESC LIMIT 100`,
    paramsList
  )).reverse();
  jsonResponse(res, 200, items);
});

const dmHub = createSseHub();

route('GET', '/api/direct-conversations/:conversationId/messages/stream', async ({ req, res, user, params }) => {
  const conversationId = integer(params.conversationId, 'conversation id');
  await directConversationWithAccess(user.id, conversationId);
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  dmHub.add(conversationId, res);
  req.on('close', () => dmHub.remove(conversationId, res));
});

route('POST', '/api/direct-conversations/:conversationId/messages', async ({ res, user, params, body }) => {
  const conversationId = integer(params.conversationId, 'conversation id');
  const conversation = await directConversationWithAccess(user.id, conversationId);
  const messageBody = requiredString(body.body, 'Message', 1, 4000);
  let parentMessageId = null;
  if (body.parent_message_id !== undefined && body.parent_message_id !== null && body.parent_message_id !== '') {
    parentMessageId = integer(body.parent_message_id, 'parent_message_id');
    const parent = await db.get('SELECT id FROM direct_messages WHERE id=? AND conversation_id=?', [parentMessageId, conversationId]);
    if (!parent) throw new HttpError(400, 'parent_message_id must reference a message in the same conversation');
  }
  const result = await db.run('INSERT INTO direct_messages(conversation_id,user_id,body,parent_message_id,created_at) VALUES(?,?,?,?,?)', [conversationId, user.id, messageBody, parentMessageId, db.utcnow()]);
  await db.run('UPDATE direct_conversation_members SET last_read_at=? WHERE conversation_id=? AND user_id=?', [db.utcnow(), conversationId, user.id]);
  const created = await db.get('SELECT dm.*,u.username,u.full_name FROM direct_messages dm JOIN users u ON u.id=dm.user_id WHERE dm.id=?', [result.lastInsertRowid]);
  // Reaches only clients with this exact conversation's stream open (existing behavior).
  dmHub.broadcast(conversationId, created);
  const otherMembers = await db.all('SELECT user_id FROM direct_conversation_members WHERE conversation_id=? AND user_id<>?', [conversationId, user.id]);
  // Rich targeted event (Phase 3, item 11/19), NOT a row in the shared `notifications` table —
  // messages get their own popup + unread system (src/services/messaging.js), never the general
  // Notifications list, per explicit product requirement. Reaches the other conversation member(s)
  // even when they don't have this conversation's own stream open.
  broadcastToUsers(otherMembers.map(item => item.user_id), {
    type: 'message',
    entity: 'direct_message',
    id: created.id,
    organization_id: conversation.organization_id,
    payload: {
      conversation_type: 'dm',
      conversation_id: conversationId,
      sender_name: user.full_name,
      preview: messageBody.slice(0, 180),
      parent_message_id: parentMessageId
    }
  });
  jsonResponse(res, 201, created);
});

route('POST', '/api/direct-conversations/:conversationId/read', async ({ res, user, params }) => {
  const conversationId = integer(params.conversationId, 'conversation id');
  await directConversationWithAccess(user.id, conversationId);
  await db.run('UPDATE direct_conversation_members SET last_read_at=? WHERE conversation_id=? AND user_id=?', [db.utcnow(), conversationId, user.id]);
  jsonResponse(res, 200, { read: true });
});
