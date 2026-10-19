'use strict';

// Step 0 of the Burst v0.20 integration: capabilities per feature (A1), the
// strict /api/state snapshot (A2) and no hotspot route anywhere (D2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBurstClient, capabilitiesFor, CAPABILITY_NAMES, GET_ALLOW, MUTATE_ALLOW, isAllowed } = require('../src/burst-client.js');
const { createFakeBurst, stateV019, stateV012 } = require('./fixtures/fake-burst.js');
const { testTempDir } = require('./helpers/tmp');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'burst-0.20.36.json'), 'utf8'));
const NEW_FLAGS = ['looseEnds', 'keepAwake', 'mods', 'finder', 'handoffTaken', 'consoleRepair', 'remoteControl', 'intelligentCompaction', 'codex'];
const OLD_FLAGS = ['usage', 'upgradeStatus', 'handoverAudit', 'handoverFile', 'testConnection'];

// The exact snapshot key set. Anything new from /api/state must be added here on purpose.
const SNAPSHOT_KEYS = [
  'active', 'caTrusted', 'claim', 'clientTls', 'compaction', 'configError', 'contextFill', 'downgrade', 'hostsEntry', 'inactiveReason', 'mode',
  'overflow', 'pfHeal', 'primary', 'primaryFailingSince', 'primaryFailures', 'primaryHealth', 'primaryLastError', 'reason', 'rejected',
  'remoteControlExpected', 'route', 'secondary', 'secondaryReady', 'selfHeal', 'until', 'version',
];

const BIN = (home) => path.join(home, '.local', 'bin', 'claude-burst');
function makeHome(adminListen) {
  const home = testTempDir('burst-v020-');
  fs.mkdirSync(path.dirname(BIN(home)), { recursive: true });
  fs.writeFileSync(BIN(home), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: adminListen }));
  return home;
}
async function setup(routes) {
  const fake = await createFakeBurst(routes);
  const home = makeHome(`127.0.0.1:${fake.port}`);
  const inspect = { launchdPid: async () => process.pid, listenerPid: async (p) => (p === fake.port ? process.pid : null), exePath: async () => BIN(home) };
  const client = createBurstClient({ home, platform: 'darwin', inspect, timeoutMs: 2000 });
  return { fake, client, done: async () => { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}
// The real v0.20.36 answers, with the pid swapped for this process so the trust check passes.
const routes020 = () => Object.fromEntries(Object.entries(FIXTURE).map(([p, body]) => [p, { body: p === '/api/state' ? { ...body, pid: process.pid } : body }]));

test('A1: capability flags come from the version floors; 0.19 has none of the 0.20 features, 0.20.36 has all', () => {
  assert.deepEqual(Object.keys(capabilitiesFor('0.20.36')).sort(), [...NEW_FLAGS, ...OLD_FLAGS, 'state'].sort());
  assert.deepEqual(CAPABILITY_NAMES.slice().sort(), Object.keys(capabilitiesFor('x')).sort());
  for (const f of NEW_FLAGS) { assert.equal(capabilitiesFor('0.19.0')[f], false, f); assert.equal(capabilitiesFor('0.19.9')[f], false, f); assert.equal(capabilitiesFor('0.20.0')[f], true, f); assert.equal(capabilitiesFor('0.20.36')[f], true, f); }
  for (const f of OLD_FLAGS) { assert.equal(capabilitiesFor('0.19.0')[f], true, f); assert.equal(capabilitiesFor('0.12.1')[f], false, f); }
  assert.equal(capabilitiesFor('banana').state, false);
});

test('A1: against the fake 0.19 server every new flag is false and /api/loose-ends is never probed', async () => {
  const t = await setup({ '/api/state': { body: stateV019() } });
  const d = await t.client.detect();
  assert.equal(d.kind, 'present');
  for (const f of NEW_FLAGS) assert.equal(d.capabilities[f], false, f);
  assert.ok(!t.fake.requests.some((r) => r.url.startsWith('/api/loose-ends')));
  await t.done();
});

test('A1: against the captured 0.20.36 server every flag is true, the probe runs once, and the snapshot carries the new keys', async () => {
  const t = await setup(routes020());
  const d = await t.client.detect();
  assert.equal(d.kind, 'present');
  assert.equal(d.state.version, '0.20.36');
  for (const f of [...NEW_FLAGS, ...OLD_FLAGS, 'state']) assert.equal(d.capabilities[f], true, f);
  assert.deepEqual(d.state.primaryHealth, { failures: 0, failingSince: '0001-01-01T00:00:00Z', lastAnswer: '2026-10-19T11:12:32.830539+02:00', lastFailure: '0001-01-01T00:00:00Z', lastError: '', networkDown: false });
  assert.equal(d.state.caTrusted, false);
  assert.equal(d.state.hostsEntry, false);
  assert.equal(d.state.remoteControlExpected, false);
  assert.deepEqual(d.state.downgrade, { enabled: true, chain: { 'claude-fable-5': ['claude-opus-5-5'], 'claude-fable-5-1': ['claude-opus-5-5'] } });
  assert.deepEqual(d.upgrade, { canUpgrade: false, upToDate: true, latestVersion: '0.20.36', behind: 0, error: '' });
  await t.client.detect();
  assert.equal(t.fake.requests.filter((r) => r.url === '/api/loose-ends').length, 1, 'probe cached per version');
  const le = await t.client.looseEnds();
  assert.deepEqual(le.stale, { commits: 0, files: 0, stashes: 0 });
  assert.equal((await t.client.mac()).keep_awake.mode, 'off');
  await t.done();
});

test('A1: a 0.20 that answers 404 on /api/loose-ends turns only that flag off', async () => {
  const r = routes020();
  delete r['/api/loose-ends'];
  const t = await setup(r);
  const d = await t.client.detect();
  assert.equal(d.capabilities.looseEnds, false);
  for (const f of NEW_FLAGS.filter((x) => x !== 'looseEnds')) assert.equal(d.capabilities[f], true, f);
  await t.done();
});

test('A2: the snapshot key set is exactly SNAPSHOT_KEYS for 0.12, 0.19 and 0.20.36; nothing else from /api/state leaks', async () => {
  for (const routes of [{ '/api/state': { body: stateV012() } }, { '/api/state': { body: stateV019() } }, routes020()]) {
    const t = await setup(routes);
    const d = await t.client.detect();
    assert.deepEqual(Object.keys(d.state).sort(), SNAPSHOT_KEYS, routes['/api/state'].body.version);
    const j = JSON.stringify(d.state);
    for (const leak of ['settings_base_url', 'log_path', 'install_cmd', 'events', 'gateway', 'totals', 'today', 'handover', '[removed for fixture]', 'bailout']) assert.ok(!j.includes(leak), leak);
    await t.done();
  }
});

test('D2: no hotspot route or key anywhere in the client or the actions', () => {
  for (const f of ['src/burst-client.js', 'src/burst-actions.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/hotspot/i.test(text), `${f} mentions hotspot`);
  }
  for (const p of ['/api/hotspot-password', '/api/hotspot-join']) { assert.ok(!(p in GET_ALLOW), p); assert.equal(isAllowed('GET', p), false, p); }
  for (const m of Object.values(MUTATE_ALLOW)) assert.ok(!/hotspot/i.test(m.path), m.path);
  assert.deepEqual(['/api/loose-ends', '/api/mod-status', '/api/mac', '/api/finder'].map((p) => GET_ALLOW[p]), [[], [], [], []]);
});
