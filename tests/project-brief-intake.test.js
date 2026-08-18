'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-project-brief-intake-'));
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

test('New Project = Project Brief: paste-to-draft, automatic analysis, details + assignment land at commit', async () => {
  const ceo = await register('pbi_ceo', 'pbi_ceo@example.com', 'Intake CEO');
  const worker = await register('pbi_worker', 'pbi_worker@example.com', 'Intake Worker');

  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Intake Co' } });
  assert.equal(org.status, 201);
  const organizationId = org.data.id;

  await inviteAndApprove(organizationId, ceo.token, worker);

  // Step 1: submit a Project Brief as pasted text — no project exists yet, and this is the
  // paste-equivalent of the file-upload draft route (project_id stays null until commit).
  const draft = await request(`/api/organizations/${organizationId}/client-briefs`, {
    method: 'POST', token: ceo.token, body: { raw_text: 'Build a small internal tool to track team tasks and deadlines.' }
  });
  assert.equal(draft.status, 201);
  assert.ok(draft.data.session_id);
  const sessionId = draft.data.session_id;

  // Step 2: analysis happens automatically on submit — no separate "Generate" click modeled here,
  // this is the same request the UI fires immediately after the draft is created.
  const analyze = await request(`/api/client-briefs/${sessionId}/analyze`, { method: 'POST', token: ceo.token });
  assert.equal(analyze.status, 200);
  assert.ok(analyze.data.plan);

  // Step 3: reviewer fills in Project Details and assigns a worker directly on a task, then commits —
  // this is what the "Project details" + inline Assign step produce before hitting Create Project.
  const plan = {
    departments: [], milestones: [], risks: [], assumptions: [{ text: 'Internal tool, no external users.' }],
    stories: [{
      name: 'Task Tracking', description: 'Core tracking feature.',
      department: '', priority: 'medium', status: 'not_started', start_date: null,
      team_name: '', team_confidence: null, team_reason: '',
      tasks: [{
        title: 'Build task list view', description: 'List and filter tasks.', priority: 'medium', status: 'not_started', due_date: null,
        tags: [], estimated_hours: null, team_name: '', team_confidence: null, team_reason: '',
        owner_id: worker.user.id,
        subtasks: []
      }]
    }]
  };

  const commit = await request(`/api/brief-sessions/${sessionId}/commit`, {
    method: 'POST', token: ceo.token,
    body: {
      plan,
      project_name: 'Internal Tracker', client_name: 'Internal',
      objective: 'Give the team visibility into deadlines', scope: 'Web app, task list only',
      constraints: 'No budget for external tools', priority: 'high', owner_id: ceo.user.id,
      start_date: '2026-01-01', due_date: '2026-03-01'
    }
  });
  assert.equal(commit.status, 200);
  assert.equal(commit.data.storyCount, 1);
  assert.equal(commit.data.taskCount, 1);

  const project = await request(`/api/projects/${commit.data.project_id}`, { token: ceo.token });
  assert.equal(project.status, 200);
  assert.equal(project.data.name, 'Internal Tracker');
  assert.equal(project.data.client_name, 'Internal');
  assert.equal(project.data.objective, 'Give the team visibility into deadlines');
  assert.equal(project.data.scope, 'Web app, task list only');
  assert.equal(project.data.constraints, 'No budget for external tools');
  assert.equal(project.data.priority, 'high');
  assert.equal(project.data.start_date, '2026-01-01');
  assert.equal(project.data.due_date, '2026-03-01');

  // The worker picked during the Assign step must be a real assignment, and must be notified —
  // this is the previously-missing per-worker notification at commit time (team leads already were).
  const tasks = await request(`/api/projects/${commit.data.project_id}/tasks`, { token: ceo.token });
  const task = tasks.data.find(item => item.title === 'Build task list view');
  assert.ok(task);
  assert.equal(Number(task.owner_id), worker.user.id);

  const workerNotifications = await request('/api/users/me/notifications', { token: worker.token });
  assert.equal(workerNotifications.status, 200);
  const assignmentNotification = workerNotifications.data.items.find(item => item.notification_type === 'task_assignment');
  assert.ok(assignmentNotification, 'worker assigned during brief review should be notified at commit time');
  assert.equal(assignmentNotification.action_view, `work:${task.id}`);
});

test('Automatic project-field extraction: labeled brief fields populate; unlabeled fields are never fabricated', async () => {
  const ceo = await register('pbi_extract_ceo', 'pbi_extract_ceo@example.com', 'Extract CEO');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Extract Co' } });
  assert.equal(org.status, 201);
  const organizationId = org.data.id;

  const labeledBrief = [
    'Project: Warehouse Inventory Portal',
    'Client: Northwind Logistics',
    'Objective: Give warehouse staff real-time visibility into stock levels.',
    'Scope: Web portal covering stock lookup and low-stock alerts.',
    'Constraints: Must run on existing warehouse tablets.',
    'Priority: high',
    'Due date: 2026-09-15'
  ].join('\n');

  const draft = await request(`/api/organizations/${organizationId}/client-briefs`, { method: 'POST', token: ceo.token, body: { raw_text: labeledBrief } });
  assert.equal(draft.status, 201);
  const analyze = await request(`/api/client-briefs/${draft.data.session_id}/analyze`, { method: 'POST', token: ceo.token });
  assert.equal(analyze.status, 200);
  const fields = analyze.data.project_fields;
  assert.ok(fields, 'analysis response should include automatically extracted project_fields');
  assert.equal(fields.name, 'Warehouse Inventory Portal');
  assert.equal(fields.client_name, 'Northwind Logistics');
  assert.match(fields.objective, /real-time visibility/);
  assert.match(fields.scope, /stock lookup/);
  assert.match(fields.constraints, /warehouse tablets/);
  assert.equal(fields.priority, 'high');
  assert.equal(fields.due_date, '2026-09-15');

  // A brief with no labeled fields and no clear client/urgency must never have those fields invented.
  const plainBrief = 'We would like some help improving how our team tracks weekly progress.';
  const plainDraft = await request(`/api/organizations/${organizationId}/client-briefs`, { method: 'POST', token: ceo.token, body: { raw_text: plainBrief } });
  const plainAnalyze = await request(`/api/client-briefs/${plainDraft.data.session_id}/analyze`, { method: 'POST', token: ceo.token });
  assert.equal(plainAnalyze.status, 200);
  const plainFields = plainAnalyze.data.project_fields;
  assert.equal(plainFields.name, '', 'no project name label present, so name must stay empty rather than invented');
  assert.equal(plainFields.client_name, '', 'no client mentioned, so client_name must stay empty rather than invented');
  assert.equal(plainFields.priority, 'medium', 'no urgency signal present, priority must default rather than being guessed as something else');
  assert.equal(plainFields.due_date, null, 'no date present, due_date must stay null rather than invented');
  assert.equal(plainFields.start_date, null, 'no date present, start_date must stay null rather than invented');
});
