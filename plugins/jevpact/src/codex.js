import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Transcript } from './transcript.js';
import { LocalState } from './local-state.js';

// Private desktop IPC contract observed in Codex 0.155.0-alpha.9.2.
export const PROTOCOL = Object.freeze({
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-compact-thread': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1,
});

export class CodexError extends Error {
  constructor(code, message = code, { ambiguous = false } = {}) {
    super(message);
    this.name = 'CodexError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

export function encodeFrame(value, maxBytes = 16 * 1024 * 1024) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxBytes) throw new CodexError('frame-too-large');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class Codex extends EventEmitter {
  static async connect(options = {}) {
    const client = new Codex(options);
    await client.connect();
    return client;
  }

  constructor({ socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock'), timeoutMs = 8000, maxFrameBytes = 16 * 1024 * 1024, localState = new LocalState() } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.localState = localState;
    this.clientId = 'initializing-client';
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.socket = null;
    this.closed = false;
    this.disposed = false;
    this.connecting = null;
    this.statusReads = new Map();
    this.readers = new Map();
    this.capabilities = Object.freeze({ status: true, compact: true, resume: true, steer: true, exactTurnSteer: false, childPreservingInterrupt: false, atomicIdleMutation: false });
  }

  connect() {
    if (this.disposed) return Promise.reject(new CodexError('closed'));
    if (this.connecting) return this.connecting;
    if (!this.closed && this.socket?.writable && !this.socket.destroyed && this.clientId !== 'initializing-client') return Promise.resolve(this);
    const attempt = this.openConnection();
    this.connecting = attempt;
    const clear = () => { if (this.connecting === attempt) this.connecting = null; };
    attempt.then(clear, clear);
    return attempt;
  }

  async openConnection() {
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    this.closed = false;
    this.clientId = 'initializing-client';
    this.buffer = Buffer.alloc(0);
    socket.on('data', data => { if (this.socket === socket) this.receive(data); });
    socket.on('error', () => this.fail(new CodexError('connection-error'), socket));
    socket.on('close', () => this.fail(new CodexError('disconnected'), socket));
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          socket.off('connect', connected);
          socket.off('error', failed);
          socket.off('close', ended);
          error ? reject(error) : resolve();
        };
        const connected = () => finish();
        const failed = () => finish(new CodexError('connection-error'));
        const ended = () => finish(new CodexError('disconnected'));
        const timer = setTimeout(() => finish(new CodexError('connect-timeout')), this.timeoutMs);
        socket.once('connect', connected);
        socket.once('error', failed);
        socket.once('close', ended);
      });
      const response = await this.request('initialize', { clientType: 'jevpact' });
      if (typeof response.result?.clientId !== 'string') throw new CodexError('invalid-initialize-response');
      if (this.socket !== socket || this.disposed) throw new CodexError('disconnected');
      this.clientId = response.result.clientId;
      return this;
    } catch (error) {
      this.fail(error, socket);
      throw error;
    }
  }

  fail(error, socket = this.socket) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.closed = true;
    this.clientId = 'initializing-client';
    this.buffer = Buffer.alloc(0);
    for (const { reject, timer, mutation } of this.pending.values()) {
      clearTimeout(timer);
      reject(new CodexError(error.code, error.message, { ambiguous: mutation }));
    }
    this.pending.clear();
    socket?.destroy();
    this.emit('disconnect', error);
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    try {
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (size === 0 || size > this.maxFrameBytes) throw new CodexError('invalid-frame-size');
        if (this.buffer.length < size + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
        this.buffer = this.buffer.length === size + 4 ? Buffer.alloc(0) : this.buffer.subarray(size + 4);
        this.handle(message);
      }
    } catch (error) {
      this.fail(error instanceof CodexError ? error : new CodexError('invalid-frame'));
    }
  }

  handle(message) {
    if (message.type === 'client-discovery-request') {
      this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType !== 'success') {
        const code = typeof message.error === 'string' ? message.error : 'request-failed';
        const definitelyUnsent = ['no-client-found', 'request-version-mismatch', 'no-handler-for-request'].includes(code);
        pending.reject(new CodexError(code, code, { ambiguous: pending.mutation && !definitelyUnsent }));
      } else if (message.method != null && message.method !== pending.method) {
        pending.reject(new CodexError('response-method-mismatch', undefined, { ambiguous: pending.mutation }));
      } else if (pending.targetClientId && message.handledByClientId !== pending.targetClientId) {
        pending.reject(new CodexError('response-owner-mismatch', undefined, { ambiguous: pending.mutation }));
      } else pending.resolve(message);
    } else if (message.type === 'broadcast') this.emit('broadcast', message);
  }

  write(message) {
    if (this.closed || !this.socket?.writable) throw new CodexError('not-connected');
    this.socket.write(encodeFrame(message, this.maxFrameBytes));
  }

  request(method, params, { targetClientId, mutation = false, isCurrent } = {}) {
    if (!(method in PROTOCOL)) return Promise.reject(new CodexError('unsupported-method'));
    mutation = mutation || method === 'thread-follower-compact-thread' || method === 'thread-follower-start-turn' || method === 'thread-follower-steer-turn';
    if (isCurrent && isCurrent() !== true) return Promise.reject(new CodexError('stale-action'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CodexError('request-timeout', undefined, { ambiguous: mutation }));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, mutation, method, targetClientId });
      try {
        this.write({ type: 'request', requestId, sourceClientId: this.clientId, version: PROTOCOL[method], method, params, targetClientId, timeoutMs: this.timeoutMs });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async owner(threadId) {
    if (typeof threadId !== 'string' || !threadId) throw new CodexError('invalid-thread-id');
    // A new operation may reconnect. A request already sent on the old socket
    // is rejected by fail() and is never replayed on this connection.
    await this.connect();
    const response = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId });
    if (typeof response.handledByClientId !== 'string') throw new CodexError('invalid-owner-response');
    return response.handledByClientId;
  }

  status(threadId) {
    if (this.statusReads.has(threadId)) return this.statusReads.get(threadId);
    const read = this.readStatus(threadId).finally(() => this.statusReads.delete(threadId));
    this.statusReads.set(threadId, read);
    return read;
  }

  async locate(threadId) {
    return this.localState.locate(threadId);
  }

  bindReader(threadId, reader) {
    const snapshot = reader.snapshot();
    if (reader.closed || snapshot.sessionId !== threadId || !snapshot.supported) throw new CodexError('reader-identity-mismatch');
    this.readers.set(threadId, reader);
  }

  unbindReader(threadId, reader) {
    if (this.readers.get(threadId) !== reader) return false;
    return this.readers.delete(threadId);
  }

  async readStatus(threadId) {
    const location = await this.locate(threadId);
    const ownerClientId = await this.owner(threadId);
    const shared = this.readers.get(threadId);
    const reader = shared ?? new Transcript({ sessionId: threadId, watch: false });
    try {
      if (shared) {
        if (reader.closed) throw new CodexError('reader-closed');
        if (reader.path !== location.rolloutPath) throw new CodexError('rollout-path-changed');
        await reader.refresh();
      } else await reader.open(location.rolloutPath);
      const snapshot = reader.snapshot();
      if (!snapshot.supported) throw new CodexError(snapshot.disabledReason ?? 'transcript-unavailable');
      if (snapshot.sessionId !== threadId) throw new CodexError('reader-identity-mismatch');
      const current = this.localState.locate(threadId);
      if (current.rolloutPath !== location.rolloutPath || reader.path !== current.rolloutPath) throw new CodexError('rollout-path-changed');
      const status = ['active', 'idle'].includes(snapshot.turnStatus) ? snapshot.turnStatus : 'unknown';
      const goalStatus = current.goalStatus === 'active' || snapshot.goalStatus === 'active'
        ? 'active' : current.goalStatus ?? snapshot.goalStatus ?? null;
      return { ...current, goalStatus, ownerClientId, revision: snapshot.revision,
        status, turnId: status === 'active' ? snapshot.turnId : null, lastTurnId: snapshot.turnId,
        lastTurnStatus: snapshot.lastTurnStatus ?? (status === 'active' ? 'inProgress' : status === 'idle' && !snapshot.userStopped ? 'completed' : null),
        userStopped: snapshot.userStopped, userEpoch: snapshot.userEpoch, stateSource: 'rollout',
        tokenUsage: { last: { inputTokens: snapshot.inputTokens }, modelContextWindow: snapshot.modelContextWindow } };
    } finally { if (!shared) await reader.close(); }
  }

  async idleState(threadId, context) {
    const state = await this.status(threadId);
    if (state.status !== 'idle') throw new CodexError('thread-not-idle');
    if (state.userStopped) throw new CodexError('user-stopped');
    if (state.goalStatus === 'active') throw new CodexError('active-goal-unsupported');
    if (context.expectedTurnId != null && state.lastTurnId !== context.expectedTurnId) throw new CodexError('stale-turn');
    if (context.isCurrent && context.isCurrent() !== true) throw new CodexError('stale-action');
    return state;
  }

  async compact(threadId, context = {}) {
    const state = await this.idleState(threadId, context);
    const response = await this.request('thread-follower-compact-thread', { conversationId: threadId }, { targetClientId: state.ownerClientId, mutation: true, isCurrent: context.isCurrent });
    if (response.result?.ok !== true) throw new CodexError('invalid-compaction-response', undefined, { ambiguous: true });
    return { accepted: true, completed: false, threadId, ownerClientId: state.ownerClientId };
  }

  async resume(threadId, text, context = {}) {
    if (typeof text !== 'string' || text.trim() === '') throw new CodexError('empty-input');
    const state = await this.idleState(threadId, context);
    const response = await this.request('thread-follower-start-turn', {
      conversationId: threadId,
      turnStart: {
        request: { threadId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text, text_elements: [] }] },
        context: { inheritThreadSettings: true },
      },
    }, { targetClientId: state.ownerClientId, mutation: true, isCurrent: context.isCurrent });
    const turnId = response.result?.result?.turn?.id;
    if (typeof turnId !== 'string') throw new CodexError('invalid-resume-response', undefined, { ambiguous: true });
    return { accepted: true, threadId, turnId, ownerClientId: state.ownerClientId };
  }

  async steer(threadId, expectedTurnId, text, { isCurrent } = {}) {
    if (typeof text !== 'string' || text.trim() === '') throw new CodexError('empty-input');
    if (typeof expectedTurnId !== 'string' || !expectedTurnId) throw new CodexError('missing-expected-turn');
    const state = await this.status(threadId);
    if (state.status !== 'active' || !state.turnId) throw new CodexError('thread-not-active');
    if (state.userStopped) throw new CodexError('user-stopped');
    if (state.goalStatus === 'active') throw new CodexError('active-goal-unsupported');
    if (state.turnId !== expectedTurnId) throw new CodexError('stale-turn');
    if (isCurrent && isCurrent() !== true) throw new CodexError('stale-action');
    const clientUserMessageId = randomUUID();
    // The owner selects the native turn. Our expected-turn check is local;
    // return the native receipt's turn id without claiming atomic targeting.
    const response = await this.request('thread-follower-steer-turn', {
      conversationId: threadId,
      clientUserMessageId,
      input: [{ type: 'text', text, text_elements: [] }],
      restoreMessage: { id: clientUserMessageId, text, context: {} },
    }, { targetClientId: state.ownerClientId, mutation: true, isCurrent });
    const turnId = response.result?.result?.turnId;
    if (typeof turnId !== 'string' || !turnId) throw new CodexError('invalid-steer-response', undefined, { ambiguous: true });
    return { accepted: true, threadId, turnId, ownerClientId: state.ownerClientId };
  }

  close() {
    this.disposed = true;
    this.readers.clear();
    if (!this.closed) this.fail(new CodexError('closed'));
    this.socket?.destroy();
  }
}
