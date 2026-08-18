'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const useTurso = Boolean(config.turso.url && config.turso.authToken);
const transactionContext = new AsyncLocalStorage();
let localDatabase = null;
let remoteClient = null;

function utcnow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeParams(params = []) {
  return params.map(value => value === undefined ? null : value);
}

function splitSqlStatements(script) {
  return String(script || '')
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
}

function ensureLocalDatabase() {
  if (localDatabase) return localDatabase;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  localDatabase = new DatabaseSync(config.databasePath);
  localDatabase.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  return localDatabase;
}

async function ensureRemoteClient() {
  if (remoteClient) return remoteClient;
  let createClient;
  try {
    ({ createClient } = await import('@libsql/client'));
  } catch (error) {
    throw new Error('Turso is configured but @libsql/client is not installed. Run npm install.');
  }
  remoteClient = createClient({
    url: config.turso.url,
    authToken: config.turso.authToken
  });
  return remoteClient;
}

function normalizeDbValue(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function rowsToObjects(result) {
  const columns = Array.from(result?.columns || []);
  return Array.from(result?.rows || []).map(row => {
    if (row && !Array.isArray(row) && typeof row === 'object') {
      const object = {};
      for (const column of columns) object[column] = normalizeDbValue(row[column]);
      return object;
    }
    return Object.fromEntries(columns.map((column, index) => [column, normalizeDbValue(row[index])]));
  });
}

async function all(sql, params = []) {
  const args = normalizeParams(params);
  if (!useTurso) return ensureLocalDatabase().prepare(sql).all(...args);
  const executor = transactionContext.getStore() || await ensureRemoteClient();
  const result = await executor.execute({ sql, args });
  return rowsToObjects(result);
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  const args = normalizeParams(params);
  if (!useTurso) {
    const result = ensureLocalDatabase().prepare(sql).run(...args);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }
  const executor = transactionContext.getStore() || await ensureRemoteClient();
  const result = await executor.execute({ sql, args });
  return {
    changes: Number(result.rowsAffected || 0),
    lastInsertRowid: result.lastInsertRowid == null ? 0 : Number(result.lastInsertRowid)
  };
}

async function execScript(script) {
  const statements = splitSqlStatements(script);
  if (!useTurso) {
    ensureLocalDatabase().exec(script);
    return;
  }
  if (!statements.length) return;
  const client = await ensureRemoteClient();
  await client.batch(statements.map(sql => ({ sql, args: [] })), 'write');
}

async function transaction(callback) {
  if (!useTurso) {
    const database = ensureLocalDatabase();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  const client = await ensureRemoteClient();
  const tx = await client.transaction('write');
  try {
    const result = await transactionContext.run(tx, callback);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch {}
    throw error;
  } finally {
    try { await tx.close(); } catch {}
  }
}

async function log({ organizationId = null, projectId = null, actorUserId = null, entityType, entityId = null, action, details = '' }) {
  const serialized = typeof details === 'string' ? details : JSON.stringify(details);
  await run(
    'INSERT INTO audit_log(organization_id,project_id,actor_user_id,entity_type,entity_id,action,details,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [organizationId, projectId, actorUserId, entityType, entityId, action, serialized, utcnow()]
  );
}

async function healthCheck() {
  const row = await get('SELECT 1 AS ready');
  return Number(row?.ready || 0) === 1;
}

function storageMode() {
  return useTurso ? 'turso' : 'local-sqlite';
}

async function close() {
  if (remoteClient) {
    try { remoteClient.close(); } catch {}
    remoteClient = null;
  }
  if (localDatabase) {
    localDatabase.close();
    localDatabase = null;
  }
}

module.exports = { utcnow, all, get, run, execScript, transaction, log, healthCheck, storageMode, close };
