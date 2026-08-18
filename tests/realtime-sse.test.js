'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-realtime-sse-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.TOKEN_SECRET = 'test-secret-that-is-long-enough';
// Empty string, not delete: config.js's loadEnv() only fills a var when it is exactly
// undefined, so an explicit '' here survives loadEnv() reading .env and keeps this test off any
// real Turso database configured locally.
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

// Opens a real SSE connection against the live server (no mocking of sseHub/userEvents) and
// returns a helper that reads raw `data: {...}` frames off the wire until one satisfies
// `predicate`, or a timeout elapses. Mirrors how a real EventSource consumes the stream, just
// without a browser.
async function openEventStream(pathname, token) {
  const controller = new AbortController();
  const response = await fetch(baseUrl + pathname, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  // One reader for the whole connection's lifetime — re-acquiring getReader() per call is invalid
  // once a previous reader has read from (and released/cancelled) the stream.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(50, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for SSE event')), remaining))
      ]);
      if (result.done) throw new Error('SSE stream ended unexpectedly');
      buffer += decoder.decode(result.value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
        if (!dataLine) continue; // e.g. ": connected" / ": ping" comment frames
        let payload;
        try { payload = JSON.parse(dataLine.slice('data: '.length)); } catch { continue; }
        if (predicate(payload)) return payload;
      }
    }
    throw new Error('timed out waiting for SSE event');
  }

  function close() {
    reader.cancel().catch(() => {});
    controller.abort();
  }

  return { waitFor, close };
}

test('REALTIME SSE: a task-assignment notification is pushed live over /api/users/me/events/stream as notification_created', async () => {
  const ceo = await register('sse-ceo');
  const worker = await register('sse-worker');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'SSE Co' } });
  assert.equal(org.status, 201);
  await inviteAndApprove(org.data.id, ceo.token, worker);

  const stream = await openEventStream('/api/users/me/events/stream', worker.token);
  try {
    const project = await request('/api/projects', { method: 'POST', token: ceo.token, body: { organization_id: org.data.id, name: 'SSE Project' } });
    assert.equal(project.status, 201);
    const task = await request(`/api/projects/${project.data.id}/tasks`, {
      method: 'POST', token: ceo.token, body: { title: 'Live-push me', owner_id: worker.user.id }
    });
    assert.equal(task.status, 201);

    const notificationEvent = await stream.waitFor(payload => payload.type === 'notification_created');
    assert.equal(notificationEvent.payload.notification_type, 'task_assignment');
    assert.equal(Number(notificationEvent.organization_id), Number(org.data.id));

    // The same mutation also fires an explicit task_updated invalidation event (Phase 3's second
    // event category) — proves both hook points work over one real connection, not just the one
    // piggybacked automatically through notifyUser().
    const taskEvent = await stream.waitFor(payload => payload.type === 'task_updated' && Number(payload.id) === Number(task.data.id));
    assert.equal(Number(taskEvent.payload.project_id), Number(project.data.id));
  } finally {
    stream.close();
  }
});

test('REALTIME SSE: a DM delivers a message-popup event over the recipient\'s stream and never becomes a general notification', async () => {
  const ceo = await register('sse-ceo-dm');
  const sender = await register('sse-sender');
  const recipient = await register('sse-recipient');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'SSE DM Co' } });
  assert.equal(org.status, 201);
  await inviteAndApprove(org.data.id, ceo.token, sender);
  await inviteAndApprove(org.data.id, ceo.token, recipient);

  const conversation = await request(`/api/organizations/${org.data.id}/direct-conversations`, {
    method: 'POST', token: sender.token, body: { user_id: recipient.user.id }
  });
  assert.equal(conversation.status, 201);

  const stream = await openEventStream('/api/users/me/events/stream', recipient.token);
  try {
    const beforeUnread = await request('/api/users/me/unread-messages', { token: recipient.token });
    assert.equal(beforeUnread.status, 200);

    const sent = await request(`/api/direct-conversations/${conversation.data.id}/messages`, {
      method: 'POST', token: sender.token, body: { body: 'Hello via SSE' }
    });
    assert.equal(sent.status, 201);

    const messageEvent = await stream.waitFor(payload => payload.type === 'message');
    assert.equal(messageEvent.payload.conversation_type, 'dm');
    assert.equal(Number(messageEvent.payload.conversation_id), Number(conversation.data.id));
    assert.equal(messageEvent.payload.preview, 'Hello via SSE');

    // Never a row in the shared notifications table — messages get their own popup + unread
    // system exclusively (explicit product requirement, Phase 3).
    const recipientNotifications = await request('/api/users/me/notifications', { token: recipient.token });
    assert.ok(!recipientNotifications.data.items.some(item => item.notification_type === 'message'));

    const afterUnread = await request('/api/users/me/unread-messages', { token: recipient.token });
    assert.equal(afterUnread.data.dm_unread_count, Number(beforeUnread.data.dm_unread_count) + 1);
    assert.equal(afterUnread.data.total_unread_count, Number(beforeUnread.data.total_unread_count) + 1);
  } finally {
    stream.close();
  }
});

test('REALTIME: a channel message reply (thread) is fetchable via ?parent_message_id and does not appear as its own top-level fetch surprise', async () => {
  const ceo = await register('thread-ceo');
  const org = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: 'Thread Co' } });
  assert.equal(org.status, 201);
  const channel = await request(`/api/organizations/${org.data.id}/channels`, {
    method: 'POST', token: ceo.token, body: { name: 'thread-test' }
  });
  assert.equal(channel.status, 201);

  const parent = await request(`/api/channels/${channel.data.id}/messages`, { method: 'POST', token: ceo.token, body: { body: 'Parent message' } });
  assert.equal(parent.status, 201);
  assert.equal(parent.data.parent_message_id, null);

  const reply = await request(`/api/channels/${channel.data.id}/messages`, {
    method: 'POST', token: ceo.token, body: { body: 'A reply', parent_message_id: parent.data.id }
  });
  assert.equal(reply.status, 201);
  assert.equal(Number(reply.data.parent_message_id), Number(parent.data.id));

  const thread = await request(`/api/channels/${channel.data.id}/messages?parent_message_id=${parent.data.id}`, { token: ceo.token });
  assert.equal(thread.status, 200);
  assert.equal(thread.data.length, 1);
  assert.equal(thread.data[0].id, reply.data.id);

  // A reply to a task in a different channel is rejected — parent_message_id must belong to the
  // same channel it's posted into.
  const otherChannel = await request(`/api/organizations/${org.data.id}/channels`, { method: 'POST', token: ceo.token, body: { name: 'random' } });
  assert.equal(otherChannel.status, 201);
  const crossChannelReply = await request(`/api/channels/${otherChannel.data.id}/messages`, {
    method: 'POST', token: ceo.token, body: { body: 'invalid cross-channel reply', parent_message_id: parent.data.id }
  });
  assert.equal(crossChannelReply.status, 400);
});
