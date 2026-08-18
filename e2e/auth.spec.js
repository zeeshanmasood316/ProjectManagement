'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { PASSWORD } = require('./constants');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', 'seed-data.json'), 'utf8'));

// This file intentionally does NOT set a storageState — every test starts logged out,
// exactly like a fresh visitor, so login/logout/direct-URL-access are exercised for real.

test('login: invalid credentials are rejected in the real UI with a visible error, valid credentials reach the app shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#authScreen')).toBeVisible();
  await expect(page.locator('#appShell')).toBeHidden();

  await page.locator('#loginForm input[name="identifier"]').fill(seed.ceo.username);
  await page.locator('#loginForm input[name="password"]').fill('WrongPassword!!');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#toast.error')).toContainText(/invalid/i, { timeout: 5000 });
  await expect(page.locator('#appShell')).toBeHidden();

  await page.locator('#loginForm input[name="password"]').fill(PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#appShell')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#authScreen')).toBeHidden();
});

test('session persists across a real page reload, and logout returns to the auth screen and blocks a subsequent reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('#loginForm input[name="identifier"]').fill(seed.worker.username);
  await page.locator('#loginForm input[name="password"]').fill(PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#appShell')).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.locator('#appShell')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#authScreen')).toBeHidden();

  await page.locator('#logoutBtn').click();
  await expect(page.locator('#authScreen')).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.locator('#authScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#appShell')).toBeHidden();
});

test('an unauthenticated browser hitting the app directly never sees workspace data, even momentarily', async ({ page }) => {
  const dashboardCalls = [];
  page.on('response', response => {
    if (response.url().includes('/api/organizations/') && response.url().includes('/dashboard')) dashboardCalls.push(response.status());
  });
  await page.goto('/');
  await expect(page.locator('#authScreen')).toBeVisible();
  await expect(page.locator('#appShell')).toBeHidden();
  // No dashboard call should ever have succeeded for a signed-out visitor.
  expect(dashboardCalls.every(status => status === 401 || status === 403)).toBeTruthy();
});
