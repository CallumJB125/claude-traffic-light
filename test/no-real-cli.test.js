'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the guard is preloaded', () => {
  assert.equal(globalThis.__plexiformNoRealCli, true, 'run with node --import ./test/support/no-real-cli.mjs');
});

test('real CLIs are refused before anything is spawned', () => {
  assert.throws(() => cp.spawn('claude'), /no-real-cli/);
  assert.throws(() => cp.spawnSync('codex', ['--version']), /no-real-cli/);
  assert.throws(() => cp.execFileSync('/usr/local/bin/codex'), /no-real-cli/);
  assert.throws(() => cp.exec('codex --version'), /no-real-cli/);
  assert.throws(() => cp.execSync('echo hi; claude -p x'), /no-real-cli/);
  assert.throws(() => cp.spawn('/bin/sh', ['-c', 'codex --version']), /no-real-cli/);
  assert.throws(() => cp.spawn(process.execPath, ['/nonexistent/lib/node_modules/@anthropic-ai/claude-code/cli.js']), /no-real-cli/);
  assert.throws(() => cp.fork('/nonexistent/lib/node_modules/@openai/codex/bin/codex.js'), /no-real-cli/);
});

test('a refusal does not echo arguments', () => {
  assert.throws(() => cp.spawn('claude', ['--api-key', 'sk-ant-api03-THISISNOTREAL']), (e) => /no-real-cli/.test(e.message) && !e.message.includes('THISISNOTREAL'));
});

test('node, git and fakes in a tmpdir are allowed', () => {
  assert.equal(cp.spawnSync(process.execPath, ['-e', '0']).status, 0);
  assert.equal(cp.spawnSync('git', ['--version']).status, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrc-'));
  try {
    const fake = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    fs.writeFileSync(fake, process.platform === 'win32' ? '@echo off\r\necho fake\r\n' : '#!/bin/sh\necho fake\n', { mode: 0o755 });
    assert.match(cp.execFileSync(fake, { encoding: 'utf8' }), /fake/);
    if (process.platform !== 'win32') assert.match(cp.execSync(`${fake}`, { encoding: 'utf8' }), /fake/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ESM named imports see the wrapped functions', async () => {
  const esm = await import('node:child_process');
  assert.equal(esm.spawn, cp.spawn);
  assert.throws(() => esm.spawn('codex'), /no-real-cli/);
});

test('wrapper launchers are inspected for the real target', () => {
  for (const [file, args] of [
    ['/usr/bin/env', ['claude', '-p', 'x']],
    ['/usr/bin/env', ['-i', 'FOO=1', 'codex']],
    ['npx', ['@anthropic-ai/claude-code', '--version']],
    ['npx', ['-y', '@openai/codex@latest']],
    ['xargs', ['claude']],
    ['timeout', ['5', 'claude']],
    ['sudo', ['-n', 'codex']],
    ['nice', ['-n', '5', 'claude']],
    ['nohup', ['codex']],
    ['time', ['claude']],
  ]) assert.throws(() => cp.spawn(file, args), /no-real-cli/, `${file} ${args.join(' ')}`);
  assert.equal(cp.spawnSync('/usr/bin/env', ['true']).status, 0);
});

test('node flags do not hide the script', () => {
  const cli = '/nonexistent/lib/node_modules/@anthropic-ai/claude-code/cli.js';
  assert.throws(() => cp.spawn(process.execPath, ['--no-warnings', cli]), /no-real-cli/);
  assert.throws(() => cp.spawn(process.execPath, ['--max-old-space-size=64', '-r', 'x', cli]), /no-real-cli/);
  assert.throws(() => cp.spawn(process.execPath, ['--import', cli, '-e', '0']), /no-real-cli/);
  assert.throws(() => cp.spawn(process.execPath, ['/tmp/ok.js', cli]), /no-real-cli/);
  assert.equal(cp.spawnSync(process.execPath, ['--no-warnings', '-e', '0']).status, 0);
});

test('shell forms: sh/bash/zsh -c, command substitution, backticks, variables', () => {
  for (const sh of ['sh', 'bash', 'zsh']) assert.throws(() => cp.spawn(`/bin/${sh}`, ['-c', 'claude --version']), /no-real-cli/, sh);
  assert.throws(() => cp.spawn('/bin/bash', ['-lc', 'codex']), /no-real-cli/);
  assert.throws(() => cp.execSync('"$(which claude)" --version'), /no-real-cli/);
  assert.throws(() => cp.execSync('`which codex` exec'), /no-real-cli/);
  assert.throws(() => cp.execSync('X=claude;$X -p hi'), /no-real-cli/);
  assert.throws(() => cp.exec('echo $(command -v codex)'), /no-real-cli/);
  assert.equal(cp.execSync('echo hello', { encoding: 'utf8' }).trim(), 'hello');
});

test('grandchildren are guarded through NODE_OPTIONS', () => {
  assert.ok(String(process.env.NODE_OPTIONS).includes('no-real-cli.mjs'));
  assert.equal(String(process.env.NODE_OPTIONS).split('no-real-cli.mjs').length, 2, 'added once');
  const script = "try { require('node:child_process').spawnSync('claude'); } catch (e) { console.log(e.message); process.exit(7); }";
  for (const options of [{ encoding: 'utf8' }, { encoding: 'utf8', env: { PATH: process.env.PATH } }]) {
    const r = cp.spawnSync(process.execPath, ['-e', script], options);
    assert.equal(r.status, 7, r.stderr);
    assert.match(r.stdout, /no-real-cli/);
  }
});
