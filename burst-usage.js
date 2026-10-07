// "Through Burst" section on the Usage page. Receives only the view model from
// main (src/burst-spend.js throughBurstView); null when Burst is absent, which
// leaves the section out. Secondary-provider spend is shown on its own and the
// source is named; it is never added to the Claude figures above it.
(() => {
  const api = window.lightsApi && window.lightsApi.burstUsage ? window.lightsApi : null;
  const after = document.getElementById('usage-history');
  if (!api || !after) return;
  const sec = document.createElement('section');
  sec.id = 'burst-usage';
  sec.hidden = true;
  sec.setAttribute('aria-label', 'Through Burst');
  after.after(sec);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const usd = (v) => `$${v >= 100 ? Math.round(v) : v.toFixed(2)}`;
  const reqs = (n) => `${n.toLocaleString('en-US')} request${n === 1 ? '' : 's'}`;

  function draw(v, codex) {
    sec.hidden = !v;
    if (!v) return;
    sec.replaceChildren(el('h3', 'Through Burst'), el('div', `Source: ${v.source}`, 'note'));
    if (v.empty) sec.append(el('div', `No secondary-provider spend in the last ${v.range || '7d'}.`, 'note'));
    else {
      sec.append(el('div', `Backup providers: ${usd(v.secondaryUsd)}${v.unpriced ? '+' : ''} across ${reqs(v.secondaryRequests)}`));
      const list = el('ul');
      for (const p of v.providers) list.append(el('li', `${p.key}: ${usd(p.usd)}${p.unpriced ? '+' : ''} · ${reqs(p.requests)}`));
      sec.append(list);
      if (v.repos.length) {
        const rl = el('ul');
        for (const r of v.repos) rl.append(el('li', `${r.key}: ${usd(r.usd)}`));
        sec.append(el('div', 'By repository', 'note'), rl);
        if (v.reposNote) sec.append(el('div', v.reposNote, 'note'));
      }
    }
    if (v.planRequests) sec.append(el('div', `${reqs(v.planRequests)} on your Claude plan went through Burst. They are counted in the Claude figures above, not here.`, 'note'));
    sec.append(el('div', v.note, 'note'));
    if (codex) {
      sec.append(el('h4', 'Codex'), el('div', `${reqs(codex.requests)}${codex.tokens ? ` · ${codex.tokens.toLocaleString('en-US')} tokens` : ''}${codex.usd ? ` · ${usd(codex.usd)}` : ''}`));
      if (codex.groups.length) {
        const cl = el('ul');
        for (const g of codex.groups) cl.append(el('li', `${g.key}: ${reqs(g.requests)}${g.usd ? ` · ${usd(g.usd)}` : ''}`));
        sec.append(cl);
      }
      sec.append(el('div', codex.note, 'note'));
    }
  }

  let timer = null;
  async function poll() {
    clearTimeout(timer);
    if (document.visibilityState !== 'visible') return;
    let next = 30000;
    try {
      const r = await api.burstUsage('7d');
      draw(r && r.view, r && r.codex);
      next = r && r.nextPollMs;
      if (!next) return;
    } catch { /* retry slowly */ }
    timer = setTimeout(poll, Math.max(next, 15000));
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); else clearTimeout(timer); });
  poll();
})();
