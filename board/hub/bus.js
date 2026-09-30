// The event bus (D40): consumers read the append-only journal through their
// own cursor (bus_cursors), so delivery is at-least-once, survives restarts and
// never touches journal rows. Handlers must be idempotent on (consumer, seq).
//
// A consumer's rows are handled strictly in order; a failing row is retried
// with backoff and blocks that consumer only (never the hub, never others).
// A handler that throws an error with `busy: true` is retried the same way
// but never dead-lettered for it.
// Consumers run in the context the bus was created in, never in the async
// context of whatever committed the row (a board queue, an integration's actor).

import { AsyncLocalStorage } from 'node:async_hooks';

const BATCH = 200;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const TICK_MS = 5_000;
// 8 tries on the same row (≈ 173 s of backoff: 1+2+5+15+30+60+60), then it
// is dead-lettered and skipped.
export const DEAD_AFTER = 8;

export function createBus({ db, log, now = () => new Date().toISOString(), timers = { setTimeout, clearTimeout } }) {
  const consumers = new Map(); // name → {handler, kinds, running, again, failures, retryAt, timer, lastError}
  let tick = null;
  let stopped = false;
  const root = AsyncLocalStorage.snapshot();

  function cursor(name) {
    const row = db.get('SELECT seq FROM bus_cursors WHERE consumer = ?', name);
    if (row) return row.seq;
    // A new consumer starts at the head: it serves what happens from now on,
    // it does not replay the board's whole history into Slack.
    const head = db.get('SELECT COALESCE(MAX(seq), 0) AS s FROM journal').s;
    db.run('INSERT INTO bus_cursors (consumer, seq, updated_at) VALUES (?, ?, ?)', name, head, now());
    return head;
  }

  function advance(name, seq) {
    db.run('UPDATE bus_cursors SET seq = ?, updated_at = ? WHERE consumer = ? AND seq < ?', seq, now(), name, seq);
  }

  async function drain(name) {
    const c = consumers.get(name);
    if (!c || stopped) return;
    if (c.running) { c.again = true; return; }
    if (c.timer) return; // backing off; the timer will drain
    c.running = true;
    let current = null;
    try {
      for (;;) {
        if (consumers.get(name) !== c) return;
        c.again = false;
        const from = cursor(name);
        const rows = db.all('SELECT * FROM journal WHERE seq > ? ORDER BY seq LIMIT ?', from, BATCH);
        if (!rows.length) break;
        for (const row of rows) {
          if (consumers.get(name) !== c) return; // unsubscribed meanwhile
          current = row.seq;
          if (!c.kinds || c.kinds.has(row.kind)) {
            const r = { ...row, payload: safeJson(row.payload) };
            await c.handler(r);
          }
          advance(name, row.seq);
          c.failures = 0;
          c.lastError = null;
          if (stopped) return;
        }
        if (rows.length < BATCH && !c.again) break;
      }
    } catch (e) {
      if (consumers.get(name) !== c) return;
      // A handler still busy with this row (a timed-out call that hasn't ended)
      // waits without moving the row toward the dead-letter queue.
      if (!e?.busy) {
        c.failures = c.failSeq === current ? c.failures + 1 : 1;
        c.failSeq = current;
      }
      c.lastError = { message: e?.message ?? String(e), at: now() };
      if (current != null && c.failures >= DEAD_AFTER) {
        db.run('INSERT OR IGNORE INTO bus_dead_letters (consumer, seq, error, at) VALUES (?, ?, ?, ?)', name, current, String(c.lastError.message).slice(0, 500), now());
        advance(name, current);
        log?.warn?.('bus row dead-lettered', { consumer: name, seq: current, err: c.lastError.message });
        c.failures = 0;
        c.failSeq = null;
        c.running = false;
        queueMicrotask(() => root(drain, name));
        return;
      }
      const delay = BACKOFF_MS[Math.max(0, Math.min(c.failures - 1, BACKOFF_MS.length - 1))];
      log?.warn?.('bus consumer failed; retrying', { consumer: name, failures: c.failures, delay, err: c.lastError.message });
      c.timer = timers.setTimeout(() => { c.timer = null; root(drain, name); }, delay);
      c.timer?.unref?.();
    } finally {
      c.running = false;
    }
    if (c.again && !c.timer) drain(name);
  }

  const drainAll = () => { for (const name of consumers.keys()) drain(name); };
  let poked = false;

  return {
    /** subscribe(name, handler(row), {kinds?: string[]}) */
    subscribe(name, handler, { kinds = null } = {}) {
      if (consumers.has(name)) throw new Error(`bus consumer ${name} already subscribed`);
      consumers.set(name, { handler, kinds: kinds ? new Set(kinds) : null, running: false, again: false, failures: 0, failSeq: null, timer: null, lastError: null });
      cursor(name);
      queueMicrotask(() => root(drain, name));
    },
    /** Stop delivering to `name` and forget its cursor (a revoked connection). */
    unsubscribe(name) {
      const c = consumers.get(name);
      if (!c) return;
      if (c.timer) timers.clearTimeout(c.timer);
      consumers.delete(name);
      db.run('DELETE FROM bus_cursors WHERE consumer = ?', name);
    },
    has: (name) => consumers.has(name),
    /** Called after every commit that wrote journal rows; drains on a later turn, never inside the committer. */
    poke() {
      if (poked) return;
      poked = true;
      root(setImmediate, () => { poked = false; drainAll(); });
    },
    start() {
      stopped = false;
      const loop = () => { root(drainAll); tick = timers.setTimeout(loop, TICK_MS); tick?.unref?.(); };
      tick = timers.setTimeout(loop, TICK_MS);
      tick?.unref?.();
    },
    stop() {
      stopped = true;
      if (tick) timers.clearTimeout(tick);
      for (const c of consumers.values()) if (c.timer) { timers.clearTimeout(c.timer); c.timer = null; }
    },
    /** For the health panel: backlog and last error per consumer. */
    health() {
      const head = db.get('SELECT COALESCE(MAX(seq), 0) AS s FROM journal').s;
      return [...consumers.entries()].map(([name, c]) => ({
        consumer: name, backlog: head - cursor(name), failures: c.failures, last_error: c.lastError,
        dead_letters: db.get('SELECT COUNT(*) AS n FROM bus_dead_letters WHERE consumer = ?', name).n,
      }));
    },
    // Test hook: resolve when every consumer is idle and caught up.
    async settle() {
      for (let i = 0; i < 100; i += 1) {
        await new Promise((r) => setImmediate(r));
        const head = db.get('SELECT COALESCE(MAX(seq), 0) AS s FROM journal').s;
        if ([...consumers.entries()].every(([n, c]) => !c.running && (c.timer || cursor(n) >= head))) return;
      }
    },
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
