'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const View = require('../src/usage-pop-view.js');
const AppMenu = require('../src/app-menu.js');

// Wednesday 30 Sep 2026, local noon: the budget week began Monday the 28th.
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const at = (day, hour) => new Date(2026, 8, day, hour, 0, 0).getTime();
// 1M output tokens: $25 on Opus, $10 on Sonnet (usage.js prices).
const turn = (ts, modelKey, output = 1e6) => ({ ts, modelKey, input: 0, output, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });

test('today, this week and the top model, with the money and token wording', () => {
  const s = View.build([turn(at(28, 10), 'sonnet'), turn(at(30, 9), 'opus', 1e5), turn(at(30, 10), 'sonnet', 3e5)], { now: NOW });
  assert.deepEqual(s.rows.map((r) => r.id), ['today', 'week', 'model']);
  assert.equal(s.rows[0].value, '$5.50 · 400k new tokens');
  assert.equal(s.rows[1].value, '$15.50');
  assert.equal(s.rows[2].value, 'Sonnet · 55% of spend');
  assert.equal(s.empty, null);
});

test('rows with no data behind them are omitted, never zero', () => {
  const lastWeek = View.build([turn(at(25, 10), 'opus')], { now: NOW });
  assert.deepEqual(lastWeek.rows, []);
  assert.match(lastWeek.empty, /Nothing recorded/);
  const earlierThisWeek = View.build([turn(at(28, 10), 'opus')], { now: NOW });
  assert.deepEqual(earlierThisWeek.rows.map((r) => r.id), ['week']);
  const unpriced = View.build([turn(at(30, 9), null)], { now: NOW });
  assert.deepEqual(unpriced.rows, []);
  assert.deepEqual(View.build(null, { now: NOW }).rows, []);
});

test('a turn after "now" is not counted', () => {
  assert.deepEqual(View.build([turn(at(30, 13), 'opus')], { now: NOW }).rows, []);
});

test('a tiny spend never gives a share over 100% or a 0% model, and omits the model row below a cent', () => {
  // 1 cent on Sonnet and half a cent on Opus: each rounds to $0.01 alone, so rounded costs gave a 133% share
  const tiny = View.build([turn(at(30, 9), 'sonnet', 1000), turn(at(30, 10), 'opus', 200)], { now: NOW });
  const m = tiny.rows.find((r) => r.id === 'model');
  assert.match(m.value, /^Sonnet · 67% of spend$/);
  assert.equal(View.build([turn(at(30, 9), 'opus', 100)], { now: NOW }).rows.find((r) => r.id === 'model'), undefined);
  const one = View.build([turn(at(30, 9), 'opus', 1e5)], { now: NOW }).rows.find((r) => r.id === 'model');
  assert.equal(one.value, 'Opus · 100% of spend');
  assert.equal(one.label, 'Busiest model today');
});

test('token wording rounds to k and M', () => {
  assert.equal(View.tokenText(950), '950 new tokens');
  assert.equal(View.tokenText(1499), '1k new tokens');
  assert.equal(View.tokenText(182400), '182k new tokens');
  assert.equal(View.tokenText(1250000), '1.3M new tokens');
});

test('the note says what the dollars are', () => {
  assert.equal(View.build([], { now: NOW }).note, 'Estimated from published per-token prices.');
  assert.match(View.build([], { now: NOW, mode: 'subscription' }).note, /published per-token prices; your plan is not billed per token/);
});

test('there is no plan-limit row: nothing on disk says how much of the limit is used', () => {
  const s = View.build([turn(at(30, 9), 'opus')], { now: NOW });
  assert.ok(!JSON.stringify(s).match(/limit of|5-hour/i));
});

test('the menu opens a pop-out for a page that has one, the page for the rest', () => {
  const PAGES = [{ id: 'usage', title: 'Usage', group: 'g', kind: 'window' }, { id: 'team', title: 'Team', group: 'g', kind: 'page' }];
  const opened = [];
  const items = AppMenu.appItems({ pages: PAGES, groups: [{ id: 'g' }], open: (id) => opened.push(id ?? null), openLabel: 'Open', popOuts: { usage: () => opened.push('pop') } });
  items.find((i) => i.label === 'Open Usage…').click();
  items.find((i) => i.label === 'Open Team…').click();
  assert.deepEqual(opened, ['pop', 'team']);
});

test('the pop-out page keeps the strict CSP, uses textContent only and exposes four calls', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'usage-pop.html'), 'utf8');
  assert.ok(html.includes("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'"));
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'usage-pop.js'), 'utf8'), /innerHTML|insertAdjacentHTML|outerHTML/);
  const names = [...fs.readFileSync(path.join(root, 'usage-pop-preload.js'), 'utf8').matchAll(/^  (\w+): /gm)].map((m) => m[1]);
  assert.deepEqual(names, ['get', 'onUpdate', 'openFull', 'close']);
});
