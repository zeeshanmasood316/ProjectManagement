'use strict';

const { test, expect } = require('@playwright/test');
const path = require('node:path');

const AUTH_DIR = path.join(__dirname, '.auth');
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 }
};

async function hasNoHorizontalOverflow(page) {
  // Raw scrollWidth vs clientWidth is misleading here: the off-canvas mobile sidebar is
  // `position: fixed; transform: translateX(-102%)`, sitting off-screen to the LEFT, which
  // inflates document.scrollWidth in Chromium even though nothing is visually broken (verified
  // against a screenshot — this produced a false positive on the first pass). What actually
  // matters for a user is whether the page can be scrolled RIGHT to reveal cut-off content.
  return page.evaluate(() => {
    const before = window.scrollX;
    window.scrollTo(document.documentElement.scrollWidth, 0);
    const reachedRight = window.scrollX;
    window.scrollTo(before, 0);
    return reachedRight <= 1;
  });
}

for (const [label, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`RESPONSIVE (${label})`, () => {
    test.use({ storageState: path.join(AUTH_DIR, 'ceo.json'), viewport });

    test(`no horizontal overflow on Dashboard, Projects, and Work Breakdown at ${label} width`, async ({ page }) => {
      // The app's own CSS collapses the sidebar behind #mobileNavToggle only below 760px
      // (public/styles.css:756-804) — this must match that real breakpoint, not a guess.
      const isOffCanvas = viewport.width <= 760;
      await page.goto('/');
      await expect(page.locator('#appShell')).toBeVisible();
      for (const view of ['dashboard', 'projects', 'work']) {
        if (isOffCanvas) await page.locator('#mobileNavToggle').click();
        await page.locator(`[data-view="${view}"]`).click();
        await page.waitForTimeout(150);
        expect(await hasNoHorizontalOverflow(page), `${view} view must not overflow horizontally at ${label} width`).toBeTruthy();
      }
    });

    test(`interactive controls remain reachable and unobscured at ${label} width`, async ({ page }) => {
      const isOffCanvas = viewport.width <= 760;
      await page.goto('/');
      await expect(page.locator('#appShell')).toBeVisible();
      if (isOffCanvas) {
        // Below the real 760px breakpoint the sidebar is off-canvas; the toggle must actually open it.
        await expect(page.locator('#mobileNavToggle')).toBeVisible();
        await page.locator('#mobileNavToggle').click();
        await expect(page.locator('body')).toHaveClass(/mobile-nav-open/);
        await expect(page.locator('[data-view="dashboard"]')).toBeVisible();
        await page.locator('[data-view="dashboard"]').click();
        await expect(page.locator('body')).not.toHaveClass(/mobile-nav-open/);
      } else {
        await expect(page.locator('[data-view="dashboard"]')).toBeVisible();
        await expect(page.locator('#mobileNavToggle')).toBeHidden();
      }
      if (isOffCanvas) await page.locator('#mobileNavToggle').click();
      const box = await page.locator('[data-view="dashboard"]').boundingBox();
      expect(box, 'the Dashboard nav control must have real, clickable dimensions, not a collapsed 0x0 box').toBeTruthy();
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    });
  });
}

test.describe('THEME', () => {
  test.use({ storageState: path.join(AUTH_DIR, 'ceo.json') });

  test('light/dark toggle actually changes the rendered theme and persists across reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#appShell')).toBeVisible();
    const initialTheme = await page.locator('html').getAttribute('data-theme');
    expect(['light', 'dark']).toContain(initialTheme);

    // index.html defines a theme-toggle button on three separate screens (auth, onboarding "setup",
    // and the main app shell) — scope to the one actually inside the visible, logged-in app shell.
    const appThemeToggle = page.locator('#appShell [data-theme-toggle]');
    await appThemeToggle.click();
    const toggledTheme = await page.locator('html').getAttribute('data-theme');
    expect(toggledTheme).not.toBe(initialTheme);

    await page.reload();
    await expect(page.locator('#appShell')).toBeVisible();
    const themeAfterReload = await page.locator('html').getAttribute('data-theme');
    expect(themeAfterReload).toBe(toggledTheme);

    // Restore original theme so this test is idempotent across repeated runs.
    await page.locator('#appShell [data-theme-toggle]').click();
  });
});
