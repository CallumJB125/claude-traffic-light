// Accounts P3 (ACCOUNTS-API.md "Invites", CONTRACT D64–D65): email binding,
// expiry, single use, revoke, resend, role ceiling, the fragment flow and
// preview, generic errors, pending invites, caps and rate limits, mail text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { tenancy, ROOMY } from './tenancy/fixture.js';
import { dumpDb } from './accounts-helpers.js';
import { mailName } from '../identity/invites.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;
const tokenOf = (link) => link.split('#')[1];

async function setup(opts) {
  const fx = await tenancy(opts);
  const invite = (u, email, role = 'member', team = fx.A.team) => fx.as(u, 'POST', `/api/teams/${team}/invites`, { email, role });
  const preview = (t) => fx.h.call('POST', '/api/invites/preview', { body: { t } });
  const accept = (u, body) => fx.as(u, 'POST', '/api/invites/accept', body);
  const newUser = async (email) => {
    const r = await fx.h.signIn(email);
    return { id: r.body.user.id, email, token: r.body.device_token };
  };
  return { ...fx, invite, preview, accept, newUser };
}

test('invite → mail with a fragment link → preview (3 fields, no address) → accept by the verified address; single use', async () => {
  const fx = await setup();
  try {
    const { h, users, A } = fx;
    const r = await fx.invite(users.ua, 'Jo@Example.com', 'member');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.body).sort(), ['code', 'invite', 'link', 'mailed']);
    assert.equal(r.body.mailed, true);
    assert.deepEqual(Object.keys(r.body.invite).sort(), ['email', 'expires_at', 'id', 'role']);
    assert.equal(r.body.invite.email, 'jo@example.com');
    assert.equal(Date.parse(r.body.invite.expires_at) - Date.parse(h.hub.iso()), 7 * DAY);
    const t = tokenOf(r.body.link);
    assert.match(r.body.link, new RegExp(`^${h.base}/invite#inv_[A-Za-z0-9_-]{43}$`), 'token only in the fragment');
    const row = h.db.get('SELECT * FROM invites WHERE id = ?', r.body.invite.id);
    assert.equal(row.token_hash, sha(t));
    assert.ok(!dumpDb(h.db).includes(t), 'the token is stored nowhere');

    const mail = h.mailer.last('jo@example.com');
    assert.equal(mail.subject, 'owner invited you to Alpha on Plexiform');
    assert.ok(mail.text.includes(r.body.link));
    assert.match(mail.text, /as a member/);
    assert.ok(mail.text.includes(`enter this code: ${r.body.code}`), 'the mail carries the code the inviter was shown');
    assert.match(mail.text, /expires on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    assert.match(mail.text, /only for jo@example\.com/);
    assert.match(mail.text, /Ignore it to decline/);
    assert.ok(!dumpDb(h.db).includes(/code: (\S+)/.exec(mail.text)[1].replace('-', '')), 'the code is stored nowhere');

    const p = await fx.preview(t);
    assert.equal(p.status, 200);
    assert.deepEqual(p.body, { team_name: 'Alpha', inviter_first_name: 'owner', role: 'member' });

    const jo = await fx.newUser('jo@example.com');
    const pend = (await fx.as(jo, 'GET', '/api/account')).body.pending_invites;
    assert.deepEqual(pend, [{ id: r.body.invite.id, team_name: 'Alpha', inviter_first_name: 'owner', role: 'member', expires_at: r.body.invite.expires_at }]);
    const ok = await fx.accept(jo, { t });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.team.id, A.team);
    assert.equal(ok.body.member.role, 'member');
    const acct = (await fx.as(jo, 'GET', '/api/account')).body;
    assert.ok(acct.teams.some((x) => x.id === A.team && x.role === 'member'));
    assert.deepEqual(acct.pending_invites, []);
    assert.equal((await fx.as(jo, 'GET', `/api/boards/${A.board}`)).status, 200);
    // The inviter hears about it.
    const note = h.mailer.last('owner@alpha.test');
    assert.equal(note.subject, 'jo joined Alpha on Plexiform');
    assert.match(note.text, /jo@example\.com/);
    // Same user again: same answer. Anyone else, and preview: the generic error.
    const again = await fx.accept(jo, { t });
    assert.deepEqual([again.status, again.body.member.member_id], [200, ok.body.member.member_id]);
    assert.equal((await fx.accept(users.n, { t })).body.error.code, 'INVALID_TOKEN');
    assert.equal((await fx.preview(t)).body.error.code, 'INVALID_TOKEN');
    assert.throws(() => h.db.run("UPDATE invites SET accepted_at = 'x' WHERE id = ?", r.body.invite.id), /invite already used/);
    const audit = h.db.all('SELECT action FROM audit WHERE target = ?', r.body.invite.id).map((x) => x.action);
    assert.deepEqual(audit, ['invite.create', 'invite.accept']);
  } finally {
    await fx.h.close();
  }
});

test('email binding: a valid token for another address → WRONG_ACCOUNT naming no address; an unverified match is refused too', async () => {
  const fx = await setup();
  try {
    const r = await fx.invite(fx.users.ua, 'carol@example.com');
    const t = tokenOf(r.body.link);
    const w = await fx.accept(fx.users.n, { t });
    assert.deepEqual([w.status, w.body.error.code, w.body.error.email_masked], [403, 'WRONG_ACCOUNT', undefined]);
    assert.ok(!w.text.includes('carol@') && !w.text.includes('c•••'));
    const carol = await fx.newUser('carol@example.com');
    fx.h.db.run('UPDATE users SET primary_email_verified_at = NULL WHERE id = ?', carol.id);
    fx.h.db.run('UPDATE identities SET email_verified = 0 WHERE user_id = ?', carol.id);
    assert.equal((await fx.accept(carol, { t })).body.error.code, 'WRONG_ACCOUNT');
    assert.deepEqual((await fx.as(carol, 'GET', '/api/account')).body.pending_invites, [], 'no pending invites without a verified address');
    // Not signed in at all: 401.
    assert.equal((await fx.h.call('POST', '/api/invites/accept', { body: { t } })).status, 401);
  } finally {
    await fx.h.close();
  }
});

test('generic errors: garbage, unknown, used, expired, withdrawn and deleted-team tokens all answer the same', async () => {
  const fx = await setup();
  try {
    const { users, A } = fx;
    const bodies = [];
    const both = async (t) => {
      const p = await fx.preview(t);
      const a = await fx.accept(users.n, { t });
      assert.deepEqual([p.status, a.status], [400, 400], String(t));
      bodies.push(JSON.stringify(p.body), JSON.stringify(a.body));
    };
    await both('garbage');
    await both(`inv_${'A'.repeat(43)}`);
    await both(12);
    const used = await fx.invite(users.ua, 'used@example.com');
    await fx.accept(await fx.newUser('used@example.com'), { t: tokenOf(used.body.link) });
    await both(tokenOf(used.body.link));
    const withdrawn = await fx.invite(users.ua, 'w@example.com');
    assert.equal((await fx.as(users.ua, 'DELETE', `/api/teams/${A.team}/invites/${withdrawn.body.invite.id}`, {})).status, 200);
    assert.equal((await fx.as(users.ua, 'DELETE', `/api/teams/${A.team}/invites/${withdrawn.body.invite.id}`, {})).status, 404, 'already withdrawn');
    await both(tokenOf(withdrawn.body.link));
    const expired = await fx.invite(users.ua, 'late@example.com');
    fx.h.clock.advance(7 * DAY + 1);
    await both(tokenOf(expired.body.link));
    const bTok = fx.B.inviteToken;
    const slug = fx.db.get('SELECT slug FROM orgs WHERE id = ?', fx.B.team).slug;
    assert.equal((await fx.as(users.ub, 'DELETE', `/api/teams/${fx.B.team}`, { confirm_slug: slug, flow_id: await fx.h.stepUp(users.ub.token, users.ub.email, 'delete_team') })).status, 200);
    assert.ok(fx.db.get('SELECT revoked_at FROM invites WHERE id = ?', fx.B.invite).revoked_at, 'team deletion withdraws its invites');
    await both(bTok);
    assert.equal(new Set(bodies).size, 1, 'one identical answer');
    // Preview is POST only: a GET with the token never exists.
    assert.equal((await fx.h.call('GET', `/api/invites/preview?t=${bTok}`)).status, 404);
  } finally {
    await fx.h.close();
  }
});

test('resend mints a new token and kills the old one; the list shows pending invites without tokens', async () => {
  const fx = await setup();
  try {
    const { users, A, h } = fx;
    const r = await fx.invite(users.aadmin, 'dee@example.com', 'viewer');
    const old = tokenOf(r.body.link);
    const s = await fx.as(users.aadmin, 'POST', `/api/teams/${A.team}/invites/${r.body.invite.id}/resend`, {});
    assert.equal(s.status, 200, s.text);
    assert.notEqual(s.body.invite.id, r.body.invite.id);
    assert.equal(s.body.invite.role, 'viewer');
    const fresh = tokenOf(s.body.link);
    assert.notEqual(fresh, old);
    assert.equal((await fx.preview(old)).body.error.code, 'INVALID_TOKEN');
    assert.equal((await fx.preview(fresh)).status, 200);
    assert.ok(h.mailer.last('dee@example.com').text.includes(s.body.link));
    const list = await fx.as(users.ua, 'GET', `/api/teams/${A.team}/invites`);
    assert.deepEqual(list.body.invites.map((i) => [i.id, i.email, i.role, i.created_by_name]), [[s.body.invite.id, 'dee@example.com', 'viewer', 'admin']]);
    assert.ok(!list.text.includes('hash') && !list.text.includes('inv_'));
    assert.equal((await fx.as(users.amember, 'GET', `/api/teams/${A.team}/invites`)).status, 403);
    assert.equal((await fx.as(users.ua, 'POST', `/api/teams/${A.team}/invites/${r.body.invite.id}/resend`, {})).status, 404, 'the replaced one is gone');
    assert.equal((await fx.as(users.ua, 'GET', `/api/teams/${A.team}`)).body.counts.pending_invites, 1);
    assert.deepEqual(h.db.all('SELECT action FROM audit WHERE action LIKE ? ORDER BY id', 'invite.%').map((x) => x.action), ['invite.create', 'invite.create', 'invite.resend']);
    // An expired invite can be resent too.
    h.clock.advance(8 * DAY);
    const s2 = await fx.as(users.ua, 'POST', `/api/teams/${A.team}/invites/${s.body.invite.id}/resend`, {});
    assert.equal(s2.status, 200, s2.text);
  } finally {
    await fx.h.close();
  }
});

test('role ceiling: only owners and admins invite, never above their own role, never as owner', async () => {
  const fx = await setup();
  try {
    const { users } = fx;
    const st = async (u, role) => (await fx.invite(u, `${randomUUID().slice(0, 8)}@example.com`, role)).status;
    assert.deepEqual([await st(users.ua, 'admin'), await st(users.ua, 'member'), await st(users.ua, 'viewer'), await st(users.ua, 'owner')], [200, 200, 200, 403]);
    assert.deepEqual([await st(users.aadmin, 'admin'), await st(users.aadmin, 'viewer'), await st(users.aadmin, 'owner')], [200, 200, 403]);
    assert.deepEqual([await st(users.amember, 'member'), await st(users.aviewer, 'viewer')], [403, 403]);
    assert.equal(await st(users.ua, 'superuser'), 400);
    assert.equal((await fx.invite(users.ua, 'not-an-address')).status, 400);
    // The member an admin invite makes is exactly that role.
    const r = await fx.invite(users.aadmin, 'ada@example.com', 'admin');
    const ada = await fx.newUser('ada@example.com');
    assert.equal((await fx.accept(ada, { t: tokenOf(r.body.link) })).body.member.role, 'admin');
  } finally {
    await fx.h.close();
  }
});

test('ALREADY_MEMBER on invite and on accept; CONFLICT for a second pending invite; re-joining reuses the old member row', async () => {
  const fx = await setup();
  try {
    const { users, A } = fx;
    const dup = await fx.invite(users.ua, 'member@alpha.test');
    assert.deepEqual([dup.status, dup.body.error.code, dup.body.error.team], [409, 'ALREADY_MEMBER', { id: A.team, name: 'Alpha' }]);
    const r1 = await fx.invite(users.ua, 'eve@example.com');
    const c = await fx.invite(users.aadmin, 'EVE@example.com');
    assert.deepEqual([c.status, c.body.error.code, c.body.error.invite_id], [409, 'CONFLICT', r1.body.invite.id]);
    // Eve joins through a second team's invite path first, then holds A's token while already in A.
    const eve = await fx.newUser('eve@example.com');
    fx.addMember(A.team, eve, 'viewer');
    const a = await fx.accept(eve, { t: tokenOf(r1.body.link) });
    assert.deepEqual([a.status, a.body.error.code, a.body.error.team.id], [409, 'ALREADY_MEMBER', A.team]);
    assert.deepEqual((await fx.as(eve, 'GET', '/api/account')).body.pending_invites, [], 'not listed for a team you are in');

    // Removed, then invited back: the same member row, active again, with the new role.
    const oldId = A.member;
    assert.equal((await fx.as(users.ua, 'DELETE', `/api/teams/${A.team}/members/${oldId}`, {})).status, 200);
    const back = await fx.invite(users.ua, 'member@alpha.test', 'viewer');
    const ok = await fx.accept(users.amember, { t: tokenOf(back.body.link) });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.body.member.member_id, ok.body.member.role], [oldId, 'viewer']);
  } finally {
    await fx.h.close();
  }
});

test('pending_invites, and accepting without the token: by invite_id (body or URL) or by the short code, only for your own address', async () => {
  const fx = await setup();
  try {
    const { users, A, h } = fx;
    const fin = await fx.newUser('fin@example.com');
    const r = await fx.invite(users.ua, 'fin@example.com', 'viewer');
    const id = r.body.invite.id;
    // Someone else's id or code: the generic error, nothing about the invite.
    for (const u of [users.n, users.ub]) {
      const x = await fx.accept(u, { invite_id: id });
      assert.deepEqual([x.status, x.body.error.code], [400, 'INVALID_TOKEN']);
      assert.ok(!x.text.includes('fin'));
      assert.equal((await fx.as(u, 'POST', `/api/account/invites/${id}/accept`, {})).body.error.code, 'INVALID_TOKEN');
    }
    const code = /code: (\S+)/.exec(h.mailer.last('fin@example.com').text)[1];
    assert.equal((await fx.accept(users.n, { code })).body.error.code, 'INVALID_TOKEN');
    assert.equal((await fx.accept(fin, { code: 'BBBB-BBBB' })).body.error.code, 'INVALID_TOKEN');
    assert.equal((await fx.accept(fin, {})).status, 400);
    const ok = await fx.accept(fin, { code: code.toLowerCase() });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.team.id, A.team);

    const gus = await fx.newUser('gus@example.com');
    const r2 = await fx.invite(users.ua, 'gus@example.com');
    const viaUrl = await fx.as(gus, 'POST', `/api/account/invites/${r2.body.invite.id}/accept`, {});
    assert.equal(viaUrl.status, 200, viaUrl.text);
    const hal = await fx.newUser('hal@example.com');
    const r3 = await fx.invite(users.ua, 'hal@example.com');
    assert.equal((await fx.accept(hal, { invite_id: r3.body.invite.id })).status, 200);
    // Web cookie sessions accept too (with the CSRF token).
    const r4 = await fx.invite(users.ua, 'ivy@example.com');
    const web = await h.webSignIn('ivy@example.com');
    const wa = await h.call('POST', '/api/invites/accept', { cookie: web.cookie, headers: { origin: h.base, 'x-csrf-token': web.csrf }, body: { t: tokenOf(r4.body.link) } });
    assert.equal(wa.status, 200, wa.text);
  } finally {
    await fx.h.close();
  }
});

test('caps: 25 members counting pending invites; rate limits per team, per user, per IP; preview and accept per IP', async () => {
  const fx = await setup({ config: { rateLimits: { ...ROOMY, invite_team: { capacity: 1000, per_ms: DAY }, invite_user: { capacity: 1000, per_ms: DAY }, invite_ip: { capacity: 1000, per_ms: DAY } } } });
  try {
    const { users, A } = fx;
    const inA = fx.db.get('SELECT COUNT(*) AS n FROM members WHERE org_id = ? AND removed_at IS NULL', A.team).n;
    for (let i = inA; i < 25; i++) assert.equal((await fx.invite(users.ua, `p${i}@example.com`)).status, 200, `invite ${i}`);
    const over = await fx.invite(users.ua, 'one-too-many@example.com');
    assert.deepEqual([over.status, over.body.error.code, over.body.error.resource, over.body.error.limit], [403, 'QUOTA_EXCEEDED', 'members', 25]);
  } finally {
    await fx.h.close();
  }
  const fx2 = await setup();
  try {
    const { users, A } = fx2;
    fx2.db.run("UPDATE orgs SET plan = 'pro' WHERE id = ?", A.team);   // members cap out of the way
    let st = 200;
    let n = 0;
    while (st === 200 && n < 25) st = (await fx2.invite(users.ua, `r${n++}@example.com`)).status;
    assert.equal(st, 429, 'invite_team: 20 a day');
    assert.equal(n, 21);
  } finally {
    await fx2.h.close();
  }
  const fx3 = await setup();
  try {
    let last;
    for (let i = 0; i < 31; i++) last = await fx3.preview(`inv_${'B'.repeat(43)}`);
    assert.equal(last.status, 429);
    let acc;
    for (let i = 0; i < 31; i++) acc = await fx3.accept(fx3.users.n, { t: 'x' });
    assert.equal(acc.status, 429);
  } finally {
    await fx3.h.close();
  }
});

test('mail text: team and inviter names are plain, one-line, link-free; only the hub link is a link', async () => {
  const fx = await setup();
  try {
    const { users, h, A } = fx;
    h.db.run('UPDATE orgs SET name = ? WHERE id = ?', 'Evil <b>Co</b> http://phish.example/login "x"', A.team);
    h.db.run('UPDATE members SET display_name = ? WHERE id = ?', 'Mal\nlory‮ visit evil.com', fx.A.owner);
    const r = await fx.invite(users.ua, 'kai@example.com');
    const m = h.mailer.last('kai@example.com');
    assert.ok(!/[<>]/.test(m.subject + m.text.replace(r.body.link, '')), 'no angle brackets');
    assert.ok(!m.text.includes('http://phish'), 'no foreign link');
    assert.ok(!m.text.includes('evil.com'), 'no bare domain');
    assert.ok(!m.text.includes('‮'));
    assert.ok(!/\n/.test(m.subject));
    const links = m.text.match(/https?:\/\/\S+/g);
    assert.deepEqual(links, [r.body.link]);
    assert.equal(mailName('a'.repeat(100)).length, 60);
    assert.equal(mailName(''), 'Someone');
    // Preview answers with the inviter's first name only.
    assert.equal((await fx.preview(tokenOf(r.body.link))).body.inviter_first_name, 'Mal');
  } finally {
    await fx.h.close();
  }
});

test('removing an inviter withdraws the invites they sent that nobody used', async () => {
  const fx = await setup();
  try {
    const { users, A } = fx;
    const r = await fx.invite(users.aadmin, 'lee@example.com');
    assert.equal((await fx.as(users.ua, 'DELETE', `/api/teams/${A.team}/members/${A.admin}`, {})).status, 200);
    assert.equal(fx.db.get('SELECT revoke_reason FROM invites WHERE id = ?', r.body.invite.id).revoke_reason, 'inviter_removed');
    assert.equal((await fx.preview(tokenOf(r.body.link))).body.error.code, 'INVALID_TOKEN');
  } finally {
    await fx.h.close();
  }
});

test('the /invite page: served with no-referrer, reads the fragment, tries plexiform://, claudebuddy:// only on a click; /download follows BOARD_DOWNLOAD_URL', async () => {
  const fx = await setup({ config: { webDir: new URL('../../web', import.meta.url).pathname, downloadUrl: 'https://downloads.example.com/Plexiform.dmg' } });
  try {
    const { h } = fx;
    const page = await fetch(`${h.base}/invite`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const html = await page.text();
    assert.match(html, /<title>Invite · Plexiform<\/title>/);
    assert.match(html, /src="\/web\/js\/invite\.js"/);
    assert.match(html, /href="\/download"/);
    assert.match(html, /right-click/);
    assert.match(html, /click your invite link in the email again/);
    assert.ok(!/Buddy/.test(html.replace('Open with older Buddy', '')), 'the old name only on the button for older builds');
    const js = await (await fetch(`${h.base}/web/js/invite.js`)).text();
    assert.match(js, /location\.hash/);
    assert.match(js, /replaceState/);
    assert.match(js, /\/api\/invites\/preview/);
    assert.match(js, /deepLinkScheme[\s\S]*legacyDeepLinkScheme/);
    assert.match(html, /id="open-legacy"/);
    const brand = await (await fetch(`${h.base}/shared/brand.js`)).text();
    assert.match(brand, /deepLinkScheme: 'plexiform'/);
    assert.match(brand, /legacyDeepLinkScheme: 'claudebuddy'/);
    const dl = await fetch(`${h.base}/download`, { redirect: 'manual' });
    assert.deepEqual([dl.status, dl.headers.get('location')], [302, 'https://downloads.example.com/Plexiform.dmg']);
  } finally {
    await fx.h.close();
  }
});

test('L4: an invite stops working when its inviter may no longer invite as that role (demoted or removed)', async () => {
  const fx = await setup();
  try {
    const { users, A } = fx;
    const inv = await fx.invite(users.aadmin, 'late@example.com', 'admin');
    assert.equal(inv.status, 200, inv.text);
    assert.equal((await fx.as(users.ua, 'PATCH', `/api/teams/${A.team}/members/${A.admin}`, { role: 'member' })).status, 200);
    const t = tokenOf(inv.body.link);
    assert.equal((await fx.preview(t)).body.error.code, 'INVALID_TOKEN');
    const late = await fx.newUser('late@example.com');
    const r = await fx.accept(late, { t });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_TOKEN');
    assert.equal(fx.db.get('SELECT 1 AS x FROM members WHERE org_id = ? AND user_id = ?', A.team, late.id), null);
    // Restored to admin: the invite works again (it was never withdrawn).
    assert.equal((await fx.as(users.ua, 'PATCH', `/api/teams/${A.team}/members/${A.admin}`, { role: 'admin' })).status, 200);
    assert.equal((await fx.accept(late, { t })).status, 200);
  } finally {
    await fx.h.close();
  }
});

test('L8: a GitHub identity never proves an address, even with its email_verified flag set', async () => {
  const fx = await setup();
  try {
    const { users, db, h } = fx;
    const x = await fx.newUser('x@example.com');
    db.insert('identities', { id: randomUUID(), user_id: x.id, provider: 'github', subject: '987654', email: 'victim@example.com', email_verified: 1, created_at: h.hub.iso() });
    const inv = await fx.invite(users.ua, 'victim@example.com', 'member');
    assert.equal((await fx.accept(x, { invite_id: inv.body.invite.id })).body.error.code, 'INVALID_TOKEN');
    assert.equal((await fx.accept(x, { t: tokenOf(inv.body.link) })).body.error.code, 'WRONG_ACCOUNT');
    assert.deepEqual((await fx.as(x, 'GET', '/api/account')).body.pending_invites, []);
    // Signing in as that address is someone else (a new user), never x.
    const v = await fx.newUser('victim@example.com');
    assert.notEqual(v.id, x.id);
    // An Access-era member row with that address links to the prover, not to x.
    const m = randomUUID();
    db.insert('members', { id: m, org_id: fx.A.team, role: 'member', display_name: 'V', email: 'victim@example.com', github_login: '~email:v', github_id: -777, created_at: h.hub.iso() });
    h.hub.accounts.linkMembers(v.id, 'victim@example.com');
    assert.equal(db.get('SELECT user_id FROM members WHERE id = ?', m).user_id, v.id);
  } finally {
    await fx.h.close();
  }
});
