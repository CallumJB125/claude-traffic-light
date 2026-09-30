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
  // toward your cursor. Everything moves on springs, so it has mass.
  const scene = $('scene');
  const PX = window.PX;
  const L = { off: 'off', green: 'green', amber: 'amber', red: 'red' };
  const GLOW = { green: '#2fae3e', amber: '#f2a200', red: '#e2231a' };
  function sceneFit() { const k = scene.clientWidth / 560; scene.style.setProperty('--k', String(k)); }
  async function hero() {
    sceneFit();
    new ResizeObserver(sceneFit).observe(scene);
    const rig = await mount($('hero-rig'), {});
    const body = $('win-body');
    const mcard = $('mcard');
    const widget = $('widget');
    const pointer = $('pointer');
    const ask = $('ask');
    const colEl = (n) => body.querySelector(`[data-col="${n}"]`);
    // where the traveller sits: slot `i` of a column, in body coordinates
    const slotPos = (col, i) => { const c = colEl(col); const s = c.querySelectorAll('.slot')[i]; return { x: c.offsetLeft + s.offsetLeft, y: c.offsetTop + s.offsetTop }; };
    const spot = (el) => { // the centre of an element, in scene design pixels
      let x = el.offsetWidth / 2; let y = el.offsetHeight / 2;
      for (let n = el; n && n.id !== 'scene-inner'; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
      return { x, y };
    };
    const mx = PX.spring(0, { response: 0.6, damping: 0.72 });
    const my = PX.spring(0, { response: 0.6, damping: 0.72 });
    const place = () => { mcard.style.transform = `translate(${mx.x}px, ${my.x}px)`; };
    mx.step = ((o) => (dt) => { o(dt); place(); })(mx.step);
    my.step = ((o) => (dt) => { o(dt); place(); })(my.step);
    const cx = PX.spring(0, { response: 0.75, damping: 0.85 });
    const cy = PX.spring(0, { response: 0.75, damping: 0.85 });
    const pscale = PX.spring(1, { response: 0.22, damping: 0.6 });
    const cur = () => { pointer.style.transform = `translate(${cx.x}px, ${cy.x}px) scale(${pscale.x})`; };
    [cx, cy, pscale].forEach((sp) => { sp.step = ((o) => (dt) => { o(dt); cur(); })(sp.step); });
    const bar = PX.spring(0, { response: 2.4, damping: 1, precision: 0.001 });
    bar.step = ((o) => (dt) => { o(dt); $('mcard-bar').style.transform = `scaleX(${bar.x})`; })(bar.step);
    const gbtn = PX.spring(1, { response: 0.2, damping: 0.6 });
    gbtn.step = ((o) => (dt) => { o(dt); $('give').style.transform = `scale(${gbtn.x})`; })(gbtn.step);
    const abtn = PX.spring(1, { response: 0.2, damping: 0.6 });
    abtn.step = ((o) => (dt) => { o(dt); $('ask-btn').style.transform = `scale(${abtn.x})`; })(abtn.step);
    const askY = PX.spring(12, { response: 0.45, damping: 0.75 });
    const askO = PX.spring(0, { response: 0.3, damping: 1 });
    askY.step = ((o) => (dt) => { o(dt); ask.style.transform = `translateY(${askY.x}px)`; })(askY.step);
    askO.step = ((o) => (dt) => { o(dt); ask.style.opacity = String(askO.x); })(askO.step);
    const glowO = PX.spring(0, { response: 0.9, damping: 1 });
    glowO.step = ((o) => (dt) => { o(dt); scene.style.setProperty('--glow-o', String(glowO.x)); })(glowO.step);

    const caption = (lamp, state, detail) => {
      widget.dataset.lamp = lamp;
      $('desk-state').textContent = state;
      $('desk-detail').textContent = detail;
      if (GLOW[lamp]) { scene.style.setProperty('--glow', `color-mix(in srgb, ${GLOW[lamp]} 34%, transparent)`); glowO.to(1); } else glowO.to(0);
    };
    const goTo = (col, i) => { const p = slotPos(col, i); mx.to(p.x); my.to(p.y); };
    const jumpTo = (col, i) => { const p = slotPos(col, i); mx.jump(p.x); my.jump(p.y); place(); };
    const aim = (el, dx = 0, dy = 0) => { const p = spot(el); cx.to(p.x + dx); cy.to(p.y + dy); };
    const press = (sp) => { sp.to(0.86); setTimeout(() => sp.to(1), 130); pscale.to(0.82); setTimeout(() => pscale.to(1), 130); };
    const AGENTS = (st) => [{ name: 'claude', status: st }];
    const reset = () => {
      jumpTo('todo', 0);
      mcard.classList.remove('gone');
      $('give').style.display = '';
      $('mcard-note').textContent = 'Unassigned';
      $('mcard-bar').parentElement.style.opacity = '0';
      bar.jump(0); gbtn.jump(1); abtn.jump(1);
      askY.jump(12); askO.jump(0);
      rig.setLook({ ...(rig.look || {}), lamp: 'off', pose: 'none', eyes: 'default', text: '', minions: [] });
      caption('off', 'Idle', 'No agents running');
      pointer.style.opacity = '0';
      cx.jump(470); cy.jump(380);
    };
    // the loop: [ms, what happens]
    const TIMELINE = [
      [0, reset],
      [900, () => { pointer.style.opacity = '1'; aim($('give'), 18, 8); }],
      [2000, () => press(gbtn)],
      [2250, () => { $('give').style.display = 'none'; $('mcard-note').textContent = 'Claude · running'; $('mcard-bar').parentElement.style.opacity = '1'; bar.to(0.9); goTo('doing', 1); rig.setLook({ ...rig.look, lamp: 'green', pose: 'think', eyes: 'default', minions: AGENTS('working') }); caption('green', 'Working', '1 agent'); aim(widget, -40, -90); }],
      [5400, () => { rig.setLook({ ...rig.look, lamp: 'red', pose: 'banner', eyes: 'surprised', text: 'APPROVE?' }); caption('red', 'Needs you', 'Permission to run a command'); askY.to(0); askO.to(1); setTimeout(() => aim($('ask-btn'), 6, 4), 500); }],
      [7300, () => press(abtn)],
      [7500, () => { askY.to(12); askO.to(0); rig.setLook({ ...rig.look, lamp: 'green', pose: 'think', eyes: 'default', text: '' }); caption('green', 'Working', '1 agent'); aim(widget, -40, -90); }],
      [9800, () => { bar.to(1); $('mcard-note').textContent = 'Ready for review'; goTo('review', 0); rig.setLook({ ...rig.look, lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: AGENTS('done') }); caption('amber', 'Your turn', 'Finished, ready for review'); rig.celebrate(); }],
      [11800, () => { aim(mcard, 40, 18); }],
      [12900, () => { press(gbtn); $('mcard-note').textContent = 'Merged'; goTo('done', 1); rig.setLook({ ...rig.look, lamp: 'green', pose: 'none', eyes: 'default', minions: [] }); caption('green', 'Idle', 'Nothing waiting'); }],
      [14600, () => { pointer.style.opacity = '0'; }],
    ];
    const LOOP = 16200;
    if (PX.reduce) { // one finished still frame, nothing moving
      jumpTo('done', 1); $('give').style.display = 'none'; $('mcard-note').textContent = 'Merged';
      rig.setLook({ ...rig.look, lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: [] });
      caption('amber', 'Your turn', 'Finished, ready for review');
      return;
    }
    let timers = [];
    let running = false;
    const play = () => { timers.forEach(clearTimeout); timers = TIMELINE.map(([t, fn]) => setTimeout(fn, t)); timers.push(setTimeout(play, LOOP)); };
    const stop = () => { running = false; timers.forEach(clearTimeout); };
    const go = () => { if (!running) { running = true; play(); } };
    new IntersectionObserver((es) => { const on = es[es.length - 1].isIntersecting && !document.hidden; if (on) go(); else stop(); }).observe(scene);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (scene.getBoundingClientRect().bottom > 0) go(); });
    addEventListener('resize', () => { if (!running) jumpTo('todo', 0); });

    // depth: the window tilts toward the cursor and the widget floats the other way
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
      const ry = PX.spring(0, { response: 0.7, damping: 0.8 });
      const rx = PX.spring(0, { response: 0.7, damping: 0.8 });
      const wx = PX.spring(0, { response: 0.9, damping: 0.8 });
      const wy = PX.spring(0, { response: 0.9, damping: 0.8 });
      const tilt = () => { scene.style.setProperty('--ry', `${ry.x}deg`); scene.style.setProperty('--rx', `${rx.x}deg`); widget.style.setProperty('--wx', `${wx.x}px`); widget.style.setProperty('--wy', `${wy.x}px`); };
      for (const sp of [ry, rx, wx, wy]) sp.step = ((o) => (dt) => { o(dt); tilt(); })(sp.step);
      const w = document.getElementById('win');
      scene.addEventListener('pointermove', (e) => { const r = scene.getBoundingClientRect(); const u = (e.clientX - r.left) / r.width - 0.5; const v = (e.clientY - r.top) / r.height - 0.5; ry.to(u * 7); rx.to(-v * 5); wx.to(-u * 16); wy.to(-v * 12); w.style.setProperty('--ry', `${u * 7}deg`); });
      scene.addEventListener('pointerleave', () => { ry.to(0); rx.to(0); wx.to(0); wy.to(0); });
    }
  }
  // load as soon as the browser is idle: the headline is already painted
  (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(hero);

  // ── the hand-off story, driven by scroll ───────────────────────────────
  const story = $('story');
  if (story) {
    const steps = [...$('story-steps').children];
    const stage = $('stage-card');
    const run = $('run');
    const origin = stage.querySelector('[data-card="a"]');
    const give = $('give2') || story.querySelector('.give');
    const cols = [...$('cols').querySelectorAll('.col')];
    let rig = null;
    let last = -1;
    let pos = null;
    const at = (el) => { const a = el.getBoundingClientRect(); const b = stage.getBoundingClientRect(); return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }; };
    // where the card rides from and to: measured once (the stage is pinned, so scroll doesn't move it)
    const measure = () => {
      const from = at(origin);
      const below = (colEl) => { const c = colEl.querySelector('.card:not([data-card])') || colEl.querySelector('.card'); const base = at(colEl); return { x: base.x + 10, y: c ? at(c).y + at(c).h + 8 : base.y + 36 }; };
      pos = { from, doing: below(cols[1]), done: below(cols[2]) };
    };
    const LOOKS = [
      { lamp: 'off', pose: 'none', eyes: 'default', minions: [] },
      { lamp: 'off', pose: 'none', eyes: 'default', minions: [] },
      { lamp: 'green', pose: 'think', eyes: 'default', minions: [{ name: 'claude', status: 'working' }] },
      { lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: [{ name: 'claude', status: 'done' }] },
    ];
    // scroll position is the target; the scene chases it on a spring, so it
    // glides through a fast flick instead of jumping with every wheel tick
    const render = (p) => {
      if (!pos) return;
      const step = p < 0.22 ? 0 : p < 0.5 ? 1 : p < 0.78 ? 2 : 3;
      if (step !== last) {
        steps.forEach((li, i) => li.classList.toggle('on', i === step));
        $('stage-lamp').textContent = ['idle', 'queued', 'working', 'your turn'][step];
        if (rig) { rig.setLook({ ...(rig.look || {}), ...LOOKS[step] }); if (step === 3 && last === 2) rig.celebrate(); }
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
      run.style.width = `${pos.from.w}px`;
      run.style.transform = `translate(${x}px, ${y}px)`;
      $('run-note').textContent = step < 2 ? 'Claude · starting' : step === 2 ? 'Claude · running' : 'Claude · finished';
      $('handover').hidden = step < 3;
    };
    const rawP = () => { const r = story.getBoundingClientRect(); return PX.clamp(-r.top / Math.max(1, r.height - innerHeight)); };
    const sp = PX.spring(0, { response: 0.32, damping: 0.92, precision: 0.0002, onUpdate: render });
    const onScroll = () => sp.to(rawP());
    if (PX.reduce) {
      whenNear(story, async () => { measure(); rig = await mount($('story-rig'), LOOKS[3]); steps.forEach((li) => li.classList.add('on')); $('handover').hidden = false; });
    } else {
      whenNear(story, async () => { measure(); rig = await mount($('story-rig'), LOOKS[0]); last = -1; sp.jump(rawP()); });
      addEventListener('scroll', onScroll, { passive: true });
      addEventListener('resize', () => { measure(); sp.jump(rawP()); });
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
  // the networks form as you scroll to them: edges draw, nodes pop on a spring
  for (const id of ['mesh', 'hub']) {
    const svg = $(id);
    if (!svg) continue;
    const edges = [...svg.querySelectorAll('.edge')];
    const nodes = [...svg.querySelectorAll('.node')];
    const paint = (p) => {
      edges.forEach((e, i) => e.style.setProperty('--off', String(1 - PX.clamp((p - 0.12 - i * 0.07) / 0.4))));
      nodes.forEach((n, i) => { const t = PX.clamp((p - i * 0.06) / 0.3); const sc = 0.7 + 0.3 * t; n.style.transform = `scale(${sc})`; n.style.opacity = String(Math.min(1, t * 1.6)); });
      if (p > 0.7) svg.setAttribute('data-live', ''); else svg.removeAttribute('data-live');
    };
    const sp = PX.spring(0, { response: 0.5, damping: 0.78, precision: 0.0005, onUpdate: paint });
    const target = () => { const r = svg.getBoundingClientRect(); return PX.clamp((innerHeight - r.top) / (innerHeight * 0.75 + r.height * 0.3)); };
    if (PX.reduce) { paint(1); continue; }
    paint(0);
    addEventListener('scroll', () => sp.to(target()), { passive: true });
    sp.jump(target());
  }

  // sample usage chart: drawn from numbers here, labelled as a sample on the page
  const bars = $('bars');
  if (bars) {
    const DAYS = [[6, 3, 1], [9, 5, 2], [12, 6, 2], [8, 7, 3], [22, 14, 5], [10, 5, 2], [4, 2, 1]];
    const COL = ['#3987e5', '#d95926', '#199e70'];
    const NS = 'http://www.w3.org/2000/svg';
    DAYS.forEach((d, i) => {
      let y = 200;
      const x = 52 + i * 70;
      d.forEach((v, k) => {
        const h = v * 3;
        y -= h;
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 46); r.setAttribute('height', h);
        r.setAttribute('rx', k === d.length - 1 ? 4 : 0); r.setAttribute('fill', COL[k]); r.setAttribute('stroke', '#1c1a1f'); r.setAttribute('stroke-width', 2); r.setAttribute('paint-order', 'stroke');
        r.setAttribute('class', 'bar'); r.style.setProperty('--d', `${i * 70 + k * 40}ms`);
        bars.append(r);
      });
    });
    live($('usage-chart'), () => $('usage-chart').removeAttribute('data-pre'));
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
