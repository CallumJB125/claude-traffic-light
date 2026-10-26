// Plexiform runs the user's key helper itself (review C1): from $HOME, absolute PATH only, 10 s, stderr never kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runKeyHelper, runUserCommand, absolutePath } from '../key-helper.cjs';
import { spawn as realSpawn } from 'node:child_process';
import { testTempDir } from '../test-support/tmp.js';

const SIGN_IN = 'your key helper needs you to sign in; run it once in a terminal';
const ENV = { PATH: '/usr/bin:/bin', LANG: 'C' };

function rig(t) {
  const root = testTempDir('key-helper-', t);
  const home = path.join(root, 'home');
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(worktree, 'node_modules', '.bin'), { recursive: true });
  const marker = path.join(root, 'ran');
  const script = (file, body) => { fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  return { root, home, worktree, marker, script };
}

test('the helper runs once, from $HOME; a copy in the worktree never runs, even when it is the process cwd', async (t) => {
  const r = rig(t);
  r.script(path.join(r.home, 'key.sh'), `pwd -P >> '${r.marker}'; echo the-key`);
  r.script(path.join(r.worktree, 'key.sh'), `echo worktree >> '${r.marker}'; echo planted`);
  const before = process.cwd();
  process.chdir(r.worktree);
  try {
    const out = await runKeyHelper({ command: './key.sh', home: r.home, env: ENV, platform: process.platform });
    assert.deepEqual(out, { ok: true, output: 'the-key' });
  } finally { process.chdir(before); }
  const ran = fs.readFileSync(r.marker, 'utf8').trim().split('\n');
  assert.deepEqual(ran, [fs.realpathSync(r.home)], 'ran once, from the home folder');
});

test('PATH keeps absolute entries only: node_modules/.bin in the worktree is never searched', async (t) => {
  const r = rig(t);
  // A relative PATH entry resolves against the spawn cwd; had it been kept, either copy would run.
  fs.mkdirSync(path.join(r.home, 'node_modules', '.bin'), { recursive: true });
  r.script(path.join(r.home, 'node_modules', '.bin', 'get-key'), `echo home-copy >> '${r.marker}'; echo planted`);
  r.script(path.join(r.worktree, 'node_modules', '.bin', 'get-key'), `echo worktree >> '${r.marker}'; echo planted`);
  const out = await runKeyHelper({ command: 'get-key', home: r.home, env: { PATH: 'node_modules/.bin:./bin:/usr/bin:/bin' }, platform: process.platform });
  assert.equal(out.ok, false);
  assert.equal(fs.existsSync(r.marker), false);
  assert.equal(absolutePath('node_modules/.bin:./x::/usr/bin', 'linux'), '/usr/bin');
  assert.equal(absolutePath('rel:also', 'linux'), '/usr/bin:/bin', 'nothing absolute left: a fixed safe PATH');
  assert.equal(absolutePath('rel;C:\\Windows', 'win32'), 'C:\\Windows');
});

test('stderr is never read, logged or returned: a failure is only "key helper failed (exit N)"', async (t) => {
  const r = rig(t);
  const SECRET = 'sk-ant-api03-stderr-secret-000000000000000000';
  r.script(path.join(r.home, 'bad.sh'), `echo ${SECRET} >&2; echo ${SECRET}-out; exit 3`);
  let opts;
  const spawn = (cmd, o) => { opts = o; return realSpawn(cmd, o); };
  const out = await runKeyHelper({ command: path.join(r.home, 'bad.sh'), home: r.home, env: ENV, platform: process.platform, spawn });
  assert.deepEqual(out, { ok: false, timedOut: false, code: 3, reason: 'key helper failed (exit 3)' });
  assert.ok(!JSON.stringify(out).includes('secret'), 'neither stderr nor stdout is in the result');
  assert.equal(opts.stdio[2], 'ignore', 'stderr is never even captured');
  assert.equal(opts.cwd, r.home);
});

test('a helper that never exits is killed after the timeout and asks the person to sign in', async (t) => {
  const r = rig(t);
  r.script(path.join(r.home, 'sso.sh'), `echo waiting-for-browser-token >&2; sleep 30`);
  const t0 = Date.now();
  const out = await runKeyHelper({ command: path.join(r.home, 'sso.sh'), home: r.home, env: ENV, platform: process.platform, timeoutMs: 250 });
  assert.equal(out.ok, false);
  assert.equal(out.timedOut, true);
  assert.equal(out.reason, SIGN_IN);
  assert.ok(!out.reason.includes('browser-token'));
  assert.ok(Date.now() - t0 < 5000, 'did not wait for the sleep');
});

test('the helper env is the allowlist: an app secret in the process env is not passed', async (t) => {
  const r = rig(t);
  r.script(path.join(r.home, 'env.sh'), 'printf "%s|%s" "${APP_SECRET:-none}" "${ANTHROPIC_API_KEY:-none}"');
  const out = await runUserCommand({ command: path.join(r.home, 'env.sh'), home: r.home, env: { ...ENV, APP_SECRET: 'x', ANTHROPIC_API_KEY: 'y' }, platform: process.platform });
  assert.equal(out.output, 'none|none');
});

test('empty command or missing home fails closed without spawning', async () => {
  let spawned = false;
  const spawn = () => { spawned = true; throw new Error('no'); };
  assert.equal((await runKeyHelper({ command: '  ', home: '/h', env: ENV, spawn })).ok, false);
  assert.equal((await runKeyHelper({ command: 'x', home: '', env: ENV, spawn })).ok, false);
  assert.equal(spawned, false);
});
