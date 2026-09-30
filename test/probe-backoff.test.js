const test = require('node:test');
const assert = require('node:assert/strict');
const { createProbeBackoff } = require('../src/probe-backoff.js');

const S = 1000;
const make = () => createProbeBackoff({ base: 20 * S, max: 600 * S, steady: (why) => why === 'already the front app' });
const noIcon = { ok: false, why: 'no Dock icon for Ghostty' };

test('probe backoff starts at the base interval', () => {
  assert.equal(make().gap, 20 * S);
});

test('each identical failure doubles the wait, capped at max', () => {
  const b = make();
  const gaps = Array.from({ length: 8 }, () => b.record(noIcon));
  assert.deepEqual(gaps.map((g) => g / S), [20, 40, 80, 160, 320, 600, 600, 600]);
});

test('a success resets it', () => {
  const b = make();
  b.record(noIcon); b.record(noIcon); b.record(noIcon);
  assert.equal(b.record({ ok: true }), 20 * S);
  assert.equal(b.record(noIcon), 20 * S, 'the next failure starts over');
});

test('a different failure starts over at the base', () => {
  const b = make();
  b.record(noIcon); b.record(noIcon);
  assert.equal(b.record({ ok: false, why: 'no Dock icon for iTerm2' }), 20 * S);
  assert.equal(b.record({ ok: false, why: 'no Dock icon for iTerm2' }), 40 * S);
});

test('a steady failure (terminal in front) never backs off, and clears the streak', () => {
  const b = make();
  b.record(noIcon); b.record(noIcon);
  for (let i = 0; i < 5; i += 1) assert.equal(b.record({ ok: false, why: 'already the front app' }), 20 * S);
  assert.equal(b.record(noIcon), 20 * S);
});

test('a new situation (key) resets; the same key does not', () => {
  const b = make();
  b.setKey('s1:permission-ask');
  b.record(noIcon); b.record(noIcon); b.record(noIcon);
  b.setKey('s1:permission-ask');
  assert.equal(b.gap, 80 * S);
  b.setKey('s1:permission-ask|s2:idle-nudge');
  assert.equal(b.gap, 20 * S);
  assert.equal(b.record(noIcon), 20 * S);
});
