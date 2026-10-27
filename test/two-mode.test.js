'use strict';
// C4: the two-mode toggle ("Show chats", config homeComposer; plan-c4.md). Chats off removes the ways to start a chat
// in Plexiform and nothing else: coordination (Sessions, Overview, the widget, the board, Needs you) never reads the
// key. This file pins where the key may be read, what the tray and the shortcut do with it (review S2: still the
// Tasks composer, unchanged), the config hook that flips the window live, and the main.js wiring. The window side is
// test/newchat-window-authority.test.js; the A/B byte check is test-visual/two-mode.spec.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Compose = require('../src/compose-main.js');
const { applyConfigSideEffects } = require('../src/config-effects.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Every shipped file that names the key or the window's C4 hooks. Anything else (src/overview-*, session-*,
// signal-server, pending-inputs, the widget, hub/, board/) must not: that is what keeps coordination byte-identical.
const READERS = [
  'buddy-window/index.js', 'main.js', 'settings.html', 'settings.js', 'src/compose-main.js', 'src/config-effects.js',
  'src/newchat-home-main.js', 'src/newchat-main.js', 'src/settings-panes.js',
];

test('the key is read only where chats start (and Settings); never by coordination', () => {
  const out = execFileSync('git', ['grep', '-l', '-E', 'homeComposer|chatsOn|chatsChanged|chatsAllowed', '--', '*.js', '*.mjs', '*.cjs', '*.html', ':!test', ':!test-visual', ':!site', ':!docs'], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(out.split('\n').filter(Boolean).sort(), [...READERS].sort());
  for (const f of ['src/overview-main.js', 'src/overview-sidebar-rows.js', 'src/signal-server.js', 'src/pending-inputs.js', 'renderer.js', 'index.html']) {
    if (fs.existsSync(path.join(root, f))) assert.doesNotMatch(read(f), /homeComposer|chatsOn/, f);
  }
});

test('review S2: with chats off the tray "New task…" and the shortcut still open the Tasks composer (unchanged)', () => {
  const opened = [];
  let composed = 0, focused = 0;
  const deps = (cfg) => ({ ready: () => true, config: () => cfg, openPage: (id) => opened.push(id), buddy: () => ({ tasksCompose: () => { composed++; return true; }, focusComposer: () => { focused++; return true; } }) });
  assert.equal(Compose.openCompose(deps({ homeComposer: false })), true);
  assert.deepEqual(opened, ['tasks']);
  assert.equal(composed, 1);
  assert.equal(focused, 0);
  assert.equal(Compose.openCompose(deps({})), true);
  assert.deepEqual(opened, ['tasks', 'home'], 'chats on: Home, as before');
});

test('review S3: offerDraft (Sessions → the task box) with chats off is "off"; under the preview main answers "gate"', () => {
  const c = Compose.createCompose({ ipcMain: { handle() {} }, buddy: () => null, service: () => ({}), config: () => ({ homeComposer: false }) });
  assert.deepEqual(c.offerDraft({ dir: '/x', ai: 'claude', text: 'a' }), { ok: false, why: 'off' });
  assert.match(read('main.js'), /offerDraft: \(d\) => \(CHAT_PREVIEW \? \{ ok: false, why: 'gate' \} : Compose\.offerDraft\(d\)\)/);
});

test('the config hook: chatsChanged runs only when the value flips (a save that names the key unchanged does not)', () => {
  const runs = [];
  const d = { installHooks() {}, enableCalendar() {}, applyWidgetVisibility() {}, syncTailnetListener() {}, createTray() {}, applyVoiceHotkey() {}, broadcastStatus() {}, chatsChanged: () => runs.push(1) };
  const touchedAll = () => true;
  applyConfigSideEffects({}, { homeComposer: true }, d, (k) => k === 'homeComposer');
  applyConfigSideEffects({ homeComposer: true }, { homeComposer: true }, d, touchedAll);
  assert.equal(runs.length, 0, 'undefined and true are both on');
  applyConfigSideEffects({}, { homeComposer: false }, d);
  applyConfigSideEffects({ homeComposer: false }, {}, d);
  assert.equal(runs.length, 2);
  applyConfigSideEffects({}, { homeComposer: false }, { ...d, chatsChanged: undefined });
});

test('main.js wiring: one source for the window, the new chat and its reads; Home\'s box keeps its own', () => {
  const main = read('main.js');
  assert.match(main, /chatsOn: \(\) => loadConfig\(\)\.homeComposer !== false,\n/);
  assert.equal(main.match(/chatsOn: \(\) => loadConfig\(\)\.homeComposer !== false/g).length, 2, 'the window and newchat-home');
  assert.match(main, /chatsChanged: \(\) => buddyWin\?\.chatsChanged\?\.\(\),/);
  assert.match(read('src/newchat-main.js'), /hidden: \(\) => deps\.config\(\)\?\.homeComposer === false,/);
  assert.equal((main.match(/CHAT_PREVIEW/g) || []).length, 13, 'no new gated channel');
});

test('Settings: the sheet says "Show chats"; the old page keeps its words byte for byte', () => {
  const html = read('settings.html');
  assert.match(html, /<label class="row"><input type="checkbox" id="homeComposer" aria-describedby="hint-home-composer" \/> Show the task box on Home<\/label>/);
  assert.match(html, /<div class="hint" id="hint-home-composer">Give Plexiform a task from Home and it picks Claude or Codex, then waits for you to press Run\. Turn it off if you only use your AI tools directly; New task… in the menu bar then opens Tasks\.<\/div>/);
  const js = read('settings.js');
  const at = js.indexOf('    if (PANE) {\n      const box');
  assert.ok(at > 0, 'only in a pane document (PANE is set only in the Settings sheet)');
  const block = js.slice(at, js.indexOf('\n    }\n', at));
  assert.match(block, /textContent = ' Show chats'/);
  assert.match(block, /Plexiform still shows those sessions, what needs you, the widget and the board as before\./);
});

test('the window tells the sidebar: chats on the state push and on buddy:pages, chat-first only', () => {
  const src = read('buddy-window/index.js');
  assert.match(src, /\.\.\.\(chatFirst === true \? \{ chat: \{ focus: sidebarFocus, thread: selected === 'thread' \? threadId : null, chats: chatsAllowed\(\) \} \} : \{\}\),/);
  assert.match(src, /return \{ collapsed: saved \?\? \[\.\.\.DEFAULT_COLLAPSED\], focus: sidebarFocus, selected, chats: chatsAllowed\(\) \};/);
});
