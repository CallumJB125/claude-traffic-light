const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../stats.js');

// Fixed local noon so day boundaries and hour buckets are unambiguous.
const T0 = new Date(2026, 8, 10, 12, 0, 0).getTime();
const day = (t = T0) => S.dayKey(t);
const sess = (over = {}) => ({ sessionId: 's1', signal: 'tool-use', cwd: '/Users/x/work/bondly', tool: 'Bash', updatedAt: '2026-09-10T12:00:00.000Z', ...over });

test('kindOf and sessionKind agree on what a session is doing', () => {
  assert.equal(S.kindOf([]), 'idle');
  assert.equal(S.kindOf([sess({ signal: 'permission-ask' })]), 'waiting');
  assert.equal(S.kindOf([sess({ signal: 'stop' })]), 'done');
  assert.equal(S.sessionKind(sess({ signal: 'limit-hit' })), 'waiting');
  assert.equal(S.sessionKind(sess({ signal: 'idle-nudge' })), 'done');
  assert.equal(S.sessionKind(sess()), 'working');
});

// ── pending-ask latency ────────────────────────────────────────────────────

test('trackAsks records how long a permission prompt sat before an answer', () => {
  const st = {};
  S.trackAsks(st, [sess({ signal: 'permission-ask' })], T0);
  assert.deepEqual(st.pending, { s1: T0 });
  // still waiting 30s later: nothing recorded yet
  assert.deepEqual(S.trackAsks(st, [sess({ signal: 'permission-ask' })], T0 + 30000), []);
  assert.equal((st.days || {})[day()], undefined);
  // answered at +45s
  const closed = S.trackAsks(st, [sess({ signal: 'tool-use' })], T0 + 45000);
  assert.deepEqual(closed, [{ sessionId: 's1', ms: 45000 }]);
  assert.deepEqual(st.days[day()].asks, [45000]);
  assert.deepEqual(st.pending, {});
});

test('trackAsks closes an ask when the session disappears entirely', () => {
  const st = {};
  S.trackAsks(st, [sess({ signal: 'limit-hit' })], T0);
  S.trackAsks(st, [], T0 + 10000);
  assert.deepEqual(st.days[day()].asks, [10000]);
});

test('trackAsks drops an ask nobody answered for hours as abandoned', () => {
  const st = {};
  S.trackAsks(st, [sess({ signal: 'permission-ask' })], T0);
  S.trackAsks(st, [sess({ signal: 'stop' })], T0 + 5 * 3600000);
  assert.deepEqual(((st.days || {})[day()] || { asks: [] }).asks, []);
  assert.deepEqual(st.pending, {});
});

test('a second prompt on the same session starts a fresh clock', () => {
  const st = {};
  S.trackAsks(st, [sess({ signal: 'permission-ask' })], T0);
  S.trackAsks(st, [sess({ signal: 'tool-use' })], T0 + 1000);
  S.trackAsks(st, [sess({ signal: 'permission-ask' })], T0 + 2000);
  S.trackAsks(st, [sess({ signal: 'stop' })], T0 + 9000);
  assert.deepEqual(st.days[day()].asks, [1000, 7000]);
});

test('latency reports median, worst and count', () => {
  assert.deepEqual(S.latency([]), { median: 0, worst: 0, count: 0 });
  assert.deepEqual(S.latency([3000, 1000, 2000]), { median: 2000, worst: 3000, count: 3 });
  assert.deepEqual(S.latency([1000, 2000, 3000, 6000]), { median: 2500, worst: 6000, count: 4 });
});

// ── hours accrual ──────────────────────────────────────────────────────────

test('tick accrues working time into the hour it happened in', () => {
  const st = {};
  S.tick(st, [sess()], T0, 4000);
  const d = st.days[day()];
  assert.equal(d.hours.length, 24);
  assert.equal(d.hours[12], 4000);
  assert.equal(d.hours.reduce((a, b) => a + b, 0), 4000);
  // a different hour lands in its own bucket
  const later = new Date(2026, 8, 10, 15, 30).getTime();
  S.tick(st, [sess()], later, 6000);
  assert.equal(st.days[day()].hours[15], 6000);
});

test('only working time is heat-mapped; waiting and idle are not', () => {
  const st = {};
  S.tick(st, [sess({ signal: 'permission-ask' })], T0, 4000);
  S.tick(st, [], T0, 4000);
  const d = st.days[day()];
  assert.equal(d.hours.reduce((a, b) => a + b, 0), 0);
  assert.equal(d.waiting, 4000);
  assert.equal(d.idle, 4000);
});

test('tick drops a long gap but still runs the event counters', () => {
  const st = {};
  S.tick(st, [sess({ signal: 'permission-ask' })], T0, 10 * 60000);
  assert.equal(st.days[day()], undefined);
  assert.deepEqual(st.pending, { s1: T0 });
});

// ── per-project shape and migration ────────────────────────────────────────

test('tick splits per-project time by that session\'s own kind', () => {
  const st = {};
  const sessions = [sess({ sessionId: 'a', cwd: '/x/alpha' }), sess({ sessionId: 'b', cwd: '/x/beta', signal: 'permission-ask' })];
  S.tick(st, sessions, T0, 4000);
  const p = st.days[day()].projects;
  assert.deepEqual(p.alpha, { working: 4000, waiting: 0, done: 0, peak: 1 });
  assert.deepEqual(p.beta, { working: 0, waiting: 4000, done: 0, peak: 1 });
});

test('per-project peak counts concurrent sessions in that folder', () => {
  const st = {};
  const two = [sess({ sessionId: 'a', cwd: '/x/alpha' }), sess({ sessionId: 'b', cwd: '/x/alpha' })];
  S.tick(st, two, T0, 4000);
  S.tick(st, [two[0]], T0 + 4000, 4000);
  assert.equal(st.days[day()].projects.alpha.peak, 2);
  assert.equal(st.days[day()].sessionsPeak, 2);
});

test('migrateDay upgrades the old numeric project shape', () => {
  const old = { working: 100, waiting: 0, idle: 0, done: 0, projects: { bondly: 60000 }, sessionsPeak: 2 };
  const d = S.migrateDay(old);
  assert.deepEqual(d.projects.bondly, { working: 60000, waiting: 0, done: 0, peak: 0 });
  assert.equal(d.hours.length, 24);
  assert.deepEqual(d.asks, []);
  assert.deepEqual(d.tools, {});
  assert.equal(d.cost, null);
  assert.equal(d.sessionsPeak, 2);
  // idempotent
  assert.deepEqual(S.migrateDay(d).projects.bondly, d.projects.bondly);
});

test('tick on a day written by an older build migrates it in place', () => {
  const st = { days: { [day()]: { working: 1000, waiting: 0, idle: 0, done: 0, projects: { alpha: 1000 }, sessionsPeak: 1 } } };
  S.tick(st, [sess({ cwd: '/x/alpha' })], T0, 4000);
  assert.deepEqual(st.days[day()].projects.alpha, { working: 5000, waiting: 0, done: 0, peak: 1 });
  assert.equal(st.days[day()].working, 5000);
});

test('summary reads an old-shaped store without mutating it', () => {
  const stored = { days: { [day()]: { working: 1000, waiting: 0, idle: 0, done: 0, projects: { alpha: 1000 }, sessionsPeak: 1 } } };
  const sum = S.summary(stored, T0, 7);
  assert.equal(sum.projects[0].name, 'alpha');
  assert.equal(sum.projects[0].working, 1000);
  assert.equal(stored.days[day()].projects.alpha, 1000);
});

// ── tool counts ────────────────────────────────────────────────────────────

test('countTools counts one call per distinct session event', () => {
  const st = {};
  S.countTools(st, [sess({ tool: 'Bash', updatedAt: 't1' })], T0);
  S.countTools(st, [sess({ tool: 'Bash', updatedAt: 't1' })], T0);  // same event, still on screen
  S.countTools(st, [sess({ tool: 'Bash', updatedAt: 't2' })], T0);
  S.countTools(st, [sess({ tool: 'Read', updatedAt: 't3' })], T0);
  assert.deepEqual(st.days[day()].tools.bondly, { Bash: 2, Read: 1 });
});

test('countTools files tool-failed separately', () => {
  const st = {};
  S.countTools(st, [sess({ signal: 'tool-failed', tool: 'Bash', updatedAt: 'f1' })], T0);
  assert.deepEqual(st.days[day()].failed.bondly, { Bash: 1 });
  assert.deepEqual(st.days[day()].tools, {});
});

test('countTools ignores non-tool signals and toolless events', () => {
  const st = {};
  S.countTools(st, [sess({ signal: 'stop', tool: 'Bash', updatedAt: 'a' })], T0);
  S.countTools(st, [sess({ signal: 'tool-use', tool: null, updatedAt: 'b' })], T0);
  assert.equal(st.days, undefined, 'nothing worth counting, so no day is created');
});

test('countTools forgets sessions that have gone away', () => {
  const st = {};
  S.countTools(st, [sess({ updatedAt: 't1' })], T0);
  S.countTools(st, [], T0);
  assert.deepEqual(st.seen, {});
});

test('topTools ranks per project and carries the failure count', () => {
  const d = {
    tools: { alpha: { Bash: 5, Read: 2 }, beta: { Edit: 9 } },
    failed: { alpha: { Bash: 3 } },
  };
  assert.deepEqual(S.topTools(d, 'alpha'), [
    { tool: 'Bash', count: 8, failed: 3 },
    { tool: 'Read', count: 2, failed: 0 },
  ]);
  assert.equal(S.topTools(d, null)[0].tool, 'Edit');
  assert.equal(S.topTools(d, 'alpha', 1).length, 1);
});

// ── cost snapshots ─────────────────────────────────────────────────────────

test('recordCost caches a day cost and ignores rubbish', () => {
  const st = {};
  S.recordCost(st, day(), 12.5);
  assert.equal(st.days[day()].cost, 12.5);
  S.recordCost(st, day(), 'nope');
  assert.equal(st.days[day()].cost, 12.5);
});

// ── summary and compare ────────────────────────────────────────────────────

test('summary rolls up days, projects, response times and cost', () => {
  const st = {};
  S.tick(st, [sess({ cwd: '/x/alpha' })], T0 - 86400000, 4000);
  S.tick(st, [sess({ cwd: '/x/alpha' })], T0, 8000);
  S.trackAsks(st, [sess({ signal: 'permission-ask' })], T0);
  S.trackAsks(st, [sess({ signal: 'stop' })], T0 + 20000);
  S.recordCost(st, day(), 3);
  const sum = S.summary(st, T0, 7);
  assert.equal(sum.days.length, 7);
  assert.equal(sum.days[6].key, day());
  assert.equal(sum.totals.working, 12000);
  assert.equal(sum.totals.cost, 3);
  assert.equal(sum.totals.response.median, 20000);
  assert.equal(sum.projects[0].name, 'alpha');
  assert.equal(sum.projects[0].ms, 12000);
  assert.equal(sum.days[6].response.count, 1);
});

test('compare measures today against the daily average of the days before', () => {
  const st = {};
  S.tick(st, [sess()], T0 - 2 * 86400000, 10000);
  S.tick(st, [sess()], T0 - 86400000, 20000);
  S.tick(st, [sess()], T0, 30000);
  const c = S.compare(st, T0, 7);
  assert.equal(c.working.value, 30000);
  assert.equal(c.working.average, 15000);
  assert.equal(c.working.delta, 15000);
  assert.equal(c.working.hasAverage, true);
});

test('compare says so when there is no history to compare against', () => {
  const st = {};
  S.tick(st, [sess()], T0, 5000);
  assert.equal(S.compare(st, T0, 7).working.hasAverage, false);
});

// ── formatting, pruning, export ────────────────────────────────────────────

test('fmt and fmtShort read the way a human would say it', () => {
  assert.equal(S.fmt(0), '0m');
  assert.equal(S.fmt(90 * 60000), '1h 30m');
  assert.equal(S.fmtShort(0), '—');
  assert.equal(S.fmtShort(4200), '4s');
  assert.equal(S.fmtShort(5 * 60000), '5m');
});

test('prune drops days past the keep window', () => {
  const st = { days: { [day(T0 - 90 * 86400000)]: S.emptyDay(), [day()]: S.emptyDay() } };
  S.prune(st, T0, 60);
  assert.deepEqual(Object.keys(st.days), [day()]);
});

test('toCsv emits a header and one row per day', () => {
  const st = {};
  S.tick(st, [sess({ cwd: '/x/alpha' })], T0, 4000);
  S.recordCost(st, day(), 1.5);
  const csv = S.toCsv(S.summary(st, T0, 3)).split('\n');
  assert.equal(csv.length, 4);
  assert.match(csv[0], /^day,working_ms,/);
  assert.match(csv[3], new RegExp(`^${day()},4000,`));
  assert.match(csv[3], /"alpha"/);
  assert.match(csv[3], /1\.5000/);
});
