import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { LocalState } from '../src/local-state.js';

const id = 'native-thread';
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jp-local-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexPath = path.join(dir, 'state_5.sqlite');
  const goalPath = path.join(dir, 'goals_1.sqlite');
  const index = new DatabaseSync(indexPath);
  index.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, model TEXT, cli_version TEXT)');
  index.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, path.join(dir, 'current.jsonl'), dir, 'gpt-6-astra', '0.155.0-alpha.9.2');
  index.close();
  const goals = new DatabaseSync(goalPath);
  goals.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, status TEXT)');
  goals.close();
  const change = (file, sql, ...args) => {
    const db = new DatabaseSync(file);
    try { db.prepare(sql).run(...args); } finally { db.close(); }
  };
  return { dir, indexPath, goalPath, change, state: new LocalState({ codexHome: dir }) };
}

test('exact native thread index supplies current path and does not use another thread', async t => {
  const { dir, indexPath, change, state } = await fixture(t);
  assert.deepEqual(state.locate(id), { threadId: id, rolloutPath: path.join(dir, 'current.jsonl'), cwd: dir, model: 'gpt-6-astra', goalStatus: null });
  assert.throws(() => state.locate('missing'), { code: 'thread-not-indexed' });
  change(indexPath, 'UPDATE threads SET rollout_path = ? WHERE id = ?', path.join(dir, 'new-current.jsonl'), id);
  assert.equal(state.locate(id).rolloutPath, path.join(dir, 'new-current.jsonl'));
});

test('native goal status is read freshly and normalized without reading objective text', async t => {
  const { goalPath, change, state } = await fixture(t);
  for (const [stored, expected] of [['active', 'active'], ['paused', 'paused'], ['blocked', 'blocked'], ['usage_limited', 'usageLimited'], ['budget_limited', 'budgetLimited'], ['complete', 'complete']]) {
    change(goalPath, 'INSERT OR REPLACE INTO thread_goals VALUES (?, ?)', id, stored);
    assert.equal(state.locate(id).goalStatus, expected);
  }
  change(goalPath, 'DELETE FROM thread_goals WHERE thread_id = ?', id);
  assert.equal(state.locate(id).goalStatus, null);
  change(goalPath, 'INSERT INTO thread_goals VALUES (?, ?)', id, 'future-state');
  assert.throws(() => state.locate(id), { code: 'invalid-goal-status' });
});

test('missing databases and incompatible schemas are unavailable, never invented absence', async t => {
  const { indexPath, goalPath, change, state } = await fixture(t);
  await rm(goalPath);
  assert.throws(() => state.locate(id), { code: 'goal-state-unavailable' });
  await assert.rejects(access(goalPath), { code: 'ENOENT' });
  const goals = new DatabaseSync(goalPath);
  goals.exec('CREATE TABLE unrelated (id TEXT)');
  goals.close();
  assert.throws(() => state.locate(id), { code: 'goal-state-unavailable' });
  change(indexPath, 'ALTER TABLE threads RENAME COLUMN rollout_path TO unknown_path');
  assert.throws(() => state.locate(id), { code: 'thread-index-unavailable' });
  await rm(indexPath);
  assert.throws(() => state.locate(id), { code: 'thread-index-unavailable' });
  await assert.rejects(access(indexPath), { code: 'ENOENT' });
  await writeFile(indexPath, 'not a sqlite database');
  assert.throws(() => state.locate(id), { code: 'thread-index-unavailable' });
});

test('invalid paths are rejected while a historical index version remains usable', async t => {
  const { dir, indexPath, change, state } = await fixture(t);
  change(indexPath, 'UPDATE threads SET rollout_path = ? WHERE id = ?', 'relative.jsonl', id);
  assert.throws(() => state.locate(id), { code: 'invalid-thread-index' });
  change(indexPath, 'UPDATE threads SET rollout_path = ?, cli_version = ? WHERE id = ?', path.join(dir, 'current.jsonl'), '0.150.0', id);
  assert.equal(state.locate(id).rolloutPath, path.join(dir, 'current.jsonl'));
});
