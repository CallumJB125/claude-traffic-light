'use strict';
// T4d teammate side: a watch share the owner has allowed me to send in reads as interact until the allowance ends
// (the earlier of it and the share's own end), says so, and offers no Propose.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTeamHubClient } = require('../src/team-hub-client');
const SharedView = require('../src/shared-thread-view');

const NOW = 1_800_000_000_000, UUID1 = '11111111-1111-4111-8111-111111111111', SESS = '33333333-3333-4333-8333-333333333333';
const iso = (ms) => new Date(ms).toISOString();
async function entries(row) {
  const json = (status, body) => ({ status, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
  const fetch = async (url) => (url.endsWith('/shared') ? json(200, { shared: [{ id: UUID1, session: SESS, team: { id: 'team-1', name: 'One' }, owner: { id: 'u-bob', name: 'Bob' }, online: true, ...row }] }) : json(404, {}));
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', viewerId: 'u-ana', token: () => 'tok', fetch }, { now: () => NOW, pollMs: 100000, timeoutMs: 500, deadlineMs: 1000 });
  const got = await hub.sharedEntries(hub.viewer());
  return got.teams[0].entries[0];
}

test('T4d client: a live allowance on a watch share reads as interact until the earlier end; absent, expired or on interact it changes nothing', async () => {
  const live = await entries({ scope: 'watch', allowance: { expires_at: iso(NOW + 600_000) }, expires_at: null });
  assert.deepEqual([live.share.scope, live.share.expiresAt], ['interact', iso(NOW + 600_000)]);
  const capped = await entries({ scope: 'watch', allowance: { expires_at: iso(NOW + 600_000) }, expires_at: iso(NOW + 60_000) });
  assert.equal(capped.share.expiresAt, iso(NOW + 60_000), 'never past the share\'s own end');
  for (const row of [{ scope: 'watch' }, { scope: 'watch', allowance: { expires_at: iso(NOW - 1) } }, { scope: 'watch', allowance: { expires_at: 'soon' } }, { scope: 'watch', allowance: 5 }]) {
    assert.equal((await entries(row)).share.scope, 'watch', JSON.stringify(row));
  }
  const interact = await entries({ scope: 'interact', allowance: { expires_at: iso(NOW + 600_000) }, expires_at: null });
  assert.equal(interact.share.scope, 'interact'); assert.equal(interact.share.expiresAt, null, 'an interact share ignores an allowance');
});

test('T4d view: via allowance says so in the header and removes Propose; a real interact share keeps Propose', () => {
  const state = { session: SESS, status: 'ready', generation: 1, activeTurn: null, provider: { label: 'Codex' }, capabilities: { newTurn: true, steer: true, interrupt: true } };
  const route = { ownerName: 'Bob', fake: false };
  const a = SharedView.project({ state, share: { scope: 'interact', expiresAt: iso(NOW + 1000), via: 'allowance' }, route, now: NOW });
  assert.equal(a.header.via, 'allowance'); assert.equal(a.controls.propose.available, false); assert.equal(a.controls.send.available, true);
  const b = SharedView.project({ state, share: { scope: 'interact', expiresAt: null }, route, now: NOW });
  assert.equal(b.header.via, null); assert.equal(b.controls.propose.available, true);
  const c = SharedView.project({ state, share: { scope: 'watch', via: 'allowance' }, route, now: NOW });
  assert.equal(c.header.via, null, 'only an interact reading can be via an allowance');
});
