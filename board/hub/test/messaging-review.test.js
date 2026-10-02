// LOCAL / DISPOSABLE PROOF ONLY: the fixes from the independent messaging review
// (turn caps for every non-owner, erasure, derived hops, the session body budget,
// read/park/churn limits, the stricter state machine, and the mutants the hostile
// suite left alive). Each case fails when its guard is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { messagingRig, targetOf, until } from './messaging-helpers.js';

const uuid = () => randomUUID();
const delivered = (mac, session) => mac.remote.hub.state({ session }, mac.remote.actor)?.deliveries.length ?? 0;
const rows = (r, sql, ...a) => r.h.db.get(sql, ...a).n;
const teamShare = (org) => () => ({ scope: 'team', org_id: org });

async function pull(r, dev = r.macA, body = {}) {
  const p = await r.api(dev, 'POST', '/host/pull', body);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body.messages;
}
async function personalMac(r, opts = {}) {
  const mac = await r.mac(r.macA, { start: false, ...opts });
  assert.equal((await mac.recv.sync(true)).status, 200);
  const t = await until(() => targetOf(r.client(r.winA), (x) => x.mine));
  return { mac, t };
}

// ── 1. turn caps ────────────────────────────────────────────────────────────
test('REVIEW 1: teammates share an hourly turn cap and a parallel cap per session; the owner keeps a generous one', async () => {
  const r = await messagingRig({ limits: { teammateTurnsPerHour: 3, teammateParallel: 2, ownerTurnsPerHour: 5 } });
  try {
    const mac = await r.mac(r.macA, { shares: teamShare(r.org), start: false });
    await mac.recv.sync(true);
    const bob = r.client(r.bob), alice = r.client(r.winA);
    const t = (await bob.targets()).body.targets[0];
    const send = (c, body) => c.send({ to: { target: t.target }, body });
    assert.equal((await send(bob, 'one')).status, 200);
    assert.equal((await send(bob, 'two')).status, 200);
    const par = await send(bob, 'three, while two wait');
    assert.equal(par.status, 429, 'parallel cap');
    assert.equal(par.body.error.reason, 'TURN_LIMIT');
    // Delivered messages free the parallel slot, never the hourly budget.
    for (const m of await pull(r)) {
      assert.equal((await r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: m.lease, phase: 'accepted' })).body.proceed, true);
      assert.equal((await r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: m.lease, phase: 'delivered' })).status, 200);
    }
    assert.equal((await send(bob, 'three')).status, 200);
    const hourly = await send(bob, 'four');
    assert.equal(hourly.status, 429, 'hourly cap');
    // The owner is not counted against teammates, and has her own (larger) cap.
    for (let i = 0; i < 5; i++) assert.equal((await send(alice, `mine ${i}`)).status, 200, `owner ${i}`);
    assert.equal((await send(alice, 'mine 5')).status, 429);
    r.h.clock.advance(3_601_000);
    assert.equal((await send(bob, 'next hour')).status, 200);
  } finally { await r.close(); }
});

// ── 3. erasure, retention, timed sweep ──────────────────────────────────────
test('REVIEW 3: deleting an account purges its messages and targets at once; deleting a team purges that team\'s', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { shares: teamShare(r.org), start: false });
    await mac.recv.sync(true);
    const bob = r.client(r.bob);
    const t = (await bob.targets()).body.targets[0];
    assert.equal((await bob.send({ to: { target: t.target }, body: 'from bob' })).status, 200);
    assert.equal((await r.client(r.winA).send({ to: { user_id: r.bob.user, org_id: r.org }, body: 'to bob' })).status, 200);
    assert.equal((await r.client(r.carol).send({ to: { user_id: r.carol.user, org_id: (await r.h.call('POST', '/api/account/setup', { token: r.carol.token, body: {} })).body.teams[0].id }, body: 'carol note' })).status, 200);
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_messages WHERE source_user_id = ? OR dest_user_id = ?', r.bob.user, r.bob.user), 2);

    r.h.hub.accounts.eraseUser(r.h.db.get('SELECT * FROM users WHERE id = ?', r.bob.user));
    // No sweep has run: the rows are already gone.
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_messages WHERE source_user_id = ? OR dest_user_id = ?', r.bob.user, r.bob.user), 0);

    const carolOrg = r.h.db.get('SELECT org_id FROM members WHERE user_id = ? AND removed_at IS NULL', r.carol.user).org_id;
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_messages WHERE org_id = ?', carolOrg), 1);
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_targets WHERE org_id = ?', r.org), 1);
    r.h.hub.teams.deleteTeam(r.h.db.get('SELECT * FROM orgs WHERE id = ?', carolOrg), {});
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_messages WHERE org_id = ?', carolOrg), 0);
    r.h.hub.teams.deleteTeam(r.h.db.get('SELECT * FROM orgs WHERE id = ?', r.org), {});
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_targets WHERE org_id = ?', r.org), 0);
  } finally { await r.close(); }
});

test('REVIEW 3: retention, expired handoffs and long-retired targets go on the timed purge, never on a read', async () => {
  const r = await messagingRig();
  try {
    const { mac, t } = await personalMac(r);
    const win = r.client(r.winA);
    const m = (await win.send({ to: { target: t.target }, body: 'old news' })).body.message;
    const h = (await win.send({ to: { user_id: r.bob.user, org_id: r.org }, kind: 'handoff', body: 'take this', ttl_s: 60 })).body.message;
    assert.equal((await r.client(r.bob).receipt(h.id)).status, 200);
    r.h.clock.advance(61_000);
    // A delivered handoff past its expiry reads as expired and can no longer be accepted.
    assert.equal((await r.client(r.bob).get(h.id)).body.message.handoff.state, 'expired');
    assert.equal((await r.client(r.bob).handoff(h.id, 'accept')).status, 409);
    r.h.hub.messaging.purge();
    assert.equal(r.h.db.get('SELECT handoff_state FROM msg_messages WHERE id = ?', h.id).handoff_state, 'expired');

    // A replaced target is retired, then deleted once it is older than retention.
    await mac.remote.hub.replaceTarget(mac.session.session);
    await until(() => mac.remote.hub.state({ session: mac.session.session }, mac.remote.actor).generation > 1);
    await mac.recv.sync(true);
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_targets WHERE id = ?', t.target), 1);
    r.h.clock.advance(31 * 86_400_000);
    assert.equal((await win.list('sent')).status, 200);
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_messages WHERE id = ?', m.id), 1, 'a read does not run retention');
    r.h.hub.messaging.purge();
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_messages WHERE id IN (?, ?)', m.id, h.id), 0);
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_targets WHERE id = ?', t.target), 0);
  } finally { await r.close(); }
});

// ── 4. hops are derived by the hub ──────────────────────────────────────────
test('REVIEW 4: hop and visited come from what the session was handed; omitting or forging caused_by cannot reset them', async () => {
  const r = await messagingRig();
  try {
    const auto = { sessions: true, max_hops: 2, turns_per_hour: 30, parallel: 4 };
    const mac = await r.mac(r.macA, { start: false, shares: () => ({ automation: auto }) });
    const B = await mac.launch(), C = await mac.launch(), D = await mac.launch();
    const sync = await mac.recv.sync(true);
    const tid = (s) => sync.body.targets.find((x) => x.session === s).target;
    const A = mac.session.session;
    const send = (from, to, extra = {}) => mac.recv.sendFromSession(from, { to: { target: tid(to) }, body: 'pass it on', ...extra });

    const m1 = await send(A, B.session);
    assert.equal(m1.body.message.hop, 1);
    // B omits caused_by: still hop 2, and A is still in its path.
    const m2 = await send(B.session, C.session);
    assert.equal(m2.status, 200, JSON.stringify(m2.body));
    assert.equal(m2.body.message.hop, 2);
    assert.equal((await send(B.session, A)).status, 409, 'loop back to A without caused_by');
    // C omits caused_by: hop 3 > 2.
    const far = await send(C.session, D.session);
    assert.equal(far.status, 409, JSON.stringify(far.body));
    assert.equal(far.body.error.reason, 'HOP_LIMIT');
    // A person's message to C does not lower it either.
    assert.equal((await r.client(r.winA).send({ to: { target: tid(C.session) }, body: 'human' })).status, 200);
    assert.equal((await send(C.session, D.session)).status, 409);
    // caused_by must be a message addressed to the sender: m1 (to B) is not C's.
    assert.equal((await send(C.session, D.session, { caused_by: m1.body.message.id })).status, 404);
    r.h.clock.advance(3_601_000);
    // A cause that aged out of the window is ignored, not refused: the session can still speak.
    const stale = await send(C.session, D.session, { caused_by: m2.body.message.id });
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    assert.equal(stale.body.message.hop, 1);
    assert.equal(stale.body.message.caused_by, null);
  } finally { await r.close(); }
});

test('REVIEW 4: a sender\'s short ttl_s does not shorten the hop/visited window', async () => {
  const r = await messagingRig();
  try {
    const auto = { sessions: true, max_hops: 1, turns_per_hour: 30, parallel: 4 };
    const mac = await r.mac(r.macA, { start: false, shares: () => ({ automation: auto }) });
    const B = await mac.launch(), C = await mac.launch();
    const sync = await mac.recv.sync(true);
    const tid = (s) => sync.body.targets.find((x) => x.session === s).target;
    const A = mac.session.session;
    const send = (from, to, extra = {}) => mac.recv.sendFromSession(from, { to: { target: tid(to) }, body: 'pass it on', ...extra });
    const m1 = await send(A, B.session, { ttl_s: 10 });
    assert.equal(m1.status, 200, JSON.stringify(m1.body));
    // Lease and deliver it so it is not swept as an undelivered expiry.
    const [p] = await pull(r);
    assert.equal(p.id, m1.body.message.id);
    assert.equal((await r.api(r.macA, 'POST', `/host/messages/${p.id}/report`, { lease: p.lease, phase: 'accepted' })).body.proceed, true);
    assert.equal((await r.api(r.macA, 'POST', `/host/messages/${p.id}/report`, { lease: p.lease, phase: 'delivered' })).status, 200);
    r.h.clock.advance(11_000);
    r.h.hub.messaging.purge();
    const far = await send(B.session, C.session);
    assert.equal(far.status, 409, JSON.stringify(far.body));
    assert.equal(far.body.error.reason, 'HOP_LIMIT');
    assert.equal((await send(B.session, A)).body.error?.reason, 'LOOP');
    r.h.clock.advance(3_600_000);
    assert.equal((await send(B.session, C.session)).status, 200, 'the fixed window has passed');
  } finally { await r.close(); }
});

// ── 5. body budget for sessions ─────────────────────────────────────────────
test('REVIEW 5: a session body up to the documented 3200 chars / 7 KiB (with handoff refs) is delivered framed; one more is 413', async () => {
  const r = await messagingRig();
  try {
    const { mac, t } = await personalMac(r);
    const win = r.client(r.winA);
    const send = (body, extra = {}) => win.send({ to: { target: t.target }, body, ...extra });
    assert.equal((await send('a'.repeat(3201))).status, 413);
    assert.equal((await send('€'.repeat(2400))).status, 413, '7200 bytes > 7168');
    const longPath = `src/${'part/'.repeat(160)}x.js`;
    assert.equal((await send('x'.repeat(2500), { kind: 'handoff' })).status, 200);
    assert.equal((await send('x'.repeat(2500), { kind: 'handoff', handoff: { artifacts: [{ kind: 'path', path: longPath }] } })).status, 413, 'refs count');
    // People keep 4000.
    assert.equal((await win.send({ to: { user_id: r.bob.user, org_id: r.org }, body: 'a'.repeat(4000) })).status, 200);

    const big = (await send('a'.repeat(3200))).body.message;
    const wide = (await send('€'.repeat(2389))).body.message;
    const refs = (await send('h'.repeat(3150), { kind: 'handoff', handoff: { card_refs: [], artifacts: [{ kind: 'path', path: 'src/p.js' }] } })).body.message;
    mac.recv.start();
    for (const m of [big, wide, refs]) {
      const done = await win.waitFor(m.id, (x) => ['replied', 'rejected', 'outcome_unknown'].includes(x.state), { timeoutMs: 10_000 });
      assert.equal(done.body.message.state, 'replied', `${m.id}: ${done.body.message.reason}`);
    }
    assert.equal(delivered(mac, mac.session.session), 4, "the three above and the 2500-char handoff");
  } finally { await r.close(); }
});

// ── 6. DoS bounds ───────────────────────────────────────────────────────────
test('REVIEW 6: messaging reads are rate limited per user', async () => {
  const r = await messagingRig();
  try {
    r.h.hub.limiter.limits.messaging_read_user = { capacity: 3, per_ms: 60_000 };
    const win = r.client(r.winA);
    for (let i = 0; i < 3; i++) assert.equal((await win.list('sent')).status, 200);
    assert.equal((await win.targets()).status, 429);
    assert.equal((await win.get(uuid())).status, 429);
    assert.equal((await r.client(r.bob).list()).status, 200, 'per user');
  } finally { await r.close(); }
});

test('REVIEW 6: a host cannot grow msg_targets without bound by bumping generations, nor park unbounded pulls', async () => {
  const r = await messagingRig({ limits: { registrationsPerHour: 3, parkedPulls: 1 } });
  try {
    const mac = await r.mac(r.macA, { start: false });
    const session = mac.session.session;
    const put = (generation) => r.api(r.macA, 'PUT', '/host/targets', { targets: [{ session, generation, provider: 'codex', scope: 'personal' }] });
    for (const g of [1, 2, 3]) assert.equal((await put(g)).status, 200);
    assert.equal((await put(3)).status, 200, 'an unchanged target is not a new row');
    const churn = await put(4);
    assert.equal(churn.status, 429, JSON.stringify(churn.body));
    assert.equal(rows(r, 'SELECT COUNT(*) n FROM msg_targets WHERE host_device_id = ?', r.macA.device), 3);

    const parked = r.api(r.macA, 'POST', '/host/pull', { wait_ms: 1500 });
    await until(() => (r.h.hub.messaging.waiters.get(r.macA.device)?.size ?? 0) === 1);
    const second = await r.api(r.macA, 'POST', '/host/pull', { wait_ms: 1500 });
    assert.equal(second.status, 429);
    assert.equal((await parked).status, 200);
  } finally { await r.close(); }
});

// ── 7. state machine ────────────────────────────────────────────────────────
test('REVIEW 7: turn_ended only for interrupted/failed, once; host handoff decisions re-check the target', async () => {
  const r = await messagingRig();
  try {
    const { mac, t } = await personalMac(r);
    const win = r.client(r.winA);
    const ids = [];
    for (const kind of ['message', 'handoff']) ids.push((await win.send({ to: { target: t.target }, body: kind, kind })).body.message.id);
    const leased = await pull(r);
    const rep = (m, phase, extra = {}) => r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: m.lease, phase, ...extra });
    for (const m of leased) { await rep(m, 'accepted'); assert.equal((await rep(m, 'delivered')).status, 200); }
    const [msg, hand] = ids.map((id) => leased.find((m) => m.id === id));
    assert.equal((await rep(msg, 'turn_ended', { turn: 'completed' })).status, 409);
    assert.equal((await rep(msg, 'turn_ended', { turn: 'interrupted' })).status, 200);
    assert.equal((await rep(msg, 'turn_ended', { turn: 'failed' })).status, 409, 'only once');
    assert.equal((await win.get(msg.id)).body.message.reason, 'turn_interrupted');

    // Hosting turned off on that device: its sessions can no longer decide.
    r.h.db.run("UPDATE user_devices SET interaction_role = 'client' WHERE id = ?", r.macA.device);
    assert.equal((await rep(hand, 'handoff', { decision: 'accept' })).status, 403);
    r.h.db.run("UPDATE user_devices SET interaction_role = 'host' WHERE id = ?", r.macA.device);
    // The target row moved to another generation in place: refused.
    r.h.db.run('UPDATE msg_targets SET generation = generation + 1 WHERE id = ?', t.target);
    assert.equal((await rep(hand, 'handoff', { decision: 'accept' })).status, 409);
    r.h.db.run('UPDATE msg_targets SET generation = generation - 1 WHERE id = ?', t.target);
    assert.equal((await rep(hand, 'handoff', { decision: 'accept' })).status, 200);
    assert.ok(mac);
  } finally { await r.close(); }
});

test('REVIEW 7: reply_to must stay inside the same team and conversation', async () => {
  const r = await messagingRig();
  try {
    const { t } = await personalMac(r);
    const bob = r.client(r.bob), alice = r.client(r.winA);
    const q = (await bob.send({ to: { user_id: r.winA.user, org_id: r.org }, body: 'question' })).body.message;
    // Into Alice's personal session (no team) as a "reply" to a team message: refused.
    assert.equal((await alice.send({ to: { target: t.target }, body: 'leak', reply_to: q.id })).status, 404);
    assert.equal((await alice.send({ to: { user_id: r.bob.user, org_id: r.org }, body: 'wrong thread', reply_to: q.id, conversation_id: uuid() })).status, 404);
    const a = await alice.send({ to: { user_id: r.bob.user, org_id: r.org }, body: 'answer', reply_to: q.id });
    assert.equal(a.status, 200);
    assert.equal(a.body.message.conversation_id, q.conversation_id);
  } finally { await r.close(); }
});

test('REVIEW 7: an owner removed from a team no longer lists or reads messages to her former shared session', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.bob, { shares: teamShare(r.org), start: false });
    await mac.recv.sync(true);
    const alice = r.client(r.winA), bob = r.client(r.bob);
    const t = (await alice.targets()).body.targets.find((x) => x.owner.user_id === r.bob.user);
    const m = (await alice.send({ to: { target: t.target }, body: 'team secret' })).body.message;
    assert.equal((await bob.list('inbox')).body.messages.length, 1);
    r.h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', new Date().toISOString(), r.h.ids.bob);
    assert.deepEqual((await bob.list('inbox')).body.messages, []);
    assert.equal((await bob.get(m.id)).status, 404);
  } finally { await r.close(); }
});

// ── 8. mutants the hostile suite left alive ─────────────────────────────────
test('REVIEW 8 (M5): a device revoked while its pull is parked gets 401, not an empty 200', async () => {
  const r = await messagingRig();
  try {
    await personalMac(r);
    const parked = r.api(r.macA, 'POST', '/host/pull', { wait_ms: 1500 });
    await until(() => (r.h.hub.messaging.waiters.get(r.macA.device)?.size ?? 0) === 1);
    assert.equal((await r.h.call('DELETE', `/api/account/devices/${r.macA.device}`, { token: r.winA.token, body: {} })).status, 200);
    assert.equal((await parked).status, 401);
  } finally { await r.close(); }
});

test('REVIEW 8 (M6): a queued message is never leased against a target whose generation moved', async () => {
  const r = await messagingRig();
  try {
    const { mac, t } = await personalMac(r);
    const win = r.client(r.winA);
    const m = (await win.send({ to: { target: t.target }, body: 'for generation 1' })).body.message;
    // Defence in depth: sync always retires on a new generation; the per-delivery check must hold anyway.
    r.h.db.run('UPDATE msg_targets SET generation = generation + 1 WHERE id = ?', t.target);
    assert.deepEqual(await pull(r), []);
    const got = (await win.get(m.id)).body.message;
    assert.equal(got.state, 'rejected');
    assert.equal(got.reason, 'target_replaced');
    assert.equal(delivered(mac, mac.session.session), 0);
  } finally { await r.close(); }
});

test('REVIEW 8 (M15): a message whose sender is revoked between pull and delivery is not injected by the receiver', async () => {
  const r = await messagingRig();
  try {
    const { mac, t } = await personalMac(r);
    const win = r.client(r.winA);
    const m = (await win.send({ to: { target: t.target }, body: 'revoked mid-flight' })).body.message;
    const [leased] = await pull(r);
    assert.equal(leased.id, m.id);
    assert.equal((await r.h.call('DELETE', `/api/account/devices/${r.winA.device}`, { token: r.macA.token, body: {} })).status, 200);
    const res = await mac.recv.deliver(leased);
    assert.equal(res.body.proceed, false);
    await new Promise((res2) => setTimeout(res2, 100));
    assert.equal(delivered(mac, mac.session.session), 0);
    assert.equal((await r.client(r.macA).get(m.id)).body.message.reason, 'sender_revoked');
  } finally { await r.close(); }
});
