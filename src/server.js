'use strict';

const http = require('node:http');
const config = require('./config');
const db = require('./database/client');
const { initDb } = require('./database/schema');
const ai = require('./ai/engine');
const packageJson = require('../package.json');
const { HttpError } = require('./middleware/http');
const { handleRequest } = require('./middleware/router');

// Each of these self-registers its routes into middleware/router's shared route table on require.
require('./routes/health.routes');
require('./routes/ai.routes');
require('./routes/auth.routes');
require('./routes/users.routes');
require('./routes/organizations.routes');
require('./routes/memberships.routes');
require('./routes/departments.routes');
require('./routes/jobRoles.routes');
require('./routes/teams.routes');
require('./routes/channels.routes');
require('./routes/projects.routes');
require('./routes/briefs.routes');
require('./routes/tasks.routes');
require('./routes/milestones.routes');
require('./routes/stories.routes');
require('./routes/taskComments.routes');
require('./routes/directMessages.routes');
require('./routes/risks.routes');
require('./routes/changes.routes');
require('./routes/decisions.routes');
require('./routes/updates.routes');
require('./routes/reports.routes');

function createServer() {
  const server = http.createServer(handleRequest);
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs + 5_000, 125_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  return server;
}

async function start() {
  await initDb();
  if (db.storageMode() === 'turso') {
    console.log('Turso connected: users, organizations, projects, tasks, chats, reports, settings, and auth data are persistent.');
  } else {
    console.warn('TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are not set; using local SQLite for development. Render Free requires Turso for persistence.');
  }

  const aiStatus = ai.aiStatus();
  if (aiStatus.enabled) {
    console.log(`AI provider: ${aiStatus.provider}:${aiStatus.model} configured. External AI calls are enabled.`);
  } else {
    console.warn('AI provider is not configured (GEMINI_API_KEY/AI_PROVIDER_API_KEY missing or ALLOW_EXTERNAL_AI=false); running on the local rule-based fallback. Add the required key to .env and restart to enable real AI-generated plans.');
  }

  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`VibeManagement v${packageJson.version} running at http://${config.host}:${config.port} (${config.nodeEnv})`);
  });

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received. Closing VibeManagement gracefully...`);
    const forceTimer = setTimeout(() => process.exit(1), 10_000);
    forceTimer.unref();
    server.close(async () => {
      try { await db.close(); } catch {}
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) {
  start().catch(error => {
    console.error('Startup failed:', error);
    process.exit(1);
  });
}

module.exports = { createServer, start, HttpError };
