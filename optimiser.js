// Draws the view model main pushes. textContent only; no HTML from anywhere.
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.optimiserApi;
  if (!api) return;

  let tab = 'dashboard';

  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };

  // Routing and per-request history live in Burst's own dashboard (Routing and Activity).
  const TABS = ['dashboard', 'tools'];
  const TOOLS_MS = 15000;
  let mode = 'loading';
  let toolsPoll = null;
  let facts = null;
  let waste = null;
  const notes = new Map(); // tool id -> {text} or {confirm}

  function showPane() {
    const ready = !$('tabs').hidden;
    for (const t of TABS) {
      const b = $(`tab-${t}`);
      const on = ready && tab === t;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  const hubShown = () => !$('hub').hidden;

  // The tool list: every tool, its status here, what it reported saving, and its one action.
  function renderTools() {
    const lib = window.PlexiformOptimiserTools;
    const box = $('tools');
    if (!lib || !facts) return;
    const v = lib.toolsView({ burst: facts, waste });
    box.textContent = '';
    $('burst-group-title').hidden = mode !== 'empty';
    for (const g of v.groups) {
      const tools = g.tools.filter((t) => !(t.id === 'burst' && mode === 'empty'));
      if (!tools.length) continue;
      if (!(g.id === 'burst' && mode === 'empty')) box.append(el('h3', `${g.title} · ${g.by}`, 'group-title'));
      for (const t of tools) box.append(toolCard(t));
    }
  }

  function toolCard(t) {
    const card = el('section', undefined, 'tool');
    card.dataset.tool = t.id;
    if (t.available === false) card.dataset.available = 'false';
    const chip = el('span', undefined, 'chip');
    chip.dataset.tone = t.status.tone;
    chip.append(el('i'), el('span', t.status.label));
    chip.firstChild.setAttribute('aria-hidden', 'true');
    card.append(el('div', undefined, 'tool-head'));
    card.firstChild.append(el('h3', t.name), el('span', t.by, 'by'), chip);
    card.append(el('p', t.what));
    if (t.saves) { const s = el('div', t.saves.text, 'saves'); s.append(el('small', t.saves.source)); card.append(s); }
    if (t.note) card.append(el('p', t.note, 'note'));
    const row = el('div', undefined, 'actions');
    for (const a of t.actions) {
      const b = el('button', a.label, a.primary ? 'primary' : undefined);
      b.type = 'button';
      b.addEventListener('click', () => toolAct(t.id, a.kind));
      row.append(b);
    }
    if (t.link && api.openLink) {
      const l = el('button', 'Learn more', 'link');
      l.type = 'button';
      l.addEventListener('click', () => api.openLink(t.link));
      row.append(l);
    }
    card.append(row);
    const n = notes.get(t.id);
    if (n && n.confirm) {
      const c = el('div', n.confirm, 'confirm');
      const yes = el('button', 'Turn on', 'primary');
      const no = el('button', 'Cancel');
      yes.type = 'button'; no.type = 'button';
      yes.addEventListener('click', () => compaction(t.id, true, true));
      no.addEventListener('click', () => { notes.set(t.id, { text: 'Cancelled. Nothing changed.' }); renderTools(); });
      const r = el('div', undefined, 'actions');
      r.append(yes, no);
      c.append(r);
      card.append(c);
    }
    card.append(el('p', n && n.text ? n.text : '', 'note'));
    card.lastChild.setAttribute('role', 'status');
    return card;
  }

  const said = (r) => (r && r.cancelled ? 'Cancelled. Nothing changed.' : r && r.ok ? '' : (r && r.error) || 'Something went wrong.');

  async function compaction(id, enabled, confirmed = false) {
    if (!api.setCompaction) return;
    const r = await api.setCompaction({ enabled, confirmed }).catch(() => ({ ok: false, error: 'Something went wrong.' }));
    notes.set(id, r && r.needsConfirm ? { confirm: r.text } : { text: r && r.ok ? (r.note || (enabled ? 'Turned on.' : 'Turned off.')) : said(r) });
    if (r && r.ok) await loadTools(); else renderTools();
  }

  async function toolAct(id, kind) {
    const [verb, arg] = kind.split(':');
    if (verb === 'compaction') return compaction(id, arg === 'on');
    if (verb === 'open') { if (api.openPage) api.openPage(arg); return undefined; }
    if (verb === 'tab' || verb === 'section') { api.act(kind).catch(() => {}); return undefined; }
    const r = await api.act(arg).catch(() => ({ ok: false, error: 'Something went wrong.' }));
    notes.set(id, { text: r && r.ok ? 'Started in Terminal. This page updates when Burst answers.' : said(r) });
    renderTools();
    return undefined;
  }

  async function loadTools() {
    if (!api.tools) return;
    const [f, rep] = await Promise.all([
      api.tools().catch(() => null),
      api.waste ? api.waste().catch(() => null) : null,
    ]);
    facts = f && typeof f === 'object' ? f : { kind: 'unsupported' };
    waste = rep && rep.waste ? rep.waste : null;
    renderTools();
  }

  function syncTools() {
    const want = hubShown() && mode !== 'loading';
    if (want && toolsPoll === null) { loadTools(); toolsPoll = setInterval(loadTools, TOOLS_MS); } else if (!want && toolsPoll !== null) { clearInterval(toolsPoll); toolsPoll = null; } else if (want) renderTools();
  }

  function render(s) {
    const ready = s.mode === 'ready';
    mode = s.mode;
    tab = ready && s.tab ? s.tab : 'dashboard';
    $('tabs').hidden = !ready;
    const empty = s.mode === 'empty';
    $('loading').hidden = s.mode !== 'loading';
    if (s.mode === 'loading') $('loading').textContent = s.headline && s.headline !== 'Usage optimiser' ? s.headline : 'Checking Burst…';
    if (s.mode !== 'empty') $('note').textContent = '';
    $('empty').hidden = !empty;
    $('chip').hidden = !s.chip;
    if (s.chip) { $('chip').dataset.tone = s.chip.tone; $('chip-text').textContent = s.chip.label; }
    $('browser').hidden = !s.canBrowser;
    $('hub').hidden = ready && tab !== 'tools';
    showPane();
    syncTools();
    if (!empty) return;
    $('headline').textContent = s.headline;
    $('detail').textContent = s.detail;
    $('docs').hidden = !s.docs;
    const box = $('actions');
    box.textContent = '';
    for (const a of s.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', async () => {
        if (a.kind === 'retry') { $('note').textContent = 'Checking again…'; api.refresh(); return; }
        const r = await api.act(a.kind).catch(() => ({ ok: false, error: 'Something went wrong.' }));
        $('note').textContent = r && r.cancelled ? 'Cancelled. Nothing changed.' : r && r.ok ? 'Started in Terminal. This page updates when Burst answers.' : (r && r.error) || '';
      });
      box.append(b);
    }
  }

  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => { if (b.dataset.tab !== tab) api.act(`tab:${b.dataset.tab}`).catch(() => {}); });
    b.addEventListener('keydown', (e) => {
      const order = TABS;
      const i = order.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
      if (i === order.indexOf(tab) || i < 0 || i >= order.length) return;
      e.preventDefault();
      api.act(`tab:${order[i]}`).then(() => $(`tab-${order[i]}`).focus()).catch(() => {});
    });
  }
  $('refresh').addEventListener('click', () => { $('note').textContent = ''; api.refresh(); });
  $('browser').addEventListener('click', () => { api.openBrowser(); });
  $('docs').addEventListener('click', () => api.openDocs());
  api.onState(render);
  api.ready();
})();
