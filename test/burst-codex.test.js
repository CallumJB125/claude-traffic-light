'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Codex = require('../src/burst-codex.js');
const { isAllowed } = require('../src/burst-client.js');
const { createBurstClient } = require('../src/burst-client.js');
const Ipc = require('../src/burst-ipc.js');
const Spend = require('../src/burst-spend.js');
const { createFakeBurst, stateV019 } = require('./fixtures/fake-burst.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('allow-list: GET /api/codex and /api/coordination?days only; POSTs and other queries rejected', () => {
  assert.ok(isAllowed('GET', '/api/codex'));
  assert.ok(isAllowed('GET', '/api/coordination'));
  assert.ok(isAllowed('GET', '/api/coordination?days=7'));
  for (const [m, p] of [['POST', '/api/codex'], ['POST', '/api/coordination'], ['POST', '/api/coordination-save'], ['POST', '/api/coordination-act'], ['GET', '/api/coordination-act'], ['GET', '/api/codex?x=1'], ['GET', '/api/coordination?session=a']]) assert.equal(isAllowed(m, p), false, `${m} ${p}`);
});

test('normalizeCodex: tolerant of shapes, bounded, null when unrecognisable', () => {
  assert.equal(Codex.normalizeCodex(null), null);
  assert.equal(Codex.normalizeCodex({ hello: 'world' }), null);
  assert.equal(Codex.normalizeCodex([]), null);
  const c = Codex.normalizeCodex({ totals: { requests: 3, usd: 1.25, tokens: 900 }, by_model: [{ model: 'gpt-5-codex', requests: 3, api_equivalent_usd: 1.25 }, { requests: 1 }] });
  assert.equal(c.requests, 3);
  assert.deepEqual(c.groups, [{ key: 'gpt-5-codex', requests: 3, tokens: 0, usd: 1.25 }]);
  assert.equal(Codex.normalizeCodex({ requests: -4, usd: 'x', sessions: [{ session: 's', count: 2 }] }).groups[0].requests, 2);
  assert.equal(Codex.normalizeCodex({ by_model: Array.from({ length: 99 }, (_, i) => ({ key: `m${i}` })) }).groups.length, 20);
  assert.match(Codex.codexView(c).note, /not part of the Claude figures/);
});

test('coordination: who masters what, matched by full or short id; off or errored is absent', () => {
  const raw = { config: { enabled: true }, status: { sessions: [{ id: 'abcdef12-0000', name: 'Fix', masterOf: [], master_of: ['/r/a.js', '/r/b.js'] }], files: [{ path: '/r/a.js', master_name: 'Fix', contributor_names: ['Other'] }, { path: '/r/b.js', master_name: 'Fix' }] } };
  const co = Codex.normalizeCoordination(raw);
  assert.deepEqual(Codex.coordinationFor(co, 'abcdef12-0000'), { masterOf: ['/r/a.js', '/r/b.js'], more: 0, shared: 1 });
  assert.equal(Codex.coordinationFor(co, 'abcdef12').shared, 1);
  assert.equal(Codex.coordinationFor(co, 'zzzzzzzz'), null);
  assert.equal(Codex.coordinationFor(null, 'abcdef12'), null);
  assert.equal(Codex.normalizeCoordination({ config: { enabled: false }, status: { sessions: [], files: [] } }), null);
  assert.equal(Codex.normalizeCoordination({ error: 'x', status: {} }), null);
  assert.equal(Codex.normalizeCoordination('nope'), null);
});

test('context fill: from state.context.sessions; absent gives nothing', () => {
  const fills = Codex.normalizeContextFill({ context: { sessions: [{ session: 's1', context: 150000, compact_at: 300000 }, { session: 's2', context: 5000 }, { session: 's3', context: 0 }, { context: 9 }] } });
  assert.equal(fills.length, 2);
  assert.deepEqual(Codex.contextFor(fills, 's1'), { tokens: 150000, limit: 300000, pct: 50 });
  assert.equal(Codex.contextFor(fills, 's2').pct, null);
  assert.equal(Codex.contextFor(fills, 'nope'), null);
  assert.deepEqual(Codex.normalizeContextFill({}), []);
  assert.equal(Codex.contextFor(undefined, 's1'), null);
});

test('client.codex / coordination read the GET endpoints; a 404 from an old Burst rejects, IPC degrades silently', async () => {
  const fake = await createFakeBurst({ '/api/state': { body: stateV019() }, '/api/codex': { body: { totals: { requests: 2, usd: 0.5 } } } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-cx-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'claude-burst');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
  const client = createBurstClient({ home, platform: 'darwin', inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin } });
  try {
    const d = await client.detect();
    assert.equal(d.kind, 'present');
    assert.deepEqual(d.state.contextFill, []);
    assert.equal((await client.codex()).requests, 2);
    await assert.rejects(client.coordination());
    assert.ok(fake.requests.every((r) => r.method === 'GET'));
  } finally { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); }

  const handlers = {};
  const detect = { kind: 'present', state: { version: '0.19.0', route: 'PRIMARY', active: false, compaction: Spend.normalizeCompaction({}), contextFill: [{ session: 's-1', tokens: 100000, limit: 200000 }] }, capabilities: { usage: true, state: true }, upgrade: null };
  const api = Ipc.register({
    utilityHandle: (ch, allowed, fn) => { handlers[ch] = (e, ...a) => (allowed(e) ? fn(e, ...a) : null); },
    settingsOnly: () => false, usageAllowed: () => true, isMac: true, home: os.tmpdir(), scriptDir: os.tmpdir(), dialog: {}, shell: {},
    client: { detect: async () => detect, adminUrl: () => null, usage: async () => ({ range: '7d', covered: true, totals: {}, byProvider: [], byRepo: [], recent: [] }), codex: async () => { throw Object.assign(new Error('http 404'), { code: 'http', status: 404 }); }, coordination: async () => { throw new Error('x'); } },
  });
  await new Promise((r) => setTimeout(r, 30));
  const r = await handlers['burst:usage']({}, '7d');
  assert.equal(r.codex, null);
  assert.ok(r.view);
  api.enrichSession({ sessionId: 's-1', cwd: '/x' });
  await new Promise((r2) => setTimeout(r2, 30));
  const b = api.enrichSession({ sessionId: 's-1', cwd: '/x' });
  assert.deepEqual(b.context, { tokens: 100000, limit: 200000, pct: 50 });
  assert.equal(b.coordination, undefined);
});
