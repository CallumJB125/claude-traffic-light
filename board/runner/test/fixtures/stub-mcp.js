#!/usr/bin/env node
// Minimal stdio MCP server (newline-delimited JSON-RPC) standing in for
// board/mcp/server.js when it is absent: lists every MCP_TOOLS entry with an
// open schema and proxies calls to the runner over the run's IPC socket.
import net from 'node:net';
import readline from 'node:readline';
import { MCP_TOOLS } from '../../../shared/protocol.js';

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let seq = 0;

function ipc(name, args) {
  return new Promise((resolve) => {
    const s = net.createConnection(process.env.BOARD_RUN_SOCKET);
    let buf = '';
    s.setEncoding('utf8');
    s.on('connect', () => s.write(`${JSON.stringify({ type: 'tool', id: String(++seq), token: process.env.BOARD_RUN_TOKEN, name, args })}\n`));
    s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { s.end(); resolve(JSON.parse(buf.slice(0, i))); } });
    s.on('error', (e) => resolve({ ok: false, error: { code: 'INTERNAL', message: e.message } }));
  });
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'board', version: '0.0.1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: MCP_TOOLS.map((name) => ({ name, description: `board ${name}`, inputSchema: { type: 'object', additionalProperties: true } })) } });
  else if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params;
    const r = await ipc(name, args ?? {});
    let text;
    if (name === 'approval') text = JSON.stringify(r.ok && r.result?.behavior === 'allow' ? { behavior: 'allow', updatedInput: args.input } : { behavior: 'deny', message: r.result?.message ?? r.error?.message ?? 'denied' });
    else text = r.ok ? JSON.stringify(r.result ?? {}) : `${r.error?.code}: ${r.error?.message}`;
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }], ...(r.ok || name === 'approval' ? {} : { isError: true }) } });
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
