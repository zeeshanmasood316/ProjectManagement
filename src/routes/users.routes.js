'use strict';

const db = require('../database/client');
const auth = require('../auth/tokens');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer, booleanInt, validateAvatarUrl, workspaceStatus, WORKSPACE_STATUS_PRESETS } = require('../utils/validation');
const { publicUser } = require('../auth/session');
const { activity, settingsForUser } = require('../notifications/events');
const { touchPresence, presenceForUser } = require('../services/organizations');

route('GET', '/api/presence/me', async ({ res, user }) => {
  jsonResponse(res, 200, await presenceForUser(user.id));
});

route('POST', '/api/presence/heartbeat', async ({ res, user }) => {
  jsonResponse(res, 200, await touchPresence(user.id));
});

route('PATCH', '/api/presence/me', async ({ res, user, body }) => {
  const allowedModes = ['auto', 'online', 'away', 'dnd', 'offline'];
  const current = await presenceForUser(user.id);
  const mode = body.presence_mode === undefined ? current.presence_mode : cleanString(body.presence_mode, 20).toLowerCase();
  if (!allowedModes.includes(mode)) throw new HttpError(400, 'Invalid presence mode');
  const selectedStatus = body.status_key === undefined
    ? { key: current.status_key, label: current.status_label, emoji: current.status_emoji }
    : workspaceStatus(body.status_key, body.status_label, body.status_emoji);
  const customStatus = body.custom_status === undefined ? current.custom_status : cleanString(body.custom_status, 120);
  const statusExpiresAt = body.status_expires_at === undefined ? current.status_expires_at : (cleanString(body.status_expires_at, 40) || null);
  if (statusExpiresAt && !Number.isFinite(new Date(statusExpiresAt).getTime())) throw new HttpError(400, 'Status expiry must be a valid date');
  const now = db.utcnow();
  await db.run(
    `INSERT INTO user_presence(user_id,presence_mode,status_key,status_label,status_emoji,custom_status,status_expires_at,last_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET presence_mode=excluded.presence_mode,status_key=excluded.status_key,status_label=excluded.status_label,status_emoji=excluded.status_emoji,custom_status=excluded.custom_status,status_expires_at=excluded.status_expires_at,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
    [user.id, mode, selectedStatus.key, selectedStatus.label, selectedStatus.emoji, customStatus, statusExpiresAt, now, now]
  );
  await activity(user.id, 'status_updated', 'Workspace status updated', `${selectedStatus.emoji} ${selectedStatus.label}`);
  jsonResponse(res, 200, await presenceForUser(user.id));
});

route('PATCH', '/api/users/me/profile', async ({ res, user, body }) => {
  const updates = [];
  const values = [];
  if (body.full_name !== undefined) { updates.push('full_name=?'); values.push(requiredString(body.full_name, 'Full name', 2, 120)); }
  if (body.avatar_url !== undefined) { updates.push('avatar_url=?'); values.push(validateAvatarUrl(body.avatar_url)); }
  if (!updates.length) throw new HttpError(400, 'No supported profile fields were provided');
  updates.push('updated_at=?'); values.push(db.utcnow(), user.id);
  await db.run(`UPDATE users SET ${updates.join(',')} WHERE id=?`, values);
  await activity(user.id, 'profile_updated', 'Profile updated', 'Your name or avatar was updated.');
  jsonResponse(res, 200, publicUser(await db.get('SELECT * FROM users WHERE id=?', [user.id])));
});

route('GET', '/api/users/me/settings', async ({ res, user }) => {
  jsonResponse(res, 200, await settingsForUser(user.id));
});

const DASHBOARD_WIDGET_KEYS = ['summary', 'my_tasks', 'status_overview', 'priority_breakdown', 'assigned_tasks', 'people', 'team_workload'];

route('PATCH', '/api/users/me/settings', async ({ res, user, body }) => {
  const current = await settingsForUser(user.id);
  const theme = body.theme === undefined ? current.theme : cleanString(body.theme, 20).toLowerCase();
  if (!['light', 'dark', 'system'].includes(theme)) throw new HttpError(400, 'Theme must be light, dark, or system');
  const preferenceNames = ['workspace_notifications', 'mention_notifications', 'invitation_notifications', 'activity_notifications'];
  const values = { theme };
  for (const name of preferenceNames) values[name] = body[name] === undefined ? Number(current[name]) : booleanInt(Boolean(body[name]));
  let dashboardLayout = current.dashboard_layout || '';
  if (body.dashboard_layout !== undefined) {
    if (!Array.isArray(body.dashboard_layout)) throw new HttpError(400, 'dashboard_layout must be an array');
    const cleaned = body.dashboard_layout
      .filter(item => item && DASHBOARD_WIDGET_KEYS.includes(item.key))
      .slice(0, DASHBOARD_WIDGET_KEYS.length)
      .map(item => ({ key: item.key, visible: item.visible !== false }));
    dashboardLayout = JSON.stringify(cleaned);
  }
  const now = db.utcnow();
  await db.run(
    `INSERT INTO user_settings(user_id,theme,workspace_notifications,mention_notifications,invitation_notifications,activity_notifications,dashboard_layout,updated_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,workspace_notifications=excluded.workspace_notifications,mention_notifications=excluded.mention_notifications,invitation_notifications=excluded.invitation_notifications,activity_notifications=excluded.activity_notifications,dashboard_layout=excluded.dashboard_layout,updated_at=excluded.updated_at`,
    [user.id, values.theme, values.workspace_notifications, values.mention_notifications, values.invitation_notifications, values.activity_notifications, dashboardLayout, now]
  );
  await activity(user.id, 'settings_updated', 'Settings updated', `Theme: ${theme}`);
  jsonResponse(res, 200, await settingsForUser(user.id));
});

route('GET', '/api/users/me/notifications', async ({ res, user, query }) => {
  const requestedLimit = Number(query.get('limit') || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const items = await db.all(
    `SELECT n.*, o.name organization_name FROM notifications n
     LEFT JOIN organizations o ON o.id=n.organization_id
     WHERE n.user_id=? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    [user.id, limit]
  );
  const unread = await db.get('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL', [user.id]);
  jsonResponse(res, 200, { items, unread_count: Number(unread?.count || 0) });
});

route('PATCH', '/api/notifications/:notificationId/read', async ({ res, user, params }) => {
  const notificationId = integer(params.notificationId, 'notification id');
  const item = await db.get('SELECT * FROM notifications WHERE id=? AND user_id=?', [notificationId, user.id]);
  if (!item) throw new HttpError(404, 'Notification not found');
  if (!item.read_at) await db.run('UPDATE notifications SET read_at=? WHERE id=?', [db.utcnow(), notificationId]);
  jsonResponse(res, 200, await db.get('SELECT * FROM notifications WHERE id=?', [notificationId]));
});

route('POST', '/api/users/me/notifications/read-all', async ({ res, user }) => {
  const result = await db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [db.utcnow(), user.id]);
  jsonResponse(res, 200, { marked_read: result.changes });
});

route('GET', '/api/users/me/activity', async ({ res, user, query }) => {
  const requestedLimit = Number(query.get('limit') || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const items = await db.all(
    `SELECT a.*, o.name organization_name FROM account_activity a
     LEFT JOIN organizations o ON o.id=a.organization_id
     WHERE a.user_id=? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [user.id, limit]
  );
  jsonResponse(res, 200, items);
});

route('GET', '/api/users/me/sessions', async ({ req, res, user }) => {
  const sessions = (await db.all(
    `SELECT id,ip_address,user_agent,created_at,last_seen_at,expires_at,revoked_at
     FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY last_seen_at DESC`,
    [user.id, db.utcnow()]
  )).map(session => ({ ...session, current: session.id === req.authPayload?.sid }));
  jsonResponse(res, 200, sessions);
});

route('DELETE', '/api/users/me/sessions/:sessionId', async ({ req, res, user, params }) => {
  const sessionId = cleanString(params.sessionId, 80);
  const session = await db.get('SELECT * FROM auth_sessions WHERE id=? AND user_id=?', [sessionId, user.id]);
  if (!session) throw new HttpError(404, 'Session not found');
  await db.run('UPDATE auth_sessions SET revoked_at=? WHERE id=?', [db.utcnow(), sessionId]);
  await activity(user.id, 'session_revoked', 'Session signed out', sessionId === req.authPayload?.sid ? 'Current session' : session.user_agent);
  const headers = sessionId === req.authPayload?.sid ? { 'Set-Cookie': auth.clearSessionCookie() } : {};
  jsonResponse(res, 200, { revoked: true, current: sessionId === req.authPayload?.sid }, headers);
});

route('POST', '/api/users/me/sessions/revoke-others', async ({ req, res, user }) => {
  const currentSessionId = req.authPayload?.sid || '';
  const result = await db.run(
    `UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id<>?`,
    [db.utcnow(), user.id, currentSessionId]
  );
  await activity(user.id, 'sessions_revoked', 'Other sessions signed out', `${result.changes} session(s) revoked.`);
  jsonResponse(res, 200, { revoked_count: result.changes });
});

route('GET', '/api/status-presets', async ({ res }) => {
  jsonResponse(res, 200, Object.entries(WORKSPACE_STATUS_PRESETS).map(([key, value]) => ({ key, ...value })));
});
