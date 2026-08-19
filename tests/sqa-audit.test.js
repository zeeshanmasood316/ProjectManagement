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

test('NOTIFICATIONS: reassigning a task notifies BOTH the previous and the new assignee', async () => {
  const ceo = await register('sqa_reassign_ceo');
  const workerA = await register('sqa_reassign_wkr_a');
  const workerB = await register('sqa_reassign_wkr_b');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Reassign Notif Co' } });
  const organizationId = org.data.id;
  await inviteAndApprove(organizationId, ceo.token, workerA);
  await inviteAndApprove(organizationId, ceo.token, workerB);

  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Reassign Project' } });
  const task = await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Reassign me', owner_id: workerA.user.id } });
  assert.equal(task.status, 201);

  const reassign = await request(`/api/tasks/${task.data.id}`, { method: 'PATCH', token: ceo.token, body: { owner_id: workerB.user.id } });
  assert.equal(reassign.status, 200);

  const notifsA = await request('/api/users/me/notifications', { token: workerA.token });
  const unassignedNotif = notifsA.data.items.find(item => item.notification_type === 'task_assignment' && /no longer assigned/i.test(item.body));
  assert.ok(unassignedNotif, 'the previous assignee must be notified that the task moved on');

  const notifsB = await request('/api/users/me/notifications', { token: workerB.token });
  const assignedNotif = notifsB.data.items.find(item => item.notification_type === 'task_assignment' && /reassigned to you/i.test(item.body));
  assert.ok(assignedNotif, 'the new assignee must still be notified as before');

  // Actor-is-the-target edge case: the CEO reassigning a task AWAY FROM THEMSELVES shouldn't
  // produce a redundant "reassigned away from you" notification about their own action.
  const selfOwnedTask = await request(`/api/projects/${project.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'CEO-owned task', owner_id: ceo.user.id } });
  assert.equal(selfOwnedTask.status, 201);
  const reassignAwayFromSelf = await request(`/api/tasks/${selfOwnedTask.data.id}`, { method: 'PATCH', token: ceo.token, body: { owner_id: workerA.user.id } });
  assert.equal(reassignAwayFromSelf.status, 200);
  const ceoNotifs = await request('/api/users/me/notifications', { token: ceo.token });
  const selfActedNotifCount = ceoNotifs.data.items.filter(item => item.notification_type === 'task_assignment' && /no longer assigned/i.test(item.body)).length;
  assert.equal(selfActedNotifCount, 0, 'the CEO reassigning their own task away must not generate a "no longer assigned" notification about their own action');
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

  const statusUpdate = await request(`/api/tasks/${subtask.data.id}`, { method: 'PATCH', token: ceo.token, body: { status: 'in_progress' } });
  assert.equal(statusUpdate.status, 200);
  const subtaskAfter = await request(`/api/tasks/${subtask.data.id}`, { token: ceo.token });
  assert.equal(subtaskAfter.data.status, 'in_progress');

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

test('WORK BREAKDOWN: a task created with no Story can later be attached to one, and set back to unassigned, without losing its other data', async () => {
  const ceo = await register('sqa_unassignstory_ceo');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Unassigned Story Co' } });
  const organizationId = org.data.id;
  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Unassigned Story Project' } });
  const projectId = project.data.id;

  const story = await request(`/api/projects/${projectId}/stories`, { method: 'POST', token: ceo.token, body: { name: 'Authentication' } });
  assert.equal(story.status, 201);

  const task = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Story-less task', priority: 'high', status: 'in_progress' } });
  assert.equal(task.status, 201);
  assert.equal(task.data.story_id, null, 'a task created without a story_id must start unassigned to any story');

  const subtask = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Story-less subtask', parent_task_id: task.data.id } });
  assert.equal(subtask.status, 201);

  const attach = await request(`/api/tasks/${task.data.id}`, { method: 'PATCH', token: ceo.token, body: { story_id: story.data.id } });
  assert.equal(attach.status, 200);
  assert.equal(Number(attach.data.story_id), story.data.id, 'CEO/Manager must be able to attach an existing story to a previously story-less task');
  assert.equal(attach.data.title, 'Story-less task', 'attaching a story must not disturb the task title');
  assert.equal(attach.data.status, 'in_progress', 'attaching a story must not disturb the task status');
  assert.equal(attach.data.priority, 'high', 'attaching a story must not disturb the task priority');
  const subtaskStillLinked = await request(`/api/tasks/${subtask.data.id}`, { token: ceo.token });
  assert.equal(Number(subtaskStillLinked.data.parent_task_id), task.data.id, 'the subtask must remain linked to its parent after the parent gains a story');

  const unassign = await request(`/api/tasks/${task.data.id}`, { method: 'PATCH', token: ceo.token, body: { story_id: null } });
  assert.equal(unassign.status, 200);
  assert.equal(unassign.data.story_id, null, 'a task must be settable back to "no story" (unassigned) at will');
  assert.equal(unassign.data.title, 'Story-less task', 'unassigning the story must not disturb any other task data');
});

test('WORK BREAKDOWN: existing tasks can be bulk-linked into a new Story without being duplicated or losing their data', async () => {
  const ceo = await register('sqa_linktasks_ceo');
  const worker = await register('sqa_linktasks_wkr');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Link Tasks Co' } });
  const organizationId = org.data.id;
  await inviteAndApprove(organizationId, ceo.token, worker);
  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Link Tasks Project' } });
  const projectId = project.data.id;

  const taskA = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Pre-existing task A', owner_id: worker.user.id, status: 'in_progress' } });
  const taskB = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Pre-existing task B' } });
  assert.equal(taskA.status, 201);
  assert.equal(taskB.status, 201);
  const subtaskOfA = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Subtask of A', parent_task_id: taskA.data.id } });
  assert.equal(subtaskOfA.status, 201);

  // A task in an unrelated project must be rejected, not silently ignored.
  const otherProject = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Other Project' } });
  const foreignTask = await request(`/api/projects/${otherProject.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Foreign task' } });

  const story = await request(`/api/projects/${projectId}/stories`, { method: 'POST', token: ceo.token, body: { name: 'New Story' } });
  assert.equal(story.status, 201);

  const badLink = await request(`/api/stories/${story.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { task_ids: [taskA.data.id, foreignTask.data.id] } });
  assert.equal(badLink.status, 400, 'linking a task from a different project must be rejected outright, not silently skipped');

  const link = await request(`/api/stories/${story.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { task_ids: [taskA.data.id, taskB.data.id] } });
  assert.equal(link.status, 200);
  assert.deepEqual(new Set(link.data.linked_task_ids), new Set([taskA.data.id, taskB.data.id]));

  const taskAAfter = await request(`/api/tasks/${taskA.data.id}`, { token: ceo.token });
  assert.equal(Number(taskAAfter.data.story_id), story.data.id);
  assert.equal(taskAAfter.data.owner_id, worker.user.id, 'linking to a story must not disturb an existing assignment');
  assert.equal(taskAAfter.data.status, 'in_progress', 'linking to a story must not disturb an existing status');

  const taskBAfter = await request(`/api/tasks/${taskB.data.id}`, { token: ceo.token });
  assert.equal(Number(taskBAfter.data.story_id), story.data.id);

  const subtaskAfter = await request(`/api/tasks/${subtaskOfA.data.id}`, { token: ceo.token });
  assert.equal(Number(subtaskAfter.data.parent_task_id), taskA.data.id, 'the subtask link to its parent must survive the parent being linked to a story');

  const allProjectTasks = await request(`/api/projects/${projectId}/tasks`, { token: ceo.token });
  const matchingIds = allProjectTasks.data.filter(t => t.title === 'Pre-existing task A');
  assert.equal(matchingIds.length, 1, 'linking a task into a story must never duplicate it');
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

// ---------------------------------------------------------------------------
// 10. DELETE PROJECT: full cascade cleanup, no orphans, no cross-project/org damage
// ---------------------------------------------------------------------------

test('DELETE PROJECT: removes every project-scoped record with no orphans, requires confirmation and CEO/admin/moderator access, and never touches sibling projects or shared org data', async () => {
  const ceo = await register('sqa_delproj_ceo');
  const manager = await register('sqa_delproj_mgr');
  const worker = await register('sqa_delproj_wkr');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Del Project Co' } });
  const organizationId = org.data.id;
  await inviteAndApprove(organizationId, ceo.token, manager);
  await inviteAndApprove(organizationId, ceo.token, worker);
  const team = await request(`/api/organizations/${organizationId}/teams`, { method: 'POST', token: ceo.token, body: { name: 'Del Project Team', lead_user_id: manager.user.id } });
  await request(`/api/teams/${team.data.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: worker.user.id } });

  // A sibling project that must survive completely untouched.
  const siblingProject = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Sibling Project' } });
  const siblingTask = await request(`/api/projects/${siblingProject.data.id}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Sibling task', owner_id: worker.user.id } });
  assert.equal(siblingTask.status, 201);

  const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'Doomed Project' } });
  const projectId = project.data.id;

  const taskA = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Doomed task A', owner_id: worker.user.id, team_id: team.data.id } });
  const taskB = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Doomed task B' } });
  const subtask = await request(`/api/projects/${projectId}/tasks`, { method: 'POST', token: ceo.token, body: { title: 'Doomed subtask', parent_task_id: taskA.data.id } });
  await request(`/api/tasks/${taskB.data.id}`, { method: 'PATCH', token: ceo.token, body: { dependencies: [taskA.data.id] } });
  const comment = await request(`/api/tasks/${taskA.data.id}/comments`, { method: 'POST', token: ceo.token, body: { body: 'A comment that must not survive' } });
  assert.equal(comment.status, 201);
  const story = await request(`/api/projects/${projectId}/stories`, { method: 'POST', token: ceo.token, body: { name: 'Doomed story' } });
  const milestone = await request(`/api/projects/${projectId}/milestones`, { method: 'POST', token: ceo.token, body: { name: 'Doomed milestone' } });
  const column = await request(`/api/projects/${projectId}/board-columns`, { method: 'POST', token: ceo.token, body: { name: 'Doomed column', maps_to_status: 'not_started' } });
  const risk = await request(`/api/projects/${projectId}/risks/scan`, { method: 'POST', token: ceo.token });
  assert.ok(risk.data.count > 0, 'the risk scan must actually produce at least one risk (taskB is unowned) to make the cascade-delete check meaningful');
  const decision = await request(`/api/projects/${projectId}/decisions`, { method: 'POST', token: ceo.token, body: { title: 'Doomed decision', detail: 'because' } });
  const changeReq = await request(`/api/projects/${projectId}/changes`, { method: 'POST', token: ceo.token, body: { title: 'Doomed change', description: 'a change nobody will keep' } });
  assert.equal(story.status, 201);
  assert.equal(milestone.status, 201);
  assert.equal(column.status, 201);
  assert.equal(decision.status, 201);
  assert.equal(changeReq.status, 201);

  // Workers and Managers must not be able to delete a project — CEO/admin/moderator only.
  const workerAttempt = await request(`/api/projects/${projectId}`, { method: 'DELETE', token: worker.token, body: { confirm_name: 'Doomed Project' } });
  assert.equal(workerAttempt.status, 403, 'a plain Worker must not be able to delete a project');
  const managerAttempt = await request(`/api/projects/${projectId}`, { method: 'DELETE', token: manager.token, body: { confirm_name: 'Doomed Project' } });
  assert.equal(managerAttempt.status, 403, 'a Manager (team lead) must not be able to delete a project — CEO/admin/moderator only');

  // Deletion must require typing the exact project name to confirm.
  const badConfirm = await request(`/api/projects/${projectId}`, { method: 'DELETE', token: ceo.token, body: { confirm_name: 'wrong name' } });
  assert.equal(badConfirm.status, 400, 'deletion must be rejected without the exact project name as confirmation');
  const stillThere = await request(`/api/projects/${projectId}`, { token: ceo.token });
  assert.equal(stillThere.status, 200, 'the project must still exist after a rejected confirmation attempt');

  const del = await request(`/api/projects/${projectId}`, { method: 'DELETE', token: ceo.token, body: { confirm_name: 'Doomed Project' } });
  assert.equal(del.status, 200);

  // The project itself, and every project-scoped record, must be gone — verified directly
  // against the database, not just via the API (which would 404 anyway once scoping fails).
  assert.equal(await db.get('SELECT id FROM projects WHERE id=?', [projectId]), null, 'project row must be gone');
  assert.equal(await db.get('SELECT id FROM tasks WHERE project_id=?', [projectId]), null, 'all tasks must be gone');
  assert.equal(await db.get('SELECT id FROM dependencies WHERE task_id=? OR depends_on_task_id=?', [taskB.data.id, taskA.data.id]), null, 'dependency rows must be gone');
  assert.equal(await db.get('SELECT id FROM task_comments WHERE id=?', [comment.data.id]), null, 'task comments must be gone');
  assert.equal(await db.get('SELECT id FROM stories WHERE project_id=?', [projectId]), null, 'stories must be gone');
  assert.equal(await db.get('SELECT id FROM milestones WHERE project_id=?', [projectId]), null, 'milestones must be gone');
  assert.equal(await db.get('SELECT id FROM board_columns WHERE project_id=?', [projectId]), null, 'board columns must be gone');
  assert.equal(await db.get('SELECT id FROM risks WHERE project_id=?', [projectId]), null, 'risks must be gone');
  assert.equal(await db.get('SELECT id FROM decisions WHERE project_id=?', [projectId]), null, 'decisions must be gone');
  assert.equal(await db.get('SELECT id FROM changes WHERE project_id=?', [projectId]), null, 'changes must be gone');
  assert.equal(await db.get('SELECT id FROM audit_log WHERE project_id=?', [projectId]), null, 'this project\'s old audit history must be gone');

  // Sibling project and all shared org data must be completely untouched.
  const siblingAfter = await request(`/api/projects/${siblingProject.data.id}`, { token: ceo.token });
  assert.equal(siblingAfter.status, 200, 'the sibling project must survive');
  const siblingTaskAfter = await db.get('SELECT id FROM tasks WHERE id=?', [siblingTask.data.id]);
  assert.ok(siblingTaskAfter, 'the sibling project\'s task must survive');
  const teamAfter = await request(`/api/teams/${team.data.id}/workspace`, { token: ceo.token });
  assert.equal(teamAfter.status, 200, 'the team must survive project deletion');
  const workerStillMember = await request(`/api/organizations/${organizationId}/members`, { token: ceo.token });
  assert.ok(workerStillMember.data.some(m => Number(m.user_id) === worker.user.id), 'org membership must be completely unaffected by a project deletion');

  // The deletion itself leaves exactly one permanent, organization-level audit trail entry.
  const orgAuditRow = await db.get("SELECT id FROM audit_log WHERE organization_id=? AND entity_type='project' AND action='deleted' AND entity_id=?", [organizationId, projectId]);
  assert.ok(orgAuditRow, 'the deletion itself must be recorded as a permanent, project_id-less organization audit entry');
});
