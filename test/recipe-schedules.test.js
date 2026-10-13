'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../src/recipe-schedules.js');

const H = 3600_000, D = 24 * H;
const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();
const dirs = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rsched-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('normalize accepts the five kinds and rejects the rest', () => {
  assert.deepEqual(S.normalize({ kind: 'off', time: 'x' }), { kind: 'off' });
  assert.deepEqual(S.normalize({ kind: 'nightly', time: '22:30' }), { kind: 'nightly', time: '22:30' });
  assert.deepEqual(S.normalize({ kind: 'weekly', day: 1, time: '09:00', extra: 1 }), { kind: 'weekly', day: 1, time: '09:00' });
  assert.deepEqual(S.normalize({ kind: 'hours', every: 4 }), { kind: 'hours', every: 4 });
  for (const bad of [null, {}, { kind: 'nightly' }, { kind: 'nightly', time: '24:00' }, { kind: 'weekly', day: 7, time: '09:00' }, { kind: 'hours', every: 5 }, { kind: 'monthly', time: '09:00' }]) assert.equal(S.normalize(bad), null, JSON.stringify(bad));
});

test('nextRun: nightly is the next occurrence of the time, strictly after now, across midnight and a DST change', () => {
  const s = { kind: 'nightly', time: '22:00' };
  assert.equal(S.nextRun(s, at(2026, 10, 13, 9, 0)), at(2026, 10, 13, 22, 0));
  assert.equal(S.nextRun(s, at(2026, 10, 13, 22, 0)), at(2026, 10, 14, 22, 0), 'exactly on the slot goes to the next one');
  assert.equal(S.nextRun(s, at(2026, 10, 13, 23, 59)), at(2026, 10, 14, 22, 0));
  // Around a clock change the slot stays at 22:00 local even though the day is 23 or 25 hours long.
  for (const [y, m, d] of [[2026, 3, 29], [2026, 10, 25], [2026, 3, 8], [2026, 11, 1]]) {
    const n = S.nextRun(s, at(y, m, d, 1, 0));
    const dt = new Date(n);
    assert.equal(`${dt.getHours()}:${dt.getMinutes()}`, '22:0', `${y}-${m}-${d}`);
    assert.equal(dt.getDate(), d);
  }
});

test('nextRun: weekdays skip the weekend, weekly lands on its day, hours step from the last run', () => {
  const fri = at(2026, 10, 16, 23, 0); // a Friday evening
  assert.equal(new Date(S.nextRun({ kind: 'weekdays', time: '08:00' }, fri)).getDay(), 1, 'Monday');
  assert.equal(S.nextRun({ kind: 'weekdays', time: '08:00' }, fri), at(2026, 10, 19, 8, 0));
  assert.equal(S.nextRun({ kind: 'weekly', day: 3, time: '10:00' }, fri), at(2026, 10, 21, 10, 0), 'next Wednesday');
  assert.equal(S.nextRun({ kind: 'weekly', day: 5, time: '10:00' }, fri), at(2026, 10, 23, 10, 0), 'the same weekday a week on when today\'s slot passed');
  const t0 = at(2026, 10, 13, 9, 7);
  assert.equal(S.nextRun({ kind: 'hours', every: 4 }, t0), t0 + 4 * H);
  assert.equal(S.nextRun({ kind: 'hours', every: 4 }, t0, { lastRun: t0 - 3 * H }), t0 + H, 'from the last run');
  assert.equal(S.nextRun({ kind: 'hours', every: 4 }, t0, { lastRun: t0 - 30 * H }), t0 + 2 * H, 'a long sleep: the next slot on the grid after now, not a pile of missed ones');
  assert.equal(S.nextRun({ kind: 'off' }, t0), null);
});

test('describe and clock read naturally', () => {
  assert.equal(S.describe({ kind: 'nightly', time: '22:00' }), 'Every night at 22:00');
  assert.equal(S.describe({ kind: 'weekly', day: 1, time: '09:00' }), 'Every Monday at 09:00');
  assert.equal(S.describe({ kind: 'hours', every: 1 }), 'Every hour while this Mac is awake');
  assert.equal(S.describe({ kind: 'hours', every: 6 }), 'Every 6 hours while this Mac is awake');
  assert.equal(S.describe(null), 'Off');
  const now = at(2026, 10, 13, 9, 0);
  assert.equal(S.clock(at(2026, 10, 13, 22, 0), now), '22:00');
  assert.equal(S.clock(at(2026, 10, 15, 8, 5), now), 'Thu 08:05');
  assert.equal(S.clock(at(2026, 10, 30, 8, 5), now), '30 Oct 08:05');
});

test('the store keeps only well-formed entries and writes atomically with private modes', () => {
  const dir = temp();
  const store = S.createStore({ dataDir: path.join(dir, 'recipes') });
  assert.deepEqual(store.load(), {});
  store.save({ 'my-task': { schedule: { kind: 'nightly', time: '22:00' }, folder: '/r', paused: false, skipNext: false, nextRunAtMs: 5, lastRunAtMs: null, history: [{ at: 1, result: 'started', note: '', taskId: 'tsk_1' }, { at: 2, result: 'nonsense' }] }, 'BAD ID': { schedule: { kind: 'nightly', time: '22:00' }, folder: '/r' }, 'no-folder': { schedule: { kind: 'nightly', time: '22:00' } } });
  const got = store.load();
  assert.deepEqual(Object.keys(got), ['my-task']);
  assert.deepEqual(got['my-task'].history, [{ at: 1, result: 'started', note: '', taskId: 'tsk_1' }]);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(store.file)).filter((n) => n.endsWith('.tmp')).length, 0);
  fs.writeFileSync(store.file, '{not json');
  assert.deepEqual(store.load(), {}, 'a damaged file is an empty store, never a crash');
});

function rig({ now, run, canSchedule = () => true, exists = () => true } = {}) {
  const dir = temp();
  let clock = now ?? at(2026, 10, 13, 9, 0);
  const timers = [];
  const store = S.createStore({ dataDir: dir });
  const runs = [];
  const changes = [];
  const sched = S.createScheduler({
    store, exists, canSchedule, now: () => clock,
    run: run || (async (id, e) => { runs.push({ id, at: clock, folder: e.folder }); return { ok: true, id: `tsk_${runs.length}` }; }),
    setTimer: (fn, ms) => { const t = { fn, due: clock + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    onChange: () => changes.push(clock),
  });
  // Move the clock; fire timers that came due (one at a time, like the real loop).
  const advance = async (ms) => { clock += ms; for (;;) { const due = timers.filter((t) => t.due <= clock).sort((a, b) => a.due - b.due)[0]; if (!due) break; timers.splice(timers.indexOf(due), 1); await due.fn(); } };
  return { sched, store, runs, timers, changes, advance, clock: () => clock, set: (v) => { clock = v; } };
}

test('set, pause, skip next and remove update the store and the next run', () => {
  const r = rig();
  const s = r.sched.set('my-task', { kind: 'nightly', time: '22:00' }, '/repo');
  assert.equal(s.ok, true);
  assert.equal(s.entry.next, 'Next run 22:00');
  assert.equal(s.entry.label, 'Every night at 22:00');
  assert.equal(r.store.load()['my-task'].nextRunAtMs, at(2026, 10, 13, 22, 0));
  assert.equal(r.timers.length, 1, 'armed');
  assert.deepEqual(r.sched.set('my-task', { kind: 'bogus' }, '/repo'), { ok: false, error: 'Choose a repeat and a time.' });
  assert.deepEqual(r.sched.set('my-task', { kind: 'nightly', time: '22:00' }, ''), { ok: false, error: 'Choose the folder it should work in first.' });
  const p = r.sched.pause('my-task', true);
  assert.equal(p.entry.next, 'Paused'); assert.equal(p.entry.nextRunAtMs, null);
  assert.equal(r.timers.length, 0, 'nothing armed while paused');
  r.sched.pause('my-task', false);
  assert.equal(r.sched.view('my-task').nextRunAtMs, at(2026, 10, 13, 22, 0));
  const k = r.sched.skipNext('my-task');
  assert.equal(k.entry.nextRunAtMs, at(2026, 10, 14, 22, 0), 'skipped tonight, runs tomorrow');
  assert.equal(r.sched.set('my-task', { kind: 'off' }, null).ok, true);
  assert.deepEqual(r.sched.list(), []);
  assert.deepEqual(r.sched.pause('my-task', true), { ok: false, error: 'That recipe has no schedule.' });
  assert.equal(r.sched.remove('gone').ok, true);
});

test('a due run starts once, records history, and the next slot is armed; a long sleep runs once, not once per missed slot', async () => {
  const r = rig();
  r.sched.set('nightly-one', { kind: 'nightly', time: '22:00' }, '/repo');
  r.sched.start();
  await r.advance(12 * H); // 21:00: not yet
  assert.equal(r.runs.length, 0);
  await r.advance(2 * H); // 23:00
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].folder, '/repo');
  const e = r.store.load()['nightly-one'];
  assert.equal(e.history.length, 1); assert.equal(e.history[0].result, 'started'); assert.equal(e.history[0].taskId, 'tsk_1');
  assert.equal(e.nextRunAtMs, at(2026, 10, 14, 22, 0));
  // The Mac sleeps for four days: on wake, exactly one run, then tonight's slot.
  r.set(at(2026, 10, 18, 10, 0));
  r.sched.wake();
  await r.advance(0);
  assert.equal(r.runs.length, 2, 'one run for four missed nights');
  assert.equal(r.store.load()['nightly-one'].nextRunAtMs, at(2026, 10, 18, 22, 0));
  assert.equal(r.sched.view('nightly-one').history[0].when, '10:00');
});

test('the timer never waits more than an hour, so a clock jump is noticed', () => {
  const r = rig();
  r.sched.set('weekly-one', { kind: 'weekly', day: 1, time: '09:00' }, '/repo');
  assert.ok(r.timers[0].due - r.clock() <= H);
});

test('a run the spend guard holds is skipped with its note; a failed start is recorded; the next slot moves on either way', async () => {
  const answers = [{ ok: false, code: 'BUDGET_HELD', text: 'Your daily limit of $5 is reached.' }, { ok: false, error: 'Supervisor unreachable.' }, { ok: true, id: 'tsk_9' }];
  const r = rig({ run: async () => answers.shift() });
  r.sched.set('hourly', { kind: 'hours', every: 1 }, '/repo');
  r.sched.start();
  await r.advance(H + 1); await r.advance(H); await r.advance(H);
  const h = r.store.load().hourly.history;
  assert.deepEqual(h.map((x) => x.result), ['skipped', 'failed', 'started']);
  assert.equal(h[0].note, 'Skipped: Your daily limit of $5 is reached.');
  assert.equal(h[1].note, 'Supervisor unreachable.');
  assert.equal(h[2].taskId, 'tsk_9');
  const runs = r.sched.runsBetween(0, r.clock());
  assert.equal(runs.length, 3); assert.equal(runs[0].id, 'hourly');
});

test('without the Plus feature nothing is set and a due run is skipped with the plan note; a deleted recipe drops its schedule', async () => {
  let plus = true;
  const r = rig({ canSchedule: () => plus, exists: (id) => id !== 'gone' });
  r.sched.set('mine', { kind: 'hours', every: 1 }, '/repo');
  r.sched.set('gone', { kind: 'hours', every: 1 }, '/repo');
  plus = false;
  assert.equal(r.sched.set('other', { kind: 'nightly', time: '22:00' }, '/repo').code, 'PLAN_REQUIRED');
  r.sched.start();
  await r.advance(H + 1);
  const all = r.store.load();
  assert.equal(all.gone, undefined);
  assert.equal(all.mine.history[0].result, 'skipped');
  assert.match(all.mine.history[0].note, /not part of your current plan/);
  assert.equal(r.runs.length, 0);
});

test('history is capped and a run in progress is not started twice', async () => {
  let pending;
  const r = rig({ run: () => new Promise((res) => { pending = res; }) });
  r.sched.set('slow', { kind: 'hours', every: 1 }, '/repo');
  r.sched.start();
  await r.advance(H + 1).catch(() => {});
  const first = r.sched.tick(); // runs the pending call
  r.sched.wake(); r.sched.wake();
  pending({ ok: true, id: 'tsk_1' });
  await first;
  await new Promise((res) => setImmediate(res));
  assert.equal(r.store.load().slow.history.length, 1);
  const data = r.store.load();
  data.slow.history = Array.from({ length: 30 }, (_, i) => ({ at: i, result: 'started', note: '', taskId: null }));
  r.store.save(data);
  assert.equal(r.store.load().slow.history.length, S.HISTORY_MAX);
});
