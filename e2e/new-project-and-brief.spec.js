'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', 'seed-data.json'), 'utf8'));
const AUTH_DIR = path.join(__dirname, '.auth');

test.use({ storageState: path.join(AUTH_DIR, 'ceo.json') });

test('New Project: chat-style brief -> automatic analysis -> pre-filled details -> review -> create, and the AI-derived fields actually persist', async ({ page }) => {
  const projectName = `E2E Brief Project ${Date.now()}`;
  const briefText = [
    `Project: ${projectName}`,
    'Client: Acme Testing Corp',
    'Objective: Ship a redesigned onboarding flow for new customers.',
    'Scope: Web app onboarding wizard covering signup, verification, and first-project setup.',
    'Priority: high',
    'Due date: 2026-12-01'
  ].join('\n');

  await page.goto('/');
  await page.locator('[data-view="projects"]').click();
  await page.locator('[data-action="open-intake"]').first().click();

  await expect(page.locator('#intakeBriefForm')).toBeVisible();
  await page.locator('#intakeBriefForm textarea[name="raw_text"]').fill(briefText);
  await page.locator('#intakeBriefForm button[type="submit"]').click();

  // No external AI key is configured for this test run, so this exercises the real local
  // fallback analysis path end-to-end (still a genuine automatic-analysis run, not a mock).
  await expect(page.locator('#intakeDetailsForm')).toBeVisible({ timeout: 15_000 });

  // Automatic extraction from the labeled brief must have pre-filled these without the user typing them.
  await expect(page.locator('#intakeDetailsForm input[name="name"]')).toHaveValue(projectName);
  await expect(page.locator('#intakeDetailsForm input[name="client_name"]')).toHaveValue('Acme Testing Corp');
  await expect(page.locator('#intakeDetailsForm select[name="priority"]')).toHaveValue('high');
  await expect(page.locator('#intakeDetailsForm input[name="due_date"]')).toHaveValue('2026-12-01');

  await page.locator('#intakeDetailsForm button[type="submit"]').click();

  const reviewDialog = page.locator('[data-action="brief-commit"]');
  await expect(reviewDialog).toBeVisible({ timeout: 10_000 });
  await reviewDialog.click();

  await expect(page.locator('.dialog-overlay, .overlay')).toHaveCount(0, { timeout: 15_000 });

  // Persistence check: reload the whole app (not just re-render in memory) and confirm the
  // AI-extracted fields actually landed in the database, not just in transient UI state.
  await page.reload();
  await page.locator('[data-view="projects"]').click();
  // The project name legitimately appears twice (the project-card heading and the top-bar project
  // picker <option>) — assert on the card heading specifically, not an ambiguous text search.
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible({ timeout: 10_000 });

  const projectsResponse = await page.request.get(`/api/organizations/${seed.organizationId}/projects`);
  const projects = await projectsResponse.json();
  const created = projects.find(p => p.name === projectName);
  expect(created, 'the project created through the brief flow must exist in the database').toBeTruthy();
  expect(created.client_name).toBe('Acme Testing Corp');
  expect(created.priority).toBe('high');
  expect(created.due_date).toBe('2026-12-01');

  const tasksResponse = await page.request.get(`/api/projects/${created.id}/tasks`);
  const tasks = await tasksResponse.json();
  expect(tasks.length, 'the AI-generated work breakdown (stories/tasks) must be persisted, not just shown in the review dialog').toBeGreaterThan(0);
});
