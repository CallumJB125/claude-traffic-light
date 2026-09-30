// Dashboard render (render-dashboard.js): states, charts' text equivalents,
// and card rows that open the drawer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, byClass, byAttr, findAll, walk } from '../js/h.js';
import { dashboardScreen } from '../js/render-dashboard.js';
import { dashboardMetrics, DAY, HOUR } from '../js/metrics.js';
import { VIEWS } from '../js/views.js';
import { view, model } from './fixtures.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const at = (ago) => new Date(NOW - ago).toISOString();
let seq = 0;
const row = (card_id, kind, ago, payload) => ({ seq: ++seq, card_id, at_hub: at(ago), kind, payload });
const tr = (id, ago, from, to, kind = null) => row(id, 'card.transition', ago, { from, to, state: { blocked_kind: kind } });

const rows = [
  row('c-a', 'card.create', 5 * DAY, { key: 'BDL-1', title: 'Claude card' }),
  tr('c-a', 4 * DAY, 'todo', 'queued'), tr('c-a', 4 * DAY - HOUR, 'queued', 'claimed'), tr('c-a', 4 * DAY - 2 * HOUR, 'claimed', 'running'),
  tr('c-a', 3 * DAY, 'running', 'blocked', 'question'), tr('c-a', 3 * DAY - HOUR, 'blocked', 'running'),
  tr('c-a', 2 * DAY, 'running', 'in_review'), tr('c-a', DAY, 'in_review', 'done'),
  row('c-gone', 'card.create', 6 * DAY, { key: 'BDL-0', title: 'Deleted card' }),
  tr('c-gone', 5 * DAY, 'todo', 'queued'), tr('c-gone', 5 * DAY - HOUR, 'queued', 'claimed'), tr('c-gone', 5 * DAY - 2 * HOUR, 'claimed', 'running'),
  tr('c-gone', 4 * DAY, 'running', 'blocked', 'permission'), tr('c-gone', 3 * DAY, 'blocked', 'running'),
  row('c-h', 'card.create', 3 * DAY, { key: 'BDL-2', title: 'Human card' }),
  row('c-h', 'card.update', 2 * DAY, { fields: { column_name: ['todo', 'done'] } }),
];
const cards = [
  view({ id: 'c-a', key: 'BDL-1', title: 'Claude card', run_state: 'done', column: 'done', budget: { spent_usd: 2.5, cap_usd: 5 } }),
  view({ id: 'c-h', key: 'BDL-2', title: 'Human card', run_state: 'todo', column: 'done', run: null, budget: null }),
];
const dash = (extra = {}) => model([], { view: 'dashboard', dashboard: { status: 'ok', error: null, updated_at: NOW, metrics: dashboardMetrics({ rows, cards, now: NOW }), ...extra } });

test('Dashboard is a view in the switcher', () => {
  assert.deepEqual(VIEWS.filter((v) => v.switcher !== false).map((v) => v.id), ['board', 'table', 'dashboard']);
});

test('loading, error and empty states', () => {
  const loading = dashboardScreen(model([], { dashboard: { status: 'loading', metrics: null } }));
  assert.match(textOf(loading), /Reading the board’s history/);
  const err = dashboardScreen(model([], { dashboard: { status: 'error', error: 'Can’t reach the board.', metrics: null } }));
  assert.match(textOf(err), /Couldn’t load the board’s history\. Can’t reach the board\./);
  assert.equal(byAttr(err, 'data-action', 'dashboard-refresh').length, 1);
  assert.equal(byAttr(err, 'role', 'alert').length, 1);
  const empty = dashboardScreen(model([], { dashboard: { status: 'ok', updated_at: NOW, metrics: dashboardMetrics({ rows: [], cards: [], now: NOW }) } }));
  assert.match(textOf(empty), /Not enough history yet/);
  assert.equal(byClass(empty, 'dash-tiles').length, 0);
});

test('a failed refresh keeps the last numbers and says so', () => {
  const v = dashboardScreen(dash({ status: 'error', error: 'x' }));
  assert.equal(byClass(v, 'dash-tiles').length, 1);
  assert.match(textOf(v), /Refresh failed; showing the last good numbers/);
});

test('KPI tiles read the metrics', () => {
  const t = textOf(byClass(dashboardScreen(dash()), 'dash-tiles')[0]);
  assert.match(t, /Median cycle time/);
  assert.match(t, /Finished by Claude50%1 of 2 cards/);
  assert.match(t, /Time blocked1d 1h/);
  assert.match(t, /Spent on budgeted cards\$2\.5/);
});

test('every chart is a named figure with a hidden data table or visible text', () => {
  const v = dashboardScreen(dash());
  const figs = findAll(v, (n) => n.tag === 'figure');
  assert.equal(figs.length, 3);
  for (const f of figs) {
    assert.ok(f.props['aria-label']?.length > 20, 'figure has a summary');
    for (const svg of findAll(f, (n) => n.tag === 'svg')) assert.equal(svg.props['aria-hidden'], 'true');
  }
  const tables = findAll(v, (n) => n.tag === 'table');
  assert.equal(tables.length, 2);
  for (const t of tables) assert.equal(t.props.class, 'sr-only');
  assert.match(textOf(tables[0]), /Cards done per week/);
  // Bar lists carry their values as text.
  assert.match(textOf(byClass(v, 'dash-blocked')[0]), /Questions1h/);
  assert.match(textOf(byClass(v, 'dash-share')[0]), /Claude1 · 50%/);
});

test('cards in lists open the drawer; cards no longer on the board are plain text', () => {
  const v = dashboardScreen(dash());
  const opens = byAttr(v, 'data-action', 'open');
  assert.ok(opens.length >= 1);
  for (const b of opens) { assert.equal(b.tag, 'button'); assert.ok(['c-a', 'c-h'].includes(b.props['data-card'])); }
  const gone = byClass(v, 'is-gone');
  assert.equal(gone.length, 1);
  assert.match(textOf(gone[0]), /BDL-0Deleted card/);
});

test('empty panels say why instead of drawing an empty chart', () => {
  const m = dashboardMetrics({ rows: [], cards: [view({ id: 'x', budget: { spent_usd: 1, cap_usd: 2 } })], now: NOW });
  const v = dashboardScreen(model([], { dashboard: { status: 'ok', updated_at: NOW, metrics: m } }));
  assert.equal(findAll(v, (n) => n.tag === 'figure').length, 0);
  assert.match(textOf(byClass(v, 'dash-throughput')[0]), /no cards finished in the last 8 weeks/);
  assert.match(textOf(byClass(v, 'dash-blocked')[0]), /Nothing was blocked/);
});

test('card titles and keys from the journal or the board are only ever text (D25)', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const evilRows = [
    row('c-x', 'card.create', 3 * DAY, { key: evil, title: evil }),
    tr('c-x', 2 * DAY, 'todo', 'queued'), tr('c-x', 2 * DAY - HOUR, 'queued', 'claimed'), tr('c-x', 2 * DAY - 2 * HOUR, 'claimed', 'running'),
    tr('c-x', DAY, 'running', 'blocked', evil),
  ];
  const evilCards = [view({ id: 'c-y', key: evil, title: evil, labels: [evil], budget: { spent_usd: 1, cap_usd: 2 } })];
  const v = dashboardScreen(model([], { dashboard: { status: 'ok', updated_at: NOW, metrics: dashboardMetrics({ rows: evilRows, cards: evilCards, now: NOW }) } }));
  assert.ok(textOf(v).includes(evil));
  walk(v, (x) => {
    assert.ok(!('innerHTML' in x.props) && !('outerHTML' in x.props), 'no html props');
    assert.notEqual(x.tag, 'script');
    assert.notEqual(x.tag, 'img');
  });
});

test('cards with no budget are left out of the spend and the panel says how many', () => {
  const withUncapped = [...cards, view({ id: 'c-u', key: 'BDL-5', budget: null })];
  const m = dashboardMetrics({ rows, cards: withUncapped, now: NOW });
  const v = dashboardScreen(model([], { dashboard: { status: 'ok', updated_at: NOW, metrics: m } }));
  assert.match(textOf(byClass(v, 'dash-tiles')[0]), /Spent on budgeted cards\$2\.5/);
  assert.match(textOf(byClass(v, 'dash-cost')[0]), /2 cards have no budget, so their spend isn’t shown\./);
});

test('only the stale warning is live; Refresh stays focusable while busy', () => {
  const ok = dashboardScreen(dash());
  const live = byAttr(ok, 'aria-live');
  assert.equal(live.length, 1);
  assert.equal(textOf(live[0]), '', 'the minutely "updated" time is not announced');
  const stale = dashboardScreen(dash({ status: 'error', error: 'x' }));
  assert.match(textOf(byAttr(stale, 'aria-live')[0]), /Refresh failed/);
  const busy = dashboardScreen(dash({ status: 'loading' }));
  const btn = byAttr(busy, 'data-action', 'dashboard-refresh')[0];
  assert.equal(btn.props['aria-disabled'], 'true');
  assert.equal(btn.props.disabled, undefined);
});
