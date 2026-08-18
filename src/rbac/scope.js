'use strict';

const db = require('../database/client');
const { HttpError } = require('../middleware/http');
const { membership, FULL_ACCESS_ROLES } = require('./permissions');

// --- RBAC scoping -----------------------------------------------------------
// Org-level role (`ceo`/`admin`/`moderator`/`member`) already gates most routes via
// requireMembership(). What it cannot express is the business-level "Manager" tier: a
// `member`-role user who leads a team (teams.lead_user_id) or manages a department
// (departments.manager_user_id). resolveAccessScope() computes that once per request and
// is the single source of truth every scoping helper below reads from. Everyone who is not
// full-access and not a Manager is treated as a plain Worker.

async function resolveAccessScope(userId, organizationId, membershipRow = null) {
  const member = membershipRow || await membership(userId, organizationId);
  const role = member ? member.role : null;
  const fullAccess = FULL_ACCESS_ROLES.includes(role);
  const scope = {
    userId: Number(userId),
    organizationId: Number(organizationId),
    role,
    fullAccess,
    departmentId: member && member.department_id ? Number(member.department_id) : null,
    managedTeamIds: [],
    managedDepartmentIds: [],
    ownTeamIds: [],
    visibleDepartmentIds: new Set(),
    managedTeamUserIds: new Set([Number(userId)]),
    ownTeamUserIds: new Set([Number(userId)])
  };
  if (fullAccess || !member) return scope;

  const [ledTeams, managedDepartments, ownMemberships] = await Promise.all([
    db.all("SELECT id, department_id FROM teams WHERE organization_id=? AND lead_user_id=? AND status='active'", [organizationId, userId]),
    db.all('SELECT id FROM departments WHERE organization_id=? AND manager_user_id=?', [organizationId, userId]),
    db.all('SELECT team_id FROM team_members WHERE user_id=?', [userId])
  ]);
  scope.managedDepartmentIds = managedDepartments.map(d => Number(d.id));
  scope.ownTeamIds = [...new Set(ownMemberships.map(t => Number(t.team_id)))];
  const leadTeamIds = ledTeams.map(t => Number(t.id));
  // A department manager manages every team under their department, not just ones they personally
  // lead — otherwise a department-level manager with no direct team leadership would pass the
  // manager-tier check (via managedDepartmentIds) but still see none of their department's work.
  const departmentTeams = scope.managedDepartmentIds.length
    ? await db.all(`SELECT id FROM teams WHERE department_id IN (${scope.managedDepartmentIds.map(() => '?').join(',')}) AND status='active'`, scope.managedDepartmentIds)
    : [];
  scope.managedTeamIds = [...new Set([...leadTeamIds, ...departmentTeams.map(t => Number(t.id))])];
  for (const id of scope.managedDepartmentIds) scope.visibleDepartmentIds.add(id);
  for (const team of ledTeams) if (team.department_id) scope.visibleDepartmentIds.add(Number(team.department_id));
  if (scope.departmentId) scope.visibleDepartmentIds.add(scope.departmentId);

  const teamIdsNeeded = [...new Set([...scope.managedTeamIds, ...scope.ownTeamIds])];
  if (teamIdsNeeded.length) {
    const placeholders = teamIdsNeeded.map(() => '?').join(',');
    const [memberRows, teamRows] = await Promise.all([
      db.all(`SELECT team_id, user_id FROM team_members WHERE team_id IN (${placeholders})`, teamIdsNeeded),
      db.all(`SELECT id, lead_user_id, department_id FROM teams WHERE id IN (${placeholders})`, teamIdsNeeded)
    ]);
    const managedSet = new Set(scope.managedTeamIds);
    const ownSet = new Set(scope.ownTeamIds);
    for (const row of memberRows) {
      const teamId = Number(row.team_id);
      const uid = Number(row.user_id);
      if (managedSet.has(teamId)) scope.managedTeamUserIds.add(uid);
      if (ownSet.has(teamId)) scope.ownTeamUserIds.add(uid);
    }
    for (const team of teamRows) {
      const teamId = Number(team.id);
      if (team.lead_user_id) {
        const leadId = Number(team.lead_user_id);
        if (managedSet.has(teamId)) scope.managedTeamUserIds.add(leadId);
        if (ownSet.has(teamId)) scope.ownTeamUserIds.add(leadId);
      }
      if (team.department_id && ownSet.has(teamId)) scope.visibleDepartmentIds.add(Number(team.department_id));
    }
  }
  if (scope.managedDepartmentIds.length) {
    const placeholders = scope.managedDepartmentIds.map(() => '?').join(',');
    const deptMembers = await db.all(
      `SELECT user_id FROM memberships WHERE organization_id=? AND department_id IN (${placeholders})`,
      [organizationId, ...scope.managedDepartmentIds]
    );
    for (const row of deptMembers) scope.managedTeamUserIds.add(Number(row.user_id));
  }
  return scope;
}

// A "Manager" is a plain member who leads at least one team or manages at least one
// department. Full-access roles are never counted as this tier (they already see everything).
function isManagerScope(scope) {
  return !scope.fullAccess && (scope.managedTeamIds.length > 0 || scope.managedDepartmentIds.length > 0);
}

function scopeMemberList(scope, members) {
  if (scope.fullAccess) return members;
  const allowedIds = isManagerScope(scope) ? scope.managedTeamUserIds : scope.ownTeamUserIds;
  return members.filter(item => allowedIds.has(Number(item.user_id)));
}

function scopeDepartmentList(scope, departments) {
  if (scope.fullAccess) return departments;
  return departments.filter(dept => scope.visibleDepartmentIds.has(Number(dept.id)));
}

function scopeTeamList(scope, teams) {
  if (scope.fullAccess) return teams;
  const visibleIds = new Set([...scope.managedTeamIds, ...scope.ownTeamIds]);
  return teams.filter(team => visibleIds.has(Number(team.id)));
}

// Coarse, project-level gate: does this project have any footprint (owned task, or a task/story
// belonging to a team the caller manages or is assigned work on) within the caller's scope at all?
// Used by projectWithAccess() as the defense-in-depth boundary for direct URL/API access to a
// specific project id — a Manager or Worker with zero legitimate connection to a project gets a 403.
async function projectInScope(scope, projectId) {
  if (scope.fullAccess) return true;
  const project = await db.get('SELECT owner_id FROM projects WHERE id=?', [projectId]);
  if (project && project.owner_id !== null && Number(project.owner_id) === scope.userId) return true;
  if (isManagerScope(scope) && scope.managedTeamIds.length) {
    const placeholders = scope.managedTeamIds.map(() => '?').join(',');
    const row = await db.get(
      `SELECT 1 found FROM tasks WHERE project_id=? AND team_id IN (${placeholders})
       UNION SELECT 1 FROM stories WHERE project_id=? AND team_id IN (${placeholders}) LIMIT 1`,
      [projectId, ...scope.managedTeamIds, projectId, ...scope.managedTeamIds]
    );
    if (row) return true;
  }
  const ownTask = await db.get('SELECT 1 found FROM tasks WHERE project_id=? AND owner_id=? LIMIT 1', [projectId, scope.userId]);
  return Boolean(ownTask);
}

async function scopeProjectList(scope, projects) {
  if (scope.fullAccess) return projects;
  const allowedIds = new Set();
  for (const project of projects) {
    if (project.owner_id !== null && Number(project.owner_id) === scope.userId) allowedIds.add(Number(project.id));
  }
  if (isManagerScope(scope) && scope.managedTeamIds.length) {
    const placeholders = scope.managedTeamIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT DISTINCT project_id FROM tasks WHERE team_id IN (${placeholders})
       UNION SELECT DISTINCT project_id FROM stories WHERE team_id IN (${placeholders})`,
      [...scope.managedTeamIds, ...scope.managedTeamIds]
    );
    for (const row of rows) allowedIds.add(Number(row.project_id));
  } else if (!isManagerScope(scope)) {
    const rows = await db.all('SELECT DISTINCT project_id FROM tasks WHERE owner_id=?', [scope.userId]);
    for (const row of rows) allowedIds.add(Number(row.project_id));
  }
  return projects.filter(project => allowedIds.has(Number(project.id)));
}

// Fine-grained, within-a-project filter: a Manager only sees tasks/subtasks whose own team_id
// (or parent story's team_id) is one they manage, or that are assigned to them personally; a
// Worker only sees tasks/subtasks assigned to them, plus (read-only context) the parent task of
// any subtask they own, so "what am I working on" still makes sense.
function scopeTaskList(scope, tasks) {
  if (scope.fullAccess) return tasks;
  if (isManagerScope(scope)) {
    const teamIds = new Set(scope.managedTeamIds);
    return tasks.filter(task =>
      (task.team_id !== null && task.team_id !== undefined && teamIds.has(Number(task.team_id))) ||
      (task.story_team_id !== null && task.story_team_id !== undefined && teamIds.has(Number(task.story_team_id))) ||
      Number(task.owner_id) === scope.userId
    );
  }
  const ownedIds = new Set(tasks.filter(task => Number(task.owner_id) === scope.userId).map(task => Number(task.id)));
  const parentIdsNeeded = new Set();
  for (const task of tasks) {
    if (ownedIds.has(Number(task.id)) && task.parent_task_id) parentIdsNeeded.add(Number(task.parent_task_id));
  }
  return tasks.filter(task => ownedIds.has(Number(task.id)) || parentIdsNeeded.has(Number(task.id)));
}

function scopeStoryList(scope, stories) {
  if (scope.fullAccess) return stories;
  if (isManagerScope(scope)) {
    const teamIds = new Set(scope.managedTeamIds);
    return stories.filter(story =>
      (story.team_id !== null && story.team_id !== undefined && teamIds.has(Number(story.team_id))) ||
      Number(story.owner_id) === scope.userId
    );
  }
  return stories.filter(story => Number(story.owner_id) === scope.userId);
}

// Task/subtask-level gate for direct-by-id routes (GET/PATCH one task, comments, etc.).
function taskInScope(scope, task) {
  if (scope.fullAccess) return true;
  if (Number(task.owner_id) === scope.userId) return true;
  if (isManagerScope(scope)) {
    const teamIds = new Set(scope.managedTeamIds);
    if (task.team_id !== null && task.team_id !== undefined && teamIds.has(Number(task.team_id))) return true;
    if (task.story_team_id !== null && task.story_team_id !== undefined && teamIds.has(Number(task.story_team_id))) return true;
  }
  return false;
}

function taskManagedByScope(scope, task) {
  if (scope.fullAccess) return true;
  if (!isManagerScope(scope)) return false;
  const teamIds = new Set(scope.managedTeamIds);
  const effectiveTeamIds = [task.team_id, task.story_team_id].filter(id => id !== null && id !== undefined).map(Number);
  return effectiveTeamIds.some(id => teamIds.has(id));
}

// Manager-tier-and-above feature gate for pages the spec puts fully off-limits to plain Workers
// (Risks & Decisions, Change Control, Reports, audit log, exports) — a Worker gets an empty result
// rather than a 403 on routes the frontend loads unconditionally for the selected project, and a
// 403 on the ones it only loads on demand.
function requireManagerTierOrAbove(scope, message) {
  if (scope.fullAccess || isManagerScope(scope)) return;
  throw new HttpError(403, message || 'This area is only available to managers and above');
}

module.exports = {
  resolveAccessScope,
  isManagerScope,
  scopeMemberList,
  scopeDepartmentList,
  scopeTeamList,
  projectInScope,
  scopeProjectList,
  scopeTaskList,
  scopeStoryList,
  taskInScope,
  taskManagedByScope,
  requireManagerTierOrAbove
};
