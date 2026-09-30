// F1 spend: spend.js (budgets, runaway detection), the rules.js spend block
// and the help.js spend notifications.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../spend.js');
const R = require('../rules.js');
const Help = require('../help.js');

// Wednesday 2026-09-30 12:00 local.
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const MIN = 60000;
const DAY = 86400000;
// An Opus turn costing `dollars` (output tokens at $25/M).
const turn = (ts, dollars, over = {}) => ({ ts, sessionId: 's1', cwd: '/w/proj', project: 'proj', model: 'claude-opus-5', modelKey: 'opus', input: 0, output: Math.round(dollars * 40000), cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...over });
const sorted = (list) => list.sort((a, b) => a.ts - b.ts);

// ── spend.js ────────────────────────────────────────────────────────────────
test('normalize: defaults, clamps and a bad mode', () => {
  assert.deepEqual(S.normalize(undefined), S.DEFAULTS);
  const n = S.normalize({ mode: 'free', dailyBudget: -5, warnAt: 7, runawayMinutes: 0, runawayDollars: 'x', notifyBudget: false });
  assert.equal(n.mode, 'api');
  assert.equal(n.dailyBudget, 0);
  assert.equal(n.warnAt, 1);
  assert.equal(n.runawayMinutes, 1);
  assert.equal(n.runawayDollars, 40);
  assert.equal(n.notifyBudget, false);
  assert.equal(S.normalize({ mode: 'subscription' }).mode, 'subscription');
});

test('the runaway default sits above the measured p99 of 20-minute session spend ($35.24)', () => {
  assert.equal(S.DEFAULTS.runawayMinutes, 20);
  assert.ok(S.DEFAULTS.runawayDollars > 35.24);
});

test('startOfWeek: Monday 00:00 local, including on a Sunday and a Monday', () => {
  assert.equal(S.startOfWeek(NOW), new Date(2026, 8, 28).getTime());
  assert.equal(S.startOfWeek(new Date(2026, 9, 4, 23).getTime()), new Date(2026, 8, 28).getTime());
  assert.equal(S.startOfWeek(new Date(2026, 8, 28, 0, 1).getTime()), new Date(2026, 8, 28).getTime());
});

test('budgetStatus: today and this week, the worse level wins, unpriced turns are skipped', () => {
  const turns = sorted([
    turn(NOW - 3 * DAY, 100), // last Sunday: not this week
    turn(NOW - 2 * DAY, 30), // Monday
    turn(NOW - 60 * MIN, 8),
    turn(NOW - 5 * MIN, 1, { modelKey: null, model: '<synthetic>' }),
    turn(NOW + 5 * MIN, 50), // the future is ignored
  ]);
  const off = S.budgetStatus(turns, {}, NOW);
  assert.equal(off.level, null);
  assert.equal(off.day.spent, 8);
  assert.equal(off.week.spent, 38);
  const warn = S.budgetStatus(turns, { dailyBudget: 10 }, NOW);
  assert.deepEqual([warn.level, warn.which, warn.day.share], ['warning', 'day', 0.8]);
  const over = S.budgetStatus(turns, { dailyBudget: 10, weeklyBudget: 35 }, NOW);
  assert.deepEqual([over.level, over.which], ['exceeded', 'week']);
  const both = S.budgetStatus(turns, { dailyBudget: 5, weeklyBudget: 45 }, NOW);
  assert.deepEqual([both.level, both.which], ['exceeded', 'day']);
  assert.equal(S.budgetStatus(turns, { dailyBudget: 20 }, NOW).level, null);
});

test('runaways: a session over the $ threshold inside the window, with its burn rate', () => {
  const turns = sorted([
    turn(NOW - 40 * MIN, 30), // outside the 20 min window
    turn(NOW - 18 * MIN, 20),
    turn(NOW - 2 * MIN, 21.4),
    turn(NOW - 10 * MIN, 39, { sessionId: 's2', cwd: '/w/other', project: 'other' }),
    turn(NOW - 10 * MIN, 99, { sessionId: null }),
  ]);
  const r = S.runaways(turns, {}, NOW);
  assert.equal(r.length, 1);
  // s1 had a turn before the window, so its burn is timed over the whole window.
  assert.deepEqual([r[0].sessionId, r[0].cost, r[0].minutes, r[0].by], ['s1', 41.4, 20, 'cost']);
  assert.equal(r[0].burn, '$41.40 in 20 min');
  assert.equal(S.runaways(turns, { runawayDollars: 45 }, NOW).length, 0);
  assert.equal(S.runaways(turns, { runawayMinutes: 45 }, NOW)[0].cost, 71.4);
  assert.deepEqual(S.runaways(turns, { runawayDollars: 0 }, NOW), []);
});

test('runaways: a session with no earlier turn is timed from its first turn, in seconds under a minute', () => {
  const born = [turn(NOW - 18 * MIN, 20), turn(NOW - 2 * MIN, 21.4)];
  assert.equal(S.runaways(born, {}, NOW)[0].burn, '$41.40 in 18 min');
  const quick = [turn(NOW - 45000, 41)];
  assert.equal(S.runaways(quick, {}, NOW)[0].burn, '$41.00 in 45 s');
  // An earlier turn two windows back is too old to count as "previous".
  const old = [turn(NOW - 50 * MIN, 1), turn(NOW - 10 * MIN, 41)];
  assert.equal(S.runaways(old, {}, NOW)[0].burn, '$41.00 in 10 min');
});

test('latchRunaways: one episode per crossing, held until under half the threshold', () => {
  const t = sorted([turn(NOW - 10 * MIN, 20), turn(NOW - 5 * MIN, 21)]);
  const a = S.latchRunaways(new Map(), t, {}, NOW);
  assert.deepEqual([a.list.length, a.list[0].firedAt], [1, NOW]);
  // 12 min on, only the $21 turn is left in the window: under $40, over $20.
  const b = S.latchRunaways(a.latched, t, {}, NOW + 12 * MIN);
  assert.deepEqual([b.list.length, b.list[0].firedAt, b.list[0].cost], [1, NOW, 21], 'same episode, same firedAt');
  assert.equal(S.runaways(t, {}, NOW + 12 * MIN).length, 0, 'stateless: not over');
  assert.equal(S.latchRunaways(new Map(), t, {}, NOW + 12 * MIN).list.length, 0, 'a new latch needs the full threshold');
  // 16 min on the window is empty: released.
  const c = S.latchRunaways(b.latched, t, {}, NOW + 16 * MIN);
  assert.equal(c.list.length, 0);
  const again = sorted(t.concat(turn(NOW + 17 * MIN, 45)));
  assert.equal(S.latchRunaways(c.latched, again, {}, NOW + 18 * MIN).list[0].firedAt, NOW + 18 * MIN, 'a new crossing is a new episode');
});

test('snapshot: with a latch it holds runaways; without, it is stateless', () => {
  const t = [turn(NOW - 5 * MIN, 41)];
  const first = S.snapshot(t, {}, NOW, new Map());
  assert.ok(first.latch instanceof Map);
  const held = S.snapshot([turn(NOW - 5 * MIN, 30)], {}, NOW + MIN, first.latch);
  assert.equal(held.runaway.length, 1);
  assert.equal(S.snapshot([turn(NOW - 5 * MIN, 30)], {}, NOW + MIN).runaway.length, 0);
});

test('budgetStatus counts unpriced turns today and this week', () => {
  const t = sorted([turn(NOW - 2 * DAY, 1, { modelKey: null }), turn(NOW - MIN, 1, { modelKey: null }), turn(NOW - MIN, 3)]);
  const b = S.budgetStatus(t, {}, NOW);
  assert.deepEqual([b.day.unpriced, b.week.unpriced, b.day.spent], [1, 2, 3]);
});

test('readSince covers this week and two runaway windows', () => {
  assert.equal(S.readSince({}, NOW), S.startOfWeek(NOW));
  const monday = new Date(2026, 8, 28, 0, 10).getTime();
  assert.equal(S.readSince({}, monday), monday - 40 * MIN);
});

test('runaways: a token-rate threshold fires on its own and says tokens', () => {
  const turns = [turn(NOW - 5 * MIN, 1, { output: 0, cacheWrite: 600000 })];
  const r = S.runaways(turns, { runawayDollars: 0, runawayTokens: 500000 }, NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].by, 'tokens');
  assert.equal(r[0].burn, '600k tokens in 5 min');
  // Cache reads are re-sent context, not new work.
  assert.equal(S.runaways([turn(NOW - 5 * MIN, 0, { cacheRead: 9e6 })], { runawayDollars: 0, runawayTokens: 500000 }, NOW).length, 0);
});

test('snapshot: labels a subscription as an API-price equivalent', () => {
  const turns = [turn(NOW - 5 * MIN, 12)];
  const api = S.snapshot(turns, { dailyBudget: 10 }, NOW);
  assert.match(api.unit, /USD/);
  assert.equal(api.budgetText, '$12.00 of $10.00 today');
  const sub = S.snapshot(turns, { mode: 'subscription', dailyBudget: 10 }, NOW);
  assert.match(sub.unit, /equivalent/);
  assert.equal(sub.budgetText, '$12.00 of $10.00 today (API-price equivalent)');
  assert.equal(S.snapshot(turns, {}, NOW).budgetText, null);
});

test('budgetStatus and runaways only walk turns inside their windows', () => {
  let reads = 0;
  const old = Array.from({ length: 1000 }, (_, i) => turn(NOW - 30 * DAY + i, 1));
  const recent = [turn(NOW - MIN, 1)];
  const turns = new Proxy(old.concat(recent), { get(t, k) { if (/^\d+$/.test(String(k))) reads += 1; return t[k]; } });
  S.budgetStatus(turns, {}, NOW);
  S.runaways(turns, {}, NOW);
  assert.ok(reads <= 4, `read ${reads} turns`);
});

test('tracker: recomputes only on new turns, new settings or a new minute, and keeps the latch', () => {
  const tr = S.tracker();
  const t = sorted([turn(NOW - 10 * MIN, 20), turn(NOW - 5 * MIN, 21)]);
  const a = tr.snapshot(t, 1, {}, NOW);
  assert.equal(tr.snapshot(t, 1, {}, NOW + 30000), a, 'same minute: memoized');
  assert.equal(tr.computed, 1);
  tr.snapshot(t, 2, {}, NOW + 30000);
  tr.snapshot(t, 2, { dailyBudget: 5 }, NOW + 30000);
  assert.equal(tr.computed, 3);
  // 12 min on only $21 is in the window: held by the latch, same episode.
  const held = tr.snapshot(t, 2, { dailyBudget: 5 }, NOW + 12 * MIN);
  assert.deepEqual([held.runaway.length, held.runaway[0].firedAt], [1, NOW]);
});

test('usage worker: reads off the main thread, then says unchanged until a file changes', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Worker } = require('worker_threads');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-worker-'));
  fs.mkdirSync(path.join(root, 'p'));
  const line = (i) => `${JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: new Date().toISOString(), requestId: `r${i}`, message: { id: `m${i}`, model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`;
  fs.writeFileSync(path.join(root, 'p', 's.jsonl'), line(0));
  const w = new Worker(path.join(__dirname, '..', 'src', 'usage-worker.js'));
  const ask = (id) => new Promise((resolve) => { w.once('message', resolve); w.postMessage({ id, root, since: 0 }); });
  try {
    const a = await ask(1);
    assert.deepEqual([a.id, a.unchanged, a.turns.length, a.parsed], [1, false, 1, 1]);
    const b = await ask(2);
    assert.deepEqual([b.unchanged, b.turns], [true, null]);
    fs.appendFileSync(path.join(root, 'p', 's.jsonl'), line(1));
    const c = await ask(3);
    assert.deepEqual([c.unchanged, c.turns.length, c.parsed], [false, 2, 1]);
  } finally {
    await w.terminate();
  }
});

// ── rules.js spend block ────────────────────────────────────────────────────
const live = (id, signal = 'tool-use', over = {}) => ({ sessionId: id, cwd: `/w/${id}`, signal, updatedAt: new Date().toISOString(), ...over });
const env = (over = {}) => ({ spend: { budget: { level: null }, budgetText: null, runaway: [], ...over } });

test('rules: spend signals are virtual, remappable signals', () => {
  for (const id of ['runaway', 'budget-warning', 'budget-exceeded']) assert.equal(R.SIGNALS.find((s) => s.id === id)?.kind, 'virtual', id);
  // F2's git signals are appended after the session signals; idle still closes those.
  assert.equal(R.SIGNALS.filter((s) => s.kind !== 'git').at(-1).id, 'idle');
});

test('rules: default spend rules sit under offline and above Task finished', () => {
  const ids = R.defaultRules().map((r) => r.id);
  assert.equal(ids.indexOf('runaway'), ids.indexOf('offline') + 1);
  assert.ok(ids.indexOf('runaway') < ids.indexOf('working'));
  assert.ok(ids.indexOf('working') < ids.indexOf('budget-exceeded'));
  assert.equal(ids.indexOf('budget-warning'), ids.indexOf('budget-exceeded') + 1);
  assert.equal(ids.indexOf('done'), ids.indexOf('budget-warning') + 1);
});

test('rules: a runaway working session turns the lamp red with its burn rate', () => {
  const e = env({ runaway: [{ sessionId: 'a', burn: '$47.20 in 18 min' }] });
  const { look } = R.resolve(R.defaultRules(), [live('a'), live('b')], Date.now(), e);
  assert.deepEqual([look.lamp, look.lampFx, look.eyes, look.ruleId], ['red', 'pulse', 'wide', 'runaway']);
  // A rule of your own can put the burn rate on the sign.
  const mine = [{ id: 'm', when: { signal: ['runaway'] }, then: { lamp: 'red', pose: 'banner', text: '{burn}' } }];
  assert.equal(R.resolve(mine, [live('a')], Date.now(), e).look.text, '$47.20 in 18 min');
  // Once its turn ends the burn has stopped.
  assert.equal(R.resolve(R.defaultRules(), [live('a', 'stop')], Date.now(), e).look.ruleId, 'done');
  // A runaway the widget has no live session for stays off the lamp.
  assert.equal(R.resolve(R.defaultRules(), [live('b')], Date.now(), e).look.ruleId, 'working');
  assert.equal(R.resolve(R.defaultRules(), [], Date.now(), e).look.ruleId, 'idle');
});

test('rules: over budget is red at turn end, near it amber with money eyes; working stays green', () => {
  const over = env({ budget: { level: 'exceeded' }, budgetText: '$60.00 of $50.00 today' });
  assert.equal(R.resolve(R.defaultRules(), [live('a')], Date.now(), over).look.lamp, 'green');
  const done = R.resolve(R.defaultRules(), [live('a', 'stop')], Date.now(), over).look;
  assert.deepEqual([done.lamp, done.ruleId, done.eyes], ['red', 'budget-exceeded', 'money']);
  const near = R.resolve(R.defaultRules(), [live('a', 'idle-nudge')], Date.now(), env({ budget: { level: 'warning' } })).look;
  assert.deepEqual([near.lamp, near.ruleId, near.eyes], ['amber', 'budget-warning', 'money']);
  assert.equal(R.resolve(R.defaultRules(), [], Date.now(), over).look.ruleId, 'idle', 'never on an empty desk');
  assert.equal(R.fillText('{budget}', R.spendSessions([live('a')], over)[0]), '$60.00 of $50.00 today');
});

test('rules: no env.spend (usage not read yet) changes nothing', () => {
  assert.deepEqual(R.spendSessions([live('a')], {}), []);
  assert.deepEqual(R.spendSessions([live('a')], undefined), []);
});

test('rules v8: spend rules are slotted in once; deleting them sticks', () => {
  const ids = R.SPEND_RULES.map((r) => r.id);
  const v6 = R.defaultRules().filter((r) => !ids.includes(r.id)).map(R.normalizeRule);
  for (const from of [6, 7]) {
    const m = R.migrateRules(v6, from);
    assert.deepEqual(m.map((r) => r.id), R.defaultRules().map((r) => r.id), `from v${from}`);
    assert.deepEqual(R.migrateRules(m, from), m, 'never duplicated');
  }
  assert.equal(R.RULES_VERSION, 8);
});

test('rules v8: spend rules deleted on v8 stay deleted, one or all', () => {
  const ids = R.SPEND_RULES.map((r) => r.id);
  const none = R.defaultRules().filter((r) => !ids.includes(r.id)).map(R.normalizeRule);
  assert.equal(R.migrateRules(none, 8), none);
  const noRunaway = R.defaultRules().filter((r) => r.id !== 'runaway').map(R.normalizeRule);
  assert.equal(R.migrateRules(noRunaway, 8), noRunaway);
  assert.ok(!R.migrateRules(noRunaway, 8).some((r) => r.id === 'runaway'));
  // Carried forward through a later version too.
  assert.equal(R.migrateRules(none, 9), none);
});

test('rules: editing a default spend rule does not leak into the next defaults', () => {
  R.defaultRules().find((r) => r.id === 'runaway').then.lamp = 'green';
  assert.equal(R.defaultRules().find((r) => r.id === 'runaway').then.lamp, 'red');
});

// ── help.js spend notifications ─────────────────────────────────────────────
const note = (prev, next, config = {}) => Help.notifications(prev, { sessions: [], pending: [], offline: false, ...next }, config);

test('help: a runaway notifies once per episode and names the burn and terminal', () => {
  const sp = env({ runaway: [{ sessionId: 'a', burn: '$47.20 in 18 min', firedAt: 1 }] }).spend;
  const first = note(new Set(), { sessions: [live('a', 'tool-use', { hostApp: 'iTerm2' })], spend: sp });
  assert.equal(first.fire.length, 1);
  assert.deepEqual([first.fire[0].kind, first.fire[0].sessionId, first.fire[0].hostApp], ['runaway', 'a', 'iTerm2']);
  assert.equal(first.fire[0].title, 'Runaway session — a');
  assert.match(first.fire[0].body, /\$47\.20 in 18 min/);
  assert.equal(note(new Set(), { sessions: [live('a')], spend: sp }, { spend: { notifyRunaway: false } }).fire.length, 0, 'muted');
  assert.equal(note(new Set(), { sessions: [live('a')], spend: sp }, { notifyOnStates: false }).fire.length, 0, 'master switch');
});

test('help: a runaway does not re-fire when its turn ends and the next one starts', () => {
  const sp = env({ runaway: [{ sessionId: 'a', cwd: '/w/a', burn: '$47.20 in 18 min', firedAt: 1 }] }).spend;
  let keys = note(new Set(), { sessions: [live('a')], spend: sp }).keys;
  for (const signal of ['stop', 'idle-nudge', 'prompt-submit', 'tool-use']) {
    const r = note(keys, { sessions: [live('a', signal)], spend: sp });
    assert.equal(r.fire.length, 0, signal);
    keys = r.keys;
  }
  // Nor when the session file is gone altogether (a headless run).
  assert.equal(note(keys, { sessions: [], spend: sp }).fire.length, 0);
  const lone = note(new Set(), { sessions: [], spend: sp });
  assert.equal(lone.fire[0].title, 'Runaway session — a', 'a runaway with no live session still notifies, named from the transcript');
  // A new episode (the latch released and re-fired) is a new notification.
  const next = env({ runaway: [{ sessionId: 'a', burn: '$41.00 in 9 min', firedAt: 2 }] }).spend;
  assert.equal(note(keys, { sessions: [live('a')], spend: next }).fire.length, 1);
});

test('help: budget notifies once per level per period, from spend alone', () => {
  const b = { level: 'exceeded', which: 'day', dayKey: 'Wed Sep 30 2026', weekKey: 'Mon Sep 28 2026' };
  const sp = env({ budget: b, budgetText: '$60.00 of $50.00 today' }).spend;
  // An empty desk: still one notice (keys don't come from sessions).
  const r = note(new Set(), { sessions: [], spend: sp });
  assert.equal(r.fire.length, 1);
  assert.deepEqual([r.fire[0].title, r.fire[0].body], ['Over budget', '$60.00 of $50.00 today.']);
  let keys = r.keys;
  for (const sessions of [[live('a')], [], [live('b'), live('c')], []]) {
    const x = note(keys, { sessions, spend: sp });
    assert.equal(x.fire.length, 0, 'session churn never re-fires');
    keys = x.keys;
  }
  // Sticky: the level dipping (budget raised) and coming back is the same notice.
  const dip = note(keys, { sessions: [], spend: env({ budget: { ...b, level: null } }).spend });
  assert.equal(note(dip.keys, { sessions: [], spend: sp }).fire.length, 0);
  // Warning then exceeded are two notices; a new day is a new one.
  const warn = note(new Set(), { sessions: [], spend: { ...sp, budget: { ...b, level: 'warning' } } });
  assert.equal(note(warn.keys, { sessions: [], spend: sp }).fire.length, 1);
  assert.equal(note(keys, { sessions: [], spend: { ...sp, budget: { ...b, dayKey: 'Thu Oct 01 2026' } } }).fire.length, 1);
  assert.equal(note(new Set(), { sessions: [], spend: sp }, { spend: { notifyBudget: false } }).fire.length, 0);
});

test('help: the panel explains the spend rules', () => {
  const rules = R.defaultRules().map(R.normalizeRule);
  const e = env({ runaway: [{ sessionId: 'a', burn: '$47.20 in 18 min' }] });
  const { look, fired, owned } = R.resolve(rules, [live('a')], Date.now(), e);
  const h = Help.explain({ look, fired, owned, firedNames: R.firedNames(rules, fired, owned), sessions: [live('a')] }, rules);
  assert.equal(h.headline, 'Runaway session');
  assert.match(h.meaning, /runaway threshold/);
});
