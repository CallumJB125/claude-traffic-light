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
  // §5. New chat works since R2b-2; "Start one above" joins the first sentence with R7's copy pass.
  const EMPTY = {
    all: 'No chats or sessions yet. Run claude or codex in any terminal and it shows up here.',
    chats: 'No chats yet.',
    terminals: 'No sessions in a terminal right now.',
    team: 'No team sessions right now.',
  };
  // C4: with chats off ("Show chats" in Settings), All doesn't mention chats.
  const EMPTY_NO_CHATS = 'No sessions yet. Run claude or codex in any terminal and it shows up here.';
  // Footer rows. Plexiform Terminal returns with the Terminal app, with a
  // "Get Plexiform Terminal" path (plan-r1 §5 Q3); its slot is after Usage.
  const FOOT = [
    { id: 'board', label: 'Board', icon: 'M2.75 3h3v10h-3zM6.5 3h3v7h-3zM10.25 3h3v8.5h-3z', section: 'board' },
    // R7-2: Usage opens on Today; the row is current on any of its five tabs (the strip, usage-tabs.html, moves between them).
    { id: 'usage:today', label: 'Usage', icon: 'M2.75 13.25h10.5M4.5 11V8M8 11V4.5M11.5 11V6.5', tabs: ['usage:today', 'usage', 'stats', 'optimiser', 'clients'] },
    // Plexiform Terminal footer row: returns with the Terminal app (see plan-r1 §5 Q3).
    { id: 'settings', label: 'Settings', icon: 'M8 5.75a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5zM8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1', section: 'settings' },
  ];

  const ui = {
    filter: 'all', rows: [], collapsed: new Set(['idle']), selectedRow: null, focusKey: null,
    seq: 0, selectedPage: null, sections: [], loaded: false,
    // C4: main says whether chats can be started here. Off hides New chat and the Chats filter; rows stay (a chat
    // started earlier may need you, and its thread still opens).
    chats: true,
  };
  const filters = () => FILTERS.filter((f) => ui.chats || f.id !== 'chats');
  // T1: teammates' shared sessions, Team filter only (read-only rows; a click opens Overview ›
  // Team sessions). Memory only: person groups' open state is never saved (names stay out of
  // config), and a tombstone keeps who and which AI, never the title.
  const TEAM = {
    shared: 'Shared with you', own: 'Your team work',
    gone: 'No longer shared with you, or it ended',
    none: "Join a team to see teammates' shared sessions.",
    empty: 'Nothing shared with you yet. Sessions appear here when teammates share them with your team.',
    unavailable: "Teammates' sessions are unavailable right now.",
  };
  const team = { viewer: undefined, rows: [], gone: new Map(), status: null, teams: [], teamsTotal: 0, loaded: false, collapsed: new Set(), people: new Map() };
  const EYE = 'M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8zM8 6.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5z';
  const SEND = 'M3 8h8.5M8.5 5l3 3-3 3';

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
  const isOpen = (id) => !collapsible(id) || !(id.startsWith('t:') ? team.collapsed : ui.collapsed).has(id);

  // ── render ───────────────────────────────────────────────────────────────
  let tree = null;
  function build() {
    const side = document.querySelector('.sidebar');
    side.setAttribute('data-chat-first', '');
    const nav = document.getElementById('nav');
    nav.textContent = '';
    const top = el('div', { class: 'sb-top' },
      el('button', { type: 'button', class: 'sb-new', id: 'sb-new' },
        svg('M8 3.25v9.5M3.25 8h9.5', 'sb-icon'), el('span', {}, 'New chat')),
      el('button', { type: 'button', class: 'sb-search', 'aria-disabled': 'true', 'aria-label': 'Search', title: 'Search is coming soon' },
        svg('M7 2.75a4.25 4.25 0 1 1 0 8.5 4.25 4.25 0 0 1 0-8.5zM10.1 10.1l3.15 3.15', 'sb-icon')));
    // R2b-2: navigation only; main opens the new-chat screen.
    top.querySelector('.sb-new').addEventListener('click', () => window.buddy.openNewChat?.());
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
    const join = el('button', { type: 'button', class: 'sb-connect', id: 'sb-team-join', hidden: true }, 'Account & team');
    join.addEventListener('click', () => window.buddy.select('account'));
    const overview = el('button', { type: 'button', class: 'sb-link', id: 'sb-team-overview' }, 'Team overview');
    overview.addEventListener('click', () => window.buddy.select('overview'));
    const more = el('p', { class: 'sb-empty sb-team-more', id: 'sb-team-more', hidden: true }, el('span', {}), ' · ', overview);
    nav.append(top, filter, el('div', { class: 'sb-scroll' }, tree, el('p', { class: 'sb-empty', id: 'sb-empty', hidden: true }), connect, join, more));
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
    if (!ui.chats && ui.filter === 'chats') ui.filter = 'all';
    const nw = document.getElementById('sb-new');
    if (nw) nw.hidden = !ui.chats;
    for (const b of document.querySelectorAll('.sb-filter-opt')) {
      b.hidden = !ui.chats && b.dataset.filter === 'chats';
      const on = b.dataset.filter === ui.filter;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const rows = visibleRows();
    // Rebuilding replaces the nodes; keep keyboard focus where it was (a poll must never steal it).
    const hadFocus = tree.contains(document.activeElement);
    tree.textContent = '';
    const empty = document.getElementById('sb-empty');
    let shown = rows.length;
    document.getElementById('sb-team-join').hidden = true;
    document.getElementById('sb-team-more').hidden = true;
    if (ui.filter === 'team') shown = renderTeam(rows, empty);
    else {
      for (const b of BUCKETS) {
        const mine = rows.filter((r) => r.bucket === b.id);
        if (!mine.length) continue; // an empty group is hidden; Needs you never shows empty
        tree.append(groupEl(b.id, b.label, mine.length, 1, null, mine.map((r) => ownRow(r, 2, null))));
      }
      empty.hidden = rows.length > 0 || !ui.loaded;
      empty.textContent = !ui.chats && ui.filter === 'all' ? EMPTY_NO_CHATS : EMPTY[ui.filter];
    }
    document.getElementById('sb-connect').hidden = empty.hidden || ui.filter !== 'all';
    tree.hidden = shown === 0;
    // Roving tabindex: exactly one tree item is tabbable.
    const items = treeItems();
    const current = items.find((i) => i.dataset.key === ui.focusKey) ?? items.find((i) => i.getAttribute('aria-selected') === 'true') ?? items[0];
    for (const i of items) i.tabIndex = i === current ? 0 : -1;
    if (current) ui.focusKey = current.dataset.key;
    if (hadFocus && current) current.focus();
    paintFoot();
  }

  // A tree group: header (label, count, chevron) and its child list. `id` is the collapse id.
  function groupEl(id, label, count, level, parent, kids, { person = null } = {}) {
    const open = isOpen(id);
    const head = el('div', { class: 'sb-group-head' }, person ? el('span', { class: 'sb-initials', 'aria-hidden': 'true' }, person.initials) : null,
      el('span', { class: person ? 'sb-person' : 'sb-group-label' }, label), el('span', { class: 'sb-count', 'aria-hidden': 'true' }, ` · ${count}`),
      collapsible(id) ? svg('M6 4.5l3.5 3.5L6 11.5', 'sb-chevron') : null);
    const group = el('li', { role: 'treeitem', class: 'sb-group', 'data-key': `g:${id}`, 'data-bucket': id, 'data-parent': parent, 'aria-level': level,
      'aria-expanded': String(open), 'aria-label': `${label}, ${count}`, tabindex: -1 }, head);
    const list = el('ul', { role: 'group', hidden: !open });
    list.append(...kids);
    group.append(list);
    return group;
  }
  function ownRow(r, level, parent) {
    const meta = [r.project, r.origin].filter(Boolean).join(' · ');
    return el('li', { role: 'treeitem', class: 'sidebar-row', 'data-key': `r:${r.id}`, 'data-bucket': r.bucket, 'data-parent': parent, 'aria-level': level,
      'aria-selected': String(ui.selectedRow === r.id), tabindex: -1 },
    el('span', { class: 'sb-dot', 'data-bucket': r.bucket, 'aria-hidden': 'true' }),
    el('span', { class: 'sb-text' }, el('span', { class: 'sb-title' }, r.title), meta ? el('span', { class: 'sb-meta' }, meta) : null),
    el('span', { class: 'sb-age' }, age(r.age_ms)));
  }

  // T1: the Team filter. My own team-board rows, then teammates' shared sessions by person.
  const whose = (r) => (r.inbox ? `${r.person}'s board run` : `${r.person}'s ${r.provider} session`);
  const BUCKET_ORDER = (b) => { const i = BUCKETS.findIndex((x) => x.id === b); return i < 0 ? BUCKETS.length : i; };
  function personKey(person, teamName) {
    const k = JSON.stringify([person, teamName]);
    if (!team.people.has(k)) team.people.set(k, `t:p${team.people.size}`);
    return team.people.get(k);
  }
  function sharedRow(r, parent, stale) {
    const old = stale || r.freshness !== 'recent';
    const meta = [r.provider, old ? 'Stale' : null].filter(Boolean).join(' · ');
    const glyph = el('span', { class: 'sb-scope', title: r.scope === 'interact' ? 'Watch and send' : 'Shared with you to watch' }, svg(EYE, 'sb-icon'), r.scope === 'interact' ? svg(SEND, 'sb-icon') : null);
    const name = `${r.title}, ${whose(r)}, shared with you to ${r.scope === 'interact' ? 'watch and send' : 'watch'}${old ? ', stale' : ''}`;
    return el('li', { role: 'treeitem', class: 'sidebar-row sb-shared', 'data-key': `s:${r.id}`, 'data-bucket': r.bucket, 'data-parent': parent, 'aria-level': 3,
      'aria-selected': 'false', 'aria-label': name, tabindex: -1 },
    el('span', { class: 'sb-dot', 'data-bucket': r.bucket, 'aria-hidden': 'true' }),
    el('span', { class: 'sb-text' }, el('span', { class: 'sb-title' }, r.title), el('span', { class: 'sb-meta' }, meta)), glyph);
  }
  function goneRow(id, g, parent) {
    return el('li', { role: 'treeitem', class: 'sidebar-row sb-gone', 'data-key': `x:${id}`, 'data-parent': parent, 'aria-level': 3,
      'aria-label': `${whose(g)}, ${TEAM.gone}. Dismiss`, tabindex: -1 },
    el('span', { class: 'sb-dot', 'data-bucket': 'idle', 'aria-hidden': 'true' }),
    el('span', { class: 'sb-text' }, el('span', { class: 'sb-title' }, whose(g)), el('span', { class: 'sb-meta', title: TEAM.gone }, TEAM.gone)),
    el('span', { class: 'sb-dismiss', title: 'Dismiss', 'aria-hidden': 'true' }, svg('M4.5 4.5l7 7M11.5 4.5l-7 7', 'sb-icon')));
  }
  function renderTeam(own, empty) {
    const stale = team.status === 'unavailable';
    if (own.length) tree.append(groupEl('t:own', TEAM.own, own.length, 1, null, own.map((r) => ownRow(r, 2, 'g:t:own'))));
    const people = new Map();
    const at = (person, initials, teamName) => {
      const k = personKey(person, teamName);
      if (!people.has(k)) people.set(k, { key: k, person, initials, team: teamName, rows: [], gone: [] });
      return people.get(k);
    };
    for (const r of team.rows) at(r.person, r.initials, r.team).rows.push(r);
    for (const [id, g] of team.gone) at(g.person, g.initials, g.team).gone.push([id, g]);
    if (people.size) {
      const multi = new Set([...people.values()].map((p) => p.team)).size > 1;
      const rank = (p) => (p.rows.some((r) => r.bucket === 'needs') ? 0 : p.rows.some((r) => r.bucket === 'working') ? 1 : 2);
      const order = [...people.values()].sort((a, b) => rank(a) - rank(b) || a.person.localeCompare(b.person) || a.team.localeCompare(b.team));
      const kids = order.map((p) => {
        const fake = p.team.endsWith(' (test data)');
        const label = multi ? `${p.person} · ${p.team}` : fake ? `${p.person} (test data)` : p.person;
        const rows = [...p.rows].sort((a, b) => BUCKET_ORDER(a.bucket) - BUCKET_ORDER(b.bucket));
        return groupEl(p.key, label, p.rows.length, 2, 'g:t:shared',
          [...rows.map((r) => sharedRow(r, `g:${p.key}`, stale)), ...p.gone.map(([id, g]) => goneRow(id, g, `g:${p.key}`))], { person: p });
      });
      tree.append(groupEl('t:shared', TEAM.shared, team.rows.length, 1, null, kids));
    }
    const shown = own.length + people.size;
    let note = '';
    if (stale) note = TEAM.unavailable;
    else if (!shown && team.loaded) note = team.teamsTotal === 0 ? TEAM.none : TEAM.empty;
    else if (!shown) note = EMPTY.team;
    empty.textContent = note;
    empty.hidden = !note || !(ui.loaded || team.loaded);
    document.getElementById('sb-team-join').hidden = !(note === TEAM.none && !empty.hidden);
    const more = document.getElementById('sb-team-more');
    more.hidden = !(team.teamsTotal > team.teams.length && team.teams.length > 0);
    more.firstChild.textContent = `Showing ${team.teams.length} of ${team.teamsTotal} teams`;
    return shown;
  }

  function paintFoot() {
    const sectionOf = (id) => ui.sections.find((s) => s.pages.includes(id))?.id ?? null;
    const open = sectionOf(ui.selectedPage);
    for (const b of document.querySelectorAll('.sb-foot')) {
      const f = FOOT.find((x) => x.id === b.dataset.page);
      const on = f && (f.tabs ? f.tabs.includes(ui.selectedPage) : open === f.section);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
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
    const set = bucket.startsWith('t:') ? team.collapsed : ui.collapsed;
    const next = open ?? set.has(bucket);
    if (next) set.delete(bucket); else set.add(bucket);
    if (set === ui.collapsed) window.buddy.setGroups([...ui.collapsed]);
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

  // T1: a teammate row opens Overview › Team sessions on it (main checks the id and the viewer).
  function openShared(key) { ui.focusKey = key; window.buddy.openTeamRow?.(key.slice(2)); }
  function dismiss(key) {
    const items = treeItems(), i = items.findIndex((n) => n.dataset.key === key);
    team.gone.delete(key.slice(2));
    render();
    const after = treeItems(), next = after[Math.min(i, after.length - 1)];
    if (next) focusKey(next.dataset.key);
  }
  function onTreeClick(e) {
    const key = keyOf(e.target);
    if (!key) return;
    if (key.startsWith('g:')) { if (e.target.closest('.sb-group-head')) toggle(key.slice(2)); return; }
    if (key.startsWith('s:')) { openShared(key); return; }
    if (key.startsWith('x:')) { if (e.target.closest('.sb-dismiss')) dismiss(key); return; }
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
        else if (isGroup && items[i + 1] && node.contains(items[i + 1])) focusKey(items[i + 1].dataset.key);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (isGroup) {
          if (collapsible(key.slice(2)) && node.getAttribute('aria-expanded') === 'true') toggle(key.slice(2), false);
          else if (node.dataset.parent) focusKey(node.dataset.parent);
        } else focusKey(node.dataset.parent || `g:${node.dataset.bucket}`);
        return;
      case 'Enter': case ' ':
        e.preventDefault();
        if (isGroup) toggle(key.slice(2)); else if (key.startsWith('s:')) openShared(key); else if (key.startsWith('x:')) dismiss(key); else openRow(key);
        return;
      case 'Delete': case 'Backspace':
        if (key.startsWith('x:')) { e.preventDefault(); dismiss(key); }
        return;
      default:
    }
  }

  function onFilterKey(e) {
    const ids = filters().map((f) => f.id), i = ids.indexOf(ui.filter);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    setFilter(ids[(i + step + ids.length) % ids.length], { focus: false });
    document.querySelector(`.sb-filter-opt[data-filter="${ui.filter}"]`)?.focus();
  }

  function setFilter(id, { focus = true, needs = false } = {}) {
    ui.filter = filters().some((f) => f.id === id) ? id : 'all';
    render();
    if (ui.filter === 'team') refreshTeam();
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
    } catch { /* keep the last rows */ } finally { refreshing = false; refreshTeam(); }
  }

  // T1: read only while the Team filter is showing in a visible window (main also holds a 15 s floor).
  let teamFetching = false;
  async function refreshTeam() {
    if (teamFetching || ui.filter !== 'team' || typeof window.buddy.teamRows !== 'function' || document.visibilityState !== 'visible') return;
    teamFetching = true;
    try {
      const out = await window.buddy.teamRows();
      if (out && typeof out === 'object' && applyTeam(out) && ui.filter === 'team') render();
    } catch { /* keep the last rows */ } finally { teamFetching = false; }
  }
  // → whether anything shown changed. A different viewer (or signed out) clears every row and
  // tombstone at once, unavailable or not; unavailable for the same viewer keeps the last rows, marked stale.
  function applyTeam(out) {
    const before = JSON.stringify([team.viewer, team.status, team.rows, [...team.gone], team.teams, team.teamsTotal, team.loaded]);
    const viewer = typeof out.viewer === 'string' ? out.viewer : null;
    const clear = () => { team.rows = []; team.gone.clear(); team.people.clear(); team.collapsed.clear(); team.teams = []; team.teamsTotal = 0; };
    if (out.status === 'unavailable') {
      if (viewer !== team.viewer || viewer === null) { clear(); team.viewer = viewer; }
      team.status = 'unavailable';
    } else {
      if (viewer !== team.viewer || viewer === null) clear();
      const rows = Array.isArray(out.rows) ? out.rows.filter((r) => r && typeof r.id === 'string') : [];
      const ids = new Set(rows.map((r) => r.id));
      for (const r of team.rows) if (!ids.has(r.id)) team.gone.set(r.id, { person: r.person, initials: r.initials, team: r.team, provider: r.provider, inbox: r.inbox });
      for (const id of ids) team.gone.delete(id);
      while (team.gone.size > 50) team.gone.delete(team.gone.keys().next().value);
      team.viewer = viewer; team.rows = rows; team.status = out.status === 'partial' ? 'partial' : 'complete';
      team.teams = Array.isArray(out.teams) ? out.teams : [];
      team.teamsTotal = Number.isSafeInteger(out.teamsTotal) ? out.teamsTotal : team.teams.length;
    }
    team.loaded = true;
    return JSON.stringify([team.viewer, team.status, team.rows, [...team.gone], team.teams, team.teamsTotal, team.loaded]) !== before;
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
    if (s?.chat && typeof s.chat.chats === 'boolean' && s.chat.chats !== ui.chats) { ui.chats = s.chat.chats; render(); }
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
      if (r.chat?.chats === false) ui.chats = false;
      build();
      // A redirect may have asked for a filter before this script loaded.
      if (r.chat?.focus) onState({ chat: { focus: r.chat.focus } });
      window.buddy.onState(onState);
      refresh();
      setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    },
  };
})();
