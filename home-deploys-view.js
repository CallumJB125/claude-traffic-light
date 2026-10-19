'use strict';
// Home's "Deploys" section (src/deploy-status-main.js decides what it holds):
// one row per project and host with building / live / failed. A failed row
// explains the error in plain words and can copy a ready prompt for Claude.
// Text goes in with textContent only; main resolves the opaque handle.
(() => {
  const api = window.homeApi;
  const section = document.getElementById('deploys');
  if (!api || !api.deploys || !section) return;
  const out = section.querySelector('.body');
  const status = document.getElementById('status');
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const WORD = { building: 'Building…', live: 'Live', failed: 'Failed', canceled: 'Canceled', none: 'No deploys yet', unknown: 'Checking…' };
  let busy = false;

  async function act(action, handle, control) {
    if (busy) return;
    busy = true; control.disabled = true;
    let r;
    try { r = await api.deployAct(action, handle); } catch { r = { ok: false }; }
    busy = false; control.disabled = false;
    if (r && (r.note || r.error)) status.textContent = r.note || r.error;
  }
  function row(d) {
    const li = node('li', null, `deploy ${d.state}`);
    const text = node('div');
    text.append(node('strong', `${d.folder} · ${d.label}`, 'title'), node('p', d.problem || WORD[d.state] || d.state, 'muted'));
    if (d.summary) text.append(node('p', d.summary));
    for (const c of d.checks || []) text.append(node('p', `Before you deploy: ${c.text}`, 'muted'));
    const actions = node('div', '', 'actions');
    const button = (label, action, primary) => { const b = node('button', label, primary ? 'primary' : ''); b.type = 'button'; b.addEventListener('click', () => void act(action, d.handle, b)); actions.append(b); };
    if (d.state === 'failed') button('Send this error to Claude', 'copy-prompt', true);
    if (d.state === 'live' && d.url) button('Open site', 'open');
    li.append(text, actions);
    return li;
  }
  function render(s) {
    const rows = (s && Array.isArray(s.rows)) ? s.rows : [];
    section.hidden = !rows.length;
    if (!rows.length) return out.replaceChildren();
    const list = node('ul'); list.setAttribute('aria-label', 'Deploys for your open projects');
    rows.forEach((d) => list.append(row(d)));
    out.replaceChildren(list);
  }
  async function refresh() {
    if (document.hidden || busy) return;
    let s;
    try { s = await api.deploys(); } catch { s = null; }
    render(s);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  setInterval(() => void refresh(), 10000);
  void refresh();
})();
