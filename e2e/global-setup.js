'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { BASE_URL, PASSWORD } = require('./constants');

const AUTH_DIR = path.join(__dirname, '.auth');

async function api(pathname, { method = 'GET', token = '', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(BASE_URL + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (response.status >= 400) throw new Error(`${method} ${pathname} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function register(username) {
  return api('/api/auth/register', {
    method: 'POST',
    body: { username, email: `${username}@example.com`, full_name: username.replace(/_/g, ' '), password: PASSWORD }
  });
}

async function inviteAndApprove(organizationId, ceoToken, invitee, role = 'member') {
  const invite = await api(`/api/organizations/${organizationId}/invitations`, {
    method: 'POST', token: ceoToken, body: { identifier: invitee.user.username, proposed_role: role }
  });
  await api(`/api/invitations/${invite.id}/accept`, { method: 'POST', token: invitee.token });
  await api(`/api/invitations/${invite.id}/approve`, { method: 'POST', token: ceoToken });
}

async function loginThroughRealUiAndSaveState(browser, username, storageStatePath) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE_URL + '/');
  await page.locator('#loginForm input[name="identifier"]').fill(username);
  await page.locator('#loginForm input[name="password"]').fill(PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.locator('#appShell').waitFor({ state: 'visible', timeout: 15_000 });
  await context.storageState({ path: storageStatePath });
  await context.close();
}

module.exports = async function globalSetup() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const ceo = await register('e2e_ceo');
  const manager = await register('e2e_manager');
  const worker = await register('e2e_worker');
  const workerTwo = await register('e2e_worker_two');

  const org = await api('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'E2E Test Org' } });
  const organizationId = org.id;

  await inviteAndApprove(organizationId, ceo.token, manager);
  await inviteAndApprove(organizationId, ceo.token, worker);
  await inviteAndApprove(organizationId, ceo.token, workerTwo);

  const team = await api(`/api/organizations/${organizationId}/teams`, {
    method: 'POST', token: ceo.token, body: { name: 'E2E Engineering Team', lead_user_id: manager.user.id }
  });
  await api(`/api/teams/${team.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: worker.user.id } });
  // The team lead is also a working member of their own team (common real-world setup), which is
  // what actually makes them appear as an assignable candidate in the assign-task UI — leading a
  // team (teams.lead_user_id) and belonging to it (team_members) are independent in this data model.
  await api(`/api/teams/${team.id}/members`, { method: 'POST', token: ceo.token, body: { user_id: manager.user.id } });

  const project = await api('/api/projects', {
    method: 'POST', token: ceo.token, body: { organization_id: organizationId, name: 'E2E Demo Project', objective: 'Exercise the app end-to-end for QA.' }
  });

  // Board cards only render once a task has a column_id, so the default columns must exist and be
  // assigned up front — otherwise a seeded task would be invisible on the Board tab.
  const columns = await api(`/api/projects/${project.id}/board-columns`, { token: ceo.token });
  const notStartedColumn = columns.find(c => c.maps_to_status === 'not_started') || columns[0];
  const inProgressColumn = columns.find(c => c.maps_to_status === 'in_progress') || columns[1];

  const task = await api(`/api/projects/${project.id}/tasks`, {
    method: 'POST', token: ceo.token, body: { title: 'E2E seeded task', team_id: team.id, owner_id: worker.user.id, priority: 'high', column_id: notStartedColumn.id }
  });
  await api(`/api/projects/${project.id}/tasks`, {
    method: 'POST', token: ceo.token, body: { title: 'E2E seeded subtask', parent_task_id: task.id, team_id: team.id, owner_id: worker.user.id }
  });

  const conversation = await api(`/api/organizations/${organizationId}/direct-conversations`, {
    method: 'POST', token: worker.token, body: { user_id: workerTwo.user.id }
  });

  fs.writeFileSync(path.join(AUTH_DIR, 'seed-data.json'), JSON.stringify({
    organizationId, projectId: project.id, teamId: team.id, taskId: task.id, conversationId: conversation.id,
    notStartedColumnId: notStartedColumn.id, inProgressColumnId: inProgressColumn.id,
    ceo: { username: ceo.user.username, id: ceo.user.id },
    manager: { username: manager.user.username, id: manager.user.id },
    worker: { username: worker.user.username, id: worker.user.id },
    workerTwo: { username: workerTwo.user.username, id: workerTwo.user.id }
  }, null, 2));

  const browser = await chromium.launch();
  await loginThroughRealUiAndSaveState(browser, ceo.user.username, path.join(AUTH_DIR, 'ceo.json'));
  await loginThroughRealUiAndSaveState(browser, manager.user.username, path.join(AUTH_DIR, 'manager.json'));
  await loginThroughRealUiAndSaveState(browser, worker.user.username, path.join(AUTH_DIR, 'worker.json'));
  await loginThroughRealUiAndSaveState(browser, workerTwo.user.username, path.join(AUTH_DIR, 'worker-two.json'));
  await browser.close();
};
