// Tiny physics for the widget: springs, a hop arc, flick projection, release
// velocity, wall bounces, eye and blink timing — plus the MOTION config. Pure maths, no DOM — required by main.js and loaded with
// <script src> by the renderers (as window.BuddyMotion).
(function (root, factory) {
  const M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root.BuddyMotion = M;
}(typeof self !== 'undefined' ? self : this, () => {
  // Every motion constant, in one place. rig.js, main.js and index.html read
  // these at the moment they animate (never cached), so values pasted from
  // tools/tuning.html take effect by editing this object alone. Springs use
  // Apple's parameters: `response` (s) and `damping` (ratio; 1 = no bounce).
  const MOTION = {
    // pose change: parts glide from where they were to the new rest
    settle: { response: 0.3, damping: 0.72 },
    // press / landing: squash fast, then spring back through a stretch
    squash: { amount: 0.1, pressMs: 60, response: 0.34, damping: 0.42 },
    // one-shot pop-ins in CSS (banner, speech bubble, pots and plants)
    pop: { response: 0.4, damping: 0.62 },
    // the sign on its grip: lags body motion, swings back, settles
    pendulum: { response: 0.62, damping: 0.28, maxDeg: 6, dragGain: 0.004, kick: 70 },
    // garden walk (the mover's x); response is divided by the garden speed
    walk: { response: 2.2, damping: 1 },
    // drag release: coast on the flick's momentum
    glide: { response: 0.45, damping: 0.85, minSpeed: 150, maxSpeed: 4000, decel: 0.99 },
    // knock: hops on the Dock icon
    hop: { height: 16, ms: 280, gapMs: 220 },
    // a glide that reaches the work-area edge bounces off it
    edge: { restitution: 0.3, maxRebound: 60 },
    // natural blinks while the plain eyes show
    blink: { minMs: 3000, maxMs: 7000, closedMs: 110, doubleChance: 0.15 },
    // eyes follow the cursor by whole rig units; drift back when it rests
    eyes: { range: 1, deadzone: 48, pollMs: 200, holdMs: 2500 },
    // lamp change: a glow blooms off the newly lit lamp
    bloom: { ms: 420, scale: 1.9, opacity: 0.55 },
    // idle loops are sampled at this rate instead of every display frame;
    // stepped loops wake only when their frame actually changes; fast smooth
    // loops (a flame's flicker) get a finer grid that still lands on every
    // slow frame, so both cost one wake-up together
    ambient: { fps: 6, minMs: 1000, fastFps: 12, fastMinMs: 300 },
  };

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

  // A spring from 0 to 1 sampled into a CSS linear() easing, so CSS and WAAPI
  // animations settle on a real damped spring instead of a bezier guess.
  // Returns the easing and the time (ms) the spring takes to settle.
  function springEasing(response = 0.4, damping = 1, { fps = 60, maxMs = 3000, tolerance = 0.002 } = {}) {
    const params = springParams(response, damping);
    const dt = 1 / fps;
    const pts = [{ t: 0, x: 0 }];
    let s = { x: 0, v: 0 };
    let t = 0;
    while (t * 1000 < maxMs) {
      s = springStep(s, 1, dt, params);
      t += dt;
      pts.push({ t, x: s.x });
      if (Math.abs(s.x - 1) < 0.001 && Math.abs(s.v) < 0.01) break;
    }
    pts[pts.length - 1].x = 1;
    const total = t;
    // drop samples a straight line through their neighbours already gives
    const keep = [pts[0]];
    for (let i = 1; i < pts.length - 1; i += 1) {
      const a = keep[keep.length - 1];
      const c = pts[i + 1];
      const lerp = a.x + ((c.x - a.x) * (pts[i].t - a.t)) / (c.t - a.t);
      if (Math.abs(lerp - pts[i].x) > tolerance) keep.push(pts[i]);
    }
    keep.push(pts[pts.length - 1]);
    const r = (n, d) => Number(n.toFixed(d));
    const stops = keep.map((p, i) => (i === 0 || i === keep.length - 1 ? String(r(p.x, 3)) : `${r(p.x, 3)} ${r((p.t / total) * 100, 1)}%`));
    return { easing: `linear(${stops.join(', ')})`, ms: Math.round(total * 1000) };
  }

  // Keeps an angle (or any value) inside ±max without a hard stop: near-linear
  // when small, easing into the limit when large.
  function softLimit(x, max) {
    if (!(max > 0)) return 0;
    return max * Math.tanh(x / max);
  }

  // The angle a held sign leans to while its carrier moves at vx (px/s): it
  // trails the motion, more the faster it goes, never past maxDeg.
  function swayTarget(vx, gain, maxDeg) {
    return softLimit(-(Number(vx) || 0) * gain, maxDeg) || 0;
  }

  // One axis of a glide against the work-area walls [lo, hi]. Crossing a wall
  // while moving outward pins the position to it and reflects the velocity,
  // scaled by `restitution`. A position already outside but heading back in
  // is left alone. `hit` is -1 (lo wall), 1 (hi wall) or 0.
  function bounceAxis(state, lo, hi, restitution) {
    if (state.x < lo && state.v < 0) return { x: lo, v: -state.v * restitution, hit: -1 };
    if (state.x > hi && state.v > 0) return { x: hi, v: -state.v * restitution, hit: 1 };
    return { x: state.x, v: state.v, hit: 0 };
  }

  // Where a bounce off a wall at `edge` comes to rest: the reflected velocity
  // coasts back out, capped so a hard throw can't fling it far across.
  function reboundTarget(edge, v, decel, maxRebound) {
    const d = project(v, decel);
    return edge + Math.max(-maxRebound, Math.min(maxRebound, d));
  }

  // Eye offset (whole rig units, per axis) toward a cursor dx, dy px away from
  // the eyes: straight ahead inside the deadzone, one unit per deadzone
  // beyond it, never more than `range`.
  function eyeOffset(dx, dy, range, deadzone) {
    const axis = (d) => {
      const n = Math.min(range, Math.floor(Math.abs(d) / Math.max(1, deadzone)));
      return n > 0 ? Math.sign(d) * n : 0;
    };
    return { x: axis(dx), y: axis(dy) };
  }

  // Gap (ms) before the next blink, from a random draw in [0, 1).
  function nextBlinkDelay(rand, minMs, maxMs) {
    const lo = Math.max(0, Math.min(minMs, maxMs));
    const hi = Math.max(minMs, maxMs);
    return Math.round(lo + Math.min(1, Math.max(0, rand)) * (hi - lo));
  }

  // How an infinite loop is sampled by the ambient clock, from its keyframes
  // ({ offset, easing } with offsets 0..1), duration and direction:
  //   { stepped: true, points } — changes only at these iteration fractions,
  //     so it is woken exactly then;
  //   { stepped: false } — smooth, sampled at the ambient fps;
  //   { stepped: false, fast: true } — smooth but quick (fastMinMs..minMs),
  //     sampled at the fast fps;
  //   null — too short to sample (left to the display clock).
  function ambientPlan(keyframes, durationMs, direction, minMs, fastMinMs) {
    if (!(durationMs > 0) || !Array.isArray(keyframes) || keyframes.length < 2) return null;
    const segs = keyframes.slice(0, -1);
    const steps = segs.map((k) => /^steps\((\d+)|^step-(start|end)/.exec(String(k.easing || '')));
    if (steps.every(Boolean)) {
      const points = new Set();
      segs.forEach((k, i) => {
        const a = k.offset;
        const b = keyframes[i + 1].offset;
        const n = steps[i][1] ? Number(steps[i][1]) : 1;
        for (let j = 0; j <= n; j += 1) points.add(a + ((b - a) * j) / n);
      });
      if (direction && direction !== 'normal') for (const p of [...points]) points.add(1 - p);
      const list = [...points].map((p) => Math.min(1, Math.max(0, p))).sort((x, y) => x - y);
      return { stepped: true, points: [...new Set(list)] };
    }
    if (durationMs >= minMs) return { stepped: false };
    return fastMinMs > 0 && durationMs >= fastMinMs ? { stepped: false, fast: true } : null;
  }

  // Local time (ms since the animation's start) when a stepped loop next
  // changes, given its plan points, duration, delay and the current time.
  function nextStepTime(points, durationMs, delayMs, t) {
    const local = t - delayMs;
    if (local < 0) return delayMs;
    const iter = Math.floor(local / durationMs);
    const frac = local / durationMs - iter;
    const p = points.find((q) => q > frac + 1e-9);
    return delayMs + (p === undefined ? iter + 1 + points[0] : iter + p) * durationMs;
  }

  return {
    MOTION, springParams, springStep, springSettled, hopHeight, project, releaseVelocity, glideTarget,
    springEasing, softLimit, swayTarget, bounceAxis, reboundTarget, eyeOffset, nextBlinkDelay, ambientPlan, nextStepTime,
  };
}));
