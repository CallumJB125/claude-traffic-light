import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync, exec } from 'node:child_process';

test('the board entry points load the guard', () => {
  assert.equal(globalThis.__plexiformNoRealCli, true, 'run with node --import ../test/support/no-real-cli.mjs');
});

test('real CLIs are refused, node and git are not', () => {
  assert.throws(() => spawn('claude'), /no-real-cli/);
  assert.throws(() => execFileSync('/usr/local/bin/codex'), /no-real-cli/);
  assert.throws(() => exec('codex --version'), /no-real-cli/);
  assert.throws(() => spawn(process.execPath, ['/nonexistent/lib/node_modules/@anthropic-ai/claude-code/cli.js']), /no-real-cli/);
  assert.equal(spawnSync(process.execPath, ['-e', '0']).status, 0);
  assert.equal(spawnSync('git', ['--version']).status, 0);
});

test('wrappers, node flags and shell forms are refused', () => {
  assert.throws(() => spawn('/usr/bin/env', ['claude']), /no-real-cli/);
  assert.throws(() => spawn(process.execPath, ['--no-warnings', '/x/node_modules/@openai/codex/bin/codex.js']), /no-real-cli/);
  assert.throws(() => exec('"$(which claude)"'), /no-real-cli/);
});

test('a grandchild node process is guarded too', () => {
  const r = spawnSync(process.execPath, ['-e', "try { require('node:child_process').spawnSync('codex'); } catch (e) { console.log(e.message); process.exit(7); }"], { encoding: 'utf8' });
  assert.equal(r.status, 7, r.stderr);
});
