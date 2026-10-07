// History view render: summary, lanes, bars with icon + label, empty state, keyboard roving tabindex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byAttr, textOf, findAll } from '../js/h.js';
import { historyScreen, barSummary } from '../js/render-history.js';
import { boardScreen } from '../js/render-board.js';
import { model } from './fixtures.js';

const T0 = Date.UTC(2026, 9, 7, 8), H = 3_600_000, iso = (h) => new Date(T0 + h * H).toISOString();
const run = (id, ai, s, e, extra = {}) => ({ id, card_id: `c-${id}`, key: `BDL-${id}`, title: `Card ${id}`, ai, ai_label: ai === 'codex' ? 'Codex' : 'Claude Code', outcome: e == null ? 'running' : 'finished', started_at: iso(s), ended_at: e == null ? null : iso(e), cost_usd: null, has_handover: false, ...extra });
const hist = (data, extra = {}) => ({ range: 'today', status: 'ok', data, from: T0 - 8 * H, to: T0 + 16 * H, now: T0 + 4 * H, selected: null, updated_at: T0, ...extra });
const screen = (history) => historyScreen({ ...model([]), history });

test('empty state teaches and offers a way forward; ranges are Today, 7 days, 30 days with Today pressed', () => {
  const v = screen(hist({ runs: [], observed: [] }));
  assert.match(textOf(v), /Nothing has run today\. Tackle a card with AI and it appears here\./);
  assert.equal(byAttr(v, 'data-view', 'board').length, 1);
  const ranges = byAttr(v, 'data-action', 'history-range');
  assert.deepEqual(ranges.map(textOf), ['Today', '7 days', '30 days']);
  assert.deepEqual(ranges.map((n) => n.props['aria-pressed']), ['true', 'false', 'false']);
});

test('bars carry icon, outcome label, duration and cost in their accessible name; unknown cost says so', () => {
  const v = screen(hist({ runs: [run('1', 'claude', 0, 0.5, { cost_usd: 0.4 }), run('2', 'codex', 1, null)], observed: [] }));
  const bars = byAttr(v, 'data-history-bar', '1');
  assert.equal(bars.length, 2);
  const names = bars.map((b) => b.props['aria-label']);
  assert.match(names[0], /Finished, 30 min, \$0\.40/);
  assert.match(names.find((n) => n.startsWith('Codex')), /Running, still going.*cost unavailable/);
  assert.ok(bars.every((b) => findAll(b, (n) => n.tag === 'svg').length === 1), 'icon on every bar');
  assert.equal(bars.filter((b) => b.props.tabindex === '0').length, 1, 'one tab stop; arrows move');
  assert.ok(bars.every((b) => b.props.style.left.endsWith('%')));
  assert.equal(byClass(v, 'hnow').length, 5, 'the now line crosses every lane');
  assert.equal(byClass(v, 'hlane').length, 5);
  assert.match(textOf(byClass(v, 'hist-tiles')[0]), /Runs today.*2.*Spend where known.*\$0\.40 \+ 1 not reported/);
});

test('selecting a bar without a handover says why', () => {
  const v = screen(hist({ runs: [run('1', 'claude', 0, 1, { outcome: 'failed' })], observed: [] }, { selected: '1' }));
  assert.match(textOf(byClass(v, 'hist-selected')[0]), /No handover yet\. The run ended before a handover was saved\./);
  assert.equal(barSummary({ ai_label: 'Claude Code', key: 'K-1', title: 't', outcome: 'stalled', durationMs: 60_000, running: false, cost_usd: null }).includes('Stalled'), true);
});

test('loading and error states; the board screen switcher lists History before the planning views', () => {
  assert.match(textOf(screen({ range: 'today', status: 'loading' })), /Reading what ran/);
  assert.match(textOf(screen({ range: 'today', status: 'error', error: 'boom' })), /Couldn’t load history\. boom/);
  const switcher = byClass(boardScreen(model([], { view: 'board' })), 'viewswitch-label').map(textOf);
  assert.ok(switcher.includes('History'));
});
