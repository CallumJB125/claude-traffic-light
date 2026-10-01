// The Tasks API socket (TASKS-CONTRACT.md §3, §4, §6.3): a unix socket in the
// engine's 0700 data dir (socket 0600), the per-user token (0600, constant-
// time compare over sha256), NDJSON frames ≤ 1 MiB, strict schema validation
// before anything reaches the engine, replay/backpressure for subscriptions
// and the hb green lease push. Local only: no TCP, no network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net'; // privacy-flow: local-board-sockets
import path from 'node:path';
import { validate } from '../tasks-api/validate.js';
import { MAX_FRAME_BYTES, HB_PUSH_MS, BACKPRESSURE_BYTES, SOCKET_NAME, TOKEN_NAME, METHODS } from '../tasks-api/protocol.js';
import { ApiError, SCHEMA } from './engine.js';
import { relayLookup } from './relay-tokens.js';

const PARAMS_DEF = {
  hello: 'HelloParams', createTask: 'CreateTaskParams', listTasks: 'ListTasksParams', getTask: 'GetTaskParams',
  subscribe: 'SubscribeParams', unsubscribe: 'UnsubscribeParams', act: 'ActParams', setLimits: 'SetLimitsParams',
  getClaims: 'GetClaimsParams', listMessages: 'ListMessagesParams',
};
export const MAX_SOCKET_PATH = 103;     // AF_UNIX sun_path is 104 bytes on macOS
const MAX_CONNECTIONS = 32;
const MAX_SUBS_PER_CONN = 16;
const MAX_WRITE_BUFFER = 16 * 1024 * 1024;   // a client that stops reading is cut off here
const MAX_INFLIGHT_PER_CONN = 64;
const HELLO_WITHIN_MS = 10000;
const TOKEN_RE = /^btk_[A-Za-z0-9_-]{43}$/;

export class StartError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Refuse anything at the socket path except our own dead socket, which is removed. */
async function clearSocketPath(socketPath) {
  let st;
  try { st = fs.lstatSync(socketPath); } catch (e) { if (e.code === 'ENOENT') return; throw new StartError('SOCKET_IN_USE', 'the socket path cannot be checked'); }
  if (!st.isSocket()) throw new StartError('SOCKET_IN_USE', 'something other than a socket is at the socket path');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new StartError('SOCKET_IN_USE', 'the socket belongs to another user');
  const live = await new Promise((resolve) => {
    const s = net.createConnection(socketPath); // privacy-flow: local-board-sockets
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  if (live) throw new StartError('SOCKET_IN_USE', 'another Tasks engine is already listening');
  fs.unlinkSync(socketPath);
}

/** The per-user token: reused when private and well-formed, otherwise replaced (it may have leaked). */
function ensureToken(tokenPath) {
  let st = null;
  try { st = fs.lstatSync(tokenPath); } catch { /* none yet */ }
  if (st) {
    const own = typeof process.getuid !== 'function' || st.uid === process.getuid();
    if (st.isFile() && !st.isSymbolicLink() && own && (st.mode & 0o077) === 0) {
      const t = fs.readFileSync(tokenPath, 'utf8').trim();
      if (TOKEN_RE.test(t)) return t;
    }
    fs.rmSync(tokenPath, { force: true });
  }
  const token = `btk_${crypto.randomBytes(32).toString('base64url')}`;
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tokenPath, 0o600);
  return token;
}

export async function startTransport({ engine, dir, log, hbMs = HB_PUSH_MS }) {
  const socketPath = path.join(dir, SOCKET_NAME);
  const tokenPath = path.join(dir, TOKEN_NAME);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new StartError('SOCKET_PATH_TOO_LONG', 'the data folder path is too long for a local socket');
  await clearSocketPath(socketPath);
  const token = ensureToken(tokenPath);
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const relay = relayLookup(dir);
  // The UI/CLI token is the full principal; a relay token is scoped to its source.
  const authOf = (t) => {
    if (typeof t !== 'string' || t.length > 256) return null;
    if (crypto.timingSafeEqual(crypto.createHash('sha256').update(t).digest(), tokenHash)) return { kind: 'full' };
    return relay(t);
  };
  const conns = new Set();
  const subs = new Map();      // sub → {conn, filter, lastSent}
  const startedAt = Date.now();

  function send(conn, obj) {
    if (conn.destroyed) return;
    if (conn.writableLength > MAX_WRITE_BUFFER) { conn.destroy(); return; }
    let line = JSON.stringify(obj);
    if (Buffer.byteLength(line) >= MAX_FRAME_BYTES) {
      if (obj.push) { log.warn('dropped an oversize push', { kind: obj.push }); return; }
      line = JSON.stringify({ id: obj.id ?? null, error: { code: 'PAYLOAD_TOO_LARGE', message: 'response exceeds 1 MiB' } });
    }
    conn.write(`${line}\n`);
  }

  function pushEvent(sub, s, e) {
    const { conn } = s;
    if (conn.destroyed) return;
    if (conn.writableLength > BACKPRESSURE_BYTES) {
      // Never block other clients or the tasks: drop this subscription and say where to resume once drained.
      subs.delete(sub);
      conn.once('drain', () => send(conn, { push: 'lagged', sub, lastSeq: s.lastSent }));
      return;
    }
    s.lastSent = e.seq;
    send(conn, { push: 'event', sub, event: e });
  }

  const onEvent = (e) => {
    for (const [sub, s] of subs) if (s.filter === '*' || s.filter === e.taskId) pushEvent(sub, s, e);
  };
  engine.on('event', onEvent);

  async function onRequest(conn, st, msg) {
    const id = typeof msg?.id === 'string' && msg.id.length <= 128 ? msg.id : null;
    const fail = (code, message, details) => send(conn, { id, error: { code, message, ...(details ? { details } : {}) } });
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail('VALIDATION', 'a frame must be a JSON object');
    const principal = authOf(msg.token);
    if (!principal) {
      fail('UNAUTHENTICATED', 'bad or missing token');
      conn.end();
      st.dead = true;
      return;
    }
    const re = validate(SCHEMA, 'Request', msg);
    if (re) {
      if (typeof msg.method === 'string' && !METHODS.includes(msg.method)) return fail('UNKNOWN_METHOD', 'unknown method');
      return fail('VALIDATION', `${re.path}: ${re.message}`);
    }
    if (!st.hello && msg.method !== 'hello') return fail('VALIDATION', 'send hello first');
    const params = msg.params;
    const def = PARAMS_DEF[msg.method];
    if (def) {
      const pe = validate(SCHEMA, def, params);
      if (pe) return fail('VALIDATION', `params${pe.path.slice(1)}: ${pe.message}`);
    }
    if (st.inflight >= MAX_INFLIGHT_PER_CONN) return fail('RATE_LIMITED', 'too many requests in flight on this connection');
    st.inflight += 1;
    try {
      switch (msg.method) {
        case 'hello': {
          const r = engine.hello(params);
          st.hello = true;
          clearTimeout(st.helloTimer);
          return send(conn, { id, result: r });
        }
        case 'subscribe': {
          if ([...subs.values()].filter((s) => s.conn === conn).length >= MAX_SUBS_PER_CONN) return fail('VALIDATION', 'too many subscriptions on this connection');
          const { reset, events } = engine.replay(params.id, params.fromSeq, params.epoch);
          const sub = `sub_${crypto.randomBytes(6).toString('hex')}`;
          const latestSeq = engine.seq;
          // A replay is paged: past BACKPRESSURE_BYTES it stops and says `lagged`, and the
          // client resubscribes from where it got to. Never one unbounded burst.
          let bytes = 0;
          let n = 0;
          while (n < events.length && bytes < BACKPRESSURE_BYTES) bytes += JSON.stringify(events[n++]).length;
          const page = events.slice(0, n);
          // Response first, then the reset or the replay, then live (§4).
          send(conn, { id, result: { sub, epoch: engine.epoch, latestSeq, replayed: page.length } });
          if (reset) send(conn, { push: 'reset', sub, reason: reset, latestSeq });
          for (const e of page) send(conn, { push: 'event', sub, event: e });
          if (n < events.length) {
            const lastSeq = page.at(-1)?.seq ?? (params.fromSeq ?? 1) - 1;
            const lagged = () => send(conn, { push: 'lagged', sub, lastSeq });
            if (conn.writableLength > 0) conn.once('drain', lagged); else lagged();
            return undefined;
          }
          subs.set(sub, { conn, filter: params.id, lastSent: page.at(-1)?.seq ?? latestSeq });
          return undefined;
        }
        case 'unsubscribe': {
          const s = subs.get(params.sub);
          if (s?.conn === conn) subs.delete(params.sub);
          return send(conn, { id, result: {} });
        }
        default:
          return send(conn, { id, result: await engine[msg.method](params ?? {}, { principal }) });
      }
    } catch (e) {
      if (e instanceof ApiError) return fail(e.code, e.message, e.details);
      log.error('tasks api internal error', { method: msg.method, code: typeof e?.code === 'string' ? e.code.slice(0, 40) : null });
      return fail('INTERNAL', 'internal error');
    } finally {
      st.inflight -= 1;
    }
  }

  const server = net.createServer((conn) => {
    if (conns.size >= MAX_CONNECTIONS) { conn.destroy(); return; }
    conns.add(conn);
    const st = { hello: false, dead: false, inflight: 0, helloTimer: null };
    st.helloTimer = setTimeout(() => { if (!st.hello) conn.destroy(); }, HELLO_WITHIN_MS);
    st.helloTimer.unref?.();
    conn.hello = st;
    let chunks = [];
    let size = 0;
    const tooLarge = () => {
      send(conn, { id: null, error: { code: 'PAYLOAD_TOO_LARGE', message: 'frame exceeds 1 MiB' } });
      st.dead = true;
      chunks = [];
      conn.end();
    };
    conn.on('data', (buf) => {
      let start = 0;
      while (!st.dead) {
        const nl = buf.indexOf(0x0a, start);
        if (nl < 0) {
          const rest = buf.subarray(start);
          if (size + rest.length > MAX_FRAME_BYTES) return tooLarge();
          if (rest.length) { chunks.push(rest); size += rest.length; }
          return;
        }
        const piece = buf.subarray(start, nl);
        if (size + piece.length > MAX_FRAME_BYTES) return tooLarge();
        const line = (chunks.length ? Buffer.concat([...chunks, piece]) : piece).toString('utf8');
        chunks = [];
        size = 0;
        start = nl + 1;
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch {
          send(conn, { id: null, error: { code: 'VALIDATION', message: 'bad json' } });
          continue;
        }
        onRequest(conn, st, msg).catch(() => {});
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => {
      clearTimeout(st.helloTimer);
      conns.delete(conn);
      for (const [k, s] of subs) if (s.conn === conn) subs.delete(k);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new StartError('SOCKET_IN_USE', 'the socket could not be opened')));
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);

  // The green lease (§6.2): every hello'd client hears about every leased task every hbMs.
  const hb = setInterval(() => {
    const tasks = engine.hbTasks();
    const frame = { push: 'hb', epoch: engine.epoch, uptimeMs: Math.max(0, Date.now() - startedAt), tasks };
    for (const c of conns) if (c.hello?.hello) send(c, frame);
  }, hbMs);
  hb.unref?.();

  return {
    socketPath, tokenPath, token,
    close: () => new Promise((resolve) => {
      clearInterval(hb);
      engine.off('event', onEvent);
      for (const c of conns) { send(c, { push: 'bye', reason: 'shutdown' }); c.destroy(); }
      server.close(() => { try { fs.unlinkSync(socketPath); } catch { /* gone */ } resolve(); });
    }),
  };
}
