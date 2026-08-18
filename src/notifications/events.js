'use strict';

const db = require('../database/client');
const { cleanString } = require('../utils/validation');

async function settingsForUser(userId) {
  const existing = await db.get('SELECT * FROM user_settings WHERE user_id=?', [userId]);
  if (existing) return existing;
  const now = db.utcnow();
  await db.run('INSERT INTO user_settings(user_id,theme,workspace_notifications,mention_notifications,invitation_notifications,activity_notifications,updated_at) VALUES(?,?,?,?,?,?,?)', [userId, 'light', 1, 1, 1, 1, now]);
  return await db.get('SELECT * FROM user_settings WHERE user_id=?', [userId]);
}

async function activity(userId, activityType, title, detail = '', organizationId = null) {
  await db.run('INSERT INTO account_activity(user_id,organization_id,activity_type,title,detail,created_at) VALUES(?,?,?,?,?,?)', [userId, organizationId, activityType, title, cleanString(detail, 500), db.utcnow()]);
}

async function notifyUser(userId, notificationType, title, body = '', organizationId = null, actionView = '') {
  const settings = await settingsForUser(userId);
  const preference = notificationType === 'invitation' ? 'invitation_notifications'
    : notificationType === 'mention' ? 'mention_notifications'
      : notificationType === 'activity' ? 'activity_notifications' : 'workspace_notifications';
  if (!Number(settings[preference])) return null;
  return (await db.run('INSERT INTO notifications(user_id,organization_id,notification_type,title,body,action_view,created_at) VALUES(?,?,?,?,?,?,?)', [userId, organizationId, notificationType, cleanString(title, 160), cleanString(body, 500), cleanString(actionView, 40), db.utcnow()])).lastInsertRowid;
}

async function notifyOrganizationManagers(organizationId, title, body, excludeUserId = null) {
  const managers = await db.all("SELECT user_id FROM memberships WHERE organization_id=? AND status='active' AND role IN ('ceo','admin')", [organizationId]);
  for (const manager of managers) if (Number(manager.user_id) !== Number(excludeUserId)) await notifyUser(manager.user_id, 'activity', title, body, organizationId, 'admin');
}

async function audit(organizationId, projectId, actorUserId, entityType, entityId, action, details = '') {
  await db.log({ organizationId, projectId, actorUserId, entityType, entityId, action, details });
}

module.exports = { settingsForUser, activity, notifyUser, notifyOrganizationManagers, audit };
