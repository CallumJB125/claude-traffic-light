// Sign-up control (CONTRACT D104, ACCOUNTS-API.md "Sign-up control"):
// BOARD_SIGNUP=open|allowlist and BOARD_SIGNUP_ALLOW, through the real routes
// (email code, Google, GitHub, invites) against the accounts rig.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { startAccounts, dumpDb } from './accounts-helpers.js';
import { fakeClients, fakeProviders, s256 } from './fake-oauth.js';
import { fakeClock, testConfig } from './helpers.js';
import { createLogger } from '../log.js';
import { outboxMailer } from '../identity/mailer.js';
import { loadConfig, validateConfig, signupPolicy } from '../config.js';

const REDIRECT = 'http://127.0.0.1:53682/callback';
const CLOSED_TEXT = 'Sign-up is invite-only right now. Ask a team owner for an invite.';
const ROOMY = Object.fromEntries(['oauth_start_ip', 'oauth_exchange_ip', 'signup_ip', 'mutate_ip', 'login_ip', 'mutate_member', 'auth_start_ip', 'auth_verify_ip',
  'invite_ip', 'invite_user', 'invite_team', 'invite_accept_ip', 'invite_accept_user'].map((k) => [k, { capacity: 10_000, per_ms: 60_000 }]));
// Spacing, case and an empty entry on purpose: the list takes the stored-address normalisation.
const ALLOW = ' DOMAIN:Allowed.Test , email:Pat@Elsewhere.TEST ,, domain:sub.partner.test';
const LISTED = ['allowed.test', 'elsewhere.test', 'partner.test'];
const verifierOf = () => randomBytes(32).toString('base64url');

async function rig({ signup = 'allowlist', allow = ALLOW, mailer = outboxMailer(), limits = ROOMY } = {}) {
  const clock = fakeClock();
  const clients = fakeClients();
  const p = fakeProviders({ clock, clients });
  const logs = [];
  const log = createLogger({ level: 'debug', sink: (l) => logs.push(l), clock: clock.wall });
  const h = await startAccounts({ clock, mailer, fetchImpl: p.fetch, log, config: { ...clients, rateLimits: limits, signup, signupAllow: allow } });
  const start = (email, extra = {}) => h.call('POST', '/api/auth/email/start', { body: { email, client: 'buddy_desktop', device_name: 'Mac', platform: 'darwin-arm64', ...extra } });
  const verify = (flowId, code) => h.call('POST', '/api/auth/email/verify', { body: { flow_id: flowId, code, form_factor: 'laptop' } });
  async function emailSignIn(email) {
    const before = mailer.sent?.length ?? 0;
    const s = await start(email);
    const mailed = (mailer.sent?.length ?? 0) > before;
    const code = mailed ? h.codeFor(mailer.sent.at(-1).to) : '000000';
    const v = await verify(s.body.flow_id, code);
    return { s, v, mailed };
  }
  async function oauth(provider, who) {
    const verifier = verifierOf();
    const s = await h.call('POST', '/api/auth/oauth/start', { body: { provider, code_challenge: s256(verifier), redirect_uri: REDIRECT, device_name: 'Mac', platform: 'darwin-arm64', client: 'buddy_desktop' } });
    assert.equal(s.status, 200, s.text);
    const a = p.authorize(s.body.url, who);
    return h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: s.body.flow_id, code: a.code, state: a.state, code_verifier: verifier, form_factor: 'laptop' } });
  }
  const setPolicy = (signupMode, list) => { h.hub.accounts.signup = signupPolicy({ signup: signupMode, signupAllow: list }); };
  const users = () => h.db.get('SELECT COUNT(*) AS n FROM users').n;
  const userBy = (email) => h.db.get('SELECT * FROM users WHERE primary_email = ? AND deleted_at IS NULL', email);
  return { h, p, logs, mailer, start, verify, emailSignIn, oauth, setPolicy, users, userBy };
}

const base = (over = {}) => ({ ...testConfig({ auth: 'accounts', devLoginSecret: null, accountsDev: true }), ...over });

test('boot: allowlist is the accounts default; bad modes and entries refuse to start with fixed texts that never repeat the list', () => {
  assert.equal(signupPolicy(base()).mode, 'allowlist', 'the default');
  assert.doesNotThrow(() => validateConfig(base({ signup: 'allowlist', signupAllow: '' })), 'an empty allowlist is invite-only, and allowed');
  assert.doesNotThrow(() => validateConfig(base({ signup: 'open' })));
  const pol = signupPolicy(base({ signupAllow: ALLOW }));
  assert.deepEqual([...pol.domains].sort(), ['allowed.test', 'sub.partner.test']);
  assert.deepEqual([...pol.emails], ['pat@elsewhere.test']);
  const priv = `zz${randomBytes(4).toString('hex')}`;
  const cases = [
    [{ signup: 'invite' }, /^BOARD_SIGNUP takes open or allowlist$/],
    [{ signupAllow: `${priv}.test` }, /entries are domain:<domain> or email:<address>/],
    [{ signupAllow: `domains:${priv}.test` }, /entries are domain:<domain> or email:<address>/],
    [{ signupAllow: `domain:*.${priv}.test` }, /domain: entry that is not a domain name/],
    [{ signupAllow: `domain:.${priv}.test` }, /domain: entry that is not a domain name/],
    [{ signupAllow: `domain:${priv}` }, /domain: entry that is not a domain name/],
    [{ signupAllow: `domain:@${priv}.test` }, /domain: entry that is not a domain name/],
    [{ signupAllow: `domain:${priv}.test/x` }, /domain: entry that is not a domain name/],
    [{ signupAllow: `domain:${priv}.tést` }, /domain: entry that is not a domain name/],
    [{ signupAllow: `email:${priv}` }, /email: entry that is not an address/],
    [{ signupAllow: `email:"a b"@${priv}.test` }, /email: entry that is not an address/],
    [{ signupAllow: `email:@${priv}.test` }, /email: entry that is not an address/],
    [{ signupAllow: Array.from({ length: 257 }, (_, i) => `domain:d${i}${priv}.test`).join(',') }, /too long/],
    [{ signupAllow: `domain:${priv}.${'a'.repeat(8200)}.test` }, /too long/],
  ];
  for (const [over, re] of cases) {
    assert.throws(() => validateConfig(base(over)), (e) => re.test(e.message) && !e.message.includes(priv), JSON.stringify(over).slice(0, 60));
  }
  // No effect outside accounts mode.
  assert.doesNotThrow(() => validateConfig(testConfig({ auth: 'dev', signup: 'bogus', signupAllow: 'nonsense' })));
  // From the environment: the list never shows in a dump of the config.
  const env = { BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_ACCOUNTS_DEV: '1', BOARD_SIGNUP_ALLOW: `domain:${priv}.test, email:x@${priv}.test` };
  const c = loadConfig({ ...env });
  assert.equal(signupPolicy(c).mode, 'allowlist');
  assert.ok(signupPolicy(c).domains.has(`${priv}.test`) && signupPolicy(c).emails.has(`x@${priv}.test`));
  assert.ok(!JSON.stringify(c).includes(priv) && !inspect(c).includes(priv) && !Object.keys(c).includes('signupAllow'));
  assert.equal(loadConfig({ ...env, BOARD_SIGNUP: 'open' }).signup, 'open');
  assert.throws(() => loadConfig({ ...env, BOARD_SIGNUP: 'closed' }), /^Error: BOARD_SIGNUP takes open or allowlist$/);
  assert.throws(() => loadConfig({ ...env, BOARD_SIGNUP_ALLOW: `${priv}` }), (e) => !e.message.includes(priv));
});

test('boot: an empty allowlist logs one warn line naming the mode only; a list or open mode logs none', async () => {
  for (const [signup, allow, n] of [['allowlist', '', 1], ['allowlist', ALLOW, 0], ['open', '', 0]]) {
    const r = await rig({ signup, allow });
    try {
      const warns = r.logs.map((l) => JSON.parse(l)).filter((l) => l.level === 'warn' && /sign-?up/i.test(l.msg));
      assert.equal(warns.length, n, `${signup} "${allow}"`);
      if (n) assert.match(warns[0].msg, /invite-only/);
      for (const d of LISTED) assert.ok(!r.logs.join('\n').includes(d), 'never the list');
    } finally { await r.h.close(); }
  }
});

test('email: an allowlisted domain or address signs up by code (case and spacing folded); a sub-domain only with its own entry', async () => {
  const r = await rig();
  try {
    for (const email of ['New.Person@ALLOWED.test', ' pat@elsewhere.test ', 'x@sub.partner.test']) {
      const { s, v, mailed } = await r.emailSignIn(email);
      assert.equal(s.status, 200, s.text);
      assert.ok(mailed, `${email} is mailed`);
      assert.equal(v.status, 200, `${email}: ${v.text}`);
      assert.ok(r.userBy(email.trim().toLowerCase()), 'the account exists');
    }
  } finally { await r.h.close(); }
});

test('email: a non-allowed new address gets the same 200, no mail and a dud flow; suffix tricks and look-alikes are refused', async () => {
  const r = await rig();
  try {
    const ok = await r.start('fine@allowed.test');
    const users = r.users();
    for (const email of ['a@evilallowed.test', 'a@allowed.test.evil.test', 'a@x.allowed.test', 'a@partner.test', 'a@allowed.test.', 'pat+x@elsewhere.test', 'pat@elsewhere.test.evil', 'nobody@nope.test']) {
      const sent = r.mailer.sent.length;
      const s = await r.start(email);
      assert.equal(s.status, ok.status, email);
      assert.deepEqual(Object.keys(s.body).sort(), Object.keys(ok.body).sort());
      assert.equal(s.body.expires_in, ok.body.expires_in);
      assert.equal(r.mailer.sent.length, sent, `${email}: no mail`);
      const row = r.h.db.get('SELECT * FROM login_flows WHERE id = ?', s.body.flow_id);
      assert.ok(row && row.code_hash.startsWith('dud:'), `${email}: a dud flow`);
      const v = await r.verify(s.body.flow_id, '123456');
      assert.equal(v.status, 400);
      assert.equal(v.body.error.code, 'INVALID_TOKEN');
      assert.equal(v.body.error.attempts_left, 4, 'counts down like a real flow');
      for (const d of LISTED) assert.ok(!s.text.includes(d) && !v.text.includes(d), 'the answer never carries the list');
    }
    assert.equal(r.users(), users, 'no account was made');
  } finally { await r.h.close(); }
});

test('email: refused starts spend no mail budget and never count as mail failures', async () => {
  const limits = { ...ROOMY, mail_global_new: { capacity: 2, per_ms: 86_400_000 }, auth_start_email_all: { capacity: 10_000, per_ms: 60_000 } };
  const r = await rig({ limits });
  try {
    for (let i = 0; i < 5; i++) await r.start(`n${i}@nope.test`);
    const sent = r.mailer.sent.length;
    await r.start('first@allowed.test');
    assert.equal(r.mailer.sent.length, sent + 1, 'the half-cap for new addresses is still there for an allowed one');
  } finally { await r.h.close(); }

  let calls = 0;
  const failing = { kind: 'ses', async send() { calls++; throw new Error('SES answered 403 (AccessDenied)'); } };
  const f = await rig({ mailer: failing });
  try {
    for (let i = 0; i < 7; i++) await f.start(`m${i}@nope.test`);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(calls, 0, 'nothing was sent');
    assert.equal(f.h.hub.accounts.mailFailures, 0);
    assert.equal((await f.h.call('GET', '/api/auth/methods')).body.email, true, 'email stays offered');
    assert.equal((await f.h.call('GET', '/api/health')).body.mail.failing, false);
  } finally { await f.h.close(); }
});

test('email: allowed at start, not at verify (the list changed): the account is not made, the fixed text, and the flow is spent', async () => {
  const r = await rig();
  try {
    const s = await r.start('late@allowed.test');
    const code = r.h.codeFor('late@allowed.test');
    assert.ok(code);
    r.setPolicy('allowlist', 'domain:other.test');
    const v = await r.verify(s.body.flow_id, code);
    assert.equal(v.status, 403, v.text);
    assert.deepEqual(v.body.error, { code: 'SIGNUP_CLOSED', message: CLOSED_TEXT });
    assert.ok(!r.userBy('late@allowed.test'));
    const again = await r.verify(s.body.flow_id, code);
    assert.equal(again.body.error.code, 'INVALID_TOKEN', 'the flow is spent');
    assert.ok(r.h.db.get("SELECT 1 AS x FROM audit WHERE action = 'auth.signup.refused'"));
  } finally { await r.h.close(); }
});

test('Google: an allowlisted Workspace address signs up; a non-allowed one gets SIGNUP_CLOSED and no account; a non-authoritative address never counts', async () => {
  const r = await rig();
  try {
    const ok = await r.oauth('google', { sub: 'g-1', email: 'Ann@Allowed.test', name: 'Ann', hd: 'allowed.test' });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(r.userBy('ann@allowed.test'));
    const n = r.users();
    const ids = r.h.db.get('SELECT COUNT(*) AS n FROM identities').n;
    for (const who of [
      { sub: 'g-2', email: 'someone@gmail.com', name: 'S' },
      { sub: 'g-3', email: 'weak@allowed.test', name: 'W' },
      { sub: 'g-4', email: 'a@evilallowed.test', name: 'E', hd: 'evilallowed.test' },
    ]) {
      const ex = await r.oauth('google', who);
      assert.equal(ex.status, 403, `${who.email}: ${ex.text}`);
      assert.deepEqual(ex.body.error, { code: 'SIGNUP_CLOSED', message: CLOSED_TEXT });
      for (const d of LISTED) assert.ok(!ex.text.includes(d));
    }
    assert.equal(r.users(), n, 'no account');
    assert.equal(r.h.db.get('SELECT COUNT(*) AS n FROM identities').n, ids, 'no identity');
    assert.equal(r.h.db.get('SELECT COUNT(*) AS n FROM user_devices').n, 1, 'no device token');
  } finally { await r.h.close(); }
});

test('GitHub: a verified primary an email: entry lists signs up; a domain: entry never admits one; a non-allowed one is refused; an unverified or non-primary allowlisted address never counts', async () => {
  const r = await rig();
  try {
    const ok = await r.oauth('github', { id: 501, login: 'octo501', name: 'Octo', email: 'Pat@Elsewhere.test' });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(r.h.db.get("SELECT 1 AS x FROM identities WHERE provider = 'github' AND subject = '501'"));
    assert.equal(r.h.db.get("SELECT u.signup_via FROM users u JOIN identities i ON i.user_id = u.id WHERE i.provider = 'github' AND i.subject = '501'").signup_via, 'allowlist');
    const n = r.users();
    for (const who of [
      // GitHub's verified primary may be years old (a mailbox at a former employer): domain: entries are for code and Google only.
      { id: 506, login: 'o506', email: 'octo@allowed.test' },
      { id: 507, login: 'o507', email: 'x@sub.partner.test' },
      { id: 502, login: 'o502', email: 'o502@nope.test' },
      { id: 503, login: 'o503', emails: [{ email: 'u@allowed.test', primary: false, verified: false }, { email: 'u@nope.test', primary: true, verified: true }] },
      { id: 504, login: 'o504', emails: [{ email: 'v@allowed.test', primary: false, verified: true }, { email: 'v@nope.test', primary: true, verified: true }] },
    ]) {
      const ex = await r.oauth('github', who);
      assert.equal(ex.status, 403, ex.text);
      assert.equal(ex.body.error.code, 'SIGNUP_CLOSED');
      assert.equal(ex.body.error.message, CLOSED_TEXT);
    }
    const unverified = await r.oauth('github', { id: 505, login: 'o505', emails: [{ email: 'w@allowed.test', primary: true, verified: false }] });
    assert.equal(unverified.body.error.code, 'EMAIL_UNVERIFIED', 'never an unverified address');
    assert.equal(r.users(), n);
    assert.equal(r.h.db.get("SELECT COUNT(*) AS n FROM identities WHERE provider = 'github'").n, 1);
    // The same domain still admits an email code and an authoritative Google account.
    const code = await r.emailSignIn('octo@allowed.test');
    assert.equal(code.v.status, 200, code.v.text);
    const g = await r.oauth('google', { sub: 'g-dom', email: 'gdom@allowed.test', name: 'G', hd: 'allowed.test' });
    assert.equal(g.status, 200, g.text);
  } finally { await r.h.close(); }
});

test('invites: a non-allowlisted newcomer with a pending invite signs up (email code or GitHub) and joins; a withdrawn invite is no pass', async () => {
  const r = await rig({ allow: '' });
  try {
    // alice@dev.local has an unlinked member row (like BOARD_BOOTSTRAP's owner): that counts as her invite.
    const alice = await r.emailSignIn('alice@dev.local');
    assert.equal(alice.v.status, 200, alice.v.text);
    const tok = alice.v.body.device_token;
    const inv = (email) => r.h.call('POST', `/api/teams/${r.h.ids.org}/invites`, { token: tok, body: { email, role: 'member' } });
    assert.equal((await inv('newbie@outside.test')).status, 200);
    const nb = await r.emailSignIn('newbie@outside.test');
    assert.ok(nb.mailed);
    assert.equal(nb.v.status, 200, nb.v.text);
    const pend = (await r.h.call('GET', '/api/account', { token: nb.v.body.device_token })).body.pending_invites;
    assert.equal(pend.length, 1);
    const acc = await r.h.call('POST', `/api/account/invites/${pend[0].id}/accept`, { token: nb.v.body.device_token, body: {} });
    assert.equal(acc.status, 200, acc.text);

    assert.equal((await inv('gh@outside.test')).status, 200);
    const gh = await r.oauth('github', { id: 601, login: 'o601', email: 'gh@outside.test' });
    assert.equal(gh.status, 200, gh.text);

    const w = await inv('gone@outside.test');
    assert.equal((await r.h.call('DELETE', `/api/teams/${r.h.ids.org}/invites/${w.body.invite.id}`, { token: tok, body: {} })).status, 200);
    const gone = await r.emailSignIn('gone@outside.test');
    assert.equal(gone.mailed, false, 'a withdrawn invite sends nothing');
    assert.equal(gone.v.status, 400);
    assert.ok(!r.userBy('gone@outside.test'));
    const gg = await r.oauth('github', { id: 602, login: 'o602', email: 'gone@outside.test' });
    assert.equal(gg.body.error.code, 'SIGNUP_CLOSED');
  } finally { await r.h.close(); }
});

test('existing accounts are unaffected on every path once sign-up closes', async () => {
  const r = await rig({ signup: 'open', allow: '' });
  try {
    const e1 = await r.emailSignIn('old@nope.test');
    const g1 = await r.oauth('google', { sub: 'g-old', email: 'gold@gmail.com', name: 'G' });
    const h1 = await r.oauth('github', { id: 701, login: 'o701', email: 'ghold@nope.test' });
    for (const x of [e1.v, g1, h1]) assert.equal(x.status, 200, x.text);
    r.setPolicy('allowlist', '');
    const e2 = await r.emailSignIn('old@nope.test');
    assert.ok(e2.mailed, 'an existing account is mailed');
    assert.equal(e2.v.status, 200, e2.v.text);
    assert.equal(e2.v.body.user.id, e1.v.body.user.id);
    const g2 = await r.oauth('google', { sub: 'g-old', email: 'gold@gmail.com', name: 'G' });
    assert.equal(g2.status, 200, g2.text);
    assert.equal(g2.body.user.id, g1.body.user.id);
    const h2 = await r.oauth('github', { id: 701, login: 'o701', email: 'ghold@nope.test' });
    assert.equal(h2.status, 200, h2.text);
    assert.equal(h2.body.user.id, h1.body.user.id);
    // Google linking to the account that proved the address by code: not a new account either.
    const g3 = await r.oauth('google', { sub: 'g-new-sub', email: 'old@nope.test', name: 'O', hd: 'nope.test' });
    assert.equal(g3.status, 200, g3.text);
    assert.equal(g3.body.user.id, e1.v.body.user.id);
  } finally { await r.h.close(); }
});

test('open: today\'s behaviour, any address signs up on every path', async () => {
  const r = await rig({ signup: 'open', allow: '' });
  try {
    const e = await r.emailSignIn('anyone@nope.test');
    assert.ok(e.mailed);
    assert.equal(e.v.status, 200, e.v.text);
    assert.equal((await r.oauth('google', { sub: 'g-o', email: 'any@gmail.com', name: 'A' })).status, 200);
    assert.equal((await r.oauth('google', { sub: 'g-w', email: 'weak@nope.test', name: 'W' })).status, 200);
    assert.equal((await r.oauth('github', { id: 801, login: 'o801', email: 'o801@nope.test' })).status, 200);
  } finally { await r.h.close(); }
});

test('privacy: the list is in no response, log line or stored row, whatever was refused', async () => {
  const r = await rig();
  try {
    const texts = [];
    const s = await r.start('nobody@nope.test');
    texts.push(s.text, (await r.verify(s.body.flow_id, '111111')).text);
    texts.push((await r.oauth('google', { sub: 'g-p', email: 'p@gmail.com', name: 'P' })).text);
    texts.push((await r.oauth('github', { id: 901, login: 'o901', email: 'p@nope.test' })).text);
    texts.push((await r.h.call('GET', '/api/auth/methods')).text, (await r.h.call('GET', '/api/health')).text);
    const all = [...texts, ...r.logs, dumpDb(r.h.db)].join('\n');
    for (const d of LISTED) assert.ok(!all.includes(d), d);
  } finally { await r.h.close(); }
});

// Invite-only spread (production cutover review): users.signup_via records
// what let a new account in; while sign-up is allowlist, an account an invite
// let in may join teams but never create one (so it can't invite further).
const NO_CREATE_TEXT = 'Only team owners invited by the hub administrator can create teams while sign-up is invite-only';

test('allowlist: an invited newcomer joins teams but cannot create one; allowlisted, member-row, legacy and open-mode accounts can', async () => {
  const r = await rig({ limits: { ...ROOMY, invite_user: { capacity: 2, per_ms: 86_400_000 } } });
  try {
    const team = (tok, name) => r.h.call('POST', '/api/teams', { token: tok, body: { name } });
    const invite = (tok, org, email) => r.h.call('POST', `/api/teams/${org}/invites`, { token: tok, body: { email, role: 'member' } });
    const acceptAll = async (tok) => {
      for (const p of (await r.h.call('GET', '/api/account', { token: tok })).body.pending_invites) {
        const a = await r.h.call('POST', `/api/account/invites/${p.id}/accept`, { token: tok, body: {} });
        assert.equal(a.status, 200, a.text);
      }
    };
    const via = (email) => r.userBy(email).signup_via;

    // Allowlisted: creates and invites as today.
    const owner = await r.emailSignIn('owner@allowed.test');
    assert.equal(owner.v.status, 200, owner.v.text);
    assert.equal(via('owner@allowed.test'), 'allowlist');
    const otok = owner.v.body.device_token;
    const t1 = await team(otok, 'Owner Team');
    assert.equal(t1.status, 200, t1.text);
    assert.equal((await invite(otok, t1.body.team.id, 'newbie@outside.test')).status, 200);

    // Invited newcomer (email code): joins, then may not create a team.
    const nb = await r.emailSignIn('newbie@outside.test');
    assert.equal(nb.v.status, 200, nb.v.text);
    assert.equal(via('newbie@outside.test'), 'invite');
    const ntok = nb.v.body.device_token;
    await acceptAll(ntok);
    const refused = await team(ntok, 'Spread');
    assert.equal(refused.status, 403, refused.text);
    assert.deepEqual(refused.body.error, { code: 'FORBIDDEN', message: NO_CREATE_TEXT });
    assert.equal(r.h.db.get("SELECT COUNT(*) AS n FROM orgs WHERE name = 'Spread'").n, 0);

    // A member-row account (alice@dev.local, an unlinked Access-era row) creates, and her invite lets the newcomer join a second team.
    const alice = await r.emailSignIn('alice@dev.local');
    assert.equal(alice.v.status, 200, alice.v.text);
    assert.equal(via('alice@dev.local'), 'member_row');
    const atok = alice.v.body.device_token;
    const t2 = await team(atok, 'Alice Team');
    assert.equal(t2.status, 200, t2.text);
    assert.equal((await invite(atok, t2.body.team.id, 'newbie@outside.test')).status, 200);
    await acceptAll(ntok);
    const teams = (await r.h.call('GET', '/api/account', { token: ntok })).body.teams.map((t) => t.name).sort();
    assert.deepEqual(teams, ['Alice Team', 'Owner Team']);
    assert.equal((await team(ntok, 'Spread')).status, 403, 'still no');

    // GitHub through an invite: the same.
    assert.equal((await invite(atok, t2.body.team.id, 'gh@outside.test')).status, 200);
    const gh = await r.oauth('github', { id: 611, login: 'o611', email: 'gh@outside.test' });
    assert.equal(gh.status, 200, gh.text);
    assert.equal(r.h.db.get("SELECT u.signup_via FROM users u JOIN identities i ON i.user_id = u.id WHERE i.provider = 'github' AND i.subject = '611'").signup_via, 'invite');
    assert.equal((await team(gh.body.device_token, 'GH Spread')).status, 403);

    // The per-user caps still apply to those who may: invites (2 here), then team creation (3 a day).
    const third = await invite(atok, t2.body.team.id, 'third@outside.test');
    assert.equal(third.status, 429, third.text);
    assert.equal((await team(atok, 'Alice Two')).status, 200);
    assert.equal((await team(atok, 'Alice Three')).status, 200);
    assert.equal((await team(atok, 'Alice Four')).status, 429);

    // An account from before the column (NULL) is unaffected.
    r.h.db.run("UPDATE users SET signup_via = NULL WHERE primary_email = 'newbie@outside.test'");
    assert.equal((await team(ntok, 'Legacy')).status, 200);

    // Open mode: anyone may create, whatever let them in.
    r.h.db.run("UPDATE users SET signup_via = 'invite' WHERE primary_email = 'newbie@outside.test'");
    r.setPolicy('open', '');
    assert.equal((await team(ntok, 'Opened')).status, 200);
    const anyone = await r.emailSignIn('anyone@nope.test');
    assert.equal(anyone.v.status, 200, anyone.v.text);
    assert.equal(via('anyone@nope.test'), 'open');
    assert.equal((await team(anyone.v.body.device_token, 'Anyone')).status, 200);
  } finally { await r.h.close(); }
});

test('signup_via takes only allowlist, invite, member_row, open (or NULL)', async () => {
  const r = await rig();
  try {
    const u = await r.emailSignIn('v@allowed.test');
    assert.equal(u.v.status, 200);
    assert.throws(() => r.h.db.run("UPDATE users SET signup_via = 'admin' WHERE primary_email = 'v@allowed.test'"), /CHECK/);
    for (const v of ['allowlist', 'invite', 'member_row', 'open', null]) r.h.db.run('UPDATE users SET signup_via = ? WHERE primary_email = ?', v, 'v@allowed.test');
  } finally { await r.h.close(); }
});

test('email start: a real code goes out exactly when verify would accept it (an email identity or an authoritative primary is an account; a GitHub primary is not)', async () => {
  const r = await rig({ signup: 'open', allow: '' });
  try {
    assert.equal((await r.emailSignIn('byident@nope.test')).v.status, 200);
    assert.equal((await r.oauth('google', { sub: 'g-auth', email: 'bygoogle@nope.test', name: 'G', hd: 'nope.test' })).status, 200);
    assert.equal((await r.oauth('github', { id: 951, login: 'o951', email: 'bygithub@nope.test' })).status, 200);
    assert.equal(r.userBy('bygithub@nope.test').primary_email_via, 'github');
    r.setPolicy('allowlist', '');
    const shapes = new Set();
    for (const [email, account] of [['byident@nope.test', true], ['bygoogle@nope.test', true], ['bygithub@nope.test', false], ['nobody@nope.test', false]]) {
      assert.equal(r.h.hub.accounts.hasAccount(email), account, email);
      const { s, v, mailed } = await r.emailSignIn(email);
      assert.equal(s.status, 200, email);
      shapes.add(JSON.stringify(Object.keys(s.body).sort()));
      const dud = r.h.db.get('SELECT code_hash FROM login_flows WHERE id = ?', s.body.flow_id).code_hash.startsWith('dud:');
      assert.equal(mailed, account, `${email}: mailed`);
      assert.equal(dud, !account, `${email}: dud`);
      // What verify does with the code (or a guess, for a dud) matches what start did.
      assert.equal(v.status, account ? 200 : 400, `${email}: ${v.text}`);
      if (!account) assert.equal(v.body.error.code, 'INVALID_TOKEN');
    }
    assert.equal(shapes.size, 1, 'one answer shape');
  } finally { await r.h.close(); }
});

test('email start: a refused address costs the same work as a real one (one code HMAC, the same three writes), and its dud kills none of the address\'s live flows', async () => {
  const r = await rig();
  try {
    const acc = r.h.hub.accounts;
    const count = (email) => {
      const seen = { hash: 0, run: 0, insert: 0 };
      const orig = { hash: acc.codeHash, run: r.h.db.run, insert: r.h.db.insert };
      acc.codeHash = function (...a) { seen.hash++; return orig.hash.apply(this, a); };
      r.h.db.run = function (...a) { seen.run++; return orig.run.apply(this, a); };
      r.h.db.insert = function (...a) { seen.insert++; return orig.insert.apply(this, a); };
      return r.start(email).finally(() => { acc.codeHash = orig.hash; r.h.db.run = orig.run; r.h.db.insert = orig.insert; }).then((s) => ({ s, seen }));
    };
    const real = await count('real@allowed.test');
    const dud = await count('refused@nope.test');
    assert.equal(r.h.db.get('SELECT code_hash FROM login_flows WHERE id = ?', dud.s.body.flow_id).code_hash.slice(0, 4), 'dud:');
    assert.deepEqual(dud.seen, real.seen);
    assert.equal(real.seen.hash, 1);
    assert.equal(real.seen.insert, 2, 'the flow and its audit row');
    // A dud for an address with live flows (here: the start limit silences it) leaves them live.
    const live = () => r.h.db.get("SELECT COUNT(*) AS n FROM login_flows WHERE email = 'real@allowed.test' AND dead_at IS NULL AND code_hash NOT LIKE 'dud:%'").n;
    for (let i = 0; i < 2; i++) await r.start('real@allowed.test');
    assert.equal(live(), 3);
    const take = r.h.hub.limiter.take.bind(r.h.hub.limiter);
    r.h.hub.limiter.take = (name, key) => (name === 'auth_start_email' ? { ok: false, retry_after_ms: 1000 } : take(name, key));
    const quiet = await count('real@allowed.test');
    assert.deepEqual(quiet.seen, real.seen);
    assert.equal(live(), 3, 'the dud killed nothing');
  } finally { await r.h.close(); }
});
