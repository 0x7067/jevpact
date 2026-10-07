import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_TOKENS, renderMessageTemplate, validateMessageTemplate } from '../src/message-template.js';

const snapshot = {
  sessionId: '11111111-1111-1111-1111-111111111111',
  latestUserDirection: { text: 'Continue the delegated review.' },
  recentUserRequests: [
    { origin: 'ordinary', text: 'Inspect the parser.' },
    { origin: 'heartbeat', text: 'Internal heartbeat.' },
    { origin: 'answer', text: 'Check the current branch too.' },
  ],
  messages: [
    { role: 'assistant', phase: 'commentary', text: 'I am checking the parser.' },
    { role: 'assistant', phase: 'final', text: 'Parser check complete; branch check remains.' },
  ],
  recentFinalReports: [{ text: 'Parser check complete; branch check remains.' }],
  toolCalls: [
    { name: 'exec', namespace: 'functions', input: 'rg parser src', resultObserved: true },
    { name: 'read_thread', namespace: 'codex_app', input: '{"threadId":"child"}', resultObserved: false },
  ],
  lastToolResult: { name: 'exec', text: 'Found parser source.' },
  usage: { inputTokens: 220000, contextWindow: 498750, recentGrowthTokens: 3000 },
  requestsSinceCompaction: 5,
  compactionGeneration: 2,
};

test('message tokens render visible checkpoint data, scope, and bounded tool activity', () => {
  const value = renderMessageTemplate([
    '{{user.latestPrompt}}', '{{user.recentPrompts:2}}', '{{assistant.latestMessage}}',
    '{{assistant.latestFinal}}', '{{assistant.recentMessages:2}}', '{{work.latestDirection}}',
    '{{pause.wrapUp}}', '{{assistant.lastBeforeCompaction}}', '{{tools.recentCalls:2}}',
    '{{tools.pendingCalls}}', '{{tools.lastResult}}', '{{lifecycle.phase}}', '{{lifecycle.reason}}',
    '{{lifecycle.trigger}}', '{{context.inputTokens}}', '{{context.windowTokens}}',
    '{{context.recentGrowthTokens}}', '{{context.requestsSinceCompaction}}',
    '{{compaction.generation}}', '{{thread.id}}', '{{project.root}}', '{{profile.name}}',
  ].join('\n'), {
    snapshot, phase: 'resume', reason: 'native-compaction-complete', trigger: 'semantic',
    pauseWrapUp: 'Finish this check next.', lastBeforeCompaction: 'The connected step is finished.',
    projectRoot: '/tmp/project', profileName: 'deep-work', compactionGeneration: 3,
  });
  assert.match(value, /Check the current branch too/);
  assert.match(value, /Inspect the parser/);
  assert.doesNotMatch(value, /Internal heartbeat/);
  assert.match(value, /Parser check complete; branch check remains/);
  assert.match(value, /Finish this check next/);
  assert.match(value, /The connected step is finished/);
  assert.match(value, /functions\.exec \(result observed\)/);
  assert.match(value, /codex_app\.read_thread \(result not observed\)/);
  assert.match(value, /Found parser source/);
  assert.match(value, /220000\n498750\n3000\n5\n3/);
  assert.match(value, /\/tmp\/project\ndeep-work$/);
});

test('tokens work anywhere, report unavailable stage data, and never expand copied text again', () => {
  const from = structuredClone(snapshot);
  from.latestUserDirection.text = 'The user literally wrote {{thread.id}}.';
  const value = renderMessageTemplate('Begin {{pause.wrapUp}} / {{work.latestDirection}} / end', {
    snapshot: from, phase: 'pause', reason: 'pressure', trigger: 'pressure',
  });
  assert.match(value, /\[unavailable: pause\.wrapUp\]/);
  assert.match(value, /literally wrote \{\{thread\.id\}\}/);
  assert.equal(renderMessageTemplate('Literal \\{{thread.id}}', { snapshot }), 'Literal {{thread.id}}');
});

test('template validation rejects unsupported tokens and keeps expanded text bounded', () => {
  assert.ok(MESSAGE_TOKENS.some(item => item.token === 'assistant.lastBeforeCompaction'));
  assert.throws(() => validateMessageTemplate('{{unknown.value}}'), /unknown message token/);
  assert.throws(() => validateMessageTemplate('{{user.recentPrompts:11}}'), /count must be 1-10/);
  assert.throws(() => validateMessageTemplate('{{compaction.recordText}}'), /native compaction content is encrypted/);
  assert.throws(() => validateMessageTemplate('{{assistant.latestFinal'), /unclosed message token/);
  const from = structuredClone(snapshot);
  from.messages.push({ role: 'assistant', phase: 'final', text: 'A'.repeat(6000) });
  const output = renderMessageTemplate('{{assistant.latestMessage}}'.repeat(10) + '\nKEEP THE NEXT ACTION', { snapshot: from });
  assert.ok(output.length <= 20_000);
  assert.ok(output.endsWith('\nKEEP THE NEXT ACTION'));
  assert.match(output, /\[truncated\]/);
});
