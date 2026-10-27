'use strict';
// Redesign R1: the chat-first sidebar's render and keyboard (plan-redesign
// §2.1–2.2), run in jsdom from the shipped files, plus the gate-off control:
// the ordinary sidebar loads and builds exactly what it always has.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Pages = require('../buddy-window/pages.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const HTML = read('buddy-window/sidebar.html');
const SIDEBAR = read('buddy-window/sidebar.js');
const CHAT = read('buddy-window/sidebar-chat.js');
const ORGANISE = read('src/work-organise.js');
const id = (n) => n.toString(16).padStart(64, '0');
const ROWS = [
  { id: id(1), bucket: 'needs', title: 'Answer the migration question', project: 'billing', origin: 'iTerm', age_ms: 120000, team: false, terminal: true },
  { id: id(2), bucket: 'needs', title: 'Approve the deploy', project: 'site', origin: null, age_ms: 30000, team: true, terminal: false },
  { id: id(3), bucket: 'working', title: 'Refactor the importer', project: 'billing', origin: 'Terminal', age_ms: 5000, team: false, terminal: true },
  { id: id(4), bucket: 'check', title: 'Fix flaky test', project: 'api', origin: 'iTerm', age_ms: 900000, team: false, terminal: true },
  { id: id(5), bucket: 'idle', title: 'Claude session in docs', project: 'docs', origin: null, age_ms: 7200000, team: false, terminal: true },
];

const open = [];
test.afterEach(() => { while (open.length) open.pop().close(); });

async function boot({ chatFirst = true, rows = ROWS, collapsed = ['idle'], focus = { filter: 'all', seq: 0 }, early = null, selected = undefined, chats = undefined, team = undefined } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///app/buddy-window/sidebar.html' });
  const w = dom.window;
  open.push(w);
  const calls = { select: [], groups: [], sessions: 0, thread: [], newchat: 0, team: 0, openTeam: [] };
  let onState = [];
  w.buddy = {
    pages: async () => ({ pages: Pages.PAGES, groups: Pages.GROUPS, sections: Pages.SECTIONS, footer: Pages.FOOTER, brand: { name: 'Plexiform', hubText: {} },
      ...(chatFirst ? { chatFirst: true, chat: { collapsed, focus, ...(selected !== undefined ? { selected } : {}), ...(chats !== undefined ? { chats } : {}) } } : {}) }),
    select: (x) => calls.select.push(x), retry() {}, retryAccountStorage() {}, workspace() {}, optimiserSection() {}, signOut() {},
    onState: (fn) => onState.push(fn),
    sessions: async () => { calls.sessions++; return { schema: 1, status: 'complete', sessions: typeof rows === 'function' ? rows() : rows }; },
    openThread: (x) => calls.thread.push(x),
    openNewChat: () => { calls.newchat++; },
    setGroups: (ids) => calls.groups.push([...ids]),
    // T1: teammates' rows (only when a test gives them).
    ...(team !== undefined ? { teamRows: async () => { calls.team++; return typeof team === 'function' ? team() : team; }, openTeamRow: (x) => calls.openTeam.push(x) } : {}),
  };
  w.CSS = w.CSS || {};
  w.CSS.escape = w.CSS.escape || ((s) => String(s).replace(/[^a-zA-Z0-9_:-]/g, (c) => `\\${c}`));
  // Script injection: jsdom with outside-only scripts doesn't fetch, so serve the two files the sidebar asks for.
  const injected = [];
  const append = w.document.head.append.bind(w.document.head);
  w.document.head.append = (n) => {
    append(n);
    if (n.tagName === 'SCRIPT') {
      injected.push(n.getAttribute('src'));
      const src = { '../src/work-organise.js': ORGANISE, 'sidebar-chat.js': CHAT }[n.getAttribute('src')];
      setTimeout(() => { if (src) { w.eval(src); n.onload?.(); } else n.onerror?.(); }, 0);
    }
  };
  w.eval(SIDEBAR);
  // A state push that lands before the chat scripts load (only sidebar.js is listening yet).
  if (early) for (const fn of onState) fn(early);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  const doc = w.document;
  const push = async (s) => { for (const fn of onState) fn(s); for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
  const key = (k, target = doc.activeElement) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  return { w, doc, calls, injected, push, key, q: (s) => doc.querySelector(s), qa: (s) => [...doc.querySelectorAll(s)] };
}

test('gate off: the ordinary sidebar builds its sections and loads no new script', async () => {
  const s = await boot({ chatFirst: false });
  assert.deepEqual(s.injected, []);
  assert.ok(s.qa('#nav .nav-item.nav-section').length >= 6);
  assert.equal(s.q('[role="tree"]'), null);
  assert.equal(s.q('.sidebar').hasAttribute('data-chat-first'), false);
  assert.equal(s.calls.sessions, 0, 'never asks for session rows');
  assert.equal(s.q('script[src*="work-organise"]'), null);
  // sidebar.html itself is unchanged: one script, the same stylesheets.
  assert.deepEqual([...new JSDOM(HTML).window.document.querySelectorAll('script')].map((n) => n.getAttribute('src')), ['sidebar.js']);
});

test('gate on: bucket groups in BUCKETS order with label wording and counts; empty groups hidden', async () => {
  const s = await boot();
  assert.deepEqual(s.injected, ['../src/work-organise.js', 'sidebar-chat.js']);
  const groups = s.qa('.sb-group');
  assert.deepEqual(groups.map((g) => g.dataset.bucket), ['needs', 'working', 'check', 'idle'], 'no Stuck rows → no Stuck group');
  assert.deepEqual(groups.map((g) => g.getAttribute('aria-label')), ['Needs you, 2', 'Working on it, 1', 'Check it, 1', 'Idle, 1']);
  assert.equal(groups[0].querySelector('.sb-group-label').textContent, 'Needs you', 'uppercase comes from CSS');
  assert.equal(groups[0].querySelector('.sb-count').textContent, ' · 2');
  assert.equal(groups[0].querySelector('.sb-chevron'), null, 'Needs you has no collapse control');
  assert.equal(groups[3].getAttribute('aria-expanded'), 'false', 'Idle starts collapsed');
  assert.equal(groups[3].querySelector('[role="group"]').hidden, true);
  const row = s.q('.sidebar-row');
  assert.equal(row.querySelector('.sb-title').textContent, 'Answer the migration question');
  assert.equal(row.querySelector('.sb-meta').textContent, 'billing · iTerm');
  assert.equal(s.qa('.sidebar-row')[1].querySelector('.sb-meta').textContent, 'site', 'no origin → project only');
  assert.equal(row.querySelector('.sb-age').textContent, '2 min');
  assert.equal(row.querySelector('.sb-dot').dataset.bucket, 'needs');
});

test('gate on: the top row, the filter and the footer', async () => {
  const s = await boot();
  const [nw, search] = [s.q('.sb-new'), s.q('.sb-search')];
  // R2b-2: New chat works (navigation only); Search is still coming.
  assert.equal(nw.getAttribute('aria-disabled'), null);
  assert.equal(nw.title, '');
  assert.equal(search.getAttribute('aria-label'), 'Search');
  assert.equal(search.title, 'Search is coming soon');
  assert.doesNotMatch(nw.textContent + search.textContent, /⌘|Ctrl/, 'no shortcut is shown: none is bound');
  assert.doesNotMatch(CHAT, /metaKey|ctrlKey/, 'no ⌘N or ⌘K handler');
  nw.click(); search.click();
  assert.deepEqual(s.calls.select, []);
  assert.equal(s.calls.newchat, 1, 'New chat asks main to open the new-chat screen, nothing else');
  assert.deepEqual(s.qa('.sb-filter-opt').map((b) => [b.textContent, b.getAttribute('aria-checked')]), [['All', 'true'], ['Chats', 'false'], ['In terminals', 'false'], ['Team', 'false']]);
  assert.equal(s.q('.sb-filter').getAttribute('role'), 'radiogroup');
  assert.deepEqual(s.qa('#nav-foot button').map((b) => b.textContent), ['Board', 'Usage', 'Settings']);
  s.qa('#nav-foot button')[1].click();
  assert.deepEqual(s.calls.select, ['usage:today'], 'R7-2: Usage opens on Today');
  for (const id of ['usage:today', 'usage', 'stats', 'optimiser', 'clients']) {
    await s.push({ selected: id });
    assert.equal(s.qa('#nav-foot button')[1].getAttribute('aria-current'), 'page', `${id} is one of Usage's tabs`);
  }
  await s.push({ selected: 'board' });
  assert.equal(s.qa('#nav-foot button')[1].getAttribute('aria-current'), null);
});

test('filters: In terminals, Team, and Chats (empty until R2)', async () => {
  const s = await boot();
  s.q('[data-filter="terminals"]').click();
  assert.equal(s.qa('.sidebar-row').length, 4);
  s.q('[data-filter="team"]').click();
  assert.deepEqual(s.qa('.sidebar-row .sb-title').map((n) => n.textContent), ['Approve the deploy']);
  s.q('[data-filter="chats"]').click();
  assert.equal(s.q('.sb-tree').hidden, true);
  assert.equal(s.q('#sb-empty').textContent, 'No chats yet.');
  // ←/→ move the selection inside the radiogroup.
  s.q('[data-filter="chats"]').focus();
  s.key('ArrowRight');
  assert.equal(s.q('[aria-checked="true"]').dataset.filter, 'terminals');
});

test('empty: no sessions shows one sentence, and no group', async () => {
  const s = await boot({ rows: [] });
  assert.equal(s.qa('.sb-group').length, 0);
  assert.equal(s.q('#sb-empty').hidden, false);
  assert.equal(s.q('#sb-empty').textContent, 'No chats or sessions yet. Run claude or codex in any terminal and it shows up here.');
  assert.equal(s.q('#sb-connect').hidden, false);
  s.q('#sb-connect').click();
  assert.deepEqual(s.calls.select, ['aitools'], 'How to connect a tool → AI tools');
});

test('tree keyboard: roving tabindex, ↑↓ Home End, ←→ collapse and expand, Enter opens, Needs you never collapses', async () => {
  const s = await boot();
  const tab = () => s.qa('[role="treeitem"]').filter((n) => n.tabIndex === 0);
  assert.equal(tab().length, 1);
  tab()[0].focus();
  assert.equal(s.doc.activeElement.dataset.key, 'g:needs');
  s.key('ArrowLeft');
  assert.equal(s.q('[data-key="g:needs"]').getAttribute('aria-expanded'), 'true', 'Needs you never collapses');
  assert.deepEqual(s.calls.groups, []);
  s.key('ArrowRight');
  assert.equal(s.doc.activeElement.dataset.key, `r:${id(1)}`, '→ on an open group goes to its first row');
  s.key('ArrowDown');
  assert.equal(s.doc.activeElement.dataset.key, `r:${id(2)}`);
  s.key('ArrowLeft');
  assert.equal(s.doc.activeElement.dataset.key, 'g:needs', '← on a row goes to its group');
  s.key('End');
  assert.equal(s.doc.activeElement.dataset.key, 'g:idle', 'Idle is collapsed, so its header is last');
  s.key('ArrowRight');
  assert.equal(s.q('[data-key="g:idle"]').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(s.calls.groups.at(-1), [], 'the open/closed state is saved');
  s.key('ArrowLeft');
  assert.deepEqual(s.calls.groups.at(-1), ['idle']);
  s.key('Home');
  s.key('ArrowDown');
  s.key('Enter');
  assert.deepEqual(s.calls.select, ['overview'], 'a row opens Overview until the thread view exists');
  assert.equal(s.q(`[data-key="r:${id(1)}"]`).getAttribute('aria-selected'), 'true');
  assert.equal(tab().length, 1);
});

test('focus that arrives by mouse or script moves the tab stop, and the arrows start from it', async () => {
  const s = await boot();
  s.q(`[data-key="r:${id(3)}"]`).focus();
  assert.equal(s.q(`[data-key="r:${id(3)}"]`).tabIndex, 0);
  assert.equal(s.qa('[role="treeitem"]').filter((n) => n.tabIndex === 0).length, 1);
  s.key('ArrowUp');
  assert.equal(s.doc.activeElement.dataset.key, 'g:working');
});

test('the saved open/closed state is used, and a header click toggles it', async () => {
  const s = await boot({ collapsed: ['working'] });
  assert.equal(s.q('[data-key="g:working"]').getAttribute('aria-expanded'), 'false');
  assert.equal(s.q('[data-key="g:idle"]').getAttribute('aria-expanded'), 'true');
  s.q('[data-key="g:working"] .sb-group-head').click();
  assert.equal(s.q('[data-key="g:working"]').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(s.calls.groups, [[]]);
});

test('a redirect from main focuses the filter it names (waiting → the first Needs you row)', async () => {
  const s = await boot();
  s.q('[data-filter="team"]').click();
  await s.push({ selected: 'board', chat: { focus: { filter: 'needs', seq: 1 } } });
  assert.equal(s.q('[aria-checked="true"]').dataset.filter, 'all');
  assert.equal(s.doc.activeElement.dataset.key, `r:${id(1)}`);
  await s.push({ selected: 'board', chat: { focus: { filter: 'terminals', seq: 2 } } });
  assert.equal(s.q('[aria-checked="true"]').dataset.filter, 'terminals');
  await s.push({ selected: 'board', chat: { focus: { filter: 'terminals', seq: 2 } } });
  assert.equal(s.q('[aria-checked="true"]').dataset.filter, 'terminals', 'the same request is not replayed');
  const t = await boot({ focus: { filter: 'terminals', seq: 4 } });
  assert.equal(t.q('[aria-checked="true"]').dataset.filter, 'terminals', 'a request made before the script loaded still applies');
});

test('a refresh while the tree has focus keeps it on the same item', async () => {
  const s = await boot();
  s.q('[data-key="g:needs"]').focus();
  s.key('ArrowDown');
  s.key('ArrowDown');
  await s.push({ selected: 'board' }); // every state push re-reads the rows and re-renders
  assert.equal(s.doc.activeElement.dataset.key, `r:${id(2)}`);
  assert.ok(s.calls.sessions >= 2);
});

test('a page selected before the chat scripts loaded still sets the footer', async () => {
  const help = await boot({ early: { selected: 'help' } });
  assert.deepEqual(help.qa('#nav-foot [aria-current]').map((b) => b.dataset.page), [], 'Help open: no footer row is current');
  const usage = await boot({ early: { selected: 'usage' } });
  assert.deepEqual(usage.qa('#nav-foot [aria-current]').map((b) => b.dataset.page), ['usage:today']);
});

test('a refresh with unchanged rows leaves the tree nodes alone', async () => {
  const s = await boot();
  const before = s.q(`[data-key="r:${id(1)}"]`);
  await s.push({ selected: 'board' });
  assert.ok(s.calls.sessions >= 2);
  assert.equal(s.q(`[data-key="r:${id(1)}"]`), before, 'same node');
});

test('collapsed-groups IPC: registered only with the gate on, sidebar only, BUCKETS ids only', () => {
  const src = read('buddy-window/index.js');
  assert.match(src, /if \(chatFirst === true\) ipcMain\.on\('buddy:sidebar-groups', \(e, ids\) => \{\n    if \(!fromSidebar\(e\)\) return;\n    const clean = sidebarCollapsed\(ids\);/);
  assert.equal((src.match(/'buddy:sidebar-groups'/g) || []).length, 1);
  assert.deepEqual(Pages.sidebarCollapsed(['idle', 'working']), ['working', 'idle']);
  assert.deepEqual(Pages.sidebarCollapsed([]), []);
  for (const bad of [null, 'idle', ['needs'], ['idle', 'nope'], [1], Array(5).fill('idle'), { 0: 'idle', length: 1 }]) assert.equal(Pages.sidebarCollapsed(bad), null, JSON.stringify(bad));
  assert.deepEqual([...Pages.DEFAULT_COLLAPSED], ['idle']);
  assert.match(read('main.js'), /sidebarGroups: \{ load: \(\) => loadConfig\(\)\.ui\?\.sidebarGroups \?\? null, save: \(v\) => saveConfig\(\{ ui: \{ \.\.\.\(loadConfig\(\)\.ui \?\? \{\}\), sidebarGroups: v \} \}\) \},/);
});

test('every sidebar-chat rule is scoped under .sidebar[data-chat-first]', () => {
  const css = read('buddy-window/shell.css');
  const block = css.slice(css.indexOf('/* ── Chat-first sidebar'));
  const selectors = block.replace(/\/\*[^]*?\*\//g, '').replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g).map((s) => s.trim()).filter(Boolean);
  for (const sel of selectors) for (const part of sel.split(',')) assert.match(part.trim(), /^\.sidebar\[data-chat-first\] /, part);
  assert.match(block, /\.sidebar-row:focus-visible \{ outline: 2px solid var\(--focus-ring, var\(--accent\)\); outline-offset: -4px; box-shadow: inset 0 0 0 2px var\(--focus-halo\); \}/);
});


// ── Redesign R2a ─────────────────────────────────────────────────────────
const THREAD_ROWS = [
  { ...ROWS[0], thread: true, chat: false },
  { ...ROWS[1], thread: false, chat: false }, // a paired device's session: no thread
  { ...ROWS[2], thread: true, chat: true },
];

test('R2a: a row with a thread opens it; one without (a paired device) opens Overview as before', async () => {
  const s = await boot({ rows: THREAD_ROWS });
  s.q(`[data-key="r:${id(1)}"]`).click();
  assert.deepEqual(s.calls.thread, [id(1)]);
  assert.deepEqual(s.calls.select, []);
  s.q(`[data-key="r:${id(2)}"]`).click();
  assert.deepEqual(s.calls.select, ['overview']);
  s.q(`[data-key="r:${id(3)}"]`).focus();
  s.key('Enter');
  assert.deepEqual(s.calls.thread, [id(1), id(3)]);
});

test('R2a: the Chats filter lists Plexiform chats', async () => {
  const s = await boot({ rows: THREAD_ROWS });
  s.q('.sb-filter-opt[data-filter="chats"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(s.qa('.sidebar-row').map((n) => n.dataset.key), [`r:${id(3)}`]);
});

test('R2a: the thread on screen is the selected row; any other page selects none', async () => {
  const s = await boot({ rows: THREAD_ROWS });
  await s.push({ selected: 'thread', chat: { focus: { filter: 'all', seq: 0 }, thread: id(3) } });
  assert.deepEqual(s.qa('.sidebar-row[aria-selected="true"]').map((n) => n.dataset.key), [`r:${id(3)}`]);
  await s.push({ selected: 'board', chat: { focus: { filter: 'all', seq: 0 }, thread: null } });
  assert.equal(s.qa('.sidebar-row[aria-selected="true"]').length, 0);
});

test('R2a: a row with no thread opens Overview and stays selected through its state push', async () => {
  const s = await boot({ rows: THREAD_ROWS });
  s.q(`[data-key="r:${id(2)}"]`).focus();
  s.key('Enter');
  assert.deepEqual(s.calls.select, ['overview']);
  await s.push({ selected: 'overview', chat: { focus: { filter: 'all', seq: 0 }, thread: null } });
  assert.deepEqual(s.qa('.sidebar-row[aria-selected="true"]').map((n) => n.dataset.key), [`r:${id(2)}`]);
  await s.push({ selected: 'board', chat: { focus: { filter: 'all', seq: 0 }, thread: null } });
  assert.equal(s.qa('.sidebar-row[aria-selected="true"]').length, 0);
});

test('R2a: Overview from the nav after a thread selects no row', async () => {
  const s = await boot({ rows: THREAD_ROWS });
  await s.push({ selected: 'thread', chat: { focus: { filter: 'all', seq: 0 }, thread: id(3) } });
  await s.push({ selected: 'overview', chat: { focus: { filter: 'all', seq: 0 }, thread: null } });
  assert.equal(s.qa('.sidebar-row[aria-selected="true"]').length, 0);
});

test('R1 follow-up 8c: a read that changes only ages keeps every node and updates the age in place', async () => {
  let n = 0;
  const s = await boot({ rows: () => THREAD_ROWS.map((r) => ({ ...r, age_ms: r.age_ms + n * 60000 })) });
  const before = s.q(`[data-key="r:${id(1)}"]`);
  assert.equal(before.querySelector('.sb-age').textContent, '2 min');
  n = 3;
  await s.push({ selected: 'board' });
  const after = s.q(`[data-key="r:${id(1)}"]`);
  assert.equal(after, before, 'the same node');
  assert.equal(after.querySelector('.sb-age').textContent, '5 min');
  assert.equal(s.q(`[data-key="r:${id(5)}"]`), null);
});

test('R1 follow-up 8d: the footer starts from buddy:pages\' selection, and with none marks nothing', async () => {
  const s = await boot({ selected: 'usage' });
  assert.deepEqual(s.qa('.sb-foot[aria-current="page"]').map((b) => b.dataset.page), ['usage:today']);
  const t = await boot({ selected: null });
  assert.equal(t.qa('.sb-foot').length, 3);
  assert.deepEqual(t.qa('.sb-foot[aria-current="page"]'), [], 'not Board by default');
});

test('R1 follow-up 8b: the sidebar bridge has the chat-first channels only when main starts it with the flag', () => {
  const vm = require('node:vm');
  const src = read('buddy-window/sidebar-preload.js');
  const exposed = (argv) => {
    let api = null;
    const electron = { contextBridge: { exposeInMainWorld: (_n, v) => { api = v; } }, ipcRenderer: { invoke() {}, send() {}, on() {} } };
    vm.runInNewContext(src, { require: (m) => (m === 'electron' ? electron : null), process: { argv } });
    return Object.keys(api).sort();
  };
  const off = exposed(['electron', '--type=renderer']);
  const on = exposed(['electron', '--type=renderer', '--plexiform-chat-preview']);
  assert.ok(!off.includes('sessions') && !off.includes('setGroups') && !off.includes('openThread') && !off.includes('openNewChat') && !off.includes('teamRows') && !off.includes('openTeamRow'));
  // R2b-2 adds openNewChat, T1 teamRows and openTeamRow, gate-on only like the rest.
  assert.deepEqual(on.filter((k) => !off.includes(k)), ['openNewChat', 'openTeamRow', 'openThread', 'sessions', 'setGroups', 'teamRows']);
  const index = read('buddy-window/index.js');
  assert.match(index, /preload: path\.join\(DIR, 'sidebar-preload\.js'\), \.\.\.\(chatFirst === true \? \{ additionalArguments: \['--plexiform-chat-preview'\] \} : \{\}\) \} \}\);/);
});

// ── C4: "Show chats" off ───────────────────────────────────────────────────
const shown = (n) => n && !n.hidden;
test('C4: chats off hides New chat and the Chats filter; the rows and the footer are exactly as with chats on', async () => {
  const on = await boot();
  const off = await boot({ chats: false });
  assert.equal(shown(off.q('.sb-new')), false);
  assert.equal(shown(off.q('.sb-filter-opt[data-filter="chats"]')), false);
  assert.deepEqual(off.qa('.sb-filter-opt').filter(shown).map((b) => b.textContent), ['All', 'In terminals', 'Team']);
  assert.equal(shown(on.q('.sb-new')), true);
  assert.equal(on.qa('.sb-filter-opt').filter(shown).length, 4);
  assert.equal(off.q('.sb-tree').outerHTML, on.q('.sb-tree').outerHTML, 'rows unchanged, chats included (Q1)');
  assert.equal(off.q('#nav-foot').outerHTML, on.q('#nav-foot').outerHTML);
  // Arrow keys skip the hidden filter.
  off.q('.sb-filter-opt[data-filter="all"]').focus();
  off.key('ArrowRight');
  assert.equal(off.q('.sb-filter-opt[aria-checked="true"]').dataset.filter, 'terminals');
});

test('C4: a redirect to the Chats filter lands on All; the live flip both ways; the All empty text drops "chats"', async () => {
  const s = await boot({ chats: false, focus: { filter: 'chats', seq: 1 } });
  assert.equal(s.q('.sb-filter-opt[aria-checked="true"]').dataset.filter, 'all');
  const live = await boot();
  live.q('.sb-filter-opt[data-filter="chats"]').click();
  await live.push({ chat: { chats: false } });
  assert.equal(live.q('.sb-filter-opt[aria-checked="true"]').dataset.filter, 'all', 'showing Chats when it went off → All');
  assert.equal(shown(live.q('.sb-new')), false);
  await live.push({ chat: { chats: true } });
  assert.equal(shown(live.q('.sb-new')), true);
  assert.equal(shown(live.q('.sb-filter-opt[data-filter="chats"]')), true);
  const empty = await boot({ chats: false, rows: [] });
  assert.equal(empty.q('#sb-empty').textContent, 'No sessions yet. Run claude or codex in any terminal and it shows up here.');
  const emptyOn = await boot({ rows: [] });
  assert.equal(emptyOn.q('#sb-empty').textContent, 'No chats or sessions yet. Run claude or codex in any terminal and it shows up here.');
});

// ── T1: teammates' shared sessions under the Team filter ───────────────────
const VIEWER = 'a'.repeat(64), VIEWER2 = 'b'.repeat(64);
const mate = (n, over = {}) => ({ id: `${'c'.repeat(62)}${n.toString(16).padStart(2, '0')}`, person: 'Bob Stone', initials: 'BS', team: 'Dev team', title: `Bob task ${n}`, provider: 'Claude Code', bucket: 'working', freshness: 'recent', age_ms: 1000, scope: 'watch', inbox: false, ...over });
const payload = (rows, over = {}) => ({ schema: 1, status: 'complete', viewer: VIEWER, teams: [{ name: 'Dev team' }], teamsTotal: 1, rows, ...over });
const settle = async (s) => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); return s; };
async function teamBoot(team, more = {}) {
  const s = await boot({ team, focus: { filter: 'team', seq: 1 }, ...more });
  return settle(s);
}
const labels = (s) => s.qa('.sb-group').map((g) => g.getAttribute('aria-label'));

test('T1: the Team filter groups my team work, then Shared with you by person (Needs first, then Working, then name)', async () => {
  let rows = [
    mate(1, { person: 'Zed Ames', initials: 'ZA', bucket: 'idle', title: 'Zed idle' }),
    mate(2, { person: 'Ann Lee', initials: 'AL', bucket: 'idle', title: 'Ann idle' }),
    mate(3, { person: 'Bob Stone', bucket: 'working', title: 'Bob works' }),
    mate(4, { person: 'Zed Ames', initials: 'ZA', bucket: 'needs', title: 'Zed needs', scope: 'interact' }),
    mate(5, { person: 'Zed Ames', initials: 'ZA', bucket: 'working', title: 'Zed works' }),
  ];
  const s = await teamBoot(() => payload(rows));
  assert.ok(s.calls.team >= 1, 'read while the Team filter shows');
  assert.deepEqual(labels(s), ['Your team work, 1', 'Shared with you, 5', 'Zed Ames, 3', 'Bob Stone, 1', 'Ann Lee, 1']);
  const zed = s.qa('.sb-group[aria-level="2"]')[0];
  assert.deepEqual([...zed.querySelectorAll('.sb-shared .sb-title')].map((n) => n.textContent), ['Zed needs', 'Zed works', 'Zed idle'], 'bucket order within a person');
  const needs = zed.querySelector('.sb-shared');
  assert.equal(needs.getAttribute('aria-label'), "Zed needs, Zed Ames's Claude Code session, shared with you to watch and send");
  assert.equal(needs.querySelectorAll('.sb-scope svg').length, 2, 'eye + send for watch and send');
  assert.equal(s.q('.sb-group[aria-level="2"]:nth-child(2) .sb-shared .sb-scope').querySelectorAll('svg').length, 1);
  assert.equal(s.q('.sb-group[data-key="g:t:own"] .sidebar-row .sb-title').textContent, 'Approve the deploy', 'my own team-board row, unchanged');
  // All and Needs you never show a teammate's row, nor count it.
  s.qa('.sb-filter-opt[data-filter="all"]')[0].click();
  await settle(s);
  assert.equal(s.qa('.sb-shared').length, 0);
  assert.equal(s.q('.sb-group[data-key="g:needs"]').getAttribute('aria-label'), 'Needs you, 2', 'a teammate Needs row is not counted');
  void rows;
});

test('T1: a teammate row opens through main (navigation only); stale, board-run and fake-hub wording', async () => {
  const s = await teamBoot(payload([
    mate(1, { freshness: 'stale', title: 'Old work' }),
    mate(2, { inbox: true, title: "Bob Stone's board run", person: 'Bob Stone' }),
  ], { teams: [{ name: 'Fake (test data)' }] }));
  const [stale, run] = s.qa('.sb-shared');
  assert.equal(stale.getAttribute('aria-label'), "Old work, Bob Stone's Claude Code session, shared with you to watch, stale");
  assert.equal(stale.querySelector('.sb-meta').textContent, 'Claude Code · Stale');
  assert.match(run.getAttribute('aria-label'), /Bob Stone's board run, shared with you to watch$/);
  stale.click();
  assert.deepEqual(s.calls.openTeam, [mate(1).id]);
  assert.deepEqual(s.calls.thread, [], 'never a thread');
  assert.deepEqual(s.calls.select, [], 'main does the navigation');
  run.focus(); s.key('Enter');
  assert.deepEqual(s.calls.openTeam, [mate(1).id, mate(2).id]);
  const f = await teamBoot(payload([mate(1, { team: 'Fake team (test data)' })]), { rows: [] });
  assert.equal(f.q('.sb-group[aria-level="2"] .sb-person').textContent, 'Bob Stone (test data)');
});

test('T1: a row that stops being shared becomes a tombstone without its title; a viewer change clears with no tombstones', async () => {
  let out = payload([mate(1, { title: 'Secret launch plan' }), mate(2)]);
  const s = await teamBoot(() => out, { rows: [] });
  out = payload([mate(2)]);
  s.w.document.querySelector('.sb-filter-opt[data-filter="all"]').click();
  s.w.document.querySelector('.sb-filter-opt[data-filter="team"]').click();
  await settle(s);
  const gone = s.q('.sb-gone');
  assert.ok(gone, 'a tombstone');
  assert.equal(gone.querySelector('.sb-title').textContent, "Bob Stone's Claude Code session");
  assert.equal(gone.querySelector('.sb-meta').textContent, 'No longer shared with you, or it ended');
  assert.ok(!s.q('.sb-scroll').textContent.includes('Secret launch plan'), 'the title is dropped');
  // Unavailable with the same viewer keeps the last rows, marked stale.
  out = { schema: 1, status: 'unavailable', viewer: null, teams: [], teamsTotal: 0, rows: [] };
  s.w.document.querySelector('.sb-filter-opt[data-filter="all"]').click();
  s.w.document.querySelector('.sb-filter-opt[data-filter="team"]').click();
  await settle(s);
  assert.equal(s.qa('.sb-shared').length, 1);
  assert.match(s.q('.sb-shared').getAttribute('aria-label'), /, stale$/);
  assert.equal(s.q('#sb-empty').textContent, "Teammates' sessions are unavailable right now.");
  // Dismiss by keyboard.
  s.q('.sb-gone').focus(); s.key('Delete');
  assert.equal(s.qa('.sb-gone').length, 0);
  // Someone else signs in: every teammate row and tombstone goes at once.
  out = payload([mate(1, { title: 'Old person row' })]);
  s.w.document.querySelector('.sb-filter-opt[data-filter="all"]').click();
  s.w.document.querySelector('.sb-filter-opt[data-filter="team"]').click();
  await settle(s);
  out = payload([mate(9, { person: 'Cara Wu', initials: 'CW' })], { viewer: VIEWER2 });
  s.w.document.querySelector('.sb-filter-opt[data-filter="all"]').click();
  s.w.document.querySelector('.sb-filter-opt[data-filter="team"]').click();
  await settle(s);
  assert.equal(s.qa('.sb-gone').length, 0, 'no tombstones across viewers');
  assert.deepEqual(s.qa('.sb-shared .sb-title').map((n) => n.textContent), ['Bob task 9']);
  assert.ok(!s.q('.sb-scroll').textContent.includes('Bob Stone'));
});

test('T1: empty states, the team cap line, and keyboard through person groups (never saved)', async () => {
  const none = await teamBoot(payload([], { teams: [], teamsTotal: 0 }), { rows: [] });
  assert.equal(none.q('#sb-empty').textContent, "Join a team to see teammates' shared sessions.");
  assert.ok(!none.q('#sb-team-join').hidden);
  none.q('#sb-team-join').click();
  assert.deepEqual(none.calls.select, ['account']);
  const nothing = await teamBoot(payload([]), { rows: [] });
  assert.equal(nothing.q('#sb-empty').textContent, 'Nothing shared with you yet. Sessions appear here when teammates share them with your team.');
  assert.ok(nothing.q('#sb-team-join').hidden);
  const capped = await teamBoot(payload([mate(1)], { teams: [1, 2, 3, 4].map((n) => ({ name: `T${n}` })), teamsTotal: 6 }), { rows: [] });
  assert.ok(!capped.q('#sb-team-more').hidden);
  assert.equal(capped.q('#sb-team-more').textContent, 'Showing 4 of 6 teams · Team overview');
  capped.q('#sb-team-overview').click();
  assert.deepEqual(capped.calls.select, ['overview']);
  // Keyboard: Shared with you → person → row, and back out; collapsing a person is memory only.
  const s = await teamBoot(payload([mate(1), mate(2, { person: 'Ann Lee', initials: 'AL' })]), { rows: [] });
  s.q('.sb-group[data-key="g:t:shared"]').focus();
  s.key('ArrowRight'); assert.equal(s.doc.activeElement.getAttribute('aria-level'), '2');
  s.key('ArrowRight'); assert.ok(s.doc.activeElement.classList.contains('sb-shared'));
  s.key('ArrowLeft'); assert.equal(s.doc.activeElement.getAttribute('aria-level'), '2');
  s.key('ArrowLeft'); assert.equal(s.doc.activeElement.getAttribute('aria-expanded'), 'false');
  s.key('ArrowLeft'); assert.equal(s.doc.activeElement.dataset.key, 'g:t:shared');
  assert.deepEqual(s.calls.groups, [], 'person groups never reach config');
});
