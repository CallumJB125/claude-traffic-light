// Local IPC client: board-mcp → runner over the run's unix socket (CONTRACT §7.2).
// NDJSON, one JSON object per line, ≤ 1 MiB; every request carries `id` and the
// per-run `token`. board-mcp never talks to the hub: the runner owns scope,
// fence, redaction and the hub connection.

import net from '../shared/local-sockets.cjs'; // protected Windows local transport; POSIX Unix sockets

export const MAX_LINE_BYTES = 1024 * 1024;

export class IpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class IpcClient {
  /**
   * @param {{socketPath: string, token: string, connectTimeoutMs?: number}} opts
   */
  constructor({ socketPath, token, connectTimeoutMs = 5000 }) {
    if (!socketPath) throw new IpcError('VALIDATION', 'BOARD_RUN_SOCKET is not set');
    if (!token) throw new IpcError('VALIDATION', 'BOARD_RUN_TOKEN is not set');
    this.socketPath = socketPath;
    this.token = token;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
  }

  // Lazy (re)connect: a runner restart kills the run anyway, but a transient
  // close must not wedge every later tool call.
  connect() {
    if (this.socket) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath); // privacy-flow: local-board-sockets
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new IpcError('INTERNAL', `board runner did not accept the connection within ${this.connectTimeoutMs} ms`));
      }, this.connectTimeoutMs);
      sock.setEncoding('utf8');
      sock.once('connect', () => {
        clearTimeout(timer);
        this.socket = sock;
        resolve();
      });
      sock.on('data', (chunk) => this.#onData(chunk));
      sock.on('error', (err) => {
        clearTimeout(timer);
        if (this.socket !== sock) reject(new IpcError('INTERNAL', `board runner unavailable: ${err.code || err.message}`));
      });
      sock.on('close', () => {
        clearTimeout(timer);
        if (this.socket === sock) this.#onClose();
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  #onData(chunk) {
    this.buf += chunk;
    if (Buffer.byteLength(this.buf) > MAX_LINE_BYTES && !this.buf.includes('\n')) {
      this.#failAll(new IpcError('PAYLOAD_TOO_LARGE', 'runner response exceeds 1 MiB'));
      this.socket?.destroy();
      return;
    }
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = msg && this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      p.settle(msg);
    }
  }

  #onClose() {
    this.socket = null;
    this.buf = '';
    this.#failAll(new IpcError('INTERNAL', 'board runner closed the connection'));
  }

  #failAll(err) {
    for (const p of this.pending.values()) p.fail(err);
    this.pending.clear();
  }

  /**
   * Send one request and resolve with its `result`, or reject with IpcError.
   * `signal` aborts the wait (the late response is dropped); `timeoutMs` 0 = none.
   */
  async request(type, body = {}, { signal, timeoutMs = 0 } = {}) {
    if (signal?.aborted) throw new IpcError('CANCELLED', 'request cancelled');
    await this.connect();
    const id = String(this.nextId++);
    const line = `${JSON.stringify({ type, id, token: this.token, ...body })}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new IpcError('PAYLOAD_TOO_LARGE', 'request exceeds 1 MiB');
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        done();
        // Tell the runner so a held call (approval) is withdrawn on the hub too.
        try { this.socket?.write(`${JSON.stringify({ type: 'cancel', id: String(this.nextId++), token: this.token, re: id })}\n`); } catch { /* closed */ }
        reject(new IpcError('CANCELLED', 'request cancelled'));
      };
      this.pending.set(id, {
        settle: (msg) => {
          done();
          if (msg.ok) resolve(msg.result);
          else reject(new IpcError(msg.error?.code || 'INTERNAL', msg.error?.message || 'runner error'));
        },
        fail: (err) => { done(); reject(err); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => { done(); reject(new IpcError('INTERNAL', `board runner did not answer within ${timeoutMs} ms`)); }, timeoutMs);
      }
      this.socket.write(line);
    });
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}
