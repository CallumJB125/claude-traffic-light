// The home page's motion. The page is complete and readable without it: the
// product is shown as captures of the real app (the board) and frames of the
// real character (sprite sheets), so nothing here renders a live scene. What
// moves is transforms and opacity only, driven from springs, and everything
// off screen is paused.
(function () {
  const $ = (id) => document.getElementById(id);
  const PX = window.PX;
  const reduce = PX.reduce;
  const clamp = PX.clamp;
  const sp = (init, opts, fn) => PX.spring(init, { ...opts, onUpdate: fn });
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

  // ── off-screen and hidden-tab pausing for every sprite, in one observer ──
  const sprites = new IntersectionObserver((es) => { for (const e of es) e.target.classList.toggle('is-off-screen', !e.isIntersecting); }, { rootMargin: '120px 0px' });
  document.querySelectorAll('.sprite-stack, .pet .slot').forEach((n) => sprites.observe(n));
  document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('tab-hidden', document.hidden));

  const setSprite = (stack, state) => { for (const s of stack.querySelectorAll('.sprite[data-state]')) s.classList.toggle('is-on', s.dataset.state === state); };
  // a finished one-shot animation is no longer listed by getAnimations(), so restart by name
  const restart = (el) => { const imgs = el.querySelectorAll('.burst img, .hit img'); imgs.forEach((i) => { i.style.animation = 'none'; }); void el.offsetWidth; imgs.forEach((i) => { i.style.animation = ''; }); };
  const burst = (el) => { if (!el || reduce) return; el.classList.add('play'); restart(el); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('play'), 1450); };
  const setFrame = (root, name) => { for (const l of root.querySelectorAll('.shot-layer')) l.classList.toggle('is-on', (l.dataset.frame || 'board') === name); };

  // where the card and its button sit in each captured frame (measured when captured)
  let RECTS = null;
  const rects = fetch('/assets/board/manifest.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((m) => { RECTS = m; return m; });
  const where = (frame, which) => { const r = RECTS && RECTS.rects[frame]; return r && (r[which] || r.card); };
  const place = (shots, el, rect, dx = 0, dy = 0) => { // a rect in 1440x900 capture px, onto the shown frame
    const k = shots.clientWidth / 1440;
    return { x: (rect.x + rect.w / 2 + dx) * k, y: (rect.y + rect.h / 2 + dy) * k, w: rect.w * k, h: rect.h * k };
  };

  // ── reveals: one orchestrated entrance for the hero, a calm one elsewhere ──
  const show = (n) => n.classList.add('in');
  const hero = $('top');
  requestAnimationFrame(() => {
    const h1 = hero.querySelector('h1.lines');
    if (h1) { h1.querySelectorAll('.ln > span').forEach((s, i) => s.style.setProperty('--rd', `${i * 90}ms`)); show(h1); }
    hero.querySelectorAll('.rv').forEach((n, i) => { n.style.setProperty('--rd', `${260 + i * 110}ms`); show(n); });
  });
  const rvio = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { show(e.target); rvio.unobserve(e.target); } }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.rv').forEach((n) => { if (!hero.contains(n)) rvio.observe(n); });

  // ── nav over the dark hero ──
  const nav = document.querySelector('.nav');
  if (nav) new IntersectionObserver((es) => nav.classList.toggle('on-dark', es[es.length - 1].isIntersecting), { rootMargin: '-40px 0px -100% 0px' }).observe(hero);

  // ── the plexus field: a few dozen drifting nodes, joined when near, drawn on one canvas ──
  const cv = $('field');
  if (cv) {
    const g = cv.getContext('2d');
    let W = 0; let H = 0; let dpr = 1; let nodes = []; let raf = 0; let on = false;
    const ptr = { x: -999, y: -999 };
    const size = () => {
      dpr = Math.min(devicePixelRatio || 1, 1.5);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(clamp((W * H) / 26000, 18, 64));
      nodes = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22, r: 1 + Math.random() * 1.4 }));
    };
    const LINK = 150;
    const frame = () => {
      g.clearRect(0, 0, W, H);
      for (const p of nodes) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
        if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
      }
      g.lineWidth = 1;
      for (let band = 0; band < 3; band += 1) { // three alpha bands, so a few strokes cover every line
        g.strokeStyle = `rgba(150, 178, 235, ${[0.07, 0.13, 0.22][band]})`;
        g.beginPath();
        for (let i = 0; i < nodes.length; i += 1) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j += 1) {
            const b = nodes[j];
            const dx = a.x - b.x; const dy = a.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > LINK * LINK) continue;
            const t = 1 - Math.sqrt(d2) / LINK;
            if ((t < 0.34 ? 0 : t < 0.67 ? 1 : 2) !== band) continue;
            g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
          }
          // the pointer is a node too: lines reach for it
          const px = a.x - ptr.x; const py = a.y - ptr.y;
          if (band === 2 && px * px + py * py < 170 * 170) { g.moveTo(a.x, a.y); g.lineTo(ptr.x, ptr.y); }
        }
        g.stroke();
      }
      g.fillStyle = 'rgba(200, 216, 250, 0.7)';
      for (const p of nodes) { g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283); g.fill(); }
      raf = on && !reduce ? requestAnimationFrame(frame) : 0;
    };
    const start = () => { if (on || reduce) return; on = true; if (!raf) raf = requestAnimationFrame(frame); };
    const stop = () => { on = false; cancelAnimationFrame(raf); raf = 0; };
    size();
    if (reduce) { frame(); } else {
      new IntersectionObserver((es) => { if (es[es.length - 1].isIntersecting && !document.hidden) start(); else stop(); }).observe(hero);
      document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (hero.getBoundingClientRect().bottom > 0) start(); });
    }
    let rw = innerWidth;
    new ResizeObserver(() => { if (Math.abs(cv.clientWidth - W) > 2 || Math.abs(cv.clientHeight - H) > 40) { size(); if (reduce) frame(); } }).observe(cv);
    if (fine) hero.addEventListener('pointermove', (e) => { const r = cv.getBoundingClientRect(); ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top; });
    hero.addEventListener('pointerleave', () => { ptr.x = ptr.y = -999; });
    void rw;
  }

  // ── hero: the real board, a card given to Claude, the real character reacting ──
  const heroShots = $('hero-shots');
  const heroFrame = $('hero-frame');
  const widget = $('hero-widget');
  const sprStack = $('hero-sprites');
  const LAMPS = { off: 'rgba(127,155,209,0.22)', working: 'rgba(47,174,62,0.30)', ready: 'rgba(242,162,0,0.32)', approve: 'rgba(226,35,26,0.30)' };
  const heroGlow = $('hero-glow');
  const cap = { off: ['Idle', 'No agents running'], working: ['Working', '1 agent'], approve: ['Needs you', 'Permission to run a command'], ready: ['Your turn', 'Finished, ready for review'] };
  const hero$ = {
    ring: $('hero-ring'), pointer: $('hero-pointer'),
    look(state) {
      widget.dataset.lamp = state === 'off' ? '' : state;
      setSprite(sprStack, state);
      heroGlow.style.setProperty('--hg', LAMPS[state]);
      $('hero-state').textContent = cap[state][0]; $('hero-detail').textContent = cap[state][1];
    },
  };
  hero$.look('off');
  // tilt + parallax: the window leans toward the cursor and drifts with scroll; the widget floats the other way (depth)
  const t = { ry: 0, rx: 0, wx: 0, wy: 0, sy: 0 };
  let painting = false;
  const paint = () => { if (painting) return; painting = true; requestAnimationFrame(() => { painting = false; paintNow(); }); };
  const paintNow = () => {
    heroFrame.style.transform = `translate3d(0, ${t.sy}px, 0) rotateY(${t.ry}deg) rotateX(${t.rx}deg)`;
    widget.style.transform = `translate3d(${t.wx}px, ${t.wy + t.sy * 1.7}px, 0)`;
  };
  if (!reduce) {
    const ry = sp(-5, { response: 0.8, damping: 0.8 }, (v) => { t.ry = v; paint(); });
    const rx = sp(2, { response: 0.8, damping: 0.8 }, (v) => { t.rx = v; paint(); });
    const wx = sp(0, { response: 0.9, damping: 0.8 }, (v) => { t.wx = v; paint(); });
    const wy = sp(0, { response: 0.9, damping: 0.8 }, (v) => { t.wy = v; paint(); });
    const sy = sp(0, { response: 0.5, damping: 1 }, (v) => { t.sy = v; paint(); });
    ry.jump(-5); rx.jump(2);
    const stage = $('hero-stage');
    let sr = stage.getBoundingClientRect(); let sTop = scrollY;
    new ResizeObserver(() => { sr = stage.getBoundingClientRect(); sTop = scrollY; }).observe(stage);
    if (fine) {
      hero.addEventListener('pointermove', (e) => { const r = { left: sr.left, top: sr.top + sTop - scrollY, width: sr.width, height: sr.height }; const u = clamp((e.clientX - r.left) / r.width, -0.2, 1.2) - 0.5; const v = clamp((e.clientY - r.top) / r.height, -0.2, 1.2) - 0.5; ry.to(-5 + u * 7); rx.to(2 - v * 5); wx.to(-u * 22); wy.to(-v * 16); });
      hero.addEventListener('pointerleave', () => { ry.to(-5); rx.to(2); wx.to(0); wy.to(0); });
    }
    let q = false;
    addEventListener('scroll', () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; if (scrollY < innerHeight * 1.2) sy.to(-scrollY * 0.06); }); }, { passive: true });
  } else { t.ry = -4; t.rx = 1; paint(); }

  // the loop: [ms, what happens]. The card can't move between captured frames, so the
  // frames crossfade and a ring marks where the action is.
  const cx = sp(0, { response: 0.8, damping: 0.85 }, () => {}); void cx;
  const cur = { x: 0, y: 0, s: 1, o: 0 };
  const putPtr = () => { hero$.pointer.style.transform = `translate(${cur.x}px, ${cur.y}px) scale(${cur.s})`; hero$.pointer.style.opacity = String(cur.o); };
  const px = sp(0, { response: 0.75, damping: 0.85 }, (v) => { cur.x = v; putPtr(); });
  const py = sp(0, { response: 0.75, damping: 0.85 }, (v) => { cur.y = v; putPtr(); });
  const ps = sp(1, { response: 0.22, damping: 0.7 }, (v) => { cur.s = v; putPtr(); });
  const ringAt = (frame, which, on) => {
    const r = where(frame, which);
    if (!r || !on) { hero$.ring.style.opacity = '0'; return; }
    const k = heroShots.clientWidth / 1440;
    hero$.ring.style.width = `${r.w * k + 10}px`; hero$.ring.style.height = `${r.h * k + 10}px`;
    hero$.ring.style.transform = `translate(${(r.x) * k - 5}px, ${(r.y) * k - 5}px)`;
    hero$.ring.style.opacity = '1';
  };
  const aimAt = (frame, which, dx = 14, dy = 10) => { const r = where(frame, which); if (!r) return; const p = place(heroShots, null, r, dx, dy); px.to(p.x); py.to(p.y); };
  let timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const tap = () => { ps.to(0.8); later(() => ps.to(1), 130); };
  const TIMELINE = [
    [0, () => { setFrame(heroShots, 'board'); hero$.look('off'); ringAt('', '', false); cur.o = 0; putPtr(); const p = place(heroShots, null, where('board-dark', 'give') || { x: 1000, y: 600, w: 10, h: 10 }, 220, 160); px.jump(p.x); py.jump(p.y); }],
    [900, () => { cur.o = 1; putPtr(); aimAt('board-dark', 'give'); ringAt('board-dark', 'give', true); }],
    [2000, () => tap()],
    [2250, () => { ringAt('', '', false); setFrame(heroShots, 'queued'); hero$.look('working'); aimAt('story-01-queued', 'card', 60, 40); }],
    [5400, () => { setFrame(heroShots, 'blocked'); hero$.look('approve'); ringAt('story-03-blocked', 'action', true); aimAt('story-03-blocked', 'action'); }],
    [7300, () => tap()],
    [7500, () => { ringAt('', '', false); setFrame(heroShots, 'queued'); hero$.look('working'); aimAt('story-01-queued', 'card', 60, 40); }],
    [9800, () => { setFrame(heroShots, 'review'); hero$.look('ready'); burst(sprStack.querySelector('.burst')); aimAt('story-06-in_review', 'card', 40, 30); }],
    [12400, () => { setFrame(heroShots, 'done'); hero$.look('ready'); aimAt('story-07-done', 'card', 40, 30); }],
    [14400, () => { cur.o = 0; putPtr(); }],
  ];
  const LOOP = 15600;
  rects.then(() => {
    if (reduce) { setFrame(heroShots, 'review'); hero$.look('ready'); return; }
    let running = false;
    const play = () => { timers.forEach(clearTimeout); timers = TIMELINE.map(([ms, fn]) => setTimeout(fn, ms)); timers.push(setTimeout(play, LOOP)); };
    const stop = () => { running = false; timers.forEach(clearTimeout); timers = []; };
    const go = () => { if (!running) { running = true; play(); } };
    new IntersectionObserver((es) => { if (es[es.length - 1].isIntersecting && !document.hidden) go(); else stop(); }).observe(heroFrame);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (heroFrame.getBoundingClientRect().bottom > 0) go(); });
  });

  // ── the hand-off story, driven by scroll ──
  // Pinned and scroll-driven on wide, tall screens. On a phone or a short window there
  // isn't room to pin, so it becomes the same story as plain content with the last frame showing.
  const story = $('story');
  if (story) {
    const mq = matchMedia('(max-width: 860px), (max-height: 720px)');
    let STATIC = reduce || mq.matches;
    const steps = [...$('story-steps').children];
    const pin = story.querySelector('.story-pin');
    const shots = $('story-shots');
    const frame = $('story-frame');
    const widget2 = $('story-widget');
    const stack = $('story-sprites');
    const ring = $('story-ring');
    const ptrEl = $('story-pointer');
    const FRAMES = ['board', 'queued', 'blocked', 'review'];
    const FRAME_KEY = ['board-dark', 'story-01-queued', 'story-03-blocked', 'story-06-in_review'];
    const SPR = ['off', 'working', 'approve', 'ready'];
    let last = -1;
    let K = 1;
    const measureK = () => { K = shots.clientWidth / 1440; };
    const render = (p) => {
      const step = STATIC ? 3 : p < 0.2 ? 0 : p < 0.47 ? 1 : p < 0.74 ? 2 : 3;
      if (step !== last) {
        steps.forEach((li, i) => li.classList.toggle('on', STATIC || i === step));
        setFrame(shots, FRAMES[step]);
        setSprite(stack, SPR[step]);
        widget2.dataset.lamp = SPR[step] === 'off' ? '' : SPR[step];
        if (step === 3 && last === 2) { const b = stack.querySelector('.burst'); burst(b); }
        last = step;
      }
      if (STATIC) return;
      // the pointer walks to the button through step 0, the ring pulses, then both let go
      const r = where(FRAME_KEY[step], step === 0 ? 'give' : 'action') || where(FRAME_KEY[step], 'card');
      if (r && RECTS) {
        const k = K;
        const walk = step === 0 ? clamp(p / 0.18) : 1;
        const from = { x: (r.x + r.w / 2) * k + 160 * (1 - walk), y: (r.y + r.h / 2) * k + 110 * (1 - walk) };
        ptrEl.style.transform = `translate(${from.x + 10}px, ${from.y + 8}px) scale(${step === 0 && walk >= 1 ? 0.84 : 1})`;
        ptrEl.style.opacity = step === 0 || step === 2 ? '1' : '0';
        ring.style.width = `${r.w * k + 10}px`; ring.style.height = `${r.h * k + 10}px`;
        ring.style.transform = `translate(${r.x * k - 5}px, ${r.y * k - 5}px)`;
        ring.style.opacity = step === 0 || step === 2 ? '1' : '0';
      }
      // depth: the window settles from a tilt to flat as you read, the widget drifts up
      const tilt = 6 * (1 - clamp(p / 0.5));
      frame.style.transform = `rotateY(${-tilt}deg) rotateX(${tilt * 0.35}deg) translate3d(0, ${(0.5 - p) * 26}px, 0)`;
      widget2.style.transform = `translate3d(0, ${(0.5 - p) * -40}px, 0)`;
    };
    const rawP = () => { const r = story.getBoundingClientRect(); return clamp(-r.top / Math.max(1, story.offsetHeight - pin.offsetHeight)); };
    const spr = PX.spring(0, { response: 0.32, damping: 0.92, precision: 0.0002, onUpdate: render });
    rects.then(() => {
      measureK();
      new ResizeObserver(measureK).observe(shots);
      if (STATIC) { spr.jump(1); }
      else spr.jump(rawP());
      // only while the story is near, and at most once a frame
      let near = false; let queued = false;
      new IntersectionObserver((es) => { near = es[es.length - 1].isIntersecting; if (near && !STATIC) spr.to(rawP()); }, { rootMargin: '100% 0px' }).observe(story);
      addEventListener('scroll', () => { if (!near || STATIC || queued) return; queued = true; requestAnimationFrame(() => { queued = false; spr.to(rawP()); }); }, { passive: true });
      let width = innerWidth;
      addEventListener('resize', () => { if (innerWidth === width) return; width = innerWidth; if (!STATIC) spr.jump(rawP()); });
      // crossing the breakpoint (rotating a tablet, resizing a window) swaps the layout: follow it
      const follow = () => { STATIC = reduce || mq.matches; last = -1; frame.style.transform = ''; widget2.style.transform = ''; ptrEl.style.opacity = '0'; ring.style.opacity = '0'; spr.jump(STATIC ? 1 : rawP()); };
      mq.addEventListener('change', follow);
    });
  }

  // ── the lamps you can press ──
  const lampList = $('lamp-list');
  if (lampList) {
    const stage = $('lamp-stage');
    const stack = $('lamp-sprites');
    lampList.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-look]');
      if (!b) return;
      for (const x of lampList.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      stage.dataset.lamp = b.dataset.look;
      setSprite(stack, b.dataset.look);
      stack.setAttribute('aria-label', `The character with the ${b.dataset.look === 'approve' ? 'red' : b.dataset.look === 'ready' ? 'amber' : 'green'} lamp on.`);
      if (b.dataset.look === 'ready') burst(stack.querySelector('.burst'));
    });
  }

  // ── board tabs: the real views, crossfaded ──
  const tabs = $('board-tabs');
  if (tabs) {
    const shots = $('tabs-shots');
    shots.tabIndex = 0;
    shots.querySelectorAll('.shot-layer').forEach((l) => l.setAttribute('aria-hidden', String(!l.classList.contains('is-on'))));
    const pick = (b) => {
      for (const x of tabs.querySelectorAll('.tab')) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); x.tabIndex = x === b ? 0 : -1; }
      for (const l of shots.querySelectorAll('.shot-layer')) { const on = l.dataset.view === b.dataset.view; l.classList.toggle('is-on', on); l.setAttribute('aria-hidden', String(!on)); }
      shots.setAttribute('aria-labelledby', b.id);
    };
    tabs.querySelectorAll('.tab').forEach((x, i) => { x.tabIndex = i === 0 ? 0 : -1; });
    tabs.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) pick(b); });
    tabs.addEventListener('keydown', (e) => {
      const all = [...tabs.querySelectorAll('.tab')]; const i = all.indexOf(document.activeElement);
      if (i < 0 || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
      all[n].focus(); pick(all[n]);
    });
  }

  // ── reveals that mean something: cards arriving, bars growing, lines drawn
  // the networks form as you scroll to them: edges draw, nodes pop on a spring.
  // Only what is on screen does any work; the pulses stop when it leaves.
  const nets = [];
  for (const id of ['mesh', 'hub']) {
    const svg = $(id);
    if (!svg) continue;
    const edges = [...svg.querySelectorAll('.edge')];
    const nodes = [...svg.querySelectorAll('.node')];
    const paint = (p) => {
      edges.forEach((e, i) => e.style.setProperty('--off', String(1 - PX.clamp((p - 0.12 - i * 0.07) / 0.4))));
      nodes.forEach((n, i) => { const t = PX.clamp((p - i * 0.06) / 0.3); n.style.transform = `scale(${0.7 + 0.3 * t})`; n.style.opacity = String(Math.min(1, t * 1.6)); });
      svg.toggleAttribute('data-live', p > 0.7 && net.visible);
    };
    const net = { svg, visible: false, spring: PX.spring(0, { response: 0.5, damping: 0.8, precision: 0.0005, onUpdate: paint }), paint };
    net.target = () => { const r = svg.getBoundingClientRect(); return PX.clamp((innerHeight - r.top) / (innerHeight * 0.75 + r.height * 0.3)); };
    if (PX.reduce) { paint(1); continue; }
    paint(0);
    new IntersectionObserver((es) => { net.visible = es[es.length - 1].isIntersecting; if (net.visible) net.spring.to(net.target()); else svg.removeAttribute('data-live'); }, { rootMargin: '120px' }).observe(svg);
    nets.push(net);
  }
  if (nets.length) {
    let queued = false;
    addEventListener('scroll', () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; for (const n of nets) if (n.visible) n.spring.to(n.target()); }); }, { passive: true });
  }


  // ── characters: click one and it cheers ──
  const gallery = $('gallery');
  if (gallery) {
    gallery.addEventListener('click', (e) => {
      const b = e.target.closest('.pet');
      if (!b) return;
      b.classList.add('cheer'); restart(b);
      clearTimeout(b._t); b._t = setTimeout(() => b.classList.remove('cheer'), 1650);
    });
  }
})();
