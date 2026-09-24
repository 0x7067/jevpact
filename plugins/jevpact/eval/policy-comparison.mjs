#!/usr/bin/env node
// Explicit working-task experiment: no task creation, polling, or forced pressure.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../src/daemon.js';
import { Codex } from '../src/codex.js';
import { RESUME_PREFIX } from '../src/controller.js';
import { call } from '../src/rpc.js';
import { decide, hasUninterpretedActivity, DEFAULT_POLICY } from '../src/policy.js';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const policies = ['jev', 'fixed', 'end-turn'];
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Baselines use the common eligibility, visibility, headroom, and execution checks. */
export function schedulingPolicy(policy, { fixedThresholdTokens } = {}) {
  if (!policies.includes(policy)) throw new Error('Unknown comparison policy');
  if (policy === 'fixed' && (!count(fixedThresholdTokens) || fixedThresholdTokens === 0)) throw new Error('A positive fixed threshold must be frozen before the run');
  return input => {
    if (policy === 'jev') return decide(input);
    const common = decide({ ...input, signals: undefined });
    if (common.kind === 'ineligible' || common.kind === 'pressure') return { ...common, requiresSignals: false };
    if (input.chronology !== undefined && hasUninterpretedActivity(input.chronology)) return { ...common, requiresSignals: false };
    const checkpoint = policy === 'fixed' ? input.usage.inputTokens >= fixedThresholdTokens : input.turnStatus === 'idle';
    return { action: checkpoint ? 'checkpoint' : 'wait', kind: 'semantic', requiresSignals: false,
      reason: policy === 'fixed' ? `Fixed threshold ${checkpoint ? 'reached' : 'not reached'}` : `Eligible end of turn ${checkpoint ? 'observed' : 'not observed'}` };
  };
}

/** Only canonical usage contributes totals; duplicate token_count events are excluded. */
export async function summarizeRollout(filename) {
  const ids = new Set();
  const totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const present = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const usage = [], lifecycle = [], finals = [], settings = [], windows = new Set();
  let malformedLines = 0;
  const lines = createInterface({ input: createReadStream(filename), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { malformedLines++; continue; }
    const p = record.payload ?? {};
    const window = record.type === 'event_msg' ? p.model_context_window ?? p.info?.model_context_window : p.model_context_window;
    if (count(window) && window > 0) windows.add(window);
    if (record.type === 'token_usage_record' && typeof p.response_id === 'string' && !ids.has(p.response_id)) {
      ids.add(p.response_id);
      const values = { input_tokens: p.usage?.input_tokens,
        cached_input_tokens: p.usage?.cached_input_tokens ?? p.usage?.input_tokens_details?.cached_tokens,
        output_tokens: p.usage?.output_tokens };
      for (const key of Object.keys(totals)) if (count(values[key])) { totals[key] += values[key]; present[key]++; }
      usage.push({ at: record.timestamp, responseId: p.response_id, turnId: p.turn_id ?? null,
        ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, count(value) ? value : null])) });
    } else if (record.type === 'turn_context') {
      settings.push({ model: p.model ?? p.model_slug ?? null,
        effort: p.effort ?? p.reasoning_effort ?? p.reasoning?.effort ?? null,
        contextWindow: p.model_context_window ?? null });
    } else if (record.type === 'compacted') {
      lifecycle.push({ at: record.timestamp, type: 'compacted', turnId: p.turn_id ?? null });
    } else if (record.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) {
      lifecycle.push({ at: record.timestamp, type: p.type, turnId: p.turn_id ?? null });
      if (p.type === 'task_complete') {
        const text = p.final_answer ?? p.last_agent_message;
        if (typeof text === 'string') finals.push({ at: record.timestamp, turnId: p.turn_id ?? null, text });
      }
    }
  }
  const active = new Map();
  let activeMs = 0;
  for (const event of lifecycle) {
    const time = Date.parse(event.at);
    if (!Number.isFinite(time)) continue;
    if (event.type === 'task_started') active.set(event.turnId, time);
    else if (['task_complete', 'turn_aborted'].includes(event.type) && active.has(event.turnId)) {
      activeMs += Math.max(0, time - active.get(event.turnId)); active.delete(event.turnId);
    }
  }
  return { requests: ids.size, totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, present[key] === ids.size ? value : null])),
    usageCoverage: present, usage, lifecycle, finals, settings, effectiveWindows: [...windows], activeMs, unfinishedTurns: active.size, malformedLines };
}

export function summarizeReport(report) {
  const resumed = report.events.filter(event => event.type === 'native-resume-accepted').map(event => {
    const turnId = event.turnId;
    return { turnId, afterCompaction: event.afterCompaction ?? null, requests: report.rollout.usage.filter(item => item.turnId === turnId).length,
      completed: report.rollout.lifecycle.some(item => item.turnId === turnId && item.type === 'task_complete'),
      aborted: report.rollout.lifecycle.some(item => item.turnId === turnId && item.type === 'turn_aborted'),
      finalAnswerPresent: report.rollout.finals.some(item => item.turnId === turnId) };
  });
  const jev = report.decisions.filter(item => item.event === 'assessed' && item.latencyMs != null);
  const pause = report.decisions.filter(item => item.event === 'pause-checked');
  const started = Date.parse(report.startedAt), finished = Date.parse(report.finishedAt);
  const actualModels = [...new Set(report.rollout.settings.map(item => item.model).filter(Boolean))];
  const actualEfforts = [...new Set(report.rollout.settings.map(item => item.effort).filter(Boolean))];
  return { policy: report.policy, threadId: report.threadId, calibration: report.calibration,
    recordedSettings: { nativeModel: report.nativeModel, actualModels, actualEfforts, effectiveWindows: report.rollout.effectiveWindows ?? [] },
    requests: report.rollout.requests, ...report.rollout.totals,
    activeMs: report.rollout.activeMs, elapsedMs: Number.isFinite(started + finished) ? finished - started : null,
    compactions: report.rollout.lifecycle.filter(item => item.type === 'compacted').length,
    pausesDelivered: report.decisions.filter(item => item.event === 'pause-delivered').length,
    pauseMessagesAccepted: report.events.filter(item => item.type === 'native-pause-message-accepted').length,
    pauseReceiptTurnMismatches: report.events.filter(item => item.type === 'native-pause-message-accepted' && item.turnId !== item.expectedTurnId).length,
    timingJevCallsCompleted: jev.length, postPauseJevCallsCompleted: pause.length,
    jevCompletedLatencyMs: [...jev, ...pause].reduce((sum, item) => sum + (item.latencyMs ?? 0), 0),
    staleAssessments: report.decisions.filter(item => item.event === 'stale-analysis').length,
    recoveryRequired: report.decisions.filter(item => item.event === 'recovery-required').length,
    resumedTurns: resumed, taskFinalAnswers: report.rollout.finals.length,
    sourceUnchanged: report.sourceBefore.fingerprint === report.sourceAfter.fingerprint,
    missingOrTruncatedEvidence: report.rollout.malformedLines > 0 || report.omittedEvents > 0,
    qualityAssessment: report.qualityAssessment ?? null,
    limitation: 'Actual observed work and usage only. Completion quality, reconstruction, duplicate work, and mistakes require review; they are not inferred from token totals.' };
}

async function sourceIdentity() {
  const roots = ['src', 'bin', 'scripts', 'hooks', '.codex-plugin', 'package.json', 'README.md', 'docs'];
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...roots], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const filename of files) { digest.update(filename + '\0'); digest.update(await fs.readFile(path.join(root, filename))); }
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), fingerprint: digest.digest('hex') };
}

async function nativeSettings() {
  const text = await fs.readFile(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
  const global = text.split(/^\s*\[/m)[0];
  const value = name => Number(global.match(new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)`, 'm'))?.[1]) || null;
  return { configuredContextWindow: value('model_context_window'), nativeLimitTokens: value('model_auto_compact_token_limit') };
}

function outputPath(value) {
  const result = path.resolve(root, value);
  if (!result.startsWith(path.join(root, 'eval/results') + path.sep)) throw new Error('Use an explicit ignored eval/results/<trial> output directory');
  return result;
}

export async function startTrial({ policy, threadId, config, out, calibration = false, reference }) {
  if (!/^[0-9a-f-]{36}$/.test(threadId ?? '')) throw new Error('An actual native thread ID is required');
  const decisionPolicy = schedulingPolicy(policy, config);
  const destination = outputPath(out);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.chmod(destination, 0o700);
  try { await call({ method: 'status' }); throw new Error('An existing controller owns the hook socket; do not replace it'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  const actualSettings = await nativeSettings();
  if (actualSettings.configuredContextWindow !== config.configuredContextWindow || actualSettings.nativeLimitTokens !== config.nativeLimitTokens) throw new Error('Native context settings differ from the frozen comparison configuration');
  if (config.nativeLimitTokens !== 450000 || config.expectedContextWindow !== 498750) throw new Error('This trial is bound to the verified 450000 fallback and 498750 effective window');
  const sourceBefore = await sourceIdentity();
  const transport = await Codex.connect();
  const native = await transport.status(threadId);
  if (native.cwd?.replace(/\/$/, '') !== root || !native.rolloutPath) { transport.close(); throw new Error('Comparison tasks must use the saved Jevpact checkout'); }
  const initialRollout = await summarizeRollout(native.rolloutPath);
  const report = { policy, threadId, calibration, config, actualSettings, sourceBefore, startedAt: new Date().toISOString(),
    nativeModel: native.model, attachedAtRequest: initialRollout.requests,
    events: [], decisions: [], omittedEvents: 0, qualityAssessment: null,
    limitation: 'Reduced eligibility floors are a mechanism-scale live comparison, not production timing validation. No actor receives desired labels or a readiness phrase.' };
  if (reference) {
    const baseline = JSON.parse(await fs.readFile(reference, 'utf8'));
    if (baseline.sourceBefore.fingerprint !== sourceBefore.fingerprint || JSON.stringify(baseline.nativeModel) !== JSON.stringify(native.model)
      || JSON.stringify(baseline.config) !== JSON.stringify(config)) { transport.close(); throw new Error('Source, model, or frozen configuration differs from the pilot/reference'); }
    const calibrationSummary = summarizeReport(baseline);
    if (baseline.calibration && (!calibrationSummary.sourceUnchanged || calibrationSummary.recoveryRequired
      || !calibrationSummary.taskFinalAnswers || baseline.rollout.unfinishedTurns > 0
      || calibrationSummary.missingOrTruncatedEvidence)) {
      transport.close(); throw new Error('Calibration must contain complete, unchanged-source working evidence without recovery or missing records');
    }
    // A pilot that finishes during cooperative wrap-up is a valid zero-cycle
    // outcome. Actual continuation remains an outcome of the matched arms,
    // not a reason to replay calibration until it yields a desired result.
    report.reference = path.resolve(reference);
    report.calibrationEvidence = calibrationSummary;
  }
  const record = (type, details = {}) => {
    if (report.events.length < 512) report.events.push({ at: new Date().toISOString(), type, ...details }); else report.omittedEvents++;
    console.log(JSON.stringify({ type, threadId, ...details }));
  };
  const compact = transport.compact.bind(transport), resume = transport.resume.bind(transport), steer = transport.steer.bind(transport);
  transport.steer = async (id, expectedTurnId, text, context) => {
    if (id !== threadId) throw new Error('Out-of-scope pause message refused');
    const result = await steer(id, expectedTurnId, text, context);
    record('native-pause-message-accepted', { expectedTurnId, turnId: result.turnId });
    return result;
  };
  transport.compact = async (id, context) => {
    if (id !== threadId) throw new Error('Out-of-scope compaction refused');
    const result = await compact(id, context); record('native-compact-accepted'); return result;
  };
  transport.resume = async (id, text, context) => {
    if (id !== threadId) throw new Error('Out-of-scope continuation refused');
    const result = await resume(id, text, context); record('native-resume-accepted', { turnId: result.turnId, afterCompaction: text.startsWith(RESUME_PREFIX) }); return result;
  };
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const runtimeConfig = { ...DEFAULT_POLICY, ...config.policyConfig, nativeLimitTokens: config.nativeLimitTokens };
  let completedCompactions = 0;
  const daemon = await serve({ config: runtimeConfig,
    decisionPolicy, transport, onlyThreads: [threadId],
    onDecision: (id, item) => {
      if (id !== threadId) return;
      if (report.decisions.length < 512) report.decisions.push(item); else report.omittedEvents++;
      if (item.event === 'compacted' && ++completedCompactions >= (config.maxCompactions ?? 1)) runtimeConfig.minRequests = Number.MAX_SAFE_INTEGER;
      if (['assessed', 'pause-delivered', 'pause-checked', 'compacted', 'resumed', 'recovery-required', 'unavailable'].includes(item.event)) {
        record('controller-decision', { event: item.event, action: item.action, kind: item.kind, reason: item.reason });
      }
    } });
  if (daemon.alreadyRunning) { transport.close(); throw new Error('Controller ownership changed before startup'); }
  const finalize = async () => {
    try {
      report.finishedAt = new Date().toISOString();
      report.rollout = await summarizeRollout(native.rolloutPath);
      report.sourceAfter = await sourceIdentity();
      report.summary = summarizeReport(report);
      await fs.writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ type: 'finished', report: path.relative(root, path.join(destination, 'report.json')), summary: report.summary }));
    } catch (error) { console.log(JSON.stringify({ type: 'export-failed', code: error.code ?? error.name })); }
    finally { resolveFinished(); }
  };
  daemon.server.once('close', finalize);
  await fs.writeFile(path.join(destination, 'running.json'), JSON.stringify({ pid: process.pid, threadId, policy, out: destination }), { mode: 0o600 });
  await daemon.dispatch({ method: 'attach', threadId });
  const state = await daemon.dispatch({ method: 'status' });
  const window = state.threads[0]?.usage.contextWindow;
  if (window != null && window !== config.expectedContextWindow) { await daemon.close(); throw new Error('Actual runtime window differs from the comparison configuration'); }
  record('ready', { policy, attachedAtRequest: initialRollout.requests, nativeModel: native.model });
  return { daemon, finished, report };
}

async function finishTrial(out) {
  const running = JSON.parse(await fs.readFile(path.join(outputPath(out), 'running.json'), 'utf8'));
  const state = await call({ method: 'status' });
  if (state.pid !== running.pid || state.threads.length !== 1 || state.threads[0].sessionId !== running.threadId) throw new Error('This output does not own the running comparison controller');
  if (state.threads[0].pendingTurnId || state.threads[0].state !== 'observing') throw new Error('A pause or compaction is unresolved; do not silently end the comparison');
  const native = await Codex.connect();
  try { if ((await native.status(running.threadId)).status !== 'idle') throw new Error('The working task is still active'); }
  finally { native.close(); }
  await call({ method: 'stop' });
  console.log(JSON.stringify({ stopRequested: true, out: outputPath(out) }));
}

async function main(args) {
  const command = args.shift();
  if (command === 'analyze') {
    if (!args.length) throw new Error('Supply completed report.json files');
    const reports = await Promise.all(args.map(async filename => JSON.parse(await fs.readFile(filename, 'utf8'))));
    const summaries = reports.map(summarizeReport);
    const settings = summaries.map(item => item.recordedSettings);
    const settingsPresent = settings.every(item => item.actualModels.length && item.actualEfforts.length && item.effectiveWindows.length);
    const comparable = settingsPresent && reports.every((report, index) => report.sourceBefore.fingerprint === reports[0].sourceBefore.fingerprint
      && JSON.stringify(settings[index]) === JSON.stringify(settings[0]) && JSON.stringify(report.config) === JSON.stringify(reports[0].config)
      && report.sourceBefore.fingerprint === report.sourceAfter.fingerprint);
    console.log(JSON.stringify({ comparableRecordedSettings: comparable, summaries,
      limitation: 'No superiority conclusion. Check model effort/context records and judge final work/continuity independently; unassessed quality remains null.' }, null, 2));
    return;
  }
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (key === '--calibration') options.calibration = true;
    else if (['--policy', '--thread', '--config', '--out', '--reference'].includes(key) && args.length) options[key.slice(2)] = args.shift();
    else throw new Error('Invalid comparison argument');
  }
  if (command === 'finish') return finishTrial(options.out);
  if (command !== 'start' || !options.config || !options.out) {
    console.log('start --policy jev|fixed|end-turn --thread ID --config FILE --out eval/results/TRIAL [--calibration] [--reference REPORT]\nfinish --out eval/results/TRIAL\nanalyze REPORT.json [REPORT.json ...]');
    return;
  }
  const trial = await startTrial({ policy: options.policy, threadId: options.thread,
    config: JSON.parse(await fs.readFile(options.config, 'utf8')), out: options.out,
    calibration: options.calibration ?? false, reference: options.reference });
  await trial.finished;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
}
