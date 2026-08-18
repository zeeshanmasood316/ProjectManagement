'use strict';

const config = require('./config');

class AiProviderError extends Error {
  constructor(message, { status = 502, provider = '', retryAfterMs = null, quotaExceeded = false } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
    this.quotaExceeded = quotaExceeded;
  }
}

function enabled() {
  return Boolean(config.externalAi.enabled && config.externalAi.key && config.externalAi.model);
}

function providerName() {
  if (!enabled()) return 'local_fallback';
  return config.externalAi.provider || 'gemini';
}

function status() {
  return {
    enabled: enabled(),
    provider: providerName(),
    model: enabled() ? config.externalAi.model : 'local-rule-engine',
    mode: enabled() ? 'external_ai' : 'local_fallback'
  };
}

function stripCodeFence(value) {
  return String(value || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractGeminiText(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === 'string' && part.text.trim()) return part.text;
    }
  }
  return '';
}

// ---- structured logging (no API keys, no brief/project content — only shape/metadata) ----
let requestSequence = 0;
function nextRequestNumber() { requestSequence += 1; return requestSequence; }

function logEvent(event, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);
  console.log(`[ai] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

// ---- concurrency limiter: bounds how many AI requests can be in flight at once, process-wide,
// so a burst of users/actions can't fan out into a burst of simultaneous Gemini calls ----
let activeRequestCount = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeRequestCount < Math.max(1, config.externalAi.maxConcurrent)) {
    activeRequestCount += 1;
    return Promise.resolve();
  }
  return new Promise(resolve => waitQueue.push(resolve));
}

function releaseSlot() {
  activeRequestCount = Math.max(0, activeRequestCount - 1);
  const next = waitQueue.shift();
  if (next) {
    activeRequestCount += 1;
    next();
  }
}

// ---- quota-exhaustion cooldown: once the provider reports its quota is exhausted, every AI
// request process-wide short-circuits straight to the caller's local fallback until the cooldown
// clears, instead of continuing to send requests that are certain to fail ----
let quotaCooldownUntil = 0;

function inQuotaCooldown() {
  return Date.now() < quotaCooldownUntil;
}

function setQuotaCooldown(ms) {
  quotaCooldownUntil = Math.max(quotaCooldownUntil, Date.now() + Math.max(0, ms));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryDelayMs(payload, headers) {
  const details = payload?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const raw = detail?.retryDelay;
      if (typeof raw === 'string') {
        const match = raw.match(/^([\d.]+)s$/);
        if (match) return Math.round(parseFloat(match[1]) * 1000);
      }
    }
  }
  const retryAfterHeader = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  return null;
}

function isQuotaExceeded(payload) {
  const message = String(payload?.error?.message || '').toLowerCase();
  const statusText = String(payload?.error?.status || '').toLowerCase();
  return statusText.includes('resource_exhausted') || message.includes('quota') || message.includes('resource_exhausted');
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.externalAi.timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`;
      const retryAfterMs = parseRetryDelayMs(payload, response.headers);
      const quotaExceeded = response.status === 429 && isQuotaExceeded(payload);
      throw new AiProviderError(`AI provider request failed: ${detail}`, { status: response.status, provider: providerName(), retryAfterMs, quotaExceeded });
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new AiProviderError('AI provider request timed out', { status: 504, provider: providerName() });
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError(`AI provider is unavailable: ${error.message}`, { provider: providerName() });
  } finally {
    clearTimeout(timer);
  }
}

async function geminiJson({ system, prompt, schema }) {
  const base = (config.externalAi.url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const url = `${base}/models/${encodeURIComponent(config.externalAi.model)}:generateContent`;
  const userText = `${prompt}\n\nRespond with only JSON matching this schema. Do not add markdown or commentary.\nJSON schema:\n${JSON.stringify(schema)}`;
  const payload = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.externalAi.key
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  const text = extractGeminiText(payload);
  if (!text) throw new AiProviderError('Gemini returned an empty response', { provider: 'gemini' });
  try { return JSON.parse(stripCodeFence(text)); }
  catch { throw new AiProviderError('Gemini returned invalid structured JSON', { provider: 'gemini' }); }
}

async function openAiCompatibleJson({ system, prompt, schema }) {
  const base = (config.externalAi.url || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const payload = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.externalAi.key}`
    },
    body: JSON.stringify({
      model: config.externalAi.model,
      temperature: 0.35,
      messages: [
        { role: 'system', content: `${system}\nReturn only JSON matching the requested schema. Do not add markdown.` },
        { role: 'user', content: `${prompt}\n\nJSON schema:\n${JSON.stringify(schema)}` }
      ],
      response_format: { type: 'json_object' }
    })
  });
  const text = payload?.choices?.[0]?.message?.content || '';
  if (!text) throw new AiProviderError('AI provider returned an empty response', { provider: providerName() });
  try { return JSON.parse(stripCodeFence(text)); }
  catch { throw new AiProviderError('AI provider returned invalid JSON', { provider: providerName() }); }
}

function isRetryable(error) {
  return error instanceof AiProviderError && [429, 503, 504].includes(error.status);
}

async function callProvider(providerId, { system, prompt, schema }) {
  if (providerId === 'gemini') return geminiJson({ system, prompt, schema });
  if (['openai', 'openai_compatible', 'groq'].includes(providerId)) return openAiCompatibleJson({ system, prompt, schema });
  throw new AiProviderError(`Unsupported AI_PROVIDER: ${providerId}`, { status: 500, provider: providerId });
}

// Single chokepoint every AI call in this app goes through. `reason`/`context` are optional,
// content-free tags (e.g. "brief_analysis", "brief:42") used only for logging — never the brief
// or prompt text itself, and never the API key.
async function generateJson({ system, prompt, schema, reason = '', context = '' } = {}) {
  if (!enabled()) throw new AiProviderError('External AI is not configured', { status: 503, provider: 'local_fallback' });

  const providerId = String(config.externalAi.provider || 'gemini').toLowerCase();
  const requestNumber = nextRequestNumber();
  const logFields = { request: requestNumber, model: config.externalAi.model, context, reason };

  if (inQuotaCooldown()) {
    logEvent('skip_quota_cooldown', { ...logFields, cooldown_remaining_ms: quotaCooldownUntil - Date.now() });
    throw new AiProviderError('AI provider quota is exhausted; skipping request until the cooldown clears', { status: 429, provider: providerName(), quotaExceeded: true });
  }

  await acquireSlot();
  try {
    const maxAttempts = 1 + Math.max(0, config.externalAi.maxRetries);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      logEvent('request', { ...logFields, attempt });
      try {
        const result = await callProvider(providerId, { system, prompt, schema });
        logEvent('success', { ...logFields, attempt });
        return result;
      } catch (rawError) {
        const error = rawError instanceof AiProviderError ? rawError : new AiProviderError(String(rawError?.message || rawError), { provider: providerName() });
        if (error.quotaExceeded) {
          setQuotaCooldown(error.retryAfterMs && error.retryAfterMs <= 120_000 ? error.retryAfterMs : 60_000);
        }
        const canRetry = attempt < maxAttempts && isRetryable(error) && !error.quotaExceeded;
        logEvent('error', {
          ...logFields,
          attempt,
          status: error.status,
          error_type: error.quotaExceeded ? 'quota_exceeded' : error.name,
          will_retry: canRetry
        });
        if (!canRetry) throw error;
        const backoffMs = error.retryAfterMs !== null && error.retryAfterMs !== undefined
          ? Math.min(error.retryAfterMs, 15_000)
          : Math.min(1000 * (2 ** (attempt - 1)), 8000) + Math.floor(Math.random() * 250);
        logEvent('retry_wait', { ...logFields, attempt, delay_ms: backoffMs });
        await sleep(backoffMs);
      }
    }
  } finally {
    releaseSlot();
  }
  // Unreachable: the loop above always returns or throws.
  throw new AiProviderError('AI request failed for an unknown reason', { provider: providerName() });
}

module.exports = { AiProviderError, enabled, providerName, status, generateJson };
