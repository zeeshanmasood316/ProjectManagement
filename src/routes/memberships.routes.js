'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer, normalizeDepartment } = require('../utils/validation');
const { requireMembership, membership, roleCanInvite, FULL_ACCESS_ROLES, ADMIN_ROLES, isCeoRole } = require('../rbac/permissions');
const { audit, activity, notifyUser, notifyOrganizationManagers } = require('../notifications/events');
const { organizationMembers } = require('../services/organizations');
const { broadcastToUsers } = require('../realtime/userEvents');

// Invalidation event (Phase 3, item 10): lets the invitations/setup screen (either the invited
// user's onboarding screen or a manager's org invitations list) update live instead of only on
// manual refresh. Broadcast to whichever of these two users are on hand at each lifecycle point.
function broadcastInvitationUpdated(organizationId, invitationId, status, userIds) {
  broadcastToUsers(userIds, { type: 'invitation_updated', entity: 'invitation', id: invitationId, organization_id: organizationId, payload: { status } });
}

route('GET', '/api/invitations/me', async ({ res, user }) => {
  const items = await db.all(
    `SELECT i.*, o.name organization_name, o.slug organization_slug, inviter.full_name invited_by_name
     FROM invitations i JOIN organizations o ON o.id=i.organization_id JOIN users inviter ON inviter.id=i.invited_by
     WHERE i.invited_user_id=? AND i.status IN ('invited','awaiting_approval') ORDER BY i.created_at DESC`,
    [user.id]
  );
  jsonResponse(res, 200, items);
});

route('POST', '/api/organizations/:organizationId/invitations', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const actor = await requireMembership(user.id, organizationId, FULL_ACCESS_ROLES);
  const identifier = requiredString(body.identifier, 'Username or email', 3, 160).toLowerCase();
  const proposedRole = cleanString(body.proposed_role || 'member', 20).toLowerCase();
  const proposedDepartment = normalizeDepartment(body.proposed_department);
  if (!roleCanInvite(actor.role, proposedRole)) throw new HttpError(403, `A ${actor.role} cannot invite this role`);
  const invitedUser = await db.get('SELECT * FROM users WHERE username=? OR email=?', [identifier, identifier]);
  if (!invitedUser) throw new HttpError(404, 'No registered user matches that username or email');
  if (Number(invitedUser.id) === Number(user.id)) throw new HttpError(400, 'You cannot invite yourself');
  if (await membership(invitedUser.id, organizationId, false)) throw new HttpError(409, 'This user already has a membership in the organization');
  if (await db.get("SELECT id FROM invitations WHERE organization_id=? AND invited_user_id=? AND status IN ('invited','awaiting_approval')", [organizationId, invitedUser.id])) throw new HttpError(409, 'An active invitation already exists for this user');
  const now = db.utcnow();
  const result = await db.run('INSERT INTO invitations(organization_id,invited_user_id,invited_by,proposed_role,proposed_department,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [organizationId, invitedUser.id, user.id, proposedRole, proposedDepartment, 'invited', now, now]);
  await audit(organizationId, null, user.id, 'invitation', result.lastInsertRowid, 'created', { invited_user_id: invitedUser.id, proposed_role: proposedRole, proposed_department: proposedDepartment });
  const organization = await db.get('SELECT name FROM organizations WHERE id=?', [organizationId]);
  await notifyUser(invitedUser.id, 'invitation', `Invitation to ${organization.name}`, `${user.full_name} invited you as ${proposedRole} in ${proposedDepartment}.`, organizationId, 'notifications');
  await activity(user.id, 'invitation_sent', 'Invitation sent', `Invited ${invitedUser.full_name} to ${organization.name}.`, organizationId);
  broadcastInvitationUpdated(organizationId, result.lastInsertRowid, 'invited', [invitedUser.id, user.id]);
  jsonResponse(res, 201, await db.get('SELECT * FROM invitations WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/organizations/:organizationId/invitations', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, FULL_ACCESS_ROLES);
  const items = await db.all(
    `SELECT i.*, invited.username invited_username, invited.email invited_email, invited.full_name invited_name,
            inviter.full_name invited_by_name, approver.full_name approved_by_name
     FROM invitations i
     JOIN users invited ON invited.id=i.invited_user_id
     JOIN users inviter ON inviter.id=i.invited_by
     LEFT JOIN users approver ON approver.id=i.approved_by
     WHERE i.organization_id=? ORDER BY i.created_at DESC`,
    [organizationId]
  );
  jsonResponse(res, 200, items);
});

route('POST', '/api/invitations/:invitationId/accept', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation || Number(invitation.invited_user_id) !== Number(user.id)) throw new HttpError(404, 'Invitation not found');
  if (invitation.status !== 'invited') throw new HttpError(409, 'Invitation cannot be accepted in its current state');
  const now = db.utcnow();
  await db.run("UPDATE invitations SET status='awaiting_approval',user_responded_at=?,updated_at=? WHERE id=?", [now, now, invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'accepted_awaiting_approval');
  const organization = await db.get('SELECT name FROM organizations WHERE id=?', [invitation.organization_id]);
  await activity(user.id, 'invitation_accepted', 'Invitation accepted', `Waiting for approval to join ${organization.name}.`, invitation.organization_id);
  await notifyOrganizationManagers(invitation.organization_id, 'Invitation awaiting approval', `${user.full_name} accepted an invitation and is waiting for access approval.`, user.id);
  broadcastInvitationUpdated(invitation.organization_id, invitationId, 'awaiting_approval', [user.id, invitation.invited_by]);
  jsonResponse(res, 200, { message: 'Invitation accepted. CEO or admin approval is still required.', status: 'awaiting_approval' });
});

route('POST', '/api/invitations/:invitationId/decline', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation || Number(invitation.invited_user_id) !== Number(user.id)) throw new HttpError(404, 'Invitation not found');
  if (!['invited', 'awaiting_approval'].includes(invitation.status)) throw new HttpError(409, 'Invitation cannot be declined in its current state');
  await db.run("UPDATE invitations SET status='declined',user_responded_at=?,updated_at=? WHERE id=?", [db.utcnow(), db.utcnow(), invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'declined');
  await activity(user.id, 'invitation_declined', 'Invitation declined', 'You declined an organization invitation.', invitation.organization_id);
  await notifyUser(invitation.invited_by, 'activity', 'Invitation declined', `${user.full_name} declined the invitation.`, invitation.organization_id, 'admin');
  broadcastInvitationUpdated(invitation.organization_id, invitationId, 'declined', [user.id, invitation.invited_by]);
  jsonResponse(res, 200, { status: 'declined' });
});

route('POST', '/api/invitations/:invitationId/approve', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  const actor = await requireMembership(user.id, Number(invitation.organization_id), ADMIN_ROLES);
  if (invitation.status !== 'awaiting_approval') throw new HttpError(409, 'The invited user must accept before CEO/admin approval');
  if (!roleCanInvite(actor.role, invitation.proposed_role)) throw new HttpError(403, 'You cannot approve the proposed role');
  const now = db.utcnow();
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO memberships(organization_id,user_id,role,department,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,department=excluded.department,status='active',updated_at=excluded.updated_at`,
      [invitation.organization_id, invitation.invited_user_id, invitation.proposed_role, normalizeDepartment(invitation.proposed_department), 'active', now, now]
    );
    await db.run("UPDATE invitations SET status='approved',approved_by=?,approved_at=?,updated_at=? WHERE id=?", [user.id, now, now, invitationId]);
  });
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'approved_membership_created', { role: invitation.proposed_role, department: normalizeDepartment(invitation.proposed_department) });
  const approvedOrganization = await db.get('SELECT name FROM organizations WHERE id=?', [invitation.organization_id]);
  await notifyUser(invitation.invited_user_id, 'invitation', `Access approved for ${approvedOrganization.name}`, `Your ${invitation.proposed_role} membership is now active.`, invitation.organization_id, 'dashboard');
  await activity(invitation.invited_user_id, 'membership_approved', 'Organization access approved', approvedOrganization.name, invitation.organization_id);
  await activity(user.id, 'membership_approved', 'Member access approved', `Approved user ${invitation.invited_user_id}.`, invitation.organization_id);
  broadcastInvitationUpdated(invitation.organization_id, invitationId, 'approved', [invitation.invited_user_id, user.id]);
  jsonResponse(res, 200, { status: 'approved', membership: await membership(invitation.invited_user_id, invitation.organization_id, false) });
});

route('POST', '/api/invitations/:invitationId/reject', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  await requireMembership(user.id, Number(invitation.organization_id), ADMIN_ROLES);
  if (!['invited', 'awaiting_approval'].includes(invitation.status)) throw new HttpError(409, 'Invitation cannot be rejected in its current state');
  await db.run("UPDATE invitations SET status='rejected',approved_by=?,approved_at=?,updated_at=? WHERE id=?", [user.id, db.utcnow(), db.utcnow(), invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'rejected');
  await notifyUser(invitation.invited_user_id, 'invitation', 'Organization invitation rejected', 'Your request to join was not approved.', invitation.organization_id, 'notifications');
  await activity(invitation.invited_user_id, 'membership_rejected', 'Organization access rejected', 'An organization invitation was rejected.', invitation.organization_id);
  broadcastInvitationUpdated(invitation.organization_id, invitationId, 'rejected', [invitation.invited_user_id, user.id]);
  jsonResponse(res, 200, { status: 'rejected' });
});

route('POST', '/api/invitations/:invitationId/cancel', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  const actor = await requireMembership(user.id, Number(invitation.organization_id), FULL_ACCESS_ROLES);
  if (!roleCanInvite(actor.role, invitation.proposed_role)) throw new HttpError(403, 'You cannot cancel an invitation for this role');
  if (!['invited', 'awaiting_approval'].includes(invitation.status)) throw new HttpError(409, 'Invitation cannot be cancelled in its current state');
  await db.run("UPDATE invitations SET status='cancelled',updated_at=? WHERE id=?", [db.utcnow(), invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'cancelled');
  await notifyUser(invitation.invited_user_id, 'invitation', 'Invitation cancelled', 'An organization invitation was cancelled by a manager.', invitation.organization_id, 'notifications');
  broadcastInvitationUpdated(invitation.organization_id, invitationId, 'cancelled', [invitation.invited_user_id, user.id]);
  jsonResponse(res, 200, { status: 'cancelled' });
});

route('PATCH', '/api/memberships/:membershipId', async ({ res, user, params, body }) => {
  const membershipId = integer(params.membershipId, 'membership id');
  const target = await db.get('SELECT * FROM memberships WHERE id=?', [membershipId]);
  if (!target) throw new HttpError(404, 'Membership not found');
  const actor = await requireMembership(user.id, Number(target.organization_id), ADMIN_ROLES);
  if (isCeoRole(target.role)) throw new HttpError(403, 'CEO membership cannot be modified');
  const updates = [];
  const values = [];
  if (body.role !== undefined) {
    const role = cleanString(body.role, 20).toLowerCase();
    if (!['admin', 'moderator', 'member'].includes(role)) throw new HttpError(400, 'Invalid role');
    if (actor.role !== 'ceo' && (target.role === 'admin' || role === 'admin')) throw new HttpError(403, 'Only the CEO can manage admin access');
    updates.push('role=?'); values.push(role);
  }
  if (body.department !== undefined) {
    updates.push('department=?'); values.push(normalizeDepartment(body.department));
  }
  if (body.department_id !== undefined) {
    const departmentId = body.department_id ? integer(body.department_id, 'department_id') : null;
    if (departmentId && !await db.get('SELECT id FROM departments WHERE id=? AND organization_id=?', [departmentId, target.organization_id])) throw new HttpError(400, 'department_id must reference a department in this organization');
    updates.push('department_id=?'); values.push(departmentId);
  }
  if (body.manager_user_id !== undefined) {
    const managerUserId = body.manager_user_id ? integer(body.manager_user_id, 'manager_user_id') : null;
    if (managerUserId && !await membership(managerUserId, target.organization_id, true)) throw new HttpError(400, 'manager_user_id must be an active organization member');
    if (managerUserId === Number(target.user_id)) throw new HttpError(400, 'A person cannot be their own manager');
    updates.push('manager_user_id=?'); values.push(managerUserId);
  }
  if (body.job_role_id !== undefined) {
    const jobRoleId = body.job_role_id ? integer(body.job_role_id, 'job_role_id') : null;
    if (jobRoleId && !await db.get('SELECT id FROM job_roles WHERE id=? AND organization_id=?', [jobRoleId, target.organization_id])) throw new HttpError(400, 'job_role_id must reference a job role in this organization');
    updates.push('job_role_id=?'); values.push(jobRoleId);
  }
  if (body.status !== undefined) {
    const status = cleanString(body.status, 20).toLowerCase();
    if (!['active', 'suspended'].includes(status)) throw new HttpError(400, 'Invalid membership status');
    if (actor.role !== 'ceo' && target.role === 'admin') throw new HttpError(403, 'Only the CEO can suspend an admin');
    updates.push('status=?'); values.push(status);
  }
  if (!updates.length) throw new HttpError(400, 'No supported membership fields were provided');
  updates.push('updated_at=?'); values.push(db.utcnow(), membershipId);
  await db.run(`UPDATE memberships SET ${updates.join(',')} WHERE id=?`, values);
  await audit(target.organization_id, null, user.id, 'membership', membershipId, 'updated', body);
  const updatedOrganization = await db.get('SELECT name FROM organizations WHERE id=?', [target.organization_id]);
  await notifyUser(target.user_id, 'activity', 'Membership updated', `Your role, department, or access in ${updatedOrganization.name} changed.`, target.organization_id, 'profile');
  await activity(target.user_id, 'membership_updated', 'Membership updated', updatedOrganization.name, target.organization_id);
  jsonResponse(res, 200, (await organizationMembers(target.organization_id, false)).find(item => Number(item.membership_id) === membershipId));
});

route('DELETE', '/api/memberships/:membershipId', async ({ res, user, params }) => {
  const membershipId = integer(params.membershipId, 'membership id');
  const target = await db.get('SELECT * FROM memberships WHERE id=?', [membershipId]);
  if (!target) throw new HttpError(404, 'Membership not found');
  const actor = await requireMembership(user.id, Number(target.organization_id), ADMIN_ROLES);
  if (isCeoRole(target.role)) throw new HttpError(403, 'CEO membership cannot be removed');
  if (actor.role !== 'ceo' && target.role === 'admin') throw new HttpError(403, 'Only the CEO can remove an admin');
  await db.run('DELETE FROM memberships WHERE id=?', [membershipId]);
  await audit(target.organization_id, null, user.id, 'membership', membershipId, 'removed', { user_id: target.user_id });
  const removedOrganization = await db.get('SELECT name FROM organizations WHERE id=?', [target.organization_id]);
  await notifyUser(target.user_id, 'activity', 'Removed from organization', `Your membership in ${removedOrganization.name} was removed.`, target.organization_id, 'notifications');
  await activity(target.user_id, 'membership_removed', 'Organization membership removed', removedOrganization.name, target.organization_id);
  jsonResponse(res, 200, { removed: true });
});
