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
  assert.deepEqual([r[0].sessionId, r[0].cost, r[0].minutes, r[0].by], ['s1', 41.4, 18, 'cost']);
  assert.equal(r[0].burn, '$41.40 in 18 min');
  assert.equal(S.runaways(turns, { runawayDollars: 45 }, NOW).length, 0);
  assert.equal(S.runaways(turns, { runawayMinutes: 45 }, NOW)[0].cost, 71.4);
  assert.deepEqual(S.runaways(turns, { runawayDollars: 0 }, NOW), []);
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

// ── rules.js spend block ────────────────────────────────────────────────────
const live = (id, signal = 'tool-use', over = {}) => ({ sessionId: id, cwd: `/w/${id}`, signal, updatedAt: new Date().toISOString(), ...over });
const env = (over = {}) => ({ spend: { budget: { level: null }, budgetText: null, runaway: [], ...over } });

test('rules: spend signals are virtual, remappable signals', () => {
  for (const id of ['runaway', 'budget-warning', 'budget-exceeded']) assert.equal(R.SIGNALS.find((s) => s.id === id)?.kind, 'virtual', id);
  assert.equal(R.SIGNALS.at(-1).id, 'idle');
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
  const sp = env({ runaway: [{ sessionId: 'a', burn: '$47.20 in 18 min' }] }).spend;
  const first = note(new Set(), { sessions: [live('a', 'tool-use', { hostApp: 'iTerm2' })], spend: sp });
  assert.equal(first.fire.length, 1);
  assert.deepEqual([first.fire[0].kind, first.fire[0].sessionId, first.fire[0].hostApp], ['runaway', 'a', 'iTerm2']);
  assert.equal(first.fire[0].title, 'Runaway session — a');
  assert.match(first.fire[0].body, /\$47\.20 in 18 min/);
  assert.equal(note(first.keys, { sessions: [live('a')], spend: sp }).fire.length, 0, 'held: no repeat');
  assert.equal(note(new Set(), { sessions: [live('a')], spend: sp }, { spend: { notifyRunaway: false } }).fire.length, 0, 'muted');
  assert.equal(note(new Set(), { sessions: [live('a')], spend: sp }, { notifyOnStates: false }).fire.length, 0, 'master switch');
});

test('help: budget notifies once per level per period', () => {
  const sp = env({ budget: { level: 'exceeded', which: 'day', dayKey: 'Wed Sep 30 2026' }, budgetText: '$60.00 of $50.00 today' }).spend;
  const r = note(new Set(), { sessions: [live('a'), live('b')], spend: sp });
  assert.equal(r.fire.length, 1);
  assert.deepEqual([r.fire[0].title, r.fire[0].body], ['Over budget', '$60.00 of $50.00 today.']);
  assert.equal(note(r.keys, { sessions: [live('a')], spend: sp }).fire.length, 0);
  assert.equal(note(new Set(), { sessions: [live('a')], spend: sp }, { spend: { notifyBudget: false } }).fire.length, 0);
});

test('help: the panel explains the spend rules', () => {
  const rules = R.defaultRules().map(R.normalizeRule);
  const e = env({ runaway: [{ sessionId: 'a', burn: '$47.20 in 18 min' }] });
  const { look, fired, owned } = R.resolve(rules, [live('a')], Date.now(), e);
  const h = Help.explain({ look, fired, owned, firedNames: R.firedNames(rules, fired, owned), sessions: [live('a')] }, rules);
  assert.equal(h.headline, 'Runaway session');
  assert.match(h.meaning, /runaway threshold/);
});
