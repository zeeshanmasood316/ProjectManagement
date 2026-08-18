'use strict';

// Fifth SSE hub (see sseHub.js), keyed by user.id instead of a conversation/task id — one stream
// per signed-in user, carrying cross-cutting events (notifications, task/project/team/invitation/
// change updates, message popups) rather than a single conversation's messages.
//
// Lives in its own module (not inside users.routes.js, where the stream endpoint itself lives) so
// that notifications/events.js and every routes file that needs to push an event can require it
// without creating a require cycle back into users.routes.js.
const { createSseHub } = require('./sseHub');

const userEventHub = createSseHub();

function broadcastToUser(userId, event) {
  if (!userId) return;
  userEventHub.broadcast(Number(userId), event);
}

// Convenience for the common "push the same event to a handful of on-hand user ids" case
// (e.g. a task's previous owner + new owner + project owner). Duplicates are collapsed so a
// user who fills more than one of those roles only gets the event once.
function broadcastToUsers(userIds, event) {
  const seen = new Set();
  for (const rawId of userIds || []) {
    if (!rawId) continue;
    const id = Number(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    broadcastToUser(id, event);
  }
}

module.exports = { userEventHub, broadcastToUser, broadcastToUsers };
