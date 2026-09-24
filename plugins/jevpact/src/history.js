import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const DAY = 86_400_000;
const PAGE_SIZE = 4096;
// A transaction journals each original page at most once (page + 8 bytes).
// With cache spilling disabled there is one header, padded to SQLite's maximum
// sector size. Reserve it as well as the entire possible rollback journal.
const JOURNAL_HEADER_BYTES = 65_536;
const MIN_BYTES = JOURNAL_HEADER_BYTES + 6 * (2 * PAGE_SIZE + 8);
const allowance = maxBytes => Math.floor((maxBytes - JOURNAL_HEADER_BYTES) / (2 * PAGE_SIZE + 8)) * PAGE_SIZE;
const APPLICATION_ID = 0x4a565048;
const SCHEMA = `
CREATE TABLE history_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  max_bytes INTEGER NOT NULL, retention_ms INTEGER NOT NULL, next_id INTEGER NOT NULL,
  appended INTEGER NOT NULL DEFAULT 0,
  expired INTEGER NOT NULL DEFAULT 0, evicted INTEGER NOT NULL DEFAULT 0,
  dropped_expired INTEGER NOT NULL DEFAULT 0, dropped_capacity INTEGER NOT NULL DEFAULT 0,
  pruned_bytes INTEGER NOT NULL DEFAULT 0, dropped_bytes INTEGER NOT NULL DEFAULT 0,
  last_pruned_at INTEGER
);
CREATE TABLE history_events (
  id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, time INTEGER NOT NULL,
  event TEXT NOT NULL, payload BLOB NOT NULL, raw_bytes INTEGER NOT NULL
);
CREATE INDEX history_time ON history_events(time, id);
CREATE INDEX history_thread_time ON history_events(thread_id, time, id);
`;
const error = code => Object.assign(new Error(code), { code });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const full = failure => failure?.errcode === 13 || failure?.code === 'SQLITE_FULL';

function json(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    || Object.getOwnPropertySymbols(value).length) throw error('history-invalid-event');
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) json(item, seen);
  seen.delete(value);
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (failure) {
    try { db.exec('ROLLBACK'); } catch { /* SQLITE_FULL can already roll back. */ }
    throw failure;
  }
}

/** Private, globally capped diagnostic history. Callers redact and bound events. */
export class History {
  constructor({ directory, retentionDays = 30, maxBytes, budgetScope = 'global', now = Date.now, readOnly = false } = {}) {
    if (typeof directory !== 'string' || !directory) throw error('history-directory-required');
    if (budgetScope !== 'global') throw error('history-unsupported-budget-scope');
    if (typeof now !== 'function') throw error('history-invalid-clock');
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'history.sqlite');
    this.now = now;
    this.readOnly = readOnly;
    this.closed = false;
    if (!readOnly) {
      if (!integer(maxBytes) || maxBytes < MIN_BYTES) throw error('history-budget-too-small');
      if (!Number.isFinite(retentionDays) || !integer(retentionDays * DAY) || retentionDays <= 0) throw error('history-invalid-retention');
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const info = fs.lstatSync(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw error('history-unsafe-directory');
      fs.chmodSync(this.directory, 0o700);
    }
    const exists = fs.existsSync(this.file);
    if (readOnly && !exists) throw error('history-not-found');
    if (exists) {
      const info = fs.lstatSync(this.file);
      if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw error('history-unsafe-file');
    }
    try {
      this.db = new DatabaseSync(this.file, { readOnly });
      if (!readOnly) {
        fs.chmodSync(this.file, 0o600);
        this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA cache_spill = OFF; PRAGMA temp_store = MEMORY');
      }
      if (!exists) {
        this.db.exec(`PRAGMA page_size = ${PAGE_SIZE}; PRAGMA auto_vacuum = FULL; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`);
        this.setPageLimit(maxBytes);
        transaction(this.db, () => {
          this.db.exec(SCHEMA);
          this.db.prepare('INSERT INTO history_meta(singleton,max_bytes,retention_ms,next_id) VALUES (1,?,?,1)').run(maxBytes, retentionDays * DAY);
        });
      }
      if (this.db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID
        || this.db.prepare('PRAGMA user_version').get().user_version !== 1
        || this.db.prepare('PRAGMA page_size').get().page_size !== PAGE_SIZE
        || this.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 1) throw error('history-incompatible-schema');
      this.meta();
      if (!readOnly) {
        this.db.prepare('UPDATE history_meta SET max_bytes=?,retention_ms=? WHERE singleton=1').run(maxBytes, retentionDays * DAY);
        this.prune();
        this.trimFile(maxBytes);
        this.setPageLimit(maxBytes);
      }
    } catch (failure) {
      this.db?.close();
      if (!exists) { try { fs.unlinkSync(this.file); } catch { /* Only our new file. */ } }
      throw failure;
    }
  }

  assertOpen(write = false) {
    if (this.closed) throw error('history-closed');
    if (write && this.readOnly) throw error('history-read-only');
  }

  time() {
    const time = this.now();
    if (!integer(time)) throw error('history-invalid-clock');
    return time;
  }

  meta() {
    this.assertOpen();
    const meta = this.db.prepare('SELECT * FROM history_meta WHERE singleton=1').get();
    if (!meta || !integer(meta.max_bytes) || !integer(meta.retention_ms) || !integer(meta.next_id)) throw error('history-incompatible-schema');
    return meta;
  }

  setPageLimit(maxBytes) {
    const pages = allowance(maxBytes) / PAGE_SIZE;
    const result = this.db.prepare(`PRAGMA max_page_count = ${pages}`).get();
    if (result.max_page_count > pages) throw error('history-budget-too-small');
  }

  drop(kind, bytes) {
    const column = kind === 'expired' ? 'dropped_expired' : 'dropped_capacity';
    this.db.prepare(`UPDATE history_meta SET ${column}=${column}+1,dropped_bytes=dropped_bytes+? WHERE singleton=1`).run(bytes);
  }

  evictOldest() {
    const oldest = this.db.prepare('SELECT id,raw_bytes FROM history_events ORDER BY time,id LIMIT 1').get();
    if (!oldest) return false;
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM history_events WHERE id=?').run(oldest.id);
      this.db.prepare('UPDATE history_meta SET evicted=evicted+1,pruned_bytes=pruned_bytes+?,last_pruned_at=? WHERE singleton=1').run(oldest.raw_bytes, this.time());
    });
    return true;
  }

  trimFile(maxBytes) {
    while (fs.statSync(this.file).size > allowance(maxBytes)) {
      if (!this.evictOldest()) throw error('history-budget-too-small');
    }
  }

  insert(db, id, threadId, event, payload, bytes) {
    db.prepare('INSERT INTO history_events(id,thread_id,time,event,payload,raw_bytes) VALUES (?,?,?,?,?,?)')
      .run(id, threadId, event.time, event.event, payload, bytes);
  }

  fitsEmpty(threadId, event, payload, bytes, maxBytes) {
    const probe = new DatabaseSync(':memory:');
    try {
      probe.exec(`PRAGMA page_size=${PAGE_SIZE}; PRAGMA auto_vacuum=FULL; PRAGMA max_page_count=${allowance(maxBytes) / PAGE_SIZE}`);
      probe.exec(SCHEMA);
      probe.prepare('INSERT INTO history_meta(singleton,max_bytes,retention_ms,next_id) VALUES(1,?,?,1)').run(maxBytes, this.meta().retention_ms);
      this.insert(probe, this.meta().next_id, threadId, event, payload, bytes);
      return true;
    } catch (failure) { if (full(failure)) return false; throw failure; }
    finally { probe.close(); }
  }

  append(threadId, event) {
    this.assertOpen(true);
    if (typeof threadId !== 'string' || !threadId || !event || Array.isArray(event)
      || !integer(event.time) || typeof event.event !== 'string' || !event.event
      || Object.hasOwn(event, 'id') || Object.hasOwn(event, 'threadId')) throw error('history-invalid-event');
    json(event);
    const encoded = Buffer.from(JSON.stringify(event));
    const payload = deflateRawSync(encoded);
    const pruned = this.prune();
    const meta = this.meta();
    const result = { stored: false, id: null, pruned: { expired: pruned.expired, capacity: 0 }, droppedReason: null };
    if (event.time <= this.time() - meta.retention_ms) {
      this.drop('expired', encoded.length);
      return { ...result, droppedReason: 'expired' };
    }
    if (payload.length > allowance(meta.max_bytes)) {
      this.drop('capacity', encoded.length);
      return { ...result, droppedReason: 'capacity' };
    }
    if (!Number.isSafeInteger(meta.next_id + 1)) throw error('history-id-exhausted');
    let checked = false;
    for (;;) {
      try {
        transaction(this.db, () => {
          this.insert(this.db, meta.next_id, threadId, event, payload, encoded.length);
          this.db.prepare('UPDATE history_meta SET next_id=next_id+1,appended=appended+1 WHERE singleton=1').run();
        });
        return { ...result, stored: true, id: meta.next_id };
      } catch (failure) {
        if (!full(failure)) throw failure;
        if (!checked && !this.fitsEmpty(threadId, event, payload, encoded.length, meta.max_bytes)) {
          this.drop('capacity', encoded.length);
          return { ...result, droppedReason: 'capacity' };
        }
        checked = true;
        if (!this.evictOldest()) {
          this.drop('capacity', encoded.length);
          return { ...result, droppedReason: 'capacity' };
        }
        result.pruned.capacity++;
      }
    }
  }

  *read({ threadId, since, after = 0, event, limit } = {}) {
    this.assertOpen();
    if ((threadId !== undefined && (typeof threadId !== 'string' || !threadId))
      || (event !== undefined && (typeof event !== 'string' || !event))
      || (since !== undefined && !integer(since)) || !integer(after)
      || (limit !== undefined && !integer(limit))) throw error('history-invalid-filter');
    const meta = this.meta();
    const upperId = meta.next_id - 1;
    const conditions = ['id > ?', 'id <= ?', 'time > ?'];
    const parameters = [after, upperId, this.time() - meta.retention_ms];
    for (const [column, value] of [['thread_id', threadId], ['time', since], ['event', event]]) {
      if (value !== undefined) { conditions.push(`${column} ${column === 'time' ? '>=' : '='} ?`); parameters.push(value); }
    }
    const query = this.db.prepare(`SELECT id,thread_id,time,payload FROM history_events WHERE ${conditions.join(' AND ')} AND (time > ? OR (time = ? AND id > ?)) ORDER BY time,id LIMIT 1`);
    let lastTime = -1;
    let lastId = 0;
    let count = 0;
    while (limit === undefined || count < limit) {
      this.assertOpen();
      // get() finishes the SQLite read before yielding to an export consumer.
      const row = query.get(...parameters, lastTime, lastTime, lastId);
      if (!row) return;
      const value = JSON.parse(inflateRawSync(row.payload).toString('utf8'));
      lastTime = row.time;
      lastId = row.id;
      count++;
      yield { id: row.id, threadId: row.thread_id, ...value };
    }
  }

  prune() {
    this.assertOpen(true);
    const cutoff = this.time() - this.meta().retention_ms;
    const expired = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(raw_bytes),0) AS bytes FROM history_events WHERE time <= ?').get(cutoff);
    if (expired.count) transaction(this.db, () => {
      this.db.prepare('DELETE FROM history_events WHERE time <= ?').run(cutoff);
      this.db.prepare('UPDATE history_meta SET expired=expired+?,pruned_bytes=pruned_bytes+?,last_pruned_at=? WHERE singleton=1')
        .run(expired.count, expired.bytes, this.time());
    });
    return { expired: expired.count, capacity: 0 };
  }

  stats() {
    this.assertOpen();
    const meta = this.meta();
    const totals = this.db.prepare('SELECT COUNT(*) AS records,COUNT(DISTINCT thread_id) AS threads,MIN(time) AS oldestAt,MAX(time) AS newestAt,COALESCE(SUM(length(payload)),0) AS payloadBytes,COALESCE(SUM(raw_bytes),0) AS uncompressedBytes FROM history_events').get();
    const visible = this.db.prepare('SELECT COUNT(*) AS count FROM history_events WHERE time > ?').get(this.time() - meta.retention_ms).count;
    const databaseBytes = fs.statSync(this.file).size;
    let journalBytes = 0;
    try { journalBytes = fs.statSync(`${this.file}-journal`).size; }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    const mainMaxBytes = allowance(meta.max_bytes);
    return { ...totals, visibleRecords: visible, bytes: databaseBytes + journalBytes, databaseBytes, journalBytes,
      maxBytes: meta.max_bytes, effectiveMaxBytes: mainMaxBytes, mainMaxBytes,
      journalReserveBytes: JOURNAL_HEADER_BYTES + mainMaxBytes / PAGE_SIZE * (PAGE_SIZE + 8),
      retentionDays: meta.retention_ms / DAY, budgetScope: 'global', readOnly: this.readOnly,
      freePages: this.db.prepare('PRAGMA freelist_count').get().freelist_count,
      appended: meta.appended, pruned: { expired: meta.expired, capacity: meta.evicted, bytes: meta.pruned_bytes },
      dropped: { expired: meta.dropped_expired, capacity: meta.dropped_capacity, bytes: meta.dropped_bytes },
      lastPrunedAt: meta.last_pruned_at };
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
