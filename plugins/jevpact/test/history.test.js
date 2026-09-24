import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { History } from '../src/history.js';

const DAY = 86_400_000;
const START = 40 * DAY;
const MAX_BYTES = 256 * 1024;

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jevpact-history-'));
  let now = START;
  const settings = { directory, maxBytes: MAX_BYTES, now: () => now, ...options };
  const history = new History(settings);
  t.after(() => { history.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, settings, history, advance: value => { now = value; } };
}

test('history requires an explicit global budget and a sufficient durable-file allowance', t => {
  const directory = path.join(os.tmpdir(), `jevpact-history-absent-${process.pid}`);
  assert.throws(() => new History({ directory }), { code: 'history-budget-too-small' });
  assert.throws(() => new History({ directory, maxBytes: 4096 }), { code: 'history-budget-too-small' });
  assert.throws(() => new History({ directory, maxBytes: MAX_BYTES, budgetScope: 'task' }), { code: 'history-unsupported-budget-scope' });
  assert.equal(fs.existsSync(directory), false);
  const { history } = fixture(t);
  assert.equal(history.stats().budgetScope, 'global');
});

test('exact JSON survives restart with chronological task/event/cursor filters', t => {
  const { directory, settings, history } = fixture(t);
  const event = { time: START + 2, event: 'jev-response', payload: { text: 'é 🧪\nexact', values: [null, false, 0, 1.25], nested: { answer: 'yes' } } };
  const first = history.append('task-a', event);
  history.append('task-b', { time: START, event: 'decision', action: 'wait' });
  const third = history.append('task-a', { time: START + 2, event: 'decision', reason: 'continue' });
  history.close();
  const reopened = new History(settings);
  t.after(() => reopened.close());
  assert.deepEqual([...reopened.read()].map(row => row.id), [2, 1, 3]);
  assert.deepEqual([...reopened.read({ threadId: 'task-a', event: 'jev-response' })], [{ id: first.id, threadId: 'task-a', ...event }]);
  assert.deepEqual([...reopened.read({ threadId: 'task-a', after: first.id, since: START + 1, limit: 1 })].map(row => row.id), [third.id]);
  assert.deepEqual([...reopened.read({ limit: 0 })], []);
  assert.equal(reopened.stats().appended, 3);
  assert.equal(reopened.stats().oldestAt, START);
  assert.equal(reopened.append('task-c', { time: START + 3, event: 'attached' }).id, 4);
  assert.equal(fs.readdirSync(directory).length, 1);
});

test('expiry removes the exact boundary and persists loss counters across restart', t => {
  const { settings, history, advance } = fixture(t);
  history.append('task-a', { time: START, event: 'first' });
  history.append('task-a', { time: START + 1, event: 'second' });
  advance(START + 30 * DAY);
  assert.deepEqual(history.prune(), { expired: 1, capacity: 0 });
  assert.equal(history.stats().oldestAt, START + 1);
  assert.equal(history.stats().pruned.expired, 1);
  assert.equal(history.append('task-a', { time: START, event: 'late-old-record' }).droppedReason, 'expired');
  assert.equal(history.stats().dropped.expired, 1);
  history.close();
  advance(START + 30 * DAY + 1);
  const reopened = new History(settings);
  t.after(() => reopened.close());
  assert.equal(reopened.stats().records, 0);
  assert.equal(reopened.stats().oldestAt, null);
  assert.equal(reopened.stats().pruned.expired, 2);
  assert.equal(reopened.stats().dropped.expired, 1);
  assert.ok(reopened.stats().pruned.bytes > 0);
  assert.equal(reopened.append('task-a', { time: START + 30 * DAY + 1, event: 'fresh' }).id, 3);
});

test('offline read-only exports hide expired rows and never create, prune or chmod', t => {
  const { directory, settings, history, advance } = fixture(t);
  history.append('task-a', { time: START, event: 'expired' });
  history.append('task-a', { time: START + 1, event: 'visible' });
  history.close();
  advance(START + 30 * DAY);
  fs.chmodSync(directory, 0o750);
  fs.chmodSync(history.file, 0o640);
  const before = fs.statSync(history.file);
  const reader = new History({ directory, readOnly: true, now: settings.now });
  t.after(() => reader.close());
  assert.deepEqual([...reader.read()].map(row => row.event), ['visible']);
  assert.equal(reader.stats().records, 2);
  assert.equal(reader.stats().visibleRecords, 1);
  assert.equal(reader.stats().pruned.expired, 0);
  assert.throws(() => reader.prune(), { code: 'history-read-only' });
  assert.throws(() => reader.append('task-a', { time: START, event: 'no' }), { code: 'history-read-only' });
  assert.equal(fs.statSync(history.file).mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(history.file).mode & 0o777, 0o640);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o750);
  const missing = path.join(directory, 'absent');
  assert.throws(() => new History({ directory: missing, readOnly: true }), { code: 'history-not-found' });
  assert.equal(fs.existsSync(missing), false);
});

test('global capacity evicts oldest records and physically reclaims pages', t => {
  const { settings, history } = fixture(t);
  const accepted = [];
  let evicted = 0;
  for (let i = 0; i < 40; i++) {
    const event = { time: START + i, event: 'request', payload: randomBytes(8000).toString('hex') };
    const result = history.append(i % 2 ? 'task-a' : 'task-b', event);
    assert.equal(result.stored, true);
    accepted.push(result.id);
    evicted += result.pruned.capacity;
    const stats = history.stats();
    assert.ok(stats.bytes <= MAX_BYTES);
    assert.ok(stats.databaseBytes <= stats.mainMaxBytes);
    assert.ok(stats.mainMaxBytes + stats.journalReserveBytes <= MAX_BYTES);
    assert.equal(stats.freePages, 0);
  }
  assert.ok(evicted > 0);
  const rows = [...history.read()];
  assert.deepEqual(rows.map(row => row.id), accepted.slice(evicted));
  assert.equal(history.stats().pruned.capacity, evicted);
  const before = history.stats().databaseBytes;
  history.close();
  const reopened = new History(settings);
  t.after(() => reopened.close());
  assert.deepEqual([...reopened.read()], rows);
  assert.equal(reopened.stats().databaseBytes, before);
  assert.equal(reopened.stats().pruned.capacity, evicted);
});

test('an event that cannot fit is counted without discarding retained events', t => {
  const { history } = fixture(t);
  history.append('task-a', { time: START, event: 'retained' });
  const before = [...history.read()];
  const result = history.append('task-b', { time: START + 1, event: 'oversize', payload: randomBytes(MAX_BYTES).toString('hex') });
  assert.equal(result.stored, false);
  assert.equal(result.droppedReason, 'capacity');
  assert.equal(result.pruned.capacity, 0);
  assert.deepEqual([...history.read()], before);
  assert.equal(history.stats().dropped.capacity, 1);
  assert.ok(history.stats().dropped.bytes > MAX_BYTES);
});

test('a paused streaming export holds no read lock and excludes later appends', t => {
  const { directory, history, settings } = fixture(t);
  history.append('task-a', { time: START, event: 'one' });
  history.append('task-a', { time: START + 1, event: 'two' });
  const reader = new History({ directory, readOnly: true, now: settings.now });
  t.after(() => reader.close());
  const stream = reader.read();
  assert.equal(stream.next().value.event, 'one');
  assert.equal(history.append('task-a', { time: START + 2, event: 'three' }).stored, true);
  assert.deepEqual([...stream].map(row => row.event), ['two']);
  assert.equal([...reader.read()].length, 3);
});

test('database and durable rollback journal stay private and within the total cap', t => {
  const { directory, history } = fixture(t);
  for (let i = 0; i < 8; i++) history.append('task-a', { time: START + i, event: 'request', payload: randomBytes(6000).toString('hex') });
  assert.equal(history.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.equal(history.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(history.db.prepare('PRAGMA cache_spill').get().cache_spill, 0);
  history.db.exec('BEGIN IMMEDIATE; UPDATE history_events SET payload=zeroblob(length(payload))');
  try {
    const files = fs.readdirSync(directory);
    assert.ok(files.includes('history.sqlite-journal'));
    const sizes = files.map(name => fs.statSync(path.join(directory, name)));
    assert.ok(sizes.reduce((sum, info) => sum + info.size, 0) <= MAX_BYTES);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    for (const info of sizes) assert.equal(info.mode & 0o777, 0o600);
    const stats = history.stats();
    assert.ok(stats.journalBytes > 0);
    assert.ok(stats.journalBytes <= stats.journalReserveBytes);
    assert.equal(stats.bytes, sizes.reduce((sum, info) => sum + info.size, 0));
  } finally { history.db.exec('ROLLBACK'); }
  assert.equal(history.stats().journalBytes, 0);
  assert.ok([...history.read()].every(row => typeof row.payload === 'string'));
});

test('committed history survives termination during an uncommitted journaled write', async t => {
  const { directory, settings, history } = fixture(t);
  history.append('task-a', { time: START, event: 'committed', payload: 'survives termination' });
  const expected = [...history.read()];
  history.close();
  const module = new URL('../src/history.js', import.meta.url).href;
  const code = `import {History} from ${JSON.stringify(module)};
    const h=new History({directory:process.argv[1],maxBytes:${MAX_BYTES},now:()=>${START}});
    h.db.exec("BEGIN IMMEDIATE; UPDATE history_events SET event='uncommitted'");
    process.stdout.write('journal-ready\\n');
    process.stdin.resume();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, directory], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const exited = once(child, 'exit');
  const ready = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => chunk.toString()),
    exited.then(([code]) => { throw new Error(`child exited before journal: ${code}`); })
  ]);
  assert.match(ready, /journal-ready/);
  assert.ok(fs.statSync(`${history.file}-journal`).size > 0);
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  const reopened = new History(settings);
  t.after(() => reopened.close());
  assert.deepEqual([...reopened.read()], expected);
  assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.ok(reopened.stats().bytes <= MAX_BYTES);
});
