'use strict';

const path = require('node:path');
const os = require('node:os');
const { defineConfig, devices } = require('@playwright/test');
const { PORT, BASE_URL } = require('./e2e/constants');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: require.resolve('./e2e/global-setup.js'),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: {
    command: 'node src/server.js',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      DATABASE_PATH: path.join(os.tmpdir(), `orbit-e2e-${Date.now()}.db`),
      TURSO_DATABASE_URL: '',
      TURSO_AUTH_TOKEN: '',
      GEMINI_API_KEY: '',
      AI_PROVIDER_API_KEY: '',
      ALLOW_EXTERNAL_AI: 'false',
      PORT: String(PORT),
      TOKEN_SECRET: 'e2e-test-secret-that-is-long-enough-1234567890',
      NODE_ENV: 'development',
      // A full E2E run (global setup + many browser contexts/specs, each calling /api/auth/me on
      // every page.goto) legitimately makes far more requests than the production defaults
      // anticipate for one real interactive user from a single IP. This only widens the ceiling for
      // this throwaway test server via the app's own existing config knobs — it does not change the
      // rate limiter's code or its production defaults.
      API_RATE_LIMIT_PER_MINUTE: '5000',
      AUTH_RATE_LIMIT_PER_15_MINUTES: '1000'
    }
  }
});
