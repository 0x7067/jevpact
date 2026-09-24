import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildRequest, evaluate, validateAnswers, QUESTIONS, PAUSE_QUESTIONS, TIMING2_QUESTIONS, DEFAULT_MODEL } from '../src/jev.js';

function answers(questions = QUESTIONS) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const choices = Object.keys(question.criteria);
    return [id, { type: 'choice', choice: 'unknown', probabilities: Object.fromEntries(choices.map(choice => [choice, choice === 'unknown' ? 0.9 : 0.1 / (choices.length - 1)])), confidence: 0.7 }];
  }));
}

async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}/v1/systemone`;
}

test('four questions share one bounded state and preserve input', () => {
  const excerpt = { objective: 'Fix clock', messages: ['Check traces', 'Resolved'] };
  const request = buildRequest(excerpt);
  assert.deepEqual(request.state.excerpt, excerpt);
  assert.equal(Object.keys(request.questions).length, 4);
  assert.ok(request.questions.settled.criteria.not_applicable);
  request.state.excerpt.messages.push('mutated');
  assert.equal(excerpt.messages.length, 2);
  assert.throws(() => buildRequest('é'.repeat(13000)), { code: 'jev-request-too-large', message: /24 KiB/ });
  assert.throws(() => buildRequest(''), { code: 'jev-invalid-excerpt', message: /nonempty/ });
});

test('selected probability and distribution confidence remain distinct', () => {
  const result = validateAnswers(answers());
  assert.equal(result.boundary.probability, 0.9);
  assert.equal(result.boundary.confidence, 0.7);
  assert.equal(result.boundary.choice, 'unknown');
});

test('source-linked timing has a separate four-question schema and strict answers', () => {
  const request = buildRequest({ currentUser: { text: 'Fix it.' }, currentReport: { text: 'Fixed.' } }, { purpose: 'timing2' });
  assert.deepEqual(Object.keys(request.questions), ['relation', 'open_result', 'settled', 'next']);
  assert.deepEqual(Object.keys(validateAnswers(answers(TIMING2_QUESTIONS), { purpose: 'timing2' })),
    ['relation', 'open_result', 'settled', 'next']);
  assert.throws(() => validateAnswers(answers(), { purpose: 'timing2' }), { code: 'jev-invalid-response' });
});

test('diagnostics receive the exact redacted request even when the HTTP request fails', async t => {
  const key = 'diagnostic-test-key';
  let sent;
  const endpoint = await server(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks).toString());
    response.statusCode = 503; response.end('Unavailable');
  });
  let retained;
  await assert.rejects(evaluate(`Visible message with ${key}`, {
    apiKey: key, endpoint, onRequest: request => { retained = structuredClone(request); request.model = 'observer-mutated'; },
  }), { code: 'jev-http-503' });
  assert.deepEqual(retained, sent);
  assert.ok(!JSON.stringify(retained).includes(key));
  assert.equal(sent.model, DEFAULT_MODEL);
});

test('a failed diagnostic sink does not prevent the Jev request', async t => {
  const endpoint = await server(t, (_, response) => response.end(JSON.stringify({ model: 'test', answers: answers() })));
  const result = await evaluate('Bounded evidence', { apiKey: 'test-key', endpoint,
    onRequest: () => { throw new Error('disk-full'); } });
  assert.equal(result.model, 'test');
});

for (const [name, mutate] of Object.entries({
  missing: value => { delete value.boundary; },
  extra: value => { value.extra = value.boundary; },
  type: value => { value.boundary.type = 'score'; },
  choice: value => { value.boundary.choice = 'invented'; },
  missingProbability: value => { delete value.boundary.probabilities.no; },
  extraProbability: value => { value.boundary.probabilities.maybe = 0; },
  nonfinite: value => { value.boundary.probabilities.no = NaN; },
  stringProbability: value => { value.boundary.probabilities.no = '0.05'; },
  wrongSum: value => { value.boundary.probabilities.no = 0.5; },
  notMaximal: value => { value.boundary.choice = 'no'; },
  missingConfidence: value => { delete value.boundary.confidence; },
  wrongConfidence: value => { value.boundary.confidence = Infinity; },
  inconsistentProbability: value => { value.boundary.probability = 0.8; },
})) {
  test(`strict response validation rejects ${name}`, () => {
    const value = answers(); mutate(value);
    assert.throws(() => validateAnswers(value), { code: 'jev-invalid-response', message: /Invalid Jev response/ });
  });
}

test('live transport sends shared request, strips exact key, and retains exact response', async t => {
  const key = 'test-secret-123';
  const payload = JSON.stringify({ model: 'resolved-model', answers: answers(), usage: { input_tokens: 100 } });
  let observed;
  const endpoint = await server(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    observed = { authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() };
    response.setHeader('Content-Type', 'application/json'); response.end(payload);
  });
  const result = await evaluate({ messages: [`User supplied ${key}`, { [key]: key }] }, { apiKey: key, endpoint });
  assert.equal(observed.authorization, `Bearer ${key}`);
  assert.ok(!observed.body.includes(key));
  assert.ok(observed.body.includes('[REDACTED_JEV_KEY]'));
  assert.equal(result.request.model, DEFAULT_MODEL);
  assert.equal(result.model, 'resolved-model');
  assert.equal(result.response, payload);
  assert.ok(result.latencyMs >= 0);
});

test('TEST credential takes precedence over API; explicit key overrides both', async t => {
  const previous = { test: process.env.JEV_TEST_KEY, api: process.env.JEV_API_KEY };
  t.after(() => {
    for (const [name, value] of [['JEV_TEST_KEY', previous.test], ['JEV_API_KEY', previous.api]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.JEV_TEST_KEY = 'test-key'; process.env.JEV_API_KEY = 'api-key';
  const headers = [];
  const endpoint = await server(t, (request, response) => {
    headers.push(request.headers.authorization);
    response.end(JSON.stringify({ model: 'test', answers: answers() }));
  });
  await evaluate('Visible excerpt', { endpoint });
  await evaluate('Visible excerpt', { endpoint, apiKey: 'explicit-key' });
  process.env.JEV_TEST_KEY = '';
  await evaluate('Visible excerpt', { endpoint });
  assert.deepEqual(headers, ['Bearer test-key', 'Bearer explicit-key', 'Bearer api-key']);
});

test('HTTP errors do not return provider body or retry', async t => {
  let calls = 0;
  const endpoint = await server(t, (request, response) => { calls++; response.writeHead(429); response.end('private provider details'); });
  await assert.rejects(evaluate('Excerpt', { endpoint, apiKey: 'key' }), { code: 'jev-http-429', message: 'Jev HTTP 429; no automatic retry' });
  assert.equal(calls, 1);
});

test('redirects cannot forward credentials', async t => {
  const endpoint = await server(t, (request, response) => { response.writeHead(302, { Location: '/other' }); response.end(); });
  await assert.rejects(evaluate('Excerpt', { endpoint, apiKey: 'key' }), { code: 'jev-transport', message: /transport failed/ });
});

test('aborted request and unsafe endpoint fail closed', async () => {
  await assert.rejects(evaluate('Excerpt', { apiKey: 'key', signal: AbortSignal.abort() }), { code: 'jev-aborted', message: /aborted/ });
  for (const endpoint of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?key=secret']) {
    await assert.rejects(evaluate('Excerpt', { endpoint, apiKey: 'key' }), { code: 'jev-invalid-endpoint', message: /Invalid configured/ });
  }
});

test('malformed, model-free, oversized, or credential-echoing successful responses fail closed', async t => {
  for (const [body, code] of [
    ['not JSON', 'jev-invalid-response'],
    [JSON.stringify({ answers: answers() }), 'jev-invalid-response'],
    ['x'.repeat(1024 * 1024 + 1), 'jev-response-too-large'],
    [JSON.stringify({ model: 'test', answers: answers(), debug: 'test-secret-123' }), 'jev-credential-echo'],
  ]) {
    const endpoint = await server(t, (request, response) => response.end(body));
    await assert.rejects(evaluate('Excerpt', { endpoint, apiKey: 'test-secret-123' }), { code });
  }
});

test('request construction and invalid configuration expose safe stable codes', async () => {
  const circular = {}; circular.self = circular;
  assert.throws(() => buildRequest(circular), { code: 'jev-invalid-excerpt' });
  assert.throws(() => buildRequest({ value: 1n }), { code: 'jev-invalid-excerpt' });
  await assert.rejects(evaluate(circular, { apiKey: 'key' }), { code: 'jev-invalid-excerpt' });
  await assert.rejects(evaluate('Excerpt', { apiKey: '' }), { code: 'missing-key' });
  await assert.rejects(evaluate('Excerpt', { apiKey: 'key', model: '' }), { code: 'jev-invalid-model' });
  await assert.rejects(evaluate('Excerpt', { apiKey: 'key', signal: {} }), { code: 'jev-invalid-signal' });
});

test('caller cancellation drops a potentially sensitive abort reason', async t => {
  const controller = new AbortController();
  const endpoint = await server(t, (request, response) => {
    response.writeHead(200); response.write('{"model":');
    setTimeout(() => controller.abort(new Error('private cancellation detail')), 5);
  });
  await assert.rejects(evaluate('Excerpt', { endpoint, apiKey: 'key', signal: controller.signal }), error => {
    assert.equal(error.code, 'jev-aborted');
    assert.equal(error.message, 'Jev request aborted');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('a timed-out response stream is distinct from caller cancellation', async t => {
  const endpoint = await server(t, (request, response) => {
    response.writeHead(200); response.write('{"model":');
  });
  await assert.rejects(evaluate('Excerpt', { endpoint, apiKey: 'key', signal: AbortSignal.timeout(20) }), { code: 'jev-timeout', message: 'Jev request timed out' });
});

test('a disconnected response stream retains a transport diagnosis', async t => {
  const endpoint = await server(t, (request, response) => {
    response.writeHead(200); response.write('{"model":');
    setTimeout(() => response.destroy(), 5);
  });
  await assert.rejects(evaluate('Excerpt', { endpoint, apiKey: 'key' }), { code: 'jev-transport', message: 'Jev transport failed' });
});

test('pause purpose asks only for a deferral veto and continuation', () => {
  const ordinary = buildRequest('The diagnosis is complete; integration verification remains.');
  const pause = buildRequest('The diagnosis is complete; integration verification remains.', { purpose: 'pause' });
  assert.deepEqual(Object.keys(ordinary.questions), ['boundary', 'continuity', 'open_result', 'settled']);
  assert.deepEqual(Object.keys(pause.questions), ['deferral', 'continuation']);
  assert.deepEqual(Object.keys(pause.questions.deferral.criteria), ['yes', 'no', 'unknown']);
  assert.equal(validateAnswers(answers(PAUSE_QUESTIONS), { purpose: 'pause' }).continuation.choice, 'unknown');
  assert.throws(() => validateAnswers(answers(), { purpose: 'pause' }), { code: 'jev-invalid-response' });
  assert.throws(() => validateAnswers(answers(PAUSE_QUESTIONS)), { code: 'jev-invalid-response' });
  const incomplete = answers(PAUSE_QUESTIONS); delete incomplete.continuation;
  assert.throws(() => validateAnswers(incomplete, { purpose: 'pause' }), { code: 'jev-invalid-response' });
  assert.throws(() => buildRequest('Excerpt', { purpose: 'other' }), { code: 'jev-invalid-purpose' });
});

test('pause-purpose transport sends and validates only its two requested questions', async t => {
  let questionIds;
  const endpoint = await server(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    questionIds = Object.keys(JSON.parse(Buffer.concat(chunks).toString()).questions);
    response.end(JSON.stringify({ model: 'test', answers: answers(PAUSE_QUESTIONS) }));
  });
  const result = await evaluate('The bounded review is complete. No additional task remains.', { endpoint, apiKey: 'key', purpose: 'pause' });
  assert.deepEqual(questionIds, ['deferral', 'continuation']);
  assert.equal(result.answers.continuation.choice, 'unknown');
  await assert.rejects(evaluate('Excerpt', { apiKey: 'key', purpose: 'other' }), { code: 'jev-invalid-purpose' });
});
