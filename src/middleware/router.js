'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const config = require('../config');
const { HttpError, jsonResponse, parseBody } = require('./http');
const { setCommonHeaders, validateRequestOrigin, enforceRateLimit } = require('./security');
const { requireUser } = require('../auth/session');

const routes = [];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

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

module.exports = { routes, route, compilePath, handleRequest, errorCode, serveStatic, MIME_TYPES };
