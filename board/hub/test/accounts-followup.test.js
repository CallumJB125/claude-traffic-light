// Follow-ups from the review of the email-code → team journey: a start the
// quiet limit silences behaves like a real flow (tries count down, it dies,
// it never kills the real flow, it is swept), the invite routes keep no link
// or code in the replay cache, pending invites are only usable ones, and
// WRONG_ACCOUNT names no address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startAccounts } from './accounts-helpers.js';
import { tenancy } from './tenancy/fixture.js';

const MIN = 60_000;
const DAY = 86_400_000;
const webStart = (h, email) => h.start(email, { client: 'web' });
const verify = (h, flowId, code) => h.call('POST', '/api/auth/email/verify', { body: { flow_id: flowId, code } });
const flowCookie = (r) => r.cookies.find((c) => c.startsWith('__Host-buddy_flow='));

test('a start the per-mailbox quiet limit silences: same answer, no mail, a dud flow that counts down and dies; the real flow lives on', async () => {
  const h = await startAccounts();
  try {
    const email = 'quiet@example.com';
    const real = [];
    for (let i = 0; i < 3; i++) {
      const r = await webStart(h, email);
      real.push({ r, code: h.codeFor(email) });
    }
    const sent = h.mailer.sent.length;
    const dud = await webStart(h, email);
    assert.equal(h.mailer.sent.length, sent, 'no mail');
    assert.equal(dud.status, real[0].r.status);
    assert.deepEqual(Object.keys(dud.body).sort(), Object.keys(real[0].r.body).sort());
    assert.equal(dud.body.expires_in, real[0].r.body.expires_in);
    assert.match(dud.body.flow_id, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(flowCookie(dud)?.replace(/=[^;]*/, '='), flowCookie(real[0].r).replace(/=[^;]*/, '='), 'the same flow cookie as a real start');
    assert.ok(h.db.get("SELECT 1 AS x FROM audit WHERE action = 'auth.code.suppressed' AND detail LIKE '%email_rate%'"));

    const left = [];
    for (let i = 0; i < 6; i++) {
      const v = await verify(h, dud.body.flow_id, i === 5 ? real[0].code : '000000');
      assert.equal(v.body.error.code, 'INVALID_TOKEN');
      left.push(v.body.error.attempts_left);
    }
    assert.deepEqual(left, [4, 3, 2, 1, 0, undefined], 'counts down to dead, then the generic answer (even for a real code)');

    assert.equal(h.db.get('SELECT dead_at FROM login_flows WHERE id = ?', real[0].r.body.flow_id).dead_at, null, 'the oldest real flow was not superseded');
    const ok = await verify(h, real[0].r.body.flow_id, real[0].code);
    assert.equal(ok.status, 200, ok.text);
  } finally {
    await h.close();
  }
});

test('a dud flow never pushes a real one out of the three live flows per address', async () => {
  const h = await startAccounts();
  try {
    const email = 'live@example.com';
    const flows = [];
    for (let i = 0; i < 3; i++) flows.push([(await h.start(email)).body.flow_id, h.codeFor(email)]);
    await h.start(email); // silenced: a dud
    h.clock.advance(5 * MIN); // the 15-minute bucket refills one
    await h.start(email);
    assert.ok(h.db.get('SELECT dead_at FROM login_flows WHERE id = ?', flows[0][0]).dead_at, 'the oldest real flow goes, as before');
    assert.equal(h.db.get('SELECT dead_at FROM login_flows WHERE id = ?', flows[1][0]).dead_at, null, 'the dud is not one of the three');
  } finally {
    await h.close();
  }
});

test('a start over the daily mail cap is a dud flow too', async () => {
  const h = await startAccounts({ config: { mailDailyCap: 2 } });
  try {
    await h.start('a@example.com');
    const quiet = await h.start('b@example.com');
    assert.equal(h.mailer.last('b@example.com'), null);
    assert.ok(h.db.get('SELECT 1 AS x FROM login_flows WHERE id = ?', quiet.body.flow_id));
    assert.equal((await verify(h, quiet.body.flow_id, '000000')).body.error.attempts_left, 4);
  } finally {
    await h.close();
  }
});

test('sign-in flows, duds with them, are deleted a day after they expire', async () => {
  const h = await startAccounts();
  try {
    const email = 'sweep@example.com';
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await h.start(email)).body.flow_id);
    const has = () => ids.filter((id) => h.db.get('SELECT 1 AS x FROM login_flows WHERE id = ?', id)).length;
    assert.equal(has(), 4, 'three real flows and a dud');
    h.clock.advance(10 * MIN + DAY - MIN);
    h.hub.oauth.sweep();
    assert.equal(has(), 4, 'kept until a day past expiry');
    h.clock.advance(2 * MIN);
    h.hub.oauth.sweep();
    assert.equal(has(), 0);
  } finally {
    await h.close();
  }
});

test('invite routes: a replayed request_id answers a fixed 409 REPLAYED; no link or code sits in the replay cache', async () => {
  const fx = await tenancy();
  try {
    const { h, users, A } = fx;
    const rid = randomUUID();
    const path = `/api/teams/${A.team}/invites`;
    const first = await fx.as(users.ua, 'POST', path, { email: 'replay@example.com', role: 'member', request_id: rid });
    assert.equal(first.status, 200, first.text);
    const token = first.body.link.split('#')[1];
    const again = await fx.as(users.ua, 'POST', path, { email: 'replay@example.com', role: 'member', request_id: rid });
    assert.equal(again.status, 409);
    assert.equal(again.headers.get('board-replayed'), '1');
    assert.deepEqual(again.body, { error: { code: 'CONFLICT', message: 'This invite was already made. Resend it to get a new link.', reason: 'REPLAYED' } });
    const cached = JSON.stringify(h.hub.cachedResponse(A.owner, rid));
    assert.ok(!cached.includes(token) && !cached.includes(first.body.code) && !cached.includes('inv_'), cached);

    const rid2 = randomUUID();
    const re = await fx.as(users.ua, 'POST', `${path}/${first.body.invite.id}/resend`, { request_id: rid2 });
    assert.equal(re.status, 200, re.text);
    const re2 = await fx.as(users.ua, 'POST', `${path}/${re.body.invite.id}/resend`, { request_id: rid2 });
    assert.equal(re2.body.error.reason, 'REPLAYED');
    const all = JSON.stringify([...h.hub.requestCache.values()]);
    for (const s of [token, re.body.link.split('#')[1], first.body.code, re.body.code]) assert.ok(!all.includes(s), 'nothing secret in the cache');
  } finally {
    await fx.h.close();
  }
});

test('pending_invites lists only usable invites: not one whose inviter may no longer invite as that role', async () => {
  const fx = await tenancy();
  try {
    const { users, A } = fx;
    const inv = await fx.as(users.aadmin, 'POST', `/api/teams/${A.team}/invites`, { email: 'pend@example.com', role: 'admin' });
    assert.equal(inv.status, 200, inv.text);
    const r = await fx.h.signIn('pend@example.com');
    const me = { token: r.body.device_token };
    const pending = async () => (await fx.as(me, 'GET', '/api/account')).body.pending_invites.map((i) => i.id);
    assert.deepEqual(await pending(), [inv.body.invite.id]);
    assert.equal((await fx.as(users.ua, 'PATCH', `/api/teams/${A.team}/members/${A.admin}`, { role: 'member' })).status, 200);
    assert.deepEqual(await pending(), [], 'its inviter was demoted: not usable, not listed');
    assert.equal((await fx.as(users.ua, 'PATCH', `/api/teams/${A.team}/members/${A.admin}`, { role: 'admin' })).status, 200);
    assert.deepEqual(await pending(), [inv.body.invite.id]);
  } finally {
    await fx.h.close();
  }
});

test('WRONG_ACCOUNT names no address, masked or not', async () => {
  const fx = await tenancy();
  try {
    const r = await fx.as(fx.users.ua, 'POST', `/api/teams/${fx.A.team}/invites`, { email: 'carol@example.com', role: 'member' });
    const w = await fx.as(fx.users.n, 'POST', '/api/invites/accept', { t: r.body.link.split('#')[1] });
    assert.equal(w.status, 403);
    assert.equal(w.body.error.code, 'WRONG_ACCOUNT');
    assert.equal('email_masked' in w.body.error, false);
    assert.ok(!/c•••|carol|example\.com/.test(w.text), w.text);
  } finally {
    await fx.h.close();
  }
});
