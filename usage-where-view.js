// The Usage & cost page's "Where it went" card (src/cost-rollup.js through
// lightsApi.costRollup): spend by project, branch and PR for today / 7 days /
// 30 days, a sortable table with a small bar per row, the trend against the
// previous period, and the week's one saving suggestion. Paths, branch names
// and PR titles are user data: textContent only, never innerHTML.
//
//   UsageWhereView.render(container, api, { force })
//   UsageWhereView.viewModel(data, { dim, sort, dir })   (pure, for tests)
(function () {
  const TABS = [['project', 'Project'], ['branch', 'Branch'], ['pr', 'PR']];
  const RANGES = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']];
  const COLS = [['label', 'Name'], ['usd', 'Cost'], ['share', 'Share'], ['change', 'Trend']];
  const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`);
  const trend = (c) => (c == null ? 'new' : Math.abs(c) < 0.005 ? 'flat' : `${c > 0 ? '+' : '−'}${Math.round(Math.abs(c) * 100)}%`);

  function viewModel(data, { dim = 'project', sort = 'usd', dir = 'desc' } = {}) {
    if (!data || !data.by || !data.total) return null;
    const src = Array.isArray(data.by[dim]) ? data.by[dim] : [];
    const max = Math.max(0.0001, ...src.map((r) => r.usd || 0));
    const sign = dir === 'asc' ? 1 : -1;
    // The "other" bucket always stays last; it is not a real row to rank.
    const ranked = src.filter((r) => !r.other).sort((a, b) => {
      if (sort === 'label') return sign * String(a.label).localeCompare(String(b.label));
      const av = a[sort] ?? -Infinity, bv = b[sort] ?? -Infinity;
      return sign * (av - bv) || String(a.label).localeCompare(String(b.label));
    });
    const rows = [...ranked, ...src.filter((r) => r.other)].map((r) => ({
      key: r.key,
      label: r.label,
      cost: `${money(r.usd)}${r.unpriced ? '+' : ''}`,
      share: `${Math.round(r.share * 100)}%`,
      trend: trend(r.change),
      bar: r.usd > 0 ? Math.max(2, (r.usd / max) * 100) : 0,
      prCost: dim === 'pr' && r.pr ? `This PR cost ${money(r.usd)}` : null,
      other: !!r.other,
    }));
    const t = data.total;
    const summary = t.turns ? `${money(t.usd)}${t.unpriced ? '+' : ''} ${data.label ? data.label.toLowerCase() : ''}`.trim() : 'No AI spend in this window yet.';
    const vs = t.turns && t.prevUsd > 0 ? `${trend(t.change)} on the previous ${data.days === 1 ? 'day' : `${data.days} days`} (${money(t.prevUsd)})` : '';
    return { rows, summary, vs, saving: data.saving || null };
  }

  if (typeof module !== 'undefined' && module.exports) { module.exports = { viewModel }; return; }

  const state = { dim: 'project', range: '7d', sort: 'usd', dir: 'desc' };
  let at = 0, busy = false, last = null;
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function seg(label, items, current, pick) {
    const g = el('div', 'seg');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    for (const [k, text] of items) {
      const b = el('button', k === current ? 'on' : '', text);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(k === current));
      // The page's history panel has its own Today / 7 days / 30 days buttons;
      // this name keeps the two sets apart (it starts with the visible text).
      b.setAttribute('aria-label', `${text}, where it went`);
      b.addEventListener('click', () => pick(k));
      g.append(b);
    }
    return g;
  }

  function card(data, api, container) {
    const vm = viewModel(data, state);
    const box = el('section', 'mix-card ww-card');
    const head = el('div', 'wc-head');
    head.append(el('div', 'k', 'Where it went'));
    head.append(seg('Group by', TABS, state.dim, (k) => { state.dim = k; paint(container, api); }));
    head.append(seg('Window', RANGES, state.range, (k) => { state.range = k; void render(container, api, { force: true }); }));
    box.append(head);
    box.append(el('div', 'v', vm.summary));
    if (vm.vs) box.append(el('div', 'd', vm.vs));
    if (vm.saving) box.append(el('div', 'mix-rec ww-saving', vm.saving));
    if (vm.rows.length) {
      const table = el('table', 'ww-table');
      const thead = el('thead');
      const hr = el('tr');
      for (const [k, text] of COLS) {
        const th = el('th');
        const b = el('button', 'ww-sort', text + (state.sort === k ? (state.dir === 'asc' ? ' ↑' : ' ↓') : ''));
        b.type = 'button';
        th.setAttribute('aria-sort', state.sort === k ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        b.addEventListener('click', () => {
          if (state.sort === k) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
          else { state.sort = k; state.dir = k === 'label' ? 'asc' : 'desc'; }
          paint(container, api);
        });
        th.append(b);
        hr.append(th);
      }
      thead.append(hr);
      const tbody = el('tbody');
      for (const r of vm.rows) {
        const tr = el('tr', r.other ? 'ww-other' : '');
        const name = el('td', 'ww-name');
        name.append(el('span', 'name', r.label));
        name.lastChild.title = r.label;
        if (r.prCost) name.append(el('span', 'wc-meta', r.prCost));
        const bar = el('span', 'bar');
        const fill = el('i');
        fill.style.width = `${r.bar}%`;
        bar.append(fill);
        name.append(bar);
        tr.append(name, el('td', 'ms', r.cost), el('td', 'ms', r.share), el('td', 'ms', r.trend));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      box.append(table);
    }
    box.append(el('div', 'note', `${data.basis || ''} Projects are folder names; work with no card or PR is grouped under "No card or PR".`.trim()));
    return box;
  }

  function paint(container, api) { if (last) container.replaceChildren(card(last, api, container)); }

  async function render(container, api, { force = false } = {}) {
    if (!container || !api || typeof api.costRollup !== 'function' || busy) return;
    if (!force && Date.now() - at < 30000 && container.childElementCount) return;
    busy = true;
    let data = null;
    try { data = await api.costRollup(state.range); } catch { data = null; } finally { busy = false; }
    at = Date.now();
    if (!data || !data.by) { container.hidden = true; container.replaceChildren(); return; }
    last = data;
    paint(container, api);
    container.hidden = false;
  }

  window.UsageWhereView = { render, viewModel };
})();
