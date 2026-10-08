// LOCAL / DISPOSABLE PROOF ONLY: independent hostile suite, written against board/MESSAGING.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { messagingRig, targetOf, until } from './messaging-helpers.js';

const uuid = () => randomUUID();
const teamShare = (org) => () => ({ scope: 'team', org_id: org });
const delivered = (mac, session) => mac.remote.hub.state({ session }, mac.remote.actor)?.deliveries.length ?? 0;
const code = (res) => res.body?.error?.code;

// A Mac with a team-shared session, targets synced, receiver NOT running.
async function sharedMac(r, opts = {}) {
  const mac = await r.mac(r.macA, { shares: teamShare(r.org), start: false, ...opts });
  assert.equal((await mac.recv.sync(true)).status, 200);
  return mac;
}
async function pull(r, dev = r.macA) {
  const p = await r.api(dev, 'POST', '/host/pull', {});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body.messages;
}

test('HOSTILE: a non-member cannot list, message or read team targets and messages, and unknown vs forbidden are indistinguishable', async () => {
  const r = await messagingRig();
  try {
    const mac = await sharedMac(r);
    const bob = r.client(r.bob), carol = r.client(r.carol);
    const t = (await bob.targets()).body.targets[0];
    assert.ok(t);
    assert.deepEqual((await carol.targets()).body.targets, []);
    const m = (await bob.send({ to: { target: t.target }, body: 'team only' })).body.message;

    const forbidden = await carol.send({ to: { target: t.target }, body: 'let me in' });
    const unknown = await carol.send({ to: { target: uuid() }, body: 'let me in' });
    assert.equal(forbidden.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(forbidden.body, unknown.body);

    const readReal = await carol.get(m.id), readFake = await carol.get(uuid());
    assert.equal(readReal.status, 404);
    assert.deepEqual(readReal.body, readFake.body);
    assert.deepEqual((await carol.list('inbox')).body.messages, []);
    assert.deepEqual((await carol.list('sent')).body.messages, []);
    // Person messages into the team are equally invisible.
    assert.equal((await carol.send({ to: { user_id: r.macA.user, org_id: r.org }, body: 'hi' })).status, 404);
    assert.equal((await carol.send({ to: { user_id: uuid().slice(0, 8), org_id: r.org }, body: 'hi' })).status, 404);
    assert.equal(delivered(mac, mac.session.session), 0);
  } finally { await r.close(); }
});

test('HOSTILE: a removed member\'s queued message is rejected as sender_removed, new sends 404, and he no longer sees the response', async () => {
  const r = await messagingRig();
  try {
    const mac = await sharedMac(r);
    const bob = r.client(r.bob);
    const t = (await bob.targets()).body.targets[0];
    const m = (await bob.send({ to: { target: t.target }, body: 'before removal' })).body.message;

    const rm = await r.h.call('DELETE', `/api/teams/${r.org}/members/${r.h.ids.bob}`, { token: r.macA.token, body: { request_id: 'rm-hostile' } });
    if (rm.status !== 200) r.h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', new Date().toISOString(), r.h.ids.bob);

    await mac.recv.pullOnce(0);
    const seenByAlice = (await r.client(r.macA).get(m.id)).body.message;
    assert.equal(seenByAlice.state, 'rejected');
    assert.equal(seenByAlice.reason, 'sender_removed');
    assert.equal(delivered(mac, mac.session.session), 0);

    const again = await bob.send({ to: { target: t.target }, body: 'after removal' });
    assert.equal(again.status, 404, JSON.stringify(again.body));
    const view = await bob.get(m.id);
    assert.ok(view.status === 404 || view.body.message.response == null, 'removed member is never handed a response');
  } finally { await r.close(); }
});

test('HOSTILE: a removed member who already got a reply no longer sees the response text', async () => {
  const r = await messagingRig();
  try {
    const mac = await sharedMac(r);
    mac.recv.start();
    const bob = r.client(r.bob);
    const t = (await bob.targets()).body.targets[0];
    const m = (await bob.send({ to: { target: t.target }, body: 'hello' })).body.message;
    const done = await bob.waitFor(m.id, (x) => x.state === 'replied', { timeoutMs: 8000 });
    assert.ok(done.body.message.response);
    r.h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', new Date().toISOString(), r.h.ids.bob);
    const after = await bob.get(m.id);
    assert.ok(after.status === 404 || (after.body.message.response == null && after.body.message.response_source == null), JSON.stringify(after.body));
  } finally { await r.close(); }
});

test('HOSTILE: a message from a revoked Windows device is rejected and never reaches the session', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA), alice = r.client(r.macA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'from soon-revoked' })).body.message;
    const rev = await r.h.call('DELETE', `/api/account/devices/${r.winA.device}`, { token: r.macA.token, body: {} });
    assert.equal(rev.status, 200, rev.text);
    assert.equal((await win.get(m.id)).status, 401);
    await mac.recv.pullOnce(0);
    const got = (await alice.get(m.id)).body.message;
    assert.equal(got.state, 'rejected');
    assert.equal(got.reason, 'sender_revoked');
    assert.equal(delivered(mac, mac.session.session), 0);
  } finally { await r.close(); }
});

test('HOSTILE: a sender revoked after the pull but before accepted gets proceed:false', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'late revoke' })).body.message;
    const [leased] = await pull(r);
    assert.equal(leased.id, m.id);
    const rev = await r.h.call('DELETE', `/api/account/devices/${r.winA.device}`, { token: r.macA.token, body: {} });
    assert.equal(rev.status, 200, rev.text);
    const acc = await r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: leased.lease, phase: 'accepted' });
    assert.equal(acc.body.proceed, false, JSON.stringify(acc.body));
    assert.equal((await r.client(r.macA).get(m.id)).body.message.state, 'rejected');
  } finally { await r.close(); }
});

test('HOSTILE: a revoked host device vanishes from the directory, its queued messages are rejected and it can no longer pull', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'to a doomed host' })).body.message;
    const rev = await r.h.call('DELETE', `/api/account/devices/${r.macA.device}`, { token: r.winA.token, body: {} });
    assert.equal(rev.status, 200, rev.text);
    assert.deepEqual((await win.targets()).body.targets, []);
    const got = (await win.get(m.id)).body.message;
    assert.equal(got.state, 'rejected');
    assert.equal(got.reason, 'device_revoked');
    assert.equal((await win.send({ to: { target: t.target }, body: 'again' })).status, 404);
    assert.ok([401, 403].includes((await r.api(r.macA, 'POST', '/host/pull', {})).status));
    assert.equal(delivered(mac, mac.session.session), 0);
  } finally { await r.close(); }
});

test('HOSTILE: an expired message is never delivered once the receiver starts', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'short lived', ttl_s: 10 })).body.message;
    assert.equal((await win.send({ to: { target: t.target }, body: 'too short', ttl_s: 9 })).status, 400);
    r.h.clock.advance(11_000);
    assert.equal((await win.get(m.id)).body.message.state, 'expired');
    mac.recv.start();
    await until(() => mac.recv.running());
    await mac.recv.pullOnce(0);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(delivered(mac, mac.session.session), 0);
    assert.equal((await win.get(m.id)).body.message.state, 'expired');
    assert.equal((await pull(r)).length, 0);
  } finally { await r.close(); }
});

test('HOSTILE: an accepted report after expiry gets proceed:false', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'x', ttl_s: 10 })).body.message;
    const [l] = await pull(r);
    r.h.clock.advance(11_000);
    const acc = await r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: l.lease, phase: 'accepted' });
    assert.equal(acc.body.proceed, false, JSON.stringify(acc.body));
    assert.equal((await win.get(m.id)).body.message.state, 'expired');
  } finally { await r.close(); }
});

test('HOSTILE: the same request_id yields one message and one delivery; different content on that id is a 409', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac();
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const request_id = uuid();
    const [a, b] = await Promise.all([win.send({ to: { target: t.target }, body: 'once', request_id }), win.send({ to: { target: t.target }, body: 'once', request_id })]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.body.message.id, b.body.message.id);
    assert.equal((await win.send({ to: { target: t.target }, body: 'twice', request_id })).status, 409);
    assert.equal((await win.send({ to: { target: t.target }, body: 'once', request_id, kind: 'handoff' })).status, 409);
    await win.waitFor(a.body.message.id, (x) => x.state === 'replied', { timeoutMs: 8000 });
    assert.equal((await win.list('sent')).body.messages.filter((x) => x.request_id === request_id).length, 1);
    assert.equal(delivered(mac, mac.session.session), 1);
  } finally { await r.close(); }
});

test('HOSTILE: the receiver delivers a message handed to it twice only once', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'dedupe me' })).body.message;
    const [leased] = await pull(r);
    assert.equal(leased.id, m.id);
    await mac.recv.deliver(leased);
    await mac.recv.deliver(leased);
    await until(() => delivered(mac, mac.session.session) >= 1);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(delivered(mac, mac.session.session), 1);
  } finally { await r.close(); }
});

test('HOSTILE: the receiver dedupes the same (source, request_id) arriving as a different message id', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'rid dedupe' })).body.message;
    const [leased] = await pull(r);
    await mac.recv.deliver(leased);
    await until(() => delivered(mac, mac.session.session) >= 1);
    await mac.recv.deliver({ ...leased, id: uuid() }).catch(() => {});
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(delivered(mac, mac.session.session), 1);
    assert.ok(m.id);
  } finally { await r.close(); }
});

test('HOSTILE: a message queued for a replaced target is rejected and never reaches the new generation', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const old = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: old.target }, body: 'for generation one' })).body.message;
    assert.equal(await mac.remote.hub.replaceTarget(mac.session.session), true);
    await until(() => mac.remote.hub.state({ session: mac.session.session }, mac.remote.actor).generation > mac.session.generation);
    await mac.recv.sync(true);
    const fresh = await until(() => targetOf(win, (x) => x.mine && x.target !== old.target));
    assert.notEqual(fresh.target, old.target);
    const got = (await win.get(m.id)).body.message;
    assert.equal(got.state, 'rejected');
    assert.equal(got.reason, 'target_replaced');
    await mac.recv.pullOnce(0);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(delivered(mac, mac.session.session), 0);
    assert.equal((await win.get(m.id)).body.message.state, 'rejected');
    assert.equal((await win.send({ to: { target: old.target }, body: 'to the dead id' })).status, 404);
  } finally { await r.close(); }
});

test('HOSTILE: a team target cannot be re-scoped by body fields and forged identity fields are refused', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const base = { request_id: uuid(), to: { target: t.target }, body: 'x' };
    for (const extra of [{ source: { user_id: r.bob.user } }, { user_id: r.bob.user }, { actor: 'bob' }, { from: { session: mac.session.session, generation: 1 } },
      { scope: 'team' }, { org_id: r.org }, { caused_by: uuid() }, { identity_source: 'hub_host_device' }]) {
      const res = await r.api(r.winA, 'POST', '/messages', { ...base, request_id: uuid(), ...extra });
      assert.equal(res.status, 400, `${Object.keys(extra)[0]}: ${JSON.stringify(res.body)}`);
    }
    // to:{target} combined with person fields is not a way to widen the audience.
    assert.equal((await r.api(r.winA, 'POST', '/messages', { ...base, to: { target: t.target, org_id: r.org } })).status, 400);
    assert.equal((await r.api(r.winA, 'POST', '/messages', { ...base, to: { target: t.target, user_id: r.bob.user } })).status, 400);
    // Bob still cannot see or message the personal target.
    assert.deepEqual((await r.client(r.bob).targets()).body.targets, []);
    assert.equal((await r.client(r.bob).send({ to: { target: t.target }, body: 'peek' })).status, 404);
    // Registration cannot be re-scoped by the owner's other (non-host) device either.
    assert.equal((await r.api(r.winA, 'PUT', '/host/targets', { targets: [{ session: mac.session.session, generation: 1, provider: 'codex', scope: 'team', org_id: r.org }] })).status, 403);
  } finally { await r.close(); }
});

test('HOSTILE: client devices cannot call host endpoints and a host cannot register a team target for a team it is not in', async () => {
  const r = await messagingRig();
  try {
    for (const dev of [r.winA, r.bob, r.carol]) {
      assert.equal((await r.api(dev, 'PUT', '/host/targets', { targets: [] })).status, 403);
      assert.equal((await r.api(dev, 'POST', '/host/pull', {})).status, 403);
      assert.equal((await r.api(dev, 'POST', `/host/messages/${uuid()}/report`, { lease: 'x', phase: 'accepted' })).status, 403);
      assert.equal((await r.api(dev, 'POST', '/host/send', { request_id: uuid(), from: { session: uuid(), generation: 1 }, to: { target: uuid() }, body: 'x' })).status, 403);
    }
    const mac = await r.mac(r.carol, { shares: teamShare(r.org), start: false });
    const res = await mac.recv.sync(true);
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.deepEqual((await r.client(r.bob).targets()).body.targets, []);
    assert.deepEqual((await r.client(r.carol).targets()).body.targets, []);
  } finally { await r.close(); }
});

test('HOSTILE: a different host cannot report on, or guess the lease of, another host\'s message', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const carolMac = await r.mac(r.carol, { start: false });
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'mine' })).body.message;
    const [l] = await pull(r);
    const report = (dev, lease, phase = 'accepted', extra = {}) => r.api(dev, 'POST', `/host/messages/${m.id}/report`, { lease, phase, ...extra });
    assert.equal((await report(r.carol, l.lease)).status, 404);
    assert.equal((await report(r.macA, 'not-the-lease')).status, 404);
    assert.equal((await report(r.macA, l.lease.slice(0, -1) + (l.lease.endsWith('A') ? 'B' : 'A'))).status, 404);
    assert.equal((await r.api(r.macA, 'POST', `/host/messages/${uuid()}/report`, { lease: l.lease, phase: 'accepted' })).status, 404);
    assert.equal((await win.get(m.id)).body.message.state, 'queued');
    assert.ok(carolMac);
  } finally { await r.close(); }
});

test('HOSTILE: report phases must follow the contract order (no delivered without accepted, no replied without delivered)', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'order' })).body.message;
    const [l] = await pull(r);
    const rep = (phase, extra = {}) => r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: l.lease, phase, ...extra });
    assert.equal((await rep('replied', { response: 'forged' })).status, 409);
    assert.equal((await rep('delivered')).status, 409, 'MESSAGING.md §4: accepted → delivered → replied');
    assert.equal((await win.get(m.id)).body.message.state, 'queued');
    assert.equal((await rep('bogus')).status, 400);
  } finally { await r.close(); }
});

test('HOSTILE: the source user and name in the DTO are always the authenticated sender', async () => {
  const r = await messagingRig();
  try {
    const mac = await sharedMac(r);
    const bob = r.client(r.bob), win = r.client(r.winA);
    const t = (await bob.targets()).body.targets[0];
    const fromBob = (await bob.send({ to: { target: t.target }, body: 'who am i' })).body.message;
    assert.equal(fromBob.source.user_id, r.bob.user);
    assert.equal(fromBob.source.name, 'bob');
    assert.equal(fromBob.source.identity_source, 'hub_credential');
    const forged = await r.api(r.bob, 'POST', '/messages', { request_id: uuid(), to: { target: t.target }, body: 'x', source: { kind: 'person', user_id: r.macA.user, name: 'alice' } });
    assert.equal(forged.status, 400);
    const person = (await win.send({ to: { user_id: r.bob.user, org_id: r.org }, body: 'hi bob' })).body.message;
    assert.equal(person.source.user_id, r.winA.user);
    assert.equal(person.source.user_id, r.macA.user);
    assert.equal(person.grants_execution, false);
    assert.equal(person.approval, false);
    assert.equal(delivered(mac, mac.session.session), 0);
  } finally { await r.close(); }
});

test('HOSTILE: a target shared to one team is invisible and unmessageable from another team; person messages across teams 404', async () => {
  const r = await messagingRig();
  try {
    const setup = await r.h.call('POST', '/api/account/setup', { token: r.carol.token, body: {} });
    assert.equal(setup.status, 200, setup.text);
    const org2 = setup.body.teams[0].id;
    assert.notEqual(org2, r.org);
    const carolMac = await r.mac(r.carol, { shares: teamShare(org2), start: false });
    assert.equal((await carolMac.recv.sync(true)).status, 200);
    const mac = await sharedMac(r);

    const carol = r.client(r.carol), bob = r.client(r.bob), alice = r.client(r.winA);
    const carolSees = (await carol.targets()).body.targets;
    assert.equal(carolSees.length, 1);
    assert.equal(carolSees[0].org_id, org2);
    const bobSees = (await bob.targets()).body.targets;
    assert.equal(bobSees.length, 1);
    assert.equal(bobSees[0].org_id, r.org);
    assert.ok(!(await alice.targets()).body.targets.some((x) => x.org_id === org2));

    assert.equal((await bob.send({ to: { target: carolSees[0].target }, body: 'cross' })).status, 404);
    assert.equal((await carol.send({ to: { target: bobSees[0].target }, body: 'cross' })).status, 404);
    assert.equal((await alice.send({ to: { user_id: r.carol.user, org_id: r.org }, body: 'cross' })).status, 404);
    assert.equal((await alice.send({ to: { user_id: r.carol.user, org_id: org2 }, body: 'cross' })).status, 404);
    assert.equal((await carol.send({ to: { user_id: r.macA.user, org_id: org2 }, body: 'cross' })).status, 404);
    assert.equal((await carol.send({ to: { user_id: r.macA.user, org_id: r.org }, body: 'cross' })).status, 404);
    assert.equal(delivered(mac, mac.session.session), 0);
    assert.equal(delivered(carolMac, carolMac.session.session), 0);
  } finally { await r.close(); }
});

test('HOSTILE: a body over the limit (4000 chars / 8 KiB to a person, 3200 / 7 KiB to a session), or over the request limit, is 413; the limits themselves are accepted', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const send = (body) => win.send({ to: { target: t.target }, body });
    assert.equal((await send('a'.repeat(3200))).status, 200);
    assert.equal((await send('a'.repeat(3201))).status, 413);
    const person = (body) => win.send({ to: { user_id: r.bob.user, org_id: r.org }, body });
    assert.equal((await person('a'.repeat(4000))).status, 200);
    assert.equal((await person('a'.repeat(4001))).status, 413);
    assert.equal((await person('€'.repeat(2731))).status, 413);
    assert.equal((await send('€'.repeat(3000))).status, 413);
    assert.equal((await send('a'.repeat(40_000))).status, 413);
    assert.equal((await send('a'.repeat(200_000))).status, 413);
    assert.equal((await send('bad\u0000control')).status, 400);
    assert.equal((await send('   ')).status, 400);
  } finally { await r.close(); }
});

test('HOSTILE: a response over 16000 chars is refused and the message stays delivered with no response', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'big reply please' })).body.message;
    const [l] = await pull(r);
    const rep = (phase, extra = {}) => r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: l.lease, phase, ...extra });
    assert.equal((await rep('accepted')).body.proceed, true);
    assert.equal((await rep('delivered')).status, 200);
    assert.equal((await rep('replied', { response: 'x'.repeat(16_001) })).status, 413);
    const mid = (await win.get(m.id)).body.message;
    assert.equal(mid.state, 'delivered');
    assert.equal(mid.response, null);
    assert.equal((await rep('replied', { response: 'x'.repeat(16_000) })).status, 200);
    assert.equal((await win.get(m.id)).body.message.response.length, 16_000);
  } finally { await r.close(); }
});

test('HOSTILE: session-sourced loops, hop limits and sessions without automation are refused', async () => {
  const r = await messagingRig();
  try {
    const auto = { sessions: true, max_hops: 2, turns_per_hour: 30, parallel: 4 };
    let noAuto = null;
    const mac = await r.mac(r.macA, { start: false, shares: (s) => (s === noAuto ? null : { automation: auto }) });
    const B = await mac.launch(), C = await mac.launch(), D = await mac.launch(), E = await mac.launch();
    noAuto = E.session;
    const sync = await mac.recv.sync(true);
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    const tid = (s) => sync.body.targets.find((x) => x.session === s).target;
    const A = mac.session.session;
    const send = (from, to, extra = {}) => mac.recv.sendFromSession(from, { to: { target: tid(to) }, body: 'hand over', ...extra });

    const m1 = await send(A, B.session);
    assert.equal(m1.status, 200, JSON.stringify(m1.body));
    assert.equal(m1.body.message.source.kind, 'session');
    assert.equal(m1.body.message.source.identity_source, 'hub_host_device');
    assert.equal(m1.body.message.hop, 1, 'MESSAGING.md §6: hop = parent hop + 1 (a person parent is hop 0)');
    // B answers A while handling m1: A is already in the visited path.
    const loop = await send(B.session, A, { caused_by: m1.body.message.id });
    assert.equal(loop.status, 409, JSON.stringify(loop.body));
    // Self-send is a loop too.
    assert.equal((await send(A, A)).status, 409);
    // B -> C is hop 2, C -> D would be hop 3 > max_hops 2.
    const m2 = await send(B.session, C.session, { caused_by: m1.body.message.id });
    assert.equal(m2.status, 200, JSON.stringify(m2.body));
    assert.equal(m2.body.message.hop, 2);
    const tooFar = await send(C.session, D.session, { caused_by: m2.body.message.id });
    assert.equal(tooFar.status, 409, JSON.stringify(tooFar.body));
    // No opt-in on E: refused.
    const off = await send(A, E.session);
    assert.equal(off.status, 403, JSON.stringify(off.body));
    // A caused_by that was not addressed to the sending session is not accepted.
    assert.equal((await send(D.session, C.session, { caused_by: m1.body.message.id })).status, 404);
    // People can still message the no-automation session.
    const win = r.client(r.winA);
    assert.equal((await win.send({ to: { target: tid(E.session) }, body: 'human is fine' })).status, 200);
  } finally { await r.close(); }
});

test('HOSTILE: the per-target queue bound is 32 (the 33rd is 429) and expiry frees it', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    for (let i = 0; i < 32; i++) assert.equal((await win.send({ to: { target: t.target }, body: `m${i}` })).status, 200, `message ${i}`);
    const over = await win.send({ to: { target: t.target }, body: 'm32' });
    assert.equal(over.status, 429, JSON.stringify(over.body));
    r.h.clock.advance(3601_000);
    assert.equal((await win.send({ to: { target: t.target }, body: 'after expiry' })).status, 200);
    assert.equal((await win.list('sent')).body.messages.filter((x) => x.state === 'expired').length, 32);
  } finally { await r.close(); }
});

test('HOSTILE: the per-sender queue bound is 64 across targets', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.launch(); await mac.launch();
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const ts = (await win.targets()).body.targets;
    assert.equal(ts.length, 3);
    for (let i = 0; i < 64; i++) {
      const res = await win.send({ to: { target: ts[Math.floor(i / 32)].target }, body: `m${i}` });
      assert.equal(res.status, 200, `message ${i}: ${JSON.stringify(res.body)}`);
    }
    const over = await win.send({ to: { target: ts[2].target }, body: 'm64' });
    assert.equal(over.status, 429, JSON.stringify(over.body));
    // Another sender is unaffected by Alice's bound.
    assert.equal((await r.client(r.macA).send({ to: { target: ts[2].target }, body: 'other device, same user' })).status, 429);
  } finally { await r.close(); }
});

test('HOSTILE: on reconnect, queued messages are revalidated: closed sessions get nothing, valid ones are delivered once', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    const B = await mac.launch();
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const ts = (await win.targets()).body.targets;
    assert.equal(ts.length, 2);
    const sync = await mac.recv.sync(true);
    const tB = sync.body.targets.find((x) => x.session === B.session).target;
    const tA = sync.body.targets.find((x) => x.session === mac.session.session).target;
    const mA = (await win.send({ to: { target: tA }, body: 'for the open one' })).body.message;
    const mB = (await win.send({ to: { target: tB }, body: 'for the closed one' })).body.message;
    assert.equal((await mac.remote.hub.close({ session: B.session, generation: B.generation }, mac.remote.actor)).ok, true);
    mac.recv.start();
    const done = await win.waitFor(mA.id, (x) => x.state === 'replied', { timeoutMs: 8000 });
    assert.equal(done.body.message.state, 'replied');
    const gone = (await win.get(mB.id)).body.message;
    assert.equal(gone.state, 'rejected');
    assert.equal(delivered(mac, mac.session.session), 1);
    assert.equal(mac.remote.hub.state({ session: B.session }, mac.remote.actor)?.deliveries?.length ?? 0, 0);
  } finally { await r.close(); }
});

test('HOSTILE: a team un-share while queued rejects the message (unshared) and Bob can no longer message it', async () => {
  const r = await messagingRig();
  try {
    let shared = true;
    const mac = await r.mac(r.macA, { shares: () => (shared ? { scope: 'team', org_id: r.org } : null), start: false });
    await mac.recv.sync(true);
    const bob = r.client(r.bob);
    const t = (await bob.targets()).body.targets[0];
    const m = (await bob.send({ to: { target: t.target }, body: 'before unshare' })).body.message;
    shared = false;
    await mac.recv.sync(true);
    const got = (await bob.get(m.id)).body.message;
    assert.equal(got.state, 'rejected');
    assert.equal(got.reason, 'unshared');
    assert.equal((await bob.send({ to: { target: t.target }, body: 'again' })).status, 404);
    await mac.recv.pullOnce(0);
    assert.equal(delivered(mac, mac.session.session), 0);
  } finally { await r.close(); }
});

test('HOSTILE: a message accepted but never reported becomes outcome_unknown after the lease and is never handed out again', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'then the cable was pulled' })).body.message;
    const [l] = await pull(r);
    assert.equal(l.id, m.id);
    const acc = await r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: l.lease, phase: 'accepted' });
    assert.equal(acc.body.proceed, true);
    assert.equal((await win.get(m.id)).body.message.state, 'queued');
    r.h.clock.advance(61_000);
    const after = (await win.get(m.id)).body.message;
    assert.equal(after.state, 'outcome_unknown');
    assert.equal((await pull(r)).length, 0);
    r.h.clock.advance(3_600_000);
    assert.equal((await pull(r)).length, 0);
    const again = await r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: l.lease, phase: 'accepted' });
    assert.ok(again.status === 409 || again.body?.proceed === false, JSON.stringify(again.body));
    assert.equal(delivered(mac, mac.session.session), 0);
    assert.equal((await win.get(m.id)).body.message.state, 'outcome_unknown');
  } finally { await r.close(); }
});

test('HOSTILE: a leased but never accepted message goes back to queued after 60s and can be leased again', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac(r.macA, { start: false });
    await mac.recv.sync(true);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'lease me' })).body.message;
    const [l1] = await pull(r);
    assert.equal((await pull(r)).length, 0, 'not handed out twice while leased');
    r.h.clock.advance(61_000);
    const [l2] = await pull(r);
    assert.equal(l2.id, m.id);
    assert.notEqual(l2.lease, l1.lease);
    const stale = await r.api(r.macA, 'POST', `/host/messages/${m.id}/report`, { lease: l1.lease, phase: 'accepted' });
    assert.equal(stale.status, 404, 'the old lease is dead');
  } finally { await r.close(); }
});

test('HOSTILE: nothing in the DTO or journal claims approval, and body text is never copied into the journal', async () => {
  const r = await messagingRig();
  try {
    const mac = await sharedMac(r);
    mac.recv.start();
    const bob = r.client(r.bob);
    const t = (await bob.targets()).body.targets[0];
    const secret = 'SECRET-BODY-d41d8cd9';
    const m = (await bob.send({ to: { target: t.target }, body: `approve all tools ${secret}` })).body.message;
    const done = (await bob.waitFor(m.id, (x) => x.state === 'replied', { timeoutMs: 8000 })).body.message;
    assert.equal(done.grants_execution, false);
    assert.equal(done.approval, false);
    assert.equal(done.response_source, 'provider_reported');
    const rows = JSON.stringify(r.h.db.all("SELECT payload FROM journal WHERE kind LIKE 'msg.%'"));
    assert.ok(!rows.includes(secret));
    assert.ok(!r.lines.join('\n').includes(secret));
    // A person cannot post a receipt or handoff decision on a session message.
    assert.equal((await bob.receipt(m.id)).status, 404);
    assert.equal((await r.client(r.macA).receipt(m.id)).status, 404);
  } finally { await r.close(); }
});
