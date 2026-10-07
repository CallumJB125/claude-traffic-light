'use strict';

// Usage optimiser "Route" tab view model from Burst's normalized state and
// /api/settings. Never base_url, keys or keychain names: only whitelisted
// fields are copied, so nothing else can leak through.

const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(v) ? v : 0);

function msUntil(iso, now) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

function chainOf(state, settings) {
  const fromSettings = settings && settings.fallback_chain && typeof settings.fallback_chain === 'object' && !Array.isArray(settings.fallback_chain) ? settings.fallback_chain : null;
  const src = fromSettings || (state.downgrade && state.downgrade.chain) || {};
  const out = {};
  for (const [k, v] of Object.entries(src).slice(0, 20)) if (Array.isArray(v)) out[str(k)] = v.slice(0, 10).map((m) => str(m));
  return out;
}

// state: detect().state (src/burst-client.js normalizeState); settings: scrubbed GET /api/settings or null.
// opts: { now = Date.now() }
function routeView(state, settings, { now = Date.now() } = {}) {
  if (!state || typeof state !== 'object') return null;
  const slot = (s) => ({ provider: str(s && s.provider), model: str(s && s.model) });
  const mf = settings && settings.metered_failover && typeof settings.metered_failover === 'object' ? settings.metered_failover : null;
  return {
    route: state.route === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY',
    overflow: state.overflow === true,
    reason: str(state.reason),
    claim: str(state.claim),
    until: str(state.until),
    untilInMs: msUntil(state.until, now),
    rejected: (Array.isArray(state.rejected) ? state.rejected : []).slice(0, 20).map((r) => ({
      model: str(r && r.model), until: str(r && r.until), fallsBackTo: str(r && r.fallsBackTo), resetInMs: msUntil(r && r.until, now),
    })),
    chain: chainOf(state, settings),
    primaryFailures: num(state.primaryFailures),
    primary: slot(state.primary),
    secondary: { ...slot(state.secondary), ready: state.secondaryReady === true },
    meteredFailover: mf ? { windowSeconds: num(mf.window_seconds), minFailures: num(mf.min_failures), transportErrorMinFailures: num(mf.transport_error_min_failures) } : null,
  };
}

module.exports = { routeView };
