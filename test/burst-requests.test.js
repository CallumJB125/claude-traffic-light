'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRequest, requestsView, historyView } = require('../src/burst-requests.js');

const ev = (over = {}) => ({
  time: '2026-10-07T09:00:00Z', session_id: 'abcdef12-3456', agent_id: 'main', slot: 'secondary', route: 'SECONDARY', model: 'glm-5',
  destination: 'https://api.together.xyz/v1/messages', http_status: 200, duration_ms: 812, input_tokens: 10, cache_read_tokens: 90, output_tokens: 50,
  api_equivalent_usd: 0.0123, note: 'ok', ...over,
});

test('destination is reduced to a host; no path, query or key reaches the row', () => {
  const r = normalizeRequest(ev({ destination: 'https://user:pw@api.together.xyz:8443/v1/messages?key=SECRET' }));
  assert.equal(r.host, 'api.together.xyz:8443');
  assert.ok(!/SECRET|pw|\/v1|destination/.test(JSON.stringify(r)));
  assert.equal(normalizeRequest(ev({ destination: 'not a url' })).host, '');
  assert.equal(normalizeRequest(null), null);
});

test('row fields', () => {
  assert.deepEqual(normalizeRequest(ev()), {
    time: '2026-10-07T09:00:00Z', session: 'abcdef12-3456', agent: 'main', slot: 'secondary', route: 'SECONDARY', host: 'api.together.xyz', model: 'glm-5',
    status: 200, latencyMs: 812, tokensIn: 100, tokensOut: 50, usd: 0.0123, note: 'ok',
  });
  assert.equal(normalizeRequest(ev({ slot: 'weird' })).slot, '');
});

test('requestsView: newest first, capped at the limit, junk dropped', () => {
  const raw = [ev({ time: '2026-10-07T08:00:00Z' }), null, ev({ time: '2026-10-07T10:00:00Z' }), ev({ time: '2026-10-07T09:00:00Z' })];
  const v = requestsView(raw, { limit: 2 });
  assert.deepEqual(v.rows.map((r) => r.time), ['2026-10-07T10:00:00Z', '2026-10-07T09:00:00Z']);
  assert.deepEqual(requestsView(null), { rows: [] });
  assert.equal(requestsView(Array.from({ length: 300 }, () => ev())).rows.length, 200);
});

test('historyView maps days and repos', () => {
  const h = historyView({ days: [{ date: '2026-10-06', primary_usd: 1.5, secondary_usd: 0.25, requests: 40, other: 1 }], repos: [{ repo: 'plexiform', path: '/Users/x/plexiform', usd: 2, saved_usd: 0.5 }] });
  assert.deepEqual(h, { days: [{ day: '2026-10-06', primaryUsd: 1.5, secondaryUsd: 0.25, requests: 40 }], repos: [{ repo: 'plexiform', usd: 2, savedUsd: 0.5 }] });
  assert.deepEqual(historyView(null), { days: [], repos: [] });
});
