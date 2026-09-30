// Per-run local IPC server (CONTRACT §7.2): unix socket in the 0700 run dir,
// socket 0600, NDJSON ≤ 1 MiB/line, every request carries the run token
// (constant-time compare; mismatch → BAD_RUN_TOKEN and the connection closes).
import net from 'node:net'; // privacy-flow: local-board-sockets
import fs from 'node:fs';
import crypto from 'node:crypto';
import { validate } from '../shared/protocol.js';

export const MAX_LINE = 1 << 20;

export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * handler: { hello(), tool(name, args, ctx), hook(event, payload), cancel(re, ctx) }
 * each returns a result (or throws {code, message}). ctx = {connId, reqId}.
 */
export function startIpcServer({ socketPath, token, handler, log }) {
  if (Buffer.byteLength(socketPath) > 103) throw new Error(`socket path too long for AF_UNIX: ${socketPath}`);
  try { fs.unlinkSync(socketPath); } catch { /* none */ }
  let connSeq = 0;
  const conns = new Set();
  const server = net.createServer((sock) => {
    const connId = ++connSeq;
    conns.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    const reply = (obj) => { if (!sock.destroyed) sock.write(`${JSON.stringify(obj)}\n`); };
    sock.on('data', (chunk) => {
      buf += chunk;
      if (Buffer.byteLength(buf) > MAX_LINE && !buf.includes('\n')) {
        reply({ id: null, ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'line exceeds 1 MiB' } });
        sock.destroy();
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { conns.delete(sock); handler.disconnect?.(connId); });

    function onLine(line) {
      let msg;
      try { msg = JSON.parse(line); } catch {
        reply({ id: null, ok: false, error: { code: 'VALIDATION', message: 'bad json' } });
        return;
      }
      const id = typeof msg?.id === 'string' ? msg.id : null;
      if (!tokenEquals(msg?.token, token)) {
        reply({ id, ok: false, error: { code: 'BAD_RUN_TOKEN', message: 'bad run token' } });
        sock.end();
        return;
      }
      const err = validate('ipc→runner', msg);
      if (err) { reply({ id, ok: false, error: err }); return; }
      // `cancel {id, token, re}`: board-mcp aborting a held call (the CLI cancelled it).
      if (msg.type === 'cancel') {
        Promise.resolve().then(() => handler.cancel?.(msg.re, { connId, reqId: id }))
          .then(() => reply({ id, ok: true, result: {} }), () => reply({ id, ok: true, result: {} }));
        return;
      }
      const ctx = { connId, reqId: id };
      Promise.resolve()
        .then(() => {
          if (msg.type === 'hello') return handler.hello(ctx);
          if (msg.type === 'tool') return handler.tool(msg.name, msg.args, ctx);
          return handler.hook(msg.event, msg.payload, ctx);
        })
        .then((result) => reply({ id, ok: true, result }))
        .catch((e) => {
          if (!e?.code) log?.error('ipc handler error', { err: e?.message });
          reply({ id, ok: false, error: { code: e?.code || 'INTERNAL', message: e?.message || String(e) } });
        });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o600); } catch { /* raced close */ }
      resolve({
        server,
        close: () => new Promise((r) => {
          for (const c of conns) c.destroy();
          server.close(() => { try { fs.unlinkSync(socketPath); } catch { /* gone */ } r(); });
        }),
      });
    });
  });
}

/** Minimal client (hook shim, tests). */
export function ipcRequest(socketPath, msg, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath); // privacy-flow: local-board-sockets
    let buf = '';
    const t = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('ipc timeout'), { code: 'TIMEOUT' })); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify(msg)}\n`));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        clearTimeout(t);
        sock.end();
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
