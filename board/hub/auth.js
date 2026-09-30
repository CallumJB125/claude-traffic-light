// Identity (CONTRACT §4): Cloudflare Access JWT verification (RS256 against
// the team's JWKS, node:crypto only), the loopback-only dev cookie, device
// tokens (sha256 at rest) and HMAC-signed run tokens.

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { HubError } from './db.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
export const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest();

// ── Cloudflare Access ───────────────────────────────────────────────────────

const KID_REFETCH_MIN_MS = 10_000;
const JWKS_TIMEOUT_MS = 10_000;

/**
 * verifier.verify(token) → claims, or throws HubError('UNAUTHENTICATED'), or
 * HubError('ACCESS_UNAVAILABLE') when the JWKS cannot be fetched.
 * JWKS cached; an unknown kid triggers a refetch (at most every 10 s).
 */
export function createAccessVerifier({ team, aud, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const certsUrl = `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const issuer = `https://${team}.cloudflareaccess.com`;
  let keys = new Map();
  let lastFetch = -Infinity;
  let fetchFailed = false;
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    lastFetch = now();
    inflight = (async () => {
      try {
        const res = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
        const body = await res.json();
        const next = new Map();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== 'RSA' || !jwk.kid) continue;
          next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        }
        keys = next;
        fetchFailed = false;
      } catch (e) {
        fetchFailed = true;
        throw e;
      }
    })().finally(() => { inflight = null; });
    return inflight;
  }

  // An unknown kid while the JWKS is unreachable is "can't tell", not "bad
  // token": callers must retry, not give up on a credential that may be fine.
  async function keyFor(kid) {
    if (!keys.has(kid)) {
      if (inflight) await inflight.catch(() => {});
      else if (now() - lastFetch >= KID_REFETCH_MIN_MS) await refresh().catch(() => {});
    }
    if (keys.has(kid)) return keys.get(kid);
    if (fetchFailed) throw new HubError('ACCESS_UNAVAILABLE', 'Access signing keys are unavailable; retry shortly');
    return null;
  }

  async function verify(token) {
    const bad = (m) => new HubError('UNAUTHENTICATED', m);
    if (typeof token !== 'string') throw bad('missing Access assertion');
    const parts = token.split('.');
    if (parts.length !== 3) throw bad('malformed JWT');
    let header;
    let claims;
    try {
      header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
      claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch { throw bad('malformed JWT'); }
    if (header.alg !== 'RS256') throw bad('unsupported alg');
    const key = await keyFor(header.kid);
    if (!key) throw bad('unknown signing key');
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]));
    if (!ok) throw bad('bad signature');
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud)) throw bad('wrong audience');
    const t = now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp <= t) throw bad('expired');
    if (typeof claims.nbf === 'number' && claims.nbf > t + 60) throw bad('not yet valid');
    if (claims.iss && claims.iss !== issuer) throw bad('wrong issuer');
    return claims;
  }

  return { verify, refresh, certsUrl };
}

// ── dev cookie ──────────────────────────────────────────────────────────────

export function devCookieValue(secret, memberId) {
  return `${memberId}.${b64url(hmac(secret, `dev:${memberId}`))}`;
}

export function parseDevCookie(secret, value) {
  if (typeof value !== 'string') return null;
  const i = value.lastIndexOf('.');
  if (i <= 0) return null;
  const id = value.slice(0, i);
  return safeEqual(value.slice(i + 1), b64url(hmac(secret, `dev:${id}`))) ? id : null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ── device + run tokens ─────────────────────────────────────────────────────

export function newDeviceToken() {
  return `bdt_${b64url(randomBytes(32))}`;
}

export function bearer(req) {
  const h = req.headers.authorization;
  const m = /^Bearer\s+(\S+)$/i.exec(h ?? '');
  return m ? m[1] : null;
}

// brt1.<b64url(JSON{c,r,f,e})>.<b64url(HMAC)>
export function mintRunToken(secret, { card_id, run_id, fence, hub_epoch }) {
  const payload = b64url(JSON.stringify({ c: card_id, r: run_id, f: fence, e: hub_epoch }));
  return `brt1.${payload}.${b64url(hmac(secret, payload))}`;
}

export function parseRunToken(secret, token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'brt1') return null;
  if (!safeEqual(parts[2], b64url(hmac(secret, parts[1])))) return null;
  try {
    const p = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    return { card_id: p.c, run_id: p.r, fence: p.f, hub_epoch: p.e };
  } catch { return null; }
}
