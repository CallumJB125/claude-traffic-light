'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTeamHubClient } = require('../src/team-hub-client');
const AT = 1_800_000_000_000;
const REQUEST = '30000000-0000-4000-8000-000000000001';
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = (body, status = 200) => ({ status, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
function fixture(count = 1) {
  const viewer = { id: 'alice', name: 'Alice' };
  const cfg = { at: AT, failed: false, beforeState: null, overrides: {}, shares: Array.from({ length: count }, (_, i) => ({
    id: `${String(i + 1).padStart(8, '0')}-2222-4333-8444-555555555555`,
    session: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    scope: 'interact', expires_at: null, team: { id: 'team', name: 'Team' }, owner: { id: 'bob', name: 'Bob' }, online: true,
  })) };
  const calls = [];
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', viewer, token: () => 'test-token', fetch: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith('/shared')) return json({ shared: cfg.shares });
    if (body.op === 'state') {
      await cfg.beforeState?.(body);
      if (cfg.failed) return json({}, 503);
      return json({ result: { ok: true, state: { session: body.args.session, generation: 1, activeTurn: null, status: 'ready', observed_at: cfg.at,
        provider: { id: 'codex', label: 'Codex' }, capabilities: { newTurn: true, steer: true, interrupt: true }, deliveries: [], ...cfg.overrides } } });
    }
    return json({ result: { ok: true, status: 'acknowledged', delivery: { id: 'receipt', text: body.args.text, state: 'acknowledged', response: '' } } });
  } }, { now: () => cfg.at });
  return { cfg, calls, hub, viewer, reads: () => calls.filter(c => c.body?.op === 'state'), metadata: () => calls.filter(c => c.url.endsWith('/shared')) };
}

test('100 shared sessions refresh metadata every5s but read each passive state at most once per45s', async () => {
  const f = fixture(100);
  const first = await f.hub.sessions(f.viewer, 'team');
  assert.equal(first.length, 100);
  assert.equal(f.reads().length, 100);
  for (let elapsed = 5000; elapsed < 45_000; elapsed += 5000) {
    f.cfg.at = AT + elapsed;
    const rows = await f.hub.sessions(f.viewer, 'team');
    assert.equal(rows.length, 100);
    assert.ok(rows.every(row => row.observed_at === AT), 'cache hit retains the real earlier host receipt');
  }
  assert.equal(f.reads().length, 100, 'no repeated100-share fanout during the45s budget window');
  assert.equal(f.metadata().length, 9, 'authorization metadata stays current');
  f.cfg.at = AT + 45_000;
  const refreshed = await f.hub.sessions(f.viewer, 'team');
  assert.equal(f.reads().length, 200);
  assert.ok(refreshed.every(row => row.observed_at === AT + 45_000));
});

test('selected inspect and action always perform fresh exact reads and update only that cached directory row', async () => {
  const f = fixture(100), target = f.cfg.shares[0];
  await f.hub.sessions(f.viewer, 'team');
  f.cfg.at += 5000;
  const inspected = await f.hub.inspect(f.viewer, 'team', target.id);
  assert.equal(inspected.state.observed_at, AT + 5000);
  assert.equal(f.reads().length, 101);
  const rows = await f.hub.sessions(f.viewer, 'team');
  assert.equal(rows[0].observed_at, AT + 5000);
  assert.ok(rows.slice(1).every(row => row.observed_at === AT));
  assert.equal(f.reads().length, 101);
  f.cfg.at += 1000;
  const acted = await f.hub.act(f.viewer, 'team', target.id, { operation: 'send', generation: 1, turn: null, text: 'Send to the selected session' }, REQUEST);
  assert.equal(acted.status, 'acknowledged');
  assert.equal(f.reads().length, 102, 'an action never trusts the passive cache');
  assert.equal(f.reads().at(-1).body.args.session, target.session);
});

test('concurrent passive directory reads share in-flight state work instead of duplicating fanout', async () => {
  const f = fixture(100); let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.cfg.beforeState = () => gate;
  const first = f.hub.sessions(f.viewer, 'team');
  await tick();
  const second = f.hub.sessions(f.viewer, 'team');
  await tick(); release();
  await Promise.all([first, second]);
  assert.equal(f.reads().length, 100);
  assert.equal(new Set(f.reads().map(c => c.body.args.session)).size, 100);
});

test('revoked shares disappear immediately and a reappearing share cannot reuse the removed cache', async () => {
  const f = fixture(), saved = structuredClone(f.cfg.shares);
  await f.hub.sessions(f.viewer, 'team');
  f.cfg.shares = [];
  assert.deepEqual(await f.hub.sessions(f.viewer, 'team'), []);
  f.cfg.shares = saved;
  await f.hub.sessions(f.viewer, 'team');
  assert.equal(f.reads().length, 2);
});

test('state cache is bound to scope, account principal, team, owner, expiry and exact session', async () => {
  const changes = [
    f => { f.cfg.shares[0].scope = 'watch'; },
    f => { f.viewer.id = 'different-account'; },
    f => { f.cfg.shares[0].team.id = 'other-team'; },
    f => { f.cfg.shares[0].owner.id = 'different-owner'; },
    f => { f.cfg.shares[0].expires_at = new Date(AT + 100_000).toISOString(); },
    f => { f.cfg.shares[0].session = '10000000-0000-4000-8000-999999999999'; },
  ];
  for (const change of changes) {
    const f = fixture();
    await f.hub.sessions(f.viewer, 'team'); change(f);
    await f.hub.sessions(f.viewer, f.cfg.shares[0].team.id);
    assert.equal(f.reads().length, 2, 'authority/target changes require another state read');
    assert.equal(f.reads().at(-1).body.args.session, f.cfg.shares[0].session);
  }
});

test('failed passive refresh retains old provider/report clocks and backs off without fabricating fresh activity', async () => {
  const f = fixture();
  f.cfg.overrides = { reporting: { task: { title: 'Earlier task', source: 'provider', observed_at: AT - 1000, received_at: AT }, input: null, children: [] } };
  await f.hub.sessions(f.viewer, 'team');
  f.cfg.at += 45_000; f.cfg.failed = true;
  const [failed] = await f.hub.sessions(f.viewer, 'team');
  assert.equal(failed.observed_at, AT);
  assert.equal(failed.task_observed_at, AT - 1000);
  f.cfg.at += 5000;
  const [cachedFailure] = await f.hub.sessions(f.viewer, 'team');
  assert.equal(cachedFailure.observed_at, AT);
  assert.equal(f.reads().length, 2, 'failed background reads do not repeat every5s');
  f.cfg.at += 40_000; f.cfg.failed = false;
  await f.hub.sessions(f.viewer, 'team');
  assert.equal(f.reads().length, 3);
});

test('cached input reports expire using their own clock during the passive cache window', async () => {
  const f = fixture();
  f.cfg.overrides = { input_needed: true, reporting: { task: null, input: { needed: true, source: 'provider', observed_at: AT - 89_000, received_at: AT }, children: [] } };
  assert.equal((await f.hub.sessions(f.viewer, 'team'))[0].input_needed, true);
  f.cfg.at += 2000;
  const [expired] = await f.hub.sessions(f.viewer, 'team');
  assert.equal(expired.input_needed, false);
  assert.equal(expired.input_reported_needed, true);
  assert.equal(expired.input_observed_at, AT - 89_000);
  assert.equal(f.reads().length, 1);
});

test('late passive read cannot overwrite a newer exact inspection in the directory cache', async () => {
  const f = fixture(); let release, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.cfg.beforeState = () => ++count === 1 ? gate : undefined;
  const pending = f.hub.sessions(f.viewer, 'team');
  await tick();
  f.cfg.at += 5000;
  const exact = await f.hub.inspect(f.viewer, 'team', f.cfg.shares[0].id);
  assert.equal(exact.state.observed_at, AT + 5000);
  // The earlier request's answer was delayed on the wire.
  f.cfg.overrides.observed_at = AT; release();
  const [first] = await pending;
  assert.equal(first.observed_at, AT + 5000);
  const [again] = await f.hub.sessions(f.viewer, 'team');
  assert.equal(again.observed_at, AT + 5000);
  assert.equal(f.reads().length, 2);
});
