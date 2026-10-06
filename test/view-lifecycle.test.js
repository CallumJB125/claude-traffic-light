'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createViewLifecycle } = require('../src/view-lifecycle');

function rig(opts = {}) {
  const destroyed = [];
  const pending = new Map();
  let n = 0;
  const lc = createViewLifecycle({
    destroy: (id) => destroyed.push(id),
    setTimer: (fn) => { pending.set(++n, fn); return n; },
    clearTimer: (t) => pending.delete(t),
    ...opts,
  });
  const fire = () => { for (const [t, fn] of [...pending]) { pending.delete(t); fn(); } };
  return { lc, destroyed, pending, fire };
}

test('keeps current plus previous; the third is destroyed at once', () => {
  const { lc, destroyed } = rig();
  lc.setCurrent('a'); lc.setCurrent('b'); lc.setCurrent('c');
  assert.deepEqual(destroyed, ['a']);
  assert.deepEqual(lc.hidden(), ['b']);
});

test('previous page is destroyed after the idle timeout', () => {
  const { lc, destroyed, fire } = rig();
  lc.setCurrent('a'); lc.setCurrent('b');
  assert.deepEqual(destroyed, []);
  fire();
  assert.deepEqual(destroyed, ['a']);
});

test('returning to the previous page cancels its timer', () => {
  const { lc, destroyed, fire, pending } = rig();
  lc.setCurrent('a'); lc.setCurrent('b'); lc.setCurrent('a');
  fire();
  assert.deepEqual(destroyed, ['b']);
  assert.equal(pending.size, 0);
});

test('constrained mode destroys hidden pages immediately', () => {
  const { lc, destroyed } = rig({ isConstrained: () => true });
  lc.setCurrent('a'); lc.setCurrent('b');
  assert.deepEqual(destroyed, ['a']);
});

test('protected pages are never destroyed, even when constrained', () => {
  let busy = true;
  const { lc, destroyed, fire } = rig({ isConstrained: () => true, isProtected: (id) => id === 'tasks' && busy });
  lc.setCurrent('tasks'); lc.setCurrent('b'); lc.setCurrent('c');
  fire();
  assert.deepEqual(destroyed, ['b']);
  busy = false;
  fire();
  assert.deepEqual(destroyed.sort(), ['b', 'tasks']);
});

test('the current page is never destroyed', () => {
  const { lc, destroyed, fire } = rig();
  lc.setCurrent('a'); lc.setCurrent(null); lc.setCurrent('a');
  fire();
  assert.deepEqual(destroyed, []);
});

test('showing a non-lifecycle view hides the current page; reset clears timers', () => {
  const { lc, destroyed, pending } = rig();
  lc.setCurrent('a'); lc.setCurrent(null);
  assert.deepEqual(lc.hidden(), ['a']);
  assert.equal(pending.size, 1);
  lc.reset();
  assert.equal(pending.size, 0);
  assert.deepEqual(destroyed, []);
});

test('forget drops a page destroyed from outside', () => {
  const { lc, destroyed, fire } = rig();
  lc.setCurrent('a'); lc.setCurrent('b'); lc.forget('a');
  fire();
  assert.deepEqual(destroyed, []);
});
