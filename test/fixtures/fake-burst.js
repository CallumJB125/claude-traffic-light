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
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const path = req.url.split('?')[0];
    let r = routes[path];
    if (typeof r === 'function') r = r(req);
    if (!r) { res.statusCode = 404; res.end('not found'); return; }
    const send = () => {
      res.statusCode = r.status || 200;
      res.setHeader('Content-Type', r.type || 'application/json');
      const b = r.body;
      res.end(Buffer.isBuffer(b) || typeof b === 'string' ? b : JSON.stringify(b));
    };
    if (r.delay) setTimeout(send, r.delay); else send();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

module.exports = { createFakeBurst, stateV019, stateV012, upgradeStatus };
