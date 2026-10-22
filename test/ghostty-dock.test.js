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

function makeHome({ cli = true, cliMode = 0o755, api = true, apiMode = 0o700, app = true } = {}) {
  const home = fs.realpathSync(testTempDir('px-dock-'));
  const where = GhosttyDock.locations(home);
  if (cli) { fs.mkdirSync(path.dirname(where.cli), { recursive: true }); fs.writeFileSync(where.cli, '#!/bin/sh\nexit 0\n'); fs.chmodSync(where.cli, cliMode); }
  if (api) { fs.mkdirSync(where.apiDir, { recursive: true }); fs.chmodSync(where.apiDir, apiMode); }
  if (app) fs.mkdirSync(where.apps[0], { recursive: true });
  return { home, where, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const detect = (home, over = {}) => GhosttyDock.detect({ home, uid: UID, platform: 'darwin', ...over });

test('a private API folder and our own executable CLI are trusted; the CLI path is absolute and fixed', () => {
  const h = makeHome();
  try {
    const d = detect(h.home);
    assert.equal(d.trusted, true);
    assert.equal(d.installed, true);
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
    assert.deepEqual(detect(h.home), { installed: false, trusted: false, cli: null, apiDir: h.where.apiDir, reason: 'CLI not installed' });
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

test('run passes argv only, refuses control characters, and needs a trusted dock', async () => {
  const calls = [];
  const exec = async (file, args) => { calls.push([file, args]); return { ok: true, stdout: '', stderr: '' }; };
  const dock = { trusted: true, cli: '/x/ghostty-dock' };
  assert.deepEqual(await GhosttyDock.run('focus', [SID], { dock, exec }), { ok: true });
  assert.deepEqual(calls, [['/x/ghostty-dock', ['focus', SID]]]);
  await assert.rejects(GhosttyDock.run('focus', ['a\nb'], { dock, exec }), /bad argument/);
  assert.equal((await GhosttyDock.run('focus', [SID], { dock: { trusted: false, cli: null, reason: 'API folder is not private' }, exec })).ok, false);
  assert.equal(calls.length, 1);
  const failed = await GhosttyDock.run('focus', [SID], { dock, exec: async () => ({ ok: false, stderr: 'no such session\n' }) });
  assert.deepEqual(failed, { ok: false, reason: 'no such session' });
});

test('a fake CLI on disk is run for real, with exactly the argv given', async () => {
  const h = makeHome();
  try {
    const log = path.join(h.home, 'argv.json');
    fs.writeFileSync(h.where.cli, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
    fs.chmodSync(h.where.cli, 0o700);
    const r = await GhosttyDock.run('focus', [SID], { dock: detect(h.home) });
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), ['focus', SID]);
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
    await GhosttyDock.run('focus', [SID], { dock: { trusted: true, cli: '/x' }, exec: async () => ({ ok: false }) });
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
