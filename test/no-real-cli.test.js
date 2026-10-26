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
