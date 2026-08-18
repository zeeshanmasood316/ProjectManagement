'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const Busboy = require('busboy');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const mailer = require('./mailer');
const ai = require('./aiEngine');
const packageJson = require('../package.json');

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

const routes = [];
const channelStreamClients = new Map();

function addChannelStreamClient(channelId, response) {
  if (!channelStreamClients.has(channelId)) channelStreamClients.set(channelId, new Set());
  channelStreamClients.get(channelId).add(response);
}

function removeChannelStreamClient(channelId, response) {
  const clients = channelStreamClients.get(channelId);
  if (!clients) return;
  clients.delete(response);
  if (!clients.size) channelStreamClients.delete(channelId);
}

function broadcastToChannel(channelId, payload) {
  const clients = channelStreamClients.get(channelId);
  if (!clients || !clients.size) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const response of clients) {
    if (!response.writableEnded) response.write(frame);
  }
}

setInterval(() => {
  for (const clients of channelStreamClients.values()) {
    for (const response of clients) {
      if (!response.writableEnded) response.write(': ping\n\n');
    }
  }
}, 25_000).unref();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const rateLimitBuckets = new Map();
const SERVER_STARTED_AT = Date.now();
const DUMMY_PASSWORD_HASH = auth.hashPassword('NotARealPassword123');

function requestId(request) {
  const supplied = String(request.headers['x-request-id'] || '').trim();
  return /^[a-zA-Z0-9._:-]{8,100}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function clientIp(request) {
  if (config.trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded.slice(0, 80);
  }
  return String(request.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 80);
}

function clientDescription(request) {
  const agent = cleanString(request.headers['user-agent'], 240) || 'Unknown client';
  return `${agent} · IP ${clientIp(request) || 'unknown'}`;
}

function setCommonHeaders(request, response) {
  const id = requestId(request);
  request.requestId = id;
  response.setHeader('X-Request-ID', id);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data: https:; connect-src 'self'");
  if (config.secureCookies) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function validateRequestOrigin(request) {
  if (!UNSAFE_METHODS.has(request.method) || !auth.usesCookieAuthentication(request)) return;
  if (String(request.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    throw new HttpError(403, 'Cross-site request blocked');
  }
  const origin = String(request.headers.origin || '').trim();
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { throw new HttpError(403, 'Invalid request origin'); }
  if (parsed.host !== request.headers.host) throw new HttpError(403, 'Cross-site request blocked');
}

function enforceRateLimit(request, response, routeMatch) {
  if (!request.url.startsWith('/api/')) return;
  const authRoute = routeMatch?.pattern?.startsWith('/api/auth/');
  const windowMs = authRoute ? 15 * 60_000 : 60_000;
  const limit = authRoute ? config.authRateLimitPer15Minutes : config.apiRateLimitPerMinute;
  const key = `${clientIp(request)}:${authRoute ? 'auth' : 'api'}`;
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  const remaining = Math.max(0, limit - bucket.count);
  response.setHeader('RateLimit-Limit', String(limit));
  response.setHeader('RateLimit-Remaining', String(remaining));
  response.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count > limit) {
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    throw new HttpError(429, 'Too many requests. Please try again later.');
  }
  if (rateLimitBuckets.size > 5000) {
    for (const [bucketKey, value] of rateLimitBuckets) if (value.resetAt <= now) rateLimitBuckets.delete(bucketKey);
  }
}

function compilePath(pattern) {
  const names = [];
  const source = pattern.split('/').map(segment => {
    if (segment.startsWith(':')) {
      names.push(segment.slice(1));
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

function route(method, pattern, handler, options = {}) {
  const compiled = compilePath(pattern);
  routes.push({ method, pattern, handler, auth: options.auth !== false, rawBody: Boolean(options.rawBody), ...compiled });
}

function jsonResponse(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(body);
}

function textResponse(response, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

async function parseBody(request) {
  if (['GET', 'HEAD'].includes(request.method)) return {};
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType && contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > config.requestBodyLimitBytes) throw new HttpError(413, 'Request body is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.requestBodyLimitBytes) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('object required');
    return parsed;
  } catch {
    throw new HttpError(400, 'Request body must be a valid JSON object');
  }
}

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

function cleanString(value, maxLength = 5000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function requiredString(value, field, minLength = 1, maxLength = 5000) {
  const output = cleanString(value, maxLength);
  if (output.length < minLength) throw new HttpError(400, `${field} is required`);
  return output;
}

function integer(value, field = 'id') {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, `${field} must be a positive integer`);
  return parsed;
}

function booleanInt(value) {
  return value ? 1 : 0;
}

function normalizeUsername(value) {
  const username = cleanString(value, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3-40 characters using letters, numbers, dot, dash, or underscore');
  }
  return username;
}

function normalizeEmail(value) {
  const email = cleanString(value, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'A valid email address is required');
  return email;
}

function normalizeDepartment(value, fallback = 'General') {
  const department = cleanString(value || fallback, 80).replace(/\s+/g, ' ');
  return department || fallback;
}

const WORKSPACE_STATUS_PRESETS = Object.freeze({
  available: { label: 'Available', emoji: '🟢' },
  busy: { label: 'Busy', emoji: '🔴' },
  on_leave: { label: 'On Leave', emoji: '🏖️' },
  remote: { label: 'Remote', emoji: '🏠' },
  in_meeting: { label: 'In a Meeting', emoji: '🟡' },
  focus: { label: 'Focus Time', emoji: '🎯' },
  travelling: { label: 'Travelling', emoji: '✈️' },
  custom: { label: 'Custom', emoji: '💬' }
});

function workspaceStatus(value, customLabel = '', customEmoji = '') {
  const key = cleanString(value || 'available', 30).toLowerCase();
  if (!Object.hasOwn(WORKSPACE_STATUS_PRESETS, key)) throw new HttpError(400, 'Invalid workspace status');
  if (key !== 'custom') return { key, ...WORKSPACE_STATUS_PRESETS[key] };
  const label = requiredString(customLabel, 'Custom status label', 2, 50);
  const emoji = cleanString(customEmoji || '💬', 8) || '💬';
  return { key, label, emoji };
}

async function settingsForUser(userId) {
  const existing = await db.get('SELECT * FROM user_settings WHERE user_id=?', [userId]);
  if (existing) return existing;
  const now = db.utcnow();
  await db.run('INSERT INTO user_settings(user_id,theme,workspace_notifications,mention_notifications,invitation_notifications,activity_notifications,updated_at) VALUES(?,?,?,?,?,?,?)', [userId, 'light', 1, 1, 1, 1, now]);
  return await db.get('SELECT * FROM user_settings WHERE user_id=?', [userId]);
}

async function activity(userId, activityType, title, detail = '', organizationId = null) {
  await db.run('INSERT INTO account_activity(user_id,organization_id,activity_type,title,detail,created_at) VALUES(?,?,?,?,?,?)', [userId, organizationId, activityType, title, cleanString(detail, 500), db.utcnow()]);
}

async function notifyUser(userId, notificationType, title, body = '', organizationId = null, actionView = '') {
  const settings = await settingsForUser(userId);
  const preference = notificationType === 'invitation' ? 'invitation_notifications'
    : notificationType === 'mention' ? 'mention_notifications'
      : notificationType === 'activity' ? 'activity_notifications' : 'workspace_notifications';
  if (!Number(settings[preference])) return null;
  return (await db.run('INSERT INTO notifications(user_id,organization_id,notification_type,title,body,action_view,created_at) VALUES(?,?,?,?,?,?,?)', [userId, organizationId, notificationType, cleanString(title, 160), cleanString(body, 500), cleanString(actionView, 40), db.utcnow()])).lastInsertRowid;
}

async function notifyOrganizationManagers(organizationId, title, body, excludeUserId = null) {
  const managers = await db.all("SELECT user_id FROM memberships WHERE organization_id=? AND status='active' AND role IN ('ceo','admin')", [organizationId]);
  for (const manager of managers) if (Number(manager.user_id) !== Number(excludeUserId)) await notifyUser(manager.user_id, 'activity', title, body, organizationId, 'admin');
}

function validateAvatarUrl(value) {
  const avatarUrl = cleanString(value, 500);
  if (!avatarUrl) return '';
  let parsed;
  try { parsed = new URL(avatarUrl); } catch { throw new HttpError(400, 'Avatar URL must be a valid HTTPS address'); }
  if (parsed.protocol !== 'https:') throw new HttpError(400, 'Avatar URL must use HTTPS');
  return avatarUrl;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 10) throw new HttpError(400, 'Password must contain at least 10 characters');
  if (password.length > 200) throw new HttpError(400, 'Password is too long');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(400, 'Password must include uppercase, lowercase, and a number');
  }
  return password;
}

async function uniqueSlug(name) {
  const base = cleanString(name, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
  let slug = base;
  let suffix = 2;
  while (await db.get('SELECT id FROM organizations WHERE slug=?', [slug])) slug = `${base}-${suffix++}`;
  return slug;
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

async function membership(userId, organizationId, activeOnly = true) {
  const row = await db.get(
    `SELECT m.*, u.username, u.email, u.full_name, o.name organization_name, o.slug organization_slug
     FROM memberships m
     JOIN users u ON u.id=m.user_id
     JOIN organizations o ON o.id=m.organization_id
     WHERE m.user_id=? AND m.organization_id=? ${activeOnly ? "AND m.status='active'" : ''}`,
    [userId, organizationId]
  );
  return row;
}

async function requireMembership(userId, organizationId, roles = null) {
  const item = await membership(userId, organizationId, true);
  if (!item) throw new HttpError(403, 'Active organization membership required');
  if (roles && !roles.includes(item.role)) throw new HttpError(403, 'You do not have permission for this action');
  return item;
}

async function projectWithAccess(userId, projectId, roles = null) {
  const project = await db.get('SELECT * FROM projects WHERE id=?', [projectId]);
  if (!project) throw new HttpError(404, 'Project not found');
  const member = await requireMembership(userId, Number(project.organization_id), roles);
  const scope = await resolveAccessScope(userId, Number(project.organization_id), member);
  if (!(await projectInScope(scope, projectId))) {
    throw new HttpError(403, 'You do not have access to this project');
  }
  return { project, member, scope };
}

async function briefSessionAccess(userId, session, roles = null) {
  if (session.project_id) {
    const { project, member } = await projectWithAccess(userId, Number(session.project_id), roles);
    return { project, member };
  }
  const member = await requireMembership(userId, Number(session.organization_id), roles);
  const virtualProject = {
    id: null,
    organization_id: Number(session.organization_id),
    name: session.project_name || 'Untitled project',
    objective: '', scope: '', constraints: '', assumptions: ''
  };
  return { project: virtualProject, member };
}

async function channelWithAccess(userId, channelId, roles = null) {
  const channel = await db.get('SELECT * FROM channels WHERE id=? AND archived=0', [channelId]);
  if (!channel) throw new HttpError(404, 'Channel not found');
  const member = await requireMembership(userId, Number(channel.organization_id), roles);
  return { channel, member };
}

function roleCanInvite(actorRole, proposedRole) {
  if (actorRole === 'ceo') return ['admin', 'moderator', 'member'].includes(proposedRole);
  if (actorRole === 'admin') return ['moderator', 'member'].includes(proposedRole);
  if (actorRole === 'moderator') return proposedRole === 'member';
  return false;
}

async function organizationSummary(userId) {
  return await db.all(
    `SELECT o.*, m.id membership_id, m.role, m.status membership_status
     FROM memberships m JOIN organizations o ON o.id=m.organization_id
     WHERE m.user_id=? ORDER BY o.name`,
    [userId]
  );
}

const PRESENCE_STATUS_SQL = `
  CASE
    WHEN m.status <> 'active' THEN 'offline'
    WHEN COALESCE(p.presence_mode, 'auto') = 'offline' THEN 'offline'
    WHEN COALESCE(p.presence_mode, 'auto') = 'dnd' THEN 'dnd'
    WHEN COALESCE(p.presence_mode, 'auto') = 'away' THEN 'away'
    WHEN p.last_seen_at IS NULL THEN 'offline'
    WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 120 THEN 'online'
    WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 900 THEN 'away'
    ELSE 'offline'
  END`;

async function organizationMembers(organizationId, activeOnly = false) {
  return await db.all(
    `SELECT m.id membership_id, m.organization_id, m.user_id, m.role, m.department, m.status, m.joined_at, m.updated_at,
            m.department_id, m.manager_user_id, m.job_role_id,
            u.username, u.email, u.full_name, u.avatar_url,
            d.name department_name, mgr.full_name manager_name, jr.name job_role_name,
            COALESCE(p.presence_mode, 'auto') presence_mode,
            COALESCE(p.status_key, 'available') status_key,
            COALESCE(p.status_label, 'Available') status_label,
            COALESCE(p.status_emoji, '🟢') status_emoji,
            COALESCE(p.custom_status, '') custom_status,
            p.status_expires_at, p.last_seen_at,
            ${PRESENCE_STATUS_SQL} current_status,
            5 AS capacity
     FROM memberships m
     JOIN users u ON u.id=m.user_id
     LEFT JOIN user_presence p ON p.user_id=u.id
     LEFT JOIN departments d ON d.id=m.department_id
     LEFT JOIN users mgr ON mgr.id=m.manager_user_id
     LEFT JOIN job_roles jr ON jr.id=m.job_role_id
     WHERE m.organization_id=? ${activeOnly ? "AND m.status='active'" : ''}
     ORDER BY CASE m.role WHEN 'ceo' THEN 1 WHEN 'admin' THEN 2 WHEN 'moderator' THEN 3 ELSE 4 END, u.full_name`,
    [organizationId]
  );
}

async function activeOrganizationMembers(organizationId) {
  return await organizationMembers(organizationId, true);
}

async function activeOrganizationTeams(organizationId) {
  return await db.all(
    `SELECT t.id,t.name,t.lead_user_id,d.name department_name
     FROM teams t LEFT JOIN departments d ON d.id=t.department_id
     WHERE t.organization_id=? AND t.status='active' ORDER BY t.name`,
    [organizationId]
  );
}

// --- RBAC scoping -----------------------------------------------------------
// Org-level role (`ceo`/`admin`/`moderator`/`member`) already gates most routes via
// requireMembership(). What it cannot express is the business-level "Manager" tier: a
// `member`-role user who leads a team (teams.lead_user_id) or manages a department
// (departments.manager_user_id). resolveAccessScope() computes that once per request and
// is the single source of truth every scoping helper below reads from. Everyone who is not
// full-access and not a Manager is treated as a plain Worker.
const FULL_ACCESS_ROLES = ['ceo', 'admin', 'moderator'];

async function resolveAccessScope(userId, organizationId, membershipRow = null) {
  const member = membershipRow || await membership(userId, organizationId);
  const role = member ? member.role : null;
  const fullAccess = FULL_ACCESS_ROLES.includes(role);
  const scope = {
    userId: Number(userId),
    organizationId: Number(organizationId),
    role,
    fullAccess,
    departmentId: member && member.department_id ? Number(member.department_id) : null,
    managedTeamIds: [],
    managedDepartmentIds: [],
    ownTeamIds: [],
    visibleDepartmentIds: new Set(),
    managedTeamUserIds: new Set([Number(userId)]),
    ownTeamUserIds: new Set([Number(userId)])
  };
  if (fullAccess || !member) return scope;

  const [ledTeams, managedDepartments, ownMemberships] = await Promise.all([
    db.all("SELECT id, department_id FROM teams WHERE organization_id=? AND lead_user_id=? AND status='active'", [organizationId, userId]),
    db.all('SELECT id FROM departments WHERE organization_id=? AND manager_user_id=?', [organizationId, userId]),
    db.all('SELECT team_id FROM team_members WHERE user_id=?', [userId])
  ]);
  scope.managedDepartmentIds = managedDepartments.map(d => Number(d.id));
  scope.ownTeamIds = [...new Set(ownMemberships.map(t => Number(t.team_id)))];
  const leadTeamIds = ledTeams.map(t => Number(t.id));
  // A department manager manages every team under their department, not just ones they personally
  // lead — otherwise a department-level manager with no direct team leadership would pass the
  // manager-tier check (via managedDepartmentIds) but still see none of their department's work.
  const departmentTeams = scope.managedDepartmentIds.length
    ? await db.all(`SELECT id FROM teams WHERE department_id IN (${scope.managedDepartmentIds.map(() => '?').join(',')}) AND status='active'`, scope.managedDepartmentIds)
    : [];
  scope.managedTeamIds = [...new Set([...leadTeamIds, ...departmentTeams.map(t => Number(t.id))])];
  for (const id of scope.managedDepartmentIds) scope.visibleDepartmentIds.add(id);
  for (const team of ledTeams) if (team.department_id) scope.visibleDepartmentIds.add(Number(team.department_id));
  if (scope.departmentId) scope.visibleDepartmentIds.add(scope.departmentId);

  const teamIdsNeeded = [...new Set([...scope.managedTeamIds, ...scope.ownTeamIds])];
  if (teamIdsNeeded.length) {
    const placeholders = teamIdsNeeded.map(() => '?').join(',');
    const [memberRows, teamRows] = await Promise.all([
      db.all(`SELECT team_id, user_id FROM team_members WHERE team_id IN (${placeholders})`, teamIdsNeeded),
      db.all(`SELECT id, lead_user_id, department_id FROM teams WHERE id IN (${placeholders})`, teamIdsNeeded)
    ]);
    const managedSet = new Set(scope.managedTeamIds);
    const ownSet = new Set(scope.ownTeamIds);
    for (const row of memberRows) {
      const teamId = Number(row.team_id);
      const uid = Number(row.user_id);
      if (managedSet.has(teamId)) scope.managedTeamUserIds.add(uid);
      if (ownSet.has(teamId)) scope.ownTeamUserIds.add(uid);
    }
    for (const team of teamRows) {
      const teamId = Number(team.id);
      if (team.lead_user_id) {
        const leadId = Number(team.lead_user_id);
        if (managedSet.has(teamId)) scope.managedTeamUserIds.add(leadId);
        if (ownSet.has(teamId)) scope.ownTeamUserIds.add(leadId);
      }
      if (team.department_id && ownSet.has(teamId)) scope.visibleDepartmentIds.add(Number(team.department_id));
    }
  }
  if (scope.managedDepartmentIds.length) {
    const placeholders = scope.managedDepartmentIds.map(() => '?').join(',');
    const deptMembers = await db.all(
      `SELECT user_id FROM memberships WHERE organization_id=? AND department_id IN (${placeholders})`,
      [organizationId, ...scope.managedDepartmentIds]
    );
    for (const row of deptMembers) scope.managedTeamUserIds.add(Number(row.user_id));
  }
  return scope;
}

// A "Manager" is a plain member who leads at least one team or manages at least one
// department. Full-access roles are never counted as this tier (they already see everything).
function isManagerScope(scope) {
  return !scope.fullAccess && (scope.managedTeamIds.length > 0 || scope.managedDepartmentIds.length > 0);
}

function scopeMemberList(scope, members) {
  if (scope.fullAccess) return members;
  const allowedIds = isManagerScope(scope) ? scope.managedTeamUserIds : scope.ownTeamUserIds;
  return members.filter(item => allowedIds.has(Number(item.user_id)));
}

function scopeDepartmentList(scope, departments) {
  if (scope.fullAccess) return departments;
  return departments.filter(dept => scope.visibleDepartmentIds.has(Number(dept.id)));
}

function scopeTeamList(scope, teams) {
  if (scope.fullAccess) return teams;
  const visibleIds = new Set([...scope.managedTeamIds, ...scope.ownTeamIds]);
  return teams.filter(team => visibleIds.has(Number(team.id)));
}

// Coarse, project-level gate: does this project have any footprint (owned task, or a task/story
// belonging to a team the caller manages or is assigned work on) within the caller's scope at all?
// Used by projectWithAccess() as the defense-in-depth boundary for direct URL/API access to a
// specific project id — a Manager or Worker with zero legitimate connection to a project gets a 403.
async function projectInScope(scope, projectId) {
  if (scope.fullAccess) return true;
  const project = await db.get('SELECT owner_id FROM projects WHERE id=?', [projectId]);
  if (project && project.owner_id !== null && Number(project.owner_id) === scope.userId) return true;
  if (isManagerScope(scope) && scope.managedTeamIds.length) {
    const placeholders = scope.managedTeamIds.map(() => '?').join(',');
    const row = await db.get(
      `SELECT 1 found FROM tasks WHERE project_id=? AND team_id IN (${placeholders})
       UNION SELECT 1 FROM stories WHERE project_id=? AND team_id IN (${placeholders}) LIMIT 1`,
      [projectId, ...scope.managedTeamIds, projectId, ...scope.managedTeamIds]
    );
    if (row) return true;
  }
  const ownTask = await db.get('SELECT 1 found FROM tasks WHERE project_id=? AND owner_id=? LIMIT 1', [projectId, scope.userId]);
  return Boolean(ownTask);
}

async function scopeProjectList(scope, projects) {
  if (scope.fullAccess) return projects;
  const allowedIds = new Set();
  for (const project of projects) {
    if (project.owner_id !== null && Number(project.owner_id) === scope.userId) allowedIds.add(Number(project.id));
  }
  if (isManagerScope(scope) && scope.managedTeamIds.length) {
    const placeholders = scope.managedTeamIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT DISTINCT project_id FROM tasks WHERE team_id IN (${placeholders})
       UNION SELECT DISTINCT project_id FROM stories WHERE team_id IN (${placeholders})`,
      [...scope.managedTeamIds, ...scope.managedTeamIds]
    );
    for (const row of rows) allowedIds.add(Number(row.project_id));
  } else if (!isManagerScope(scope)) {
    const rows = await db.all('SELECT DISTINCT project_id FROM tasks WHERE owner_id=?', [scope.userId]);
    for (const row of rows) allowedIds.add(Number(row.project_id));
  }
  return projects.filter(project => allowedIds.has(Number(project.id)));
}

// Fine-grained, within-a-project filter: a Manager only sees tasks/subtasks whose own team_id
// (or parent story's team_id) is one they manage, or that are assigned to them personally; a
// Worker only sees tasks/subtasks assigned to them, plus (read-only context) the parent task of
// any subtask they own, so "what am I working on" still makes sense.
function scopeTaskList(scope, tasks) {
  if (scope.fullAccess) return tasks;
  if (isManagerScope(scope)) {
    const teamIds = new Set(scope.managedTeamIds);
    return tasks.filter(task =>
      (task.team_id !== null && task.team_id !== undefined && teamIds.has(Number(task.team_id))) ||
      (task.story_team_id !== null && task.story_team_id !== undefined && teamIds.has(Number(task.story_team_id))) ||
      Number(task.owner_id) === scope.userId
    );
  }
  const ownedIds = new Set(tasks.filter(task => Number(task.owner_id) === scope.userId).map(task => Number(task.id)));
  const parentIdsNeeded = new Set();
  for (const task of tasks) {
    if (ownedIds.has(Number(task.id)) && task.parent_task_id) parentIdsNeeded.add(Number(task.parent_task_id));
  }
  return tasks.filter(task => ownedIds.has(Number(task.id)) || parentIdsNeeded.has(Number(task.id)));
}

function scopeStoryList(scope, stories) {
  if (scope.fullAccess) return stories;
  if (isManagerScope(scope)) {
    const teamIds = new Set(scope.managedTeamIds);
    return stories.filter(story =>
      (story.team_id !== null && story.team_id !== undefined && teamIds.has(Number(story.team_id))) ||
      Number(story.owner_id) === scope.userId
    );
  }
  return stories.filter(story => Number(story.owner_id) === scope.userId);
}

// Task/subtask-level gate for direct-by-id routes (GET/PATCH one task, comments, etc.).
function taskInScope(scope, task) {
  if (scope.fullAccess) return true;
  if (Number(task.owner_id) === scope.userId) return true;
  if (isManagerScope(scope)) {
    const teamIds = new Set(scope.managedTeamIds);
    if (task.team_id !== null && task.team_id !== undefined && teamIds.has(Number(task.team_id))) return true;
    if (task.story_team_id !== null && task.story_team_id !== undefined && teamIds.has(Number(task.story_team_id))) return true;
  }
  return false;
}

function taskManagedByScope(scope, task) {
  if (scope.fullAccess) return true;
  if (!isManagerScope(scope)) return false;
  const teamIds = new Set(scope.managedTeamIds);
  const effectiveTeamIds = [task.team_id, task.story_team_id].filter(id => id !== null && id !== undefined).map(Number);
  return effectiveTeamIds.some(id => teamIds.has(id));
}

// Fields a plain Worker may change on a task they own but do not manage — status/progress
// updates and moving their own card between board columns (which just maps to a status change).
const WORKER_SELF_EDIT_FIELDS = new Set(['status', 'progress', 'column_id', 'board_position']);

// Manager-tier-and-above feature gate for pages the spec puts fully off-limits to plain Workers
// (Risks & Decisions, Change Control, Reports, audit log, exports) — a Worker gets an empty result
// rather than a 403 on routes the frontend loads unconditionally for the selected project, and a
// 403 on the ones it only loads on demand.
function requireManagerTierOrAbove(scope, message) {
  if (scope.fullAccess || isManagerScope(scope)) return;
  throw new HttpError(403, message || 'This area is only available to managers and above');
}

async function touchPresence(userId) {
  const now = db.utcnow();
  await db.run(
    `INSERT INTO user_presence(user_id,presence_mode,status_key,status_label,status_emoji,custom_status,status_expires_at,last_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
    [userId, 'auto', 'available', 'Available', '🟢', '', null, now, now]
  );
  return await presenceForUser(userId);
}

async function presenceForUser(userId) {
  return await db.get(
    `SELECT u.id user_id, COALESCE(p.presence_mode, 'auto') presence_mode,
            COALESCE(p.status_key, 'available') status_key,
            COALESCE(p.status_label, 'Available') status_label,
            COALESCE(p.status_emoji, '🟢') status_emoji,
            COALESCE(p.custom_status, '') custom_status, p.status_expires_at, p.last_seen_at,
            CASE
              WHEN COALESCE(p.presence_mode, 'auto') = 'offline' THEN 'offline'
              WHEN COALESCE(p.presence_mode, 'auto') = 'dnd' THEN 'dnd'
              WHEN COALESCE(p.presence_mode, 'auto') = 'away' THEN 'away'
              WHEN p.last_seen_at IS NULL THEN 'offline'
              WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 120 THEN 'online'
              WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 900 THEN 'away'
              ELSE 'offline'
            END current_status
     FROM users u LEFT JOIN user_presence p ON p.user_id=u.id WHERE u.id=?`,
    [userId]
  );
}

async function audit(organizationId, projectId, actorUserId, entityType, entityId, action, details = '') {
  await db.log({ organizationId, projectId, actorUserId, entityType, entityId, action, details });
}

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

route('GET', '/api/ai/status', async ({ res }) => {
  jsonResponse(res, 200, ai.aiStatus());
});

route('POST', '/api/ai/suggest', async ({ res, user, body }) => {
  const fieldName = cleanString(body.field_name, 120);
  const fieldLabel = cleanString(body.field_label, 160);
  const value = cleanString(body.value, 20000);
  const userInstruction = cleanString(body.instruction, 1000);
  const rawContext = body.form_context && typeof body.form_context === 'object' && !Array.isArray(body.form_context) ? body.form_context : {};
  const formContext = {};
  for (const [key, rawValue] of Object.entries(rawContext).slice(0, 30)) {
    formContext[cleanString(key, 80)] = cleanString(rawValue, 4000);
  }
  let project = null;
  if (body.project_id) {
    const projectId = integer(body.project_id, 'project id');
    const access = await projectWithAccess(user.id, projectId);
    project = {
      id: access.project.id,
      name: access.project.name,
      objective: access.project.objective,
      scope: access.project.scope,
      constraints: access.project.constraints,
      assumptions: access.project.assumptions,
      status: access.project.status
    };
  }
  const result = await ai.suggestField({ fieldName, fieldLabel, value, formContext, project, userInstruction });
  jsonResponse(res, 200, result);
});

route('POST', '/api/auth/register', async ({ req, res, body }) => {
  const username = normalizeUsername(body.username);
  const email = normalizeEmail(body.email);
  const fullName = requiredString(body.full_name, 'Full name', 2, 120);
  const password = validatePassword(body.password);
  const passwordHash = auth.hashPassword(password);
  const now = db.utcnow();

  if (await db.get('SELECT id FROM users WHERE username=? OR email=?', [username, email])) {
    throw new HttpError(409, 'Username or email is already registered');
  }

  let result;
  try {
    result = await db.run(
      'INSERT INTO users(username,email,full_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      [username, email, fullName, passwordHash, 'active', now, now]
    );
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'Username or email is already registered');
    throw error;
  }

  await db.run(
    'INSERT INTO user_presence(user_id,presence_mode,status_key,status_label,status_emoji,custom_status,status_expires_at,last_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [result.lastInsertRowid, 'auto', 'available', 'Available', '🟢', '', null, now, now]
  );
  await settingsForUser(result.lastInsertRowid);
  const user = await db.get('SELECT * FROM users WHERE id=?', [result.lastInsertRowid]);
  const session = await createAuthSession(user, req);
  await activity(user.id, 'account_created', 'Account created', clientDescription(req));

  jsonResponse(res, 201, {
    token: session.token,
    user: publicUser(user),
    persistent_account: db.storageMode() === 'turso',
    workspace_access: {
      can_access_workspace: false,
      requires_onboarding: true,
      active_organization_count: 0,
      pending_invitation_count: 0
    }
  }, authenticationHeaders(session.token));
}, { auth: false });

route('POST', '/api/auth/login', async ({ req, res, body }) => {
  const identifier = cleanString(body.identifier, 160).toLowerCase();
  if (!identifier) throw new HttpError(400, 'Username or email is required');
  const user = await db.get('SELECT * FROM users WHERE username=? OR email=?', [identifier, identifier]);
  const passwordMatches = auth.verifyPassword(String(body.password || ''), user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) throw new HttpError(401, 'Invalid username/email or password');
  if (user.status !== 'active') throw new HttpError(403, 'This account is disabled');

  const session = await createAuthSession(user, req);
  const presence = await touchPresence(user.id);
  await activity(user.id, 'signed_in', 'Signed in', clientDescription(req));
  jsonResponse(res, 200, {
    token: session.token,
    user: publicUser(user),
    presence,
    settings: await settingsForUser(user.id)
  }, authenticationHeaders(session.token));
}, { auth: false });

route('POST', '/api/auth/forgot-password', async ({ res, body }) => {
  const email = normalizeEmail(body.email);
  const productionNeedsEmail = config.isProduction && !mailer.configured();
  if (productionNeedsEmail) throw new HttpError(503, 'Password recovery email is not configured yet');

  const now = db.utcnow();
  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = passwordResetCodeHash(email, code);
  const expiresAt = new Date(Date.now() + config.passwordResetCodeTtlMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const account = await db.get('SELECT * FROM users WHERE email=?', [email]);

  if (account) {
    await db.transaction(async () => {
      await db.run('UPDATE password_reset_codes SET used_at=? WHERE user_id=? AND used_at IS NULL', [now, account.id]);
      await db.run(
        'INSERT INTO password_reset_codes(user_id,code_hash,expires_at,used_at,created_at) VALUES(?,?,?,NULL,?)',
        [account.id, codeHash, expiresAt, now]
      );
    });
  }

  if (account && mailer.configured()) {
    try { await mailer.sendPasswordResetCode({ to: email, code }); }
    catch (error) {
      console.error('Password reset email failed:', error.message);
      throw new HttpError(503, 'Password recovery email could not be sent');
    }
  }

  const payload = { message: 'If an account exists for that email, a reset code has been sent.' };
  if (!config.isProduction && account && !mailer.configured()) payload.dev_reset_code = code;
  jsonResponse(res, 200, payload);
}, { auth: false });

route('POST', '/api/auth/reset-password', async ({ res, body }) => {
  const email = normalizeEmail(body.email);
  const code = cleanString(body.code, 12).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the 6-digit reset code');
  const newPassword = validatePassword(body.password);
  const codeHash = passwordResetCodeHash(email, code);
  const now = db.utcnow();
  const passwordHash = auth.hashPassword(newPassword);

  const reset = await db.get(
    `SELECT r.id reset_id,u.* FROM password_reset_codes r
     JOIN users u ON u.id=r.user_id
     WHERE u.email=? AND r.code_hash=? AND r.used_at IS NULL AND r.expires_at>?
     ORDER BY r.id DESC LIMIT 1`,
    [email, codeHash, now]
  );
  if (!reset) throw new HttpError(400, 'Reset code is invalid or expired');

  await db.transaction(async () => {
    const consumed = await db.run('UPDATE password_reset_codes SET used_at=? WHERE id=? AND used_at IS NULL', [now, reset.reset_id]);
    if (!consumed.changes) throw new HttpError(400, 'Reset code is invalid or already used');
    await db.run('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', [passwordHash, now, reset.id]);
    await db.run('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [now, reset.id]);
  });
  await activity(reset.id, 'password_reset', 'Password reset', 'Password changed using recovery code');

  jsonResponse(res, 200, { message: 'Password updated. You can sign in with your new password.' });
}, { auth: false });

route('POST', '/api/auth/logout', async ({ req, res, user }) => {
  if (req.authPayload?.sid) await db.run('UPDATE auth_sessions SET revoked_at=? WHERE id=? AND user_id=?', [db.utcnow(), req.authPayload.sid, user.id]);
  await activity(user.id, 'signed_out', 'Signed out', clientDescription(req));
  jsonResponse(res, 200, { status: 'signed_out' }, { 'Set-Cookie': auth.clearSessionCookie() });
});

route('GET', '/api/auth/me', async ({ res, user }) => {
  const presence = await touchPresence(user.id);
  const organizations = await organizationSummary(user.id);
  const activeOrganizationCount = organizations.filter(item => item.membership_status === 'active').length;
  const pendingInvitation = await db.get(
    "SELECT COUNT(*) invitation_count FROM invitations WHERE invited_user_id=? AND status IN ('invited','awaiting_approval')",
    [user.id]
  );
  const settings = await settingsForUser(user.id);
  const unread = await db.get('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL', [user.id]);
  jsonResponse(res, 200, {
    user: publicUser(user),
    presence,
    settings,
    unread_notification_count: Number(unread?.count || 0),
    organizations,
    workspace_access: {
      can_access_workspace: activeOrganizationCount > 0,
      requires_onboarding: activeOrganizationCount === 0,
      active_organization_count: activeOrganizationCount,
      pending_invitation_count: Number(pendingInvitation?.invitation_count || 0)
    }
  });
});

route('GET', '/api/presence/me', async ({ res, user }) => {
  jsonResponse(res, 200, await presenceForUser(user.id));
});

route('POST', '/api/presence/heartbeat', async ({ res, user }) => {
  jsonResponse(res, 200, await touchPresence(user.id));
});

route('PATCH', '/api/presence/me', async ({ res, user, body }) => {
  const allowedModes = ['auto', 'online', 'away', 'dnd', 'offline'];
  const current = await presenceForUser(user.id);
  const mode = body.presence_mode === undefined ? current.presence_mode : cleanString(body.presence_mode, 20).toLowerCase();
  if (!allowedModes.includes(mode)) throw new HttpError(400, 'Invalid presence mode');
  const selectedStatus = body.status_key === undefined
    ? { key: current.status_key, label: current.status_label, emoji: current.status_emoji }
    : workspaceStatus(body.status_key, body.status_label, body.status_emoji);
  const customStatus = body.custom_status === undefined ? current.custom_status : cleanString(body.custom_status, 120);
  const statusExpiresAt = body.status_expires_at === undefined ? current.status_expires_at : (cleanString(body.status_expires_at, 40) || null);
  if (statusExpiresAt && !Number.isFinite(new Date(statusExpiresAt).getTime())) throw new HttpError(400, 'Status expiry must be a valid date');
  const now = db.utcnow();
  await db.run(
    `INSERT INTO user_presence(user_id,presence_mode,status_key,status_label,status_emoji,custom_status,status_expires_at,last_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET presence_mode=excluded.presence_mode,status_key=excluded.status_key,status_label=excluded.status_label,status_emoji=excluded.status_emoji,custom_status=excluded.custom_status,status_expires_at=excluded.status_expires_at,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
    [user.id, mode, selectedStatus.key, selectedStatus.label, selectedStatus.emoji, customStatus, statusExpiresAt, now, now]
  );
  await activity(user.id, 'status_updated', 'Workspace status updated', `${selectedStatus.emoji} ${selectedStatus.label}`);
  jsonResponse(res, 200, await presenceForUser(user.id));
});

route('PATCH', '/api/users/me/profile', async ({ res, user, body }) => {
  const updates = [];
  const values = [];
  if (body.full_name !== undefined) { updates.push('full_name=?'); values.push(requiredString(body.full_name, 'Full name', 2, 120)); }
  if (body.avatar_url !== undefined) { updates.push('avatar_url=?'); values.push(validateAvatarUrl(body.avatar_url)); }
  if (!updates.length) throw new HttpError(400, 'No supported profile fields were provided');
  updates.push('updated_at=?'); values.push(db.utcnow(), user.id);
  await db.run(`UPDATE users SET ${updates.join(',')} WHERE id=?`, values);
  await activity(user.id, 'profile_updated', 'Profile updated', 'Your name or avatar was updated.');
  jsonResponse(res, 200, publicUser(await db.get('SELECT * FROM users WHERE id=?', [user.id])));
});

route('GET', '/api/users/me/settings', async ({ res, user }) => {
  jsonResponse(res, 200, await settingsForUser(user.id));
});

const DASHBOARD_WIDGET_KEYS = ['summary', 'my_tasks', 'status_overview', 'priority_breakdown', 'assigned_tasks', 'people', 'team_workload'];

route('PATCH', '/api/users/me/settings', async ({ res, user, body }) => {
  const current = await settingsForUser(user.id);
  const theme = body.theme === undefined ? current.theme : cleanString(body.theme, 20).toLowerCase();
  if (!['light', 'dark', 'system'].includes(theme)) throw new HttpError(400, 'Theme must be light, dark, or system');
  const preferenceNames = ['workspace_notifications', 'mention_notifications', 'invitation_notifications', 'activity_notifications'];
  const values = { theme };
  for (const name of preferenceNames) values[name] = body[name] === undefined ? Number(current[name]) : booleanInt(Boolean(body[name]));
  let dashboardLayout = current.dashboard_layout || '';
  if (body.dashboard_layout !== undefined) {
    if (!Array.isArray(body.dashboard_layout)) throw new HttpError(400, 'dashboard_layout must be an array');
    const cleaned = body.dashboard_layout
      .filter(item => item && DASHBOARD_WIDGET_KEYS.includes(item.key))
      .slice(0, DASHBOARD_WIDGET_KEYS.length)
      .map(item => ({ key: item.key, visible: item.visible !== false }));
    dashboardLayout = JSON.stringify(cleaned);
  }
  const now = db.utcnow();
  await db.run(
    `INSERT INTO user_settings(user_id,theme,workspace_notifications,mention_notifications,invitation_notifications,activity_notifications,dashboard_layout,updated_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,workspace_notifications=excluded.workspace_notifications,mention_notifications=excluded.mention_notifications,invitation_notifications=excluded.invitation_notifications,activity_notifications=excluded.activity_notifications,dashboard_layout=excluded.dashboard_layout,updated_at=excluded.updated_at`,
    [user.id, values.theme, values.workspace_notifications, values.mention_notifications, values.invitation_notifications, values.activity_notifications, dashboardLayout, now]
  );
  await activity(user.id, 'settings_updated', 'Settings updated', `Theme: ${theme}`);
  jsonResponse(res, 200, await settingsForUser(user.id));
});

route('GET', '/api/users/me/notifications', async ({ res, user, query }) => {
  const requestedLimit = Number(query.get('limit') || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const items = await db.all(
    `SELECT n.*, o.name organization_name FROM notifications n
     LEFT JOIN organizations o ON o.id=n.organization_id
     WHERE n.user_id=? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    [user.id, limit]
  );
  const unread = await db.get('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL', [user.id]);
  jsonResponse(res, 200, { items, unread_count: Number(unread?.count || 0) });
});

route('PATCH', '/api/notifications/:notificationId/read', async ({ res, user, params }) => {
  const notificationId = integer(params.notificationId, 'notification id');
  const item = await db.get('SELECT * FROM notifications WHERE id=? AND user_id=?', [notificationId, user.id]);
  if (!item) throw new HttpError(404, 'Notification not found');
  if (!item.read_at) await db.run('UPDATE notifications SET read_at=? WHERE id=?', [db.utcnow(), notificationId]);
  jsonResponse(res, 200, await db.get('SELECT * FROM notifications WHERE id=?', [notificationId]));
});

route('POST', '/api/users/me/notifications/read-all', async ({ res, user }) => {
  const result = await db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [db.utcnow(), user.id]);
  jsonResponse(res, 200, { marked_read: result.changes });
});

route('GET', '/api/users/me/activity', async ({ res, user, query }) => {
  const requestedLimit = Number(query.get('limit') || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const items = await db.all(
    `SELECT a.*, o.name organization_name FROM account_activity a
     LEFT JOIN organizations o ON o.id=a.organization_id
     WHERE a.user_id=? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [user.id, limit]
  );
  jsonResponse(res, 200, items);
});

route('GET', '/api/users/me/sessions', async ({ req, res, user }) => {
  const sessions = (await db.all(
    `SELECT id,ip_address,user_agent,created_at,last_seen_at,expires_at,revoked_at
     FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY last_seen_at DESC`,
    [user.id, db.utcnow()]
  )).map(session => ({ ...session, current: session.id === req.authPayload?.sid }));
  jsonResponse(res, 200, sessions);
});

route('DELETE', '/api/users/me/sessions/:sessionId', async ({ req, res, user, params }) => {
  const sessionId = cleanString(params.sessionId, 80);
  const session = await db.get('SELECT * FROM auth_sessions WHERE id=? AND user_id=?', [sessionId, user.id]);
  if (!session) throw new HttpError(404, 'Session not found');
  await db.run('UPDATE auth_sessions SET revoked_at=? WHERE id=?', [db.utcnow(), sessionId]);
  await activity(user.id, 'session_revoked', 'Session signed out', sessionId === req.authPayload?.sid ? 'Current session' : session.user_agent);
  const headers = sessionId === req.authPayload?.sid ? { 'Set-Cookie': auth.clearSessionCookie() } : {};
  jsonResponse(res, 200, { revoked: true, current: sessionId === req.authPayload?.sid }, headers);
});

route('POST', '/api/users/me/sessions/revoke-others', async ({ req, res, user }) => {
  const currentSessionId = req.authPayload?.sid || '';
  const result = await db.run(
    `UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id<>?`,
    [db.utcnow(), user.id, currentSessionId]
  );
  await activity(user.id, 'sessions_revoked', 'Other sessions signed out', `${result.changes} session(s) revoked.`);
  jsonResponse(res, 200, { revoked_count: result.changes });
});

route('GET', '/api/status-presets', async ({ res }) => {
  jsonResponse(res, 200, Object.entries(WORKSPACE_STATUS_PRESETS).map(([key, value]) => ({ key, ...value })));
});

route('GET', '/api/organizations', async ({ res, user }) => {
  jsonResponse(res, 200, await organizationSummary(user.id));
});

route('POST', '/api/organizations', async ({ res, user, body }) => {
  const name = requiredString(body.name, 'Organization name', 2, 120);
  const now = db.utcnow();
  const created = await db.transaction(async () => {
    const organization = await db.run('INSERT INTO organizations(name,slug,created_by,created_at,updated_at) VALUES(?,?,?,?,?)', [name, await uniqueSlug(name), user.id, now, now]);
    await db.run('INSERT INTO memberships(organization_id,user_id,role,department,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?)', [organization.lastInsertRowid, user.id, 'ceo', 'Leadership', 'active', now, now]);
    await db.run('INSERT INTO channels(organization_id,name,topic,created_by,created_at) VALUES(?,?,?,?,?)', [organization.lastInsertRowid, 'general', 'Company-wide announcements and discussion', user.id, now]);
    await db.run('INSERT INTO channels(organization_id,name,topic,created_by,created_at) VALUES(?,?,?,?,?)', [organization.lastInsertRowid, 'project-updates', 'Project progress, blockers, and decisions', user.id, now]);
    return organization.lastInsertRowid;
  });
  await audit(created, null, user.id, 'organization', created, 'created', { name });
  await activity(user.id, 'organization_created', 'Organization created', name, created);
  await notifyUser(user.id, 'workspace', `Welcome to ${name}`, 'Your new organization is ready.', created, 'dashboard');
  const organization = await db.get('SELECT o.*, m.role, m.status membership_status FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE o.id=? AND m.user_id=?', [created, user.id]);
  jsonResponse(res, 201, organization);
});

route('GET', '/api/organizations/:organizationId', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const organization = await db.get('SELECT * FROM organizations WHERE id=?', [organizationId]);
  jsonResponse(res, 200, { ...organization, membership: member });
});

route('GET', '/api/organizations/:organizationId/members', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const scope = await resolveAccessScope(user.id, organizationId, member);
  const members = await organizationMembers(organizationId, false);
  jsonResponse(res, 200, scopeMemberList(scope, members));
});

route('GET', '/api/invitations/me', async ({ res, user }) => {
  const items = await db.all(
    `SELECT i.*, o.name organization_name, o.slug organization_slug, inviter.full_name invited_by_name
     FROM invitations i JOIN organizations o ON o.id=i.organization_id JOIN users inviter ON inviter.id=i.invited_by
     WHERE i.invited_user_id=? AND i.status IN ('invited','awaiting_approval') ORDER BY i.created_at DESC`,
    [user.id]
  );
  jsonResponse(res, 200, items);
});

route('POST', '/api/organizations/:organizationId/invitations', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const actor = await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const identifier = requiredString(body.identifier, 'Username or email', 3, 160).toLowerCase();
  const proposedRole = cleanString(body.proposed_role || 'member', 20).toLowerCase();
  const proposedDepartment = normalizeDepartment(body.proposed_department);
  if (!roleCanInvite(actor.role, proposedRole)) throw new HttpError(403, `A ${actor.role} cannot invite this role`);
  const invitedUser = await db.get('SELECT * FROM users WHERE username=? OR email=?', [identifier, identifier]);
  if (!invitedUser) throw new HttpError(404, 'No registered user matches that username or email');
  if (Number(invitedUser.id) === Number(user.id)) throw new HttpError(400, 'You cannot invite yourself');
  if (await membership(invitedUser.id, organizationId, false)) throw new HttpError(409, 'This user already has a membership in the organization');
  if (await db.get("SELECT id FROM invitations WHERE organization_id=? AND invited_user_id=? AND status IN ('invited','awaiting_approval')", [organizationId, invitedUser.id])) throw new HttpError(409, 'An active invitation already exists for this user');
  const now = db.utcnow();
  const result = await db.run('INSERT INTO invitations(organization_id,invited_user_id,invited_by,proposed_role,proposed_department,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [organizationId, invitedUser.id, user.id, proposedRole, proposedDepartment, 'invited', now, now]);
  await audit(organizationId, null, user.id, 'invitation', result.lastInsertRowid, 'created', { invited_user_id: invitedUser.id, proposed_role: proposedRole, proposed_department: proposedDepartment });
  const organization = await db.get('SELECT name FROM organizations WHERE id=?', [organizationId]);
  await notifyUser(invitedUser.id, 'invitation', `Invitation to ${organization.name}`, `${user.full_name} invited you as ${proposedRole} in ${proposedDepartment}.`, organizationId, 'notifications');
  await activity(user.id, 'invitation_sent', 'Invitation sent', `Invited ${invitedUser.full_name} to ${organization.name}.`, organizationId);
  jsonResponse(res, 201, await db.get('SELECT * FROM invitations WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/organizations/:organizationId/invitations', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const items = await db.all(
    `SELECT i.*, invited.username invited_username, invited.email invited_email, invited.full_name invited_name,
            inviter.full_name invited_by_name, approver.full_name approved_by_name
     FROM invitations i
     JOIN users invited ON invited.id=i.invited_user_id
     JOIN users inviter ON inviter.id=i.invited_by
     LEFT JOIN users approver ON approver.id=i.approved_by
     WHERE i.organization_id=? ORDER BY i.created_at DESC`,
    [organizationId]
  );
  jsonResponse(res, 200, items);
});

route('POST', '/api/invitations/:invitationId/accept', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation || Number(invitation.invited_user_id) !== Number(user.id)) throw new HttpError(404, 'Invitation not found');
  if (invitation.status !== 'invited') throw new HttpError(409, 'Invitation cannot be accepted in its current state');
  const now = db.utcnow();
  await db.run("UPDATE invitations SET status='awaiting_approval',user_responded_at=?,updated_at=? WHERE id=?", [now, now, invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'accepted_awaiting_approval');
  const organization = await db.get('SELECT name FROM organizations WHERE id=?', [invitation.organization_id]);
  await activity(user.id, 'invitation_accepted', 'Invitation accepted', `Waiting for approval to join ${organization.name}.`, invitation.organization_id);
  await notifyOrganizationManagers(invitation.organization_id, 'Invitation awaiting approval', `${user.full_name} accepted an invitation and is waiting for access approval.`, user.id);
  jsonResponse(res, 200, { message: 'Invitation accepted. CEO or admin approval is still required.', status: 'awaiting_approval' });
});

route('POST', '/api/invitations/:invitationId/decline', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation || Number(invitation.invited_user_id) !== Number(user.id)) throw new HttpError(404, 'Invitation not found');
  if (!['invited', 'awaiting_approval'].includes(invitation.status)) throw new HttpError(409, 'Invitation cannot be declined in its current state');
  await db.run("UPDATE invitations SET status='declined',user_responded_at=?,updated_at=? WHERE id=?", [db.utcnow(), db.utcnow(), invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'declined');
  await activity(user.id, 'invitation_declined', 'Invitation declined', 'You declined an organization invitation.', invitation.organization_id);
  await notifyUser(invitation.invited_by, 'activity', 'Invitation declined', `${user.full_name} declined the invitation.`, invitation.organization_id, 'admin');
  jsonResponse(res, 200, { status: 'declined' });
});

route('POST', '/api/invitations/:invitationId/approve', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  const actor = await requireMembership(user.id, Number(invitation.organization_id), ['ceo', 'admin']);
  if (invitation.status !== 'awaiting_approval') throw new HttpError(409, 'The invited user must accept before CEO/admin approval');
  if (!roleCanInvite(actor.role, invitation.proposed_role)) throw new HttpError(403, 'You cannot approve the proposed role');
  const now = db.utcnow();
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO memberships(organization_id,user_id,role,department,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,department=excluded.department,status='active',updated_at=excluded.updated_at`,
      [invitation.organization_id, invitation.invited_user_id, invitation.proposed_role, normalizeDepartment(invitation.proposed_department), 'active', now, now]
    );
    await db.run("UPDATE invitations SET status='approved',approved_by=?,approved_at=?,updated_at=? WHERE id=?", [user.id, now, now, invitationId]);
  });
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'approved_membership_created', { role: invitation.proposed_role, department: normalizeDepartment(invitation.proposed_department) });
  const approvedOrganization = await db.get('SELECT name FROM organizations WHERE id=?', [invitation.organization_id]);
  await notifyUser(invitation.invited_user_id, 'invitation', `Access approved for ${approvedOrganization.name}`, `Your ${invitation.proposed_role} membership is now active.`, invitation.organization_id, 'dashboard');
  await activity(invitation.invited_user_id, 'membership_approved', 'Organization access approved', approvedOrganization.name, invitation.organization_id);
  await activity(user.id, 'membership_approved', 'Member access approved', `Approved user ${invitation.invited_user_id}.`, invitation.organization_id);
  jsonResponse(res, 200, { status: 'approved', membership: await membership(invitation.invited_user_id, invitation.organization_id, false) });
});

route('POST', '/api/invitations/:invitationId/reject', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  await requireMembership(user.id, Number(invitation.organization_id), ['ceo', 'admin']);
  if (!['invited', 'awaiting_approval'].includes(invitation.status)) throw new HttpError(409, 'Invitation cannot be rejected in its current state');
  await db.run("UPDATE invitations SET status='rejected',approved_by=?,approved_at=?,updated_at=? WHERE id=?", [user.id, db.utcnow(), db.utcnow(), invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'rejected');
  await notifyUser(invitation.invited_user_id, 'invitation', 'Organization invitation rejected', 'Your request to join was not approved.', invitation.organization_id, 'notifications');
  await activity(invitation.invited_user_id, 'membership_rejected', 'Organization access rejected', 'An organization invitation was rejected.', invitation.organization_id);
  jsonResponse(res, 200, { status: 'rejected' });
});

route('POST', '/api/invitations/:invitationId/cancel', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  const actor = await requireMembership(user.id, Number(invitation.organization_id), ['ceo', 'admin', 'moderator']);
  if (!roleCanInvite(actor.role, invitation.proposed_role)) throw new HttpError(403, 'You cannot cancel an invitation for this role');
  if (!['invited', 'awaiting_approval'].includes(invitation.status)) throw new HttpError(409, 'Invitation cannot be cancelled in its current state');
  await db.run("UPDATE invitations SET status='cancelled',updated_at=? WHERE id=?", [db.utcnow(), invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'cancelled');
  await notifyUser(invitation.invited_user_id, 'invitation', 'Invitation cancelled', 'An organization invitation was cancelled by a manager.', invitation.organization_id, 'notifications');
  jsonResponse(res, 200, { status: 'cancelled' });
});

route('PATCH', '/api/memberships/:membershipId', async ({ res, user, params, body }) => {
  const membershipId = integer(params.membershipId, 'membership id');
  const target = await db.get('SELECT * FROM memberships WHERE id=?', [membershipId]);
  if (!target) throw new HttpError(404, 'Membership not found');
  const actor = await requireMembership(user.id, Number(target.organization_id), ['ceo', 'admin']);
  if (target.role === 'ceo') throw new HttpError(403, 'CEO membership cannot be modified');
  const updates = [];
  const values = [];
  if (body.role !== undefined) {
    const role = cleanString(body.role, 20).toLowerCase();
    if (!['admin', 'moderator', 'member'].includes(role)) throw new HttpError(400, 'Invalid role');
    if (actor.role !== 'ceo' && (target.role === 'admin' || role === 'admin')) throw new HttpError(403, 'Only the CEO can manage admin access');
    updates.push('role=?'); values.push(role);
  }
  if (body.department !== undefined) {
    updates.push('department=?'); values.push(normalizeDepartment(body.department));
  }
  if (body.department_id !== undefined) {
    const departmentId = body.department_id ? integer(body.department_id, 'department_id') : null;
    if (departmentId && !await db.get('SELECT id FROM departments WHERE id=? AND organization_id=?', [departmentId, target.organization_id])) throw new HttpError(400, 'department_id must reference a department in this organization');
    updates.push('department_id=?'); values.push(departmentId);
  }
  if (body.manager_user_id !== undefined) {
    const managerUserId = body.manager_user_id ? integer(body.manager_user_id, 'manager_user_id') : null;
    if (managerUserId && !await membership(managerUserId, target.organization_id, true)) throw new HttpError(400, 'manager_user_id must be an active organization member');
    if (managerUserId === Number(target.user_id)) throw new HttpError(400, 'A person cannot be their own manager');
    updates.push('manager_user_id=?'); values.push(managerUserId);
  }
  if (body.job_role_id !== undefined) {
    const jobRoleId = body.job_role_id ? integer(body.job_role_id, 'job_role_id') : null;
    if (jobRoleId && !await db.get('SELECT id FROM job_roles WHERE id=? AND organization_id=?', [jobRoleId, target.organization_id])) throw new HttpError(400, 'job_role_id must reference a job role in this organization');
    updates.push('job_role_id=?'); values.push(jobRoleId);
  }
  if (body.status !== undefined) {
    const status = cleanString(body.status, 20).toLowerCase();
    if (!['active', 'suspended'].includes(status)) throw new HttpError(400, 'Invalid membership status');
    if (actor.role !== 'ceo' && target.role === 'admin') throw new HttpError(403, 'Only the CEO can suspend an admin');
    updates.push('status=?'); values.push(status);
  }
  if (!updates.length) throw new HttpError(400, 'No supported membership fields were provided');
  updates.push('updated_at=?'); values.push(db.utcnow(), membershipId);
  await db.run(`UPDATE memberships SET ${updates.join(',')} WHERE id=?`, values);
  await audit(target.organization_id, null, user.id, 'membership', membershipId, 'updated', body);
  const updatedOrganization = await db.get('SELECT name FROM organizations WHERE id=?', [target.organization_id]);
  await notifyUser(target.user_id, 'activity', 'Membership updated', `Your role, department, or access in ${updatedOrganization.name} changed.`, target.organization_id, 'profile');
  await activity(target.user_id, 'membership_updated', 'Membership updated', updatedOrganization.name, target.organization_id);
  jsonResponse(res, 200, (await organizationMembers(target.organization_id, false)).find(item => Number(item.membership_id) === membershipId));
});

route('DELETE', '/api/memberships/:membershipId', async ({ res, user, params }) => {
  const membershipId = integer(params.membershipId, 'membership id');
  const target = await db.get('SELECT * FROM memberships WHERE id=?', [membershipId]);
  if (!target) throw new HttpError(404, 'Membership not found');
  const actor = await requireMembership(user.id, Number(target.organization_id), ['ceo', 'admin']);
  if (target.role === 'ceo') throw new HttpError(403, 'CEO membership cannot be removed');
  if (actor.role !== 'ceo' && target.role === 'admin') throw new HttpError(403, 'Only the CEO can remove an admin');
  await db.run('DELETE FROM memberships WHERE id=?', [membershipId]);
  await audit(target.organization_id, null, user.id, 'membership', membershipId, 'removed', { user_id: target.user_id });
  const removedOrganization = await db.get('SELECT name FROM organizations WHERE id=?', [target.organization_id]);
  await notifyUser(target.user_id, 'activity', 'Removed from organization', `Your membership in ${removedOrganization.name} was removed.`, target.organization_id, 'notifications');
  await activity(target.user_id, 'membership_removed', 'Organization membership removed', removedOrganization.name, target.organization_id);
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/organizations/:organizationId/departments', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const scope = await resolveAccessScope(user.id, organizationId, member);
  const departments = await db.all(
    `SELECT d.*,u.full_name manager_name,
      (SELECT COUNT(*) FROM memberships m WHERE m.department_id=d.id AND m.status='active') member_count,
      (SELECT COUNT(*) FROM teams t WHERE t.department_id=d.id) team_count
     FROM departments d LEFT JOIN users u ON u.id=d.manager_user_id
     WHERE d.organization_id=? ORDER BY d.name`,
    [organizationId]
  );
  jsonResponse(res, 200, scopeDepartmentList(scope, departments));
});

route('POST', '/api/organizations/:organizationId/departments', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin']);
  const name = requiredString(body.name, 'Department name', 2, 120);
  const managerUserId = body.manager_user_id ? integer(body.manager_user_id, 'manager_user_id') : null;
  if (managerUserId && !await membership(managerUserId, organizationId, true)) throw new HttpError(400, 'manager_user_id must be an active organization member');
  const now = db.utcnow();
  let result;
  try {
    result = await db.run('INSERT INTO departments(organization_id,name,description,manager_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', [organizationId, name, cleanString(body.description), managerUserId, now, now]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'A department with this name already exists');
    throw error;
  }
  await audit(organizationId, null, user.id, 'department', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM departments WHERE id=?', [result.lastInsertRowid]));
});

async function departmentWithAccess(userId, departmentId, roles = null) {
  const department = await db.get('SELECT * FROM departments WHERE id=?', [departmentId]);
  if (!department) throw new HttpError(404, 'Department not found');
  const member = await requireMembership(userId, Number(department.organization_id), roles);
  return { department, member };
}

function isDepartmentManager(department, member) {
  return ['ceo', 'admin'].includes(member.role) || Number(department.manager_user_id) === Number(member.user_id);
}

route('PATCH', '/api/departments/:departmentId', async ({ res, user, params, body }) => {
  const departmentId = integer(params.departmentId, 'department id');
  const { department, member } = await departmentWithAccess(user.id, departmentId);
  if (!isDepartmentManager(department, member)) throw new HttpError(403, 'Only CEO, admin, or the department manager can edit this department');
  const allowed = {
    name: value => requiredString(value, 'Department name', 2, 120),
    description: value => cleanString(value),
    manager_user_id: value => value ? integer(value, 'manager_user_id') : null
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'manager_user_id') {
        if (!['ceo', 'admin'].includes(member.role)) throw new HttpError(403, 'Only CEO or admin can reassign the department manager');
        if (value && !await membership(value, department.organization_id, true)) throw new HttpError(400, 'manager_user_id must be an active organization member');
      }
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), departmentId);
    await db.run(`UPDATE departments SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(department.organization_id, null, user.id, 'department', departmentId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM departments WHERE id=?', [departmentId]));
});

route('DELETE', '/api/departments/:departmentId', async ({ res, user, params }) => {
  const departmentId = integer(params.departmentId, 'department id');
  const { department } = await departmentWithAccess(user.id, departmentId, ['ceo', 'admin']);
  await db.run('UPDATE memberships SET department_id=NULL WHERE department_id=?', [departmentId]);
  await db.run('UPDATE teams SET department_id=NULL WHERE department_id=?', [departmentId]);
  await db.run('UPDATE stories SET department_id=NULL WHERE department_id=?', [departmentId]);
  await db.run('DELETE FROM departments WHERE id=?', [departmentId]);
  await audit(department.organization_id, null, user.id, 'department', departmentId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/organizations/:organizationId/job-roles', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  jsonResponse(res, 200, await db.all('SELECT * FROM job_roles WHERE organization_id=? ORDER BY name', [organizationId]));
});

route('POST', '/api/organizations/:organizationId/job-roles', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin']);
  const name = requiredString(body.name, 'Job role name', 2, 80);
  const now = db.utcnow();
  let result;
  try {
    result = await db.run('INSERT INTO job_roles(organization_id,name,created_at) VALUES(?,?,?)', [organizationId, name, now]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'This job role already exists');
    throw error;
  }
  await audit(organizationId, null, user.id, 'job_role', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM job_roles WHERE id=?', [result.lastInsertRowid]));
});

route('DELETE', '/api/job-roles/:jobRoleId', async ({ res, user, params }) => {
  const jobRoleId = integer(params.jobRoleId, 'job role id');
  const jobRole = await db.get('SELECT * FROM job_roles WHERE id=?', [jobRoleId]);
  if (!jobRole) throw new HttpError(404, 'Job role not found');
  await requireMembership(user.id, Number(jobRole.organization_id), ['ceo', 'admin']);
  await db.run('UPDATE memberships SET job_role_id=NULL WHERE job_role_id=?', [jobRoleId]);
  await db.run('DELETE FROM job_roles WHERE id=?', [jobRoleId]);
  await audit(jobRole.organization_id, null, user.id, 'job_role', jobRoleId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/organizations/:organizationId/teams', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const scope = await resolveAccessScope(user.id, organizationId, member);
  const teams = await db.all(
    `SELECT t.*,d.name department_name,u.full_name lead_name,
      (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id=t.id) member_count
     FROM teams t LEFT JOIN departments d ON d.id=t.department_id LEFT JOIN users u ON u.id=t.lead_user_id
     WHERE t.organization_id=? ORDER BY t.name`,
    [organizationId]
  );
  jsonResponse(res, 200, scopeTeamList(scope, teams));
});

route('POST', '/api/organizations/:organizationId/teams', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const name = requiredString(body.name, 'Team name', 2, 120);
  const departmentId = body.department_id ? integer(body.department_id, 'department_id') : null;
  let department = null;
  if (departmentId) {
    department = await db.get('SELECT * FROM departments WHERE id=? AND organization_id=?', [departmentId, organizationId]);
    if (!department) throw new HttpError(400, 'department_id must reference a department in this organization');
  }
  if (!['ceo', 'admin'].includes(member.role) && !(department && isDepartmentManager(department, member))) throw new HttpError(403, 'Only CEO, admin, or the managing department head can create a team');
  const leadUserId = body.lead_user_id ? integer(body.lead_user_id, 'lead_user_id') : null;
  if (leadUserId && !await membership(leadUserId, organizationId, true)) throw new HttpError(400, 'lead_user_id must be an active organization member');
  const now = db.utcnow();
  let result;
  try {
    result = await db.run('INSERT INTO teams(organization_id,department_id,name,description,lead_user_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [organizationId, departmentId, name, cleanString(body.description), leadUserId, 'active', now, now]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'A team with this name already exists');
    throw error;
  }
  await audit(organizationId, null, user.id, 'team', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM teams WHERE id=?', [result.lastInsertRowid]));
});

async function teamWithAccess(userId, teamId, roles = null) {
  const team = await db.get('SELECT * FROM teams WHERE id=?', [teamId]);
  if (!team) throw new HttpError(404, 'Team not found');
  const member = await requireMembership(userId, Number(team.organization_id), roles);
  return { team, member };
}

function isTeamManager(team, member) {
  return ['ceo', 'admin'].includes(member.role) || Number(team.lead_user_id) === Number(member.user_id);
}

async function validTeamId(value, organizationId, field = 'team_id') {
  if (!value) return null;
  const teamId = integer(value, field);
  const team = await db.get('SELECT * FROM teams WHERE id=? AND organization_id=?', [teamId, organizationId]);
  if (!team) throw new HttpError(400, `${field} must reference a team in this organization`);
  return team;
}

// ADMIN/PROJECT MANAGER (ceo/admin/moderator) can always assign. A TEAM MANAGER (the lead of the
// task's own team) may only assign within their own team. A plain WORKER can never assign work.
async function canAssignTask(task, member, targetOwnerId) {
  if (['ceo', 'admin', 'moderator'].includes(member.role)) return true;
  if (!task.team_id) return false;
  const team = await db.get('SELECT * FROM teams WHERE id=?', [task.team_id]);
  if (!team) return false;
  const isLead = Number(team.lead_user_id) === Number(member.user_id);
  // A department manager also manages every team under their department, not only teams they
  // personally lead — matches resolveAccessScope()'s managedTeamIds expansion for the same reason.
  const isDepartmentManager = team.department_id
    ? Boolean(await db.get('SELECT 1 found FROM departments WHERE id=? AND manager_user_id=?', [team.department_id, member.user_id]))
    : false;
  if (!isLead && !isDepartmentManager) return false;
  if (!targetOwnerId) return true;
  return Boolean(await db.get('SELECT id FROM team_members WHERE team_id=? AND user_id=?', [task.team_id, targetOwnerId]));
}

async function recordTaskAssignment(project, taskId, actorUserId, previousOwnerId, newOwnerId) {
  await audit(project.organization_id, project.id, actorUserId, 'task', taskId, 'assigned', { previous_owner_id: previousOwnerId || null, new_owner_id: newOwnerId || null });
  if (newOwnerId && Number(newOwnerId) !== Number(actorUserId)) {
    const task = await db.get('SELECT title FROM tasks WHERE id=?', [taskId]);
    const verb = previousOwnerId ? 'reassigned to you' : 'assigned to you';
    await notifyUser(newOwnerId, 'task_assignment', previousOwnerId ? 'Task reassigned to you' : 'New task assigned to you', `"${task?.title || 'A task'}" was ${verb}.`, project.organization_id, `work:${taskId}`);
    await activity(newOwnerId, 'task_assigned', previousOwnerId ? 'Task reassigned to you' : 'New task assigned to you', task?.title || '', project.organization_id);
  }
}

route('PATCH', '/api/teams/:teamId', async ({ res, user, params, body }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  if (!isTeamManager(team, member)) throw new HttpError(403, 'Only CEO, admin, or the team lead can edit this team');
  const allowed = {
    name: value => requiredString(value, 'Team name', 2, 120),
    description: value => cleanString(value),
    status: value => { if (!['active', 'archived'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    department_id: value => value ? integer(value, 'department_id') : null,
    lead_user_id: value => value ? integer(value, 'lead_user_id') : null
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'department_id' && value && !await db.get('SELECT id FROM departments WHERE id=? AND organization_id=?', [value, team.organization_id])) throw new HttpError(400, 'department_id must reference a department in this organization');
      if (key === 'lead_user_id' && value && !await membership(value, team.organization_id, true)) throw new HttpError(400, 'lead_user_id must be an active organization member');
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), teamId);
    await db.run(`UPDATE teams SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(team.organization_id, null, user.id, 'team', teamId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM teams WHERE id=?', [teamId]));
});

route('DELETE', '/api/teams/:teamId', async ({ res, user, params }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  if (!isTeamManager(team, member)) throw new HttpError(403, 'Only CEO, admin, or the team lead can delete this team');
  await db.run('UPDATE stories SET team_id=NULL WHERE team_id=?', [teamId]);
  await db.run('UPDATE tasks SET team_id=NULL WHERE team_id=?', [teamId]);
  await db.run('DELETE FROM teams WHERE id=?', [teamId]);
  await audit(team.organization_id, null, user.id, 'team', teamId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/teams/:teamId/members', async ({ res, user, params }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  const scope = await resolveAccessScope(user.id, Number(team.organization_id), member);
  const canView = scope.fullAccess || scope.managedTeamIds.includes(teamId) || scope.ownTeamIds.includes(teamId);
  if (!canView) throw new HttpError(403, 'You do not have access to this team');
  const members = await db.all(
    'SELECT tm.*,u.full_name,u.username,u.avatar_url FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY u.full_name',
    [teamId]
  );
  jsonResponse(res, 200, members);
});

route('POST', '/api/teams/:teamId/members', async ({ res, user, params, body }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  if (!isTeamManager(team, member)) throw new HttpError(403, 'Only CEO, admin, or the team lead can manage team members');
  const targetUserId = integer(body.user_id, 'user_id');
  if (!await membership(targetUserId, team.organization_id, true)) throw new HttpError(400, 'user_id must be an active organization member');
  const now = db.utcnow();
  await db.run('INSERT OR IGNORE INTO team_members(team_id,user_id,role_in_team,joined_at) VALUES(?,?,?,?)', [teamId, targetUserId, cleanString(body.role_in_team, 80), now]);
  await audit(team.organization_id, null, user.id, 'team_member', teamId, 'added', { user_id: targetUserId });
  jsonResponse(res, 201, await db.get('SELECT tm.*,u.full_name,u.username FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? AND tm.user_id=?', [teamId, targetUserId]));
});

route('DELETE', '/api/teams/:teamId/members/:memberUserId', async ({ res, user, params }) => {
  const teamId = integer(params.teamId, 'team id');
  const memberUserId = integer(params.memberUserId, 'user id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  if (!isTeamManager(team, member)) throw new HttpError(403, 'Only CEO, admin, or the team lead can manage team members');
  await db.run('DELETE FROM team_members WHERE team_id=? AND user_id=?', [teamId, memberUserId]);
  await audit(team.organization_id, null, user.id, 'team_member', teamId, 'removed', { user_id: memberUserId });
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/teams/:teamId/workspace', async ({ res, user, params }) => {
  const teamId = integer(params.teamId, 'team id');
  const { team, member } = await teamWithAccess(user.id, teamId);
  const isMember = await db.get('SELECT id FROM team_members WHERE team_id=? AND user_id=?', [teamId, user.id]);
  if (!isTeamManager(team, member) && !isMember) throw new HttpError(403, 'You are not a member of this team');
  const members = await db.all('SELECT tm.*,u.full_name,u.username,u.avatar_url FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY u.full_name', [teamId]);
  const memberIds = members.map(item => Number(item.user_id));
  const workload = [];
  let tasks = [];
  let projects = [];
  if (memberIds.length) {
    const placeholders = memberIds.map(() => '?').join(',');
    tasks = await db.all(`SELECT t.*,p.name project_name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.organization_id=? AND t.owner_id IN (${placeholders}) AND t.rejected=0 ORDER BY (t.due_date IS NULL),t.due_date LIMIT 200`, [team.organization_id, ...memberIds]);
    for (const person of members) {
      const activeCount = tasks.filter(item => Number(item.owner_id) === Number(person.user_id) && item.status !== 'done').length;
      workload.push({ user_id: person.user_id, full_name: person.full_name, active_task_count: activeCount, capacity: 5 });
    }
    const projectIds = [...new Set(tasks.map(item => Number(item.project_id)))];
    if (projectIds.length) projects = await db.all(`SELECT * FROM projects WHERE id IN (${projectIds.map(() => '?').join(',')})`, projectIds);
  }
  const today = db.utcnow().slice(0, 10);
  const overdueCount = tasks.filter(item => item.status !== 'done' && item.due_date && item.due_date < today).length;

  const unassignedItems = await db.all(
    `SELECT t.*,p.name project_name,s.name story_name,parent.title parent_task_title
     FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN stories s ON s.id=t.story_id LEFT JOIN tasks parent ON parent.id=t.parent_task_id
     WHERE t.team_id=? AND t.owner_id IS NULL AND t.rejected=0
     ORDER BY (t.story_id IS NULL),t.story_id,(t.parent_task_id IS NOT NULL),t.id`,
    [teamId]
  );
  const storyGroups = new Map();
  for (const item of unassignedItems) {
    const storyKey = Number(item.story_id) || 0;
    if (!storyGroups.has(storyKey)) {
      storyGroups.set(storyKey, { story_id: item.story_id ? Number(item.story_id) : null, story_name: item.story_name || 'No story', project_id: Number(item.project_id), project_name: item.project_name, tasks: [], subtasks: [] });
    }
    const group = storyGroups.get(storyKey);
    if (item.parent_task_id) group.subtasks.push(item); else group.tasks.push(item);
  }
  const needsDistribution = { stories: [...storyGroups.values()] };

  jsonResponse(res, 200, { team, members, workload, tasks, projects, overdue_count: overdueCount, needs_distribution: needsDistribution });
});

route('GET', '/api/organizations/:organizationId/manager-workspace', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const isOrgAdmin = ['ceo', 'admin'].includes(member.role);
  const departments = isOrgAdmin
    ? await db.all('SELECT * FROM departments WHERE organization_id=? ORDER BY name', [organizationId])
    : await db.all('SELECT * FROM departments WHERE organization_id=? AND manager_user_id=? ORDER BY name', [organizationId, user.id]);
  const result = [];
  for (const department of departments) {
    const teams = await db.all(
      'SELECT t.*,(SELECT COUNT(*) FROM team_members tm WHERE tm.team_id=t.id) member_count FROM teams t WHERE t.department_id=? ORDER BY t.name',
      [department.id]
    );
    const teamMembers = await db.all(
      'SELECT DISTINCT tm.user_id,u.full_name,u.username FROM team_members tm JOIN teams t ON t.id=tm.team_id JOIN users u ON u.id=tm.user_id WHERE t.department_id=?',
      [department.id]
    );
    const deptMembers = await db.all(
      "SELECT m.user_id,u.full_name,u.username FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.department_id=? AND m.status='active'",
      [department.id]
    );
    const rosterMap = new Map();
    for (const person of [...teamMembers, ...deptMembers]) rosterMap.set(Number(person.user_id), person);
    const roster = [...rosterMap.values()];
    const workload = [];
    for (const person of roster) {
      const counts = await db.get(
        "SELECT COUNT(*) active_count FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.organization_id=? AND t.owner_id=? AND t.status<>'done' AND t.rejected=0",
        [organizationId, person.user_id]
      );
      workload.push({ user_id: person.user_id, full_name: person.full_name, username: person.username, active_task_count: Number(counts.active_count), capacity: 5 });
    }
    const stories = await db.all(
      `SELECT s.*,p.name project_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id=s.id AND t.rejected=0) task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id=s.id AND t.rejected=0 AND t.status='done') done_task_count
       FROM stories s JOIN projects p ON p.id=s.project_id WHERE s.department_id=? ORDER BY (s.due_date IS NULL),s.due_date`,
      [department.id]
    );
    const today = db.utcnow().slice(0, 10);
    const storyIds = stories.map(item => Number(item.id));
    let deadlineTasks = [];
    let blockedTasks = [];
    if (storyIds.length) {
      const placeholders = storyIds.map(() => '?').join(',');
      deadlineTasks = await db.all(`SELECT * FROM tasks WHERE story_id IN (${placeholders}) AND rejected=0 AND status<>'done' AND due_date IS NOT NULL AND due_date>=? ORDER BY due_date LIMIT 10`, [...storyIds, today]);
      blockedTasks = await db.all(`SELECT * FROM tasks WHERE story_id IN (${placeholders}) AND rejected=0 AND status='blocked'`, storyIds);
    }
    result.push({ department, teams, roster, workload, stories, deadline_tasks: deadlineTasks, blocked_tasks: blockedTasks });
  }
  jsonResponse(res, 200, { is_manager: departments.length > 0, departments: result });
});

route('GET', '/api/organizations/:organizationId/dashboard', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const membershipRow = await requireMembership(user.id, organizationId);
  const scope = await resolveAccessScope(user.id, organizationId, membershipRow);
  const today = db.utcnow().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sevenDaysAhead = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  // Scoped once, up front: a Manager only ever sees their own team's tasks from here on, a Worker
  // only their own — every downstream summary/status/priority/people/team section below is a plain
  // function of `allTasks`, so scoping the source data alone makes the whole dashboard role-correct
  // without touching any of that existing aggregation logic (CEO/admin/moderator: unchanged).
  const orgTasks = await db.all(
    `SELECT t.*,p.name project_name,u.full_name owner_name,s.name story_name,s.team_id story_team_id,tm.name team_name,lead.full_name team_manager_name
     FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.owner_id
     LEFT JOIN stories s ON s.id=t.story_id LEFT JOIN teams tm ON tm.id=t.team_id LEFT JOIN users lead ON lead.id=tm.lead_user_id
     WHERE p.organization_id=? AND t.rejected=0`,
    [organizationId]
  );
  const allTasks = scopeTaskList(scope, orgTasks);

  const completed7d = allTasks.filter(task => task.status === 'done' && task.updated_at >= sevenDaysAgo).length;
  const updated7d = allTasks.filter(task => task.updated_at >= sevenDaysAgo).length;
  const created7d = allTasks.filter(task => task.created_at >= sevenDaysAgo).length;
  const dueSoon7d = allTasks.filter(task => task.status !== 'done' && task.due_date && task.due_date >= today && task.due_date <= sevenDaysAhead).length;

  const myTasks = allTasks.filter(task => Number(task.owner_id) === Number(user.id));
  const myUpcoming = myTasks.filter(task => task.status !== 'done' && (!task.due_date || task.due_date >= today)).sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))).slice(0, 20);
  const myOverdue = myTasks.filter(task => task.status !== 'done' && task.due_date && task.due_date < today);
  const myCompleted = myTasks.filter(task => task.status === 'done').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 20);

  const statusDistribution = { not_started: 0, in_progress: 0, blocked: 0, done: 0 };
  const priorityDistribution = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const task of allTasks) {
    if (statusDistribution[task.status] !== undefined) statusDistribution[task.status] += 1;
    if (priorityDistribution[task.priority] !== undefined) priorityDistribution[task.priority] += 1;
  }

  const assignedByMe = allTasks.filter(task => Number(task.created_by) === Number(user.id) && task.owner_id && Number(task.owner_id) !== Number(user.id)).sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))).slice(0, 20);

  const members = await activeOrganizationMembers(organizationId);
  // Dashboard "people" is a workload/stats view, not a directory — a Worker's dashboard shows only
  // their own row (this is their "My Work" surface), a Manager's shows only their own team's people.
  const dashboardPeopleSource = scope.fullAccess
    ? members
    : members.filter(member => (isManagerScope(scope) ? scope.managedTeamUserIds : new Set([scope.userId])).has(Number(member.user_id)));
  const people = dashboardPeopleSource.map(member => {
    const owned = allTasks.filter(task => Number(task.owner_id) === Number(member.user_id));
    const activeCount = owned.filter(task => task.status !== 'done').length;
    const overdueCount = owned.filter(task => task.status !== 'done' && task.due_date && task.due_date < today).length;
    const completedCount = owned.filter(task => task.status === 'done').length;
    const capacity = Number(member.capacity || 5);
    return { user_id: member.user_id, full_name: member.full_name, active_task_count: activeCount, overdue_count: overdueCount, completed_count: completedCount, capacity, overloaded: activeCount > capacity };
  });

  const ledTeams = await db.all('SELECT id,name FROM teams WHERE organization_id=? AND lead_user_id=? AND status=\'active\'', [organizationId, user.id]);
  const teamManagement = ledTeams.map(team => {
    const teamTasks = allTasks.filter(task => Number(task.team_id) === Number(team.id));
    return {
      team_id: Number(team.id),
      team_name: team.name,
      needs_distribution_count: teamTasks.filter(task => !task.owner_id).length,
      in_progress_count: teamTasks.filter(task => task.status === 'in_progress').length,
      completed_count: teamTasks.filter(task => task.status === 'done').length,
      overdue_count: teamTasks.filter(task => task.status !== 'done' && task.due_date && task.due_date < today).length
    };
  });

  jsonResponse(res, 200, {
    summary: { completed_7d: completed7d, updated_7d: updated7d, created_7d: created7d, due_soon_7d: dueSoon7d },
    my_tasks: { upcoming: myUpcoming, overdue: myOverdue, completed: myCompleted },
    status_distribution: statusDistribution,
    priority_distribution: priorityDistribution,
    assigned_by_me: assignedByMe,
    people,
    team_management: teamManagement
  });
});

route('GET', '/api/organizations/:organizationId/channels', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const channels = await db.all(
    `SELECT c.*, u.full_name created_by_name,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id=c.id) message_count
     FROM channels c JOIN users u ON u.id=c.created_by
     WHERE c.organization_id=? AND c.archived=0 ORDER BY c.name`,
    [organizationId]
  );
  jsonResponse(res, 200, channels);
});

route('POST', '/api/organizations/:organizationId/channels', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const name = requiredString(body.name, 'Channel name', 2, 60).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
  if (name.length < 2) throw new HttpError(400, 'Channel name must contain letters or numbers');
  const topic = cleanString(body.topic, 240);
  if (await db.get('SELECT id FROM channels WHERE organization_id=? AND name=?', [organizationId, name])) throw new HttpError(409, 'A channel with this name already exists');
  const result = await db.run('INSERT INTO channels(organization_id,name,topic,created_by,created_at) VALUES(?,?,?,?,?)', [organizationId, name, topic, user.id, db.utcnow()]);
  await audit(organizationId, null, user.id, 'channel', result.lastInsertRowid, 'created', { name, topic });
  jsonResponse(res, 201, await db.get('SELECT * FROM channels WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/channels/:channelId/messages', async ({ res, user, params, query }) => {
  const channelId = integer(params.channelId, 'channel id');
  await channelWithAccess(user.id, channelId);
  const before = query.get('before');
  const paramsList = [channelId];
  let condition = '';
  if (before) { condition = 'AND m.id < ?'; paramsList.push(integer(before, 'before')); }
  const items = (await db.all(
    `SELECT m.*,u.username,u.full_name FROM messages m JOIN users u ON u.id=m.user_id
     WHERE m.channel_id=? ${condition} ORDER BY m.id DESC LIMIT 100`,
    paramsList
  )).reverse();
  jsonResponse(res, 200, items);
});

route('GET', '/api/channels/:channelId/messages/stream', async ({ req, res, params, user }) => {
  const channelId = integer(params.channelId, 'channel id');
  await channelWithAccess(user.id, channelId);
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  addChannelStreamClient(channelId, res);
  req.on('close', () => removeChannelStreamClient(channelId, res));
});

route('POST', '/api/channels/:channelId/messages', async ({ res, user, params, body }) => {
  const channelId = integer(params.channelId, 'channel id');
  const { channel } = await channelWithAccess(user.id, channelId);
  const message = requiredString(body.body, 'Message', 1, 4000);
  const result = await db.run('INSERT INTO messages(channel_id,user_id,body,created_at) VALUES(?,?,?,?)', [channelId, user.id, message, db.utcnow()]);
  await audit(channel.organization_id, null, user.id, 'message', result.lastInsertRowid, 'created', { channel_id: channelId });
  const mentionedUsernames = [...new Set([...message.matchAll(/@([a-z0-9._-]{3,40})/gi)].map(match => match[1].toLowerCase()))];
  for (const username of mentionedUsernames) {
    const mentioned = await db.get(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.username=? AND m.organization_id=? AND m.status='active'`, [username, channel.organization_id]);
    if (mentioned && Number(mentioned.id) !== Number(user.id)) await notifyUser(mentioned.id, 'mention', `${user.full_name} mentioned you`, `#${channel.name}: ${message.slice(0, 180)}`, channel.organization_id, 'chat');
  }
  const created = await db.get('SELECT m.*,u.username,u.full_name FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?', [result.lastInsertRowid]);
  broadcastToChannel(channelId, created);
  jsonResponse(res, 201, created);
});

async function getProject(projectId) {
  const project = await db.get('SELECT * FROM projects WHERE id=?', [projectId]);
  if (!project) throw new HttpError(404, 'Project not found');
  project.team_members = await activeOrganizationMembers(project.organization_id);
  project.sources = await db.all('SELECT * FROM source_records WHERE project_id=? ORDER BY created_at DESC', [projectId]);
  return project;
}

async function taskDetail(taskId) {
  const task = await db.get(
    `SELECT t.*,u.full_name owner_name,u.username owner_username,tm.name team_name,lead.id team_manager_id,lead.full_name team_manager_name,s.team_id story_team_id
     FROM tasks t LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN teams tm ON tm.id=t.team_id LEFT JOIN users lead ON lead.id=tm.lead_user_id
     LEFT JOIN stories s ON s.id=t.story_id
     WHERE t.id=?`,
    [taskId]
  );
  if (!task) throw new HttpError(404, 'Task not found');
  task.dependencies = (await db.all('SELECT depends_on_task_id FROM dependencies WHERE task_id=?', [taskId])).map(item => Number(item.depends_on_task_id));
  return task;
}

const DEFAULT_BOARD_COLUMNS = [
  { name: 'Not Started', maps_to_status: 'not_started', color: '' },
  { name: 'In Progress', maps_to_status: 'in_progress', color: '' },
  { name: 'Blocked', maps_to_status: 'blocked', color: '' },
  { name: 'Done', maps_to_status: 'done', color: '' }
];

async function ensureBoardColumns(projectId) {
  let columns = await db.all('SELECT * FROM board_columns WHERE project_id=? ORDER BY position,id', [projectId]);
  if (!columns.length) {
    const now = db.utcnow();
    for (let index = 0; index < DEFAULT_BOARD_COLUMNS.length; index += 1) {
      const preset = DEFAULT_BOARD_COLUMNS[index];
      await db.run('INSERT INTO board_columns(project_id,name,color,maps_to_status,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [projectId, preset.name, preset.color, preset.maps_to_status, index, now, now]);
    }
    columns = await db.all('SELECT * FROM board_columns WHERE project_id=? ORDER BY position,id', [projectId]);
  }
  const orphanTasks = await db.all('SELECT id, status FROM tasks WHERE project_id=? AND column_id IS NULL AND rejected=0 ORDER BY id', [projectId]);
  if (orphanTasks.length) {
    const byStatus = new Map(columns.map(column => [column.maps_to_status, column]));
    const nextPosition = new Map();
    for (const column of columns) {
      const maxRow = await db.get('SELECT COALESCE(MAX(board_position),-1) AS maxPos FROM tasks WHERE column_id=?', [column.id]);
      nextPosition.set(column.id, Number(maxRow.maxPos) + 1);
    }
    for (const task of orphanTasks) {
      const column = byStatus.get(task.status) || columns[0];
      const position = nextPosition.get(column.id) ?? 0;
      nextPosition.set(column.id, position + 1);
      await db.run('UPDATE tasks SET column_id=?, board_position=? WHERE id=?', [column.id, position, task.id]);
    }
  }
  return columns;
}

async function createPlan(projectId, actorUserId, brief = '', replaceUnapproved = false) {
  const project = await getProject(projectId);
  if (replaceUnapproved) await db.run('DELETE FROM tasks WHERE project_id=? AND ai_generated=1 AND approved=0', [projectId]);
  let sourceBrief = cleanString(brief, 20000);
  if (!sourceBrief) {
    const source = await db.get("SELECT content FROM source_records WHERE project_id=? AND record_type='project_brief' ORDER BY id DESC LIMIT 1", [projectId]);
    sourceBrief = source?.content || '';
  }
  if (sourceBrief) await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [projectId, 'plan_input', sourceBrief, actorUserId, db.utcnow()]);
  const members = await activeOrganizationMembers(project.organization_id);
  const aiResult = await ai.generatePlan(project, members, sourceBrief);
  const proposals = aiResult.items;
  const created = await db.transaction(async () => {
    const ids = [];
    for (const proposal of proposals) {
      const inserted = await db.run(
        `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [projectId, proposal.phase, proposal.title, proposal.description, proposal.owner_id, proposal.priority, proposal.status, proposal.progress, proposal.acceptance_criteria, proposal.due_date, 'ai_plan', 1, 0, 0, actorUserId, db.utcnow(), db.utcnow()]
      );
      ids.push(inserted.lastInsertRowid);
    }
    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index];
      for (const dependencyIndex of proposal.depends_on_proposal_indexes || []) {
        if (ids[dependencyIndex] && ids[dependencyIndex] !== ids[index]) {
          await db.run('INSERT OR IGNORE INTO dependencies(task_id,depends_on_task_id) VALUES(?,?)', [ids[index], ids[dependencyIndex]]);
        }
      }
    }
    return ids;
  });
  await audit(project.organization_id, projectId, actorUserId, 'project', projectId, 'ai_plan_generated', { created_task_ids: created, provider: aiResult.provider, fallback: aiResult.fallback });
  return { ids: created, aiResult };
}

async function projectReport(projectId) {
  const project = await getProject(projectId);
  const tasks = await db.all(
    `SELECT t.*,u.full_name owner_name FROM tasks t LEFT JOIN users u ON u.id=t.owner_id
     WHERE t.project_id=? AND t.rejected=0 ORDER BY t.id`,
    [projectId]
  );
  const blockers = tasks.filter(task => task.status === 'blocked');
  const approvedTasks = tasks.filter(task => Number(task.approved) === 1);
  const complete = approvedTasks.filter(task => task.status === 'done');
  const overall = approvedTasks.length ? Math.round(approvedTasks.reduce((sum, task) => sum + Number(task.progress), 0) / approvedTasks.length) : 0;
  return {
    generated_at: db.utcnow(),
    project: { id: project.id, name: project.name, objective: project.objective, scope: project.scope, status: project.status },
    overall_progress_percent: overall,
    approved_task_count: approvedTasks.length,
    completed_task_count: complete.length,
    blockers,
    open_risks: await db.all("SELECT * FROM risks WHERE project_id=? AND status='open' ORDER BY severity DESC,id DESC", [projectId]),
    approved_decisions: await db.all("SELECT * FROM decisions WHERE project_id=? AND status='approved' ORDER BY created_at DESC", [projectId]),
    pending_changes: await db.all("SELECT * FROM changes WHERE project_id=? AND status='pending' ORDER BY created_at DESC", [projectId]),
    recent_updates: await db.all('SELECT * FROM updates WHERE project_id=? ORDER BY created_at DESC LIMIT 20', [projectId]),
    reliability_note: 'Progress, completion, blockers, decisions, and changes are assembled from stored records. AI-generated items remain unapproved until an authorized human reviews them.'
  };
}

async function listProjectsForOrganization(userId, organizationId) {
  const member = await requireMembership(userId, organizationId);
  const scope = await resolveAccessScope(userId, organizationId, member);
  const projects = await db.all(
    `SELECT p.*,u.full_name created_by_name,o.full_name owner_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.rejected=0) task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.rejected=0 AND t.status='done') done_task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.rejected=0 AND t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date<date('now')) overdue_task_count,
      (SELECT COUNT(*) FROM risks r WHERE r.project_id=p.id AND r.status='open') open_risk_count
     FROM projects p JOIN users u ON u.id=p.created_by
     LEFT JOIN users o ON o.id=p.owner_id
     WHERE p.organization_id=? ORDER BY p.updated_at DESC`,
    [organizationId]
  );
  return await scopeProjectList(scope, projects);
}

route('GET', '/api/projects', async ({ res, user, query }) => {
  const organizationId = integer(query.get('organization_id'), 'organization_id');
  jsonResponse(res, 200, await listProjectsForOrganization(user.id, organizationId));
});

route('GET', '/api/organizations/:organizationId/projects', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  jsonResponse(res, 200, await listProjectsForOrganization(user.id, organizationId));
});

const PROJECT_PRIORITIES = ['low', 'medium', 'high', 'critical'];

async function handleCreateProject({ res, user, body, organizationId }) {
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const name = requiredString(body.name, 'Project name', 2, 160);
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : user.id;
  if (ownerId !== user.id && !await membership(ownerId, organizationId, true)) throw new HttpError(400, 'Project owner must be an active organization member');
  const priority = PROJECT_PRIORITIES.includes(body.priority) ? body.priority : 'medium';
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO projects(organization_id,name,objective,scope,constraints,assumptions,status,owner_id,priority,start_date,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [organizationId, name, cleanString(body.objective), cleanString(body.scope), cleanString(body.constraints), cleanString(body.assumptions), 'active', ownerId, priority, cleanString(body.start_date, 10) || null, cleanString(body.due_date, 10) || null, user.id, now, now]
  );
  const brief = cleanString(body.brief, 20000);
  if (brief) await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [result.lastInsertRowid, 'project_brief', brief, user.id, now]);
  await audit(organizationId, result.lastInsertRowid, user.id, 'project', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await getProject(result.lastInsertRowid));
}

route('POST', '/api/projects', async context => {
  const organizationId = integer(context.body.organization_id, 'organization_id');
  await handleCreateProject({ ...context, organizationId });
});

route('POST', '/api/organizations/:organizationId/projects', async context => {
  const organizationId = integer(context.params.organizationId, 'organization id');
  await handleCreateProject({ ...context, organizationId });
});

route('GET', '/api/projects/:projectId', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  jsonResponse(res, 200, await getProject(projectId));
});

route('PATCH', '/api/projects/:projectId', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const allowed = {
    name: value => requiredString(value, 'Project name', 2, 160),
    objective: value => cleanString(value),
    scope: value => cleanString(value),
    constraints: value => cleanString(value),
    assumptions: value => cleanString(value),
    status: value => { if (!['active', 'on_hold', 'completed', 'archived'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    priority: value => { if (!PROJECT_PRIORITIES.includes(value)) throw new HttpError(400, 'Invalid priority'); return value; },
    start_date: value => cleanString(value, 10) || null,
    due_date: value => cleanString(value, 10) || null,
    health_override: value => { if (value && !['healthy', 'at_risk', 'critical'].includes(value)) throw new HttpError(400, 'Invalid health override'); return value || null; },
    owner_id: value => value ? integer(value, 'owner_id') : null
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'owner_id' && value && !await membership(value, project.organization_id, true)) throw new HttpError(400, 'Project owner must be an active organization member');
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), projectId);
    await db.run(`UPDATE projects SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(project.organization_id, projectId, user.id, 'project', projectId, 'updated', body);
  jsonResponse(res, 200, await getProject(projectId));
});

route('POST', '/api/projects/:projectId/generate-plan', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const result = await createPlan(projectId, user.id, body.brief || '', Boolean(body.replace_unapproved));
  jsonResponse(res, 201, { created_task_ids: result.ids, ai_provider: result.aiResult.provider, fallback_used: result.aiResult.fallback, warning: result.aiResult.warning || null, message: 'AI proposals created. Review and approve or edit them.' });
});

const BRIEF_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const BRIEF_ALLOWED_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'pdf', 'docx']);

async function extractBriefText(filename, buffer) {
  const extension = (String(filename || '').split('.').pop() || '').toLowerCase();
  if (!BRIEF_ALLOWED_EXTENSIONS.has(extension)) throw new HttpError(400, `Unsupported file type: .${extension || 'unknown'}. Upload a .txt, .md, .pdf, or .docx file.`);
  if (extension === 'txt' || extension === 'md' || extension === 'markdown') return buffer.toString('utf8');
  if (extension === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

const briefProgressStreamClients = new Map();

function addBriefProgressStreamClient(token, response) {
  if (!briefProgressStreamClients.has(token)) briefProgressStreamClients.set(token, new Set());
  briefProgressStreamClients.get(token).add(response);
}

function removeBriefProgressStreamClient(token, response) {
  const clients = briefProgressStreamClients.get(token);
  if (!clients) return;
  clients.delete(response);
  if (!clients.size) briefProgressStreamClients.delete(token);
}

function broadcastBriefProgress(token, payload) {
  const clients = briefProgressStreamClients.get(token);
  if (!clients || !clients.size) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const response of clients) {
    if (!response.writableEnded) response.write(frame);
  }
}

setInterval(() => {
  for (const clients of briefProgressStreamClients.values()) {
    for (const response of clients) {
      if (!response.writableEnded) response.write(': ping\n\n');
    }
  }
}, 25_000).unref();

route('GET', '/api/brief-analysis/progress', async ({ req, res, user, query }) => {
  const token = cleanString(query.get('token'), 80);
  if (!token) throw new HttpError(400, 'A progress token is required');
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  addBriefProgressStreamClient(token, res);
  req.on('close', () => removeBriefProgressStreamClient(token, res));
});

route('POST', '/api/projects/:projectId/brief-analysis/upload', async ({ req, res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(415, 'Content-Type must be multipart/form-data');
  const upload = await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    let busboyInstance;
    try {
      busboyInstance = Busboy({ headers: req.headers, limits: { files: 1, fileSize: BRIEF_UPLOAD_MAX_BYTES } });
    } catch (error) {
      return settle(new HttpError(400, 'Invalid upload request'));
    }
    let found = null;
    let truncated = false;
    busboyInstance.on('file', (fieldname, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => { size += chunk.length; if (size <= BRIEF_UPLOAD_MAX_BYTES) chunks.push(chunk); });
      stream.on('limit', () => { truncated = true; });
      stream.on('close', () => { if (!found) found = { filename: info.filename, buffer: Buffer.concat(chunks) }; });
    });
    busboyInstance.on('close', () => {
      if (truncated) return settle(new HttpError(400, `File exceeds the ${Math.round(BRIEF_UPLOAD_MAX_BYTES / (1024 * 1024))}MB limit`));
      if (!found || !found.buffer.length) return settle(new HttpError(400, 'No file was uploaded'));
      settle(null, found);
    });
    busboyInstance.on('error', error => settle(error));
    req.pipe(busboyInstance);
  });
  const text = await extractBriefText(upload.filename, upload.buffer);
  const cleanedText = String(text || '').trim();
  if (!cleanedText) throw new HttpError(400, 'No readable text was found in that file');
  jsonResponse(res, 200, { filename: upload.filename, text: cleanedText.slice(0, 100000) });
}, { rawBody: true });

route('POST', '/api/projects/:projectId/brief-analysis', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const rawText = requiredString(body.raw_text, 'Brief text', 10, 100000);
  const sourceType = body.source_type === 'upload' ? 'upload' : 'paste';
  const streamToken = cleanString(body.stream_token, 80);
  const onProgress = streamToken ? (step, detail) => broadcastBriefProgress(streamToken, { step, detail }) : undefined;
  const members = await activeOrganizationMembers(project.organization_id);
  const teams = await activeOrganizationTeams(project.organization_id);
  const analysis = await ai.analyzeProjectBrief(project, members, rawText, onProgress, teams);
  if (streamToken) broadcastBriefProgress(streamToken, { step: 'done', detail: 'Analysis complete' });
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO ai_brief_sessions(project_id,organization_id,client_name,project_name,source_type,source_filename,raw_text,status,generated_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [projectId, project.organization_id, project.client_name || '', project.name, sourceType, cleanString(body.source_filename, 255), rawText, 'ready_for_review', JSON.stringify(analysis.item), user.id, now]
  );
  await audit(project.organization_id, projectId, user.id, 'ai_brief_session', result.lastInsertRowid, 'generated', { provider: analysis.provider, fallback: analysis.fallback });
  jsonResponse(res, 201, { session_id: result.lastInsertRowid, plan: analysis.item, project_fields: analysis.project || null, ai_provider: analysis.provider, fallback_used: analysis.fallback, warning: analysis.warning || null });
});

route('POST', '/api/brief-sessions/:sessionId/commit', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT * FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Brief analysis session not found');
  if (session.status !== 'ready_for_review') throw new HttpError(409, 'This brief analysis is not ready to be created into a project (it may already be converted, or analysis has not completed).');
  const { project: accessProject } = await briefSessionAccess(user.id, session, ['ceo', 'admin', 'moderator']);
  const plan = body.plan && typeof body.plan === 'object' ? body.plan : {};
  const now = db.utcnow();

  // Resolved fresh at commit time against real organization teams — never trust a client-submitted
  // team name blindly, and never fabricate a team that doesn't exist (only exact matches route work).
  const orgTeams = await activeOrganizationTeams(session.organization_id);
  const teamByLowerName = new Map(orgTeams.map(team => [String(team.name).toLowerCase(), team]));
  const teamById = new Map(orgTeams.map(team => [Number(team.id), team]));
  const resolveTeam = name => {
    const clean = cleanString(name, 120);
    return clean ? teamByLowerName.get(clean.toLowerCase()) || null : null;
  };
  const validTeamConfidence = value => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : null;
  };

  const summary = await db.transaction(async () => {
    let project = accessProject;
    let createdProjectId = null;
    if (!session.project_id) {
      const projectName = cleanString(body.project_name, 160) || cleanString(session.project_name, 160) || 'Untitled project';
      const clientName = cleanString(body.client_name, 160) || cleanString(session.client_name, 160);
      const projectOwnerId = body.owner_id ? integer(body.owner_id, 'owner_id') : user.id;
      const validOwnerId = projectOwnerId === user.id || await membership(projectOwnerId, session.organization_id, true) ? projectOwnerId : user.id;
      const projectPriority = PROJECT_PRIORITIES.includes(body.priority) ? body.priority : 'medium';
      const projectResult = await db.run(
        'INSERT INTO projects(organization_id,name,client_name,objective,scope,constraints,assumptions,status,owner_id,priority,start_date,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [session.organization_id, projectName, clientName, cleanString(body.objective), cleanString(body.scope), cleanString(body.constraints), '', 'active', validOwnerId, projectPriority, cleanString(body.start_date, 10) || null, cleanString(body.due_date, 10) || null, user.id, now, now]
      );
      createdProjectId = projectResult.lastInsertRowid;
      project = await db.get('SELECT * FROM projects WHERE id=?', [createdProjectId]);
      await audit(session.organization_id, createdProjectId, user.id, 'project', createdProjectId, 'created', { name: projectName, source: 'client_brief' });
    }
    const departmentIdByName = new Map();
    const resolveDepartment = async name => {
      const clean = cleanString(name, 120);
      if (!clean) return null;
      const key = clean.toLowerCase();
      if (departmentIdByName.has(key)) return departmentIdByName.get(key);
      await db.run('INSERT OR IGNORE INTO departments(organization_id,name,created_at,updated_at) VALUES(?,?,?,?)', [project.organization_id, clean, now, now]);
      const row = await db.get('SELECT id FROM departments WHERE organization_id=? AND name=? COLLATE NOCASE', [project.organization_id, clean]);
      departmentIdByName.set(key, row?.id || null);
      return row?.id || null;
    };

    let departmentCount = 0;
    for (const item of Array.isArray(plan.departments) ? plan.departments : []) {
      const name = cleanString(item?.name, 120);
      if (!name) continue;
      const id = await resolveDepartment(name);
      if (id) departmentCount += 1;
    }

    let milestoneCount = 0;
    for (const item of Array.isArray(plan.milestones) ? plan.milestones : []) {
      const name = cleanString(item?.name, 160);
      if (!name) continue;
      await db.run('INSERT INTO milestones(project_id,name,description,due_date,owner_id,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [project.id, name, `Generated from project brief analysis. ${cleanString(item?.source_note, 500)}`.trim(), /^\d{4}-\d{2}-\d{2}$/.test(cleanString(item?.due_date, 10)) ? item.due_date : null, null, 'planned', user.id, now, now]);
      milestoneCount += 1;
    }

    let riskCount = 0;
    for (const item of Array.isArray(plan.risks) ? plan.risks : []) {
      const title = cleanString(item?.title, 220);
      if (!title) continue;
      await db.run('INSERT INTO risks(project_id,risk_type,severity,title,description,evidence,status,ai_generated,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [project.id, 'brief_analysis', ['low', 'medium', 'high', 'critical'].includes(item?.severity) ? item.severity : 'medium', title, cleanString(item?.description, 4000), cleanString(item?.source_note, 1000), 'open', 1, 0, now, now]);
      riskCount += 1;
    }

    let assumptionCount = 0;
    const assumptionTexts = (Array.isArray(plan.assumptions) ? plan.assumptions : []).map(item => cleanString(item?.text, 500)).filter(Boolean);
    if (assumptionTexts.length) {
      const existingProject = await db.get('SELECT assumptions FROM projects WHERE id=?', [project.id]);
      const merged = [cleanString(existingProject?.assumptions, 20000), ...assumptionTexts.map(text => `- ${text} (from brief analysis)`)].filter(Boolean).join('\n');
      await db.run('UPDATE projects SET assumptions=?,updated_at=? WHERE id=?', [merged.slice(0, 20000), now, project.id]);
      assumptionCount = assumptionTexts.length;
    }

    const resolveOwner = async value => {
      const ownerId = value ? Number(value) : null;
      if (!ownerId || !Number.isInteger(ownerId)) return null;
      return (await membership(ownerId, project.organization_id, true)) ? ownerId : null;
    };
    const validStoryStatus = value => ['not_started', 'in_progress', 'at_risk', 'done'].includes(value) ? value : 'not_started';
    const validTaskStatus = value => ['not_started', 'in_progress', 'blocked', 'done'].includes(value) ? value : 'not_started';
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(cleanString(value, 10)) ? value : null;
    const cleanTags = value => Array.isArray(value) ? value.map(tag => cleanString(tag, 40)).filter(Boolean).slice(0, 8).join(',') : '';
    const cleanHours = value => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

    let storyCount = 0, taskCount = 0, subtaskCount = 0;
    let unassignedTaskCount = 0;
    const teamBreakdownMap = new Map();
    const workersToNotify = [];
    const recordTeamWork = (team, isSubtask) => {
      if (!team) { unassignedTaskCount += 1; return; }
      if (!teamBreakdownMap.has(team.id)) teamBreakdownMap.set(team.id, { team_id: Number(team.id), team_name: team.name, task_count: 0, subtask_count: 0 });
      const entry = teamBreakdownMap.get(team.id);
      if (isSubtask) entry.subtask_count += 1; else entry.task_count += 1;
    };

    const maxPositionRow = await db.get('SELECT COALESCE(MAX(position),-1) AS maxPos FROM stories WHERE project_id=?', [project.id]);
    let nextPosition = Number(maxPositionRow.maxPos) + 1;
    for (const storyItem of Array.isArray(plan.stories) ? plan.stories : []) {
      const storyName = cleanString(storyItem?.name, 160);
      if (!storyName) continue;
      const departmentId = await resolveDepartment(storyItem?.department);
      const storyOwnerId = await resolveOwner(storyItem?.owner_id);
      const storyTeam = resolveTeam(storyItem?.team_name);
      const storyResult = await db.run(
        'INSERT INTO stories(project_id,name,description,owner_id,department_id,priority,status,start_date,due_date,position,team_id,ai_team_confidence,ai_team_reason,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [project.id, storyName, cleanString(storyItem?.description, 4000), storyOwnerId, departmentId, ['low', 'medium', 'high', 'critical'].includes(storyItem?.priority) ? storyItem.priority : 'medium', validStoryStatus(storyItem?.status), validDate(storyItem?.start_date), validDate(storyItem?.due_date), nextPosition, storyTeam?.id || null, storyTeam ? validTeamConfidence(storyItem?.team_confidence) : null, storyTeam ? cleanString(storyItem?.team_reason, 500) : '', user.id, now, now]
      );
      nextPosition += 1;
      storyCount += 1;
      for (const taskItem of Array.isArray(storyItem?.tasks) ? storyItem.tasks : []) {
        const taskTitle = cleanString(taskItem?.title, 220);
        if (!taskTitle) continue;
        const taskOwnerId = await resolveOwner(taskItem?.owner_id);
        const taskTeamOverride = resolveTeam(taskItem?.team_name);
        const taskTeam = taskTeamOverride || storyTeam;
        const taskResult = await db.run(
          `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,story_id,tags,estimated_hours,source_type,ai_generated,approved,rejected,team_id,ai_team_confidence,ai_team_reason,created_by,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [project.id, storyName.slice(0, 120), taskTitle, cleanString(taskItem?.description, 4000), taskOwnerId, ['low', 'medium', 'high', 'critical'].includes(taskItem?.priority) ? taskItem.priority : 'medium', validTaskStatus(taskItem?.status), 0, '', validDate(taskItem?.due_date), storyResult.lastInsertRowid, cleanTags(taskItem?.tags), cleanHours(taskItem?.estimated_hours), 'ai_brief', 1, 0, 0, taskTeam?.id || null, taskTeamOverride ? validTeamConfidence(taskItem?.team_confidence) : null, taskTeamOverride ? cleanString(taskItem?.team_reason, 500) : '', user.id, now, now]
        );
        taskCount += 1;
        recordTeamWork(taskTeam, false);
        if (taskOwnerId) workersToNotify.push({ taskId: taskResult.lastInsertRowid, taskTitle, ownerId: taskOwnerId });
        for (const subtaskItem of Array.isArray(taskItem?.subtasks) ? taskItem.subtasks : []) {
          const subtaskTitle = cleanString(subtaskItem?.title, 220);
          if (!subtaskTitle) continue;
          const subtaskOwnerId = await resolveOwner(subtaskItem?.owner_id);
          const subtaskTeamOverride = resolveTeam(subtaskItem?.team_name);
          const subtaskTeam = subtaskTeamOverride || taskTeam;
          const subtaskResult = await db.run(
            `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,story_id,parent_task_id,tags,estimated_hours,source_type,ai_generated,approved,rejected,team_id,ai_team_confidence,ai_team_reason,created_by,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [project.id, storyName.slice(0, 120), subtaskTitle, cleanString(subtaskItem?.description, 4000), subtaskOwnerId, ['low', 'medium', 'high', 'critical'].includes(subtaskItem?.priority) ? subtaskItem.priority : 'medium', validTaskStatus(subtaskItem?.status), 0, '', validDate(subtaskItem?.due_date), storyResult.lastInsertRowid, taskResult.lastInsertRowid, cleanTags(subtaskItem?.tags), cleanHours(subtaskItem?.estimated_hours), 'ai_brief', 1, 0, 0, subtaskTeam?.id || null, subtaskTeamOverride ? validTeamConfidence(subtaskItem?.team_confidence) : null, subtaskTeamOverride ? cleanString(subtaskItem?.team_reason, 500) : '', user.id, now, now]
          );
          subtaskCount += 1;
          recordTeamWork(subtaskTeam, true);
          if (subtaskOwnerId) workersToNotify.push({ taskId: subtaskResult.lastInsertRowid, taskTitle: subtaskTitle, ownerId: subtaskOwnerId });
        }
      }
    }

    await db.run("UPDATE ai_brief_sessions SET status='converted',project_id=? WHERE id=?", [project.id, sessionId]);
    return {
      departmentCount, milestoneCount, riskCount, assumptionCount, storyCount, taskCount, subtaskCount,
      unassignedTaskCount, teamBreakdown: [...teamBreakdownMap.values()], workersToNotify,
      projectId: project.id, projectName: project.name, organizationId: project.organization_id
    };
  });

  const teamsNotified = [];
  const teamsWithoutManager = [];
  for (const entry of summary.teamBreakdown) {
    const team = teamById.get(entry.team_id);
    const leadUserId = team?.lead_user_id ? Number(team.lead_user_id) : null;
    if (leadUserId) {
      const taskWord = entry.task_count === 1 ? 'task' : 'tasks';
      const subtaskWord = entry.subtask_count === 1 ? 'subtask' : 'subtasks';
      await notifyUser(
        leadUserId, 'team_work', 'New work for your team',
        `${entry.task_count} ${taskWord} and ${entry.subtask_count} ${subtaskWord} from "${summary.projectName}" need review.`,
        summary.organizationId, `teams:${entry.team_id}`
      );
      await activity(leadUserId, 'team_work_assigned', 'New team work assigned', `${entry.team_name}: ${entry.task_count} tasks, ${entry.subtask_count} subtasks from "${summary.projectName}"`, summary.organizationId);
      teamsNotified.push({ team_id: entry.team_id, team_name: entry.team_name, manager_id: leadUserId });
    } else {
      teamsWithoutManager.push({ team_id: entry.team_id, team_name: entry.team_name });
    }
  }

  for (const worker of summary.workersToNotify) {
    if (Number(worker.ownerId) === Number(user.id)) continue;
    await notifyUser(worker.ownerId, 'task_assignment', 'New task assigned to you', `"${worker.taskTitle}" was assigned to you.`, summary.organizationId, `work:${worker.taskId}`);
    await activity(worker.ownerId, 'task_assigned', 'New task assigned to you', worker.taskTitle, summary.organizationId);
    await audit(summary.organizationId, summary.projectId, user.id, 'task', worker.taskId, 'assigned', { previous_owner_id: null, new_owner_id: worker.ownerId });
  }

  const { workersToNotify: _workersToNotify, ...summaryForResponse } = summary;
  await audit(summary.organizationId, summary.projectId, user.id, 'ai_brief_session', sessionId, 'converted', summaryForResponse);
  jsonResponse(res, 200, {
    committed: true, project_id: summary.projectId, ...summaryForResponse,
    teams_notified: teamsNotified, teams_without_manager: teamsWithoutManager,
    team_breakdown: summary.teamBreakdown, unassigned_task_count: summary.unassignedTaskCount
  });
});

route('POST', '/api/brief-sessions/:sessionId/regenerate', async ({ res, user, params }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT * FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Brief analysis session not found');
  if (session.status !== 'ready_for_review') throw new HttpError(409, 'This brief analysis is not ready to be regenerated (it may already be converted, or analysis has not completed).');
  const { project } = await briefSessionAccess(user.id, session, ['ceo', 'admin', 'moderator']);
  const members = await activeOrganizationMembers(project.organization_id);
  const teams = await activeOrganizationTeams(project.organization_id);
  const analysis = await ai.analyzeProjectBrief(project, members, session.raw_text, undefined, teams);
  await db.run("UPDATE ai_brief_sessions SET status='discarded' WHERE id=?", [sessionId]);
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO ai_brief_sessions(project_id,organization_id,client_name,project_name,source_type,source_filename,file_mime,file_size,original_file,raw_text,status,generated_json,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [session.project_id, session.organization_id, session.client_name, session.project_name, session.source_type, session.source_filename, session.file_mime, session.file_size, session.original_file, session.raw_text, 'ready_for_review', JSON.stringify(analysis.item), user.id, now]
  );
  jsonResponse(res, 201, { session_id: result.lastInsertRowid, plan: analysis.item, project_fields: analysis.project || null, ai_provider: analysis.provider, fallback_used: analysis.fallback, warning: analysis.warning || null });
});

async function briefSessionForScopedAction(userId, sessionId) {
  const session = await db.get('SELECT * FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Brief analysis session not found');
  if (session.status !== 'ready_for_review') throw new HttpError(409, 'This brief analysis is not ready to be edited (it may already be converted, or analysis has not completed).');
  const { project } = await briefSessionAccess(userId, session, ['ceo', 'admin', 'moderator']);
  const members = await activeOrganizationMembers(project.organization_id);
  const teams = await activeOrganizationTeams(project.organization_id);
  return { session, project, members, teams };
}

route('POST', '/api/brief-sessions/:sessionId/regenerate-story', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const { session, project, members, teams } = await briefSessionForScopedAction(user.id, sessionId);
  const story = body.story && typeof body.story === 'object' ? body.story : {};
  const storyName = requiredString(story.name, 'Story name', 1, 160);
  const result = await ai.regenerateBriefStory(project, members, session.raw_text, { name: storyName, description: cleanString(story.description, 4000) }, teams);
  jsonResponse(res, 200, { tasks: result.tasks, ai_provider: result.provider, fallback_used: result.fallback, warning: result.warning || null });
});

route('POST', '/api/brief-sessions/:sessionId/regenerate-task', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const { session, project, members, teams } = await briefSessionForScopedAction(user.id, sessionId);
  const task = body.task && typeof body.task === 'object' ? body.task : {};
  const taskTitle = requiredString(task.title, 'Task title', 1, 220);
  const result = await ai.regenerateBriefTask(project, members, session.raw_text, { title: taskTitle, description: cleanString(task.description, 4000) }, teams);
  jsonResponse(res, 200, { subtasks: result.subtasks, ai_provider: result.provider, fallback_used: result.fallback, warning: result.warning || null });
});

route('POST', '/api/brief-sessions/:sessionId/ai-edit', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const { session, project, members, teams } = await briefSessionForScopedAction(user.id, sessionId);
  const story = body.story && typeof body.story === 'object' ? body.story : {};
  const storyName = requiredString(story.name, 'Story name', 1, 160);
  const instruction = requiredString(body.instruction, 'Instruction', 3, 500);
  const item = { name: storyName, description: cleanString(story.description, 4000), tasks: Array.isArray(story.tasks) ? story.tasks : [] };
  const result = await ai.applyBriefEditCommand(project, members, session.raw_text, item, instruction, teams);
  jsonResponse(res, 200, { tasks: result.tasks, ai_provider: result.provider, fallback_used: result.fallback, warning: result.warning || null });
});

const CLIENT_BRIEF_MIME_BY_EXTENSION = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

function guessClientAndProjectName(text) {
  const sample = String(text || '').slice(0, 3000);
  const clientMatch = sample.match(/^[ \t]*(?:client|customer|prepared for)[ \t]*:[ \t]*(.+)$/im);
  const projectMatch = sample.match(/^[ \t]*project(?:[ \t]*name|[ \t]*title)?[ \t]*:[ \t]*(.+)$/im);
  return {
    clientName: clientMatch ? clientMatch[1].trim().slice(0, 160) : '',
    projectName: projectMatch ? projectMatch[1].trim().slice(0, 160) : ''
  };
}

route('POST', '/api/organizations/:organizationId/client-briefs', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const rawText = requiredString(body.raw_text, 'Brief text', 10, 100000);
  const guessed = guessClientAndProjectName(rawText);
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO ai_brief_sessions(project_id,organization_id,client_name,project_name,source_type,source_filename,file_mime,file_size,original_file,raw_text,status,generated_json,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [null, organizationId, guessed.clientName, guessed.projectName, 'paste', '', '', 0, null, rawText.slice(0, 100000), 'uploaded', '{}', user.id, now]
  );
  await audit(organizationId, null, user.id, 'ai_brief_session', result.lastInsertRowid, 'uploaded', { source: 'paste' });
  jsonResponse(res, 201, { session_id: result.lastInsertRowid, client_name: guessed.clientName, project_name: guessed.projectName });
});

route('POST', '/api/organizations/:organizationId/client-briefs/upload', async ({ req, res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(415, 'Content-Type must be multipart/form-data');
  const upload = await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    let busboyInstance;
    try {
      busboyInstance = Busboy({ headers: req.headers, limits: { files: 1, fileSize: BRIEF_UPLOAD_MAX_BYTES } });
    } catch (error) {
      return settle(new HttpError(400, 'Invalid upload request'));
    }
    let found = null;
    let truncated = false;
    busboyInstance.on('file', (fieldname, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => { size += chunk.length; if (size <= BRIEF_UPLOAD_MAX_BYTES) chunks.push(chunk); });
      stream.on('limit', () => { truncated = true; });
      stream.on('close', () => { if (!found) found = { filename: info.filename, buffer: Buffer.concat(chunks) }; });
    });
    busboyInstance.on('close', () => {
      if (truncated) return settle(new HttpError(400, `File exceeds the ${Math.round(BRIEF_UPLOAD_MAX_BYTES / (1024 * 1024))}MB limit`));
      if (!found || !found.buffer.length) return settle(new HttpError(400, 'No file was uploaded'));
      settle(null, found);
    });
    busboyInstance.on('error', error => settle(error));
    req.pipe(busboyInstance);
  });
  let cleanedText;
  try {
    const text = await extractBriefText(upload.filename, upload.buffer);
    cleanedText = String(text || '').trim();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Unable to read this client brief.');
  }
  if (!cleanedText) throw new HttpError(400, 'Unable to read this client brief.');
  const extension = (String(upload.filename || '').split('.').pop() || '').toLowerCase();
  const fileMime = CLIENT_BRIEF_MIME_BY_EXTENSION[extension] || 'application/octet-stream';
  const guessed = guessClientAndProjectName(cleanedText);
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO ai_brief_sessions(project_id,organization_id,client_name,project_name,source_type,source_filename,file_mime,file_size,original_file,raw_text,status,generated_json,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [null, organizationId, guessed.clientName, guessed.projectName, 'upload', upload.filename, fileMime, upload.buffer.length, upload.buffer, cleanedText.slice(0, 100000), 'uploaded', '{}', user.id, now]
  );
  await audit(organizationId, null, user.id, 'ai_brief_session', result.lastInsertRowid, 'uploaded', { filename: upload.filename });
  jsonResponse(res, 201, {
    session_id: result.lastInsertRowid, filename: upload.filename, file_mime: fileMime, file_size: upload.buffer.length,
    client_name: guessed.clientName, project_name: guessed.projectName
  });
}, { rawBody: true });

route('GET', '/api/organizations/:organizationId/client-briefs', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const sessions = await db.all(
    `SELECT s.id,s.project_id,s.client_name,s.project_name,s.source_type,s.source_filename,s.file_mime,s.file_size,s.status,s.created_at,
            u.full_name AS created_by_name, p.name AS generated_project_name
     FROM ai_brief_sessions s
     LEFT JOIN users u ON u.id = s.created_by
     LEFT JOIN projects p ON p.id = s.project_id
     WHERE s.organization_id=? AND s.status <> 'discarded'
     ORDER BY s.created_at DESC`,
    [organizationId]
  );
  jsonResponse(res, 200, sessions);
});

route('GET', '/api/client-briefs/:sessionId', async ({ res, user, params }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get(
    `SELECT s.id,s.project_id,s.organization_id,s.client_name,s.project_name,s.source_type,s.source_filename,s.file_mime,s.file_size,s.raw_text,s.status,s.generated_json,s.created_at,
            u.full_name AS created_by_name, p.name AS generated_project_name
     FROM ai_brief_sessions s LEFT JOIN users u ON u.id=s.created_by LEFT JOIN projects p ON p.id=s.project_id
     WHERE s.id=?`,
    [sessionId]
  );
  if (!session) throw new HttpError(404, 'Client brief not found');
  await requireMembership(user.id, Number(session.organization_id));
  const { generated_json, ...rest } = session;
  let plan = {};
  try { plan = JSON.parse(generated_json || '{}'); } catch { plan = {}; }
  jsonResponse(res, 200, { ...rest, plan });
});

route('POST', '/api/client-briefs/:sessionId/analyze', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT * FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Client brief not found');
  if (!['uploaded', 'failed'].includes(session.status)) throw new HttpError(409, 'This brief is not in a state that can be analyzed right now.');
  const { project } = await briefSessionAccess(user.id, session, ['ceo', 'admin', 'moderator']);
  const streamToken = cleanString(body.stream_token, 80);
  const onProgress = streamToken ? (step, detail) => broadcastBriefProgress(streamToken, { step, detail }) : undefined;
  const members = await activeOrganizationMembers(session.organization_id);
  const teams = await activeOrganizationTeams(session.organization_id);
  const clientName = body.client_name !== undefined ? cleanString(body.client_name, 160) : session.client_name;
  const projectName = body.project_name !== undefined ? cleanString(body.project_name, 160) : session.project_name;
  await db.run('UPDATE ai_brief_sessions SET status=?,client_name=?,project_name=? WHERE id=?', ['analyzing', clientName, projectName, sessionId]);
  try {
    const contextProject = { ...project, name: projectName || project.name };
    const analysis = await ai.analyzeProjectBrief(contextProject, members, session.raw_text, onProgress, teams);
    if (streamToken) broadcastBriefProgress(streamToken, { step: 'done', detail: 'Analysis complete' });
    await db.run("UPDATE ai_brief_sessions SET status='ready_for_review',generated_json=? WHERE id=?", [JSON.stringify(analysis.item), sessionId]);
    await audit(session.organization_id, session.project_id, user.id, 'ai_brief_session', sessionId, 'analyzed', { provider: analysis.provider, fallback: analysis.fallback });
    jsonResponse(res, 200, { session_id: sessionId, plan: analysis.item, project_fields: analysis.project || null, ai_provider: analysis.provider, fallback_used: analysis.fallback, warning: analysis.warning || null });
  } catch (error) {
    await db.run("UPDATE ai_brief_sessions SET status='failed' WHERE id=?", [sessionId]);
    if (streamToken) broadcastBriefProgress(streamToken, { step: 'failed', detail: 'Client brief was uploaded successfully, but analysis could not be completed.' });
    throw error;
  }
});

route('GET', '/api/client-briefs/:sessionId/download', async ({ res, user, params }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT organization_id,original_file,file_mime,source_filename FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Client brief not found');
  await requireMembership(user.id, Number(session.organization_id));
  if (!session.original_file) throw new HttpError(404, 'No original file was stored for this brief.');
  const buffer = Buffer.isBuffer(session.original_file) ? session.original_file : Buffer.from(session.original_file);
  const safeFilename = String(session.source_filename || 'client-brief').replace(/["\r\n]/g, '');
  textResponse(res, 200, buffer, session.file_mime || 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${safeFilename}"` });
});

route('DELETE', '/api/client-briefs/:sessionId', async ({ res, user, params }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT organization_id FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Client brief not found');
  await requireMembership(user.id, Number(session.organization_id), ['ceo', 'admin', 'moderator']);
  await db.run('DELETE FROM ai_brief_sessions WHERE id=?', [sessionId]);
  await audit(session.organization_id, null, user.id, 'ai_brief_session', sessionId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/projects/:projectId/tasks', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  const allTasks = await db.all(
    `SELECT t.*,u.full_name owner_name,u.username owner_username,tm.name team_name,lead.full_name team_manager_name,s.team_id story_team_id
     FROM tasks t LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN teams tm ON tm.id=t.team_id LEFT JOIN users lead ON lead.id=tm.lead_user_id
     LEFT JOIN stories s ON s.id=t.story_id
     WHERE t.project_id=? AND t.rejected=0 ORDER BY t.phase,t.id`,
    [projectId]
  );
  const tasks = scopeTaskList(scope, allTasks);
  const visibleIds = new Set(tasks.map(task => Number(task.id)));
  const dependencies = await db.all('SELECT d.* FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]);
  const byTask = new Map();
  for (const item of dependencies) {
    if (!visibleIds.has(Number(item.task_id)) || !visibleIds.has(Number(item.depends_on_task_id))) continue;
    const list = byTask.get(Number(item.task_id)) || [];
    list.push(Number(item.depends_on_task_id));
    byTask.set(Number(item.task_id), list);
  }
  tasks.forEach(task => { task.dependencies = byTask.get(Number(task.id)) || []; });
  jsonResponse(res, 200, tasks);
});

async function validateTaskLink(projectId, taskId, value, field) {
  if (!value) return null;
  const linked = integer(value, field);
  if (linked === taskId) throw new HttpError(400, `${field} cannot reference the task itself`);
  const row = await db.get('SELECT id FROM tasks WHERE id=? AND project_id=?', [linked, projectId]);
  if (!row) throw new HttpError(400, `${field} must reference a task in the same project`);
  return linked;
}

async function wouldCreateDependencyCycle(projectId, taskId, newDependsOn) {
  const rows = await db.all('SELECT d.task_id,d.depends_on_task_id FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]);
  const graph = new Map();
  for (const row of rows) {
    const list = graph.get(Number(row.task_id)) || [];
    list.push(Number(row.depends_on_task_id));
    graph.set(Number(row.task_id), list);
  }
  graph.set(taskId, newDependsOn.map(Number));
  const visiting = new Set();
  const visited = new Set();
  const hasCycle = node => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) || []) if (hasCycle(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return hasCycle(taskId);
}

route('POST', '/api/projects/:projectId/tasks', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project, scope } = await projectWithAccess(user.id, projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) throw new HttpError(403, 'You do not have permission to create tasks');
  const title = requiredString(body.title, 'Task title', 2, 220);
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
  const priority = ['low', 'medium', 'high', 'critical'].includes(body.priority) ? body.priority : 'medium';
  let status = ['not_started', 'in_progress', 'blocked', 'done'].includes(body.status) ? body.status : 'not_started';
  const progress = Math.min(100, Math.max(0, Number(body.progress || 0)));
  const columnId = body.column_id ? integer(body.column_id, 'column_id') : null;
  let boardPosition = 0;
  if (columnId) {
    const column = await db.get('SELECT * FROM board_columns WHERE id=? AND project_id=?', [columnId, projectId]);
    if (!column) throw new HttpError(400, 'column_id must reference a board column in the same project');
    status = column.maps_to_status;
    const maxPositionRow = await db.get('SELECT COALESCE(MAX(board_position),-1) AS maxPos FROM tasks WHERE column_id=?', [columnId]);
    boardPosition = Number(maxPositionRow.maxPos) + 1;
  }
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,start_date,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at,column_id,board_position)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [projectId, cleanString(body.phase, 120) || 'General', title, cleanString(body.description), ownerId, priority, status, progress, cleanString(body.acceptance_criteria), cleanString(body.due_date, 10) || null, cleanString(body.start_date, 10) || null, 'manual', 0, 1, 0, user.id, now, now, columnId, boardPosition]
  );
  const taskId = result.lastInsertRowid;
  const parentTaskId = await validateTaskLink(projectId, taskId, body.parent_task_id, 'parent_task_id');
  const milestoneId = body.milestone_id ? integer(body.milestone_id, 'milestone_id') : null;
  if (milestoneId && !await db.get('SELECT id FROM milestones WHERE id=? AND project_id=?', [milestoneId, projectId])) throw new HttpError(400, 'milestone_id must reference a milestone in the same project');
  const storyId = body.story_id ? integer(body.story_id, 'story_id') : null;
  if (storyId && !await db.get('SELECT id FROM stories WHERE id=? AND project_id=?', [storyId, projectId])) throw new HttpError(400, 'story_id must reference a story in the same project');
  const team = await validTeamId(body.team_id, project.organization_id);
  if (team && !scope.fullAccess && !scope.managedTeamIds.includes(Number(team.id))) throw new HttpError(403, 'You can only create tasks for a team you manage');
  if (ownerId && !scope.fullAccess && !scope.managedTeamUserIds.has(ownerId)) throw new HttpError(403, 'You can only assign tasks to a worker on your own team');
  if (parentTaskId !== null || milestoneId !== null || storyId !== null || team !== null) await db.run('UPDATE tasks SET parent_task_id=?,milestone_id=?,story_id=?,team_id=? WHERE id=?', [parentTaskId, milestoneId, storyId, team?.id || null, taskId]);
  const dependencyIds = [];
  for (const dependencyId of Array.isArray(body.dependencies) ? body.dependencies : []) {
    const dep = await validateTaskLink(projectId, taskId, dependencyId, 'dependency id');
    if (dep !== null) dependencyIds.push(dep);
  }
  if (dependencyIds.length) {
    for (const dep of dependencyIds) await db.run('INSERT OR IGNORE INTO dependencies(task_id,depends_on_task_id) VALUES(?,?)', [taskId, dep]);
  }
  await audit(project.organization_id, projectId, user.id, 'task', taskId, 'created', body);
  // A task created with an owner already set is an assignment, same as PATCH-ing owner_id later —
  // the new owner must be notified either way, not just when reassigned after the fact.
  if (ownerId) await recordTaskAssignment(project, taskId, user.id, null, ownerId);
  jsonResponse(res, 201, await taskDetail(taskId));
});

route('GET', '/api/tasks/:taskId', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { scope } = await projectWithAccess(user.id, Number(task.project_id));
  if (!taskInScope(scope, task)) throw new HttpError(403, 'You do not have access to this task');
  jsonResponse(res, 200, task);
});

route('GET', '/api/projects/:projectId/board-columns', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  jsonResponse(res, 200, await ensureBoardColumns(projectId));
});

route('POST', '/api/projects/:projectId/board-columns', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  await ensureBoardColumns(projectId);
  const name = requiredString(body.name, 'Column name', 1, 80);
  const mapsToStatus = ['not_started', 'in_progress', 'blocked', 'done'].includes(body.maps_to_status) ? body.maps_to_status : 'not_started';
  const color = cleanString(body.color, 30);
  const maxPositionRow = await db.get('SELECT COALESCE(MAX(position),-1) AS maxPos FROM board_columns WHERE project_id=?', [projectId]);
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO board_columns(project_id,name,color,maps_to_status,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    [projectId, name, color, mapsToStatus, Number(maxPositionRow.maxPos) + 1, now, now]
  );
  await audit(project.organization_id, projectId, user.id, 'board_column', result.lastInsertRowid, 'created', body);
  jsonResponse(res, 201, await db.get('SELECT * FROM board_columns WHERE id=?', [result.lastInsertRowid]));
});

route('PATCH', '/api/board-columns/:columnId', async ({ res, user, params, body }) => {
  const columnId = integer(params.columnId, 'column id');
  const column = await db.get('SELECT * FROM board_columns WHERE id=?', [columnId]);
  if (!column) throw new HttpError(404, 'Column not found');
  const { project } = await projectWithAccess(user.id, Number(column.project_id), ['ceo', 'admin', 'moderator']);
  const fields = [];
  const values = [];
  if (body.name !== undefined) { fields.push('name=?'); values.push(requiredString(body.name, 'Column name', 1, 80)); }
  if (body.color !== undefined) { fields.push('color=?'); values.push(cleanString(body.color, 30)); }
  if (body.position !== undefined) {
    const position = Number(body.position);
    if (!Number.isInteger(position) || position < 0) throw new HttpError(400, 'position must be a non-negative integer');
    fields.push('position=?'); values.push(position);
  }
  let newStatus = null;
  if (body.maps_to_status !== undefined) {
    if (!['not_started', 'in_progress', 'blocked', 'done'].includes(body.maps_to_status)) throw new HttpError(400, 'Invalid maps_to_status');
    newStatus = body.maps_to_status;
    fields.push('maps_to_status=?'); values.push(newStatus);
  }
  if (!fields.length) throw new HttpError(400, 'No changes supplied');
  fields.push('updated_at=?'); values.push(db.utcnow(), columnId);
  await db.run(`UPDATE board_columns SET ${fields.join(',')} WHERE id=?`, values);
  if (newStatus) await db.run('UPDATE tasks SET status=?, updated_at=? WHERE column_id=?', [newStatus, db.utcnow(), columnId]);
  await audit(project.organization_id, column.project_id, user.id, 'board_column', columnId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM board_columns WHERE id=?', [columnId]));
});

route('DELETE', '/api/board-columns/:columnId', async ({ res, user, params, body }) => {
  const columnId = integer(params.columnId, 'column id');
  const column = await db.get('SELECT * FROM board_columns WHERE id=?', [columnId]);
  if (!column) throw new HttpError(404, 'Column not found');
  const { project } = await projectWithAccess(user.id, Number(column.project_id), ['ceo', 'admin', 'moderator']);
  const remainingColumns = await db.get('SELECT COUNT(*) AS count FROM board_columns WHERE project_id=?', [column.project_id]);
  if (Number(remainingColumns.count) <= 1) throw new HttpError(400, 'A board must have at least one column');
  const taskCountRow = await db.get('SELECT COUNT(*) AS count FROM tasks WHERE column_id=? AND rejected=0', [columnId]);
  const taskCount = Number(taskCountRow.count);
  if (taskCount > 0) {
    const targetColumnId = body.move_tasks_to_column_id ? integer(body.move_tasks_to_column_id, 'move_tasks_to_column_id') : null;
    if (!targetColumnId) {
      jsonResponse(res, 409, {
        detail: `This column contains ${taskCount} task${taskCount === 1 ? '' : 's'}. Choose where to move them before deleting.`,
        code: 'COLUMN_HAS_TASKS',
        task_count: taskCount
      });
      return;
    }
    if (targetColumnId === columnId) throw new HttpError(400, 'Choose a different column to move tasks into');
    const targetColumn = await db.get('SELECT * FROM board_columns WHERE id=? AND project_id=?', [targetColumnId, column.project_id]);
    if (!targetColumn) throw new HttpError(400, 'move_tasks_to_column_id must reference a column in the same project');
    const maxPositionRow = await db.get('SELECT COALESCE(MAX(board_position),-1) AS maxPos FROM tasks WHERE column_id=?', [targetColumnId]);
    let nextPosition = Number(maxPositionRow.maxPos) + 1;
    const tasksToMove = await db.all('SELECT id FROM tasks WHERE column_id=? ORDER BY board_position,id', [columnId]);
    for (const task of tasksToMove) {
      await db.run('UPDATE tasks SET column_id=?, board_position=?, status=?, updated_at=? WHERE id=?', [targetColumnId, nextPosition, targetColumn.maps_to_status, db.utcnow(), task.id]);
      nextPosition += 1;
    }
  }
  await db.run('DELETE FROM board_columns WHERE id=?', [columnId]);
  await audit(project.organization_id, column.project_id, user.id, 'board_column', columnId, 'deleted', { moved_task_count: taskCount });
  jsonResponse(res, 200, { ok: true, moved_task_count: taskCount });
});

route('PATCH', '/api/tasks/:taskId', async ({ res, user, params, body }) => {
  const taskId = integer(params.taskId, 'task id');
  const existing = await taskDetail(taskId);
  const { project, member, scope } = await projectWithAccess(user.id, Number(existing.project_id));
  if (!taskInScope(scope, existing)) throw new HttpError(403, 'You do not have access to this task');
  if ((body.approved !== undefined || body.rejected !== undefined) && !['ceo', 'admin', 'moderator'].includes(member.role)) throw new HttpError(403, 'Only CEO, admin, or moderator can approve/reject AI work');
  let ownerChanged = false;
  let newOwnerId = existing.owner_id;
  if (body.owner_id !== undefined) {
    newOwnerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
    if (newOwnerId && !await membership(newOwnerId, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
    if (!await canAssignTask(existing, member, newOwnerId)) throw new HttpError(403, 'You do not have permission to assign this task.');
    ownerChanged = Number(newOwnerId || 0) !== Number(existing.owner_id || 0);
  }
  // A Worker who owns this task but doesn't manage its team may only move status/progress —
  // every other field (title, description, priority, dates, links, etc.) requires managing the
  // task's team or full-access. (owner_id/approved/rejected are already gated above/below.)
  if (!taskManagedByScope(scope, existing)) {
    const restrictedFields = Object.keys(body).filter(key => !['owner_id', 'approved', 'rejected'].includes(key) && !WORKER_SELF_EDIT_FIELDS.has(key));
    if (restrictedFields.length) throw new HttpError(403, `You can only update status and progress on your own tasks (not: ${restrictedFields.join(', ')})`);
  }
  const allowed = {
    phase: value => cleanString(value, 120) || 'General',
    title: value => requiredString(value, 'Task title', 2, 220),
    description: value => cleanString(value),
    owner_id: value => value ? integer(value, 'owner_id') : null,
    priority: value => { if (!['low', 'medium', 'high', 'critical'].includes(value)) throw new HttpError(400, 'Invalid priority'); return value; },
    status: value => { if (!['not_started', 'in_progress', 'blocked', 'done'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    progress: value => { const output = Number(value); if (!Number.isFinite(output) || output < 0 || output > 100) throw new HttpError(400, 'Progress must be between 0 and 100'); return Math.round(output); },
    acceptance_criteria: value => cleanString(value),
    due_date: value => cleanString(value, 10) || null,
    start_date: value => cleanString(value, 10) || null,
    approved: value => booleanInt(value),
    rejected: value => booleanInt(value)
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (body.team_id !== undefined) {
    if (!['ceo', 'admin', 'moderator'].includes(member.role)) throw new HttpError(403, 'Only CEO, admin, or moderator can change a task’s team');
    const team = await validTeamId(body.team_id, project.organization_id);
    fields.push('team_id=?'); values.push(team?.id || null);
  }
  if (body.parent_task_id !== undefined) {
    const parentTaskId = await validateTaskLink(Number(existing.project_id), taskId, body.parent_task_id, 'parent_task_id');
    fields.push('parent_task_id=?'); values.push(parentTaskId);
  }
  if (body.milestone_id !== undefined) {
    const milestoneId = body.milestone_id ? integer(body.milestone_id, 'milestone_id') : null;
    if (milestoneId && !await db.get('SELECT id FROM milestones WHERE id=? AND project_id=?', [milestoneId, existing.project_id])) throw new HttpError(400, 'milestone_id must reference a milestone in the same project');
    fields.push('milestone_id=?'); values.push(milestoneId);
  }
  if (body.story_id !== undefined) {
    const storyId = body.story_id ? integer(body.story_id, 'story_id') : null;
    if (storyId && !await db.get('SELECT id FROM stories WHERE id=? AND project_id=?', [storyId, existing.project_id])) throw new HttpError(400, 'story_id must reference a story in the same project');
    fields.push('story_id=?'); values.push(storyId);
  }
  if (body.column_id !== undefined) {
    const columnId = body.column_id ? integer(body.column_id, 'column_id') : null;
    let mapsToStatus = null;
    if (columnId) {
      const column = await db.get('SELECT id, maps_to_status FROM board_columns WHERE id=? AND project_id=?', [columnId, existing.project_id]);
      if (!column) throw new HttpError(400, 'column_id must reference a board column in the same project');
      mapsToStatus = column.maps_to_status;
    }
    fields.push('column_id=?'); values.push(columnId);
    if (mapsToStatus) {
      const statusIndex = fields.indexOf('status=?');
      if (statusIndex !== -1) { fields.splice(statusIndex, 1); values.splice(statusIndex, 1); }
      fields.push('status=?'); values.push(mapsToStatus);
    }
  }
  if (body.board_position !== undefined) {
    const boardPosition = Number(body.board_position);
    if (!Number.isFinite(boardPosition)) throw new HttpError(400, 'board_position must be a number');
    fields.push('board_position=?'); values.push(Math.round(boardPosition));
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), taskId);
    await db.run(`UPDATE tasks SET ${fields.join(',')} WHERE id=?`, values);
  }
  if (Array.isArray(body.dependencies)) {
    const dependencyIds = [];
    for (const dependencyId of body.dependencies) {
      const dep = await validateTaskLink(Number(existing.project_id), taskId, dependencyId, 'dependency id');
      if (dep !== null) dependencyIds.push(dep);
    }
    if (await wouldCreateDependencyCycle(Number(existing.project_id), taskId, dependencyIds)) {
      throw new HttpError(400, 'That dependency would create a circular chain');
    }
    await db.run('DELETE FROM dependencies WHERE task_id=?', [taskId]);
    for (const dep of dependencyIds) await db.run('INSERT OR IGNORE INTO dependencies(task_id,depends_on_task_id) VALUES(?,?)', [taskId, dep]);
  }
  await audit(project.organization_id, existing.project_id, user.id, 'task', taskId, 'updated', body);
  if (ownerChanged) await recordTaskAssignment(project, taskId, user.id, existing.owner_id, newOwnerId);
  jsonResponse(res, 200, await taskDetail(taskId));
});

route('POST', '/api/tasks/bulk-assign', async ({ res, user, body }) => {
  const taskIds = [...new Set((Array.isArray(body.task_ids) ? body.task_ids : []).map(id => integer(id, 'task_ids')))];
  if (!taskIds.length) throw new HttpError(400, 'task_ids must be a non-empty array');
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  const assignedTaskIds = [];
  for (const taskId of taskIds) {
    const existing = await taskDetail(taskId);
    const { project, member } = await projectWithAccess(user.id, Number(existing.project_id));
    if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
    if (!await canAssignTask(existing, member, ownerId)) throw new HttpError(403, `You do not have permission to assign task #${taskId}.`);
    if (Number(ownerId || 0) !== Number(existing.owner_id || 0)) {
      await db.run('UPDATE tasks SET owner_id=?,updated_at=? WHERE id=?', [ownerId, db.utcnow(), taskId]);
      await recordTaskAssignment(project, taskId, user.id, existing.owner_id, ownerId);
    }
    assignedTaskIds.push(taskId);
  }
  jsonResponse(res, 200, { assigned_task_ids: assignedTaskIds, owner_id: ownerId });
});

route('POST', '/api/tasks/:taskId/assign-with-subtasks', async ({ res, user, params, body }) => {
  const taskId = integer(params.taskId, 'task id');
  const existing = await taskDetail(taskId);
  const { project, member } = await projectWithAccess(user.id, Number(existing.project_id));
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
  if (!await canAssignTask(existing, member, ownerId)) throw new HttpError(403, 'You do not have permission to assign this task.');
  if (Number(ownerId || 0) !== Number(existing.owner_id || 0)) {
    await db.run('UPDATE tasks SET owner_id=?,updated_at=? WHERE id=?', [ownerId, db.utcnow(), taskId]);
    await recordTaskAssignment(project, taskId, user.id, existing.owner_id, ownerId);
  }
  const assignedSubtaskIds = [];
  if (body.include_unassigned_subtasks) {
    // Only fills subtasks that have no assignee yet — an existing subtask assignment is never overwritten.
    const subtasks = await db.all('SELECT id,owner_id,team_id FROM tasks WHERE parent_task_id=? AND owner_id IS NULL AND rejected=0', [taskId]);
    for (const subtask of subtasks) {
      if (!await canAssignTask(subtask, member, ownerId)) continue;
      await db.run('UPDATE tasks SET owner_id=?,updated_at=? WHERE id=?', [ownerId, db.utcnow(), subtask.id]);
      await recordTaskAssignment(project, subtask.id, user.id, null, ownerId);
      assignedSubtaskIds.push(subtask.id);
    }
  }
  jsonResponse(res, 200, { task_id: taskId, assigned_subtask_ids: assignedSubtaskIds, owner_id: ownerId });
});

route('GET', '/api/projects/:projectId/milestones', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  const milestones = await db.all(
    `SELECT m.*,u.full_name owner_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id=m.id AND t.rejected=0) task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id=m.id AND t.rejected=0 AND t.status='done') done_task_count
     FROM milestones m LEFT JOIN users u ON u.id=m.owner_id
     WHERE m.project_id=? ORDER BY (m.due_date IS NULL),m.due_date,m.id`,
    [projectId]
  );
  jsonResponse(res, 200, milestones);
});

route('POST', '/api/projects/:projectId/milestones', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const name = requiredString(body.name, 'Milestone name', 2, 160);
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Milestone owner must be an active organization member');
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO milestones(project_id,name,description,due_date,owner_id,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [projectId, name, cleanString(body.description), cleanString(body.due_date, 10) || null, ownerId, 'planned', user.id, now, now]
  );
  await audit(project.organization_id, projectId, user.id, 'milestone', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM milestones WHERE id=?', [result.lastInsertRowid]));
});

async function milestoneWithAccess(userId, milestoneId, roles = null) {
  const milestone = await db.get('SELECT * FROM milestones WHERE id=?', [milestoneId]);
  if (!milestone) throw new HttpError(404, 'Milestone not found');
  const { project } = await projectWithAccess(userId, Number(milestone.project_id), roles);
  return { milestone, project };
}

route('PATCH', '/api/milestones/:milestoneId', async ({ res, user, params, body }) => {
  const milestoneId = integer(params.milestoneId, 'milestone id');
  const { milestone, project } = await milestoneWithAccess(user.id, milestoneId, ['ceo', 'admin', 'moderator']);
  const allowed = {
    name: value => requiredString(value, 'Milestone name', 2, 160),
    description: value => cleanString(value),
    due_date: value => cleanString(value, 10) || null,
    status: value => { if (!['planned', 'in_progress', 'at_risk', 'done'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    owner_id: value => value ? integer(value, 'owner_id') : null
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'owner_id' && value && !await membership(value, project.organization_id, true)) throw new HttpError(400, 'Milestone owner must be an active organization member');
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), milestoneId);
    await db.run(`UPDATE milestones SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(project.organization_id, milestone.project_id, user.id, 'milestone', milestoneId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM milestones WHERE id=?', [milestoneId]));
});

route('DELETE', '/api/milestones/:milestoneId', async ({ res, user, params }) => {
  const milestoneId = integer(params.milestoneId, 'milestone id');
  const { milestone, project } = await milestoneWithAccess(user.id, milestoneId, ['ceo', 'admin', 'moderator']);
  await db.run('UPDATE tasks SET milestone_id=NULL WHERE milestone_id=?', [milestoneId]);
  await db.run('DELETE FROM milestones WHERE id=?', [milestoneId]);
  await audit(project.organization_id, milestone.project_id, user.id, 'milestone', milestoneId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/projects/:projectId/stories', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  const stories = await db.all(
    `SELECT s.*,u.full_name owner_name,d.name department_name,t.name team_name,lead.full_name team_manager_name,
      (SELECT COUNT(*) FROM tasks t2 WHERE t2.story_id=s.id AND t2.rejected=0) task_count,
      (SELECT COUNT(*) FROM tasks t2 WHERE t2.story_id=s.id AND t2.rejected=0 AND t2.status='done') done_task_count
     FROM stories s LEFT JOIN users u ON u.id=s.owner_id LEFT JOIN departments d ON d.id=s.department_id
     LEFT JOIN teams t ON t.id=s.team_id LEFT JOIN users lead ON lead.id=t.lead_user_id
     WHERE s.project_id=? ORDER BY s.position,s.id`,
    [projectId]
  );
  jsonResponse(res, 200, scopeStoryList(scope, stories));
});

route('POST', '/api/projects/:projectId/stories', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const name = requiredString(body.name, 'Story name', 2, 160);
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Story owner must be an active organization member');
  const departmentId = body.department_id ? integer(body.department_id, 'department_id') : null;
  if (departmentId && !await db.get('SELECT id FROM departments WHERE id=? AND organization_id=?', [departmentId, project.organization_id])) throw new HttpError(400, 'department_id must reference a department in this organization');
  const team = await validTeamId(body.team_id, project.organization_id);
  const priority = ['low', 'medium', 'high', 'critical'].includes(body.priority) ? body.priority : 'medium';
  const maxPosition = await db.get('SELECT COALESCE(MAX(position),-1) AS maxPos FROM stories WHERE project_id=?', [projectId]);
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO stories(project_id,name,description,owner_id,department_id,priority,status,start_date,due_date,position,team_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [projectId, name, cleanString(body.description), ownerId, departmentId, priority, 'not_started', cleanString(body.start_date, 10) || null, cleanString(body.due_date, 10) || null, Number(maxPosition.maxPos) + 1, team?.id || null, user.id, now, now]
  );
  await audit(project.organization_id, projectId, user.id, 'story', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM stories WHERE id=?', [result.lastInsertRowid]));
});

async function storyWithAccess(userId, storyId, roles = null) {
  const story = await db.get('SELECT * FROM stories WHERE id=?', [storyId]);
  if (!story) throw new HttpError(404, 'Story not found');
  const { project } = await projectWithAccess(userId, Number(story.project_id), roles);
  return { story, project };
}

route('PATCH', '/api/stories/:storyId', async ({ res, user, params, body }) => {
  const storyId = integer(params.storyId, 'story id');
  const { story, project } = await storyWithAccess(user.id, storyId, ['ceo', 'admin', 'moderator']);
  const allowed = {
    name: value => requiredString(value, 'Story name', 2, 160),
    description: value => cleanString(value),
    priority: value => { if (!['low', 'medium', 'high', 'critical'].includes(value)) throw new HttpError(400, 'Invalid priority'); return value; },
    status: value => { if (!['not_started', 'in_progress', 'at_risk', 'done'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    start_date: value => cleanString(value, 10) || null,
    due_date: value => cleanString(value, 10) || null,
    owner_id: value => value ? integer(value, 'owner_id') : null,
    position: value => { const output = Number(value); if (!Number.isFinite(output)) throw new HttpError(400, 'Invalid position'); return Math.round(output); }
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'owner_id' && value && !await membership(value, project.organization_id, true)) throw new HttpError(400, 'Story owner must be an active organization member');
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (body.department_id !== undefined) {
    const departmentId = body.department_id ? integer(body.department_id, 'department_id') : null;
    if (departmentId && !await db.get('SELECT id FROM departments WHERE id=? AND organization_id=?', [departmentId, project.organization_id])) throw new HttpError(400, 'department_id must reference a department in this organization');
    fields.push('department_id=?'); values.push(departmentId);
  }
  if (body.team_id !== undefined) {
    const team = await validTeamId(body.team_id, project.organization_id);
    fields.push('team_id=?'); values.push(team?.id || null);
  }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), storyId);
    await db.run(`UPDATE stories SET ${fields.join(',')} WHERE id=?`, values);
  }
  await audit(project.organization_id, story.project_id, user.id, 'story', storyId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM stories WHERE id=?', [storyId]));
});

route('DELETE', '/api/stories/:storyId', async ({ res, user, params }) => {
  const storyId = integer(params.storyId, 'story id');
  const { story, project } = await storyWithAccess(user.id, storyId, ['ceo', 'admin', 'moderator']);
  await db.run('UPDATE tasks SET story_id=NULL WHERE story_id=?', [storyId]);
  await db.run('DELETE FROM stories WHERE id=?', [storyId]);
  await audit(project.organization_id, story.project_id, user.id, 'story', storyId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});

const taskCommentStreamClients = new Map();

function addTaskCommentStreamClient(taskId, response) {
  if (!taskCommentStreamClients.has(taskId)) taskCommentStreamClients.set(taskId, new Set());
  taskCommentStreamClients.get(taskId).add(response);
}

function removeTaskCommentStreamClient(taskId, response) {
  const clients = taskCommentStreamClients.get(taskId);
  if (!clients) return;
  clients.delete(response);
  if (!clients.size) taskCommentStreamClients.delete(taskId);
}

function broadcastToTaskComments(taskId, payload) {
  const clients = taskCommentStreamClients.get(taskId);
  if (!clients || !clients.size) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const response of clients) {
    if (!response.writableEnded) response.write(frame);
  }
}

setInterval(() => {
  for (const clients of taskCommentStreamClients.values()) {
    for (const response of clients) {
      if (!response.writableEnded) response.write(': ping\n\n');
    }
  }
}, 25_000).unref();

route('GET', '/api/tasks/:taskId/comments', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { scope } = await projectWithAccess(user.id, Number(task.project_id));
  if (!taskInScope(scope, task)) throw new HttpError(403, 'You do not have access to this task');
  const comments = await db.all(
    'SELECT c.*,u.username,u.full_name FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.id',
    [taskId]
  );
  jsonResponse(res, 200, comments);
});

route('GET', '/api/tasks/:taskId/comments/stream', async ({ req, res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { scope } = await projectWithAccess(user.id, Number(task.project_id));
  if (!taskInScope(scope, task)) throw new HttpError(403, 'You do not have access to this task');
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  addTaskCommentStreamClient(taskId, res);
  req.on('close', () => removeTaskCommentStreamClient(taskId, res));
});

route('POST', '/api/tasks/:taskId/comments', async ({ res, user, params, body }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { project, scope } = await projectWithAccess(user.id, Number(task.project_id));
  if (!taskInScope(scope, task)) throw new HttpError(403, 'You do not have access to this task');
  const commentBody = requiredString(body.body, 'Comment', 1, 4000);
  const result = await db.run('INSERT INTO task_comments(task_id,user_id,body,created_at) VALUES(?,?,?,?)', [taskId, user.id, commentBody, db.utcnow()]);
  await audit(project.organization_id, task.project_id, user.id, 'task_comment', result.lastInsertRowid, 'created', { task_id: taskId });
  const mentionedUsernames = [...new Set([...commentBody.matchAll(/@([a-z0-9._-]{3,40})/gi)].map(match => match[1].toLowerCase()))];
  for (const username of mentionedUsernames) {
    const mentioned = await db.get(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.username=? AND m.organization_id=? AND m.status='active'`, [username, project.organization_id]);
    if (mentioned && Number(mentioned.id) !== Number(user.id)) await notifyUser(mentioned.id, 'mention', `${user.full_name} mentioned you`, `${task.title}: ${commentBody.slice(0, 180)}`, project.organization_id, 'work');
  }
  if (task.owner_id && Number(task.owner_id) !== Number(user.id)) {
    await notifyUser(task.owner_id, 'activity', `${user.full_name} commented on ${task.title}`, commentBody.slice(0, 180), project.organization_id, 'work');
  }
  const created = await db.get('SELECT c.*,u.username,u.full_name FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.id=?', [result.lastInsertRowid]);
  broadcastToTaskComments(taskId, created);
  jsonResponse(res, 201, created);
});

async function directConversationWithAccess(userId, conversationId) {
  const conversation = await db.get('SELECT * FROM direct_conversations WHERE id=?', [conversationId]);
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  const membershipRow = await db.get('SELECT * FROM direct_conversation_members WHERE conversation_id=? AND user_id=?', [conversationId, userId]);
  if (!membershipRow) throw new HttpError(403, 'You are not part of this conversation');
  return conversation;
}

route('GET', '/api/organizations/:organizationId/direct-conversations', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const conversations = await db.all(
    `SELECT dc.id, dc.created_at,
      (SELECT u.id FROM direct_conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=dc.id AND m.user_id<>? LIMIT 1) other_user_id,
      (SELECT last_read_at FROM direct_conversation_members WHERE conversation_id=dc.id AND user_id=?) my_last_read_at
     FROM direct_conversations dc
     WHERE dc.organization_id=? AND EXISTS (SELECT 1 FROM direct_conversation_members m WHERE m.conversation_id=dc.id AND m.user_id=?)`,
    [user.id, user.id, organizationId, user.id]
  );
  const result = [];
  for (const conversation of conversations) {
    const other = conversation.other_user_id ? await db.get('SELECT id,full_name,username,avatar_url FROM users WHERE id=?', [conversation.other_user_id]) : null;
    const lastMessage = await db.get('SELECT body,created_at FROM direct_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1', [conversation.id]);
    const unread = await db.get('SELECT COUNT(*) count FROM direct_messages WHERE conversation_id=? AND created_at > ? AND user_id<>?', [conversation.id, conversation.my_last_read_at || '0000-01-01T00:00:00Z', user.id]);
    result.push({ id: conversation.id, other_user: other, last_message: lastMessage?.body || '', last_message_at: lastMessage?.created_at || conversation.created_at, unread_count: Number(unread.count) });
  }
  result.sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
  jsonResponse(res, 200, result);
});

route('POST', '/api/organizations/:organizationId/direct-conversations', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const targetUserId = integer(body.user_id, 'user_id');
  if (targetUserId === user.id) throw new HttpError(400, 'You cannot start a conversation with yourself');
  if (!await membership(targetUserId, organizationId, true)) throw new HttpError(400, 'That person is not an active member of this organization');
  const existing = await db.get(
    `SELECT dc.id FROM direct_conversations dc
     WHERE dc.organization_id=?
     AND EXISTS (SELECT 1 FROM direct_conversation_members m1 WHERE m1.conversation_id=dc.id AND m1.user_id=?)
     AND EXISTS (SELECT 1 FROM direct_conversation_members m2 WHERE m2.conversation_id=dc.id AND m2.user_id=?)
     AND (SELECT COUNT(*) FROM direct_conversation_members m WHERE m.conversation_id=dc.id)=2`,
    [organizationId, user.id, targetUserId]
  );
  if (existing) { jsonResponse(res, 200, { id: existing.id, created: false }); return; }
  const now = db.utcnow();
  const result = await db.run('INSERT INTO direct_conversations(organization_id,created_at) VALUES(?,?)', [organizationId, now]);
  await db.run('INSERT INTO direct_conversation_members(conversation_id,user_id,last_read_at) VALUES(?,?,?)', [result.lastInsertRowid, user.id, now]);
  await db.run('INSERT INTO direct_conversation_members(conversation_id,user_id,last_read_at) VALUES(?,?,?)', [result.lastInsertRowid, targetUserId, null]);
  jsonResponse(res, 201, { id: result.lastInsertRowid, created: true });
});

route('GET', '/api/direct-conversations/:conversationId/messages', async ({ res, user, params, query }) => {
  const conversationId = integer(params.conversationId, 'conversation id');
  await directConversationWithAccess(user.id, conversationId);
  const before = query.get('before');
  const paramsList = [conversationId];
  let condition = '';
  if (before) { condition = 'AND dm.id < ?'; paramsList.push(integer(before, 'before')); }
  const items = (await db.all(
    `SELECT dm.*,u.username,u.full_name FROM direct_messages dm JOIN users u ON u.id=dm.user_id WHERE dm.conversation_id=? ${condition} ORDER BY dm.id DESC LIMIT 100`,
    paramsList
  )).reverse();
  jsonResponse(res, 200, items);
});

const dmStreamClients = new Map();

function addDmStreamClient(conversationId, response) {
  if (!dmStreamClients.has(conversationId)) dmStreamClients.set(conversationId, new Set());
  dmStreamClients.get(conversationId).add(response);
}

function removeDmStreamClient(conversationId, response) {
  const clients = dmStreamClients.get(conversationId);
  if (!clients) return;
  clients.delete(response);
  if (!clients.size) dmStreamClients.delete(conversationId);
}

function broadcastToDmConversation(conversationId, payload) {
  const clients = dmStreamClients.get(conversationId);
  if (!clients || !clients.size) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const response of clients) {
    if (!response.writableEnded) response.write(frame);
  }
}

setInterval(() => {
  for (const clients of dmStreamClients.values()) {
    for (const response of clients) {
      if (!response.writableEnded) response.write(': ping\n\n');
    }
  }
}, 25_000).unref();

route('GET', '/api/direct-conversations/:conversationId/messages/stream', async ({ req, res, user, params }) => {
  const conversationId = integer(params.conversationId, 'conversation id');
  await directConversationWithAccess(user.id, conversationId);
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  addDmStreamClient(conversationId, res);
  req.on('close', () => removeDmStreamClient(conversationId, res));
});

route('POST', '/api/direct-conversations/:conversationId/messages', async ({ res, user, params, body }) => {
  const conversationId = integer(params.conversationId, 'conversation id');
  const conversation = await directConversationWithAccess(user.id, conversationId);
  const messageBody = requiredString(body.body, 'Message', 1, 4000);
  const result = await db.run('INSERT INTO direct_messages(conversation_id,user_id,body,created_at) VALUES(?,?,?,?)', [conversationId, user.id, messageBody, db.utcnow()]);
  await db.run('UPDATE direct_conversation_members SET last_read_at=? WHERE conversation_id=? AND user_id=?', [db.utcnow(), conversationId, user.id]);
  const created = await db.get('SELECT dm.*,u.username,u.full_name FROM direct_messages dm JOIN users u ON u.id=dm.user_id WHERE dm.id=?', [result.lastInsertRowid]);
  broadcastToDmConversation(conversationId, created);
  const otherMembers = await db.all('SELECT user_id FROM direct_conversation_members WHERE conversation_id=? AND user_id<>?', [conversationId, user.id]);
  for (const other of otherMembers) {
    await notifyUser(other.user_id, 'message', `New message from ${user.full_name}`, messageBody.slice(0, 180), conversation.organization_id, 'chat');
  }
  jsonResponse(res, 201, created);
});

route('POST', '/api/direct-conversations/:conversationId/read', async ({ res, user, params }) => {
  const conversationId = integer(params.conversationId, 'conversation id');
  await directConversationWithAccess(user.id, conversationId);
  await db.run('UPDATE direct_conversation_members SET last_read_at=? WHERE conversation_id=? AND user_id=?', [db.utcnow(), conversationId, user.id]);
  jsonResponse(res, 200, { read: true });
});

route('POST', '/api/tasks/:taskId/regenerate', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { project } = await projectWithAccess(user.id, Number(task.project_id), ['ceo', 'admin', 'moderator']);
  const aiResult = await ai.regenerateTask(task, project, await activeOrganizationMembers(project.organization_id));
  await db.run('UPDATE tasks SET description=?,acceptance_criteria=?,approved=0,rejected=0,ai_generated=1,updated_at=? WHERE id=?', [aiResult.item.description, aiResult.item.acceptance_criteria, db.utcnow(), taskId]);
  await audit(project.organization_id, task.project_id, user.id, 'task', taskId, 'ai_regenerated', { provider: aiResult.provider, fallback: aiResult.fallback });
  const updated = await taskDetail(taskId);
  updated.ai_provider = aiResult.provider;
  updated.fallback_used = aiResult.fallback;
  jsonResponse(res, 200, updated);
});

route('POST', '/api/projects/:projectId/meeting-notes', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const notes = requiredString(body.notes, 'Meeting notes', 5, 30000);
  await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [projectId, 'meeting_notes', notes, user.id, db.utcnow()]);
  const aiResult = await ai.generateMeetingSuggestions(notes, await activeOrganizationMembers(project.organization_id), project);
  const proposals = aiResult.items;
  const ids = [];
  for (const proposal of proposals) {
    const inserted = await db.run(
      'INSERT INTO suggestions(project_id,suggestion_type,payload_json,rationale,evidence,status,created_at) VALUES(?,?,?,?,?,?,?)',
      [projectId, proposal.suggestion_type, JSON.stringify(proposal.payload), proposal.rationale, proposal.evidence, 'pending', db.utcnow()]
    );
    ids.push(inserted.lastInsertRowid);
  }
  await audit(project.organization_id, projectId, user.id, 'project', projectId, 'meeting_notes_processed', { suggestion_ids: ids, provider: aiResult.provider, fallback: aiResult.fallback });
  jsonResponse(res, 201, { created_suggestion_ids: ids, ai_provider: aiResult.provider, fallback_used: aiResult.fallback, message: 'Meeting-note proposals created for review.' });
});

route('GET', '/api/projects/:projectId/suggestions', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  const items = await db.all('SELECT * FROM suggestions WHERE project_id=? ORDER BY created_at DESC', [projectId]);
  items.forEach(item => {
    try { item.payload = JSON.parse(item.payload_json); } catch { item.payload = {}; }
  });
  jsonResponse(res, 200, items);
});

route('POST', '/api/suggestions/:suggestionId/approve', async ({ res, user, params }) => {
  const suggestionId = integer(params.suggestionId, 'suggestion id');
  const suggestion = await db.get('SELECT * FROM suggestions WHERE id=?', [suggestionId]);
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  const { project } = await projectWithAccess(user.id, Number(suggestion.project_id), ['ceo', 'admin', 'moderator']);
  if (suggestion.status !== 'pending') throw new HttpError(409, 'Suggestion has already been reviewed');
  let payload = {};
  try { payload = JSON.parse(suggestion.payload_json); } catch {}
  let createdEntity = null;
  if (suggestion.suggestion_type === 'task') {
    const owner = payload.owner_name ? await db.get(
      `SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=? AND m.status='active' AND lower(u.full_name)=lower(?) LIMIT 1`,
      [project.organization_id, payload.owner_name]
    ) : null;
    const result = await db.run(
      `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [suggestion.project_id, payload.phase || 'Meeting Follow-up', payload.title || 'Meeting follow-up', payload.description || '', owner?.id || null, ['low','medium','high','critical'].includes(payload.priority) ? payload.priority : 'medium', 'not_started', 0, payload.acceptance_criteria || '', 'meeting_note', 1, 1, 0, user.id, db.utcnow(), db.utcnow()]
    );
    createdEntity = { type: 'task', id: result.lastInsertRowid };
  } else if (suggestion.suggestion_type === 'decision') {
    const result = await db.run('INSERT INTO decisions(project_id,title,detail,owner,status,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', [suggestion.project_id, payload.title || 'Meeting decision', payload.detail || suggestion.evidence, payload.owner || '', 'approved', 'meeting_note', user.id, db.utcnow()]);
    createdEntity = { type: 'decision', id: result.lastInsertRowid };
  } else if (suggestion.suggestion_type === 'risk') {
    const result = await db.run('INSERT INTO risks(project_id,risk_type,severity,title,description,evidence,status,ai_generated,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [suggestion.project_id, payload.risk_type || 'meeting_note', payload.severity || 'medium', payload.title || 'Meeting risk', payload.description || suggestion.evidence, suggestion.evidence, 'open', 1, 1, db.utcnow(), db.utcnow()]);
    createdEntity = { type: 'risk', id: result.lastInsertRowid };
  }
  await db.run("UPDATE suggestions SET status='approved',reviewed_at=?,reviewed_by=? WHERE id=?", [db.utcnow(), user.id, suggestionId]);
  await audit(project.organization_id, suggestion.project_id, user.id, 'suggestion', suggestionId, 'approved', createdEntity || {});
  jsonResponse(res, 200, { status: 'approved', created_entity: createdEntity });
});

route('POST', '/api/suggestions/:suggestionId/reject', async ({ res, user, params }) => {
  const suggestionId = integer(params.suggestionId, 'suggestion id');
  const suggestion = await db.get('SELECT * FROM suggestions WHERE id=?', [suggestionId]);
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  const { project } = await projectWithAccess(user.id, Number(suggestion.project_id), ['ceo', 'admin', 'moderator']);
  if (suggestion.status !== 'pending') throw new HttpError(409, 'Suggestion has already been reviewed');
  await db.run("UPDATE suggestions SET status='rejected',reviewed_at=?,reviewed_by=? WHERE id=?", [db.utcnow(), user.id, suggestionId]);
  await audit(project.organization_id, suggestion.project_id, user.id, 'suggestion', suggestionId, 'rejected');
  jsonResponse(res, 200, { status: 'rejected' });
});

route('POST', '/api/projects/:projectId/risks/scan', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const tasks = await db.all('SELECT * FROM tasks WHERE project_id=? AND rejected=0', [projectId]);
  const dependencies = await db.all('SELECT d.* FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]);
  const aiResult = await ai.scanRisksWithAi(tasks, await activeOrganizationMembers(project.organization_id), dependencies, project);
  const risks = aiResult.items;
  await db.run('DELETE FROM risks WHERE project_id=? AND ai_generated=1 AND approved=0', [projectId]);
  const ids = [];
  for (const item of risks) {
    const inserted = await db.run(
      'INSERT INTO risks(project_id,risk_type,severity,title,description,evidence,status,ai_generated,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [projectId, item.risk_type, item.severity, item.title, item.description, item.evidence, 'open', 1, 0, db.utcnow(), db.utcnow()]
    );
    ids.push(inserted.lastInsertRowid);
  }
  await audit(project.organization_id, projectId, user.id, 'project', projectId, 'risk_scan_completed', { risk_ids: ids, provider: aiResult.provider, fallback: aiResult.fallback });
  jsonResponse(res, 201, { created_risk_ids: ids, count: ids.length, ai_provider: aiResult.provider, fallback_used: aiResult.fallback });
});

route('GET', '/api/projects/:projectId/risks', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) return jsonResponse(res, 200, []);
  jsonResponse(res, 200, await db.all('SELECT * FROM risks WHERE project_id=? ORDER BY status,severity DESC,id DESC', [projectId]));
});

route('PATCH', '/api/risks/:riskId', async ({ res, user, params, body }) => {
  const riskId = integer(params.riskId, 'risk id');
  const risk = await db.get('SELECT * FROM risks WHERE id=?', [riskId]);
  if (!risk) throw new HttpError(404, 'Risk not found');
  const { project } = await projectWithAccess(user.id, Number(risk.project_id), ['ceo', 'admin', 'moderator']);
  const fields = [];
  const values = [];
  if (body.status !== undefined) { fields.push('status=?'); values.push(cleanString(body.status, 30)); }
  if (body.approved !== undefined) { fields.push('approved=?'); values.push(booleanInt(body.approved)); }
  if (!fields.length) throw new HttpError(400, 'No supported risk fields were provided');
  fields.push('updated_at=?'); values.push(db.utcnow(), riskId);
  await db.run(`UPDATE risks SET ${fields.join(',')} WHERE id=?`, values);
  await audit(project.organization_id, risk.project_id, user.id, 'risk', riskId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM risks WHERE id=?', [riskId]));
});

route('POST', '/api/projects/:projectId/changes', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId);
  const title = requiredString(body.title, 'Change title', 2, 220);
  const description = requiredString(body.description, 'Change description', 3, 10000);
  const taskCount = Number((await db.get('SELECT COUNT(*) count FROM tasks WHERE project_id=? AND rejected=0', [projectId]))?.count || 0);
  const ownerCounts = Object.fromEntries((await db.all(
    `SELECT u.full_name name,COUNT(*) count FROM tasks t JOIN users u ON u.id=t.owner_id
     WHERE t.project_id=? AND t.status!='done' AND t.rejected=0 GROUP BY u.id,u.full_name`, [projectId]
  )).map(row => [row.name, Number(row.count)]));
  const existingTasks = await db.all('SELECT id,phase,title,owner_id,priority,status,progress,due_date FROM tasks WHERE project_id=? AND rejected=0 ORDER BY id', [projectId]);
  const aiResult = await ai.analyzeChangeWithAi(description, taskCount, ownerCounts, project, existingTasks);
  const impact = aiResult.item;
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO changes(project_id,title,description,impact_scope,impact_effort,impact_dependencies,impact_workload,status,requested_by,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [projectId, title, description, impact.impact_scope, impact.impact_effort, impact.impact_dependencies, impact.impact_workload, 'pending', cleanString(body.requested_by, 160), user.id, now, now]
  );
  await audit(project.organization_id, projectId, user.id, 'change', result.lastInsertRowid, 'created', { title, impact, provider: aiResult.provider, fallback: aiResult.fallback });
  const createdChange = await db.get('SELECT * FROM changes WHERE id=?', [result.lastInsertRowid]);
  createdChange.ai_provider = aiResult.provider;
  createdChange.fallback_used = aiResult.fallback;
  jsonResponse(res, 201, createdChange);
});

route('GET', '/api/projects/:projectId/changes', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) return jsonResponse(res, 200, []);
  jsonResponse(res, 200, await db.all('SELECT * FROM changes WHERE project_id=? ORDER BY created_at DESC', [projectId]));
});

route('POST', '/api/changes/:changeId/:action', async ({ res, user, params }) => {
  const changeId = integer(params.changeId, 'change id');
  const action = cleanString(params.action, 20).toLowerCase();
  if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'Action must be approve or reject');
  const change = await db.get('SELECT * FROM changes WHERE id=?', [changeId]);
  if (!change) throw new HttpError(404, 'Change not found');
  const { project } = await projectWithAccess(user.id, Number(change.project_id), ['ceo', 'admin', 'moderator']);
  await db.run('UPDATE changes SET status=?,updated_at=? WHERE id=?', [action === 'approve' ? 'approved' : 'rejected', db.utcnow(), changeId]);
  await audit(project.organization_id, change.project_id, user.id, 'change', changeId, action + 'd');
  jsonResponse(res, 200, await db.get('SELECT * FROM changes WHERE id=?', [changeId]));
});

route('POST', '/api/projects/:projectId/decisions', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const result = await db.run('INSERT INTO decisions(project_id,title,detail,owner,status,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', [projectId, requiredString(body.title, 'Decision title', 2, 220), requiredString(body.detail, 'Decision detail', 3, 10000), cleanString(body.owner, 160), 'approved', 'manual', user.id, db.utcnow()]);
  await audit(project.organization_id, projectId, user.id, 'decision', result.lastInsertRowid, 'created');
  jsonResponse(res, 201, await db.get('SELECT * FROM decisions WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/projects/:projectId/decisions', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) return jsonResponse(res, 200, []);
  jsonResponse(res, 200, await db.all('SELECT * FROM decisions WHERE project_id=? ORDER BY created_at DESC', [projectId]));
});

route('POST', '/api/projects/:projectId/updates', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId);
  const taskId = body.task_id ? integer(body.task_id, 'task_id') : null;
  if (taskId && !await db.get('SELECT id FROM tasks WHERE id=? AND project_id=?', [taskId, projectId])) throw new HttpError(400, 'Task does not belong to this project');
  const result = await db.run('INSERT INTO updates(project_id,task_id,note,update_type,created_by,created_at) VALUES(?,?,?,?,?,?)', [projectId, taskId, requiredString(body.note, 'Update note', 2, 10000), cleanString(body.update_type, 40) || 'progress', user.id, db.utcnow()]);
  await audit(project.organization_id, projectId, user.id, 'update', result.lastInsertRowid, 'created');
  jsonResponse(res, 201, await db.get('SELECT * FROM updates WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/projects/:projectId/report', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  const report = await projectReport(projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) {
    jsonResponse(res, 200, { ...report, blockers: [], open_risks: [], approved_decisions: [], pending_changes: [], recent_updates: [] });
    return;
  }
  jsonResponse(res, 200, report);
});

route('GET', '/api/projects/:projectId/audit', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  jsonResponse(res, 200, await db.all(
    `SELECT a.*,u.full_name actor_name,u.username actor_username FROM audit_log a
     LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.project_id=? ORDER BY a.id DESC LIMIT 500`,
    [projectId]
  ));
});

route('GET', '/api/projects/:projectId/export.json', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  requireManagerTierOrAbove(scope, 'Exporting a project is only available to managers and above');
  const allTasksForExport = await db.all(
    `SELECT t.*, s.team_id story_team_id FROM tasks t LEFT JOIN stories s ON s.id=t.story_id WHERE t.project_id=?`,
    [projectId]
  );
  const exportData = {
    project: await getProject(projectId),
    tasks: scopeTaskList(scope, allTasksForExport),
    dependencies: await db.all('SELECT d.* FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]),
    risks: await db.all('SELECT * FROM risks WHERE project_id=?', [projectId]),
    decisions: await db.all('SELECT * FROM decisions WHERE project_id=?', [projectId]),
    changes: await db.all('SELECT * FROM changes WHERE project_id=?', [projectId]),
    updates: await db.all('SELECT * FROM updates WHERE project_id=?', [projectId]),
    report: await projectReport(projectId)
  };
  const body = JSON.stringify(exportData, null, 2);
  textResponse(res, 200, body, 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="project-${projectId}-export.json"` });
});

function csvCell(value) {
  const string = String(value ?? '');
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

route('GET', '/api/projects/:projectId/tasks.csv', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  requireManagerTierOrAbove(scope, 'Exporting tasks is only available to managers and above');
  const allTasksForCsv = await db.all(
    `SELECT t.*,u.full_name owner_name,s.team_id story_team_id FROM tasks t LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN stories s ON s.id=t.story_id WHERE t.project_id=? ORDER BY t.id`,
    [projectId]
  );
  const tasks = scopeTaskList(scope, allTasksForCsv);
  const headers = ['id','phase','title','owner_name','priority','status','progress','approved','due_date','acceptance_criteria'];
  const csv = [headers.join(','), ...tasks.map(task => headers.map(header => csvCell(task[header])).join(','))].join('\n');
  textResponse(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="project-${projectId}-tasks.csv"` });
});

function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requested);
  const resolved = path.resolve(config.publicDir, `.${decoded}`);
  if (!resolved.startsWith(config.publicDir + path.sep) && resolved !== path.join(config.publicDir, 'index.html')) return false;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  const stat = fs.statSync(resolved);
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const extension = path.extname(resolved).toLowerCase();
  response.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
  response.setHeader('Cache-Control', extension === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=300');
  response.setHeader('ETag', etag);
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304);
    response.end();
    return true;
  }
  const content = fs.readFileSync(resolved);
  response.setHeader('Content-Length', content.length);
  response.writeHead(200);
  if (request.method === 'HEAD') response.end(); else response.end(content);
  return true;
}

function errorCode(status) {
  return ({
    400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE', 500: 'INTERNAL_ERROR'
  })[status] || 'REQUEST_FAILED';
}

async function handleRequest(request, response) {
  setCommonHeaders(request, response);
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Allow': 'GET,HEAD,POST,PATCH,DELETE,OPTIONS', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
      response.setHeader('Allow', 'GET,HEAD,POST,PATCH,DELETE,OPTIONS');
      throw new HttpError(405, 'Method not allowed');
    }

    const pathMatches = routes.filter(item => item.regex.test(url.pathname));
    const routeMatch = pathMatches.find(item => item.method === request.method);
    enforceRateLimit(request, response, routeMatch);

    if (!routeMatch) {
      if (!url.pathname.startsWith('/api/') && ['GET', 'HEAD'].includes(request.method) && serveStatic(request, response, url.pathname)) return;
      if (pathMatches.length) {
        response.setHeader('Allow', [...new Set(pathMatches.map(item => item.method))].join(','));
        throw new HttpError(405, 'Method not allowed');
      }
      throw new HttpError(404, 'Route not found');
    }

    validateRequestOrigin(request);
    const match = url.pathname.match(routeMatch.regex);
    const params = Object.fromEntries(routeMatch.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
    const user = routeMatch.auth ? await requireUser(request) : null;
    const body = routeMatch.rawBody ? undefined : await parseBody(request);
    await routeMatch.handler({ req: request, res: response, url, query: url.searchParams, params, body, user });
  } catch (error) {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    const detail = error instanceof HttpError ? error.detail : 'Internal server error';
    if (!(error instanceof HttpError)) console.error(`[${request.requestId}]`, error);
    jsonResponse(response, status, {
      detail,
      code: errorCode(status),
      request_id: request.requestId
    });
  }
}

function createServer() {
  const server = http.createServer(handleRequest);
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs + 5_000, 125_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  return server;
}

async function start() {
  await db.initDb();
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
