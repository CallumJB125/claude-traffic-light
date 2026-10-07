// Draws the view model main pushes. textContent only; no HTML from anywhere.
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.optimiserApi;
  if (!api) return;

  const VIEW_MS = 5000;
  let tab = 'dashboard';
  let rows = [];
  let route = null;
  let routeAt = 0;
  let poll = null;
  let clock = null;
  let loaded = '';

  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const usd = (n) => (n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : '<$0.01');
  const short = (id) => (id ? id.slice(0, 8) : '');
  const clock12 = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };

  function countdown(ms) {
    if (ms === null || ms === undefined) return '';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s === 0) return 'any moment';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    return m ? `${m}m ${s % 60}s` : `${s}s`;
  }

  const TABS = ['dashboard', 'route', 'requests', 'tools'];
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
    $('route-pane').hidden = !(ready && tab === 'route');
    $('requests-pane').hidden = !(ready && tab === 'requests');
  }

  const hubShown = () => !document.querySelector('main:not(.pane)').hidden;

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
    if (verb === 'tab') { api.act(kind).catch(() => {}); return undefined; }
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
    $('empty').hidden = !empty;
    $('chip').hidden = !s.chip;
    if (s.chip) { $('chip').dataset.tone = s.chip.tone; $('chip-text').textContent = s.chip.label; }
    $('browser').hidden = !s.canBrowser;
    document.querySelector('main:not(.pane)').hidden = ready && tab !== 'tools';
    showPane();
    syncPolling();
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
        const r = await api.act(a.kind).catch(() => ({ ok: false, error: 'Something went wrong.' }));
        $('note').textContent = r && r.cancelled ? 'Cancelled. Nothing changed.' : r && r.ok ? 'Started in Terminal. This page updates when Burst answers.' : (r && r.error) || '';
      });
      box.append(b);
    }
  }

  function renderRoute() {
    const err = $('route-error');
    const on = !!route;
    $('route-card').hidden = !on;
    if (!on) { $('route-rejected-card').hidden = true; $('route-chain-card').hidden = true; return; }
    err.hidden = true;
    const secondary = route.route === 'SECONDARY';
    $('route-head').textContent = secondary ? 'Using your backup provider' : 'Using your Claude plan';
    $('route-chip').dataset.tone = secondary ? 'amber' : 'green';
    $('route-chip-text').textContent = route.route === 'SECONDARY' ? 'Backup' : 'Your plan';
    const left = route.untilInMs === null ? null : Math.max(0, route.untilInMs - (Date.now() - routeAt));
    const why = [route.reason, route.claim ? `Limit: ${route.claim}` : '', left !== null && secondary ? `Claude returns in ${countdown(left)}` : ''].filter(Boolean).join('. ');
    $('route-reason').textContent = why || (secondary ? '' : 'Requests go to Claude.');
    $('route-reset').hidden = !secondary;

    const kv = $('route-kv');
    kv.textContent = '';
    const add = (k, v) => { kv.append(el('dt', k), el('dd', v)); };
    add('Your Claude plan', [route.primary.provider, route.primary.model].filter(Boolean).join(' / ') || 'Claude');
    add('Backup provider', [route.secondary.provider, route.secondary.model].filter(Boolean).join(' / ') + (route.secondary.ready ? '' : ' (not ready)') || 'Not set up');
    add('Plan failures', String(route.primaryFailures));
    if (route.overflow) add('Using backup', 'Active');
    if (route.meteredFailover && route.meteredFailover.minFailures) add('Switches after', `${route.meteredFailover.minFailures} failures in ${route.meteredFailover.windowSeconds}s`);

    const rej = $('route-rejected');
    rej.textContent = '';
    for (const r of route.rejected) {
      const left2 = r.resetInMs === null ? '' : countdown(Math.max(0, r.resetInMs - (Date.now() - routeAt)));
      const tr = document.createElement('tr');
      tr.append(el('td', r.model), el('td', left2), el('td', r.fallsBackTo || 'No fallback'));
      rej.append(tr);
    }
    $('route-rejected-card').hidden = route.rejected.length === 0;

    const chain = $('route-chain');
    chain.textContent = '';
    const keys = Object.keys(route.chain);
    for (const k of keys) chain.append(el('dt', k), el('dd', route.chain[k].join(' then ') || 'None'));
    $('route-chain-card').hidden = keys.length === 0;
  }

  async function loadRoute() {
    const r = await api.view('route').catch(() => ({ view: null, error: 'Could not read the route.' }));
    if (tab !== 'route') return;
    route = r && r.view ? r.view : null;
    routeAt = Date.now();
    renderRoute();
    const err = $('route-error');
    err.hidden = !!route;
    err.textContent = route ? '' : (r && r.error) || 'Burst did not answer.';
  }

  function renderHistory(h) {
    const box = $('hist-chart');
    box.textContent = '';
    const max = Math.max(0.0001, ...h.days.map((d) => d.primaryUsd + d.secondaryUsd));
    for (const d of h.days) {
      const col = el('div', undefined, 'bar-col');
      col.title = `${d.day}: ${usd(d.primaryUsd + d.secondaryUsd)} (Your plan ${usd(d.primaryUsd)}, Backup ${usd(d.secondaryUsd)}), ${d.requests} requests`;
      const bars = el('div', undefined, 'bars');
      const sec = el('i', undefined, 's');
      sec.style.height = `${(d.secondaryUsd / max) * 100}%`;
      const pri = el('i', undefined, 'p');
      pri.style.height = `${(d.primaryUsd / max) * 100}%`;
      bars.append(sec, pri);
      col.append(bars, el('span', d.day.slice(5), 'day'));
      box.append(col);
    }
    $('hist-card').hidden = h.days.length === 0;
    $('hist-total').textContent = `Total ${usd(h.days.reduce((n, d) => n + d.primaryUsd + d.secondaryUsd, 0))}`;
  }

  function renderRows() {
    const slot = $('f-slot').value;
    const st = $('f-status').value;
    const model = $('f-model').value;
    const pings = $('f-pings').checked;
    const body = $('req-rows');
    body.textContent = '';
    let n = 0;
    for (const r of rows) {
      if (slot && r.slot !== slot) continue;
      if (st === 'ok' && !(r.status >= 200 && r.status < 400)) continue;
      if (st === 'err' && r.status >= 200 && r.status < 400) continue;
      if (model && r.model !== model) continue;
      const empty = r.tokensIn === 0 && r.tokensOut === 0;
      if (empty && !pings && r.status >= 200 && r.status < 400) continue;
      n++;
      const tr = document.createElement('tr');
      const tok = (v) => (empty ? el('td', '\u2014', 'num dim') : el('td', String(v), 'num'));
      tr.append(el('td', clock12(r.time)), el('td', short(r.session)), el('td', ({ primary: 'Your plan', secondary: 'Backup' })[String(r.slot || r.route).toLowerCase()] || r.slot || r.route), r.model ? el('td', r.model) : el('td', '\u2014', 'dim'), el('td', String(r.status), 'num'), el('td', `${r.latencyMs} ms`, 'num'), tok(r.tokensIn), tok(r.tokensOut), empty && !r.usd ? el('td', '\u2014', 'num dim') : el('td', usd(r.usd), 'num'), el('td', r.note, 'note'));
      body.append(tr);
    }
    $('req-empty').hidden = n > 0;
  }

  function fillModels() {
    const sel = $('f-model');
    const keep = sel.value;
    const models = [...new Set(rows.map((r) => r.model).filter(Boolean))].sort();
    sel.textContent = '';
    sel.append(el('option', 'All'));
    sel.firstChild.value = '';
    for (const m of models) { const o = el('option', m); o.value = m; sel.append(o); }
    sel.value = models.includes(keep) ? keep : '';
  }

  async function loadRequests() {
    const [q, h] = await Promise.all([
      api.view('requests', { limit: 200 }).catch(() => ({ view: null, error: 'Could not read requests.' })),
      api.view('history', { days: 14 }).catch(() => ({ view: null })),
    ]);
    if (tab !== 'requests') return;
    const err = $('req-error');
    err.hidden = !!(q && q.view);
    err.textContent = q && q.view ? '' : (q && q.error) || 'Burst did not answer.';
    if (q && q.view) { rows = q.view.rows; fillModels(); renderRows(); }
    if (h && h.view) renderHistory(h.view);
  }

  function load() {
    if (tab === 'route') loadRoute();
    else if (tab === 'requests') loadRequests();
  }

  function syncPolling() {
    const want = tab === 'route' || tab === 'requests';
    if (want && poll === null) {
      loaded = tab;
      load();
      poll = setInterval(load, VIEW_MS);
      clock = setInterval(() => { if (tab === 'route') renderRoute(); }, 1000);
    } else if (want && loaded !== tab) {
      loaded = tab;
      load();
    } else if (!want && poll !== null) {
      clearInterval(poll); clearInterval(clock); poll = null; clock = null;
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
  for (const id of ['f-slot', 'f-status', 'f-model', 'f-pings']) $(id).addEventListener('change', renderRows);
  $('route-reset').addEventListener('click', async () => {
    const r = await api.burstAction('reset').catch(() => ({ ok: false, error: 'Something went wrong.' }));
    $('route-note').textContent = r && r.cancelled ? 'Cancelled. Nothing changed.' : r && r.ok ? 'Sent. Burst is routing back to Claude.' : (r && r.error) || '';
    if (r && r.ok) loadRoute();
  });
  $('refresh').addEventListener('click', () => { $('note').textContent = ''; api.refresh(); load(); });
  $('browser').addEventListener('click', () => { api.openBrowser(); });
  $('docs').addEventListener('click', () => api.openDocs());
  api.onState(render);
  api.ready();
})();
