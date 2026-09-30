const test = require('node:test');
const assert = require('node:assert/strict');
const { createAwayFeeds } = require('../src/away-feeds.js');

function rig() {
  const log = [];
  const busyWatch = { start: () => log.push('busy:start'), stop: () => log.push('busy:stop') };
  const feeds = createAwayFeeds({ busyWatch, feeds: () => [() => log.push('spend'), () => log.push('git')] });
  return { feeds, log };
}

test('away feeds tick spend and git together', () => {
  const { feeds, log } = rig();
  feeds.tick();
  assert.deepEqual(log, ['spend', 'git']);
});

test('a locked screen or sleeping displays keep the feeds and the busy watch going', () => {
  const { feeds, log } = rig();
  feeds.power('locked', true);
  feeds.power('screens-asleep', true);
  feeds.tick();
  assert.equal(feeds.away, false);
  assert.deepEqual(log, ['spend', 'git'], 'ticked, and BusyWatch never stopped');
});

test('sleep holds the feeds and stops the busy watch; waking restarts it and catches up at once', () => {
  const { feeds, log } = rig();
  feeds.power('suspended', true);
  assert.equal(feeds.away, true);
  feeds.tick();
  feeds.tick();
  assert.deepEqual(log, ['busy:stop'], 'no feed ran while asleep');
  feeds.power('suspended', false);
  assert.deepEqual(log, ['busy:stop', 'busy:start', 'spend', 'git']);
  feeds.tick();
  assert.deepEqual(log.slice(-2), ['spend', 'git']);
});

test('an unlock while asleep does not wake the feeds', () => {
  const { feeds, log } = rig();
  feeds.power('suspended', true);
  feeds.power('locked', true);
  feeds.power('locked', false);
  feeds.tick();
  assert.deepEqual(log, ['busy:stop']);
});
