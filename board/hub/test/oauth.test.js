// OAuth sign-in (CONTRACT D76–D78, ACCOUNTS-API.md "OAuth sign-in"): Google
// and GitHub through the desktop loopback + PKCE, against a fake provider (an
// injected fetch) and a real sqlite hub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { startAccounts, dumpDb } from './accounts-helpers.js';
import { fakeClients, fakeProviders, s256 } from './fake-oauth.js';
import { fakeClock } from './helpers.js';
import { createLogger } from '../log.js';
import { emailOnlyIdentity } from '../views.js';
import { outboxMailer } from '../identity/mailer.js';

const REDIRECT = 'http://127.0.0.1:53682/callback';
const ROOMY = Object.fromEntries(['oauth_start_ip', 'oauth_exchange_ip', 'signup_ip', 'mutate_ip', 'login_ip', 'mutate_member'].map((k) => [k, { capacity: 10_000, per_ms: 60_000 }]));
const verifierOf = () => randomBytes(32).toString('base64url');

async function rig({ clients = fakeClients(), config = {}, mailer = null, limits = ROOMY } = {}) {
  const clock = fakeClock();
  const p = fakeProviders({ clock, clients });
  const logs = [];
  const log = createLogger({ level: 'debug', sink: (l) => logs.push(l), clock: clock.wall });
  const h = await startAccounts({ clock, mailer, fetchImpl: p.fetch, log, config: { ...clients, rateLimits: limits, ...config } });
  const start = (provider, over = {}, opts = {}) => h.call('POST', '/api/auth/oauth/start', {
    ...opts,
    body: { provider, code_challenge: s256(over.verifier), redirect_uri: REDIRECT, device_name: 'MacBook-Pro', platform: 'darwin-arm64', client: 'buddy_desktop', ...over.body },
  });
  // The whole desktop flow: start → consent at the provider → exchange.
  async function signIn(provider, who, { token, purpose, providerOver = {}, exchangeOver = {} } = {}) {
    const verifier = verifierOf();
    const s = await start(provider, { verifier, body: purpose ? { purpose } : {} }, { token });
    if (s.status !== 200) return { s, ex: s };
    const a = p.authorize(s.body.url, who, providerOver);
    const ex = await h.call('POST', '/api/auth/oauth/exchange', { token, body: { flow_id: s.body.flow_id, code: a.code, state: a.state, code_verifier: verifier, form_factor: 'laptop', ...exchangeOver } });
    return { s, a, ex, verifier };
  }
  return { h, p, logs, clients, clock, start, signIn };
}

const gUser = (n = randomUUID().slice(0, 8)) => ({ sub: `g-${n}`, email: `${n}@gmail.test`, name: `G ${n}` });
const ghUser = (id = 1000 + Math.floor(Math.random() * 1e6), email = `gh${id}@example.test`) => ({ id, login: `octo${id}`, name: `Octo ${id}`, email });

test('methods: a provider is on only with both its client id and secret; unconfigured → METHOD_DISABLED', async () => {
  const c = fakeClients();
  const r = await rig({ clients: { googleClientId: c.googleClientId, googleClientSecret: c.googleClientSecret, githubClientId: c.githubClientId, githubClientSecret: null } });
  try {
    assert.deepEqual((await r.h.call('GET', '/api/auth/methods')).body, { google: true, github: false, email: false });
    const off = await r.start('github', { verifier: verifierOf() });
    assert.equal(off.status, 404);
    assert.equal(off.body.error.code, 'METHOD_DISABLED');
    const bad = await r.start('myspace', { verifier: verifierOf() });
    assert.equal(bad.body.error.code, 'VALIDATION');
  } finally {
    await r.h.close();
  }
});

test('Google: start mints state + nonce, the url asks for openid email profile with PKCE S256 and no offline access; exchange signs up and returns a device token', async () => {
  const r = await rig();
  try {
    const who = gUser('jo');
    const { s, a, ex } = await r.signIn('google', who);
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(Object.keys(s.body).sort(), ['expires_in', 'flow_id', 'state', 'url']);
    assert.equal(s.body.expires_in, 600);
    assert.equal(a.params.scope, 'openid email profile');
    assert.equal(a.params.prompt, 'select_account');
    assert.equal(a.params.code_challenge_method, 'S256');
    assert.equal(a.params.redirect_uri, REDIRECT);
    assert.equal(a.params.client_id, r.clients.googleClientId);
    assert.match(a.params.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.match(s.body.state, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(a.params.access_type, undefined, 'never offline access');
    assert.equal(ex.status, 200, ex.text);
    assert.deepEqual(Object.keys(ex.body).sort(), ['device_id', 'device_token', 'teams', 'user']);
    assert.match(ex.body.device_token, /^bdt_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(ex.body.user, { id: ex.body.user.id, display_name: 'G jo', email: 'jo@gmail.test', email_verified: true });
    const acct = await r.h.call('GET', '/api/account', { token: ex.body.device_token });
    assert.equal(acct.status, 200);
    const id = r.h.db.get("SELECT * FROM identities WHERE provider = 'google'");
    assert.equal(id.subject, 'g-jo');
    assert.ok(id.verified_at);
    // The token request carried the STORED redirect_uri and the verifier.
    const tokenReq = r.p.requests.find((q) => q.url.includes('oauth2.googleapis.com/token'));
    const form = new URLSearchParams(tokenReq.body);
    assert.equal(form.get('redirect_uri'), REDIRECT);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.ok(form.get('code_verifier'));
    // A second sign-in with the same Google account is the same user.
    const again = await r.signIn('google', { ...who, email: 'renamed@gmail.test' });
    assert.equal(again.ex.body.user.id, ex.body.user.id, 'keyed by sub, not email');
  } finally {
    await r.h.close();
  }
});

test('flow problems all answer the one generic INVALID_TOKEN, and each attempt burns the flow', async () => {
  const r = await rig();
  try {
    const users = r.h.db.get('SELECT COUNT(*) AS n FROM users').n;
    const unknown = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: randomBytes(18).toString('base64url'), code: 'c', state: randomBytes(32).toString('base64url'), code_verifier: verifierOf() } });
    assert.equal(unknown.body.error.code, 'INVALID_TOKEN', 'unknown flow');
    const cases = {
      'state mismatch': () => ({ state: randomBytes(32).toString('base64url') }),
      'verifier mismatch': () => ({ code_verifier: verifierOf() }),
      'redirect_uri differs from start': () => ({ redirect_uri: 'http://127.0.0.1:53683/callback' }),
      'provider differs': () => ({ provider: 'github' }),
    };
    for (const [name, over] of Object.entries(cases)) {
      const { ex, s, a, verifier } = await r.signIn('google', gUser(), { exchangeOver: over() });
      assert.equal(ex.status, 400, name);
      assert.equal(ex.body.error.code, 'INVALID_TOKEN', name);
      // The right answer afterwards is too late: the flow is gone.
      const retry = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: s.body.flow_id, code: a.code, state: a.state, code_verifier: verifier } });
      assert.equal(retry.body.error.code, 'INVALID_TOKEN', `${name}: burned`);
    }
    assert.equal(r.h.db.get('SELECT COUNT(*) AS n FROM users').n, users, 'nobody signed up');
    assert.ok(!r.p.requests.some((q) => q.url.includes('token')), 'the provider was never called');
    // Expired.
    const v = verifierOf();
    const s = await r.start('google', { verifier: v });
    const a = r.p.authorize(s.body.url, gUser());
    r.clock.advance(600_001);
    const late = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: s.body.flow_id, code: a.code, state: a.state, code_verifier: v } });
    assert.equal(late.body.error.code, 'INVALID_TOKEN', 'expired');
  } finally {
    await r.h.close();
  }
});

test('id_token checks: nonce, aud, iss, exp, iat, email_verified, signature, unknown kid', async () => {
  const r = await rig();
  try {
    const now = Math.floor(r.clock.wall() / 1000);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const cases = [
      ['nonce mismatch', { claims: { nonce: 'x'.repeat(43) } }, 'INVALID_TOKEN'],
      ['wrong aud', { claims: { aud: 'someone-else.apps.example' } }, 'INVALID_TOKEN'],
      ['wrong iss', { claims: { iss: 'https://accounts.evil.test' } }, 'INVALID_TOKEN'],
      ['expired', { claims: { exp: now - 61, iat: now - 3700 } }, 'INVALID_TOKEN'],
      ['not yet valid', { claims: { iat: now + 120, exp: now + 3700 } }, 'INVALID_TOKEN'],
      ['email_verified false', { claims: { email_verified: false } }, 'EMAIL_UNVERIFIED'],
      ['email_verified "true" (a string)', { claims: { email_verified: 'true' } }, 'EMAIL_UNVERIFIED'],
      ['bad signature', { sign: { privateKey: other.privateKey } }, 'INVALID_TOKEN'],
      ['unknown kid', { sign: { keyId: 'nope' } }, 'INVALID_TOKEN'],
      ['alg none', { sign: { alg: 'none' } }, 'INVALID_TOKEN'],
    ];
    for (const [name, over, code] of cases) {
      const { ex } = await r.signIn('google', gUser(), { providerOver: over });
      assert.equal(ex.body?.error?.code, code, `${name}: ${ex.text}`);
      assert.equal(ex.status, code === 'EMAIL_UNVERIFIED' ? 403 : 400, name);
    }
    // Within the 60 s skew is fine.
    const ok = await r.signIn('google', gUser(), { providerOver: { claims: { exp: now - 30 } } });
    assert.equal(ok.ex.status, 200, ok.ex.text);
    assert.equal(r.h.db.get("SELECT COUNT(*) AS n FROM identities WHERE provider = 'google'").n, 1, 'only the good one signed in');
  } finally {
    await r.h.close();
  }
});

test('JWKS outage → 503 PROVIDER_UNAVAILABLE and the flow is burned; the cache serves a known kid while the JWKS is down', async () => {
  const r = await rig();
  try {
    r.p.jwksDown = true;
    const { ex, s, a, verifier } = await r.signIn('google', gUser());
    assert.equal(ex.status, 503);
    assert.equal(ex.body.error.code, 'PROVIDER_UNAVAILABLE');
    const retry = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: s.body.flow_id, code: a.code, state: a.state, code_verifier: verifier } });
    assert.equal(retry.body.error.code, 'INVALID_TOKEN', 'burned');
    r.p.jwksDown = false;
    assert.equal((await r.signIn('google', gUser())).ex.status, 200, 'keys fetched and cached');
    r.p.jwksDown = true;
    const fetches = r.p.requests.filter((q) => q.url.includes('certs')).length;
    assert.equal((await r.signIn('google', gUser())).ex.status, 200, 'cached kid, JWKS down');
    assert.equal(r.p.requests.filter((q) => q.url.includes('certs')).length, fetches, 'no refetch within the TTL');
  } finally {
    await r.h.close();
  }
});

test('redirect_uri must be http://127.0.0.1:<1024–65535>/callback; code_challenge must be S256 base64url', async () => {
  const r = await rig();
  try {
    const bad = ['http://localhost:53682/callback', 'https://127.0.0.1:53682/callback', 'http://127.0.0.2:53682/callback', 'http://127.0.0.1:53682/cb',
      'http://127.0.0.1:53682/callback/', 'http://127.0.0.1:80/callback', 'http://127.0.0.1:1023/callback', 'http://127.0.0.1:70000/callback',
      'http://127.0.0.1/callback', 'http://127.0.0.1:53682/callback?x=1', 'http://evil.test@127.0.0.1:53682/callback', 'plexiform://callback', 42];
    for (const uri of bad) {
      const s = await r.start('google', { verifier: verifierOf(), body: { redirect_uri: uri } });
      assert.equal(s.status, 400, String(uri));
      assert.equal(s.body.error.code, 'VALIDATION', String(uri));
    }
    for (const uri of ['http://127.0.0.1:1024/callback', 'http://127.0.0.1:65535/callback']) assert.equal((await r.start('google', { verifier: verifierOf(), body: { redirect_uri: uri } })).status, 200, uri);
    for (const cc of ['short', 'x'.repeat(44), '+'.repeat(43), null]) assert.equal((await r.start('google', { verifier: verifierOf(), body: { code_challenge: cc } })).body.error.code, 'VALIDATION');
    assert.equal((await r.start('google', { verifier: verifierOf(), body: { client: 'web' } })).body.error.code, 'VALIDATION');
  } finally {
    await r.h.close();
  }
});

test('replay, code reuse, two concurrent exchanges of one flow (exactly one wins), provider 5xx burns the flow', async () => {
  const r = await rig();
  try {
    const first = await r.signIn('google', gUser());
    assert.equal(first.ex.status, 200);
    const replay = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: first.s.body.flow_id, code: first.a.code, state: first.a.state, code_verifier: first.verifier } });
    assert.equal(replay.body.error.code, 'INVALID_TOKEN', 'replay of a used flow');
    // The same code on a fresh flow: the provider refuses it → 502.
    const v = verifierOf();
    const s2 = await r.start('google', { verifier: v });
    const reuse = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: s2.body.flow_id, code: first.a.code, state: s2.body.state, code_verifier: v } });
    assert.equal(reuse.status, 502);
    assert.equal(reuse.body.error.code, 'PROVIDER_ERROR');

    // Concurrency: both requests reach the hub before the provider answers.
    const v3 = verifierOf();
    const s3 = await r.start('google', { verifier: v3 });
    const a3 = r.p.authorize(s3.body.url, gUser());
    let open;
    r.p.gate = new Promise((res) => { open = res; });
    const body = { flow_id: s3.body.flow_id, code: a3.code, state: a3.state, code_verifier: v3 };
    const both = Promise.all([r.h.call('POST', '/api/auth/oauth/exchange', { body }), r.h.call('POST', '/api/auth/oauth/exchange', { body })]);
    await new Promise((res) => setTimeout(res, 100));
    open();
    r.p.gate = null;
    const statuses = (await both).map((x) => x.status).sort();
    assert.deepEqual(statuses, [200, 400], 'exactly one exchange succeeds');

    r.p.tokenStatus = 500;
    const down = await r.signIn('github', ghUser());
    assert.equal(down.ex.status, 503);
    assert.equal(down.ex.body.error.code, 'PROVIDER_UNAVAILABLE');
    r.p.tokenStatus = null;
    const again = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: down.s.body.flow_id, code: down.a.code, state: down.a.state, code_verifier: down.verifier } });
    assert.equal(again.body.error.code, 'INVALID_TOKEN', 'a provider failure does not reopen the flow');
  } finally {
    await r.h.close();
  }
});

test('the exchange must come from the network that started the flow', async () => {
  const r = await rig();
  try {
    const v = verifierOf();
    const s = r.h.hub.oauth.start({ provider: 'google', code_challenge: s256(v), redirect_uri: REDIRECT }, { ip: '203.0.113.5' });
    const a = r.p.authorize(s.url, gUser());
    await assert.rejects(r.h.hub.oauth.exchange({ flow_id: s.flow_id, code: a.code, state: a.state, code_verifier: v }, { ip: '198.51.100.7' }), (e) => e.code === 'INVALID_TOKEN');
    const v2 = verifierOf();
    const s2 = r.h.hub.oauth.start({ provider: 'google', code_challenge: s256(v2), redirect_uri: REDIRECT }, { ip: '203.0.113.5' });
    const a2 = r.p.authorize(s2.url, gUser());
    const ok = await r.h.hub.oauth.exchange({ flow_id: s2.flow_id, code: a2.code, state: a2.state, code_verifier: v2 }, { ip: '203.0.113.77' });
    assert.ok(ok.device_token, 'same /24');
  } finally {
    await r.h.close();
  }
});

test('GitHub: primary+verified email only; login changes keep the identity; scopes and PKCE on the url', async () => {
  const r = await rig();
  try {
    const who = ghUser(424242, 'octo@example.test');
    const { a, ex } = await r.signIn('github', who);
    assert.equal(ex.status, 200, ex.text);
    assert.equal(a.params.scope, 'read:user user:email');
    assert.equal(a.params.allow_signup, 'true');
    assert.equal(a.params.code_challenge_method, 'S256');
    const again = await r.signIn('github', { ...who, login: 'renamed-octo' });
    assert.equal(again.ex.body.user.id, ex.body.user.id);
    assert.equal(r.h.db.get("SELECT login FROM identities WHERE provider = 'github' AND subject = '424242'").login, 'renamed-octo');
    const none = await r.signIn('github', { ...ghUser(), emails: [{ email: 'a@example.test', primary: true, verified: false }, { email: 'b@example.test', primary: false, verified: true }] });
    assert.equal(none.ex.status, 403);
    assert.equal(none.ex.body.error.code, 'EMAIL_UNVERIFIED');
    // The GitHub user token is sent only to api.github.com.
    for (const q of r.p.requests.filter((x) => x.headers.authorization)) assert.match(q.url, /^https:\/\/api\.github\.com\//);
  } finally {
    await r.h.close();
  }
});

test('linking: a verified email links across providers and to an email-code account; an unverified one never does; an admin-typed github_id never proves anything', async () => {
  const r = await rig();
  try {
    const g = await r.signIn('google', { sub: 'g-sam', email: 'sam@example.test', name: 'Sam' });
    const gh = await r.signIn('github', ghUser(5150, 'sam@example.test'));
    assert.equal(gh.ex.body.user.id, g.ex.body.user.id, 'linked by the verified address');
    assert.ok(r.h.db.get("SELECT 1 AS x FROM audit WHERE action = 'identity.link' AND actor_user_id = ?", g.ex.body.user.id));
    // A GitHub account whose verified primary is elsewhere, with Sam's address unverified: not Sam.
    const other = await r.signIn('github', { ...ghUser(6160), emails: [{ email: 'sam@example.test', primary: false, verified: false }, { email: 'mallory@example.test', primary: true, verified: true }] });
    assert.notEqual(other.ex.body.user.id, g.ex.body.user.id);
    // Migration 009's admin-typed GitHub id (email_verified 0, never proven).
    const now = r.h.hub.iso();
    r.h.db.insert('identities', { id: randomUUID(), user_id: g.ex.body.user.id, provider: 'github', subject: '777', login: 'typo', email_verified: 0, created_at: now });
    const imposter = await r.signIn('github', ghUser(777, 'someone-else@example.test'));
    assert.equal(imposter.ex.status, 200);
    assert.notEqual(imposter.ex.body.user.id, g.ex.body.user.id, 'the typed id never reaches Sam');
    const row = r.h.db.get("SELECT * FROM identities WHERE provider = 'github' AND subject = '777'");
    assert.equal(row.user_id, imposter.ex.body.user.id);
    assert.ok(row.verified_at);
  } finally {
    await r.h.close();
  }
});

test('first sign-in links the Access-era member rows (Callum, Tonde, James) to their team', async () => {
  const r = await rig();
  try {
    const org = r.h.ids.org;
    const now = r.h.hub.iso();
    const people = [['Callum', 'Callum@Example.test'], ['Tonde', 'tonde@example.test'], ['James', 'james@example.test']];
    for (const [name, email] of people) {
      r.h.db.insert('members', { id: randomUUID(), org_id: org, role: 'member', display_name: name, email, ...emailOnlyIdentity(email.toLowerCase()), created_at: now });
    }
    const results = [
      await r.signIn('google', { sub: 'g-callum', email: 'callum@example.test', name: 'Callum' }),
      await r.signIn('github', ghUser(9001, 'tonde@example.test')),
      await r.signIn('google', { sub: 'g-james', email: 'james@example.test', name: 'James' }),
    ];
    for (const x of results) {
      assert.equal(x.ex.status, 200, x.ex.text);
      assert.deepEqual(x.ex.body.teams.map((t) => t.id), [org]);
    }
  } finally {
    await r.h.close();
  }
});

test('delete step-up by OAuth: needs a Bearer, the same provider identity, from the same device; opens 5 minutes; deletes the account and a team with no mailer', async () => {
  const r = await rig();
  try {
    const me = await r.signIn('google', { sub: 'g-del', email: 'del@example.test', name: 'Del' });
    const token = me.ex.body.device_token;
    assert.equal((await r.start('google', { verifier: verifierOf(), body: { purpose: 'delete' } })).status, 401, 'no Bearer');
    // Another Google account cannot confirm: the generic 400 (never a 401, which would sign the app out).
    const wrong = await r.signIn('google', gUser(), { token, purpose: 'delete' });
    assert.equal(wrong.ex.status, 400);
    assert.equal(wrong.ex.body.error.code, 'INVALID_TOKEN');
    const wrongProvider = await r.signIn('github', ghUser(), { token, purpose: 'delete' });
    assert.deepEqual([wrongProvider.ex.status, wrongProvider.ex.body.error.code], [400, 'INVALID_TOKEN'], 'a provider the account never used: the same answer');
    assert.equal((await r.h.call('GET', '/api/account', { token })).status, 200, 'still signed in');
    assert.equal((await r.h.call('DELETE', '/api/account', { token, body: {} })).body.error.code, 'STEP_UP_REQUIRED');
    assert.equal(r.h.db.get("SELECT COUNT(*) AS n FROM identities WHERE provider = 'google'").n, 1, 'a failed step-up creates no account');
    // Team deletion with an OAuth step-up.
    const team = await r.h.call('POST', '/api/teams', { token, body: { name: 'Doomed' } });
    const step = await r.signIn('google', { sub: 'g-del', email: 'del@example.test' }, { token, purpose: 'delete' });
    assert.equal(step.ex.status, 200, step.ex.text);
    assert.deepEqual(Object.keys(step.ex.body), ['stepup_until'], 'exactly {stepup_until}: no device_token, user or teams');
    assert.match(step.ex.body.stepup_until, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(Date.parse(step.ex.body.stepup_until) - r.clock.wall(), 300_000);
    assert.equal(r.h.db.get('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ?', me.ex.body.user.id).n, 1, 'a step-up mints no device');
    // Another device of the same user cannot spend it.
    const other = await r.signIn('google', { sub: 'g-del', email: 'del@example.test' });
    const slug = team.body.team.slug;
    assert.equal((await r.h.call('DELETE', `/api/teams/${team.body.team.id}`, { token: other.ex.body.device_token, body: { confirm_slug: slug } })).body.error.code, 'STEP_UP_REQUIRED');
    const del = await r.h.call('DELETE', `/api/teams/${team.body.team.id}`, { token, body: { confirm_slug: slug, flow_id: step.s.body.flow_id } });
    assert.equal(del.status, 200, del.text);
    assert.equal((await r.h.call('DELETE', '/api/account', { token, body: {} })).body.error.code, 'STEP_UP_REQUIRED', 'spent: single use');
    // Expiry.
    const late = await r.signIn('google', { sub: 'g-del', email: 'del@example.test' }, { token, purpose: 'delete' });
    r.clock.advance(300_001);
    assert.equal((await r.h.call('DELETE', '/api/account', { token, body: { flow_id: late.s.body.flow_id } })).body.error.code, 'STEP_UP_REQUIRED', 'older than 5 minutes');
    // A delete that fails (the only owner of a team with members: 409) does not spend the step-up.
    const t2 = await r.h.call('POST', '/api/teams', { token, body: { name: 'Shared' } });
    const now = r.h.hub.iso();
    const mate = randomUUID();
    r.h.db.insert('members', { id: mate, org_id: t2.body.team.id, role: 'member', display_name: 'Mate', email: 'mate@example.test', ...emailOnlyIdentity('mate@example.test'), created_at: now });
    const fresh = await r.signIn('google', { sub: 'g-del', email: 'del@example.test' }, { token, purpose: 'delete' });
    const blocked = await r.h.call('DELETE', '/api/account', { token, body: { flow_id: fresh.s.body.flow_id } });
    assert.equal(blocked.status, 409, blocked.text);
    assert.equal(r.h.db.get('SELECT consumed_at FROM oauth_flows WHERE id = ?', fresh.s.body.flow_id).consumed_at, null, 'not spent');
    r.h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', now, mate);
    const gone = await r.h.call('DELETE', '/api/account', { token, body: { flow_id: fresh.s.body.flow_id } });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(r.h.db.get('SELECT COUNT(*) AS n FROM oauth_flows WHERE user_id = ?', me.ex.body.user.id).n, 0, 'no flows left behind');
    assert.equal((await r.h.call('GET', '/api/account', { token })).status, 401);
    // Signing in with that Google account again makes a new, empty account.
    const back = await r.signIn('google', { sub: 'g-del', email: 'del@example.test' });
    assert.notEqual(back.ex.body.user.id, me.ex.body.user.id);
    assert.deepEqual(back.ex.body.teams, []);
  } finally {
    await r.h.close();
  }
});

test('GET /api/account lists the proven sign-in providers by name only', async () => {
  const r = await rig({ mailer: outboxMailer() });
  try {
    const g = await r.signIn('google', { sub: 'g-ids', email: 'ids@example.test' });
    const token = g.ex.body.device_token;
    assert.deepEqual((await r.h.call('GET', '/api/account', { token })).body.identities, [{ provider: 'google' }]);
    await r.signIn('github', ghUser(8080, 'ids@example.test'));
    // An email code for the same address adds 'email'.
    await r.h.signIn('ids@example.test');
    const acct = await r.h.call('GET', '/api/account', { token });
    assert.deepEqual(acct.body.identities, [{ provider: 'email' }, { provider: 'github' }, { provider: 'google' }]);
    assert.ok(!JSON.stringify(acct.body.identities).includes('8080') && !JSON.stringify(acct.body.identities).includes('g-ids'));
    // Migration 009's unproven GitHub id is not listed.
    const u = await r.signIn('google', { sub: 'g-solo', email: 'solo@example.test' });
    r.h.db.insert('identities', { id: randomUUID(), user_id: u.ex.body.user.id, provider: 'github', subject: '999999', email_verified: 0, created_at: r.h.hub.iso() });
    assert.deepEqual((await r.h.call('GET', '/api/account', { token: u.ex.body.device_token })).body.identities, [{ provider: 'google' }]);
  } finally {
    await r.h.close();
  }
});

test('no provider token, code, state, verifier or id_token reaches the DB, the logs or the audit', async () => {
  const r = await rig();
  try {
    const runs = [await r.signIn('google', gUser('leak')), await r.signIn('github', ghUser(31337, 'leak2@example.test')), await r.signIn('google', gUser(), { providerOver: { claims: { aud: 'x' } } })];
    const secrets = [...r.p.issued, r.clients.googleClientSecret, r.clients.githubClientSecret];
    for (const x of runs) secrets.push(x.a.code, x.a.state, x.verifier);
    // Google's nonce is kept with its flow (it must match the id_token), never logged or audited.
    const nonces = runs.map((x) => x.a.params.nonce).filter(Boolean);
    assert.ok(secrets.length >= 12 && nonces.length === 2);
    const dump = dumpDb(r.h.db);
    const logs = r.logs.join('\n');
    const audit = JSON.stringify(r.h.db.all('SELECT * FROM audit'));
    for (const sec of secrets) {
      assert.ok(typeof sec === 'string' && sec.length >= 20);
      assert.ok(!dump.includes(sec), 'DB holds a provider secret');
      assert.ok(!logs.includes(sec), 'logs hold a provider secret');
      assert.ok(!audit.includes(sec), 'audit holds a provider secret');
    }
    for (const n of nonces) assert.ok(!logs.includes(n) && !audit.includes(n));
    // Audit rows carry a keyed hash of the subject, never the email before an account exists.
    assert.ok(!audit.includes('leak@gmail.test') && !audit.includes('g-leak'));
    assert.ok(r.h.db.get("SELECT 1 AS x FROM audit WHERE action = 'auth.signin' AND detail LIKE '%subject_ref%'"));
  } finally {
    await r.h.close();
  }
});

test('limits: 20 starts an hour per network, at most 5 open flows per network, 30 exchanges an hour, and a failure budget on mismatches', async () => {
  const r = await rig({ limits: {}, config: { authFailBudget: 3 } });
  try {
    const opened = [];
    for (let i = 0; i < 5; i++) opened.push(await r.start('google', { verifier: verifierOf() }));
    assert.ok(opened.every((x) => x.status === 200));
    const sixth = await r.start('google', { verifier: verifierOf() });
    assert.equal(sixth.status, 429, 'open-flow cap');
    assert.ok(Number(sixth.headers.get('retry-after')) > 0);
    // Mismatches spend the failure budget (3 here): then 429 even for a good exchange.
    for (let i = 0; i < 3; i++) {
      const x = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: opened[i].body.flow_id, code: 'c', state: randomBytes(32).toString('base64url'), code_verifier: verifierOf() } });
      assert.equal(x.body.error.code, 'INVALID_TOKEN');
    }
    const locked = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: opened[3].body.flow_id, code: 'c', state: opened[3].body.state, code_verifier: verifierOf() } });
    assert.equal(locked.status, 429);
    assert.equal(r.h.db.get('SELECT used FROM oauth_flows WHERE id = ?', opened[3].body.flow_id).used, 0, 'a locked exchange checks nothing and burns nothing');
    r.clock.advance(86_400_000 * 3);
    let n = 0;
    for (; n < 40; n++) {
      r.h.db.run('UPDATE oauth_flows SET used = 1');   // no open flows: only the hourly start bucket counts
      if ((await r.start('google', { verifier: verifierOf() })).status === 429) break;
    }
    assert.equal(n, 20, 'the 21st start in an hour is refused');
    assert.deepEqual(r.h.hub.limiter.limits.oauth_exchange_ip, { capacity: 30, per_ms: 3_600_000 });
  } finally {
    await r.h.close();
  }
});
