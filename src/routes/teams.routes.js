'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { requireMembership, membership, canManageAdmins, canManageDepartment, canManageTeam } = require('../rbac/permissions');
const { resolveAccessScope, scopeTeamList } = require('../rbac/scope');
const { audit } = require('../notifications/events');
const { teamWithAccess } = require('../services/access');
const { broadcastToUsers } = require('../realtime/userEvents');

route('GET', '/api/organizations/:organizationId/teams', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const scope = await resolveAccessScope(user.id, organizationId, member);
  const teams = await db.all(
    `SELECT t.*,d.name department_name,u.full_name lead_name,
      (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id=t.id) member_count
     FROM teams t LEFT JOIN departments d ON d.id=t.department_id LEFT JOIN users u ON u.id=t.lead_user_id
     WHERE t.organization_id=? ORDER BY t.name`,
    [organizationId]
  );
  jsonResponse(res, 200, scopeTeamList(scope, teams));
});

route('POST', '/api/organizations/:organizationId/teams', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const name = requiredString(body.name, 'Team name', 2, 120);
  const departmentId = body.department_id ? integer(body.department_id, 'department_id') : null;
  let department = null;
  if (departmentId) {
    department = await db.get('SELECT * FROM departments WHERE id=? AND organization_id=?', [departmentId, organizationId]);
    if (!department) throw new HttpError(400, 'department_id must reference a department in this organization');
  }
  if (!canManageAdmins(member.role) && !(department && canManageDepartment(department, member))) throw new HttpError(403, 'Only CEO, admin, or the managing department head can create a team');
  const leadUserId = body.lead_user_id ? integer(body.lead_user_id, 'lead_user_id') : null;
  if (leadUserId && !await membership(leadUserId, organizationId, true)) throw new HttpError(400, 'lead_user_id must be an active organization member');
  const now = db.utcnow();
  let result;
  try {
    result = await db.run('INSERT INTO teams(organization_id,department_id,name,description,lead_user_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [organizationId, departmentId, name, cleanString(body.description), leadUserId, 'active', now, now]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'A team with this name already exists');
    throw error;
  }
  await audit(organizationId, null, user.id, 'team', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM teams WHERE id=?', [result.lastInsertRowid]));
});

route('PATCH', '/api/teams/:teamId', async ({ res, user, params, body }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  if (!canManageTeam(team, member)) throw new HttpError(403, 'Only CEO, admin, or the team lead can edit this team');
  const allowed = {
    name: value => requiredString(value, 'Team name', 2, 120),
    description: value => cleanString(value),
    status: value => { if (!['active', 'archived'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    department_id: value => value ? integer(value, 'department_id') : null,
    lead_user_id: value => value ? integer(value, 'lead_user_id') : null
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'department_id' && value && !await db.get('SELECT id FROM departments WHERE id=? AND organization_id=?', [value, team.organization_id])) throw new HttpError(400, 'department_id must reference a department in this organization');
      if (key === 'lead_user_id' && value && !await membership(value, team.organization_id, true)) throw new HttpError(400, 'lead_user_id must be an active organization member');
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), teamId);
    await db.run(`UPDATE teams SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(team.organization_id, null, user.id, 'team', teamId, 'updated', body);
  const updatedTeam = await db.get('SELECT * FROM teams WHERE id=?', [teamId]);
  broadcastToUsers([team.lead_user_id, updatedTeam.lead_user_id], { type: 'team_updated', entity: 'team', id: teamId, organization_id: team.organization_id, payload: {} });
  jsonResponse(res, 200, updatedTeam);
});

route('DELETE', '/api/teams/:teamId', async ({ res, user, params }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  if (!canManageTeam(team, member)) throw new HttpError(403, 'Only CEO, admin, or the team lead can delete this team');
  await db.run('UPDATE stories SET team_id=NULL WHERE team_id=?', [teamId]);
  await db.run('UPDATE tasks SET team_id=NULL WHERE team_id=?', [teamId]);
  await db.run('DELETE FROM teams WHERE id=?', [teamId]);
  await audit(team.organization_id, null, user.id, 'team', teamId, 'deleted', {});
  broadcastToUsers([team.lead_user_id], { type: 'team_updated', entity: 'team', id: teamId, organization_id: team.organization_id, payload: { deleted: true } });
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/teams/:teamId/members', async ({ res, user, params }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  const scope = await resolveAccessScope(user.id, Number(team.organization_id), member);
  const canView = scope.fullAccess || scope.managedTeamIds.includes(teamId) || scope.ownTeamIds.includes(teamId);
  if (!canView) throw new HttpError(403, 'You do not have access to this team');
  const members = await db.all(
    'SELECT tm.*,u.full_name,u.username,u.avatar_url FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY u.full_name',
    [teamId]
  );
  jsonResponse(res, 200, members);
});

route('POST', '/api/teams/:teamId/members', async ({ res, user, params, body }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  if (!canManageTeam(team, member)) throw new HttpError(403, 'Only CEO, admin, or the team lead can manage team members');
  const targetUserId = integer(body.user_id, 'user_id');
  if (!await membership(targetUserId, team.organization_id, true)) throw new HttpError(400, 'user_id must be an active organization member');
  const now = db.utcnow();
  await db.run('INSERT OR IGNORE INTO team_members(team_id,user_id,role_in_team,joined_at) VALUES(?,?,?,?)', [teamId, targetUserId, cleanString(body.role_in_team, 80), now]);
  await audit(team.organization_id, null, user.id, 'team_member', teamId, 'added', { user_id: targetUserId });
  jsonResponse(res, 201, await db.get('SELECT tm.*,u.full_name,u.username FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? AND tm.user_id=?', [teamId, targetUserId]));
});

route('DELETE', '/api/teams/:teamId/members/:memberUserId', async ({ res, user, params }) => {
  const teamId = integer(params.teamId, 'team id');
  const memberUserId = integer(params.memberUserId, 'user id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  if (!canManageTeam(team, member)) throw new HttpError(403, 'Only CEO, admin, or the team lead can manage team members');
  await db.run('DELETE FROM team_members WHERE team_id=? AND user_id=?', [teamId, memberUserId]);
  await audit(team.organization_id, null, user.id, 'team_member', teamId, 'removed', { user_id: memberUserId });
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/teams/:teamId/workspace', async ({ res, user, params }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  const isMember = await db.get('SELECT id FROM team_members WHERE team_id=? AND user_id=?', [teamId, user.id]);
  if (!canManageTeam(team, member) && !isMember) throw new HttpError(403, 'You are not a member of this team');
  const members = await db.all('SELECT tm.*,u.full_name,u.username,u.avatar_url FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY u.full_name', [teamId]);
  const memberIds = members.map(item => Number(item.user_id));
  const workload = [];
  let tasks = [];
  let projects = [];
  if (memberIds.length) {
    const placeholders = memberIds.map(() => '?').join(',');
    tasks = await db.all(`SELECT t.*,p.name project_name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.organization_id=? AND t.owner_id IN (${placeholders}) AND t.rejected=0 ORDER BY (t.due_date IS NULL),t.due_date LIMIT 200`, [team.organization_id, ...memberIds]);
    for (const person of members) {
      const activeCount = tasks.filter(item => Number(item.owner_id) === Number(person.user_id) && item.status !== 'done').length;
      workload.push({ user_id: person.user_id, full_name: person.full_name, active_task_count: activeCount, capacity: 5 });
    }
    const projectIds = [...new Set(tasks.map(item => Number(item.project_id)))];
    if (projectIds.length) projects = await db.all(`SELECT * FROM projects WHERE id IN (${projectIds.map(() => '?').join(',')})`, projectIds);
  }
  const today = db.utcnow().slice(0, 10);
  const overdueCount = tasks.filter(item => item.status !== 'done' && item.due_date && item.due_date < today).length;

  const unassignedItems = await db.all(
    `SELECT t.*,p.name project_name,s.name story_name,parent.title parent_task_title
     FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN stories s ON s.id=t.story_id LEFT JOIN tasks parent ON parent.id=t.parent_task_id
     WHERE t.team_id=? AND t.owner_id IS NULL AND t.rejected=0
     ORDER BY (t.story_id IS NULL),t.story_id,(t.parent_task_id IS NOT NULL),t.id`,
    [teamId]
  );
  const storyGroups = new Map();
  for (const item of unassignedItems) {
    const storyKey = Number(item.story_id) || 0;
    if (!storyGroups.has(storyKey)) {
      storyGroups.set(storyKey, { story_id: item.story_id ? Number(item.story_id) : null, story_name: item.story_name || 'No story', project_id: Number(item.project_id), project_name: item.project_name, tasks: [], subtasks: [] });
    }
    const group = storyGroups.get(storyKey);
    if (item.parent_task_id) group.subtasks.push(item); else group.tasks.push(item);
  }
  const needsDistribution = { stories: [...storyGroups.values()] };

  jsonResponse(res, 200, { team, members, workload, tasks, projects, overdue_count: overdueCount, needs_distribution: needsDistribution });
});
