'use strict';
// Ghostty Dock is not installed on CI or on the dev Mac: every test here uses a
// temporary home folder and a fake CLI or an exec stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GhosttyDock = require('../src/ghostty-dock.js');
const { testTempDir } = require('./helpers/tmp');

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const SID = '0b7c9a52-1d3e-4f60-8a9b-2c3d4e5f6a7b';
const RUNNING = async (file, args) => (file === '/usr/bin/osascript' ? { ok: true, stdout: 'true\n', stderr: '' } : null);

// A temporary home with the CLI, its opener, the API folder, the app bundle,
// and its own bin folder standing in for the fixed PATH (jq, uuidgen).
function makeHome({ cli = true, cliMode = 0o755, opener = true, api = true, apiMode = 0o700, app = true, jq = true } = {}) {
  const home = fs.realpathSync(testTempDir('px-dock-'));
  const where = GhosttyDock.locations(home);
  const bin = path.join(home, 'fixed-path');
  fs.mkdirSync(bin);
  for (const t of ['uuidgen', ...(jq ? ['jq'] : [])]) { fs.writeFileSync(path.join(bin, t), '#!/bin/sh\n'); fs.chmodSync(path.join(bin, t), 0o755); }
  fs.mkdirSync(path.dirname(where.cli), { recursive: true });
  if (cli) { fs.writeFileSync(where.cli, '#!/bin/sh\nexit 0\n'); fs.chmodSync(where.cli, cliMode); }
  if (opener) { fs.writeFileSync(where.opener, '#!/bin/sh\nexit 0\n'); fs.chmodSync(where.opener, 0o755); }
  if (api) { fs.mkdirSync(where.apiDir, { recursive: true }); fs.chmodSync(where.apiDir, apiMode); }
  if (app) fs.mkdirSync(where.apps[0], { recursive: true });
  return { home, where, bin, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const detect = (home, over = {}) => GhosttyDock.detect({ home, uid: UID, platform: 'darwin', pathDirs: [path.join(home, 'fixed-path')], ...over });

test('a private API folder and our own executable CLI are trusted; the CLI path is absolute and fixed', () => {
  const h = makeHome();
  try {
    const d = detect(h.home);
    assert.equal(d.trusted, true);
    assert.equal(d.installed, true);
    assert.equal(d.canOpen, true);
    assert.deepEqual(d.env, { HOME: h.home, PATH: h.bin, TMPDIR: require('node:os').tmpdir() });
    assert.equal(d.cli, path.join(h.home, '.local', 'bin', 'ghostty-dock'));
    assert.ok(path.isAbsolute(d.cli));
  } finally { h.done(); }
});

test('untrusted: API folder is a symlink, is 0755, or belongs to another user; CLI group-writable or missing', () => {
  const cases = [
    ['api 0755', { apiMode: 0o755 }],
    ['cli group-writable', { cliMode: 0o775 }],
    ['cli not executable', { cliMode: 0o644 }],
    ['cli missing', { cli: false }],
    ['api missing', { api: false }],
    ['no jq on the fixed PATH', { jq: false }],
  ];
  for (const [label, opts] of cases) {
    const h = makeHome(opts);
    try {
      const d = detect(h.home);
      assert.equal(d.trusted, false, label);
      assert.equal(d.cli, null, label);
      assert.ok(d.reason, label);
    } finally { h.done(); }
  }
  const h = makeHome({ api: false });
  try {
    const real = path.join(h.home, 'elsewhere');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.mkdirSync(path.dirname(h.where.apiDir), { recursive: true });
    fs.symlinkSync(real, h.where.apiDir);
    assert.equal(detect(h.home).trusted, false, 'symlinked API folder');
    assert.match(detect(h.home).reason, /not a plain folder/);
    assert.equal(detect(h.home, { uid: UID + 1 }).trusted, false, 'another owner');
  } finally { h.done(); }
  const noJq = makeHome({ jq: false });
  try { assert.equal(detect(noJq.home).reason, 'CLI needs jq'); } finally { noJq.done(); }
});

test('the CLI\'s folder and a symlink\'s target folder must not be writable by others; the opener is checked for open', () => {
  const h = makeHome();
  try {
    fs.chmodSync(path.dirname(h.where.cli), 0o777);
    assert.match(detect(h.home).reason, /folder other users can change/);
    fs.chmodSync(path.dirname(h.where.cli), 0o755);
    const shared = path.join(h.home, 'shared');
    fs.mkdirSync(shared, { mode: 0o777 });
    fs.chmodSync(shared, 0o777);
    fs.renameSync(h.where.cli, path.join(shared, 'ghostty-dock'));
    fs.symlinkSync(path.join(shared, 'ghostty-dock'), h.where.cli);
    assert.equal(detect(h.home).trusted, false, 'symlink into a world-writable folder');
    fs.chmodSync(shared, 0o755);
    assert.equal(detect(h.home).trusted, true, 'symlink to our own file in our own folder');
    fs.chmodSync(h.where.opener, 0o777);
    const d = detect(h.home);
    assert.deepEqual([d.trusted, d.canOpen], [true, false]);
  } finally { h.done(); }
  const noApp = makeHome({ app: false });
  try { assert.deepEqual([detect(noApp.home).trusted, detect(noApp.home).canOpen], [true, false]); } finally { noApp.done(); }
});

test('the GHOSTTY_DOCK_STATE override is ignored, and nothing is looked up on PATH', () => {
  const h = makeHome({ api: false });
  const planted = makeHome();
  const saved = { state: process.env.GHOSTTY_DOCK_STATE, path: process.env.PATH };
  try {
    process.env.GHOSTTY_DOCK_STATE = path.dirname(planted.where.apiDir);
    process.env.PATH = `${path.dirname(planted.where.cli)}:${saved.path}`;
    const d = detect(h.home);
    assert.equal(d.trusted, false);
    assert.equal(d.apiDir, path.join(h.home, '.local', 'state', 'ghostty-dock', 'api'));
  } finally {
    if (saved.state === undefined) delete process.env.GHOSTTY_DOCK_STATE; else process.env.GHOSTTY_DOCK_STATE = saved.state;
    process.env.PATH = saved.path;
    h.done(); planted.done();
  }
});

test('absent cleanly: no app, no CLI, or not macOS', () => {
  const h = makeHome({ cli: false, api: false, app: false });
  try {
    const d = detect(h.home);
    assert.deepEqual([d.installed, d.trusted, d.canOpen, d.cli, d.reason], [false, false, false, null, 'CLI not installed']);
    assert.equal(GhosttyDock.detect({ home: h.home, platform: 'linux' }).trusted, false);
  } finally { h.done(); }
});

test('the op allow-list is frozen to focus, list, notify and open; anything else throws before any exec', async () => {
  assert.deepEqual([...GhosttyDock.OPS], ['focus', 'list', 'notify', 'open']);
  assert.ok(Object.isFrozen(GhosttyDock.OPS));
  assert.equal(typeof GhosttyDock.call, 'undefined', 'no generic call');
  const calls = [];
  const exec = async (...a) => { calls.push(a); return { ok: true }; };
  const dock = { trusted: true, cli: '/x/ghostty-dock' };
  for (const op of ['send', 'keys', 'read', 'wait', 'FOCUS', '', undefined]) {
    await assert.rejects(GhosttyDock.run(op, [SID], { dock, exec }), /not allowed/, String(op));
  }
  assert.throws(() => { GhosttyDock.OPS.push('send'); });
  assert.deepEqual(calls, []);
});

const ENV = { HOME: '/Users/me', PATH: '/usr/bin:/bin', TMPDIR: '/tmp' };
const DOCK = { trusted: true, canOpen: true, cli: '/x/ghostty-dock', env: ENV };

test('run uses its own copy of the checked argv, so the caller cannot change it during the running check', async () => {
  const args = [SID];
  const calls = [];
  const exec = async (file, a) => { calls.push([file, a]); if (file === '/usr/bin/osascript') { args[0] = '--evil'; return { ok: true, stdout: 'true' }; } return { ok: true }; };
  await GhosttyDock.run('focus', args, { dock: DOCK, exec });
  assert.deepEqual(calls[1], ['/x/ghostty-dock', ['focus', SID]]);
});

test('focus checks the app is running first, then runs argv only with the checked env and SIGTERM', async () => {
  const calls = [];
  const exec = async (file, args, opts) => { calls.push([file, args, opts]); return (await RUNNING(file)) || { ok: true, stdout: '', stderr: '' }; };
  assert.deepEqual(await GhosttyDock.run('focus', [SID], { dock: DOCK, exec }), { ok: true });
  assert.deepEqual(calls.map(([f, a]) => [f, a]), [['/usr/bin/osascript', ['-e', GhosttyDock.RUNNING_SCRIPT]], ['/x/ghostty-dock', ['focus', SID]]]);
  assert.match(GhosttyDock.RUNNING_SCRIPT, /application id "consulting\.cloudscale\.ghosttydock" is running/);
  for (const [, , opts] of calls) { assert.equal(opts.env, ENV); assert.equal(opts.killSignal, 'SIGTERM'); }
  // Not running: no request file is ever written for a later start to act on.
  const quiet = [];
  const down = await GhosttyDock.run('focus', [SID], { dock: DOCK, exec: async (f, a) => { quiet.push(f); return { ok: true, stdout: 'false' }; } });
  assert.deepEqual(down, { ok: false, reason: 'Ghostty Dock is not running' });
  assert.deepEqual(quiet, ['/usr/bin/osascript']);
  assert.equal((await GhosttyDock.run('focus', [SID], { dock: { trusted: false, cli: null, reason: 'API folder is not private' }, exec })).ok, false);
  assert.equal(calls.length, 2);
  const failed = await GhosttyDock.run('focus', [SID], { dock: DOCK, exec: async (f) => (await RUNNING(f)) || { ok: false, stderr: 'no such session\n' } });
  assert.deepEqual(failed, { ok: false, reason: 'no such session' });
});

test('each op has a fixed argument shape: no free command line, no names or folders for focus', async () => {
  const calls = [];
  const exec = async (file, args, opts) => { calls.push([file, args, opts]); return { ok: true, stdout: 'true' }; };
  const tmpRoot = '/private/var/folders/xy/T';
  const file = `${tmpRoot}/plexiform-terminal-Ab12Cd/continue.command`;
  const bad = [
    ['focus', []], ['focus', [SID, SID]], ['focus', ['aws-cli']], ['focus', ['a\nb']], ['focus', ['/Users/me/repo']],
    ['list', ['--all']], ['notify', []], ['notify', ['a', 'b']], ['notify', ['--urgent']],
    ['open', ['/Users/me/repo', '--command', 'rm -rf ~']],
    ['open', ['/Users/me/repo', '--command', "'rm' -rf ~"]],
    ['open', ['/Users/me/repo', '--command', `'${file}'; rm -rf ~`]],
    ['open', ['/Users/me/repo', '--command', file]],
    ['open', ['/Users/me/repo', '--command', `'/tmp/evil/continue.command'`]],
    ['open', ['/Users/me/repo', '--command', `'${tmpRoot}/plexiform-terminal-Ab12Cd/../x/continue.command'`]],
    ['open', ['/Users/me/repo', '--command', `'${tmpRoot}/plexiform-terminal-Ab12Cd/run.sh'`]],
    ['open', ['relative', '--command', `'${file}'`]],
    ['open', ['/Users/me/repo', '-c', `'${file}'`]],
    ['open', ['/Users/me/repo', '--command', `'${file}'`, 'extra']],
  ];
  for (const [op, args] of bad) await assert.rejects(GhosttyDock.run(op, args, { dock: DOCK, exec, tmpRoot }), /bad arguments/, `${op} ${JSON.stringify(args)}`);
  assert.deepEqual(calls, []);
  assert.deepEqual(await GhosttyDock.run('open', ['/Users/me/repo', '--command', `'${file}'`], { dock: DOCK, exec, tmpRoot }), { ok: true });
  assert.deepEqual(calls[0][1], ['open', '/Users/me/repo', '--command', `'${file}'`]);
  assert.equal(calls[0][2].timeout, GhosttyDock.OPEN_TIMEOUT_MS, 'room for the Automation prompt');
  assert.ok(GhosttyDock.OPEN_TIMEOUT_MS >= 30000);
  assert.equal((await GhosttyDock.run('open', ['/Users/me/repo', '--command', `'${file}'`], { dock: { ...DOCK, canOpen: false }, exec, tmpRoot })).ok, false);
  await GhosttyDock.run('list', [], { dock: DOCK, exec });
  await GhosttyDock.run('notify', [`Plexiform: done\u0007${'x'.repeat(300)}`], { dock: DOCK, exec });
  const title = calls.at(-1)[1][1];
  assert.ok(title.length <= 120 && !/[\0-\x1f]/.test(title), 'one clipped title');
});

test('a fake CLI on disk is run for real, with exactly the argv given', async () => {
  const h = makeHome();
  try {
    const log = path.join(h.home, 'argv.json');
    fs.writeFileSync(h.where.cli, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), state: process.env.GHOSTTY_DOCK_STATE ?? null, home: process.env.HOME, path: process.env.PATH, secret: process.env.PX_DOCK_SECRET ?? null }));\n`);
    fs.chmodSync(h.where.cli, 0o700);
    const saved = process.env.GHOSTTY_DOCK_STATE;
    process.env.GHOSTTY_DOCK_STATE = '/tmp/planted-state';
    process.env.PX_DOCK_SECRET = 'fixture-private-value';
    let r;
    try {
      // The real exec, with only the running check stubbed (Ghostty Dock isn't here).
      const realExec = (file, args, opts) => (file === '/usr/bin/osascript' ? RUNNING(file) : GhosttyDock.execCli(file, args, opts));
      r = await GhosttyDock.run('focus', [SID], { dock: detect(h.home), exec: realExec });
    } finally {
      if (saved === undefined) delete process.env.GHOSTTY_DOCK_STATE; else process.env.GHOSTTY_DOCK_STATE = saved;
      delete process.env.PX_DOCK_SECRET;
    }
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), { argv: ['focus', SID], state: null, home: h.home, path: h.bin, secret: null });
  } finally { h.done(); }
});

test('detection is cached for 60 s and a failed call drops the cache', async () => {
  GhosttyDock.invalidate();
  const h = makeHome();
  try {
    assert.equal(GhosttyDock.current({ home: h.home, uid: UID, platform: 'darwin', now: 1000 }).trusted, true);
    fs.chmodSync(h.where.apiDir, 0o755);
    assert.equal(GhosttyDock.current({ home: h.home, uid: UID, platform: 'darwin', now: 30000 }).trusted, true, 'cached');
    assert.equal(GhosttyDock.current({ home: h.home, uid: UID, platform: 'darwin', now: 61001 }).trusted, false, 'expired');
    fs.chmodSync(h.where.apiDir, 0o700);
    await GhosttyDock.run('list', [], { dock: DOCK, exec: async () => ({ ok: false }) });
    assert.equal(GhosttyDock.current({ home: h.home, uid: UID, platform: 'darwin', now: 61002 }).trusted, true, 'invalidated');
  } finally { h.done(); GhosttyDock.invalidate(); }
});

test('session ids must be full UUIDs; modes are auto or off', () => {
  assert.ok(GhosttyDock.validSessionId(SID));
  for (const bad of ['', 'aws-cli', SID.slice(0, 8), `${SID} `, `${SID}\n`, '/Users/me/repo', null, 42]) assert.equal(GhosttyDock.validSessionId(bad), false, String(bad));
  assert.equal(GhosttyDock.modeOf({}), 'auto');
  assert.equal(GhosttyDock.modeOf({ integrations: { ghosttyDock: 'off' } }), 'off');
  assert.equal(GhosttyDock.modeOf({ integrations: { ghosttyDock: 'send' } }), 'auto');
});

test('the health row is read-only wording with the third-party note', () => {
  const link = /third-party app with no license/i;
  assert.equal(GhosttyDock.healthRow({ installed: false, trusted: false }, 'auto').status, 'info');
  assert.match(GhosttyDock.healthRow({ installed: false, trusted: false }, 'auto').detail, /^Not installed\./);
  const warn = GhosttyDock.healthRow({ installed: true, trusted: false, reason: 'API folder is not private' }, 'auto');
  assert.equal(warn.status, 'warn');
  assert.match(warn.detail, /API folder is not private/);
  assert.match(GhosttyDock.healthRow({ installed: true, trusted: true }, 'auto').detail, link);
  assert.match(GhosttyDock.healthRow({ installed: true, trusted: true }, 'off').detail, /Turned off/);
});

test('plexiform doctor shows the Ghostty Dock row on macOS without calling it', async () => {
  const h = makeHome({ cli: false, api: false, app: false });
  try {
    const Cli = require('../src/cli.js');
    let out = '';
    await Cli.run({ argv: ['doctor', '--json'], home: h.home, env: { CLAUDE_TRAFFIC_LIGHT_HOME: path.join(h.home, 'data') }, platform: 'darwin',
      out: (s) => { out += s; }, err: () => {}, fetchLive: async () => null, health: async () => ({ ok: true, problems: 0, checks: [] }) });
    const row = JSON.parse(out).checks.find((c) => c.id === 'ghostty-dock');
    assert.equal(row.status, 'info');
    assert.match(row.detail, /^Not installed/);
  } finally { h.done(); }
});

test('the Health check list carries the row only when main passes it', () => {
  const Health = require('../src/health.js');
  const home = testTempDir('px-dock-health-');
  try {
    assert.ok(!Health.runChecks({ home }).checks.some((c) => c.id === 'ghostty-dock'));
    const row = Health.runChecks({ home, ghosttyDock: { status: 'ok', detail: 'Installed.' } }).checks.find((c) => c.id === 'ghostty-dock');
    assert.deepEqual([row.label, row.status], ['Ghostty Dock', 'ok']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
