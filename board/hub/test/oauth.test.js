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
  async function signIn(provider, who, { token, purpose, teamId, providerOver = {}, exchangeOver = {} } = {}) {
    const verifier = verifierOf();
    const s = await start(provider, { verifier, body: { ...(purpose ? { purpose } : {}), ...(teamId ? { team_id: teamId } : {}) } }, { token });
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

test('D83 linking: only an authoritative Google account (hd = the domain, or gmail.com) joins an existing account by address; GitHub and other Google never do', async () => {
  const r = await rig({ mailer: outboxMailer() });
  try {
    const owner = async (email) => (await r.h.signIn(email)).body;   // an email-code account
    // gmail.com: Google runs the mailbox → links.
    const sam = await owner('sam@gmail.com');
    const g = await r.signIn('google', { sub: 'g-sam', email: 'sam@gmail.com', name: 'Sam' });
    assert.equal(g.ex.body.user.id, sam.user.id, 'gmail links');
    assert.ok(r.h.db.get("SELECT 1 AS x FROM audit WHERE action = 'identity.link' AND actor_user_id = ?", sam.user.id));
    // A Workspace account whose hd is the address's domain → links.
    const pat = await owner('pat@corp.test');
    const hd = await r.signIn('google', { sub: 'g-pat', email: 'pat@corp.test', hd: 'corp.test' });
    assert.equal(hd.ex.body.user.id, pat.user.id, 'hd links');
    // A Google account for a non-Gmail address without a matching hd (a recycled or consumer address): a separate account.
    const lee = await owner('lee@corp.test');
    const weak = await r.signIn('google', { sub: 'g-lee', email: 'lee@corp.test' });
    const wrongHd = await r.signIn('google', { sub: 'g-lee2', email: 'lee@corp.test', hd: 'other.test' });
    for (const x of [weak, wrongHd]) {
      assert.equal(x.ex.status, 200, x.ex.text);
      assert.notEqual(x.ex.body.user.id, lee.user.id, 'no link');
      assert.equal(x.ex.body.user.email, null, 'the address stays with the account that proved it');
    }
    // GitHub never links, even with a primary+verified address.
    const gh = await r.signIn('github', ghUser(5150, 'sam@gmail.com'));
    assert.notEqual(gh.ex.body.user.id, sam.user.id);
    assert.equal(gh.ex.body.user.email, null);
    // A GitHub account whose primary is elsewhere, with Sam's address unverified: not Sam either.
    const other = await r.signIn('github', { ...ghUser(6160), emails: [{ email: 'sam@gmail.com', primary: false, verified: false }, { email: 'mallory@example.test', primary: true, verified: true }] });
    assert.notEqual(other.ex.body.user.id, sam.user.id);
    // Migration 009's admin-typed GitHub id (email_verified 0, never proven).
    const now = r.h.hub.iso();
    r.h.db.insert('identities', { id: randomUUID(), user_id: sam.user.id, provider: 'github', subject: '777', login: 'typo', email_verified: 0, created_at: now });
    const imposter = await r.signIn('github', ghUser(777, 'someone-else@example.test'));
    assert.equal(imposter.ex.status, 200);
    assert.notEqual(imposter.ex.body.user.id, sam.user.id, 'the typed id never reaches Sam');
    const row = r.h.db.get("SELECT * FROM identities WHERE provider = 'github' AND subject = '777'");
    assert.equal(row.user_id, imposter.ex.body.user.id);
    assert.ok(row.verified_at);
  } finally {
    await r.h.close();
  }
});

test('D83 takeover: an attacker\'s Google account on a recycled non-Gmail address, or a GitHub account claiming it, never reaches the victim\'s account or teams', async () => {
  const r = await rig({ mailer: outboxMailer() });
  try {
    const victim = (await r.h.signIn('alice@corp.test')).body;
    const team = await r.h.call('POST', '/api/teams', { token: victim.device_token, body: { name: 'Victim Co' } });
    assert.equal(team.status, 200, team.text);
    for (const [label, x] of [
      ['google', await r.signIn('google', { sub: 'g-mallory', email: 'alice@corp.test', name: 'Alice' })],
      ['github', await r.signIn('github', ghUser(4040, 'alice@corp.test'))],
    ]) {
      assert.equal(x.ex.status, 200, x.ex.text);
      assert.notEqual(x.ex.body.user.id, victim.user.id, label);
      assert.deepEqual(x.ex.body.teams, [], `${label}: none of the victim's teams`);
      assert.equal((await r.h.call('GET', `/api/teams/${team.body.team.id}`, { token: x.ex.body.device_token })).status, 404);
    }
    const v = r.h.db.get('SELECT * FROM users WHERE id = ?', victim.user.id);
    assert.equal(v.primary_email, 'alice@corp.test', 'the victim keeps the address');
    assert.deepEqual(r.h.db.all('SELECT provider FROM identities WHERE user_id = ? ORDER BY provider', victim.user.id).map((x) => x.provider), ['email']);
    // The other way round: a GitHub account that took an address first yields it to an email code (a separate account).
    const early = await r.signIn('github', ghUser(5050, 'bob@corp.test'));
    assert.equal(early.ex.body.user.email, 'bob@corp.test');
    const bob = (await r.h.signIn('bob@corp.test')).body;
    assert.notEqual(bob.user.id, early.ex.body.user.id, 'the email code never joins the GitHub-made account');
    assert.equal(bob.user.email, 'bob@corp.test');
    assert.equal(r.h.db.get('SELECT primary_email FROM users WHERE id = ?', early.ex.body.user.id).primary_email, null, 'released');
  } finally {
    await r.h.close();
  }
});

test('D83 invites: a GitHub primary+verified address may accept an invite addressed to it; a non-authoritative Google address may not', async () => {
  const r = await rig({ mailer: outboxMailer() });
  try {
    const admin = (await r.h.signIn('admin@corp.test')).body;
    const team = (await r.h.call('POST', '/api/teams', { token: admin.device_token, body: { name: 'Invites Co' } })).body.team;
    const invite = async (email) => (await r.h.call('POST', `/api/teams/${team.id}/invites`, { token: admin.device_token, body: { email, role: 'member' } })).body;
    const i1 = await invite('octo@elsewhere.test');
    const gh = await r.signIn('github', ghUser(6060, 'octo@elsewhere.test'));
    const pending = (await r.h.call('GET', '/api/account', { token: gh.ex.body.device_token })).body.pending_invites;
    assert.deepEqual(pending.map((x) => x.id), [i1.invite.id]);
    const ok = await r.h.call('POST', '/api/invites/accept', { token: gh.ex.body.device_token, body: { invite_id: i1.invite.id } });
    assert.equal(ok.status, 200, ok.text);
    const i2 = await invite('kim@elsewhere.test');
    const weak = await r.signIn('google', { sub: 'g-kim', email: 'kim@elsewhere.test' });
    assert.deepEqual((await r.h.call('GET', '/api/account', { token: weak.ex.body.device_token })).body.pending_invites, []);
    const no = await r.h.call('POST', '/api/invites/accept', { token: weak.ex.body.device_token, body: { invite_id: i2.invite.id } });
    assert.equal(no.body.error.code, 'INVALID_TOKEN');
    assert.equal((await r.h.call('POST', '/api/invites/accept', { token: weak.ex.body.device_token, body: { t: i2.link.split('#')[1] } })).body.error.code, 'WRONG_ACCOUNT');
    // The same address through Workspace (hd) does accept.
    const strong = await r.signIn('google', { sub: 'g-kim-ws', email: 'kim@elsewhere.test', hd: 'elsewhere.test' });
    assert.equal((await r.h.call('POST', '/api/invites/accept', { token: strong.ex.body.device_token, body: { invite_id: i2.invite.id } })).status, 200);
  } finally {
    await r.h.close();
  }
});

test('D83: an authoritative first sign-in links the Access-era member rows (Callum, Tonde, James); GitHub and non-authoritative Google never do', async () => {
  const r = await rig({ mailer: outboxMailer() });
  try {
    const org = r.h.ids.org;
    const now = r.h.hub.iso();
    const people = [['Callum', 'Callum@Gmail.com'], ['Tonde', 'tonde@example.test'], ['James', 'james@example.test'], ['Ivy', 'ivy@example.test']];
    for (const [name, email] of people) {
      r.h.db.insert('members', { id: randomUUID(), org_id: org, role: 'member', display_name: name, email, ...emailOnlyIdentity(email.toLowerCase()), created_at: now });
    }
    const linked = [
      await r.signIn('google', { sub: 'g-callum', email: 'callum@gmail.com', name: 'Callum' }),
      await r.signIn('google', { sub: 'g-james', email: 'james@example.test', name: 'James', hd: 'example.test' }),
    ];
    for (const x of linked) {
      assert.equal(x.ex.status, 200, x.ex.text);
      assert.deepEqual(x.ex.body.teams.map((t) => t.id), [org]);
    }
    const github = await r.signIn('github', ghUser(9001, 'tonde@example.test'));
    const weak = await r.signIn('google', { sub: 'g-ivy', email: 'ivy@example.test' });
    for (const x of [github, weak]) assert.deepEqual(x.ex.body.teams, [], 'no member row joins');
    // Tonde's row joins once the address is proven by a code.
    assert.deepEqual((await r.h.signIn('tonde@example.test')).body.teams.map((t) => t.id), [org]);
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
    // Team deletion with an OAuth step-up, bound to that team (L6).
    const team = await r.h.call('POST', '/api/teams', { token, body: { name: 'Doomed' } });
    const keep = await r.h.call('POST', '/api/teams', { token, body: { name: 'Keep' } });
    assert.equal((await r.start('google', { verifier: verifierOf(), body: { purpose: 'delete_team' } }, { token })).body.error.code, 'VALIDATION', 'delete_team names its team');
    const unbound = await r.signIn('google', { sub: 'g-del', email: 'del@example.test' }, { token, purpose: 'delete' });
    assert.equal((await r.h.call('DELETE', `/api/teams/${team.body.team.id}`, { token, body: { confirm_slug: team.body.team.slug, flow_id: unbound.s.body.flow_id } })).body.error.code, 'STEP_UP_REQUIRED', 'an account step-up deletes no team');
    r.h.db.run('UPDATE oauth_flows SET consumed_at = ? WHERE id = ?', r.h.hub.iso(), unbound.s.body.flow_id);
    const step = await r.signIn('google', { sub: 'g-del', email: 'del@example.test' }, { token, purpose: 'delete_team', teamId: team.body.team.id });
    assert.equal((await r.h.call('DELETE', `/api/teams/${keep.body.team.id}`, { token, body: { confirm_slug: keep.body.team.slug, flow_id: step.s.body.flow_id } })).body.error.code, 'STEP_UP_REQUIRED', 'bound to the other team');
    assert.equal((await r.h.call('DELETE', '/api/account', { token, body: { flow_id: step.s.body.flow_id } })).body.error.code, 'STEP_UP_REQUIRED', 'a team step-up never deletes the account');
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
    const t2 = keep;
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
    const g = await r.signIn('google', { sub: 'g-ids', email: 'ids@gmail.com' });
    const token = g.ex.body.device_token;
    assert.deepEqual((await r.h.call('GET', '/api/account', { token })).body.identities, [{ provider: 'google' }]);
    const gh = await r.signIn('github', ghUser(8080, 'ids@gmail.com'));
    assert.notEqual(gh.ex.body.user.id, g.ex.body.user.id, 'GitHub is a separate account (D83)');
    // An email code for the same address (Gmail: authoritative holder) adds 'email'.
    await r.h.signIn('ids@gmail.com');
    const acct = await r.h.call('GET', '/api/account', { token });
    assert.deepEqual(acct.body.identities, [{ provider: 'email' }, { provider: 'google' }]);
    assert.ok(!JSON.stringify(acct.body.identities).includes('g-ids'));
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

test('limits: 20 starts an hour per /64, at most 10 open flows per client address, 30 exchanges an hour; no lockout from junk exchanges (M1, M2)', async () => {
  const r = await rig({ limits: {} });
  try {
    const opened = [];
    for (let i = 0; i < 10; i++) opened.push(await r.start('google', { verifier: verifierOf() }));
    assert.ok(opened.every((x) => x.status === 200));
    const eleventh = await r.start('google', { verifier: verifierOf() });
    assert.equal(eleventh.status, 429, 'open-flow cap');
    assert.ok(Number(eleventh.headers.get('retry-after')) > 0);
    // Another client in the same /24 has its own cap (the /24 is only the start-vs-exchange check).
    const v = verifierOf();
    assert.ok(r.h.hub.oauth.start({ provider: 'google', code_challenge: s256(v), redirect_uri: REDIRECT }, { ip: '127.0.0.9' }).flow_id);
    // 25 junk exchanges (unknown flows, wrong state): no lockout, a real exchange still works.
    for (let i = 0; i < 25; i++) {
      const x = await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: `junk${i}`, code: 'c', state: randomBytes(32).toString('base64url'), code_verifier: verifierOf() } });
      assert.equal(x.body.error.code, 'INVALID_TOKEN');
    }
    r.h.db.run('UPDATE oauth_flows SET used = 1');
    const good = await r.signIn('google', gUser());
    assert.equal(good.ex.status, 200, good.ex.text);
    // 26 exchanges so far; the 31st in the hour is refused (the only exchange bound).
    let n = 27;
    for (; n < 40; n++) {
      if ((await r.h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: 'x', code: 'c', state: 's', code_verifier: 'v' } })).status === 429) break;
    }
    assert.equal(n, 31, 'the 31st exchange in an hour is refused');
    r.clock.advance(3_600_000);
    let m = 0;
    for (; m < 40; m++) {
      r.h.db.run('UPDATE oauth_flows SET used = 1');   // no open flows: only the hourly start bucket counts
      if ((await r.start('google', { verifier: verifierOf() })).status === 429) break;
    }
    assert.equal(m, 20, 'the 21st start in an hour is refused');
  } finally {
    await r.h.close();
  }
});

test('M4: the reaper deletes flows a day past expiry (not an open step-up window); a sign-in flow belongs to its account, so erasure deletes it', async () => {
  const r = await rig();
  try {
    const signed = await r.signIn('google', gUser());
    assert.equal(r.h.db.get('SELECT user_id FROM oauth_flows WHERE id = ?', signed.s.body.flow_id).user_id, signed.ex.body.user.id);
    const stale = await r.start('google', { verifier: verifierOf() });
    r.clock.advance(86_400_000 + 600_001);
    const fresh = await r.start('google', { verifier: verifierOf() });
    await r.h.hub.tick();
    const left = r.h.db.all('SELECT id FROM oauth_flows').map((x) => x.id);
    assert.ok(!left.includes(stale.body.flow_id) && !left.includes(signed.s.body.flow_id), 'expired a day ago: gone');
    assert.ok(left.includes(fresh.body.flow_id));
  } finally {
    await r.h.close();
  }
});

test('L2-L5: multiple audiences need azp = us; redirects are refused and bodies capped; non-ASCII addresses refused, NFKC compared; control characters stripped from device names', async () => {
  const r = await rig();
  try {
    const multi = await r.signIn('google', gUser(), { providerOver: { claims: { aud: ['other-client', r.clients.googleClientId] } } });
    assert.equal(multi.ex.body.error.code, 'INVALID_TOKEN', 'two audiences, no azp');
    const azp = await r.signIn('google', gUser(), { providerOver: { claims: { aud: ['other-client', r.clients.googleClientId], azp: r.clients.googleClientId } } });
    assert.equal(azp.ex.status, 200, 'azp is us');
    for (const q of r.p.requests) assert.equal(q.redirect, 'error', 'no provider redirect is followed');
    r.p.bigBody = true;
    const big = await r.signIn('github', ghUser());
    assert.equal(big.ex.body.error.code, 'PROVIDER_ERROR', 'a 64 KB+ answer is not read');
    r.p.bigBody = false;
    const uni = await r.signIn('google', { sub: 'g-uni', email: 'jöe@gmail.com' });
    assert.equal(uni.ex.body.error.code, 'INVALID_TOKEN', 'non-ASCII address');
    const nfkc = await r.signIn('google', { sub: 'g-nfkc', email: 'ｆｕｌｌ@gmail.com' });
    assert.equal(nfkc.ex.status, 200, nfkc.ex.text);
    assert.equal(nfkc.ex.body.user.email, 'full@gmail.com', 'NFKC folds full-width letters');
    const s = await r.start('google', { verifier: verifierOf(), body: { device_name: 'Jo‮\u0007 laptop', platform: 'darwin\u0000' } });
    const row = r.h.db.get('SELECT device_name, platform FROM oauth_flows WHERE id = ?', s.body.flow_id);
    assert.deepEqual({ ...row }, { device_name: 'Jo laptop', platform: 'darwin' });
  } finally {
    await r.h.close();
  }
});
