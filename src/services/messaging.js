'use strict';

// Shared unread-message math for the Phase 3 "separate message unread system" (never mixed with
// the general `notifications` table — see src/routes/directMessages.routes.js and
// src/routes/channels.routes.js, which stopped/never started writing 'message' notification rows).
// DMs already track a per-member `last_read_at` (direct_conversation_members); channels get an
// equivalent per-user marker via the new `channel_reads` table (src/database/schema.js).

const db = require('../database/client');

async function dmUnreadCount(userId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(
        (SELECT COUNT(*) FROM direct_messages dm
         WHERE dm.conversation_id = dcm.conversation_id AND dm.user_id <> ?
           AND dm.created_at > COALESCE(dcm.last_read_at, '0000-01-01T00:00:00Z'))
      ), 0) AS unread
     FROM direct_conversation_members dcm WHERE dcm.user_id = ?`,
    [userId, userId]
  );
  return Number(row?.unread || 0);
}

async function channelUnreadCount(userId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(
        (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.user_id <> ?
           AND m.created_at > COALESCE((SELECT last_read_at FROM channel_reads cr WHERE cr.channel_id = c.id AND cr.user_id = ?), '0000-01-01T00:00:00Z'))
      ), 0) AS unread
     FROM channels c
     JOIN memberships mem ON mem.organization_id = c.organization_id AND mem.user_id = ? AND mem.status = 'active'
     WHERE c.archived = 0`,
    [userId, userId, userId]
  );
  return Number(row?.unread || 0);
}

async function unreadMessageSummary(userId) {
  const [dmUnread, channelUnread] = await Promise.all([dmUnreadCount(userId), channelUnreadCount(userId)]);
  return { dm_unread_count: dmUnread, channel_unread_count: channelUnread, total_unread_count: dmUnread + channelUnread };
}

module.exports = { dmUnreadCount, channelUnreadCount, unreadMessageSummary };
