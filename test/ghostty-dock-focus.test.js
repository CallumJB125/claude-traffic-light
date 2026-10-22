'use strict';
// Ghostty Dock as a host app (plan P0) and its focus adapters (plan P1). Ghostty
// Dock isn't installed anywhere these run: the CLI is an exec stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const Focus = require('../src/focus/index.js');
const Ghostty = require('../src/focus/ghostty.js');
const Dock = require('../src/focus/ghostty-dock.js');
const { createJumper } = require('../src/focus/jump.js');
const HostApp = require('../hooks/host-app.js');
const H = require('../hostapp.js');
const { testTempDir } = require('./helpers/tmp');

const HOST = os.hostname().split('.')[0];
const SID = '0b7c9a52-1d3e-4f60-8a9b-2c3d4e5f6a7b';
const CLI = '/Users/me/.local/bin/ghostty-dock';
const TRUSTED = { installed: true, trusted: true, cli: CLI, apiDir: '/Users/me/.local/state/ghostty-dock/api', reason: 'ready' };
const APP_ONLY = { installed: true, trusted: false, cli: null, apiDir: TRUSTED.apiDir, reason: 'CLI not installed' };
const ctxOf = (over = {}) => ({ platform: 'darwin', which: (b) => b[0], isDir: () => true, tmuxServerOk: () => true, ghosttyDock: TRUSTED, ...over });
const sess = (extra = {}) => ({ host: HOST, sessionId: SID, hostApp: 'Ghostty Dock', cwd: '/Users/me/proj', terminal: { env: { TERM_PROGRAM: 'ghostty' }, tty: null, cwd: '/Users/me/proj' }, ...extra });
function fakeExec(answer = () => ({ ok: true })) {
  const calls = [];
  return { calls, exec: async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: '', stderr: '', ...answer(file, args) }; } };
}

// ── P0: the host app ───────────────────────────────────────────────────────

test('the hook records a Ghostty Dock session as Ghostty Dock, and stock Ghostty as Ghostty', () => {
  for (const [bundle, want] of [['consulting.cloudscale.ghosttydock', 'Ghostty Dock'], ['com.mitchellh.ghostty', 'Ghostty']]) {
    const home = testTempDir('px-dock-host-');
    try {
      execFileSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'set-status.js'), 'tool-use'], {
        env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, __CFBundleIdentifier: bundle, TERM_PROGRAM: 'ghostty' },
        input: JSON.stringify({ session_id: 'dock', cwd: '/tmp' }),
      });
      const f = path.join(home, 'sessions', fs.readdirSync(path.join(home, 'sessions')).find((n) => n.endsWith('.json')));
      assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).hostApp, want, bundle);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('the process-tree walk reads the bundle before the shared `ghostty` binary name', () => {
  assert.equal(HostApp.appOfExe('/Users/x/Applications/Ghostty Dock.app/Contents/MacOS/ghostty'), 'Ghostty Dock');
  assert.equal(HostApp.appOfExe('/Applications/Ghostty Dock.app/Contents/MacOS/ghostty'), 'Ghostty Dock');
  assert.equal(HostApp.appOfExe('/Applications/Ghostty.app/Contents/MacOS/ghostty'), 'Ghostty');
  assert.equal(HostApp.appOfExe('/usr/local/bin/ghostty'), 'Ghostty');
  assert.equal(HostApp.appOfExe('/bin/zsh'), null);
});

test('knocking: Ghostty Dock has its own alias, and a recorded Ghostty Dock host wins over Ghostty', () => {
  assert.ok(H.matchesRunning('Ghostty Dock', ['Finder', 'Ghostty Dock']));
  const waiting = (s) => s === 'permission-ask';
  assert.equal(H.pickTerminal([{ hostApp: 'Ghostty Dock', signal: 'permission-ask' }], ['ghostty', 'Ghostty Dock'], waiting), 'Ghostty Dock');
  assert.equal(H.pickTerminal([{ hostApp: 'Ghostty', signal: 'permission-ask' }], ['ghostty', 'Ghostty Dock'], waiting), 'Ghostty');
});

test('stock Ghostty\'s adapter refuses a Ghostty Dock session, so it is never scripted against the wrong app', () => {
  assert.equal(Ghostty.canHandle(sess(), ctxOf()), false);
  assert.equal(Ghostty.canHandle(sess({ hostApp: 'Ghostty' }), ctxOf()), true);
});

// ── P1: the focus adapters ─────────────────────────────────────────────────

test('the CLI adapter runs [cli, focus, <uuid>] as argv, exact, with no Automation permission', async () => {
  const { calls, exec } = fakeExec();
  assert.equal(Dock.cli.canHandle(sess(), ctxOf()), true);
  assert.equal(Dock.cli.needs, undefined);
  assert.deepEqual(await Dock.cli.focus(sess(), { exec, ghosttyDock: TRUSTED }), { ok: true, exact: true });
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [[CLI, ['focus', SID]]]);
  const r = await Focus.focusSession(sess(), ctxOf({ exec }));
  assert.deepEqual([r.ok, r.exact, r.adapter], [true, true, 'ghostty-dock']);
});

test('anything but a full session id is refused before any exec: names, folders and prefixes never go to Dock\'s matcher', () => {
  for (const bad of ['aws-cli', SID.slice(0, 8), '/Users/me/proj', `${SID}; touch /tmp/x`, `-${SID}`, '', undefined]) {
    assert.equal(Dock.cli.canHandle(sess({ sessionId: bad }), ctxOf()), false, String(bad));
  }
});

test('not handled when Preferences turn it off, off macOS, or for another host', () => {
  assert.equal(Dock.cli.canHandle(sess(), ctxOf({ ghosttyDock: null })), false);
  assert.equal(Dock.script.canHandle(sess(), ctxOf({ ghosttyDock: null })), false);
  assert.equal(Dock.cli.canHandle(sess(), ctxOf({ platform: 'linux' })), false);
  assert.equal(Dock.cli.canHandle(sess({ hostApp: 'Ghostty' }), ctxOf()), false);
  assert.equal(Dock.cli.canHandle(sess({ hostApp: undefined }), ctxOf()), false, 'TERM_PROGRAM=ghostty alone is not Ghostty Dock');
});

test('a failing CLI answers ok:false and the jumper switches nothing', async () => {
  const { exec } = fakeExec(() => ({ ok: false, stderr: 'no session' }));
  const r = await Focus.focusSession(sess(), ctxOf({ exec }));
  assert.equal(r.ok, false);
  assert.equal(r.adapter, 'ghostty-dock');
  const activated = [];
  const jump = createJumper({
    localHost: HOST, platform: 'darwin',
    focus: (s, over) => Focus.focusSession(s, { ...over, ...ctxOf({ exec }) }),
    activate: async (...a) => { activated.push(a); return { app: 'Ghostty', exact: false }; },
    explainer: { onNeeds: () => null, onDenied: () => {} },
  });
  const j = await jump(sess(), '/Users/me/proj', 'Ghostty Dock');
  assert.equal(j.app, null);
  assert.match(j.cant, /can.t tell which terminal/i);
  assert.deepEqual(activated, []);
});

test('the jump deadline and cancellation apply to the Dock CLI', async () => {
  const { calls, exec } = fakeExec();
  let t = 0;
  const late = await Focus.focusSession(sess(), ctxOf({ exec, now: () => (t += 5000) }));
  assert.equal(late.ok, false);
  const cancelled = await Focus.focusSession(sess(), ctxOf({ exec, isCancelled: () => true }));
  assert.equal(cancelled.ok, false);
  assert.equal(calls.length, 0);
  const { calls: bounded, exec: exec2 } = fakeExec();
  await Focus.focusSession(sess(), ctxOf({ exec: exec2 }));
  assert.ok(bounded[0].opts.timeout <= Focus.JUMP_DEADLINE_MS, 'bounded by the deadline');
});

test('without a usable CLI the fallback AppleScript addresses Ghostty Dock by bundle id and passes the folder as argv', async () => {
  const s = sess();
  s.terminal.cwd = '/Users/me/my "quoted" proj';
  assert.equal(Dock.cli.canHandle(s, ctxOf({ ghosttyDock: APP_ONLY })), false);
  assert.equal(Dock.script.canHandle(s, ctxOf({ ghosttyDock: APP_ONLY })), true);
  assert.equal(Dock.script.canHandle(s, ctxOf()), false, 'the CLI path wins when trusted');
  assert.equal(Dock.script.canHandle(s, ctxOf({ ghosttyDock: { ...APP_ONLY, installed: false } })), false);
  assert.deepEqual(Dock.script.needs.permission, 'automation');
  assert.match(Dock.SCRIPT, /tell application id "consulting\.cloudscale\.ghosttydock"/);
  assert.doesNotMatch(Dock.SCRIPT, /application "Ghostty"/);
  const { calls, exec } = fakeExec(() => ({ ok: true, stdout: 'ok' }));
  assert.equal((await Dock.script.focus(s, { exec })).ok, true);
  assert.deepEqual(calls[0].args, ['-e', Dock.SCRIPT, '/Users/me/my "quoted" proj']);
  assert.ok(!calls[0].args[1].includes('quoted'), 'the folder is never in the script source');
});

test('the Dock adapters come before stock Ghostty\'s', () => {
  const ids = Focus.ADAPTERS.map((a) => a.id);
  assert.ok(ids.indexOf('ghostty-dock') < ids.indexOf('ghostty'));
  assert.ok(ids.indexOf('ghostty-dock-script') < ids.indexOf('ghostty'));
});
