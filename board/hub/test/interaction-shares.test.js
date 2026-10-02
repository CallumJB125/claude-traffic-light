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
const { createRemoteInteractionHost } = require('../../../src/remote-interaction.js');
const { createInteractionHub } = require('../../../src/session-interaction.js');
const { createCodexAppServer } = require('../../../src/codex-app-server.js');
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
  const adapter = createCodexAppServer({ bin: FAKE });
  // A separate "Overview" hub on the same Mac: its sessions are reachable only once shared.
  const overview = createInteractionHub({ adapters: { codex: createCodexAppServer({ bin: FAKE }) }, boardCurrent: (b) => b === 'board:x' });
  const mac = createRemoteInteractionHost({
    userId: macA.user, adapters: { codex: adapter }, boardCurrent: (b) => b === null, now: () => h.clock.wall(),
    sharedTarget: (session) => (overview.state({ session }, 'overview:1:1') ? { hub: overview, actor: 'overview:1:1' } : null),
  });
  const st = await mac.enable({ baseUrl: h.base, token: macA.token, WebSocket });
  assert.equal(st.state, 'connected');
  const launch = async () => (await mac.hub.launch({ provider: 'codex' }, mac.actor)).state;
  const ownerSend = (s, text) => mac.hub.send({ session: s.session, generation: s.generation, text }, mac.actor);
  const call = (dev, share, op, args, requestId = rid()) => h.call('POST', `/api/interaction/v1/shared/${share}/call`, { token: dev.token, body: { request_id: requestId, op, args } });
  const shared = (dev) => h.call('GET', '/api/interaction/v1/shared', { token: dev.token });
  const bobName = h.db.get('SELECT display_name AS n FROM users WHERE id = ?', bob.user).n;
  return {
    h, lines, macA, winA, bob, carol, mac, overview, launch, ownerSend, call, shared, bobName, org: h.ids.org,
    async close() { mac.close(); overview.stopAll(); await h.close(); },
  };
}

test('LOCAL PROOF: a teammate watches a shared session; with interact they steer and interrupt, labelled "Sent by"', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    // Off by default: nothing is shared, nothing is listed.
    assert.deepEqual((await r.shared(r.bob)).body.shared, []);
    const made = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.deepEqual(made.share.members.map((m) => m.id), [r.bob.user]);
    const listed = (await r.shared(r.bob)).body.shared;
    assert.equal(listed.length, 1);
    assert.deepEqual([listed[0].id, listed[0].scope, listed[0].session, listed[0].online, listed[0].team.id], [made.share.id, 'watch', s.session, true, r.org]);
    const id = made.share.id;

    // Watch: the owner types, the teammate reads the reply as it streams.
    await r.ownerSend(s, 'owner says hi');
    let after = 0, done = null;
    await until(async () => {
      const w = await r.call(r.bob, id, 'watch', { session: s.session, after });
      assert.equal(w.status, 200, w.text);
      after = w.body.result.version;
      done = w.body.result.state.deliveries.find((d) => d.state === 'completed');
      return done;
    });
    assert.equal(done.response, 'echo:owner says hi');
    assert.equal(done.by, null);
    const read = await r.call(r.bob, id, 'state', { session: s.session });
    assert.equal(read.body.result.ok, true);
    assert.ok(!Object.hasOwn(read.body.result.state, 'board'));

    // Read-only: no send, no interrupt; no list/launch/close/capabilities for anyone.
    const esc = await r.call(r.bob, id, 'send', { session: s.session, generation: s.generation, text: 'let me in' });
    assert.equal(esc.status, 403); assert.equal(esc.body.error.reason, 'SCOPE');
    for (const op of ['list', 'launch', 'close', 'capabilities']) assert.equal((await r.call(r.bob, id, op, {})).status, 400, op);

    // Interact: a new share replaces the old one (old id dead at once).
    const up = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact', expiresInS: 3600 });
    assert.equal(up.ok, true);
    assert.equal((await r.call(r.bob, id, 'state', { session: s.session })).status, 404);
    const sent = await r.call(r.bob, up.share.id, 'send', { session: s.session, generation: s.generation, text: 'teammate here' });
    assert.equal(sent.body.result.status, 'acknowledged', sent.text);
    assert.equal(sent.body.result.delivery.by, r.bobName);
    // The owner's own transcript says who typed it.
    const mine = await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.find((d) => d.text === 'teammate here' && d.state === 'completed'));
    assert.equal(mine.by, r.bobName);
    // Steer + interrupt.
    await r.call(r.bob, up.share.id, 'send', { session: s.session, generation: s.generation, text: 'HOLD' });
    const turn = await until(async () => (await r.call(r.bob, up.share.id, 'state', { session: s.session })).body.result.state.activeTurn);
    const steer = await r.call(r.bob, up.share.id, 'send', { session: s.session, generation: s.generation, text: 'more', expectedTurn: turn });
    assert.equal(steer.body.result.delivery.mode, 'steer');
    await r.call(r.bob, up.share.id, 'send', { session: s.session, generation: s.generation, text: 'HOLD 2' });
    const turn2 = await until(async () => (await r.call(r.bob, up.share.id, 'state', { session: s.session })).body.result.state.activeTurn);
    const intr = await r.call(r.bob, up.share.id, 'interrupt', { session: s.session, generation: s.generation, turn: turn2 });
    assert.equal(intr.body.result.status, 'interrupt-requested');
    await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.some((d) => d.state === 'interrupted'));

    // The owner can always close; the share then answers as gone and cannot be renewed.
    assert.equal((await r.mac.hub.close({ session: s.session, generation: s.generation }, r.mac.actor)).ok, true);
    const gone = await r.call(r.bob, up.share.id, 'state', { session: s.session });
    assert.equal(gone.body.result?.ok, false);
    assert.equal((await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' })).status, 'stale');
    assert.deepEqual(r.mac.shared(), []);
    await until(async () => (await r.call(r.bob, up.share.id, 'state', { session: s.session })).status === 404);

    // No provider thread id on the wire, no message text in hub logs.
    const s2 = await r.launch();
    const sh2 = await r.mac.shareSession({ session: s2.session, team: r.org, scope: 'watch' });
    const wire = JSON.stringify([listed, read.body, sent.body, (await r.call(r.bob, sh2.share.id, 'state', { session: s2.session })).body]);
    assert.ok(!wire.includes(r.mac.hub.targetOf(s2.session)));
    const logs = r.lines.join('\n');
    for (const secret of ['owner says hi', 'teammate here', 'echo:', 'HOLD', 'let me in']) assert.ok(!logs.includes(secret), `log carries ${secret}`);
  } finally { await r.close(); }
});

test('LOCAL PROOF: an Overview-started session is reachable by teammates only once shared, and never through list', async () => {
  const r = await rig();
  try {
    const local = (await r.overview.launch({ provider: 'codex', board: 'board:x' }, 'overview:1:1')).state;
    const winA = (op, args) => r.h.call('POST', `/api/interaction/v1/hosts/${r.macA.device}/call`, { token: r.winA.token, body: { request_id: rid(), op, args } });
    assert.ok(!(await winA('list', {})).body.result.sessions.some((x) => x.session === local.session));
    const made = await r.mac.shareSession({ session: local.session, team: r.org, scope: 'interact' });
    assert.equal(made.ok, true, JSON.stringify(made));
    const sent = await r.call(r.bob, made.share.id, 'send', { session: local.session, generation: local.generation, text: 'into overview' });
    assert.equal(sent.body.result.status, 'acknowledged', sent.text);
    const d = await until(() => r.overview.state({ session: local.session }, 'overview:1:1').deliveries.find((x) => x.state === 'completed'));
    assert.equal(d.by, r.bobName);
    assert.ok(!(await winA('list', {})).body.result.sessions.some((x) => x.session === local.session));
    // The board key never reaches the teammate.
    assert.ok(!JSON.stringify(sent.body).includes('board:x'));
  } finally { await r.close(); }
});

test('HOSTILE: non-member, cross-team, guessed session id, forged caller, replay, oversize, rate limit, host-role caller', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const other = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    // Non-member: nothing listed, nothing reachable (same answer as an unknown share).
    assert.deepEqual((await r.shared(r.carol)).body.shared, []);
    assert.equal((await r.call(r.carol, share.id, 'state', { session: s.session })).status, 404);
    assert.equal((await r.call(r.bob, rid(), 'state', { session: s.session })).status, 404);
    // Guessing the owner's other session id through a real share.
    assert.equal((await r.call(r.bob, share.id, 'state', { session: other.session })).status, 404);
    assert.equal((await r.call(r.bob, share.id, 'send', { session: other.session, generation: 1, text: 'x' })).status, 404);
    // …or through the owner's host route (another account's host).
    assert.equal((await r.h.call('POST', `/api/interaction/v1/hosts/${r.macA.device}/call`, { token: r.bob.token, body: { request_id: rid(), op: 'state', args: { session: s.session } } })).status, 404);
    // Forged caller / actor / label: extra fields are refused.
    const forged = await r.h.call('POST', `/api/interaction/v1/shared/${share.id}/call`, { token: r.bob.token, body: { request_id: rid(), op: 'state', args: { session: s.session }, user: r.macA.user } });
    assert.equal(forged.status, 400);
    for (const extra of [{ by: 'Alice' }, { actor: 'account:x' }, { board: null }, { share: share.id }]) {
      assert.equal((await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation, text: 'x', ...extra })).status, 400, JSON.stringify(extra));
    }
    // Cross-team: Alice cannot share with a team she is not in; another team's owner cannot revoke her share.
    const team = await r.h.call('POST', '/api/teams', { token: r.carol.token, body: { name: 'Carol Co' } });
    assert.equal(team.status, 200, team.text);
    const carolTeam = team.body.team?.id ?? team.body.id;
    assert.equal((await r.h.call('POST', '/api/interaction/v1/shares', { token: r.macA.token, body: { session: s.session, team: carolTeam, scope: 'watch' } })).status, 404);
    assert.ok([403, 404].includes((await r.h.call('DELETE', `/api/teams/${carolTeam}/interaction-shares/${share.id}`, { token: r.carol.token, body: {} })).status));
    // Only the owner's host device creates shares; a client device or a cookie cannot.
    assert.equal((await r.h.call('POST', '/api/interaction/v1/shares', { token: r.winA.token, body: { session: s.session, team: r.org, scope: 'watch' } })).status, 403);
    assert.equal((await r.h.call('POST', '/api/interaction/v1/shares', { token: r.bob.token, body: { session: s.session, team: r.org, scope: 'watch' } })).status, 403);
    // Replay: the same request_id is refused; the provider sees one send.
    const once = rid();
    assert.equal((await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation, text: 'once' }, once)).body.result.status, 'acknowledged');
    const again = await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation, text: 'once' }, once);
    assert.equal(again.status, 409); assert.equal(again.body.error.reason, 'REPLAYED');
    await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.every((d) => d.state === 'completed'));
    assert.equal(r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.length, 1);
    // Stale generation (the provider target was replaced).
    await r.mac.hub.replaceTarget(s.session);
    assert.equal((await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation, text: 'old gen' })).body.result.status, 'stale');
    // Oversize.
    assert.equal((await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation + 1, text: 'x'.repeat(17000) })).status, 413);
    // The owner's own devices use their own route, not a share; host-role devices cannot call shares.
    assert.equal((await r.call(r.winA, share.id, 'state', { session: s.session })).status, 404);
    assert.equal((await r.call(r.macA, share.id, 'state', { session: s.session })).status, 403);
    // A cookie session cannot call shares.
    const web = await r.h.webSignIn('bob@dev.local');
    assert.equal((await r.h.call('POST', `/api/interaction/v1/shared/${share.id}/call`, { cookie: web.cookie, headers: { 'x-csrf-token': web.csrf }, body: { request_id: rid(), op: 'state', args: { session: s.session } } })).status, 403);
    // Per-teammate rate limit.
    r.h.hub.limiter.limits.share_call_user = { capacity: 2, per_ms: 60_000 };
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await r.call(r.bob, share.id, 'state', { session: s.session })).status);
    assert.deepEqual(codes, [200, 200, 429]);
    // A share's scope, session or team can never be changed in place.
    assert.throws(() => r.h.db.run("UPDATE interaction_shares SET scope = 'interact' WHERE id = ?", share.id), /fixed/);
  } finally { await r.close(); }
});

test('HOSTILE: removed member, revoked device, expired share, team-admin revoke and owner revoke mid-stream all cut access', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    // Expiry: the hub and the Mac both stop serving it.
    const short = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch', expiresInS: 60 });
    assert.equal((await r.call(r.bob, short.share.id, 'state', { session: s.session })).status, 200);
    r.h.clock.advance(61_000);
    assert.equal((await r.call(r.bob, short.share.id, 'state', { session: s.session })).status, 404);
    assert.deepEqual((await r.shared(r.bob)).body.shared, []);

    // Owner revokes while the teammate is long-polling: the answer is withheld.
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    const v = (await r.call(r.bob, share.id, 'state', { session: s.session })).body.result;
    assert.equal(v.ok, true);
    const first = await r.call(r.bob, share.id, 'watch', { session: s.session, after: 0 });
    const poll = r.call(r.bob, share.id, 'watch', { session: s.session, after: first.body.result.version });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.mac.stopSharing(share.id).ok, true);
    await r.ownerSend(s, 'after revoke secret');
    const cut = await poll;
    // The Mac stops serving it first (its answer carries no text), then the hub forgets it.
    assert.ok(cut.status === 404 || cut.body.result.ok === false, cut.text);
    assert.ok(!cut.text.includes('after revoke secret'));
    await until(async () => (await r.shared(r.bob)).body.shared.length === 0);

    // Revoked at the hub while the Mac still serves it: the hub withholds the Mac's answer.
    const m = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    const w0 = await r.call(r.bob, m.share.id, 'watch', { session: s.session, after: 0 });
    const poll2 = r.call(r.bob, m.share.id, 'watch', { session: s.session, after: w0.body.result.version });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal((await r.h.call('DELETE', `/api/interaction/v1/shares/${m.share.id}`, { token: r.winA.token, body: {} })).status, 200);
    await r.ownerSend(s, 'hub revoked secret');
    const cut2 = await poll2;
    assert.equal(cut2.status, 404);
    assert.ok(!cut2.text.includes('hub revoked secret'));

    // Team admin revoke: a plain member cannot, the team owner can.
    const b = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    assert.equal((await r.h.call('DELETE', `/api/teams/${r.org}/interaction-shares/${b.share.id}`, { token: r.bob.token, body: {} })).status, 403);
    assert.equal((await r.h.call('DELETE', `/api/teams/${r.org}/interaction-shares/${b.share.id}`, { token: r.winA.token, body: {} })).status, 200);
    assert.equal((await r.call(r.bob, b.share.id, 'state', { session: s.session })).status, 404);
    // The Mac drops it at its next refresh.
    const listed = await r.mac.listShares();
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.shares, []);
    assert.deepEqual(listed.teams.map((t) => t.id), [r.org]);

    // Revoked device: the teammate's token stops working at once.
    const c = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    const bob2 = await r.h.signIn('bob@dev.local', { device_name: 'Bob Laptop' });
    assert.equal((await r.h.call('DELETE', `/api/account/devices/${r.bob.device}`, { token: bob2.body.device_token, body: {} })).status, 200);
    assert.equal((await r.call(r.bob, c.share.id, 'state', { session: s.session })).status, 401);
    const laptop = { token: bob2.body.device_token };
    assert.equal((await r.call(laptop, c.share.id, 'state', { session: s.session })).status, 200);

    // Removed member: nothing listed, nothing reachable, from any of their devices.
    assert.equal((await r.h.call('DELETE', `/api/teams/${r.org}/members/${r.h.ids.bob}`, { token: r.winA.token, body: {} })).status, 200);
    assert.equal((await r.call(laptop, c.share.id, 'state', { session: s.session })).status, 404);
    assert.deepEqual((await r.shared(laptop)).body.shared, []);
  } finally { await r.close(); }
});

test('HOSTILE: the Mac enforces the share itself — a malicious hub forwarding unshared or widened calls is refused', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const other = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    const frame = (op, args, sh = {}) => ({ type: 'relay.request', id: rid(), rid: rid(), user: r.macA.user, from: 'evil-device', op, args,
      share: { id: share.id, team: r.org, user: r.bob.user, name: 'Bob', scope: 'interact', ...sh } });
    // Control: the real share works.
    assert.equal((await r.mac.handle(frame('state', { session: s.session }))).ok, true);
    // Unshared session, unknown share id, another team, a non-member caller, the owner posing as a teammate.
    assert.equal((await r.mac.handle(frame('state', { session: other.session }))).status, 'forbidden');
    assert.equal((await r.mac.handle(frame('state', { session: s.session }, { id: rid() }))).status, 'forbidden');
    assert.equal((await r.mac.handle(frame('state', { session: s.session }, { team: 'other-team' }))).status, 'forbidden');
    assert.equal((await r.mac.handle(frame('state', { session: s.session }, { user: r.carol.user }))).status, 'forbidden');
    assert.equal((await r.mac.handle(frame('state', { session: s.session }, { user: r.macA.user }))).status, 'forbidden');
    // The hub claims 'interact' but the Mac's share is 'watch': send and interrupt are refused.
    assert.equal((await r.mac.handle(frame('send', { session: s.session, generation: s.generation, text: 'widened' }))).status, 'forbidden');
    assert.equal((await r.mac.handle(frame('interrupt', { session: s.session, generation: s.generation, turn: rid() }))).status, 'forbidden');
    // Owner-only ops never pass a share.
    for (const op of ['list', 'launch', 'close', 'capabilities']) assert.equal((await r.mac.handle(frame(op, { session: s.session }))).status, 'forbidden', op);
    assert.ok(!r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.some((d) => d.text === 'widened'));
    // A forged name cannot be injected: the label comes from the Mac's own member list.
    const up = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    const f2 = frame('send', { session: s.session, generation: s.generation, text: 'labelled' }, { id: up.share.id, name: 'Alice (owner)' });
    assert.equal((await r.mac.handle(f2)).status, 'acknowledged');
    assert.equal(r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.find((d) => d.text === 'labelled').by, r.bobName);
    // Replayed frame.
    assert.equal((await r.mac.handle(f2)).status, 'stale');
    // Stopped locally: refused even though the hub might still forward it.
    r.mac.stopSharing(up.share.id);
    assert.equal((await r.mac.handle(frame('state', { session: s.session }, { id: up.share.id }))).status, 'forbidden');
    // Expired on the Mac's own clock.
    const exp = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch', expiresInS: 60 });
    r.h.clock.advanceWallOnly(61_000);
    assert.equal((await r.mac.handle(frame('state', { session: s.session }, { id: exp.share.id }))).status, 'stale');
    assert.deepEqual(r.mac.shared(), []);
  } finally { await r.close(); }
});
