import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { History } from '../src/history.js';

test('installed-shaped CLI can filter and export history while the controller is stopped', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'jevpact-cli-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const history = new History({ directory, maxBytes: 1_000_000, retentionDays: 30 });
  const now = Date.now();
  history.append('task-a', { time: now, event: 'jev-request', evaluationId: 'eval-a', request: { model: 'test', state: { excerpt: 'Exact bounded excerpt' } } });
  history.append('task-b', { time: now + 1, event: 'assessed', reason: 'another task' });
  history.append('task-a', { time: now + 2, event: 'assessed', action: 'wait', reason: 'ongoing work' });
  history.close();
  const run = args => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/jevpact.js', import.meta.url)),
    'history', '--directory', directory, ...args], { encoding: 'utf8' });
  const exported = run(['task-a', '--event', 'jev-request', '--json']);
  assert.equal(exported.status, 0, exported.stderr);
  const row = JSON.parse(exported.stdout.trim());
  assert.equal(row.threadId, 'task-a');
  assert.equal(row.request.state.excerpt, 'Exact bounded excerpt');
  const following = run(['task-a', '--after', String(row.id), '--limit', '1', '--json']);
  assert.equal(following.status, 0, following.stderr);
  assert.equal(JSON.parse(following.stdout).event, 'assessed');
  const plain = run(['task-a', '--event', 'assessed']);
  assert.match(plain.stdout, /wait ongoing work/);
  assert.ok(!plain.stdout.includes('another task'));
  const stats = run(['--stats', '--json']);
  assert.equal(stats.status, 0, stats.stderr);
  assert.equal(JSON.parse(stats.stdout).maxBytes, 1_000_000);
  const invalid = run(['task-a', '--since', 'not-a-date']);
  assert.notEqual(invalid.status, 0);
});
