  const R = window.TrafficLightRules;
  const $ = (id) => document.getElementById(id);
  const pageQuery = new URLSearchParams(location.search);
  const embeddedView = pageQuery.get('embedded') === '1' && ['stats', 'mix'].includes(pageQuery.get('view')) ? pageQuery.get('view') : null;
  const widgetOnly = pageQuery.get('utility') === 'widget';
  document.body.classList.toggle('embedded-analytics', !!embeddedView);
  document.body.classList.toggle('widget-configuration', widgetOnly);
  if (embeddedView) {
    document.title = embeddedView === 'mix' ? 'Usage' : 'Stats';
    document.querySelector('#titlebar h1').textContent = document.title;
  } else if (widgetOnly) {
    document.title = 'Widget configuration';
    document.querySelector('#titlebar h1').textContent = document.title;
  }

  const ICON = {
    lock: '<svg class="lock" viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>',
    costume: '<svg viewBox="0 0 16 16"><path d="M3 13h10l-1-6H4zM5 7l3-4 3 4"/></svg>',
    cameo: '<svg viewBox="0 0 16 16"><path d="M4 7c0-3 1.8-5 4-5s4 2 4 5M3 7h10M4.5 9.5h3v2h-3zM8.5 9.5h3v2h-3zM7.5 10.5h1M5 14c1.5 1 4.5 1 6 0"/></svg>',
    body: '<svg viewBox="0 0 16 16"><circle cx="8" cy="5" r="2.5"/><path d="M3 14c0-3 2-5 5-5s5 2 5 5"/></svg>',
    effect: '<svg viewBox="0 0 16 16"><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2"/></svg>',
    pet: '<svg viewBox="0 0 16 16"><path d="M4 12a4 4 0 0 1 8 0zM5 8l-1-4 3 2M11 8l1-4-3 2"/></svg>',
    sound: '<svg viewBox="0 0 16 16"><path d="M3 6h3l4-3v10l-4-3H3zM12 6a3 3 0 0 1 0 4"/></svg>',
    grip: '<svg viewBox="0 0 10 14"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11" r="1.2"/><circle cx="7" cy="11" r="1.2"/></svg>',
    pose: {
      think: '<svg viewBox="0 0 16 16"><circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12" cy="8" r="1"/></svg>',
      wave: '<svg viewBox="0 0 16 16"><path d="M3 12l3-7 3 4 4-6"/></svg>',
      thumbs: '<svg viewBox="0 0 16 16"><path d="M3 8h2v5H3zM5 8l3-5c1 0 1.5.7 1.3 1.6L9 7h3.5c.8 0 1.3.7 1.1 1.4l-1 4c-.2.4-.6.6-1 .6H5"/></svg>',
      sleep: '<svg viewBox="0 0 16 16"><path d="M3 11h4l-4 3h4M9 5h4l-4 4h4"/></svg>',
      blink: '<svg viewBox="0 0 16 16"><path d="M2 8c2-3 10-3 12 0M5 9.5v1.5M8 10v2M11 9.5v1.5"/></svg>',
      nod: '<svg viewBox="0 0 16 16"><path d="M8 3v8M5 8l3 3 3-3"/></svg>',
      bounce: '<svg viewBox="0 0 16 16"><path d="M3 12c1-6 3-8 5-8s4 2 5 8M4 13h8"/></svg>',
      look: '<svg viewBox="0 0 16 16"><path d="M2 8c2-3 10-3 12 0-2 3-10 3-12 0z"/><circle cx="10" cy="8" r="1.4"/></svg>',
      spin: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.5M12 2v3h-3"/></svg>',
      party: '<svg viewBox="0 0 16 16"><path d="M4 13l3-8 5 5zM11 3l1 1M13 7l1-1M9 2v1"/></svg>',
      guitar: '<svg viewBox="0 0 16 16"><path d="M9 3l4 4M5.5 8.5l3-3M3 13a3 3 0 1 1 4-4"/></svg>',
      ak47: '<svg viewBox="0 0 16 16"><path d="M2 9h9l3-2M5 9v3M8 9v2"/></svg>',
      sniper: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"/><path d="M8 2v3M8 11v3M2 8h3M11 8h3"/></svg>',
      banner: '<svg viewBox="0 0 16 16"><path d="M3 3h10v7H8l-2 2v-2H3z"/></svg>',
    },
  };
  // tokens.css's Lamps block, as hex for the swatches and the colour input.
  const LAMP_COLORS = { red: '#f44b2f', amber: '#fbb62b', green: '#2db396' };
  // Stand-in agents so the Agents picker and stage show the chosen chips.
  const SAMPLE_MINIONS = [{ name: 'agent-1', status: 'working' }, { name: 'agent-2', status: 'waiting' }, { name: 'agent-3', status: 'done' }];

  // ── State ──────────────────────────────────────────────────────────────
  let config = null;      // saved
  let rules = [];         // working copy
  let selectedId = null;
  let previewMode = 'rule';
  let live = null;
  let dirty = false;

  // The stage plays at full rate while you're working in the editor; left
  // open behind other windows it drops to the widget's own ambient clock
  // (a full-rate stage alone cost ~35% of a core).
  const stage = mountRig($('stage-rig'), { ambient: true });
  window.lightsApi.onWindowFocus((focused) => stage.setAmbient(!focused));
  let motionPaused = false;
  let stageConfetti = null;
  // ── Stage gun demo: tracers / a scoped shot drawn over the stage, aimed at
  // a target on the stage's right, so the preview shows the real effect.
  const fx = (() => {
    const canvas = $('stage-fx');
    const ctx = canvas.getContext('2d');
    const bullets = [], sparks = [], shots = [], holes = [];
    let firingUntil = 0, lastShot = 0, raf = null, scope = null;
    function size() { const r = canvas.getBoundingClientRect(); canvas.width = r.width * devicePixelRatio; canvas.height = r.height * devicePixelRatio; ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); return r; }
    function muzzle(len) {
      const sr = stage.svg.getBoundingClientRect(); const cr = canvas.getBoundingClientRect();
      const sx = sr.width / 64, sy = sr.height / 82;
      return { x: sr.left - cr.left + (44 + len) * sx, y: sr.top - cr.top + 50 * sy };
    }
    function target() { const r = canvas.getBoundingClientRect(); return { x: r.width * 0.62, y: r.height * 0.42 }; }
    function kick() { if (!raf) raf = requestAnimationFrame(loop); }
    function loop(t) {
      const r = size();
      const busy = t < firingUntil || bullets.length || sparks.length || shots.length || holes.length || (scope && t < scope.until);
      raf = busy ? requestAnimationFrame(loop) : null;
      ctx.clearRect(0, 0, r.width, r.height);
      if (t < firingUntil && t - lastShot > 90) {
        lastShot = t; const m = muzzle(23);
        const sp = (Math.random() - 0.5) * 0.1;
        bullets.push({ x: m.x, y: m.y, vx: Math.cos(sp) * 14, vy: Math.sin(sp) * 14 });
        for (let i = 0; i < 3; i += 1) sparks.push({ x: m.x, y: m.y, vx: 2 + Math.random() * 3, vy: (Math.random() - 0.5) * 3, life: 1 });
      }
      for (let i = bullets.length - 1; i >= 0; i -= 1) {
        const b = bullets[i]; b.x += b.vx; b.y += b.vy;
        if (b.x > r.width + 20) { bullets.splice(i, 1); continue; }
        const n = Math.hypot(b.vx, b.vy) || 1, tx = b.x - (b.vx / n) * 28, ty = b.y - (b.vy / n) * 28;
        const g = ctx.createLinearGradient(tx, ty, b.x, b.y); g.addColorStop(0, 'rgba(255,180,60,0)'); g.addColorStop(1, 'rgba(255,230,150,0.9)');
        ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      for (let i = sparks.length - 1; i >= 0; i -= 1) {
        const p = sparks[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.2; p.life -= 0.07;
        if (p.life <= 0) { sparks.splice(i, 1); continue; }
        ctx.fillStyle = `rgba(255,200,90,${p.life})`; ctx.fillRect(p.x, p.y, 1.5, 1.5);
      }
      if (scope && t < scope.until) {
        const p = 1 - (scope.until - t) / 700, rr = 18 - 9 * p, c = target();
        ctx.strokeStyle = `rgba(255,60,48,${0.35 + 0.6 * p})`; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(c.x, c.y, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(c.x + dx * (rr + 4), c.y + dy * (rr + 4)); ctx.lineTo(c.x + dx * (rr - 5), c.y + dy * (rr - 5)); } ctx.stroke();
      }
      for (let i = shots.length - 1; i >= 0; i -= 1) {
        const sh = shots[i], age = t - sh.t0; if (age > 320) { shots.splice(i, 1); continue; }
        const a = 1 - age / 320;
        ctx.strokeStyle = `rgba(255,245,214,${a})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sh.mx, sh.my); ctx.lineTo(sh.tx, sh.ty); ctx.stroke();
        ctx.strokeStyle = `rgba(255,170,60,${a * 0.5})`; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(sh.mx, sh.my); ctx.lineTo(sh.tx, sh.ty); ctx.stroke();
      }
      for (let i = holes.length - 1; i >= 0; i -= 1) {
        const h = holes[i], age = t - h.t0; if (age > 2500) { holes.splice(i, 1); continue; }
        const a = age < 2000 ? 1 : 1 - (age - 2000) / 500;
        ctx.fillStyle = `rgba(20,20,24,${0.85 * a})`; ctx.beginPath(); ctx.arc(h.x, h.y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = `rgba(230,236,245,${0.75 * a})`; ctx.lineWidth = 1; ctx.beginPath();
        for (let k = 0; k < 7; k += 1) { const ang = (k / 7) * Math.PI * 2 + 0.4 * Math.sin(k * 3.1), len = 7 + ((k * 37) % 9); ctx.moveTo(h.x + Math.cos(ang) * 3, h.y + Math.sin(ang) * 3); ctx.lineTo(h.x + Math.cos(ang) * len, h.y + Math.sin(ang) * len); }
        ctx.stroke();
      }
    }
    return {
      burst(ms) { firingUntil = performance.now() + ms; lastShot = 0; kick(); },
      snipe() { scope = { until: performance.now() + 700 }; kick(); setTimeout(() => { const m = muzzle(39), c = target(); shots.push({ mx: m.x, my: m.y, tx: c.x, ty: c.y, t0: performance.now() }); holes.push({ x: c.x, y: c.y, t0: performance.now() }); stage.burst(250); kick(); }, 700); },
      clear() { firingUntil = 0; scope = null; bullets.length = sparks.length = shots.length = holes.length = 0; kick(); },
    };
  })();

  let stageBurst = null;
  function stageFire(pose) {
    clearInterval(stageBurst);
    stageBurst = null;
    fx.clear();
    if (pose === 'ak47') {
      const go = () => { stage.burst(1200); fx.burst(1200); };
      go(); stageBurst = setInterval(() => { if (!motionPaused) go(); }, 15000);
    } else if (pose === 'sniper') {
      fx.snipe(); stageBurst = setInterval(() => { if (!motionPaused) fx.snipe(); }, 7000);
    }
  }
  function stageCelebrate(on) {
    clearInterval(stageConfetti);
    stageConfetti = null;
    if (!on) return;
    stage.celebrate();
    stageConfetti = setInterval(() => { if (!motionPaused) stage.celebrate(); }, 10000);
  }

  function selected() { return rules.find((r) => r.id === selectedId) || null; }
  // The template the rules came from (saved with them, so later migrations keep
  // them in its shape), and the settings it implies, staged until Save.
  let templateId = null;
  let stagedPrefs = null;
  let applying = false;
  function setDirty(v) {
    dirty = v;
    if (v && !applying) templateId = null;
    $('save-state').innerHTML = v ? '<span class="unsaved">Unsaved changes</span>' : '';
    $('save-btn').disabled = !v;
    $('revert-btn').disabled = !v;
  }

  // ── Rules list ─────────────────────────────────────────────────────────
  function renderList() {
    const ul = $('rule-list');
    ul.innerHTML = '';
    $('rule-count').textContent = rules.length ? `${rules.filter((r) => r.enabled).length} of ${rules.length} on` : '';
    if (!rules.length) {
      ul.innerHTML = '<li class="empty">No rules yet. The widget will stay dark until you add one — or pick a preset from the top right.</li>';
      return;
    }
    for (const r of rules) {
      const li = document.createElement('li');
      li.className = 'rule' + (r.id === selectedId ? ' selected' : '') + (r.locked ? ' locked' : '') + (r.enabled ? '' : ' off');
      li.dataset.id = r.id;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', r.id === selectedId);
      li.tabIndex = 0;
      li.draggable = !r.locked;
      const t = r.then;
      const lampC = t.lamp && t.lamp !== 'off' ? (t.lampColor || LAMP_COLORS[t.lamp]) : null;
      const eyeC = t.eyes && t.eyes !== 'closed' && t.eyes !== 'default' ? t.eyes : null;
      li.innerHTML = `
        <span class="grip" title="Drag to change priority">${ICON.grip}</span>
        <input type="checkbox" ${r.enabled ? 'checked' : ''} ${r.locked ? 'disabled' : ''} aria-label="Enabled" />
        <span class="name">${r.locked ? ICON.lock : ''}<span>${escape(r.name)}</span></span>
        <span class="chips">
          ${t.lamp ? `<span class="chip" style="--chip:${lampC || '#3a3542'}" title="Lamp"></span>` : ''}
          ${eyeC ? `<span class="chip eye" style="--chip:${eyeC}" title="Eyes"></span>` : t.eyes === 'closed' ? '<span class="chip eye" style="--chip:#211f1c" title="Eyes closed"></span>' : ''}
          ${t.pose && t.pose !== 'none' ? `<span class="chip pose pose-chip" title="${t.pose}">${ICON.pose[t.pose] || ICON.pose.think}</span>` : ''}
          ${t.costume && t.costume !== 'none' ? `<span class="chip pose" title="${t.costume}">${ICON.costume}</span>` : ''}
          ${t.cameo && t.cameo !== 'none' ? `<span class="chip pose" title="cameo: ${t.cameo}">${ICON.cameo}</span>` : ''}
          ${t.effect && t.effect !== 'none' ? `<span class="chip pose" title="effect: ${t.effect}">${ICON.effect}</span>` : ''}
          ${t.pet && t.pet !== 'none' ? `<span class="chip pose" title="pet: ${t.pet}">${ICON.pet}</span>` : ''}
          ${t.sound ? `<span class="chip pose" title="sound: ${escape(t.sound.replace(/^file:/, ''))}">${ICON.sound}</span>` : ''}
        </span>`;
      li.querySelector('input').addEventListener('change', (e) => {
        r.enabled = e.target.checked;
        setDirty(true);
        renderList();
        if (r.id === selectedId) renderEditor();
      });
      li.querySelector('input').addEventListener('click', (e) => e.stopPropagation());
      li.addEventListener('click', () => select(r.id));
      li.addEventListener('keydown', (e) => {
        const i = rules.indexOf(r);
        if (!e.altKey && e.key === 'ArrowDown' && rules[i + 1]) { e.preventDefault(); select(rules[i + 1].id); focusRow(rules[i + 1].id); }
        if (!e.altKey && e.key === 'ArrowUp' && rules[i - 1]) { e.preventDefault(); select(rules[i - 1].id); focusRow(rules[i - 1].id); }
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !r.locked) {
          e.preventDefault();
          move(r.id, i + (e.key === 'ArrowUp' ? -1 : 1));
          focusRow(r.id);
        }
        if ((e.key === 'Backspace' || e.key === 'Delete') && !r.locked) { e.preventDefault(); remove(r.id); }
      });
      li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', r.id); li.classList.add('dragging'); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        const rect = li.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        li.classList.toggle('drop-before', before);
        li.classList.toggle('drop-after', !before);
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const before = li.classList.contains('drop-before');
        li.classList.remove('drop-before', 'drop-after');
        const fromId = e.dataTransfer.getData('text/plain');
        if (!fromId || fromId === r.id) return;
        const from = rules.findIndex((x) => x.id === fromId);
        let to = rules.indexOf(r) + (before ? 0 : 1);
        if (from < to) to -= 1;
        move(fromId, to);
      });
      ul.appendChild(li);
    }
  }
  function focusRow(id) { document.querySelector(`.rule[data-id="${id}"]`)?.focus(); }
  function escape(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function move(id, to) {
    const from = rules.findIndex((r) => r.id === id);
    if (from < 0) return;
    const firstUnlocked = rules.findIndex((r) => !r.locked);
    to = Math.max(firstUnlocked < 0 ? 0 : firstUnlocked, Math.min(rules.length - 1, to));
    if (to === from) return;
    const [r] = rules.splice(from, 1);
    rules.splice(to, 0, r);
    setDirty(true);
    renderList();
  }

  function select(id) {
    selectedId = id;
    previewMode = 'rule';
    renderList();
    renderEditor();
    renderStage();
    renderNow();
  }

  // ── Now strip ──────────────────────────────────────────────────────────
  // Which rule the lamp belongs to, and which rule owns each accent channel,
  // so a look that mixes several rules can be traced back to them.
  const NOW_CHANNELS = [['lamp', ['lamp']], ['eyes', ['eyes']], ['pose', ['pose']], ['costume', ['costume']], ['cameo', ['cameo']], ['effect', ['effect']], ['pet', ['pet']], ['agents', ['agents', 'agentsColor']], ['sign/number', ['numberOf', 'sign']]];
  function renderNow() {
    const box = $('now');
    const head = box.querySelector('.head');
    const owners = box.querySelector('.owners');
    owners.innerHTML = '';
    if (!live) { head.textContent = 'Now: …'; return; }
    const ruleName = (id) => (rules.find((x) => x.id === id) || config?.rules?.find((x) => x.id === id))?.name || id;
    const n = live.sessions.length;
    if (!n && live.reason !== 'manual' && live.reason !== 'preview') { head.innerHTML = '<span class="who">Now:&nbsp;<b>Nothing running</b></span>'; return; }
    const owned = live.owned || {};
    const name = owned.lamp ? ruleName(owned.lamp) : (live.firedNames?.[0] || live.look.name || '—');
    const agents = live.agentCount || 0;
    head.innerHTML = `<span class="who">Now:&nbsp;<b>${escape(name)}</b></span>${live.tool ? `<span class="tool">&nbsp;· ${escape(live.tool)}</span>` : ''}<span class="count">&nbsp;· ${n} session${n === 1 ? '' : 's'} · ${agents} agent${agents === 1 ? '' : 's'}</span>`;
    head.title = head.textContent;
    const groups = new Map();
    for (const [label, keys] of NOW_CHANNELS) {
      const id = keys.map((k) => owned[k]).find(Boolean);
      if (!id) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(label);
    }
    for (const [id, labels] of groups) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'own' + (id === selectedId ? ' on' : '');
      b.innerHTML = `<i>${labels.join(' · ')}</i> — ${escape(ruleName(id))}`;
      b.title = `${labels.join(', ')} come${labels.length === 1 ? 's' : ''} from “${ruleName(id)}” — click to edit it`;
      if (rules.some((x) => x.id === id)) b.addEventListener('click', () => { select(id); focusRow(id); });
      else b.disabled = true;
      owners.appendChild(b);
    }
  }

  function remove(id) {
    const i = rules.findIndex((r) => r.id === id);
    if (i < 0 || rules[i].locked) return;
    rules.splice(i, 1);
    if (selectedId === id) selectedId = rules[Math.min(i, rules.length - 1)]?.id || null;
    setDirty(true);
    renderList();
    renderEditor();
    renderStage();
  }

  // ── Editor ─────────────────────────────────────────────────────────────
  // The one character is saved straight away, not with the rule edits.
  async function setCharacter(next) {
    try { config = await window.lightsApi.saveConfig({ character: R.normalizeCharacter(next) }); } catch (err) { flash(`Save failed: ${err.message}`); return; }
    renderEditor(); renderStage();
  }
  function renderEditor() {
    const r = selected();
    const ed = $('editor');
    ed.classList.toggle('disabled', !r);
    if (!r) return;
    $('name').value = r.name;
    $('enabled').checked = r.enabled;
    $('enabled').disabled = r.locked;
    $('delete-btn').disabled = r.locked;
    $('delete-btn').title = r.locked ? 'Built-in safety rule — can be edited, not removed' : '';

    const sig = $('signals');
    sig.innerHTML = '';
    for (const s of R.SIGNALS) {
      const b = document.createElement('button');
      b.className = 'signal ' + s.kind + (r.when.signal.includes(s.id) ? ' on' : '');
      b.innerHTML = `<span class="k"></span>${s.label}`;
      b.title = s.hook ? `Claude Code hook: ${s.hook}` : s.kind === 'git' ? 'From GitHub, via your gh login (Preferences → Git and CI)' : 'When no session file is live';
      b.addEventListener('click', () => {
        const i = r.when.signal.indexOf(s.id);
        if (i >= 0) r.when.signal.splice(i, 1); else r.when.signal.push(s.id);
        touch();
      });
      sig.appendChild(b);
    }
    const toolSignals = r.when.signal.some((id) => R.SIGNALS.find((s) => s.id === id)?.tool);
    $('tool-row').hidden = !toolSignals;
    $('tool').value = r.when.tool || '';

    const lamps = $('lamps');
    lamps.innerHTML = '';
    for (const l of [null, 'off', 'red', 'amber', 'green']) {
      const b = document.createElement('button');
      b.className = 'lampbtn ' + (l === null ? 'keep' : l) + (r.then.lamp === l ? ' on' : '');
      b.title = l === null ? 'Leave to other rules' : l === 'off' ? 'All lamps off' : l;
      b.style.setProperty('--c', LAMP_COLORS[l] || '');
      b.innerHTML = '<i></i>';
      b.addEventListener('click', () => { r.then.lamp = l; if (l === null || l === 'off') r.then.lampColor = null; touch(); });
      lamps.appendChild(b);
    }
    const lampSw = $('lamp-color-swatch');
    lampSw.classList.toggle('has', !!r.then.lampColor);
    lampSw.classList.toggle('on', !!r.then.lampColor);
    lampSw.style.setProperty('--c', r.then.lampColor || '');
    $('lamp-color').value = r.then.lampColor || (LAMP_COLORS[r.then.lamp] || '#38bdf8');

    const eyes = $('eyes');
    eyes.innerHTML = '';
    for (const [v, label, c] of [[null, 'Leave to other rules', null], ['default', 'Normal', '#211f1c'], ['closed', 'Closed', null]]) {
      const b = document.createElement('button');
      b.className = 'lampbtn ' + (v === null ? 'keep' : v === 'closed' ? 'closed' : '') + (r.then.eyes === v ? ' on' : '');
      b.title = label;
      b.style.setProperty('--c', c || '#211f1c');
      b.innerHTML = v === 'closed' ? '<i style="height:3px;border-radius:2px;background:#ece8e2"></i>' : '<i></i>';
      b.addEventListener('click', () => { r.then.eyes = v; touch(); });
      eyes.appendChild(b);
    }
    const eyeCustom = /^#/.test(r.then.eyes || '');
    const eyeSw = $('eye-color-swatch');
    eyeSw.classList.toggle('has', eyeCustom);
    eyeSw.classList.toggle('on', eyeCustom);
    eyeSw.style.setProperty('--c', eyeCustom ? r.then.eyes : '');
    $('eye-color').value = eyeCustom ? r.then.eyes : '#8b5cf6';

    const poses = $('poses');
    poses.innerHTML = '';
    for (const p of [null, ...R.POSES]) {
      const b = document.createElement('button');
      b.className = 'posebtn' + (r.then.pose === p ? ' on' : '');
      b.title = p === null ? 'Leave to other rules' : p;
      const mini = document.createElement('div');
      mini.className = 'mini';
      b.appendChild(mini);
      const lbl = document.createElement('span');
      lbl.textContent = p === null ? 'keep' : p;
      b.appendChild(lbl);
      const m = mountRig(mini);
      m.setLook({ lamp: 'off', eyes: p === 'sleep' ? 'closed' : 'default', pose: p || 'none', text: 'HEY' });
      if (p === null) mini.style.opacity = '0.35';
      b.addEventListener('click', () => { r.then.pose = p; touch(); });
      poses.appendChild(b);
    }

    // Mini-rig pickers for every sprite channel: keep (null) + each option.
    // opts.label(o) overrides the caption; opts.extra(o) returns a control to
    // pin on the tile's corner (the cameo row's "remove photo").
    const picker = (container, options, current, lookFor, onPick, opts = {}) => {
      container.innerHTML = '';
      for (const o of (opts.noKeep ? options : [null, ...options])) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'posebtn' + (current === o ? ' on' : '');
        b.title = o === null ? 'Leave to other rules' : o;
        const mini = document.createElement('div');
        mini.className = 'mini';
        b.appendChild(mini);
        const lbl = document.createElement('span');
        lbl.textContent = o === null ? 'keep' : (opts.label && opts.label(o)) || ({ h3: '3 lamps', v3: 'vertical', h1: '1 lamp', h5: '5 lamps' })[o] || o;
        b.appendChild(lbl);
        mountRig(mini).setLook({ lamp: 'off', eyes: 'default', pose: 'none', ...lookFor(o) });
        if (o === null) mini.style.opacity = '0.35';
        b.addEventListener('click', () => { onPick(o); if (!opts.noKeep) touch(); });
        const extra = o !== null && opts.extra && opts.extra(o);
        if (extra) {
          const cell = document.createElement('span');
          cell.className = 'posecell';
          cell.append(b, extra);
          container.appendChild(cell);
        } else container.appendChild(b);
      }
    };
    picker($('lampfx'), R.LAMP_FX, r.then.lampFx, (o) => ({ lamp: r.then.lamp && r.then.lamp !== 'off' ? r.then.lamp : 'green', lampColor: r.then.lampColor, lampFx: o || 'none' }), (o) => { r.then.lampFx = o; });
    const litLamp = r.then.lamp && r.then.lamp !== 'off' ? r.then.lamp : 'green';
    picker($('signs'), R.SIGNS, r.then.sign, (o) => ({ lamp: litLamp, sign: o || 'h3', lampShape: r.then.lampShape || 'square' }), (o) => { r.then.sign = o; });
    picker($('shapes'), R.LAMP_SHAPES, r.then.lampShape, (o) => ({ lamp: litLamp, lampShape: o || 'square', sign: r.then.sign || 'h3' }), (o) => { r.then.lampShape = o; });
    picker($('signfx'), R.SIGN_FX, r.then.signFx, (o) => ({ lamp: litLamp, signFx: o || 'none' }), (o) => { r.then.signFx = o; });
    $('number').innerHTML = [['', 'Keep'], ['none', 'No number (lamps)'], ['sessions', 'Sessions running'], ['minutes', 'Minutes waiting on you'], ['tasks', 'Tasks left'], ['agents', 'Agents running'], ['ralph', 'Ralph iteration']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('number').value = r.then.number || '';
    const sfx = $('screenfx');
    sfx.innerHTML = '';
    for (const [v, label] of [[null, 'keep'], ['none', 'none'], ['vignette', 'vignette'], ['confetti', 'confetti'], ['spotlight', 'spotlight']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'signal' + (r.then.screenFx === v ? ' on' : '');
      b.textContent = label;
      b.title = v === null ? 'Leave to other rules' : label;
      b.addEventListener('click', () => { r.then.screenFx = v; touch(); });
      sfx.appendChild(b);
    }
    picker($('costumes'), R.COSTUMES, r.then.costume, (o) => ({ costume: o || 'none' }), (o) => { r.then.costume = o; });
    const userFaces = cameoList.filter((c) => !c.builtin).map((c) => c.id);
    picker($('cameos'), [...R.CAMEOS, ...userFaces], r.then.cameo, (o) => ({ cameo: o || 'none', costume: r.then.costume || 'none' }), (o) => { r.then.cameo = o; }, {
      label: (o) => (userFaces.includes(o) ? cameoById(o).name : null),
      extra: (o) => (cameoById(o)?.user ? faceRemoveBtn(cameoById(o)) : null),
    });
    $('cameos').appendChild(faceAddBtn());
    const userBodies = window.BuddyCharacters.ids().filter((id) => id.startsWith('u-'));
    const character = R.normalizeCharacter(config.character);
    picker($('bodies'), [...R.BODIES, ...userBodies], character.body, (o) => ({ body: o, bodyColor: character.bodyColor }), (o) => { setCharacter({ ...character, body: o }); }, {
      noKeep: true,
      label: (o) => (userBodies.includes(o) ? window.BuddyCharacters.get(o).name : null),
      extra: (o) => (userBodies.includes(o) ? hatchRemoveBtn(o) : null),
    });
    $('bodies').appendChild(hatchAddBtn());
    picker($('effects'), R.EFFECTS, r.then.effect, (o) => ({ effect: o || 'none', waitMinutes: 20 }), (o) => { r.then.effect = o; });
    picker($('pets'), R.PETS, r.then.pet, (o) => ({ pet: o || 'none' }), (o) => { r.then.pet = o; });
    picker($('agents'), R.AGENT_STYLES, r.then.agents, (o) => ({ agents: o || 'robot', agentsColor: r.then.agentsColor, minions: SAMPLE_MINIONS }), (o) => { r.then.agents = o; });
    const agentsSw = $('agents-color-swatch');
    agentsSw.classList.toggle('has', !!r.then.agentsColor);
    agentsSw.classList.toggle('on', !!r.then.agentsColor);
    agentsSw.style.setProperty('--c', r.then.agentsColor || '');
    $('agents-color').value = r.then.agentsColor || '#2fae3e';
    // mood eyes ride in the eyes row (no keep button — the eye buttons have one)
    const moods = $('moods');
    moods.innerHTML = '';
    for (const m of R.EYE_MOODS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'posebtn' + (r.then.eyes === m ? ' on' : '');
      b.title = m;
      const mini = document.createElement('div');
      mini.className = 'mini';
      b.appendChild(mini);
      const lbl = document.createElement('span');
      lbl.textContent = m;
      b.appendChild(lbl);
      mountRig(mini).setLook({ lamp: 'off', eyes: m, pose: 'none' });
      b.addEventListener('click', () => { r.then.eyes = m; touch(); });
      moods.appendChild(b);
    }
    const bodySw = $('body-color-swatch');
    bodySw.classList.toggle('has', !!character.bodyColor);
    bodySw.classList.toggle('on', !!character.bodyColor);
    bodySw.style.setProperty('--c', character.bodyColor || '');
    $('body-color').value = character.bodyColor || '#da7756';
    $('cwd').value = r.when.cwd || '';
    $('source').value = r.when.source || '';

    // Programmable gestures: a select per gesture plus an argument field
    // for actions that take one. "Keep" leaves it to the rules below (and
    // finally the defaults: click jumps, double-click pets, ⌥-click feeds).
    for (const g of R.GESTURES) {
      const field = $(`${g}-field`);
      field.innerHTML = '';
      const cur = r.then.clicks[g] || null;
      const sel = document.createElement('select');
      sel.className = 'select';
      sel.setAttribute('aria-label', `${g} action`);
      sel.innerHTML = `<option value="">Keep (${R.ACTIONS.find((a) => a.id === R.DEFAULT_CLICKS[g].type).label.toLowerCase()})</option>` + R.ACTIONS.map((a) => `<option value="${a.id}">${escape(a.label)}</option>`).join('');
      sel.value = cur ? cur.type : '';
      const def = R.ACTIONS.find((a) => a.id === (cur && cur.type));
      const argInput = document.createElement('input');
      argInput.type = 'text';
      argInput.placeholder = def?.arg || '';
      argInput.value = cur?.arg || '';
      argInput.style.width = '210px';
      argInput.hidden = !def?.arg;
      argInput.setAttribute('aria-label', `${g} action argument`);
      sel.addEventListener('change', () => { r.then.clicks[g] = sel.value ? { type: sel.value, arg: argInput.value.trim() || null } : undefined; if (!sel.value) delete r.then.clicks[g]; touch(); });
      argInput.addEventListener('input', () => { if (r.then.clicks[g]) { r.then.clicks[g].arg = argInput.value.trim() || null; setDirty(true); } });
      field.appendChild(sel);
      field.appendChild(argInput);
    }

    const sel = $('sound');
    const soundOpts = [['', 'No sound'], ...R.SOUNDS.map((x) => [x, x === 'beep' ? 'System beep' : x])];
    if (r.then.sound && r.then.sound.startsWith('file:')) soundOpts.push([r.then.sound, R.folderOf(r.then.sound.slice(5))]);
    sel.innerHTML = soundOpts.map(([v, l]) => `<option value="${escape(v)}">${escape(l)}</option>`).join('');
    sel.value = r.then.sound || '';
    $('sound-play').disabled = !r.then.sound;
    $('celebrate').checked = !!r.then.celebrate;
    $('busy-ping').value = r.then.busyPing || '';
    $('text-row').hidden = !(r.then.pose === 'banner' || r.then.pose === 'bubble');
    $('text-row').querySelector('.lbl').textContent = r.then.pose === 'bubble' ? 'Bubble says' : 'Banner says';
    $('text').value = r.then.text || '';
  }

  function touch() {
    setDirty(true);
    renderList();
    renderEditor();
    renderStage();
  }

  $('name').addEventListener('input', (e) => { const r = selected(); if (!r) return; r.name = e.target.value; setDirty(true); renderList(); renderStage(); });
  $('enabled').addEventListener('change', (e) => { const r = selected(); if (!r) return; r.enabled = e.target.checked; touch(); });
  $('tool').addEventListener('input', (e) => { const r = selected(); if (!r) return; r.when.tool = e.target.value.trim() || null; setDirty(true); renderList(); });
  $('lamp-color').addEventListener('input', (e) => { const r = selected(); if (!r) return; if (!r.then.lamp || r.then.lamp === 'off') r.then.lamp = 'amber'; r.then.lampColor = e.target.value; touch(); });
  $('eye-color').addEventListener('input', (e) => { const r = selected(); if (!r) return; r.then.eyes = e.target.value; touch(); });
  $('text').addEventListener('input', (e) => { const r = selected(); if (!r) return; r.then.text = e.target.value.trim().slice(0, 24) || null; setDirty(true); renderStage(); });
  $('sound').addEventListener('change', (e) => { const r = selected(); if (!r) return; r.then.sound = e.target.value || null; setDirty(true); $('sound-play').disabled = !r.then.sound; renderList(); });
  $('number').addEventListener('change', (e) => { const r = selected(); if (!r) return; r.then.number = e.target.value || null; touch(); });
  $('sound-play').addEventListener('click', () => { const r = selected(); if (r?.then.sound) window.lightsApi.previewSound(r.then.sound); });
  $('sound-file').addEventListener('click', async () => { const r = selected(); if (!r) return; const f = await window.lightsApi.chooseSoundFile(); if (!f) return; r.then.sound = f; touch(); });
  $('body-color').addEventListener('change', (e) => setCharacter({ ...R.normalizeCharacter(config.character), bodyColor: e.target.value }));
  $('agents-color').addEventListener('input', (e) => { const r = selected(); if (!r) return; r.then.agentsColor = e.target.value; touch(); });
  $('source').addEventListener('change', (e) => { const r = selected(); if (!r) return; r.when.source = e.target.value || null; setDirty(true); });
  $('cwd').addEventListener('input', (e) => { const r = selected(); if (!r) return; r.when.cwd = e.target.value.trim() || null; setDirty(true); renderList(); });
  $('busy-ping').addEventListener('change', (e) => { const r = selected(); if (!r) return; if (e.target.value) r.then.busyPing = e.target.value; else delete r.then.busyPing; setDirty(true); });
  $('celebrate').addEventListener('change', (e) => { const r = selected(); if (!r) return; r.then.celebrate = e.target.checked; setDirty(true); stageCelebrate(e.target.checked); });
  $('delete-btn').addEventListener('click', () => selectedId && remove(selectedId));

  // ── Photo cameos ───────────────────────────────────────────────────────
  // The user's own faces (cameos.js, via main). All are registered with the
  // rig so every mini and the stage can wear them; the Cameo row lists them
  // after the six built-ins, and "+ photo" opens the crop modal below.
  let cameoList = [];
  const cameoById = (id) => cameoList.find((c) => c.id === id);
  async function loadCameos(list) {
    cameoList = list || await window.lightsApi.cameos.list();
    window.rigSetCameoPhotos(cameoList);
  }
  const X_ICON = '<svg viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>';
  // Two clicks to remove: the first arms it (it turns red and says so).
  function faceRemoveBtn(c) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'face-x';
    const label = c.builtin ? `Remove your photo (back to the built-in ${c.id})` : `Remove ${c.name}`;
    x.title = label;
    x.setAttribute('aria-label', label);
    x.innerHTML = X_ICON;
    let armed = null;
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!armed) {
        x.classList.add('armed');
        x.textContent = 'remove?';
        x.title = 'Click again to remove this photo. A backup of your faces is kept first (Preferences → Backups).';
        armed = setTimeout(() => { armed = null; x.classList.remove('armed'); x.innerHTML = X_ICON; x.title = label; }, 2500);
        return;
      }
      clearTimeout(armed);
      const left = await window.lightsApi.cameos.remove(c.id);
      if (left && left.error) { flash(`Could not remove the face — ${left.error}`); return; }
      await loadCameos(left);
      renderEditor();
      renderStage();
    });
    return x;
  }
  function hatchRemoveBtn(id) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'face-x';
    const label = `Delete ${window.BuddyCharacters.get(id).name}`;
    x.title = label;
    x.setAttribute('aria-label', label);
    x.innerHTML = X_ICON;
    let armed = null;
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armed) {
        x.classList.add('armed');
        x.textContent = 'delete?';
        armed = setTimeout(() => { armed = null; x.classList.remove('armed'); x.innerHTML = X_ICON; }, 3000);
        return;
      }
      clearTimeout(armed);
      window.lightsApi.removeCharacter(id);
    });
    return x;
  }

  function hatchAddBtn() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'addhatch';
    b.title = 'Make a new character';
    b.innerHTML = '<span>+ Hatch</span>';
    b.addEventListener('click', () => window.lightsApi.openHatch());
    return b;
  }

  function faceAddBtn() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'addface';
    b.title = 'Add from photo';
    b.innerHTML = '<svg viewBox="0 0 16 16"><path d="M2 5.5h2.4l1.2-1.8h4.8l1.2 1.8H14v7H2z"/><circle cx="8" cy="9" r="2.1"/></svg><span>+ photo</span>';
    b.addEventListener('click', openFace);
    return b;
  }

  const FACE_TRY = [['plain', {}], ['smoke', { pose: 'smoke' }], ['zyn', { pose: 'zyn' }], ['grin', { pose: 'grin' }], ['crown', { costume: 'crown' }]];
  const face = { img: null, w: 0, h: 0, crop: null, shape: 'oval', eyes: null, mouth: null, rev: 0, tryOn: 'plain', raf: 0 };
  const facePreview = mountRig($('face-preview'));
  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = faceCanvas.height = 256;
  const faceClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const facePoint = (p) => ({ x: faceClamp(p.x, 0, 1), y: faceClamp(p.y, 0, 1) });
  const faceScale = () => $('face-img').getBoundingClientRect().width / face.w || 1;
  const faceError = (msg) => { $('face-err').textContent = msg || ''; };
  const faceOpen = () => !$('face-modal').hidden;
  const pickIn = (group, b) => { for (const x of group.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); } };
  $('face-try').innerHTML = FACE_TRY.map(([k]) => `<button type="button" class="signal" data-try="${k}" aria-pressed="false">${k}</button>`).join('');

  function openFace() {
    face.img = null;
    face.shape = 'oval';
    face.tryOn = 'plain';
    pickIn($('face-shape'), $('face-shape').children[0]);
    pickIn($('face-try'), $('face-try').children[0]);
    $('face-img').removeAttribute('src');
    $('face-empty').hidden = false;
    $('face-frame').hidden = true;
    $('face-again').hidden = true;
    $('face-save').disabled = true;
    $('face-name').value = '';
    $('face-name').placeholder = 'Name, e.g. Dad';
    const title = (id) => id.charAt(0).toUpperCase() + id.slice(1);
    $('face-replace').innerHTML = '<option value="">— or replace a built-in —</option>' + cameoList.filter((c) => c.builtin).map((c) => `<option value="${c.id}">Replace ${title(c.id)}${c.user ? ' (your photo)' : ''}</option>`).join('');
    faceError('');
    $('face-modal').hidden = false;
    facePreview.setLook({ lamp: 'green', eyes: 'default', pose: 'none' });
    $('face-choose').focus();
  }
  function closeFace() {
    $('face-modal').hidden = true;
    face.img = null;
    $('face-img').removeAttribute('src');
    $('cameos').querySelector('.addface')?.focus();
  }

  function faceLoad(url, name) {
    const img = new Image();
    img.onload = () => {
      face.img = img;
      face.w = img.naturalWidth;
      face.h = img.naturalHeight;
      const side = Math.round(Math.min(face.w, face.h) * 0.6);
      face.crop = { x: (face.w - side) / 2, y: (face.h - side) / 2, size: side };
      face.eyes = { x: 0.5, y: 0.4 };
      face.mouth = { x: 0.5, y: 0.75 };
      $('face-img').src = url;
      $('face-empty').hidden = true;
      $('face-frame').hidden = false;
      $('face-again').hidden = false;
      $('face-save').disabled = false;
      // Camera and clipboard names (IMG_1234, image.png) make poor names.
      if (!$('face-name').value && name && !/^(img|dsc|dscn|pxl|image|photo|screenshot|pasted)[\s_-]?\d*|^[\d\s_-]+$/i.test(name)) $('face-name').value = name.slice(0, 40);
      faceError('');
      $('face-img').decode().catch(() => {}).then(() => { faceUpdate(); $('face-crop').focus(); });
    };
    img.onerror = () => faceError('That image could not be opened here — Choose file… also reads HEIC.');
    img.src = url;
  }
  function faceFromFile(file) {
    if (!file || !/^image\//.test(file.type)) { faceError('That is not an image.'); return; }
    const r = new FileReader();
    r.onload = () => faceLoad(r.result, file.name.replace(/\.[^.]+$/, ''));
    r.readAsDataURL(file);
  }
  async function faceChoose() {
    const r = await window.lightsApi.cameos.chooseFile();
    if (!r) return;
    if (r.error) faceError(r.error);
    else faceLoad(r.dataUrl, r.name);
  }

  function facePaint() {
    if (!face.img) return;
    const k = faceScale();
    const box = $('face-crop');
    box.style.left = `${face.crop.x * k}px`;
    box.style.top = `${face.crop.y * k}px`;
    box.style.width = box.style.height = `${face.crop.size * k}px`;
    box.classList.toggle('rounded', face.shape === 'rounded');
    $('face-line').style.top = `${face.eyes.y * 100}%`;
    for (const [id, p] of [['face-eyes', face.eyes], ['face-mouth', face.mouth]]) {
      $(id).style.left = `${p.x * 100}%`;
      $(id).style.top = `${p.y * 100}%`;
    }
  }
  // The preview wears the crop exactly as main will cut it (same mask), one
  // frame at a time however fast the drag.
  function faceUpdate() {
    facePaint();
    if (!face.img || face.raf) return;
    face.raf = requestAnimationFrame(() => {
      face.raf = 0;
      if (!face.img) return;
      const g = faceCanvas.getContext('2d');
      g.clearRect(0, 0, 256, 256);
      g.save();
      g.beginPath();
      if (face.shape === 'rounded') g.roundRect(0, 0, 256, 256, 256 * 0.18);
      else g.ellipse(128, 128, 256 * 0.42, 128, 0, 0, Math.PI * 2);
      g.clip();
      g.drawImage(face.img, face.crop.x, face.crop.y, face.crop.size, face.crop.size, 0, 0, 256, 256);
      g.restore();
      face.rev += 1;
      const tryOn = FACE_TRY.find(([k]) => k === face.tryOn)[1];
      facePreview.setLook({ lamp: 'green', eyes: 'default', pose: 'none', costume: 'none', ...tryOn, cameo: 'face-draft', cameoPhoto: { id: 'face-draft', rev: face.rev, src: faceCanvas.toDataURL('image/png'), eyes: face.eyes, mouth: face.mouth, shape: face.shape } });
    });
  }
  function faceSetCrop(c) {
    const max = Math.min(face.w, face.h);
    const size = faceClamp(c.size, Math.min(32, max), max);
    face.crop = { size, x: faceClamp(c.x, 0, face.w - size), y: faceClamp(c.y, 0, face.h - size) };
    faceUpdate();
  }
  // Pointer drags in image pixels; the handlers get the delta and the state
  // at pointerdown.
  function faceDrag(el, onMove) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !face.img) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus();
      el.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, k: faceScale(), crop: { ...face.crop }, eyes: { ...face.eyes }, mouth: { ...face.mouth } };
      el.classList.add('grabbing');
      const move = (ev) => onMove((ev.clientX - start.x) / start.k, (ev.clientY - start.y) / start.k, start);
      const up = () => {
        el.classList.remove('grabbing');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
  faceDrag($('face-crop'), (dx, dy, s) => faceSetCrop({ ...s.crop, x: s.crop.x + dx, y: s.crop.y + dy }));
  faceDrag($('face-handle'), (dx, dy, s) => faceSetCrop({ ...s.crop, size: Math.min(s.crop.size + Math.max(dx, dy), face.w - s.crop.x, face.h - s.crop.y) }));
  faceDrag($('face-eyes'), (dx, dy, s) => { face.eyes = facePoint({ x: s.eyes.x + dx / s.crop.size, y: s.eyes.y + dy / s.crop.size }); faceUpdate(); });
  faceDrag($('face-mouth'), (dx, dy, s) => { face.mouth = facePoint({ x: s.mouth.x + dx / s.crop.size, y: s.mouth.y + dy / s.crop.size }); faceUpdate(); });
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  $('face-crop').addEventListener('keydown', (e) => {
    if (!face.img || e.target !== $('face-crop')) return;
    const step = Math.max(1, Math.min(face.w, face.h) * (e.shiftKey ? 0.05 : 0.01));
    if (ARROWS[e.key]) {
      e.preventDefault();
      const [ax, ay] = ARROWS[e.key];
      faceSetCrop({ ...face.crop, x: face.crop.x + ax * step, y: face.crop.y + ay * step });
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      const d = (e.key === '-' ? -2 : 2) * step;
      faceSetCrop({ x: face.crop.x - d / 2, y: face.crop.y - d / 2, size: face.crop.size + d });
    }
  });
  for (const [id, key] of [['face-eyes', 'eyes'], ['face-mouth', 'mouth']]) {
    $(id).addEventListener('keydown', (e) => {
      if (!ARROWS[e.key]) return;
      e.preventDefault();
      const step = e.shiftKey ? 0.05 : 0.01;
      const [ax, ay] = ARROWS[e.key];
      face[key] = facePoint({ x: face[key].x + ax * step, y: face[key].y + ay * step });
      faceUpdate();
    });
  }
  $('face-try').addEventListener('click', (e) => {
    const b = e.target.closest('[data-try]');
    if (!b) return;
    face.tryOn = b.dataset.try;
    pickIn($('face-try'), b);
    faceUpdate();
  });
  $('face-shape').addEventListener('click', (e) => {
    const b = e.target.closest('[data-shape]');
    if (!b) return;
    face.shape = b.dataset.shape;
    pickIn($('face-shape'), b);
    faceUpdate();
  });

  async function faceSave() {
    if (!face.img) return;
    const replace = $('face-replace').value;
    const name = $('face-name').value.trim();
    if (!replace && !name) { faceError('Give the face a name, or pick a built-in to replace.'); $('face-name').focus(); return; }
    $('face-save').disabled = true;
    faceError('');
    // Main gets a PNG with any EXIF rotation already applied, at most 1600px.
    const k = Math.min(1, 1600 / Math.max(face.w, face.h));
    const c = document.createElement('canvas');
    c.width = Math.round(face.w * k);
    c.height = Math.round(face.h * k);
    c.getContext('2d').drawImage(face.img, 0, 0, c.width, c.height);
    const res = await window.lightsApi.cameos.add({
      source: c.toDataURL('image/png'),
      rect: { x: face.crop.x * k, y: face.crop.y * k, size: face.crop.size * k },
      shape: face.shape, name, replace: replace || null, eyes: face.eyes, mouth: face.mouth,
    });
    $('face-save').disabled = false;
    if (res.error) { faceError(res.error); return; }
    await loadCameos(res.list);
    closeFace();
    // The new face goes straight onto the rule being edited.
    const r = selected();
    if (r) { r.then.cameo = res.id; touch(); } else { renderEditor(); renderStage(); }
  }

  $('face-choose').addEventListener('click', faceChoose);
  $('face-again').addEventListener('click', faceChoose);
  $('face-cancel').addEventListener('click', closeFace);
  $('face-close').addEventListener('click', closeFace);
  $('face-save').addEventListener('click', faceSave);
  $('face-name').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('face-save').disabled) faceSave(); });
  $('face-replace').addEventListener('change', () => { $('face-name').placeholder = $('face-replace').value ? 'Name (optional)' : 'Name, e.g. Dad'; faceError(''); });
  $('face-modal').addEventListener('pointerdown', (e) => { if (e.target === $('face-modal')) closeFace(); });
  // Dropping anywhere on the modal loads the image (and never navigates the window to it).
  $('face-modal').addEventListener('dragover', (e) => { e.preventDefault(); $('face-pane').classList.add('dragging'); });
  $('face-modal').addEventListener('dragleave', (e) => { if (!$('face-modal').contains(e.relatedTarget)) $('face-pane').classList.remove('dragging'); });
  $('face-modal').addEventListener('drop', (e) => { e.preventDefault(); $('face-pane').classList.remove('dragging'); faceFromFile(e.dataTransfer.files[0]); });
  // hatched characters arrive after the first draw, and when one is saved or removed
  let ucTimer = null;
  window.addEventListener('user-characters', () => {
    clearTimeout(ucTimer);
    ucTimer = setTimeout(() => { try { renderEditor(); } catch (e) { console.warn('lights: redraw after characters changed failed:', e && e.message); } }, 100);
  });
  document.addEventListener('paste', (e) => {
    if (!faceOpen()) return;
    const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    faceFromFile(item.getAsFile());
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && faceOpen()) { e.preventDefault(); e.stopPropagation(); closeFace(); } }, true);
  window.addEventListener('resize', () => { if (faceOpen()) facePaint(); });

  // ── Stage ──────────────────────────────────────────────────────────────
  function renderStage() {
    $('mode-rule').classList.toggle('on', previewMode === 'rule');
    $('mode-live').classList.toggle('on', previewMode === 'live');
    const cap = $('caption');
    if (previewMode === 'rule') {
      const r = selected();
      if (!r) { stage.setLook({ lamp: 'off' }); cap.textContent = 'Select a rule to preview it.'; return; }
      // Show only this rule's own look, so what you see is what "Try on
      // widget" sends. The caption still says what the other rules would
      // contribute when this signal is live.
      const own = R.previewLook(r, config.character);
      own.gardenSpeed = 30;
      if (r.then.agents || r.then.agentsColor) own.minions = SAMPLE_MINIONS;
      stage.setLook(own);
      document.querySelector('#stage .rig-wrap').classList.toggle('wide', own.effect === 'garden');
      stageCelebrate(!!own.celebrate);
      stageFire(own.pose);
      const sample = { signal: r.when.signal[0] || 'idle', tool: r.when.tool && !r.when.tool.endsWith('*') ? r.when.tool : (r.when.tool ? r.when.tool.slice(0, -1) + 'x' : null) };
      const { owned } = R.resolve(rules.map((x) => (x.id === r.id ? { ...x, enabled: true } : x)), [sample]);
      const parts = [];
      for (const ch of ['lamp', 'eyes', 'pose']) {
        if (owned[ch] && owned[ch] !== r.id) parts.push(`${ch} would come from <b>${escape(rules.find((x) => x.id === owned[ch])?.name || '')}</b>`);
      }
      cap.innerHTML = `<b>${escape(r.name)}</b>${r.enabled ? '' : ' <span class="owner">(disabled)</span>'}` + (parts.length ? `<br><span class="owner">${parts.join(' · ')}</span>` : '');
    } else {
      if (!live) return;
      stage.setLook({ ...live.look, gardenSpeed: 30 });
      document.querySelector('#stage .rig-wrap').classList.toggle('wide', live.look.effect === 'garden');
      stageCelebrate(!!live.look.celebrate);
      stageFire(live.look.pose);
      const n = live.sessions.length;
      cap.innerHTML = `<b>${escape(live.look.name || 'Nothing matched')}</b><br><span class="owner">${live.reason === 'manual' ? 'manual override' : n ? `${n} live session${n === 1 ? '' : 's'}` : 'no sessions'}</span>`;
    }
  }
  $('mode-rule').addEventListener('click', () => { previewMode = 'rule'; renderStage(); });
  $('mode-live').addEventListener('click', () => { previewMode = 'live'; renderStage(); });
  $('try-btn').addEventListener('click', () => {
    const look = stage.look;
    if (!look) return;
    window.lightsApi.previewOnWidget({ ...look, name: (selected()?.name || '') }, 4000);
    if (look.celebrate) stage.celebrate();
  });

  async function refreshLive() {
    live = await window.lightsApi.getAggregateStatus();
    if (!live) return;
    const c = live.look.lampColor || LAMP_COLORS[live.look.lamp] || null;
    $('live-dot').style.setProperty('--live-color', c || '');
    const n = live.sessions.length;
    $('live-text').textContent = `Widget: ${live.look.name || '—'} · ${n} session${n === 1 ? '' : 's'}`;
    renderNow();
    if (previewMode === 'live') renderStage();
  }
  window.lightsApi.onStatusChanged(() => {
    if (!embeddedView) refreshLive();
    if (document.hidden) return;
    if ($('main').dataset.view === 'stats') renderStats();
    else if ($('main').dataset.view === 'mix') refreshMixLive();
  });

  // ── Save / revert / presets ────────────────────────────────────────────
  // Set when a template, preset or import replaced the rules wholesale, so main keeps a backup first.
  let replaceWhy = null;
  async function save() {
    if (!dirty) return;
    try { config = await window.lightsApi.saveConfig({ rules, template: templateId, ...(replaceWhy && { __backupReason: replaceWhy }), ...prefsToSave() }); stagedPrefs = null; replaceWhy = null; } catch (err) {
      // stay dirty: nothing was stored, and the edits are still only here
      flash(`Save failed — ${err.message}`);
      return;
    }
    rules = config.rules.map(R.normalizeRule);
    setDirty(false);
    templateId = config.template || null;
    $('save-state').textContent = 'Saved';
    setTimeout(() => { if (!dirty) $('save-state').textContent = ''; }, 1500);
    renderList(); renderEditor(); renderStage();
  }
  // Any other saveConfig rejection (toggles) still gets a visible message.
  window.addEventListener('unhandledrejection', (e) => { flash(e.reason?.message || 'Something went wrong'); });
  $('save-btn').addEventListener('click', save);
  $('revert-btn').addEventListener('click', () => { replaceWhy = null; rules = config.rules.map(R.normalizeRule); setDirty(false); templateId = config.template || null; stagedPrefs = null; if (!selected()) selectedId = rules[0]?.id || null; renderList(); renderEditor(); renderStage(); });
  window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  $('add-btn').addEventListener('click', () => {
    const r = R.normalizeRule({ name: 'New rule', when: { signal: ['tool-use'], tool: 'Edit' }, then: { eyes: '#38bdf8' } });
    const at = rules.findIndex((x) => !x.locked);
    rules.splice(at < 0 ? rules.length : at, 0, r);
    setDirty(true);
    select(r.id);
    $('name').focus();
    $('name').select();
  });

  const PRESETS = {
    tools: () => {
      const d = R.defaultRules().map((r) => (r.id === 'shell' || r.id === 'failed' ? { ...r, enabled: true } : r));
      const at = d.findIndex((r) => r.id === 'working');
      d.splice(at, 0,
        { id: 'edits', name: 'Editing files', enabled: true, when: { signal: ['tool-use'], tool: 'Edit' }, then: { eyes: '#f2a200' } },
        { id: 'writes', name: 'Writing files', enabled: true, when: { signal: ['tool-use'], tool: 'Write' }, then: { eyes: '#f2a200' } },
        { id: 'mcp', name: 'Using an MCP tool', enabled: true, when: { signal: ['tool-use'], tool: 'mcp__*' }, then: { eyes: '#f472b6' } },
        { id: 'web', name: 'On the web', enabled: true, when: { signal: ['tool-use', 'tool-done'], tool: 'Web*' }, then: { eyes: '#38bdf8' } },
      );
      return d;
    },
  };
  function userPresets() { return Array.isArray(config?.presets) ? config.presets : []; }

  function renderUserPresets() {
    const box = $('user-presets');
    const list = userPresets();
    box.innerHTML = list.length ? '' : '<div class="empty-small">Save the current rules below to keep a set you can come back to.</div>';
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'user';
      row.innerHTML = `<button class="pick" data-user="${p.id}"><span>${escape(p.name)}</span><small>${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}</small></button>
        <button class="x" data-remove="${p.id}" title="Delete preset" aria-label="Delete preset ${escape(p.name)}"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>`;
      box.appendChild(row);
    }
  }

  function renderTemplates() {
    $('templates').innerHTML = R.templates().map((t) => `<button data-template="${t.id}"><span>${escape(t.name)}</span><small>${escape(t.description)}</small></button>`).join('');
  }
  renderTemplates();

  // A template's settings merged over the saved ones: config keys are replaced
  // whole, so notifyStates starts from what is saved.
  function prefsToSave() {
    if (!stagedPrefs) return {};
    const { notifyStates, spend, ...rest } = stagedPrefs;
    return { ...rest, ...(notifyStates && { notifyStates: { ...config.notifyStates, ...notifyStates } }), ...(spend && { spend: { ...config.spend, ...spend } }) };
  }

  function applyRules(next, tpl) {
    replaceWhy = tpl ? 'template' : 'preset';
    rules = next.map(R.normalizeRule);
    selectedId = rules[0]?.id || null;
    applying = true;
    setDirty(true);
    applying = false;
    templateId = tpl ? tpl.id : null;
    stagedPrefs = tpl && Object.keys(tpl.prefs).length ? tpl.prefs : null;
    $('presets').hidden = true;
    renderList(); renderEditor(); renderStage();
  }

  PRESETS.loud = () => {
    const d = R.defaultRules();
    const set = (id, then) => { const r = d.find((x) => x.id === id); Object.assign(r.then, then); };
    set('limit', { sound: 'Sosumi', pose: 'sleep', lampFx: 'sos' });
    set('permission', { sound: 'Hero', pose: 'ak47', lampFx: 'strobe' });
    set('nudge', { pose: 'bubble', text: 'YOUR TURN', sound: 'Glass' });
    const i = d.findIndex((x) => x.id === 'ignored');
    // ignored-10 and -20 still fire at 30 minutes, so the longest wait must sit on top to win.
    d.splice(i, 1,
      { id: 'ig30', name: 'Ignored 30 min', enabled: true, when: { signal: ['ignored-30'] }, then: { pose: 'banner', text: 'HELLO??', eyes: 'laser', sound: 'Funk' } },
      { id: 'ig20', name: 'Ignored 20 min', enabled: true, when: { signal: ['ignored-20'] }, then: { pose: 'arms', effect: 'beard' } },
      { id: 'ig10', name: 'Ignored 10 min', enabled: true, when: { signal: ['ignored-10'] }, then: { pose: 'tap' } },
    );
    return d;
  };
  PRESETS.party = () => {
    const d = R.defaultRules();
    const set = (id, then) => { const r = d.find((x) => x.id === id); Object.assign(r.then, then); };
    set('done', { pose: 'party', costume: 'partyhat', effect: 'sparkles', eyes: 'heart', lampFx: 'chase' });
    set('working', { pose: 'run', pet: 'duck', lampFx: 'breathe', agents: 'duck' });
    set('limit', { effect: 'rain', eyes: 'x' });
    set('permission', { pose: 'wave', costume: 'crown' });
    set('failed', { eyes: 'dizzy', effect: 'fire' });
    d.find((x) => x.id === 'failed').enabled = true;
    return d;
  };
  PRESETS.zen = () => {
    const d = R.defaultRules().filter((r) => !['subagent', 'failed', 'shell', 'ignored'].includes(r.id));
    const set = (id, then) => { const r = d.find((x) => x.id === id); if (r) Object.assign(r.then, then); };
    set('working', { pose: 'blink', lampFx: 'breathe', pet: null });
    set('done', { pose: 'none', eyes: 'happy', costume: 'halo', celebrate: false, lampFx: 'breathe' });
    set('nudge', { pose: 'blink', lampFx: 'breathe' });
    set('idle', { pose: 'sleep', eyes: 'closed', lampFx: 'breathe', effect: 'snow' });
    set('permission', { pose: 'nod', sound: 'Glass', lampFx: 'breathe' });
    set('limit', { pose: 'sleep', sound: 'Blow', lampFx: 'breathe' });
    set('ralph', { pose: 'blink' });
    return d;
  };
  PRESETS.chaos = () => {
    const d = R.defaultRules().map((r) => (r.id === 'failed' || r.id === 'shell' ? { ...r, enabled: true } : r));
    const set = (id, then) => { const r = d.find((x) => x.id === id); if (r) Object.assign(r.then, then); };
    set('permission', { pose: 'sniper', lampFx: 'strobe', sound: 'Sosumi', screenFx: 'vignette', eyes: 'laser' });
    set('limit', { pose: 'ak47', lampFx: 'sos', sound: 'Funk', screenFx: 'vignette' });
    set('working', { pose: 'run', lampFx: 'police', pet: 'dragon', effect: 'fire' });
    set('done', { pose: 'party', lampFx: 'rainbow', screenFx: 'confetti', costume: 'partyhat', eyes: 'star', sound: 'Hero' });
    set('failed', { eyes: 'dizzy', effect: 'fire', signFx: 'rattle' });
    set('ignored', { pose: 'arms', effect: 'beard', signFx: 'cracked', lampFx: 'flicker' });
    set('idle', { pose: 'kickflip', lampFx: 'chase', pet: 'duck' });
    return d;
  };
  PRESETS.gardener = () => {
    const d = R.defaultRules();
    const set = (id, then) => { const r = d.find((x) => x.id === id); if (r) Object.assign(r.then, then); };
    set('idle', { effect: 'garden', pose: 'none', costume: 'none' });
    set('working', { pose: 'run', effect: 'sun', pet: 'duck', costume: 'none' });
    set('done', { pose: 'thumbs', effect: 'sparkles', eyes: 'happy', pet: 'bunny' });
    set('nudge', { pose: 'none', effect: 'sun', pet: 'snail' });
    set('permission', { pose: 'wave', effect: 'rain' });
    set('limit', { pose: 'sleep', effect: 'rain' });
    return d;
  };
  PRESETS.office = () => {
    const d = R.defaultRules().filter((r) => !['shell', 'failed'].includes(r.id));
    const set = (id, then) => { const r = d.find((x) => x.id === id); if (r) Object.assign(r.then, then); };
    set('working', { pose: 'nod', costume: 'tophat', eyes: 'suspicious', lampFx: 'none' });
    set('done', { pose: 'thumbs', costume: 'tophat', eyes: 'happy', celebrate: false, sound: 'Glass' });
    set('nudge', { pose: 'bubble', text: 'BRB', costume: 'tophat', eyes: 'roll' });
    set('permission', { pose: 'banner', text: 'SIGN HERE', costume: 'tophat', sound: 'Ping' });
    set('limit', { pose: 'dead', costume: 'tophat', lampFx: 'flicker' });
    set('idle', { pose: 'selfie', costume: 'shades', eyes: 'money' });
    set('subagent', { costume: 'shades', eyes: '#8b5cf6' });
    return d;
  };
  PRESETS.night = () => {
    const d = R.defaultRules().filter((r) => !['shell', 'failed'].includes(r.id));
    const set = (id, then) => { const r = d.find((x) => x.id === id); if (r) Object.assign(r.then, then); };
    set('working', { pose: 'blink', effect: 'snow', lampFx: 'breathe', lampColor: '#8b5cf6', lamp: 'green', agents: 'ghost' });
    set('done', { pose: 'nod', eyes: 'sleepy', lampFx: 'breathe', lampColor: '#8b5cf6', lamp: 'amber', celebrate: false });
    set('nudge', { pose: 'sleep', eyes: 'closed', lampFx: 'breathe', lampColor: '#8b5cf6', lamp: 'amber' });
    set('idle', { pose: 'sleep', eyes: 'closed', effect: 'snow', lamp: 'off' });
    set('permission', { pose: 'wave', costume: 'halo', sound: 'Purr', lampFx: 'breathe' });
    set('limit', { pose: 'dead', lampFx: 'sos' });
    return d;
  };
  PRESETS.swarm = () => {
    const d = R.defaultRules();
    const set = (id, then) => { const r = d.find((x) => x.id === id); if (r) Object.assign(r.then, then); };
    // Team eyes sit above the subagent and swarm eye accents so team mode always reads as distinct.
    d.splice(2, 0, d.splice(d.findIndex((x) => x.id === 'team'), 1)[0]);
    d.splice(d.findIndex((x) => x.id === 'swarm') + 1, 0,
      { id: 'subagents', name: 'Subagents running', enabled: true, when: { signal: ['subagents'] }, then: { pose: 'banner', text: '{agents} AGENTS', number: 'agents', agents: 'robot' } },
    );
    set('team', { eyes: 'star', costume: 'crown', pet: null });
    set('ralph', { pose: 'banner', text: 'LOOP {iteration}', number: 'ralph', lampFx: 'chase' });
    set('swarm', { number: 'agents', eyes: '#f2a200', signFx: 'neon' });
    set('permission', { pose: 'knock', lampFx: 'pulse' });
    set('limit', { eyes: 'x', lampFx: 'sos' });
    set('done', { pose: 'thumbs', screenFx: 'confetti' });
    return d;
  };
  PRESETS.focus = () => {
    const d = R.defaultRules().filter((r) => !['subagent', 'ralph', 'swarm', 'team', 'shell', 'failed', 'ignored'].includes(r.id));
    const set = (id, then) => { const r = d.find((x) => x.id === id); if (r) Object.assign(r.then, then); };
    set('limit', { pose: 'none', lampColor: '#ffffff' });
    set('permission', { pose: 'none', sound: null, lampColor: '#ffffff', lampFx: 'breathe' });
    set('working', { pose: 'none', lampColor: '#d4d4d4', lampFx: 'breathe' });
    set('done', { pose: 'none', eyes: null, lampColor: '#ffffff', celebrate: false });
    set('nudge', { lampColor: '#a3a3a3' });
    set('idle', { lampColor: '#525252' });
    set('offline', { pose: 'none', eyes: null, effect: null, lampColor: '#737373', lampFx: 'breathe' });
    set('failed-turn', { pose: 'none', eyes: null, lampColor: '#a3a3a3' });
    return d;
  };
  PRESETS.retro = () => {
    const d = R.defaultRules().map((r) => (r.id === 'failed' ? { ...r, enabled: true } : r));
    const set = (id, then) => { const r = d.find((x) => x.id === id); if (r) Object.assign(r.then, then); };
    set('limit', { pose: 'banner', text: 'GAME OVER', eyes: 'x', lampFx: 'sos' });
    set('permission', { pose: 'knock', eyes: 'surprised', lampFx: 'strobe' });
    set('ralph', { pose: 'banner', text: 'LEVEL {iteration}' });
    set('failed', { eyes: 'dizzy', signFx: 'rattle' });
    set('working', { pose: 'run', lampFx: 'chase', signFx: 'neon' });
    set('done', { pose: 'party', eyes: 'star', lampFx: 'rainbow', screenFx: 'confetti', sound: 'beep' });
    set('nudge', { pose: 'bubble', text: 'PLAYER 1?' });
    set('idle', { pose: 'banner', text: 'INSERT COIN', lampFx: 'chase' });
    return d;
  };
  $('presets-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('presets').hidden;
    $('presets').hidden = !open;
    if (open) { renderUserPresets(); $('preset-name').value = ''; $('preset-save').disabled = true; $('setup-choice').hidden = true; $('rules-choice').hidden = true; $('presets').querySelector('button')?.focus(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#presets')) $('presets').hidden = true; });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('presets').hidden) { $('presets').hidden = true; $('presets-btn').focus(); } });
  new MutationObserver(() => $('presets-btn').setAttribute('aria-expanded', String(!$('presets').hidden))).observe($('presets'), { attributes: true, attributeFilter: ['hidden'] });
  $('presets').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.preset) return applyRules(PRESETS[b.dataset.preset]());
    if (b.dataset.template) {
      // Staged, not saved: Revert returns to the saved rules and settings.
      const t = R.templates().find((x) => x.id === b.dataset.template);
      const done = `Template loaded${t.prefsNote ? ` (${t.prefsNote})` : ''} — Save to keep it; Revert returns to your saved rules`;
      if (dirty) return offerRules(t.rules, done, t);
      applyRules(t.rules, t);
      return flash(done);
    }
    if (b.dataset.user) {
      const p = userPresets().find((x) => x.id === b.dataset.user);
      if (p) applyRules(p.rules);
      return;
    }
    if (b.dataset.remove) {
      config = await window.lightsApi.saveConfig({ presets: userPresets().filter((x) => x.id !== b.dataset.remove) });
      renderUserPresets();
    }
  });
  // ── Sharing: a compact code (deflate + base64url) or a JSON file. Codes
  // are versioned ("ctl1:") so a future format can still read old ones.
  async function encodeShare(rulesToShare) {
    const json = JSON.stringify(R.shareFile(rulesToShare));
    const bytes = new TextEncoder().encode(json);
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter(); w.write(bytes); w.close();
    const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
    return 'ctl1:' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function decodeShare(code) {
    const m = /^ctl1:([A-Za-z0-9_-]+)$/.exec(String(code).trim());
    if (!m) throw new Error('Not a share code');
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (m[1].length % 4)) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter(); w.write(bytes); w.close();
    const json = await new Response(ds.readable).text();
    const parsed = JSON.parse(json);
    if (!parsed || !Array.isArray(parsed.rules)) throw new Error('Share code has no rules');
    // Codes made before v5 carry no rulesVersion; they migrate like a saved config.
    return R.migrateRules(parsed.rules.map(R.normalizeRule), R.rulesVersionOf(parsed));
  }
  function flash(msg) { $('save-state').textContent = msg; setTimeout(() => { if (!dirty) $('save-state').textContent = ''; else setDirty(true); }, 2200); }
  $('share-copy').addEventListener('click', async (e) => { e.stopPropagation(); const code = await encodeShare(rules); await navigator.clipboard.writeText(code); $('presets').hidden = true; flash(`Share code copied (${code.length} chars)`); });
  $('share-paste').addEventListener('click', async (e) => { e.stopPropagation(); $('share-form').hidden = false; $('share-code').value = ''; try { const t = await navigator.clipboard.readText(); if (/^ctl1:/.test(t.trim())) $('share-code').value = t.trim(); } catch { /* clipboard not readable */ } $('share-code').focus(); });
  // Rules from someone else (a share code or a file) can bind clicks to shell
  // commands, Shortcuts, URLs and apps, so, like a whole-setup import, they are shown —
  // every command included — and only load on an explicit confirm.
  let offered = null;
  function offerRules(incoming, done, tpl) {
    offered = { rules: incoming.map(R.normalizeRule), done, tpl };
    const cmds = R.clickCommands(offered.rules);
    const k = offered.rules.length;
    $('rules-summary').innerHTML = `<b>${k} rule${k === 1 ? '' : 's'} — they replace your current rules, unsaved edits included. Revert returns to your saved rules</b>`
      + (cmds.length ? `<br>Clicks in these rules run:${cmds.map((c) => `<code>${escape(c)}</code>`).join('')}` : '');
    $('share-form').hidden = true;
    $('setup-choice').hidden = true;
    $('presets').hidden = false;
    $('rules-choice').hidden = false;
    $('rules-choice').querySelector('button').focus();
  }
  $('rules-choice').addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('button[data-rules]');
    if (!b || !offered) return;
    const { rules: incoming, done, tpl } = offered;
    offered = null;
    $('rules-choice').hidden = true;
    if (b.dataset.rules === 'cancel') { $('presets').hidden = true; return; }
    applyRules(incoming, tpl);
    flash(done);
  });
  $('share-form').addEventListener('submit', async (e) => {
    e.preventDefault(); e.stopPropagation();
    try { offerRules(await decodeShare($('share-code').value), 'Loaded shared rules — Save to keep them'); }
    catch (err) { flash(err.message); }
  });
  $('share-export').addEventListener('click', async (e) => { e.stopPropagation(); $('presets').hidden = true; const r = await window.lightsApi.exportRules(rules.map(R.normalizeRule)); if (r) flash(`Exported to ${R.folderOf(r)}`); });
  $('share-import').addEventListener('click', async (e) => { e.stopPropagation(); const r = await window.lightsApi.importRules(); if (r && Array.isArray(r.rules)) offerRules(r.rules, 'Imported — Save to keep them'); else { $('presets').hidden = true; if (r && r.error) flash(r.error); } });
  // Whole setup: export writes what's saved; import shows what the file holds
  // (and any commands its clicks run) before the user picks merge or replace.
  $('setup-export').addEventListener('click', async (e) => {
    e.stopPropagation(); $('presets').hidden = true;
    const r = await window.lightsApi.exportSetup();
    if (r && r.error) flash(r.error);
    else if (r) flash(`Setup exported to ${r.file.split(/[\\/]/).pop()}${dirty ? ' — unsaved rule edits not included' : ''}`);
  });
  $('setup-import').addEventListener('click', async (e) => {
    e.stopPropagation();
    const s = await window.lightsApi.importSetupPick();
    if (!s) return;
    if (s.error) { $('presets').hidden = true; flash(s.error); return; }
    const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
    const parts = [s.rules != null && n(s.rules, 'rule'), s.presets != null && n(s.presets, 'preset'), s.cameos && n(s.cameos, 'face'), s.settings.length && 'agent settings'].filter(Boolean);
    $('setup-summary').innerHTML = `<b>${escape(parts.join(', ') || 'Nothing usable in that file')}</b>`
      + '<br>Replace deletes your current rules, presets and faces that are not in this file. A backup is kept first (Preferences → Backups).'
      + (s.old ? '<br>From an older version — updated as it loads.' : '')
      + (s.dropped ? `<br>${n(s.dropped, 'face')} skipped (not a valid photo).` : '')
      + (s.commands.length ? `<br>Clicks in this setup run:${s.commands.map((c) => `<code>${escape(c)}</code>`).join('')}` : '');
    $('rules-choice').hidden = true;
    $('setup-choice').hidden = false;
  });
  $('setup-choice').addEventListener('click', async (e) => {
    e.stopPropagation();
    const b = e.target.closest('button[data-setup]');
    if (!b) return;
    $('setup-choice').hidden = true; $('presets').hidden = true;
    if (b.dataset.setup === 'cancel') return;
    const r = await window.lightsApi.importSetupApply(b.dataset.setup);
    if (r.error) { flash(r.error); return; }
    config = r.config;
    if (b.dataset.setup === 'replace') { rules = config.rules.map(R.normalizeRule); selectedId = rules[0]?.id || null; setDirty(false); }
    await loadCameos(r.cameos);
    renderList(); renderEditor(); renderStage();
    flash(r.failed.length ? r.failed[0] : b.dataset.setup === 'replace' ? 'Setup imported' : 'Presets and faces merged in');
  });
  $('share-code').addEventListener('click', (e) => e.stopPropagation());
  $('share-form').addEventListener('click', (e) => e.stopPropagation());

  $('preset-name').addEventListener('input', (e) => { $('preset-save').disabled = !e.target.value.trim(); });
  $('preset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('preset-name').value.trim();
    if (!name) return;
    const existing = userPresets().find((p) => p.name.toLowerCase() === name.toLowerCase());
    const entry = { id: existing?.id || R.uid(), name, rules: rules.map(R.normalizeRule) };
    const presets = existing ? userPresets().map((p) => (p.id === entry.id ? entry : p)) : [...userPresets(), entry];
    config = await window.lightsApi.saveConfig({ presets });
    $('preset-name').value = '';
    $('preset-save').disabled = true;
    renderUserPresets();
    $('save-state').textContent = existing ? `Updated “${name}”` : `Saved “${name}”`;
    setTimeout(() => { if (!dirty) $('save-state').textContent = ''; else setDirty(true); }, 1500);
  });
  $('prefs-btn').addEventListener('click', () => window.lightsApi.openPreferences());

  // ── Stats view ─────────────────────────────────────────────────────────
  const S = window.TrafficLightStats;
  function setView(v) {
    if (!['rules', 'stats', 'mix', 'auto'].includes(v)) return;
    if (embeddedView && v !== embeddedView) return;
    if (widgetOnly && !['rules', 'auto'].includes(v)) return;
    $('main').dataset.view = v;
    $('frame').dataset.view = v;
    for (const k of ['rules', 'stats', 'mix', 'auto']) {
      $(`view-${k}`).classList.toggle('on', v === k);
      $(`view-${k}`).setAttribute('aria-selected', v === k);
    }
    if (v === 'stats') renderStats();
    if (v === 'mix') { renderMix(); renderUsageHistory(true); }
  }
  $('view-rules').addEventListener('click', () => setView('rules'));
  window.lightsApi.onShowView((v) => setView(v));
  window.lightsApi.onMotionPaused((paused) => {
    motionPaused = !!paused;
    document.body.classList.toggle('motion-paused', motionPaused);
  });
  $('view-stats').addEventListener('click', () => setView('stats'));
  $('view-mix').addEventListener('click', () => setView('mix'));
  $('view-auto').addEventListener('click', () => setView('auto'));

  let rangeDays = 7;
  let projectFilter = null;
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  const usd = (v) => `$${(v || 0).toFixed(2)}`;
  const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n || 0)));
  // Tooltips follow the cursor inside their own chart box.
  function attachTip(node, wrap, tip, text) {
    node.addEventListener('mousemove', (e) => {
      const box = wrap.getBoundingClientRect();
      tip.hidden = false;
      tip.textContent = text;
      tip.style.left = `${e.clientX - box.left}px`;
      tip.style.top = `${e.clientY - box.top}px`;
    });
    node.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  $('range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    rangeDays = Number(b.dataset.days);
    Array.from($('range').children).forEach((x) => x.classList.toggle('on', x === b));
    renderStats();
  });
  $('export-json').addEventListener('click', () => window.lightsApi.exportStats('json', rangeDays));
  $('export-csv').addEventListener('click', () => window.lightsApi.exportStats('csv', rangeDays));
  $('filter-note').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { projectFilter = null; renderStats(); } });

  // Today's hero number plus how it compares with the daily average.
  function setHero(id, text, field, format, goodUp, eps) {
    $(id).textContent = text;
    const d = $(`${id}-d`);
    if (!field.hasAverage) { d.className = 'd'; d.textContent = 'no earlier days yet'; return; }
    const diff = field.delta;
    if (Math.abs(diff) <= eps) { d.className = 'd'; d.textContent = `on par with ${format(field.average)} avg`; return; }
    const up = diff > 0;
    d.className = `d ${up === goodUp ? 'up' : 'down'}`;
    d.innerHTML = `<span class="arrow">${up ? '▲' : '▼'}</span> ${escape(format(Math.abs(diff)))} vs ${escape(format(field.average))} avg`;
  }

  // Time first so the page is never blocked on reading costs, then again once the
  // costs are in — fetching them also snapshots each day's spend into stats.
  async function renderStats() {
    const sum = await window.lightsApi.getStats(rangeDays);
    if (!sum) return;
    paintStats(sum, null);
    const costs = await window.lightsApi.getCosts();
    paintStats(await window.lightsApi.getStats(rangeDays) || sum, costs);
  }

  function paintStats(sum, costs) {
    const { days, projects, totals } = sum;
    if (projectFilter && !projects.some((p) => p.name === projectFilter)) projectFilter = null;

    // ── Today strip
    setHero('today-working', S.fmt(sum.today.working.value), sum.today.working, S.fmt, true, 60000);
    setHero('today-waiting', S.fmt(sum.today.waiting.value), sum.today.waiting, S.fmt, false, 60000);
    setHero('today-cost', usd(sum.today.cost.value), sum.today.cost, usd, false, 0.005);

    $('stats-range-title').textContent = `Last ${rangeDays} days`;
    const note = $('filter-note');
    note.hidden = !projectFilter;
    if (projectFilter) note.innerHTML = `Bars filtered to ${escape(projectFilter)}<button type="button">clear</button>`;
    const resp = totals.response;
    $('stats-totals').textContent = [
      `${S.fmt(totals.working)} working`,
      `${S.fmt(totals.waiting)} waiting on you`,
      `${S.fmt(totals.idle)} idle`,
      resp.count ? `${resp.count} prompts, ${S.fmtShort(resp.median)} median reply` : 'no permission prompts',
    ].join(' · ');

    // ── Stacked bars
    const svg = $('chart');
    svg.querySelectorAll(':scope > :not(defs):not(title)').forEach((n) => n.remove());
    const W = 640, H = 200, padL = 8, padR = 8, padT = 22, padB = 22;
    const innerH = H - padT - padB;
    const colW = (W - padL - padR) / days.length;
    const barW = Math.max(2, Math.min(44, colW * 0.62));
    const series = projectFilter
      ? [['working', '#2fae3e'], ['waiting', 'url(#hatch)']]
      : [['working', '#2fae3e'], ['waiting', 'url(#hatch)'], ['idle', '#3c3846']];
    const val = (d, k) => (projectFilter ? (d.projects[projectFilter] || {})[k] || 0 : d[k]);
    const stack = (d) => series.reduce((a, [k]) => a + val(d, k), 0);
    const max = Math.max(60 * 60000, ...days.map(stack));
    // recessive grid: baseline + one mid line
    svg.appendChild(svgEl('line', { class: 'grid', x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH }));
    svg.appendChild(svgEl('line', { class: 'grid', x1: padL, x2: W - padR, y1: padT + innerH / 2, y2: padT + innerH / 2, 'stroke-dasharray': '2 4' }));
    svg.appendChild(svgEl('text', { x: padL + 2, y: padT + innerH / 2 - 4 }, S.fmt(max / 2)));
    const tip = $('chart-tip');
    const every = days.length > 30 ? 7 : days.length > 14 ? 3 : 1;
    days.forEach((d, i) => {
      const cx = padL + colW * i + colW / 2;
      let y = padT + innerH;
      const total = stack(d);
      // fixed order bottom→top: working, waiting, idle; 2px surface gap between fills
      for (const [k, fill] of series) {
        const h = (val(d, k) / max) * innerH;
        if (h < 1) continue;
        const gap = y === padT + innerH ? 0 : 2;
        const rect = svgEl('rect', { class: 'seg', x: cx - barW / 2, y: y - h, width: barW, height: Math.max(1, h - gap), fill, rx: 2 });
        attachTip(rect, $('chart'), tip, `${d.date} · ${k === 'waiting' ? 'Waiting on you' : k[0].toUpperCase() + k.slice(1)} ${S.fmt(val(d, k))}${projectFilter ? ` · ${projectFilter}` : ''}`);
        svg.appendChild(rect);
        y -= h;
      }
      if ((days.length - 1 - i) % every === 0) svg.appendChild(svgEl('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, days.length > 14 ? d.date : d.label));
      if (total > 0 && days.length <= 14) svg.appendChild(svgEl('text', { class: 'total', x: cx, y: y - 6, 'text-anchor': 'middle' }, S.fmt(total)));
    });

    // ── Per-project cards
    const costByProject = {};
    for (const p of (costs && costs.available && costs.projects) || []) costByProject[p.name] = p;
    const cards = $('project-cards');
    cards.innerHTML = '';
    if (!projects.length) cards.innerHTML = '<div class="stats-sub">No project time recorded yet — it accrues while sessions run.</div>';
    for (const p of projects.slice(0, 12)) {
      const c = costByProject[p.name] || { cost: 0, tokens: 0 };
      const hours = p.working / 3600000;
      const tph = hours > 0.02 && c.tokens ? `${compact(c.tokens / hours)}/h` : '—';
      const spend = costs ? `${usd(c.cost)} · ` : '';
      const tokens = costs ? `${compact(c.tokens)} tokens · ${tph}` : 'tokens loading…';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `card${projectFilter === p.name ? ' on' : ''}`;
      btn.setAttribute('aria-pressed', String(projectFilter === p.name));
      const tools = (p.tools || []).map((t) => `<span class="tool${t.failed ? ' bad' : ''}" title="${escape(t.tool)}: ${t.count} calls, ${t.failed} failed">${escape(t.tool)} ${t.count}</span>`).join('');
      const recent = days.slice(-14);
      const pMax = Math.max(1, ...recent.map((d) => (d.projects[p.name] || {}).working || 0));
      const spark = recent.map((d) => {
        const v = (d.projects[p.name] || {}).working || 0;
        const h = v ? Math.max(2, Math.round((v / pMax) * 14)) : 1;
        return `<i style="height:${h}px;background:${v ? '#2fae3e' : 'var(--line)'}"></i>`;
      }).join('');
      btn.innerHTML = `<span class="cname" title="${escape(p.name)}">${escape(p.name)}</span>`
        + `<span class="cnums">${S.fmt(p.working)} · ${spend}${p.peak || 1} peak</span>`
        + `<span class="cnums">${tokens}</span>`
        + `<span class="spark">${spark}</span>`
        + (tools ? `<span class="ctools">${tools}</span>` : '');
      btn.addEventListener('click', () => { projectFilter = projectFilter === p.name ? null : p.name; renderStats(); });
      cards.appendChild(btn);
    }

    // ── Response time: worst as a whisker, median as a mark on it
    const rs = $('resp');
    rs.innerHTML = '';
    const RW = 320, RH = 92, rPadB = 16, rPadT = 8;
    const rInner = RH - rPadT - rPadB;
    const rCol = RW / days.length;
    const rMax = Math.max(60000, ...days.map((d) => d.response.worst));
    rs.appendChild(svgEl('line', { class: 'grid', x1: 0, x2: RW, y1: rPadT + rInner, y2: rPadT + rInner }));
    if (totals.response.count) rs.appendChild(svgEl('text', { x: 2, y: rPadT + 9 }, S.fmtShort(rMax)));
    const rtip = $('resp-tip');
    days.forEach((d, i) => {
      const cx = rCol * i + rCol / 2;
      const yOf = (ms) => rPadT + rInner - (ms / rMax) * rInner;
      if (d.response.count) {
        const line = svgEl('line', { class: 'worst', x1: cx, x2: cx, y1: rPadT + rInner, y2: yOf(d.response.worst) });
        rs.appendChild(line);
        const dot = svgEl('circle', { class: 'med', cx, cy: yOf(d.response.median), r: Math.max(2, Math.min(3.5, rCol / 4)) });
        rs.appendChild(dot);
        const txt = `${d.date} · ${d.response.count} prompt${d.response.count === 1 ? '' : 's'} · median ${S.fmtShort(d.response.median)} · worst ${S.fmtShort(d.response.worst)}`;
        attachTip(line, rs.parentElement, rtip, txt);
        attachTip(dot, rs.parentElement, rtip, txt);
      }
      if ((days.length - 1 - i) % every === 0 && days.length <= 14) rs.appendChild(svgEl('text', { x: cx, y: RH - 4, 'text-anchor': 'middle' }, d.label));
    });
    if (!totals.response.count) rs.appendChild(svgEl('text', { x: RW / 2, y: RH / 2, 'text-anchor': 'middle' }, 'No permission prompts in this range'));

    // ── Hourly heatmap, last 7 days
    const heat = $('heat');
    heat.innerHTML = '';
    const htip = $('heat-tip');
    const last7 = days.slice(-7);
    const hMax = Math.max(1, ...last7.flatMap((d) => d.hours));
    for (const d of last7) {
      const lab = document.createElement('div');
      lab.className = 'lab';
      lab.textContent = d.label;
      const row = document.createElement('div');
      row.className = 'row';
      d.hours.forEach((ms, h) => {
        const cell = document.createElement('div');
        cell.className = 'cellbox';
        if (ms > 0) cell.style.background = `rgba(218, 119, 86, ${(0.18 + 0.82 * (ms / hMax)).toFixed(3)})`;
        attachTip(cell, heat.parentElement, htip, `${d.date} ${String(h).padStart(2, '0')}:00 · ${S.fmt(ms)} working`);
        row.appendChild(cell);
      });
      heat.appendChild(lab);
      heat.appendChild(row);
    }
    const spacer = document.createElement('div');
    const hours = document.createElement('div');
    hours.className = 'hours';
    for (let h = 0; h < 24; h += 1) hours.appendChild(Object.assign(document.createElement('span'), { textContent: String(h) }));
    heat.appendChild(spacer);
    heat.appendChild(hours);

    // ── By project (ranked list) and the day table
    const ol = $('projects');
    ol.innerHTML = projects.length ? '' : '<li class="empty-small">No project time recorded yet — it accrues while sessions run.</li>';
    const top = projects.slice(0, 8);
    const maxP = top[0]?.ms || 1;
    for (const p of top) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="name" title="${escape(p.name)}">${escape(p.name)}</span><span class="ms">${S.fmt(p.ms)}</span><span class="bar"><i style="width:${Math.max(2, (p.ms / maxP) * 100)}%"></i></span>`;
      ol.appendChild(li);
    }
    const tb = $('days-table').querySelector('tbody');
    tb.innerHTML = '';
    for (const d of [...days].reverse().slice(0, 14)) {
      const tr = document.createElement('tr');
      const cost = d.cost != null ? usd(d.cost) : (costs && costs.available && costs.days[d.key] ? usd(costs.days[d.key].cost) : '—');
      tr.innerHTML = `<td title="${escape(d.key)}">${d.label}</td><td>${S.fmt(d.working)}</td><td>${S.fmt(d.waiting)}</td><td>${d.sessionsPeak}</td><td>${d.response.count ? S.fmtShort(d.response.median) : '—'}</td><td>${cost}</td>`;
      tb.appendChild(tr);
    }
    if (!costs) {
      // still loading — leave whatever the last pass showed
    } else if (!costs.available) {
      $('cost-totals').textContent = 'No Claude Code transcripts found, and ccusage isn\'t installed (npm i -g ccusage) — spend shows up here once either is available.';
      $('cost-projects').innerHTML = ''; $('cost-sessions').querySelector('tbody').innerHTML = '';
    } else {
      const todayKey = days[days.length - 1].key;
      const today = costs.days[todayKey]?.cost || 0;
      const week = Object.values(costs.days).reduce((a, d) => a + d.cost, 0);
      const models = [...new Set(Object.values(costs.days).flatMap((d) => d.models))].slice(0, 3).join(', ');
      $('cost-totals').textContent = `${usd(today)} today · ${usd(week)} this week${models ? ' · ' + models : ''}`;
      const cl = $('cost-projects');
      cl.innerHTML = costs.projects.length ? '' : '<li class="empty-small">No session costs in the last week.</li>';
      const maxC = costs.projects[0]?.cost || 1;
      for (const p of costs.projects.slice(0, 6)) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="name" title="${escape(p.name)}">${escape(p.name)}</span><span class="ms">${usd(p.cost)} · ${compact(p.tokens)}t</span><span class="bar"><i style="width:${Math.max(2, (p.cost / maxC) * 100)}%;background:#f2a200"></i></span>`;
        cl.appendChild(li);
      }
      const st = $('cost-sessions').querySelector('tbody');
      st.innerHTML = '';
      for (const x of costs.sessions) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td title="${escape(x.id)}">${escape(x.id.slice(0, 8))}</td><td>${escape(x.project)}</td><td>${usd(x.cost)}</td>`;
        st.appendChild(tr);
      }
    }
  }

  // ── Model mix view (read-only) ─────────────────────────────────────────
  const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : usd(v));
  const MODEL_NAMES = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
  const plural = (n, w) => `${Number(n || 0).toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

  function paintMixWindow(id, w) {
    $(`mix-${id}-cost`).textContent = money(w.cost);
    $(`mix-${id}-turns`).textContent = plural(w.turns, 'turn');
    const max = Math.max(...w.models.map((m) => m.cost), 0.0001);
    $(`mix-${id}`).innerHTML = w.models.length ? w.models.map((m) => `<li><span class="name">${escape(MODEL_NAMES[m.name] || m.name)}</span><span class="ms">${Math.round(m.share * 100)}% of turns · ${money(m.cost)}</span><span class="bar"><i style="width:${Math.max(2, (m.cost / max) * 100)}%"></i></span></li>`).join('')
      : '<li class="empty-small">No turns yet.</li>';
  }

  // The history section: drawn from the permanent record (usage-view.js).
  let usageView = null;
  let usageAt = 0;
  function renderUsageHistory(force) {
    if (!window.UsageView) return;
    // the tab redraws on every hook burst; the charts only need it now and then
    if (!force && usageView && Date.now() - usageAt < 15000) return;
    usageAt = Date.now();
    const q = new URLSearchParams(location.search).get('now');
    if (!usageView) usageView = window.UsageView.mount($('usage-history'), { api: window.lightsApi, ...(q ? { now: () => Number(q) } : {}) });
    usageView.refresh();
  }

  async function renderMix() {
    renderUsageHistory();
    const mix = await window.lightsApi.modelMix();
    if (!mix) return;
    $('mix-loading').hidden = true;
    $('mix-empty').hidden = mix.week.turns > 0;
    $('mix-body').hidden = !mix.week.turns;
    if (mix.week.turns) {
      paintMixWindow('today', mix.today);
      paintMixWindow('week', mix.week);
      $('mix-rec').textContent = mix.recommendation;
    }
  }

  // Follows the hooks, at most every 3 s.
  let mixRefreshAt = 0;
  let mixRefreshTimer = null;
  function refreshMixLive() {
    if (mixRefreshTimer) return;
    mixRefreshTimer = setTimeout(() => { mixRefreshTimer = null; mixRefreshAt = Date.now(); renderMix(); }, Math.max(0, mixRefreshAt + 3000 - Date.now()));
  }

  // ── Accessibility layer ────────────────────────────────────────────────
  // Roles, names and pressed/selected state are derived from the visual state
  // (`.on`) so the many render paths that toggle it stay screen-reader-true.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let a11yQueued = false;
  function a11yPass() {
    a11yQueued = false;
    document.querySelectorAll('[role="tablist"]').forEach((tl) => {
      const tabs = [...tl.querySelectorAll('[role="tab"]')];
      const cur = tabs.find((t) => t.classList.contains('on')) || tabs[0];
      tabs.forEach((t) => { t.setAttribute('aria-selected', String(t === cur && t.classList.contains('on'))); t.tabIndex = t === cur ? 0 : -1; });
    });
    document.querySelectorAll('.seg[role="group"] button, #editor .lampbtn, #editor .posebtn, #editor .signal').forEach((b) => b.setAttribute('aria-pressed', String(b.classList.contains('on'))));
    document.querySelectorAll('#editor button[title]:not(#sound-file):not(#sound-play)').forEach((b) => { if (!b.hasAttribute('aria-label') && b.title) b.setAttribute('aria-label', b.title); });
    document.querySelectorAll('#editor input[type="color"]').forEach((i) => { const t = i.closest('.swatch')?.title; if (t) i.setAttribute('aria-label', t); });
  }
  const queueA11y = () => { if (!a11yQueued) { a11yQueued = true; queueMicrotask(a11yPass); } };
  function initA11y() {
    document.querySelectorAll('#editor .row').forEach((row, n) => {
      const lbl = row.querySelector(':scope > .lbl');
      const field = row.querySelector(':scope > .field');
      if (!lbl || !field) return;
      lbl.id = lbl.id || `lbl-${n}`;
      field.querySelectorAll('input[type="text"], select').forEach((c) => { if (!c.hasAttribute('aria-label') && !c.hasAttribute('aria-labelledby')) c.setAttribute('aria-labelledby', lbl.id); });
      if (field.querySelector('button, input[type="color"]')) { field.setAttribute('role', 'group'); field.setAttribute('aria-labelledby', lbl.id); }
    });
    $('sound-file').setAttribute('aria-label', 'Use your own audio file for this rule');
    $('sound-play').setAttribute('aria-label', 'Play the sound');
    // The live previews toggle classes on every animation frame and garden
    // tick; none of that is a11y state, and a pass per toggle cost ~25 ms.
    const mo = new MutationObserver((records) => { if (records.some((r) => !r.target.closest?.('svg.rig'))) queueA11y(); });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    document.addEventListener('keydown', (e) => {
      const tab = e.target.closest?.('[role="tab"]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')].filter(t => t.getClientRects().length);
      const i = tabs.indexOf(tab);
      const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      e.preventDefault(); next.focus(); next.click();
    });
    document.querySelectorAll('#jump button').forEach((b) => b.addEventListener('click', () => {
      const t = $(b.dataset.jump);
      if (t) t.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }));
    queueA11y();
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  (async () => {
    $('tool-list').innerHTML = R.TOOL_SUGGESTIONS.map((t) => `<option value="${t}">`).join('');
    config = await window.lightsApi.getConfig();
    rules = config.rules.map(R.normalizeRule);
    templateId = config.template || null;
    const q = new URLSearchParams(location.search);
    selectedId = (q.get('select') && rules.find((r) => r.id === q.get('select'))?.id) || rules[0]?.id || null;
    if (q.get('mode') === 'live') previewMode = 'live';
    if (embeddedView) setView(embeddedView);
    else if (['stats', 'mix', 'auto'].includes(q.get('view'))) setView(q.get('view'));
    if (q.get('event')) setTimeout(() => stage.playEvent(q.get('event')), 100);
    if (q.get('scroll')) setTimeout(() => { ({ stats: $('stats'), mix: $('mix') }[q.get('view')] || $('editor')).scrollTop = Number(q.get('scroll')); }, q.get('view') === 'mix' ? 3000 : 400);
    setDirty(false);
    if (!embeddedView) {
      await loadCameos();
      renderList(); renderEditor(); renderStage();
      refreshLive();
    }
    initA11y();
    // Dev: ?pose=<p> forces the stage into a pose for screenshots.
    if (q.get('pose')) { document.querySelector('#stage .rig-wrap').classList.toggle('wide', q.get('effect') === 'garden'); stage.setLook({ lamp: 'amber', gardenSpeed: Number(q.get('speed') || 30), eyes: q.get('eyes') || 'default', pose: q.get('pose'), text: q.get('text') || null, costume: q.get('costume') || 'none', cameo: q.get('cameo') || 'none', lampFx: q.get('lampfx') || 'none', sign: q.get('sign') || 'h3', lampShape: q.get('shape') || 'square', signFx: q.get('signfx') || 'none', number: q.get('number') ? Number(q.get('number')) : null, body: q.get('body') || 'claude', effect: q.get('effect') || 'none', pet: q.get('pet') || 'none', waitMinutes: 25, smokeCycleMs: Number(q.get('fastSmoke')) || undefined }); stageFire(q.get('pose')); $('caption').textContent = `pose: ${q.get('pose')}${q.get('costume') ? ' · ' + q.get('costume') : ''}${q.get('cameo') ? ' · ' + q.get('cameo') : ''}`; }
  })();
