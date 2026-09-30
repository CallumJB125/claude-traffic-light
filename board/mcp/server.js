#!/usr/bin/env node
// board-mcp: the per-run stdio MCP server named `board` (CONTRACT §7.1, §7.3).
// Spawned by the CLI from the run's mcp.json with env BOARD_RUN_SOCKET and
// BOARD_RUN_TOKEN. Every tool call is forwarded to the runner over local IPC;
// this process never talks to the hub.

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { IpcClient } from './ipc.js';
import { TOOLS, callTool, jsonSchemaOf, errorResult } from './tools.js';

export const SERVER_NAME = 'board';
export const SERVER_VERSION = '0.1.0';

export const INSTRUCTIONS = `You are working on a card from your team's board. The board tools keep your teammates informed and make your work resumable by someone else at any moment.

1. board_get_card, then board_declare_plan before editing.
2. Keep board_write_handover current as you go (plan, done, dead ends, next step); nothing is written for you if you stop suddenly. Use board_update_status for the one-line status.
3. Blocked on a human? board_ask_human with one clear, self-contained question.
4. Found separate work outside this card? board_create_card (a To do child card). Learned something about the repo a teammate should know? board_add_lesson.
5. Finished? Attach evidence (PR or pushed commit, plus a test run or a no-tests reason) with board_attach_evidence, then board_complete. Can't finish? board_release.

Errors: FENCED means this card was taken over or stopped, RUN_ENDED that this run is over (completed, released or stopped); either way stop working and end your turn. GATE_CLOSED or HUB_UNREACHABLE mean the board is offline; status, progress, handover and comment calls are queued, other calls should be retried later.`;

// Loaded from the Claude Code plugin (board/plugin, D34) in an ordinary
// session: there is no run to proxy to, so no tools are listed.
export const OUTSIDE_RUN_INSTRUCTIONS = 'Team board plugin: the board tools are available only inside a board run, which the board runner starts when a card is given to Claude. This session is not one, so no board tools are listed.';

function log(level, msg, extra = {}) {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })}\n`);
}

export function createBoardServer({ ipc }) {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions: ipc ? INSTRUCTIONS : OUTSIDE_RUN_INSTRUCTIONS });
  const list = !ipc ? [] : Object.entries(TOOLS).map(([name, def]) => ({
    name,
    title: def.title,
    description: def.description,
    inputSchema: jsonSchemaOf(def),
    ...(def.annotations && { annotations: { title: def.title, ...def.annotations } }),
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => (ipc
    ? callTool(ipc, req.params.name, req.params.arguments, { signal: extra.signal })
    : errorResult('VALIDATION', 'not inside a board run')));
  return server;
}

export async function main(env = process.env) {
  // Only the plugin sets BOARD_MCP_PLUGIN; a run missing its socket or token
  // still fails loudly below.
  if (env.BOARD_MCP_PLUGIN === '1' && !env.BOARD_RUN_SOCKET && !env.BOARD_RUN_TOKEN) {
    await createBoardServer({ ipc: null }).connect(new StdioServerTransport());
    return;
  }
  const ipc = new IpcClient({ socketPath: env.BOARD_RUN_SOCKET, token: env.BOARD_RUN_TOKEN });
  const server = createBoardServer({ ipc });
  server.onclose = () => { ipc.close(); process.exit(0); };
  await server.connect(new StdioServerTransport());
  ipc.request('hello', {}, { timeoutMs: 5000 }).then(
    (r) => log('info', 'board-mcp connected to runner', { run_id: r?.run_id, key: r?.key }),
    (err) => log('warn', 'board-mcp could not greet runner', { code: err.code, error: err.message }),
  );
}

const isEntry = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isEntry) {
  main().catch((err) => { log('error', 'board-mcp failed to start', { error: err.message, code: err.code }); process.exit(1); });
}
