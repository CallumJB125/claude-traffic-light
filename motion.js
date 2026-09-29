// Tiny physics for the widget: a spring, a hop arc, flick projection and
// release velocity. Pure maths, no DOM — required by main.js and loaded with
// <script src> by the renderers (as window.BuddyMotion).
(function (root, factory) {
  const M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root.BuddyMotion = M;
}(typeof self !== 'undefined' ? self : this, () => {
  // Apple-style parameters: `response` is roughly how long (s) the spring
  // takes to get there, `dampingRatio` 1 = no overshoot, < 1 = a little bounce.
  function springParams(response = 0.4, dampingRatio = 1) {
    const w = (2 * Math.PI) / Math.max(0.001, response);
    return { stiffness: w * w, damping: 2 * dampingRatio * w };
  }

  // Advance { x, v } toward `target` by dt seconds (unit mass). Substepped
  // semi-implicit Euler, so a janky 100 ms frame can't blow the spring up;
  // dt is capped so a backgrounded window resumes instead of teleporting.
  function springStep(state, target, dt, params) {
    const { stiffness, damping } = params;
    let { x, v } = state;
    let left = Math.min(Math.max(0, dt), 0.1);
    while (left > 0) {
      const h = Math.min(left, 1 / 240);
      v += (-stiffness * (x - target) - damping * v) * h;
      x += v * h;
      left -= h;
    }
    return { x, v };
  }

  function springSettled(state, target, posEps = 0.5, velEps = 20) {
    return Math.abs(state.x - target) < posEps && Math.abs(state.v) < velEps;
  }

  // Height of a hop at progress p (0..1) peaking at `height`: a gravity
  // parabola — decelerates on the way up, accelerates on the way down.
  function hopHeight(p, height) {
    const t = Math.min(1, Math.max(0, p));
    return 4 * height * t * (1 - t);
  }

  // Where a flick at velocity v (px/s) would coast to, with UIScrollView's
  // exponential deceleration (0.998 normal, 0.99 snappier).
  function project(v, rate = 0.99) {
    return ((v / 1000) * rate) / (1 - rate);
  }

  // Release velocity (px/s per axis) from recent {x, y, t(ms)} samples. Only
  // the last `windowMs` count, and a pointer that stopped before letting go
  // has no velocity — so a careful place-and-release never drifts.
  function releaseVelocity(samples, now, windowMs = 80, stillMs = 50) {
    let lastMove = null;
    for (let i = samples.length - 1; i > 0 && !lastMove; i -= 1) {
      if (samples[i].x !== samples[i - 1].x || samples[i].y !== samples[i - 1].y) lastMove = samples[i];
    }
    if (!lastMove || now - lastMove.t > stillMs) return { vx: 0, vy: 0 };
    const recent = samples.filter((s) => now - s.t <= windowMs);
    if (recent.length < 2) return { vx: 0, vy: 0 };
    const a = recent[0];
    const b = recent[recent.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  // A glide lands inside [lo, hi] — but never further out than where it
  // started, and never pulled back in past it: momentum can't push the
  // widget off-screen, and a widget parked half off an edge isn't yanked.
  function glideTarget(cur, projected, lo, hi) {
    return Math.min(Math.max(projected, Math.min(lo, cur)), Math.max(hi, cur));
  }

  return { springParams, springStep, springSettled, hopHeight, project, releaseVelocity, glideTarget };
}));
