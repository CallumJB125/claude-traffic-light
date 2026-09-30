// The home page's motion. Everything here is lazy: the page is complete and
// readable without it, and the real pixel rig (the app's own rig.js) is only
// fetched once something that needs it is near the screen.
(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const APP = '/assets/app/';
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

  // ── the rig, loaded once ────────────────────────────────────────────────
  let rigLoad = null;
  function loadRig() {
    if (rigLoad) return rigLoad;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${APP}rig.css`;
    document.head.append(css);
    const add = (src) => new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = `${APP}${src}`; s.onload = resolve; s.onerror = reject; document.head.append(s); });
    // in order: the motion maths, the character contract, the built-ins, the rig
    rigLoad = ['motion.js', 'characters/contract.js', 'characters/builtin/core.js', 'rig.js'].reduce((p, f) => p.then(() => add(f)), Promise.resolve()).then(() => window.mountRig);
    return rigLoad;
  }
  // mount a rig into `node` the first time it comes within a screen of the viewport
  function whenNear(node, run, margin = '300px') {
    if (!node) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); run(); } }, { rootMargin: margin });
    io.observe(node);
  }
  // keep a rig's own clocks stopped while it is off screen or the tab is hidden
  function tend(node, rig) {
    let visible = true;
    const sync = () => rig.setHidden(!visible || document.hidden);
    const io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; sync(); }, { rootMargin: '80px' });
    io.observe(node);
    document.addEventListener('visibilitychange', sync);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }
  async function mount(node, look, opts) {
    const mountRig = await loadRig();
    const rig = mountRig(node, { ambient: true, ...opts });
    rig.setLook({ lamp: 'off', eyes: 'default', pose: 'none', ...look });
    rig.blinks(true);
    const untend = tend(node, rig);
    rig.dispose = () => { untend(); rig.blinks(false); rig.setHidden(true); node.replaceChildren(); };
    return rig;
  }
  // A rig that exists only while it is near the screen. Each one is hundreds of
  // SVG nodes, and a long page of them is heavy on a phone, so far-away rigs
  // are taken down and put back (with their last look) when you return.
  // → { rig } holder; `ready(rig)` runs after every (re)mount.
  function lazyRig(node, look, opts, ready) {
    const holder = { rig: null, look: { ...look } };
    let busy = false;
    const io = new IntersectionObserver(async (es) => {
      const near = es[es.length - 1].isIntersecting;
      if (near && !holder.rig && !busy) {
        busy = true;
        holder.rig = await mount(node, holder.look, opts);
        if (ready) ready(holder.rig);
        busy = false;
      } else if (!near && holder.rig) {
        holder.look = { ...holder.rig.look };
        holder.rig.dispose();
        holder.rig = null;
      }
    }, { rootMargin: '700px 0px' });
    io.observe(node);
    return holder;
  }

  // ── hero: the product running on a loop ────────────────────────────────
  // A fixed-size scene scaled to fit. A card is given to Claude, travels across
  // the board on springs, the widget's real rig changes lamp as it goes, an
  // approval interrupts, a pointer does the clicking, and the window tilts
  // toward your cursor. Everything moves on springs, so it has mass. Springs
  // write straight to element styles (never to inherited custom properties,
  // which would restyle every node of the rig under them on each frame).
  const scene = $('scene');
  const PX = window.PX;
  const GLOW = { green: '#2fae3e', amber: '#f2a200', red: '#e2231a' };
  const sp = (init, opts, fn) => PX.spring(init, { ...opts, onUpdate: fn });
  function sceneFit() { scene.style.setProperty('--k', String(scene.clientWidth / 560)); }
  async function hero() {
    sceneFit();
    new ResizeObserver(sceneFit).observe(scene);
    const rig = await mount($('hero-rig'), {});
    const body = $('win-body');
    const win = $('win');
    const mcard = $('mcard');
    const widget = $('widget');
    const pointer = $('pointer');
    const ask = $('ask');
    const give = $('give');
    const askBtn = $('ask-btn');
    const barEl = $('mcard-bar');
    const glow = $('scene-glow');
    const colEl = (n) => body.querySelector(`[data-col="${n}"]`);
    // where the traveller sits: slot `i` of a column, in body coordinates
    const slotPos = (col, i) => { const c = colEl(col); const s2 = c.querySelectorAll('.slot')[i]; return { x: c.offsetLeft + s2.offsetLeft, y: c.offsetTop + s2.offsetTop }; };
    const spot = (el) => { // the centre of an element, in scene design pixels
      let x = el.offsetWidth / 2; let y = el.offsetHeight / 2;
      for (let n = el; n && n.id !== 'scene-inner'; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
      return { x, y };
    };
    const card = { x: 0, y: 0 };
    const placeCard = () => { mcard.style.transform = `translate(${card.x}px, ${card.y}px)`; };
    const mx = sp(0, { response: 0.6, damping: 0.72 }, (v) => { card.x = v; placeCard(); });
    const my = sp(0, { response: 0.6, damping: 0.72 }, (v) => { card.y = v; placeCard(); });
    const cur = { x: 0, y: 0, s: 1 };
    const placeCur = () => { pointer.style.transform = `translate(${cur.x}px, ${cur.y}px) scale(${cur.s})`; };
    const cx = sp(0, { response: 0.75, damping: 0.85 }, (v) => { cur.x = v; placeCur(); });
    const cy = sp(0, { response: 0.75, damping: 0.85 }, (v) => { cur.y = v; placeCur(); });
    const pscale = sp(1, { response: 0.22, damping: 0.7 }, (v) => { cur.s = v; placeCur(); });
    const bar = sp(0, { response: 2.4, damping: 1, precision: 0.001 }, (v) => { barEl.style.transform = `scaleX(${v})`; });
    const gbtn = sp(1, { response: 0.2, damping: 0.7 }, (v) => { give.style.transform = `scale(${v})`; });
    const abtn = sp(1, { response: 0.2, damping: 0.7 }, (v) => { askBtn.style.transform = `scale(${v})`; });
    const askY = sp(12, { response: 0.45, damping: 0.75 }, (v) => { ask.style.transform = `translateY(${v}px)`; });
    const askO = sp(0, { response: 0.3, damping: 1 }, (v) => { ask.style.opacity = String(v); });
    const glowO = sp(0, { response: 0.9, damping: 1 }, (v) => { glow.style.opacity = String(v); });

    const caption = (lamp, state, detail) => {
      widget.dataset.lamp = lamp;
      $('desk-state').textContent = state;
      $('desk-detail').textContent = detail;
      if (GLOW[lamp]) { glow.style.background = `radial-gradient(closest-side, color-mix(in srgb, ${GLOW[lamp]} 34%, transparent), transparent 72%)`; glowO.to(1); } else glowO.to(0);
    };
    const goTo = (col, i) => { const p = slotPos(col, i); mx.to(p.x); my.to(p.y); };
    const jumpTo = (col, i) => { const p = slotPos(col, i); mx.jump(p.x); my.jump(p.y); };
    const aim = (el, dx = 0, dy = 0) => { const p = spot(el); cx.to(p.x + dx); cy.to(p.y + dy); };
    let timers = [];
    const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };
    const press = (spr) => { spr.to(0.86); pscale.to(0.82); later(() => { spr.to(1); pscale.to(1); }, 130); };
    const AGENTS = (st) => [{ name: 'claude', status: st }];
    const reset = () => {
      jumpTo('todo', 0);
      mcard.style.transition = 'none'; mcard.style.opacity = '1';
      give.style.display = '';
      $('mcard-note').textContent = 'Unassigned';
      barEl.parentElement.style.opacity = '0';
      bar.jump(0); gbtn.jump(1); abtn.jump(1); askY.jump(12); askO.jump(0);
      rig.setLook({ ...(rig.look || {}), lamp: 'off', pose: 'none', eyes: 'default', text: '', minions: [] });
      caption('off', 'Idle', 'No agents running');
      pointer.style.opacity = '0';
      cx.jump(470); cy.jump(380);
    };
    // the loop: [ms, what happens]
    const TIMELINE = [
      [0, reset],
      [900, () => { pointer.style.opacity = '1'; aim(give, 18, 8); }],
      [2000, () => press(gbtn)],
      [2250, () => { give.style.display = 'none'; $('mcard-note').textContent = 'Claude · running'; barEl.parentElement.style.opacity = '1'; bar.to(0.9); goTo('doing', 1); rig.setLook({ ...rig.look, lamp: 'green', pose: 'think', eyes: 'default', minions: AGENTS('working') }); caption('green', 'Working', '1 agent'); aim(widget, -40, -90); }],
      [5400, () => { rig.setLook({ ...rig.look, lamp: 'red', pose: 'banner', eyes: 'surprised', text: 'APPROVE?' }); caption('red', 'Needs you', 'Permission to run a command'); askY.to(0); askO.to(1); later(() => aim(askBtn, 6, 4), 500); }],
      [7300, () => press(abtn)],
      [7500, () => { askY.to(12); askO.to(0); rig.setLook({ ...rig.look, lamp: 'green', pose: 'think', eyes: 'default', text: '' }); caption('green', 'Working', '1 agent'); aim(widget, -40, -90); }],
      [9800, () => { bar.to(1); $('mcard-note').textContent = 'Ready for review'; goTo('review', 0); rig.setLook({ ...rig.look, lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: AGENTS('done') }); caption('amber', 'Your turn', 'Finished, ready for review'); rig.celebrate(); }],
      [11800, () => aim(mcard, 40, 18)],
      [12900, () => { press(gbtn); $('mcard-note').textContent = 'Merged'; goTo('done', 1); rig.setLook({ ...rig.look, lamp: 'green', pose: 'none', eyes: 'default', minions: [] }); caption('green', 'Idle', 'Nothing waiting'); }],
      [14600, () => { pointer.style.opacity = '0'; }],
      // fade the card out before the loop restarts, so it never snaps back
      [15300, () => { mcard.style.transition = 'opacity 280ms ease'; mcard.style.opacity = '0'; }],
    ];
    const LOOP = 16200;
    if (PX.reduce) { // one finished still frame, nothing moving
      jumpTo('done', 1); give.style.display = 'none'; $('mcard-note').textContent = 'Merged';
      rig.setLook({ ...rig.look, lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: [] });
      caption('amber', 'Your turn', 'Finished, ready for review');
      return;
    }
    let running = false;
    const play = () => { timers.forEach(clearTimeout); timers = TIMELINE.map(([t, fn]) => setTimeout(fn, t)); timers.push(setTimeout(play, LOOP)); };
    const stop = () => { running = false; timers.forEach(clearTimeout); timers = []; };
    const go = () => { if (!running) { running = true; play(); } };
    new IntersectionObserver((es) => { const on = es[es.length - 1].isIntersecting && !document.hidden; if (on) go(); else stop(); }).observe(scene);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (scene.getBoundingClientRect().bottom > 0) go(); });
    addEventListener('resize', () => { if (!running) jumpTo('todo', 0); });

    // depth: the window tilts toward the cursor (real perspective on the window
    // itself) and the widget floats the other way
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
      const t = { ry: 0, rx: 0, wx: 0, wy: 0 };
      const paint = () => { win.style.transform = `perspective(1400px) rotateY(${t.ry}deg) rotateX(${t.rx}deg)`; widget.style.transform = `translate(${t.wx}px, ${t.wy}px)`; };
      const ry = sp(0, { response: 0.7, damping: 0.8 }, (v) => { t.ry = v; paint(); });
      const rx = sp(0, { response: 0.7, damping: 0.8 }, (v) => { t.rx = v; paint(); });
      const wx = sp(0, { response: 0.9, damping: 0.8 }, (v) => { t.wx = v; paint(); });
      const wy = sp(0, { response: 0.9, damping: 0.8 }, (v) => { t.wy = v; paint(); });
      scene.addEventListener('pointermove', (e) => { const r = scene.getBoundingClientRect(); const u = (e.clientX - r.left) / r.width - 0.5; const v = (e.clientY - r.top) / r.height - 0.5; ry.to(u * 7); rx.to(-v * 5); wx.to(-u * 16); wy.to(-v * 12); });
      scene.addEventListener('pointerleave', () => { ry.to(0); rx.to(0); wx.to(0); wy.to(0); });
    }
  }
  // load as soon as the browser is idle: the headline is already painted
  (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(hero);

  // ── the hand-off story, driven by scroll ───────────────────────────────
  // Pinned and scroll-driven on wide, tall screens. On a phone or a short
  // window there isn't room to pin four steps and a board, so it becomes the
  // same story laid out as plain content, finished state showing.
  const story = $('story');
  if (story) {
    const STATIC = PX.reduce || matchMedia('(max-width: 860px), (max-height: 720px)').matches;
    const steps = [...$('story-steps').children];
    const stage = $('stage-card');
    const pin = story.querySelector('.story-pin');
    const run = $('run');
    const runNote = $('run-note');
    const stageLamp = $('stage-lamp');
    const handover = $('handover');
    const origin = stage.querySelector('[data-card="a"]');
    const give = $('give2');
    const cols = [...$('cols').querySelectorAll('.col')];
    let rig = null;
    let last = -1;
    let lastNote = '';
    let pos = null;
    const at = (el) => { const a = el.getBoundingClientRect(); const b = stage.getBoundingClientRect(); return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }; };
    // where the card rides from and to: measured once (the stage is pinned, so scroll doesn't move it)
    const measure = () => {
      const from = at(origin);
      const below = (colEl) => { const c = colEl.querySelector('.card:not([data-card])') || colEl.querySelector('.card'); const base = at(colEl); return { x: base.x + 10, y: c ? at(c).y + at(c).h + 8 : base.y + 36 }; };
      pos = { from, doing: below(cols[1]), done: below(cols[2]) };
      run.style.width = `${from.w}px`;
    };
    const LOOKS = [
      { lamp: 'off', pose: 'none', eyes: 'default', minions: [] },
      { lamp: 'off', pose: 'none', eyes: 'default', minions: [] },
      { lamp: 'green', pose: 'think', eyes: 'default', minions: [{ name: 'claude', status: 'working' }] },
      { lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: [{ name: 'claude', status: 'done' }] },
    ];
    const NOTES = ['Claude · starting', 'Claude · starting', 'Claude · running', 'Claude · finished'];
    // scroll position is the target; the scene chases it on a spring, so it
    // glides through a fast flick instead of jumping with every wheel tick
    const render = (p) => {
      if (!pos) return;
      const step = p < 0.22 ? 0 : p < 0.5 ? 1 : p < 0.78 ? 2 : 3;
      if (step !== last) {
        steps.forEach((li, i) => li.classList.toggle('on', STATIC || i === step));
        stageLamp.textContent = ['idle', 'queued', 'working', 'your turn'][step];
        if (rig) { rig.setLook({ ...(rig.look || {}), ...LOOKS[step] }); if (step === 3 && last === 2) rig.celebrate(); }
        if (NOTES[step] !== lastNote) { lastNote = NOTES[step]; runNote.textContent = lastNote; }
        handover.hidden = step < 3;
        last = step;
      }
      const press = step === 0 ? Math.sin(PX.clamp(p / 0.22) * Math.PI) : 0;
      give.style.transform = `scale(${1 - 0.1 * press})`;
      const a = PX.clamp((p - 0.22) / 0.26);
      const b = PX.clamp((p - 0.78) / 0.22);
      const x = pos.from.x + (pos.doing.x - pos.from.x) * a + (pos.done.x - pos.doing.x) * b;
      const y = pos.from.y + (pos.doing.y - pos.from.y) * a + (pos.done.y - pos.doing.y) * b;
      run.hidden = p < 0.22;
      origin.style.visibility = p < 0.22 ? 'visible' : 'hidden';
      run.style.transform = `translate(${x}px, ${y}px)`;
    };
    // the pin is the viewport tall (svh: stable while a phone's toolbar collapses)
    const rawP = () => { const r = story.getBoundingClientRect(); return PX.clamp(-r.top / Math.max(1, story.offsetHeight - pin.offsetHeight)); };
    const spr = PX.spring(0, { response: 0.32, damping: 0.92, precision: 0.0002, onUpdate: render });
    if (STATIC) {
      whenNear(story, async () => { measure(); rig = await mount($('story-rig'), LOOKS[3]); last = -1; spr.jump(1); });
    } else {
      whenNear(story, async () => { measure(); rig = await mount($('story-rig'), LOOKS[0]); last = -1; spr.jump(rawP()); });
      addEventListener('scroll', () => spr.to(rawP()), { passive: true });
      // a phone's toolbar collapsing changes the height only: ignore that, re-measure real resizes
      let width = innerWidth;
      addEventListener('resize', () => { if (innerWidth === width) return; width = innerWidth; measure(); spr.jump(rawP()); });
    }
  }

  // ── the lamps you can press ────────────────────────────────────────────
  const lampList = $('lamp-list');
  if (lampList) {
    const LOOK = {
      green: { lamp: 'green', pose: 'think', eyes: 'default', text: '' },
      amber: { lamp: 'amber', pose: 'thumbs', eyes: 'happy', text: '' },
      red: { lamp: 'red', pose: 'banner', eyes: 'surprised', text: 'APPROVE?' },
    };
    const h = lazyRig($('lamp-rig'), LOOK.green);
    lampList.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-look]');
      if (!b) return;
      for (const x of lampList.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      $('lamp-desk').dataset.lamp = b.dataset.look;
      h.look = { ...h.look, ...LOOK[b.dataset.look] };
      if (h.rig) { h.rig.setLook({ ...(h.rig.look || {}), ...LOOK[b.dataset.look] }); if (b.dataset.look === 'amber') h.rig.celebrate(); }
    });
  }

  // ── reveals that mean something: cards arriving, bars growing, lines drawn
  const live = (node, fn) => { if (!node) return; if (reduce) { fn(); return; } const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { threshold: 0.35 }); io.observe(node); };
  live($('board'), () => $('board').removeAttribute('data-pre'));
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

  // ── agents: chips in every state ───────────────────────────────────────
  lazyRig($('agents-rig'), { lamp: 'green', pose: 'think', minions: [{ name: 'claude', status: 'working' }, { name: 'codex', status: 'working' }, { name: 'cursor', status: 'waiting' }, { name: 'gemini', status: 'done' }] });

  // ── characters: click one and it poses ─────────────────────────────────
  const gallery = $('gallery');
  if (gallery) {
    const PETS = [['claude', 'Claude'], ['dog', 'Dog'], ['cat', 'Cat'], ['frog', 'Frog'], ['robot', 'Robot'], ['ghost', 'Ghost']];
    const POSES = ['wave', 'cheer', 'spin', 'party', 'bounce', 'thumbs'];
    let n = 0;
    const cells = PETS.map(([body, name]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pet';
      b.setAttribute('aria-label', `${name}: click to make it pose`);
      const slot = document.createElement('span');
      slot.className = 'slot';
      b.append(slot, document.createTextNode(name));
      gallery.append(b);
      return { b, slot, body };
    });
    cells.forEach((c) => {
      const h = lazyRig(c.slot, { lamp: 'green', body: c.body });
      c.b.addEventListener('click', () => {
        if (!h.rig) return;
        const pose = POSES[n++ % POSES.length];
        h.rig.react({ pose, eyes: pose === 'party' || pose === 'cheer' ? 'star' : 'happy' }, 1800);
        h.rig.celebrate();
      });
    });
  }
})();
