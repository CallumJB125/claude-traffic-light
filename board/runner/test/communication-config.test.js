import test from 'node:test';
import assert from 'node:assert/strict';
import { codexConfig } from '../backends/codex.js';
import { CODEX_BOARD_TOOLS } from '../../mcp/codex-run.js';
import { TOOLS } from '../../mcp/tools.js';

test('Codex task communication tools share the exact private catalog and per-tool approval policy', () => {
  const opts = { cwd: '/repo/task', gitDir: '/repo/.git/worktrees/task', commonGitDir: '/repo/.git', gitRef: 'refs/heads/buddy/task', cacheDir: '/private/cache', dataDir: '/private/board', env: { HOME: '/home/user', CODEX_HOME: '/private/auth' } };
  const config = codexConfig({ ...opts, boardRunDir: '/private/board/runs/task' });
  assert.deepEqual(CODEX_BOARD_TOOLS, Object.keys(TOOLS).filter((name) => name !== 'approval'));
  for (const name of ['board_read_packet', 'board_write_packet', 'board_send_message', 'board_list_messages', 'board_ack_message']) assert.ok(CODEX_BOARD_TOOLS.includes(name), name);
  for (const name of ['approval', 'runner_messages_received', 'runner_plan_status']) assert.ok(!CODEX_BOARD_TOOLS.includes(name), name);
  assert.equal(config.find((line) => line.startsWith('mcp_servers.board.enabled_tools=')), `mcp_servers.board.enabled_tools=${JSON.stringify(CODEX_BOARD_TOOLS)}`);
  assert.ok(config.includes('mcp_servers.board.default_tools_approval_mode="prompt"'));
  assert.deepEqual(config.filter((line) => line.startsWith('mcp_servers.board.tools.')), CODEX_BOARD_TOOLS.map((name) => `mcp_servers.board.tools.${name}.approval_mode="approve"`));
  // Tool consent does not authorize a shell transition or expose credentials.
  const plan = codexConfig({ ...opts, readOnly: true, boardRunDir: '/private/board/runs/task' }).join('\n');
  assert.ok(plan.includes('":workspace_roots"="read"'));
  assert.ok(!plan.includes('"/repo/.git/objects"="write"'));
  for (const name of ['network.enabled=false', 'network.dangerously_allow_all_unix_sockets=false', '"/private/auth"="deny"', '"/private/board"="deny"']) assert.ok(plan.includes(name), name);
  const local = codexConfig(opts);
  assert.ok(local.includes('mcp_servers={}'));
  assert.ok(!local.some((line) => line.startsWith('mcp_servers.board.')));
});
