'use strict';

const db = require('../database/client');
const { HttpError } = require('../middleware/http');

// Org-level role sets shared by many route handlers. Extracted from repeated inline
// role-array literals (['ceo','admin'], ['ceo','admin','moderator']) that were scattered
// across server.js — same conditions, just centralized.
const FULL_ACCESS_ROLES = ['ceo', 'admin', 'moderator'];
const ADMIN_ROLES = ['ceo', 'admin'];

async function membership(userId, organizationId, activeOnly = true) {
  const row = await db.get(
    `SELECT m.*, u.username, u.email, u.full_name, o.name organization_name, o.slug organization_slug
     FROM memberships m
     JOIN users u ON u.id=m.user_id
     JOIN organizations o ON o.id=m.organization_id
     WHERE m.user_id=? AND m.organization_id=? ${activeOnly ? "AND m.status='active'" : ''}`,
    [userId, organizationId]
  );
  return row;
}

async function requireMembership(userId, organizationId, roles = null) {
  const item = await membership(userId, organizationId, true);
  if (!item) throw new HttpError(403, 'Active organization membership required');
  if (roles && !roles.includes(item.role)) throw new HttpError(403, 'You do not have permission for this action');
  return item;
}

function roleCanInvite(actorRole, proposedRole) {
  if (actorRole === 'ceo') return ['admin', 'moderator', 'member'].includes(proposedRole);
  if (actorRole === 'admin') return ['moderator', 'member'].includes(proposedRole);
  if (actorRole === 'moderator') return proposedRole === 'member';
  return false;
}

// --- Named predicates replacing scattered ad-hoc inline role checks -------------------
// Each encodes the exact same condition as the inline check it replaces (rename/extract only).

function isFullAccessRole(role) {
  return FULL_ACCESS_ROLES.includes(role);
}

function canManageAdmins(role) {
  return ADMIN_ROLES.includes(role);
}

function isCeoRole(role) {
  return role === 'ceo';
}

function canManageDepartment(department, member) {
  return canManageAdmins(member.role) || Number(department.manager_user_id) === Number(member.user_id);
}

function canManageTeam(team, member) {
  return canManageAdmins(member.role) || Number(team.lead_user_id) === Number(member.user_id);
}

module.exports = {
  FULL_ACCESS_ROLES,
  ADMIN_ROLES,
  membership,
  requireMembership,
  roleCanInvite,
  isFullAccessRole,
  canManageAdmins,
  isCeoRole,
  canManageDepartment,
  canManageTeam
};
