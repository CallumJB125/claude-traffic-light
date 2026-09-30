// Accounts P2 (ACCOUNTS-API.md "Teams and members", CONTRACT D59–D62): team
// create / read / rename / soft delete, slugs, members and roles under the
// ceilings, last-owner protection, leaving, and the free-plan quotas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy, ROOMY } from './tenancy/fixture.js';
import { startAccounts } from './accounts-helpers.js';
import { settle } from './helpers.js';

test('POST /api/teams: creator is owner, one board, a unique slug; /api/account lists it; audited', async () => {
  const h = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const a = await h.signIn('jo@example.com');
    const as = (method, path, body, u = a) => h.call(method, path, { token: u.body.device_token, body, headers: { origin: h.base } });
    const t = await as('POST', '/api/teams', { name: '  Acme   Rockets ' });
    assert.equal(t.status, 200, t.text);
    assert.deepEqual(Object.keys(t.body).sort(), ['board', 'team']);
    assert.equal(t.body.team.name, 'Acme Rockets');
    assert.equal(t.body.team.slug, 'acme-rockets');
    assert.equal(t.body.team.plan, 'free');
    assert.deepEqual([t.body.board.name, t.body.board.key_prefix], ['Acme Rockets', 'ACM']);
    const acct = await as('GET', '/api/account');
    const mine = acct.body.teams.find((x) => x.id === t.body.team.id);
    assert.equal(mine.role, 'owner');
    assert.equal(mine.slug, 'acme-rockets');
    assert.deepEqual(mine.boards.map((b) => b.id), [t.body.board.id]);
    const audit = h.db.get("SELECT * FROM audit WHERE action = 'team.create'");
    assert.equal(audit.org_id, t.body.team.id);
    assert.equal(audit.actor_user_id, a.body.user.id);

    // Same name from someone else: -2. Reserved or unsluggable names get team-xxxxxx.
    const b = await h.signIn('kim@example.com');
    assert.equal((await as('POST', '/api/teams', { name: 'Acme Rockets' }, b)).body.team.slug, 'acme-rockets-2');
    assert.match((await as('POST', '/api/teams', { name: 'Admin' }, b)).body.team.slug, /^team-[0-9a-f]{6}$/);
    assert.match((await as('POST', '/api/teams', { name: '日本' }, b)).body.team.slug, /^team-[0-9a-f]{6}$/);
    // An explicit slug: validated, and taken ones refused.
    assert.equal((await as('POST', '/api/teams', { name: 'X', slug: 'acme-rockets' })).status, 409);
    assert.equal((await as('POST', '/api/teams', { name: 'X', slug: 'Bad Slug' })).status, 400);
    assert.equal((await as('POST', '/api/teams', { name: 'X', slug: 'api' })).status, 400);
    assert.equal((await as('POST', '/api/teams', { name: 'Own slug', slug: 'own-slug' })).body.team.slug, 'own-slug');
    for (const name of ['', '   ', 'x'.repeat(61), 'zero\u200Bwidth', 'bell\u0007', 5]) {
      assert.equal((await as('POST', '/api/teams', { name })).status, 400, JSON.stringify(name));
    }
    // An unverified address cannot create teams.
    h.db.run('UPDATE users SET primary_email_verified_at = NULL WHERE id = ?', b.body.user.id);
    const unv = await as('POST', '/api/teams', { name: 'Nope' }, b);
    assert.deepEqual([unv.status, unv.body.error.code], [403, 'EMAIL_UNVERIFIED']);
    // Signed out: 401.
    assert.equal((await h.call('POST', '/api/teams', { body: { name: 'x' } })).status, 401);
  } finally {
    await h.close();
  }
});

test('legacy teams (seed, bootstrap) get a slug; GET /api/teams/:id shows counts and quotas', async () => {
  const h = await startAccounts();
  try {
    const a = await h.signIn('alice@dev.local');
    const acct = await h.call('GET', '/api/account', { token: a.body.device_token });
    assert.equal(acct.body.teams[0].slug, 'dev');
    const t = await h.call('GET', `/api/teams/${h.ids.org}`, { token: a.body.device_token });
    assert.equal(t.status, 200, t.text);
    assert.equal(t.body.team.slug, 'dev');
    assert.deepEqual(t.body.me, { member_id: h.ids.alice, role: 'owner' });
    assert.equal(t.body.counts.members, 2);
    assert.deepEqual(t.body.quotas, { members: 25, boards: 10 });
  } finally {
    await h.close();
  }
});

test('quotas: 10 owned teams per user, 10 boards per team (free); 3 team creations a day', async () => {
  const h = await startAccounts({ config: { rateLimits: { ...ROOMY, team_create_user: { capacity: 100, per_ms: 86_400_000 } } } });
  try {
    const a = await h.signIn('many@example.com');
    const as = (method, path, body) => h.call(method, path, { token: a.body.device_token, body, headers: { origin: h.base } });
    let first;
    for (let i = 0; i < 10; i++) {
      const r = await as('POST', '/api/teams', { name: `Team ${i}` });
      assert.equal(r.status, 200, r.text);
      first ??= r.body;
    }
    const over = await as('POST', '/api/teams', { name: 'Eleven' });
    assert.equal(over.status, 403);
    assert.deepEqual([over.body.error.code, over.body.error.resource, over.body.error.limit], ['QUOTA_EXCEEDED', 'teams', 10]);
    for (let i = 1; i < 10; i++) assert.equal((await as('POST', `/api/teams/${first.team.id}/boards`, { name: `Board ${i}` })).status, 200);
    const b = await as('POST', `/api/teams/${first.team.id}/boards`, { name: 'Board 10' });
    assert.deepEqual([b.status, b.body.error.code, b.body.error.resource, b.body.error.limit], [403, 'QUOTA_EXCEEDED', 'boards', 10]);
    assert.equal((await as('POST', `/api/teams/${first.team.id}/boards`, { name: 'x', key_prefix: 'bad' })).status, 400);
  } finally {
    await h.close();
  }
  const h2 = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const a = await h2.signIn('quick@example.com');
    const make = (n) => h2.call('POST', '/api/teams', { token: a.body.device_token, body: { name: n } });
    for (const n of ['a1', 'a2', 'a3']) assert.equal((await make(n)).status, 200);
    const r = await make('a4');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  } finally {
    await h2.close();
  }
});

test('members: names for everyone, emails for admins; role changes follow the ceilings', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A } = fx;
    const list = async (u) => (await as(u, 'GET', `/api/teams/${A.team}/members`)).body.members;
    const own = await list(users.ua);
    assert.deepEqual(own.map((x) => x.role), ['owner', 'admin', 'member', 'member', 'viewer']);
    assert.ok(own.every((x) => typeof x.email === 'string' && x.member_id && x.user_id && x.joined_at));
    for (const u of [users.amember, users.aviewer]) assert.ok((await list(u)).every((x) => !('email' in x)), 'no emails for members/viewers');
    assert.ok((await list(users.aadmin)).every((x) => 'email' in x));

    const set = (u, mid, role) => as(u, 'PATCH', `/api/teams/${A.team}/members/${mid}`, { role });
    // member / viewer can't change roles; admin can't touch owners or make owners.
    assert.equal((await set(users.amember, A.viewer, 'member')).status, 403);
    assert.equal((await set(users.aviewer, A.viewer, 'admin')).status, 403);
    assert.equal((await set(users.aadmin, A.owner, 'member')).status, 403);
    assert.equal((await set(users.aadmin, A.member, 'owner')).status, 403);
    const up = await set(users.aadmin, A.viewer, 'admin');
    assert.equal(up.status, 200, up.text);
    assert.equal(up.body.member.role, 'admin');
    assert.equal((await set(users.aadmin, A.viewer, 'viewer')).body.member.role, 'viewer');
    assert.equal((await set(users.ua, A.member, 'nonsense')).status, 400);
    // Only an owner makes owners; the last owner cannot step down.
    const last = await set(users.ua, A.owner, 'admin');
    assert.deepEqual([last.status, last.body.error.code, last.body.error.reason], [409, 'CONFLICT', 'LAST_OWNER']);
    assert.equal((await set(users.ua, A.admin, 'owner')).body.member.role, 'owner');
    assert.equal((await set(users.ua, A.owner, 'admin')).status, 200, 'a second owner exists now');
    const audit = fx.db.all("SELECT detail FROM audit WHERE action = 'member.role' AND org_id = ?", A.team).map((r) => JSON.parse(r.detail));
    assert.ok(audit.some((d) => d.from === 'admin' && d.to === 'owner'));
    // An unknown or foreign member id: 404.
    assert.equal((await set(users.ua, randomUUID(), 'member')).status, 404);
  } finally {
    await fx.h.close();
  }
});

test('removal and leaving: last owner protected (API and DB trigger); sockets close 4403; devices revoked', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, db } = fx;
    const del = (u, mid) => as(u, 'DELETE', `/api/teams/${A.team}/members/${mid}`, {});
    assert.equal((await del(users.amember, A.viewer)).status, 403, 'members cannot remove others');
    assert.equal((await del(users.aadmin, A.owner)).status, 403, 'admins cannot remove owners');
    const lastOwner = await del(users.ua, A.owner);
    assert.deepEqual([lastOwner.status, lastOwner.body.error.reason], [409, 'LAST_OWNER']);
    assert.throws(() => db.run("UPDATE members SET role = 'member' WHERE id = ?", A.owner), /a team needs an owner/);
    assert.throws(() => db.run('UPDATE members SET removed_at = ? WHERE id = ?', 'x', A.owner), /a team needs an owner/);

    // The member has a live browser socket on A's board and a runner device.
    const sock = await fx.h.browser({ token: users.amember.token });
    await sock.subscribe(A.board);
    const dev = randomUUID();
    db.insert('devices', { id: dev, member_id: A.member, name: 'mbp', kind: 'runner', token_hash: randomUUID(), created_at: fx.h.hub.iso() });
    const r = await del(users.aadmin, A.member);
    assert.equal(r.status, 200, r.text);
    assert.equal(await sock.closed(), 4403);
    assert.ok(db.get('SELECT revoked_at FROM devices WHERE id = ?', dev).revoked_at);
    assert.equal((await as(users.amember, 'GET', `/api/boards/${A.board}`)).status, 404);
    assert.ok(!(await as(users.amember, 'GET', '/api/account')).body.teams.some((t) => t.id === A.team));
    assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action = 'member.remove' AND target = ?", A.member));

    // Leaving: anyone may remove themselves, even a viewer.
    const leave = await del(users.aviewer, A.viewer);
    assert.equal(leave.status, 200);
    assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action = 'member.leave' AND target = ?", A.viewer));
    // The old owner hands over, then leaves.
    await as(users.ua, 'PATCH', `/api/teams/${A.team}/members/${A.admin}`, { role: 'owner' });
    assert.equal((await del(users.ua, A.owner)).status, 200);
    assert.equal((await as(users.aadmin, 'GET', `/api/teams/${A.team}`)).body.me.role, 'owner');
  } finally {
    await fx.h.close();
  }
});

test('rename (admin) and soft delete (owner, confirm_slug): the team 404s everywhere, sockets and devices go', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, db } = fx;
    assert.equal((await as(users.amember, 'PATCH', `/api/teams/${A.team}`, { name: 'Nope' })).status, 403);
    const ren = await as(users.aadmin, 'PATCH', `/api/teams/${A.team}`, { name: 'Alpha Two' });
    assert.deepEqual([ren.status, ren.body.team.name, ren.body.team.slug], [200, 'Alpha Two', 'alpha'], 'rename keeps the slug');

    const sock = await fx.h.browser({ token: users.s.token });
    await sock.subscribe(A.board);
    const dev = randomUUID();
    db.insert('devices', { id: dev, member_id: A.s, name: 'mbp', kind: 'runner', token_hash: randomUUID(), created_at: fx.h.hub.iso() });
    assert.equal((await as(users.aadmin, 'DELETE', `/api/teams/${A.team}`, { confirm_slug: 'alpha' })).status, 403, 'admins cannot delete');
    assert.equal((await as(users.ua, 'DELETE', `/api/teams/${A.team}`, { confirm_slug: 'wrong' })).status, 400);
    const d = await as(users.ua, 'DELETE', `/api/teams/${A.team}`, { confirm_slug: 'alpha' });
    assert.equal(d.status, 200, d.text);
    assert.equal(Date.parse(d.body.purge_after) - Date.parse(fx.h.hub.iso()), 7 * 86_400_000);
    assert.equal(await sock.closed(), 4403);
    assert.ok(db.get('SELECT revoked_at FROM devices WHERE id = ?', dev).revoked_at);
    for (const path of [`/api/teams/${A.team}`, `/api/teams/${A.team}/members`, `/api/boards/${A.board}`, `/api/cards/${A.card}`]) {
      assert.equal((await as(users.ua, 'GET', path)).status, 404, path);
    }
    assert.ok(!(await as(users.ua, 'GET', '/api/account')).body.teams.some((t) => t.id === A.team));
    // S is still in B, and a new subscribe to A's board finds nothing.
    assert.deepEqual((await as(users.s, 'GET', '/api/account')).body.teams.map((t) => t.id), [fx.B.team]);
    const s2 = await fx.h.browser({ token: users.s.token });
    s2.send({ type: 'hello', protocol: 1 });
    await s2.next('welcome');
    s2.send({ type: 'subscribe', board_id: A.board });
    assert.equal((await s2.next('error')).code, 'NOT_FOUND');
    // The slug stays taken while the team waits for its purge.
    const again = await as(users.ua, 'POST', '/api/teams', { name: 'Alpha' });
    assert.equal(again.body.team.slug, 'alpha-2');
    assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action = 'team.delete' AND org_id = ?", A.team));
    await settle();
  } finally {
    await fx.h.close();
  }
});

test('account deletion soft-deletes the teams where the user was the only member', async () => {
  const h = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const a = await h.signIn('solo@example.com');
    const t = await h.call('POST', '/api/teams', { token: a.body.device_token, body: { name: 'Solo' } });
    await h.start('solo@example.com', { purpose: 'delete' }, { token: a.body.device_token });
    const flow = h.db.get("SELECT id FROM login_flows WHERE purpose = 'delete' ORDER BY created_at DESC LIMIT 1").id;
    await h.call('POST', '/api/auth/email/verify', { token: a.body.device_token, body: { flow_id: flow, code: h.codeFor('solo@example.com') } });
    const del = await h.call('DELETE', '/api/account', { token: a.body.device_token, body: { flow_id: flow } });
    assert.equal(del.status, 200, del.text);
    assert.ok(h.db.get('SELECT deleted_at FROM orgs WHERE id = ?', t.body.team.id).deleted_at);
  } finally {
    await h.close();
  }
});
