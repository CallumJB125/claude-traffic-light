'use strict';
// Ghostty Dock's list → exact-tab jumps for sessions recorded under another
// app, the needs-you queue and honest feedback. No Ghostty Dock anywhere:
// every exec is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const GhosttyDock = require('../src/ghostty-dock.js');
const Focus = require('../src/focus/index.js');
const Dock = require('../src/focus/ghostty-dock.js');
const { createJumper } = require('../src/focus/jump.js');
const { needingQueue, jumpFeedback } = require('../src/needing-queue.js');

const HOST = os.hostname().split('.')[0];
const SID = '0b7c9a52-1d3e-4f60-8a9b-2c3d4e5f6a7b';
const SID2 = '1c8dab63-2e4f-4071-9bac-3d4e5f6a7b8c';
const CLI = '/Users/me/.local/bin/ghostty-dock';
const DOCK = { installed: true, trusted: true, canOpen: true, cli: CLI, apiDir: '/x', env: { HOME: '/Users/me', PATH: '/usr/bin', TMPDIR: '/tmp' }, reason: 'ready' };
const running = (file, args) => file === '/usr/bin/osascript' && args[1] === GhosttyDock.RUNNING_SCRIPT;
function listExec(stdout, { up = true } = {}) {
  const calls = [];
  return { calls, exec: async (file, args, opts) => { calls.push({ file, args, opts }); if (running(file, args)) return { ok: up, stdout: up ? 'true\n' : 'false\n' }; return { ok: true, stdout, stderr: '' }; } };
}
const row = (status, name, id) => JSON.stringify([{ status, name, session_id: id, branch: 'main' }]);

test('listStatus runs only `list --json`, after a running check, bounded and cached for 2 s', async () => {
  GhosttyDock.invalidateList();
  const { calls, exec } = listExec(row('waiting', 'api', SID));
  let t = 1000;
  const clock = () => t;
  const a = await GhosttyDock.listStatus({ dock: DOCK, exec, clock });
  assert.equal(a.get(SID), 'waiting');
  assert.deepEqual(calls.map((c) => [c.file, c.args[0]]), [['/usr/bin/osascript', '-e'], [CLI, 'list']]);
  assert.deepEqual(calls[1].args, ['list', '--json']);
  assert.ok(calls[1].opts.timeout > 0 && calls[1].opts.timeout <= GhosttyDock.LIST_TIMEOUT_MS);
  assert.deepEqual(calls[1].opts.env, DOCK.env);
  t = 2500;
  await GhosttyDock.listStatus({ dock: DOCK, exec, clock });
  assert.equal(calls.length, 2, 'cached');
  t = 3001;
  await GhosttyDock.listStatus({ dock: DOCK, exec, clock });
  assert.equal(calls.length, 4, 'expired after 2 s');
  GhosttyDock.invalidateList();
  assert.equal(await GhosttyDock.listStatus({ dock: { ...DOCK, trusted: false, cli: null }, exec }), null);
  GhosttyDock.invalidateList();
  const down = listExec(row('waiting', 'api', SID), { up: false });
  assert.equal(await GhosttyDock.listStatus({ dock: DOCK, exec: down.exec }), null);
  assert.equal(down.calls.length, 1, 'no CLI call while Dock is not running');
  GhosttyDock.invalidateList();
  await assert.rejects(GhosttyDock.run('list', [], { dock: DOCK, exec }), /bad arguments/);
});

// ── adoption ───────────────────────────────────────────────────────────────
const Terminal = () => {
  // src/terminal.js needs electron; adoptIntoDock is a plain function on it, so load it with a stub.
  const Module = require('node:module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { app: {}, screen: {}, Notification: { isSupported: () => false }, shell: {} } : orig.call(this, req, ...rest); };
  try { return require('../src/terminal.js')({ getSessions: () => [], getRootDir: () => os.tmpdir(), getLocalHost: () => HOST }); } finally { Module._load = orig; }
};
const ghosttySess = (extra = {}) => ({ host: HOST, sessionId: SID, hostApp: 'Ghostty', cwd: '/Users/me/proj', terminal: { env: { TERM_PROGRAM: 'ghostty' }, cwd: '/Users/me/proj' }, ...extra });

test('a session recorded as Ghostty that Dock lists by its exact id is focused through the Dock CLI', async () => {
  const T = Terminal();
  const listed = new Map([[SID, 'running']]);
  const adopt = (s) => T.adoptIntoDock(s, { mode: 'auto', detect: () => DOCK, listStatus: async () => listed });
  const a = await adopt(ghosttySess());
  assert.equal(a.hostApp, 'Ghostty Dock');
  assert.equal(a.sessionId, SID);
  assert.equal(await adopt(ghosttySess({ sessionId: SID2 })), null, 'not in the list');
  assert.equal(await adopt(ghosttySess({ sessionId: 'not-a-uuid' })), null);
  assert.equal(await adopt(ghosttySess({ hostApp: 'Ghostty Dock' })), null, 'already Dock');
  assert.equal(await T.adoptIntoDock(ghosttySess(), { mode: 'off', detect: () => DOCK, listStatus: async () => listed }), null, 'off in Preferences');
  assert.equal(await T.adoptIntoDock(ghosttySess(), { mode: 'auto', detect: () => ({ ...DOCK, trusted: false }), listStatus: async () => listed }), null, 'untrusted');

  const calls = [];
  const exec = async (file, args) => { calls.push([file, ...args]); return running(file, args) ? { ok: true, stdout: 'true' } : { ok: true, stdout: '' }; };
  const jump = createJumper({
    localHost: HOST, platform: 'darwin', adopt,
    focus: (s, over) => Focus.focusSession(s, { ...over, platform: 'darwin', exec, ghosttyDock: s.hostApp === 'Ghostty Dock' ? DOCK : null }),
    activate: async () => { throw new Error('never activates on macOS'); },
    explainer: { onNeeds: () => null, onDenied: () => {} },
  });
  const r = await jump(ghosttySess(), 'proj');
  assert.deepEqual(r, { app: 'Ghostty Dock', exact: true });
  assert.deepEqual(calls.at(-1), [CLI, 'focus', SID]);
});

test('an adopted session with no terminal recorded still gets the exact Dock focus; unlisted ones still say nothing was switched', async () => {
  const exec = async (file, args) => (running(file, args) ? { ok: true, stdout: 'true' } : { ok: true, stdout: '' });
  const mk = (listed) => createJumper({
    localHost: HOST, platform: 'darwin',
    adopt: async (s) => (listed ? { ...s, hostApp: 'Ghostty Dock' } : null),
    focus: (s, over) => Focus.focusSession(s, { ...over, platform: 'darwin', exec, ghosttyDock: s.hostApp === 'Ghostty Dock' ? DOCK : null }),
    activate: async () => null,
    explainer: { onNeeds: () => null, onDenied: () => {} },
  });
  assert.equal((await mk(true)(ghosttySess({ terminal: undefined }), 'proj')).exact, true);
  assert.match((await mk(false)(ghosttySess({ terminal: undefined }), 'proj')).cant, /can.t tell/i);
});

test('the Dock folder fallback is reported as by-folder, never exact', async () => {
  const exec = async () => ({ ok: true, stdout: 'ok' });
  assert.deepEqual(await Dock.script.focus(ghosttySess({ hostApp: 'Ghostty Dock' }), { exec }), { ok: true, exact: false, byFolder: true });
  const jump = createJumper({
    localHost: HOST, platform: 'darwin',
    focus: async () => ({ ok: true, adapter: 'ghostty-dock-script', exact: false, byFolder: true }),
    activate: async () => null,
    explainer: { onNeeds: () => null, onDenied: () => {} },
  });
  assert.deepEqual(await jump(ghosttySess({ hostApp: 'Ghostty Dock' }), 'proj'), { app: 'Ghostty Dock', exact: false, byFolder: true });
});

// ── queue ──────────────────────────────────────────────────────────────────
const s = (id, signal, at) => ({ sessionId: id, signal, updatedAt: new Date(at).toISOString(), cwd: `/p/${id}` });
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('the queue: blocked ones longest-waiting first, then finished; a limit hit still jumps the queue', () => {
  const list = [s('fin-old', 'stop', 1), s('ask-new', 'permission-ask', 50), s('ask-old', 'permission-ask', 10), s('fin-new', 'idle-nudge', 60), s('failed', 'turn-failed', 30), s('busy', 'tool-start', 0)];
  assert.deepEqual(needingQueue(list).map((x) => x.sessionId), ['ask-old', 'failed', 'ask-new', 'fin-old', 'fin-new']);
  assert.deepEqual(needingQueue([...list, s('lim', 'limit-hit', 99)]).map((x) => x.sessionId), ['lim']);
  assert.deepEqual(needingQueue(null), []);
});

test('a session Dock shows as waiting joins the blocked tier, but only one Plexiform knows by that exact id', () => {
  const list = [s(U(1), 'tool-start', 5), s(U(2), 'stop', 1), s(U(3), 'session-end', 2), s(U(4), 'permission-ask', 9)];
  const dockStatus = new Map([[U(1), 'waiting'], [U(3), 'waiting'], [U(9), 'waiting'], [U(2), 'running']]);
  const q = needingQueue(list, { dockStatus });
  assert.deepEqual(q.map((x) => x.sessionId), [U(1), U(4), U(2)]);
  assert.equal(q.length, 3, 'U(9) is not invented; an ended session is not revived; Dock "running" does not demote');
  assert.deepEqual(needingQueue([s(U(1).toUpperCase(), 'tool-start', 1)], { dockStatus }).length, 1, 'ids compare case-insensitively');
});

test('feedback says plainly when only the app came forward', () => {
  assert.equal(jumpFeedback('proj', '', { app: 'Ghostty Dock', exact: true }), '→ proj · tab found · path copied');
  assert.equal(jumpFeedback('proj', ' (1/2)', { app: 'Ghostty Dock', exact: false }), "Opened Ghostty Dock — couldn't pick the tab (proj (1/2)) · path copied");
  assert.match(jumpFeedback('proj', '', { app: 'Ghostty Dock', exact: false, byFolder: true }), /the one Ghostty Dock tab in that folder/);
  assert.doesNotMatch(jumpFeedback('proj', '', { app: 'Ghostty Dock', exact: false, byFolder: true }), /tab found/);
  assert.equal(jumpFeedback('proj', '', { app: null, cant: 'nope' }), 'proj: nope');
  assert.equal(jumpFeedback('proj', '', null), '→ proj · path copied');
});

test('a hung Dock list costs a jump to another terminal at most ADOPT_MS', async () => {
  const { ADOPT_MS } = require('../src/focus/jump.js');
  assert.equal(ADOPT_MS, 2500);
  const t0 = Date.now();
  const focused = [];
  const jump = createJumper({
    localHost: HOST, platform: 'darwin',
    adopt: () => new Promise(() => {}),
    focus: async (s) => { focused.push(s.hostApp); return { ok: true, adapter: 'iterm', exact: true }; },
    activate: async () => null,
    explainer: { onNeeds: () => null, onDenied: () => {} },
  });
  const r = await jump(ghosttySess({ hostApp: 'iTerm2' }), 'proj');
  assert.equal(r.exact, true);
  assert.deepEqual(focused, ['iTerm2']);
  assert.ok(Date.now() - t0 < ADOPT_MS + 1500);
});
