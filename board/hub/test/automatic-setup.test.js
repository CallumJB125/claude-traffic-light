// Automatic first workspace uses the existing creation policy, atomically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAccounts } from './accounts-helpers.js';
import { ROOMY } from './tenancy/fixture.js';
import { personalTeamName, teamName } from '../identity/teams.js';

test('first setup makes one personal team and board; concurrent devices and retries reuse it', async () => {
  const h = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const a = await h.signIn('callum@example.test');
    const b = await h.signIn('callum@example.test');
    h.db.run('UPDATE users SET display_name = ? WHERE id = ?', 'Callum Baker', a.body.user.id);
    const setup = (token) => h.call('POST', '/api/account/setup', { token, body: {} });
    // Reading account or signing in alone never mutates memberships.
    assert.equal((await h.call('GET', '/api/account', { token: a.body.device_token })).body.teams.length, 0);
    const results = await Promise.all([setup(a.body.device_token), setup(b.body.device_token), setup(a.body.device_token)]);
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results));
    assert.deepEqual(results.map((r) => r.body.setup).sort(), ['created', 'existing', 'existing']);
    const t = results[0].body.teams[0];
    assert.deepEqual([t.name, t.role, t.boards.length, t.boards[0].name], ["Callum's team", 'owner', 1, "Callum's team"]);
    assert.ok(results.every((r) => r.body.teams[0].id === t.id));
    assert.equal(h.db.get("SELECT count(*) AS n FROM audit WHERE actor_user_id = ? AND action = 'team.create'", a.body.user.id).n, 1);
    assert.equal((await setup(b.body.device_token)).body.teams.length, 1);
  } finally { await h.close(); }
});

test('usable invitations prevent a personal team; explicit acceptance leads only to the inviter team', async () => {
  const h = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const owner = await h.signIn('alice@dev.local');
    const make = (email) => h.call('POST', `/api/teams/${h.ids.org}/invites`, { token: owner.body.device_token, body: { email, role: 'member' } });
    const inv = await make('guest@example.test');
    assert.equal(inv.status, 200, inv.text);
    const guest = await h.signIn('guest@example.test');
    const setup = await h.call('POST', '/api/account/setup', { token: guest.body.device_token, body: {} });
    assert.deepEqual([setup.status, setup.body.setup, setup.body.teams.length, setup.body.pending_invites.length], [200, 'invited', 0, 1]);
    const accept = await h.call('POST', '/api/invites/accept', { token: guest.body.device_token, body: { invite_id: inv.body.invite.id } });
    assert.equal(accept.status, 200, accept.text);
    const after = await h.call('POST', '/api/account/setup', { token: guest.body.device_token, body: {} });
    assert.deepEqual([after.body.setup, after.body.teams.length, after.body.teams[0].id, after.body.teams[0].role], ['existing', 1, h.ids.org, 'member']);
    assert.equal(h.db.get("SELECT count(*) AS n FROM audit WHERE actor_user_id = ? AND action = 'team.create'", guest.body.user.id).n, 0);
  } finally { await h.close(); }
});

test('revoked, expired, and no-longer-authorized invitations do not block setup', async () => {
  for (const invalid of ['revoked', 'expired', 'demoted']) {
    const h = await startAccounts({ config: { rateLimits: ROOMY } });
    try {
      h.db.run("UPDATE members SET role = 'admin' WHERE id = ?", h.ids.bob);
      const admin = await h.signIn('bob@dev.local');
      const email = `${invalid}@example.test`;
      const inv = await h.call('POST', `/api/teams/${h.ids.org}/invites`, { token: admin.body.device_token, body: { email, role: 'member' } });
      assert.equal(inv.status, 200, inv.text);
      if (invalid === 'demoted') h.db.run("UPDATE members SET role = 'member' WHERE id = ?", h.ids.bob);
      else h.db.run(`UPDATE invites SET ${invalid === 'revoked' ? 'revoked_at' : 'expires_at'} = ? WHERE id = ?`, '2000-01-01T00:00:00.000Z', inv.body.invite.id);
      const guest = await h.signIn(email);
      const r = await h.call('POST', '/api/account/setup', { token: guest.body.device_token, body: {} });
      assert.deepEqual([r.status, r.body.setup, r.body.teams.length], [200, 'created', 1], `${invalid}: ${r.text}`);
      assert.notEqual(r.body.teams[0].id, h.ids.org);
    } finally { await h.close(); }
  }
});

test('setup preserves actual invite-only admission when a newcomer invitation is withdrawn', async () => {
  const h = await startAccounts({ config: { signup: 'allowlist', signupAllow: 'email:allowed@example.test', rateLimits: ROOMY } });
  try {
    const allowed = await h.signIn('allowed@example.test');
    const owner = await h.call('POST', '/api/account/setup', { token: allowed.body.device_token, body: {} });
    assert.equal(owner.body.setup, 'created', owner.text);
    const invite = await h.call('POST', `/api/teams/${owner.body.teams[0].id}/invites`, { token: allowed.body.device_token, body: { email: 'newcomer@example.test', role: 'member' } });
    assert.equal(invite.status, 200, invite.text);
    const newcomer = await h.signIn('newcomer@example.test');
    assert.equal(newcomer.status, 200, newcomer.text);
    assert.equal(h.db.get('SELECT signup_via FROM users WHERE id = ?', newcomer.body.user.id).signup_via, 'invite');
    h.db.run('UPDATE invites SET revoked_at = ? WHERE id = ?', h.hub.iso(), invite.body.invite.id);
    const closed = await h.call('POST', '/api/account/setup', { token: newcomer.body.device_token, body: {} });
    assert.deepEqual([closed.status, closed.body.error.code], [403, 'FORBIDDEN'], closed.text);
    assert.equal((await h.call('GET', '/api/account', { token: newcomer.body.device_token })).body.teams.length, 0);
  } finally { await h.close(); }
});

test('setup retains creation rate limits and rolls back a failed first team', async () => {
  const h = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const guest = await h.signIn('newcomer@example.test');
    const call = () => h.call('POST', '/api/account/setup', { token: guest.body.device_token, body: {} });
    for (let i = 0; i < 3; i++) h.hub.limiter.take('team_create_user', guest.body.user.id);
    const limited = await call();
    assert.equal(limited.status, 429, limited.text);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await h.call('GET', '/api/account', { token: guest.body.device_token })).body.teams.length, 0);
    h.clock.advance(86_400_000);
    assert.equal((await call()).body.setup, 'created');
  } finally { await h.close(); }
});

test('setup is authenticated, origin-pinned and CSRF protected for browser sessions', async () => {
  const h = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    assert.equal((await h.call('POST', '/api/account/setup', { body: {} })).status, 401);
    const u = await h.webSignIn('browser@example.test');
    assert.equal((await h.call('POST', '/api/account/setup', { cookie: u.cookie, body: {} })).status, 403);
    assert.equal((await h.call('POST', '/api/account/setup', { cookie: u.cookie, body: {}, headers: { origin: 'https://foreign.test', 'x-csrf-token': u.csrf } })).status, 403);
    const r = await h.call('POST', '/api/account/setup', { cookie: u.cookie, body: {}, headers: { origin: h.base, 'x-csrf-token': u.csrf } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.setup, 'created');
  } finally { await h.close(); }
});

test('personal names fit the existing team name rule, including long Unicode names', () => {
  for (const display_name of ['Callum Baker', '', '\u0007\u200b', 'A'.repeat(100), `${'A'.repeat(52)}🙂 Person`, 'Élodie Dupont', '🙂🙂']) {
    const name = personalTeamName({ display_name });
    assert.equal(teamName(name), name);
  }
  assert.equal(personalTeamName({ display_name: ' Callum   Baker ' }), "Callum's team");
});
