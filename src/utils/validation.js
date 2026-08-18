'use strict';

const { HttpError } = require('../middleware/http');

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

module.exports = {
  cleanString,
  requiredString,
  integer,
  booleanInt,
  normalizeUsername,
  normalizeEmail,
  normalizeDepartment,
  WORKSPACE_STATUS_PRESETS,
  workspaceStatus,
  validateAvatarUrl,
  validatePassword
};
