const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../mcp-server.js');
const Snap = require('../src/burst-snapshot.js');

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-burst-'));

const detection = {
  kind: 'present',
  state: {
    version: '0.19.0', route: 'SECONDARY', active: true, overflow: true, reason: 'plan limit', claim: 'five_hour', until: '2026-09-11T14:00:00Z', secondaryReady: true,
    primary: { provider: 'anthropic', model: 'claude-opus', strategy: 's', keyPresent: true }, secondary: { provider: 'openrouter', model: 'glm', keyPresent: true },
    primaryFailures: 2, rejected: [{ model: 'claude-opus', until: '2026-09-11T14:00:00Z', fallsBackTo: 'claude-sonnet' }], apiKey: 'sk-secret',
  },
};
const coordination = { sessions: [{ id: 'sess-aaaa1111', name: 'api', task: 'fix auth', masterOf: ['/w/api/src/auth.js'] }], files: [{ path: '/w/api/src/auth.js', master: 'api', contributors: ['web'] }] };
const requests = { requests: Array.from({ length: 60 }, (_, i) => ({ time: `t${i}`, session_id: i % 2 ? 'sess-bbbb2222' : 'sess-aaaa1111', route: 'openrouter', url: 'https://openrouter.ai/api/v1/x?key=1', model: 'glm', status: 200, latency_ms: 40, input_tokens: 10, output_tokens: 5, api_equivalent_usd: 0.01, prompt: 'SECRET PROMPT' })) };

function write(dir, at = NOW) {
  Snap.writeSnapshot(Snap.snapshotPath(dir), Snap.buildSnapshot({ detection, coordination, requests, now: at }));
}

test('buildSnapshot: whitelist only, requests capped at 50, hosts not URLs', () => {
  const s = Snap.buildSnapshot({ detection, coordination, requests, now: NOW });
  const json = JSON.stringify(s);
  assert.ok(!json.includes('sk-secret') && !json.includes('SECRET PROMPT') && !json.includes('key=1'));
  assert.equal(s.requests.length, 50);
  assert.equal(s.requests[0].host, 'openrouter.ai');
  assert.equal(s.route, 'SECONDARY');
  assert.equal(s.secondary_ready, true);
  assert.deepEqual(Snap.buildSnapshot({ detection: { kind: 'off' }, now: NOW }), { v: 1, at: NOW, present: false });
});

test('boardFacts: limits and coordination masters; empty when Burst is absent', () => {
  const f = Snap.boardFacts(Snap.buildSnapshot({ detection, coordination, requests, now: NOW }));
  assert.equal(f.limits[0].model, 'claude-opus');
  assert.deepEqual(f.coordinationMasters, [{ session: 'sess-aaaa1111', files: 1 }]);
  assert.deepEqual(Snap.boardFacts(null), {});
});

test('buddy_burst_status returns the fixture snapshot', () => {
  const r = root(); write(r);
  const st = M.buddyBurstStatus({ root: r, now: NOW + 5000 });
  assert.equal(st.present, true);
  assert.equal(st.route, 'SECONDARY');
  assert.equal(st.secondaryReady, true);
  assert.equal(st.limits[0].fallsBackTo, 'claude-sonnet');
  assert.equal(st.snapshotAgeSeconds, 5);
});

test('missing or stale snapshot: explicit "Burst not present" on all three tools', () => {
  const none = root();
  const stale = root(); write(stale, NOW - 3 * 60_000);
  for (const r of [none, stale]) {
    for (const fn of [M.buddyBurstStatus, M.buddyBurstCoordination, M.buddyBurstRequests]) {
      assert.deepEqual(fn({ root: r, now: NOW }), { present: false, message: 'Burst not present' });
    }
  }
});

test('buddy_burst_coordination: who masters path X', () => {
  const r = root(); write(r);
  const hit = M.buddyBurstCoordination({ root: r, now: NOW, path: 'src/auth.js' });
  assert.deepEqual(hit.masters.map((m) => m.master), ['api']);
  assert.match(M.buddyBurstCoordination({ root: r, now: NOW, path: 'nope.js' }).message, /No session masters/);
  assert.equal(M.buddyBurstCoordination({ root: r, now: NOW }).sessions.length, 1);
});

test('buddy_burst_requests: session filter and limit', () => {
  const r = root(); write(r);
  const all = M.buddyBurstRequests({ root: r, now: NOW });
  assert.equal(all.count, 20);
  const one = M.buddyBurstRequests({ root: r, now: NOW, session: 'sess-bbbb', limit: 5 });
  assert.equal(one.count, 5);
  assert.ok(one.requests.every((x) => x.session === 'sess-bbbb2222'));
  assert.ok(!JSON.stringify(one).includes('SECRET PROMPT'));
});
