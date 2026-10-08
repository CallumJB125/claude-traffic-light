// Encrypted sync across one person's own devices (W3-C; client: src/sync/).
//
// The hub routes and stores ciphertext only. Devices hold the keys: a keyring
// sealed ("wrapped") to each device's public key and to the recovery key,
// which the hub keeps as opaque strings. What the hub sees: which devices a
// user has, their public keys and names, blob sizes, hashes, times, the key
// generation (epoch) each blob claims, and per-device read cursors.
//
// Upload: the device asks for a hub-signed blob path (POST /api/sync/uploads
// with size, sha256 and epoch; quota and plan are checked), then sends the
// ciphertext with that ticket (PUT /api/sync/blobs). The hub checks the
// ticket, size and hash, writes the object store, then records the blob row
// and its bytes against the user's quota in one transaction.
//
// Plans: sync needs a live Plus or Team entitlement (billing/entitlements.js):
// 3 devices and 5 GiB of ciphertext per user (src/entitlements.js LIMITS;
// a test pins them equal). When the plan lapses, sync is read-only for 30
// days (download, revoke and cursor moves still work), with an email notice;
// then every object and row is deleted, with a second notice. Renewing within
// the 30 days restores it. Deleting the account purges at the next sweep.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HubError } from './db.js';
import { storeFrom } from './sync-store.js';
import { BRAND } from '../shared/brand.js';

const GiB = 1024 ** 3;
const DAY_MS = 86_400_000;
export const SYNC_PLANS = Object.freeze({
  plus: Object.freeze({ devices: 3, bytes: 5 * GiB }),
  team: Object.freeze({ devices: 3, bytes: 5 * GiB }), // per seat: each member has their own
});
export const READ_ONLY_DAYS = 30;
export const SYNC_LIMITS = Object.freeze({ blobMax: 512 * 1024, ticketMs: 10 * 60_000, listMax: 200, nameMax: 80, wrapMax: 8192 });

const B64 = /^[A-Za-z0-9_-]+$/;
const PUB = /^[A-Za-z0-9_-]{87}$/; // an uncompressed P-256 point (65 bytes)
const WRAP = /^w1\.([1-9]\d{0,8})\.[A-Za-z0-9_-]{87}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const wrapRev = (w) => Number(WRAP.exec(w)?.[1] ?? NaN);

function checkWrap(w, rev, what) {
  if (typeof w !== 'string' || w.length > SYNC_LIMITS.wrapMax || !WRAP.test(w)) throw new HubError('VALIDATION', `${what} is not a key wrap`);
  if (wrapRev(w) !== rev) throw new HubError('VALIDATION', `${what} is for another keyring revision`);
}

export class Sync {
  constructor(hub, { store } = {}) {
    this.hub = hub;
    this.db = hub.db;
    const c = hub.config;
    this.store = store !== undefined ? store : storeFrom(c.syncStore ?? (c.syncR2Bucket
      ? { kind: 'r2', endpoint: c.syncR2Endpoint, bucket: c.syncR2Bucket, accessKeyId: c.syncR2AccessKeyId, secretAccessKey: c.syncR2SecretAccessKey } : null));
    this.ticketKey = createHmac('sha256', hub.secret ?? randomBytes(32)).update('plexiform.sync.ticket.v1').digest();
  }

  get enabled() { return !!this.store; }
  now() { return this.hub.wallMs(); }

  requireEnabled() { if (!this.store) throw new HubError('METHOD_DISABLED', 'sync is not set up on this hub'); }

  /** The sync limits of a user's live plan, or null. */
  plan(userId) {
    const row = this.hub.billing?.effective(userId);
    return row ? SYNC_PLANS[row.plan] ?? null : null;
  }

  account(userId) { return this.db.get('SELECT * FROM sync_accounts WHERE user_id = ?', userId); }

  ensureAccount(userId) {
    if (!this.account(userId)) {
      const now = this.hub.iso();
      this.db.insert('sync_accounts', { user_id: userId, created_at: now, updated_at: now });
    }
    return this.account(userId);
  }

  /**
   * 'active' (plan live), 'read_only' (lapsed, within 30 days), 'gone'
   * (lapsed longer, or purge due) or 'none' (no plan, never used). Notes a
   * lapse (or a renewal) on the account row as a side effect.
   */
  mode(userId) {
    const acc = this.account(userId);
    const plan = this.plan(userId);
    if (acc?.purge_at) return { mode: 'gone', acc, plan };
    if (plan) {
      if (acc?.lapsed_at) this.db.run('UPDATE sync_accounts SET lapsed_at = NULL, lapse_notice_at = NULL, updated_at = ? WHERE user_id = ?', this.hub.iso(), userId);
      return { mode: 'active', acc: this.account(userId), plan };
    }
    if (!acc) return { mode: 'none', acc: null, plan: null };
    let lapsed = acc.lapsed_at;
    if (!lapsed) {
      lapsed = this.hub.iso();
      this.db.run('UPDATE sync_accounts SET lapsed_at = ?, updated_at = ? WHERE user_id = ?', lapsed, lapsed, userId);
    }
    const until = Date.parse(lapsed) + READ_ONLY_DAYS * DAY_MS;
    return { mode: this.now() < until ? 'read_only' : 'gone', acc: this.account(userId), plan: null, until };
  }

  /** The caller's own sync device row. Sync is for the desktop app's device sign-in only. */
  me(ident) {
    if (ident?.cred?.kind !== 'device' || ident.cred.scope) throw new HubError('FORBIDDEN', "sync needs this computer's own Plexiform sign-in");
    return this.db.get('SELECT * FROM sync_devices WHERE user_id = ? AND device_id = ?', ident.user.id, ident.cred.id);
  }

  /** A registered, unrevoked device of the caller, and the account's mode. */
  caller(ident, { modes = ['active'], needKeys = false } = {}) {
    this.requireEnabled();
    const dev = this.me(ident);
    const m = this.mode(ident.user.id);
    if (!dev) throw new HubError('FORBIDDEN', 'this device is not in your sync set: turn sync on here first', { reason: 'not_registered' });
    if (dev.revoked_at) throw new HubError('FORBIDDEN', 'this device was removed from sync', { reason: 'revoked' });
    if (!modes.includes(m.mode)) {
      if (m.mode === 'read_only') throw new HubError('PLAN_REQUIRED', 'your plan has ended: sync is read-only until you renew', { feature: 'sync', plan: 'plus', mode: 'read_only' });
      throw new HubError('PLAN_REQUIRED', 'sync needs the Plus or Team plan', { feature: 'sync', plan: 'plus', mode: m.mode });
    }
    if (needKeys && !dev.wrap) throw new HubError('FORBIDDEN', 'this device has no sync key yet: approve it on another device or use your recovery code', { reason: 'no_key' });
    return { dev, ...m };
  }

  // ── devices and keys ──

  /** GET /api/sync/state */
  state(ident) {
    this.requireEnabled();
    const me = this.me(ident);
    const uid = ident.user.id;
    const m = this.mode(uid);
    const limits = m.plan ?? SYNC_PLANS.plus;
    const base = { mode: m.mode, read_only_until: m.until ? new Date(m.until).toISOString() : null, device_id: ident.cred.id,
      limits: { bytes: limits.bytes, devices: limits.devices, blob: SYNC_LIMITS.blobMax }, registered: !!me, revoked: !!me?.revoked_at };
    if (me?.revoked_at || m.mode === 'none' || m.mode === 'gone') return { ...base, initialized: false, devices: [] };
    const acc = m.acc;
    const devices = this.db.all('SELECT * FROM sync_devices WHERE user_id = ? ORDER BY created_at, device_id', uid).map((d) => ({
      device_id: d.device_id, name: d.name, agree_pub: d.agree_pub, has_key: !!d.wrap, wrap_rev: d.wrap_rev, cursor: d.cursor,
      last_sync_at: d.last_sync_at, revoked: !!d.revoked_at, current: d.device_id === ident.cred.id, created_at: d.created_at,
    }));
    const head = this.db.get('SELECT COALESCE(MAX(id), 0) AS id FROM sync_blobs WHERE user_id = ?', uid).id;
    return {
      ...base, initialized: (acc?.epoch ?? 0) > 0, epoch: acc?.epoch ?? 0, keyring_rev: acc?.keyring_rev ?? 0, bytes_used: acc?.bytes_used ?? 0, head,
      your_wrap: me ? me.wrap : null, recovery_wrap: acc?.recovery_wrap ?? null, devices,
    };
  }

  /** POST /api/sync/devices {agree_pub, name}: add this device to the caller's sync set. */
  registerDevice(ident, body) {
    this.requireEnabled();
    const uid = ident.user.id;
    const me = this.me(ident);
    const pub = body.agree_pub;
    const name = typeof body.name === 'string' ? body.name.slice(0, SYNC_LIMITS.nameMax) : '';
    if (typeof pub !== 'string' || !PUB.test(pub)) throw new HubError('VALIDATION', 'agree_pub must be an uncompressed P-256 public key (base64url)');
    const m = this.mode(uid);
    if (m.mode !== 'active') throw new HubError('PLAN_REQUIRED', 'sync needs the Plus or Team plan', { feature: 'sync', plan: 'plus', mode: m.mode });
    return this.db.tx(() => {
      if (me) {
        if (me.revoked_at) throw new HubError('FORBIDDEN', 'this device was removed from sync: sign in again to add it as a new device', { reason: 'revoked' });
        if (me.agree_pub === pub) return { device_id: me.device_id, registered: true };
        if (me.wrap) throw new HubError('CONFLICT', 'this device already has a sync key');
        this.db.run('UPDATE sync_devices SET agree_pub = ?, name = ? WHERE user_id = ? AND device_id = ?', pub, name, uid, me.device_id);
        return { device_id: me.device_id, registered: true };
      }
      const live = this.db.get('SELECT COUNT(*) AS n FROM sync_devices WHERE user_id = ? AND revoked_at IS NULL', uid).n;
      if (live >= m.plan.devices) throw new HubError('QUOTA_EXCEEDED', `your plan syncs up to ${m.plan.devices} devices: remove one first`, { resource: 'sync.devices', limit: m.plan.devices });
      this.ensureAccount(uid);
      this.db.insert('sync_devices', { user_id: uid, device_id: ident.cred.id, name, agree_pub: pub, created_at: this.hub.iso() });
      return { device_id: ident.cred.id, registered: true };
    });
  }

  /** POST /api/sync/init {wrap, recovery_wrap}: the first device creates the keyring (epoch 1, rev 1). */
  init(ident, body) {
    const { dev, acc } = this.caller(ident);
    checkWrap(body.wrap, 1, 'wrap');
    checkWrap(body.recovery_wrap, 1, 'recovery_wrap');
    return this.db.tx(() => {
      const cur = this.account(ident.user.id);
      if (cur.epoch > 0) throw new HubError('CONFLICT', 'sync is already set up for this account: approve this device on another one, or use your recovery code', { reason: 'initialized' });
      const now = this.hub.iso();
      this.db.run('UPDATE sync_accounts SET epoch = 1, keyring_rev = 1, recovery_wrap = ?, updated_at = ? WHERE user_id = ?', body.recovery_wrap, now, acc.user_id);
      this.db.run('UPDATE sync_devices SET wrap = ?, wrap_rev = 1 WHERE user_id = ? AND device_id = ?', body.wrap, acc.user_id, dev.device_id);
      return { epoch: 1, keyring_rev: 1 };
    });
  }

  checkWraps(uid, wraps, rev, { exclude = null } = {}) {
    if (!wraps || typeof wraps !== 'object' || Array.isArray(wraps)) throw new HubError('VALIDATION', 'wraps must be an object of device id → wrap');
    const known = new Map(this.db.all('SELECT device_id, revoked_at FROM sync_devices WHERE user_id = ?', uid).map((d) => [d.device_id, d]));
    const ids = Object.keys(wraps);
    if (ids.length > 32) throw new HubError('VALIDATION', 'too many wraps');
    for (const id of ids) {
      const d = known.get(id);
      if (!d || d.revoked_at || id === exclude) throw new HubError('VALIDATION', 'a wrap names a device that is not in your sync set');
      checkWrap(wraps[id], rev, 'wrap');
    }
    return ids;
  }

  /** PUT /api/sync/wraps {epoch, keyring_rev, wraps, recovery_wrap?}: a new keyring revision (approve a device, rejoin after recovery, new recovery code). */
  putWraps(ident, body) {
    const { acc } = this.caller(ident);
    const uid = ident.user.id;
    if (body.epoch !== acc.epoch || acc.epoch < 1) throw new HubError('CONFLICT', 'the content key changed: refresh and try again', { reason: 'stale_epoch', epoch: acc.epoch });
    if (body.keyring_rev !== acc.keyring_rev + 1) throw new HubError('CONFLICT', 'the keyring changed: refresh and try again', { reason: 'stale_rev', keyring_rev: acc.keyring_rev });
    const rev = body.keyring_rev;
    const ids = this.checkWraps(uid, body.wraps, rev);
    if (body.recovery_wrap !== undefined) checkWrap(body.recovery_wrap, rev, 'recovery_wrap');
    return this.db.tx(() => {
      const cur = this.account(uid);
      if (cur.keyring_rev !== acc.keyring_rev || cur.epoch !== acc.epoch) throw new HubError('CONFLICT', 'the keyring changed: refresh and try again', { reason: 'stale_rev', keyring_rev: cur.keyring_rev });
      for (const id of ids) this.db.run('UPDATE sync_devices SET wrap = ?, wrap_rev = ? WHERE user_id = ? AND device_id = ?', body.wraps[id], rev, uid, id);
      this.db.run('UPDATE sync_accounts SET keyring_rev = ?, recovery_wrap = COALESCE(?, recovery_wrap), updated_at = ? WHERE user_id = ?', rev, body.recovery_wrap ?? null, this.hub.iso(), uid);
      return { epoch: cur.epoch, keyring_rev: rev };
    });
  }

  /**
   * POST /api/sync/devices/:device_id/revoke {epoch, keyring_rev, wraps, recovery_wrap}:
   * remove a device and rotate: the caller sends the keyring with a new
   * content key, wrapped to every remaining device and the recovery key.
   * Allowed while read-only too (removing a lost laptop must always work).
   */
  revoke(ident, deviceId, body) {
    const { acc, dev } = this.caller(ident, { modes: ['active', 'read_only'], needKeys: true });
    const uid = ident.user.id;
    const target = this.db.get('SELECT * FROM sync_devices WHERE user_id = ? AND device_id = ?', uid, deviceId);
    if (!target) throw new HubError('NOT_FOUND', 'no such device');
    if (target.device_id === dev.device_id) throw new HubError('VALIDATION', 'remove this device from another one');
    if (target.revoked_at) throw new HubError('CONFLICT', 'that device was already removed');
    if (body.epoch !== acc.epoch + 1) throw new HubError('CONFLICT', 'the content key changed: refresh and try again', { reason: 'stale_epoch', epoch: acc.epoch });
    if (body.keyring_rev !== acc.keyring_rev + 1) throw new HubError('CONFLICT', 'the keyring changed: refresh and try again', { reason: 'stale_rev', keyring_rev: acc.keyring_rev });
    const rev = body.keyring_rev;
    const ids = this.checkWraps(uid, body.wraps, rev, { exclude: deviceId });
    if (!ids.includes(dev.device_id)) throw new HubError('VALIDATION', 'include a wrap for this device');
    checkWrap(body.recovery_wrap, rev, 'recovery_wrap');
    return this.db.tx(() => {
      const cur = this.account(uid);
      if (cur.keyring_rev !== acc.keyring_rev || cur.epoch !== acc.epoch) throw new HubError('CONFLICT', 'the keyring changed: refresh and try again', { reason: 'stale_rev', keyring_rev: cur.keyring_rev });
      const now = this.hub.iso();
      this.db.run('UPDATE sync_devices SET revoked_at = ?, wrap = NULL, wrap_rev = NULL WHERE user_id = ? AND device_id = ?', now, uid, deviceId);
      // Remaining devices get the new keyring; one left out has no key until it is approved again.
      for (const d of this.db.all('SELECT device_id FROM sync_devices WHERE user_id = ? AND revoked_at IS NULL', uid)) {
        const w = body.wraps[d.device_id] ?? null;
        this.db.run('UPDATE sync_devices SET wrap = ?, wrap_rev = ? WHERE user_id = ? AND device_id = ?', w, w ? rev : null, uid, d.device_id);
      }
      this.db.run('UPDATE sync_accounts SET epoch = ?, keyring_rev = ?, recovery_wrap = ?, updated_at = ? WHERE user_id = ?', body.epoch, rev, body.recovery_wrap, now, uid);
      return { epoch: body.epoch, keyring_rev: rev, revoked: deviceId };
    });
  }

  // ── the op log ──

  ticketSig(t) {
    return createHmac('sha256', this.ticketKey).update([t.user, t.device, t.path, t.size, t.sha256, t.epoch, t.expires].join('\n')).digest('base64url');
  }

  /** POST /api/sync/uploads {size, sha256, epoch} → a hub-signed blob path, valid 10 minutes. */
  uploadTicket(ident, body) {
    const { acc, plan, dev } = this.caller(ident, { needKeys: true });
    if (!int(body.size, 1, SYNC_LIMITS.blobMax)) throw new HubError('VALIDATION', `size must be 1 to ${SYNC_LIMITS.blobMax} bytes`);
    if (typeof body.sha256 !== 'string' || !HEX64.test(body.sha256)) throw new HubError('VALIDATION', 'sha256 must be 64 lowercase hex characters');
    if (body.epoch !== acc.epoch) throw new HubError('CONFLICT', 'the content key changed: refresh your keys', { reason: 'stale_epoch', epoch: acc.epoch });
    if (acc.bytes_used + body.size > plan.bytes) throw new HubError('QUOTA_EXCEEDED', 'your sync storage is full', { resource: 'sync.bytes', limit: plan.bytes, used: acc.bytes_used });
    const t = { user: ident.user.id, device: dev.device_id, path: `sync/${ident.user.id}/${dev.device_id}/${randomUUID()}`, size: body.size, sha256: body.sha256, epoch: body.epoch, expires: this.now() + SYNC_LIMITS.ticketMs };
    return { path: t.path, size: t.size, sha256: t.sha256, epoch: t.epoch, expires: t.expires, sig: this.ticketSig(t) };
  }

  /** PUT /api/sync/blobs {path, size, sha256, epoch, expires, sig, data}: store the ciphertext the ticket names. */
  async putBlob(ident, body) {
    const { dev } = this.caller(ident, { needKeys: true });
    const uid = ident.user.id;
    const t = { user: uid, device: dev.device_id, path: body.path, size: body.size, sha256: body.sha256, epoch: body.epoch, expires: body.expires };
    if (typeof body.sig !== 'string' || typeof t.path !== 'string' || !int(t.size, 1, SYNC_LIMITS.blobMax) || !int(t.expires, 0, Number.MAX_SAFE_INTEGER) || !int(t.epoch, 1, 1e9) || typeof t.sha256 !== 'string') {
      throw new HubError('VALIDATION', 'not an upload ticket');
    }
    const want = Buffer.from(this.ticketSig(t));
    const got = Buffer.from(body.sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new HubError('FORBIDDEN', 'the upload ticket is not valid for this device');
    if (this.now() > t.expires) throw new HubError('FORBIDDEN', 'the upload ticket expired: ask for a new one', { reason: 'expired' });
    if (typeof body.data !== 'string' || !B64.test(body.data)) throw new HubError('VALIDATION', 'data must be base64url');
    const bytes = Buffer.from(body.data, 'base64url');
    if (bytes.length !== t.size) throw new HubError('VALIDATION', 'data is not the size the ticket names');
    if (createHash('sha256').update(bytes).digest('hex') !== t.sha256) throw new HubError('VALIDATION', 'data does not match the ticket hash');
    const done = this.db.get('SELECT id, seq FROM sync_blobs WHERE object_key = ?', t.path);
    if (done) return { id: done.id, seq: done.seq };
    await this.store.put(t.path, bytes);
    try {
      return this.db.tx(() => {
        const { acc, plan } = this.caller(ident, { needKeys: true });
        if (t.epoch !== acc.epoch) throw new HubError('CONFLICT', 'the content key changed: refresh your keys', { reason: 'stale_epoch', epoch: acc.epoch });
        if (acc.bytes_used + t.size > plan.bytes) throw new HubError('QUOTA_EXCEEDED', 'your sync storage is full', { resource: 'sync.bytes', limit: plan.bytes, used: acc.bytes_used });
        const seq = this.db.get('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM sync_blobs WHERE user_id = ? AND device_id = ?', uid, dev.device_id).s;
        const now = this.hub.iso();
        const r = this.db.run('INSERT INTO sync_blobs (user_id, device_id, seq, epoch, size, sha256, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          uid, dev.device_id, seq, t.epoch, t.size, t.sha256, t.path, now);
        this.db.run('UPDATE sync_accounts SET bytes_used = bytes_used + ?, updated_at = ? WHERE user_id = ?', t.size, now, uid);
        return { id: Number(r.lastInsertRowid), seq };
      });
    } catch (e) {
      await this.store.delete(t.path).catch(() => {});
      throw e;
    }
  }

  /** GET /api/sync/blobs?after=&limit= → the log after a cursor (metadata only). Read-only mode may read. */
  listBlobs(ident, query) {
    const { dev } = this.caller(ident, { modes: ['active', 'read_only'] });
    const after = Number(query.get('after') ?? 0);
    const limit = Number(query.get('limit') ?? SYNC_LIMITS.listMax);
    if (!int(after, 0, Number.MAX_SAFE_INTEGER) || !int(limit, 1, SYNC_LIMITS.listMax)) throw new HubError('VALIDATION', `after must be a cursor and limit 1 to ${SYNC_LIMITS.listMax}`);
    const rows = this.db.all('SELECT id, device_id, seq, epoch, size, sha256, created_at FROM sync_blobs WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?', ident.user.id, after, limit + 1);
    this.db.run('UPDATE sync_devices SET last_sync_at = ? WHERE user_id = ? AND device_id = ?', this.hub.iso(), ident.user.id, dev.device_id);
    return { blobs: rows.slice(0, limit).map((r) => ({ ...r })), more: rows.length > limit };
  }

  /** GET /api/sync/blobs/:blob_id → one blob's ciphertext (base64url). */
  async getBlob(ident, blobId) {
    this.caller(ident, { modes: ['active', 'read_only'] });
    const id = Number(blobId);
    const row = int(id, 1, Number.MAX_SAFE_INTEGER) ? this.db.get('SELECT * FROM sync_blobs WHERE id = ? AND user_id = ?', id, ident.user.id) : null;
    if (!row) throw new HubError('NOT_FOUND', 'no such blob');
    const bytes = Buffer.from(await this.store.get(row.object_key));
    if (bytes.length !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new HubError('INTERNAL', 'stored blob does not match its record');
    return { id: row.id, device_id: row.device_id, seq: row.seq, epoch: row.epoch, size: row.size, sha256: row.sha256, created_at: row.created_at, data: bytes.toString('base64url') };
  }

  /** PUT /api/sync/cursor {cursor}: how far this device has read (shown on the Sync page). */
  putCursor(ident, body) {
    const { dev } = this.caller(ident, { modes: ['active', 'read_only'] });
    const head = this.db.get('SELECT COALESCE(MAX(id), 0) AS id FROM sync_blobs WHERE user_id = ?', ident.user.id).id;
    if (!int(body.cursor, 0, head)) throw new HubError('VALIDATION', 'cursor must be a blob id you have read');
    this.db.run('UPDATE sync_devices SET cursor = MAX(cursor, ?), last_sync_at = ? WHERE user_id = ? AND device_id = ?', body.cursor, this.hub.iso(), ident.user.id, dev.device_id);
    return { cursor: Math.max(dev.cursor, body.cursor) };
  }

  routes(route) {
    const opts = { auth: 'user', replay: false };
    route('GET', '/api/sync/state', ({ ident }) => this.state(ident), opts);
    route('POST', '/api/sync/devices', ({ ident, body }) => this.registerDevice(ident, body), opts);
    route('POST', '/api/sync/init', ({ ident, body }) => this.init(ident, body), opts);
    route('PUT', '/api/sync/wraps', ({ ident, body }) => this.putWraps(ident, body), { ...opts, maxBody: 256 * 1024 });
    route('POST', '/api/sync/devices/:device_id/revoke', ({ ident, params, body }) => this.revoke(ident, params.device_id, body), { ...opts, maxBody: 256 * 1024 });
    route('POST', '/api/sync/uploads', ({ ident, body }) => this.uploadTicket(ident, body), opts);
    route('PUT', '/api/sync/blobs', ({ ident, body }) => this.putBlob(ident, body), { ...opts, maxBody: 1024 * 1024 });
    route('GET', '/api/sync/blobs', ({ ident, query }) => this.listBlobs(ident, query), opts);
    route('GET', '/api/sync/blobs/:blob_id', ({ ident, params }) => this.getBlob(ident, params.blob_id), opts);
    route('PUT', '/api/sync/cursor', ({ ident, body }) => this.putCursor(ident, body), opts);
  }

  // ── lapse and purge (the hub's hourly job) ──

  async notify(userId, subject, text, key) {
    const mailer = this.hub.accounts?.mailer;
    const to = this.db.get('SELECT primary_email FROM users WHERE id = ? AND deleted_at IS NULL', userId)?.primary_email;
    if (!mailer || !to) return false;
    await mailer.send({ to, subject, text, idempotencyKey: key });
    return true;
  }

  async purge(acc) {
    for (const b of this.db.all('SELECT id, object_key FROM sync_blobs WHERE user_id = ?', acc.user_id)) {
      await this.store.delete(b.object_key);
      this.db.run('DELETE FROM sync_blobs WHERE id = ?', b.id);
    }
    this.db.tx(() => {
      this.db.run('DELETE FROM sync_devices WHERE user_id = ?', acc.user_id);
      this.db.run('DELETE FROM sync_accounts WHERE user_id = ?', acc.user_id);
    });
  }

  /**
   * Notes lapses and renewals, mails the read-only notice, and deletes every
   * object and row of an account 30 days after its lapse (or at once after
   * account deletion). One failing account never stops the others.
   * → {lapsed, noticed, purged}
   */
  async sweep() {
    const out = { lapsed: 0, noticed: 0, purged: 0 };
    if (!this.store) return out;
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    for (const row of this.db.all('SELECT user_id FROM sync_accounts')) {
      try {
        const before = this.account(row.user_id);
        const m = this.mode(row.user_id);
        const acc = m.acc;
        if (!before.lapsed_at && acc.lapsed_at) out.lapsed++;
        if (m.mode === 'read_only' && !acc.lapse_notice_at) {
          const sent = await this.notify(acc.user_id, `${BRAND.name} sync is read-only: your plan has ended`,
            `Your ${BRAND.name} plan has ended, so sync across your computers is now read-only.\n\nYour synced data stays available to download until ${day(m.until)}. After that date it is deleted from ${BRAND.name}'s servers. Renew Plus before then to keep syncing; nothing on your computers is deleted either way.\n`,
            `sync-lapse:${acc.user_id}:${acc.lapsed_at}`);
          if (sent || !this.hub.accounts?.mailer) this.db.run('UPDATE sync_accounts SET lapse_notice_at = ? WHERE user_id = ?', this.hub.iso(), acc.user_id);
          if (sent) out.noticed++;
        }
        const due = acc.purge_at ? Date.parse(acc.purge_at) : m.mode === 'gone' ? 0 : Infinity;
        if (this.now() >= due) {
          await this.purge(acc);
          out.purged++;
          if (acc.purge_notice) {
            await this.notify(acc.user_id, `Your ${BRAND.name} synced data was deleted`,
              `As we told you when your ${BRAND.name} plan ended, the encrypted copy of your synced data has now been deleted from ${BRAND.name}'s servers. Everything on your computers is unchanged. If you subscribe again, sync starts fresh from your computers.\n`,
              `sync-purged:${acc.user_id}`).catch((e) => this.hub.log.warn('sync deletion notice failed', { err: e?.message }));
          }
        }
      } catch (e) {
        this.hub.log.warn('sync sweep failed for one account', { err: e?.message ?? String(e) });
      }
    }
    return out;
  }

  /** Account deletion (in its transaction): every object and row goes at the next sweep, without a notice. */
  forgetUser(userId) {
    this.db.run('UPDATE sync_accounts SET purge_at = ?, purge_notice = 0, updated_at = ? WHERE user_id = ?', this.hub.iso(), this.hub.iso(), userId);
    this.db.run('UPDATE sync_devices SET revoked_at = COALESCE(revoked_at, ?), wrap = NULL WHERE user_id = ?', this.hub.iso(), userId);
  }
}
