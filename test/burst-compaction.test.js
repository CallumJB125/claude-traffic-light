'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBurstClient } = require('../src/burst-client.js');
const Ipc = require('../src/burst-ipc.js');
const View = require('../src/burst-view.js');
const Spend = require('../src/burst-spend.js');
const { createFakeBurst, stateV019, pauselessConfig, pauselessRoutes } = require('./fixtures/fake-burst.js');

const BIN = (home) => path.join(home, '.local', 'bin', 'claude-burst');
async function setup(routes) {
  const fake = await createFakeBurst(routes);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-pl-'));
  fs.mkdirSync(path.dirname(BIN(home)), { recursive: true });
  fs.writeFileSync(BIN(home), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
  const inspect = { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => BIN(home) };
  const client = createBurstClient({ home, platform: 'darwin', inspect, timeoutMs: 2000 });
  return { fake, home, client, done: async () => { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}

test('setCompaction: read-modify-write keeps every other field, unknown ones included, and sends the admin header', async () => {
  const h = pauselessRoutes();
  const before = JSON.parse(JSON.stringify(h.config));
  const t = await setup(h.routes);
  await t.client.setCompaction({ enabled: true });
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].headers['x-claude-burst-admin'], '1');
  assert.equal(h.posts[0].headers.host, '127.0.0.1');
  assert.deepEqual(JSON.parse(h.posts[0].body), { ...before, enabled: true });
  assert.deepEqual(Object.keys(JSON.parse(h.posts[0].body)), Object.keys(before));
  await t.done();
});

test('off -> on -> off round trip, and a mode switch changes only mode', async () => {
  const h = pauselessRoutes();
  const original = JSON.parse(JSON.stringify(h.config));
  const t = await setup(h.routes);
  await t.client.setCompaction({ enabled: true });
  assert.equal(h.config.enabled, true);
  await t.client.setCompaction({ enabled: true, mode: 'intelligent' });
  assert.deepEqual(h.config, { ...original, enabled: true, mode: 'intelligent' });
  await t.client.setCompaction({ enabled: false, mode: 'fixed' });
  assert.deepEqual(h.config, original);
  await t.done();
});

test('a 400 from Burst surfaces its text and nothing else is sent', async () => {
  const h = pauselessRoutes({ reject: 'compact_at_tokens must be above floor_tokens' });
  const t = await setup(h.routes);
  await assert.rejects(t.client.setCompaction({ enabled: true }), (e) => e.code === 'http' && e.status === 400 && /above floor_tokens/.test(e.detail));
  await t.done();
});

test('fails closed: unknown shape, bad arguments, untrusted listener', async () => {
  const noCfg = await setup({ '/api/state': { body: { ...stateV019(), context: {} } }, '/api/compaction': () => ({ body: { ok: 'x' } }) });
  await assert.rejects(noCfg.client.setCompaction({ enabled: true }), { code: 'bad_config' });
  assert.ok(!noCfg.fake.requests.some((r) => r.method === 'POST'));
  await noCfg.done();

  const oddMode = pauselessRoutes({ config: pauselessConfig({ mode: 'turbo' }) });
  const t = await setup(oddMode.routes);
  await assert.rejects(t.client.setCompaction({ enabled: true }), { code: 'bad_config' });
  await assert.rejects(t.client.setCompaction({ enabled: 'yes' }), { code: 'bad_request' });
  await assert.rejects(t.client.setCompaction({ enabled: true, mode: 'x' }), { code: 'bad_request' });
  assert.equal(oddMode.posts.length, 0);
  await t.done();

  const h = pauselessRoutes();
  const u = await setup(h.routes);
  const wrong = createBurstClient({ home: u.home, platform: 'darwin', inspect: { launchdPid: async () => 1, listenerPid: async () => 2, exePath: async () => '/x' } });
  await assert.rejects(wrong.setCompaction({ enabled: true }), { code: 'not_present' });
  assert.equal(h.posts.length, 0);
  await u.done();
});

test('the generic request path still refuses POST /api/compaction', async () => {
  const h = pauselessRoutes();
  const t = await setup(h.routes);
  await assert.rejects(t.client.request('POST', '/api/compaction'), { code: 'denied' });
  assert.equal(h.posts.length, 0);
  await t.done();
});

test('view model: pauseless fields, chip tag, hidden when the feature is absent', () => {
  const st = { ...stateV019(), context: { compaction: pauselessConfig({ enabled: true, mode: 'intelligent' }), compaction_stats: { compactions: 9, saved_usd: 12.34, tokens_not_resent: 3700000 } } };
  const pl = Spend.normalizeCompaction(st).pauseless;
  assert.deepEqual(pl, { available: true, enabled: true, mode: 'intelligent', thresholdLabel: 'Smart, from 80k tokens', savedUsd: 12.34, compactions: 9, tokensNotResent: 3700000 });
  const present = (compaction) => ({ kind: 'present', state: { version: '0.19.0', route: 'PRIMARY', active: true, mode: 'base-url', rejected: [], primaryFailures: 0, compaction }, capabilities: {}, upgrade: null });
  const on = View.statusView(present(Spend.normalizeCompaction(st)), { platform: 'darwin' });
  assert.equal(on.compaction.enabled, true);
  assert.equal(on.chip.tag, 'Compaction on');
  const old = View.statusView(present(Spend.normalizeCompaction({ ...stateV019() })), { platform: 'darwin' });
  assert.equal(old.compaction, null);
  assert.equal(old.chip.tag, undefined);
  assert.equal(View.statusView({ kind: 'untrusted', reason: 'x' }, { platform: 'darwin' }).compaction, null);
  assert.equal(View.statusView({ kind: 'present' }, { platform: 'linux' }).compaction, null);
});

test('ipc: turning on needs the confirm, then writes; off never asks; others hidden', async () => {
  const h = pauselessRoutes();
  const t = await setup(h.routes);
  const handlers = {};
  Ipc.register({ utilityHandle: (ch, allowed, fn) => { handlers[ch] = (e, ...a) => (allowed(e) ? fn(e, ...a) : null); }, settingsOnly: (e) => e.settings === true, isMac: true, client: t.client, home: t.home, scriptDir: t.home, dialog: {}, shell: {} });
  await new Promise((r) => setTimeout(r, 100));
  const call = (req, e = { settings: true }) => handlers['burst:set-compaction'](e, req);
  assert.equal(await call({ enabled: true }, {}), null);
  const ask = await call({ enabled: true });
  assert.equal(ask.needsConfirm, true);
  assert.match(ask.text, /subscription tokens/);
  assert.equal(h.posts.length, 0);
  const on = await call({ enabled: true, confirmed: true });
  assert.equal(on.ok, true);
  assert.match(on.note, /own Claude compactor is off/);
  assert.equal(on.view.compaction.enabled, true);
  assert.equal(on.view.chip.tag, 'Compaction on');
  assert.equal((await call({ enabled: true, mode: 'intelligent' })).ok, true);
  const off = await call({ enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.view.compaction.enabled, false);
  assert.equal((await call({ enabled: 'x' })).ok, false);
  h.reject = 'bad window';
  const bad = await call({ enabled: true, confirmed: true });
  assert.match(bad.error, /Burst refused it: bad window/);
  await t.done();
});

test('ipc: nothing to switch when Burst has no compaction setting', async () => {
  const t = await setup({ '/api/state': { body: stateV019() } });
  const handlers = {};
  Ipc.register({ utilityHandle: (ch, allowed, fn) => { handlers[ch] = (e, ...a) => fn(e, ...a); }, settingsOnly: () => true, isMac: true, client: t.client, home: t.home, scriptDir: t.home, dialog: {}, shell: {} });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await handlers['burst:set-compaction']({}, { enabled: true, confirmed: true })).ok, false);
  assert.ok(!t.fake.requests.some((r) => r.method === 'POST'));
  await t.done();
});
