// Tasks API client (TASKS-CONTRACT.md §3–§7), shared by the Buddy UI (Electron
// main process), the `buddy` CLI and the buddy_spin_off MCP tool. Node only
// (unix socket; a Windows named pipe path works the same through net).
//
//   const c = await connect();                   // BOARD_HOME/runner.sock + tasks.token
//   const { id } = await c.createTask({ text, cwd });
//   const s = await c.subscribe(id, { fromSeq }, (event) => …);
//   c.isGreen(id)                                // the green lease rule (§6.2); never infer it elsewhere
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { TASKS_PROTOCOL_VERSION, MAX_FRAME_BYTES, GREEN_TTL_MS, SOCKET_NAME, TOKEN_NAME, TAKEOVER_TIMEOUT_MS } from './protocol.js';

export class TasksError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function defaultPaths(env = process.env) {
  const home = env.BOARD_HOME || path.join(os.homedir(), '.board');
  return { socketPath: path.join(home, SOCKET_NAME), tokenPath: path.join(home, TOKEN_NAME) };
}

/** Reads the token, refusing a file other users could read or that another user owns (§9.1). */
export function readToken(tokenPath) {
  const st = fs.statSync(tokenPath);
  if (process.platform !== 'win32') {
    if ((st.mode & 0o077) !== 0) throw new TasksError('FORBIDDEN', `${tokenPath} must be 0600 (is ${(st.mode & 0o777).toString(8)})`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new TasksError('FORBIDDEN', `${tokenPath} is owned by another user`);
  }
  return fs.readFileSync(tokenPath, 'utf8').trim();
}

export const newRequestId = () => crypto.randomUUID();

export class TasksClient extends EventEmitter {
  constructor(sock, token, { timeoutMs = 30000 } = {}) {
    super();
    this.sock = sock;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.subs = new Map();          // sub → {handler, filter, lastSeq}
    this.early = new Map();         // sub → events pushed before subscribe() saw its reply
    this.green = new Map();         // taskId → {green, at}
    this.lastHbAt = null;
    this.epoch = null;
    this.closed = false;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      if (!buf.includes('\n') && Buffer.byteLength(buf) > MAX_FRAME_BYTES) { this.#fail(new TasksError('PAYLOAD_TOO_LARGE', 'server frame exceeds 1 MiB')); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.#onFrame(msg);
      }
    });
    sock.on('error', (e) => this.#fail(e));
    sock.on('close', () => {
      const code = this.lastErrorCode === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'SUPERVISOR_UNREACHABLE';
      this.#fail(new TasksError(code, 'connection to the Buddy supervisor closed'));
    });
  }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.t); p.reject(err); }
    this.pending.clear();
    this.green.clear();
    this.emit('close', err);
  }

  #onFrame(msg) {
    if (msg.push) return this.#onPush(msg);
    const p = this.pending.get(msg.id);
    if (!p) {
      if (msg.error) { this.lastErrorCode = msg.error.code; this.emit('error-frame', msg.error); }
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.t);
    if (msg.error) {
      this.lastErrorCode = msg.error.code;
      p.reject(new TasksError(msg.error.code, msg.error.message, msg.error.details));
    } else p.resolve(msg.result);
  }

  #onPush(msg) {
    switch (msg.push) {
      case 'event': {
        const s = this.subs.get(msg.sub);
        const e = msg.event;
        if (e.type === 'state') this.green.set(e.taskId, { green: e.green, at: performance.now() });
        if (!s) {
          // Replay follows the subscribe reply in the same read, before the caller's await resumes.
          if (!this.early.has(msg.sub)) this.early.set(msg.sub, []);
          if (this.early.size <= 64) this.early.get(msg.sub).push(e);
          return;
        }
        this.#dispatch(s, e);
        return;
      }
      case 'hb': {
        this.lastHbAt = performance.now();
        for (const t of msg.tasks) this.green.set(t.id, { green: t.green, at: this.lastHbAt });
        this.emit('hb', msg);
        return;
      }
      case 'lagged': {
        // Dropped for backpressure: resubscribe from where we got to; the ring replays the gap.
        const s = this.subs.get(msg.sub);
        if (!s) return;
        this.subs.delete(msg.sub);
        this.emit('lagged', msg);
        this.#resubscribe(s, msg.sub).catch((e) => this.emit('error', e));
        return;
      }
      case 'reset': {
        // Epoch changed or the ring no longer has fromSeq: refetch state, then continue live.
        const s = this.subs.get(msg.sub);
        this.emit('reset', msg);
        if (s) this.#reset(s, msg);
        else {
          if (!this.early.has(msg.sub)) this.early.set(msg.sub, []);
          this.early.get(msg.sub).push({ reset: msg });
        }
        return;
      }
      case 'bye': this.emit('bye', msg); return;
      default:
    }
  }

  #dispatch(s, e) {
    if (e.seq <= s.lastSeq) return;        // duplicate after a resubscribe
    s.lastSeq = e.seq;
    s.handler(e);
  }

  #reset(s, msg) {
    s.lastSeq = msg.latestSeq;
    s.onReset?.(msg);
  }

  #attach(sub, s) {
    this.subs.set(sub, s);
    const early = this.early.get(sub) ?? [];
    this.early.delete(sub);
    for (const e of early) {
      if (e.reset) this.#reset(s, e.reset);
      else this.#dispatch(s, e);
    }
  }

  async #resubscribe(s, oldSub) {
    const r = await this.call('subscribe', { id: s.filter, fromSeq: s.lastSeq + 1, epoch: this.epoch });
    s.handle.sub = r.sub;
    this.#attach(r.sub, s);
    this.emit('resubscribed', { from: oldSub, to: r.sub });
  }

  call(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new TasksError('SUPERVISOR_UNREACHABLE', 'connection closed'));
    const id = String(this.nextId++);
    const line = `${JSON.stringify({ id, method, params, token: this.token })}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return Promise.reject(new TasksError('PAYLOAD_TOO_LARGE', 'request exceeds 1 MiB'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new TasksError('TIMEOUT', `${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      this.sock.write(line);
    });
  }

  async hello(client = { name: 'buddy-tasks-client', version: '1' }) {
    const r = await this.call('hello', { protocol: TASKS_PROTOCOL_VERSION, client });
    this.epoch = r.epoch;
    this.server = r;
    return r;
  }

  createTask(spec, { requestId = newRequestId() } = {}) { return this.call('createTask', { requestId, spec }); }
  listTasks(opts = {}) { return this.call('listTasks', opts); }
  getTask(id) { return this.call('getTask', { id }); }
  listMessages(id, { afterSeq } = {}) { return this.call('listMessages', afterSeq == null ? { id } : { id, afterSeq }); }
  detectAIs() { return this.call('detectAIs'); }
  getLimits() { return this.call('getLimits'); }
  setLimits(p) { return this.call('setLimits', p); }
  getClaims(repo) { return this.call('getClaims', { repo }); }

  act(id, action, payload = {}, { requestId = newRequestId(), timeoutMs } = {}) {
    const t = timeoutMs ?? (action === 'takeover' ? TAKEOVER_TIMEOUT_MS : this.timeoutMs);
    return this.call('act', { id, action, payload, requestId }, { timeoutMs: t });
  }

  /**
   * subscribe(id | '*', {fromSeq, onReset}, handler) → {sub, epoch, latestSeq, replayed, unsubscribe()}
   * Events arrive in seq order; replayed ones first (their at_age_ms is their age now).
   */
  async subscribe(id, { fromSeq, onReset } = {}, handler = () => {}) {
    const params = { id, ...(fromSeq != null ? { fromSeq } : {}), ...(this.epoch ? { epoch: this.epoch } : {}) };
    const r = await this.call('subscribe', params);
    const s = { handler, filter: id, lastSeq: fromSeq != null ? fromSeq - 1 : r.latestSeq, onReset, handle: null };
    const handle = {
      sub: r.sub, epoch: r.epoch, latestSeq: r.latestSeq, replayed: r.replayed,
      unsubscribe: () => { this.subs.delete(handle.sub); return this.call('unsubscribe', { sub: handle.sub }).catch(() => {}); },
    };
    s.handle = handle;
    this.#attach(r.sub, s);
    return handle;
  }

  /**
   * The green lease (§6.2): green only if the latest signal for the task
   * (a state event or an hb push) said green and is at most GREEN_TTL_MS old,
   * and the connection is up.
   */
  isGreen(taskId, nowMs = performance.now()) {
    if (this.closed) return false;
    const g = this.green.get(taskId);
    return !!g && g.green === true && nowMs - g.at <= GREEN_TTL_MS;
  }

  close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.t); p.reject(new TasksError('SUPERVISOR_UNREACHABLE', 'client closed')); }
    this.pending.clear();
    this.sock.end();
    this.sock.destroy();
  }
}

/** connect({socketPath, tokenPath, token, client, timeoutMs}) → hello'd TasksClient. */
export async function connect(opts = {}) {
  const d = defaultPaths(opts.env);
  const socketPath = opts.socketPath ?? d.socketPath;
  const token = opts.token ?? readToken(opts.tokenPath ?? d.tokenPath);
  const sock = await new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.once('connect', () => { s.off('error', reject); resolve(s); });
    s.once('error', (e) => reject(new TasksError('SUPERVISOR_UNREACHABLE', `Buddy supervisor not reachable at ${socketPath}: ${e.code ?? e.message}`)));
  });
  const c = new TasksClient(sock, token, opts);
  await c.hello(opts.client);
  return c;
}
