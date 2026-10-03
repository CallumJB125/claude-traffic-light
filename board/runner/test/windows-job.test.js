import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WindowsJob, jobFrame, launchPayload, windowsQuote, jobHelperPath } from '../windows-job.js';
import { CodexBackend, codexConfig } from '../backends/codex.js';
import { ClaudeBackend } from '../backends/claude.js';
import { buildCodexEnv, buildEnv } from '../launch.js';
const opts = { cwd: 'C:\\work tree', env: { HOME: 'C:\\Users\\tester', SystemRoot: 'C:\\Windows' } };
function fixture() {
  const helper = new EventEmitter(); Object.assign(helper, { pid: 999, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const sent = []; helper.stdin.on('data', (b) => sent.push(b)); let killed = 0;
  helper.kill = () => { killed++; helper.emit('close', 1); };
  return { helper, sent, get killed() { return killed; }, spawnHelper: (_exe, args, options) => { assert.deepEqual(args, []); assert.equal(options.windowsHide, true); return helper; } };
}
const ready = (pid = 42) => { const b = Buffer.alloc(12); b.writeUInt32LE(pid); b.writeBigUInt64LE(12345n, 4); return jobFrame(129, b); };
const finished = (confirmed = true) => jobFrame(132, Buffer.from([0, 0, 0, 0, confirmed ? 1 : 0]));
test('Windows private launch bounds and quoting preserve arguments without shell interpretation', () => {
  assert.equal(windowsQuote('a"b\\'), '"a\\"b\\\\"');
  const bytes = launchPayload('C:\\Program Files\\codex.exe', ['$(no-shell)', 'x&y'], opts);
  assert.equal(bytes.readUInt32LE(0), process.pid);
  assert.match(bytes.subarray(20).toString('utf16le'), /"\$\(no-shell\)" "x&y"/);
  assert.throws(() => launchPayload('codex.cmd', [], opts));
  assert.throws(() => launchPayload('C:\\codex.exe', ['bad\0arg'], opts));
  assert.throws(() => launchPayload('C:\\codex.exe', [], { ...opts, env: { Path: 'a', PATH: 'b' } }));
});
test('fragmented receipt records provider PID; provider bytes cannot forge a stopped receipt', async () => {
  const f = fixture(), j = new WindowsJob('C:\\codex.exe', [], opts, f);
  let output = ''; j.stdout.on('data', (b) => { output += b.toString(); });
  assert.equal(j.pid, null); const r = ready(); f.helper.stdout.write(r.subarray(0, 6)); f.helper.stdout.write(r.subarray(6)); await j.ready;
  assert.equal(j.pid, 42); assert.notEqual(j.pid, f.helper.pid); assert.equal(j.lstart, 'win32:0000000000003039');
  f.helper.stdout.write(jobFrame(130, finished())); assert.equal(j.stopped, false); assert.ok(output.length);
  f.helper.stdout.write(finished()); assert.equal(j.stopped, false); f.helper.emit('close', 0);
  assert.equal(await j.completion, true);
});
test('stop requires receipt plus clean helper closure; timeout, crash, trailing bytes and duplicate receipts fail closed', async () => {
  for (const mode of ['timeout', 'crash', 'trailing', 'duplicate', 'negative']) {
    const f = fixture(), j = new WindowsJob('C:\\codex.exe', [], opts, f); f.helper.stdout.write(ready()); await j.ready;
    const stopped = j.stop(15); assert.equal(f.sent.at(-1)[0], 4);
    if (mode === 'crash') f.helper.emit('close', 1);
    if (mode === 'trailing') { f.helper.stdout.write(Buffer.concat([finished(), Buffer.from([1])])); f.helper.emit('close', 0); }
    if (mode === 'duplicate') f.helper.stdout.write(Buffer.concat([finished(), finished()]));
    if (mode === 'negative') { f.helper.stdout.write(finished(false)); f.helper.emit('close', 0); }
    assert.equal(await stopped, false, mode); assert.equal(j.stopped, false, mode);
  }
});
test('Windows environment is allowlisted and uses no POSIX shell; Codex keeps exact deny/read-only restrictions', () => {
  const parent = { ...opts.env, USERPROFILE: opts.env.HOME, PATH: 'C:\\tools', SECRET: 'no', CODEX_HOME: 'C:\\auth' };
  const env = buildCodexEnv(parent, 'C:\\cache', 'win32'); assert.equal(env.SHELL, undefined); assert.equal(env.SECRET, undefined); assert.equal(env.TEMP, 'C:\\cache\\tmp');
  assert.equal(buildEnv(parent, { runDir: 'C:\\run', platform: 'win32' }).SHELL, undefined);
  const config = codexConfig({ ...opts, cwd: opts.cwd, env, platform: 'win32', dataDir: 'C:\\private', readOnly: true });
  assert.ok(config.includes('windows.sandbox="elevated"')); assert.ok(config.includes('permissions.plexiform.network.enabled=false'));
  const policy = config.find((s) => s.startsWith('permissions.plexiform.filesystem='));
  assert.ok(policy.includes('":workspace_roots"="read"')); assert.ok(policy.includes('"C:\\\\private"="deny"')); assert.ok(policy.includes('"C:\\\\auth"="deny"')); assert.ok(!policy.includes('/opt/homebrew'));
});
test('Windows Codex start is connected to async Job receipt and confirmed stop, Claude refuses before launch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-job-'));
  const f = fixture(), backend = new CodexBackend({ ...opts, platform: 'win32', bin: 'C:\\codex.exe', runDir: dir, windowsJobOptions: f });
  try {
    const started = backend.start('PRIVATE PROMPT'); assert.equal(backend.pid, null);
    f.helper.stdout.write(ready(72)); await started; assert.equal(backend.pid, 72); assert.equal(backend.pgid, null);
    if (!backend.child.stdin.writableFinished) await once(backend.child.stdin, 'finish');
    assert.equal(f.sent[1][0], 2); assert.equal(f.sent[1].subarray(5).toString(), 'PRIVATE PROMPT'); assert.equal(f.sent[2][0], 3);
    const stopped = backend.stop(); f.helper.stdout.write(finished()); f.helper.emit('close', 0); assert.equal(await stopped, true); assert.equal(await backend.confirmStopped(), true);
    const claude = new ClaudeBackend({ platform: 'win32' }); assert.throws(() => claude.start('x'), /sandbox/); assert.equal(claude.pid, null);
    assert.equal(ClaudeBackend.describe('win32').startable, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('packaged Job helper follows trusted resources path in app.asar and unpacked utility processes', () => {
  for (const archive of ['app.asar', 'app.asar.unpacked']) assert.equal(jobHelperPath(path.resolve(`/Applications/Plexiform/resources/${archive}/board/shared`)), path.resolve('/Applications/Plexiform/resources/native/windows-process-job.exe'));
  assert.equal(jobHelperPath(path.resolve('/checkout/board/shared')), path.resolve('/checkout/native/bin/windows-process-job.exe'));
});
test('unconsumed provider output is bounded and cannot produce a stopped receipt after overflow', async () => {
  const f = fixture(), j = new WindowsJob('C:\\codex.exe', [], opts, f); f.helper.stdout.write(ready()); await j.ready;
  const chunk = jobFrame(130, Buffer.alloc(1024 * 1024));
  f.helper.stdout.write(chunk); f.helper.stdout.write(chunk); f.helper.stdout.write(chunk);
  assert.equal(await j.completion, false); assert.ok(f.killed); assert.ok(j.stdout.readableLength <= 2 * 1024 * 1024);
});

test('missing helper with no spawned PID is safely not started; a started helper error stays unknown', async () => {
  for (const didSpawn of [false, true]) {
    const f = fixture(); if (!didSpawn) f.helper.pid = undefined;
    const j = new WindowsJob('C:\\codex.exe', [], opts, f);
    f.helper.emit('error', Object.assign(new Error('fixture'), { code: 'ENOENT' }));
    await assert.rejects(j.ready, /unavailable/);
    assert.equal(await j.completion, !didSpawn);
    assert.equal(j.neverStarted === true, !didSpawn);
  }
});
