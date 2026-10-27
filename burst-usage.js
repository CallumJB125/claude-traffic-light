// "Through Burst" section on the Usage page. Receives only the view model from
// main (src/burst-spend.js throughBurstView); null when Burst is absent, which
// leaves the section out. Secondary-provider spend is shown on its own and the
// source is named; it is never added to the Claude figures above it.
(() => {
  const api = window.lightsApi && window.lightsApi.burstUsage ? window.lightsApi : null;
  const after = document.getElementById('usage-history');
  if (!api || !after || window.lightsRulesPane) return; // not in the Settings sheet's rules pane (it may not call the Usage channels)
  const sec = document.createElement('section');
  sec.id = 'burst-usage';
  sec.hidden = true;
  sec.setAttribute('aria-label', 'Through Burst');
  after.after(sec);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const usd = (v) => `$${v >= 100 ? Math.round(v) : v.toFixed(2)}`;
  const RANGES = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
  const reqs = (n) => `${n.toLocaleString('en-US')} request${n === 1 ? '' : 's'}`;

  // Burst's own 14-day buckets: request counts by slot, backup-provider dollars, and per-repository
  // compaction savings. Plan traffic stays a count; its API-equivalent dollars are not shown.
  function drawHistory(h) {
    const days = h.days.filter((d) => d.day);
    if (days.some((d) => d.requests)) {
      const max = Math.max(...days.map((d) => d.requests), 1);
      const total = days.reduce((n, d) => n + d.requests, 0);
      const backup = days.reduce((n, d) => n + d.secondaryRequests, 0);
      const strip = el('div', null, 'burst-days');
      strip.setAttribute('role', 'img');
      strip.setAttribute('aria-label', `${reqs(total)} through Burst over ${days.length} days, ${reqs(backup)} to backup providers`);
      Object.assign(strip.style, { display: 'flex', alignItems: 'flex-end', gap: '2px', height: '40px', margin: '4px 0' });
      for (const d of days) {
        const col = el('div');
        col.title = `${d.day}: ${reqs(d.requests)}${d.secondaryRequests ? `, ${d.secondaryRequests.toLocaleString('en-US')} to backup providers (${usd(d.secondaryUsd)})` : ''}`;
        Object.assign(col.style, { flex: '1', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' });
        const plan = Math.max(0, d.requests - d.secondaryRequests);
        const top = el('div'); Object.assign(top.style, { height: `${(d.secondaryRequests / max) * 100}%`, background: '#c98500' });
        const bottom = el('div'); Object.assign(bottom.style, { height: `${(plan / max) * 100}%`, minHeight: d.requests ? '1px' : '0', background: 'currentColor', opacity: '0.45' });
        col.append(top, bottom);
        strip.append(col);
      }
      sec.append(el('h4', `Last ${days.length} days`), strip, el('div', `${reqs(total)}; ${reqs(backup)} went to backup providers (top of each bar).`, 'note'));
    }
    const compacted = h.repos.filter((r) => r.repo && r.compacted && r.netSavedUsd);
    if (compacted.length) {
      const sl = el('ul');
      for (const r of compacted) sl.append(el('li', `${r.repo}: ${r.netSavedUsd > 0 ? `${usd(r.netSavedUsd)} saved` : `cost ${usd(-r.netSavedUsd)} more than it saved`}${r.requests ? ` · ${reqs(r.requests)}` : ''}`));
      sec.append(el('div', 'Burst compaction by repository, after the cost of its summaries (API-equivalent, last 14 days)', 'note'), sl);
    }
  }

  function draw(v, codex, history) {
    sec.hidden = !v;
    if (!v) return;
    sec.replaceChildren(el('h3', 'Through Burst'), el('div', `These figures come from Claude Burst's own log of the requests it carried, not from Plexiform's reading of your transcripts above. Source: ${v.source}.`, 'note'));
    if (v.empty) sec.append(el('div', `No backup-provider spend in the last ${RANGES[v.range] || '7 days'}: everything went to your Claude plan.`, 'note'));
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
    if (v.unpricedRequests) sec.append(el('div', `${v.unpricedRequests.toLocaleString('en-US')} of ${reqs(v.totalRequests || v.unpricedRequests)} could not be priced (Burst has no price for their model), so any dollar figure from Burst here is a lower bound.`, 'note'));
    if (v.planRequests) sec.append(el('div', `${reqs(v.planRequests)} on your Claude plan went through Burst. They are counted in the Claude figures above, not here.`, 'note'));
    sec.append(el('div', v.note, 'note'));
    if (history) drawHistory(history);
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
      draw(r && r.view, r && r.codex, r && r.history);
      next = r && r.nextPollMs;
      if (!next) return;
    } catch { /* retry slowly */ }
    timer = setTimeout(poll, Math.max(next, 15000));
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); else clearTimeout(timer); });
  poll();
})();
