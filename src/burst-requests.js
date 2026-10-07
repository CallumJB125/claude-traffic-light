'use strict';

// Usage optimiser "Requests" tab: per-request metadata from /api/requests and
// the daily chart from /api/history. Destinations are reduced to a host.
// WP0 stub: WP2 fills it in.

// one metrics.Event -> { time, session, agent, slot, route, host, model, status, latencyMs, tokensIn, tokensOut, usd, note }
function normalizeRequest(_ev) { return null; }

// scrubbed GET /api/requests -> { rows: [normalizeRequest...] } newest first, at most `limit`.
function requestsView(_raw, _opts = { limit: 200 }) { return { rows: [] }; }

// scrubbed GET /api/history -> { days: [{ day, primaryUsd, secondaryUsd, requests }], repos: [{ repo, usd, savedUsd }] }
function historyView(_raw) { return { days: [], repos: [] }; }

module.exports = { normalizeRequest, requestsView, historyView };
