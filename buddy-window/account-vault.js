'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// load() is deliberately cache-only. Native password-store authorization may
// wait indefinitely; it must never sit on Electron's window/event-loop thread.
function createAccountVault({ origin, file, storage, ready = () => true, whenReady = async () => {}, onChange = () => {}, io = fs }) {
  let cache = null, phase = 'unread', generation = 0, pending = null, closed = false;
  const cancelled = () => new Error('Account storage operation was cancelled.');
  const unavailable = () => new Error('Secure account storage is unavailable.');
  const notify = reason => { queueMicrotask(() => { if (!closed) { try { onChange({ reason, state: phase }); } catch { /* UI cannot break credential storage */ } } }); };
  const valid = value => value && typeof value === 'object' && !Array.isArray(value) && value.hub === origin && typeof value.token === 'string' && value.token.length > 0;
  function restore() {
    if (closed) return Promise.resolve(null);
    if (pending) return pending;
    const ticket = generation;
    phase = 'restoring'; notify('restoring');
    const current = () => !closed && generation === ticket;
    const operation = Promise.resolve().then(async () => {
      if (!ready()) await whenReady();
      if (!current()) return null;
      // A missing file does not need to authorize the OS password store.
      if (!io.existsSync(file)) { phase = 'empty'; notify('empty'); return null; }
      try {
        const value = JSON.parse(await storage.decryptAsync(io.readFileSync(file)));
        if (!current()) return null;
        if (!valid(value)) throw unavailable();
        cache = value; phase = 'ready'; notify('restored'); return cache;
      } catch {
        if (current()) { phase = 'locked'; notify('locked'); }
        // Preserve the ciphertext. Only an explicit retry starts another read.
        return null;
      }
    }).catch(() => {
      if (current()) { phase = 'locked'; notify('locked'); }
      return null;
    }).finally(() => { if (pending === operation) pending = null; });
    pending = operation;
    return operation;
  }
  return {
    load() { if (!closed && phase === 'unread') void restore(); return closed ? null : cache; },
    state: () => phase,
    retry() { return phase === 'locked' || phase === 'unread' || phase === 'restoring' ? restore() : Promise.resolve(closed ? null : cache); },
    async save(value, { keep = () => true } = {}) {
      const kept = () => { try { return keep() === true; } catch { return false; } };
      if (closed || !kept()) throw cancelled();
      if (!valid(value)) throw unavailable();
      const ticket = ++generation;
      phase = 'saving'; notify('saving');
      const current = () => !closed && ticket === generation && kept();
      let tmp;
      try {
        if (!ready()) await whenReady();
        if (!current()) throw cancelled();
        const bytes = await storage.encryptAsync(JSON.stringify(value));
        if (!current()) throw cancelled();
        if (!Buffer.isBuffer(bytes) || !bytes.length) throw unavailable();
        io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
        io.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
        // Check after the private write and immediately before publication.
        if (!current()) throw cancelled();
        io.renameSync(tmp, file); tmp = null;
        cache = value; phase = 'ready'; notify('saved');
      } catch {
        if (!closed && ticket === generation) { phase = cache ? 'ready' : 'locked'; notify('locked'); }
        if (!current()) throw cancelled();
        throw unavailable();
      } finally {
        if (tmp) { try { io.rmSync(tmp, { force: true }); } catch { /* preserve primary safe error */ } }
      }
    },
    clear() {
      generation++; cache = null; phase = 'empty';
      io.rmSync(file, { force: true }); notify('cleared');
    },
    // Closing never joins a native authorization promise.
    close() { closed = true; generation++; cache = null; phase = 'closed'; },
  };
}
module.exports = { createAccountVault };
