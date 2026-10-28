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

async function proposalFixture(r, { scope = 'interact' } = {}) {
  const s = await r.launch(), share = (await r.mac.shareSession({ session:s.session, team:r.org, scope })).share;
  const base = `/api/interaction/v1/shared/${share.id}/proposals`;
  const body = { id:rid(), decision:rid(), version:1, generation:s.generation, title:'Reviewed audit', text:'Report READY without editing anything.' };
  const create = (b=body, who=r.bob) => r.h.call('POST',base,{token:who.token,body:b});
  const approve = p => r.mac.proposalApprove({ share:share.id,id:p.id,version:p.version,digest:p.digest,expiresInS:600 });
  const send = (p, who=r.bob) => { r.h.clock.advance(1); return r.h.call('POST',`${base}/${p.id}/send`,{token:who.token,body:{version:p.version,digest:p.digest,request_id:rid()}}); };
  return {s,share,base,body,create,approve,send};
}

test('owner proposal uses persisted exact review and one host-enforced send with a real relay receipt', async () => {
  const r=await rig();
  try {
    const p=await proposalFixture(r), made=await p.create(); assert.equal(made.status,200,made.text);
    const proposal=made.body.proposal;
    assert.equal(proposal.status,'pending'); assert.equal(r.mac.hub.state({session:p.s.session},r.mac.actor).deliveries.length,0);
    assert.equal((await p.send(proposal)).status,409);
    assert.equal((await p.approve(proposal)).ok,true);
    assert.equal(r.h.db.get('SELECT status FROM interaction_proposals WHERE id = ?',proposal.id).status,'approved');
    const sent=await p.send(proposal); assert.equal(sent.status,200,sent.text); assert.equal(sent.body.proposal.status,'sent');
    assert.ok(sent.body.proposal.receipt.id); assert.equal((await p.send(proposal)).status,409);
    assert.equal(r.mac.hub.state({session:p.s.session},r.mac.actor).deliveries.length,1);
    assert.equal((await p.send(proposal,r.carol)).status,404);
    assert.equal((await r.mac.proposalList(p.share.id)).proposals[0].receipt.id,sent.body.proposal.receipt.id);
  } finally {await r.close();}
});

test('proposal versions, wrong text, watch scope, stale generation, expiry and revoke never grant implicit sends', async () => {
  const r=await rig();
  try {
    const watched=await proposalFixture(r,{scope:'watch'}); assert.equal((await watched.create()).status,403);
    const p=await proposalFixture(r), made=(await p.create()).body.proposal;
    assert.equal((await p.create({...p.body,text:'Changed text with the old id'})).status,409);
    assert.equal((await p.approve({...made,digest:'0'.repeat(64)})).ok,false);
    assert.equal((await p.approve(made)).ok,true);
    const v2=(await p.create({...p.body,id:rid(),version:2,text:'Replacement decision'})).body.proposal;
    assert.equal((await p.send(made)).status,409);
    assert.equal((await p.approve(v2)).ok,true);
    assert.equal((await r.mac.proposalRevoke({share:p.share.id,id:v2.id})).ok,true);
    assert.equal((await p.send(v2)).status,409);
    const v3=(await p.create({...p.body,id:rid(),version:3})).body.proposal;
    assert.equal((await p.approve(v3)).ok,true); r.h.clock.advance(600001);
    assert.equal((await p.send(v3)).status,409);
    const v4=(await p.create({...p.body,id:rid(),version:4,generation:p.s.generation+1})).body.proposal;
    assert.equal((await p.approve(v4)).ok,false);
    assert.equal(r.mac.hub.state({session:p.s.session},r.mac.actor).deliveries.length,0);
  } finally {await r.close();}
});

test('hub approval alone does not create host authority; uncertain or interrupted dispatch is never retried', async () => {
  const r=await rig();
  try {
    const p=await proposalFixture(r), proposal=(await p.create()).body.proposal;
    const approval=await r.h.call('POST',`/api/interaction/v1/shares/${p.share.id}/proposals/${proposal.id}/approve`,{token:r.macA.token,body:{version:proposal.version,digest:proposal.digest,generation:proposal.generation,expires_in_s:600}});
    assert.equal(approval.status,200);
    const refused=await p.send(proposal); assert.equal(refused.status,200,refused.text); assert.equal(refused.body.proposal.status,'refused');
    assert.equal((await p.send(proposal)).status,409); assert.equal(r.mac.hub.state({session:p.s.session},r.mac.actor).deliveries.length,0);
    const next=(await p.create({...p.body,id:rid(),version:2})).body.proposal; assert.equal((await p.approve(next)).ok,true);
    r.h.db.run("UPDATE interaction_proposals SET status = 'dispatching', used_at = ? WHERE id = ?",r.h.hub.iso(),next.id);
    assert.equal((await p.send(next)).status,409);
    r.h.clock.advance(7*86400000); r.h.hub.interactionShares.proposals.prune();
    assert.equal(r.h.db.get('SELECT COUNT(*) AS n FROM interaction_proposals').n,0);
  } finally {await r.close();}
});

test('LOCAL ACTIVITY PROOF: shared reads omit pre-share activity and preserve its independent provider clock', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    await r.ownerSend(s, 'HOLD private prior task');
    const own = () => r.mac.hub.state({ session: s.session }, r.mac.actor);
    assert.equal(own().activity.label, 'Thinking');
    const made = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    assert.equal(made.ok, true);
    const read = async () => (await r.call(r.bob, made.share.id, 'state', { session: s.session })).body.result.state;
    assert.equal((await read()).activity, null, 'even same-millisecond pre-share metadata stays private');
    r.h.clock.advance(1000);
    assert.equal((await read()).activity, null, 'a fresh host read does not freshen pre-share provider activity');
    await r.mac.hub.interrupt({ session: s.session, generation: s.generation, turn: own().activeTurn }, r.mac.actor);
    await until(() => own().status === 'ready');
    const completed = (await read()).activity;
    assert.equal(completed.label, 'Thinking'); assert.equal(completed.phase, 'completed');
    assert.equal(completed.observed_at, r.h.clock.wall());
    r.h.clock.advance(1000);
    assert.deepEqual((await read()).activity, completed, 'host read does not change activity observation time');
    assert.ok(!JSON.stringify(completed).includes(r.mac.hub.targetOf(s.session)), 'native session remains private');
    assert.ok(!JSON.stringify(await read()).includes('private prior task'), 'activity exposes no pre-share prompt');
  } finally { await r.close(); }
});

test('LOCAL REPORTING PROOF: real hub shares bounded parent/child/input reports with independent clocks and no pre-share history', async () => {
  const r = await rig();
  try {
    const s = await r.launch(), report = (req) => r.mac.hub.report({ session: s.session, generation: s.generation, source: 'self-reported', ...req }, r.mac.actor);
    const privateAt = r.h.clock.wall();
    assert.equal(report({ taskTitle: 'Private old task', inputNeeded: true, children: [{ id: 'old-child-private-id', name: 'Private old child', taskTitle: 'Private old child task', state: 'input', observedAt: privateAt, createdAt: privateAt }] }).ok, true);
    // Metadata was recorded immediately before share in the same wall-clock
    // millisecond. A >= comparison would leak it despite operation ordering.
    const made = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    assert.equal(made.ok, true);
    const hub = createReportingTeamHubClient({ baseUrl: r.h.base, token: () => r.bob.token, viewerId: r.bob.user }, { now: () => r.h.clock.wall() });
    let wire = (await r.call(r.bob, made.share.id, 'state', { session: s.session })).body.result.state;
    assert.equal(wire.task_title, null); assert.equal(wire.input_needed, false); assert.deepEqual(wire.reporting.children, []);
    assert.ok(!JSON.stringify(wire).includes('Private old'));
    r.h.clock.advance(1000); const childAt = r.h.clock.wall();
    assert.equal(report({ taskTitle: 'Public current task', inputNeeded: true, children: [
      { id: 'old-child-private-id', name: 'Private old child updated', taskTitle: 'Private old child task', state: 'ended', observedAt: childAt, createdAt: childAt },
      { id: 'new-child-private-id', name: 'Test worker', taskTitle: 'Validate Overview /Users/alice/private ghp_abcdefghijklmnopqrstuv123456789', state: 'input', observedAt: childAt, createdAt: childAt },
    ] }).ok, true);
    r.h.clock.advance(1000); const parentAt = r.h.clock.wall();
    report({ taskTitle: 'Public parent refreshed' });
    let rows = await hub.sessions(null, r.org);
    assert.equal(rows.length, 1); assert.equal(rows[0].task_title, 'Public parent refreshed'); assert.equal(rows[0].task_source, 'self-reported');
    assert.equal(rows[0].input_needed, true); assert.equal(rows[0].state, 'input'); assert.equal(rows[0].children.length, 1);
    assert.equal(rows[0].children[0].name, 'Test worker'); assert.equal(rows[0].children[0].observed_at, childAt); assert.equal(rows[0].children[0].received_at, childAt);
    assert.equal(rows[0].task_observed_at, parentAt); assert.equal(rows[0].observed_at, parentAt);
    assert.ok(!JSON.stringify(rows).includes('new-child-private-id')); assert.ok(!JSON.stringify(rows).includes('/Users/alice')); assert.ok(!JSON.stringify(rows).includes('ghp_abcdefghijklmnopqrstuv123456789'));
    r.h.clock.advance(1000);
    rows = await hub.sessions(null, r.org);
    assert.equal(rows[0].observed_at, parentAt, 'passive cache keeps the real earlier receipt time');
    assert.equal((await hub.inspect(hub.viewer(), r.org, made.share.id)).ok, true, 'selected session reads exact live state');
    rows = await hub.sessions(null, r.org);
    assert.equal(rows[0].observed_at, r.h.clock.wall()); assert.equal(rows[0].children[0].observed_at, childAt, 'fresh state receipt is not child activity');
    assert.equal(rows[0].children[0].received_at, childAt);
    const reportedInputAt = rows[0].input_observed_at;
    r.h.clock.advance(90_001);
    wire = (await r.call(r.bob, made.share.id, 'state', { session: s.session })).body.result.state;
    assert.equal(wire.input_needed, false); assert.equal(wire.reporting.input.needed, true); assert.equal(wire.reporting.input.observed_at, reportedInputAt);
    rows = await hub.sessions(null, r.org); assert.equal(rows[0].input_needed, false); assert.equal(rows[0].input_reported_needed, true); assert.equal(rows[0].input_observed_at, reportedInputAt);
    // Viewing and reporting never send a provider instruction or imply delivery.
    assert.deepEqual(r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries, []);
    await r.ownerSend(s, 'HOLD reporting proof');
    const turn = await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).activeTurn);
    r.h.clock.advance(1000); report({ inputNeeded: true, source: 'observed' });
    assert.equal((await hub.inspect(hub.viewer(), r.org, made.share.id)).state.input_needed, true);
    assert.equal((await hub.sessions(null, r.org))[0].input_needed, true);
    await r.mac.hub.interrupt({ session: s.session, generation: s.generation, turn }, r.mac.actor);
    await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).status === 'ready');
    assert.equal((await hub.inspect(hub.viewer(), r.org, made.share.id)).state.input_needed, false);
    rows = await hub.sessions(null, r.org); assert.equal(rows[0].input_needed, false); assert.equal(rows[0].state, 'idle', 'correlated turn completion clears its wait in actual shared state');
    r.h.clock.advance(1000); report({ inputNeeded: true, source: 'observed' });
    r.adapter.stop(); await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).status === 'ended');
    wire = (await r.call(r.bob, made.share.id, 'state', { session: s.session })).body.result.state;
    assert.equal(wire.status, 'ended'); assert.equal(wire.input_needed, false); assert.equal(wire.reporting.input.needed, true, 'closed provider preserves the last report, never a current question');
    assert.equal((await hub.inspect(hub.viewer(), r.org, made.share.id)).state.status, 'ended');
    rows = await hub.sessions(null, r.org); assert.equal(rows[0].state, 'ended'); assert.equal(rows[0].input_needed, false); assert.equal(rows[0].input_reported_needed, true);
    r.mac.stopSharing(made.share.id);
    assert.equal(r.mac.shared().some(x => x.id === made.share.id), false, 'the local grant is removed immediately');
    // DELETE is asynchronous: first observe the hub acknowledging removal,
    // then require the directory to omit it. A pre-revoke listing can safely
    // contain an Unknown row while the local host already refuses calls.
    await until(async () => {
      const listed = await r.shared(r.bob);
      assert.equal(listed.status, 200, listed.text);
      return !listed.body.shared.some(x => x.id === made.share.id);
    });
    assert.deepEqual(await hub.sessions(null, r.org), []);
    // A second main-owned hub can use a slower clock. Even if its DTO calls
    // the old question current, the relaying host must enforce its own TTL.
    let ownerTime = r.h.clock.wall();
    const slower = createInteractionHub({ adapters: { codex: createCodexAppServer({ bin: FAKE, spawn: spawnProviderFixture }) }, boardCurrent: () => true, now: () => ownerTime });
    r.extra.push(slower);
    try {
      const other = (await slower.launch({ provider: 'codex' }, 'extra:0')).state;
      const shared = await r.mac.shareSession({ session: other.session, team: r.org, scope: 'watch' }); assert.equal(shared.ok, true);
      r.h.clock.advance(1000); ownerTime = r.h.clock.wall();
      slower.report({ session: other.session, generation: other.generation, source: 'observed', inputNeeded: true }, 'extra:0');
      r.h.clock.advance(90_001);
      assert.equal(slower.state({ session: other.session }, 'extra:0').input_needed, true, 'owner clock has not advanced');
      const independent = (await r.call(r.bob, shared.share.id, 'state', { session: other.session })).body.result.state;
      assert.equal(independent.reporting.input.needed, true); assert.equal(independent.input_needed, false, 'relaying host independently expires an owner claim');
      r.mac.stopSharing(shared.share.id);
    } finally { slower.stopAll(); }
  } finally { await r.close(); }
});

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
    // The acknowledgement may precede the fake provider's completion event.
    // Wait for that exact delivery before starting the independent held turn;
    // otherwise HOLD 2 is refused as busy and polling cannot find a new turn.
    await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.some((d) =>
      d.id === steer.body.result.delivery.id && d.state === 'completed'));
    const held = await r.call(r.bob, up.share.id, 'send', { session: s.session, generation: s.generation, text: 'HOLD 2' });
    assert.equal(held.status, 200, held.text);
    assert.equal(held.body.result.status, 'acknowledged', held.text);
    assert.equal(held.body.result.delivery.mode, 'new-turn');
    const turn2 = await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).activeTurn);
    const heldRead = await r.call(r.bob, up.share.id, 'state', { session: s.session });
    assert.equal(heldRead.status, 200, heldRead.text);
    assert.equal(heldRead.body.result.state.activeTurn, turn2);
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
    // The owner's own devices use their own route; sharing never authorizes self-access.
    assert.equal((await r.call(r.winA, share.id, 'state', { session: s.session })).status, 404);
    assert.equal((await r.call(r.macA, share.id, 'state', { session: s.session })).status, 404);
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

test('HISTORY: a teammate sees only what was sent after the share; a re-share to another team does not open earlier history (hub and Mac both filter)', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const done = (text) => until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.find((d) => d.text === text && d.state === 'completed'));
    await r.ownerSend(s, 'before share secret'); await done('before share secret');
    r.h.clock.advance(1000);
    const one = (await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' })).share;
    await r.ownerSend(s, 'after share one'); await done('after share one');
    r.h.clock.advance(1000);
    const team = await r.h.call('POST', '/api/teams', { token: r.winA.token, body: { name: 'Second team' } });
    assert.equal(team.status, 200, team.text);
    const team2 = team.body.team?.id ?? team.body.id;
    r.join(r.bob, 'member', team2);
    const two = (await r.mac.shareSession({ session: s.session, team: team2, scope: 'watch' })).share;
    assert.ok(two?.id, 'second share');
    await r.ownerSend(s, 'after share two'); await done('after share two');

    assert.deepEqual(r.texts(await r.call(r.bob, one.id, 'state', { session: s.session })), ['after share one', 'after share two']);
    assert.deepEqual(r.texts(await r.call(r.bob, two.id, 'state', { session: s.session })), ['after share two']);
    assert.deepEqual(r.texts(await r.call(r.bob, two.id, 'watch', { session: s.session, after: 0 })), ['after share two']);
    // The Mac filters on its own…
    const direct = await r.mac.handle(r.frame('state', { session: s.session }, two, r.bob));
    assert.deepEqual(direct.state.deliveries.map((d) => d.text), ['after share two']);
    const owner = r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.map((d) => d.text);
    assert.deepEqual(owner, ['before share secret', 'after share one', 'after share two'], 'the owner still sees everything');
    // …and so does the hub, whatever the Mac answers.
    const relay = r.h.hub.interactionRelay, orig = relay.dispatch;
    relay.dispatch = async function (...a) {
      const res = await orig.apply(this, a);
      return { ...res, state: { ...res.state, deliveries: [{ id: rid(), text: 'old injected', sentAt: 0 }, ...res.state.deliveries] } };
    };
    try {
      const got = await r.call(r.bob, two.id, 'state', { session: s.session });
      assert.equal(got.status, 200, got.text);
      assert.ok(!got.text.includes('old injected'));
      assert.deepEqual(r.texts(got), ['after share two']);
    } finally { relay.dispatch = orig; }
  } finally { await r.close(); }
});

test('HOSTILE: a team viewer only watches, even on a "Watch and send" share (hub and Mac)', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    r.h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", r.h.ids.bob);
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    assert.deepEqual(share.members.map((m) => [m.id, m.canSend]), [[r.bob.user, false]]);
    assert.equal((await r.shared(r.bob)).body.shared[0].scope, 'watch');
    assert.equal((await r.call(r.bob, share.id, 'state', { session: s.session })).status, 200);
    const sent = await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation, text: 'viewer send' });
    assert.equal(sent.status, 403); assert.equal(sent.body.error.reason, 'SCOPE');
    const intr = await r.call(r.bob, share.id, 'interrupt', { session: s.session, generation: s.generation, turn: rid() });
    assert.equal(intr.status, 403); assert.equal(intr.body.error.reason, 'SCOPE');
    // A hub that forwards it anyway: the Mac refuses from its own member list.
    assert.equal((await r.mac.handle(r.frame('send', { session: s.session, generation: s.generation, text: 'viewer send' }, share, r.bob))).status, 'forbidden');
    assert.ok(!r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.some((d) => d.text === 'viewer send'));
    // Made a member again: both sides let them send (after the Mac's next refresh).
    r.h.db.run("UPDATE members SET role = 'member' WHERE id = ?", r.h.ids.bob);
    assert.equal((await r.mac.listShares()).ok, true);
    const ok = await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation, text: 'member send' });
    assert.equal(ok.body.result.status, 'acknowledged', ok.text);
  } finally { await r.close(); }
});

test('HOSTILE: "Sent by" cannot impersonate — a duplicate or owner display name gets a stable member suffix', async () => {
  const r = await rig();
  try {
    const dave = await r.signIn('dave@dev.local', 'Dave Mac');
    const erin = await r.signIn('erin@dev.local', 'Erin Mac');
    r.join(dave); r.join(erin);
    const aliceName = r.h.db.get('SELECT display_name AS n FROM users WHERE id = ?', r.macA.user).n;
    r.h.db.run('UPDATE users SET display_name = ? WHERE id = ?', r.bobName, dave.user);
    r.h.db.run('UPDATE users SET display_name = ? WHERE id = ?', ` ${aliceName.toUpperCase()}`, erin.user);
    const s = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    const by = {};
    for (const [who, dev] of [['bob', r.bob], ['dave', dave], ['erin', erin]]) {
      const sent = await r.call(dev, share.id, 'send', { session: s.session, generation: s.generation, text: `from ${who}` });
      assert.equal(sent.body.result.status, 'acknowledged', sent.text);
      by[who] = sent.body.result.delivery.by;
      await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.find((d) => d.text === `from ${who}` && d.state === 'completed'));
    }
    assert.match(by.bob, new RegExp(`^${r.bobName} #[0-9a-f]{6}$`));
    assert.match(by.dave, new RegExp(`^${r.bobName} #[0-9a-f]{6}$`));
    assert.notEqual(by.bob, by.dave);
    assert.match(by.erin, /#[0-9a-f]{6}$/);
    assert.notEqual(by.erin.trim().toLowerCase(), aliceName.toLowerCase());
    // Stable: the same member keeps the same label after a refresh.
    await r.mac.listShares();
    const again = await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation, text: 'bob again' });
    assert.equal(again.body.result.delivery.by, by.bob);
  } finally { await r.close(); }
});

test('HOSTILE: teammates cannot take the Mac\'s or the hub\'s capacity from the owner', async () => {
  const r = await rig();
  try {
    const team = [r.bob, r.carol, await r.signIn('dave@dev.local', 'Dave Mac'), await r.signIn('erin@dev.local', 'Erin Mac'), await r.signIn('frank@dev.local', 'Frank Mac')];
    const [bob, carol, dave, erin, frank] = team;
    for (const dev of team.slice(1)) r.join(dev);
    // A session whose provider holds an interrupt until released.
    let release; const held = new Promise((res) => { release = res; });
    const adapter = {
      label: 'Slow', capabilities: { newTurn: true, steer: false, interrupt: true },
      open: async () => ({ target: 'slow-target' }), send: async () => ({ turnId: 'turn-1', mode: 'new-turn' }),
      interrupt: () => held, release: async () => true, alive: () => true, stop() {}, on: () => () => {},
    };
    const slow = createInteractionHub({ adapters: { slow: adapter }, boardCurrent: (b) => b === null, now: () => r.h.clock.wall() });
    r.extra.push(slow);
    const st = (await slow.launch({ provider: 'slow' }, 'extra:0')).state;
    const turn = (await slow.send({ session: st.session, generation: st.generation, board: null, text: 'go' }, 'extra:0')).state.activeTurn;
    const { share } = await r.mac.shareSession({ session: st.session, team: r.org, scope: 'interact' });
    const v = (await r.mac.handle(r.frame('state', { session: st.session }, share, bob))).version;
    const watch = (dev) => r.mac.handle(r.frame('watch', { session: st.session, after: v }, share, dev));
    const intr = (dev) => r.mac.handle(r.frame('interrupt', { session: st.session, generation: st.generation, turn }, share, dev));
    const busy = (res) => res.status === 'unavailable' && /busy/.test(res.error);
    const pending = [watch(bob), watch(bob)];
    // Each teammate: at most two calls at once.
    assert.ok(busy(await r.mac.handle(r.frame('state', { session: st.session }, share, bob))), 'per-teammate cap');
    // All teammates together: at most four watches…
    pending.push(watch(carol), watch(carol));
    assert.ok(busy(await watch(dave)), 'shared watch cap');
    // …and at most eight calls.
    pending.push(intr(dave), intr(dave), intr(erin), intr(erin));
    await new Promise((res) => setImmediate(res));
    assert.ok(busy(await r.mac.handle(r.frame('state', { session: st.session }, share, frank))), 'shared handling cap');
    // The owner's own devices still get through.
    const own = await r.mac.handle({ type: 'relay.request', id: rid(), rid: rid(), user: r.macA.user, from: r.winA.device, op: 'list', args: {} });
    assert.equal(own.ok, true, JSON.stringify(own));
    release(true);
    r.mac.stopSharing(share.id);
    await Promise.all(pending);
    assert.equal((await r.mac.handle({ type: 'relay.request', id: rid(), rid: rid(), user: r.macA.user, from: r.winA.device, op: 'list', args: {} })).ok, true);

    // The hub keeps its own per-teammate and all-teammates caps in front of the host.
    const s = await r.launch();
    const sh = (await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' })).share;
    const relay = r.h.hub.interactionRelay;
    relay.limits.pendingPerTeammate = 1; relay.limits.sharedPendingPerHost = 2;
    const w0 = (await r.call(bob, sh.id, 'state', { session: s.session })).body.result.version;
    const polls = [r.call(bob, sh.id, 'watch', { session: s.session, after: w0 })];
    await until(() => [...relay.hosts.get(r.macA.device).pending.values()].length === 1);
    assert.equal((await r.call(bob, sh.id, 'state', { session: s.session })).status, 429);
    polls.push(r.call(carol, sh.id, 'watch', { session: s.session, after: w0 }));
    await until(() => [...relay.hosts.get(r.macA.device).pending.values()].length === 2);
    assert.equal((await r.call(dave, sh.id, 'state', { session: s.session })).status, 429);
    const owner = await r.h.call('POST', `/api/interaction/v1/hosts/${r.macA.device}/call`, { token: r.winA.token, body: { request_id: rid(), op: 'state', args: { session: s.session } } });
    assert.equal(owner.status, 200, owner.text);
    await r.ownerSend(s, 'wake');
    for (const p of await Promise.all(polls)) assert.equal(p.status, 200, p.text);
  } finally { await r.close(); }
});

test('HOSTILE: the owner leaving the team ends access (authorize and the shared list)', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    assert.equal((await r.call(r.bob, share.id, 'state', { session: s.session })).status, 200);
    r.h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", r.h.ids.bob);
    r.h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', r.h.hub.iso(), r.h.ids.alice);
    assert.equal((await r.call(r.bob, share.id, 'state', { session: s.session })).status, 404);
    assert.deepEqual((await r.shared(r.bob)).body.shared, []);
  } finally { await r.close(); }
});

test('HOSTILE: an answer from a host connection other than the one asked is withheld', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    const relay = r.h.hub.interactionRelay, orig = relay.dispatch, live = relay.hosts.get(r.macA.device);
    // The host's slot changes hands while it answers.
    relay.dispatch = async function (host, ...a) { const res = await orig.call(this, host, ...a); relay.hosts.set(host.cred.id, { ...host }); return res; };
    try {
      const got = await r.call(r.bob, share.id, 'state', { session: s.session });
      assert.equal(got.status, 404, got.text);
    } finally { relay.dispatch = orig; relay.hosts.set(r.macA.device, live); }
    assert.equal((await r.call(r.bob, share.id, 'state', { session: s.session })).status, 200);
  } finally { await r.close(); }
});

test('HOSTILE: the per-team rate limit covers all teammates together', async () => {
  const r = await rig();
  try {
    r.join(r.carol);
    const s = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    r.h.hub.limiter.limits.share_call_team = { capacity: 2, per_ms: 60_000 };
    const codes = [];
    for (const dev of [r.bob, r.bob, r.carol]) codes.push((await r.call(dev, share.id, 'state', { session: s.session })).status);
    assert.deepEqual(codes, [200, 200, 429]);
  } finally { await r.close(); }
});

test('BACKSTOP: share rows — host must be the owner\'s device, expiry never extended, a stop is final', async () => {
  const r = await rig();
  try {
    const row = (dev) => ({ id: rid(), owner_user_id: r.macA.user, host_device_id: dev, session_id: rid(), org_id: r.org, scope: 'watch', created_at: r.h.hub.iso(), expires_at: '2026-10-01T00:00:00.000Z' });
    assert.throws(() => r.h.db.insert('interaction_shares', row(r.bob.device)), /owner's device/);
    const ok = row(r.macA.device);
    r.h.db.insert('interaction_shares', ok);
    const set = (sql, ...a) => () => r.h.db.run(`UPDATE interaction_shares SET ${sql} WHERE id = ?`, ...a, ok.id);
    assert.throws(set('expires_at = ?', '2026-12-01T00:00:00.000Z'), /cannot be extended/);
    assert.throws(set('expires_at = NULL'), /cannot be extended/);
    set('expires_at = ?', '2026-09-30T12:00:00.000Z')();
    set('revoked_at = ?, revoked_by = ?', r.h.hub.iso(), r.macA.user)();
    assert.throws(set('revoked_at = NULL'), /stays stopped/);
    assert.throws(set('revoked_by = NULL'), /stays stopped/);
    assert.throws(set('revoked_by = ?', r.bob.user), /stays stopped/);
    assert.throws(set('revoked_at = ?', '2027-01-01T00:00:00.000Z'), /stays stopped/);
  } finally { await r.close(); }
});

test('HOSTILE: deleting the owner\'s account stops their shares', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    r.h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", r.h.ids.bob);
    const flow = await r.h.stepUp(r.winA.token, 'alice@dev.local');
    const del = await r.h.call('DELETE', '/api/account', { token: r.winA.token, body: { flow_id: flow } });
    assert.equal(del.status, 200, del.text);
    assert.ok(r.h.db.get('SELECT revoked_at FROM interaction_shares WHERE id = ?', share.id).revoked_at);
    assert.equal((await r.call(r.bob, share.id, 'state', { session: s.session })).status, 404);
  } finally { await r.close(); }
});

test('QUOTA: a host holds at most 64 live shares; expired-but-unrevoked shares do not take a slot', async () => {
  const r = await rig();
  try {
    const create = () => r.h.call('POST', '/api/interaction/v1/shares', { token: r.macA.token, body: { session: rid(), team: r.org, scope: 'watch' } });
    const row = (expires) => r.h.db.insert('interaction_shares', { id: rid(), owner_user_id: r.macA.user, host_device_id: r.macA.device, session_id: rid(), org_id: r.org, scope: 'watch', created_at: r.h.hub.iso(), expires_at: expires });
    for (let i = 0; i < 62; i++) row(null);
    const soon = new Date(r.h.clock.wall() + 60_000).toISOString();
    row(soon);
    assert.equal((await create()).status, 200, 'the 64th');
    const full = await create();
    assert.equal(full.body.error?.code, 'QUOTA_EXCEEDED', full.text);
    r.h.clock.advance(61_000);
    assert.equal((await create()).status, 200, 'the expired share no longer counts');
    assert.equal((await create()).body.error?.code, 'QUOTA_EXCEEDED');
  } finally { await r.close(); }
});

test('HOSTILE: the hub forwards a team viewer\'s call to the Mac as watch-only, whatever the share\'s scope', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    r.h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", r.h.ids.bob);
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    const relay = r.h.hub.interactionRelay, orig = relay.dispatch, frames = [];
    relay.dispatch = function (host, frame, ...a) { frames.push(frame); return orig.call(this, host, frame, ...a); };
    try {
      assert.equal((await r.call(r.bob, share.id, 'state', { session: s.session })).status, 200);
      r.h.db.run("UPDATE members SET role = 'member' WHERE id = ?", r.h.ids.bob);
      assert.equal((await r.call(r.bob, share.id, 'state', { session: s.session })).status, 200);
    } finally { relay.dispatch = orig; }
    assert.deepEqual(frames.map((f) => f.share.scope), ['watch', 'interact']);
  } finally { await r.close(); }
});

test('HISTORY: a teammate\'s steer into a turn that began before the share does not show that turn\'s response (hub and Mac)', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    await r.ownerSend(s, 'HOLD pre-share work');
    const turn = await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).activeTurn);
    r.h.clock.advance(1000);
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    const steer = await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation, text: 'more', expectedTurn: turn });
    assert.equal(steer.body.result.delivery?.mode, 'steer', steer.text);
    assert.equal(steer.body.result.delivery.response, '', 'the immediate steer receipt cannot reveal a pre-share turn response');
    await until(() => r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.find((d) => d.text === 'more' && d.state === 'completed'));
    assert.ok(r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.find((d) => d.text === 'more').response, 'the owner still sees it');
    const seen = (await r.call(r.bob, share.id, 'state', { session: s.session })).body.result.state.deliveries;
    assert.deepEqual(seen.map((d) => [d.text, d.response]), [['more', '']]);
    // The Mac withholds it on its own, too.
    const direct = await r.mac.handle(r.frame('state', { session: s.session }, share, r.bob));
    assert.deepEqual(direct.state.deliveries.map((d) => d.response), ['']);
    // …and so does the hub, whatever the Mac answers.
    const relay = r.h.hub.interactionRelay, orig = relay.dispatch;
    relay.dispatch = async function (...a) {
      const res = await orig.apply(this, a);
      return { ...res, delivery: { ...res.state.deliveries[0], response: 'pre-share output' }, state: { ...res.state, deliveries: res.state.deliveries.map((d) => ({ ...d, response: 'pre-share output' })) } };
    };
    try {
      const got = await r.call(r.bob, share.id, 'state', { session: s.session });
      assert.ok(!got.text.includes('pre-share output'), got.text);
    } finally { relay.dispatch = orig; }
    // A turn a teammate starts after the share shows its response.
    const fresh = await r.call(r.bob, share.id, 'send', { session: s.session, generation: s.generation, text: 'new turn' });
    assert.equal(fresh.body.result.status, 'acknowledged', fresh.text);
    const done = await until(async () => (await r.call(r.bob, share.id, 'state', { session: s.session })).body.result.state.deliveries.find((d) => d.text === 'new turn' && d.state === 'completed'));
    assert.equal(done.response, 'echo:new turn');
  } finally { await r.close(); }
});


test('LOCAL PROOF: actual shared endpoint reaches Overview once, with live Message and revocation', async () => {
  const { createTeamHubClient } = require('../../../src/team-hub-client.js');
  const { createOverviewService } = require('../../../src/overview-service.js');
  const r = await rig();
  let bobHost = null;
  try {
    const s = await r.launch();
    const made = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    assert.equal(made.ok, true);
    bobHost = createRemoteInteractionHost({ userId: r.bob.user, adapters: { codex: createCodexAppServer({ bin: FAKE, spawn: spawnProviderFixture }) }, now: () => r.h.clock.wall() });
    assert.equal((await bobHost.enable({ baseUrl: r.h.base, token: r.bob.token, WebSocket })).state, 'connected');
    const bobSession = (await bobHost.hub.launch({ provider: 'codex' }, bobHost.actor)).state;
    assert.equal((await bobHost.shareSession({ session: bobSession.session, team: r.org, scope: 'interact' })).ok, true);
    const aliceHub = createTeamHubClient({ baseUrl: r.h.base, token: () => r.macA.token, viewerId: r.macA.user }, { now: () => r.h.clock.wall() });
    const aliceOverview = createOverviewService({ now: () => r.h.clock.wall(), hubTeams: async () => ({ origin: r.h.base, teams: [{ id: r.org, name: 'Dev team' }] }), teamHub: () => aliceHub });
    const aliceRows = await aliceOverview.directory({ view: 'team', team: null });
    assert.equal(aliceRows.entries.length, 1, 'two live hosting desktops can discover each other');
    r.h.clock.advance(1);
    assert.equal((await aliceOverview.teamMessage({ id: aliceRows.entries[0].id, text: 'alice into bob session' })).ok, true);
    assert.ok(bobHost.hub.state({ session: bobSession.session }, bobHost.actor).deliveries.some(d => d.text === 'alice into bob session'));
    const raw = (await r.shared(r.bob)).body.shared;
    assert.equal(raw[0].owner.id, r.macA.user, 'server supplies owner identity to main');
    const hub = createTeamHubClient({ baseUrl: r.h.base, token: () => r.bob.token, viewerId: r.bob.user }, { now: () => r.h.clock.wall() });
    assert.equal(Object.getOwnPropertyDescriptor(hub, 'origin').writable, false);
    const overview = createOverviewService({ now: () => r.h.clock.wall(), hubTeams: async () => ({ origin: r.h.base, teams: [{ id: r.org, name: 'Dev team' }] }), teamHub: () => hub });
    const rows = await overview.directory({ view: 'team', team: null });
    assert.equal(rows.teams.length, 1, 'signed-in teams and real client use one canonical origin');
    assert.equal(rows.entries.length, 1, 'genuine endpoint is accepted by client');
    assert.equal(rows.entries[0].freshness, 'recent', 'authorized owner answer has receiver time');
    assert.equal(rows.entries[0].capabilities.receive.available, true, 'Message can be rendered');
    assert.equal(rows.entries[0].observedAt, r.h.clock.wall());
    assert.equal(JSON.stringify(rows).includes(r.macA.user), false, 'owner account id stays in main');
    r.h.clock.advance(1);
    const selected = await overview.teamInspect({ id: rows.entries[0].id });
    assert.equal(selected.ok, true);
    const sent = await overview.teamAction({ selection: selected.selection, operation: 'send', text: 'overview teammate turn' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.ok(r.mac.hub.state({ session: s.session }, r.mac.actor).deliveries.some(d => d.text === 'overview teammate turn'));
    await until(async () => { const refreshed = await overview.teamInspect({ id: rows.entries[0].id }); return refreshed.state?.deliveries.some(d => d.text === 'overview teammate turn' && d.state === 'completed' && d.response); });
    r.h.db.run("UPDATE members SET role = 'viewer' WHERE org_id = ? AND user_id = ?", r.org, r.bob.user);
    const watch = await overview.directory({ view: 'team', team: rows.team.key });
    assert.equal(watch.entries[0].capabilities.receive.available, false);
    assert.equal(watch.entries[0].interact, null);
    assert.equal((await overview.teamMessage({ id: rows.entries[0].id, text: 'viewer cannot send' })).ok, false);
    r.h.db.run("UPDATE members SET role = 'member' WHERE org_id = ? AND user_id = ?", r.org, r.bob.user);
    assert.equal((await r.mac.stopSharing(made.share.id)).ok, true);
    assert.equal((await overview.teamMessage({ id: rows.entries[0].id, text: 'after revoke' })).ok, false);
    assert.equal((await overview.directory({ view: 'team', team: rows.team.key })).entries.length, 0);
  } finally { bobHost?.close(); await r.close(); }
});


test('replacing a share releases its parked watches before a new watch and send consume teammate capacity', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const old = (await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' })).share;
    let oldResult = null;
    const parked = r.mac.handle(r.frame('watch', { session: s.session, after: 1_000_000 }, old, r.bob)).then((value) => { oldResult = value; return value; });
    const made = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    assert.equal(made.ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(oldResult, 'revoked share watch must settle without waiting for a polling timer');
    assert.equal(oldResult.status, 'stale');
    const freshWatch = r.mac.handle(r.frame('watch', { session: s.session, after: 1_000_000 }, made.share, r.bob));
    const sent = await r.mac.handle(r.frame('send', { session: s.session, generation: s.generation, text: 'replacement-share-send' }, made.share, r.bob));
    assert.equal(sent.ok, true, JSON.stringify(sent));
    r.mac.stopSharing(made.share.id);
    assert.equal((await freshWatch).ok, false);
    const last = (await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' })).share;
    const stopped = [];
    for (let n = 0; n < 2; n++) r.mac.handle(r.frame('watch', { session: s.session, after: 1_000_000 }, last, r.bob)).then((value) => stopped.push(value));
    r.mac.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped.length, 2, 'stopping hosting must release parked watches immediately');
    assert.ok(stopped.every((value) => value.status === 'stale'));
  } finally { await r.close(); }
});

// Owner-reviewed delegation: real local accounts, HTTP routes, SQLite,
// WebSocket relay and host adapter; the provider remains a disposable fixture.
async function proposalRig(r) {
  const state = await r.launch();
  const { share } = await r.mac.shareSession({ session: state.session, team: r.org, scope: 'interact' });
  r.h.clock.advance(1);
  const client = createReportingTeamHubClient({ baseUrl: r.h.base, token: () => r.bob.token, viewerId: r.bob.user }, { now: () => r.h.clock.wall() });
  const viewer = { id: r.bob.user }, decision = rid();
  const create = async (version = 1, text = 'reviewed proposal', options = {}) => client.proposals(viewer,r.org,share.id,'request', { id:rid(),decision,version,generation:state.generation,title:'Review parser',text,...options });
  const approve = p => r.mac.proposalApprove({ share:share.id,id:p.id,version:p.version,digest:p.digest,expiresInS:600 });
  const send = p => client.proposals(viewer,r.org,share.id,'send',p);
  return {state,share,client,viewer,create,approve,send};
}

test('PROPOSALS: owner acknowledges exact decision; requester sends one durable action and correlated receipt', async () => {
 const r=await rig(); try {
  const x=await proposalRig(r), made=await x.create(); assert.equal(made.ok,true,JSON.stringify(made));
  const p=made.proposal;
  assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.length,0);
  assert.equal((await x.send(p)).ok,false,'pending request cannot execute');
  assert.equal((await x.approve(p)).ok,true);
  const list=await x.client.proposals(x.viewer,r.org,x.share.id,'list');
  assert.equal(list.proposals[0].status,'approved'); assert.ok(list.proposals[0].acknowledgedAt);
  r.h.clock.advance(1);
  const sent=await x.send(list.proposals[0]); assert.equal(sent.ok,true,JSON.stringify(sent)); assert.equal(sent.proposal.status,'sent'); assert.ok(sent.proposal.receipt.id);
  assert.equal((await x.send(list.proposals[0])).ok,false,'one action budget persists after dispatch');
  assert.equal(r.h.db.get('SELECT status FROM interaction_proposals WHERE id=?',p.id).status,'sent');
  assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.filter(d=>d.text==='reviewed proposal').length,1);
 }finally{await r.close();}
});

test('PROPOSALS: supersession, revoke, viewer scope and foreign actors refuse without provider work', async () => {
 const r=await rig(); try {
  const x=await proposalRig(r), first=(await x.create()).proposal; assert.equal((await x.approve(first)).ok,true);
  const newer=(await x.create(2,'replacement decision')).proposal;
  assert.equal((await x.send(first)).ok,false,'old decision cannot dispatch');
  assert.equal((await x.approve(first)).ok,false,'old acknowledgement cannot be revived');
  assert.equal((await x.approve(newer)).ok,true);
  assert.equal((await r.mac.proposalRevoke({share:x.share.id,id:newer.id})).ok,true);
  assert.equal((await x.send(newer)).ok,false);
  const foreign=await r.h.call('GET',`/api/interaction/v1/shared/${x.share.id}/proposals`,{token:r.carol.token});assert.equal(foreign.status,404);
  r.h.db.run("UPDATE members SET role='viewer' WHERE org_id=? AND user_id=?",r.org,r.bob.user);
  assert.equal((await x.create(3)).ok,false);
  assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.length,0);
 }finally{await r.close();}
});

test('PROPOSALS: host rejects a forged or reused approval even with an interact share',async()=>{
 const r=await rig();try{
  const x=await proposalRig(r),p=(await x.create()).proposal;
  const frame=()=>r.frame('send',{session:x.state.session,generation:x.state.generation,text:p.text},x.share,r.bob,{proposal:{id:p.id,digest:p.digest,version:p.version}});
  assert.equal((await r.mac.handle(frame())).ok,false,'hub cannot invent local owner approval');
  assert.equal((await x.approve(p)).ok,true);
  assert.equal((await r.mac.handle(frame())).ok,false,'host checks persisted admission, not only cached approval');
  assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.length,0);
 }finally{await r.close();}
});

test('PROPOSALS: revocation during approval response cannot reinstall local authority',async()=>{
 const r=await rig();try{
  const x=await proposalRig(r),p=(await x.create()).proposal;
  const service=r.h.hub.interactionShares.proposals, original=service.approve.bind(service);
  let release, entered;const at=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
  service.approve=async(...a)=>{const out=original(...a);entered();await hold;return out;};
  const approving=x.approve(p);await at;
  assert.equal((await r.mac.proposalRevoke({share:x.share.id,id:p.id})).ok,true);
  release();assert.equal((await approving).ok,false);
  const frame=r.frame('send',{session:x.state.session,generation:x.state.generation,text:p.text},x.share,r.bob,{proposal:{id:p.id,digest:p.digest,version:p.version}});
  assert.equal((await r.mac.handle(frame)).ok,false);
  assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.length,0);
 }finally{await r.close();}
});

test('PROPOSALS: document change during owner acknowledgement never grants execution',async()=>{
 const r=await rig();try{
  const x=await proposalRig(r),p=(await x.create()).proposal;
  const service=r.h.hub.interactionShares.proposals, original=service.approve.bind(service);
  let current=true;service.approve=(...a)=>{const out=original(...a);current=false;return out;};
  assert.equal((await r.mac.proposalApprove({share:x.share.id,id:p.id,version:p.version,digest:p.digest,expiresInS:600},()=>current)).ok,false);
  assert.equal((await x.send(p)).proposal.status,'refused','server approval without current local owner grant cannot execute');
  assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.length,0);
 }finally{await r.close();}
});

test('PROPOSALS: expiry, deletion retention and changed generations fail safely',async()=>{
 const r=await rig();try{
  const x=await proposalRig(r),p=(await x.create()).proposal;assert.equal((await x.approve(p)).ok,true);
  r.h.clock.advance(600001);assert.equal((await x.send(p)).ok,false);
  const next=(await x.create(2,'stale generation',{generation:x.state.generation+1})).proposal;
  assert.equal((await x.approve(next)).ok,false);
  r.h.clock.advance(7*86400000);r.h.hub.interactionShares.proposals.prune();
  assert.equal(r.h.db.get('SELECT COUNT(*) AS n FROM interaction_proposals').n,0);
  assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.length,0);
 }finally{await r.close();}
});

test('PROPOSALS: supersession while owner response is held refuses that old local grant',async()=>{
 const r=await rig();try{
  const x=await proposalRig(r),p=(await x.create()).proposal;
  const service=r.h.hub.interactionShares.proposals, original=service.approve.bind(service);
  let release,entered;const at=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
  service.approve=async(...a)=>{const out=original(...a);entered();await hold;return out;};
  const approving=x.approve(p);await at;const next=await x.create(2,'newest version');assert.equal(next.ok,true);release();
  assert.equal((await approving).ok,false);
  assert.equal((await x.send(p)).ok,false);
  assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.length,0);
 }finally{await r.close();}
});

test('PROPOSALS: lost acknowledgement persists uncertainty and never permits automatic retry',async()=>{
 const r=await rig();try{
  const x=await proposalRig(r),p=(await x.create()).proposal;assert.equal((await x.approve(p)).ok,true);
  const relay=r.h.hub.interactionRelay,original=relay.dispatch.bind(relay);
  relay.dispatch=async(...a)=>{const out=await original(...a);if(a[1]?.share?.proposal)throw new Error('discarded response');return out;};
  assert.equal((await x.send(p)).ok,false);
  assert.equal(r.h.db.get('SELECT status FROM interaction_proposals WHERE id=?',p.id).status,'unconfirmed');
  relay.dispatch=original;assert.equal((await x.send(p)).ok,false);
  assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.filter(d=>d.text===p.text).length,1);
 }finally{await r.close();}
});

test('PROPOSALS: revocation while relay admission is held prevents later host effect',async()=>{
 const r=await rig();try{
  const x=await proposalRig(r),p=(await x.create()).proposal;assert.equal((await x.approve(p)).ok,true);
  const relay=r.h.hub.interactionRelay,original=relay.dispatch.bind(relay);
  let release,entered;const at=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
  relay.dispatch=async(...a)=>{if(a[1]?.share?.proposal){entered();await hold;}return original(...a);};
  const sending=x.send(p);await at;await r.mac.proposalRevoke({share:x.share.id,id:p.id});release();
  const out=await sending;assert.equal(out.proposal.status,'refused');assert.equal(r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries.length,0);
 }finally{await r.close();}
});

test('PROPOSALS: Overview coordinator reaches persisted owner review and exact provider receipt through production services',async()=>{
 const r=await rig();try{
  const {createOverviewService}=require('../../../src/overview-service.js');
  const x=await proposalRig(r),overview=createOverviewService({now:()=>r.h.clock.wall(),teamHub:()=>x.client});
  const inventory=await overview.coordinatorInventory({team:null});assert.equal(inventory.ok,true);
  const entry=inventory.entries[0];assert.ok(entry?.available);
  const review=await overview.coordinatorPropose({team:inventory.team.key,title:'Team review',assignments:[{id:entry.id,name:'Named reviewer',text:'Exact owner reviewed task'}]});assert.equal(review.ok,true);assert.equal(review.assignments[0].status,'review');
  const requested=await overview.coordinatorRequestOwner({proposal:review.proposal});assert.equal(requested.assignments[0].status,'awaiting-owner');
  const owner=await r.mac.proposalList(x.share.id);assert.equal(owner.proposals.length,1);assert.equal((await x.approve(owner.proposals[0])).ok,true);
  const listed=await overview.coordinatorRemoteList({id:entry.id});assert.equal(listed.proposals[0].status,'approved');
  const revised=await overview.coordinatorRemoteReplace({selection:listed.proposals[0].selection,text:'Revised exact task'});assert.equal(revised.ok,true);assert.equal(revised.proposal.version,2);
  assert.equal((await x.send(listed.proposals[0])).ok,false,'the older owner-approved version was retired');
  assert.equal((await x.approve(revised.proposal)).ok,true);
  const fresh=await overview.coordinatorRemoteList({id:entry.id}),approved=fresh.proposals.find(p=>p.status==='approved');
  const sent=await overview.coordinatorRemoteSend({selection:approved.selection});assert.equal(sent.ok,true,JSON.stringify(sent));assert.equal(sent.proposal.status,'sent');assert.ok(sent.proposal.receipt.id);
  assert.equal((await overview.coordinatorRemoteSend({selection:approved.selection})).ok,false);
  const deliveries=r.mac.hub.state({session:x.state.session},r.mac.actor).deliveries;
  assert.equal(deliveries.filter(d=>d.text==='Revised exact task').length,1);assert.equal(deliveries.some(d=>d.text==='Exact owner reviewed task'),false);
 }finally{await r.close();}
});

test('PROPOSALS: a different owned share cannot revoke another session grant by guessing its ID',async()=>{
 const r=await rig();try{
  const x=await proposalRig(r),p=(await x.create()).proposal;assert.equal((await x.approve(p)).ok,true);
  const second=await r.launch(),other=(await r.mac.shareSession({session:second.session,team:r.org,scope:'interact'})).share;
  assert.equal((await r.mac.proposalRevoke({share:other.id,id:p.id})).ok,false);
  const sent=await x.send(p);assert.equal(sent.proposal.status,'sent');
 }finally{await r.close();}
});

// ── T0: automatic shares watch; one share per session and team; no manual share is ever replaced by an automatic one ──

// Holds the next share-create POST (before it reaches the hub) so a test can run another create meanwhile.
function gateShareCreates() {
  const real = globalThis.fetch, gate = { posts: 0, signals: [], hold: null, entered: null };
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/api/interaction/v1/shares')) {
      gate.posts++; gate.signals.push(init.signal);
      const hold = gate.hold; gate.hold = null;
      if (hold) { gate.entered?.(); await hold.promise; if (hold.fail) throw new Error('connection lost'); }
    }
    return real(url, init);
  };
  gate.restore = () => { globalThis.fetch = real; };
  gate.holdNext = (fail = false) => { let resolve; const promise = new Promise((r) => { resolve = r; }); const entered = new Promise((r) => { gate.entered = r; }); gate.hold = { promise, fail }; return { release: resolve, entered }; };
  return gate;
}
const live = (r, session) => r.h.db.all('SELECT * FROM interaction_shares WHERE session_id = ? AND revoked_at IS NULL', session);
// An acting teammate's relayed ops against a share: send, steer (send with expectedTurn) and interrupt are refused; state and watch still work.
async function assertWatchOnly(r, s, share) {
  for (const [op, args] of [['send', { text: 'x' }], ['send', { text: 'x', expectedTurn: 'turn-1' }], ['interrupt', { turn: 'turn-1' }]]) {
    const res = await r.mac.handle(r.frame(op, { session: s.session, generation: s.generation, ...args }, share, r.bob));
    assert.deepEqual([res.ok, res.status, res.error], [false, 'forbidden', 'This session is not shared with you.'], `${op} ${JSON.stringify(args)}`);
    const hub = await r.call(r.bob, share.id, op, { session: s.session, generation: s.generation, ...args });
    assert.equal(hub.status, 403, op); assert.equal(hub.body.error.reason, 'SCOPE');
  }
  assert.equal((await r.mac.handle(r.frame('state', { session: s.session }, share, r.bob))).ok, true);
}

test('T0: an automatic watch share replaced by a manual watch share leaves exactly one watch share; send, steer and interrupt stay refused', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const auto = await r.mac.shareSessionAutomatic({ session: s.session, team: r.org, scope: 'watch' });
    assert.equal(auto.ok, true); assert.equal(auto.share.scope, 'watch');
    const manual = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch', expiresInS: 3600 });
    assert.equal(manual.ok, true);
    assert.deepEqual(r.mac.shared().map((x) => [x.id, x.scope]), [[manual.share.id, 'watch']]);
    assert.deepEqual(live(r, s.session).map((x) => [x.id, x.scope]), [[manual.share.id, 'watch']]);
    assert.equal((await r.call(r.bob, auto.share.id, 'state', { session: s.session })).status, 404, 'the automatic share is dead');
    await assertWatchOnly(r, s, manual.share);
  } finally { await r.close(); }
});

test('T0: a send-capable share from before the change, replaced by a manual watch share, leaves exactly one watch share', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const old = (await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' })).share;
    const manual = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    assert.equal(manual.ok, true);
    assert.deepEqual(live(r, s.session).map((x) => [x.id, x.scope]), [[manual.share.id, 'watch']]);
    const refused = await r.mac.handle(r.frame('send', { session: s.session, generation: s.generation, text: 'x' }, old, r.bob));
    assert.equal(refused.status, 'forbidden', 'the old interact share id no longer works');
    await assertWatchOnly(r, s, manual.share);
  } finally { await r.close(); }
});

test('T0 race: a manual share made while an automatic create is in flight ends as the only live share, with its expiry', async () => {
  const gate = gateShareCreates(), r = await rig();
  try {
    const s = await r.launch(), held = gate.holdNext();
    const auto = r.mac.shareSessionAutomatic({ session: s.session, team: r.org, scope: 'watch' });
    await held.entered;
    const manual = r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch', expiresInS: 3600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(gate.posts, 1, 'the manual create waits for the automatic one');
    held.release();
    const [a, m] = await Promise.all([auto, manual]);
    assert.equal(a.ok, true); assert.equal(m.ok, true);
    const rows = live(r, s.session);
    assert.deepEqual(rows.map((x) => x.id), [m.share.id]);
    assert.notEqual(rows[0].expires_at, null, 'the manual expiry survives');
    assert.deepEqual(r.mac.shared().map((x) => x.id), [m.share.id]);
  } finally { gate.restore(); await r.close(); }
});

test('T0 race: an automatic create yields to a manual one in flight, with no hub call', async () => {
  const gate = gateShareCreates(), r = await rig();
  try {
    const s = await r.launch(), held = gate.holdNext();
    const manual = r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch', expiresInS: 3600 });
    await held.entered;
    const auto = r.mac.shareSessionAutomatic({ session: s.session, team: r.org, scope: 'interact' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    held.release();
    const [m, a] = await Promise.all([manual, auto]);
    assert.equal(m.ok, true);
    assert.deepEqual([a.ok, a.status], [false, 'exists']);
    assert.equal(gate.posts, 1, 'only the manual create reached the hub');
    assert.deepEqual(live(r, s.session).map((x) => [x.id, x.scope]), [[m.share.id, 'watch']]);
  } finally { gate.restore(); await r.close(); }
});

test('T0: the create has a deadline, and a failed create releases the lock for the next one', async () => {
  const gate = gateShareCreates(), r = await rig();
  try {
    const s = await r.launch(), held = gate.holdNext(true);
    const first = r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    await held.entered;
    const second = r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    held.release();
    assert.equal((await first).ok, false);
    assert.equal((await second).ok, true);
    assert.ok(gate.signals.every((x) => x instanceof AbortSignal), 'every create is bounded by an abort signal');
    assert.equal(live(r, s.session).length, 1);
  } finally { gate.restore(); await r.close(); }
});

test('T0: automatic creation validates its scope and is not part of the manual path', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    for (const scope of [undefined, 'admin', 'WATCH']) assert.equal((await r.mac.shareSessionAutomatic({ session: s.session, team: r.org, scope })).ok, false, String(scope));
    assert.equal((await r.mac.shareSessionAutomatic({ team: r.org, scope: 'watch' })).ok, false);
    assert.equal(live(r, s.session).length, 0);
  } finally { await r.close(); }
});

test('T0: after a restart, the hub ends a send-capable share the new host does not know', async () => {
  const r = await rig();
  let again;
  try {
    const s = await r.launch();
    const old = (await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' })).share;
    r.mac.close();
    again = createRemoteInteractionHost({ userId: r.macA.user, adapters: {}, boardCurrent: (b) => b === null, now: () => r.h.clock.wall() });
    assert.equal((await again.enable({ baseUrl: r.h.base, token: r.macA.token, WebSocket })).state, 'connected');
    assert.equal((await again.listShares()).ok, true);
    await until(() => live(r, s.session).length === 0);
    assert.deepEqual(again.shared(), []);
    assert.equal((await r.call(r.bob, old.id, 'state', { session: s.session })).status, 404);
  } finally { again?.close(); await r.close(); }
});

test('T0: Allow sending (a replacing interact share) leaves exactly one interact share; an acting member sends, a viewer is refused', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const auto = (await r.mac.shareSessionAutomatic({ session: s.session, team: r.org, scope: 'watch' })).share;
    const up = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact', expiresInS: 3000 });
    assert.equal(up.ok, true);
    assert.deepEqual(live(r, s.session).map((x) => [x.id, x.scope]), [[up.share.id, 'interact']]);
    assert.deepEqual(r.mac.shared().map((x) => [x.id, x.scope]), [[up.share.id, 'interact']]);
    assert.equal((await r.call(r.bob, auto.id, 'state', { session: s.session })).status, 404, 'the watch share is dead');
    const sent = await r.call(r.bob, up.share.id, 'send', { session: s.session, generation: s.generation, text: 'member send' });
    assert.equal(sent.body.result.status, 'acknowledged', sent.text);
    r.h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", r.h.ids.bob);
    const refused = await r.call(r.bob, up.share.id, 'send', { session: s.session, generation: s.generation, text: 'viewer send' });
    assert.equal(refused.status, 403); assert.equal(refused.body.error.reason, 'SCOPE');
  } finally { await r.close(); }
});

test('T0: a create that never answers is cut off at its 15 s deadline, and the lock then lets the next create through', async () => {
  const realFetch = globalThis.fetch, realTimeout = AbortSignal.timeout;
  const deadlines = []; // AbortSignal.timeout is faked: advancing the "clock" means aborting the signal handed out
  AbortSignal.timeout = (ms) => { const c = new AbortController(); deadlines.push({ ms, abort: () => c.abort(new DOMException('timed out', 'TimeoutError')) }); return c.signal; };
  let hung = true;
  globalThis.fetch = (url, init) => (hung && init?.method === 'POST' && String(url).endsWith('/api/interaction/v1/shares')
    ? new Promise((_, reject) => { hung = false; init.signal.addEventListener('abort', () => reject(init.signal.reason)); })
    : realFetch(url, init));
  const r = await rig();
  try {
    const s = await r.launch();
    deadlines.length = 0; hung = true;
    const first = r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    const second = r.mac.shareSessionAutomatic({ session: s.session, team: r.org, scope: 'watch' });
    const third = r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact', expiresInS: 3600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(deadlines.map((d) => d.ms), [15_000], 'one create is in flight; the others wait behind the lock');
    assert.equal(live(r, s.session).length, 0);
    deadlines[0].abort(); // 15 s pass
    assert.equal((await first).ok, false);
    assert.equal((await second).ok, true, 'the next create proceeds');
    assert.equal((await third).ok, true);
    assert.deepEqual(live(r, s.session).map((x) => x.scope), ['interact']);
    assert.deepEqual(deadlines.map((d) => d.ms), [15_000, 15_000, 15_000]);
  } finally { AbortSignal.timeout = realTimeout; globalThis.fetch = realFetch; await r.close(); }
});

test('T0: a create that throws releases the lock, and the next create for the same session and team goes through', async () => {
  const r = await rig();
  try {
    const s = await r.launch(), state = r.mac.hub.state.bind(r.mac.hub);
    let boom = true;
    r.mac.hub.state = (...args) => { if (boom) { boom = false; throw new Error('provider state failed'); } return state(...args); };
    const first = r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    const queued = r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact', expiresInS: 3600 });
    await assert.rejects(first, /provider state failed/);
    const made = await queued;
    assert.equal(made.ok, true);
    assert.deepEqual(live(r, s.session).map((x) => x.scope), ['interact']);
    assert.equal((await r.mac.shareSessionAutomatic({ session: s.session, team: r.org, scope: 'watch' })).status, 'exists');
  } finally { await r.close(); }
});

// ---- Share viewers (ledger 32): a grantee's "I have this open" beat, shown to the owner ----
const view = (r, dev, share, viewing = true, extra = {}) => r.h.call('POST', `/api/interaction/v1/shared/${share}/view`, { token: dev.token, body: { viewing, ...extra } });
const viewers = async (r) => (await r.h.call('GET', '/api/interaction/v1/shares', { token: r.macA.token })).body.shares.map((s) => s.viewers);
const held = (r) => r.h.hub.interactionShares.viewing;

test('SHARE VIEWERS: a grantee beat shows the owner who is watching; leaving, TTL and revoke clear it; nothing is stored', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    assert.deepEqual(await viewers(r), [[]]);
    const rows = r.h.db.get('SELECT (SELECT count(*) FROM interaction_shares) a, (SELECT count(*) FROM journal) b').b;
    const beat = await view(r, r.bob, share.id);
    assert.equal(beat.status, 200); assert.deepEqual(beat.body, { viewing: true });
    const [[v]] = await viewers(r);
    assert.deepEqual({ user_id: v.user_id, name: v.name }, { user_id: r.bob.user, name: r.bobName });
    assert.equal(v.at, r.h.hub.iso());
    assert.equal(r.h.db.get('SELECT count(*) b FROM journal').b, rows);
    assert.ok(!JSON.stringify(r.h.db.all('SELECT * FROM interaction_shares')).includes(r.bob.user));
    // Leaving clears at once; the answer is the same either way.
    assert.deepEqual((await view(r, r.bob, share.id, false)).body, { viewing: false });
    assert.deepEqual(await viewers(r), [[]]); assert.equal(held(r).size, 0);
    // Silent for the TTL: gone on read, then swept by the reaper.
    await view(r, r.bob, share.id);
    r.h.clock.advance(89_000); assert.equal((await viewers(r))[0].length, 1);
    r.h.clock.advance(2_000); assert.deepEqual(await viewers(r), [[]]);
    assert.equal(held(r).size, 1);                       // still held until the reaper runs
    await r.h.hub.tick(); assert.equal(held(r).size, 0);   // one reaper pass ages it out
    // The owner stopping the share, or the team removing the member, clears it.
    await view(r, r.bob, share.id);
    await r.h.call('DELETE', `/api/interaction/v1/shares/${share.id}`, { token: r.macA.token, body: {} });
    assert.equal(held(r).size, 0);
    assert.equal((await view(r, r.bob, share.id)).status, 404);
    const b = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    await view(r, r.bob, b.share.id); assert.equal(held(r).size, 1);
    r.h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', r.h.hub.iso(), r.h.ids.bob);
    assert.deepEqual(await viewers(r), [[]]);          // filtered on read, even before the hook
    r.h.hub.memberChanged(r.h.ids.bob); assert.equal(held(r).size, 0);
    // Admin revoke clears too.
    r.h.db.run('UPDATE members SET removed_at = NULL WHERE id = ?', r.h.ids.bob);
    await view(r, r.bob, b.share.id); assert.equal(held(r).size, 1);
    assert.equal((await r.h.call('DELETE', `/api/teams/${r.org}/interaction-shares/${b.share.id}`, { token: r.winA.token, body: {} })).status, 200);
    assert.equal(held(r).size, 0);
  } finally { await r.close(); }
});

test('SHARE VIEWERS HOSTILE: only a grantee of a live share can beat; everyone else gets the same 404 and nothing is stored', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'interact' });
    const s2 = await r.launch();   // a second session: sharing the same one again would replace the first share
    const gone = await r.mac.shareSession({ session: s2.session, team: r.org, scope: 'watch', expiresInS: 60 });
    const missing = [
      await view(r, r.macA, share.id),
      await view(r, r.winA, share.id),                              // nor is the owner's other device
      await view(r, r.carol, share.id),                             // outsider
      await view(r, r.bob, '00000000-0000-4000-8000-000000000000'), // unknown
      await view(r, r.bob, 'not-a-uuid'),
    ];
    for (const m of missing) assert.equal(m.status, 404, m.text);
    assert.equal(new Set(missing.map((m) => m.text)).size, 1);
    assert.equal(held(r).size, 0);
    // Another team's member, and a removed member.
    const other = r.h.db.get('SELECT id FROM orgs WHERE id != ? LIMIT 1', r.org)?.id;
    if (other) r.h.db.run('UPDATE members SET org_id = ? WHERE id = ?', other, r.h.ids.bob);
    else r.h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', r.h.hub.iso(), r.h.ids.bob);
    assert.equal((await view(r, r.bob, share.id)).status, 404);
    assert.equal(held(r).size, 0);
    r.h.db.run('UPDATE members SET org_id = ?, removed_at = NULL WHERE id = ?', r.org, r.h.ids.bob);
    // Owner no longer a member of the team: nobody can beat.
    r.h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", r.h.ids.bob);
    r.h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', r.h.hub.iso(), r.h.ids.alice);
    assert.equal((await view(r, r.bob, share.id)).status, 404);
    r.h.db.run('UPDATE members SET removed_at = NULL WHERE id = ?', r.h.ids.alice);
    // Expired, and a revoked device token.
    r.h.clock.advance(61_000);
    assert.equal((await view(r, r.bob, gone.share.id)).status, 404);
    assert.equal(held(r).size, 0);
    assert.equal((await r.h.call('POST', `/api/interaction/v1/shared/${share.id}/view`, { body: { viewing: true } })).status, 401);
    // The body is closed.
    for (const body of [{}, { viewing: 'yes' }, { viewing: true, request_id: rid() }, { viewing: true, name: 'Eve' }, []]) {
      const res = await r.h.call('POST', `/api/interaction/v1/shared/${share.id}/view`, { token: r.bob.token, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(held(r).size, 0);
  } finally { await r.close(); }
});

test('SHARE VIEWERS: repeat beats are dropped inside half the presence floor, a change is not, the bucket and the cap bound a flood, names are clean', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    await view(r, r.bob, share.id);
    const first = held(r).get(share.id).get(r.bob.user).at;
    r.h.clock.advance(1_000); await view(r, r.bob, share.id);
    assert.equal(held(r).get(share.id).get(r.bob.user).at, first);          // dropped: a keepalive flood
    r.h.clock.advance(2_000); await view(r, r.bob, share.id);
    assert.ok(held(r).get(share.id).get(r.bob.user).at > first);             // accepted
    // A leave right after a beat is always honoured.
    await view(r, r.bob, share.id, false); assert.equal(held(r).size, 0);
    // The per-user bucket: 60 a minute, then 429; other users are unaffected.
    let limited = null;
    for (let i = 0; i < 70 && !limited; i++) { const res = await view(r, r.bob, share.id, i % 2 === 0); if (res.status === 429) limited = res; }
    assert.ok(limited, 'bucket not enforced');
    assert.equal((await view(r, r.carol, share.id)).status, 404);
    // Names: control and bidi characters never reach the owner.
    r.h.clock.advance(60_000);
    r.h.db.run('UPDATE users SET display_name = ? WHERE id = ?', 'Bo‮b\u0000 ⁦x', r.bob.user);
    assert.equal((await view(r, r.bob, share.id)).status, 200);
    assert.equal((await viewers(r))[0][0].name, 'Bob x');
    // Newest first: a second grantee who beats later is listed first.
    r.join(r.carol);
    r.h.clock.advance(6_000);
    assert.equal((await view(r, r.carol, share.id)).status, 200);
    assert.deepEqual((await viewers(r))[0].map((v) => v.user_id), [r.carol.user, r.bob.user]);
    // Cap per share: a new viewer beyond the limit is not recorded.
    const m = held(r).get(share.id); m.clear();
    for (let i = 0; i < 50; i++) m.set(`u${i}`, { at: r.h.hub.mono(), wall: r.h.hub.iso() });
    assert.deepEqual((await view(r, r.bob, share.id)).body, { viewing: false });
    assert.equal(m.size, 50); assert.ok(!m.has(r.bob.user));
  } finally { await r.close(); }
});

test('SHARE VIEWERS: a beat needs no online host; viewers are memory only', async () => {
  const r = await rig();
  try {
    const s = await r.launch();
    const { share } = await r.mac.shareSession({ session: s.session, team: r.org, scope: 'watch' });
    r.mac.close();
    await until(() => !r.h.hub.interactionRelay.liveHost(r.macA.user, r.macA.device));
    assert.equal((await view(r, r.bob, share.id)).status, 200);
    assert.equal(held(r).size, 1);
  } finally { await r.close(); }
});
