const test = require('node:test');
const assert = require('node:assert/strict');
const { createMotionGate, staleMachineReasons, askKey, statusPushWanted } = require('../src/motion-gate.js');

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

test('a paused widget still hears every change to its waiting inputs', () => {
  const none = askKey({ pending: [], inputs: [] });
  const one = askKey({ pending: [{ id: 'r1' }], inputs: [{ id: 'r1' }] });
  const two = askKey({ pending: [{ id: 'r1' }], inputs: [{ id: 'r1' }, { id: 'tmux-3' }] });
  assert.equal(askKey({}), none);
  assert.equal(askKey({ inputs: [{ id: 'b' }, { id: 'a' }] }), askKey({ inputs: [{ id: 'a' }, { id: 'b' }] }), 'order does not matter');
  assert.equal(statusPushWanted(false, none, none), true, 'running: every broadcast');
  assert.equal(statusPushWanted(true, none, none), false, 'paused, nothing new: skipped');
  assert.equal(statusPushWanted(true, one, none), true, 'a new ask reaches a paused widget');
  assert.equal(statusPushWanted(true, two, one), true, 'and another');
  assert.equal(statusPushWanted(true, none, two), true, 'answered elsewhere: it hears that too');
  assert.equal(statusPushWanted(true, two, two), false);
});

test('a session-derived input keeps its id but a changed text or time still reaches a paused widget', () => {
  const q = (text, at) => askKey({ inputs: [{ id: 'ask-host-s1', kind: 'question', created_at: at, title: 'Framework', text }] });
  const first = q('Which framework?', '2026-10-01T10:00:00Z');
  assert.equal(q('Which framework?', '2026-10-01T10:00:00Z'), first, 'same ask, same key');
  assert.notEqual(q('Which database?', '2026-10-01T10:00:00Z'), first, 'new text');
  assert.notEqual(q('Which framework?', '2026-10-01T10:05:00Z'), first, 'asked again later');
  assert.equal(statusPushWanted(true, q('Which database?', '2026-10-01T10:00:00Z'), first), true);
});

test('a work-scope change on a waiting session reaches a paused widget', () => {
  const st = (state) => askKey({ inputs: [{ id: 'r1' }], sessions: [{ sessionId: 's1', scope: state ? { state } : null }] });
  assert.notEqual(st('counting'), st('personal'));
  assert.notEqual(st(null), st('counting'));
  assert.equal(st('counting'), st('counting'));
});
