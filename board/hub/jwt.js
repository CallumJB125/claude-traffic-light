// RS256 id_token verification against a provider's JWKS, shared by Google
// sign-in (identity/oauth.js) and integration identity links (D98). The
// caller fetches the key set (its own fetch, host rules and caps); this file
// only caches keys and checks tokens. Every refusal is a JwtInvalid with no
// detail: callers turn it into their own fixed answer.

import { createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

export class JwtInvalid extends Error {
  constructor() { super('invalid token'); this.name = 'JwtInvalid'; }
}

const SUB_MAX = 255;
const MIN_RSA_BITS = 2048;

/**
 * A JWKS cache. `load()` → the parsed key set ({keys:[jwk]}), throwing when
 * it can't. A set older than ttlMs is refetched (no sooner than retryMs after
 * the last attempt); an unknown kid refetches at most once per kidRefetchMs,
 * so tokens with made-up kids can't make every call a fetch. Concurrent
 * callers share one fetch. A stale set that still knows the kid answers when
 * the refetch fails. Only RSA keys of at least 2048 bits whose `use` (when
 * set) is `sig` and `alg` (when set) is `RS256` are kept.
 */
export function createJwks({ load, now, ttlMs, kidRefetchMs, retryMs = 0 }) {
  let keys = new Map();
  let fetchedAt = -Infinity;
  let triedAt = -Infinity;
  let running = null;

  async function refresh() {
    triedAt = now();
    const doc = await load();
    if (!Array.isArray(doc?.keys)) throw new Error('not a key set');
    const next = new Map();
    for (const jwk of doc.keys) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      // An encryption key or one meant for another alg is never a signing key here.
      if (('use' in jwk && jwk.use !== 'sig') || ('alg' in jwk && jwk.alg !== 'RS256')) continue;
      let key;
      try { key = createPublicKey({ key: jwk, format: 'jwk' }); } catch { continue; }
      if (!(key.asymmetricKeyDetails?.modulusLength >= MIN_RSA_BITS)) continue;
      next.set(jwk.kid, key);
    }
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid) {
    if (running) await running.catch(() => {});
    const t = now();
    const stale = t - fetchedAt >= ttlMs;
    const unknown = !keys.has(kid);
    if ((stale && t - triedAt >= retryMs) || (unknown && t - triedAt >= kidRefetchMs)) {
      running ??= refresh().finally(() => { running = null; });
      try { await running; } catch (e) {
        if (!keys.has(kid) || !Number.isFinite(fetchedAt)) throw e;
      }
    }
    return keys.get(kid) ?? null;
  }

  return { keyFor };
}

const sameText = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * → the claims of a valid token, else throws JwtInvalid (a key-set failure
 * from keyFor propagates as it is). Only RS256 with a kid; `iss` one of
 * `issuers`; `aud` (string or array) includes `audience`, and with several
 * audiences `azp` equals it; `exp > now − skew`; `iat ≤ now + skew`;
 * `nonce` equal (constant time) to a non-empty expected nonce; `sub` a string
 * of 1–255 chars.
 */
export async function verifyRs256(token, { keyFor, issuers, audience, nonce, nowS, skewS = 60 }) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new JwtInvalid();
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw new JwtInvalid(); }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !claims || typeof claims !== 'object') throw new JwtInvalid();
  const key = await keyFor(header.kid);
  if (!key) throw new JwtInvalid();
  if (!cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new JwtInvalid();
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!issuers.includes(claims.iss) || typeof audience !== 'string' || !audience || !auds.includes(audience)) throw new JwtInvalid();
  if (auds.length > 1 && claims.azp !== audience) throw new JwtInvalid();
  if (typeof claims.exp !== 'number' || claims.exp + skewS <= nowS) throw new JwtInvalid();
  if (typeof claims.iat !== 'number' || claims.iat - skewS > nowS) throw new JwtInvalid();
  if (typeof claims.nonce !== 'string' || typeof nonce !== 'string' || !nonce || !sameText(claims.nonce, nonce)) throw new JwtInvalid();
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > SUB_MAX) throw new JwtInvalid();
  return claims;
}

/** A response body as text, refusing more than `max` bytes. */
export async function readCapped(res, max) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > max) throw new Error('provider answer too large');
  if (!res.body?.getReader) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); throw new Error('provider answer too large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
