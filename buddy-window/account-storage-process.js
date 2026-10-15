'use strict';

const { spawn: defaultSpawn } = require('node:child_process');

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING = 64;
const WORKER_ARG = '--plexiform-account-storage-worker';
const SAFE_ENV = new Set(['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);

// Credentials cross only the spawned app's anonymous stdin/stdout pipes. A
// separate process can be killed while its native Keychain request is blocked.
function createAccountStorageProcess({ spawn = defaultSpawn, execPath = process.execPath,
  env = process.env, ready = () => true } = {}) {
  let child = null, retiring = null, closed = false, nextId = 1;
  const pending = new Map();
  const restarts = new Set();
  const unavailable = () => new Error('Secure account storage is unavailable.');
  const workerEnv = Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    typeof value === 'string' && (SAFE_ENV.has(key) || /^LC_[A-Z_]+$/.test(key))));

  function kill(c) {
    try { c.kill('SIGKILL'); } catch { /* the exact spawned process may have exited */ }
    try { c.stdin?.destroy?.(); } catch { /* already closed */ }
    try { c.stdout?.destroy?.(); } catch { /* already closed */ }
  }

  function fail(c) {
    if (child !== c) return;
    child = null;
    retiring = c;
    for (const request of pending.values()) request.reject(unavailable());
    pending.clear();
    kill(c);
  }

  function exited(c) {
    if (child === c) fail(c);
    if (retiring === c) {
      retiring = null;
      for (const resolve of restarts) resolve(!closed);
      restarts.clear();
    }
  }

  function receive(c, frame) {
    if (child !== c) return;
    let response;
    try {
      response = JSON.parse(frame.toString('utf8'));
      if (!response || Array.isArray(response) || !Number.isSafeInteger(response.id) || response.id < 1 ||
          typeof response.ok !== 'boolean' || !pending.has(response.id)) throw unavailable();
      const request = pending.get(response.id);
      if (!response.ok) {
        pending.delete(response.id); request.reject(unavailable()); return;
      }
      if (typeof response.data !== 'string') throw unavailable();
      const bytes = Buffer.from(response.data, 'base64');
      if (bytes.toString('base64') !== response.data) throw unavailable();
      let value = bytes;
      if (request.op === 'encrypt') {
        if (!bytes.length) throw unavailable();
      } else {
        value = bytes.toString('utf8');
        if (!Buffer.from(value, 'utf8').equals(bytes)) throw unavailable();
      }
      pending.delete(response.id); request.resolve(value);
    } catch { fail(c); }
  }

  function start() {
    if (child) return child;
    if (retiring) throw unavailable();
    let c;
    try {
      c = spawn(execPath, [WORKER_ARG], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
        env: { ...workerEnv } }); // privacy-flow: team-hub-account
      if (!c || typeof c.on !== 'function') throw unavailable();
      child = c;
      c.on('error', () => fail(c));
      c.on('exit', () => exited(c));
      c.on('close', () => exited(c));
      if (!c.stdin || !c.stdout || typeof c.stdin.write !== 'function' ||
          typeof c.stdout.on !== 'function') throw unavailable();
      let buffered = Buffer.alloc(0);
      c.stdout.on('data', chunk => {
        if (child !== c) return;
        try {
          if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') throw unavailable();
          // An OS pipe chunk is normally much smaller. Reject oversized input
          // before copying/concatenating it, and check each fragment before it
          // can extend the retained partial frame beyond the same bound.
          const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
          if (size > MAX_FRAME_BYTES + 1) throw unavailable();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          for (let offset = 0; offset < bytes.length;) {
            const newline = bytes.indexOf(0x0a, offset);
            const end = newline < 0 ? bytes.length : newline;
            if (end - offset > MAX_FRAME_BYTES - buffered.length) throw unavailable();
            const fragment = bytes.subarray(offset, end);
            const frame = buffered.length ? Buffer.concat([buffered, fragment]) : fragment;
            if (newline < 0) { buffered = Buffer.from(frame); break; }
            buffered = Buffer.alloc(0);
            receive(c, frame);
            if (child !== c) return;
            offset = newline + 1;
          }
        } catch { fail(c); }
      });
      c.stdout.on('end', () => fail(c));
      c.stdout.on('close', () => fail(c));
      c.stdout.on('error', () => fail(c));
      c.stdin.on('error', () => fail(c));
      c.stdin.on('close', () => fail(c));
      c.stdin.on('finish', () => fail(c));
      return c;
    } catch {
      if (c) {
        if (child === c) fail(c);
        else if (retiring !== c) { retiring = c; kill(c); }
      }
      throw unavailable();
    }
  }

  function request(op, bytes) {
    try {
      if (closed || retiring || ready() !== true || pending.size >= MAX_PENDING) throw unavailable();
      const id = nextId++;
      const frame = Buffer.from(`${JSON.stringify({ id, op, data: bytes.toString('base64') })}\n`);
      if (frame.length - 1 > MAX_FRAME_BYTES) throw unavailable();
      const c = start();
      return new Promise((resolve, reject) => {
        pending.set(id, { op, resolve, reject });
        try { c.stdin.write(frame, error => { if (error) fail(c); }); }
        catch { fail(c); }
      });
    } catch { return Promise.reject(unavailable()); }
  }

  return {
    encryptAsync(text) {
      if (typeof text !== 'string') return Promise.reject(unavailable());
      return request('encrypt', Buffer.from(text, 'utf8'));
    },
    decryptAsync(bytes) {
      if (!Buffer.isBuffer(bytes) || !bytes.length) return Promise.reject(unavailable());
      return request('decrypt', bytes);
    },
    // Only an explicit user retry resets a process whose native async provider
    // cached an earlier denial. It never starts replacement work by itself.
    restart() {
      if (closed) return Promise.resolve(false);
      if (!child && !retiring) return Promise.resolve(true);
      return new Promise(resolve => {
        restarts.add(resolve);
        if (child) fail(child);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const resolve of restarts) resolve(false);
      restarts.clear();
      if (child) fail(child);
    },
    pendingCount: () => pending.size,
  };
}

module.exports = { createAccountStorageProcess };
