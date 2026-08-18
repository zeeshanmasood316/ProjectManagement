'use strict';

const crypto = require('node:crypto');
const config = require('../config');

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

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

// Local, self-contained trim helper (avoids importing utils/validation's cleanString here,
// which would create a require cycle since utils/validation depends on HttpError from this file).
function trimmed(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function clientDescription(request) {
  const agent = trimmed(request.headers['user-agent'], 240) || 'Unknown client';
  return `${agent} · IP ${clientIp(request) || 'unknown'}`;
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

module.exports = {
  HttpError,
  requestId,
  clientIp,
  clientDescription,
  jsonResponse,
  textResponse,
  parseBody
};
