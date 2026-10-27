import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolveKey } from '../src/credentials.js';
import { reduceHook } from '../src/hook.js';
import { PAUSE_PREFIX } from '../src/controller.js';
import { storedKeyPath } from '../src/paths.js';

test('OpenRouter resolves only its own credentials and uses a separate stored file', async () => {
  const env = { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'router', JEV_TEST_KEY: 'jev-test', JEV_API_KEY: 'jev-api' };
  assert.equal(await resolveKey({ env, keyPath: null, globalValue: async () => 'global' }), 'router');
  delete env.OPENROUTER_API_KEY;
  assert.equal(await resolveKey({ env, keyPath: null, globalValue: async name => name === 'OPENROUTER_API_KEY' ? 'global-router' : 'wrong' }), 'global-router');
  assert.equal(await resolveKey({ env, keyPath: null, globalValue: async () => '' }), '');
  assert.notEqual(storedKeyPath('openrouter'), storedKeyPath('jev'));
  await assert.rejects(resolveKey({ env: { JEV_PROVIDER: 'other' }, keyPath: null }), /JEV_PROVIDER/);
});

test('credential names take priority before process versus global origin', async () => {
  const cases = [
    [{ JEV_TEST_KEY: 'process-test', JEV_API_KEY: 'process-api' }, { JEV_TEST_KEY: 'global-test' }, 'process-test'],
    [{ JEV_API_KEY: 'process-api' }, { JEV_TEST_KEY: 'global-test' }, 'global-test'],
    [{ JEV_TEST_KEY: '', JEV_API_KEY: 'process-api' }, { JEV_API_KEY: 'global-api' }, 'process-api'],
    [{}, { JEV_API_KEY: 'global-api' }, 'global-api'],
    [{}, {}, ''],
  ];
  for (const [env, globals, expected] of cases) {
    assert.equal(await resolveKey({ env, globalValue: async name => globals[name] ?? '', keyPath: null }), expected);
  }
  assert.equal(await resolveKey({ env: {}, platform: 'linux' }), '');
});

test('a private stored key is a durable fallback and an exposed file is refused', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jp-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, 'credential');
  await writeFile(keyPath, 'stored-placeholder\n', { mode: 0o600 });
  assert.equal(await resolveKey({ env: {}, globalValue: async () => '', keyPath }), 'stored-placeholder');
  await chmod(keyPath, 0o644);
  await assert.rejects(resolveKey({ env: {}, globalValue: async () => '', keyPath }), /Unsafe Jevpact credential file/);
});

test('hook transport discards source, command output and user text', () => {
  const identity = { session_id: 'session', turn_id: 'turn', transcript_path: '/transcript', hook_event_name: 'PostToolUse' };
  const reduced = reduceHook({ ...identity, tool_input: { secret: 'private-input' }, tool_output: 'private-output', prompt: 'private-direction' });
  assert.deepEqual(reduced, { ...identity, controllerMessage: false });
  assert.deepEqual(reduceHook({ ...identity, prompt: `${PAUSE_PREFIX} private body` }), { ...identity, controllerMessage: true });
});
