// The chat-first sidebar (redesign R1, plan-redesign §2.1–2.2). Loaded only
// when main says the dev-only chat preview is on (sidebar.js injects it with
// work-organise.js); the ordinary sidebar never loads this file.
// DOM by textContent only. Data: read-only session rows from main
// (overview:state's sidebar projection), never paths. Navigation only.
(function () {
  'use strict';
  const Organise = window.PlexiformWorkOrganise;
  const SVG = 'http://www.w3.org/2000/svg';
  const POLL_MS = 5000;

  // Wording and order come from work-organise BUCKETS (the `label` form).
  const BUCKETS = Organise.BUCKETS;
  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'chats', label: 'Chats' },
    { id: 'terminals', label: 'In terminals' },
    { id: 'team', label: 'Team' },
  ];
  // The filter a redirect names → the filter shown (Needs you is All, with Needs you focused).
  const FILTER_OF = { all: 'all', needs: 'all', terminals: 'terminals', chats: 'chats', team: 'team' };
  // §5. "Start one above" joins the first sentence when New chat works (R7).
  const EMPTY = {
    all: 'No chats or sessions yet. Run claude or codex in any terminal and it shows up here.',
    chats: 'No chats yet.',
    terminals: 'No sessions in a terminal right now.',
    team: 'No team sessions right now.',
  };
  // Footer rows. Plexiform Terminal returns with the Terminal app, with a
  // "Get Plexiform Terminal" path (plan-r1 §5 Q3); its slot is after Usage.
  const FOOT = [
    { id: 'board', label: 'Board', icon: 'M2.75 3h3v10h-3zM6.5 3h3v7h-3zM10.25 3h3v8.5h-3z', section: 'board' },
    { id: 'usage', label: 'Usage', icon: 'M2.75 13.25h10.5M4.5 11V8M8 11V4.5M11.5 11V6.5', section: 'usage' },
    // Plexiform Terminal footer row: returns with the Terminal app (see plan-r1 §5 Q3).
    { id: 'settings', label: 'Settings', icon: 'M8 5.75a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5zM8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1', section: 'settings' },
  ];

  const ui = {
    filter: 'all', rows: [], collapsed: new Set(['idle']), selectedRow: null, focusKey: null,
    seq: 0, selectedPage: null, sections: [], loaded: false,
  };

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  function svg(d, cls) {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
    return s;
  }

  const age = (ms) => {
    if (!Number.isFinite(ms)) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
  };
  const visibleRows = () => {
    if (ui.filter === 'chats') return ui.rows.filter((r) => r.chat);
    if (ui.filter === 'terminals') return ui.rows.filter((r) => r.terminal);
    if (ui.filter === 'team') return ui.rows.filter((r) => r.team);
    return ui.rows;
  };
  const collapsible = (id) => id !== 'needs';
  const isOpen = (id) => !collapsible(id) || !ui.collapsed.has(id);

  // ── render ───────────────────────────────────────────────────────────────
  let tree = null;
  function build() {
    const side = document.querySelector('.sidebar');
    side.setAttribute('data-chat-first', '');
    const nav = document.getElementById('nav');
    nav.textContent = '';
    const top = el('div', { class: 'sb-top' },
      el('button', { type: 'button', class: 'sb-new', 'aria-disabled': 'true', title: 'New chats are coming soon' },
        svg('M8 3.25v9.5M3.25 8h9.5', 'sb-icon'), el('span', {}, 'New chat')),
      el('button', { type: 'button', class: 'sb-search', 'aria-disabled': 'true', 'aria-label': 'Search', title: 'Search is coming soon' },
        svg('M7 2.75a4.25 4.25 0 1 1 0 8.5 4.25 4.25 0 0 1 0-8.5zM10.1 10.1l3.15 3.15', 'sb-icon')));
    const filter = el('div', { class: 'sb-filter', role: 'radiogroup', 'aria-label': 'Show' });
    for (const f of FILTERS) {
      const b = el('button', { type: 'button', role: 'radio', class: 'sb-filter-opt', 'data-filter': f.id }, f.label);
      b.addEventListener('click', () => setFilter(f.id, { focus: false }));
      filter.append(b);
    }
    filter.addEventListener('keydown', onFilterKey);
    tree = el('ul', { class: 'sb-tree', role: 'tree', 'aria-label': 'Sessions' });
    tree.addEventListener('keydown', onTreeKey);
    tree.addEventListener('click', onTreeClick);
    // Focus that arrives by mouse or script moves the roving tab stop too, so the arrows start from it.
    tree.addEventListener('focusin', (e) => { const key = keyOf(e.target); if (key && key !== ui.focusKey) { ui.focusKey = key; for (const i of treeItems()) i.tabIndex = i.dataset.key === key ? 0 : -1; } });
    const connect = el('button', { type: 'button', class: 'sb-connect', id: 'sb-connect', hidden: true }, 'How to connect a tool');
    connect.addEventListener('click', () => window.buddy.select('aitools'));
    nav.append(top, filter, el('div', { class: 'sb-scroll' }, tree, el('p', { class: 'sb-empty', id: 'sb-empty', hidden: true }), connect));
    const foot = document.getElementById('nav-foot');
    foot.textContent = '';
    foot.setAttribute('aria-label', 'Workspace');
    for (const f of FOOT) {
      const b = el('button', { type: 'button', class: 'nav-item sb-foot', 'data-page': f.id }, svg(f.icon, 'nav-icon'), el('span', { class: 'nav-label' }, f.label));
      b.addEventListener('click', () => window.buddy.select(f.id));
      foot.append(b);
    }
    render();
  }

  function render() {
    for (const b of document.querySelectorAll('.sb-filter-opt')) {
      const on = b.dataset.filter === ui.filter;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const rows = visibleRows();
    // Rebuilding replaces the nodes; keep keyboard focus where it was (a poll must never steal it).
    const hadFocus = tree.contains(document.activeElement);
    tree.textContent = '';
    for (const b of BUCKETS) {
      const mine = rows.filter((r) => r.bucket === b.id);
      if (!mine.length) continue; // an empty group is hidden; Needs you never shows empty
      const open = isOpen(b.id);
      const label = el('span', { class: 'sb-group-label' }, b.label);
      const head = el('div', { class: 'sb-group-head' }, label, el('span', { class: 'sb-count', 'aria-hidden': 'true' }, ` · ${mine.length}`),
        collapsible(b.id) ? svg('M6 4.5l3.5 3.5L6 11.5', 'sb-chevron') : null);
      const group = el('li', { role: 'treeitem', class: 'sb-group', 'data-key': `g:${b.id}`, 'data-bucket': b.id, 'aria-level': 1,
        'aria-expanded': String(open), 'aria-label': `${b.label}, ${mine.length}`, tabindex: -1 }, head);
      const list = el('ul', { role: 'group', hidden: !open });
      for (const r of mine) {
        const meta = [r.project, r.origin].filter(Boolean).join(' · ');
        const row = el('li', { role: 'treeitem', class: 'sidebar-row', 'data-key': `r:${r.id}`, 'data-bucket': r.bucket, 'aria-level': 2,
          'aria-selected': String(ui.selectedRow === r.id), tabindex: -1 },
        el('span', { class: 'sb-dot', 'data-bucket': r.bucket, 'aria-hidden': 'true' }),
        el('span', { class: 'sb-text' }, el('span', { class: 'sb-title' }, r.title), meta ? el('span', { class: 'sb-meta' }, meta) : null),
        el('span', { class: 'sb-age' }, age(r.age_ms)));
        list.append(row);
      }
      group.append(list);
      tree.append(group);
    }
    const empty = document.getElementById('sb-empty');
    empty.hidden = rows.length > 0 || !ui.loaded;
    empty.textContent = EMPTY[ui.filter];
    document.getElementById('sb-connect').hidden = empty.hidden || ui.filter !== 'all';
    tree.hidden = rows.length === 0;
    // Roving tabindex: exactly one tree item is tabbable.
    const items = treeItems();
    const current = items.find((i) => i.dataset.key === ui.focusKey) ?? items.find((i) => i.getAttribute('aria-selected') === 'true') ?? items[0];
    for (const i of items) i.tabIndex = i === current ? 0 : -1;
    if (current) ui.focusKey = current.dataset.key;
    if (hadFocus && current) current.focus();
    paintFoot();
  }

  function paintFoot() {
    const sectionOf = (id) => ui.sections.find((s) => s.pages.includes(id))?.id ?? null;
    const open = sectionOf(ui.selectedPage);
    for (const b of document.querySelectorAll('.sb-foot')) {
      const f = FOOT.find((x) => x.id === b.dataset.page);
      if (f && open === f.section) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
  }

  // ── behaviour ────────────────────────────────────────────────────────────
  // Visible tree items in order: group headers and the rows of open groups.
  const treeItems = () => [...tree.querySelectorAll('[role="treeitem"]')].filter((i) => !i.closest('[hidden]'));
  const keyOf = (n) => n?.closest?.('[role="treeitem"]')?.dataset.key ?? null;
  function focusKey(key) {
    ui.focusKey = key;
    for (const i of treeItems()) i.tabIndex = i.dataset.key === key ? 0 : -1;
    tree.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }

  function toggle(bucket, open) {
    if (!collapsible(bucket)) return;
    const next = open ?? ui.collapsed.has(bucket);
    if (next) ui.collapsed.delete(bucket); else ui.collapsed.add(bucket);
    window.buddy.setGroups([...ui.collapsed]);
    render();
    focusKey(`g:${bucket}`);
  }

  // Set only when a row with no thread opened Overview, so Overview from the
  // nav doesn't leave the last thread's row highlighted.
  let overviewFromRow = false;

  function openRow(key) {
    const id = key.slice(2), r = ui.rows.find((x) => x.id === id);
    ui.selectedRow = id;
    ui.focusKey = key;
    // A row with a thread opens it (main resolves the row again). One with
    // none (a paired device's session) opens Overview, as in R1; a select
    // from the sidebar is never redirected back here.
    overviewFromRow = !r?.thread;
    if (r?.thread) window.buddy.openThread(id); else window.buddy.select('overview');
    render();
    focusKey(key);
  }

  function onTreeClick(e) {
    const key = keyOf(e.target);
    if (!key) return;
    if (key.startsWith('g:')) { if (e.target.closest('.sb-group-head')) toggle(key.slice(2)); return; }
    openRow(key);
  }

  function onTreeKey(e) {
    const items = treeItems();
    const i = items.findIndex((n) => n.dataset.key === ui.focusKey);
    const node = items[i];
    if (!node) return;
    const key = node.dataset.key, isGroup = key.startsWith('g:');
    const move = (j) => { e.preventDefault(); if (items[j]) focusKey(items[j].dataset.key); };
    switch (e.key) {
      case 'ArrowDown': return move(Math.min(i + 1, items.length - 1));
      case 'ArrowUp': return move(Math.max(i - 1, 0));
      case 'Home': return move(0);
      case 'End': return move(items.length - 1);
      case 'ArrowRight':
        e.preventDefault();
        if (isGroup && node.getAttribute('aria-expanded') === 'false') toggle(key.slice(2), true);
        else if (isGroup && items[i + 1]?.dataset.key.startsWith('r:')) focusKey(items[i + 1].dataset.key);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (isGroup) { if (collapsible(key.slice(2)) && node.getAttribute('aria-expanded') === 'true') toggle(key.slice(2), false); }
        else focusKey(`g:${node.dataset.bucket}`);
        return;
      case 'Enter': case ' ':
        e.preventDefault();
        if (isGroup) toggle(key.slice(2)); else openRow(key);
        return;
      default:
    }
  }

  function onFilterKey(e) {
    const ids = FILTERS.map((f) => f.id), i = ids.indexOf(ui.filter);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    setFilter(ids[(i + step + ids.length) % ids.length], { focus: false });
    document.querySelector(`.sb-filter-opt[data-filter="${ui.filter}"]`)?.focus();
  }

  function setFilter(id, { focus = true, needs = false } = {}) {
    ui.filter = FILTERS.some((f) => f.id === id) ? id : 'all';
    render();
    if (!focus) return;
    const items = treeItems();
    const target = (needs && items.find((n) => n.dataset.key.startsWith('r:') && n.dataset.bucket === 'needs')) || items.find((n) => n.dataset.key === ui.focusKey) || items[0];
    if (target) focusKey(target.dataset.key);
    else document.querySelector(`.sb-filter-opt[data-filter="${ui.filter}"]`)?.focus();
  }

  // ── data ─────────────────────────────────────────────────────────────────
  let refreshing = false;
  let rowsKey = '';
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const out = await window.buddy.sessions();
      if (!out || !Array.isArray(out.sessions)) return;
      // Unchanged rows: keep the DOM as it is (no node churn under the cursor, the focus or a screenshot).
      // Ages tick on every read, so they're left out of the key and updated in place.
      const key = JSON.stringify(out.sessions.map(({ age_ms, ...rest }) => rest));
      if (ui.loaded && key === rowsKey) { ui.rows = out.sessions; paintAges(); return; }
      rowsKey = key; ui.rows = out.sessions; ui.loaded = true; render();
    } catch { /* keep the last rows */ } finally { refreshing = false; }
  }

  function paintAges() {
    for (const r of ui.rows) {
      const n = tree.querySelector(`[data-key="r:${CSS.escape(r.id)}"] .sb-age`);
      const text = age(r.age_ms);
      if (n && n.textContent !== text) n.textContent = text;
    }
  }

  function onState(s) {
    if (typeof s?.selected === 'string') ui.selectedPage = s.selected;
    // The thread on screen is the selected row. Overview keeps the row only
    // when that row (one with no thread) opened it, as in R1; any other page
    // selects none.
    if (s?.chat && 'thread' in s.chat) {
      if (s.selected !== 'overview') overviewFromRow = false;
      const next = s.selected === 'thread' && typeof s.chat.thread === 'string' ? s.chat.thread
        : s.selected === 'overview' && overviewFromRow ? ui.selectedRow : null;
      if (next !== ui.selectedRow) { ui.selectedRow = next; render(); }
    }
    const f = s?.chat?.focus;
    if (f && Number.isSafeInteger(f.seq) && f.seq !== ui.seq) {
      ui.seq = f.seq;
      setFilter(FILTER_OF[f.filter] ?? 'all', { focus: true, needs: f.filter === 'needs' });
    } else paintFoot();
    refresh();
  }

  window.SidebarChat = {
    start(r) {
      ui.sections = Array.isArray(r.sections) ? r.sections : [];
      if (typeof r.selected === 'string') ui.selectedPage = r.selected;
      const saved = r.chat?.collapsed;
      if (Array.isArray(saved)) ui.collapsed = new Set(saved);
      build();
      // A redirect may have asked for a filter before this script loaded.
      if (r.chat?.focus) onState({ chat: { focus: r.chat.focus } });
      window.buddy.onState(onState);
      refresh();
      setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    },
  };
})();
