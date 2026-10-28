'use strict';
// QoL1 (plan-qol1 Rev 2): a click brings the session's terminal forward, or says plainly why not.
// B1 the adapter scripts (activate first; restore a minimised window), B3 the notes (several Ghostty tabs in one
// folder, Warp/Alacritty opened by bundle id, ended / still running / maybe closed), B4 no silent caller.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createJumper, LIVENESS_MS, OPEN_ONLY, NOTES } = require('../src/focus/jump.js');
const { folderMatches } = require('../src/focus/applescript.js');
const TerminalApp = require('../src/focus/terminal-app.js');
const ITerm = require('../src/focus/iterm.js');
const Ghostty = require('../src/focus/ghostty.js');
const Dock = require('../src/focus/ghostty-dock.js');

const HOST = 'qol1-host';
const at = (script, line) => { const i = script.split('\n').findIndex((l) => l.trim() === line); assert.ok(i >= 0, `missing: ${line}`); return i; };

// ── B1 ────────────────────────────────────────────────────────────────────
test('B1: Terminal and iTerm2 pin the window by id, activate, restore a minimised window, then pick the tab', () => {
  // The loop's references are by position and activating reorders the windows (seen on the real Terminal.app,
  // where an unpinned script raised another window), so the window is pinned by id and the tab found again.
  const order = (script, lines) => { const ix = lines.map((l) => at(script, l)); assert.deepEqual([...ix].sort((a, b) => a - b), ix, lines.join(' → ')); };
  order(TerminalApp.SCRIPT, ['set w to window id (id of w)', 'activate', 'if miniaturized of w then set miniaturized of w to false', 'set selected tab of w to (first tab of w whose tty is wantTty)', 'set index of w to 1']);
  order(ITerm.SCRIPT, ['set wid to id of w', 'set sid to id of s', 'activate', 'set w to window id wid', 'if miniaturized of w then set miniaturized of w to false', 'select w', 'if id of s2 is sid then', 'select t2', 'select s2']);
  // F-M1: the session not found again in its pinned window is a miss, never "ok" with only the window raised.
  const it = ITerm.SCRIPT.split('\n').map((l) => l.trim());
  assert.deepEqual(it.filter((l) => l.includes('return ')), ['if application "iTerm2" is not running then return "not-running"', 'return "ok"', 'return "lost"', 'return "no match"']);
  assert.equal(it[it.indexOf('return "ok"') - 1], 'select s2', 'the only "ok" follows selecting the session');
  for (const s of [Ghostty.SCRIPT, Dock.SCRIPT]) assert.ok(at(s, 'activate') < at(s, 'focus (item 1 of hits)'), 'Ghostty: activate, then focus');
});

test('B1: "matches: N" is counted only when N > 1; a match or none stays as it was', () => {
  assert.deepEqual(folderMatches({ ok: false, reason: 'matches: 3' }), { ok: false, reason: 'matches: 3', ambiguous: 3 });
  for (const r of [{ ok: false, reason: 'matches: 0' }, { ok: false, reason: 'matches: 1' }, { ok: false, reason: 'matches: 99999' }, { ok: true, exact: true }, { ok: false, reason: 'no match' }]) assert.deepEqual(folderMatches(r), r);
});

// ── B3 ────────────────────────────────────────────────────────────────────
const sess = (over = {}) => ({ host: HOST, sessionId: 'qol1-s', hostApp: 'Terminal', cwd: '/Users/me/private/proj', terminal: { env: {}, tty: '/dev/ttys009', cwd: '/Users/me/private/proj' }, ...over });
function jumper({ focus = async () => ({ ok: false, adapter: 'terminal-app', reason: 'no match' }), liveness = async () => 'unknown', openApp = null, activate = async () => ({ app: 'X', exact: false }) } = {}) {
  const calls = { open: [], activate: 0, live: 0 };
  const jump = createJumper({ localHost: HOST, platform: 'darwin', focus, activate: async (...a) => { calls.activate++; return activate(...a); },
    liveness: liveness && (async (s) => { calls.live++; return liveness(s); }), openApp: openApp && (async (id) => { calls.open.push(id); return openApp(id); }),
    explainer: { onNeeds: () => null, onDenied: () => {} } });
  return { jump, calls };
}

test('B3: several Ghostty tabs in one folder say how many and name the folder only', async () => {
  for (const [adapter, app] of [['ghostty', 'Ghostty'], ['ghostty-dock-script', 'Ghostty Dock']]) {
    const { jump } = jumper({ focus: async () => ({ ok: false, adapter, reason: 'matches: 2', ambiguous: 2 }) });
    const r = await jump(sess({ hostApp: 'Ghostty' }), 'proj');
    assert.equal(r.cant, `There are 2 ${app} tabs in proj, so Plexiform didn't guess. Switch to it in ${app}.`);
    assert.equal(r.app, null);
    assert.equal(r.cant.includes('/Users/me'), false, 'never the full path');
  }
});

test('B3: a window not found says ended, still running, or maybe closed, from the session\'s own process', async () => {
  for (const [live, note] of [['gone', NOTES.NOTE_ENDED], ['alive', NOTES.NOTE_NO_WINDOW], ['unknown', NOTES.NOTE_MAYBE_CLOSED]]) {
    for (const reason of ['no match', 'not-running', 'matches: 0']) {
      const { jump, calls } = jumper({ focus: async () => ({ ok: false, adapter: 'terminal-app', reason }), liveness: async () => live });
      const r = await jump(sess(), 'proj');
      assert.equal(r.cant, note, `${live} / ${reason}`);
      assert.equal(calls.activate, 0, 'nothing activated');
    }
  }
  // A refused permission, a timeout or iTerm2's session lost from its pinned window is not a missing window: the old note, and no process check.
  for (const r0 of [{ ok: false, adapter: 'terminal-app', denied: 'automation', reason: 'automation not allowed' }, { ok: false, adapter: 'terminal-app', reason: 'jump deadline passed' }, { ok: false, adapter: 'iterm', reason: 'lost' }]) {
    const { jump, calls } = jumper({ focus: async () => r0, liveness: async () => 'gone' });
    assert.match((await jump(sess(), 'proj')).cant, /Can't tell which terminal window/);
    assert.equal(calls.live, 0);
  }
});

test('B3: nothing recorded is "ended" only when its process is gone, otherwise the old note; never "closed"', async () => {
  for (const [live, want] of [['gone', NOTES.NOTE_ENDED], ['alive', /Can't tell which terminal window/], ['unknown', /Can't tell which terminal window/]]) {
    const { jump } = jumper({ liveness: async () => live });
    const r = await jump(sess({ terminal: undefined }), 'proj');
    if (typeof want === 'string') assert.equal(r.cant, want); else assert.match(r.cant, want);
  }
});

test('B3: a liveness check that takes too long stays neutral, never "still running"', async () => {
  const { jump } = jumper({ liveness: () => new Promise(() => {}) });
  const t0 = Date.now();
  assert.equal((await jump(sess(), 'proj')).cant, NOTES.NOTE_MAYBE_CLOSED);
  assert.ok(Date.now() - t0 < LIVENESS_MS + 1000);
});

test('B3: Warp and Alacritty are opened by bundle id and the note says the tab was not picked; not in tmux, not another app', async () => {
  assert.deepEqual({ ...OPEN_ONLY }, { Warp: 'dev.warp.Warp-Stable', Alacritty: 'org.alacritty' });
  const none = async () => ({ ok: false, reason: 'no adapter for this terminal' });
  for (const app of ['Warp', 'Alacritty']) {
    const { jump, calls } = jumper({ focus: none, openApp: async () => true });
    const r = await jump(sess({ hostApp: app }), 'proj');
    assert.deepEqual(calls.open, [OPEN_ONLY[app]]);
    assert.equal(r.cant, `Opened ${app}. Plexiform can't pick its tab.`);
    assert.equal(r.app, app);
    assert.equal(calls.activate, 0, 'never the title-matching activateTerminalApp');
  }
  // Nothing recorded at all: still the app, by id.
  { const { jump, calls } = jumper({ openApp: async () => true }); await jump(sess({ hostApp: 'Warp', terminal: undefined }), 'proj'); assert.deepEqual(calls.open, ['dev.warp.Warp-Stable']); }
  for (const s of [sess({ hostApp: 'Hyper' }), sess({ hostApp: 'toString' }), sess({ hostApp: 'Warp', terminal: { env: { TMUX_PANE: '%1' } } })]) {
    const { jump, calls } = jumper({ focus: async () => ({ ok: false, reason: Object.keys(s.terminal.env).length ? 'tmux pane not reachable' : 'no adapter for this terminal' }), openApp: async () => true });
    await jump(s, 'proj');
    assert.deepEqual(calls.open, [], s.hostApp);
  }
  // Another machine's session: nothing at all.
  { const { jump, calls } = jumper({ focus: none, openApp: async () => true }); assert.equal(await jump(sess({ hostApp: 'Warp', remote: true }), 'proj'), null); assert.deepEqual(calls.open, []); }
  // Opening failed: the plain notes.
  { const { jump, calls } = jumper({ focus: none, openApp: async () => false }); assert.equal((await jump(sess({ hostApp: 'Warp' }), 'proj')).cant, NOTES.NOTE_MAYBE_CLOSED); assert.deepEqual(calls.open, ['dev.warp.Warp-Stable']); }
  // An ended session says so, and no app is opened for it (recorded or not).
  for (const terminal of [undefined, sess().terminal]) {
    const { jump, calls } = jumper({ focus: none, openApp: async () => true, liveness: async () => 'gone' });
    assert.equal((await jump(sess({ hostApp: 'Alacritty', terminal }), 'proj')).cant, NOTES.NOTE_ENDED);
    assert.deepEqual(calls.open, []);
  }
});

// ── liveness (src/terminal.js) ─────────────────────────────────────────────
function loadTerminal() {
  const Module = require('node:module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { app: {}, screen: {}, Notification: { isSupported: () => false }, shell: {} } : orig.call(this, req, ...rest); };
  try { return require('../src/terminal.js')({ getSessions: () => [], getRootDir: () => '/nonexistent-qol1', getLocalHost: () => HOST }); } finally { Module._load = orig; }
}

test('liveness: Claude only, this computer only; gone is ESRCH; alive also needs the pid to still be claude (reuse guard); EPERM is not gone', async () => {
  const { sessionLiveness } = loadTerminal();
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.on('exit', r));
  const asked = [];
  const ai = (answer) => async (pid, provider) => { asked.push([pid, provider]); return answer; };
  const s = (over) => ({ source: 'claude', host: HOST, claudePid: process.pid, ...over });
  assert.equal(await sessionLiveness(s({ claudePid: child.pid }), HOST, ai(true)), 'gone');
  assert.equal(await sessionLiveness(s(), HOST, ai(true)), 'alive');
  assert.equal(await sessionLiveness(s(), HOST, ai(false)), 'unknown', 'a reused pid is never alive');
  assert.equal(await sessionLiveness(s({ source: 'codex', codexServerPid: process.pid }), HOST, ai(true)), 'unknown', 'a Codex app-server can outlive its thread');
  assert.equal(await sessionLiveness(s({ host: 'other' }), HOST, ai(true)), 'unknown', 'another computer\'s pid is never probed');
  assert.equal(await sessionLiveness(s({ claudePid: undefined }), HOST, ai(true)), 'unknown');
  assert.deepEqual(asked, [[process.pid, 'claude'], [process.pid, 'claude']]);
  const kill = process.kill;
  process.kill = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  try { assert.equal(await sessionLiveness(s({ claudePid: 4242 }), HOST, ai(false)), 'unknown', 'EPERM: exists under another user, not gone'); } finally { process.kill = kill; }
});

// ── B4: no silent caller ──────────────────────────────────────────────────
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
test('B4: every jump result is used; the input click, a notification click and "Go to it" say why nothing switched', () => {
  const main = read('main.js');
  const lines = main.split('\n').filter((l) => /\bjumpToSession\(/.test(l));
  // Each call either keeps the result or (the notification) shows its note.
  for (const l of lines) assert.match(l, /(=\s*await jumpToSession|jumpToSession\(.*\)\.then\(\(r\) => \{ if \(r && r\.cant\) showJumpNote|jump: \(s\) => jumpToSession)/, l.trim().slice(0, 140));
  assert.equal(lines.length, 8); // QoL2 added the widget card's Open (openSessionTerminal)
  assert.match(main, /if \(!session\) return \{ ok: false, note: "This session has ended, so there's no terminal window to show\." \};/);
  assert.match(read('widget.js'), /if \(r\.inputId\) \{ const o = await window\.trafficLight\.openInput\(r\.inputId\)\.catch\(\(\) => null\); if \(o && o\.note\) showFeedback\(o\.note\); return; \}/);
});
