const test = require('node:test');
const assert = require('node:assert/strict');
const { createMotionGate, staleMachineReasons } = require('../src/motion-gate.js');

function gate() {
  const calls = [];
  const g = createMotionGate((paused, reasons) => calls.push([paused, reasons]));
  return { g, calls };
}

test('motion gate starts running', () => {
  const { g, calls } = gate();
  assert.equal(g.paused, false);
  assert.deepEqual(g.reasons, []);
  assert.deepEqual(calls, []);
});

test('any one reason pauses; clearing it resumes', () => {
  const { g, calls } = gate();
  assert.equal(g.set('hidden', true), true);
  assert.equal(g.paused, true);
  assert.equal(g.set('hidden', false), false);
  assert.deepEqual(calls, [[true, ['hidden']], [false, []]]);
});

test('reasons combine: it resumes only when every reason has cleared', () => {
  const { g, calls } = gate();
  g.set('locked', true);
  g.set('hidden', true);
  g.set('locked', false);
  assert.equal(g.paused, true, 'still hidden after the unlock');
  assert.deepEqual(g.reasons, ['hidden']);
  g.set('hidden', false);
  assert.equal(g.paused, false);
  assert.deepEqual(calls.map((c) => c[0]), [true, false], 'one pause edge, one resume edge');
});

test('repeats and clearing an unknown reason are no-ops', () => {
  const { g, calls } = gate();
  g.set('suspended', false);
  g.set('hidden', true);
  g.set('hidden', true);
  g.set('asleep', false);
  assert.deepEqual(calls, [[true, ['hidden']]]);
});

test('onChange is optional', () => {
  const g = createMotionGate();
  g.set('menu-bar', true);
  assert.equal(g.paused, true);
});

test('stale lock/displays-off reasons clear once the system is plainly back', () => {
  assert.deepEqual(staleMachineReasons(['locked', 'screens-asleep', 'hidden'], 'active', 5), ['locked', 'screens-asleep'], 'never touches window reasons');
  assert.deepEqual(staleMachineReasons(['locked'], 'locked', 5), [], 'still locked');
  assert.deepEqual(staleMachineReasons(['screens-asleep'], 'idle', 900), [], 'nobody has touched it: displays may really be off');
  assert.deepEqual(staleMachineReasons(['suspended'], 'active', 1), [], 'sleep has its own resume');
  assert.deepEqual(staleMachineReasons([], 'active', 1), []);
});
