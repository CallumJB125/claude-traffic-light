// LOCAL / DISPOSABLE PROOF ONLY — not production account acceptance.
// Team session sharing over an in-process accounts-mode hub on a loopback
// temp port: Alice's Mac hosts sessions backed by the FAKE codex app-server
// (test/fixtures/fake-codex-app-server.js) and shares one with the seeded
// dev team, where Bob is a member; Carol is in no team of Alice's. Every
// device is a real desktop device token from the email sign-in flow. No real
// provider, Cloudflare or deployed hub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { startAccounts } from './accounts-helpers.js';
import { createLogger } from '../log.js';

const require = createRequire(import.meta.url);
const { spawnProviderFixture } = require('../../../test/helpers/provider-fixture-spawn');
const { createRemoteInteractionHost } = require('../../../src/remote-interaction.js');
const { createInteractionHub } = require('../../../src/session-interaction.js');
const { createCodexAppServer } = require('../../../src/codex-app-server.js');
const { createTeamHubClient: createReportingTeamHubClient } = require('../../../src/team-hub-client.js');
const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'fake-codex-app-server.js');

const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };
const rid = () => crypto.randomUUID();

async function rig() {
  const lines = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  const h = await startAccounts({ log });
  const signIn = async (email, name) => {
    const r = await h.signIn(email, { device_name: name });
    assert.equal(r.status, 200, r.text);
    return { token: r.body.device_token, device: r.body.device_id, user: r.body.user.id };
  };
  const macA = await signIn('alice@dev.local', 'Alice Mac');
  const winA = await signIn('alice@dev.local', 'Alice Windows');
  const bob = await signIn('bob@dev.local', 'Bob Phone');
  const carol = await signIn('carol@dev.local', 'Carol Windows');
  const adapter = createCodexAppServer({ bin: FAKE, spawn: spawnProviderFixture });
  // A separate "Overview" hub on the same Mac: its sessions are reachable only once shared.
  const overview = createInteractionHub({ adapters: { codex: createCodexAppServer({ bin: FAKE, spawn: spawnProviderFixture }) }, boardCurrent: (b) => b === 'board:x', now: () => h.clock.wall() });
  // More hubs a test may add (actor 'extra:<i>'), reachable only once shared, like Overview's.
  const extra = [];
  const mac = createRemoteInteractionHost({
    userId: macA.user, adapters: { codex: adapter }, boardCurrent: (b) => b === null, now: () => h.clock.wall(),
    sharedTarget: (session) => {
      if (overview.state({ session }, 'overview:1:1')) return { hub: overview, actor: 'overview:1:1' };
      for (let i = 0; i < extra.length; i++) if (extra[i].state({ session }, `extra:${i}`)) return { hub: extra[i], actor: `extra:${i}` };
      return null;
    },
  });
  const st = await mac.enable({ baseUrl: h.base, token: macA.token, WebSocket });
  assert.equal(st.state, 'connected');
  const launch = async () => (await mac.hub.launch({ provider: 'codex' }, mac.actor)).state;
  // Model operation ordering explicitly: strict share-time privacy suppresses
  // messages in an indistinguishable same-millisecond boundary.
  const ownerSend = (s, text) => { h.clock.advance(1); return mac.hub.send({ session: s.session, generation: s.generation, text }, mac.actor); };
  const call = (dev, share, op, args, requestId = rid()) => { if (op === 'send') h.clock.advance(1); return h.call('POST', `/api/interaction/v1/shared/${share}/call`, { token: dev.token, body: { request_id: requestId, op, args } }); };
  const shared = (dev) => h.call('GET', '/api/interaction/v1/shared', { token: dev.token });
  const bobName = h.db.get('SELECT display_name AS n FROM users WHERE id = ?', bob.user).n;
  // Puts a signed-in user straight into a team with a role.
  let joined = 0;
  const join = (dev, role = 'member', org = h.ids.org) => h.db.insert('members', { id: crypto.randomUUID(), org_id: org, user_id: dev.user, github_id: -(++joined) - 1000, github_login: `~email:${dev.user}`, email: `${dev.user}@join.local`, display_name: 'Joined', role, created_at: h.hub.iso() });
  // A relay frame as the hub would forward it for `user` on `share`.
  const frame = (op, args, share, user, sh = {}) => ({ type: 'relay.request', id: rid(), rid: rid(), user: macA.user, from: 'hub-forwarded', op, args,
    share: { id: share.id, team: share.team.id, user: user.user, name: 'x', scope: share.scope, ...sh } });
  const texts = (res) => res.body.result.state.deliveries.map((d) => d.text);
  return {
    h, lines, macA, winA, bob, carol, mac, adapter, overview, extra, launch, ownerSend, call, shared, bobName, org: h.ids.org, signIn, join, frame, texts,
    async close() { mac.close(); overview.stopAll(); await h.close(); },
  };
}


// ── T4d: Allow ‹teammate› to send ──────────────────────────────────────────────────────────────────────────
const SEND = (s, text = 'hello from bob') => ({ session: s.session, generation: s.generation, text });
const put = (r, share, user, secs, dev = r.macA) => r.h.call('PUT', `/api/interaction/v1/shares/${share}/allowances/${user}`, { token: dev.token, body: { expires_in_s: secs } });
const del = (r, share, user, dev = r.macA) => r.h.call('DELETE', `/api/interaction/v1/shares/${share}/allowances/${user}`, { token: dev.token, body: {} });
const rows = (r, share) => r.h.db.all('SELECT user_id, expires_at FROM interaction_allowances WHERE share_id = ?', share);
async function watchShare(r, opts = {}) {
  const s = await r.launch(), out = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch', ...opts });
  assert.equal(out.ok, true, JSON.stringify(out));
  return { s, share: out.share };
}

test('T4d: an allowed teammate sends, steers and stops on a WATCH share until the time ends; others and the base scope are unchanged', async () => {
  const r = await rig();
  try {
    const { s, share } = await watchShare(r);
    assert.equal(share.allowOk, true, 'the hub advertises allowances');
    assert.equal((await r.call(r.bob, share.id, 'send', SEND(s))).status, 403, 'watch share: no sending before an allowance');
    const frames = [], orig = r.h.hub.interactionShares.relay.dispatch.bind(r.h.hub.interactionShares.relay);
    r.h.hub.interactionShares.relay.dispatch = (host, frame, unburn) => { frames.push(frame); return orig(host, frame, unburn); };
    const granted = await r.mac.grantAllowance({ share: share.id, user: r.bob.user, seconds: 1800 });
    assert.equal(granted.ok, true, JSON.stringify(granted));
    const bobMember = granted.share.members.find((m) => m.id === r.bob.user);
    assert.equal(bobMember.canSend, true); assert.ok(bobMember.allowedUntil > r.h.clock.wall());
    const res = await r.call(r.bob, share.id, 'send', SEND(s)); assert.equal(res.status, 200, res.text);
    assert.deepEqual(r.texts(res), ['hello from bob']);
    // S2: the allowance key rides only on send/interrupt frames, never on reads.
    await r.call(r.bob, share.id, 'state', { session: s.session });
    const kinds = frames.map((f) => [f.op, f.share.allowance_until !== undefined]);
    assert.deepEqual(kinds.filter(([op]) => op === 'state'), [['state', false]]);
    assert.deepEqual(kinds.filter(([op]) => op === 'send'), [['send', true]]);
    // Base scope stays 'watch' in the teammate's list; the allowance is reported next to it, for an acting role only.
    const mine = (await r.shared(r.bob)).body.shared.find((x) => x.id === share.id);
    assert.equal(mine.scope, 'watch'); assert.ok(mine.allowance.expires_at);
    // Someone else on the team is still watch-only; a stranger learns nothing.
    assert.equal((await r.call(r.carol, share.id, 'send', SEND(s))).status, 404);
    // The time box ends it, without anyone acting.
    r.h.clock.advance(1800 * 1000 + 1);
    assert.equal((await r.call(r.bob, share.id, 'send', SEND(s))).status, 403);
    assert.equal((await r.shared(r.bob)).body.shared.find((x) => x.id === share.id).allowance, undefined);
    assert.equal((await r.mac.listShares()).shares[0].members.find((m) => m.id === r.bob.user).canSend, false);
  } finally { await r.close(); }
});

test('T4d M1: an allowance is not a proposal right (proposals need a real interact share)', async () => {
  const r = await rig();
  try {
    const { s, share } = await watchShare(r);
    assert.equal((await r.mac.grantAllowance({ share: share.id, user: r.bob.user, seconds: 900 })).ok, true);
    const body = { id: rid(), decision: rid(), version: 1, generation: s.generation, title: 'Reviewed audit', text: 'Report READY without editing anything.' };
    assert.equal((await r.h.call('POST', `/api/interaction/v1/shared/${share.id}/proposals`, { token: r.bob.token, body })).status, 403);
    assert.equal(r.h.db.get('SELECT COUNT(*) AS n FROM interaction_proposals').n, 0);
  } finally { await r.close(); }
});

test('T4d hub guards: owner host device only, watch shares only, acting roles only, bounds, share expiry cap, replace, idempotent revoke', async () => {
  const r = await rig();
  try {
    const { s, share } = await watchShare(r, { expiresInS: 600 });
    assert.equal((await put(r, share.id, r.bob.user, 900, r.winA)).status, 403, 'a non-host device of the owner');
    assert.equal((await put(r, share.id, r.bob.user, 900, r.bob)).status, 403, 'a teammate');
    for (const bad of [59, 14401, 1.5, '900', null]) assert.equal((await put(r, share.id, r.bob.user, bad)).status, 400, String(bad));
    assert.equal((await r.h.call('PUT', `/api/interaction/v1/shares/${share.id}/allowances/${r.bob.user}`, { token: r.macA.token, body: { expires_in_s: 900, extra: 1 } })).status, 400);
    assert.equal((await put(r, share.id, r.macA.user, 900)).status, 404, 'never the owner');
    assert.equal((await put(r, share.id, crypto.randomUUID(), 900)).status, 404, 'not a member');
    r.join(r.carol, 'viewer');
    assert.equal((await put(r, share.id, r.carol.user, 900)).status, 404, 'a viewer role is never allowed');
    const ok = await put(r, share.id, r.bob.user, 14400); assert.equal(ok.status, 200, ok.text);
    assert.ok(Date.parse(ok.body.allowance.expires_at) <= Date.parse(r.h.db.get('SELECT expires_at AS e FROM interaction_shares WHERE id = ?', share.id).e), 'capped at the share\'s own end');
    const short = await put(r, share.id, r.bob.user, 60); assert.equal(short.status, 200);
    assert.equal(rows(r, share.id).length, 1, 'a second grant replaces the first');
    const d1 = await del(r, share.id, r.bob.user); assert.equal(d1.status, 200, d1.text); const d2 = await del(r, share.id, r.bob.user); assert.equal(d2.status, 200, d2.text);
    assert.equal(rows(r, share.id).length, 0);
    assert.equal((await del(r, share.id, r.bob.user, r.bob)).status, 403);
    // An interact share needs none.
    const t = await r.launch(), interact = (await r.mac.shareSession({ session: t.session, team: r.org, scope: 'interact' })).share;
    assert.equal((await put(r, interact.id, r.bob.user, 900)).status, 400);
    void s;
  } finally { await r.close(); }
});

test('T4d lifecycle: ending the share, removing the member and a role change delete the allowance; a revived member gets nothing back', async () => {
  const r = await rig();
  try {
    const { share } = await watchShare(r);
    assert.equal((await put(r, share.id, r.bob.user, 3600)).status, 200);
    const member = r.h.db.get('SELECT id FROM members WHERE user_id = ? AND org_id = ?', r.bob.user, r.org);
    r.h.hub.interactionShares.dropViewer(member.id);
    assert.equal(rows(r, share.id).length, 0, 'a member change drops theirs');
    assert.equal((await put(r, share.id, r.bob.user, 3600)).status, 200);
    r.h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", member.id);
    const s = (await r.shared(r.bob)).body.shared.find((x) => x.id === share.id);
    assert.equal(s.allowance, undefined, 'a viewer role is never reported an allowance');
    r.h.db.run("UPDATE members SET role = 'member' WHERE id = ?", member.id);
    assert.equal((await r.mac.stopSharing(share.id)).ok, true);
    await until(() => rows(r, share.id).length === 0);
  } finally { await r.close(); }
});

test('T4d host authority: an allowance the hub invents is never honoured and is removed; a revoke is immediate and local first', async () => {
  const r = await rig();
  try {
    const { s, share } = await watchShare(r);
    // A row the owner's Mac never granted (a hub bug or tampering): the hub would admit it, the Mac refuses.
    r.h.db.insert('interaction_allowances', { share_id: share.id, user_id: r.bob.user, granted_at: r.h.hub.iso(), expires_at: new Date(r.h.hub.wallMs() + 600000).toISOString(), granted_by: r.macA.user });
    const res = await r.call(r.bob, share.id, 'send', SEND(s));
    assert.equal(r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.length, 0, 'nothing reached the session');
    assert.notEqual(res.body?.result?.ok, true);
    await r.mac.listShares();
    await until(() => rows(r, share.id).length === 0);
    // Interrupt has no later re-check: the Mac's admission check is its only gate. A held turn must not be stopped by an invented row.
    await r.ownerSend(s, 'HOLD');
    const turn = await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).activeTurn);
    r.h.db.insert('interaction_allowances', { share_id: share.id, user_id: r.bob.user, granted_at: r.h.hub.iso(), expires_at: new Date(r.h.hub.wallMs() + 600000).toISOString(), granted_by: r.macA.user });
    const stop = await r.call(r.bob, share.id, 'interrupt', { session: s.session, generation: s.generation, turn });
    assert.notEqual(stop.body?.result?.status, 'interrupt-requested', JSON.stringify(stop.body));
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(r.mac.hub.state({ session: s.session }, r.mac.actor).activeTurn, turn, 'the turn is still running');
    assert.ok(!r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.some((d) => d.state === 'interrupted'));
    r.h.db.run('DELETE FROM interaction_allowances WHERE share_id = ?', share.id);
    await r.mac.hub.interrupt({ session: s.session, generation: s.generation, turn }, r.mac.actor);
    await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).activeTurn === null);
    // A real grant, then a revoke that does not wait for the hub.
    assert.equal((await r.mac.grantAllowance({ share: share.id, user: r.bob.user, seconds: 900 })).ok, true);
    assert.equal((await r.call(r.bob, share.id, 'send', SEND(s, 'one'))).status, 200);
    const pending = r.mac.revokeAllowance({ share: share.id, user: r.bob.user });
    assert.equal(r.mac.shared()[0].members.find((m) => m.id === r.bob.user).canSend, false, 'ended locally before the hub answered');
    await pending;
    assert.equal(rows(r, share.id).length, 0);
    assert.equal((await r.call(r.bob, share.id, 'send', SEND(s, 'two'))).status, 403);
  } finally { await r.close(); }
});

test('T4d H1: a share list that overlaps a grant never drops the fresh allowance', async () => {
  const r = await rig();
  try {
    const { s, share } = await watchShare(r);
    const ish = r.h.hub.interactionShares, orig = ish.allow.bind(ish);
    let release; const gate = new Promise((res) => { release = res; });
    // The hub commits the row at once but holds its answer, so a list can begin between the commit and the Mac recording it.
    ish.allow = (...a) => { const out = orig(...a); return gate.then(() => out); };
    const granting = r.mac.grantAllowance({ share: share.id, user: r.bob.user, seconds: 1800 });
    await new Promise((res) => setTimeout(res, 50));
    const listing = r.mac.listShares();
    await new Promise((res) => setTimeout(res, 50));
    release();
    assert.equal((await granting).ok, true); await listing;
    assert.equal(rows(r, share.id).length, 1, 'the hub row survives');
    assert.equal((await r.call(r.bob, share.id, 'send', SEND(s))).status, 200, 'and so does the Mac\'s record');
  } finally { await r.close(); }
});

test('T4d old hub: no allowances array means no Allow, no hub call, and anything held is dropped', async () => {
  const r = await rig();
  try {
    const ish = r.h.hub.interactionShares, view = ish.ownerView.bind(ish);
    let strip = true, puts = 0; const orig = ish.allow.bind(ish);
    ish.allow = (...a) => { puts++; return orig(...a); };
    ish.ownerView = (row) => { const v = view(row); if (strip) delete v.allowances; return v; };
    const { share } = await watchShare(r);
    assert.equal(share.allowOk, false);
    const refused = await r.mac.grantAllowance({ share: share.id, user: r.bob.user, seconds: 900 });
    assert.equal(refused.ok, false); assert.match(refused.error, /hub needs an update/);
    assert.equal(puts, 0, 'the hub was never called');
    // A hub that has it: grant works; the hub is then rolled back (the list loses the array): Allow is hidden and nothing is honoured.
    strip = false; await r.mac.listShares();
    assert.equal(r.mac.shared()[0].allowOk, true);
    assert.equal((await r.mac.grantAllowance({ share: share.id, user: r.bob.user, seconds: 900 })).ok, true);
    strip = true; await r.mac.listShares();
    assert.equal(r.mac.shared()[0].allowOk, false); assert.equal(r.mac.shared()[0].members.find((m) => m.id === r.bob.user).canSend, false);
  } finally { await r.close(); }
});

test('T4d H2: after the hub advertised the route, a 404 on the grant says the share changed (not "needs an update")', async () => {
  const r = await rig();
  try {
    const { share } = await watchShare(r);
    await r.mac.stopSharing(share.id);                       // gone at the hub, still advertised in the Mac's record until the next list
    const rec = r.mac.shared();                                // the Mac dropped it too
    assert.equal(rec.length, 0);
    const out = await r.mac.grantAllowance({ share: share.id, user: r.bob.user, seconds: 900 });
    assert.equal(out.ok, false);
    // A share the Mac still holds but the hub no longer has:
    const { share: again } = await watchShare(r);
    r.h.db.run('UPDATE interaction_shares SET revoked_at = ? WHERE id = ?', r.h.hub.iso(), again.id);
    const stale = await r.mac.grantAllowance({ share: again.id, user: r.bob.user, seconds: 900 });
    assert.equal(stale.ok, false); assert.match(stale.error, /This share changed\. Look again\./);
  } finally { await r.close(); }
});

test('T4d clamp: a hub whose expiry runs later than the chosen time never lengthens it on the Mac (send, interrupt, and the owner label)', async () => {
  const r = await rig();
  try {
    const { s, share } = await watchShare(r);
    const ish = r.h.hub.interactionShares, orig = ish.allow.bind(ish);
    // The hub row and its answer are 5 minutes past the chosen time (a fast hub clock or a bad hub).
    ish.allow = (...a) => {
      const out = orig(...a);
      const later = new Date(Date.parse(out.allowance.expires_at) + 300_000).toISOString();
      r.h.db.run('DELETE FROM interaction_allowances WHERE share_id = ?', share.id);
      r.h.db.insert('interaction_allowances', { share_id: share.id, user_id: a[2], granted_at: r.h.hub.iso(), expires_at: later, granted_by: r.macA.user });
      return { allowance: { user_id: a[2], expires_at: later } };
    };
    const t0 = r.h.clock.wall();
    const granted = await r.mac.grantAllowance({ share: share.id, user: r.bob.user, seconds: 900 });
    assert.equal(granted.ok, true, JSON.stringify(granted));
    assert.equal(granted.share.members.find((m) => m.id === r.bob.user).allowedUntil, t0 + 900_000, 'the owner label shows the clamped cutoff');
    assert.equal((await r.call(r.bob, share.id, 'send', SEND(s, 'inside'))).status, 200);
    await r.ownerSend(s, 'HOLD');
    const turn = await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).activeTurn);
    r.h.clock.advance(900_000 + 1000);   // past the chosen time, still before the hub's later expiry
    assert.ok(Date.parse(rows(r, share.id)[0].expires_at) > r.h.clock.wall(), 'the hub still honours it');
    const before = r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.length;
    const late = await r.call(r.bob, share.id, 'send', SEND(s, 'too late'));
    assert.notEqual(late.body?.result?.ok, true, JSON.stringify(late.body));
    assert.equal(r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.length, before, 'nothing was sent');
    const stop = await r.call(r.bob, share.id, 'interrupt', { session: s.session, generation: s.generation, turn });
    assert.notEqual(stop.body?.result?.status, 'interrupt-requested', JSON.stringify(stop.body));
    assert.equal(r.mac.hub.state({ session: s.session }, r.mac.actor).activeTurn, turn, 'the turn is still running');
    assert.equal(r.mac.shared()[0].members.find((m) => m.id === r.bob.user).canSend, false);
    await r.mac.hub.interrupt({ session: s.session, generation: s.generation, turn }, r.mac.actor);
  } finally { await r.close(); }
});
