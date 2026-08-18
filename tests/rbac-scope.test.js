'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rbac-scope-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.TOKEN_SECRET = 'test-secret-that-is-long-enough';
process.env.TURSO_DATABASE_URL = '';
process.env.TURSO_AUTH_TOKEN = '';
process.env.GEMINI_API_KEY = '';
process.env.AI_PROVIDER_API_KEY = '';

const db = require('../src/database/client');
const { initDb } = require('../src/database/schema');
const { createServer } = require('../src/server');

initDb();
const server = createServer();

let baseUrl;

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(pathname, { method = 'GET', token = '', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

async function register(username) {
  const result = await request('/api/auth/register', {
    method: 'POST',
    body: { username, email: `${username}@example.com`, full_name: username, password: 'Password123!' }
  });
  assert.equal(result.status, 201);
  return result.data;
}

async function inviteAndApprove(organizationId, ceoToken, invitee, role = 'member') {
  const invite = await request(`/api/organizations/${organizationId}/invitations`, {
    method: 'POST', token: ceoToken, body: { identifier: invitee.user.username, proposed_role: role }
  });
  assert.equal(invite.status, 201);
  const accept = await request(`/api/invitations/${invite.data.id}/accept`, { method: 'POST', token: invitee.token });
  assert.equal(accept.status, 200);
  const approve = await request(`/api/invitations/${invite.data.id}/approve`, { method: 'POST', token: ceoToken });
  assert.equal(approve.status, 200);
  return approve.data.membership;
}

test('RBAC: CEO sees everything, a team Manager is scoped to their own team, a Worker is scoped to their own tasks', async () => {
  const ceo = await register('rbac_ceo');
  const manager1 = await register('rbac_mgr_eng');
  const manager2 = await register('rbac_mgr_mkt');
  const worker1 = await register('rbac_wkr_eng');
  const worker2 = await register('rbac_wkr_mkt');

  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'RBAC Co' } });
  assert.equal(org.status, 201);
  const organizationId = org.data.id;

  await inviteAndApprove(organizationId, ceo.token, manager1);
  await inviteAndApprove(organizationId, ceo.token, manager2);
  await inviteAndApprove(organizationId, ceo.token, worker1);
  await inviteAndApprove(organizationId, ceo.token, worker2);

  const engTeam = await request(`/api/organizations/${organizationId}/teams`, {
    method: 'POST', token: ceo.token, body: { name: 'Engineering Team', lead_user_id: manager1.user.id }
  });
  assert.equal(engTeam.status, 201);
  const mktTeam = await request(`/api/organizations/${organizationId}/teams`, {
    method: 'POST', token: ceo.token, body: { name: 'Marketing Team', lead_user_id: manager2.user.id }
  });
  assert.equal(mktTeam.status, 201);

  await request(`/api/teams/${engTeam.data.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: worker1.user.id } });
  await request(`/api/teams/${mktTeam.data.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: worker2.user.id } });

  // Both projects are org-wide, but projectA only has Engineering-team work and projectB only
  // has Marketing-team work — this is the shape the scoping logic must respect.
  const projectA = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Project Alpha' } });
  assert.equal(projectA.status, 201);
  const projectB = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Project Beta' } });
  assert.equal(projectB.status, 201);

  const taskA1 = await request(`/api/projects/${projectA.data.id}/tasks`, {
    method: 'POST', token: ceo.token, body: { title: 'Alpha Engineering Task', team_id: engTeam.data.id, owner_id: worker1.user.id }
  });
  assert.equal(taskA1.status, 201);
  const taskA2 = await request(`/api/projects/${projectA.data.id}/tasks`, {
    method: 'POST', token: ceo.token, body: { title: 'Alpha Marketing Task', team_id: mktTeam.data.id, owner_id: worker2.user.id }
  });
  assert.equal(taskA2.status, 201);
  const taskB1 = await request(`/api/projects/${projectB.data.id}/tasks`, {
    method: 'POST', token: ceo.token, body: { title: 'Beta Marketing Task', team_id: mktTeam.data.id, owner_id: worker2.user.id }
  });
  assert.equal(taskB1.status, 201);

  // --- CEO: full access -----------------------------------------------------------------
  const ceoProjects = await request(`/api/organizations/${organizationId}/projects`, { token: ceo.token });
  assert.deepEqual(new Set(ceoProjects.data.map(p => p.id)), new Set([projectA.data.id, projectB.data.id]));
  const ceoProjectB = await request(`/api/projects/${projectB.data.id}`, { token: ceo.token });
  assert.equal(ceoProjectB.status, 200);
  const ceoTasksA = await request(`/api/projects/${projectA.data.id}/tasks`, { token: ceo.token });
  assert.equal(ceoTasksA.data.length, 2);

  // --- Manager (Engineering lead): own team only -----------------------------------------
  const mgrProjects = await request(`/api/organizations/${organizationId}/projects`, { token: manager1.token });
  assert.deepEqual(new Set(mgrProjects.data.map(p => p.id)), new Set([projectA.data.id]), 'Manager should only see projects with their own team\'s work');

  const mgrProjectB = await request(`/api/projects/${projectB.data.id}`, { token: manager1.token });
  assert.equal(mgrProjectB.status, 403, 'Manager must not access a project with zero footprint from their team, even by direct id');

  const mgrTasksA = await request(`/api/projects/${projectA.data.id}/tasks`, { token: manager1.token });
  assert.deepEqual(mgrTasksA.data.map(t => t.id), [taskA1.data.id], 'Manager should only see their own team\'s tasks within a shared project');

  const mgrTeamMembersOwn = await request(`/api/teams/${engTeam.data.id}/members`, { token: manager1.token });
  assert.equal(mgrTeamMembersOwn.status, 200);
  const mgrTeamMembersOther = await request(`/api/teams/${mktTeam.data.id}/members`, { token: manager1.token });
  assert.equal(mgrTeamMembersOther.status, 403, 'Manager must not list another team\'s roster');

  const mgrPatchOwnTeamTask = await request(`/api/tasks/${taskA1.data.id}`, { method: 'PATCH', token: manager1.token, body: { status: 'in_progress' } });
  assert.equal(mgrPatchOwnTeamTask.status, 200);
  const mgrPatchOtherTeamTask = await request(`/api/tasks/${taskA2.data.id}`, { method: 'PATCH', token: manager1.token, body: { status: 'in_progress' } });
  assert.equal(mgrPatchOtherTeamTask.status, 403, 'Manager must not edit another team\'s task, even within a project they can see');

  const mgrAssignOwnTeam = await request(`/api/tasks/${taskA1.data.id}`, { method: 'PATCH', token: manager1.token, body: { owner_id: worker1.user.id } });
  assert.equal(mgrAssignOwnTeam.status, 200, 'Manager can (re)assign within their own team');
  const mgrAssignOtherTeam = await request(`/api/tasks/${taskB1.data.id}`, { method: 'PATCH', token: manager1.token, body: { owner_id: worker1.user.id } });
  assert.equal(mgrAssignOtherTeam.status, 403, 'Manager must not assign a task belonging to another team');

  const mgrExport = await request(`/api/projects/${projectA.data.id}/export.json`, { token: manager1.token });
  assert.equal(mgrExport.status, 200);
  assert.deepEqual(mgrExport.data.tasks.map(t => t.id), [taskA1.data.id]);

  // --- Worker (Engineering member): own assigned work only ------------------------------
  const wkrProjects = await request(`/api/organizations/${organizationId}/projects`, { token: worker1.token });
  assert.deepEqual(new Set(wkrProjects.data.map(p => p.id)), new Set([projectA.data.id]), 'Worker should only see projects containing their own assigned work');

  const wkrProjectB = await request(`/api/projects/${projectB.data.id}`, { token: worker1.token });
  assert.equal(wkrProjectB.status, 403, 'Worker must not access a project with none of their own tasks, even by direct id');

  const wkrTasksA = await request(`/api/projects/${projectA.data.id}/tasks`, { token: worker1.token });
  assert.deepEqual(wkrTasksA.data.map(t => t.id), [taskA1.data.id], 'Worker must only see their own tasks, not a teammate\'s');

  const wkrTaskDirect = await request(`/api/tasks/${taskA2.data.id}`, { token: worker1.token });
  assert.equal(wkrTaskDirect.status, 403, 'Worker must not read another worker\'s task by direct id');

  const wkrStatusUpdate = await request(`/api/tasks/${taskA1.data.id}`, { method: 'PATCH', token: worker1.token, body: { status: 'in_progress' } });
  assert.equal(wkrStatusUpdate.status, 200, 'Worker can update status on their own task');

  const wkrStructuralEdit = await request(`/api/tasks/${taskA1.data.id}`, { method: 'PATCH', token: worker1.token, body: { title: 'Renamed by worker' } });
  assert.equal(wkrStructuralEdit.status, 403, 'Worker must not edit structural fields, even on their own task');

  const wkrReassignAttempt = await request(`/api/tasks/${taskA1.data.id}`, { method: 'PATCH', token: worker1.token, body: { owner_id: worker2.user.id } });
  assert.equal(wkrReassignAttempt.status, 403, 'Worker must never be able to reassign a task');

  const wkrCreateTask = await request(`/api/projects/${projectA.data.id}/tasks`, { method: 'POST', token: worker1.token, body: { title: 'Should be blocked' } });
  assert.equal(wkrCreateTask.status, 403, 'Worker must not be able to create tasks');

  const wkrMembers = await request(`/api/organizations/${organizationId}/members`, { token: worker1.token });
  const wkrVisibleIds = new Set(wkrMembers.data.map(m => Number(m.user_id)));
  assert.ok(wkrVisibleIds.has(worker1.user.id) && wkrVisibleIds.has(manager1.user.id), 'Worker should see themself and their own team lead');
  assert.ok(!wkrVisibleIds.has(worker2.user.id) && !wkrVisibleIds.has(manager2.user.id), 'Worker must not see another team\'s people in the directory');

  const wkrRisks = await request(`/api/projects/${projectA.data.id}/risks`, { token: worker1.token });
  assert.equal(wkrRisks.status, 200);
  assert.deepEqual(wkrRisks.data, [], 'Worker must not receive any Risks & Decisions data');

  const wkrChanges = await request(`/api/projects/${projectA.data.id}/changes`, { token: worker1.token });
  assert.equal(wkrChanges.status, 200);
  assert.deepEqual(wkrChanges.data, [], 'Worker must not receive any Change Control data');

  const wkrExport = await request(`/api/projects/${projectA.data.id}/export.json`, { token: worker1.token });
  assert.equal(wkrExport.status, 403, 'Worker must not be able to export project data');

  const wkrTeamMembersOther = await request(`/api/teams/${mktTeam.data.id}/members`, { token: worker1.token });
  assert.equal(wkrTeamMembersOther.status, 403, 'Worker must not list a team they do not belong to');
});

test('RBAC: a department manager sees their department\'s team work even without personally leading a team', async () => {
  const ceo = await register('rbac_ceo2');
  const deptManager = await register('rbac_dept_mgr');
  const worker = await register('rbac_dept_wkr');

  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Dept RBAC Co' } });
  assert.equal(org.status, 201);
  const organizationId = org.data.id;

  await inviteAndApprove(organizationId, ceo.token, deptManager);
  await inviteAndApprove(organizationId, ceo.token, worker);

  const department = await request(`/api/organizations/${organizationId}/departments`, {
    method: 'POST', token: ceo.token, body: { name: 'Ops Department', manager_user_id: deptManager.user.id }
  });
  assert.equal(department.status, 201);

  // No lead_user_id set — this team is only reachable through department management, not direct
  // team leadership, which is exactly the gap the managedDepartmentIds -> managedTeamIds expansion covers.
  const team = await request(`/api/organizations/${organizationId}/teams`, {
    method: 'POST', token: ceo.token, body: { name: 'Ops Team', department_id: department.data.id }
  });
  assert.equal(team.status, 201);
  await request(`/api/teams/${team.data.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: worker.user.id } });

  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Ops Project' } });
  assert.equal(project.status, 201);
  const task = await request(`/api/projects/${project.data.id}/tasks`, {
    method: 'POST', token: ceo.token, body: { title: 'Ops Task', team_id: team.data.id, owner_id: worker.user.id }
  });
  assert.equal(task.status, 201);

  const deptMgrProject = await request(`/api/projects/${project.data.id}`, { token: deptManager.token });
  assert.equal(deptMgrProject.status, 200, 'Department manager should see a project touched by their department\'s team');

  const deptMgrTasks = await request(`/api/projects/${project.data.id}/tasks`, { token: deptManager.token });
  assert.deepEqual(deptMgrTasks.data.map(t => t.id), [task.data.id]);

  const deptMgrAssign = await request(`/api/tasks/${task.data.id}`, { method: 'PATCH', token: deptManager.token, body: { owner_id: worker.user.id } });
  assert.equal(deptMgrAssign.status, 200, 'Department manager should be able to (re)assign work within their department\'s team');

  const deptMgrTeamMembers = await request(`/api/teams/${team.data.id}/members`, { token: deptManager.token });
  assert.equal(deptMgrTeamMembers.status, 200);
});

test('RBAC: date-editing is manager-tier-and-above only, and a Manager can manage a team-less subtask of their own team\'s task', async () => {
  const ceo = await register('rbac_dates_ceo');
  const manager = await register('rbac_dates_mgr');
  const worker = await register('rbac_dates_wkr');
  const worker2 = await register('rbac_dates_wkr2');

  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Dates RBAC Co' } });
  assert.equal(org.status, 201);
  const organizationId = org.data.id;

  await inviteAndApprove(organizationId, ceo.token, manager);
  await inviteAndApprove(organizationId, ceo.token, worker);
  await inviteAndApprove(organizationId, ceo.token, worker2);

  const team = await request(`/api/organizations/${organizationId}/teams`, {
    method: 'POST', token: ceo.token, body: { name: 'Dates Team', lead_user_id: manager.user.id }
  });
  assert.equal(team.status, 201);
  await request(`/api/teams/${team.data.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: worker.user.id } });
  await request(`/api/teams/${team.data.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: worker2.user.id } });

  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Dates Project' } });
  assert.equal(project.status, 201);

  const milestone = await request(`/api/projects/${project.data.id}/milestones`, { method: 'POST', token: ceo.token, body: { name: 'Launch' } });
  assert.equal(milestone.status, 201);

  const task = await request(`/api/projects/${project.data.id}/tasks`, {
    method: 'POST', token: ceo.token, body: { title: 'Team task', team_id: team.data.id, owner_id: worker.user.id }
  });
  assert.equal(task.status, 201);

  // Subtask created with NO team_id of its own — only reachable through its parent task's team.
  const subtask = await request(`/api/projects/${project.data.id}/tasks`, {
    method: 'POST', token: ceo.token, body: { title: 'Team-less subtask', parent_task_id: task.data.id, owner_id: worker.user.id }
  });
  assert.equal(subtask.status, 201);
  assert.equal(subtask.data.team_id, null, 'the subtask must have no team_id of its own for this to be a meaningful test');

  // --- Item 23: Members cannot edit dates anywhere; Managers can, within their own scope -----
  const wkrTaskDate = await request(`/api/tasks/${task.data.id}`, { method: 'PATCH', token: worker.token, body: { due_date: '2030-01-01' } });
  assert.equal(wkrTaskDate.status, 403, 'Worker must not be able to set a due date on their own task');

  const wkrMilestoneDate = await request(`/api/milestones/${milestone.data.id}`, { method: 'PATCH', token: worker.token, body: { due_date: '2030-01-01' } });
  assert.equal(wkrMilestoneDate.status, 403, 'Worker must not be able to edit milestone dates');

  const wkrProjectDate = await request(`/api/projects/${project.data.id}`, { method: 'PATCH', token: worker.token, body: { due_date: '2030-01-01' } });
  assert.equal(wkrProjectDate.status, 403, 'Worker must not be able to edit project dates');

  const mgrTaskDate = await request(`/api/tasks/${task.data.id}`, { method: 'PATCH', token: manager.token, body: { due_date: '2030-01-01' } });
  assert.equal(mgrTaskDate.status, 200, 'Manager can set a due date on their own team\'s task');

  // --- Item 24: Manager can manage a team-less subtask via its parent task's team -----------
  const mgrSubtaskEdit = await request(`/api/tasks/${subtask.data.id}`, { method: 'PATCH', token: manager.token, body: { due_date: '2030-01-01' } });
  assert.equal(mgrSubtaskEdit.status, 200, 'Manager should be able to edit a team-less subtask of a task belonging to their own team');

  // Worker still owns the subtask at this point — the same WORKER_SELF_EDIT_FIELDS mechanism
  // that applies to a normal task must also apply to a team-less subtask.
  const wkrSubtaskStatus = await request(`/api/tasks/${subtask.data.id}`, { method: 'PATCH', token: worker.token, body: { status: 'in_progress' } });
  assert.equal(wkrSubtaskStatus.status, 200, 'Worker should still be able to update the status of their own team-less subtask');

  const mgrSubtaskReassign = await request(`/api/tasks/${subtask.data.id}`, { method: 'PATCH', token: manager.token, body: { owner_id: worker2.user.id } });
  assert.equal(mgrSubtaskReassign.status, 200, 'Manager should be able to reassign a team-less subtask of their own team\'s task');

  // Once reassigned away, the former owner loses even status-only access.
  const wkrSubtaskStatusAfter = await request(`/api/tasks/${subtask.data.id}`, { method: 'PATCH', token: worker.token, body: { status: 'blocked' } });
  assert.equal(wkrSubtaskStatusAfter.status, 403, 'Worker must lose access once reassigned away from them');
});
