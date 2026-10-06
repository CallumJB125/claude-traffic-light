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
      if (a.kind !== 'open-dashboard') b.addEventListener('mouseenter', () => showConsent(a.kind));
      b.addEventListener('focus', () => { if (a.kind !== 'open-dashboard') showConsent(a.kind); });
      b.addEventListener('click', async () => {
        if (a.kind !== 'open-dashboard') await showConsent(a.kind);
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

  new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) poll(); else clearTimeout(timer);
  }).observe(card);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); else clearTimeout(timer); });
})();
