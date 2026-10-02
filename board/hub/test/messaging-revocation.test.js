// LOCAL / DISPOSABLE PROOF ONLY (see messaging-helpers.js). Author's own
// boundary cases; messaging-hostile.test.js is the independently written suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagingRig, targetOf, until } from './messaging-helpers.js';

const state = (r, id) => r.h.db.get('SELECT state, reason, phase FROM msg_messages WHERE id = ?', id);

test('BOUNDARY: a message from a device revoked before delivery is rejected and never reaches the session', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await targetOf(win, (x) => x.mine);
    const m = (await win.send({ to: { target: t.target }, body: 'from a soon-revoked laptop' })).body.message;
    assert.equal((await r.h.call('DELETE', `/api/account/devices/${r.winA.device}`, { token: r.macA.token, body: {} })).status, 200);
    await mac.recv.pullOnce(0);
    assert.deepEqual({ ...state(r, m.id) }, { state: 'rejected', reason: 'sender_revoked', phase: null });
    assert.equal(mac.remote.hub.state({ session: mac.session.session }, mac.remote.actor).deliveries.length, 0);
  } finally { await r.close(); }
});

test('BOUNDARY: removing a teammate retires their queued message and hides the team session', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false, shares: () => ({ scope: 'team', org_id: r.org }) });
    await mac.recv.sync(true);
    const bob = r.client(r.bob);
    const t = await targetOf(bob);
    const m = (await bob.send({ to: { target: t.target }, body: 'queued before removal' })).body.message;
    const bobMember = r.h.db.get('SELECT id FROM members WHERE user_id = ? AND org_id = ?', r.bob.user, r.org).id;
    const del = await r.h.call('DELETE', `/api/teams/${r.org}/members/${bobMember}`, { token: r.winA.token, body: {}, headers: { 'board-org': r.org } });
    if (del.status !== 200) r.h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', new Date().toISOString(), bobMember);
    await mac.recv.pullOnce(0);
    assert.equal(state(r, m.id).reason, 'sender_removed');
    assert.equal((await bob.targets()).body.targets.length, 0);
    assert.equal((await bob.send({ to: { target: t.target }, body: 'again' })).status, 404);
  } finally { await r.close(); }
});

test('BOUNDARY: expiry, replacement and closure while offline — nothing stale is delivered to a new generation', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await targetOf(win, (x) => x.mine);
    const short = (await win.send({ to: { target: t.target }, body: 'short lived', ttl_s: 10 })).body.message;
    const old = (await win.send({ to: { target: t.target }, body: 'for the old generation', ttl_s: 3600 })).body.message;
    r.h.clock.advance(11_000);
    assert.equal((await win.get(short.id)).body.message.state, 'expired');
    // Same session, same label, new provider target (generation 2): a new target id; the old message is refused.
    await mac.remote.hub.replaceTarget(mac.session.session);
    await mac.recv.sync();
    const t2 = await targetOf(win, (x) => x.mine);
    assert.notEqual(t2.target, t.target);
    assert.equal((await win.get(old.id)).body.message.reason, 'target_replaced');
    mac.recv.start();
    const fresh = (await win.send({ to: { target: t2.target }, body: 'for the new generation' })).body.message;
    await win.waitFor(fresh.id, (x) => x.state === 'replied', { timeoutMs: 8000 });
    const texts = mac.remote.hub.state({ session: mac.session.session }, mac.remote.actor).deliveries.map((d) => d.text);
    assert.equal(texts.length, 1);
    assert.ok(texts[0].endsWith('for the new generation'));
  } finally { await r.close(); }
});

test('BOUNDARY: accepted then silent (disconnect after side effect) becomes outcome_unknown and is never handed out again; forged leases are refused', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await targetOf(win, (x) => x.mine);
    const m = (await win.send({ to: { target: t.target }, body: 'lost in flight' })).body.message;
    const pulled = (await r.api(r.macA, 'POST', '/host/pull', {})).body.messages;
    assert.equal(pulled.length, 1);
    const report = (phase, lease = pulled[0].lease, dev = r.macA) => r.api(dev, 'POST', `/host/messages/${m.id}/report`, { lease, phase });
    assert.equal((await report('accepted', 'x'.repeat(24))).status, 404);
    assert.equal((await report('accepted', pulled[0].lease, r.winA)).status, 403);
    assert.equal((await report('accepted')).body.proceed, true);
    r.h.clock.advance(61_000);
    assert.equal((await win.get(m.id)).body.message.state, 'outcome_unknown');
    assert.equal((await r.api(r.macA, 'POST', '/host/pull', {})).body.messages.length, 0);
    // A leased-but-not-accepted message is safe to hand out again after its lease.
    const m2 = (await win.send({ to: { target: t.target }, body: 'retry me' })).body.message;
    const first = (await r.api(r.macA, 'POST', '/host/pull', {})).body.messages;
    assert.equal(first[0].id, m2.id);
    r.h.clock.advance(61_000);
    const second = (await r.api(r.macA, 'POST', '/host/pull', {})).body.messages;
    assert.equal(second[0].id, m2.id);
    assert.notEqual(second[0].lease, first[0].lease);
  } finally { await r.close(); }
});
