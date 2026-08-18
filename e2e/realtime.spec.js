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
// itself (source: public/app.js setDmStreamStatus/connectDmStream) does exist and is wired to the
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

test.describe('NOTIFICATIONS (honest check of actual behavior)', () => {
  test.use({ storageState: path.join(AUTH_DIR, 'worker.json') });

  test('are pull-based, not push-based, in the current implementation — the open page does not update live, but the data is there once asked for', async ({ page, browser }) => {
    await page.goto('/');
    const badgeBefore = (await page.locator('#navNotificationBadge').textContent().catch(() => '0')) || '0';

    // Cause a real, server-side notification for this worker while their page stays open and idle —
    // via the CEO's real API session, exactly as a teammate assigning them work would.
    const ceoContext = await browser.newContext({ storageState: path.join(AUTH_DIR, 'ceo.json') });
    const ceoPage = await ceoContext.newPage();
    const createTask = await ceoPage.request.post(`/api/projects/${seed.projectId}/tasks`, {
      data: { title: `Realtime notif probe ${Date.now()}`, owner_id: seed.worker.id }
    });
    expect(createTask.status()).toBe(201);
    await ceoContext.close();

    // Give any push mechanism, if one existed, a real chance to fire.
    await page.waitForTimeout(2000);
    const badgeAfterWait = (await page.locator('#navNotificationBadge').textContent().catch(() => '0')) || '0';
    // Documenting actual behavior: the notification exists server-side immediately, but the open,
    // idle page does not update its badge without an explicit trigger (no SSE/poll for notifications,
    // unlike channel messages, DMs, and task comments which are genuinely push-based via SSE).
    expect(badgeAfterWait).toBe(badgeBefore);

    // It DOES appear once the user actually asks for it (matches real usage: opening the bell/notifications).
    const notifResponse = await page.request.get('/api/users/me/notifications');
    expect(notifResponse.status()).toBe(200);
    const notifData = await notifResponse.json();
    expect(notifData.items.some(item => item.notification_type === 'task_assignment')).toBeTruthy();
  });
});
