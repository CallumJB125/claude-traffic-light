'use strict';
// QoL2 (plan-qol2 Rev 2): a session's own widget card. It shows the folder (~ for home), how long a waiting session
// has waited, and offers Open (that session's terminal), the file manager, the editor, and copying the resume
// command for an ended session. That command is only copied, never run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const A = require('../src/session-row-actions.js');
const V = require('../src/session-card-view.js');
const Cards = require('../src/widget-cards-main.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

// ── the resume command ─────────────────────────────────────────────────────
test('resume: cd into the quoted folder, then the provider command; Claude and Codex by source', () => {
  assert.equal(A.resumeCommand({ sessionId: 'abc-123', cwd: '/Users/me/my work' }), "cd '/Users/me/my work' && claude --resume abc-123");
  assert.equal(A.resumeCommand({ sessionId: 'abc', cwd: "/p/it's here", source: 'claude' }), "cd '/p/it'\\''s here' && claude --resume abc");
  assert.equal(A.resumeCommand({ sessionId: 't.1', cwd: '/p', source: 'codex' }), "cd '/p' && codex resume t.1");
  // The quoted folder is one word to the shell, whatever it holds.
  assert.equal(A.shellQuote("a'b; rm -rf ~ $(x) `y`"), "'a'\\''b; rm -rf ~ $(x) `y`'");
});

test('resume: no command for another source, a bad id, a folder with a newline or NUL, a relative folder, or a remote row', () => {
  for (const row of [
    { sessionId: 'a', cwd: '/p', source: 'gemini' }, { sessionId: 'a', cwd: '/p', source: 'toString' }, { sessionId: 'a', cwd: '/p', source: '__proto__' },
    { sessionId: 'a b', cwd: '/p' }, { sessionId: 'a;b', cwd: '/p' }, { sessionId: '', cwd: '/p' }, { sessionId: 7, cwd: '/p' },
    { sessionId: 'a', cwd: '/p\nrm -rf ~' }, { sessionId: 'a', cwd: '/p\u0000x' }, { sessionId: 'a', cwd: '/p\rx' }, { sessionId: 'a', cwd: 'p' }, { sessionId: 'a' },
    { sessionId: 'a', cwd: '/p', remote: true }, null, 'x',
  ]) assert.equal(A.resumeCommand(row), null, JSON.stringify(row));
});

// ── the folder line and the waiting time ───────────────────────────────────
test('folder: home becomes ~ only on a path boundary; long folders keep both ends', () => {
  assert.equal(A.folderLabel('/Users/me', '/Users/me'), '~');
  assert.equal(A.folderLabel('/Users/me/src/app', '/Users/me'), '~/src/app');
  assert.equal(A.folderLabel('/Users/me/src/app', '/Users/me/'), '~/src/app');
  assert.equal(A.folderLabel('/Users/mex/app', '/Users/me'), '/Users/mex/app');
  assert.equal(A.folderLabel('/srv/app', '/'), '/srv/app');
  const long = A.folderLabel(`/Users/me/${'a'.repeat(100)}/end`, '/Users/me');
  assert.equal([...long].length, 80);
  assert.match(long, /^~\/a+…a+\/end$/);
  assert.equal(A.folderLabel('', '/Users/me'), null);
  assert.equal(A.folderLabel('/p/‮x', null), '/p/x');
});

test('waiting time: hidden under a minute, then m, h, d', () => {
  assert.equal(A.waitShort(59_999), '');
  assert.equal(A.waitShort(4 * 60_000), '4m');
  assert.equal(A.waitShort(125 * 60_000), '2h');
  assert.equal(A.waitShort(50 * 3600_000), '2d');
  assert.equal(A.waitShort(NaN), '');
});

// ── opening the folder ─────────────────────────────────────────────────────
function folderRig(platform = 'darwin') {
  const calls = [];
  const deps = { platform, fs, execFile: (bin, args) => calls.push(['exec', bin, ...args]), shell: { openPath: (p) => calls.push(['openPath', p]) }, editorCommand: (a) => a || 'code' };
  return { calls, deps };
}

test('Finder on macOS reveals the folder with open -R, so a folder named x.app is shown and never launched', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qol2-')));
  const app = path.join(dir, 'Evil.app');
  fs.mkdirSync(app);
  try {
    const { calls, deps } = folderRig('darwin');
    const r = A.openFolder('finder', app, deps);
    assert.deepEqual(calls, [['exec', '/usr/bin/open', '-R', app]]);
    assert.equal(r.ok, true);
    assert.equal(r.feedback, 'Finder → Evil.app');
    // Elsewhere the file manager opens the folder (no package semantics there).
    const lin = folderRig('linux');
    A.openFolder('finder', app, lin.deps);
    assert.deepEqual(lin.calls, [['openPath', app]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the editor gets the saved app or the default, never anything else; a missing, relative or file path opens nothing', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qol2-')));
  try {
    const { calls, deps } = folderRig('darwin');
    assert.equal(A.openFolder('editor', dir, deps).ok, true);
    assert.equal(A.openFolder('editor', dir, deps, 'Zed').feedback, `Zed → ${path.basename(dir)}`);
    assert.deepEqual(calls, [['exec', '/usr/bin/open', '-a', 'Visual Studio Code', dir], ['exec', '/usr/bin/open', '-a', 'Zed', dir]]);
    const file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'x');
    const none = folderRig('darwin');
    for (const p of [path.join(dir, 'gone'), 'relative/dir', file, `${dir}\nx`, null]) assert.equal(A.openFolder('finder', p, none.deps).ok, false, String(p));
    assert.equal(A.openFolder('shell', dir, none.deps).ok, false);
    assert.deepEqual(none.calls, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the card model ─────────────────────────────────────────────────────────
test('card: own local sessions get the folder and the folder buttons; a teammate or another device never does', () => {
  const own = V.sessionCard({ sessionId: 's', cwd: '/Users/me/app', signal: 'tool-use' }, { now: NOW, home: '/Users/me', platform: 'darwin' });
  assert.equal(own.folder, '~/app');
  assert.equal(own.folderApp, 'Finder');
  assert.deepEqual(own.actions, ['open', 'finder', 'editor', 'pin']);
  const mate = V.sessionCard({ sessionId: 's', cwd: '/Users/me/app', signal: 'tool-use' }, { now: NOW, home: '/Users/me', teammate: { name: 'Ann' } });
  assert.equal(mate.folder, null);
  assert.deepEqual(mate.actions, []);
  const away = V.sessionCard({ sessionId: 'remote:s', cwd: '/Users/me/app', signal: 'idle', remote: true }, { now: NOW, home: '/Users/me', resumable: true });
  assert.equal(away.folder, null);
  assert.deepEqual(away.actions, ['pin']);
  assert.equal(V.sessionCard({ sessionId: 's', cwd: '/p' }, { now: NOW, platform: 'win32' }).folderApp, 'Explorer');
  assert.equal(V.sessionCard({ sessionId: 's', cwd: '/p' }, { now: NOW, platform: 'linux' }).folderApp, 'Files');
});

test('card: copy-resume only on an idle card main called resumable; the waiting time only on a waiting card, from a minute', () => {
  const idle = (o) => V.sessionCard({ sessionId: 's', cwd: '/p', signal: 'session-end' }, { now: NOW, ...o }).actions;
  assert.deepEqual(idle({ resumable: true }), ['open', 'copy-resume', 'finder', 'editor', 'pin']);
  assert.deepEqual(idle({ resumable: false }), ['open', 'finder', 'editor', 'pin']);
  assert.deepEqual(idle({ resumable: 'yes' }), ['open', 'finder', 'editor', 'pin']);
  const waiting = V.sessionCard({ sessionId: 's', cwd: '/p', signal: 'permission-ask', signalSince: ago(4) }, { now: NOW, resumable: true });
  assert.ok(!waiting.actions.includes('copy-resume'));
  assert.equal(waiting.waitFor, '4m');
  assert.equal(V.sessionCard({ sessionId: 's', signal: 'permission-ask', signalSince: new Date(NOW - 30_000).toISOString() }, { now: NOW }).waitFor, '');
  assert.equal(V.sessionCard({ sessionId: 's', signal: 'tool-use', signalSince: ago(9) }, { now: NOW }).waitFor, '');
});

// ── IPC, through the real handlers ─────────────────────────────────────────
function rig({ sessions, alive = 'gone', allowed = () => true, clock } = {}) {
  const handlers = new Map(), copied = [], opened = [], exec = [];
  let t = NOW;
  const api = Cards.install({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, config: { load: () => ({}), save: () => {} }, allowed, now: clock || (() => (t += 1000)),
    getSessions: () => sessions, home: '/Users/me', platform: 'darwin',
    liveness: async (row) => (typeof alive === 'function' ? alive(row) : alive),
    copyText: (s) => copied.push(s), openSession: async (how, row) => { opened.push([how, row.sessionId]); return { ok: true, feedback: `${how} ${row.sessionId}` }; } });
  const sender = (id = 1) => ({ sender: { id } });
  return { handlers, copied, opened, exec, api, call: (ch, req, e = sender()) => handlers.get(ch)(e, req) };
}
const ENDED = { sessionId: 'c1', cwd: "/Users/me/it's app", signal: 'session-end', source: 'claude' };

test('copy-resume copies the quoted command for your own ended session and says only that it copied', async () => {
  const r = rig({ sessions: [ENDED, { sessionId: 'x1', cwd: '/p', signal: 'idle', remote: true }] });
  const out = await r.call('widget:session-copy-resume', { id: 'c1' });
  assert.deepEqual(out, { ok: true, feedback: 'Copied the resume command.' });
  assert.deepEqual(r.copied, ["cd '/Users/me/it'\\''s app' && claude --resume c1"]);
  assert.ok(!out.feedback.includes('/Users'));
});

test('copy-resume refuses a session that is still running, a remote or unknown id, a bad shape, another sender, and a second click within half a second', async () => {
  assert.deepEqual(await rig({ sessions: [ENDED], alive: 'alive' }).call('widget:session-copy-resume', { id: 'c1' }), { ok: false, feedback: "It's still running. Open it instead." });
  const r = rig({ sessions: [ENDED, { sessionId: 'x1', cwd: '/p', signal: 'idle', remote: true }] });
  for (const req of [{ id: 'x1' }, { id: 'nope' }]) assert.equal((await r.call('widget:session-copy-resume', req)).ok, false);
  for (const req of [{ id: 'c1', text: 'rm -rf ~' }, 'c1', ['c1'], null, { id: '../c1' }, Object.assign(Object.create({ x: 1 }), { id: 'c1' })]) assert.deepEqual(await r.call('widget:session-copy-resume', req), { ok: false, feedback: '' });
  assert.deepEqual(r.copied, []);
  assert.deepEqual(await rig({ sessions: [ENDED], allowed: () => false }).call('widget:session-copy-resume', { id: 'c1' }), { ok: false, feedback: '' });
  const fixed = rig({ sessions: [ENDED], clock: () => NOW });
  assert.equal((await fixed.call('widget:session-copy-resume', { id: 'c1' })).ok, true);
  assert.equal((await fixed.call('widget:session-copy-resume', { id: 'c1' })).ok, false);
  assert.equal((await fixed.call('widget:session-copy-resume', { id: 'c1' }, { sender: { id: 2 } })).ok, true, 'the limit is per sender');
});

test('copy-resume never runs anything: its handler only copies', () => {
  const src = read('src/widget-cards-main.js');
  const body = src.slice(src.indexOf('async function copyResume('), src.indexOf("ipcMain.handle('widget:session-cards'"));
  assert.ok(body.length > 100);
  assert.doesNotMatch(body, /execFile|spawn|exec\(|shell\.|openSession|child_process/);
  assert.doesNotMatch(read('src/session-row-actions.js').slice(0, read('src/session-row-actions.js').indexOf('function openFolder(')), /execFile\(|spawn|child_process/);
  assert.doesNotMatch(src, /child_process/);
});

test('session-open: a fixed set of hows, on your own row re-found by id; nothing for a remote row or a forged how', async () => {
  const rows = [{ sessionId: 'a1', cwd: '/p', signal: 'idle' }, { sessionId: 'x1', cwd: '/p', signal: 'idle', remote: true }];
  const r = rig({ sessions: rows });
  for (const how of ['terminal', 'finder', 'editor']) assert.deepEqual(await r.call('widget:session-open', { id: 'a1', how }), { ok: true, feedback: `${how} a1` });
  assert.deepEqual(r.opened, [['terminal', 'a1'], ['finder', 'a1'], ['editor', 'a1']]);
  assert.equal((await r.call('widget:session-open', { id: 'x1', how: 'finder' })).ok, false);
  for (const req of [{ id: 'a1', how: 'shell' }, { id: 'a1', how: 'toString' }, { id: 'a1' }, { id: 'a1', how: 'finder', cwd: '/etc' }, { id: 'a1', how: 'editor', app: 'Terminal' }]) assert.deepEqual(await r.call('widget:session-open', req), { ok: false, feedback: '' });
  assert.equal(r.opened.length, 3);
});

test('cards: copy-resume is offered for an idle session not known to be running, never for a running or waiting one', async () => {
  const rows = [ENDED, { sessionId: 'w1', cwd: '/p', signal: 'permission-ask', signalSince: ago(4) }, { sessionId: 'k1', cwd: '/q', signal: 'idle', source: 'codex' }];
  const actions = async (alive) => Object.fromEntries((await rig({ sessions: rows, alive }).handlers.get('widget:session-cards')({})).rows.map((x) => [x.id, x.card.actions]));
  const gone = await actions('gone');
  assert.ok(gone.c1.includes('copy-resume'));
  assert.ok(gone.k1.includes('copy-resume'), "Codex is never called alive, so an idle Codex session is offered");
  assert.ok(!gone.w1.includes('copy-resume'));
  const running = await actions('alive');
  assert.ok(!running.c1.includes('copy-resume') && !running.k1.includes('copy-resume'));
  const slow = await actions(() => new Promise(() => {}));
  assert.ok(slow.c1.includes('copy-resume'), 'a liveness check that never answers is bounded and counts as unknown');
});

// ── the widget, its own code in JSDOM ──────────────────────────────────────
function widget(model) {
  const src = read('widget.js');
  const slice = src.slice(src.indexOf('const CARD_DELAY_MS = 350;'));
  const dom = new JSDOM('<body><div id="strip"></div><div id="session-card"></div></body>', { runScripts: 'outside-only' });
  const w = dom.window, calls = [], feedback = [];
  w.trafficLight = { getSessionCards: async () => model, sessionOpen: async (id, how) => { calls.push(['open', id, how]); return { feedback: `ok ${how}` }; }, copyResume: async (id) => { calls.push(['copy', id]); return { ok: true, feedback: 'Copied the resume command.' }; },
    goToNeedingSession: async () => { calls.push(['needing']); return {}; }, pinSession: async () => ({}) };
  w.showFeedback = (t) => feedback.push(t);
  w.stop = (e) => e.stopPropagation();
  w.eval(slice);
  return { w, calls, feedback, doc: w.document };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('widget: a waiting chip shows " · 4m" after its title; the card shows the folder, and Open acts on that session, not the needing queue', async () => {
  const card = (o) => ({ id: 's1', title: 'shop', state: 'Needs you since 4 min', waiting: true, idle: false, actions: ['open', 'copy-resume', 'finder', 'editor'], folder: '~/src/shop', folderApp: 'Finder', waitFor: '4m', help: [], ...o });
  const f = widget({ rows: [{ kind: 'session', id: 's1', card: card() }, { kind: 'session', id: 's2', card: card({ waiting: false, waitFor: '', title: 'docs' }) }], team: [] });
  f.w.loadCards(true); await tick();
  const chips = [...f.doc.querySelectorAll('#strip .chip')];
  assert.equal(chips[0].querySelector('.chip-wait').textContent, ' · 4m');
  assert.equal(chips[0].textContent, 'shop · 4m');
  assert.equal(chips[1].querySelector('.chip-wait'), null);
  chips[0].dispatchEvent(new f.w.FocusEvent('focus'));
  assert.equal(f.doc.querySelector('#session-card .card-folder').textContent, '~/src/shop');
  const buttons = () => [...f.doc.querySelectorAll('#session-card .card-acts button')];
  assert.deepEqual(buttons().map((b) => b.textContent), ['Open', 'Copy resume', 'Finder', 'Editor']);
  for (let i = 0; i < 4; i += 1) { chips[0].dispatchEvent(new f.w.FocusEvent('focus')); buttons()[i].click(); await tick(); }
  assert.deepEqual(f.calls, [['open', 's1', 'terminal'], ['copy', 's1'], ['open', 's1', 'finder'], ['open', 's1', 'editor']]);
  assert.deepEqual(f.feedback, ['ok terminal', 'Copied the resume command.', 'ok finder', 'ok editor']);
});

test('widget: the folder and titles are text, never markup', async () => {
  const f = widget({ rows: [{ kind: 'session', id: 's1', card: { id: 's1', title: '<img src=x onerror=1>', state: 's', waiting: true, waitFor: '<b>1m</b>', actions: [], folder: '<i>~/x</i>', folderApp: 'Finder', help: [] } }], team: [] });
  f.w.loadCards(true); await tick();
  const chip = f.doc.querySelector('#strip .chip');
  chip.dispatchEvent(new f.w.FocusEvent('focus'));
  assert.equal(f.doc.querySelectorAll('img, b, i:not(.dot)').length, 0);
  assert.equal(f.doc.querySelector('.card-folder').textContent, '<i>~/x</i>');
});

test('the gesture Finder action goes through the same reveal; the card copy passes the copy and platform tests', () => {
  const main = read('main.js');
  assert.match(main, /case 'finder': if \(!cwd\) return \{ feedback: 'no session folder' \}; return \{ feedback: RowActions\.openFolder\('finder', cwd, folderDeps\)\.feedback \};/);
  assert.doesNotMatch(main.slice(main.indexOf("case 'finder':"), main.indexOf("case 'editor':")), /shell\.openPath/);
  assert.match(main, /openSession: \(how, s\) => \(how === 'terminal' \? openSessionTerminal\(s\) : RowActions\.openFolder\(how, s\.cwd, folderDeps, savedEditor\(\)\)\)/);
  assert.match(read('preload.js'), /sessionOpen: \(id, how\) => \(typeof id === 'string' && \['terminal', 'finder', 'editor'\]\.includes\(how\) \? ipcRenderer\.invoke\('widget:session-open', \{ id, how \}\)/);
  assert.match(read('preload.js'), /copyResume: \(id\) => \(typeof id === 'string' \? ipcRenderer\.invoke\('widget:session-copy-resume', \{ id \}\)/);
});
