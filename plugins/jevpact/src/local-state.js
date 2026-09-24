import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const GOAL_STATUS = new Map([
  ['active', 'active'], ['paused', 'paused'], ['blocked', 'blocked'],
  ['usage_limited', 'usageLimited'], ['budget_limited', 'budgetLimited'], ['complete', 'complete'],
]);
const unavailable = code => Object.assign(new Error(code), { code });

/** Native Core indexes, verified against 0.155.0-alpha.9.2. No writes or retained DB handles. */
export class LocalState {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
    this.codexHome = codexHome;
  }

  query(file, sql, threadId, failureCode) {
    let db;
    try {
      db = new DatabaseSync(path.join(this.codexHome, file), { readOnly: true });
      return db.prepare(sql).get(threadId);
    } catch {
      // Database errors can contain paths or SQL. Expose only the failed source.
      throw unavailable(failureCode);
    } finally { db?.close(); }
  }

  locate(threadId) {
    if (typeof threadId !== 'string' || !threadId) throw unavailable('invalid-thread-id');
    const thread = this.query('state_5.sqlite',
      'SELECT id, rollout_path, cwd, model FROM threads WHERE id = ?', threadId, 'thread-index-unavailable');
    if (!thread) throw unavailable('thread-not-indexed');
    if (thread.id !== threadId || typeof thread.rollout_path !== 'string' || !path.isAbsolute(thread.rollout_path)
      || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)) throw unavailable('invalid-thread-index');

    // Core reads and persists native ThreadGoal by exact thread_id in this DB.
    // No row means no native goal; failure to open/query it means unavailable.
    const goal = this.query('goals_1.sqlite',
      'SELECT status FROM thread_goals WHERE thread_id = ?', threadId, 'goal-state-unavailable');
    if (goal && !GOAL_STATUS.has(goal.status)) throw unavailable('invalid-goal-status');
    return { threadId, rolloutPath: thread.rollout_path, cwd: thread.cwd,
      model: thread.model ?? null, goalStatus: goal ? GOAL_STATUS.get(goal.status) : null };
  }
}
