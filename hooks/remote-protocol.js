// The wire contract between a reporter machine (hooks/remote.js, emit.js) and
// the desktop app (src/remote-devices.js). Lives in hooks/ because both sides
// need it and the packaged hooks run with nothing else beside them.
// Dependency-free (crypto only).
//
// A request is the envelope JSON as the body plus four headers:
//   x-buddy-device     the paired device id
//   x-buddy-ts         sender's wall clock, ms since epoch
//   x-buddy-nonce      32 hex chars, fresh per request
//   x-buddy-signature  hex HMAC-SHA256(device key, signingString)
// The signature covers the exact body bytes (by digest), so the receiver
// verifies before it parses anything. The device id is in the signed string
// too, so one device's key can never speak for another.
//
// The desktop signs its answer the same way (responseString, over the
// request's nonce), so a reporter can tell the real desktop from anything
// else listening where the tunnel should be.
const crypto = require('crypto');

const VERSION = 1;
const MAX_SKEW_MS = 60000;
// A nonce only has to outlive the window in which its timestamp still
// passes: both skew directions, plus slack. Kept on the monotonic clock, so
// a wall-clock step can't expire one early.
const NONCE_TTL_MS = 2 * MAX_SKEW_MS + 5000;
const NONCES_PER_DEVICE = 1000;
const MAX_BODY_BYTES = 16384;
const MAX_EVENTS = 8;
const MAX_HEARTBEAT_SESSIONS = 64;
const HEADERS = { device: 'x-buddy-device', ts: 'x-buddy-ts', nonce: 'x-buddy-nonce', sig: 'x-buddy-signature' };
const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const SIG = /^[0-9a-f]{64}$/;
const SOURCE = /^[a-z][a-z0-9_-]{0,23}$/;
// Exactly what safeSessionId() in session-state.js can produce, minus the
// all-dots names that would read as path segments.
const SESSION_ID = /^[\w.-]{1,120}$/;
const validSessionId = (s) => typeof s === 'string' && SESSION_ID.test(s) && !/^\.+$/.test(s);
const validSeq = (n) => Number.isSafeInteger(n) && n > 0;
const PAIR_PREFIX = 'buddy-pair-v1';
// Verified against when the device id is unknown, so an unknown id costs the
// same HMAC as a known one.
const DUMMY_TOKEN = crypto.randomBytes(32).toString('hex');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const bytes = (body) => (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
const monoMs = () => Number(process.hrtime.bigint() / 1000000n);

function signingString({ device, ts, nonce, body }) {
  return `buddy-remote-v${VERSION}\n${device}\n${ts}\n${nonce}\n${sha256(bytes(body))}`;
}

const hmac = (token, text) => crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(text).digest('hex');
const sign = (token, parts) => hmac(token, signingString(parts));

function signedHeaders({ device, token, body, now = Date.now(), nonce = crypto.randomBytes(16).toString('hex') }) {
  const ts = String(Math.round(now));
  return {
    'content-type': 'application/json',
    [HEADERS.device]: device,
    [HEADERS.ts]: ts,
    [HEADERS.nonce]: nonce,
    [HEADERS.sig]: sign(token, { device, ts, nonce, body }),
  };
}

const responseString = ({ nonce, status, body }) => `buddy-remote-v${VERSION}-resp\n${nonce}\n${status}\n${sha256(bytes(body))}`;
const signResponse = (token, parts) => hmac(token, responseString(parts));
const responseAuthentic = (token, { nonce, status, body, sig }) => safeEqualHex(signResponse(token, { nonce, status, body }), sig);

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !SIG.test(a) || !SIG.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// One cache per device: a device that floods only locks itself out. The cap
// fails closed (reject) rather than evicting, since an evicted nonce inside
// the window could be replayed. Only signed requests ever reach it.
function nonceCaches({ ttlMs = NONCE_TTL_MS, max = NONCES_PER_DEVICE } = {}) {
  const byDevice = new Map(); // device -> Map(nonce -> expiresAt), insertion-ordered
  return {
    check(device, nonce, mono = monoMs()) {
      let seen = byDevice.get(device);
      if (!seen) byDevice.set(device, (seen = new Map()));
      for (const [k, exp] of seen) { if (exp > mono) break; seen.delete(k); }
      if (seen.has(nonce)) return 'replay';
      if (seen.size >= max) return 'full';
      seen.set(nonce, mono + ttlMs);
      return 'fresh';
    },
    forget(device) { byDevice.delete(device); },
    size(device) { return (byDevice.get(device) || new Map()).size; },
  };
}

// → { ok: true, device } or { ok: false, status, error }. `lookup(id)` returns
// the registered device ({ id, token, … }) or null (unknown, revoked, or a
// pairing code that expired unused). `now` is the wall clock (skew only);
// `mono` the monotonic one (nonce expiry).
function verify({ headers, body, lookup, nonces, now = Date.now(), mono = monoMs() }) {
  const h = (name) => { const v = headers[name]; return Array.isArray(v) ? null : v; };
  const device = h(HEADERS.device);
  const ts = h(HEADERS.ts);
  const nonce = h(HEADERS.nonce);
  const sig = h(HEADERS.sig);
  const deny = (status, error) => ({ ok: false, status, error });
  if (typeof device !== 'string' || !DEVICE_ID.test(device) || typeof ts !== 'string' || !/^\d{1,16}$/.test(ts)
    || typeof nonce !== 'string' || !NONCE.test(nonce) || typeof sig !== 'string' || !SIG.test(sig)) {
    return deny(401, 'missing or malformed signature headers');
  }
  const entry = lookup(device);
  const known = !!entry && typeof entry.token === 'string' && TOKEN.test(entry.token);
  const good = safeEqualHex(sign(known ? entry.token : DUMMY_TOKEN, { device, ts, nonce, body }), sig);
  // One answer for unknown, revoked and forged: the caller learns nothing
  // about which device ids exist.
  if (!known || !good) return deny(401, 'bad signature');
  if (Math.abs(now - Number(ts)) > MAX_SKEW_MS) return deny(401, 'timestamp outside the 60 s window (check both clocks)');
  const seen = nonces.check(device, nonce, mono);
  if (seen === 'replay') return deny(401, 'replayed request');
  if (seen === 'full') return { ...deny(429, 'too many requests'), device: entry, nonce };
  return { ok: true, device: entry, nonce };
}

const pairingCode = (device, token) => `${PAIR_PREFIX}.${device}.${token}`;

function parsePairingCode(text) {
  const m = /^buddy-pair-v1\.([a-z0-9][a-z0-9-]{0,31})\.([0-9a-f]{64})$/.exec(String(text || '').trim());
  return m ? { device: m[1], token: m[2] } : null;
}

// 100.64.0.0/10, the CGNAT block Tailscale assigns from.
function isTailnetIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  return !!m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127 && m.slice(3).every((x) => Number(x) <= 255);
}

// Plain http only where the path itself is private: loopback (an SSH
// tunnel's end) or a Tailscale IPv4 (WireGuard underneath; the reporter also
// checks it has a tailnet address itself before pairing). A name, even a
// *.ts.net one, could resolve anywhere, so names need https.
function urlAllowed(text) {
  let u;
  try { u = new URL(text); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || isTailnetIPv4(host);
}

// What travels. `kind` is 'session' (hook events), 'heartbeat' (the state of
// every session still running on the device) or 'ping' (pairing check).
// Receivers ignore fields they don't know, so a later sender (the board hub's
// runner channel: run_id, fence) can add to it without breaking this one.
function envelope(kind, device, fields = {}, now = Date.now()) {
  return { v: VERSION, kind, device, sentAt: new Date(now).toISOString(), ...fields };
}

// Control, zero-width, line/paragraph separator and bidi characters, so a
// string from another machine can't rearrange, hide or fake what the widget,
// a notification, a log line or a terminal shows.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;
const displayString = (v, max) => (typeof v === 'string' ? v.replace(UNSAFE_CHARS, '').slice(0, max) : '');

module.exports = {
  VERSION, MAX_SKEW_MS, NONCE_TTL_MS, NONCES_PER_DEVICE, MAX_BODY_BYTES, MAX_EVENTS, MAX_HEARTBEAT_SESSIONS, HEADERS, DEVICE_ID, TOKEN, SOURCE,
  validSessionId, validSeq, signingString, sign, signedHeaders, responseString, signResponse, responseAuthentic, safeEqualHex,
  nonceCaches, verify, pairingCode, parsePairingCode, urlAllowed, isTailnetIPv4, envelope, displayString, monoMs,
};
