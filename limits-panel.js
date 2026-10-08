// "Limits" on the Usage page: known usage-limit reset times per provider, from
// main's src/limit-resets.js panel(). A provider with no known time says so.
(() => {
  const api = window.lightsApi && window.lightsApi.limits ? window.lightsApi : null;
  const after = document.getElementById('usage-history');
  if (!api || !after) return;
  const sec = document.createElement('section');
  sec.id = 'usage-limits';
  sec.hidden = true;
  sec.setAttribute('aria-label', 'Limits');
  after.after(sec);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

  function draw(v) {
    sec.hidden = !v;
    if (!v) return;
    const list = el('ul');
    for (const r of v.rows) list.append(el('li', `${r.label}: ${r.text}${r.source ? ` (${r.source})` : ''}`, r.status === 'limited' ? 'limited' : null));
    sec.replaceChildren(el('h3', 'Limits'), list);
    if (v.models.length) {
      const ml = el('ul');
      for (const m of v.models) ml.append(el('li', m.text));
      sec.append(el('div', 'Models Claude Burst is routing around', 'note'), ml);
    }
    sec.append(el('div', v.note, 'note'));
  }

  async function load() {
    if (document.hidden) return;
    try { draw(await api.limits()); } catch { draw(null); }
  }
  document.addEventListener('visibilitychange', load);
  setInterval(load, 30000);
  load();
})();
