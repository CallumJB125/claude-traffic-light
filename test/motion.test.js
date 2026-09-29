const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../motion.js');

function run(state, target, params, seconds, fps = 60) {
  let s = state;
  let peak = s.x;
  for (let i = 0; i < seconds * fps; i += 1) {
    s = M.springStep(s, target, 1 / fps, params);
    peak = target > state.x ? Math.max(peak, s.x) : Math.min(peak, s.x);
  }
  return { s, peak };
}

test('springParams maps response/damping ratio to stiffness/damping', () => {
  const p = M.springParams(1, 1);
  assert.ok(Math.abs(p.stiffness - (2 * Math.PI) ** 2) < 1e-9);
  assert.ok(Math.abs(p.damping - 4 * Math.PI) < 1e-9);
  assert.ok(M.springParams(0.2, 1).stiffness > M.springParams(0.5, 1).stiffness, 'shorter response is stiffer');
});

test('a critically damped spring settles on target without overshoot', () => {
  const { s, peak } = run({ x: 0, v: 0 }, 100, M.springParams(0.4, 1), 2);
  assert.ok(M.springSettled(s, 100), `settled at ${s.x}`);
  assert.ok(peak <= 100.001, `no overshoot (peak ${peak})`);
});

test('an under-damped spring overshoots a little, then settles', () => {
  const { s, peak } = run({ x: 0, v: 0 }, 100, M.springParams(0.4, 0.8), 3);
  assert.ok(peak > 100 && peak < 110, `peak ${peak}`);
  assert.ok(M.springSettled(s, 100));
});

test('retargeting mid-flight keeps velocity (no restart from rest)', () => {
  const params = M.springParams(0.5, 1);
  let s = { x: 0, v: 0 };
  for (let i = 0; i < 12; i += 1) s = M.springStep(s, 100, 1 / 60, params);
  const before = s.v;
  assert.ok(before > 0);
  const next = M.springStep(s, 150, 1 / 60, params);
  assert.ok(next.v >= before * 0.9, `velocity carried: ${before} -> ${next.v}`);
  assert.ok(next.x > s.x, 'keeps moving the same way');
});

test('springStep is stable across big frames and caps dt', () => {
  const params = M.springParams(0.1, 1);
  const s = M.springStep({ x: 0, v: 0 }, 50, 5, params);
  assert.ok(Number.isFinite(s.x) && Math.abs(s.x) <= 60, `stable: ${s.x}`);
  const same = M.springStep({ x: 3, v: 7 }, 50, -1, params);
  assert.deepEqual(same, { x: 3, v: 7 }, 'negative dt is a no-op');
});

test('initial velocity carries a spring past a nearby start before returning', () => {
  const { peak } = run({ x: 0, v: 2000 }, 10, M.springParams(0.45, 0.85), 2);
  assert.ok(peak > 10, 'a throw overshoots a close target');
});

test('hopHeight is a gravity parabola: zero at ends, peak mid-air, symmetric', () => {
  assert.equal(M.hopHeight(0, 16), 0);
  assert.equal(M.hopHeight(1, 16), 0);
  assert.equal(M.hopHeight(0.5, 16), 16);
  assert.ok(Math.abs(M.hopHeight(0.2, 16) - M.hopHeight(0.8, 16)) < 1e-9);
  // decelerates rising: the first tenth climbs more than the one before the peak
  assert.ok(M.hopHeight(0.1, 16) - M.hopHeight(0, 16) > M.hopHeight(0.5, 16) - M.hopHeight(0.4, 16));
  assert.equal(M.hopHeight(-1, 16), 0);
  assert.equal(M.hopHeight(2, 16), 0);
});

test('project coasts in the direction of the flick, scaled by velocity', () => {
  assert.equal(M.project(0), 0);
  assert.ok(Math.abs(M.project(1000) - 99) < 1e-6);
  assert.ok(Math.abs(M.project(-1000) + 99) < 1e-6);
  assert.ok(M.project(1000, 0.998) > M.project(1000, 0.99), 'lower deceleration coasts further');
});

test('releaseVelocity measures the last moments of a moving pointer', () => {
  const samples = [
    { x: 0, y: 0, t: 0 },
    { x: 10, y: 0, t: 100 },
    { x: 20, y: 5, t: 140 },
    { x: 30, y: 10, t: 180 },
  ];
  const v = M.releaseVelocity(samples, 180);
  assert.ok(Math.abs(v.vx - 250) < 1e-9, `vx ${v.vx}`);
  assert.ok(Math.abs(v.vy - 125) < 1e-9, `vy ${v.vy}`);
});

test('releaseVelocity is zero for a pointer that stopped before letting go', () => {
  const samples = [
    { x: 0, y: 0, t: 0 },
    { x: 40, y: 0, t: 20 },
    { x: 40, y: 0, t: 200 },
  ];
  assert.deepEqual(M.releaseVelocity(samples, 200), { vx: 0, vy: 0 });
  assert.deepEqual(M.releaseVelocity([{ x: 1, y: 1, t: 5 }], 5), { vx: 0, vy: 0 });
  assert.deepEqual(M.releaseVelocity([], 5), { vx: 0, vy: 0 });
});

test('glideTarget keeps momentum on screen without yanking a parked widget', () => {
  // ordinary flick inside the work area
  assert.equal(M.glideTarget(100, 300, 0, 1000), 300);
  // flicked past an edge: stops at the edge
  assert.equal(M.glideTarget(900, 1400, 0, 1000), 1000);
  assert.equal(M.glideTarget(50, -300, 0, 1000), 0);
  // already half off the right edge: may not go further, and isn't pulled in past where it is
  assert.equal(M.glideTarget(1100, 1300, 0, 1000), 1100);
  assert.equal(M.glideTarget(1100, 900, 0, 1000), 900);
});
