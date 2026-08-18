'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-sqa-audit-'));
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

async function register(username, password = 'Password123!') {
  const result = await request('/api/auth/register', {
    method: 'POST',
    body: { username, email: `${username}@example.com`, full_name: username, password }
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

// ---------------------------------------------------------------------------
// 1. AUTHENTICATION
// ---------------------------------------------------------------------------

test('AUTH: invalid credentials are rejected, and unknown vs wrong-password give the same generic error (no user enumeration)', async () => {
  await register('sqa_auth_user');
  const wrongPassword = await request('/api/auth/login', { method: 'POST', body: { identifier: 'sqa_auth_user', password: 'WrongPassword1!' } });
  assert.equal(wrongPassword.status, 401);
  const unknownUser = await request('/api/auth/login', { method: 'POST', body: { identifier: 'sqa_nonexistent_user', password: 'WrongPassword1!' } });
  assert.equal(unknownUser.status, 401);
  assert.equal(wrongPassword.data.error || wrongPassword.data.message, unknownUser.data.error || unknownUser.data.message);
});

test('AUTH: protected routes reject requests with no token and with a garbage token', async () => {
  const noToken = await request('/api/auth/me');
  assert.equal(noToken.status, 401);
  const garbageToken = await request('/api/auth/me', { token: 'not-a-real-token' });
  assert.equal(garbageToken.status, 401);
});

test('AUTH: a session token stops working after logout (direct reuse of a dead session must fail)', async () => {
  const user = await register('sqa_logout_user');
  const meBefore = await request('/api/auth/me', { token: user.token });
  assert.equal(meBefore.status, 200);
  const logout = await request('/api/auth/logout', { method: 'POST', token: user.token });
  assert.equal(logout.status, 200);
  const meAfter = await request('/api/auth/me', { token: user.token });
  assert.equal(meAfter.status, 401, 'a revoked session token must be rejected on the very next request, not just client-side forgotten');
});

test('AUTH: direct URL/API access to an org resource without membership is rejected server-side', async () => {
  const ceo = await register('sqa_auth_ceo');
  const outsider = await register('sqa_auth_outsider');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Auth Test Co' } });
  assert.equal(org.status, 201);
  const outsiderAccess = await request(`/api/organizations/${org.data.id}`, { token: outsider.token });
  assert.equal(outsiderAccess.status, 403, 'a user with no membership in the org must not be able to load it by guessing/typing its id');
});

// ---------------------------------------------------------------------------
// 2 & 7. DASHBOARD SCOPING (per-role)
// ---------------------------------------------------------------------------

test('DASHBOARD: CEO sees org-wide people/team data, Manager sees only their team, Worker sees only themself', async () => {
  const ceo = await register('sqa_dash_ceo');
  const manager = await register('sqa_dash_mgr');
  const worker = await register('sqa_dash_wkr');
  const otherWorker = await register('sqa_dash_other');

  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Dashboard Co' } });
  const organizationId = org.data.id;
  await inviteAndApprove(organizationId, ceo.token, manager);
  await inviteAndApprove(organizationId, ceo.token, worker);
  await inviteAndApprove(organizationId, ceo.token, otherWorker);

  const team = await request(`/api/organizations/${organizationId}/teams`, { method: 'POST', token: ceo.token, body: { name: 'Dash Team', lead_user_id: manager.user.id } });
  await request(`/api/teams/${team.data.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: worker.user.id } });

  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Dash Project' } });
  await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Team task', team_id: team.data.id, owner_id: worker.user.id } });
  await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Unrelated task', owner_id: otherWorker.user.id } });

  const ceoDash = await request(`/api/organizations/${organizationId}/dashboard`, { token: ceo.token });
  assert.equal(ceoDash.status, 200);
  const ceoPeopleIds = new Set(ceoDash.data.people.map(p => Number(p.user_id)));
  assert.ok(ceoPeopleIds.has(worker.user.id) && ceoPeopleIds.has(otherWorker.user.id), 'CEO dashboard must show every org member');

  const mgrDash = await request(`/api/organizations/${organizationId}/dashboard`, { token: manager.token });
  assert.equal(mgrDash.status, 200);
  const mgrPeopleIds = new Set(mgrDash.data.people.map(p => Number(p.user_id)));
  assert.ok(mgrPeopleIds.has(worker.user.id), 'Manager dashboard must include their own team member');
  assert.ok(!mgrPeopleIds.has(otherWorker.user.id), 'Manager dashboard must not include a worker outside their team');

  const wkrDash = await request(`/api/organizations/${organizationId}/dashboard`, { token: worker.token });
  assert.equal(wkrDash.status, 200);
  assert.deepEqual(wkrDash.data.people.map(p => Number(p.user_id)), [worker.user.id], 'Worker dashboard must only show themself, not teammates or org-wide stats');
});

// ---------------------------------------------------------------------------
// 8. NOTIFICATIONS
// ---------------------------------------------------------------------------

test('NOTIFICATIONS: assignment creates a notification, read/unread toggles correctly, persists across refetch, and cannot be marked read by another user', async () => {
  const ceo = await register('sqa_notif_ceo');
  const worker = await register('sqa_notif_wkr');
  const otherUser = await register('sqa_notif_other');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Notif Co' } });
  const organizationId = org.data.id;
  await inviteAndApprove(organizationId, ceo.token, worker);
  await inviteAndApprove(organizationId, ceo.token, otherUser);

  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Notif Project' } });
  const task = await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Notify me', owner_id: worker.user.id } });
  assert.equal(task.status, 201);

  const notifs = await request('/api/users/me/notifications', { token: worker.token });
  assert.equal(notifs.status, 200);
  const assignmentNotif = notifs.data.items.find(item => item.notification_type === 'task_assignment');
  assert.ok(assignmentNotif, 'assigning a task must generate a notification for the new owner');
  assert.equal(assignmentNotif.read_at, null, 'a fresh notification must start unread (read_at null)');

  const markRead = await request(`/api/notifications/${assignmentNotif.id}/read`, { method: 'PATCH', token: worker.token });
  assert.equal(markRead.status, 200);

  const notifsAfter = await request('/api/users/me/notifications', { token: worker.token });
  const sameNotif = notifsAfter.data.items.find(item => item.id === assignmentNotif.id);
  assert.ok(sameNotif.read_at, 'read state must persist across refetch');

  // A second, unrelated notification for the read-all check.
  const task2 = await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Notify me again', owner_id: worker.user.id } });
  assert.equal(task2.status, 201);
  const readAll = await request('/api/users/me/notifications/read-all', { method: 'POST', token: worker.token });
  assert.equal(readAll.status, 200);
  const notifsFinal = await request('/api/users/me/notifications', { token: worker.token });
  assert.ok(notifsFinal.data.items.every(item => Boolean(item.read_at)), 'read-all must mark every notification read');

  // Ownership: another user must not be able to mark someone else's notification read via a guessed id.
  const otherAttempt = await request(`/api/notifications/${assignmentNotif.id}/read`, { method: 'PATCH', token: otherUser.token });
  assert.notEqual(otherAttempt.status, 200, 'a user must not be able to mark another user\'s notification as read by guessing its id');
});

// ---------------------------------------------------------------------------
// 9. MESSAGING (private/direct messages)
// ---------------------------------------------------------------------------

test('MESSAGING: direct messages send/receive/persist correctly, and an unrelated org member cannot read or post into someone else\'s conversation', async () => {
  const ceo = await register('sqa_msg_ceo');
  const userA = await register('sqa_msg_a');
  const userB = await register('sqa_msg_b');
  const outsider = await register('sqa_msg_outsider');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Msg Co' } });
  const organizationId = org.data.id;
  await inviteAndApprove(organizationId, ceo.token, userA);
  await inviteAndApprove(organizationId, ceo.token, userB);
  await inviteAndApprove(organizationId, ceo.token, outsider);

  const conversation = await request(`/api/organizations/${organizationId}/direct-conversations`, { method: 'POST', token: userA.token, body: { user_id: userB.user.id } });
  assert.equal(conversation.status, 201);
  const conversationId = conversation.data.id;

  const sent = await request(`/api/direct-conversations/${conversationId}/messages`, { method: 'POST', token: userA.token, body: { body: 'Hello there' } });
  assert.equal(sent.status, 201);

  const receivedByB = await request(`/api/direct-conversations/${conversationId}/messages`, { token: userB.token });
  assert.equal(receivedByB.status, 200);
  assert.ok(receivedByB.data.some(m => m.body === 'Hello there'), 'the recipient must see the sent message');

  const refetchByA = await request(`/api/direct-conversations/${conversationId}/messages`, { token: userA.token });
  assert.ok(refetchByA.data.some(m => m.body === 'Hello there'), 'the message must persist for the sender across refetch too');

  const outsiderRead = await request(`/api/direct-conversations/${conversationId}/messages`, { token: outsider.token });
  assert.equal(outsiderRead.status, 403, 'a third org member must not be able to read a conversation they are not part of');

  const outsiderPost = await request(`/api/direct-conversations/${conversationId}/messages`, { method: 'POST', token: outsider.token, body: { body: 'butting in' } });
  assert.equal(outsiderPost.status, 403, 'a third org member must not be able to post into a conversation they are not part of');
});

// ---------------------------------------------------------------------------
// 5. WORK BREAKDOWN: task/subtask CRUD, board columns, and persistence
// ---------------------------------------------------------------------------

test('WORK BREAKDOWN: task and subtask create/edit/status-update persist across refetch; board columns can be created and renamed', async () => {
  const ceo = await register('sqa_wb_ceo');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'WB Co' } });
  const organizationId = org.data.id;
  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'WB Project' } });
  const projectId = project.data.id;

  const task = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Build the thing', priority: 'high' } });
  assert.equal(task.status, 201);
  const taskId = task.data.id;

  const editTask = await request(`/api/tasks/${taskId}`, { method: 'PATCH', token: ceo.token, body: { title: 'Build the thing (v2)', priority: 'critical' } });
  assert.equal(editTask.status, 200);
  const taskAfterEdit = await request(`/api/tasks/${taskId}`, { token: ceo.token });
  assert.equal(taskAfterEdit.data.title, 'Build the thing (v2)');
  assert.equal(taskAfterEdit.data.priority, 'critical');

  const subtask = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Sub-step one', parent_task_id: taskId } });
  assert.equal(subtask.status, 201);
  assert.equal(Number(subtask.data.parent_task_id), taskId);

  const statusUpdate = await request(`/api/tasks/${subtask.data.id}`, { method: 'PATCH', token: ceo.token, body: { status: 'in_progress', progress: 50 } });
  assert.equal(statusUpdate.status, 200);
  const subtaskAfter = await request(`/api/tasks/${subtask.data.id}`, { token: ceo.token });
  assert.equal(subtaskAfter.data.status, 'in_progress');
  assert.equal(Number(subtaskAfter.data.progress), 50);

  const listAfter = await request(`/api/projects/${projectId}/tasks`, { token: ceo.token });
  const subtaskInList = listAfter.data.find(t => t.id === subtask.data.id);
  assert.ok(subtaskInList, 'the subtask must appear in the project task list after a refetch');
  assert.equal(subtaskInList.status, 'in_progress');

  const column = await request(`/api/projects/${projectId}/board-columns`, { method: 'POST', token: ceo.token, body: { name: 'In Review', maps_to_status: 'in_progress' } });
  assert.equal(column.status, 201);
  const renamedColumn = await request(`/api/board-columns/${column.data.id}`, { method: 'PATCH', token: ceo.token, body: { name: 'Peer Review' } });
  assert.equal(renamedColumn.status, 200);
  const columnsAfter = await request(`/api/projects/${projectId}/board-columns`, { token: ceo.token });
  assert.ok(columnsAfter.data.some(c => c.id === column.data.id && c.name === 'Peer Review'), 'the renamed column must persist across refetch');
});

// ---------------------------------------------------------------------------
// 6. ASSIGNMENTS: subtask-specific + persistence
// ---------------------------------------------------------------------------

test('ASSIGNMENTS: assign-with-subtasks fills unassigned subtasks and the assignment persists; a worker cannot use it to assign at all', async () => {
  const ceo = await register('sqa_assign_ceo');
  const manager = await register('sqa_assign_mgr');
  const worker = await register('sqa_assign_wkr');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Assign Co' } });
  const organizationId = org.data.id;
  await inviteAndApprove(organizationId, ceo.token, manager);
  await inviteAndApprove(organizationId, ceo.token, worker);
  const team = await request(`/api/organizations/${organizationId}/teams`, { method: 'POST', token: ceo.token, body: { name: 'Assign Team', lead_user_id: manager.user.id } });
  await request(`/api/teams/${team.data.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: worker.user.id } });

  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Assign Project' } });
  const task = await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Parent task', team_id: team.data.id } });
  const sub1 = await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Sub A', parent_task_id: task.data.id, team_id: team.data.id } });
  const sub2 = await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Sub B', parent_task_id: task.data.id, team_id: team.data.id } });

  const workerAttempt = await request(`/api/tasks/${task.data.id}/assign-with-subtasks`, {
    method: 'POST', token: worker.token, body: { owner_id: worker.user.id, include_unassigned_subtasks: true }
  });
  assert.equal(workerAttempt.status, 403, 'a Worker must not be able to assign a task to themself or anyone via assign-with-subtasks');

  const managerAssign = await request(`/api/tasks/${task.data.id}/assign-with-subtasks`, {
    method: 'POST', token: manager.token, body: { owner_id: worker.user.id, include_unassigned_subtasks: true }
  });
  assert.equal(managerAssign.status, 200);
  assert.deepEqual(new Set(managerAssign.data.assigned_subtask_ids), new Set([sub1.data.id, sub2.data.id]));

  const sub1After = await request(`/api/tasks/${sub1.data.id}`, { token: manager.token });
  assert.equal(Number(sub1After.data.owner_id), worker.user.id, 'subtask assignment must persist across refetch');
});

// ---------------------------------------------------------------------------
// 12. ERROR HANDLING
// ---------------------------------------------------------------------------

test('ERROR HANDLING: invalid input is rejected with a clean 400/404, not a crash or a 500', async () => {
  const ceo = await register('sqa_err_ceo');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Err Co' } });
  const organizationId = org.data.id;
  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Err Project' } });

  const missingTitle = await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: '' } });
  assert.equal(missingTitle.status, 400);

  const badPriority = await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Valid title', priority: 'super-urgent' } });
  // priority silently coerces to 'medium' rather than erroring — verify it does not crash and produces a valid enum value either way.
  assert.equal(badPriority.status, 201);
  assert.ok(['low', 'medium', 'high', 'critical'].includes(badPriority.data.priority));

  const nonexistentProject = await request('/api/projects/999999999', { token: ceo.token });
  assert.equal(nonexistentProject.status, 404);

  const nonexistentTask = await request('/api/tasks/999999999', { token: ceo.token });
  assert.equal(nonexistentTask.status, 404);

  const malformedId = await request('/api/projects/not-a-number', { token: ceo.token });
  assert.equal(malformedId.status, 400, 'a non-numeric id in the URL must be a clean 400, not an unhandled exception');
});
