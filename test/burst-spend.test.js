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
    assert.deepEqual(d.state.compaction, { active: true, pauseless: { available: true, enabled: true, mode: 'fixed', thresholdLabel: 'Static', savedUsd: 0, netUsd: null, costUsd: 0, compactions: 0, tokensNotResent: 0, moneyText: '' }, sessions: [{ session: 's-1', compactions: 2, requests: 9, savedTokens: 5000, savedUsd: 1.25, netUsd: 0.75 }] });
    assert.equal(await client.sessionSecondaryUsd('s-1'), 1.5);
    const u = await client.usage({ range: 'bogus' });
    assert.equal(u.byProvider.length, 2);
    assert.ok(fake.requests.some((r) => r.url === '/api/usage?range=7d&limit=200'));
    assert.ok(fake.requests.some((r) => r.url.includes('session=s-1')));
    for (const r of fake.requests) assert.equal(r.method, 'GET');
  } finally { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('normalizeCompaction: not active when Burst compaction is off', () => {
  assert.equal(Spend.normalizeCompaction(compactionState([], false)).active, false);
  assert.deepEqual(Spend.normalizeCompaction({}), { active: false, sessions: [] });
});

const learnedBody = () => ({
  mode: 'intelligent', enabled: true, fixed: 150000, floor: 80000, buffer_percent: 15, delay_minutes: 60, window_days: 14,
  repos: [
    { root: '/Users/me/src/plexiform', name: 'plexiform', threshold: 120000, target: 118000, compactions: 7, cost_usd: 0.4, failures: {}, reason: 'x', in_force: 120000, source: 'learned' },
    { root: '/Users/me/src/other', name: 'other', threshold: 0, compactions: 0, in_force: 0, source: 'off' },
    { root: '/x', name: '', in_force: 5, source: 'learned' },
  ],
});

test('learnedThresholds: names, Compact at in force and why; no roots or learner inputs; null without Burst', () => {
  const v = Spend.learnedThresholds(learnedBody());
  assert.deepEqual(v, { intelligent: true, windowDays: 14, repos: [{ name: 'plexiform', inForce: 120000, source: 'learned', compactions: 7, reason: 'x' }, { name: 'other', inForce: 0, source: 'off', compactions: 0, reason: '' }] });
  assert.doesNotMatch(JSON.stringify(v), /\/Users|cost_usd/);
  assert.equal(Spend.learnedThresholds({ ...learnedBody(), mode: '' }).intelligent, false);
  assert.equal(Spend.learnedThresholds({ repos: [{ name: 'a', source: 'weird', in_force: -1 }] }).repos[0].source, 'fixed');
  assert.equal(Spend.learnedThresholds(null), null);
  assert.equal(Spend.learnedThresholds({}), null);
});

test('learnedThresholds through the fake Burst: one GET to /api/intelligent-compaction', async () => {
  const fake = await createFakeBurst({ '/api/state': { body: compactionState([]) }, '/api/intelligent-compaction': { body: learnedBody() } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-learned-'));
  const bin = path.join(home, '.local', 'bin', 'claude-burst');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
  const client = createBurstClient({ home, platform: 'darwin', inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin } });
  try {
    assert.equal((await client.detect()).kind, 'present');
    const v = Spend.learnedThresholds(await client.intelligentCompaction());
    assert.equal(v.repos.length, 2);
    const hits = fake.requests.filter((r) => r.url === '/api/intelligent-compaction');
    assert.equal(hits.length, 1); assert.equal(hits[0].method, 'GET');
  } finally { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('compaction money: net of the summaries when Burst reports it, a loss reads as a cost, never "$-"', () => {
  const live = { compactions: 9, saved_usd: 0.7476, summary_usd: 1.3778, rewrite_usd: 0.9975, net_usd: -1.6277, tokens_not_resent: 3738000 };
  const p = Spend.normalizeCompaction({ context: { compaction: { enabled: true, mode: 'fixed', compact_at_tokens: 300000 }, compaction_stats: live } }).pauseless;
  assert.equal(p.netUsd, -1.6277);
  assert.equal(p.moneyText, 'Cost about $1.63 more than it saved: $0.75 of tokens not resent, $2.38 to write the summaries.');
  assert.doesNotMatch(p.moneyText, /\$-/);
  assert.match(Spend.compactionMoneyText({ compactions: 2, savedUsd: 3, costUsd: 1, netUsd: 2 }), /^Saved about \$2\.00 after the cost of its summaries/);
  assert.equal(Spend.compactionMoneyText({ compactions: 0 }), '');
});

test('Through Burst says how many requests could not be priced', () => {
  const v = Spend.throughBurstView(Spend.normalizeUsage(usageReport({ totals: { requests: 17533, usd: 218.26, unpriced: 7620 } })));
  assert.equal(v.unpricedRequests, 7620);
  assert.equal(v.totalRequests, 17533);
  assert.equal(Spend.throughBurstView(Spend.normalizeUsage(usageReport())).unpricedRequests, 0);
});
