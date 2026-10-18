import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readTaskRunCapability } from '../task-run.js';
import { readRunCapability, CODEX_BOARD_TOOLS } from '../codex-run.js';
import { TASK_TOOL_NAMES } from '../task-tools.js';
import { codexConfig } from '../../runner/backends/codex.js';
import { TASK_MCP_SERVER, CODEX_MCP_SERVER } from '../../runner/launch.js';
import { testTempDir } from '../../shared/test-support/tmp.js';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const TOKEN = 't'.repeat(32);
async function rig({ scope = 'task' } = {}) {
  const dir = fs.realpathSync(testTempDir('mtask-'));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'hook.token'), TOKEN, { mode: 0o600 });
  const socketPath = path.join(dir, 'ipc.sock'), received = [], sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8'); let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk; let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const message = JSON.parse(pending.slice(0, nl)); pending = pending.slice(nl + 1); received.push(message);
        const reply = (result) => socket.write(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
        if (message.token !== TOKEN) { socket.write(`${JSON.stringify({ id: message.id, ok: false, error: { code: 'UNAUTHENTICATED', message: 'Unavailable' } })}\n`); continue; }
        if (message.type === 'hello') reply({ scope, task_id: 'tsk_test', tools: TASK_TOOL_NAMES });
        else if (message.name === 'approval') reply({ behavior: 'allow' });
        else reply({ task_id: 'tsk_test', echoed: message.name, args: message.args });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);
  return { dir, socketPath, received, async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('local-task Codex config uses a distinct private launcher, exact tools and unchanged sandbox boundaries', () => {
  const opts = { cwd: '/repo', dataDir: '/private/tasks', env: { HOME: '/home/user', PATH: '/usr/bin' } };
  const task = codexConfig({ ...opts, taskRunDir: '/private/run' });
  assert.ok(task.includes(`mcp_servers.board.args=${JSON.stringify([TASK_MCP_SERVER, '/private/run'])}`));
  assert.ok(task.includes(`mcp_servers.board.enabled_tools=${JSON.stringify(TASK_TOOL_NAMES)}`));
  assert.deepEqual(task.filter((v) => /^mcp_servers\.board\.tools\./.test(v)), TASK_TOOL_NAMES.map((name) => `mcp_servers.board.tools.${name}.approval_mode="approve"`));
  for (const line of ['permissions.plexiform.network.enabled=false', 'permissions.plexiform.network.dangerously_allow_all_unix_sockets=false', 'mcp_servers.board.env_vars=[]', 'mcp_servers.board.required=true']) assert.ok(task.includes(line));
  assert.match(task.find((v) => v.startsWith('permissions.plexiform.filesystem=')), /"\/private\/run"="deny"/);
  assert.ok(!task.some((v) => v.includes(TOKEN) || v.includes('tools.approval.')));
  const board = codexConfig({ ...opts, boardRunDir: '/private/board' });
  assert.ok(board.includes(`mcp_servers.board.args=${JSON.stringify([CODEX_MCP_SERVER, '/private/board'])}`));
  assert.ok(board.includes(`mcp_servers.board.enabled_tools=${JSON.stringify(CODEX_BOARD_TOOLS)}`));
  assert.throws(() => codexConfig({ ...opts, taskRunDir: '/private/run', boardRunDir: '/private/board' }), /exactly one/);
});

test('local task capability rejects Board tokens, aliases, loose modes and nonregular files', async () => {
  const r = await rig(), tokenFile = path.join(r.dir, 'hook.token'), alias = `${r.dir}-alias`;
  try {
    assert.equal(readTaskRunCapability(r.dir).token, TOKEN);
    assert.throws(() => readRunCapability(r.dir), /unavailable/, 'Board token parser stays strict');
    for (const bad of ['brt1.payload.signature', 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}!`]) {
      fs.writeFileSync(tokenFile, bad); assert.throws(() => readTaskRunCapability(r.dir), /unavailable/);
    }
    fs.writeFileSync(tokenFile, TOKEN);
    fs.symlinkSync(r.dir, alias); assert.throws(() => readTaskRunCapability(alias), /unavailable/);
    for (const [file, mode] of [[r.dir, 0o700], [tokenFile, 0o600], [r.socketPath, 0o600]]) {
      fs.chmodSync(file, 0o777); assert.throws(() => readTaskRunCapability(r.dir), /unavailable/); fs.chmodSync(file, mode);
    }
    fs.unlinkSync(tokenFile); fs.symlinkSync(path.join(r.dir, 'missing'), tokenFile); assert.throws(() => readTaskRunCapability(r.dir), /unavailable/);
    fs.unlinkSync(tokenFile); fs.mkdirSync(tokenFile); assert.throws(() => readTaskRunCapability(r.dir), /unavailable/);
  } finally { fs.rmSync(alias, { force: true }); await r.close(); }
});

test('real task stdio uses trusted scope; Claude retains approval and Codex exposes only collaboration tools', async () => {
  for (const claude of [false, true]) {
    const r = await rig();
    const transport = new StdioClientTransport({ command: process.execPath, args: claude ? [SERVER] : [TASK_MCP_SERVER, r.dir], env: claude ? { BOARD_RUN_SOCKET: r.socketPath, BOARD_RUN_TOKEN: TOKEN } : { PATH: process.env.PATH }, stderr: 'pipe' });
    let stderr = ''; transport.stderr.on('data', (chunk) => stderr += chunk);
    const client = new Client({ name: 'task-transport-test', version: '0' });
    try {
      await client.connect(transport);
      assert.equal(r.received[0].type, 'hello');
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...TASK_TOOL_NAMES, ...(claude ? ['approval'] : [])].sort());
      const response = await client.callTool({ name: 'buddy_tasks', arguments: {} });
      assert.equal(JSON.parse(response.content[0].text).echoed, 'buddy_tasks');
      const before = r.received.length;
      assert.equal((await client.callTool({ name: 'board_get_card', arguments: {} })).isError, true);
      assert.equal(r.received.length, before, 'Board tools never reach the task runner');
      const input = { command: 'node --version' };
      const approval = await client.callTool({ name: 'approval', arguments: { tool_name: 'Bash', input } });
      if (claude) assert.deepEqual(JSON.parse(approval.content[0].text), { behavior: 'allow', updatedInput: input });
      else { assert.equal(approval.isError, true); assert.equal(r.received.length, before); }
      assert.ok(!stderr.includes(TOKEN));
    } finally { await client.close(); await r.close(); }
  }
});

test('private task launcher refuses a Board hello before serving MCP', async () => {
  const r = await rig({ scope: 'board' });
  const child = spawn(process.execPath, [TASK_MCP_SERVER, r.dir], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
  try {
    const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Task launcher did not refuse')), 8000); child.on('exit', (code) => { clearTimeout(timer); resolve(code); }); });
    assert.equal(code, 1); assert.equal(stdout, ''); assert.ok(!stderr.includes(TOKEN)); assert.match(stderr, /capability unavailable/i);
    assert.equal(r.received.length, 1); assert.equal(r.received[0].type, 'hello');
  } finally { child.kill(); await r.close(); }
});
