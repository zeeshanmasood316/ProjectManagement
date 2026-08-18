'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', 'seed-data.json'), 'utf8'));
const AUTH_DIR = path.join(__dirname, '.auth');

test('REALTIME (SSE): a direct message sent by one user appears in the other user\'s open conversation with no reload', async ({ browser }) => {
  const workerContext = await browser.newContext({ storageState: path.join(AUTH_DIR, 'worker.json') });
  const workerTwoContext = await browser.newContext({ storageState: path.join(AUTH_DIR, 'worker-two.json') });
  const workerPage = await workerContext.newPage();
  const workerTwoPage = await workerTwoContext.newPage();

  try {
    await workerPage.goto('/');
    await workerPage.locator('[data-view="chat"]').click();
    await workerPage.locator('[data-action="set-chat-mode"][data-mode="direct"]').click();
    await workerPage.locator(`[data-action="select-conversation"][data-id="${seed.conversationId}"]`).click();
    await expect(workerPage.locator('#directMessageForm')).toBeVisible();

    await workerTwoPage.goto('/');
    await workerTwoPage.locator('[data-view="chat"]').click();
    await workerTwoPage.locator('[data-action="set-chat-mode"][data-mode="direct"]').click();
    await workerTwoPage.locator(`[data-action="select-conversation"][data-id="${seed.conversationId}"]`).click();
    await expect(workerTwoPage.locator('#directMessageForm')).toBeVisible();

    const uniqueMessage = `Realtime probe ${Date.now()}`;
    await workerTwoPage.locator('#directMessageForm textarea[name="body"]').fill(uniqueMessage);
    await workerTwoPage.locator('#directMessageForm button[type="submit"]').click();

    // The critical assertion: worker's page must show this WITHOUT any reload/navigation on their side.
    await expect(workerPage.locator('#directMessageFeed').getByText(uniqueMessage)).toBeVisible({ timeout: 8_000 });
  } finally {
    await workerContext.close();
    await workerTwoContext.close();
  }
});

// NOTE ON SCOPE: a test that simulates a real network drop against an already-open SSE connection
// (via Playwright's context.setOffline()) was attempted and deliberately removed. Direct diagnostic
// (a standalone script that opened a real authenticated EventSource, then called setOffline(true) and
// polled its readyState for 20+ seconds) showed the connection's readyState stayed OPEN with zero
// error events the entire time — Playwright/CDP's offline emulation blocks NEW network requests but
// does not interrupt an already-established streaming connection in this Chromium build. That means
// the "#dmConnectionStatus shows Reconnecting… on a dropped connection" behavior could NOT be
// triggered or verified through a genuine network-level failure in this environment. Per instruction,
// this is reported honestly as untestable-here rather than faked as a pass. The reconnect UI code
// itself (source: public/js/messaging.js setDmStreamStatus/connectDmStream) does exist and is wired to the
// EventSource's onopen/onerror handlers — that much is confirmed by reading the source, not by a
// live browser test — but the live trigger could not be reproduced with the tools available.
test('REALTIME (SSE): switching away from and back to a conversation cleanly tears down and re-establishes the live stream (real EventSource lifecycle, not simulated)', async ({ browser }) => {
  const context = await browser.newContext({ storageState: path.join(AUTH_DIR, 'worker.json') });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.locator('[data-view="chat"]').click();
    await page.locator('[data-action="set-chat-mode"][data-mode="direct"]').click();
    await page.locator(`[data-action="select-conversation"][data-id="${seed.conversationId}"]`).click();
    await expect(page.locator('#directMessageForm')).toBeVisible();
    await expect(page.locator('#dmConnectionStatus')).toBeHidden();

    // Leave the conversation view entirely (tears down the EventSource) and come back (opens a new one).
    await page.locator('[data-view="dashboard"]').click();
    await page.locator('[data-view="chat"]').click();
    await page.locator('[data-action="set-chat-mode"][data-mode="direct"]').click();
    await page.locator(`[data-action="select-conversation"][data-id="${seed.conversationId}"]`).click();
    await expect(page.locator('#directMessageForm')).toBeVisible();
    await expect(page.locator('#dmConnectionStatus')).toBeHidden();

    // And the re-established stream is genuinely live: a message sent by the other party still arrives with no reload.
    const workerTwoContext = await browser.newContext({ storageState: path.join(AUTH_DIR, 'worker-two.json') });
    const workerTwoPage = await workerTwoContext.newPage();
    await workerTwoPage.goto('/');
    await workerTwoPage.locator('[data-view="chat"]').click();
    await workerTwoPage.locator('[data-action="set-chat-mode"][data-mode="direct"]').click();
    await workerTwoPage.locator(`[data-action="select-conversation"][data-id="${seed.conversationId}"]`).click();
    const probeMessage = `Reconnect-lifecycle probe ${Date.now()}`;
    await workerTwoPage.locator('#directMessageForm textarea[name="body"]').fill(probeMessage);
    await workerTwoPage.locator('#directMessageForm button[type="submit"]').click();
    await expect(page.locator('#directMessageFeed').getByText(probeMessage)).toBeVisible({ timeout: 8_000 });
    await workerTwoContext.close();
  } finally {
    await context.close();
  }
});

test.describe('NOTIFICATIONS (Phase 3: now genuinely push-based over the per-user SSE stream)', () => {
  test.use({ storageState: path.join(AUTH_DIR, 'worker.json') });

  // NOTE ON HISTORY: this test used to document the OPPOSITE behavior — that notifications were
  // pull-only and an open, idle page never updated its badge without a manual refresh. Phase 3
  // added a 5th SSE hub (GET /api/users/me/events/stream, see src/realtime/userEvents.js) that
  // notifyUser() now pushes a 'notification_created' event through on every notification it
  // writes — this test proves that hook actually reaches an open browser tab live.
  test('a task-assignment notification updates the bell badge on an open, idle page with no reload', async ({ page, browser }) => {
    await page.goto('/');
    await page.waitForSelector('#appShell:not(.hidden)');
    const badgeBefore = Number((await page.locator('#navNotificationBadge').textContent().catch(() => '0')) || '0');

    // Cause a real, server-side notification for this worker while their page stays open and idle —
    // via the CEO's real API session, exactly as a teammate assigning them work would.
    const ceoContext = await browser.newContext({ storageState: path.join(AUTH_DIR, 'ceo.json') });
    const ceoPage = await ceoContext.newPage();
    const createTask = await ceoPage.request.post(`/api/projects/${seed.projectId}/tasks`, {
      data: { title: `Realtime notif probe ${Date.now()}`, owner_id: seed.worker.id }
    });
    expect(createTask.status()).toBe(201);
    await ceoContext.close();

    // The critical assertion: the badge count increments on the already-open page with no
    // reload/navigation — proving the push, not a coincidental poll.
    await expect(page.locator('#navNotificationBadge')).toHaveText(String(badgeBefore + 1), { timeout: 8_000 });

    // It also shows up in the actual list once opened (the SSE event is an invalidation signal;
    // the REST fetch remains the RBAC-correct source of truth for content).
    const notifResponse = await page.request.get('/api/users/me/notifications');
    expect(notifResponse.status()).toBe(200);
    const notifData = await notifResponse.json();
    expect(notifData.items.some(item => item.notification_type === 'task_assignment')).toBeTruthy();
  });
});

test.describe('MESSAGE POPUP + unread badge (Phase 3, item 11/19)', () => {
  test('a DM sent while the recipient is NOT looking at that conversation shows a distinct popup and bumps the message badge (not the notification bell), and never appears in Notifications', async ({ browser }) => {
    const workerContext = await browser.newContext({ storageState: path.join(AUTH_DIR, 'worker.json') });
    const workerPage = await workerContext.newPage();
    try {
      await workerPage.goto('/');
      // Deliberately stay away from chat entirely — on the Dashboard, not looking at any conversation.
      await workerPage.locator('[data-view="dashboard"]').click();
      await expect(workerPage.locator('#navMessageBadge')).toBeHidden();

      const workerTwoContext = await browser.newContext({ storageState: path.join(AUTH_DIR, 'worker-two.json') });
      const workerTwoPage = await workerTwoContext.newPage();
      const uniqueMessage = `Popup probe ${Date.now()}`;
      const sendResponse = await workerTwoPage.request.post(`/api/direct-conversations/${seed.conversationId}/messages`, {
        data: { body: uniqueMessage }
      });
      expect(sendResponse.status()).toBe(201);
      await workerTwoContext.close();

      // The distinct message popup appears (never confused with #toast system notifications).
      await expect(workerPage.locator('#messagePopup')).toHaveClass(/show/, { timeout: 8_000 });
      await expect(workerPage.locator('#messagePopupPreview')).toHaveText(uniqueMessage);

      // The distinct unread-message badge (on the Channel nav item) bumps — the general
      // notification bell must NOT move for a message.
      await expect(workerPage.locator('#navMessageBadge')).toBeVisible();
      await expect(workerPage.locator('#navMessageBadge')).not.toHaveText('0');

      // And it never becomes a general notification — explicit product requirement.
      const notifResponse = await workerPage.request.get('/api/users/me/notifications');
      const notifData = await notifResponse.json();
      expect(notifData.items.some(item => item.notification_type === 'message')).toBeFalsy();
    } finally {
      await workerContext.close();
    }
  });
});
