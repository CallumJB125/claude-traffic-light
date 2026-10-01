// A background mail failure is invisible to the person signing in (the hub has
// already answered "started"), so the operator needs a signal that does not
// need the logs: /api/health says when a send last failed, never to whom or why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAccounts } from './accounts-helpers.js';
import { outboxMailer } from '../identity/mailer.js';

const start = (h, email) => h.call('POST', '/api/auth/email/start', { body: { email, client: 'buddy_desktop', device_name: 'Test Mac', platform: 'darwin-arm64' } });
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } return null; };

test('health: a failed background send sets mail.last_error_at; no address, no detail; a good send does not clear it', async () => {
  let fail = true;
  const out = outboxMailer();
  const mailer = { kind: 'ses', async send(m) { if (fail) throw new Error('SES answered 403 (AccessDenied)'); return out.send(m); } };
  const h = await startAccounts({ mailer });
  try {
    const before = await h.call('GET', '/api/health');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.mail, { last_error_at: null });
    const r = await start(h, 'someone@example.com');
    assert.equal(r.status, 200, 'the answer is the same whether or not the send fails');
    const after = await until(async () => { const x = await h.call('GET', '/api/health'); return x.body.mail.last_error_at ? x : null; });
    assert.ok(after, 'the failure shows up');
    assert.match(after.body.mail.last_error_at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.deepEqual(Object.keys(after.body.mail), ['last_error_at']);
    assert.ok(!JSON.stringify(after.body).includes('someone@example.com') && !JSON.stringify(after.body).includes('AccessDenied'));
    fail = false;
    const t = after.body.mail.last_error_at;
    await start(h, 'other@example.com');
    await until(() => out.sent.length > 0);
    const later = await h.call('GET', '/api/health');
    assert.equal(later.body.mail.last_error_at, t, 'a later success leaves the time of the last failure in place');
  } finally { await h.close(); }
});

test('health: the invite and deletion mails count too (every send goes through the same tracking)', async () => {
  const mailer = { kind: 'ses', async send() { throw new Error('boom'); } };
  const h = await startAccounts({ mailer });
  try {
    assert.equal((await h.call('GET', '/api/health')).body.mail.last_error_at, null);
    await assert.rejects(h.hub.accounts.mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), /boom/);
    assert.ok((await h.call('GET', '/api/health')).body.mail.last_error_at, 'a direct send through the hub mailer is tracked');
  } finally { await h.close(); }
});

test('health: no mailer, no mail key; a hub that is not in accounts mode has none either', async () => {
  const h = await startAccounts({ mailer: null });
  try {
    const x = await h.call('GET', '/api/health');
    assert.equal(x.status, 200);
    assert.equal('mail' in x.body, false);
  } finally { await h.close(); }
});
