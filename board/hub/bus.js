// The event bus (D40): consumers read the append-only journal through their
// own cursor (bus_cursors), so delivery is at-least-once, survives restarts and
// never touches journal rows. Handlers must be idempotent on (consumer, seq).
//
// A consumer's rows are handled strictly in order; a failing row is retried
// with backoff and blocks that consumer only (never the hub, never others).

const BATCH = 200;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const TICK_MS = 5_000;
// ~10 min of retries on the same row, then it is dead-lettered and skipped.
export const DEAD_AFTER = 8;

export function createBus({ db, log, now = () => new Date().toISOString(), timers = { setTimeout, clearTimeout } }) {
  const consumers = new Map(); // name → {handler, kinds, running, again, failures, retryAt, timer, lastError}
  let tick = null;
  let stopped = false;

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
        c.again = false;
        const from = cursor(name);
        const rows = db.all('SELECT * FROM journal WHERE seq > ? ORDER BY seq LIMIT ?', from, BATCH);
        if (!rows.length) break;
        for (const row of rows) {
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
      c.failures = c.failSeq === current ? c.failures + 1 : 1;
      c.failSeq = current;
      c.lastError = { message: e?.message ?? String(e), at: now() };
      if (current != null && c.failures >= DEAD_AFTER) {
        db.run('INSERT OR IGNORE INTO bus_dead_letters (consumer, seq, error, at) VALUES (?, ?, ?, ?)', name, current, String(c.lastError.message).slice(0, 500), now());
        advance(name, current);
        log?.warn?.('bus row dead-lettered', { consumer: name, seq: current, err: c.lastError.message });
        c.failures = 0;
        c.failSeq = null;
        c.running = false;
        queueMicrotask(() => drain(name));
        return;
      }
      const delay = BACKOFF_MS[Math.min(c.failures - 1, BACKOFF_MS.length - 1)];
      log?.warn?.('bus consumer failed; retrying', { consumer: name, failures: c.failures, delay, err: c.lastError.message });
      c.timer = timers.setTimeout(() => { c.timer = null; drain(name); }, delay);
      c.timer?.unref?.();
    } finally {
      c.running = false;
    }
    if (c.again && !c.timer) drain(name);
  }

  const drainAll = () => { for (const name of consumers.keys()) drain(name); };

  return {
    /** subscribe(name, handler(row), {kinds?: string[]}) */
    subscribe(name, handler, { kinds = null } = {}) {
      if (consumers.has(name)) throw new Error(`bus consumer ${name} already subscribed`);
      consumers.set(name, { handler, kinds: kinds ? new Set(kinds) : null, running: false, again: false, failures: 0, failSeq: null, timer: null, lastError: null });
      cursor(name);
      queueMicrotask(() => drain(name));
    },
    /** Called after every commit that wrote journal rows. */
    poke: drainAll,
    start() {
      stopped = false;
      const loop = () => { drainAll(); tick = timers.setTimeout(loop, TICK_MS); tick?.unref?.(); };
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
