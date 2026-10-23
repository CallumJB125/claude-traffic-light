const test = require('node:test');
const assert = require('node:assert/strict');
const { pulse, FRESH_MS, STALE_MS } = require('../src/session-pulse.js');

const now = 1_000_000_000;
const base = { state: 'Working on it', bucket: 'working', ageMs: 40_000, freshness: 'recent', activity: { label: 'Editing files', phase: 'tool' }, project: 'app', children: [{ state: 'Working on it' }, { state: 'Idle' }] };

test('pulse: a fresh working session with activity reads as a present-tense line', () => {
  const p = pulse(base, now, now);
  assert.equal(p.freshness, 'fresh');
  assert.equal(p.line, 'Editing files in app · 1 agent working · 40s ago');
  assert.equal(p.canRequest, true);
  assert.equal(p.reason, '');
});

test('pulse: idle between 90s and 10min keeps requests enabled; stale after 10min disables them with a reason', () => {
  const idle = pulse({ ...base, state: 'Idle', bucket: 'idle', ageMs: FRESH_MS + 1000 }, now, now);
  assert.equal(idle.freshness, 'idle');
  assert.equal(idle.canRequest, true);
  assert.match(idle.line, /^Idle · 1m ago$/);
  const stale = pulse({ ...base, ageMs: STALE_MS }, now, now);
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.canRequest, false);
  assert.match(stale.reason, /over ten minutes/);
});

test('pulse: ended or unreported sessions are offline and cannot take requests', () => {
  const ended = pulse({ ...base, state: 'Idle', bucket: 'idle', detail: 'Ended' }, now, now);
  assert.equal(ended.freshness, 'offline');
  assert.equal(ended.line, 'Ended · 40s ago');
  const unknown = pulse({ ...base, ageMs: null, freshness: 'unknown' }, now, now);
  assert.equal(unknown.freshness, 'offline');
  assert.equal(unknown.line, 'Not reporting · time unknown');
  assert.equal(unknown.canRequest, false);
});

test('pulse: ages in place between snapshots and names states with the bucket headings', () => {
  const p = pulse({ ...base, state: 'Needs you', bucket: 'needs', input: true, ageMs: 10_000 }, now + 120_000, now);
  assert.equal(p.ageMs, 130_000);
  assert.equal(p.freshness, 'idle');
  assert.equal(p.line, 'Needs you · 2m ago');
  assert.equal(pulse({ ...base, state: 'Working on it', bucket: undefined, detail: 'Compacting', activity: null, ageMs: 200_000 }, now, now).line, 'Compacting · 3m ago', 'a detail says more than the heading');
  assert.equal(pulse({ ...base, state: undefined, bucket: undefined, ageMs: 200_000 }, now, now).line, 'Idle · 3m ago', 'unknown is Idle');
});
