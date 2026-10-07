// Burst card on the Settings page. The main process owns detection, consent
// and every command; this only renders a normalized view model. It polls only
// while the card is on screen, at the interval main asks for (it backs off).
(() => {
  const $ = (id) => document.getElementById(id);
  const card = $('burst-card');
  if (!card || !window.settingsApi || !window.settingsApi.burstStatus) return;
  let timer = null;
  let visible = false;
  let view = null;
  const NO_CONSENT = new Set(['open-dashboard', 'open-browser']);

  const EXPLAIN = 'Keeps long Claude Code sessions going without the pause: Burst summarises the old part in the background and swaps it in. It can raise cost slightly when a summary is made; savings shown below.';
  const fmtTokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  let boxId = 0;

  // One Pauseless compaction section; the Burst card and the Compactor preferences each get one.
  function pauselessBox(host) {
    const name = `pauseless-mode-${boxId++}`;
    const el = (tag, parent, text = '', cls = '') => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; parent.append(n); return n; };
    el('div', host, 'Pauseless compaction', 'group-label');
    const sw = el('label', host, '', 'row');
    const toggle = el('input', sw);
    toggle.type = 'checkbox';
    toggle.setAttribute('role', 'switch');
    const state = el('span', sw);
    const seg = el('div', host, '', 'row');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Compaction mode');
    const radios = {};
    for (const [value, label] of [['fixed', 'Static'], ['intelligent', 'Smart']]) {
      const l = el('label', seg, '', 'row');
      const r = el('input', l);
      r.type = 'radio'; r.name = name; r.value = value;
      l.append(label);
      radios[value] = r;
    }
    el('div', host, EXPLAIN, 'hint');
    const threshold = el('div', host, '', 'hint');
    const stats = el('div', host, '', 'hint');
    stats.setAttribute('role', 'status');
    const note = el('div', host, '', 'hint');
    const confirm = el('div', host);
    confirm.hidden = true;
    const confirmText = el('div', confirm, '', 'hint');
    const yes = el('button', confirm, 'Turn on');
    const no = el('button', confirm, 'Cancel', 'secondary');
    yes.type = no.type = 'button';
    const off = el('button', host, 'Turn off', 'secondary');
    off.type = 'button';
    const result = el('div', host, '', 'hint');
    result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite');
    let current = null;

    async function apply(req) {
      result.textContent = '';
      const r = await window.settingsApi.burstSetCompaction(req).catch(() => ({ ok: false, error: 'Something went wrong.' }));
      if (r && r.needsConfirm) { confirmText.textContent = r.text; confirm.hidden = false; return; }
      confirm.hidden = true;
      if (!r || !r.ok) { result.textContent = (r && r.error) || 'Something went wrong.'; if (current) update(current); return; }
      if (r.view) render(r.view); else poll();
    }

    toggle.addEventListener('change', () => {
      if (toggle.checked) { toggle.checked = false; apply({ enabled: true }); } else apply({ enabled: false });
    });
    for (const r of Object.values(radios)) r.addEventListener('change', () => { if (r.checked) apply({ enabled: current.enabled, mode: r.value }); });
    off.addEventListener('click', () => apply({ enabled: false }));
    yes.addEventListener('click', () => apply({ enabled: true, confirmed: true }));
    no.addEventListener('click', () => { confirm.hidden = true; });

    function update(c) {
      current = c;
      host.hidden = !c;
      if (!c) return;
      toggle.checked = c.enabled;
      state.textContent = c.enabled ? 'On' : 'Off';
      radios.fixed.checked = c.mode === 'fixed';
      radios.intelligent.checked = c.mode === 'intelligent';
      threshold.textContent = c.thresholdLabel;
      stats.textContent = c.compactions
        ? `${c.compactions} ${c.compactions === 1 ? 'compaction' : 'compactions'} \u00b7 saved ~$${c.savedUsd.toFixed(2)} \u00b7 ${fmtTokens(c.tokensNotResent)} tokens not resent`
        : 'No compactions yet.';
      note.textContent = c.enabled ? 'Plexiform\'s own Claude compactor is off while this is on.' : '';
      off.disabled = !c.enabled;
      if (c.enabled) confirm.hidden = true;
    }
    return { update };
  }

  const boxes = [...document.querySelectorAll('.pauseless')].map((h) => pauselessBox(h));

  const mode = () => (document.querySelector('input[name="burst-mode"]:checked') || {}).value || 'base-url';

  function renderConsent(c) {
    const box = $('burst-consent-box');
    const body = $('burst-consent');
    body.textContent = '';
    if (!c) { box.hidden = true; return; }
    const add = (tag, text) => { const n = document.createElement(tag); n.textContent = text; body.append(n); return n; };
    for (const t of c.what) add('div', t).className = 'hint';
    if (c.changes.length) {
      add('div', c.changesHeading).className = 'group-label';
      const ul = document.createElement('ul');
      for (const t of c.changes) { const li = document.createElement('li'); li.textContent = t; ul.append(li); }
      body.append(ul);
    }
    if (c.terms) add('div', c.terms).className = 'hint';
    add('div', c.undo).className = 'hint';
    add('div', `Terminal will run: ${c.command}`).className = 'hint';
    box.hidden = false;
  }

  async function showConsent(kind) {
    renderConsent(await window.settingsApi.burstConsent(kind, mode()).catch(() => null));
  }

  function render(v) {
    view = v;
    for (const b of boxes) b.update(v.compaction);
    $('burst-headline').textContent = v.headline;
    $('burst-chip').textContent = v.chip ? v.chip.label : '';
    $('burst-detail').textContent = v.detail;
    $('burst-modes').hidden = !v.actions.some((a) => a.modes);
    const box = $('burst-actions');
    box.textContent = '';
    for (const a of v.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (!a.primary) b.className = 'secondary';
      if (!NO_CONSENT.has(a.kind)) b.addEventListener('mouseenter', () => showConsent(a.kind));
      b.addEventListener('focus', () => { if (!NO_CONSENT.has(a.kind)) showConsent(a.kind); });
      b.addEventListener('click', async () => {
        if (!NO_CONSENT.has(a.kind)) await showConsent(a.kind);
        const r = await window.settingsApi.burstAction({ kind: a.kind, mode: mode() }).catch(() => ({ ok: false, error: 'Something went wrong.' }));
        $('burst-result').textContent = r.cancelled ? 'Cancelled. Nothing changed.' : r.ok ? 'Started in Terminal. This card updates when Burst answers.' : (r.error || '');
        poll();
      });
      box.append(b);
    }
  }

  async function poll() {
    clearTimeout(timer);
    if (!visible || document.visibilityState !== 'visible') return;
    let next = 5000;
    try {
      const v = await window.settingsApi.burstStatus();
      if (v) { render(v); next = v.nextPollMs || 0; }
    } catch { next = 30000; }
    if (next > 0) timer = setTimeout(poll, next);
  }

  const seen = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); }
    visible = seen.size > 0;
    if (visible) poll(); else clearTimeout(timer);
  });
  io.observe(card);
  const compactorHeading = document.querySelector('.field.pauseless')?.previousElementSibling;
  if (compactorHeading) io.observe(compactorHeading);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); else clearTimeout(timer); });
})();
