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
    new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; sync(); }, { rootMargin: '80px' }).observe(node);
    document.addEventListener('visibilitychange', sync);
  }
  async function mount(node, look, opts) {
    const mountRig = await loadRig();
    const rig = mountRig(node, { ambient: true, ...opts });
    rig.setLook({ lamp: 'off', eyes: 'default', pose: 'none', ...look });
    rig.blinks(true);
    tend(node, rig);
    return rig;
  }

  // ── hero: the character doing its job on a loop ────────────────────────
  const desk = $('desk');
  const AGENTS = [{ name: 'explore', status: 'working' }, { name: 'tests', status: 'working' }, { name: 'review', status: 'working' }];
  const SCRIPT = [
    { at: 0, look: { lamp: 'off', pose: 'none', eyes: 'default', minions: [] }, lamp: 'off', state: 'Idle', detail: 'No agents running' },
    { at: 1400, look: { lamp: 'green', pose: 'think', minions: AGENTS.slice(0, 1) }, lamp: 'green', state: 'Working', detail: '1 agent' },
    { at: 2400, look: { minions: AGENTS.slice(0, 2) }, detail: '2 agents' },
    { at: 3400, look: { minions: AGENTS }, detail: '3 agents' },
    { at: 6200, look: { minions: [AGENTS[0], { ...AGENTS[1], status: 'done' }, AGENTS[2]] }, detail: '2 agents, 1 done' },
    { at: 7400, look: { lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: AGENTS.map((a) => ({ ...a, status: 'done' })) }, lamp: 'amber', state: 'Your turn', detail: 'Everything finished', celebrate: true },
    { at: 10600, look: { lamp: 'red', pose: 'banner', eyes: 'surprised', text: 'APPROVE?', minions: [] }, lamp: 'red', state: 'Needs you', detail: 'Permission to run a command' },
    { at: 13800, look: { lamp: 'off', pose: 'none', eyes: 'default', text: '' }, lamp: 'off', state: 'Idle', detail: 'No agents running' },
  ];
  const LOOP = 15200;
  function heroCaption(step) {
    if (step.lamp) { desk.dataset.lamp = step.lamp; $('desk-state').textContent = step.state; }
    if (step.detail) $('desk-detail').textContent = step.detail;
  }
  async function hero() {
    const rig = await mount($('hero-rig'), {});
    if (reduce) { // one finished, still frame
      const last = SCRIPT[5];
      rig.setLook({ ...last.look, minions: [] });
      heroCaption(last);
      return;
    }
    let timers = [];
    let running = false;
    const play = () => {
      timers.forEach(clearTimeout);
      timers = SCRIPT.map((s) => setTimeout(() => { rig.setLook({ ...(rig.look || {}), ...s.look }); heroCaption(s); if (s.celebrate) rig.celebrate(); }, s.at));
      timers.push(setTimeout(play, LOOP));
    };
    const io = new IntersectionObserver((es) => {
      const on = es[es.length - 1].isIntersecting && !document.hidden;
      if (on && !running) { running = true; play(); } else if (!on && running) { running = false; timers.forEach(clearTimeout); }
    });
    io.observe(desk);
    document.addEventListener('visibilitychange', () => { if (document.hidden && running) { running = false; timers.forEach(clearTimeout); } else if (!document.hidden && !running) { running = true; play(); } });
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
    const give = $('give');
    const cols = [...$('cols').querySelectorAll('.col')];
    let rig = null;
    let last = -1;
    let ticking = false;
    const at = (el) => { const a = el.getBoundingClientRect(); const b = stage.getBoundingClientRect(); return { x: a.left - b.left, y: a.top - b.top, w: a.width }; };
    const LOOKS = [
      { lamp: 'off', pose: 'none', eyes: 'default', minions: [] },
      { lamp: 'off', pose: 'none', eyes: 'default', minions: [] },
      { lamp: 'green', pose: 'think', eyes: 'default', minions: [{ name: 'claude', status: 'working' }] },
      { lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: [{ name: 'claude', status: 'done' }] },
    ];
    const draw = () => {
      ticking = false;
      const r = story.getBoundingClientRect();
      const p = clamp(-r.top / Math.max(1, r.height - innerHeight));
      const step = p < 0.22 ? 0 : p < 0.5 ? 1 : p < 0.78 ? 2 : 3;
      if (step !== last) {
        steps.forEach((li, i) => li.classList.toggle('on', i === step));
        $('stage-lamp').textContent = ['idle', 'queued', 'working', 'your turn'][step];
        if (rig) { rig.setLook({ ...(rig.look || {}), ...LOOKS[step] }); if (step === 3 && last === 2) rig.celebrate(); }
        last = step;
      }
      // "Give to Claude" presses in step 0
      const press = step === 0 ? Math.sin(clamp(p / 0.22) * Math.PI) : 0;
      give.style.transform = `scale(${1 - 0.1 * press})`;
      // the card rides from To do, to Doing, to Done
      const from = at(origin);
      const doing = cols[1];
      const done = cols[2];
      // land below whatever card the column already holds
      const below = (colEl) => { const c = colEl.querySelector('.card:not([data-card])') || colEl.querySelector('.card'); const r = c ? at(c) : null; const base = at(colEl); return { x: base.x + 10, y: r ? r.y + c.getBoundingClientRect().height + 8 : base.y + 36 }; };
      const target = (colEl) => below(colEl);
      const a = clamp((p - 0.22) / 0.26);
      const b = clamp((p - 0.78) / 0.22);
      const s = target(doing);
      const d = target(done);
      const x = from.x + (s.x - from.x) * a + (d.x - s.x) * b;
      const y = from.y + (s.y - from.y) * a + (d.y - s.y) * b;
      run.hidden = p < 0.22;
      origin.style.visibility = p < 0.22 ? 'visible' : 'hidden';
      run.style.width = `${from.w}px`;
      run.style.transform = `translate(${x}px, ${y}px)`;
      $('run-note').textContent = step < 2 ? 'Claude · starting' : step === 2 ? 'Claude · running' : 'Claude · finished';
      $('handover').hidden = step < 3;
    };
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(draw); } };
    if (reduce) {
      // no pinning: show the finished state
      whenNear(story, async () => { rig = await mount($('story-rig'), LOOKS[3]); steps.forEach((li) => li.classList.add('on')); $('handover').hidden = false; });
    } else {
      whenNear(story, async () => { rig = await mount($('story-rig'), LOOKS[0]); last = -1; draw(); });
      addEventListener('scroll', onScroll, { passive: true });
      addEventListener('resize', onScroll);
      draw();
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
    whenNear($('lamp-desk'), async () => {
      const rig = await mount($('lamp-rig'), LOOK.green);
      lampList.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-look]');
        if (!b) return;
        for (const x of lampList.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
        $('lamp-desk').dataset.lamp = b.dataset.look;
        rig.setLook({ ...(rig.look || {}), ...LOOK[b.dataset.look] });
        if (b.dataset.look === 'amber') rig.celebrate();
      });
    });
  }

  // ── reveals that mean something: cards arriving, bars growing, lines drawn
  const live = (node, fn) => { if (!node) return; if (reduce) { fn(); return; } const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { threshold: 0.35 }); io.observe(node); };
  live($('board'), () => $('board').removeAttribute('data-pre'));
  for (const id of ['mesh', 'hub']) live($(id), () => $(id).setAttribute('data-live', ''));

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
  whenNear($('agents-desk'), () => mount($('agents-rig'), { lamp: 'green', pose: 'think', minions: [{ name: 'claude', status: 'working' }, { name: 'codex', status: 'working' }, { name: 'cursor', status: 'waiting' }, { name: 'gemini', status: 'done' }] }));

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
    whenNear(gallery, async () => {
      for (const c of cells) {
        const rig = await mount(c.slot, { lamp: 'green', body: c.body });
        c.b.addEventListener('click', () => {
          const pose = POSES[n++ % POSES.length];
          rig.react({ pose, eyes: pose === 'party' || pose === 'cheer' ? 'star' : 'happy' }, 1800);
          rig.celebrate();
        });
      }
    });
  }
})();
