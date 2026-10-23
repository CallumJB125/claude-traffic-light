'use strict';
// adapters/codex-mcp.js: Codex's MCP registration through its own CLI, never
// by editing config.toml. A fake `codex` (test/helpers/fake-codex.js) by
// default; the real CLI, when installed, only against a scratch CODEX_HOME
// (no model call is ever made).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CodexMcp = require('../../adapters/codex-mcp.js');
const { findCodexBin } = require('../../src/codex-app-server.js');
const Fake = require('../helpers/fake-codex.js');
const { testTempDir } = require('../helpers/tmp');

const SPEC = { command: '/Applications/Plexiform.app/Contents/MacOS/Plexiform', args: ['/Applications/Plexiform.app/Contents/Resources/app.asar/mcp-server.js', '--profile', 'bus'], env: { PLEXIFORM_MCP: 'bus-v1:packaged', ELECTRON_RUN_AS_NODE: '1' } };

function scratch(t) {
  const dir = testTempDir('pf-codexmcp-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexHome = path.join(dir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  return { dir, codexHome, bin: Fake.write(path.join(dir, 'bin')) };
}

test('argv: `codex mcp add plexiform-bus --env K=V … -- <command> <args>`, env sorted', () => {
  assert.deepEqual(CodexMcp.addArgs(SPEC), ['mcp', 'add', 'plexiform-bus', '--env', 'ELECTRON_RUN_AS_NODE=1', '--env', 'PLEXIFORM_MCP=bus-v1:packaged', '--',
    SPEC.command, ...SPEC.args]);
});

test('get / add / remove round trip, with Homebrew on the child PATH even when the app\'s PATH lacks it', async (t) => {
  const s = scratch(t);
  const cli = CodexMcp.create({ bin: s.bin, env: { PATH: '/usr/bin:/bin', CODEX_HOME: s.codexHome } });
  assert.deepEqual(await cli.get(), { ok: true, spec: null });
  assert.deepEqual(await cli.add(SPEC), { ok: true });
  const got = await cli.get();
  assert.equal(got.ok, true);
  assert.ok(CodexMcp.sameSpec(got.spec, SPEC));
  assert.deepEqual(await cli.remove(), { ok: true });
  assert.deepEqual(await cli.get(), { ok: true, spec: null });
  assert.deepEqual(Fake.calls(s.codexHome).map((c) => c.slice(0, 2).join(' ')), ['mcp get', 'mcp add', 'mcp get', 'mcp remove', 'mcp get']);
  // The CLI was handed a PATH with Homebrew on it (a Dock-launched app's PATH has none).
  let seenEnv;
  await CodexMcp.create({ bin: s.bin, env: { PATH: '/usr/bin:/bin', CODEX_HOME: s.codexHome }, execFile: (f, a, o, cb) => { seenEnv = o.env; cb(null, '', ''); } }).remove();
  assert.ok(seenEnv.PATH.split(':').includes('/opt/homebrew/bin'));
});

test('findCodexBin finds Codex where a Dock-launched app\'s PATH would not', () => {
  const found = findCodexBin({ env: { HOME: '/Users/u', PATH: '/usr/bin:/bin' }, exists: (p) => p === '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' });
  assert.equal(found, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
  assert.equal(findCodexBin({ env: { HOME: '/Users/u' }, exists: () => false }), null);
});

test('missing binary, timeout and failure are reported, never thrown', async (t) => {
  const s = scratch(t);
  assert.deepEqual(await CodexMcp.create({ bin: path.join(s.dir, 'nope') }).get(), { ok: false, error: 'missing' });
  assert.deepEqual(await CodexMcp.create({ bin: null }).add(SPEC), { ok: false, error: 'missing' });
  const slow = CodexMcp.create({ bin: s.bin, env: { CODEX_HOME: s.codexHome, FAKE_CODEX_MODE: 'timeout' }, timeoutMs: 300 });
  assert.deepEqual(await slow.get(), { ok: false, error: 'timeout' });
  const bad = CodexMcp.create({ bin: s.bin, env: { CODEX_HOME: s.codexHome, FAKE_CODEX_MODE: 'fail' } });
  assert.deepEqual(await bad.add(SPEC), { ok: false, error: 'failed' });
  assert.deepEqual(await bad.get(), { ok: false, error: 'failed' });
});

test('specOf reads only a stdio transport; sameSpec compares command, args and env exactly', () => {
  assert.equal(CodexMcp.specOf({ transport: { type: 'streamable_http', url: 'http://x' } }), null);
  assert.equal(CodexMcp.specOf(null), null);
  const s = CodexMcp.specOf({ transport: { type: 'stdio', command: 'c', args: ['a'], env: { B: '2', A: '1' } } });
  assert.ok(CodexMcp.sameSpec(s, { command: 'c', args: ['a'], env: { A: '1', B: '2' } }));
  assert.ok(!CodexMcp.sameSpec(s, { command: 'c', args: ['a'], env: { A: '1' } }));
  assert.ok(!CodexMcp.sameSpec(s, { command: 'c', args: ['a', 'b'], env: { A: '1', B: '2' } }));
});

test('the real Codex CLI, against a scratch CODEX_HOME only', { skip: !findCodexBin() && 'Codex is not installed' }, async (t) => {
  const s = scratch(t);
  const cli = CodexMcp.create({ bin: findCodexBin(), env: { ...process.env, HOME: s.dir, CODEX_HOME: s.codexHome } });
  assert.deepEqual(await cli.get(), { ok: true, spec: null });
  assert.deepEqual(await cli.add(SPEC), { ok: true });
  assert.ok(CodexMcp.sameSpec((await cli.get()).spec, SPEC), 'Codex keeps exactly what was written');
  assert.match(fs.readFileSync(path.join(s.codexHome, 'config.toml'), 'utf8'), /\[mcp_servers\.plexiform-bus\]/);
  assert.deepEqual(await cli.remove(), { ok: true });
  assert.deepEqual(await cli.get(), { ok: true, spec: null });
});
