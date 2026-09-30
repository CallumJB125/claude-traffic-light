// QR device pairing. The desktop shows a QR with its public key, a one-time
// secret, the hub URL and an expiry; the phone answers through the hub.
//
//   phone → desktop  pair-init    {pid, devicePub, deviceName, commit=H(nP)}  + HMAC(secret) + device signature
//   desktop → phone  pair-challenge {pid, devicePub, commit, nD}              signed by the desktop key
//   phone → desktop  pair-reveal  {pid, nP}                                   + HMAC(secret)
//   phone screen     SAS = 6 digits of H(pid, did, dpk, devicePub, nP, nD)
//   human TYPES that code into the desktop; the desktop compares it with its
//   own SAS (never displayed) → registry.add
//   desktop → phone  pair-complete {pid, devicePub, deviceId, ownerId}         signed by the desktop key
//
// Why each piece:
// - The secret never crosses the hub (it is read optically), so the HMAC
//   proves the init came from whoever scanned the QR; a relay can't make one.
// - The desktop signs what it received, so a relay that swaps the device key
//   is caught by the phone (signature is over the wrong key).
// - If the secret leaks (someone photographs the QR) an attacker holding the
//   hub could race the real phone. The code the human reads off the phone
//   then doesn't match the desktop's session, so typing it fails. Typing
//   (rather than "do these match? yes") means a hurried click can't confirm.
//   The commit/reveal order means the attacker has to fix its key before it
//   sees nD, so it cannot grind a key whose SAS collides with the phone's.
// - Every failure burns the pairing; the QR is single-use.
import { b64url, fromB64url, utf8, randomBytes, concatBytes } from './encoding.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { importPublicRaw, exportPublicRaw, fingerprint, signObject, verifyObject, signBytes, verifyBytes, generateSigningKey } from './keys.js';
import { cleanName } from './registry.js';

export const PAIRING_TTL_MS = 3 * 60 * 1000;
const MAX_OPEN_PAIRINGS = 4;

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function mac(secret, obj) {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(canonicalize(obj))));
}
async function macOk(secret, obj, tag) {
  let t;
  try { t = fromB64url(tag); } catch { return false; }
  return crypto.subtle.verify('HMAC', await hmacKey(secret), t, utf8(canonicalize(obj)));
}
const commitOf = (nP) => sha256Hex(concatBytes(utf8('buddy.pair.commit:'), fromB64url(nP)));

export async function shortCode({ pid, did, dpk, devicePub, nP, nD }) {
  const h = await sha256Hex(canonicalize({ t: 'buddy.pair.sas', pid, did, dpk, devicePub, nP, nD }));
  return String(parseInt(h.slice(0, 8), 16) % 1000000).padStart(6, '0');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const str = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;

// ── Desktop side ────────────────────────────────────────────────────────────
export class PairingHost {
  // identity: { privateKey, publicRaw, desktopId } (see keys.js createIdentity)
  constructor({ identity, registry, ownerId, hubUrl, clock = () => Date.now(), ttlMs = PAIRING_TTL_MS, audit = () => {} }) {
    Object.assign(this, { identity, registry, ownerId, hubUrl, clock, ttlMs, audit });
    this.open = new Map();
    this.completed = new Map(); // pid → { complete, exp }: the phone polls for it
  }

  #sweep() {
    const now = this.clock();
    for (const [pid, s] of this.open) if (s.exp <= now) this.open.delete(pid);
    for (const [pid, c] of this.completed) if (c.exp <= now) this.completed.delete(pid);
  }

  #fail(pid, reason) {
    const s = this.open.get(pid);
    this.open.delete(pid);
    this.audit({ type: 'remote.pair.failed', at: this.clock(), pid, reason, deviceName: s?.deviceName ?? null });
    return { ok: false, reason };
  }

  #session(pid, state) {
    if (!str(pid, 64)) return { error: 'malformed' };
    const s = this.open.get(pid);
    if (!s) return { error: 'unknown-pairing' };
    if (s.exp <= this.clock()) return { error: 'expired' };
    if (s.state !== state) return { error: 'wrong-state' };
    return { s };
  }

  // Returns the QR payload object and its text form for the QR encoder.
  async start() {
    this.#sweep();
    if (this.open.size >= MAX_OPEN_PAIRINGS) throw new Error('too many open pairings');
    const pid = b64url(randomBytes(16));
    const secret = randomBytes(32);
    const exp = this.clock() + this.ttlMs;
    this.open.set(pid, { pid, secret, exp, state: 'init' });
    const qr = { v: 1, t: 'buddy.pair', hub: this.hubUrl, did: this.identity.desktopId, dpk: this.identity.publicRaw, pid, s: b64url(secret), exp };
    return { pid, qr, qrText: canonicalize(qr), expiresAt: exp };
  }

  // The phone asks, through the hub, whether the human has confirmed yet.
  // The completion is desktop-signed, so the hub can't fake it.
  poll(pid) {
    this.#sweep();
    const c = this.completed.get(pid);
    if (c) return { ok: true, state: 'complete', complete: c.complete };
    if (this.open.has(pid)) return { ok: true, state: 'waiting' };
    return { ok: false, reason: 'unknown-pairing' };
  }

  cancel(pid) {
    return this.open.delete(pid);
  }

  async handleInit(msg) {
    const { s, error } = this.#session(msg?.pid, 'init');
    if (error) return error === 'unknown-pairing' || error === 'malformed' ? { ok: false, reason: error } : this.#fail(msg.pid, error);
    const { pid, devicePub, deviceName, commit, mac: tag, pop } = msg;
    if (!str(devicePub, 100) || !str(commit, 64) || typeof deviceName !== 'string' || deviceName.length > 200 || !str(tag, 64) || !str(pop, 100)) return this.#fail(pid, 'malformed');
    const body = { t: 'pair-init', pid, did: this.identity.desktopId, devicePub, deviceName, commit };
    if (!(await macOk(s.secret, body, tag))) return this.#fail(pid, 'bad-mac');
    let key;
    try { key = await importPublicRaw(devicePub); } catch { return this.#fail(pid, 'bad-key'); }
    if (!(await verifyBytes(key, pop, utf8(canonicalize(body))))) return this.#fail(pid, 'bad-proof-of-possession');
    const nD = b64url(randomBytes(32));
    Object.assign(s, { state: 'reveal', devicePub, deviceName: cleanName(deviceName), commit, nD });
    const challenge = await signObject(this.identity.privateKey, { t: 'pair-challenge', pid, did: this.identity.desktopId, devicePub, commit, nD });
    return { ok: true, challenge };
  }

  // On success the desktop asks the human to type the code shown on the
  // phone. It shows the device name only as an untrusted, phone-chosen label.
  async handleReveal(msg) {
    const { s, error } = this.#session(msg?.pid, 'reveal');
    if (error) return error === 'unknown-pairing' || error === 'malformed' ? { ok: false, reason: error } : this.#fail(msg.pid, error);
    const { pid, nP, mac: tag } = msg;
    if (!str(nP, 64) || !str(tag, 64)) return this.#fail(pid, 'malformed');
    if (!(await macOk(s.secret, { t: 'pair-reveal', pid, nP }, tag))) return this.#fail(pid, 'bad-mac');
    let c;
    try { c = await commitOf(nP); } catch { return this.#fail(pid, 'malformed'); }
    if (c !== s.commit) return this.#fail(pid, 'commit-mismatch');
    s.sas = await shortCode({ pid, did: this.identity.desktopId, dpk: this.identity.publicRaw, devicePub: s.devicePub, nP, nD: s.nD });
    s.state = 'confirm';
    return { ok: true, deviceName: s.deviceName, deviceNameUntrusted: true };
  }

  // `typedCode` is what the human typed from the phone's screen. One try: a
  // wrong code cancels the pairing. Only the local desktop UI calls this.
  async confirm(pid, typedCode) {
    const { s, error } = this.#session(pid, 'confirm');
    if (error) return error === 'unknown-pairing' || error === 'malformed' ? { ok: false, reason: error } : this.#fail(pid, error);
    const typed = typeof typedCode === 'string' ? typedCode.replace(/\s+/g, '') : '';
    if (!/^\d{6}$/.test(typed) || !constantTimeEqual(typed, s.sas)) return this.#fail(pid, 'wrong-code');
    this.open.delete(pid);
    const device = await this.registry.add({ publicKey: s.devicePub, name: s.deviceName, ownerId: this.ownerId });
    const complete = await signObject(this.identity.privateKey, { t: 'pair-complete', pid, did: this.identity.desktopId, devicePub: s.devicePub, deviceId: device.deviceId, ownerId: this.ownerId });
    this.completed.set(pid, { complete, exp: this.clock() + this.ttlMs });
    this.audit({ type: 'remote.pair.completed', at: this.clock(), pid, deviceId: device.deviceId, deviceName: device.name, ownerId: this.ownerId });
    return { ok: true, device, complete };
  }
}

// ── Phone side ──────────────────────────────────────────────────────────────
export function parsePairingQr(text, { now = Date.now(), allowInsecureHub = false } = {}) {
  let qr;
  try { qr = JSON.parse(text); } catch { throw new Error('not a Buddy pairing code'); }
  if (!qr || qr.v !== 1 || qr.t !== 'buddy.pair' || ![qr.hub, qr.did, qr.dpk, qr.pid, qr.s].every((x) => str(x, 2048)) || !Number.isFinite(qr.exp)) {
    throw new Error('not a Buddy pairing code');
  }
  let url;
  try { url = new URL(qr.hub); } catch { throw new Error('bad hub URL'); }
  if (url.protocol !== 'https:' && !allowInsecureHub) throw new Error('hub URL must be https');
  if (qr.exp <= now) throw new Error('pairing code expired — show a new one on the desktop');
  return qr;
}

export class PairingClient {
  static async begin(qr, { deviceName = 'Phone', keyPair } = {}) {
    const c = new PairingClient();
    c.qr = qr;
    c.keyPair = keyPair || (await generateSigningKey());
    c.devicePub = await exportPublicRaw(c.keyPair.publicKey);
    // The QR's desktop key must hash to its advertised id.
    if ((await fingerprint(qr.dpk)) !== qr.did) throw new Error('pairing code is inconsistent');
    c.desktopKey = await importPublicRaw(qr.dpk);
    c.secret = fromB64url(qr.s);
    c.nP = b64url(randomBytes(32));
    const commit = await commitOf(c.nP);
    const body = { t: 'pair-init', pid: qr.pid, did: qr.did, devicePub: c.devicePub, deviceName: String(deviceName), commit };
    c.commit = commit;
    // `did` is covered by the MAC and signature but not sent: the desktop
    // fills in its own id, so an init relayed to another desktop fails.
    c.init = { t: 'pair-init', pid: qr.pid, devicePub: c.devicePub, deviceName: body.deviceName, commit, mac: await mac(c.secret, body), pop: await signBytes(c.keyPair.privateKey, utf8(canonicalize(body))) };
    return c;
  }

  // Returns the reveal message and the code to show on the phone.
  async onChallenge(env) {
    const ch = await verifyObject(this.desktopKey, env);
    if (!ch || ch.t !== 'pair-challenge' || ch.pid !== this.qr.pid || ch.did !== this.qr.did) throw new Error('pairing challenge not signed by this desktop');
    if (ch.devicePub !== this.devicePub || ch.commit !== this.commit) throw new Error('pairing was tampered with in transit — do not confirm on the desktop');
    this.nD = ch.nD;
    const reveal = { t: 'pair-reveal', pid: this.qr.pid, nP: this.nP, mac: await mac(this.secret, { t: 'pair-reveal', pid: this.qr.pid, nP: this.nP }) };
    this.sas = await shortCode({ pid: this.qr.pid, did: this.qr.did, dpk: this.qr.dpk, devicePub: this.devicePub, nP: this.nP, nD: this.nD });
    return { reveal, sas: this.sas };
  }

  // What the phone stores once paired (the private key stays a CryptoKey).
  async onComplete(env) {
    const done = await verifyObject(this.desktopKey, env);
    if (!done || done.t !== 'pair-complete' || done.pid !== this.qr.pid || done.did !== this.qr.did || done.devicePub !== this.devicePub) throw new Error('pairing completion not valid');
    if (done.deviceId !== (await fingerprint(this.devicePub))) throw new Error('pairing completion not valid');
    this.secret = null;
    return { deviceId: done.deviceId, ownerId: done.ownerId, desktopId: this.qr.did, desktopPub: this.qr.dpk, hub: this.qr.hub, keyPair: this.keyPair };
  }
}
