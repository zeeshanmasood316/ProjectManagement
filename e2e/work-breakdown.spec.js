'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', 'seed-data.json'), 'utf8'));
const AUTH_DIR = path.join(__dirname, '.auth');

test.use({ storageState: path.join(AUTH_DIR, 'ceo.json') });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // The project picker (#projectPickerWrap) is only shown on certain views — not the default
  // landing view — so "work" must be selected first before the picker becomes interactable.
  await page.locator('[data-view="work"]').click();
  // Other spec files in this run create additional projects against the same shared test database;
  // the app defaults to whichever project was updated most recently when none is explicitly chosen
  // (public/js/workspace-loader.js, loadWorkspace), so this must pin the exact seeded project rather
  // than rely on that default.
  await page.locator('#projectSelect').selectOption(String(seed.projectId));
  await page.locator('[data-action="set-project-tab"][data-tab="board"]').click();
  await expect(page.locator('.kanban-board')).toBeVisible();
});

test('drag-and-drop: moving a task card to another column updates its status/column and persists after a real reload', async ({ page }) => {
  const card = page.locator(`[data-drag-board-task="${seed.taskId}"]`);
  const targetColumn = page.locator(`[data-drop-board-column="${seed.inProgressColumnId}"]`);
  await expect(card).toBeVisible();

  // locator.dragTo()'s single-step mouse move is occasionally too fast for this app's dragover
  // handler (public/js/dnd.js) to register the current drop target before drop fires — a known
  // Playwright caveat with native HTML5 DnD, observed here as intermittent flakiness across repeated
  // runs. Driving the mouse through explicit down/move/move/up steps is the standard, reliable fix.
  const sourceBox = await card.boundingBox();
  const targetBox = await targetColumn.boundingBox();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 20, sourceBox.y + sourceBox.height / 2, { steps: 5 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 40, { steps: 10 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 40, { steps: 2 });
  await page.mouse.up();

  await expect(page.locator(`[data-drop-board-column="${seed.inProgressColumnId}"] [data-drag-board-task="${seed.taskId}"]`)).toBeVisible({ timeout: 10_000 });

  // Real persistence check: reload the whole page (fresh fetch from the server, not client cache).
  await page.reload();
  await page.locator('[data-view="work"]').click();
  await page.locator('[data-action="set-project-tab"][data-tab="board"]').click();
  await expect(page.locator(`[data-drop-board-column="${seed.inProgressColumnId}"] [data-drag-board-task="${seed.taskId}"]`)).toBeVisible({ timeout: 10_000 });

  const taskResponse = await page.request.get(`/api/tasks/${seed.taskId}`);
  const taskData = await taskResponse.json();
  expect(Number(taskData.column_id)).toBe(seed.inProgressColumnId);
  expect(taskData.status).toBe('in_progress');
});

test('assignment via the UI: reassigning a task\'s owner from the board card persists after reload', async ({ page }) => {
  const card = page.locator(`[data-drag-board-task="${seed.taskId}"]`);
  await card.locator('[data-action="quick-assign-task"]').click();

  await expect(page.locator('#assignTaskForm')).toBeVisible();
  await page.locator('#assignTaskForm select[name="owner_id"]').selectOption(String(seed.manager.id));
  await page.locator('#assignTaskForm button[type="submit"]').click();
  await expect(page.locator('#assignTaskForm')).toBeHidden({ timeout: 10_000 });

  await page.reload();
  const taskResponse = await page.request.get(`/api/tasks/${seed.taskId}`);
  const taskData = await taskResponse.json();
  expect(Number(taskData.owner_id)).toBe(seed.manager.id);

  // Put ownership back to the worker so later tests in this file/session are not affected by this one's side effect.
  await page.request.patch(`/api/tasks/${seed.taskId}`, { data: { owner_id: seed.worker.id } });
});
