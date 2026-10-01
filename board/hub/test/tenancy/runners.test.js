// Accounts P4 runner enrolment (CONTRACT D79–D81, ACCOUNTS-DESIGN.md §6.4,
// §7.3): T-RUN-1…6, T-DISPATCH, rotation, caps, unenrol vs sign-out, restore.
// Two teams (tenancy fixture), runners as FakeRunner sockets that present
// `Authorization: Bearer brt_…` + `Board-Team`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { tenancy, MARK, INVARIANTS } from './fixture.js';
import { dumpDb } from '../accounts-helpers.js';
import { FakeRunner, settle, until } from '../helpers.js';
import { createLogger } from '../../log.js';
import { BAD_RUNNER_TOKEN, MAX_PER_USER, MAX_PER_USER_TEAM } from '../../identity/enrolments.js';
import { newDeviceToken } from '../../auth.js';
import { runAdmin } from '../../admin.js';
import { openDb } from '../../db.js';

const rid = () => randomUUID();

async function enrol(fx, u, team, body = {}) {
  const r = await fx.as(u, 'POST', `/api/teams/${team}/enrol`, body);
  assert.equal(r.status, 200, r.text);
  return r.body;
}

/** An enrolled runner socket: hello (device id learnt from welcome), then advertise its team's repo. */
async function runner(fx, token, team, repo) {
  const r = new FakeRunner(fx.h.base, { device_id: '', device_token: token, team });
  await r.open();
  await r.hello();
  if (repo) await r.advertise([{ repo_id: repo, approvals_from: [], auto_accept_from: [] }]);
  return r;
}

/** A refused upgrade: → {code, reason}. */
async function refused(fx, token, team) {
  const r = new FakeRunner(fx.h.base, { device_id: '', device_token: token, team });
  await r.open();
  const code = await r.closed();
  return { code, reason: r.closeReason };
}

async function card(fx, u, T, title) {
  const c = await fx.as(u, 'POST', `/api/boards/${T.board}/cards`, { request_id: rid(), title, repo_id: T.repo });
  assert.equal(c.status, 200, c.text);
  return c.body.card;
}

async function dispatch(fx, u, cardId, target) {
  const d = await fx.as(u, 'POST', `/api/cards/${cardId}/actions/dispatch`, { request_id: rid(), target_member_id: target, confirm: true });
  assert.equal(d.status, 200, d.text);
}

test('enrol: {enrollment_id, team_id, runner_token} once; the socket learns its device from welcome; the app stays signed in after unenrol', async () => {
  const fx = await tenancy();
  try {
    const { users, A } = fx;
    const e = await enrol(fx, users.amember, A.team, { device_name: 'Jo laptop' });
    assert.deepEqual(Object.keys(e).sort(), ['enrollment_id', 'runner_token', 'team_id']);
    assert.equal(e.team_id, A.team);
    assert.match(e.runner_token, /^brt_[A-Za-z0-9_-]{43}$/);
    const r = await runner(fx, e.runner_token, A.team, A.repo);
    const row = fx.db.get('SELECT * FROM runner_enrollments WHERE id = ?', e.enrollment_id);
    assert.equal(r.welcome.device_id, row.device_id);
    assert.equal(r.welcome.member_id, A.member);
    assert.deepEqual(r.welcome.allowlist.map((x) => x.repo_id), [A.repo], 'only team A\'s repo row, though B links the same URL');
    const dev = fx.db.get('SELECT * FROM devices WHERE id = ?', row.device_id);
    assert.equal(dev.member_id, A.member);
    assert.equal(dev.cf_service_token_id, null);
    assert.equal(dev.name, 'Jo laptop');
    const list = await fx.as(users.amember, 'GET', `/api/teams/${A.team}/enrolments`);
    assert.deepEqual(list.body.enrolments.map((x) => [x.id, x.online, x.current, x.user.id]), [[e.enrollment_id, true, true, users.amember.id]]);
    assert.ok(!list.text.includes(e.runner_token), 'shown once');
    // DELETE enrol: the runner goes (4403), the app does not.
    assert.equal((await fx.as(users.amember, 'DELETE', `/api/teams/${A.team}/enrol`, {})).status, 200);
    assert.equal(await r.closed(), 4403);
    assert.equal((await fx.as(users.amember, 'GET', '/api/account')).status, 200, 'still signed in');
    assert.equal((await refused(fx, e.runner_token, A.team)).code, 4401);
    assert.equal((await fx.as(users.amember, 'DELETE', `/api/teams/${A.team}/enrol`, {})).status, 404, 'nothing left to unenrol');
    // A cookie session can't enrol: it is the desktop app's install that runs cards.
    const web = await fx.h.webSignIn(users.amember.email);
    const viaCookie = await fx.h.call('POST', `/api/teams/${A.team}/enrol`, { cookie: web.cookie, body: {}, headers: { origin: fx.h.base, 'x-csrf-token': web.csrf } });
    assert.equal(viaCookie.status, 403);
  } finally {
    await fx.h.close();
  }
});

test('T-RUN-1 + T-DISPATCH: S enrolled in A and B gets each team\'s offers only on that team\'s socket; A\'s card offers only to the target\'s A runner', async () => {
  const fx = await tenancy();
  try {
    const { users, A, B } = fx;
    const sa = await runner(fx, (await enrol(fx, users.s, A.team)).runner_token, A.team, A.repo);
    const sb = await runner(fx, (await enrol(fx, users.s, B.team)).runner_token, B.team, B.repo);
    const ma = await runner(fx, (await enrol(fx, users.amember, A.team)).runner_token, A.team, A.repo);
    const oa = await runner(fx, (await enrol(fx, users.ua, A.team)).runner_token, A.team, A.repo);
    sb.send({ type: 'presence', sessions: [{ session_id: 's-b', agent: 'claude', repo_id: B.repo, state: 'working', since: '2026-09-30T10:00:00Z', summary: `${MARK} presence` }] });

    const cb = await card(fx, users.ub, B, `${MARK} for S`);
    await dispatch(fx, users.ub, cb.id, B.s);
    const offerB = await sb.next('offer', (o) => o.card_id === cb.id);
    assert.equal(offerB.repo_id, B.repo);
    const ca = await card(fx, users.ua, A, 'alpha for member');
    await dispatch(fx, users.ua, ca.id, A.member);
    await ma.next('offer', (o) => o.card_id === ca.id);
    const cs = await card(fx, users.ua, A, 'alpha for S');
    await dispatch(fx, users.ua, cs.id, A.s);
    await sa.next('offer', (o) => o.card_id === cs.id);
    await settle();
    assert.deepEqual(sa.all('offer').map((o) => o.card_id), [cs.id], 'S\'s A socket: only A\'s card for S');
    assert.deepEqual(sb.all('offer').map((o) => o.card_id), [cb.id], 'S\'s B socket: only B\'s card');
    assert.deepEqual(ma.all('offer').map((o) => o.card_id), [ca.id], 'the member\'s runner: only the card for them');
    assert.deepEqual(oa.all('offer'), [], 'the owner\'s runner: nothing (not the target)');
    for (const r of [sa, ma, oa]) {
      const text = JSON.stringify(r.msgs);
      assert.ok(!text.includes(MARK) && !text.includes(B.team) && !text.includes(B.board) && !text.includes(B.card) && !text.includes(B.repo) && !text.includes(cb.id), 'no B frame on an A runner');
    }
    // A claim works on the right socket.
    const res = await sb.claim(offerB);
    assert.equal(res.ok, true, JSON.stringify(res));
    for (const [name, sql] of Object.entries(INVARIANTS)) assert.deepEqual(fx.db.all(sql), [], name);
  } finally {
    await fx.h.close();
  }
});

test('T-RUN-2: a token with another team\'s Board-Team, no Board-Team, or an unknown token all get the same 4401', async () => {
  const fx = await tenancy();
  try {
    const { users, A, B } = fx;
    const e = await enrol(fx, users.s, A.team);
    const forged = `brt_${createHash('sha256').update(rid()).digest('base64url').slice(0, 43)}`;
    const answers = [await refused(fx, e.runner_token, B.team), await refused(fx, e.runner_token, undefined), await refused(fx, forged, A.team), await refused(fx, B.runnerToken, A.team)];
    for (const a of answers) assert.deepEqual(a, { code: 4401, reason: BAD_RUNNER_TOKEN });
    // S is a member of B too: still refused, the token is bound to A for life.
    const ok = await runner(fx, e.runner_token, A.team);
    assert.equal(ok.welcome.member_id, A.s);
  } finally {
    await fx.h.close();
  }
});

test('T-RUN-3: frames from an A runner that name B\'s card, run or repo are rejected and change none of B\'s rows', async () => {
  const fx = await tenancy();
  try {
    const { users, A, B } = fx;
    const sa = await runner(fx, (await enrol(fx, users.s, A.team)).runner_token, A.team, A.repo);
    const before = fx.snapshotB();
    const deviceId = sa.welcome.device_id;
    await sa.advertise([{ repo_id: B.repo, approvals_from: [], auto_accept_from: [] }]);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM runner_repos WHERE device_id = ? AND repo_id = ?', deviceId, B.repo).n, 0, 'B repo never advertised');
    const claim = await sa.claim({ card_id: B.card, request_id: rid(), fence: 1 });
    assert.equal(claim.ok, false);
    sa.send({ type: 'decline', card_id: B.card, request_id: rid() });
    const hb = await sa.hb([{ run_id: B.run, card_id: B.card, fence: 1, child_alive: true, tool_in_flight: null }]);
    assert.equal(hb.runs[0].current, false);
    const run = { run_id: B.run, card_id: B.card, fence: 1, repo_id: B.repo };
    await sa.out({ kind: 'activity', ...run, source: 'x' });
    await sa.out({ kind: 'comment.create', ...run, text: 'pwned' });
    sa.send({ type: 'salvage', ...run, kind: 'note', payload: { text: 'pwned' } });
    const rpc = await sa.rpc({ ...run, run_token: 'brt1.x.y' }, 'board_get_card');
    assert.equal(rpc.ok, false);
    await settle();
    assert.equal(fx.snapshotB(), before, "B's rows changed");
    assert.ok(!JSON.stringify(sa.msgs).includes(MARK));
  } finally {
    await fx.h.close();
  }
});

test('T-RUN-4 + T-RUN-5: revoke, removal, demotion to viewer, team deletion, account deletion, sign-out and a reaper-pass revoke each close the live runner socket', async () => {
  const fx = await tenancy();
  try {
    const { users, A, B, h } = fx;
    // A viewer cannot enrol.
    const v = await fx.as(users.aviewer, 'POST', `/api/teams/${A.team}/enrol`, {});
    assert.equal(v.status, 403);
    const cases = [];
    const open = async (u, T) => {
      const e = await enrol(fx, u, T.team);
      return { e, r: await runner(fx, e.runner_token, T.team, T.repo) };
    };
    // Revoked by an admin.
    const x1 = await open(users.amember, A);
    assert.equal((await fx.as(users.aadmin, 'DELETE', `/api/teams/${A.team}/enrolments/${x1.e.enrollment_id}`, {})).status, 200);
    cases.push(['admin revoke', x1.r, 4403]);
    // Demoted to viewer (and the enrolment answers 4403 while they stay one).
    const x2 = await open(users.aadmin, A);
    assert.equal((await fx.as(users.ua, 'PATCH', `/api/teams/${A.team}/members/${A.admin}`, { role: 'viewer' })).status, 200);
    cases.push(['demoted', x2.r, 4403]);
    // Removed from A: S's B runner stays.
    const x3 = await open(users.s, A);
    const sb = await open(users.s, B);
    assert.equal((await fx.as(users.ua, 'DELETE', `/api/teams/${A.team}/members/${A.s}`, {})).status, 200);
    cases.push(['removed', x3.r, 4403]);
    for (const [name, r, code] of cases) assert.equal(await r.closed(), code, name);
    await settle();
    assert.equal(sb.r.closeCode, null, 'S\'s B runner is untouched');
    assert.equal((await refused(fx, x2.e.runner_token, A.team)).code, 4403, 'a viewer\'s runner is refused');
    // A member (not admin) can remove only their own.
    const x4 = await open(users.ua, A);
    assert.equal((await fx.as(users.amember, 'DELETE', `/api/teams/${A.team}/enrolments/${x4.e.enrollment_id}`, {})).status, 403);
    // Signed out on that install: its runner goes too (4401), its enrolments are revoked.
    assert.equal((await fx.as(users.ua, 'POST', '/api/auth/signout', {})).status, 200);
    assert.equal(await x4.r.closed(), 4401);
    assert.ok(fx.db.get('SELECT revoked_at FROM runner_enrollments WHERE id = ?', x4.e.enrollment_id).revoked_at);
    // Account deletion.
    const x5 = await open(users.amember, A);
    const flow = await h.stepUp(users.amember.token, users.amember.email);
    assert.equal((await fx.as(users.amember, 'DELETE', '/api/account', { flow_id: flow })).status, 200);
    assert.ok([4401, 4403].includes(await x5.r.closed()));
    assert.equal(fx.db.get('SELECT name FROM runner_enrollments WHERE id = ?', x5.e.enrollment_id).name, 'Deleted device');
    // Team deletion.
    const del = await fx.as(users.ub, 'DELETE', `/api/teams/${B.team}`, { confirm_slug: fx.db.get('SELECT slug FROM orgs WHERE id = ?', B.team).slug, flow_id: await h.stepUp(users.ub.token, users.ub.email, 'delete_team') });
    assert.equal(del.status, 200, del.text);
    assert.equal(await sb.r.closed(), 4403);
    // The reaper backstop: a revoke written straight to the database.
    const x6 = await open(users.s, { team: A.team, repo: A.repo }).catch(() => null);
    assert.equal(x6, null, 'S was removed from A: no enrolment');
    const users2 = await h.signIn('late@alpha.test');
    const late = { token: users2.body.device_token };
    fx.addMember(A.team, { id: users2.body.user.id, email: 'late@alpha.test' }, 'member');
    const x7 = await open(late, A);
    h.db.run("UPDATE runner_enrollments SET revoked_at = ?, token_hash = NULL WHERE id = ?", h.hub.iso(), x7.e.enrollment_id);
    await h.hub.tick();
    assert.equal(await x7.r.closed(), 4403);
    assert.equal(h.hub.presence.byDevice.has(x7.r.welcome.device_id), false);
  } finally {
    await fx.h.close();
  }
});

test('T-RUN-6: the runner token is shown once, stored as sha256, and never in the DB, the logs or the audit', async () => {
  const lines = [];
  const fx = await tenancy({ log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) });
  try {
    const { users, A } = fx;
    const e = await enrol(fx, users.amember, A.team);
    const r = await runner(fx, e.runner_token, A.team, A.repo);
    await fx.as(users.amember, 'GET', `/api/teams/${A.team}/enrolments`);
    await fx.h.hub.tick();
    const dump = dumpDb(fx.db);
    assert.ok(!dump.includes(e.runner_token), 'no token in the DB');
    assert.ok(dump.includes(createHash('sha256').update(e.runner_token).digest('hex')), 'its sha256 is');
    assert.ok(!lines.join('\n').includes(e.runner_token), 'no token in the logs');
    assert.ok(!lines.join('\n').includes(e.runner_token.slice(4, 20)));
    assert.ok(!JSON.stringify(fx.db.all('SELECT * FROM audit')).includes(e.runner_token));
    assert.ok(fx.db.get("SELECT 1 AS x FROM audit WHERE action = 'runner.enrol' AND target = ?", e.enrollment_id));
    r.terminate();
  } finally {
    await fx.h.close();
  }
});

test('rotation: enrolling the same install again revokes the old token at once and keeps the runner device (outbox seq)', async () => {
  const fx = await tenancy();
  try {
    const { users, A } = fx;
    const e1 = await enrol(fx, users.amember, A.team);
    const r1 = await runner(fx, e1.runner_token, A.team, A.repo);
    const e2 = await enrol(fx, users.amember, A.team);
    assert.notEqual(e2.runner_token, e1.runner_token);
    assert.equal(await r1.closed(), 4403);
    assert.equal((await refused(fx, e1.runner_token, A.team)).code, 4401, 'the old token is unknown now');
    const r2 = await runner(fx, e2.runner_token, A.team, A.repo);
    assert.equal(r2.welcome.device_id, r1.welcome.device_id, 'same runner device');
    const rows = fx.db.all('SELECT revoked_reason FROM runner_enrollments WHERE member_id = ? ORDER BY created_at', A.member).map((x) => x.revoked_reason);
    assert.deepEqual(rows, ['rotated', null]);
  } finally {
    await fx.h.close();
  }
});

test('caps: 5 installs per person per team, 20 enrolments per person; restore closes and refuses runner tokens (device epoch)', async () => {
  const fx = await tenancy();
  try {
    const { users, A, h } = fx;
    const installs = [users.amember];
    for (let i = 0; i < MAX_PER_USER_TEAM; i++) {
      h.clock.advance(6 * 60_000);   // the per-mailbox start limit (3 / 15 min)
      installs.push({ token: (await h.signIn(users.amember.email)).body.device_token });
    }
    for (let i = 0; i < MAX_PER_USER_TEAM; i++) await enrol(fx, installs[i], A.team);
    const sixth = await fx.as(installs[MAX_PER_USER_TEAM], 'POST', `/api/teams/${A.team}/enrol`, {});
    assert.equal(sixth.status, 403);
    assert.deepEqual(sixth.body.error, { code: 'QUOTA_EXCEEDED', message: sixth.body.error.message, resource: 'runner_enrollments', limit: MAX_PER_USER_TEAM });
    assert.equal((await fx.as(installs[0], 'POST', `/api/teams/${A.team}/enrol`, {})).status, 200, 'rotating one of the five is fine');

    // 20 across teams: fill with rows in other teams, straight into the DB.
    const now = h.hub.iso();
    const ud = users.s.device_id;
    for (let i = 0; i < MAX_PER_USER; i++) {
      const org = rid();
      const mem = rid();
      const dev = rid();
      h.db.insert('orgs', { id: org, name: `T${i}`, created_at: now });
      h.db.run("INSERT INTO members (id, org_id, user_id, role, display_name, email, github_login, github_id, created_at) VALUES (?, ?, ?, 'member', 's', NULL, ?, ?, ?)", mem, org, users.s.id, `x-${mem}`, -(i + 1000), now);
      h.db.insert('devices', { id: dev, member_id: mem, name: 'x', kind: 'runner', token_hash: `enrolment:${rid()}`, created_at: now });
      h.db.insert('runner_enrollments', { id: rid(), org_id: org, user_id: users.s.id, user_device_id: ud, member_id: mem, device_id: dev, name: 'x', token_hash: rid(), session_epoch: 1, created_at: now });
    }
    const over = await fx.as(users.s, 'POST', `/api/teams/${A.team}/enrol`, {});
    assert.equal(over.status, 403);
    assert.equal(over.body.error.limit, MAX_PER_USER);

    // Restore: the epoch moves, every runner token dies with the device tokens.
    const e = await enrol(fx, users.ua, A.team);
    const r = await runner(fx, e.runner_token, A.team, A.repo);
    h.db.setMeta('session_epoch', Number(h.db.meta('session_epoch')) + 1);
    await h.hub.tick();
    assert.equal(await r.closed(), 4401);
    assert.equal((await refused(fx, e.runner_token, A.team)).code, 4401);
  } finally {
    await fx.h.close();
  }
});

test('H1: accounts mode refuses legacy runner device tokens (the same 4401 as an unknown runner token) and has no POST /api/devices; admin.js revoke-legacy-devices cleans up', async () => {
  const fx = await tenancy();
  const config = fx.h.app.config;
  let legacyId;
  let enrolledDevice;
  try {
    const { users, A, h } = fx;
    const mint = await fx.as(users.amember, 'POST', '/api/devices', { request_id: rid(), name: 'legacy' }, { 'x-board-team': A.team });
    assert.equal(mint.status, 404);
    assert.equal(mint.body.error.code, 'NOT_FOUND');
    // A device token minted before the cutover (Access era, or this branch before H1).
    const token = newDeviceToken();
    legacyId = rid();
    h.db.insert('devices', { id: legacyId, member_id: A.member, name: 'old laptop', kind: 'runner', token_hash: createHash('sha256').update(token).digest('hex'), created_at: h.hub.iso() });
    const legacy = new FakeRunner(h.base, { device_id: legacyId, device_token: token });
    await legacy.open();
    assert.deepEqual({ code: await legacy.closed(), reason: legacy.closeReason }, { code: 4401, reason: BAD_RUNNER_TOKEN });
    const withTeam = new FakeRunner(h.base, { device_id: legacyId, device_token: token, team: A.team });
    await withTeam.open();
    assert.deepEqual({ code: await withTeam.closed(), reason: withTeam.closeReason }, { code: 4401, reason: BAD_RUNNER_TOKEN });
    assert.deepEqual(await refused(fx, undefined, A.team), { code: 4401, reason: BAD_RUNNER_TOKEN }, 'a garbage Bearer');
    assert.deepEqual(await refused(fx, users.amember.token, A.team), { code: 4401, reason: BAD_RUNNER_TOKEN }, 'the app device token is not a runner token');
    // Listing and revoking legacy devices still work for cleanup.
    assert.ok((await fx.as(users.amember, 'GET', '/api/devices', undefined, { 'x-board-team': A.team })).body.devices.some((d) => d.id === legacyId));
    const e = await enrol(fx, users.amember, A.team);
    enrolledDevice = fx.db.get('SELECT device_id FROM runner_enrollments WHERE id = ?', e.enrollment_id).device_id;
  } finally {
    await fx.h.close();
  }
  const out = [];
  const err = [];
  assert.equal(runAdmin(['revoke-legacy-devices'], { config, out: (x) => out.push(x), err: (x) => err.push(x) }), 0, err.join('\n'));
  const res = JSON.parse(out[0]);
  assert.equal(res.ok, true);
  assert.ok(res.revoked >= 2, 'the fixture\'s B device and the legacy one');
  assert.ok(res.enrolled_kept >= 2, 'enrolment devices are kept');
  const db = openDb(config.dbPath);
  try {
    assert.ok(db.get('SELECT revoked_at FROM devices WHERE id = ?', legacyId).revoked_at);
    assert.equal(db.get('SELECT revoked_at FROM devices WHERE id = ?', enrolledDevice).revoked_at, null);
    assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action = 'device.revoke_legacy'"));
  } finally {
    db.close();
  }
  assert.equal(runAdmin(['revoke-legacy-devices'], { config: { ...config, auth: 'dev' }, out: () => {}, err: () => {} }), 2, 'accounts mode only');
});
