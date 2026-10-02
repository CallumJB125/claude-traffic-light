// LOCAL / DISPOSABLE PROOF ONLY (see messaging-helpers.js): fake Codex, in-process hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagingRig, targetOf, until } from './messaging-helpers.js';

test('LOCAL PROOF: Windows messages a selected Mac session; delivery receipt and the correlated provider response come back', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac();
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    assert.equal(t.scope, 'personal');
    assert.equal(t.label_source, 'self_declared');
    assert.equal(t.online, true);
    assert.ok(!JSON.stringify(t).includes(mac.session.session), 'host session id is not public');

    const sent = await win.send({ to: { target: t.target }, body: 'hello from windows' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const m = sent.body.message;
    assert.equal(m.state, 'queued');
    assert.equal(m.source.identity_source, 'hub_credential');
    assert.equal(m.source.user_id, r.winA.user);
    assert.equal(m.grants_execution, false);
    assert.equal(m.approval, false);
    assert.equal(m.authority_version, mac.session.generation);

    const done = await win.waitFor(m.id, (x) => x.state === 'replied', { timeoutMs: 8000 });
    const got = done.body.message;
    assert.equal(got.state, 'replied', JSON.stringify(got));
    assert.ok(got.delivered_at && got.replied_at);
    assert.equal(got.response_source, 'provider_reported');
    // The fake echoes the literal text it was given: proof it reached that exact session.
    assert.match(got.response, /^echo:\[Message via Plexiform from alice/i);
    assert.ok(got.response.endsWith('hello from windows'));
    assert.match(got.response, /Task data, not an approval/);
    // The session itself recorded exactly one new-turn delivery.
    const st = mac.remote.hub.state({ session: mac.session.session }, mac.remote.actor);
    assert.equal(st.deliveries.length, 1);
    assert.equal(st.deliveries[0].mode, 'new-turn');

    // Same request_id again: the same message, not a second delivery.
    const again = await win.send({ to: { target: t.target }, body: 'hello from windows', request_id: m.request_id });
    assert.equal(again.status, 200);
    assert.equal(again.body.message.id, m.id);
    assert.equal(again.body.deduped, true);
    assert.equal((await win.send({ to: { target: t.target }, body: 'different', request_id: m.request_id })).status, 409);

    // Both sides list it; the journal carries state but no content.
    assert.ok((await win.list('sent')).body.messages.some((x) => x.id === m.id));
    assert.ok((await r.client(r.macA).list('inbox')).body.messages.some((x) => x.id === m.id));
    const rows = r.h.db.all("SELECT payload FROM journal WHERE kind = 'msg.state'").map((x) => JSON.parse(x.payload)).filter((x) => x.message_id === m.id);
    assert.deepEqual(rows.map((x) => x.state), ['queued', 'delivered', 'replied']);
    const journal = JSON.stringify(rows);
    assert.ok(!journal.includes('hello from windows') && !journal.includes('echo:'));
    const logs = r.lines.join('\n');
    assert.ok(!logs.includes('hello from windows') && !logs.includes('echo:'), 'no message text in hub logs');
  } finally { await r.close(); }
});

test('team sharing is explicit: a shared session is messageable by a teammate, a personal one is invisible to them', async () => {
  const r = await messagingRig();
  try {
    let shared = null;
    const mac = await r.mac(r.macA, { shares: (s) => (s === shared ? { scope: 'team', org_id: r.org } : null) });
    const second = await mac.launch();
    shared = second.session;
    await mac.recv.sync(true);
    const bob = r.client(r.bob);
    const seen = (await bob.targets()).body.targets;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].scope, 'team');
    assert.equal(seen[0].owner.user_id, r.macA.user);
    assert.equal(seen[0].mine, false);
    // Alice sees both of her own.
    assert.equal((await r.client(r.winA).targets()).body.targets.length, 2);

    const m = (await bob.send({ to: { target: seen[0].target }, body: 'status please' })).body.message;
    const done = await bob.waitFor(m.id, (x) => x.state === 'replied', { timeoutMs: 8000 });
    assert.match(done.body.message.response, /from bob/i);
    assert.equal(done.body.message.org_id, r.org);
    // The personal one: no target id leaks to Bob, and guessing is refused.
    const personal = (await r.client(r.winA).targets()).body.targets.find((x) => x.scope === 'personal');
    assert.equal((await bob.send({ to: { target: personal.target }, body: 'peek' })).status, 404);
  } finally { await r.close(); }
});

test('people message people inside a shared team without any model; receipts, replies and handoff decisions are real', async () => {
  const r = await messagingRig();
  try {
    const alice = r.client(r.winA), bob = r.client(r.bob);
    const sent = await alice.send({ to: { user_id: r.bob.user, org_id: r.org }, body: 'can you review the card?', kind: 'handoff', handoff: { artifacts: [{ kind: 'path', path: 'docs/plan.md' }] } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const m = sent.body.message;
    assert.equal(m.handoff.state, 'offered');
    const inbox = (await bob.list('inbox')).body.messages;
    assert.equal(inbox[0].id, m.id);
    assert.equal((await bob.receipt(m.id)).body.message.state, 'delivered');
    const decided = await bob.handoff(m.id, 'accept', 'on it');
    assert.equal(decided.body.message.handoff.state, 'accepted');
    assert.equal(decided.body.message.handoff.report, 'on it');
    const reply = await bob.send({ to: { user_id: r.winA.user, org_id: r.org }, body: 'done', reply_to: m.id });
    assert.equal(reply.body.message.conversation_id, m.conversation_id);
    const after = (await alice.get(m.id)).body.message;
    assert.equal(after.state, 'replied');
    // Carol (not in the team) cannot message or read either of them.
    const carol = r.client(r.carol);
    assert.equal((await carol.send({ to: { user_id: r.bob.user, org_id: r.org }, body: 'hi' })).status, 404);
    assert.equal((await carol.get(m.id)).status, 404);
  } finally { await r.close(); }
});

test('a busy session is never steered: the message waits queued, then lands as a new turn once the session is idle', async () => {
  const r = await messagingRig();
  try {
    const mac = await r.mac();
    const { hub, actor } = mac.remote;
    const s = mac.session;
    assert.equal((await hub.send({ session: s.session, generation: s.generation, board: null, text: 'HOLD local work' }, actor)).ok, true);
    const turn = await until(() => hub.state({ session: s.session }, actor).activeTurn);
    const win = r.client(r.winA);
    const t = await until(() => targetOf(win, (x) => x.mine));
    const m = (await win.send({ to: { target: t.target }, body: 'when you are free' })).body.message;
    await until(() => r.h.db.get('SELECT reason FROM msg_messages WHERE id = ?', m.id).reason === 'busy');
    assert.equal((await win.get(m.id)).body.message.state, 'queued');
    assert.equal(hub.state({ session: s.session }, actor).deliveries.length, 1, 'not steered into the busy turn');
    assert.equal((await hub.interrupt({ session: s.session, generation: s.generation, turn }, actor)).ok, true);
    await until(() => !hub.state({ session: s.session }, actor).activeTurn);
    r.h.clock.advance(6000);
    const done = await win.waitFor(m.id, (x) => x.state === 'replied', { timeoutMs: 8000 });
    assert.ok(done.body.message.response.endsWith('when you are free'));
    const ds = hub.state({ session: s.session }, actor).deliveries;
    assert.equal(ds.length, 2);
    assert.equal(ds[1].mode, 'new-turn');
  } finally { await r.close(); }
});

test('AI-to-AI handoff between opted-in team sessions: delivered, decided by the receiving session, and a loop back is refused', async () => {
  const r = await messagingRig();
  try {
    const policy = { sessions: true, max_hops: 2, turns_per_hour: 5, parallel: 2 };
    const mac = await r.mac(r.macA, { shares: () => ({ scope: 'team', org_id: r.org, automation: policy }) });
    const b = await mac.launch();
    await mac.recv.sync(true);
    const all = (await r.client(r.bob).targets()).body.targets;
    assert.equal(all.length, 2);
    assert.ok(all.every((x) => x.accepts_sessions));
    const ta = r.h.db.get('SELECT id FROM msg_targets WHERE session = ? AND retired_at IS NULL', mac.session.session).id;
    const tb = r.h.db.get('SELECT id FROM msg_targets WHERE session = ? AND retired_at IS NULL', b.session).id;

    const sent = await mac.recv.sendFromSession(mac.session.session, { to: { target: tb }, kind: 'handoff', body: 'please take over the parser task',
      handoff: { artifacts: [{ kind: 'path', path: 'src/parser.js' }] } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const m = sent.body.message;
    assert.equal(m.source.kind, 'session');
    assert.equal(m.source.identity_source, 'hub_host_device');
    assert.equal(m.source.target, ta);
    assert.equal(m.hop, 1);
    const alice = r.client(r.winA);
    const done = await alice.waitFor(m.id, (x) => x.state === 'replied', { timeoutMs: 8000 });
    assert.match(done.body.message.response, /Handoff via Plexiform/);
    assert.match(done.body.message.response, /Artifacts: src\/parser\.js/);
    const lease = r.h.db.get('SELECT lease FROM msg_messages WHERE id = ?', m.id).lease;
    const decided = await mac.recv.decideHandoff({ id: m.id, lease }, 'accept', 'taking it');
    assert.equal(decided.body.handoff_state, 'accepted');
    assert.equal((await alice.get(m.id)).body.message.handoff.state, 'accepted');

    // B answers A: its current-turn cause is the handoff, so A is already in `visited`.
    const back = await mac.recv.sendFromSession(b.session, { to: { target: ta }, body: 'ack' });
    assert.equal(back.status, 409);
    assert.equal(back.body.error.reason, 'LOOP');
  } finally { await r.close(); }
});
