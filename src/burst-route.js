'use strict';

// Usage optimiser "Route" tab view model from Burst's normalized state and
// /api/settings. Never base_url, keys or keychain names.
// WP0 stub: WP2 fills it in.

// state: detect().state (src/burst-client.js normalizeState); settings: scrubbed GET /api/settings or null.
// -> { route, overflow, reason, claim, until, untilInMs, rejected: [{ model, until, fallsBackTo, resetInMs }],
//      chain: { model: [models] }, primaryFailures, primary: { provider, model }, secondary: { provider, model, ready },
//      meteredFailover } | null
// opts: { now = Date.now() }
function routeView(_state, _settings, _opts = {}) { return null; }

module.exports = { routeView };
