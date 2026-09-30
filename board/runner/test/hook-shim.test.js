// Hook shim dead-man check (spike change 2) and the pre-hook gates:
// supervisor pid+lstart mismatch / socket gone → pre DENIES, others exit 0;
// path confinement to the worktree; git push only to origin board/<KEY>-r<n>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { HOOK_SHIM } from '../launch.js';
import { lstartOf } from '../procs.js';
import { startIpcServer } from '../ipc.js';
import { checkGitPush } from '../run.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, hookCall } from './helpers.js';

function shim(event, env, payload = { tool_name: 'Bash', tool_input: { command: 'ls' } }) {
  const r = spawnSync(process.execPath, [HOOK_SHIM, event], { input: JSON.stringify(payload), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const isDeny = (out) => JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny';

test('dead-man: dead supervisor pid → pre denies (exit 0 + deny JSON); post is silent', async () => {
  const dead = spawnSync('/usr/bin/true').pid;
  const env = { BOARD_SUPERVISOR_PID: String(dead), BOARD_SUPERVISOR_LSTART: 'Thu Jan  1 00:00:00 1970', BOARD_RUN_SOCKET: '/tmp/nope.sock', BOARD_RUN_TOKEN: 't' };
  const p = shim('pre', env);
  assert.equal(p.code, 0);
  assert.ok(isDeny(p.stdout));
  assert.match(JSON.parse(p.stdout).hookSpecificOutput.permissionDecisionReason, /supervisor unavailable/);
  const q = shim('post', env);
  assert.equal(q.code, 0);
  assert.equal(q.stdout, '');
});

test('dead-man: live pid but different start time (pid reuse) → deny', () => {
  const env = { BOARD_SUPERVISOR_PID: String(process.pid), BOARD_SUPERVISOR_LSTART: 'Mon Jan  1 00:00:00 2001', BOARD_RUN_SOCKET: '/tmp/nope.sock', BOARD_RUN_TOKEN: 't' };
  assert.ok(isDeny(shim('pre', env).stdout));
});

test('dead-man: supervisor alive but socket unreachable / wrong token → deny', async () => {
  const dir = tmpDir();
  try {
    const sock = path.join(dir, 'ipc.sock');
    const env = { BOARD_SUPERVISOR_PID: String(process.pid), BOARD_SUPERVISOR_LSTART: lstartOf(process.pid), BOARD_RUN_SOCKET: sock, BOARD_RUN_TOKEN: 'good' };
    assert.ok(isDeny(shim('pre', env).stdout), 'no socket');
    const srv = await startIpcServer({ socketPath: sock, token: 'good', handler: { hello: () => ({}), tool: () => ({}), hook: () => ({ stdout: {}, exit_code: 0 }) } });
    try {
      assert.equal((fs.statSync(sock).mode & 0o777), 0o600);
      const bad = await runShimAsync('pre', { ...env, BOARD_RUN_TOKEN: 'bad' });
      assert.ok(isDeny(bad.stdout), 'bad token');
      const ok = await runShimAsync('pre', env);
      assert.equal(ok.code, 0);
      assert.equal(ok.stdout, '', 'proceeds with no output');
    } finally { await srv.close(); }
  } finally { rm(dir); }
});

// The IPC server lives in this process, so the shim must run asynchronously.
function runShimAsync(event, env, payload = { tool_name: 'Bash', tool_input: { command: 'ls' } }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [HOOK_SHIM, event], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.on('close', (code) => resolve({ code, stdout }));
    c.stdin.end(JSON.stringify(payload));
  });
}

test('the shim reads the run token from <run_dir>/hook.token when the CLI scrubbed BOARD_RUN_TOKEN', async () => {
  const dir = tmpDir();
  try {
    const sock = path.join(dir, 'ipc.sock');
    fs.writeFileSync(path.join(dir, 'hook.token'), 'filetok', { mode: 0o600 });
    const seen = [];
    const srv = await startIpcServer({ socketPath: sock, token: 'filetok', handler: { hello: () => ({}), tool: () => ({}), hook: (e, p) => { seen.push(e); return { stdout: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'ctx' } }, exit_code: 0 }; } } });
    try {
      const r = await runShimAsync('post', { BOARD_SUPERVISOR_PID: String(process.pid), BOARD_SUPERVISOR_LSTART: lstartOf(process.pid), BOARD_RUN_SOCKET: sock });
      assert.equal(r.code, 0);
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, 'ctx');
      assert.deepEqual(seen, ['post']);
    } finally { await srv.close(); }
  } finally { rm(dir); }
});

test('checkGitPush allows only origin board/<KEY>-r<n>', () => {
  const b = 'board/APP-1-r3';
  assert.equal(checkGitPush('git push origin board/APP-1-r3', b), null);
  assert.equal(checkGitPush('git push -u origin HEAD:board/APP-1-r3', b), null);
  assert.equal(checkGitPush('npm test && git commit -m x && git push origin board/APP-1-r3', b), null);
  assert.ok(checkGitPush('git push origin main', b));
  assert.ok(checkGitPush('git push', b));
  assert.ok(checkGitPush('git push --force origin board/APP-1-r3', b));
  assert.ok(checkGitPush('git push origin +board/APP-1-r3', b));
  assert.ok(checkGitPush('git push upstream board/APP-1-r3', b));
  assert.ok(checkGitPush('git -C .. push origin main', b));
  assert.ok(checkGitPush('git push origin board/APP-1-r2', b), 'a previous fence\'s branch');
  assert.equal(checkGitPush('git status && ls', b), null);
});

test('pre confines Read/Edit/Write/Glob/Grep to the worktree (after realpath) and gates git push', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-50' }));
    fs.symlinkSync('/etc', path.join(run.worktree, 'etc-link'));
    const pre = async (tool_name, tool_input) => (await hookCall(run, 'pre', { tool_name, tool_input, cwd: run.worktree })).result.stdout.hookSpecificOutput?.permissionDecision ?? 'allow';
    assert.equal(await pre('Read', { file_path: `${run.worktree}/README.md` }), 'allow');
    assert.equal(await pre('Read', { file_path: 'README.md' }), 'allow');
    assert.equal(await pre('Write', { file_path: `${run.worktree}/new/dir/x.js`, content: '' }), 'allow');
    assert.equal(await pre('Read', { file_path: `${repo.checkout}/README.md` }), 'deny', 'the trusted checkout is outside');
    assert.equal(await pre('Read', { file_path: '../../checkout/README.md' }), 'deny');
    assert.equal(await pre('Read', { file_path: '~/.ssh/id_rsa' }), 'deny');
    assert.equal(await pre('Read', { file_path: 'etc-link/passwd' }), 'deny', 'symlink escape');
    assert.equal(await pre('Edit', { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' }), 'deny');
    assert.equal(await pre('Glob', { pattern: '**/*.js' }), 'allow');
    assert.equal(await pre('Glob', { pattern: '/Users/**/*.pem' }), 'deny');
    assert.equal(await pre('Glob', { pattern: '*.js', path: '/tmp' }), 'deny');
    assert.equal(await pre('Grep', { pattern: 'x', path: '..' }), 'deny');
    assert.equal(await pre('Grep', { pattern: 'x', glob: '../**' }), 'deny');
    assert.equal(await pre('Bash', { command: `git push origin ${run.branch}` }), 'allow');
    assert.equal(await pre('Bash', { command: 'git push origin main' }), 'deny');
    assert.equal(await pre('Bash', { command: 'git push --force origin main' }), 'deny');
    // Fenced: everything is denied with the takeover reason.
    run.fenced = true;
    const r = await hookCall(run, 'pre', { tool_name: 'Read', tool_input: { file_path: 'README.md' }, cwd: run.worktree });
    assert.match(r.result.stdout.hookSpecificOutput.permissionDecisionReason, /taken over/);
    run.fenced = false;
    // Wrong token → BAD_RUN_TOKEN.
    const { ipcRequest } = await import('../ipc.js');
    const bad = await ipcRequest(run.socketPath, { type: 'hook', id: 'x', token: 'nope', event: 'pre', payload: {} });
    assert.equal(bad.error.code, 'BAD_RUN_TOKEN');
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
