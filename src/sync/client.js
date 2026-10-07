// Encrypted sync client (W3-C): talks only to the signed-in team hub's
// /api/sync routes, with this computer's own sign-in. Everything it uploads is
// sealed on this computer first (keys.js); the hub stores ciphertext, opaque
// key wraps and sizes. Keys, the recovery code and plaintext never leave.
//
// Local state lives in a store ({load(name), save(name, value)}; index.js
// gives a 0600-file one): 'device' (this computer's key-agreement key pair),
// 'keyring' (the content keys), 'log' (the doc set, pending ops, read cursor).
'use strict';

const crypto = require('crypto');
const Keys = require('./keys');
const { createLog } = require('./log');

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE = 2 * 1024 * 1024;

class SyncError extends Error {
  constructor(code, message = code, extra = {}) { super(message); this.name = 'SyncError'; this.code = code; this.extra = extra; }
}

function baseOf(origin) {
  try {
    const u = new URL(origin);
    const loop = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) return null;
    return u.origin;
  } catch { return null; }
}

/** An in-memory store (tests). */
function memoryStore() {
  const m = new Map();
  return { load: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), save: (k, v) => { m.set(k, JSON.stringify(v)); }, dump: () => new Map(m) };
}

/**
 * identity() → {origin, userId, token: () => string} | null (the signed-in team hub).
 * fetch: the network function (tests inject one bound to an in-process hub).
 */
function createSyncClient({ identity, fetch, store, deviceName = 'Computer', allowTranscripts = false }) {
  const current = () => {
    let id = null;
    try { id = identity(); } catch { id = null; }
    const base = id && typeof id.userId === 'string' && id.userId && typeof id.token === 'function' ? baseOf(id.origin) : null;
    if (!base) throw new SyncError('signed-out', 'sign in to your team hub first');
    return { ...id, base };
  };

  async function call(method, route, body) {
    const id = current();
    let token = '';
    try { token = id.token() || ''; } catch { token = ''; }
    if (!token) throw new SyncError('signed-out', 'sign in to your team hub first');
    let res;
    try {
      res = await fetch(`${id.base}${route}`, { // privacy-flow: sync
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { throw new SyncError('offline', "couldn't reach your team hub"); }
    let text = '';
    try { text = await res.text(); } catch { throw new SyncError('offline', "couldn't reach your team hub"); }
    if (text.length > MAX_RESPONSE) throw new SyncError('unreadable', 'the hub answered with too much data');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const { code, message, ...extra } = json?.error ?? {};
      throw new SyncError(res.status === 401 ? 'signed-out' : code ?? 'refused', message ?? `the hub refused (${res.status})`, { status: res.status, ...extra });
    }
    return json;
  }

  function device() {
    let d = store.load('device');
    if (!d?.priv || !d?.pub) { d = Keys.createDeviceKey(); store.save('device', d); }
    return d;
  }

  const ring = () => store.load('keyring');
  const saveRing = (r) => store.save('keyring', r);

  function logOf(deviceId) {
    const saved = store.load('log') ?? {};
    const lg = createLog({ deviceId, state: saved.state ?? null, allowTranscripts });
    return { lg, cursor: saved.cursor ?? 0, save: (cursor = saved.cursor ?? 0, extra = {}) => { saved.cursor = cursor; Object.assign(saved, extra); store.save('log', { ...saved, state: lg.state(), cursor }); } };
  }

  const state = () => call('GET', '/api/sync/state');

  /** Adopt a newer keyring wrapped to this device, if the hub has one. → the local keyring or null. */
  function adopt(st) {
    const uid = current().userId;
    let local = ring();
    if (local && local.uid !== uid) local = null; // another account signed in here: never mix keyrings
    if (st.your_wrap && (!local || Keys.wrapRev(st.your_wrap) > local.rev)) {
      const got = Keys.unwrapKeyring(st.your_wrap, device().priv, { uid, to: st.device_id });
      local = Keys.mergeKeyring(local, got);
      saveRing(local);
    }
    return local;
  }

  async function refreshKeys() {
    const st = await state();
    if (st.revoked) throw new SyncError('revoked', 'this computer was removed from sync');
    return { st, ring: st.registered ? adopt(st) : ring() };
  }

  /** The current keyring, verified to be the hub's latest revision (a change must build on it). */
  async function latest() {
    const { st, ring: r } = await refreshKeys();
    if (!r) throw new SyncError('no-key', 'this computer has no sync key yet');
    if (r.rev !== st.keyring_rev || r.current !== st.epoch) throw new SyncError('stale-keyring', 'another computer changed the keys: try again in a moment');
    return { st, ring: r };
  }

  async function register(st) {
    if (st.revoked) throw new SyncError('revoked', 'this computer was removed from sync');
    if (!st.registered) {
      await call('POST', '/api/sync/devices', { agree_pub: device().pub, name: String(deviceName).slice(0, 80) });
      return state();
    }
    return st;
  }

  return {
    state,

    /** This computer's key fingerprint, for comparing on the approving computer. */
    fingerprint: () => Keys.fingerprint(device().pub),

    /**
     * Turn sync on here. First computer: makes the keyring and returns
     * {ok, recoveryCode} (show it once). Later computers: {ok} if already
     * approved, else {ok:false, waiting:'approval', fingerprint}.
     */
    async enable() {
      const uid = current().userId;
      const st = await register(await state());
      if (!st.initialized) {
        const code = Keys.newRecoveryCode();
        const rk = Keys.recoveryKey(code, uid);
        const r = Keys.newKeyring({ uid, deviceId: st.device_id, devicePub: device().pub, recoveryPub: rk.pub });
        const w = Keys.wrapAll(r);
        await call('POST', '/api/sync/init', { wrap: w.wraps[st.device_id], recovery_wrap: w.recovery_wrap });
        saveRing(r);
        return { ok: true, recoveryCode: code };
      }
      if (adopt(st)) return { ok: true };
      return { ok: false, waiting: 'approval', fingerprint: Keys.fingerprint(device().pub) };
    },

    /** Restore on a new computer with the recovery code; this computer joins the keyring. */
    async recover(code) {
      const uid = current().userId;
      let st = await register(await state());
      if (!st.initialized || !st.recovery_wrap) throw new SyncError('not-initialized', 'sync was never set up for this account');
      let rk;
      let restored;
      try {
        rk = Keys.recoveryKey(code, uid);
        restored = Keys.unwrapKeyring(st.recovery_wrap, rk.priv, { uid, to: 'recovery' });
      } catch { throw new SyncError('bad-code', "that recovery code doesn't open this account's sync"); }
      const local = ring()?.uid === uid ? ring() : null;
      const merged = Keys.mergeKeyring(local, restored);
      if (merged.rev !== st.keyring_rev) { st = await state(); throw new SyncError('stale-keyring', 'another computer changed the keys: try again in a moment'); }
      const next = Keys.addDevice(merged, st.device_id, device().pub);
      const w = Keys.wrapAll(next);
      await call('PUT', '/api/sync/wraps', { epoch: next.current, keyring_rev: next.rev, wraps: w.wraps, recovery_wrap: w.recovery_wrap });
      saveRing(next);
      return { ok: true };
    },

    /** Approve another computer of this account (after comparing its fingerprint). */
    async approve(deviceId) {
      const { st, ring: r } = await latest();
      const d = st.devices.find((x) => x.device_id === deviceId && !x.revoked);
      if (!d) throw new SyncError('not-found', 'no such computer in your sync set');
      const next = Keys.addDevice(r, deviceId, d.agree_pub);
      const w = Keys.wrapAll(next);
      await call('PUT', '/api/sync/wraps', { epoch: next.current, keyring_rev: next.rev, wraps: w.wraps, recovery_wrap: w.recovery_wrap });
      saveRing(next);
      return { ok: true };
    },

    /** Remove a computer and rotate the content key: it can never read anything synced after this. */
    async revoke(deviceId) {
      const { ring: r } = await latest();
      const next = Keys.rotate(r, { revoke: deviceId });
      const w = Keys.wrapAll(next);
      await call('POST', `/api/sync/devices/${encodeURIComponent(deviceId)}/revoke`, { epoch: next.current, keyring_rev: next.rev, wraps: w.wraps, recovery_wrap: w.recovery_wrap });
      saveRing(next);
      return { ok: true, epoch: next.current };
    },

    /** Replace the recovery code (the old one stops working). → {ok, recoveryCode} */
    async newRecoveryCode() {
      const { ring: r } = await latest();
      const code = Keys.newRecoveryCode();
      const next = Keys.setRecovery(r, Keys.recoveryKey(code, r.uid).pub);
      const w = Keys.wrapAll(next);
      await call('PUT', '/api/sync/wraps', { epoch: next.current, keyring_rev: next.rev, wraps: w.wraps, recovery_wrap: w.recovery_wrap });
      saveRing(next);
      return { ok: true, recoveryCode: code };
    },

    /** Local docs: collect(lg) puts this computer's current docs into the log before a push. */
    log(deviceId) { return logOf(deviceId); },

    /** Download and merge every blob after the local cursor. → {applied, cursor} */
    async pull() {
      const { st, ring: r } = await refreshKeys();
      if (!r) throw new SyncError('no-key', 'this computer has no sync key yet');
      const uid = current().userId;
      const { lg, cursor: start, save } = logOf(st.device_id);
      let cursor = start;
      let applied = 0;
      for (;;) {
        const page = await call('GET', `/api/sync/blobs?after=${cursor}&limit=100`);
        for (const b of page.blobs) {
          const got = await call('GET', `/api/sync/blobs/${b.id}`);
          const bytes = Buffer.from(got.data, 'base64url');
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== b.sha256) throw new SyncError('corrupt', 'a synced blob failed its hash check');
          let plain;
          try { plain = JSON.parse(Keys.openBlob(r, { uid, deviceId: b.device_id }, bytes).toString('utf8')); } catch (e) {
            save(cursor);
            throw new SyncError(e?.code === 'no-key' ? 'no-key' : 'decrypt', e?.code === 'no-key' ? 'this computer lacks the key for newer data' : 'a synced blob could not be opened');
          }
          applied += lg.merge(plain?.ops);
          cursor = b.id;
        }
        save(cursor);
        if (!page.more || !page.blobs.length) break;
      }
      if (cursor > 0) await call('PUT', '/api/sync/cursor', { cursor }).catch(() => {});
      return { applied, cursor };
    },

    /** Seal and upload pending ops. → {uploaded, bytes} */
    async push() {
      let { st, ring: r } = await refreshKeys();
      if (!r) throw new SyncError('no-key', 'this computer has no sync key yet');
      const uid = current().userId;
      const { lg, cursor, save } = logOf(st.device_id);
      let uploaded = 0;
      let bytes = 0;
      for (const batch of lg.batches()) {
        for (let attempt = 0; ; attempt++) {
          const sealed = Keys.sealBlob(r, { uid, deviceId: st.device_id }, Buffer.from(JSON.stringify({ v: 1, ops: batch }), 'utf8'));
          const sha256 = crypto.createHash('sha256').update(sealed.bytes).digest('hex');
          try {
            const ticket = await call('POST', '/api/sync/uploads', { size: sealed.bytes.length, sha256, epoch: sealed.epoch });
            await call('PUT', '/api/sync/blobs', { ...ticket, data: sealed.bytes.toString('base64url') });
            uploaded++; bytes += sealed.bytes.length;
            break;
          } catch (e) {
            // The key rotated under us: take the new keyring and seal again, once.
            if (attempt === 0 && e.code === 'CONFLICT' && e.extra?.reason === 'stale_epoch') { ({ st, ring: r } = await refreshKeys()); if (r) continue; }
            save(cursor);
            throw e;
          }
        }
        lg.sent(batch);
        save(cursor);
      }
      return { uploaded, bytes };
    },

    /** One round: refresh keys, put local docs, pull, push. Read-only (lapsed) still pulls. */
    async syncNow({ collect = null } = {}) {
      const st = await state();
      if (!st.registered || st.revoked) throw new SyncError(st.revoked ? 'revoked' : 'not-registered', 'turn sync on here first');
      const { lg, cursor, save } = logOf(st.device_id);
      if (collect && st.mode === 'active') { await collect(lg); save(cursor); }
      const pulled = await this.pull();
      let pushed = { uploaded: 0, bytes: 0 };
      if (st.mode === 'active') pushed = await this.push();
      const at = Date.now();
      const saved = store.load('log') ?? {};
      store.save('log', { ...saved, lastSync: at });
      return { mode: st.mode, pulled, pushed, at };
    },

    /** Local view for the Sync page (no network). */
    local() {
      const saved = store.load('log') ?? {};
      const r = ring();
      return { hasKeys: !!r, epoch: r?.current ?? null, cursor: saved.cursor ?? 0, lastSync: saved.lastSync ?? null, pending: saved.state?.pending?.length ?? 0, docs: Object.values(saved.state?.docs ?? {}).filter((d) => !d.x).length, fingerprint: Keys.fingerprint(device().pub) };
    },
  };
}

module.exports = { createSyncClient, memoryStore, SyncError, baseOf };
