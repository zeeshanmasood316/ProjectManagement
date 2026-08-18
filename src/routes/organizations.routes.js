'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { jsonResponse } = require('../middleware/http');
const { requiredString, integer } = require('../utils/validation');
const { uniqueSlug } = require('../utils/slug');
const { requireMembership, canManageAdmins } = require('../rbac/permissions');
const { resolveAccessScope, scopeMemberList, scopeTaskList, isManagerScope } = require('../rbac/scope');
const { audit, activity, notifyUser } = require('../notifications/events');
const { organizationSummary, organizationMembers, activeOrganizationMembers } = require('../services/organizations');

route('GET', '/api/organizations', async ({ res, user }) => {
  jsonResponse(res, 200, await organizationSummary(user.id));
});

route('POST', '/api/organizations', async ({ res, user, body }) => {
  const name = requiredString(body.name, 'Organization name', 2, 120);
  const now = db.utcnow();
  const created = await db.transaction(async () => {
    const organization = await db.run('INSERT INTO organizations(name,slug,created_by,created_at,updated_at) VALUES(?,?,?,?,?)', [name, await uniqueSlug(name), user.id, now, now]);
    await db.run('INSERT INTO memberships(organization_id,user_id,role,department,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?)', [organization.lastInsertRowid, user.id, 'ceo', 'Leadership', 'active', now, now]);
    await db.run('INSERT INTO channels(organization_id,name,topic,created_by,created_at) VALUES(?,?,?,?,?)', [organization.lastInsertRowid, 'general', 'Company-wide announcements and discussion', user.id, now]);
    await db.run('INSERT INTO channels(organization_id,name,topic,created_by,created_at) VALUES(?,?,?,?,?)', [organization.lastInsertRowid, 'project-updates', 'Project progress, blockers, and decisions', user.id, now]);
    return organization.lastInsertRowid;
  });
  await audit(created, null, user.id, 'organization', created, 'created', { name });
  await activity(user.id, 'organization_created', 'Organization created', name, created);
  await notifyUser(user.id, 'workspace', `Welcome to ${name}`, 'Your new organization is ready.', created, 'dashboard');
  const organization = await db.get('SELECT o.*, m.role, m.status membership_status FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE o.id=? AND m.user_id=?', [created, user.id]);
  jsonResponse(res, 201, organization);
});

route('GET', '/api/organizations/:organizationId', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const organization = await db.get('SELECT * FROM organizations WHERE id=?', [organizationId]);
  jsonResponse(res, 200, { ...organization, membership: member });
});

route('GET', '/api/organizations/:organizationId/members', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const scope = await resolveAccessScope(user.id, organizationId, member);
  const members = await organizationMembers(organizationId, false);
  jsonResponse(res, 200, scopeMemberList(scope, members));
});

route('GET', '/api/organizations/:organizationId/manager-workspace', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const isOrgAdmin = canManageAdmins(member.role);
  const departments = isOrgAdmin
    ? await db.all('SELECT * FROM departments WHERE organization_id=? ORDER BY name', [organizationId])
    : await db.all('SELECT * FROM departments WHERE organization_id=? AND manager_user_id=? ORDER BY name', [organizationId, user.id]);
  const result = [];
  for (const department of departments) {
    const teams = await db.all(
      'SELECT t.*,(SELECT COUNT(*) FROM team_members tm WHERE tm.team_id=t.id) member_count FROM teams t WHERE t.department_id=? ORDER BY t.name',
      [department.id]
    );
    const teamMembers = await db.all(
      'SELECT DISTINCT tm.user_id,u.full_name,u.username FROM team_members tm JOIN teams t ON t.id=tm.team_id JOIN users u ON u.id=tm.user_id WHERE t.department_id=?',
      [department.id]
    );
    const deptMembers = await db.all(
      "SELECT m.user_id,u.full_name,u.username FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.department_id=? AND m.status='active'",
      [department.id]
    );
    const rosterMap = new Map();
    for (const person of [...teamMembers, ...deptMembers]) rosterMap.set(Number(person.user_id), person);
    const roster = [...rosterMap.values()];
    const workload = [];
    for (const person of roster) {
      const counts = await db.get(
        "SELECT COUNT(*) active_count FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.organization_id=? AND t.owner_id=? AND t.status<>'done' AND t.rejected=0",
        [organizationId, person.user_id]
      );
      workload.push({ user_id: person.user_id, full_name: person.full_name, username: person.username, active_task_count: Number(counts.active_count), capacity: 5 });
    }
    const stories = await db.all(
      `SELECT s.*,p.name project_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id=s.id AND t.rejected=0) task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id=s.id AND t.rejected=0 AND t.status='done') done_task_count
       FROM stories s JOIN projects p ON p.id=s.project_id WHERE s.department_id=? ORDER BY (s.due_date IS NULL),s.due_date`,
      [department.id]
    );
    const today = db.utcnow().slice(0, 10);
    const storyIds = stories.map(item => Number(item.id));
    let deadlineTasks = [];
    let blockedTasks = [];
    if (storyIds.length) {
      const placeholders = storyIds.map(() => '?').join(',');
      deadlineTasks = await db.all(`SELECT * FROM tasks WHERE story_id IN (${placeholders}) AND rejected=0 AND status<>'done' AND due_date IS NOT NULL AND due_date>=? ORDER BY due_date LIMIT 10`, [...storyIds, today]);
      blockedTasks = await db.all(`SELECT * FROM tasks WHERE story_id IN (${placeholders}) AND rejected=0 AND status='blocked'`, storyIds);
    }
    result.push({ department, teams, roster, workload, stories, deadline_tasks: deadlineTasks, blocked_tasks: blockedTasks });
  }
  jsonResponse(res, 200, { is_manager: departments.length > 0, departments: result });
});

route('GET', '/api/organizations/:organizationId/dashboard', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const membershipRow = await requireMembership(user.id, organizationId);
  const scope = await resolveAccessScope(user.id, organizationId, membershipRow);
  const today = db.utcnow().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sevenDaysAhead = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  // Scoped once, up front: a Manager only ever sees their own team's tasks from here on, a Worker
  // only their own — every downstream summary/status/priority/people/team section below is a plain
  // function of `allTasks`, so scoping the source data alone makes the whole dashboard role-correct
  // without touching any of that existing aggregation logic (CEO/admin/moderator: unchanged).
  const orgTasks = await db.all(
    `SELECT t.*,p.name project_name,u.full_name owner_name,s.name story_name,s.team_id story_team_id,tm.name team_name,lead.full_name team_manager_name
     FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.owner_id
     LEFT JOIN stories s ON s.id=t.story_id LEFT JOIN teams tm ON tm.id=t.team_id LEFT JOIN users lead ON lead.id=tm.lead_user_id
     WHERE p.organization_id=? AND t.rejected=0`,
    [organizationId]
  );
  const allTasks = scopeTaskList(scope, orgTasks);

  const completed7d = allTasks.filter(task => task.status === 'done' && task.updated_at >= sevenDaysAgo).length;
  const updated7d = allTasks.filter(task => task.updated_at >= sevenDaysAgo).length;
  const created7d = allTasks.filter(task => task.created_at >= sevenDaysAgo).length;
  const dueSoon7d = allTasks.filter(task => task.status !== 'done' && task.due_date && task.due_date >= today && task.due_date <= sevenDaysAhead).length;

  const myTasks = allTasks.filter(task => Number(task.owner_id) === Number(user.id));
  const myUpcoming = myTasks.filter(task => task.status !== 'done' && (!task.due_date || task.due_date >= today)).sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))).slice(0, 20);
  const myOverdue = myTasks.filter(task => task.status !== 'done' && task.due_date && task.due_date < today);
  const myCompleted = myTasks.filter(task => task.status === 'done').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 20);

  const statusDistribution = { not_started: 0, in_progress: 0, blocked: 0, done: 0 };
  const priorityDistribution = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const task of allTasks) {
    if (statusDistribution[task.status] !== undefined) statusDistribution[task.status] += 1;
    if (priorityDistribution[task.priority] !== undefined) priorityDistribution[task.priority] += 1;
  }

  const assignedByMe = allTasks.filter(task => Number(task.created_by) === Number(user.id) && task.owner_id && Number(task.owner_id) !== Number(user.id)).sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))).slice(0, 20);

  const members = await activeOrganizationMembers(organizationId);
  // Dashboard "people" is a workload/stats view, not a directory — a Worker's dashboard shows only
  // their own row (this is their "My Work" surface), a Manager's shows only their own team's people.
  const dashboardPeopleSource = scope.fullAccess
    ? members
    : members.filter(member => (isManagerScope(scope) ? scope.managedTeamUserIds : new Set([scope.userId])).has(Number(member.user_id)));
  const people = dashboardPeopleSource.map(member => {
    const owned = allTasks.filter(task => Number(task.owner_id) === Number(member.user_id));
    const activeCount = owned.filter(task => task.status !== 'done').length;
    const overdueCount = owned.filter(task => task.status !== 'done' && task.due_date && task.due_date < today).length;
    const completedCount = owned.filter(task => task.status === 'done').length;
    const capacity = Number(member.capacity || 5);
    return { user_id: member.user_id, full_name: member.full_name, active_task_count: activeCount, overdue_count: overdueCount, completed_count: completedCount, capacity, overloaded: activeCount > capacity };
  });

  const ledTeams = await db.all('SELECT id,name FROM teams WHERE organization_id=? AND lead_user_id=? AND status=\'active\'', [organizationId, user.id]);
  const teamManagement = ledTeams.map(team => {
    const teamTasks = allTasks.filter(task => Number(task.team_id) === Number(team.id));
    return {
      team_id: Number(team.id),
      team_name: team.name,
      needs_distribution_count: teamTasks.filter(task => !task.owner_id).length,
      in_progress_count: teamTasks.filter(task => task.status === 'in_progress').length,
      completed_count: teamTasks.filter(task => task.status === 'done').length,
      overdue_count: teamTasks.filter(task => task.status !== 'done' && task.due_date && task.due_date < today).length
    };
  });

  jsonResponse(res, 200, {
    summary: { completed_7d: completed7d, updated_7d: updated7d, created_7d: created7d, due_soon_7d: dueSoon7d },
    my_tasks: { upcoming: myUpcoming, overdue: myOverdue, completed: myCompleted },
    status_distribution: statusDistribution,
    priority_distribution: priorityDistribution,
    assigned_by_me: assignedByMe,
    people,
    team_management: teamManagement
  });
});
