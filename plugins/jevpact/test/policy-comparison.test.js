import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { schedulingPolicy, summarizeRollout, summarizeReport } from '../eval/policy-comparison.mjs';

const input = () => ({ usage: { inputTokens: 60000, contextWindow: 498750, recentGrowthTokens: 1000 },
  baseline: { inputTokens: 30000 }, requestsSinceCompact: 5, turnStatus: 'active',
  chronology: { latestAssistantSequence: 10, latestOmittedActivitySequence: 8 },
  config: { minInputTokens: 40000, minGrowthTokens: 8000, minRequests: 3, nativeLimitTokens: 450000 } });

test('fixed baseline uses measured pressure and requests no initial semantic answer', () => {
  const policy = schedulingPolicy('fixed', { fixedThresholdTokens: 60000 });
  assert.deepEqual(policy(input()), { action: 'checkpoint', kind: 'semantic', requiresSignals: false, reason: 'Fixed threshold reached' });
  const current = input(); current.usage.inputTokens = 59000;
  assert.equal(policy(current).action, 'wait');
  current.usage.inputTokens = 410000;
  assert.equal(policy(current).kind, 'pressure');
});

test('end-turn baseline waits for actual idle and shares deterministic visibility protection', () => {
  const policy = schedulingPolicy('end-turn');
  const current = input();
  assert.equal(policy(current).action, 'wait');
  current.turnStatus = 'idle';
  assert.equal(policy(current).action, 'checkpoint');
  current.chronology.latestOmittedActivitySequence = 11;
  assert.equal(policy(current).action, 'wait');
  current.usage.inputTokens = 410000;
  assert.equal(policy(current).kind, 'pressure');
});

test('baselines preserve common eligibility and Jev policy does not fabricate answers', () => {
  for (const name of ['fixed', 'end-turn']) {
    const current = input(); current.requestsSinceCompact = 1;
    assert.equal(schedulingPolicy(name, { fixedThresholdTokens: 60000 })(current).kind, 'ineligible');
  }
  assert.equal(schedulingPolicy('jev')(input()).action, 'wait');
  assert.throws(() => schedulingPolicy('fixed'), /positive fixed threshold/);
});

test('actual canonical usage is deduplicated; missing cache usage stays unknown', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jevpact-comparison-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'rollout.jsonl');
  const records = [
    { type: 'turn_context', payload: { model: 'same-model', effort: 'high' } },
    { type: 'event_msg', timestamp: '2026-09-21T20:00:00Z', payload: { type: 'task_started', turn_id: 'continued', model_context_window: 498750 } },
    { type: 'token_usage_record', payload: { response_id: 'r1', turn_id: 'continued', usage: { input_tokens: 50000, output_tokens: 400 } } },
    { type: 'token_usage_record', payload: { response_id: 'r1', turn_id: 'continued', usage: { input_tokens: 50000, output_tokens: 400 } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50000 } } } },
    { type: 'event_msg', timestamp: '2026-09-21T20:00:10Z', payload: { type: 'task_complete', turn_id: 'continued', final_answer: 'Source-specific result, retained privately.' } },
  ];
  await writeFile(filename, records.map(item => JSON.stringify(item)).join('\n'));
  const rollout = await summarizeRollout(filename);
  assert.equal(rollout.requests, 1);
  assert.equal(rollout.totals.input_tokens, 50000);
  assert.equal(rollout.totals.cached_input_tokens, null);
  assert.equal(rollout.activeMs, 10000);
  assert.deepEqual(rollout.effectiveWindows, [498750]);
  const summary = summarizeReport({ policy: 'fixed', threadId: 'native', calibration: true, nativeModel: 'same-model',
    startedAt: '2026-09-21T20:00:00Z', finishedAt: '2026-09-21T20:00:11Z', rollout,
    events: [{ type: 'native-pause-message-accepted', expectedTurnId: 'paused', turnId: 'paused' },
      { type: 'native-resume-accepted', turnId: 'continued' }], decisions: [], omittedEvents: 0,
    sourceBefore: { fingerprint: 'same' }, sourceAfter: { fingerprint: 'same' } });
  assert.equal(summary.resumedTurns[0].completed, true);
  assert.equal(summary.resumedTurns[0].requests, 1);
  assert.equal(summary.pauseMessagesAccepted, 1);
  assert.equal(summary.pauseReceiptTurnMismatches, 0);
  assert.equal(summary.qualityAssessment, null);
  assert.ok(!JSON.stringify(summary).includes('Source-specific result'));
});
