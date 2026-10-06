const test = require('node:test');
const assert = require('node:assert/strict');
const { windowAnimStepMs, createPointDedupe } = require('../src/anim-step.js');

test('macOS keeps the 16 ms step; Windows and Linux get a coarser one', () => {
  assert.equal(windowAnimStepMs('darwin'), 16);
  assert.equal(windowAnimStepMs('win32'), 33);
  assert.equal(windowAnimStepMs('linux'), 33);
});

test('point dedupe passes only a changed pixel', () => {
  const moved = createPointDedupe();
  assert.equal(moved(10, 20), true);
  assert.equal(moved(10, 20), false);
  assert.equal(moved(11, 20), true);
  assert.equal(moved(11, 21), true);
  assert.equal(moved(11, 21), false);
});

test('a 600 ms tween issues at most ~19 steps on Windows vs ~38 on macOS', () => {
  const steps = (platform) => Math.ceil(600 / windowAnimStepMs(platform));
  assert.ok(steps('win32') <= 19);
  assert.ok(steps('darwin') >= 37);
});

test('eye poll is fast while the cursor moved recently and 1 s at rest', () => {
  const { eyePollMs } = require('../src/anim-step.js');
  const base = { holdMs: 2500, fastMs: 200 };
  assert.equal(eyePollMs({ ...base, now: 10000, movedAt: 9000 }), 200);
  assert.equal(eyePollMs({ ...base, now: 10000, movedAt: 7000 }), 1000);
  assert.equal(eyePollMs({ ...base, now: 10000, movedAt: 0 }), 1000);
});
