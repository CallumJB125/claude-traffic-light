// W3-B: the desktop entitlement refresh (src/entitlement-refresh.js) against a
// fake hub, and the offline behaviour of the token it saves (src/entitlements.js):
// 13 days offline past the paid period still Plus, day 15 free with a banner
// and data intact, clock rollback can't extend, no request while signed out,
// a token is written only after verification, and nothing ever throws.
// Temp data roots only; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Ent = require('../src/entitlements');
const { createRefresher, describe } = require('../src/entitlement-refresh');
const { ENTITLEMENT_KEYS } = require('../src/entitlement-keys');

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const USER = 'user-1';

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey };
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(priv, claims) {
  const head = b64({ alg: 'EdDSA', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${crypto.sign(null, Buffer.from(`${head}.${body}`), priv).toString('base64url')}`;
}

function rig({ signedIn = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-refresh-'));
  const k = keys();
  const clock = { now: T0 };
  Ent.configure({ root, publicKeys: [k.pub], now: () => clock.now });
  const periodEnd = Math.floor((T0 + 30 * DAY) / 1000);
  const claims = { sub: USER, plan: 'plus', iat: Math.floor(T0 / 1000), period_end: periodEnd, exp: periodEnd + 14 * 86_400 };
  const hub = { calls: [], answer: () => ({ status: 200, body: { plan: 'plus', period_end: periodEnd, token: sign(k.priv, claims) } }) };
  const fetch = async (url, init) => {
    hub.calls.push({ url, init });
    const a = await hub.answer(url, init);
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status });
  };
  const id = { origin: 'https://hub.test', userId: USER, token: () => 'device-token' };
  const state = { signedIn };
  const refresher = createRefresher({ identity: () => (state.signedIn ? id : null), fetch });
  const tokenFile = path.join(root, Ent.TOKEN_FILE);
  return { root, k, clock, claims, hub, refresher, state, tokenFile, periodEnd };
}

test('the pinned key list ships empty, and the verifier pins it by default', () => {
  assert.deepEqual(ENTITLEMENT_KEYS, []);
  assert.ok(Object.isFrozen(ENTITLEMENT_KEYS));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'entitlements.js'), 'utf8');
  assert.match(src, /require\('\.\/entitlement-keys'\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', 'entitlement-keys.js'), 'utf8'), /PRIVATE KEY/);
});

test('signed out: no request is ever made', async () => {
  const r = rig({ signedIn: false });
  assert.deepEqual((await r.refresher.check('daily')).reason, 'signed-out');
  assert.equal((await r.refresher.link('checkout', 'month')).reason, 'signed-out');
  assert.equal(r.hub.calls.length, 0);
  // An identity whose token is gone (signed out mid-way) sends nothing either.
  const none = createRefresher({ identity: () => ({ origin: 'https://hub.test', userId: USER, token: () => '' }), fetch: async () => { throw new Error('must not be called'); } });
  assert.equal((await none.check()).reason, 'signed-out');
  // A non-https hub (other than loopback) is never contacted.
  const plain = createRefresher({ identity: () => ({ origin: 'http://hub.test', userId: USER, token: () => 't' }), fetch: async () => { throw new Error('must not be called'); } });
  assert.equal((await plain.check()).reason, 'signed-out');
});

test('a token is written only after it verifies against the pinned key and names the signed-in account', async () => {
  const r = rig();
  const other = keys();
  r.hub.answer = () => ({ status: 200, body: { plan: 'plus', token: sign(other.priv, r.claims) } });
  assert.equal((await r.refresher.check()).reason, 'unverified');
  assert.ok(!fs.existsSync(r.tokenFile));
  r.hub.answer = () => ({ status: 200, body: { plan: 'plus', token: sign(r.k.priv, { ...r.claims, sub: 'someone-else' }) } });
  assert.equal((await r.refresher.check()).reason, 'unverified');
  r.hub.answer = () => ({ status: 200, body: { plan: 'team', token: sign(r.k.priv, r.claims) } });
  assert.equal((await r.refresher.check()).reason, 'unverified', 'answer and token disagree');
  r.hub.answer = () => ({ status: 200, body: { plan: 'plus', token: sign(r.k.priv, { ...r.claims, plan: 'gold' }) } });
  assert.equal((await r.refresher.check()).reason, 'unverified');
  assert.ok(!fs.existsSync(r.tokenFile));
  assert.equal(Ent.plan(), 'free');

  r.hub.answer = () => ({ status: 200, body: { plan: 'plus', token: sign(r.k.priv, r.claims) } });
  const ok = await r.refresher.check('sign-in');
  assert.equal(ok.ok, true);
  assert.equal(Ent.plan(), 'plus');
  assert.equal(fs.statSync(r.tokenFile).mode & 0o777, 0o600);
  const call = r.hub.calls.at(-1);
  assert.equal(call.url, 'https://hub.test/api/entitlement');
  assert.equal(call.init.headers.authorization, 'Bearer device-token');
  assert.equal(call.init.body, undefined, 'nothing but the request itself is sent');
});

test('offline: 13 days past the paid period still Plus (with days left); day 15 free with a banner, data intact', async () => {
  const r = rig();
  await r.refresher.check();
  const keep = path.join(r.root, 'my-work.json');
  fs.writeFileSync(keep, '{"mine":true}');
  r.hub.answer = () => { throw new Error('offline'); };
  const periodEndMs = r.periodEnd * 1000;

  r.clock.now = periodEndMs + 13 * DAY;
  assert.equal((await r.refresher.check('daily')).reason, 'offline');
  assert.equal(Ent.plan(), 'plus');
  const d13 = describe(Ent, r.clock.now);
  assert.equal(d13.inGrace, true);
  assert.equal(d13.daysLeft, 1);
  assert.match(d13.banner, /1 more day/);
  assert.equal(d13.limits['memory.days'], 'unlimited');

  r.clock.now = periodEndMs + 15 * DAY;
  assert.equal(Ent.plan(), 'free');
  assert.equal(Ent.has('phone'), false);
  const d15 = describe(Ent, r.clock.now);
  assert.equal(d15.reason, 'expired');
  assert.match(d15.banner, /ended.*Everything you made is still here/);
  assert.equal(d15.limits['memory.days'], 7);
  assert.equal(fs.readFileSync(keep, 'utf8'), '{"mine":true}', 'data intact');
  assert.ok(fs.existsSync(r.tokenFile), 'nothing deleted offline either');
});

test('turning the clock back cannot extend an expired token, also across a restart', async () => {
  const r = rig();
  await r.refresher.check();
  r.clock.now = r.periodEnd * 1000 + 15 * DAY;
  assert.equal(Ent.plan(), 'free');
  r.clock.now = T0 + DAY;
  assert.equal(Ent.plan(), 'free', 'rolled back in the same run');
  Ent.configure({ root: r.root, publicKeys: [r.k.pub], now: () => r.clock.now });
  assert.equal(Ent.plan(), 'free', 'rolled back after a restart');
});

test('never throws: network errors, refusals, garbage and a throwing identity leave the cached token alone', async () => {
  const r = rig();
  await r.refresher.check();
  const before = fs.readFileSync(r.tokenFile, 'utf8');
  for (const answer of [() => { throw new TypeError('fetch failed'); }, () => ({ status: 500, body: {} }), () => ({ status: 200, body: 'not json' }), () => ({ status: 200, body: { plan: 'plus', token: 42 } }), () => ({ status: 200, body: 'x'.repeat(40_000) })]) {
    r.hub.answer = answer;
    const res = await r.refresher.check();
    assert.equal(res.ok, false);
  }
  assert.equal(fs.readFileSync(r.tokenFile, 'utf8'), before);
  assert.equal(Ent.plan(), 'plus');
  const broken = createRefresher({ identity: () => { throw new Error('boom'); }, fetch: async () => { throw new Error('no'); } });
  assert.equal((await broken.check()).ok, false);
  assert.doesNotThrow(() => describe({ status: () => { throw new Error('x'); }, limits: () => { throw new Error('y'); } }));
});

test('the hub saying "free" removes the cached token (paid features off, nothing else touched)', async () => {
  const r = rig();
  await r.refresher.check();
  assert.equal(Ent.plan(), 'plus');
  r.hub.answer = () => ({ status: 200, body: { plan: 'free', token: null } });
  assert.equal((await r.refresher.check()).reason, 'free');
  assert.ok(!fs.existsSync(r.tokenFile));
  assert.equal(Ent.plan(), 'free');
  // A hub without billing set up (or unreachable) leaves the token as it is.
  r.hub.answer = () => ({ status: 200, body: { plan: 'plus', token: sign(r.k.priv, r.claims) } });
  await r.refresher.check();
  r.hub.answer = () => ({ status: 404, body: { error: { code: 'METHOD_DISABLED' } } });
  assert.equal((await r.refresher.check()).reason, 'refused');
  assert.equal(Ent.plan(), 'plus');
});

test('Upgrade / Manage billing ask the signed-in hub for a hosted https link; anything else falls back to its billing page', async () => {
  const r = rig();
  r.hub.answer = (url, init) => ({ status: 200, body: { url: url.endsWith('/portal') ? 'https://billing.provider.test/p' : 'https://checkout.provider.test/c', echo: JSON.parse(init.body) } });
  const co = await r.refresher.link('checkout', 'year');
  assert.deepEqual(co, { ok: true, url: 'https://checkout.provider.test/c' });
  const sent = JSON.parse(r.hub.calls.at(-1).init.body);
  assert.equal(sent.interval, 'year');
  assert.deepEqual(Object.keys(sent).sort(), ['interval', 'request_id']);
  assert.equal((await r.refresher.link('portal')).url, 'https://billing.provider.test/p');
  r.hub.answer = () => ({ status: 200, body: { url: 'javascript:alert(1)' } });
  assert.deepEqual(await r.refresher.link('checkout'), { ok: false, reason: 'refused', fallback: 'https://hub.test/billing' });
  r.hub.answer = () => ({ status: 409, body: { error: { code: 'CONFLICT' } } });
  assert.equal((await r.refresher.link('checkout')).fallback, 'https://hub.test/billing');
});

test('the refresh is a paid-wiring package, and the Plan & billing page is registered and packaged', () => {
  const { PACKAGES } = require('../src/paid-wiring');
  assert.ok(PACKAGES.some(([name]) => name === 'entitlement-refresh'));
  const { pageById, sectionOf } = require('../buddy-window/pages');
  const page = pageById('upgrade');
  assert.equal(page.file, 'upgrade.html');
  assert.equal(page.preload, 'upgrade-preload.js');
  // Listed only once a hub key is pinned (none ships), or with PLEXIFORM_SHOW_UPGRADE=1.
  assert.equal(page.hidden, true);
  assert.equal(sectionOf('upgrade'), null);
  const shown = require('node:child_process').execFileSync(process.execPath, ['-e', "const p=require('./buddy-window/pages');console.log(JSON.stringify([p.pageById('upgrade').hidden,p.sectionOf('upgrade')]))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PLEXIFORM_SHOW_UPGRADE: '1' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(shown), [false, 'team']);
  const files = require('../package.json').build.files;
  for (const f of ['upgrade.html', 'upgrade.js', 'upgrade-preload.js', 'page.css']) assert.ok(files.includes(f), f);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'entitlement-refresh.js'), 'utf8');
  assert.match(src, /privacy-flow: entitlement-check/);
  assert.match(src, /fromPage\(e, 'upgrade'\)/);
});
