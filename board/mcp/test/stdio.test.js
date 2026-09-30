// Spawns mcp/server.js over stdio with the SDK's own client, exactly as the CLI
// would from the run's mcp.json, against a fake runner socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_TOOLS } from '../../shared/protocol.js';
import { startFakeRunner, TOKEN } from './fake-runner.js';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));

test('stdio: list and call tools through the real server process', async () => {
  const runner = await startFakeRunner({
    onTool(msg, reply) {
      if (msg.name === 'approval') return setTimeout(() => reply(true, { behavior: 'allow' }), 200);
      reply(true, { echoed: msg.name });
    },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { BOARD_RUN_SOCKET: runner.socketPath, BOARD_RUN_TOKEN: TOKEN },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (d) => { stderr += d; });
  const client = new Client({ name: 'stdio-test', version: '0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'board');

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...MCP_TOOLS].sort());

    const res = await client.callTool({ name: 'board_get_card', arguments: {} });
    assert.deepEqual(JSON.parse(res.content[0].text), { echoed: 'board_get_card' });

    const input = { command: 'npm test' };
    const ap = await client.callTool({ name: 'approval', arguments: { tool_name: 'Bash', input, tool_use_id: 'toolu_x' } });
    assert.deepEqual(JSON.parse(ap.content[0].text), { behavior: 'allow', updatedInput: input });

    const bad = await client.callTool({ name: 'board_release', arguments: { reason: 'x' } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /^VALIDATION: requeue/);

    for (let i = 0; i < 100 && !runner.received.some((m) => m.type === 'hello'); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(runner.received.some((m) => m.type === 'hello'), 'server greets the runner');
    for (const m of runner.received) assert.equal(m.token, TOKEN);
    assert.deepEqual(runner.invalid, []);
    assert.ok(!stderr.includes(TOKEN), 'the run token is never logged');
  } finally {
    await client.close();
    await runner.close();
  }
});

test('stdio: missing env → exits non-zero without serving', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [SERVER], { env: { PATH: process.env.PATH }, input: '', timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(String(r.stderr), /BOARD_RUN_SOCKET is not set/);
});
