// Held (agent-authored) messages, MESSAGING §6a: created by a desktop token,
// invisible to the recipient until the sender's person releases them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { messagingRig } from './messaging-helpers.js';
import { HubError } from '../db.js';

const ask = (r, dev, body, extra = {}) => r.api(dev, 'POST', '/messages', { request_id: randomUUID(), to: { user_id: r.bob.user, org_id: r.org }, body, hold: true, via: { surface: 'local', provider: 'claude', label: 'Claude Code in shop-api' }, ...extra });
const release = (r, dev, id, body) => r.api(dev, 'POST', `/messages/${id}/release`, body);
const inbox = async (r, dev, q = '') => (await r.api(dev, 'GET', `/messages?box=inbox${q}`)).body.messages;

test('a held message is created from a desktop token, is invisible to the recipient, and is sent only on release', async () => {
  const r = await messagingRig();
  try {
    const sent = await ask(r, r.winA, 'Which env var holds the queue url?');
    assert.equal(sent.status, 200, sent.text);
    const m = sent.body.message;
    assert.equal(m.state, 'held');
    assert.deepEqual(m.via, { surface: 'local', provider: 'claude', label: 'Claude Code in shop-api', label_source: 'self_declared' });
    assert.equal(Date.parse(m.expires_at) - Date.parse(m.created_at), 3_600_000);

    // The recipient sees nothing: not listed, not readable, no receipt, no reply to it.
    assert.equal((await inbox(r, r.bob)).length, 0);
    assert.equal((await r.api(r.bob, 'GET', `/messages/${m.id}`)).status, 404);
    assert.equal((await r.api(r.bob, 'POST', `/messages/${m.id}/receipt`, { state: 'delivered' })).status, 404);
    assert.equal((await r.api(r.bob, 'POST', '/messages', { request_id: randomUUID(), to: { user_id: r.winA.user, org_id: r.org }, body: 'x', reply_to: m.id })).status, 404);
    // The sender lists it under held.
    const held = (await r.api(r.winA, 'GET', '/messages?box=held')).body.messages;
    assert.deepEqual(held.map((x) => x.id), [m.id]);

    const out = await release(r, r.winA, m.id, { decision: 'send', body: 'Which env var holds the queue URL? (edited)' });
    assert.equal(out.status, 200, out.text);
    assert.equal(out.body.message.state, 'queued');
    assert.equal(out.body.message.body, 'Which env var holds the queue URL? (edited)');
    const got = await inbox(r, r.bob);
    assert.deepEqual(got.map((x) => x.id), [m.id]);
    assert.equal(got[0].via.label_source, 'self_declared');
    // Released once: a second release conflicts.
    assert.equal((await release(r, r.winA, m.id, { decision: 'send' })).status, 409);
    assert.equal((await r.api(r.winA, 'GET', '/messages?box=held')).body.messages.length, 0);
  } finally { await r.close(); }
});

test('release is for a signed-in person only: phone relay, runner and grant credentials are refused human_only', async () => {
  const r = await messagingRig();
  try {
    const m = (await ask(r, r.winA, 'q')).body.message;
    const ident = { user: { id: r.winA.user } };
    for (const cred of [{ kind: 'device', id: r.winA.device, scope: 'relay' }, { kind: 'runner', id: 'x' }, { kind: 'grant', id: 'x' }, { kind: 'host', id: 'x' }, undefined]) {
      assert.throws(() => r.h.hub.messaging.release({ ...ident, cred }, m.id, { decision: 'send' }),
        (e) => e instanceof HubError && e.code === 'FORBIDDEN' && e.extra?.reason === 'HUMAN_ONLY', JSON.stringify(cred));
    }
    // A runner token never authenticates a person route at all.
    const res = await r.h.call('POST', `/api/messaging/v1/messages/${m.id}/release`, { token: 'brt1.not.a-person', body: { decision: 'send' } });
    assert.equal(res.status, 401);
    // Someone else's held message does not exist for them.
    assert.equal((await release(r, r.bob, m.id, { decision: 'send' })).status, 404);
    // A browser sign-in (cookie + CSRF) may release.
    const web = await r.h.webSignIn('alice@dev.local');
    const ok = await r.h.call('POST', `/api/messaging/v1/messages/${m.id}/release`, { cookie: web.cookie, headers: { 'x-csrf-token': web.csrf, origin: r.h.base }, body: { decision: 'send' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.message.state, 'queued');
  } finally { await r.close(); }
});

test('an edited release is re-validated; discard deletes the row', async () => {
  const r = await messagingRig();
  try {
    const m = (await ask(r, r.winA, 'q')).body.message;
    assert.equal((await release(r, r.winA, m.id, { decision: 'send', body: 'x'.repeat(4001) })).status, 413);
    assert.equal((await release(r, r.winA, m.id, { decision: 'send', body: '   ' })).status, 400);
    assert.equal((await release(r, r.winA, m.id, { decision: 'send', body: 'bad\u0001' })).status, 400);
    assert.equal((await release(r, r.winA, m.id, { decision: 'maybe' })).status, 400);
    assert.equal(r.h.db.get('SELECT state FROM msg_messages WHERE id = ?', m.id).state, 'held');
    const d = await release(r, r.winA, m.id, { decision: 'discard' });
    assert.equal(d.status, 200, d.text);
    assert.equal(d.body.discarded, true);
    assert.ok(!r.h.db.get('SELECT * FROM msg_messages WHERE id = ?', m.id));
    assert.equal((await release(r, r.winA, m.id, { decision: 'send' })).status, 404);
  } finally { await r.close(); }
});

test('held messages expire after one hour and at most 8 wait per user', async () => {
  const r = await messagingRig();
  try {
    const ids = [];
    for (let i = 0; i < 8; i++) { const s = await ask(r, r.winA, `q${i}`); assert.equal(s.status, 200, s.text); ids.push(s.body.message.id); }
    const ninth = await ask(r, r.winA, 'q9');
    assert.equal(ninth.status, 429);
    assert.equal(ninth.body.error.reason, 'HELD_FULL');
    r.h.clock.advance(3_600_001);
    const gone = (await r.api(r.winA, 'GET', `/messages/${ids[0]}`)).body.message;
    assert.deepEqual([gone.state, gone.reason], ['expired', 'not_released']);
    assert.equal((await r.api(r.bob, 'GET', `/messages/${ids[0]}`)).status, 404);
    assert.equal((await r.api(r.winA, 'GET', '/messages?box=held')).body.messages.length, 0);
    assert.equal((await release(r, r.winA, ids[1], { decision: 'send' })).status, 409);
    assert.equal((await inbox(r, r.bob)).length, 0, 'an expired held message never reaches the recipient');
    assert.equal((await ask(r, r.winA, 'fresh')).status, 200, 'expired ones no longer count against the cap');
  } finally { await r.close(); }
});

test('release after the sender left the team is rejected sender_removed', async () => {
  const r = await messagingRig();
  try {
    const m = (await ask(r, r.bob, 'q', { to: { user_id: r.winA.user, org_id: r.org } })).body.message;
    r.h.db.run('UPDATE members SET removed_at = ? WHERE org_id = ? AND user_id = ?', new Date().toISOString(), r.org, r.bob.user);
    const out = await release(r, r.bob, m.id, { decision: 'send' });
    assert.equal(out.status, 200, out.text);
    assert.equal(out.body.message.state, 'rejected');
    assert.equal(out.body.message.reason, 'sender_removed');
    assert.equal(r.h.db.get('SELECT state FROM msg_messages WHERE id = ?', m.id).state, 'rejected');
  } finally { await r.close(); }
});

test('bodies are scrubbed with cleanPacketText on create and on an edited release', async () => {
  const r = await messagingRig();
  try {
    const m = (await ask(r, r.winA, 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH at /Users/alice/secret/app.env and https://u:p@example.com/x?token=1')).body.message;
    assert.ok(!m.body.includes('sk-ant-api03'), m.body);
    assert.ok(!m.body.includes('/Users/alice'), m.body);
    assert.ok(!m.body.includes('u:p@') && !m.body.includes('token=1'), m.body);
    const out = (await release(r, r.winA, m.id, { decision: 'send', body: 'see /Users/alice/x' })).body.message;
    assert.equal(out.body, 'see <path>');
    // Ordinary (unheld) messages are scrubbed too.
    const plain = (await r.api(r.winA, 'POST', '/messages', { request_id: randomUUID(), to: { user_id: r.bob.user, org_id: r.org }, body: 'at /Users/alice/y' })).body.message;
    assert.equal(plain.body, 'at <path>');
  } finally { await r.close(); }
});

test('hold is only for a person destination without ttl; via needs hold and is closed', async () => {
  const r = await messagingRig();
  try {
    assert.equal((await ask(r, r.winA, 'q', { ttl_s: 60 })).status, 400);
    assert.equal((await ask(r, r.winA, 'q', { hold: 'yes' })).status, 400);
    assert.equal((await ask(r, r.winA, 'q', { hold: undefined })).status, 400, 'via without hold');
    assert.equal((await ask(r, r.winA, 'q', { via: { surface: 'remote' } })).status, 400);
    assert.equal((await ask(r, r.winA, 'q', { via: { surface: 'local', extra: 1 } })).status, 400);
    assert.equal((await ask(r, r.winA, 'q', { via: { surface: 'local', label: 'x'.repeat(61) } })).status, 413);
    assert.equal((await ask(r, r.winA, 'q', { to: { target: randomUUID() } })).status, 400);
  } finally { await r.close(); }
});

test('the reply_to filter returns only replies addressed to the asker', async () => {
  const r = await messagingRig();
  try {
    const m = (await ask(r, r.winA, 'q')).body.message;
    await release(r, r.winA, m.id, { decision: 'send' });
    const other = (await r.api(r.winA, 'POST', '/messages', { request_id: randomUUID(), to: { user_id: r.bob.user, org_id: r.org }, body: 'unrelated' })).body.message;
    const answer = await r.api(r.bob, 'POST', '/messages', { request_id: randomUUID(), to: { user_id: r.winA.user, org_id: r.org }, body: 'QUEUE_URL', reply_to: m.id });
    assert.equal(answer.status, 200, answer.text);
    await r.api(r.bob, 'POST', '/messages', { request_id: randomUUID(), to: { user_id: r.winA.user, org_id: r.org }, body: 'other thread', reply_to: other.id });
    await r.api(r.bob, 'POST', '/messages', { request_id: randomUUID(), to: { user_id: r.winA.user, org_id: r.org }, body: 'no thread' });
    const replies = await inbox(r, r.winA, `&reply_to=${m.id}`);
    assert.deepEqual(replies.map((x) => x.body), ['QUEUE_URL']);
    assert.equal((await r.api(r.winA, 'GET', `/messages/${m.id}`)).body.message.state, 'replied');
    // Bob's own inbox, filtered by the same id, has none: replies addressed to someone else never show.
    assert.equal((await inbox(r, r.bob, `&reply_to=${m.id}`)).length, 0);
    assert.equal((await r.api(r.winA, 'GET', '/messages?box=sent&reply_to=' + m.id)).status, 400);
    assert.equal((await r.api(r.winA, 'GET', '/messages?box=inbox&reply_to=nope')).status, 400);
  } finally { await r.close(); }
});

test('072 keeps existing message rows, their seq and the sequence, and allows held', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrate, loadMigrations } = await import('../../shared/migrate.js');
  const all = loadMigrations();
  const db = new DatabaseSync(':memory:');
  migrate(db, { migrations: all.filter((m) => m.version < 72) });
  const row = { id: randomUUID(), request_id: randomUUID(), request_hash: 'h', kind: 'message', source_kind: 'person', source_user_id: 'u1', source_cred_kind: 'device', source_cred_id: 'd1',
    dest_kind: 'person', dest_user_id: 'u2', conversation_id: 'c', body: 'kept', authority_version: 0, state: 'replied', created_at: 'a', expires_at: 'b', updated_at: 'c' };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO msg_messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
  assert.throws(() => db.prepare("UPDATE msg_messages SET state = 'held'").run(), /CHECK/);
  assert.deepEqual(migrate(db, { migrations: all.filter((m) => m.version < 73) }), [72]);
  assert.deepEqual({ ...db.prepare('SELECT seq, body, state, via_json FROM msg_messages').get() }, { seq: 1, body: 'kept', state: 'replied', via_json: null });
  db.prepare("UPDATE msg_messages SET state = 'held'").run();
  db.prepare(`INSERT INTO msg_messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values({ ...row, id: randomUUID(), request_id: randomUUID() }));
  assert.equal(db.prepare('SELECT MAX(seq) n FROM msg_messages').get().n, 2);
  assert.throws(() => db.prepare("UPDATE msg_messages SET via_json = 'not json'").run(), /CHECK/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'msg_messages_source_state'").get());
});

test('073 keeps rows, seq, via_json and the indexes, and allows the done and failed handoff outcomes', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrate, loadMigrations } = await import('../../shared/migrate.js');
  const all = loadMigrations();
  const db = new DatabaseSync(':memory:');
  migrate(db, { migrations: all.filter((m) => m.version < 73) });
  const row = { id: randomUUID(), request_id: randomUUID(), request_hash: 'h', kind: 'handoff', source_kind: 'person', source_user_id: 'u1', source_cred_kind: 'device', source_cred_id: 'd1',
    dest_kind: 'person', dest_user_id: 'u2', conversation_id: 'c', body: 'kept', handoff: '{}', handoff_state: 'accepted', authority_version: 0, state: 'delivered', created_at: 'a', expires_at: 'b', updated_at: 'c', via_json: '{"surface":"local"}' };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO msg_messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
  assert.throws(() => db.prepare("UPDATE msg_messages SET handoff_state = 'done'").run(), /CHECK/);
  assert.deepEqual(migrate(db, { migrations: all }), [73, 75, 76, 79, 80, 81]);
  assert.deepEqual({ ...db.prepare('SELECT seq, body, handoff_state, via_json FROM msg_messages').get() }, { seq: 1, body: 'kept', handoff_state: 'accepted', via_json: '{"surface":"local"}' });
  db.prepare("UPDATE msg_messages SET handoff_state = 'done'").run();
  db.prepare("UPDATE msg_messages SET handoff_state = 'failed'").run();
  assert.throws(() => db.prepare("UPDATE msg_messages SET handoff_state = 'bogus'").run(), /CHECK/);
  db.prepare(`INSERT INTO msg_messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values({ ...row, id: randomUUID(), request_id: randomUUID() }));
  assert.equal(db.prepare('SELECT MAX(seq) n FROM msg_messages').get().n, 2);
  for (const idx of ['msg_messages_offered', 'msg_messages_source_state', 'msg_messages_dest_user']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(idx), idx);
});

test('072 carries the seq high-water mark across: a deleted top message\'s seq is never reused', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrate, loadMigrations } = await import('../../shared/migrate.js');
  const all = loadMigrations();
  const row = () => ({ id: randomUUID(), request_id: randomUUID(), request_hash: 'h', kind: 'message', source_kind: 'person', source_user_id: 'u1', source_cred_kind: 'device', source_cred_id: 'd1',
    dest_kind: 'person', dest_user_id: 'u2', conversation_id: 'c', body: 'b', authority_version: 0, state: 'queued', created_at: 'a', expires_at: 'b', updated_at: 'c' });
  const put = (db) => { const r = row(); const cols = Object.keys(r); return Number(db.prepare(`INSERT INTO msg_messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(r)).lastInsertRowid); };
  for (const keep of [1, 0]) {
    const db = new DatabaseSync(':memory:');
    migrate(db, { migrations: all.filter((m) => m.version < 72) });
    for (let i = 0; i < 3; i++) put(db);
    db.prepare('DELETE FROM msg_messages WHERE seq > ?').run(keep);
    migrate(db, { migrations: all });
    assert.equal(put(db), 4, `with ${keep} row(s) left`);
  }
});

test('the hub scrubs every credential shape the app does, userinfo in any scheme, and handoff reports; routes survive', async () => {
  const r = await messagingRig();
  try {
    const samples = ['sk_live_51Hab0123456789', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'postgres://admin:hunter2@db.internal:5432/app', 'npm_abcdefghijklmnopqrstuvwxyz0123456789', 'glpat-abcdefghij0123456789', 'api_key: "Zx9q-secretvalue-123456"'];
    const leaks = ['sk_live_51H', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIi', 'hunter2', 'npm_abcdefghij', 'glpat-abcdefghij', 'Zx9q-secretvalue'];
    const body = samples.map((s, i) => `${i}: ${s}`).join('\n') + '\nGET /api/v1/orders?id=1 is slow';
    const m = (await ask(r, r.winA, body)).body.message;
    for (const l of leaks) assert.ok(!m.body.includes(l), `${l} survived:\n${m.body}`);
    assert.match(m.body, /postgres:\/\/<redacted>@db\.internal/);
    assert.match(m.body, /GET \/api\/v1\/orders/, 'a route stays readable');
    // An edited release goes through the same scrubber.
    const out = (await release(r, r.winA, m.id, { decision: 'send', body: `try ${samples[3]} via ftp://u:pw@host/x` })).body.message;
    assert.ok(!out.body.includes('npm_abcdefghij') && !out.body.includes('u:pw@'), out.body);

    // A handoff decision report is scrubbed too.
    const h = (await r.api(r.winA, 'POST', '/messages', { request_id: randomUUID(), to: { user_id: r.bob.user, org_id: r.org }, kind: 'handoff', body: 'take it' })).body.message;
    const d = await r.api(r.bob, 'POST', `/messages/${h.id}/handoff`, { decision: 'decline', report: `no, password is: hunter2 and ${samples[0]}` });
    assert.equal(d.status, 200, d.text);
    assert.ok(!d.body.message.handoff.report.includes('hunter2') && !d.body.message.handoff.report.includes('sk_live_51H'), d.body.message.handoff.report);
  } finally { await r.close(); }
});

test('M1: the hub folds a body before scrubbing it, so a key split by a zero-width space or soft hyphen, or in fullwidth, is redacted', async () => {
  const r = await messagingRig();
  try {
    const full = (x) => x.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    const KEY = 'npm_abcdefghijklmnopqrstuvwxyz0123456789';
    const body = `a npm_abcdefghij\u200bklmnopqrstuvwxyz0123456789 b npm_abcdefghij\u00adklmnopqrstuvwxyz0123456789 c ${full(KEY)}`;
    const res = await ask(r, r.winA, body);
    assert.equal(res.status, 200, res.text);
    const seen = (x) => x.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
    assert.ok(!seen(res.body.message.body).includes('npm_abcdefghij'), res.body.message.body);
  } finally { await r.close(); }
});
