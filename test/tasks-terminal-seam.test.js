'use strict';
// PR 0s: the launcher seam in src/tasks-terminal.js (plan-agent-terminal §R2.13
// PR 0s, plan-pr0s §6 ruling 5, §8 S2/S3). Today's two launch branches are
// unchanged; the take-over stamp lives outside config.json and outside Backups.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const MODULE = require.resolve('../src/tasks-terminal');
const GOLDEN = path.join(__dirname, 'fixtures/continue-command-golden.txt');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr0s-seam-'));
const descriptor = (cwd) => ({ argv: ['/bin/echo', '--resume', '11111111-2222-4333-8444-555555555555', '--settings', '/Users/fixture/run/settings.json', 'it\'s $HOME', ''], cwd,
  env: { TMPDIR: '/tmp/x y', BUDDY_TASK_ID: 'tsk_0123456789ab', ANTHROPIC_AUTH_TOKEN: 'never' } });

// A fresh tasks-terminal with node:child_process.execFile recorded, so the
// default launcher (bound at require time) is the stub too.
function withExecFile(fn) {
  const real = childProcess.execFile;
  const calls = [];
  childProcess.execFile = (cmd, args, opts, cb) => { calls.push([cmd, args, opts]); cb(null); };
  delete require.cache[MODULE];
  try { return fn(require(MODULE), calls); } finally { childProcess.execFile = real; delete require.cache[MODULE]; }
}

test('continue.command is byte for byte what main wrote before PR 0s', async () => {
  const T = require('../src/tasks-terminal');
  const dir = tmp(), cwd = tmp();
  try {
    let body = null;
    const r = await T.launchTaskTerminal(descriptor(cwd), { platform: 'darwin', resolve: (v) => v, tempDir: dir,
      launch: async (file) => { body = fs.readFileSync(file, 'utf8').split(path.dirname(file)).join('<DIR>').split(cwd).join('<CWD>'); } });
    assert.equal(r.status, 'requested');
    assert.equal(body, fs.readFileSync(GOLDEN, 'utf8'));
    assert.doesNotMatch(body, /AUTH_TOKEN|never/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('Terminal: launcherFor(\'Terminal\') makes exactly the calls the default launcher made', async () => {
  const run = (launchOf) => withExecFile(async (T, calls) => {
    const dir = tmp(), cwd = tmp();
    try {
      const r = await T.launchTaskTerminal(descriptor(cwd), { platform: 'darwin', resolve: (v) => v, tempDir: dir, ...launchOf(T) });
      return { status: r.status, calls: calls.map(([cmd, args, opts]) => [cmd, args.map((a) => a.split(dir).join('<TMP>').replace(/plexiform-terminal-[^/]+/, 'plexiform-terminal-<RANDOM>')), opts]) };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); }
  });
  const before = await run(() => ({})); // main passed no launch for Terminal
  const after = await run((T) => ({ launch: T.launcherFor('Terminal') }));
  assert.equal(before.calls.length, 1);
  assert.deepEqual(after, before);
  assert.deepEqual(before.calls[0], ['/usr/bin/open', ['-a', 'Terminal', '<TMP>/plexiform-terminal-<RANDOM>/continue.command'], { timeout: 10000 }]);
  withExecFile((T) => assert.equal(T.launcherFor('Terminal'), T.launcherFor('Terminal'), 'one function, not a wrapper per call'));
});

test('Ghostty Dock: launcherFor(\'Ghostty Dock\') makes exactly the calls main\'s ghosttyDockLauncher() made', async () => {
  const Dock = require('../src/ghostty-dock');
  const T = require('../src/tasks-terminal');
  const real = { detect: Dock.detect, run: Dock.run };
  const calls = [];
  Dock.detect = () => ({ fixture: 'dock' });
  Dock.run = async (...a) => { calls.push(a); return { ok: true }; };
  try {
    await T.ghosttyDockLauncher()('/tmp/a b/continue.command', '/Users/fixture/acme');
    await T.launcherFor('Ghostty Dock')('/tmp/a b/continue.command', '/Users/fixture/acme');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.deepEqual(calls[0], ['open', ['/Users/fixture/acme', '--command', '\'/tmp/a b/continue.command\''], { dock: { fixture: 'dock' } }]);
    Dock.run = async () => ({ ok: false, reason: 'no tab' });
    await assert.rejects(T.launcherFor('Ghostty Dock')('/f', '/c'), /no tab/);
  } finally { Object.assign(Dock, real); }
});

test('launcherFor maps only the apps terminalApp() names', () => {
  const T = require('../src/tasks-terminal');
  for (const app of ['plexiform', 'Plexiform Terminal', 'iTerm', 'Ghostty', 'toString', '__proto__', undefined]) {
    assert.throws(() => T.launcherFor(app), { code: 'CAPABILITY_MISSING' }, String(app));
  }
  assert.equal(typeof T.launcherFor('Ghostty Dock'), 'function');
});

test('stampTakeover: only a requested launch stamps, a failed write changes nothing, and the result passes through', () => {
  const T = require('../src/tasks-terminal');
  const dir = tmp();
  try {
    assert.equal(T.takeoverUsedAt(dir), null);
    const unconfirmed = { status: 'unconfirmed', cancelPending() {} };
    assert.equal(T.stampTakeover(unconfirmed, dir, () => 5), unconfirmed);
    assert.equal(T.takeoverUsedAt(dir), null);
    const requested = { status: 'requested', cancelPending() {} };
    assert.equal(T.stampTakeover(requested, dir, () => 1793095200000), requested);
    assert.equal(T.takeoverUsedAt(dir), 1793095200000);
    const file = path.join(dir, T.STATE_FILE);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), [T.STATE_FILE], 'no temp file left behind');
    assert.ok(!fs.existsSync(path.join(dir, 'config.json')), 'config.json is never touched');
    // An unwritable place: the launch result is unchanged, nothing throws.
    assert.equal(T.stampTakeover(requested, path.join(file, 'not-a-dir'), () => 9), requested);
    assert.equal(T.takeoverUsedAt(dir), 1793095200000);
    // A rename that fails (a folder in the way) leaves no temp file behind.
    const blocked = tmp();
    fs.mkdirSync(path.join(blocked, T.STATE_FILE));
    fs.writeFileSync(path.join(blocked, T.STATE_FILE, 'x'), '');
    assert.equal(T.stampTakeover(requested, blocked, () => 9), requested);
    assert.deepEqual(fs.readdirSync(blocked), [T.STATE_FILE]);
    fs.rmSync(blocked, { recursive: true, force: true });
    fs.writeFileSync(file, '{"takeoverUsedAt":"soon"}');
    assert.equal(T.takeoverUsedAt(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Backups never copies, compares or restores terminal-state.json', () => {
  const Backups = require('../src/backups');
  const T = require('../src/tasks-terminal');
  const base = tmp(), dataDir = path.join(base, 'data');
  try {
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ rules: [] }));
    T.stampTakeover({ status: 'requested' }, dataDir, () => 1);
    assert.equal(Backups.allowed(T.STATE_FILE), false);
    const b = Backups.create({ dataDir, backupsDir: path.join(base, 'backups'), now: () => 1793095200000 });
    const snap = b.snapshot('manual', { force: true });
    assert.equal(snap.taken, true);
    assert.equal(snap.files, 1, 'only config.json');
    T.stampTakeover({ status: 'requested' }, dataDir, () => 2);
    const d = b.diff(snap.id);
    assert.equal(d.same, true, 'a later stamp is no difference');
    assert.deepEqual(d.configKeys, []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Your data lists terminal-state.json under Session state, and Delete my data removes it', (t) => {
  const Inventory = require('../src/data-inventory');
  const Delete = require('../src/data-delete');
  const T = require('../src/tasks-terminal');
  const { fakeMac } = require('./helpers/data-rights-fixture.js');
  const mac = fakeMac();
  t.after(mac.cleanup);
  const d = mac.roots.dataDir;
  T.stampTakeover({ status: 'requested' }, d, () => 1);
  const file = path.join(d, T.STATE_FILE);
  const rows = Inventory.inventory(mac.roots);
  assert.ok(rows.find((r) => r.id === 'sessions').paths.includes(file));
  assert.deepEqual(rows.find((r) => r.id === 'data-other').paths, [], 'not left to the catch-all');
  Delete.requestDeletion({ ids: ['sessions'], confirm: 'delete', dataDir: d, pid: 999999 });
  assert.equal(Delete.runPendingDeletion({ ...mac.roots, isAlive: () => false, now: Date.UTC(2026, 9, 27) }).ran, true);
  assert.ok(!fs.existsSync(file));
  assert.equal(T.takeoverUsedAt(d), null);
});

test('Backups names the state file as left out on purpose', () => {
  const Backups = require('../src/backups');
  assert.ok(Backups.EXCLUDED.some((e) => e.name === 'terminal-state.json' && e.why));
});
