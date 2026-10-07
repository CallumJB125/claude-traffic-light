const test = require('node:test');
const assert = require('node:assert/strict');

const Receipt = require('../src/receipt');

const NOW = new Date(2026, 9, 20, 12).getTime();
const DAY = 86400000;
const routine = (ts) => ({ ts, modelKey: 'opus', input: 100, output: 100, cacheRead: 50000, cacheWrite: 1000, cacheWrite1h: 0 });
const turns = [routine(NOW - DAY), routine(NOW - 2 * DAY), routine(NOW - 40 * DAY), { ts: NOW - DAY, modelKey: 'opus', input: 9000, output: 4000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }];
const log = [
  { kind: 'runaway', at: NOW - DAY, cost: 40, stopped: true },
  { kind: 'runaway', at: NOW - 40 * DAY, cost: 99, stopped: true },
  { kind: 'cap', at: NOW - 3 * DAY },
];

function burst({ kind = 'present', history, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    detect: async () => { if (fail) throw new Error('boom'); return { kind }; },
    history: async (q) => { calls.push(q); return history ?? { days: [], repos: [{ repo: 'a', usd: 10, saved_usd: 2.5 }, { repo: 'b', usd: 4, saved_usd: 1.25 }] }; },
  };
}

test('full receipt: only what Plexiform stopped counts as saved, as a range with its method and source', async () => {
  const r = await Receipt.build({ now: NOW, turns, log, full: true });
  assert.equal(r.teaser, false);
  assert.deepEqual([r.saved.low, r.saved.high, r.saved.runawaysStopped, r.saved.capsHeld], [20, 40, 1, 1]);
  assert.match(r.headline, /Plexiform saved you about \$20\.00–\$40\.00 in October 2026/);
  assert.equal(r.saved.source, Receipt.SOURCES.log);
  assert.ok(r.saved.method.length > 20);
  // routine Opus is advice, not a saving: separate figure, separate source
  assert.equal(r.couldSave.turns, 2);
  assert.ok(r.couldSave.high > 0 && r.couldSave.low <= r.couldSave.high);
  assert.equal(r.couldSave.source, Receipt.SOURCES.transcripts);
  assert.match(r.couldSave.method, /Not a saving until you switch/);
  assert.equal(r.burst, null);
  assert.deepEqual(r.range, { from: new Date(2026, 9, 1).getTime(), to: NOW });
});

test('Burst present: its /api/history savings are shown as Burst\'s and never added to Plexiform\'s', async () => {
  const b = burst();
  const r = await Receipt.build({ now: NOW, turns, log, burst: b, full: true });
  assert.deepEqual(b.calls, [{ days: 20 }]);
  assert.equal(r.burst.savedUsd, 3.75);
  assert.equal(r.burst.source, Receipt.SOURCES.burst);
  assert.match(r.burst.line, /Claude Burst saved \$3\.75.*not Plexiform's/);
  assert.equal(r.saved.high, 40);
  assert.doesNotMatch(r.headline, /43\.75|3\.75/);
});

test('Burst absent, untrusted or failing: transcript estimate only, no Burst line', async () => {
  for (const b of [null, burst({ kind: 'not_installed' }), burst({ kind: 'untrusted' }), burst({ fail: true })]) {
    const r = await Receipt.build({ now: NOW, turns, log, burst: b, full: true });
    assert.equal(r.burst, null);
    assert.equal(r.couldSave.source, Receipt.SOURCES.transcripts);
  }
  assert.equal((await Receipt.burstSaved(burst({ fail: true }), 5)).available, false);
});

test('free teaser: the headline and its source only, no breakdown', async () => {
  const r = await Receipt.build({ now: NOW, turns, log, burst: burst(), full: false });
  assert.equal(r.teaser, true);
  assert.match(r.headline, /looked routine enough for Sonnet/);
  assert.equal(r.source, Receipt.SOURCES.transcripts);
  assert.equal(r.saved, undefined);
  assert.equal(r.couldSave, undefined);
  assert.equal(r.burst.source, Receipt.SOURCES.burst);
  const none = await Receipt.build({ now: NOW, turns: [], log: [], full: false });
  assert.equal(none.headline, 'No activity yet this month');
  const notRoutine = await Receipt.build({ now: NOW, turns: turns.slice(3), log: [], full: false });
  assert.match(notRoutine.headline, /No routine Opus spend/);
  assert.equal((await Receipt.build({ now: NOW, turns: [], log: [], full: true })).headline, 'No activity yet this month');
});

test('nothing stopped this month says so instead of claiming a saving', async () => {
  const r = await Receipt.build({ now: NOW, turns: [], log: [{ kind: 'runaway', at: NOW - DAY, cost: 10, stopped: false }], full: true });
  assert.equal(r.saved.high, 0);
  assert.match(r.headline, /hasn't had to stop any spend/);
  assert.equal(r.couldSave.line, null);
});
