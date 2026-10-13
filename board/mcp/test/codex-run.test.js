import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readRunCapability, CODEX_BOARD_TOOLS } from '../codex-run.js';
import { startFakeRunner, TOKEN } from './fake-runner.js';
const SERVER = fileURLToPath(new URL('../codex-run.js', import.meta.url));
async function rig() {
  const r = await startFakeRunner();
  const dir = fs.realpathSync(path.dirname(r.socketPath));
  fs.chmodSync(dir, 0o700); fs.chmodSync(r.socketPath, 0o600);
  fs.writeFileSync(path.join(dir, 'hook.token'), TOKEN, { mode: 0o600 });
  return { ...r, dir };
}
test('Codex wrapper serves only fixed run tools after authenticated hello; token absent from argv/env/stderr', async () => {
  const r = await rig();
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER, r.dir], env: { PATH: process.env.PATH }, stderr: 'pipe' });
  let stderr = ''; t.stderr.on('data', (d) => stderr += d);
  const c = new Client({ name: 'codex-private-run-test', version: '0' });
  try {
    await c.connect(t); assert.equal(r.received[0].type, 'hello');
    assert.deepEqual((await c.listTools()).tools.map((x) => x.name).sort(), [...CODEX_BOARD_TOOLS].sort());
    const read = await c.callTool({ name: 'board_get_card', arguments: {} }); assert.equal(read.isError, undefined);
    const before = r.tools().length;
    const approval = await c.callTool({ name: 'approval', arguments: { tool_name: 'Bash', input: {} } }); assert.equal(approval.isError, true);
    assert.equal(r.tools().length, before); assert.ok(!stderr.includes(TOKEN));
  } finally { await c.close(); await r.close(); }
});
test('Codex wrapper refuses symlinks, loose modes, oversized/nonregular capability and wrong socket', async () => {
  const r = await rig(); const token = path.join(r.dir, 'hook.token'); const alias = `${r.dir}-alias`;
  try {
    assert.equal(readRunCapability(r.dir).token, TOKEN);
    fs.symlinkSync(r.dir, alias); assert.throws(() => readRunCapability(alias), /unavailable/);
    fs.chmodSync(r.dir, 0o755); assert.throws(() => readRunCapability(r.dir), /unavailable/); fs.chmodSync(r.dir, 0o700);
    fs.chmodSync(token, 0o644); assert.throws(() => readRunCapability(r.dir), /unavailable/); fs.chmodSync(token, 0o600);
    fs.writeFileSync(token, 'x'.repeat(4097)); assert.throws(() => readRunCapability(r.dir), /unavailable/);
    fs.unlinkSync(token); fs.symlinkSync(path.join(r.dir, 'other'), token); assert.throws(() => readRunCapability(r.dir), /unavailable/);
    fs.unlinkSync(token); fs.mkdirSync(token); assert.throws(() => readRunCapability(r.dir), /unavailable/);
    fs.rmSync(token, { recursive: true }); fs.writeFileSync(token, TOKEN, { mode: 0o600 });
    fs.chmodSync(r.socketPath, 0o666); assert.throws(() => readRunCapability(r.dir), /unavailable/);
  } finally { fs.rmSync(alias, { force: true }); await r.close(); }
});
test('Codex wrapper refuses a swapped run token before MCP initialization without disclosing it', async () => {
  const r = await rig(); const foreign = 'brt1.foreign-run.foreign-signature';
  fs.writeFileSync(path.join(r.dir, 'hook.token'), foreign);
  const child = spawn(process.execPath, [SERVER, r.dir], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', (d) => stdout += d); child.stderr.on('data', (d) => stderr += d);
  try {
    const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('wrapper did not fail')), 8000); child.on('exit', (c) => { clearTimeout(timer); resolve(c); }); });
    assert.equal(code, 1); assert.equal(stdout, ''); assert.ok(!stderr.includes(foreign)); assert.match(stderr, /capability unavailable/i);
    assert.ok(!r.received.some((x) => x.type === 'tool'));
  } finally { child.kill(); await r.close(); }
});
