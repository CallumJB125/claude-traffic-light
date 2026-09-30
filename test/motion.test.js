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

test('MOTION holds every tunable constant as a finite number', () => {
  const groups = ['settle', 'squash', 'pop', 'pendulum', 'walk', 'glide', 'hop', 'edge', 'blink', 'eyes', 'bloom', 'ambient'];
  assert.deepEqual(Object.keys(M.MOTION).sort(), [...groups].sort());
  for (const g of groups) {
    for (const [k, v] of Object.entries(M.MOTION[g])) assert.ok(Number.isFinite(v), `${g}.${k} = ${v}`);
  }
  assert.ok(M.MOTION.edge.restitution > 0 && M.MOTION.edge.restitution < 1);
});

function parseLinear(easing) {
  const inner = /^linear\((.*)\)$/.exec(easing)[1];
  return inner.split(',').map((s) => s.trim().split(/\s+/)).map(([v, pct]) => ({ v: Number(v), pct: pct ? Number(pct.replace('%', '')) : null }));
}

test('springEasing samples a spring from 0 to 1 into a CSS linear()', () => {
  const bouncy = M.springEasing(0.3, 0.5);
  const stops = parseLinear(bouncy.easing);
  assert.equal(stops[0].v, 0);
  assert.equal(stops[stops.length - 1].v, 1);
  assert.ok(Math.max(...stops.map((s) => s.v)) > 1.05, 'an under-damped spring overshoots');
  const pcts = stops.map((s) => s.pct).filter((p) => p !== null);
  assert.ok(pcts.every((p, i) => i === 0 || p > pcts[i - 1]), 'stop positions increase');
  assert.ok(pcts.every((p) => p > 0 && p < 100));
  assert.ok(bouncy.ms > 300 && bouncy.ms < 3000, `settles in ${bouncy.ms}ms`);

  const firm = parseLinear(M.springEasing(0.3, 1).easing);
  assert.ok(Math.max(...firm.map((s) => s.v)) <= 1, 'a critically damped spring never overshoots');
  assert.ok(M.springEasing(0.2, 1).ms < M.springEasing(0.6, 1).ms, 'a shorter response settles sooner');
  assert.ok(stops.length < 60, `compact: ${stops.length} stops`);
});

test('softLimit is odd, near-linear when small and never passes the limit', () => {
  assert.equal(M.softLimit(0, 6), 0);
  assert.ok(Math.abs(M.softLimit(0.5, 6) - 0.5) < 0.01);
  assert.equal(M.softLimit(-3, 6), -M.softLimit(3, 6));
  for (const x of [10, 100, 1e6]) assert.ok(M.softLimit(x, 6) <= 6 && M.softLimit(x, 6) > 5);
  assert.equal(M.softLimit(5, 0), 0);
});

test('swayTarget leans the sign against the motion, bounded', () => {
  assert.ok(M.swayTarget(500, 0.004, 6) < 0, 'moving right leans the sign left');
  assert.ok(M.swayTarget(-500, 0.004, 6) > 0);
  assert.ok(Math.abs(M.swayTarget(1e6, 0.004, 6)) <= 6);
  assert.ok(Math.abs(M.swayTarget(0, 0.004, 6)) === 0);
  assert.equal(M.swayTarget(NaN, 0.004, 6), 0);
});

test('the pendulum spring swings through upright a few times, then settles', () => {
  const P = M.MOTION.pendulum;
  const params = M.springParams(P.response, P.damping);
  let s = { x: 0, v: P.kick };
  let crossings = 0;
  let peak = 0;
  let settledAt = null;
  for (let i = 0; i < 600 && settledAt === null; i += 1) {
    const next = M.springStep(s, 0, 1 / 60, params);
    if (Math.sign(next.x) !== Math.sign(s.x) && s.x !== 0) crossings += 1;
    peak = Math.max(peak, Math.abs(next.x));
    s = next;
    if (M.springSettled(s, 0, 0.05, 0.5)) settledAt = i / 60;
  }
  assert.ok(crossings >= 2, `swings back and forth (${crossings} crossings)`);
  assert.ok(peak > 1 && peak < P.maxDeg * 2, `peak ${peak}°`);
  assert.ok(settledAt !== null && settledAt < 5, `settles (${settledAt}s)`);
});

test('bounceAxis reflects off a wall with restitution and pins to it', () => {
  assert.deepEqual(M.bounceAxis({ x: 1012, v: 900 }, 0, 1000, 0.3), { x: 1000, v: -270, hit: 1 });
  assert.deepEqual(M.bounceAxis({ x: -5, v: -400 }, 0, 1000, 0.3), { x: 0, v: 120, hit: -1 });
  // inside: untouched
  assert.deepEqual(M.bounceAxis({ x: 500, v: 900 }, 0, 1000, 0.3), { x: 500, v: 900, hit: 0 });
  // outside but already heading back in (parked off an edge): left alone
  assert.deepEqual(M.bounceAxis({ x: 1100, v: -50 }, 0, 1000, 0.3), { x: 1100, v: -50, hit: 0 });
});

test('reboundTarget comes back off the wall a little, capped', () => {
  const t = M.reboundTarget(1000, -270, 0.99, 60);
  assert.ok(t < 1000 && t > 940, `rests ${1000 - t}px off the wall`);
  assert.equal(M.reboundTarget(1000, -1e5, 0.99, 60), 940);
  assert.equal(M.reboundTarget(0, 1e5, 0.99, 60), 60);
  assert.equal(M.reboundTarget(0, 0, 0.99, 60), 0);
});

test('a glide flung at a wall bounces back and never ends up past it', () => {
  const G = M.MOTION.glide;
  const E = M.MOTION.edge;
  const params = M.springParams(G.response, G.damping);
  let s = { x: 800, v: 4000 };
  let target = s.x + M.project(s.v, G.decel);
  const [lo, hi] = [0, 1000];
  let hits = 0;
  let maxX = s.x;
  for (let i = 0; i < 400; i += 1) {
    s = M.springStep(s, target, 1 / 60, params);
    const b = M.bounceAxis(s, lo, hi, E.restitution);
    if (b.hit) { hits += 1; s = { x: b.x, v: b.v }; target = Math.min(hi, Math.max(lo, M.reboundTarget(b.x, b.v, G.decel, E.maxRebound))); }
    maxX = Math.max(maxX, s.x);
  }
  assert.ok(hits >= 1, 'hit the wall');
  assert.ok(maxX <= hi, `never past the wall (max ${maxX})`);
  assert.ok(M.springSettled(s, target), 'came to rest');
  assert.ok(s.x < hi && s.x >= hi - E.maxRebound, `rests just off the wall at ${s.x}`);
});

test('eyeOffset looks straight inside the deadzone, then whole units toward the cursor', () => {
  assert.deepEqual(M.eyeOffset(10, -20, 1, 48), { x: 0, y: 0 });
  assert.deepEqual(M.eyeOffset(60, -200, 1, 48), { x: 1, y: -1 });
  assert.deepEqual(M.eyeOffset(-5000, 49, 1, 48), { x: -1, y: 1 });
  assert.deepEqual(M.eyeOffset(100, 0, 2, 48), { x: 2, y: 0 }, 'range 2 needs two deadzones');
  assert.deepEqual(M.eyeOffset(60, 0, 2, 48), { x: 1, y: 0 });
  const o = M.eyeOffset(123.4, -77.7, 3, 10);
  assert.ok(Number.isInteger(o.x) && Number.isInteger(o.y));
});

test('nextBlinkDelay spreads blinks evenly between min and max', () => {
  assert.equal(M.nextBlinkDelay(0, 3000, 7000), 3000);
  assert.equal(M.nextBlinkDelay(0.999999, 3000, 7000), 7000);
  assert.equal(M.nextBlinkDelay(0.5, 3000, 7000), 5000);
  assert.equal(M.nextBlinkDelay(0.25, 7000, 3000), 4000, 'swapped bounds still work');
  assert.equal(M.nextBlinkDelay(-1, 3000, 7000), 3000);
  assert.equal(M.nextBlinkDelay(2, 3000, 7000), 7000);
});

test('ambientPlan: stepped loops wake at their frame changes, smooth ones on the clock', () => {
  const bob = M.ambientPlan([{ offset: 0, easing: 'steps(1, end)' }, { offset: 0.5, easing: 'steps(1, end)' }, { offset: 1, easing: 'linear' }], 4000, 'normal', 1000);
  assert.deepEqual(bob, { stepped: true, points: [0, 0.5, 1] });
  const four = M.ambientPlan([{ offset: 0, easing: 'steps(4, end)' }, { offset: 1, easing: 'linear' }], 1600, 'normal', 1000);
  assert.deepEqual(four.points, [0, 0.25, 0.5, 0.75, 1]);
  const alt = M.ambientPlan([{ offset: 0, easing: 'steps(1)' }, { offset: 0.3, easing: 'steps(1)' }, { offset: 1, easing: 'linear' }], 900, 'alternate', 1000);
  assert.ok(alt.points.some((p) => Math.abs(p - 0.7) < 1e-9), 'alternate adds the mirrored change');
  assert.deepEqual(M.ambientPlan([{ offset: 0, easing: 'ease-in-out' }, { offset: 1, easing: 'ease' }], 1800, 'normal', 1000), { stepped: false });
  assert.equal(M.ambientPlan([{ offset: 0, easing: 'ease' }, { offset: 1, easing: 'ease' }], 300, 'normal', 1000), null, 'fast smooth loops stay on the display clock');
  assert.equal(M.ambientPlan([], 1000, 'normal', 1000), null);
});

test('nextStepTime finds the next frame change, across the delay and iterations', () => {
  const pts = [0, 0.5, 1];
  assert.equal(M.nextStepTime(pts, 4000, 300, 100), 300, 'waits out the delay');
  assert.equal(M.nextStepTime(pts, 4000, 0, 1000), 2000);
  assert.equal(M.nextStepTime(pts, 4000, 0, 2000), 4000, 'exactly on a change: the next one');
  assert.equal(M.nextStepTime(pts, 4000, 0, 9000), 10000, 'later iterations');
  assert.equal(M.nextStepTime([0.25, 0.75], 1000, 0, 800), 1250, 'wraps to the next iteration');
});
