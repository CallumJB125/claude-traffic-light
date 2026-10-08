'use strict';

// Usage optimiser "Requests" tab: per-request metadata from /api/requests and
// the daily chart from /api/history. Destinations are reduced to a host.

const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(v) ? v : 0);

function hostOf(dest) {
  if (typeof dest !== 'string' || !dest) return '';
  try { return new URL(dest).host; } catch { return ''; }
}

// one metrics.Event -> { time, session, agent, slot, route, host, model, status, latencyMs, tokensIn, tokensOut, usd, note }
function normalizeRequest(ev) {
  if (!ev || typeof ev !== 'object') return null;
  return {
    time: str(ev.time, 40),
    session: str(ev.session_id, 200),
    agent: str(ev.agent_id, 100),
    slot: ev.slot === 'primary' || ev.slot === 'secondary' ? ev.slot : '',
    route: str(ev.route, 40),
    host: hostOf(ev.destination),
    model: str(ev.model, 100) || str(ev.requested_model, 100),
    status: num(ev.http_status),
    latencyMs: num(ev.duration_ms),
    tokensIn: num(ev.input_tokens) + num(ev.cache_read_tokens) + num(ev.cache_write_tokens),
    tokensOut: num(ev.output_tokens),
    usd: num(ev.api_equivalent_usd),
    note: str(ev.note, 300),
  };
}

// scrubbed GET /api/requests -> { rows } newest first, at most `limit`.
function requestsView(raw, { limit = 200 } = {}) {
  const rows = (Array.isArray(raw) ? raw : []).map(normalizeRequest).filter(Boolean);
  rows.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return { rows: rows.slice(0, Math.max(0, limit)) };
}

// scrubbed GET /api/history -> { days: [{ day, primaryUsd, secondaryUsd, requests }], repos: [{ repo, usd, savedUsd }] }
function historyView(raw) {
  const h = raw && typeof raw === 'object' ? raw : {};
  return {
    days: (Array.isArray(h.days) ? h.days : []).slice(0, 90).map((d) => ({
      day: str(d && d.date, 10), primaryUsd: num(d && d.primary_usd), secondaryUsd: num(d && d.secondary_usd), requests: num(d && d.requests),
    })),
    repos: (Array.isArray(h.repos) ? h.repos : []).slice(0, 50).map((r) => ({ repo: str(r && r.repo, 100), usd: num(r && r.usd), savedUsd: num(r && r.saved_usd) })),
  };
}

module.exports = { normalizeRequest, requestsView, historyView };
