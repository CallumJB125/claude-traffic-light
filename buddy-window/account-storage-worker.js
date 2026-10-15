'use strict';

// A credential-only Electron main process. The parent owns account files;
// this child sees only in-memory crypto requests on anonymous stdin/stdout.
// Its disposable Chromium profile never holds an account token.
const MAX_FRAME = 1024 * 1024;
function serve({ input, output, storage, ready = async () => {}, terminate }) {
  let buffer = Buffer.alloc(0), ended = false, inFlight = 0;
  let lastId = 0;
  const stop = () => { if (ended) return; ended = true; buffer = Buffer.alloc(0); terminate(); };
  const send = value => {
    if (ended) return;
    try {
      const line = JSON.stringify(value);
      if (Buffer.byteLength(line) > MAX_FRAME) return stop();
      output.write(line + '\n');
    } catch { stop(); }
  };
  async function request(line) {
    let value;
    try { value = JSON.parse(line); } catch { return stop(); }
    const { id, op, data } = value ?? {};
    if (!Number.isSafeInteger(id) || id <= lastId || inFlight >= 64 || !['encrypt', 'decrypt'].includes(op) || typeof data !== 'string') return stop();
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data || (op === 'decrypt' && !bytes.length)) return stop();
    // Monotonic IDs prevent replay without retaining request bodies or a
    // growing history of IDs after native calls finish.
    lastId = id;
    inFlight++;
    try {
      await ready();
      if (ended) return;
      const result = op === 'encrypt' ? await storage.encryptAsync(bytes.toString('utf8')) : await storage.decryptAsync(bytes);
      if (ended) return;
      send({ id, ok: true, data: (op === 'encrypt' ? result : Buffer.from(result, 'utf8')).toString('base64') });
    } catch { send({ id, ok: false }); }
    finally { inFlight--; }
  }
  input.on('data', chunk => {
    if (ended) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Check before concatenating an untrusted frame into a growing buffer.
    if (bytes.length > MAX_FRAME + 1) return stop();
    buffer = Buffer.concat([buffer, bytes]);
    let newline;
    while ((newline = buffer.indexOf(10)) >= 0) {
      if (newline > MAX_FRAME) return stop();
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      void request(line);
      if (ended) return;
    }
    if (buffer.length > MAX_FRAME) stop();
  });
  input.on('end', stop); input.on('error', stop); output.on('error', stop);
  return { stop };
}
function start() {
  const { app } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  try {
    if (process.platform !== 'darwin' || !app.isPackaged) throw Error();
    // A flag and caller-chosen nonce alone confer no authority. The native
    // guard verifies kernel ancestry, executable/code identity and the running
    // GUI role before this process can ask the OS for any credential.
    for (const fd of [0, 1]) { const stat = fs.fstatSync(fd); if (!stat.isFIFO() && !stat.isSocket()) throw Error(); }
    const guard = path.join(process.resourcesPath, 'account-storage', 'buddy-account-storage-parent');
    const result = execFileSync(guard, [], { timeout: 3000, maxBuffer: 64, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } }); // privacy-flow: team-hub-account
    if (result !== 'approved\n') throw Error();
  } catch { process.kill(process.pid, 'SIGKILL'); return; }
  const { safeStorage } = require('electron');
  const { createSecureStorage } = require('./secure-storage');
  // This entry precedes normal app startup: no hooks, user DBs, updater,
  // single-instance lock, windows, network or account-file access.
  app.dock?.hide();
  serve({ input: process.stdin, output: process.stdout,
    storage: createSecureStorage(safeStorage), ready: () => app.whenReady(),
    // A native authorization can outlive Electron's normal quit. This process
    // owns no persistent work, so pipe closure retires only this child.
    terminate: () => process.kill(process.pid, 'SIGKILL'),
  });
}
module.exports = { serve, start, MAX_FRAME };
