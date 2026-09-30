// A fake runner IPC server (CONTRACT §7.2) for board-mcp tests: NDJSON over a
// unix socket in a temp dir, token-checked, validated with protocol.validate.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { validate, MCP_TOOLS } from '../../shared/protocol.js';

export const TOKEN = 'brt1.test-payload.test-sig';

/**
 * @param {(msg, reply:(ok, resultOrError)=>void, sock) => void} [onTool]
 *   Default: echo {tool: name, args}.
 */
export async function startFakeRunner({ onTool, token = TOKEN } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bmcp-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const received = [];
  const invalid = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line);
        received.push(msg);
        const send = (obj) => { if (!sock.destroyed) sock.write(`${JSON.stringify(obj)}\n`); };
        const err = validate('ipc→runner', msg);
        if (err) { invalid.push({ msg, err }); send({ id: msg.id, ok: false, error: err }); continue; }
        if (msg.token !== token) { send({ id: msg.id, ok: false, error: { code: 'BAD_RUN_TOKEN', message: 'bad run token' } }); sock.end(); continue; }
        const reply = (ok, v) => send(ok ? { id: msg.id, ok: true, result: v } : { id: msg.id, ok: false, error: v });
        if (msg.type === 'hello') { reply(true, { run_id: 'run-1', card_id: 'card-1', key: 'DEV-1', fence: 3, repo_id: 'repo-1', tools: [...MCP_TOOLS] }); continue; }
        if (onTool) onTool(msg, reply, sock);
        else reply(true, { tool: msg.name, args: msg.args });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    received,
    invalid,
    tools: () => received.filter((m) => m.type === 'tool'),
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
