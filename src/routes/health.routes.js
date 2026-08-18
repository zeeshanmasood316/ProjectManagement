'use strict';

const db = require('../database/client');
const ai = require('../ai/engine');
const config = require('../config');
const packageJson = require('../../package.json');
const { route } = require('../middleware/router');
const { jsonResponse } = require('../middleware/http');

const SERVER_STARTED_AT = Date.now();

route('GET', '/api/health', async ({ res }) => {
  jsonResponse(res, 200, {
    status: 'ok',
    service: 'orbit-workspace',
    version: packageJson.version,
    environment: config.nodeEnv,
    uptime_seconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    external_model_enabled: ai.externalModelEnabled(),
    ai: ai.aiStatus()
  });
}, { auth: false });

route('GET', '/api/health/live', async ({ res }) => {
  jsonResponse(res, 200, { status: 'alive' });
}, { auth: false });

route('GET', '/api/health/ready', async ({ res }) => {
  let ready = false;
  try { ready = await db.healthCheck(); }
  catch (error) { console.error('Database readiness check failed:', error.message); }
  jsonResponse(res, ready ? 200 : 503, {
    status: ready ? 'ready' : 'unavailable',
    database_storage: db.storageMode(),
    persistent: db.storageMode() === 'turso'
  });
}, { auth: false });
