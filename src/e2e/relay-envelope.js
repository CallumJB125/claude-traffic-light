// End-to-end envelope for the interaction relay (phone <-> desktop through the
// accounts hub). REQUIRES INDEPENDENT SECURITY REVIEW before release: see
// docs/relay-e2e-threat-model.md.
//
// One file, byte-identical in two homes: src/e2e/relay-envelope.js (the desktop
// app, canonical) and board/web/js/phone-e2e.js (served to the phone PWA by the
// hub). remote/src/envelope.js re-exports the first. test/relay-e2e.test.js
// fails on drift. No imports, no Buffer: WebCrypto (globalThis.crypto.subtle)
// only, identical on Node >= 22 and iOS 16.4+ Safari.
//
// Primitives: ECDH P-256, HKDF-SHA-256, AES-256-GCM. Nothing home-made.
//
// Keys. Each end has a static ECDH P-256 key. They are exchanged and
// authenticated at pairing (remote/src/pairing.js: the phone's half inside the
// MAC'd and signed pair-init, the desktop's in the desktop-signed challenge
// and completion, both in the typed SAS). The pair secret is
// ECDH(own static, peer static): only those two ends can compute it, so a
// message that opens under it came from the other end (implicit mutual
// authentication; the hub only ever sees the public halves).
//
// Session. `hello` (sealed under the pair secret) carries a random phone
// nonce nP; the desktop answers (sealed) with a fresh session id and nonce nD.
//   session secret = HKDF(pair secret, salt = nP || nD,
//                         info = ["plexiform.relay.v1","session",did,dev,sid])
// The desktop keeps sessions in memory only: after a restart every old
// envelope is refused ("no-session") and the phone opens a new session, so a
// captured envelope can never be replayed into a later run.
//
// Message. key = HKDF(secret, salt = 32 random bytes,
//                     info = ["plexiform.relay.v1","msg",dir]) -> AES-256-GCM,
// IV = 96 random bits (a fresh key per message, so IV reuse cannot happen).
//   AAD = ["plexiform.relay",1,dir,did,dev,sid,seq,rid,op]
// so a ciphertext only opens for this desktop, this device, this session and
// sequence number, this relay request id, this op and this direction. The hub
// sees v, dev, sid, seq, sizes and timing; never args or results.
//
// Replay. The desktop accepts each (sid, seq) once and refuses a seq more than
// WINDOW below the highest it has seen; the phone accepts an answer only for a
// request it has outstanding (same sid, seq, rid and op, direction d2p).

export const RELAY_E2E = Object.freeze({
  v: 1,
  suite: 'ECDH-P256/HKDF-SHA256/AES-256-GCM',
  window: 256,
  maxSeq: 2 ** 31 - 1,
  sessionsPerDevice: 4,
  sessionsTotal: 64,
  sessionIdleMs: 30 * 60_000,
  sessionMaxMs: 12 * 60 * 60_000,
  maxCipherChars: 1_100_000,
});

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const B64 = /^[A-Za-z0-9_-]*$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SID_CHARS = 22;  // 16 bytes
const SALT_CHARS = 43; // 32 bytes
const IV_CHARS = 16;   // 12 bytes
const ENC_KEYS = ['v', 'dev', 'sid', 'seq', 'salt', 'iv', 'ct'];
const subtle = () => globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export class E2EError extends Error {
  constructor(code, message = code) { super(message); this.name = 'E2EError'; this.code = code; }
}

function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  if (typeof s !== 'string' || !B64.test(s) || s.length % 4 === 1) throw new E2EError('malformed');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── keys ────────────────────────────────────────────────────────────────────

/** A static ECDH P-256 key. The phone keeps it non-extractable (a CryptoKey in IndexedDB); the desktop needs extractable to persist it. */
export function generateAgreementKey({ extractable = false } = {}) {
  return subtle().generateKey(ECDH, extractable, ['deriveBits']);
}

export async function exportAgreementPublic(publicKey) {
  return b64url(await subtle().exportKey('raw', publicKey));
}

/** Uncompressed SEC1 point only; WebCrypto refuses a point that is not on the curve. */
export async function importAgreementPublic(rawB64) {
  const raw = fromB64url(rawB64);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new E2EError('bad-key', 'expected an uncompressed P-256 public key');
  try { return await subtle().importKey('raw', raw, ECDH, true, []); } catch { throw new E2EError('bad-key', 'not a P-256 point'); }
}

/** Desktop persistence: the private half as a JWK (0600 file, see remote/src/node/file-store.js). */
export async function importAgreementPrivateJwk(jwk) {
  if (!isObj(jwk) || !jwk.d) throw new E2EError('bad-key', 'not a private JWK');
  const privateKey = await subtle().importKey('jwk', jwk, ECDH, false, ['deriveBits']);
  const { d, ...pub } = jwk;
  const publicKey = await subtle().importKey('jwk', { ...pub, key_ops: [] }, ECDH, true, []);
  return { privateKey, publicKey };
}

async function pairSecret(privateKey, peerPublic) {
  const peer = typeof peerPublic === 'string' ? await importAgreementPublic(peerPublic) : peerPublic;
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
}

const info = (...parts) => te.encode(JSON.stringify(['plexiform.relay.v1', ...parts]));
const aadOf = (c) => te.encode(JSON.stringify(['plexiform.relay', RELAY_E2E.v, c.dir, c.did, c.dev, c.sid, c.seq, c.rid, c.op]));

async function hkdfBits(ikm, salt, inf) {
  const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: inf }, base, 256));
}
async function msgKey(secret, salt, dir, usage) {
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: info('msg', dir) }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

// ── envelope ────────────────────────────────────────────────────────────────

/** Seal `value` (JSON) under `secret` for context c = {dir, did, dev, sid, seq, rid, op}. */
export async function seal(secret, c, value) {
  const salt = random(32);
  const iv = random(12);
  const key = await msgKey(secret, salt, c.dir, 'encrypt');
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(c), tagLength: 128 }, key, te.encode(JSON.stringify(value)));
  return { v: RELAY_E2E.v, dev: c.dev, sid: c.sid, seq: c.seq, salt: b64url(salt), iv: b64url(iv), ct: b64url(ct) };
}

/** Open an envelope for context c; throws E2EError('rejected') on any tamper (AAD, ciphertext, tag, salt, iv). */
export async function open(secret, c, enc) {
  checkShape(enc);
  if (enc.dev !== c.dev || enc.sid !== c.sid || enc.seq !== c.seq) throw new E2EError('rejected');
  let plain;
  try {
    const key = await msgKey(secret, fromB64url(enc.salt), c.dir, 'decrypt');
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64url(enc.iv), additionalData: aadOf(c), tagLength: 128 }, key, fromB64url(enc.ct));
  } catch { throw new E2EError('rejected'); }
  try { return JSON.parse(td.decode(plain)); } catch { throw new E2EError('rejected'); }
}

/** The envelope's shape (what the hub also checks): closed keys, sizes, base64url. */
export function checkShape(enc) {
  if (!isObj(enc) || Object.keys(enc).length !== ENC_KEYS.length || !ENC_KEYS.every((k) => Object.hasOwn(enc, k))) throw new E2EError('malformed');
  if (enc.v !== RELAY_E2E.v || typeof enc.dev !== 'string' || !ID.test(enc.dev)) throw new E2EError('malformed');
  if (typeof enc.sid !== 'string' || !(enc.sid === '' || (enc.sid.length === SID_CHARS && B64.test(enc.sid)))) throw new E2EError('malformed');
  if (!Number.isSafeInteger(enc.seq) || enc.seq < 0 || enc.seq > RELAY_E2E.maxSeq || (enc.sid === '') !== (enc.seq === 0)) throw new E2EError('malformed');
  if (typeof enc.salt !== 'string' || enc.salt.length !== SALT_CHARS || !B64.test(enc.salt)) throw new E2EError('malformed');
  if (typeof enc.iv !== 'string' || enc.iv.length !== IV_CHARS || !B64.test(enc.iv)) throw new E2EError('malformed');
  if (typeof enc.ct !== 'string' || enc.ct.length < 22 || enc.ct.length > RELAY_E2E.maxCipherChars || !B64.test(enc.ct)) throw new E2EError('malformed');
  return enc;
}

// ── desktop (host) side ─────────────────────────────────────────────────────

/**
 * The desktop's end. `did`: this desktop's id (bound into every AAD).
 * `privateKey`: its static ECDH private key. `peer(dev)` → the paired device's
 * ECDH public key (base64url raw) or null when unknown or revoked; asked on
 * every message, so a revocation takes effect on the next one.
 *
 * open({rid, op, enc}) →
 *   {ok:false, code}                          refuse; nothing ran
 *   {ok:true, hello:true, reply}              a new session; answer {enc: reply}
 *   {ok:true, dev, args, seal(result) → enc}  run op with args, answer {enc: await seal(result)}
 */
export function createDesktopChannel({ did, privateKey, peer, now = Date.now, limits = {} }) {
  if (typeof did !== 'string' || !ID.test(did)) throw new TypeError('did must be a short id');
  const L = { ...RELAY_E2E, ...limits };
  const sessions = new Map(); // sid -> {dev, secret, createdAt, usedAt, max, seen:Set}
  const fail = (code) => ({ ok: false, code });

  function sweep() {
    const t = now();
    for (const [sid, s] of sessions) if (t - s.usedAt > L.sessionIdleMs || t - s.createdAt > L.sessionMaxMs) sessions.delete(sid);
  }
  function admit(sid, s) {
    const mine = [...sessions].filter(([, x]) => x.dev === s.dev);
    if (mine.length >= L.sessionsPerDevice) sessions.delete(mine[0][0]);
    if (sessions.size >= L.sessionsTotal) sessions.delete(sessions.keys().next().value);
    sessions.set(sid, s);
  }
  async function peerKey(dev) {
    let k = null;
    try { k = await peer(dev); } catch { k = null; }
    if (typeof k !== 'string' || !k) { forget(dev); return null; }
    return k;
  }
  function forget(dev) { for (const [sid, s] of sessions) if (s.dev === dev) sessions.delete(sid); }

  async function openFrame({ rid, op, enc }) {
    try { checkShape(enc); } catch { return fail('malformed'); }
    if (typeof rid !== 'string' || !rid || typeof op !== 'string' || !op) return fail('malformed');
    sweep();
    const peerPub = await peerKey(enc.dev);
    if (!peerPub) return fail('unknown-device');
    let ps;
    try { ps = await pairSecret(privateKey, peerPub); } catch { return fail('unknown-device'); }
    const base = { did, dev: enc.dev, rid, op };
    if (op === 'hello') {
      if (enc.sid !== '') return fail('malformed');
      let body;
      try { body = await open(ps, { ...base, dir: 'p2d', sid: '', seq: 0 }, enc); } catch { return fail('rejected'); }
      let nP;
      try { nP = isObj(body) && Object.keys(body).length === 1 ? fromB64url(body.nP) : null; } catch { nP = null; }
      if (!nP || nP.length !== 32) return fail('rejected');
      const sid = b64url(random(16));
      const nD = random(32);
      const secret = await hkdfBits(ps, concat(nP, nD), info('session', did, enc.dev, sid));
      const t = now();
      admit(sid, { dev: enc.dev, secret, createdAt: t, usedAt: t, max: 0, seen: new Set() });
      const reply = await seal(ps, { ...base, dir: 'd2p', sid: '', seq: 0 }, { sid, nD: b64url(nD) });
      return { ok: true, hello: true, dev: enc.dev, reply };
    }
    if (enc.sid === '') return fail('malformed');
    const s = sessions.get(enc.sid);
    if (!s || s.dev !== enc.dev) return fail('no-session');
    const c = { ...base, sid: enc.sid, seq: enc.seq };
    if (enc.seq <= s.max - L.window || s.seen.has(enc.seq)) return fail('replayed');
    let args;
    try { args = await open(s.secret, { ...c, dir: 'p2d' }, enc); } catch { return fail('rejected'); }
    // Re-checked after the await: a concurrent copy of the same envelope may have won.
    if (enc.seq <= s.max - L.window || s.seen.has(enc.seq) || sessions.get(enc.sid) !== s) return fail('replayed');
    s.seen.add(enc.seq);
    if (enc.seq > s.max) {
      s.max = enc.seq;
      for (const q of s.seen) if (q <= s.max - L.window) s.seen.delete(q);
    }
    s.usedAt = now();
    return { ok: true, dev: enc.dev, args, seal: (result) => seal(s.secret, { ...c, dir: 'd2p' }, result) };
  }

  return { open: openFrame, forget, sessionCount: () => sessions.size, close: () => sessions.clear() };
}

// ── device (phone, or another desktop as client) side ───────────────────────

const E2E_TEXT = {
  'no-session': 'Your computer restarted, so this request may not have been handled. Check the session before trying again.',
  busy: 'Your computer is busy with other requests. Try again shortly.',
  'unknown-device': 'Your computer no longer recognises this phone. Pair it again from your computer.',
  rejected: 'Your computer could not verify that request. Pair this phone again from your computer.',
  replayed: 'That request was already handled. Check the conversation before trying again.',
  required: 'Your computer only accepts end-to-end encrypted requests. Pair this phone from your computer first.',
  unsupported: 'Your computer does not support end-to-end encryption yet. Update Plexiform there.',
  malformed: 'Your computer refused that request.',
  answer: 'The answer could not be verified, so it was not shown. It may have been changed on the way.',
};
export const E2E_CODES = Object.freeze(Object.keys(E2E_TEXT));
// Ops whose effect may already have happened: never repeated automatically.
const MUTATING = new Set(['launch', 'send', 'interrupt', 'close']);
const e2eFailure = (code) => ({ status: 502, body: { error: { code: 'E2E', reason: code, message: E2E_TEXT[code] ?? E2E_TEXT.malformed } } });

/**
 * The calling end. `did`/`peerPublic`: the paired desktop's id and ECDH public
 * key; `dev`: this device's id as that desktop knows it; `privateKey`: this
 * device's static ECDH private key.
 *
 * call(op, args, send, uuid) → {status, body}, the shape of a plain relay
 * answer: `send(requestId, op, enc)` posts {request_id, op, enc} and returns
 * the hub's {status, body}. A 200 whose result opens is returned with the
 * plaintext result in body.result. A desktop refusal before decryption
 * ({ok:false, e2e}) or anything that does not open becomes a 502
 * {error:{code:'E2E', reason}} with fixed text: an unverifiable answer is
 * never shown. A forgotten session (desktop restart) is reopened once.
 */
export function createDeviceChannel({ did, dev, privateKey, peerPublic }) {
  if (typeof did !== 'string' || !ID.test(did) || typeof dev !== 'string' || !ID.test(dev)) throw new TypeError('did and dev must be short ids');
  let session = null; // {sid, secret, seq}
  let opening = null;

  async function hello(send, uuid) {
    const ps = await pairSecret(privateKey, peerPublic);
    const nP = random(32);
    const rid = uuid();
    const base = { did, dev, rid, op: 'hello', sid: '', seq: 0 };
    const enc = await seal(ps, { ...base, dir: 'p2d' }, { nP: b64url(nP) });
    const r = await send(rid, 'hello', enc);
    const res = r?.status === 200 ? r.body?.result : null;
    if (!res?.enc) return r?.status === 200 ? e2eFailure(isObj(res) && E2E_CODES.includes(res.e2e) ? res.e2e : 'answer') : r;
    let body;
    try { body = await open(ps, { ...base, dir: 'd2p' }, res.enc); } catch { return e2eFailure('answer'); }
    let nD;
    try { nD = isObj(body) && typeof body.sid === 'string' && body.sid.length === SID_CHARS && B64.test(body.sid) ? fromB64url(body.nD) : null; } catch { nD = null; }
    if (!nD || nD.length !== 32) return e2eFailure('answer');
    session = { sid: body.sid, secret: await hkdfBits(ps, concat(nP, nD), info('session', did, dev, body.sid)), seq: 0 };
    return null;
  }

  async function ensure(send, uuid) {
    if (session) return null;
    opening ??= hello(send, uuid).finally(() => { opening = null; });
    return opening;
  }

  async function call(op, args, send, uuid) {
    for (let attempt = 0; ; attempt++) {
      const failed = await ensure(send, uuid);
      if (failed) return failed;
      const s = session;
      if (!s) return e2eFailure('answer');
      if (s.seq >= RELAY_E2E.maxSeq) { session = null; continue; }
      const c = { did, dev, sid: s.sid, seq: ++s.seq, rid: uuid(), op };
      const enc = await seal(s.secret, { ...c, dir: 'p2d' }, args ?? {});
      const r = await send(c.rid, op, enc);
      if (r?.status !== 200) return r;
      const res = r.body?.result;
      if (isObj(res) && res.enc !== undefined) {
        try { return { ...r, body: { ...r.body, result: await open(s.secret, { ...c, dir: 'd2p' }, res.enc) } }; } catch { return e2eFailure('answer'); }
      }
      // Plaintext from the desktop's side is only ever a refusal made before it could decrypt.
      const code = isObj(res) && E2E_CODES.includes(res.e2e) ? res.e2e : 'answer';
      // The hub could fake a restart to make a send run twice: only reads are retried.
      if (code === 'no-session' && attempt === 0 && !MUTATING.has(op)) { if (session === s) session = null; continue; }
      if (code === 'no-session' || code === 'unknown-device' || code === 'rejected') { if (session === s) session = null; }
      return e2eFailure(code);
    }
  }

  return { call, reset: () => { session = null; }, get open() { return !!session; } };
}
