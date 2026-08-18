'use strict';

const { URL } = require('node:url');
const config = require('../config');
const auth = require('../auth/tokens');
const { HttpError, requestId, clientIp } = require('./http');

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const rateLimitBuckets = new Map();

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

module.exports = { setCommonHeaders, validateRequestOrigin, enforceRateLimit };
