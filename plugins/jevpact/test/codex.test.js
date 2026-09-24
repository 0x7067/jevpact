import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Codex, encodeFrame } from '../src/codex.js';
import { LocalState } from '../src/local-state.js';
import { Transcript } from '../src/transcript.js';

const threadId = 'test-thread';
const owner = 'desktop-owner';
const idle = { turnStatus: 'idle', turnId: 'old-turn' };
const active = { turnStatus: 'active', turnId: 'active-turn' };
const event = (type, turnId) => JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId } }) + '\n';

async function fixture(t, { state = idle, cliVersion = '0.155.0-alpha.9.2', indexVersion = cliVersion, sessionId = threadId, mutate, split = false, timeoutMs = 500, ownerAvailable = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jevpact-ipc-test-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const rolloutPath = path.join(dir, 'current.jsonl');
  let records = JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cli_version: cliVersion } }) + '\n';
  if (state.turnId) {
    records += event('task_started', state.turnId);
    if (state.turnStatus === 'idle') records += event(state.stopped ? 'turn_aborted' : 'task_complete', state.turnId);
  }
  await writeFile(rolloutPath, records);
  const index = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  index.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, model TEXT, cli_version TEXT)');
  index.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(threadId, rolloutPath, dir, 'test-model', indexVersion);
  index.close();
  const goals = new DatabaseSync(path.join(dir, 'goals_1.sqlite'));
  goals.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, status TEXT)');
  if (state.goalStatus) goals.prepare('INSERT INTO thread_goals VALUES (?, ?)').run(threadId, state.goalStatus);
  goals.close();
  const localState = new LocalState({ codexHome: dir });
  const seen = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    const send = message => {
      const frame = encodeFrame(message);
      if (split) { socket.write(frame.subarray(0, 2)); setImmediate(() => socket.write(frame.subarray(2))); }
      else socket.write(frame);
    };
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0);
        const message = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        seen.push(message);
        // This owner has no snapshot implementation, including for a subscriber.
        if (message.type !== 'request') continue;
        const response = { type: 'response', method: message.method, requestId: message.requestId, resultType: 'success', handledByClientId: owner };
        if (message.method === 'initialize') response.result = { clientId: 'test-client' };
        else if (message.method === 'thread-owner-discovery') {
          if (ownerAvailable) response.result = {};
          else Object.assign(response, { resultType: 'error', error: 'no-client-found' });
        }
        else if (mutate) { mutate({ message, response, send, socket }); continue; }
        else if (message.method === 'thread-follower-compact-thread') response.result = { ok: true };
        else if (message.method === 'thread-follower-start-turn') response.result = { result: { turn: { id: 'new-turn' } } };
        else if (message.method === 'thread-follower-steer-turn') response.result = { result: { turnId: 'active-turn' } };
        send(response);
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const client = await Codex.connect({ socketPath, timeoutMs, localState });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true });
    assert.equal(seen.some(m => m.type === 'broadcast'), false, 'No snapshot subscription is permitted');
  });
  return { client, seen, dir, rolloutPath, localState, sockets, socketPath };
}

test('little endian framing tolerates a split header and targets the discovered owner', async t => {
  const { client, seen } = await fixture(t, { split: true });
  const state = await client.status(threadId);
  assert.equal(state.status, 'idle');
  assert.equal(state.lastTurnId, 'old-turn');
  assert.equal(state.ownerClientId, owner);
  assert.equal(state.stateSource, 'rollout');
  assert.equal(seen.find(m => m.method === 'thread-owner-discovery').version, 1);
});

test('invalid consumed rollout fields prevent a mutation', async t => {
  const { client, seen, rolloutPath } = await fixture(t);
  await appendFile(rolloutPath, event('task_started', 123));
  await assert.rejects(client.compact(threadId), { code: 'invalid-turn' });
  assert.equal(seen.some(m => m.method === 'thread-follower-compact-thread'), false);
});

test('metadata locate works without a GUI owner or IPC connection', async t => {
  const { client, localState, rolloutPath, seen } = await fixture(t, { ownerAvailable: false });
  assert.equal((await client.locate(threadId)).rolloutPath, rolloutPath);
  assert.equal(seen.some(m => m.method === 'thread-owner-discovery'), false);
  await assert.rejects(client.status(threadId), { code: 'no-client-found' });
  const offline = new Codex({ socketPath: '/nonexistent/jevpact-test.sock', localState });
  t.after(() => offline.close());
  assert.equal((await offline.locate(threadId)).rolloutPath, rolloutPath);
  assert.equal(offline.socket, null);
});

test('historical index CLI versions accept structurally valid current records', async t => {
  const { client } = await fixture(t, { indexVersion: '0.150.0', cliVersion: '0.150.0' });
  assert.equal((await client.status(threadId)).status, 'idle');
});

test('a new operation reconnects once and preserves the shared incremental reader', async t => {
  const { client, seen, sockets, rolloutPath } = await fixture(t, { state: active });
  const reader = new Transcript({ sessionId: threadId, watch: false });
  await reader.open(rolloutPath);
  t.after(() => reader.close());
  client.bindReader(threadId, reader);
  await client.status(threadId);
  const originalHandle = reader.handle;
  const disconnected = once(client, 'disconnect');
  for (const socket of sockets) socket.destroy();
  await disconnected;
  assert.equal(seen.filter(m => m.method === 'initialize').length, 1);
  await appendFile(rolloutPath, event('task_complete', 'active-turn'));
  const [state, discoveredOwner] = await Promise.all([client.status(threadId), client.owner(threadId)]);
  assert.equal(state.status, 'idle');
  assert.equal(state.lastTurnId, 'active-turn');
  assert.equal(discoveredOwner, owner);
  assert.equal(seen.filter(m => m.method === 'initialize').length, 2);
  assert.equal(client.readers.get(threadId), reader);
  assert.equal(reader.handle, originalHandle);
  assert.equal(reader.closed, false);
  await client.compact(threadId, { expectedTurnId: 'active-turn' });
  assert.equal(seen.filter(m => m.method === 'thread-follower-compact-thread').length, 1);
});

test('disconnect rejects a sent mutation without replay and permits a later new operation', async t => {
  let failMutation = true;
  const { client, seen } = await fixture(t, { mutate: ({ socket, response, send }) => {
    if (failMutation) socket.destroy();
    else send({ ...response, result: { ok: true } });
  } });
  await assert.rejects(client.compact(threadId), { code: 'disconnected', ambiguous: true });
  assert.equal(seen.filter(m => m.method === 'thread-follower-compact-thread').length, 1);
  assert.equal(seen.filter(m => m.method === 'initialize').length, 1);
  failMutation = false;
  await client.compact(threadId);
  assert.equal(seen.filter(m => m.method === 'initialize').length, 2);
  assert.equal(seen.filter(m => m.method === 'thread-follower-compact-thread').length, 2);
});

test('failed initial connection can recover on a new operation; explicit close cannot', async t => {
  const { localState, socketPath } = await fixture(t);
  const client = new Codex({ localState, socketPath: socketPath + '.missing' });
  t.after(() => client.close());
  await assert.rejects(client.status(threadId), { code: 'connection-error' });
  client.socketPath = socketPath;
  assert.equal((await client.status(threadId)).status, 'idle');
  client.close();
  await assert.rejects(client.status(threadId), { code: 'closed' });
});

test('recorded goal state survives an absent native DB row and either active source prevents commands', async t => {
  for (const [recordedStatus, nativeStatus, expected] of [['paused', null, 'paused'], ['active', null, 'active'], ['paused', 'active', 'active']]) {
    const { client, seen, rolloutPath } = await fixture(t, { state: { ...active, goalStatus: nativeStatus } });
    await appendFile(rolloutPath, JSON.stringify({ type: 'event_msg', payload: { type: 'thread_goal_updated',
      threadId, goal: { threadId, status: recordedStatus } } }) + '\n');
    assert.equal((await client.status(threadId)).goalStatus, expected);
    if (expected === 'active') {
      await assert.rejects(client.steer(threadId, 'active-turn', 'pause'), { code: 'active-goal-unsupported' });
      await appendFile(rolloutPath, event('task_complete', 'active-turn'));
      await assert.rejects(client.compact(threadId), { code: 'active-goal-unsupported' });
      await assert.rejects(client.resume(threadId, 'continue'), { code: 'active-goal-unsupported' });
      assert.equal(seen.some(m => m.method.startsWith('thread-follower-')), false);
    }
  }
});

test('active, unknown, and active-goal threads cannot be compacted', async t => {
  for (const state of [
    active,
    { turnStatus: 'unknown', turnId: null },
    { ...idle, goalStatus: 'active' },
  ]) {
    const { client, seen } = await fixture(t, { state });
    await assert.rejects(client.compact(threadId), error => ['thread-not-idle', 'active-goal-unsupported'].includes(error.code));
    await assert.rejects(client.resume(threadId, 'continue'), error => ['thread-not-idle', 'active-goal-unsupported'].includes(error.code));
    assert.equal(seen.some(m => m.method === 'thread-follower-compact-thread'), false);
  }
});

test('stale turn and invalidated controller decisions cause no mutation', async t => {
  const { client, seen } = await fixture(t);
  await assert.rejects(client.compact(threadId, { expectedTurnId: 'other-turn' }), { code: 'stale-turn' });
  await assert.rejects(client.resume(threadId, 'continue', { isCurrent: () => false }), { code: 'stale-action' });
  assert.equal(seen.some(m => m.method.startsWith('thread-follower-')), false);
});

test('default transport compacts and acknowledges separately from completion', async t => {
  const { client, seen } = await fixture(t);
  const result = await client.compact(threadId, { expectedTurnId: 'old-turn' });
  assert.equal(result.accepted, true);
  assert.equal(result.completed, false);
  const message = seen.find(m => m.method === 'thread-follower-compact-thread');
  assert.equal(message.targetClientId, owner);
  assert.equal(message.version, 1);
});

test('default transport resumes with fresh input once and inherits existing settings', async t => {
  const { client, seen } = await fixture(t);
  const result = await client.resume(threadId, 'Continue the existing assignment.');
  assert.equal(result.turnId, 'new-turn');
  const messages = seen.filter(m => m.method === 'thread-follower-start-turn');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].version, 2);
  assert.deepEqual(messages[0].params.turnStart.request.input, [{ type: 'text', text: 'Continue the existing assignment.', text_elements: [] }]);
  assert.deepEqual(messages[0].params.turnStart.context, { inheritThreadSettings: true });
});

test('an ambiguous mutation timeout never retries', async t => {
  const { client, seen } = await fixture(t, { timeoutMs: 100, mutate: () => {} });
  await assert.rejects(client.compact(threadId), { code: 'request-timeout', ambiguous: true });
  assert.equal(seen.filter(m => m.method === 'thread-follower-compact-thread').length, 1);
});

test('disconnect and mismatched owner acknowledge an uncertain mutation', async t => {
  for (const mutate of [
    ({ socket }) => socket.destroy(),
    ({ response, send }) => send({ ...response, handledByClientId: 'new-owner', result: { ok: true } }),
  ]) {
    const { client } = await fixture(t, { mutate });
    await assert.rejects(client.compact(threadId), error => error.ambiguous === true);
  }
});

test('steer sends one ordinary message to the active owner and returns native attribution', async t => {
  const { client, seen } = await fixture(t, { state: active });
  const result = await client.steer(threadId, 'active-turn', 'Finish this connected step and pause.', { isCurrent: () => true });
  assert.deepEqual(result, { accepted: true, threadId, turnId: 'active-turn', ownerClientId: owner });
  const requests = seen.filter(m => m.method === 'thread-follower-steer-turn');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].version, 1);
  assert.equal(requests[0].targetClientId, owner);
  assert.deepEqual(requests[0].params.input, [{ type: 'text', text: 'Finish this connected step and pause.', text_elements: [] }]);
  assert.deepEqual(requests[0].params.restoreMessage.context, {});
  assert.equal(requests[0].params.clientUserMessageId, requests[0].params.restoreMessage.id);
  assert.equal(Object.hasOwn(requests[0].params, 'additionalContext'), false);
  assert.equal(Object.hasOwn(requests[0].params, 'toolOutput'), false);
  assert.equal(seen.some(m => m.method === 'thread-follower-start-turn' || m.method?.includes('interrupt')), false);
});

test('steer refuses an idle, unknown or unidentified active turn', async t => {
  for (const state of [idle, { turnStatus: 'unknown', turnId: null }]) {
    const { client, seen } = await fixture(t, { state });
    await assert.rejects(client.steer(threadId, 'active-turn', 'pause'), { code: 'thread-not-active' });
    assert.equal(seen.some(m => m.method === 'thread-follower-steer-turn'), false);
  }
});

test('an active native goal prevents steering a cooperative pause', async t => {
  const { client, seen } = await fixture(t, { state: { ...active, goalStatus: 'active' } });
  await assert.rejects(client.steer(threadId, 'active-turn', 'Finish this step and pause.'), { code: 'active-goal-unsupported' });
  assert.equal(seen.some(m => m.method === 'thread-follower-steer-turn'), false);
  assert.equal(seen.filter(m => m.method === 'thread-owner-discovery').length, 1);
});

test('bound status incrementally refreshes the shared reader without closing it', async t => {
  const { client, rolloutPath } = await fixture(t, { state: active });
  const reader = new Transcript({ sessionId: threadId, watch: false });
  await reader.open(rolloutPath);
  t.after(() => reader.close());
  client.bindReader(threadId, reader);
  assert.equal((await client.status(threadId)).turnId, 'active-turn');
  const offset = reader.offset;
  await appendFile(rolloutPath, event('task_complete', 'active-turn'));
  const state = await client.status(threadId);
  assert.equal(state.status, 'idle');
  assert.equal(state.lastTurnId, 'active-turn');
  assert.ok(reader.offset > offset);
  assert.equal(client.unbindReader(threadId, {}), false);
  assert.equal(client.unbindReader(threadId, reader), true);
  assert.equal(reader.closed, false);
});

test('unbound reads use a temporary watcher-free reader and return the compaction turn', async t => {
  const { client, rolloutPath } = await fixture(t);
  await appendFile(rolloutPath, event('task_started', 'compaction-turn')
    + JSON.stringify({ type: 'compacted', payload: { message: 'Saved work summary.' } }) + '\n' + event('task_complete', 'compaction-turn'));
  let temporary;
  const open = Transcript.prototype.open;
  t.mock.method(Transcript.prototype, 'open', async function (file) { temporary = this; return open.call(this, file); });
  const state = await client.status(threadId);
  assert.equal(state.lastTurnId, 'compaction-turn');
  assert.equal(state.status, 'idle');
  assert.equal(temporary.options.watch, false);
  assert.equal(temporary.closed, true);
  assert.equal(temporary.handle, null);
});

test('mismatched rollout identity cannot supply status or authorize a command', async t => {
  const { client, seen, rolloutPath } = await fixture(t, { sessionId: 'another-thread' });
  const wrongReader = new Transcript({ sessionId: 'another-thread', watch: false });
  await wrongReader.open(rolloutPath);
  t.after(() => wrongReader.close());
  assert.throws(() => client.bindReader(threadId, wrongReader), { code: 'reader-identity-mismatch' });
  await assert.rejects(client.status(threadId), { code: 'session-identity-mismatch' });
  await assert.rejects(client.compact(threadId), { code: 'session-identity-mismatch' });
  assert.equal(seen.some(m => m.method.startsWith('thread-follower-')), false);
});

test('current index path changes reject a bound old rollout and moves during reading', async t => {
  const { client, localState, rolloutPath } = await fixture(t);
  const reader = new Transcript({ sessionId: threadId, watch: false });
  await reader.open(rolloutPath);
  t.after(() => reader.close());
  client.bindReader(threadId, reader);
  const locate = localState.locate.bind(localState);
  t.mock.method(localState, 'locate', id => ({ ...locate(id), rolloutPath: rolloutPath + '.new' }));
  await assert.rejects(client.status(threadId), { code: 'rollout-path-changed' });
  client.unbindReader(threadId, reader);
  let reads = 0;
  t.mock.method(localState, 'locate', id => ({ ...locate(id), rolloutPath: ++reads === 1 ? rolloutPath : rolloutPath + '.new' }));
  await assert.rejects(client.status(threadId), { code: 'rollout-path-changed' });
});

test('a stopped rollout remains stopped even when its last turn is idle', async t => {
  const { client } = await fixture(t, { state: { ...idle, stopped: true } });
  const state = await client.status(threadId);
  assert.equal(state.userStopped, true);
  assert.equal(state.lastTurnStatus, null);
  await assert.rejects(client.compact(threadId), { code: 'user-stopped' });
  await assert.rejects(client.resume(threadId, 'continue'), { code: 'user-stopped' });
});

test('steer rejects stale turns and rechecks cancellation immediately before dispatch', async t => {
  const { client, seen } = await fixture(t, { state: active });
  await assert.rejects(client.steer(threadId, 'old-turn', 'pause'), { code: 'stale-turn' });
  await assert.rejects(client.steer(threadId, 'active-turn', 'pause', { isCurrent: () => false }), { code: 'stale-action' });
  let checks = 0;
  await assert.rejects(client.steer(threadId, 'active-turn', 'pause', { isCurrent: () => ++checks === 1 }), { code: 'stale-action' });
  assert.equal(checks, 2);
  assert.equal(seen.some(m => m.method === 'thread-follower-steer-turn'), false);
});

test('steer reports the actual native selected turn instead of echoing its preflight', async t => {
  const { client } = await fixture(t, { state: active, mutate: ({ response, send }) => send({ ...response, result: { result: { turnId: 'native-selected-turn' } } }) });
  assert.equal((await client.steer(threadId, 'active-turn', 'pause')).turnId, 'native-selected-turn');
});

test('uncertain steer receipts never retry or fall back to starting or interrupting a turn', async t => {
  for (const mutate of [() => {}, ({ response, send }) => send({ ...response, result: { result: {} } })]) {
    const { client, seen } = await fixture(t, { state: active, timeoutMs: 100, mutate });
    await assert.rejects(client.steer(threadId, 'active-turn', 'pause'), error => error.ambiguous === true);
    assert.equal(seen.filter(m => m.method === 'thread-follower-steer-turn').length, 1);
    assert.equal(seen.some(m => m.method === 'thread-follower-start-turn' || m.method?.includes('interrupt')), false);
  }
});

test('invalidation after the idle check still prevents compact and resume dispatch', async t => {
  for (const operation of ['compact', 'resume']) {
    const { client, seen } = await fixture(t);
    let checks = 0;
    const context = { expectedTurnId: 'old-turn', isCurrent: () => ++checks === 1 };
    const result = operation === 'compact' ? client.compact(threadId, context) : client.resume(threadId, 'continue', context);
    await assert.rejects(result, { code: 'stale-action' });
    assert.equal(checks, 2);
    assert.equal(seen.some(m => m.method.startsWith('thread-follower-')), false);
  }
});
