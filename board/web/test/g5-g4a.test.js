import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, findAll } from '../js/h.js';
import { costText, boardCostRollup, dailyCapText } from '../js/cost.js';
import { needsYou, displayFace } from '../js/view.js';
import { topBar, needsYouSection } from '../js/render-board.js';
import { view, model } from './fixtures.js';

const ent = (v, elapsed_ms = 0) => ({ view: v, elapsed_ms, face: displayFace(v, { elapsed_ms }) });
const cost = (status, total_usd, reported_runs, unavailable_runs) => ({ status, total_usd, reported_runs, unavailable_runs });

test('cost text never shows $0 for an AI without dollar telemetry', () => {
  assert.equal(costText(cost('none', null, 0, 0)), null);
  assert.equal(costText(cost('unavailable', null, 0, 1)), 'unavailable');
  assert.equal(costText(cost('reported', 1.5, 1, 0)), '$1.50');
  assert.equal(costText(cost('partial', 2, 1, 2)), '$2 + 2 runs unavailable');
});

test('board rollup sums reported runs and stays partial when some are unavailable', () => {
  const r = boardCostRollup([view({ cost: cost('reported', 1.25, 1, 0) }), view({ cost: cost('unavailable', null, 0, 1) }), view({})]);
  assert.deepEqual(r, { total_usd: 1.25, reported_runs: 1, unavailable_runs: 1, status: 'partial' });
  assert.equal(boardCostRollup([view({ cost: cost('unavailable', null, 0, 2) })]).total_usd, null);
  assert.equal(boardCostRollup([]).status, 'none');
  assert.match(dailyCapText({ cap_usd: 10, spent_usd: 12, exceeded: true }), /cap reached/);
});

test('top bar shows the board total and the daily cap', () => {
  const m = model([ent(view({ cost: cost('partial', 3, 1, 1) }))], { board: { id: 'b', name: 'B', daily_cap: { cap_usd: 10, spent_usd: 3, exceeded: false } } });
  const t = textOf(topBar(m, {}));
  assert.match(t, /Spent \$3 \+ 1 run unavailable/);
  assert.match(t, /\$3 of \$10 today/);
});

test('Needs you orders by longest wait and shows it; ignores cards the viewer is not involved with', () => {
  const blocked = view({ id: 'c-b', key: 'BDL-2', run_state: 'blocked', blocked_kind: 'question', state_age_ms: 5 * 60_000 });
  const review = view({ id: 'c-r', key: 'BDL-3', run_state: 'in_review', state_age_ms: 3_600_000 });
  const budget = view({ id: 'c-u', key: 'BDL-4', run_state: 'failed', fail_kind: 'budget', state_age_ms: 60_000 });
  const stranger = view({ id: 'c-x', key: 'BDL-5', run_state: 'blocked', blocked_kind: 'question', state_age_ms: 9e9, assignee_ids: [], run: { owner: { member_id: 'm-bob' }, dispatched_by: { member_id: 'm-bob' } } });
  const running = view({ id: 'c-n', key: 'BDL-6' });
  const items = needsYou('m-alice', [blocked, review, budget, stranger, running].map((v) => ent(v)));
  assert.deepEqual(items.map((i) => i.key), ['BDL-3', 'BDL-2', 'BDL-4']);
  assert.deepEqual(items.map((i) => i.kind), ['review', 'waiting', 'budget']);
  const aged = needsYou('m-alice', [ent(blocked, 10 * 60_000), ent(review)]);
  assert.equal(aged[0].key, 'BDL-3', '1h review still waited longer than 15m');
  const n = needsYouSection(items, model([]));
  assert.match(textOf(n), /Needs you · 3/);
  assert.match(textOf(n), /BDL-3Ready for reviewwaiting 1h/);
  assert.equal(needsYouSection([], model([])), null);
});
