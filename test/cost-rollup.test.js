'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Usage = require('../usage.js');
const Rollup = require('../src/cost-rollup.js');
const View = require('../usage-where-view.js');

const NOW = new Date(2026, 9, 19, 15, 0).getTime();
const H = 3600000, D = 24 * H;
// 1M output tokens on Sonnet = exactly $10.
const turn = (o) => ({ ts: NOW - H, sessionId: 's0', cwd: '/Users/a/shop', branch: 'main', model: 'claude-sonnet-4-5', modelKey: 'sonnet', input: 0, output: 1e6, cacheRead: 0, cacheWrite: 0, ...o });

test('cost-rollup: ranges cover whole local days, and the previous period is the same length just before', () => {
  const w = Rollup.windowsOf('today', NOW);
  assert.equal(w.from, new Date(2026, 9, 19).getTime());
  assert.equal(w.prevFrom, new Date(2026, 9, 18).getTime());
  assert.equal(w.prevTo, w.from);
  const w7 = Rollup.windowsOf('7d', NOW);
  assert.equal(w7.from, new Date(2026, 9, 13).getTime());
  assert.equal(w7.prevFrom, new Date(2026, 9, 6).getTime());
  assert.equal(Rollup.windowsOf('30d', NOW).from, new Date(2026, 8, 20).getTime());
  assert.equal(Rollup.windowsOf('bogus', NOW).range, '7d');
});

test('cost-rollup: totals and trend per range; old and future turns are left out', () => {
  const turns = [turn({}), turn({ ts: NOW - 3 * D }), turn({ ts: NOW - 8 * D }), turn({ ts: NOW - 40 * D }), turn({ ts: NOW + H }), turn({ modelKey: null, model: 'mystery' })];
  const today = Rollup.rollup({ turns, range: 'today', now: NOW });
  assert.equal(today.total.usd, 10);
  assert.equal(today.total.unpriced, 1);
  assert.equal(today.total.turns, 2);
  assert.equal(today.total.prevUsd, 0);
  assert.equal(today.total.change, null);
  const week = Rollup.rollup({ turns, range: '7d', now: NOW });
  assert.equal(week.total.usd, 20);
  assert.equal(week.total.prevUsd, 10);
  assert.equal(week.total.change, 1);
  assert.equal(Rollup.rollup({ turns, range: '30d', now: NOW }).total.usd, 30);
});

test('cost-rollup: by project, branch, PR/card and model, with shares', () => {
  const tasks = [
    { provider: 'claude', session_id: 's1', card_id: 'c1', title: 'Fix login', repo: 'acme/shop', pr: { number: 42 } },
    { provider: 'claude', session_id: 's2', card_id: 'c2', title: 'Tidy docs', repo: 'acme/shop', pr: null },
    { provider: 'claude', session_id: 's1', card_id: 'c9', title: 'Second capture ignored' },
    { provider: 'codex', session_id: 's3', card_id: 'c3', title: 'Not priced here' },
  ];
  const turns = [
    turn({ sessionId: 's1', output: 3e6 }),
    turn({ sessionId: 's2', branch: 'docs' }),
    turn({ sessionId: 's3', cwd: '/Users/a/api', branch: null, model: 'claude-opus-4-1', modelKey: 'opus', output: 4e5 }),
  ];
  const r = Rollup.rollup({ turns, tasks, records: [{ adapter: 'claude', session_id: 's1', title: 'Fix the login flow' }], range: '7d', now: NOW });
  assert.equal(r.total.usd, 50);
  assert.deepEqual(r.by.project.map((x) => [x.label, x.usd]), [['shop', 40], ['api', 10]]);
  assert.equal(r.by.project[0].share, 0.8);
  assert.deepEqual(r.by.branch.map((x) => x.label), ['shop · main', 'api · no branch', 'shop · docs']);
  assert.deepEqual(r.by.pr.map((x) => [x.label, x.usd, x.pr ?? null]), [['PR #42 · Fix the login flow', 30, 42], ['No card or PR', 10, null], ['Tidy docs', 10, null]]);
  assert.deepEqual(r.by.model.map((x) => [x.label, x.usd]), [['Sonnet', 40], ['Opus', 10]]);
});

test('cost-rollup: top N then one "other" bucket that sums the rest', () => {
  const turns = Array.from({ length: 12 }, (_, i) => turn({ cwd: `/p/proj${i}`, output: (i + 1) * 1e5, ts: NOW - H, sessionId: `s${i}` }))
    .concat(Array.from({ length: 12 }, (_, i) => turn({ cwd: `/p/proj${i}`, output: 1e5, ts: NOW - 9 * D })));
  const r = Rollup.rollup({ turns, range: '7d', now: NOW, top: 3 });
  assert.equal(r.by.project.length, 4);
  assert.deepEqual(r.by.project.slice(0, 3).map((x) => x.label), ['proj11', 'proj10', 'proj9']);
  const other = r.by.project[3];
  assert.equal(other.other, true);
  assert.equal(other.label, '9 others');
  assert.equal(other.usd, 45);
  assert.equal(other.prevUsd, 9);
  assert.equal(other.change, 4);
  const sum = r.by.project.reduce((s, x) => s + x.usd, 0);
  assert.ok(Math.abs(sum - r.total.usd) < 1e-9);
  assert.equal(Rollup.rollup({ turns, range: '7d', now: NOW }).by.project.length, Rollup.TOP + 1);
});

test('usage view model: sorting keeps "other" last, formats money, trend and the PR line; strings stay plain', () => {
  const tasks = [{ provider: 'claude', session_id: 'a', card_id: 'c1', title: 'Fix a < b & "c" ${x}', pr: { number: 7 } }];
  const turns = [turn({ sessionId: 'a', output: 2e6 }), turn({ sessionId: 'b', cwd: '/x/<b>bold</b>', output: 1e6 }), turn({ sessionId: 'b', cwd: '/x/z', output: 5e5, ts: NOW - 9 * D })];
  const data = { ...Rollup.rollup({ turns, tasks, range: '7d', now: NOW, top: 1 }), basis: 'b', saving: 'About 50% …' };
  const vm = View.viewModel(data, { dim: 'project' });
  assert.equal(vm.summary, '$30.00 last 7 days');
  assert.equal(vm.vs, '+500% on the previous 7 days ($5.00)');
  assert.equal(vm.saving, 'About 50% …');
  assert.deepEqual(vm.rows.map((r) => [r.label, r.cost, r.share, r.trend, r.other]), [['shop', '$20.00', '67%', 'new', false], ['1 other', '$10.00', '33%', 'new', true]]);
  assert.equal(vm.rows[0].bar, 100);
  const asc = View.viewModel(data, { dim: 'project', sort: 'usd', dir: 'asc' });
  assert.equal(asc.rows[asc.rows.length - 1].other, true, 'other stays last');
  const pr = View.viewModel(Rollup.rollup({ turns, tasks, range: '7d', now: NOW }), { dim: 'pr', sort: 'label', dir: 'asc' });
  const row = pr.rows.find((r) => r.prCost);
  assert.equal(row.prCost, 'This PR cost $20.00');
  assert.equal(row.label, 'PR #7 · Fix a < b & "c" ${x}', 'kept as text for textContent');
  assert.equal(View.viewModel(Rollup.rollup({ turns: [], range: 'today', now: NOW })).summary, 'No AI spend in this window yet.');
  assert.equal(View.viewModel(null), null);
  assert.ok(Usage.costOf(turn({})) === 10);
});
