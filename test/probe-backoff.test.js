const test = require('node:test');
const assert = require('node:assert/strict');
const { createProbeBackoff } = require('../src/probe-backoff.js');

const S = 1000;
const NO_APP = 'no terminal app running';
const make = () => createProbeBackoff({ base: 20 * S, max: 600 * S, caps: { [NO_APP]: 60 * S }, steady: (why) => why === 'already the front app' });
const noIcon = { ok: false, why: 'no Dock icon for Ghostty', situation: { app: 'Ghostty', running: true, frontmost: false, dockIcon: false } };
const front = { ok: false, why: 'already the front app', situation: { app: 'Ghostty', running: true, frontmost: true } };
const noApp = { ok: false, why: NO_APP, situation: { app: null, running: false } };

// The main-process loop in miniature: a status poll every 4 s probes when
// due. Returns the times (s) at which it probed.
function drive(b, { from = 0, to, result, onPoll }) {
  const probes = [];
  for (let t = from; t <= to; t += 4 * S) {
    if (onPoll) onPoll(t);
    if (!b.due(t)) continue;
    probes.push(t / S);
    b.probed(typeof result === 'function' ? result(t) : result, t);
  }
  return probes;
}

test('probe backoff starts at the base interval', () => {
  assert.equal(make().gap, 20 * S);
});

test('each identical failure doubles the wait, capped at max', () => {
  const b = make();
  const gaps = Array.from({ length: 8 }, (_, i) => b.probed(noIcon, i));
  assert.deepEqual(gaps.map((g) => g / S), [20, 40, 80, 160, 320, 600, 600, 600]);
});

test("'no terminal app running' backs off only to 60 s", () => {
  const b = make();
  const gaps = Array.from({ length: 5 }, (_, i) => b.probed(noApp, i));
  assert.deepEqual(gaps.map((g) => g / S), [20, 40, 60, 60, 60]);
});

test('a success resets it', () => {
  const b = make();
  b.probed(noIcon, 0); b.probed(noIcon, 1); b.probed(noIcon, 2);
  assert.equal(b.probed({ ok: true }, 3), 20 * S);
  assert.equal(b.probed(noIcon, 4), 20 * S, 'the next failure starts over');
});

test('a different failure, or the same reason in a new situation, starts over', () => {
  const b = make();
  b.probed(noIcon, 0); b.probed(noIcon, 1);
  assert.equal(b.probed({ ok: false, why: 'no Dock icon for iTerm2', situation: { app: 'iTerm2', running: true, frontmost: false, dockIcon: false } }, 2), 20 * S);
  b.probed(noIcon, 3); b.probed(noIcon, 4);
  assert.equal(b.probed({ ...noIcon, situation: { ...noIcon.situation, frontmost: null } }, 5), 20 * S);
});

test('a steady failure (terminal in front) never backs off, and clears the streak', () => {
  const b = make();
  b.probed(noIcon, 0); b.probed(noIcon, 1);
  for (let i = 0; i < 5; i += 1) assert.equal(b.probed(front, 2 + i), 20 * S);
  assert.equal(b.probed(noIcon, 9), 20 * S);
});

test('a new set of waiting sessions (key) resets; the same key does not', () => {
  const b = make();
  b.setKey('s1:permission-ask');
  b.probed(noIcon, 0); b.probed(noIcon, 1); b.probed(noIcon, 2);
  b.setKey('s1:permission-ask');
  assert.equal(b.gap, 80 * S);
  b.setKey('s1:permission-ask|s2:idle-nudge');
  assert.equal(b.gap, 20 * S);
});

test('the poll loop: probes thin out while nothing changes', () => {
  const b = make();
  assert.deepEqual(drive(b, { to: 1300 * S, result: noIcon }), [0, 20, 60, 140, 300, 620, 1220]);
});

test('the terminal gains a Dock icon after a 320 s backoff: the launch wakes it and the knock follows within 20 s', () => {
  const b = make();
  let hasIcon = false;
  const launchedAt = 640;
  const probes = drive(b, {
    to: 1300 * S,
    result: () => (hasIcon ? { ok: true } : noIcon),
    onPoll: (t) => { if (t === launchedAt * S) { hasIcon = true; b.wake(); } },
  });
  const before = probes.filter((p) => p < launchedAt);
  assert.equal(before[before.length - 1], 620, 'the last failing probe, with 320 s then due');
  const next = probes.find((p) => p >= launchedAt);
  assert.ok(next - launchedAt <= 20, `next probe ${next} s, ${next - launchedAt} s after the launch`);
});
