// Cloudflare Turnstile (optional, BOARD_TURNSTILE_SITE_KEY + BOARD_TURNSTILE_SECRET):
// the human check a browser passes before an email code may make a new account.
// Only the token goes to Cloudflare (no address, no IP); a configured hub that
// cannot reach it refuses rather than letting the start through.

import { HubError } from '../db.js';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_ACTION = 'email-signin';
const SITEVERIFY = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;
const TIMEOUT_MS = 5_000;
const MAX_TOKEN = 2048;

const refused = () => new HubError('FORBIDDEN', 'the human check did not pass: try it again', { reason: 'human_check' });

export function createTurnstile(cfg, { fetchImpl = globalThis.fetch } = {}) { // privacy-flow: hub-turnstile
  if (!cfg.turnstileSiteKey || !cfg.turnstileSecret) return null;
  const secret = cfg.turnstileSecret;
  const hostname = cfg.publicUrl ? new URL(cfg.publicUrl).hostname : null;
  return {
    siteKey: cfg.turnstileSiteKey,
    async verify(token) {
      if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) throw refused();
      let out = null;
      try {
        const res = await fetchImpl(SITEVERIFY, { // privacy-flow: hub-turnstile
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret, response: token }).toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        out = res.ok ? await res.json() : null;
      } catch {
        out = null;
      }
      if (typeof out?.success !== 'boolean') throw new HubError('PROVIDER_UNAVAILABLE', 'the human check could not be reached: try again shortly');
      if (!out.success || out.action !== TURNSTILE_ACTION || (hostname && out.hostname !== hostname)) throw refused();
    },
  };
}
