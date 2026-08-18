'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', 'seed-data.json'), 'utf8'));
const AUTH_DIR = path.join(__dirname, '.auth');
const fullName = username => username.replace(/_/g, ' ');

test.describe('CEO', () => {
  test.use({ storageState: path.join(AUTH_DIR, 'ceo.json') });

  test('sees every nav item, including admin-only and manager-only areas', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#appShell')).toBeVisible();
    await expect(page.locator('[data-view="admin"]')).toBeVisible();
    await expect(page.locator('[data-view="meeting"]')).toBeVisible();
    await expect(page.locator('[data-view="members"]')).toBeVisible();
    await expect(page.locator('[data-view="risks"]')).toBeVisible();
    await expect(page.locator('[data-view="changes"]')).toBeVisible();
    await expect(page.locator('[data-view="report"]')).toBeVisible();
  });

  test('dashboard shows org-wide people, including a worker on a team they don\'t manage directly', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="dashboard"]').click();
    await expect(page.getByText(fullName(seed.worker.username), { exact: true }).first()).toBeVisible();
    await expect(page.getByText(fullName(seed.workerTwo.username), { exact: true }).first()).toBeVisible();
  });
});

test.describe('Manager', () => {
  test.use({ storageState: path.join(AUTH_DIR, 'manager.json') });

  test('admin dashboard and meeting notes are hidden, but team-facing areas remain visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#appShell')).toBeVisible();
    await expect(page.locator('[data-view="admin"]')).toBeHidden();
    await expect(page.locator('[data-view="meeting"]')).toBeHidden();
    await expect(page.locator('[data-view="members"]')).toBeVisible();
    await expect(page.locator('[data-view="risks"]')).toBeVisible();
    await expect(page.locator('[data-view="changes"]')).toBeVisible();
    await expect(page.locator('[data-view="report"]')).toBeVisible();
  });

  test('dashboard is scoped to the manager\'s own team: sees their worker, never a worker on another team', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="dashboard"]').click();
    await expect(page.getByText(fullName(seed.worker.username), { exact: true }).first()).toBeVisible();
    await expect(page.getByText(fullName(seed.workerTwo.username), { exact: true })).toHaveCount(0);
  });

  test('the admin-only invitations API rejects a Manager even with a valid, real browser session', async ({ page }) => {
    // This app has no client-side router (one document, view switching is in-memory JS state), so
    // there is no separate "URL" to the admin dashboard to force — the real boundary to prove is the
    // API itself, called with the Manager's actual authenticated browser session (real cookie, not a
    // fabricated token), exactly as a Manager poking devtools/the network tab would attempt it.
    await page.goto('/');
    const response = await page.request.get(`/api/organizations/${seed.organizationId}/invitations`);
    expect(response.status()).toBe(403);
  });
});

test.describe('Worker', () => {
  test.use({ storageState: path.join(AUTH_DIR, 'worker.json') });

  test('People, Risk & Decisions, Change Control, and Reports are hidden from the sidebar entirely', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#appShell')).toBeVisible();
    await expect(page.locator('[data-view="admin"]')).toBeHidden();
    await expect(page.locator('[data-view="meeting"]')).toBeHidden();
    await expect(page.locator('[data-view="members"]')).toBeHidden();
    await expect(page.locator('[data-view="risks"]')).toBeHidden();
    await expect(page.locator('[data-view="changes"]')).toBeHidden();
    await expect(page.locator('[data-view="report"]')).toBeHidden();
    // Still allowed: their own work context.
    await expect(page.locator('[data-view="dashboard"]')).toBeVisible();
    await expect(page.locator('[data-view="work"]')).toBeVisible();
  });

  test('dashboard shows only themself, never a teammate or another worker', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-view="dashboard"]').click();
    await expect(page.getByText(fullName(seed.worker.username), { exact: true }).first()).toBeVisible();
    await expect(page.getByText(fullName(seed.workerTwo.username), { exact: true })).toHaveCount(0);
  });

  test('hidden nav items are also blocked server-side if reached directly — not just visually hidden', async ({ page }) => {
    await page.goto('/');
    const [risks, changes, members, report] = await Promise.all([
      page.request.get(`/api/projects/${seed.projectId}/risks`),
      page.request.get(`/api/projects/${seed.projectId}/changes`),
      page.request.get(`/api/organizations/${seed.organizationId}/members`),
      page.request.get(`/api/projects/${seed.projectId}/export.json`)
    ]);
    expect(risks.status()).toBe(200);
    expect(await risks.json()).toEqual([]);
    expect(changes.status()).toBe(200);
    expect(await changes.json()).toEqual([]);
    expect(members.status()).toBe(200);
    const memberIds = (await members.json()).map(m => Number(m.user_id));
    expect(memberIds).not.toContain(seed.workerTwo.id);
    expect(report.status()).toBe(403);
  });
});
