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

async function boot({ chatFirst = true, rows = ROWS, collapsed = ['idle'], focus = { filter: 'all', seq: 0 } } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///app/buddy-window/sidebar.html' });
  const w = dom.window;
  open.push(w);
  const calls = { select: [], groups: [], sessions: 0 };
  let onState = [];
  w.buddy = {
    pages: async () => ({ pages: Pages.PAGES, groups: Pages.GROUPS, sections: Pages.SECTIONS, footer: Pages.FOOTER, brand: { name: 'Plexiform', hubText: {} },
      ...(chatFirst ? { chatFirst: true, chat: { collapsed, focus } } : {}) }),
    select: (x) => calls.select.push(x), retry() {}, retryAccountStorage() {}, workspace() {}, optimiserSection() {}, signOut() {},
    onState: (fn) => onState.push(fn),
    sessions: async () => { calls.sessions++; return { schema: 1, status: 'complete', sessions: rows }; },
    setGroups: (ids) => calls.groups.push([...ids]),
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
  assert.equal(nw.getAttribute('aria-disabled'), 'true');
  assert.equal(nw.title, 'New chats are coming soon');
  assert.equal(search.getAttribute('aria-label'), 'Search');
  assert.equal(search.title, 'Search is coming soon');
  assert.doesNotMatch(nw.textContent + search.textContent, /⌘|Ctrl/, 'no shortcut is shown: none is bound');
  assert.doesNotMatch(CHAT, /metaKey|ctrlKey/, 'no ⌘N or ⌘K handler');
  nw.click(); search.click();
  assert.deepEqual(s.calls.select, []);
  assert.deepEqual(s.qa('.sb-filter-opt').map((b) => [b.textContent, b.getAttribute('aria-checked')]), [['All', 'true'], ['Chats', 'false'], ['In terminals', 'false'], ['Team', 'false']]);
  assert.equal(s.q('.sb-filter').getAttribute('role'), 'radiogroup');
  assert.deepEqual(s.qa('#nav-foot button').map((b) => b.textContent), ['Board', 'Usage', 'Settings']);
  s.qa('#nav-foot button')[1].click();
  assert.deepEqual(s.calls.select, ['usage']);
  await s.push({ selected: 'stats' });
  assert.equal(s.qa('#nav-foot button')[1].getAttribute('aria-current'), 'page', 'Stats lives in the Usage section');
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
