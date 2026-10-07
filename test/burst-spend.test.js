'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Spend = require('../src/burst-spend.js');
const { createBurstClient } = require('../src/burst-client.js');
const { createFakeBurst, usageReport, compactionState } = require('./fixtures/fake-burst.js');

test('Through Burst: secondary spend stands alone, source named, plan traffic is a count never dollars', () => {
  const v = Spend.throughBurstView(Spend.normalizeUsage(usageReport()));
  assert.equal(v.secondaryUsd, 1.5);
  assert.equal(v.secondaryRequests, 2);
  assert.deepEqual(v.providers.map((p) => p.key), ['together']);
  assert.equal(v.planRequests, 4);
  assert.match(v.source, /Claude Burst gateway log/);
  assert.match(v.note, /never added/);
  // The Claude plan's 6 USD (and the 7.5 total) must not leak into the shown spend.
  assert.ok(!JSON.stringify(v).includes('7.5') && !JSON.stringify(v).match(/"usd":6/));
  assert.deepEqual(v.repos, [{ key: 'plexiform', usd: 1.5 }]);
});

test('no secondary traffic: empty view; garbage input is bounded', () => {
  assert.equal(Spend.throughBurstView(Spend.normalizeUsage(usageReport({ by_provider: [{ key: 'anthropic', requests: 1, usd: 2 }], recent: [] }))).empty, true);
  const u = Spend.normalizeUsage({ by_provider: [{ key: 'x', usd: -5, requests: 'a' }], recent: 'nope', totals: null });
  assert.equal(u.byProvider[0].usd, 0);
  assert.deepEqual(u.recent, []);
});

test('per-session overflow comes only from secondary rows (no double counting with the Claude figure)', () => {
  const u = Spend.normalizeUsage(usageReport());
  assert.deepEqual(Spend.secondaryBySession(u), { 's-1': 1.5 });
  assert.equal(Spend.secondaryUsdOf(u), 1.5);
});

test('client.usage and compaction stats come from the fake Burst, GET only, normalized', async () => {
  const fake = await createFakeBurst({ '/api/usage': { body: usageReport() }, '/api/state': { body: compactionState([{ session: 's-1', compactions: 2, requests: 9, saved_tokens: 5000, saved_usd: 1.25, net_usd: 0.75, secret: 'x' }]) } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-spend-'));
  const bin = path.join(home, '.local', 'bin', 'claude-burst');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
  const client = createBurstClient({ home, platform: 'darwin', inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin } });
  try {
    const d = await client.detect();
    assert.equal(d.kind, 'present');
    assert.deepEqual(d.state.compaction, { active: true, pauseless: { available: true, enabled: true, mode: 'fixed', thresholdLabel: 'Static', savedUsd: 0, compactions: 0, tokensNotResent: 0 }, sessions: [{ session: 's-1', compactions: 2, requests: 9, savedTokens: 5000, savedUsd: 1.25, netUsd: 0.75 }] });
    assert.equal(await client.sessionSecondaryUsd('s-1'), 1.5);
    const u = await client.usage({ range: 'bogus' });
    assert.equal(u.byProvider.length, 2);
    assert.ok(fake.requests.some((r) => r.url === '/api/usage?range=7d&limit=200'));
    assert.ok(fake.requests.some((r) => r.url.includes('session=s-1')));
    for (const r of fake.requests) assert.equal(r.method, 'GET');
  } finally { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('Burst compaction forces Plexiform\'s own Claude compactor off, others untouched', () => {
  const Compaction = require('../src/compaction.js');
  const on = Compaction.normalizeSettings({ enabled: true, providers: { claude: true, codex: true } });
  const forced = Spend.withBurstCompaction(on, true);
  assert.equal(forced.providers.claude, false);
  assert.equal(forced.providers.codex, true);
  assert.equal(Compaction.shouldCompact({ settings: forced, provider: 'claude', contextTokens: 9000, window: 10000, turns: 5 }).reason, 'off');
  assert.equal(Compaction.shouldCompact({ settings: on, provider: 'claude', contextTokens: 9000, window: 10000, turns: 5 }).go, true);
  assert.equal(Spend.withBurstCompaction(on, false), on);
  assert.equal(Spend.COMPACTION_NOTE, 'Burst is compacting Claude sessions');
});

test('normalizeCompaction: not active when Burst compaction is off', () => {
  assert.equal(Spend.normalizeCompaction(compactionState([], false)).active, false);
  assert.deepEqual(Spend.normalizeCompaction({}), { active: false, sessions: [] });
});
