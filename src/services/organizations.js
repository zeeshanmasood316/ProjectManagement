'use strict';

// Cross-domain organization/member/presence lookups shared by organizations, memberships,
// projects, briefs, tasks, and auth route handlers.

const db = require('../database/client');

async function organizationSummary(userId) {
  return await db.all(
    `SELECT o.*, m.id membership_id, m.role, m.status membership_status
     FROM memberships m JOIN organizations o ON o.id=m.organization_id
     WHERE m.user_id=? ORDER BY o.name`,
    [userId]
  );
}

const PRESENCE_STATUS_SQL = `
  CASE
    WHEN m.status <> 'active' THEN 'offline'
    WHEN COALESCE(p.presence_mode, 'auto') = 'offline' THEN 'offline'
    WHEN COALESCE(p.presence_mode, 'auto') = 'dnd' THEN 'dnd'
    WHEN COALESCE(p.presence_mode, 'auto') = 'away' THEN 'away'
    WHEN p.last_seen_at IS NULL THEN 'offline'
    WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 120 THEN 'online'
    WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 900 THEN 'away'
    ELSE 'offline'
  END`;

async function organizationMembers(organizationId, activeOnly = false) {
  return await db.all(
    `SELECT m.id membership_id, m.organization_id, m.user_id, m.role, m.department, m.status, m.joined_at, m.updated_at,
            m.department_id, m.manager_user_id, m.job_role_id,
            u.username, u.email, u.full_name, u.avatar_url,
            d.name department_name, mgr.full_name manager_name, jr.name job_role_name,
            COALESCE(p.presence_mode, 'auto') presence_mode,
            COALESCE(p.status_key, 'available') status_key,
            COALESCE(p.status_label, 'Available') status_label,
            COALESCE(p.status_emoji, '🟢') status_emoji,
            COALESCE(p.custom_status, '') custom_status,
            p.status_expires_at, p.last_seen_at,
            ${PRESENCE_STATUS_SQL} current_status,
            5 AS capacity
     FROM memberships m
     JOIN users u ON u.id=m.user_id
     LEFT JOIN user_presence p ON p.user_id=u.id
     LEFT JOIN departments d ON d.id=m.department_id
     LEFT JOIN users mgr ON mgr.id=m.manager_user_id
     LEFT JOIN job_roles jr ON jr.id=m.job_role_id
     WHERE m.organization_id=? ${activeOnly ? "AND m.status='active'" : ''}
     ORDER BY CASE m.role WHEN 'ceo' THEN 1 WHEN 'admin' THEN 2 WHEN 'moderator' THEN 3 ELSE 4 END, u.full_name`,
    [organizationId]
  );
}

async function activeOrganizationMembers(organizationId) {
  return await organizationMembers(organizationId, true);
}

async function activeOrganizationTeams(organizationId) {
  return await db.all(
    `SELECT t.id,t.name,t.lead_user_id,d.name department_name
     FROM teams t LEFT JOIN departments d ON d.id=t.department_id
     WHERE t.organization_id=? AND t.status='active' ORDER BY t.name`,
    [organizationId]
  );
}

async function touchPresence(userId) {
  const now = db.utcnow();
  await db.run(
    `INSERT INTO user_presence(user_id,presence_mode,status_key,status_label,status_emoji,custom_status,status_expires_at,last_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
    [userId, 'auto', 'available', 'Available', '🟢', '', null, now, now]
  );
  return await presenceForUser(userId);
}

// NOTE: intentionally NOT sharing PRESENCE_STATUS_SQL — this query has no `memberships` table
// join (no `m` alias in scope), so PRESENCE_STATUS_SQL's `WHEN m.status <> 'active'` branch would
// reference an undefined alias if reused here. Kept as its own near-duplicate CASE expression.
async function presenceForUser(userId) {
  return await db.get(
    `SELECT u.id user_id, COALESCE(p.presence_mode, 'auto') presence_mode,
            COALESCE(p.status_key, 'available') status_key,
            COALESCE(p.status_label, 'Available') status_label,
            COALESCE(p.status_emoji, '🟢') status_emoji,
            COALESCE(p.custom_status, '') custom_status, p.status_expires_at, p.last_seen_at,
            CASE
              WHEN COALESCE(p.presence_mode, 'auto') = 'offline' THEN 'offline'
              WHEN COALESCE(p.presence_mode, 'auto') = 'dnd' THEN 'dnd'
              WHEN COALESCE(p.presence_mode, 'auto') = 'away' THEN 'away'
              WHEN p.last_seen_at IS NULL THEN 'offline'
              WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 120 THEN 'online'
              WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 900 THEN 'away'
              ELSE 'offline'
            END current_status
     FROM users u LEFT JOIN user_presence p ON p.user_id=u.id WHERE u.id=?`,
    [userId]
  );
}

module.exports = {
  organizationSummary,
  organizationMembers,
  activeOrganizationMembers,
  activeOrganizationTeams,
  touchPresence,
  presenceForUser
};
