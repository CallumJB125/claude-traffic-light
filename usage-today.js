'use strict';
// Usage › Today (redesign R7-2, chat-first preview only): what Home's Today, Savings and My day cards showed, and the
// digest with copy, save and email. textContent only; numbers and short texts from main (src/usage-today-main.js).
(() => {
  const api = window.todayApi;
  const $ = (id) => document.getElementById(id);
  if (!api || !$('td')) return;
  const REFRESH_MS = 15000, DIGEST_MS = 60000;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const button = (label, onClick, className) => { const b = node('button', label, className); b.type = 'button'; b.addEventListener('click', onClick); return b; };
  const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${Number(v).toFixed(2)}`);
  const minutes = (ms) => (ms < 60000 ? 'under a minute' : ms < 3600000 ? `${Math.floor(ms / 60000)} min` : `${Math.floor(ms / 3600000)} h ${Math.floor(ms / 60000) % 60} min`);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const tile = (big, small) => { const t = node('div', null, 'td-tile'); t.append(node('strong', big), node('span', small)); return t; };

  function render(s) {
    const t = s?.today;
    const sp = t?.spend, eq = sp?.equivalent ? ' (API-price equivalent)' : '';
    $('td-tiles').replaceChildren(
      sp ? tile(money(sp.spent ?? 0), sp.budget > 0 ? `of ${money(sp.budget)} daily limit${eq}` : `spent today, no daily limit${eq}`) : tile('–', 'No spend recorded yet'),
      tile(String(t?.running ?? 0), 'running now'),
      tile(t?.longestWaitMs == null ? 'None' : minutes(t.longestWaitMs), 'longest wait for you'),
    );
    const c = s?.costs;
    $('td-costs').hidden = !c;
    if (c) {
      const parts = [];
      if (c.receipt) parts.push(node('p', `${c.receipt.month}: ${c.receipt.headline}`));
      if (c.enforce) parts.push(node('p', c.enforce.status, 'td-muted'));
      if (c.waste) parts.push(node('p', c.waste.count ? `${plural(c.waste.count, 'possible saving')}${c.waste.top ? `. Top: ${c.waste.top}` : ''}` : 'No waste found lately.', 'td-muted'));
      $('td-costs-body').replaceChildren(...parts);
    }
    const m = s?.myDay;
    $('td-myday').hidden = !m;
    if (m) {
      const row = node('div', null, 'td-tiles');
      row.append(tile(String(m.decisions), plural(m.decisions, 'team decision').replace(/^\d+ /, '')), tile(String(m.cards), plural(m.cards, 'card').replace(/^\d+ /, '') + ' for you'));
      const go = node('div', null, 'td-actions');
      go.append(button('Open Team', () => void api.open('team')), button('Open Board', () => void api.open('board')));
      $('td-myday-body').replaceChildren(row, ...(m.unavailable ? [node('p', 'Some boards could not be read just now.', 'td-muted')] : []), go);
    }
    $('td-empty').hidden = !(s && s.empty);
  }

  async function refresh() {
    let s;
    try { s = await api.state(); } catch { s = null; }
    if (s) render(s);
    $('td').setAttribute('aria-busy', 'false');
  }

  // ── digest ──
  let period = 'day', gen = 0;
  const say = (text) => { $('td-digest-status').textContent = text || ''; };
  async function act(fn, done) {
    try { const r = await fn(); if (r && r.ok === false) { if (!r.canceled) say(r.error || 'That did not work.'); return; } say(done); }
    catch { say('That did not work. Try again in a moment.'); }
  }
  function renderDigest(d) {
    const out = $('td-digest-body');
    if (!d) return out.replaceChildren(node('p', 'Couldn’t build the digest just now. It tries again in a minute.', 'td-muted'));
    const parts = [node('p', d.title, 'td-digest-title')];
    for (const sec of d.sections || []) {
      parts.push(node('h3', sec.heading));
      if (sec.summary) parts.push(node('p', sec.summary, 'td-muted'));
      if (sec.items?.length) { const ul = node('ul', null, 'td-list'); sec.items.forEach((i) => ul.append(node('li', i))); parts.push(ul); }
    }
    out.replaceChildren(...parts);
  }
  async function loadDigest() {
    const mine = ++gen;
    let r;
    try { r = await api.digest.get(period); } catch { r = null; }
    if (mine === gen) renderDigest(r?.digest ?? null);
  }
  $('td-digest-actions').replaceChildren(
    button('Copy digest', () => act(() => api.digest.copy(period, 'text'), 'Copied.'), 'td-primary'),
    button('Copy as Markdown', () => act(() => api.digest.copy(period, 'markdown'), 'Copied as Markdown.')),
    button('Save as Markdown file', () => act(() => api.digest.save(period), 'Saved.')),
    button('Copy as email', () => act(() => api.digest.email(period), 'Opened in your mail app. Nothing is sent until you send it.')),
  );
  document.querySelectorAll('#td-digest [data-period]').forEach((b) => b.addEventListener('click', () => {
    period = b.dataset.period;
    document.querySelectorAll('#td-digest [data-period]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    void loadDigest();
  }));

  setInterval(() => { if (!document.hidden) void refresh(); }, REFRESH_MS);
  setInterval(() => { if (!document.hidden) void loadDigest(); }, DIGEST_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refresh(); void loadDigest(); } });
  void refresh();
  void loadDigest();
})();
