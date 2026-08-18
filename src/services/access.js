'use strict';

const db = require('../database/client');
const { HttpError } = require('../middleware/http');
const { integer } = require('../utils/validation');
const { requireMembership } = require('../rbac/permissions');
const { resolveAccessScope, projectInScope } = require('../rbac/scope');

async function projectWithAccess(userId, projectId, roles = null) {
  const project = await db.get('SELECT * FROM projects WHERE id=?', [projectId]);
  if (!project) throw new HttpError(404, 'Project not found');
  const member = await requireMembership(userId, Number(project.organization_id), roles);
  const scope = await resolveAccessScope(userId, Number(project.organization_id), member);
  if (!(await projectInScope(scope, projectId))) {
    throw new HttpError(403, 'You do not have access to this project');
  }
  return { project, member, scope };
}

async function briefSessionAccess(userId, session, roles = null) {
  if (session.project_id) {
    const { project, member } = await projectWithAccess(userId, Number(session.project_id), roles);
    return { project, member };
  }
  const member = await requireMembership(userId, Number(session.organization_id), roles);
  const virtualProject = {
    id: null,
    organization_id: Number(session.organization_id),
    name: session.project_name || 'Untitled project',
    objective: '', scope: '', constraints: '', assumptions: ''
  };
  return { project: virtualProject, member };
}

async function channelWithAccess(userId, channelId, roles = null) {
  const channel = await db.get('SELECT * FROM channels WHERE id=? AND archived=0', [channelId]);
  if (!channel) throw new HttpError(404, 'Channel not found');
  const member = await requireMembership(userId, Number(channel.organization_id), roles);
  return { channel, member };
}

async function departmentWithAccess(userId, departmentId, roles = null) {
  const department = await db.get('SELECT * FROM departments WHERE id=?', [departmentId]);
  if (!department) throw new HttpError(404, 'Department not found');
  const member = await requireMembership(userId, Number(department.organization_id), roles);
  return { department, member };
}

async function teamWithAccess(userId, teamId, roles = null) {
  const team = await db.get('SELECT * FROM teams WHERE id=?', [teamId]);
  if (!team) throw new HttpError(404, 'Team not found');
  const member = await requireMembership(userId, Number(team.organization_id), roles);
  return { team, member };
}

async function validTeamId(value, organizationId, field = 'team_id') {
  if (!value) return null;
  const teamId = integer(value, field);
  const team = await db.get('SELECT * FROM teams WHERE id=? AND organization_id=?', [teamId, organizationId]);
  if (!team) throw new HttpError(400, `${field} must reference a team in this organization`);
  return team;
}

async function milestoneWithAccess(userId, milestoneId, roles = null) {
  const milestone = await db.get('SELECT * FROM milestones WHERE id=?', [milestoneId]);
  if (!milestone) throw new HttpError(404, 'Milestone not found');
  const { project } = await projectWithAccess(userId, Number(milestone.project_id), roles);
  return { milestone, project };
}

async function storyWithAccess(userId, storyId, roles = null) {
  const story = await db.get('SELECT * FROM stories WHERE id=?', [storyId]);
  if (!story) throw new HttpError(404, 'Story not found');
  const { project } = await projectWithAccess(userId, Number(story.project_id), roles);
  return { story, project };
}

async function directConversationWithAccess(userId, conversationId) {
  const conversation = await db.get('SELECT * FROM direct_conversations WHERE id=?', [conversationId]);
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  const membershipRow = await db.get('SELECT * FROM direct_conversation_members WHERE conversation_id=? AND user_id=?', [conversationId, userId]);
  if (!membershipRow) throw new HttpError(403, 'You are not part of this conversation');
  return conversation;
}

module.exports = {
  projectWithAccess,
  briefSessionAccess,
  channelWithAccess,
  departmentWithAccess,
  teamWithAccess,
  validTeamId,
  milestoneWithAccess,
  storyWithAccess,
  directConversationWithAccess
};
