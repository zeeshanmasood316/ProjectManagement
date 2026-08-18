'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ALLOW_EXTERNAL_AI = 'true';
process.env.AI_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-key';
process.env.AI_MODEL = 'gemini-test-model';
process.env.AI_MAX_RETRIES = '2';

const ai = require('../src/aiEngine');

function geminiResponse(jsonBody) {
  return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(jsonBody) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function geminiErrorResponse(httpStatus, { message = 'error', errStatus = '', retryDelay } = {}) {
  const details = retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : undefined;
  const body = { error: { code: httpStatus, message, status: errStatus, details } };
  return new Response(JSON.stringify(body), { status: httpStatus, headers: { 'content-type': 'application/json' } });
}

const baseProject = { id: 101, organization_id: 55, name: 'Test Project', client_name: '' };
const members = [];
const teams = [{ id: 1, name: 'Engineering Team', department_name: 'Engineering' }];

// Comfortably over the old 6000-char chunk threshold, to prove a long brief no longer fans out
// into a chunk-digest request per ~4000 characters.
function bigBrief(seed) {
  const paragraph = `This is a detailed requirement paragraph about ${seed} covering objectives, deliverables, and constraints for the project team to review carefully. `;
  return paragraph.repeat(80);
}

const validPlan = {
  project: { name: 'Test Project', client_name: '', objective: 'Ship the thing', scope: 'In scope', constraints: '', priority: 'medium', start_date: null, due_date: null },
  departments: [], milestones: [], risks: [], assumptions: [],
  stories: [{
    name: 'Story A', description: 'desc', department: '', priority: 'medium', status: 'not_started', start_date: null,
    source: 'inferred', source_note: 'n/a', team_name: '', team_confidence: 0, team_reason: '',
    tasks: [{
      title: 'Task A', description: 'desc', priority: 'medium', status: 'not_started', due_date: null, tags: [],
      estimated_hours: null, source: 'inferred', source_note: 'n/a', team_name: '', team_confidence: 0, team_reason: '', subtasks: []
    }]
  }]
};

test('a long brief triggers exactly one AI request, not a chunk-digest call per chunk', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => { callCount += 1; return geminiResponse(validPlan); };
  try {
    const result = await ai.analyzeProjectBrief(baseProject, members, bigBrief('alpha'), () => {}, teams);
    assert.equal(callCount, 1, 'exactly one Gemini request should be made for one brief analysis, regardless of brief length');
    assert.equal(result.fallback, false);
    assert.equal(result.item.stories.length, 1);
  } finally { global.fetch = originalFetch; }
});

test('a transient 429 with a short server-provided retry delay is retried and then succeeds', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    if (callCount === 1) return geminiErrorResponse(429, { message: 'Too many requests, please retry shortly', retryDelay: '0.05s' });
    return geminiResponse(validPlan);
  };
  try {
    const result = await ai.analyzeProjectBrief({ ...baseProject, id: 102 }, members, bigBrief('beta-retry'), () => {}, teams);
    assert.equal(callCount, 2, 'a transient 429 should be retried once, honoring the short server-provided retry delay');
    assert.equal(result.fallback, false);
  } finally { global.fetch = originalFetch; }
});

test('identical brief content submitted twice is served from cache the second time, with no second AI request', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => { callCount += 1; return geminiResponse(validPlan); };
  const text = bigBrief('gamma-cache');
  const project = { ...baseProject, id: 103 };
  try {
    const first = await ai.analyzeProjectBrief(project, members, text, () => {}, teams);
    const second = await ai.analyzeProjectBrief(project, members, text, () => {}, teams);
    assert.equal(callCount, 1, 'resubmitting the exact same brief text must be served from cache, not call the AI provider again');
    assert.deepEqual(second.item, first.item);
  } finally { global.fetch = originalFetch; }
});

test('two concurrent submissions of the identical brief are deduped onto a single in-flight AI request', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  let releaseFetch;
  global.fetch = async () => {
    callCount += 1;
    await new Promise(resolve => { releaseFetch = resolve; });
    return geminiResponse(validPlan);
  };
  const text = bigBrief('delta-dedup');
  const project = { ...baseProject, id: 104 };
  try {
    const first = ai.analyzeProjectBrief(project, members, text, () => {}, teams);
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = ai.analyzeProjectBrief(project, members, text, () => {}, teams);
    releaseFetch();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(callCount, 1, 'a duplicate concurrent analysis of the same brief must not start a second AI call — it should reuse the in-flight one');
    assert.deepEqual(firstResult.item, secondResult.item);
  } finally { global.fetch = originalFetch; }
});

test('a quota-exceeded 429 is not retried and degrades cleanly to the local fallback engine', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    return geminiErrorResponse(429, { message: 'Quota exceeded for quota metric free_tier_requests', errStatus: 'RESOURCE_EXHAUSTED' });
  };
  const project = { ...baseProject, id: 105 };
  try {
    const result = await ai.analyzeProjectBrief(project, members, bigBrief('epsilon-quota'), () => {}, teams);
    assert.equal(callCount, 1, 'a quota-exceeded error must not be retried, since further attempts would obviously fail the same way');
    assert.equal(result.fallback, true);
    assert.equal(result.provider, 'local_javascript_engine');
  } finally { global.fetch = originalFetch; }
});
