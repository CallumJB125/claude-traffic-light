'use strict';

// A fake Claude Burst admin server on 127.0.0.1:0. Shapes follow claude-burst
// internal/admin (stateResponse, upgradeStatus, testConnectionResponse), v0.19.
const http = require('node:http');

const stateV019 = (over = {}) => ({
  version: '0.19.0', pid: process.pid, route: 'PRIMARY', overflow: false, gateway: '127.0.0.1:7777',
  primary: { provider: 'anthropic' }, secondary: { provider: 'together', key_present: true },
  intercept: { mode: 'base-url', host: '', ca_trusted: false, hosts_entry: false, remote_control_expected: false, settings_base_url: 'http://127.0.0.1:7777', active: true },
  totals: {}, today: {}, downgrade: { enabled: true }, context: {}, handover: {},
  primary_health: { last_answer: '2026-10-06T10:00:00Z', failures: 0 }, secondary_ready: true,
  ...over,
});
const stateV012 = () => { const s = stateV019(); s.version = '0.12.1'; delete s.primary_health; delete s.secondary_ready; return s; };
const upgradeStatus = (over = {}) => ({ running_version: '0.19.0', latest_version: '0.20.0', behind: 3, up_to_date: false, can_upgrade: true, ...over });

// routes: path -> { status, body (object|string|Buffer), delay, type } | function(req) -> same
function createFakeBurst(routes = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  const handle = (req, res, body) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const path = req.url.split('?')[0];
    let r = routes[path];
    if (typeof r === 'function') r = r(req, body);
    if (!r) { res.statusCode = 404; res.end('not found'); return; }
    const send = () => {
      res.statusCode = r.status || 200;
      res.setHeader('Content-Type', r.type || 'application/json');
      const b = r.body;
      res.end(Buffer.isBuffer(b) || typeof b === 'string' ? b : JSON.stringify(b));
    };
    if (r.delay) setTimeout(send, r.delay); else send();
  };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

// /api/usage as claude-burst metrics.UsageReport: rows carry api_equivalent_usd, route and slot.
const usageReport = (over = {}) => ({
  range: '7d', covered: true, totals: { requests: 6, usd: 7.5, unpriced: 0 },
  by_provider: [{ key: 'anthropic', requests: 4, errors: 0, tokens: 9000, usd: 6 }, { key: 'together', requests: 2, errors: 0, tokens: 3000, usd: 1.5 }],
  by_repo: [{ key: 'plexiform', requests: 6, errors: 0, tokens: 12000, usd: 7.5 }],
  recent: [
    { time: '2026-10-06T09:00:00Z', session_id: 's-1', route: 'together', slot: 'secondary', provider: 'together', repo: 'plexiform', api_equivalent_usd: 1, result: 'ok' },
    { time: '2026-10-06T09:01:00Z', session_id: 's-1', route: 'together', slot: 'secondary', provider: 'together', repo: 'plexiform', api_equivalent_usd: 0.5, result: 'ok' },
    { time: '2026-10-06T08:00:00Z', session_id: 's-1', route: 'anthropic', slot: 'primary', provider: 'anthropic', repo: 'plexiform', api_equivalent_usd: 6, result: 'ok' },
  ],
  ...over,
});
const compactionState = (sessions = [], enabled = true) => ({ ...stateV019(), context: { applicable: true, compaction: { enabled }, compaction_stats: { sessions } } });

// Stateful /api/state + POST /api/compaction: replaces the whole config like Burst does, or answers `reject` as 400 text.
const pauselessConfig = (over = {}) => ({ enabled: false, compact_at_tokens: 150000, warn_at_percent: 80, window_minutes: 60, mid_turn: true, mode: 'fixed', floor_tokens: 80000, buffer_percent: 15, future_field: { nested: [1, 2.5, 'x'] }, ...over });
function pauselessRoutes({ config = pauselessConfig(), stats = { compactions: 9, summary_usd: 0.4, rewrite_usd: 0.1, compacted_requests: 40, tokens_not_resent: 3700000, saved_usd: 12.34 }, reject = null } = {}) {
  const h = { config, posts: [], reject };
  h.routes = {
    '/api/state': () => ({ body: { ...stateV019(), context: { applicable: true, compaction: h.config, compaction_stats: stats } } }),
    '/api/compaction': (req, body) => {
      h.posts.push({ headers: req.headers, body });
      if (h.reject) return { status: 400, type: 'text/plain', body: h.reject };
      h.config = JSON.parse(body);
      return { body: { ok: 'compaction updated' } };
    },
  };
  return h;
}

module.exports = { pauselessConfig, pauselessRoutes, createFakeBurst, stateV019, stateV012, upgradeStatus, usageReport, compactionState };
