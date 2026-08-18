'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-team-work-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.TOKEN_SECRET = 'test-secret-that-is-long-enough';
// Empty string, not delete: config.js's loadEnv() only fills a var when it is
// exactly undefined, so an explicit '' here survives loadEnv() reading .env
// and keeps this test off any real Turso database configured locally.
process.env.TURSO_DATABASE_URL = '';
process.env.TURSO_AUTH_TOKEN = '';
// Same reasoning: keep this test on the deterministic local AI fallback engine
// instead of making a real, billable call to whatever provider .env configures.
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

async function register(username, email, fullName) {
  const result = await request('/api/auth/register', {
    method: 'POST',
    body: { username, email, full_name: fullName, password: 'Password123!' }
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

test('AI work distribution: brief -> team -> manager -> worker', async () => {
  const ceo = await register('wd_ceo', 'wd_ceo@example.com', 'Workspace CEO');
  const lead = await register('wd_lead', 'wd_lead@example.com', 'Team Lead');
  const worker1 = await register('wd_worker1', 'wd_worker1@example.com', 'Worker One');
  const worker2 = await register('wd_worker2', 'wd_worker2@example.com', 'Worker Two');

  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Distribution Co' } });
  assert.equal(org.status, 201);
  const organizationId = org.data.id;

  await inviteAndApprove(organizationId, ceo.token, lead);
  await inviteAndApprove(organizationId, ceo.token, worker1);
  await inviteAndApprove(organizationId, ceo.token, worker2);

  const team = await request(`/api/organizations/${organizationId}/teams`, {
    method: 'POST', token: ceo.token, body: { name: 'Frontend Team', lead_user_id: lead.user.id }
  });
  assert.equal(team.status, 201);
  const teamId = team.data.id;

  const addMember = await request(`/api/teams/${teamId}/members`, {
    method: 'POST', token: ceo.token, body: { user_id: worker1.user.id }
  });
  assert.equal(addMember.status, 201);

  const project = await request(`/api/organizations/${organizationId}/projects`, {
    method: 'POST', token: ceo.token, body: { name: 'Client Website', objective: 'Launch a marketing site' }
  });
  assert.equal(project.status, 201);
  const projectId = project.data.id;

  // Local AI fallback generates a session; we then override the reviewed plan the same way the
  // browser's review screen would before committing, so the test exercises the real commit-time
  // team resolution/permission/notification logic rather than the fuzzy local keyword matcher.
  const analysis = await request(`/api/projects/${projectId}/brief-analysis`, {
    method: 'POST', token: ceo.token, body: { raw_text: 'Build a marketing website with a navigation menu and a contact form.', source_type: 'paste' }
  });
  assert.equal(analysis.status, 201);
  const sessionId = analysis.data.session_id;

  const plan = {
    departments: [], milestones: [], risks: [], assumptions: [],
    stories: [{
      name: 'Frontend Development', description: 'Build the site frontend.',
      department: '', priority: 'high', status: 'not_started', start_date: null,
      team_name: 'Frontend Team', team_confidence: 90, team_reason: 'Frontend work.',
      tasks: [{
        title: 'Build navigation', description: 'Implement the nav bar.', priority: 'high', status: 'not_started', due_date: null,
        tags: [], estimated_hours: null, team_name: 'Frontend Team', team_confidence: 85, team_reason: 'Frontend work.',
        subtasks: [{ title: 'Build nav markup', status: 'not_started', tags: [], estimated_hours: null }]
      }]
    }]
  };

  const commit = await request(`/api/brief-sessions/${sessionId}/commit`, { method: 'POST', token: ceo.token, body: { plan } });
  assert.equal(commit.status, 200);
  assert.equal(commit.data.storyCount, 1);
  assert.equal(commit.data.taskCount, 1);
  assert.equal(commit.data.subtaskCount, 1);
  assert.equal(commit.data.unassigned_task_count, 0);
  assert.equal(commit.data.team_breakdown.length, 1);
  assert.equal(commit.data.team_breakdown[0].team_id, teamId);
  assert.equal(commit.data.team_breakdown[0].task_count, 1);
  assert.equal(commit.data.team_breakdown[0].subtask_count, 1);
  assert.equal(commit.data.teams_notified.length, 1);
  assert.equal(commit.data.teams_notified[0].manager_id, lead.user.id);
  assert.equal(commit.data.teams_without_manager.length, 0);

  // The team lead must have received a real notification pointing at the team.
  const leadNotifications = await request('/api/users/me/notifications', { token: lead.token });
  assert.equal(leadNotifications.status, 200);
  const teamWorkNotification = leadNotifications.data.items.find(item => item.notification_type === 'team_work');
  assert.ok(teamWorkNotification, 'team lead should have a team_work notification');
  assert.equal(teamWorkNotification.action_view, `teams:${teamId}`);

  const tasks = await request(`/api/projects/${projectId}/tasks`, { token: ceo.token });
  assert.equal(tasks.status, 200);
  const task = tasks.data.find(item => item.title === 'Build navigation');
  const subtask = tasks.data.find(item => item.title === 'Build nav markup');
  assert.equal(Number(task.team_id), teamId);
  assert.equal(Number(task.ai_team_confidence), 85);
  assert.equal(Number(subtask.team_id), teamId, 'subtask should inherit the parent task team by default');
  assert.equal(subtask.owner_id, null);

  // TEAM MANAGER (the lead) assigns the task to a member of their own team — allowed.
  const leadAssign = await request(`/api/tasks/${task.id}`, {
    method: 'PATCH', token: lead.token, body: { owner_id: worker1.user.id }
  });
  assert.equal(leadAssign.status, 200);
  assert.equal(Number(leadAssign.data.owner_id), worker1.user.id);

  const worker1Notifications = await request('/api/users/me/notifications', { token: worker1.token });
  const assignmentNotification = worker1Notifications.data.items.find(item => item.notification_type === 'task_assignment');
  assert.ok(assignmentNotification, 'worker1 should be notified of the new assignment');
  assert.equal(assignmentNotification.action_view, `work:${task.id}`);

  // A plain WORKER (not the team lead, not admin/moderator) cannot reassign this task.
  const workerAttempt = await request(`/api/tasks/${task.id}`, {
    method: 'PATCH', token: worker1.token, body: { owner_id: worker2.user.id }
  });
  assert.equal(workerAttempt.status, 403);

  // A member entirely outside the team cannot assign it either.
  const outsiderAttempt = await request(`/api/tasks/${task.id}`, {
    method: 'PATCH', token: worker2.token, body: { owner_id: worker2.user.id }
  });
  assert.equal(outsiderAttempt.status, 403);

  // The lead cannot assign the task to someone outside their own team.
  const outOfTeamAssign = await request(`/api/tasks/${task.id}`, {
    method: 'PATCH', token: lead.token, body: { owner_id: worker2.user.id }
  });
  assert.equal(outOfTeamAssign.status, 403);

  // assign-with-subtasks: only fills the still-unassigned subtask, never overwrites an existing one.
  const assignWithSubtasks = await request(`/api/tasks/${task.id}/assign-with-subtasks`, {
    method: 'POST', token: lead.token, body: { owner_id: worker1.user.id, include_unassigned_subtasks: true }
  });
  assert.equal(assignWithSubtasks.status, 200);
  assert.deepEqual(assignWithSubtasks.data.assigned_subtask_ids, [subtask.id]);

  const tasksAfter = await request(`/api/projects/${projectId}/tasks`, { token: ceo.token });
  const subtaskAfter = tasksAfter.data.find(item => item.id === subtask.id);
  assert.equal(Number(subtaskAfter.owner_id), worker1.user.id);

  // Bulk assign (admin-tier action) reassigns both items to worker1 at once.
  const bulkAssign = await request('/api/tasks/bulk-assign', {
    method: 'POST', token: ceo.token, body: { task_ids: [task.id, subtask.id], owner_id: worker1.user.id }
  });
  assert.equal(bulkAssign.status, 200);
  assert.deepEqual(bulkAssign.data.assigned_task_ids.sort(), [task.id, subtask.id].sort());
});

test('team with no manager keeps its work but is flagged; unmatched team stays unassigned', async () => {
  const ceo = await register('wd2_ceo', 'wd2_ceo@example.com', 'Second CEO');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'No Manager Co' } });
  const organizationId = org.data.id;

  const team = await request(`/api/organizations/${organizationId}/teams`, {
    method: 'POST', token: ceo.token, body: { name: 'QA Team' }
  });
  assert.equal(team.status, 201);
  assert.equal(team.data.lead_user_id, null);
  const teamId = team.data.id;

  const project = await request(`/api/organizations/${organizationId}/projects`, {
    method: 'POST', token: ceo.token, body: { name: 'Internal Tool', objective: 'Ship an internal tool' }
  });
  const projectId = project.data.id;

  const analysis = await request(`/api/projects/${projectId}/brief-analysis`, {
    method: 'POST', token: ceo.token, body: { raw_text: 'Ship an internal tool with automated regression tests.', source_type: 'paste' }
  });
  const sessionId = analysis.data.session_id;

  const plan = {
    departments: [], milestones: [], risks: [], assumptions: [],
    stories: [
      {
        name: 'Testing', description: 'Test the tool.', department: '', priority: 'medium', status: 'not_started', start_date: null,
        team_name: 'QA Team', team_confidence: 80, team_reason: 'QA work.',
        tasks: [{ title: 'Write regression tests', description: '', priority: 'medium', status: 'not_started', due_date: null, tags: [], estimated_hours: null, subtasks: [] }]
      },
      {
        name: 'Legal Review', description: 'Unrelated compliance work.', department: '', priority: 'medium', status: 'not_started', start_date: null,
        team_name: 'Legal Team', team_confidence: 90, team_reason: 'No such team exists.',
        tasks: [{ title: 'Legal compliance review', description: '', priority: 'medium', status: 'not_started', due_date: null, tags: [], estimated_hours: null, subtasks: [] }]
      }
    ]
  };

  const commit = await request(`/api/brief-sessions/${sessionId}/commit`, { method: 'POST', token: ceo.token, body: { plan } });
  assert.equal(commit.status, 200);
  assert.equal(commit.data.teams_without_manager.length, 1);
  assert.equal(commit.data.teams_without_manager[0].team_id, teamId);
  assert.equal(commit.data.teams_notified.length, 0);
  assert.equal(commit.data.unassigned_task_count, 1, 'the fabricated "Legal Team" must never be created or matched');

  const tasks = await request(`/api/projects/${projectId}/tasks`, { token: ceo.token });
  const qaTask = tasks.data.find(item => item.title === 'Write regression tests');
  const legalTask = tasks.data.find(item => item.title === 'Legal compliance review');
  assert.equal(Number(qaTask.team_id), teamId, 'work for the unmanaged team must still be saved, not lost');
  assert.equal(legalTask.team_id, null, 'a team name with no real match must never be fabricated');

  const teams = await request(`/api/organizations/${organizationId}/teams`, { token: ceo.token });
  assert.ok(!teams.data.some(item => item.name === 'Legal Team'), 'no phantom team should have been created');
});
