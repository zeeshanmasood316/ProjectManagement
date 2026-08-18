'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const db = require('../database/client');
const auth = require('../auth/tokens');
const mailer = require('../notifications/mailer');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse, clientDescription } = require('../middleware/http');
const { cleanString, requiredString, normalizeUsername, normalizeEmail, validatePassword } = require('../utils/validation');
const { publicUser, createAuthSession, authenticationHeaders, passwordResetCodeHash } = require('../auth/session');
const { activity, settingsForUser } = require('../notifications/events');
const { touchPresence, organizationSummary } = require('../services/organizations');

const DUMMY_PASSWORD_HASH = auth.hashPassword('NotARealPassword123');

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
