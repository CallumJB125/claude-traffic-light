'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { launchTaskTerminal } = require('../src/tasks-terminal');
const exec = promisify(execFile);
const mac = process.platform === 'darwin' ? test : test.skip;

mac('one-use terminal launcher preserves quoted arguments, strips secret env and cleans up after exit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxterm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "a user's folder"), bin = path.join(root, 'provider'), output = path.join(root, 'result.json');
  fs.mkdirSync(cwd);
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),safe:process.env.BUDDY_TASK_ID,secret:process.env.PLEXIFORM_SYNTHETIC_TOKEN}));`, { mode: 0o700 });
  const args = ['resume', 'same-session', "quotes' and spaces", '$(touch should-not-exist)', '`touch should-not-exist`'];
  const result = await launchTaskTerminal({ cwd, argv: [bin, ...args], env: { BUDDY_TASK_ID: 'same-task', PLEXIFORM_SYNTHETIC_TOKEN: 'fixture-private-value' } }, {
    platform: 'darwin', tempDir: root,
    launch: async file => {
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(file).mode & 0o777, 0o700);
      assert.ok(!fs.readFileSync(file, 'utf8').includes('fixture-private-value'));
      // The command remains one-use even if the OS has read it twice already.
      const cached = path.join(root, 'cached.command'); fs.copyFileSync(file, cached);
      await exec('/bin/zsh', [file]);
      await exec('/bin/zsh', [cached]);
      assert.equal(fs.existsSync(file), false);
    },
  });
  assert.equal(result.status, 'requested');
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), { argv: args, cwd: fs.realpathSync(cwd), safe: 'same-task' });
  assert.equal(fs.existsSync(path.join(cwd, 'should-not-exist')), false);
});

test('stale and failed terminal launches remove the command and never retry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxterm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptor = { cwd: root, argv: [process.execPath, '-e', ''] }; let calls = 0, file;
  const launch = async f => { calls++; file = f; throw new Error('synthetic timeout after OS request'); };
  await assert.rejects(launchTaskTerminal(descriptor, { platform: 'darwin', tempDir: root, current: () => false, launch }), e => e.code === 'CONFLICT');
  assert.equal(calls, 0);
  const result = await launchTaskTerminal(descriptor, { platform: 'darwin', tempDir: root, launch });
  assert.equal(result.status, 'unconfirmed'); assert.equal(calls, 1); assert.equal(fs.existsSync(file), false);
  await assert.rejects(launchTaskTerminal(descriptor, { platform: 'win32', launch }), e => e.code === 'CAPABILITY_MISSING');
  assert.equal(calls, 1);
});

test('Ghostty Dock launcher: opens the task folder with only the quoted path of the one-use file, and is never retried', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pxterm dock '"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { ghosttyDockLauncher } = require('../src/tasks-terminal');
  const dock = { trusted: true, cli: '/Users/me/.local/bin/ghostty-dock' };
  const runs = [];
  const run = async (op, args, opts) => { runs.push({ op, args, opts }); return { ok: true }; };
  const descriptor = { cwd: root, argv: [process.execPath, '-e', ''], env: { PLEXIFORM_SYNTHETIC_TOKEN: 'fixture-private-value' } };
  const result = await launchTaskTerminal(descriptor, { platform: 'darwin', tempDir: root, launch: ghosttyDockLauncher({ detect: () => dock, run }) });
  assert.equal(result.status, 'requested');
  assert.equal(runs.length, 1);
  const [{ op, args, opts }] = runs;
  assert.equal(op, 'open');
  assert.equal(opts.dock, dock);
  assert.equal(args[0], root);
  assert.equal(args[1], '--command');
  const file = args[2].slice(1, -1).replace(/'\\''/g, "'");
  assert.equal(args[2], `'${file.replace(/'/g, "'\\''")}'`, 'the path is shell-quoted');
  assert.match(file, /continue\.command$/);
  assert.ok(fs.existsSync(file) && (fs.statSync(file).mode & 0o777) === 0o700);
  assert.ok(!args.join(' ').includes('fixture-private-value') && !args.join(' ').includes(process.execPath), 'the command body stays in the file');
  result.cancelPending();
  // Not trusted (or the CLI fails): the launch is unconfirmed, cleaned up and not repeated.
  let calls = 0;
  const failing = ghosttyDockLauncher({ detect: () => ({ trusted: false, cli: null }), run: async (...a) => { calls++; return require('../src/ghostty-dock').run(...a); } });
  const r2 = await launchTaskTerminal(descriptor, { platform: 'darwin', tempDir: root, launch: failing });
  assert.equal(r2.status, 'unconfirmed');
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('plexiform-terminal-')), []);
});
