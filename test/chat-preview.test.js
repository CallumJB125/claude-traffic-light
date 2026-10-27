'use strict';
// Redesign R1: the dev-only chat preview gate (plan-redesign §R3.8) and the
// select() wiring it guards. The selection code runs from the shipped source
// in a vm (the test/compose-window-authority.test.js pattern); no window opens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chatPreviewOn, ENV } = require('../src/chat-preview.js');
const Pages = require('../buddy-window/pages.js');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'buddy-window/index.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const between = (text, a, b) => { const i = text.indexOf(a); const j = text.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} … ${b}`); return text.slice(i, j); };

test('the gate opens only for a dev run of an unpackaged app with the variable set to 1', () => {
  assert.equal(ENV, 'CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW');
  assert.equal(chatPreviewOn({ isDevRun: true, isPackaged: false, env: { [ENV]: '1' } }), true);
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', 1]) assert.equal(chatPreviewOn({ isDevRun: true, isPackaged: false, env: { [ENV]: v } }), false, String(v));
  assert.equal(chatPreviewOn({ isDevRun: true, isPackaged: true, env: { [ENV]: '1' } }), false, 'packaged');
  assert.equal(chatPreviewOn({ isDevRun: false, isPackaged: false, env: { [ENV]: '1' } }), false, 'not a dev run');
  assert.equal(chatPreviewOn({ isDevRun: 1, isPackaged: 0, env: { [ENV]: '1' } }), false, 'only real booleans');
  assert.equal(chatPreviewOn({ isDevRun: true, isPackaged: false }), false, 'no env');
  assert.equal(chatPreviewOn(), false);
});

test('main reads the gate once from IS_DEV_RUN and app.isPackaged and hands it to the Buddy window', () => {
  assert.equal(mainSrc.match(/chatPreviewOn\(/g).length, 1);
  assert.match(mainSrc, /const CHAT_PREVIEW = require\('\.\/src\/chat-preview\.js'\)\.chatPreviewOn\(\{ isDevRun: IS_DEV_RUN, isPackaged: app\.isPackaged, env: process\.env \}\);/);
  assert.match(mainSrc, /buddyWin = createBuddyWindow\(\{[^]*?\n      chatFirst: CHAT_PREVIEW,\n/);
  // Read once; used by the Buddy window, the sidebar's read-only session rows (overview-main),
  // the R2a thread (registered only when on, and told the gate) and its deep links, and Sessions' Start (with the gate on
  // Home is the new chat, which takes no draft, so Start copies the command), and the Settings sheet's pane guards
  // (R8-1: settingsPane, settingsPaneOf, sendToSettings), nothing else.
  assert.equal((mainSrc.match(/CHAT_PREVIEW/g) || []).length, 10);
  assert.match(mainSrc, /    if \(CHAT_PREVIEW && !invited\) \{\n/);
  assert.match(mainSrc, /\nif \(CHAT_PREVIEW\) \{\n  const SidebarRows[^]*?buddy: \(\) => buddyWin, chatPreview: CHAT_PREVIEW,\n/);
  assert.match(mainSrc, /createOverviewMain\(\{\n  buddy:\(\)=>buddyWin,chatPreview:CHAT_PREVIEW,/);
  assert.match(src, /simpleMode = \(\) => false, chatFirst = false,/, 'off unless main says so');
  // Renderers never read the environment for it.
  for (const f of ['buddy-window/sidebar.js', 'buddy-window/sidebar-preload.js']) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /CHAT_PREVIEW|process\.env/);
});

test('the sidebar learns the gate only from buddy:pages, and only when it is on', () => {
  assert.match(src, /\.\.\.\(chatFirst === true \? \{ chatFirst: true, chat: chatPagesExtra\(\) \} : \{\}\) \} : null\)\);/);
  assert.match(src, /\.\.\.\(chatFirst === true \? \{ chat: \{ focus: sidebarFocus, thread: selected === 'thread' \? threadId : null \} \} : \{\}\),/);
});

function world(chatFirst) {
  const calls = [];
  const ctx = {
    calls, pageById: Pages.pageById, paneById: Pages.paneById, resolve: Pages.resolve, sectionTarget: Pages.sectionTarget, chatFirst,
    setupLocalGeneration: 0, tasksGeneration: 0, homeGeneration: 0, selected: 'board', content: null, hubInfo: null,
    sidebar: { webContents: { isDestroyed: () => false, focus: () => calls.push(['focus']) } },
    getTeamHub: () => null, forgetHub: () => {}, optimiser: { open: () => calls.push(['optimiser']) },
    flow: { show: (s) => calls.push(['screen', s]), leftAccountPages: () => {} },
    openWindow: (w) => calls.push(['window', w]),
    pushState: () => calls.push(['state']),
    showHubPage: (p) => { calls.push(['hub', p.id]); ctx.content = {}; },
    showLocal: (p) => { calls.push(['local', p.id]); ctx.content = {}; },
    showInfo: (p) => calls.push(['info', p.id]),
    fromSidebarOk: true,
  };
  const code = between(src, '  // Chat-first preview only (redesign R1)', '  const fromSidebar = ')
    + "const fromSidebar = () => fromSidebarOk;\n"
    + between(src, '  function onSelect(e, id) {', '  function onRetry(');
  vm.runInNewContext(`${code}\nglobalThis.api = { select, route, onSelect, get focus() { return sidebarFocus; } };`, ctx);
  return ctx;
}

test('gate off: route() is select(), and the sidebar behaves exactly as before', () => {
  for (const id of [...Pages.flat().map((p) => p.id)]) {
    const w = world(false);
    w.api.route(id);
    assert.ok(!w.calls.some(([k]) => k === 'focus'), id);
  }
  const w = world(false);
  w.api.route('overview');
  assert.deepEqual(w.calls, [['state'], ['local', 'overview']]);
  for (const id of ['inbox', 'section:sessions', ...Pages.FUTURE_IDS, ...Pages.FLOW_IDS, 'nope']) {
    const v = world(false); v.api.route(id); v.api.select(id); v.api.onSelect({}, id);
    assert.deepEqual(v.calls, [], `${id} is still a no-op`);
  }
});

test('gate on: future ids stay no-ops (never showInfo)', () => {
  for (const id of Pages.FUTURE_IDS) { const w = world(true); w.api.route(id); w.api.onSelect({}, id); assert.deepEqual(w.calls, [], id); }
});

test('gate on: overview, waiting and sessions focus the sidebar filter and keep the content (Board on first open)', () => {
  const w = world(true);
  w.api.route('waiting');
  assert.deepEqual(w.calls, [['state'], ['hub', 'board'], ['focus']], 'nothing showing yet → Board');
  assert.equal(w.api.focus.filter, 'needs');
  w.calls.length = 0;
  w.api.route('overview');
  assert.deepEqual(w.calls, [['state'], ['focus']], 'content kept');
  assert.equal(w.api.focus.filter, 'all');
  w.api.route('sessions');
  assert.equal(w.api.focus.filter, 'terminals');
  assert.equal(w.api.focus.seq, 3);
  assert.equal(w.selected, 'board');
});

test('gate on: a select from the sidebar is terminal; `from` comes from the sender, never the payload', () => {
  const w = world(true);
  w.content = {};
  w.api.onSelect({}, 'overview');
  assert.deepEqual(w.calls, [['state'], ['local', 'overview']], 'a row click opens overview, no loop back to the sidebar');
  assert.equal(w.api.onSelect.length, 2, 'onSelect takes (event, id) only');
  w.fromSidebarOk = false;
  w.calls.length = 0;
  w.api.onSelect({}, 'board');
  assert.deepEqual(w.calls, [], 'not the sidebar: refused');
});

test('gate on: a section id opens its default; the Sessions section is section:sessions', () => {
  const w = world(true);
  w.content = {};
  w.api.onSelect({}, 'section:sessions');
  assert.deepEqual(w.calls, [['state'], ['local', 'overview']]);
  w.calls.length = 0;
  w.api.route('inbox');
  assert.equal(w.api.focus.filter, 'needs', 'inbox → waiting → the Needs you filter');
  w.calls.length = 0;
  w.api.onSelect({}, 'section:nope');
  assert.deepEqual(w.calls, []);
});
