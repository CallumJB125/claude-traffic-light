'use strict';
// Security review M2: a click asks Dock's list once, under one 2.5 s budget
// for the whole flow (the needs-you queue, then adoption), and a CLI that
// ignores SIGTERM or leaves a child holding its output is SIGKILLed and given
// up on, about 500 ms after its timeout. (Timeouts here are 1 s so the
// shell has set its trap before the TERM arrives.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const GhosttyDock = require('../src/ghostty-dock.js');
const { createJumper } = require('../src/focus/jump.js');

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const HOST = os.hostname().split('.')[0];
const DOCK = { installed: true, trusted: true, canOpen: true, cli: '/fake/ghostty-dock', apiDir: '/x', env: { HOME: '/h', PATH: '/usr/bin:/bin', TMPDIR: '/tmp' }, reason: 'ready' };
const running = (file, args) => file === '/usr/bin/osascript' && args[1] === GhosttyDock.RUNNING_SCRIPT;
const slow = (ms, stdout) => new Promise((r) => setTimeout(() => r({ ok: true, stdout, stderr: '' }), ms));

function terminalModule() {
  const Module = require('node:module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { app: {}, screen: {}, Notification: { isSupported: () => false }, shell: {} } : orig.call(this, req, ...rest); };
  try { return require('../src/terminal.js'); } finally { Module._load = orig; }
}

function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('execCli gives up on a CLI that ignores SIGTERM, SIGKILLing it about 500 ms after its timeout', async () => {
  const dir = testTempDir('px-dock-term-');
  try {
    const cli = script(dir, 'ignore-term', 'trap "" TERM\n/bin/sleep 6');
    const t0 = Date.now();
    const r = await GhosttyDock.execCli(cli, [], { timeout: 1000, env: { PATH: '/usr/bin:/bin' } });
    const took = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.ok(took < 2200, `took ${took} ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('execCli gives up when a grandchild keeps the output pipe open past the kill', async () => {
  const dir = testTempDir('px-dock-hang-');
  try {
    const cli = script(dir, 'hang', `/bin/sleep 6\necho 'waiting x ${SID}'`);
    const t0 = Date.now();
    const r = await GhosttyDock.execCli(cli, [], { timeout: 1000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 2200, `took ${Date.now() - t0} ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PoC: running check and list each just under 2.5 s — the whole click still stalls under 3 s and asks Dock once', async () => {
  GhosttyDock.invalidateList();
  let lists = 0;
  const exec = async (file, args) => {
    if (running(file, args)) return slow(2400, 'true\n');
    lists += 1;
    return slow(2400, JSON.stringify([{ status: 'running', session_id: SID }]));
  };
  const T = terminalModule();
  const t0 = Date.now();
  // main.js dockStatusFor, then the jumper's adoption, as go-to-needing-session runs them.
  const status = await GhosttyDock.listStatus({ dock: DOCK, exec });
  let focusedAt = null;
  const jump = createJumper({
    localHost: HOST, platform: 'darwin',
    adopt: (s) => T.adoptIntoDock(s, { mode: 'auto', detect: () => DOCK, listStatus: (o) => GhosttyDock.listStatus({ ...o, exec }) }),
    focus: async () => { focusedAt = Date.now() - t0; return { ok: true, adapter: 'terminal', exact: true }; },
    activate: async () => null,
    explainer: { onNeeds: () => null, onDenied: () => {} },
  });
  await jump({ sessionId: SID, hostApp: 'Terminal', terminal: { app: 'Terminal' }, host: HOST, cwd: '/tmp' }, 'tmp');
  assert.equal(status, null, 'over budget counts as no answer');
  assert.ok(focusedAt !== null && focusedAt < 3000, `focus started after ${focusedAt} ms`);
  assert.ok(lists <= 1, `list asked ${lists} times`);
  GhosttyDock.invalidateList();
});

test('PoC: a SIGTERM-ignoring list CLI (real process) still answers the click inside 3 s', async () => {
  const dir = testTempDir('px-dock-ignore-');
  try {
    const cli = script(dir, 'ghostty-dock', 'trap "" TERM\n/bin/sleep 8');
    const exec = async (file, args, opts) => (running(file, args) ? slow(2400, 'true\n') : GhosttyDock.execCli(file, args, opts));
    GhosttyDock.invalidateList();
    const t0 = Date.now();
    assert.equal(await GhosttyDock.listStatus({ dock: { ...DOCK, cli }, exec }), null);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  } finally { GhosttyDock.invalidateList(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent callers share one in-flight list, and the cache is stamped when it completes', async () => {
  GhosttyDock.invalidateList();
  let t = 0;
  let lists = 0;
  const exec = async (file, args) => {
    if (running(file, args)) return { ok: true, stdout: 'true\n' };
    lists += 1;
    await slow(50);
    t += 1900; // the call "took" 1.9 s on the injected clock
    return { ok: true, stdout: JSON.stringify([{ status: 'waiting', session_id: SID }]) };
  };
  const clock = () => t;
  const [a, b] = await Promise.all([GhosttyDock.listStatus({ dock: DOCK, exec, clock }), GhosttyDock.listStatus({ dock: DOCK, exec, clock })]);
  assert.equal(lists, 1);
  assert.equal(a.get(SID), 'waiting');
  assert.equal(b, a);
  t += 1500; // 3.4 s after the call started, 1.5 s after it answered
  await GhosttyDock.listStatus({ dock: DOCK, exec, clock });
  assert.equal(lists, 1, 'still fresh: stamped at completion, not at start');
  GhosttyDock.invalidateList();
});

test('run(list) gives the running check and list one shared budget', async () => {
  const seen = [];
  const exec = async (file, args, opts) => { seen.push(opts.timeout); if (running(file, args)) { await slow(300); return { ok: true, stdout: 'true\n' }; } return { ok: true, stdout: '[]' }; };
  await GhosttyDock.run('list', ['--json'], { dock: DOCK, exec });
  assert.equal(seen[0], GhosttyDock.LIST_TIMEOUT_MS);
  assert.ok(seen[1] <= GhosttyDock.LIST_TIMEOUT_MS - 250, `list got ${seen[1]} ms after a 300 ms check`);
});
