'use strict';
// The widget's turn and spend rings (src/widget-rings-view.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/widget-rings-view.js');

const MIN = 60_000;

test('turnRing: elapsed against the usual, clamped, over when longer', () => {
  const half = R.turnRing({ startedAt: 0, now: 2 * MIN, usualMs: 4 * MIN });
  assert.equal(half.show, true);
  assert.equal(half.fraction, 0.5);
  assert.equal(half.over, false);
  assert.equal(half.band, 'green');
  assert.match(half.label, /This turn 2m · your usual 4m/);
  const long = R.turnRing({ startedAt: 0, now: 9 * MIN, usualMs: 4 * MIN });
  assert.equal(long.fraction, 1);
  assert.equal(long.over, true);
  assert.equal(long.band, 'amber');
  assert.match(long.label, /longer than usual/);
  assert.equal(R.turnRing({ startedAt: 10, now: 0, usualMs: MIN }).fraction, 0, 'a clock skew never goes negative');
});

test('turnRing hides without a running turn or a usual', () => {
  assert.equal(R.turnRing({ now: 1, usualMs: MIN }).show, false);
  assert.equal(R.turnRing({ startedAt: 0, now: 1 }).show, false);
  assert.equal(R.turnRing({ startedAt: 0, now: 1, durations: [MIN, MIN] }).show, false, 'two turns are not a usual yet');
});

test('the usual is the median of recent closed turns, quick exchanges ignored', () => {
  assert.equal(R.usualTurnMs([MIN, 3 * MIN, 2 * MIN]), 2 * MIN);
  assert.equal(R.usualTurnMs([MIN, 2 * MIN, 3 * MIN, 4 * MIN]), 2.5 * MIN);
  assert.equal(R.usualTurnMs([1000, 2000, MIN, MIN]), null, 'sub-5s turns do not count');
  const r = R.turnRing({ startedAt: 0, now: MIN, durations: [2 * MIN, 2 * MIN, 2 * MIN] });
  assert.equal(r.fraction, 0.5);
  let d = [];
  for (let i = 0; i < 40; i += 1) d = R.recordTurn(d, i * 1000);
  assert.equal(d.length, R.MAX_TURNS);
  assert.equal(d[d.length - 1], 39000);
  assert.deepEqual(R.recordTurn([1], NaN), [1]);
});

test('spendRing: share of the daily budget with green, amber and red bands', () => {
  assert.deepEqual(R.spendRing({ today: 2, budget: 10 }), { show: true, fraction: 0.2, over: false, band: 'green', label: '$2.00 of $10.00 today' });
  assert.equal(R.spendRing({ today: 8.5, budget: 10 }).band, 'amber');
  assert.equal(R.spendRing({ today: 5, budget: 10, warnAt: 0.5 }).band, 'amber');
  const over = R.spendRing({ today: 150, budget: 100 });
  assert.equal(over.fraction, 1);
  assert.equal(over.over, true);
  assert.equal(over.band, 'red');
  assert.match(over.label, /\$150 of \$100 today · over budget/);
});

test('spendRing hides with no budget set', () => {
  assert.equal(R.spendRing({ today: 3, budget: 0 }).show, false);
  assert.equal(R.spendRing({ today: null, budget: 5 }).show, false);
  assert.equal(R.spendRing({}).show, false);
});

test('rings() shows when either ring does', () => {
  assert.equal(R.rings({}).show, false);
  assert.equal(R.rings({ spend: { today: 1, budget: 2 } }).show, true);
  assert.equal(R.rings({ turn: { startedAt: 0, now: 1, usualMs: 10 } }).show, true);
});
