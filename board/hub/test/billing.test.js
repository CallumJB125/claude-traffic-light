// W3-A billing (board/hub/billing/): hosted Checkout / portal hand-off, the
// signed provider webhook (signature, timestamp, idempotency, ordering,
// dunning, cancellation), Team seats capping members, and the Ed25519
// entitlement token the desktop app verifies. No request leaves the process:
// the provider's API is a fake fetch, and every webhook is a fixture signed
// with the test secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID, createPublicKey } from 'node:crypto';
import { mkdtempSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tenancy } from './tenancy/fixture.js';
import { dumpDb } from './accounts-helpers.js';
import { accessUntil, GRACE_S } from '../billing/entitlements.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SECRET = 'whsec_test_fixture_only';
const DAY = 86_400;
const PRICES = { 'plus:month': 'price_plus_m', 'plus:year': 'price_plus_y', 'team:month': 'price_team_m' };

function keyFile() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'billing-key-'));
  const file = join(dir, 'entitlement.pem');
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { file, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) };
}

// A fake provider API: records each call, answers a hosted URL. Never the network.
function fakeApi() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {}, body: new URLSearchParams(init.body ?? '') });
    const u = String(url);
    const json = u.endsWith('/v1/checkout/sessions') ? { id: 'cs_test_1', url: 'https://checkout.stripe.test/c/cs_test_1' }
      : u.endsWith('/v1/billing_portal/sessions') ? { id: 'bps_1', url: 'https://billing.stripe.test/p/bps_1' } : null;
    return new Response(JSON.stringify(json ?? { error: { message: 'unknown' } }), { status: json ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

async function setup({ billing = true } = {}) {
  const key = keyFile();
  const api = fakeApi();
  const config = billing
    ? { publicUrl: 'http://127.0.0.1', billingProvider: 'stripe', billingApiKey: 'sk_test_fixture_only', billingWebhookSecret: SECRET, billingPrices: PRICES, entitlementKeyFile: key.file }
    : { entitlementKeyFile: key.file };
  const fx = await tenancy({ config, fetchImpl: api.fetchImpl });
  const nowS = () => Math.floor(fx.h.hub.wallMs() / 1000);
  // A fixture event, signed as the provider signs it.
  let seq = 0;
  const event = (type, object, { id = `evt_${++seq}_${randomUUID().slice(0, 8)}`, created = nowS() } = {}) => ({ id, object: 'event', type, created, data: { object } });
  const deliver = async (evt, { secret = SECRET, t = nowS(), raw = JSON.stringify(evt), header } = {}) => {
    const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    const res = await fetch(`${fx.h.base}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': header ?? `t=${t},v1=${sig}` }, body: raw });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const row = (type, id) => fx.db.get('SELECT * FROM entitlements WHERE subject_type = ? AND subject_id = ?', type, id);
  return { ...fx, key, api, nowS, event, deliver, row };
}

// Fixture objects shaped like the provider's, with payment-method details that must never be stored.
const CARD = { payment_method_details: { card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, fingerprint: 'FPRINTCARDSECRET' } }, billing_details: { address: { line1: '1 Secret Street', country: 'ZA' } } };
const session = (subject, plan, extra = {}) => ({ id: 'cs_test_1', object: 'checkout.session', mode: 'subscription', customer: 'cus_A', subscription: 'sub_A', payment_status: 'paid',
  client_reference_id: `${subject.type}:${subject.id}`, customer_details: { email: 'buyer@alpha.test', address: { country: 'ZA' } }, metadata: { subject_type: subject.type, subject_id: subject.id, plan, interval: 'month' }, ...CARD, ...extra });
const subscription = (subject, plan, { status = 'active', periodEnd, cancel = false, quantity = 1, sub = 'sub_A', price = plan === 'team' ? 'price_team_m' : 'price_plus_m' } = {}) => ({
  id: sub, object: 'subscription', customer: 'cus_A', status, cancel_at_period_end: cancel, current_period_end: periodEnd,
  items: { data: [{ price: { id: price }, quantity }] }, metadata: { subject_type: subject.type, subject_id: subject.id, plan, interval: 'month' }, default_payment_method: CARD });
const invoice = (subject, periodEnd, { sub = 'sub_A' } = {}) => ({ id: `in_${randomUUID().slice(0, 6)}`, object: 'invoice', customer: 'cus_A', subscription: sub, status: 'paid',
  lines: { data: [{ period: { start: periodEnd - 30 * DAY, end: periodEnd } }] }, subscription_details: { metadata: { subject_type: subject.type, subject_id: subject.id, plan: 'plus' } }, charge: CARD, customer_address: { country: 'ZA' } });

function decode(token) {
  const [, body] = token.split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

test('Plus: hosted Checkout link, then signed checkout + invoice events → a verifiable entitlement token (exp = period end + 14 d)', async () => {
  const fx = await setup();
  try {
    const me = { type: 'user', id: fx.users.ua.id };
    assert.deepEqual((await fx.as(fx.users.ua, 'GET', '/api/entitlement')).body, { plan: 'free', token: null });

    const co = await fx.as(fx.users.ua, 'POST', '/api/billing/checkout', { request_id: randomUUID(), interval: 'month' });
    assert.equal(co.status, 200, co.text);
    assert.equal(co.body.url, 'https://checkout.stripe.test/c/cs_test_1');
    const call = fx.api.calls.at(-1);
    assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(call.headers.authorization, 'Bearer sk_test_fixture_only');
    assert.equal(call.body.get('mode'), 'subscription');
    assert.equal(call.body.get('line_items[0][price]'), 'price_plus_m');
    assert.equal(call.body.get('subscription_data[metadata][subject_id]'), fx.users.ua.id);
    assert.equal(call.body.get('customer_email'), 'owner@alpha.test');
    assert.equal(call.body.get('success_url'), 'http://127.0.0.1/billing?checkout=done');
    assert.ok(![...call.body.keys()].some((k) => /card|payment_method/.test(k)), 'the hub never sends card fields: Checkout is hosted');
    assert.equal((await fx.as(fx.users.ua, 'POST', '/api/billing/checkout', { interval: 'week' })).status, 400);

    const r1 = await fx.deliver(fx.event('checkout.session.completed', session(me, 'plus')));
    assert.deepEqual([r1.status, r1.body], [200, { received: true }]);
    const created = fx.row('user', me.id);
    assert.equal(created.status, 'incomplete');
    assert.equal(created.provider_customer, 'cus_A');
    assert.equal(created.provider_subscription, 'sub_A');
    assert.equal((await fx.as(fx.users.ua, 'GET', '/api/entitlement')).body.plan, 'free', 'not paid yet');

    const periodEnd = fx.nowS() + 30 * DAY;
    assert.equal((await fx.deliver(fx.event('invoice.paid', invoice(me, periodEnd)))).status, 200);
    const got = await fx.as(fx.users.ua, 'GET', '/api/entitlement');
    assert.equal(got.status, 200, got.text);
    assert.equal(got.body.plan, 'plus');
    const claims = decode(got.body.token);
    assert.equal(claims.sub, me.id);
    assert.equal(claims.plan, 'plus');
    assert.equal(claims.period_end, periodEnd);
    assert.equal(claims.exp, periodEnd + GRACE_S);
    assert.equal(claims.iat, fx.nowS());

    // The desktop verifier (src/entitlements.js) accepts it with the pinned public key.
    const Ent = require('../../../src/entitlements.js');
    const root = mkdtempSync(join(tmpdir(), 'ent-root-'));
    writeFileSync(join(root, 'entitlement.json'), JSON.stringify({ token: got.body.token }));
    Ent.configure({ root, publicKeys: [fx.key.publicPem], now: () => fx.h.hub.wallMs() });
    assert.equal(Ent.plan(), 'plus');
    assert.equal(Ent.has('phone'), true);
    Ent.configure({ root, publicKeys: [generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })], now: () => fx.h.hub.wallMs() });
    assert.equal(Ent.plan(), 'free', 'a token from another key is refused');

    const summary = await fx.as(fx.users.ua, 'GET', '/api/billing');
    assert.equal(summary.body.effective_plan, 'plus');
    assert.equal(summary.body.plus.manageable, true);
    assert.equal((await fx.as(fx.users.ua, 'POST', '/api/billing/checkout', { interval: 'month' })).status, 409, 'already subscribed');
    const portal = await fx.as(fx.users.ua, 'POST', '/api/billing/portal', {});
    assert.equal(portal.body.url, 'https://billing.stripe.test/p/bps_1');
    assert.equal(fx.api.calls.at(-1).body.get('customer'), 'cus_A');
    assert.equal((await fx.as(fx.users.n, 'POST', '/api/billing/portal', {})).status, 404, 'nothing to manage');
  } finally { await fx.h.close(); }
});

test('webhook: bad or stale signature is 400 and changes nothing; a duplicate delivery is idempotent', async () => {
  const fx = await setup();
  try {
    const me = { type: 'user', id: fx.users.ua.id };
    const evt = fx.event('checkout.session.completed', session(me, 'plus'));
    const before = dumpDb(fx.db);
    assert.equal((await fx.deliver(evt, { secret: 'whsec_wrong' })).status, 400);
    assert.equal((await fx.deliver(evt, { t: fx.nowS() - 301 })).status, 400, 'outside the timestamp tolerance');
    assert.equal((await fx.deliver(evt, { header: 'garbage' })).status, 400);
    assert.equal((await fx.deliver(evt, { header: '' })).status, 400);
    // Signed over different bytes than were sent.
    const t = fx.nowS();
    const sig = createHmac('sha256', SECRET).update(`${t}.${JSON.stringify(evt)}`).digest('hex');
    const res = await fetch(`${fx.h.base}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: JSON.stringify({ ...evt, id: 'evt_forged' }) });
    assert.equal(res.status, 400);
    assert.equal(dumpDb(fx.db), before, 'no refused delivery wrote anything');

    assert.deepEqual((await fx.deliver(evt)).body, { received: true });
    const first = JSON.stringify(fx.row('user', me.id));
    fx.h.clock.advance(60_000);
    const again = await fx.deliver(evt);
    assert.deepEqual([again.status, again.body], [200, { received: true, duplicate: true }]);
    assert.equal(JSON.stringify(fx.row('user', me.id)), first, 'the repeat changed nothing');
    assert.equal(fx.db.get('SELECT COUNT(*) n FROM billing_events').n, 1);
    // Events we do not act on are recorded (so not retried) and touch no plan.
    assert.deepEqual((await fx.deliver(fx.event('charge.succeeded', CARD))).body, { received: true });
    assert.equal(fx.db.get("SELECT outcome FROM billing_events WHERE type = 'charge.succeeded'").outcome, 'ignored');
  } finally { await fx.h.close(); }
});

test('cancellation keeps access to the period end; dunning stops at the paid-through date; older events never overwrite newer', async () => {
  const fx = await setup();
  try {
    const me = { type: 'user', id: fx.users.ua.id };
    const t0 = fx.nowS();
    const end1 = t0 + 30 * DAY;
    await fx.deliver(fx.event('checkout.session.completed', session(me, 'plus')));
    await fx.deliver(fx.event('customer.subscription.created', subscription(me, 'plus', { periodEnd: end1 })));
    await fx.deliver(fx.event('invoice.paid', invoice(me, end1)));
    assert.equal(fx.row('user', me.id).status, 'active');

    // Cancel at period end: still Plus until end1, then free.
    fx.h.clock.advance(10 * DAY * 1000);
    await fx.deliver(fx.event('customer.subscription.updated', subscription(me, 'plus', { periodEnd: end1, cancel: true })));
    let got = await fx.as(fx.users.ua, 'GET', '/api/entitlement');
    assert.equal(got.body.plan, 'plus');
    assert.equal(decode(got.body.token).period_end, end1);
    assert.equal((await fx.as(fx.users.ua, 'GET', '/api/billing')).body.plus.cancel_at_period_end, true);
    // Provider ends it at the period end.
    fx.h.clock.advance(20 * DAY * 1000 + 1000);
    await fx.deliver(fx.event('customer.subscription.deleted', subscription(me, 'plus', { status: 'canceled', periodEnd: end1, cancel: true })));
    got = await fx.as(fx.users.ua, 'GET', '/api/entitlement');
    assert.deepEqual(got.body, { plan: 'free', token: null });

    // A new subscription for the same user (re-subscribe), then a failed renewal.
    const t1 = fx.nowS();
    const end2 = t1 + 30 * DAY;
    await fx.deliver(fx.event('checkout.session.completed', session(me, 'plus', { subscription: 'sub_B' })));
    await fx.deliver(fx.event('customer.subscription.updated', subscription(me, 'plus', { sub: 'sub_B', periodEnd: end2 })));
    await fx.deliver(fx.event('invoice.paid', invoice(me, end2, { sub: 'sub_B' })));
    assert.equal(fx.row('user', me.id).provider_subscription, 'sub_B');
    assert.equal((await fx.as(fx.users.ua, 'GET', '/api/entitlement')).body.plan, 'plus');
    fx.h.clock.advance(30 * DAY * 1000 + 1000);
    const end3 = end2 + 30 * DAY;
    // The period rolled over, but the renewal failed: access only to what was paid (end2).
    const failed = fx.event('invoice.payment_failed', { ...invoice(me, end3, { sub: 'sub_B' }), status: 'open', attempt_count: 1 });
    await fx.deliver(fx.event('customer.subscription.updated', subscription(me, 'plus', { sub: 'sub_B', status: 'past_due', periodEnd: end3 })));
    await fx.deliver(failed);
    const dunning = fx.row('user', me.id);
    assert.equal(dunning.status, 'past_due');
    assert.equal(accessUntil(dunning), end2);
    assert.deepEqual((await fx.as(fx.users.ua, 'GET', '/api/entitlement')).body, { plan: 'free', token: null }, 'unpaid period grants nothing on the hub; the desktop keeps its 14-day offline grace');
    // The retry succeeds: back to Plus through end3.
    await fx.deliver(fx.event('invoice.paid', invoice(me, end3, { sub: 'sub_B' })));
    assert.equal(fx.row('user', me.id).status, 'active');
    assert.equal(decode((await fx.as(fx.users.ua, 'GET', '/api/entitlement')).body.token).period_end, end3);

    // An event older than the applied state is recorded but cannot roll the status back.
    await fx.deliver(fx.event('customer.subscription.updated', subscription(me, 'plus', { sub: 'sub_B', status: 'canceled', periodEnd: end3 }), { created: t1 }));
    assert.equal(fx.row('user', me.id).status, 'active');
  } finally { await fx.h.close(); }
});

test('Team: owner-only checkout with seats ≥ members; paid seats cap members; every member gets the Team token', async () => {
  const fx = await setup();
  try {
    const team = { type: 'org', id: fx.A.team };
    const path = `/api/teams/${fx.A.team}/billing/checkout`;
    assert.equal((await fx.as(fx.users.aadmin, 'POST', path, { seats: 10 })).status, 403, 'admins cannot change the plan');
    const few = await fx.as(fx.users.ua, 'POST', path, { seats: 2 });
    assert.equal(few.status, 400);
    assert.equal(few.body.error.seats_used, 5);
    assert.equal((await fx.as(fx.users.ua, 'POST', path, { seats: 0 })).status, 400);
    assert.equal((await fx.as(fx.users.ub, 'POST', path, { seats: 9 })).status, 404, 'another team is invisible');
    const co = await fx.as(fx.users.ua, 'POST', path, { seats: 6 });
    assert.equal(co.status, 200, co.text);
    assert.equal(fx.api.calls.at(-1).body.get('line_items[0][quantity]'), '6');
    assert.equal(fx.api.calls.at(-1).body.get('line_items[0][price]'), 'price_team_m');

    const end = fx.nowS() + 30 * DAY;
    await fx.deliver(fx.event('checkout.session.completed', session(team, 'team')));
    await fx.deliver(fx.event('customer.subscription.updated', subscription(team, 'team', { periodEnd: end, quantity: 6 })));
    await fx.deliver(fx.event('invoice.paid', invoice(team, end)));
    assert.equal(fx.db.get('SELECT plan FROM orgs WHERE id = ?', fx.A.team).plan, 'pro');
    assert.equal(fx.row('org', fx.A.team).seats, 6);

    for (const u of [fx.users.ua, fx.users.amember, fx.users.s]) {
      const got = await fx.as(u, 'GET', '/api/entitlement');
      assert.equal(got.body.plan, 'team', u.email);
      assert.equal(decode(got.body.token).exp, end + GRACE_S);
    }
    assert.equal((await fx.as(fx.users.n, 'GET', '/api/entitlement')).body.plan, 'free', 'not in the team');
    const view = await fx.as(fx.users.ua, 'GET', `/api/teams/${fx.A.team}/billing`);
    assert.deepEqual([view.body.plan, view.body.seats, view.body.seats_used], ['team', 6, 5]);
    assert.equal((await fx.as(fx.users.amember, 'GET', `/api/teams/${fx.A.team}/billing`)).status, 403);

    // 5 members + 1 pending fills 6 seats; the next invite is refused.
    const first = await fx.as(fx.users.ua, 'POST', `/api/teams/${fx.A.team}/invites`, { email: 'six@alpha.test', role: 'member' });
    assert.equal(first.status, 200, first.text);
    const over = await fx.as(fx.users.ua, 'POST', `/api/teams/${fx.A.team}/invites`, { email: 'seven@alpha.test', role: 'member' });
    assert.equal(over.status, 403);
    assert.equal(over.body.error.code, 'QUOTA_EXCEEDED');
    assert.equal(over.body.error.limit, 6);

    // Seats added in the portal raise the cap.
    await fx.deliver(fx.event('customer.subscription.updated', subscription(team, 'team', { periodEnd: end, quantity: 8 })));
    assert.equal((await fx.as(fx.users.ua, 'POST', `/api/teams/${fx.A.team}/invites`, { email: 'seven@alpha.test', role: 'member' })).status, 200);

    // After the period (cancelled, no renewal) the team is back on the free plan.
    await fx.deliver(fx.event('customer.subscription.updated', subscription(team, 'team', { periodEnd: end, quantity: 8, cancel: true })));
    fx.h.clock.advance((30 * DAY + 1) * 1000);
    assert.equal((await fx.as(fx.users.amember, 'GET', '/api/entitlement')).body.plan, 'free');
    assert.equal(fx.db.get('SELECT plan FROM orgs WHERE id = ?', fx.A.team).plan, 'free');
  } finally { await fx.h.close(); }
});

test('no card data is ever stored: only provider ids, plan, seats and period', async () => {
  const fx = await setup();
  try {
    const me = { type: 'user', id: fx.users.ua.id };
    const end = fx.nowS() + 30 * DAY;
    await fx.deliver(fx.event('checkout.session.completed', session(me, 'plus')));
    await fx.deliver(fx.event('customer.subscription.updated', subscription(me, 'plus', { periodEnd: end })));
    await fx.deliver(fx.event('invoice.paid', invoice(me, end)));
    const dump = dumpDb(fx.db);
    for (const secret of ['4242', 'FPRINTCARDSECRET', 'Secret Street', 'visa', 'buyer@alpha.test']) assert.ok(!dump.includes(secret), `stored: ${secret}`);
    const cols = fx.db.all("SELECT name FROM pragma_table_info('entitlements')").map((c) => c.name);
    assert.ok(!cols.some((c) => /card|last4|brand|exp_|address|fingerprint|payment_method/.test(c)), cols.join(','));
    assert.deepEqual(fx.db.all("SELECT name FROM pragma_table_info('billing_events')").map((c) => c.name).sort(), ['event_id', 'outcome', 'provider', 'received_at', 'type']);
  } finally { await fx.h.close(); }
});

test('a hub without billing: checkout is METHOD_DISABLED, the webhook is not a route; misconfiguration is refused at start', async () => {
  const fx = await setup({ billing: false });
  try {
    assert.equal((await fx.as(fx.users.ua, 'POST', '/api/billing/checkout', { interval: 'month' })).body.error.code, 'METHOD_DISABLED');
    assert.equal((await fx.as(fx.users.ua, 'GET', '/api/billing')).body.configured, false);
    assert.equal((await fx.deliver(fx.event('checkout.session.completed', {}))).status, 404);
  } finally { await fx.h.close(); }
  const { testConfig } = await import('./helpers.js');
  assert.throws(() => testConfig({ auth: 'accounts', accountsDev: true, billingProvider: 'stripe' }), /BOARD_BILLING_API_KEY/);
  assert.throws(() => testConfig({ auth: 'accounts', accountsDev: true, billingProvider: 'paypal', billingApiKey: 'k', billingWebhookSecret: 's' }), /must be stripe/);
});

test('gen-entitlement-key.mjs writes a 0600 private key, prints only the public key, and never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-key-'));
  const out = join(dir, 'k.pem');
  const script = join(HERE, '..', 'scripts', 'gen-entitlement-key.mjs');
  const printed = execFileSync(process.execPath, [script, '--out', out], { encoding: 'utf8' });
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.doesNotMatch(printed, /PRIVATE KEY/);
  const pub = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(printed)[0];
  assert.equal(createPublicKey(pub).asymmetricKeyType, 'ed25519');
  assert.match(readFileSync(out, 'utf8'), /BEGIN PRIVATE KEY/);
  assert.throws(() => execFileSync(process.execPath, [script, '--out', out], { stdio: 'pipe' }));
});
