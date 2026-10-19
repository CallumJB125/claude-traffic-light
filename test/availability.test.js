'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { availability, LEVELS, FRESH_MS, STALE_MS } = require('../src/availability.js');

const NOW = 1_700_000_000_000;
const entry = (state, ageMs, extra = {}) => ({ state, ageMs, freshness: 'recent', children: [], ...extra });

test('exports the four levels in order and the pulse thresholds', () => {
  assert.deepEqual([...LEVELS], ['active', 'idle', 'away', 'offline']);
  assert.ok(Object.isFrozen(LEVELS));
  assert.equal(FRESH_MS, 90_000); assert.equal(STALE_MS, 600_000);
});

test('active: a fresh working entry wins over idle ones, detail counts working sessions', () => {
  const a = availability([entry('Working', 20_000), entry('Idle', 5_000), entry('Working', 60_000)], NOW);
  assert.deepEqual(a, { level: 'active', label: 'Active', detail: 'Working in 2 sessions · last report 5s ago' });
  assert.equal(availability([entry('Working', 1_000)], NOW).detail, 'Working in 1 session · last report 1s ago');
});

test('idle: fresh but not working, or idle-not-stale', () => {
  assert.deepEqual(availability([entry('Idle', 30_000)], NOW), { level: 'idle', label: 'Idle', detail: 'Idle · last report 30s ago' });
  assert.equal(availability([entry('Working', 4 * 60_000)], NOW).level, 'idle', 'working but not fresh is idle, not active');
  assert.equal(availability([entry('Waiting', FRESH_MS)], NOW).level, 'idle');
  assert.equal(availability([entry('Idle', STALE_MS - 1)], NOW).detail, 'Idle · last report 9m ago');
});

test('away: every known entry is stale (age at or past ten minutes)', () => {
  const a = availability([entry('Working', STALE_MS), entry('Idle', 25 * 60_000)], NOW);
  assert.deepEqual(a, { level: 'away', label: 'Away', detail: 'Away · last report 10m ago' });
  assert.equal(availability([entry('Idle', 25 * 60_000), entry('Ended', 1_000)], NOW).detail, 'Away · last report 25m ago');
  assert.equal(availability([entry('Idle', 3 * 3_600_000)], NOW).detail, 'Away · last report 3h ago');
});

test('offline: no entries, all ended, unknown age or unknown freshness', () => {
  const off = { level: 'offline', label: 'Offline', detail: 'Not reporting' };
  assert.deepEqual(availability([], NOW), off);
  assert.deepEqual(availability(null, NOW), off);
  assert.deepEqual(availability([entry('Ended', 1_000)], NOW), off);
  assert.deepEqual(availability([entry('Working', null)], NOW), off);
  assert.deepEqual(availability([entry('Working', 1_000, { freshness: 'unknown' })], NOW), off);
  assert.deepEqual(availability([entry('Working', -5)], NOW), off);
});

test('drift: age grows by now - observedAt, never shrinks', () => {
  const e = [entry('Working', 60_000)];
  assert.equal(availability(e, NOW, NOW).level, 'active');
  assert.equal(availability(e, NOW + 60_000, NOW).level, 'idle', '2 min after the snapshot it is no longer fresh');
  assert.equal(availability(e, NOW + 10 * 60_000, NOW).level, 'away');
  assert.equal(availability(e, NOW - 60_000, NOW).level, 'active', 'a snapshot from the future adds no drift');
  assert.equal(availability(e, NOW + 60_000, NOW).detail, 'Idle · last report 2m ago');
});

test('ignores junk entries and never throws', () => {
  assert.equal(availability([null, 1, 'x', entry('Working', 1_000)], NOW).level, 'active');
  assert.equal(availability([{}], NOW).level, 'offline');
});
