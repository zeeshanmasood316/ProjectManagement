'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const db = require('../database/client');
const auth = require('./tokens');
const { HttpError, clientIp } = require('../middleware/http');
const { cleanString } = require('../utils/validation');

function publicUser(user) {
  return user ? {
    id: Number(user.id),
    username: user.username,
    email: user.email,
    full_name: user.full_name,
    avatar_url: user.avatar_url || '',
    status: user.status,
    created_at: user.created_at
  } : null;
}

async function requireUser(request) {
  const payload = auth.verifyToken(auth.bearerToken(request));
  if (!payload) throw new HttpError(401, 'Authentication required');
  if (payload.sid) {
    const session = await db.get('SELECT * FROM auth_sessions WHERE id=? AND user_id=?', [payload.sid, payload.sub]);
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) throw new HttpError(401, 'Session expired or revoked');
    if (Date.now() - new Date(session.last_seen_at).getTime() > 5 * 60_000) {
      await db.run('UPDATE auth_sessions SET last_seen_at=? WHERE id=?', [db.utcnow(), payload.sid]);
    }
  }
  const user = await db.get('SELECT * FROM users WHERE id=?', [payload.sub]);
  if (!user || user.status !== 'active') throw new HttpError(401, 'User account is unavailable');
  request.authPayload = payload;
  return user;
}

async function createAuthSession(user, request) {
  const sessionId = crypto.randomUUID();
  const token = auth.createToken(user, sessionId);
  const now = db.utcnow();
  const expiresAt = new Date(Date.now() + config.tokenTtlHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.run(
    'INSERT INTO auth_sessions(id,user_id,ip_address,user_agent,created_at,last_seen_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)',
    [sessionId, user.id, clientIp(request), cleanString(request.headers['user-agent'], 240), now, now, expiresAt]
  );
  return { token, sessionId, expiresAt };
}

function authenticationHeaders(token) {
  return { 'Set-Cookie': auth.sessionCookie(token) };
}

function passwordResetCodeHash(email, code) {
  return crypto.createHmac('sha256', config.tokenSecret).update(`${String(email || '').trim().toLowerCase()}:${String(code || '').trim()}`).digest('hex');
}

module.exports = { publicUser, requireUser, createAuthSession, authenticationHeaders, passwordResetCodeHash };
