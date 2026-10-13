#!/usr/bin/env node
// Trusted per-run stdio launcher. Its only argument is a private directory;
// the run capability never rides argv/env or reaches model shell commands.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IpcClient } from './ipc.js';
import { createBoardServer } from './server.js';
import { TOOLS } from './tools.js';

export const CODEX_BOARD_TOOLS = Object.freeze(Object.keys(TOOLS).filter((n) => n !== 'approval'));
const refused = () => Object.assign(new Error('private board run capability unavailable'), { code: 'UNAUTHENTICATED' });
const owned = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();

export function readRunCapability(dir) {
  let fd;
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.resolve(dir) !== dir || fs.realpathSync(dir) !== dir) throw refused();
    let current = path.parse(dir).root;
    for (const part of dir.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      if (!fs.lstatSync(current).isDirectory()) throw refused();
    }
    const parent = fs.lstatSync(dir);
    if (!owned(parent) || (parent.mode & 0o777) !== 0o700) throw refused();
    const tokenFile = path.join(dir, 'hook.token'), socketPath = path.join(dir, 'ipc.sock');
    const socket = fs.lstatSync(socketPath);
    if (!socket.isSocket() || !owned(socket) || (socket.mode & 0o777) !== 0o600) throw refused();
    fd = fs.openSync(tokenFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); // privacy-flow: local-board-sockets
    const tokenStat = fs.fstatSync(fd);
    if (!tokenStat.isFile() || !owned(tokenStat) || (tokenStat.mode & 0o777) !== 0o600 || tokenStat.size < 1 || tokenStat.size > 4096) throw refused();
    const buf = Buffer.alloc(4097), count = fs.readSync(fd, buf, 0, buf.length, 0);
    if (count > 4096) throw refused();
    const token = buf.subarray(0, count).toString('utf8');
    if (!/^brt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw refused();
    return { token, socketPath };
  } catch { throw refused(); } finally { if (fd != null) fs.closeSync(fd); }
}

export async function main(dir = process.argv[2]) {
  const ipc = new IpcClient(readRunCapability(dir));
  try {
    // A required MCP server must refuse initialization when its run is gone.
    await ipc.request('hello', {}, { timeoutMs: 5000 });
    const server = createBoardServer({ ipc, allowedTools: new Set(CODEX_BOARD_TOOLS) });
    server.onclose = () => { ipc.close(); process.exit(0); };
    await server.connect(new StdioServerTransport());
    return server;
  } catch { ipc.close(); throw refused(); }
}

const isEntry = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isEntry) main().catch(() => { process.stderr.write('Private board run capability unavailable\n'); process.exit(1); });
