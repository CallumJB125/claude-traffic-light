// BOARD_AUTH=accounts, P1 (ACCOUNTS-API.md, CONTRACT D51–D58): email codes,
// desktop device tokens, web cookie sessions + CSRF, WS auth, step-up
// deletion, rate limits and audit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startAccounts, dumpDb } from './accounts-helpers.js';
import { settle } from './helpers.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const MIN = 60_000;
const DAY = 86_400_000;

test('desktop sign-up = sign-in: code mail names the device, token is shown once and stored only hashed', async () => {
  const h = await startAccounts();
  try {
    const s = await h.start('Alice@Dev.Local ');
    assert.equal(s.status, 200);
    assert.deepEqual(Object.keys(s.body).sort(), ['expires_in', 'flow_id']);
    assert.equal(s.body.expires_in, 600);
    const mail = h.mailer.last('alice@dev.local');
    assert.match(mail.subject, /^\d{6} is your Plexiform sign-in code$/);
    assert.match(mail.text, /"MacBook-Pro" \(darwin-arm64\)/);
    assert.match(mail.text, /Never share this code/);
    assert.doesNotMatch(mail.text, /auth\/email#/, 'desktop mails carry no link');
    const code = h.codeFor('alice@dev.local');
    const v = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code, device_name: 'MacBook-Pro', platform: 'darwin-arm64', form_factor: 'laptop' } });
    assert.equal(v.status, 200, v.text);
    assert.match(v.body.device_token, /^bdt_[A-Za-z0-9_-]{43}$/);
    assert.equal(v.body.user.email, 'alice@dev.local');
    assert.equal(v.body.user.email_verified, true);
    assert.equal(v.cookies.length, 0, 'no cookie for the desktop client');
    // The pre-accounts member row with that email joined the new user.
    assert.deepEqual(v.body.teams.map((t) => [t.id, t.role, t.boards.map((b) => b.id)]), [[h.ids.org, 'owner', [h.ids.board]]]);
    const row = h.db.get('SELECT * FROM user_devices WHERE id = ?', v.body.device_id);
    assert.equal(row.token_hash, sha(v.body.device_token));
    assert.equal(row.name, 'MacBook-Pro');
    assert.equal(row.form_factor, 'laptop');
    const dump = dumpDb(h.db);
    assert.ok(!dump.includes(v.body.device_token), 'token nowhere in the DB');
    assert.ok(!dump.includes(`"${code}"`), 'code nowhere in the DB');

    const acct = await h.call('GET', '/api/account', { token: v.body.device_token });
    assert.equal(acct.status, 200);
    assert.deepEqual(Object.keys(acct.body).sort(), ['pending_invites', 'teams', 'user']);
    assert.deepEqual(acct.body.pending_invites, []);
    assert.equal(acct.body.teams[0].slug, 'dev', 'teams made by the legacy seed get a slug (P2 backfill)');

    // Signing in again: same user, a second device.
    const again = await h.signIn('alice@dev.local');
    assert.equal(again.body.user.id, v.body.user.id);
    assert.notEqual(again.body.device_id, v.body.device_id);
    // A new address: a new user with no team.
    const n = await h.signIn('new.person@example.com');
    assert.equal(n.status, 200);
    assert.deepEqual(n.body.teams, []);
    assert.equal(n.body.user.display_name, 'new.person');
    // The legacy /api/me keeps answering, with the member of the only team.
    const me = await h.call('GET', '/api/me', { token: v.body.device_token });
    assert.equal(me.body.member.id, h.ids.alice);
    assert.equal(me.body.user.id, v.body.user.id);
    const me2 = await h.call('GET', '/api/me', { token: n.body.device_token });
    assert.equal(me2.body.member, null);
    assert.deepEqual(me2.body.boards, []);
    // Member routes work with the Bearer token and need no CSRF token.
    const card = await h.call('POST', `/api/boards/${h.ids.board}/cards`, { token: v.body.device_token, headers: { origin: h.base }, body: { request_id: 'r1', title: 'from the app' } });
    assert.equal(card.status, 200, card.text);
    const noTeam = await h.call('GET', `/api/boards/${h.ids.board}`, { token: n.body.device_token });
    assert.equal(noTeam.status, 404);
    const cross = await h.call('POST', `/api/boards/${h.ids.board}/cards`, { token: v.body.device_token, headers: { origin: 'https://evil.example' }, body: { request_id: 'r2', title: 'x' } });
    assert.equal(cross.status, 403, 'Bearer requests keep the Origin check');
  } finally {
    await h.close();
  }
});

test('same answer for every address; unknown or fake flow ids fail like a wrong code', async () => {
  const h = await startAccounts();
  try {
    const a = await h.start('alice@dev.local');
    const b = await h.start('nobody@example.com');
    assert.equal(a.status, b.status);
    assert.deepEqual(Object.keys(a.body), Object.keys(b.body));
    assert.equal(a.body.flow_id.length, b.body.flow_id.length);
    const bad = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: 'nope', code: '123456' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_TOKEN');
    assert.equal((await h.start('not-an-email')).status, 400);
    assert.equal((await h.start('x@y.io', { client: 'tv' })).status, 400);
  } finally {
    await h.close();
  }
});

test('codes: 5 wrong attempts kill the flow, single use, 10-minute TTL, at most 3 live flows per address', async () => {
  const h = await startAccounts();
  try {
    const verify = (flow_id, code) => h.call('POST', '/api/auth/email/verify', { body: { flow_id, code } });
    const s = await h.start('bob@dev.local');
    const code = h.codeFor('bob@dev.local');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 5; i++) {
      const r = await verify(s.body.flow_id, wrong);
      assert.equal(r.body.error.code, 'INVALID_TOKEN');
      assert.equal(r.body.error.attempts_left, 5 - i);
    }
    assert.equal((await verify(s.body.flow_id, code)).body.error.code, 'INVALID_TOKEN', 'dead after 5');

    h.clock.advance(15 * MIN);
    const s2 = await h.start('bob@dev.local');
    const c2 = h.codeFor('bob@dev.local');
    assert.equal((await verify(s2.body.flow_id, c2)).status, 200);
    assert.equal((await verify(s2.body.flow_id, c2)).body.error.code, 'INVALID_TOKEN', 'single use');

    const s3 = await h.start('bob@dev.local');
    const c3 = h.codeFor('bob@dev.local');
    h.clock.advance(10 * MIN + 1);
    assert.equal((await verify(s3.body.flow_id, c3)).body.error.code, 'INVALID_TOKEN', 'expired');

    // Three flows now, a fourth 5 minutes later (the per-address bucket refilled one): the oldest dies.
    h.clock.advance(15 * MIN);
    const flows = [];
    for (let i = 0; i < 3; i++) flows.push([(await h.start('bob@dev.local')).body.flow_id, h.codeFor('bob@dev.local')]);
    h.clock.advance(5 * MIN);
    flows.push([(await h.start('bob@dev.local')).body.flow_id, h.codeFor('bob@dev.local')]);
    assert.ok(h.db.get('SELECT dead_at FROM login_flows WHERE id = ?', flows[0][0]).dead_at, 'oldest superseded');
    assert.equal((await verify(...flows[0])).body.error.code, 'INVALID_TOKEN');
    assert.equal((await verify(...flows[3])).status, 200);
  } finally {
    await h.close();
  }
});

test('rate limits: per address (silent, no mail), per IP (429), verify lockout per address', async () => {
  const h = await startAccounts({ config: { rateLimits: { auth_verify_ip: { capacity: 100, per_ms: 10 * MIN } } } });
  try {
    for (let i = 0; i < 3; i++) await h.start('carol@example.com');
    const sent = h.mailer.sent.length;
    const quiet = await h.start('carol@example.com');
    assert.equal(quiet.status, 200, 'over the per-address limit: same answer');
    assert.equal(h.mailer.sent.length, sent, 'but no mail');
    assert.equal(h.db.get('SELECT 1 AS x FROM login_flows WHERE id = ?', quiet.body.flow_id), null);
    assert.equal((await h.call('POST', '/api/auth/email/verify', { body: { flow_id: quiet.body.flow_id, code: '123456' } })).body.error.code, 'INVALID_TOKEN');

    // Per IP: 20 starts an hour (4 used above).
    let last;
    for (let i = 0; i < 17; i++) last = await h.start(`p${i}@example.com`);
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(last.headers.get('retry-after')) > 0);

    // Lockout: 10 verify attempts per address per 15 min, even with the right code after.
    h.clock.advance(60 * MIN);
    const flows = [];
    for (let i = 0; i < 3; i++) flows.push([(await h.start('dave@example.com')).body.flow_id, h.codeFor('dave@example.com')]);
    for (let i = 0; i < 5; i++) await h.call('POST', '/api/auth/email/verify', { body: { flow_id: flows[0][0], code: 'abcdef' } });
    for (let i = 0; i < 5; i++) await h.call('POST', '/api/auth/email/verify', { body: { flow_id: flows[1][0], code: 'abcdef' } });
    const locked = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: flows[2][0], code: flows[2][1] } });
    assert.equal(locked.status, 429);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit WHERE action = 'auth.lockout'"));
    h.clock.advance(15 * MIN);
    assert.equal((await h.call('POST', '/api/auth/email/verify', { body: { flow_id: flows[2][0], code: flows[2][1] } })).status, 400, 'flow expired meanwhile');
  } finally {
    await h.close();
  }
});

test('verify: 10 per 10 min per IP; new users: 10 a day per IP', async () => {
  const h = await startAccounts({ config: { rateLimits: { auth_start_ip: { capacity: 1000, per_ms: 3_600_000 }, auth_verify_ip: { capacity: 1000, per_ms: MIN } } } });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await h.signIn(`new${i}@example.com`)).status, 200);
    const eleventh = await h.signIn('new10@example.com');
    assert.equal(eleventh.status, 429);
    assert.equal((await h.signIn('new0@example.com')).status, 200, 'existing users are not new users');
  } finally {
    await h.close();
  }
  const h2 = await startAccounts();
  try {
    let r;
    for (let i = 0; i < 11; i++) r = await h2.call('POST', '/api/auth/email/verify', { body: { flow_id: `x${i}`, code: '123456' } });
    assert.equal(r.status, 429);
  } finally {
    await h2.close();
  }
});

test('web: magic link in the fragment; a scanner GET consumes nothing; another browser must confirm; cookie flags', async () => {
  const h = await startAccounts();
  try {
    const s = await h.start('alice@dev.local', { client: 'web' });
    const flowCookie = s.cookies.find((c) => c.startsWith('__Host-buddy_flow='));
    assert.match(flowCookie, /HttpOnly; Secure; SameSite=Lax; Path=\//);
    const mail = h.mailer.last('alice@dev.local');
    const link = /(http:\/\/\S+\/auth\/email#f=(\S+)&c=(\d{6}))/.exec(mail.text);
    assert.ok(link, mail.text);
    assert.equal(link[2], s.body.flow_id);
    // Scanner: GETs the page (the fragment never leaves the client) — nothing happens.
    const page = await fetch(link[1]);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /signin\.js/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(h.db.get('SELECT consumed_at FROM login_flows WHERE id = ?', s.body.flow_id).consumed_at, null);
    // Another browser (no flow cookie): confirm first; this costs no attempt.
    const other = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: link[2], code: link[3], via: 'link' } });
    assert.equal(other.status, 428);
    assert.equal(other.body.error.code, 'CONFIRM_REQUIRED');
    assert.equal(other.body.error.email_masked, 'a•••@dev.local');
    const same = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: link[2], code: link[3], via: 'link' }, cookie: flowCookie.split(';')[0] });
    assert.equal(same.status, 200, same.text);
    assert.equal(same.body.device_token, undefined, 'web gets no device token');
    assert.ok(same.body.csrf_token);
    const sc = same.cookies.find((c) => c.startsWith('__Host-buddy_session='));
    assert.match(sc, /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000/);
    assert.ok(same.cookies.some((c) => c.startsWith('__Host-buddy_flow=;') && /Max-Age=0/.test(c)), 'flow cookie cleared');
    const value = sc.split(';')[0].split('=')[1];
    assert.equal(h.db.get('SELECT count(*) AS n FROM sessions WHERE id_hash = ?', sha(value)).n, 1, 'stored hashed');
    assert.ok(!dumpDb(h.db).includes(value));

    // Cross-browser with confirm:true also works (new flow).
    h.clock.advance(15 * MIN);
    const s2 = await h.start('bob@dev.local', { client: 'web' });
    const c2 = h.codeFor('bob@dev.local');
    const ok = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: s2.body.flow_id, code: c2, via: 'link', confirm: true } });
    assert.equal(ok.status, 200);
    // /invite and /signin are public pages in accounts mode.
    assert.equal((await fetch(`${h.base}/invite`)).status, 200);
    assert.equal((await fetch(`${h.base}/signin`)).status, 200);
  } finally {
    await h.close();
  }
});

test('CSRF (cookie sessions): Origin present and same, Sec-Fetch-Site same-origin, X-CSRF-Token', async () => {
  const h = await startAccounts();
  try {
    const w = await h.webSignIn('alice@dev.local');
    const acct = await h.call('GET', '/api/account', { cookie: w.cookie });
    assert.equal(acct.status, 200);
    assert.equal(acct.body.csrf_token, w.csrf);
    const post = (headers) => h.call('POST', `/api/boards/${h.ids.board}/cards`, { cookie: w.cookie, headers, body: { title: 'x' } });
    assert.equal((await post({ origin: h.base })).status, 403, 'no token');
    assert.equal((await post({ 'x-csrf-token': w.csrf })).status, 403, 'no Origin');
    assert.equal((await post({ origin: 'https://evil.example', 'x-csrf-token': w.csrf })).status, 403, 'foreign Origin');
    assert.equal((await post({ origin: h.base, 'x-csrf-token': w.csrf, 'sec-fetch-site': 'cross-site' })).status, 403, 'Sec-Fetch-Site');
    assert.equal((await post({ origin: h.base, 'x-csrf-token': 'x'.repeat(43) })).status, 403, 'wrong token');
    const good = await post({ origin: h.base, 'x-csrf-token': w.csrf, 'sec-fetch-site': 'same-origin' });
    assert.equal(good.status, 200, good.text);
    // Sign out needs it too, then the cookie is dead.
    assert.equal((await h.call('POST', '/api/auth/signout', { cookie: w.cookie, body: {} })).status, 403);
    const out = await h.call('POST', '/api/auth/signout', { cookie: w.cookie, headers: { origin: h.base, 'x-csrf-token': w.csrf }, body: {} });
    assert.equal(out.status, 200);
    assert.ok(out.cookies.some((c) => c.startsWith('__Host-buddy_session=;')));
    assert.equal((await h.call('GET', '/api/account', { cookie: w.cookie })).status, 401);
    assert.equal((await h.call('GET', '/api/account')).status, 401);
  } finally {
    await h.close();
  }
});

test('web sessions: idle 14 d, absolute 30 d, rotation after 24 h with a 60 s grace, epoch bump', async () => {
  const h = await startAccounts();
  try {
    const get = (cookie) => h.call('GET', '/api/account', { cookie });
    const w = await h.webSignIn('alice@dev.local');
    h.clock.advance(DAY + 1);
    const r = await get(w.cookie);
    assert.equal(r.status, 200);
    const rotated = r.cookies.find((c) => c.startsWith('__Host-buddy_session='));
    assert.ok(rotated, 'rotated after 24 h');
    const fresh = rotated.split(';')[0];
    assert.notEqual(fresh, w.cookie);
    assert.equal((await get(w.cookie)).status, 200, 'old value inside the grace');
    assert.equal((await get(fresh)).body.csrf_token, w.csrf, 'CSRF token survives rotation');
    h.clock.advance(61_000);
    assert.equal((await get(w.cookie)).status, 401, 'old value after the grace');
    assert.equal((await get(fresh)).status, 200);

    // Idle: 14 days without a request.
    h.clock.advance(14 * DAY + 1);
    assert.equal((await get(fresh)).status, 401, 'idle expiry');

    // Absolute: used every 10 days, dead at 30.
    const w2 = await h.webSignIn('bob@dev.local');
    let c = w2.cookie;
    for (let i = 0; i < 2; i++) {
      h.clock.advance(10 * DAY);
      const g = await get(c);
      assert.equal(g.status, 200);
      c = g.cookies.find((x) => x.startsWith('__Host-buddy_session='))?.split(';')[0] ?? c;
    }
    h.clock.advance(10 * DAY + 1);
    assert.equal((await get(c)).status, 401, 'absolute expiry');

    // A restore bumps the epoch: every session dies.
    h.clock.advance(15 * MIN);
    const w3 = await h.webSignIn('alice@dev.local');
    assert.equal((await get(w3.cookie)).status, 200);
    h.db.setMeta('session_epoch', 2);
    assert.equal((await get(w3.cookie)).status, 401);
  } finally {
    await h.close();
  }
});

test('/ws/board: Bearer accepted; missing or invalid Bearer → HTTP 401; revoking a device closes its socket (session.revoked, 4401)', async () => {
  const h = await startAccounts();
  try {
    const a = await h.signIn('alice@dev.local');
    const b = await h.signIn('alice@dev.local');
    assert.equal(await h.upgradeStatus({}), 401, 'no credential');
    assert.equal(await h.upgradeStatus({ authorization: 'Bearer bdt_nope' }), 401, 'unknown token');
    assert.equal(await h.upgradeStatus({ authorization: 'Basic x' }), 401, 'not a Bearer');
    assert.equal(await h.upgradeStatus({ authorization: `Bearer ${a.body.device_token}`, origin: 'https://evil.example' }), 403, 'foreign Origin');

    const sa = await h.browser({ token: a.body.device_token, headers: { origin: h.base } });
    const snap = await sa.subscribe(h.ids.board);
    assert.equal(snap.board_id, h.ids.board);
    assert.equal(sa.all('welcome')[0].user.id, a.body.user.id);
    const sb = await h.browser({ token: b.body.device_token });
    await sb.subscribe(h.ids.board);

    const list = await h.call('GET', '/api/account/devices', { token: a.body.device_token });
    assert.deepEqual(list.body.devices.map((d) => [d.id, d.current]).sort(), [[a.body.device_id, true], [b.body.device_id, false]].sort());
    const del = await h.call('DELETE', `/api/account/devices/${b.body.device_id}`, { token: a.body.device_token, body: {} });
    assert.equal(del.status, 200);
    assert.equal(await sb.closed(), 4401);
    assert.ok(sb.all('session.revoked').length, 'told why before the close');
    assert.equal((await h.call('GET', '/api/account', { token: b.body.device_token })).status, 401);
    assert.equal(h.db.get('SELECT token_hash FROM user_devices WHERE id = ?', b.body.device_id).token_hash, null);
    assert.equal(sa.closeCode, null, 'the other device keeps its socket');

    // Someone else's device: 404.
    const other = await h.signIn('bob@dev.local');
    assert.equal((await h.call('DELETE', `/api/account/devices/${a.body.device_id}`, { token: other.body.device_token, body: {} })).status, 404);

    // Sign-out revokes the device and closes its socket.
    const out = await h.call('POST', '/api/auth/signout', { token: a.body.device_token, body: {} });
    assert.equal(out.status, 200);
    assert.equal(await sa.closed(), 4401);
    assert.equal((await h.call('GET', '/api/account', { token: a.body.device_token })).status, 401);

    // Cookie sockets: Origin required; the reaper pass closes a socket whose session died.
    const w = await h.webSignIn('bob@dev.local');
    assert.equal(await h.upgradeStatus({ cookie: w.cookie }), 403, 'cookie upgrade without Origin');
    const sc = await h.browser({ cookie: w.cookie, headers: { origin: h.base } });
    await sc.subscribe(h.ids.board);
    h.db.run("UPDATE sessions SET revoked_at = 'x'");
    await h.hub.tick();
    assert.equal(await sc.closed(), 4401);
  } finally {
    await h.close();
  }
});

test('a user with no team keeps a socket but finds no board; removal from the team closes a subscribed socket', async () => {
  const h = await startAccounts();
  try {
    const n = await h.signIn('solo@example.com');
    const s = await h.browser({ token: n.body.device_token });
    s.send({ type: 'hello', protocol: 1 });
    const welcome = await s.next('welcome');
    assert.equal(welcome.member, null);
    s.send({ type: 'subscribe', board_id: h.ids.board });
    assert.equal((await s.next('error')).code, 'NOT_FOUND');
    await settle();
    assert.equal(s.closeCode, null);

    const bob = await h.signIn('bob@dev.local');
    const sb = await h.browser({ token: bob.body.device_token });
    await sb.subscribe(h.ids.board);
    const alice = await h.signIn('alice@dev.local');
    const rm = await h.call('DELETE', `/api/teams/${h.ids.org}/members/${h.ids.bob}`, { token: alice.body.device_token, body: { request_id: 'rm1' } });
    assert.equal(rm.status, 200, rm.text);
    assert.equal(await sb.closed(), 4403);
  } finally {
    await h.close();
  }
});

test('DELETE /api/account: step-up with a fresh code (5 min), sole-owner guard, then tombstone + revoke everything', async () => {
  const h = await startAccounts();
  try {
    const alice = await h.signIn('alice@dev.local');
    const bob = await h.signIn('bob@dev.local');
    const tok = bob.body.device_token;
    const del = (body) => h.call('DELETE', '/api/account', { token: tok, body });
    const noStep = await del({});
    assert.equal(noStep.status, 401);
    assert.equal(noStep.body.error.code, 'STEP_UP_REQUIRED');
    assert.equal(noStep.body.error.max_age_s, 300);

    // A delete flow needs a signed-in caller and goes to the account's own address.
    assert.equal((await h.call('POST', '/api/auth/email/start', { body: { purpose: 'delete' } })).status, 401);
    const s = await h.call('POST', '/api/auth/email/start', { token: tok, body: { purpose: 'delete', email: 'attacker@example.com' } });
    assert.equal(s.status, 200);
    const mail = h.mailer.last();
    assert.equal(mail.to, 'bob@dev.local');
    assert.match(mail.subject, /confirms deleting your Plexiform account/);
    const code = h.codeFor('bob@dev.local');
    assert.equal((await del({ flow_id: s.body.flow_id })).body.error.code, 'STEP_UP_REQUIRED', 'started but not verified');
    // Another user can't verify or use bob's delete flow.
    assert.equal((await h.call('POST', '/api/auth/email/verify', { token: alice.body.device_token, body: { flow_id: s.body.flow_id, code } })).body.error.code, 'INVALID_TOKEN');
    const v = await h.call('POST', '/api/auth/email/verify', { token: tok, body: { flow_id: s.body.flow_id, code } });
    assert.equal(v.status, 200, v.text);
    assert.deepEqual(v.body, { ok: true, flow_id: s.body.flow_id, step_up_expires_in: 300 });
    assert.equal(v.body.device_token, undefined, 'a delete flow never signs in');
    assert.equal((await h.call('DELETE', '/api/account', { token: alice.body.device_token, body: { flow_id: s.body.flow_id } })).body.error.code, 'STEP_UP_REQUIRED');
    h.clock.advance(5 * MIN + 1);
    assert.equal((await del({ flow_id: s.body.flow_id })).body.error.code, 'STEP_UP_REQUIRED', 'stale step-up');

    // Alice is the only owner of a team with another member: refused.
    const sa = await h.call('POST', '/api/auth/email/start', { token: alice.body.device_token, body: { purpose: 'delete' } });
    await h.call('POST', '/api/auth/email/verify', { token: alice.body.device_token, body: { flow_id: sa.body.flow_id, code: h.codeFor('alice@dev.local') } });
    const blocked = await h.call('DELETE', '/api/account', { token: alice.body.device_token, body: { flow_id: sa.body.flow_id } });
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body.error.sole_owner_of.map((t) => t.id), [h.ids.org]);

    // Bob, fresh step-up, a live socket and a comment in the journal.
    const card = await h.call('POST', `/api/boards/${h.ids.board}/cards`, { token: tok, body: { request_id: 'c1', title: 'bob was here' } });
    const sock = await h.browser({ token: tok });
    await sock.subscribe(h.ids.board);
    h.clock.advance(15 * MIN);
    const s2 = await h.call('POST', '/api/auth/email/start', { token: tok, body: { purpose: 'delete' } });
    await h.call('POST', '/api/auth/email/verify', { token: tok, body: { flow_id: s2.body.flow_id, code: h.codeFor('bob@dev.local') } });
    const ok = await del({ flow_id: s2.body.flow_id });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(await sock.closed(), 4401);
    assert.equal((await h.call('GET', '/api/account', { token: tok })).status, 401);
    const u = h.db.get('SELECT * FROM users WHERE id = ?', bob.body.user.id);
    assert.equal(u.display_name, 'Deleted user');
    assert.equal(u.primary_email, null);
    assert.ok(u.deleted_at);
    assert.equal(h.db.get('SELECT count(*) AS n FROM identities WHERE user_id = ?', u.id).n, 0);
    assert.equal(h.db.get("SELECT count(*) AS n FROM user_devices WHERE user_id = ? AND revoked_at IS NULL", u.id).n, 0);
    const m = h.db.get('SELECT * FROM members WHERE id = ?', h.ids.bob);
    assert.ok(m.removed_at);
    assert.equal(m.display_name, 'Deleted user');
    assert.equal(m.email, null);
    assert.ok(!JSON.stringify(m).includes('bob'), 'no trace of the name in the member row');
    // History keeps pointing at the member id.
    assert.equal(h.db.get('SELECT created_by FROM cards WHERE id = ?', card.body.card.id).created_by, h.ids.bob);
    assert.ok(h.db.get("SELECT 1 AS x FROM journal WHERE actor_id = ? AND kind = 'card.create'", h.ids.bob));
    assert.equal(h.mailer.last('bob@dev.local').subject, 'Your Plexiform account was deleted');
    assert.ok(h.db.get("SELECT 1 AS x FROM audit WHERE action = 'user.deleted' AND actor_user_id = ?", u.id));
    // Signing in again with that address is a new, team-less user.
    h.clock.advance(15 * MIN);
    const back = await h.signIn('bob@dev.local');
    assert.notEqual(back.body.user.id, u.id);
    assert.deepEqual(back.body.teams, []);
  } finally {
    await h.close();
  }
});

test('audit: every auth event is recorded, with no address, code or token in it', async () => {
  const h = await startAccounts();
  try {
    const s = await h.start('eve@example.com');
    await h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code: 'abcdef' } });
    const v = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code: h.codeFor('eve@example.com') } });
    await h.call('POST', '/api/auth/signout', { token: v.body.device_token, body: {} });
    const rows = h.db.all('SELECT * FROM audit ORDER BY id');
    const actions = rows.map((r) => r.action);
    for (const a of ['auth.code.sent', 'auth.code.failed', 'user.create', 'auth.signin', 'auth.signout']) assert.ok(actions.includes(a), a);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes('eve@example.com'));
    assert.ok(!text.includes(v.body.device_token));
    assert.ok(!text.includes(h.codeFor('eve@example.com')));
    assert.ok(rows.every((r) => r.ip_prefix === '127.0.0.0/24'));
    assert.ok(rows.filter((r) => r.action !== 'auth.code.sent' && r.action !== 'auth.code.failed').every((r) => r.actor_user_id === v.body.user.id));
  } finally {
    await h.close();
  }
});
