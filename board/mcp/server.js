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
import { TOOLS, callTool, jsonSchemaOf } from './tools.js';

export const SERVER_NAME = 'board';
export const SERVER_VERSION = '0.1.0';

export const INSTRUCTIONS = `You are working on a card from your team's board. The board tools keep your teammates informed and make your work resumable by someone else at any moment.

1. board_get_card, then board_declare_plan before editing.
2. Keep board_write_handover current as you go (plan, done, dead ends, next step); nothing is written for you if you stop suddenly. Use board_update_status for the one-line status.
3. Blocked on a human? board_ask_human with one clear, self-contained question.
4. Finished? Attach evidence (PR or pushed commit, plus a test run or a no-tests reason) with board_attach_evidence, then board_complete. Can't finish? board_release.

Errors: FENCED or RUN_ENDED mean this card was taken over or stopped; stop working and end your turn. GATE_CLOSED or HUB_UNREACHABLE mean the board is offline; status, progress, handover and comment calls are queued, other calls should be retried later.`;

function log(level, msg, extra = {}) {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })}\n`);
}

export function createBoardServer({ ipc }) {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const list = Object.entries(TOOLS).map(([name, def]) => ({
    name,
    title: def.title,
    description: def.description,
    inputSchema: jsonSchemaOf(def),
    ...(def.annotations && { annotations: { title: def.title, ...def.annotations } }),
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => callTool(ipc, req.params.name, req.params.arguments, { signal: extra.signal }));
  return server;
}

export async function main(env = process.env) {
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
