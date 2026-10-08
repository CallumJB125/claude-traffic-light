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
  assert.deepEqual(Codex.coordinationFor(co, 'abcdef12-0000'), { masterOf: ['/r/a.js', '/r/b.js'], more: 0, shared: 1,
    files: [{ path: '/r/a.js', master: true, others: ['Other'] }, { path: '/r/b.js', master: true, others: [] }] });
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

// WP3: coordination metrics and the Sessions Files column.
const COORD = {
  config: { enabled: true }, installed: true,
  status: {
    sessions: [{ id: 'aaaaaaaa-1111', label: 'A', name: 'Fix login', cwd: '/r', master_of: ['/r/a.js'] }, { id: 'bbbbbbbb-2222', label: 'B', cwd: '/r' }],
    files: [{ path: '/r/a.js', master: 'aaaaaaaa-1111', master_label: 'A', master_name: 'Fix login', contributors: ['bbbbbbbb-2222'], contributor_names: ['Docs'], take_over: true, wanted: 'B' }],
  },
  activity: ['2026-10-07 10:00:00 share /r/a.js'],
  metrics: { days: 7, totals: { shared: 3, refused: 1, held: 2, stopped: 1, errors: 1, bogus: 9 }, unresolved: 1, per_day: [],
    issues: [{ at: '2026-10-06 09:00:00', kind: 'error', text: 'ERROR in pre-tool hook', resolved: true }, { at: '2026-10-07 09:00:00', kind: 'stopped', text: 'B stopped with uncommitted /r/c.js', session: 'bbbbbbbb-2222', files: ['/r/c.js'], pending: ['/r/c.js'], resolved: false }] },
};

test('coordination metrics: window, fixed counters, issues newest first; a contributor sees the file as shared', () => {
  const co = Codex.normalizeCoordination(COORD);
  assert.equal(co.metrics.days, 7);
  assert.deepEqual(co.metrics.totals, { shared: 3, refused: 1, taken: 0, passed: 0, asked: 0, inherited: 0, held: 2, stopped: 1, errors: 1, released: 0 });
  assert.equal(co.metrics.unresolved, 1);
  assert.deepEqual(co.metrics.issues.map((i) => [i.kind, i.resolved, i.pending]), [['stopped', false, ['/r/c.js']], ['error', true, []]]);
  assert.equal(co.files[0].masterId, 'aaaaaaaa-1111');
  assert.equal(co.files[0].takeOver, true);
  assert.ok(!JSON.stringify(co).includes('activity'), 'the raw coord.log tail is not passed on');
  assert.deepEqual(Codex.coordinationFor(co, 'bbbbbbbb-2222'), { masterOf: [], more: 0, shared: 0, files: [{ path: '/r/a.js', master: false, masterName: 'Fix login' }] });
  assert.equal(Codex.normalizeCoordination({ status: { sessions: [], files: [] } }).metrics, null);
});

async function actionHarness(answer) {
  const fake = await createFakeBurst({ '/api/state': { body: stateV019() }, '/api/upgrade-status': { body: {} }, '/api/coordination-act': { body: { ok: 'done' } }, '/api/requests': { body: [] }, '/api/coordination': { body: COORD } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-coord-'));
  const bin = path.join(home, '.local', 'bin', 'claude-burst');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
  const client = createBurstClient({ home, platform: 'darwin', inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin } });
  const handlers = {}, dialogs = [];
  const api = Ipc.register({
    utilityHandle: (c, allowed, f) => { handlers[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); },
    settingsOnly: () => false, sessionsAllowed: (e) => e.from === 'sessions', isMac: true, client, home, shell: {}, scriptDir: '/x',
    dialog: { showMessageBox: async (o) => { dialogs.push(o); return { response: answer }; } },
  });
  await api.refresh(true);
  const posts = () => fake.requests.filter((r) => r.method === 'POST');
  return { handlers, dialogs, posts, done: async () => { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}
const SESSIONS = { from: 'sessions' };

test('Files column actions: Message and Hand on, cancel sends nothing, confirm sends exactly one allow-listed POST', async () => {
  for (const [id, args, body] of [
    ['coord-message', { session: 'bbbbbbbb-2222', message: 'please commit a.js' }, { session: 'bbbbbbbb-2222', message: 'please commit a.js' }],
    ['coord-release', { release: '/r/a.js', session: 'ignored' }, { release: '/r/a.js' }],
  ]) {
    const no = await actionHarness(0);
    assert.deepEqual(await no.handlers['burst-action'](SESSIONS, id, args), { ok: false, cancelled: true });
    assert.equal(no.dialogs.length, 1);
    assert.equal(no.posts().length, 0, `${id} cancel`);
    await no.done();
    const yes = await actionHarness(1);
    assert.equal((await yes.handlers['burst-action'](SESSIONS, id, args)).ok, true);
    assert.equal(yes.posts().length, 1, `${id} confirm`);
    assert.equal(yes.posts()[0].url, '/api/coordination-act');
    assert.deepEqual(JSON.parse(yes.posts()[0].body), body);
    await yes.done();
  }
});

test('coordination view for the Sessions page is the normalized one, and only Sessions may read it', async () => {
  const h = await actionHarness(1);
  try {
    const r = await h.handlers['burst:view'](SESSIONS, 'coordination', { days: 7 });
    assert.equal(r.view.metrics.days, 7);
    assert.ok(Array.isArray(r.view.metrics.issues));
    assert.equal(await h.handlers['burst:view']({ from: 'widget' }, 'coordination', { days: 7 }), null);
    assert.equal(h.posts().length, 0);
  } finally { await h.done(); }
});
