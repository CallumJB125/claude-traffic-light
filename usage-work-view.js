// The Usage & cost page's "Cost by work" card (src/work-cost.js through
// lightsApi.workCost): the ten costliest cards, branches and projects this
// week and this month, per tool, and a CSV export. Titles, branches and repo
// names are user data, so everything is textContent, never innerHTML.
//
//   UsageWorkView.render(container, api, { force })
(function () {
  const REFRESH_MS = 30000;
  let at = 0;
  let busy = false;
  let windowKey = 'week';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`);
  const unpricedText = (n) => `${n.toLocaleString('en-US')} request${n === 1 ? '' : 's'} could not be priced`;
  const KIND = { card: 'card', branch: 'no card', project: 'no card' };

  function row(r, max) {
    const li = el('li', 'wc-row');
    li.append(el('span', 'name', r.title));
    li.lastChild.title = r.title;
    li.append(el('span', 'ms', r.usd == null ? 'not priced' : `${money(r.usd)}${r.unpriced ? '+' : ''}`));
    const meta = [r.toolLabel, KIND[r.kind], r.branch && r.kind === 'card' ? r.branch : null, r.pr ? `PR #${r.pr.number}` : null,
      `${r.sessions} session${r.sessions === 1 ? '' : 's'}`, r.unpriced ? unpricedText(r.unpriced) : null].filter(Boolean).join(' · ');
    li.append(el('span', 'wc-meta', meta));
    const bar = el('span', 'bar');
    const fill = el('i');
    fill.style.width = `${r.usd ? Math.max(2, (r.usd / max) * 100) : 0}%`;
    bar.append(fill);
    li.append(bar);
    return li;
  }

  function card(data, api, rerender) {
    const w = data[windowKey];
    const box = el('section', 'mix-card wc-card');
    const head = el('div', 'wc-head');
    head.append(el('div', 'k', 'Cost by work'));
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Cost by work window');
    for (const k of ['week', 'month']) {
      const b = el('button', k === windowKey ? 'on' : '', data[k].label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(k === windowKey));
      b.addEventListener('click', () => { windowKey = k; rerender(); });
      seg.append(b);
    }
    const exp = el('button', 'btn ghost', 'Export CSV');
    exp.type = 'button';
    const status = el('span', 'wc-status');
    status.setAttribute('role', 'status');
    exp.addEventListener('click', async () => {
      exp.disabled = true;
      try {
        const r = await api.exportWorkCost();
        status.textContent = r && r.ok ? 'Saved.' : '';
      } catch { status.textContent = 'Could not save the file.'; }
      exp.disabled = false;
    });
    head.append(seg, exp, status);
    box.append(head);

    const total = el('div', 'v', `${money(w.total.usd)}${w.total.unpriced ? '+' : ''}`);
    const onCards = el('div', 'd', w.count ? `${money(w.total.onCards)} of it on board cards · ${w.count} piece${w.count === 1 ? '' : 's'} of work` : 'No AI work in this window yet.');
    box.append(total, onCards);
    if (w.byTool.length) {
      box.append(el('div', 'wc-tools', w.byTool.map((g) => `${g.label} ${g.usd == null ? 'not priced' : money(g.usd)}${g.unpriced ? ` (${unpricedText(g.unpriced)})` : ''}`).join(' · ')));
    }
    if (w.top.length) {
      const list = el('ol', 'projects wc-list');
      const max = Math.max(...w.top.map((r) => r.usd || 0), 0.0001);
      for (const r of w.top) list.append(row(r, max));
      box.append(list);
    }
    const notes = [data.basis];
    if (w.total.unpriced) notes.push(`${unpricedText(w.total.unpriced)} (a model with no known price), so these totals could be low.`);
    if (w.total.unpricedTools.length) notes.push(`${w.total.unpricedTools.join(', ')} work is listed without a price: there are no token counts for it on this Mac.`);
    notes.push('A card is the session Plexiform captured for it on My board or a team board; work with no card is grouped by project and git branch.');
    box.append(el('div', 'note', notes.join(' ')));
    return box;
  }

  async function render(container, api, { force = false } = {}) {
    if (!container || !api || typeof api.workCost !== 'function' || busy) return;
    if (!force && Date.now() - at < REFRESH_MS && container.childElementCount) return;
    busy = true;
    let data = null;
    try { data = await api.workCost(); } catch { data = null; } finally { busy = false; }
    at = Date.now();
    if (!data || !data.week) { container.hidden = true; container.replaceChildren(); return; }
    const rerender = () => container.replaceChildren(card(data, api, rerender));
    rerender();
    container.hidden = false;
  }

  window.UsageWorkView = { render };
})();
