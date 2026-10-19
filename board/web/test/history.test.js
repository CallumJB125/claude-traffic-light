// History view: pure layout (time to x, lane packing, overlap stacking, summary, keyboard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeWindow, timeToX, packRows, buildHistory, unionMs, axisTicks, neighborBar, durationText, noHandoverReason } from '../js/history.js';

const T0 = Date.UTC(2026, 9, 7, 8, 0, 0), H = 3_600_000;
const run = (id, ai, startH, endH, extra = {}) => ({ id, card_id: `c-${id}`, key: `BDL-${id}`, title: `Card ${id}`, ai, ai_label: ai, outcome: endH == null ? 'running' : 'finished',
  started_at: new Date(T0 + startH * H).toISOString(), ended_at: endH == null ? null : new Date(T0 + endH * H).toISOString(), cost_usd: null, has_handover: false, ...extra });

test('rangeWindow: Today is local midnight to midnight; 7 and 30 days end at tomorrow midnight', () => {
  const now = new Date(2026, 9, 7, 15, 30).getTime();
  const t = rangeWindow('today', now), w = rangeWindow('7d', now), m = rangeWindow('30d', now);
  assert.equal(t.from, new Date(2026, 9, 7).getTime());
  assert.equal(t.to, new Date(2026, 9, 7, 17).getTime(), 'two hours past the current hour');
  assert.equal(rangeWindow('today', new Date(2026, 9, 7, 23, 30).getTime()).to, new Date(2026, 9, 8).getTime(), 'never past midnight');
  assert.equal(w.to, new Date(2026, 9, 8).getTime()); assert.equal(m.to, w.to);
  assert.equal(new Date(w.from).getDate(), 1);
  assert.ok(m.to - m.from <= 31 * 86_400_000);
});

test('timeToX maps and clamps', () => {
  assert.equal(timeToX(50, 0, 100), 0.5);
  assert.equal(timeToX(-5, 0, 100), 0);
  assert.equal(timeToX(500, 0, 100), 1);
  assert.equal(timeToX(5, 10, 10), 0);
});

test('packRows stacks overlapping bars and reuses a row once it is free', () => {
  const bars = [{ x0: 0, x1: 0.4 }, { x0: 0.2, x1: 0.6 }, { x0: 0.45, x1: 0.7 }, { x0: 0.3, x1: 0.35 }];
  assert.equal(packRows(bars), 3);
  assert.deepEqual(bars.map((b) => b.row), [0, 1, 0, 2]);
  assert.equal(packRows([]), 0);
});

test('buildHistory: one lane per AI, running bars extend to now, hermes-dgx joins Hermes, observed has its own lane', () => {
  const from = T0, to = T0 + 10 * H, now = T0 + 6 * H;
  const data = { runs: [run('1', 'claude', 1, 2), run('2', 'claude', 1.5, 3), run('3', 'hermes-dgx', 4, null), run('4', 'codex', 0, 1, { outcome: 'stalled' })],
    observed: [{ card_id: 'c-o', key: 'BDL-9', title: 'Seen', provider: 'cursor', started_at: new Date(T0 + 2 * H).toISOString(), ended_at: null, last_seen_at: new Date(T0 + 3 * H).toISOString(), status: 'working' }] };
  const out = buildHistory({ data, from, to, now });
  assert.deepEqual(out.lanes.map((l) => l.id), ['claude', 'codex', 'gemini', 'hermes', 'observed']);
  assert.equal(out.lanes[0].rows, 2, 'overlapping Claude runs stack');
  const running = out.lanes[3].bars[0];
  assert.equal(running.running, true);
  assert.equal(running.x1, 0.6, 'a running bar ends at now');
  assert.equal(out.nowX, 0.6);
  assert.equal(out.lanes[4].bars[0].outcome, 'observed');
  assert.equal(out.summary.runs, 4);
  assert.equal(out.summary.stalled, 1);
  assert.equal(out.empty, false);
});

test('summary: worked time counts overlap once; spend is null when no AI reported dollars, else partial', () => {
  const from = T0, to = T0 + 10 * H;
  const none = buildHistory({ data: { runs: [run('1', 'claude', 0, 2), run('2', 'codex', 1, 3)] }, from, to, now: to });
  assert.equal(none.summary.workedMs, 3 * H);
  assert.equal(none.summary.spendUsd, null);
  const some = buildHistory({ data: { runs: [run('1', 'claude', 0, 2, { cost_usd: 1.5 }), run('2', 'codex', 1, 3)] }, from, to, now: to });
  assert.equal(some.summary.spendUsd, 1.5);
  assert.equal(some.summary.spendUnknown, 1);
  assert.equal(unionMs([{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }], 0, 100), 30);
});

test('empty data is flagged; runs clipped to the window keep a visible minimum width', () => {
  assert.equal(buildHistory({ data: { runs: [] }, from: T0, to: T0 + H, now: T0 }).empty, true);
  const out = buildHistory({ data: { runs: [run('1', 'claude', -5, 0.00001)] }, from: T0, to: T0 + 10 * H, now: T0 });
  const b = out.lanes[0].bars[0];
  assert.equal(b.x0, 0);
  assert.ok(b.x1 > 0);
});

test('axisTicks and keyboard neighbours', () => {
  const ticks = axisTicks('today', new Date(2026, 9, 7).getTime(), new Date(2026, 9, 8).getTime());
  assert.equal(ticks.length, 8); assert.equal(ticks[0].label, '00:00');
  assert.equal(axisTicks('today', new Date(2026, 9, 7).getTime(), new Date(2026, 9, 7, 5).getTime()).length, 5, 'hourly on a short window');
  const out = buildHistory({ data: { runs: [run('1', 'claude', 0, 1), run('2', 'claude', 2, 3), run('3', 'codex', 2.2, 3), run('4', 'hermes', 5, 6)] }, from: T0, to: T0 + 10 * H, now: T0 });
  assert.equal(neighborBar(out.lanes, '1', 'ArrowRight'), '2');
  assert.equal(neighborBar(out.lanes, '1', 'ArrowLeft'), null);
  assert.equal(neighborBar(out.lanes, '2', 'ArrowDown'), '3');
  assert.equal(neighborBar(out.lanes, '3', 'ArrowDown'), '4', 'skips empty lanes');
  assert.equal(neighborBar(out.lanes, '4', 'ArrowDown'), null);
  assert.equal(neighborBar(out.lanes, '3', 'ArrowUp'), '2');
});

test('copy helpers', () => {
  assert.equal(durationText(30_000), 'under a minute');
  assert.equal(durationText(14 * 60_000), '14 min');
  assert.equal(durationText(95 * 60_000), '1 h 35 min');
  assert.match(noHandoverReason({ running: true }), /still going/);
  assert.match(noHandoverReason({ observed: true }), /observed/);
  assert.match(noHandoverReason({ outcome: 'failed' }), /ended before/);
});
