'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ALLOW_EXTERNAL_AI = 'true';
process.env.AI_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-key';
process.env.AI_MODEL = 'gemini-3-flash-preview';

const provider = require('../src/aiProvider');

test('Gemini structured response is parsed through the server-side AI provider', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3-flash-preview:generateContent/);
    assert.equal(options.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(options.body);
    assert.ok(Array.isArray(body.contents) && body.contents[0].parts[0].text.includes('test'));
    assert.equal(body.systemInstruction.parts[0].text, 'test');
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '{"suggestion":"Better scope","rationale":"More specific"}' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await provider.generateJson({ system: 'test', prompt: 'test', schema: { type:'object', properties:{ suggestion:{type:'string'}, rationale:{type:'string'} }, required:['suggestion','rationale'] } });
    assert.equal(result.suggestion, 'Better scope');
  } finally { global.fetch = originalFetch; }
});
