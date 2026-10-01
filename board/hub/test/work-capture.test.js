// Actual account and embedded local HTTP. No models, transcripts or user config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tenancy } from './tenancy/fixture.js';
import { createApp } from '../app.js';
import { testConfig, fakeClock, fakeGitHub } from './helpers.js';
import { silentLogger } from '../log.js';
import { WorkCapture } from '../work-capture.js';
import { dumpDb, startAccounts } from './accounts-helpers.js';

const observation = (repo, extra = {}) => ({ install_id: randomUUID(), provider: 'codex', session_id: 'session-123', task_id: 'task-456', repo_id: repo,
  title: 'Observed work', status: 'working', ...extra });
async function rig(t, options) { const f = await tenancy(options); t.after(() => f.h.close()); return f; }
const path = (board) => `/api/boards/${board}/work-capture`;
const snapshot = (f) => JSON.stringify(['cards', 'work_capture_cards', 'journal', 'dispatches', 'runs', 'comments'].map((name) => f.db.all(`SELECT * FROM ${name}`)));

test('current account catalog returns exact eligible metadata for every team and admits no guests', async (t) => {
  const f = await rig(t);
  const result = await f.as(f.users.s, 'GET', '/api/work-capture/routes');
  assert.equal(result.status, 200, result.text); assert.equal(result.body.complete, true); assert.equal(result.body.truncated, false);
  assert.deepEqual(new Set(result.body.routes.map((r) => r.board_id)), new Set([f.A.board, f.B.board]));
  assert.ok(result.body.routes.every((r) => r.canonical_url === 'github.com/shared/app' && r.role === 'member' && r.team_name && r.board_name));
  assert.ok(!JSON.stringify(result.body).includes('@')); assert.ok(!JSON.stringify(result.body).includes('device_token'));
  assert.equal((await f.as(f.users.bguest, 'GET', '/api/work-capture/routes')).body.routes.length, 0);
  assert.equal((await f.as(f.users.n, 'GET', '/api/work-capture/routes')).body.routes.length, 0);
  f.db.run('UPDATE boards SET archived_at=? WHERE id=?', f.h.hub.iso(), f.B.board);
  assert.deepEqual((await f.as(f.users.s, 'GET', '/api/work-capture/routes')).body.routes.map((r) => r.board_id), [f.A.board]);
  f.db.run('UPDATE members SET removed_at=? WHERE id=?', f.h.hub.iso(), f.A.s);
  assert.equal((await f.as(f.users.s, 'GET', '/api/work-capture/routes')).body.routes.length, 0);
});

test('reports create one ordinary In Progress card with no run, authority, automatic Done or duplicate', async (t) => {
  const f = await rig(t), body = observation(f.A.repo), before = f.db.get('SELECT COUNT(*) AS n FROM runs').n;
  const first = await f.as(f.users.amember, 'POST', path(f.A.board), body);
  assert.equal(first.status, 200, first.text); const id = first.body.card.id;
  assert.equal(first.body.card.column, 'in_progress'); assert.equal(first.body.card.run, null); assert.equal(first.body.card.live, null);
  assert.equal(first.body.capture.provider_verified, false); assert.equal(first.body.capture.verified_run, false); assert.equal(first.body.capture.grants_execution, false);
  assert.equal(first.body.capture.status, 'working'); assert.equal(f.h.hub.card(id).run_state, null);
  const retry = await f.as(f.users.amember, 'POST', path(f.A.board), body);
  assert.equal(retry.status, 200); assert.equal(retry.body.card.id, id); assert.equal(retry.headers.get('board-replayed'), null);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM work_capture_cards').n, 1);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM runs').n, before);
  for (const status of ['waiting', 'idle', 'review', 'ended']) {
    const r = await f.as(f.users.amember, 'POST', path(f.A.board), { ...body, status }); assert.equal(r.status, 200, r.text);
    assert.equal(r.body.card.column, ['review', 'ended'].includes(status) ? 'in_review' : 'in_progress'); assert.equal(r.body.card.run, null);
  }
  f.h.clock.advance(60_001);
  const stale = await f.as(f.users.amember, 'GET', `/api/cards/${id}`);
  assert.equal(stale.body.card.capture.status, 'unknown'); assert.equal(stale.body.card.capture.fresh, false);
  assert.equal(stale.body.card.capture.reported_status, 'ended');
});

test('destination is pinned across team memberships and concurrent different-board first reports have one winner', async (t) => {
  const f = await rig(t), body = observation(f.A.repo);
  const results = await Promise.all([f.as(f.users.s, 'POST', path(f.A.board), body), f.as(f.users.s, 'POST', path(f.B.board), { ...body, repo_id: f.B.repo })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM work_capture_cards').n, 1);
  const winner = results.find((r) => r.status === 200).body.card;
  const loserBoard = winner.board_id === f.A.board ? f.B : f.A;
  const rejected = await f.as(f.users.s, 'POST', path(loserBoard.board), { ...body, repo_id: loserBoard.repo });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.reason, 'CAPTURE_DESTINATION_PINNED');
  const other = await f.as(f.users.ua, 'POST', path(f.A.board), body); assert.equal(other.status, 200, 'another actual account has its own source namespace');
  assert.notEqual(other.body.card.id, winner.id);
});

test('title/body/column human edits permanently win, including an edit changed back before another report', async (t) => {
  const f = await rig(t), body = observation(f.A.repo, { summary: 'Opted-in brief' });
  const first = await f.as(f.users.amember, 'POST', path(f.A.board), body); assert.equal(first.status, 200, first.text); const id = first.body.card.id;
  const edit = await f.as(f.users.ua, 'PATCH', `/api/cards/${id}`, { request_id: randomUUID(), version: first.body.card.version, title: 'Human title', body: 'Human body', column: 'todo' });
  assert.equal(edit.status, 200, edit.text);
  const back = await f.as(f.users.ua, 'PATCH', `/api/cards/${id}`, { request_id: randomUUID(), version: edit.body.card.version, title: body.title, body: body.summary, column: 'in_progress' });
  assert.equal(back.status, 200);
  const report = await f.as(f.users.amember, 'POST', path(f.A.board), { ...body, title: 'New observed title', summary: 'New observed brief', status: 'ended' });
  assert.equal(report.status, 200); assert.equal(report.body.card.title, body.title); assert.equal(report.body.card.column, 'in_progress'); assert.equal(f.h.hub.card(id).body, body.summary);
  assert.deepEqual(report.body.capture.managed, { title: false, body: false, column: false });
  const journal = JSON.stringify(f.db.all('SELECT * FROM journal WHERE card_id=?', id));
  for (const value of ['Opted-in brief', 'Human body', 'New observed brief']) assert.ok(!journal.includes(value), value);
});

for (const tombstone of ['archive', 'stop', 'delete']) test(`${tombstone} preserves durable user intent and never resurrects a source`, async (t) => {
  const f = await rig(t), body = observation(f.A.repo), first = await f.as(f.users.amember, 'POST', path(f.A.board), body), id = first.body.card.id;
  assert.equal(first.status, 200, first.text);
  if (tombstone === 'archive') {
    assert.equal((await f.as(f.users.ua, 'POST', `/api/cards/${id}/archive`, {})).status, 200);
    assert.equal((await f.as(f.users.ua, 'POST', `/api/cards/${id}/restore`, {})).status, 200);
  } else if (tombstone === 'stop') {
    const wrong = await f.as(f.users.ua, 'POST', `/api/cards/${id}/work-capture/stop`, {}); assert.equal(wrong.status, 404);
    f.db.run("UPDATE members SET role='viewer' WHERE id=?", f.A.member);
    const stop = await f.as(f.users.amember, 'POST', `/api/cards/${id}/work-capture/stop`, {}); assert.equal(stop.status, 200, stop.text);
    f.db.run("UPDATE members SET role='member' WHERE id=?", f.A.member);
    assert.equal((await f.as(f.users.amember, 'POST', `/api/cards/${id}/work-capture/stop`, {})).body.capture.tracking, 'stopped');
  } else {
    // No product hard-delete route: exercise the DB safety tombstone directly.
    f.db.run('DELETE FROM events WHERE card_id=?', id);
    f.db.run('DELETE FROM cards WHERE id=?', id);
  }
  const before = snapshot(f), replay = await f.as(f.users.amember, 'POST', path(f.A.board), { ...body, title: 'Must not revive', status: 'working' });
  assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.capture.tracking, tombstone === 'archive' ? 'archived' : tombstone === 'delete' ? 'deleted' : 'stopped');
  assert.equal(replay.body.capture.status, 'unknown'); assert.equal(snapshot(f), before);
  if (tombstone === 'delete') assert.equal(replay.body.card, null); else assert.equal(replay.body.card.id, id);
});

test('closed inputs reject private paths/transcripts/authority and sanitize optional text before storage', async (t) => {
  const f = await rig(t), body = observation(f.A.repo, { title: 'Work /Users/private/project/file sk-' + 'A'.repeat(40), summary: 'file:///Users/private/secret https://name:pass@example.com/path?token=SECRET#private' });
  for (const extra of [{ cwd: '/private' }, { transcript: 'raw' }, { evidence: [] }, { for_agent: true }, { provider: 'openai' }, { status: 'done' }, { title: 'x'.repeat(201) }, { summary: 'x'.repeat(2001) }, { task_id: '../outside' }, { session_id: '', task_id: null }, { install_id: 'bad' }, { run_id: randomUUID() }, { request_id: randomUUID() }]) {
    const r = await f.as(f.users.amember, 'POST', path(f.A.board), { ...body, ...extra }); assert.equal(r.status, 400, r.text);
  }
  const good = await f.as(f.users.amember, 'POST', path(f.A.board), body); assert.equal(good.status, 200, good.text);
  const stored = JSON.stringify({ capture: f.db.all('SELECT * FROM work_capture_cards'), card: f.h.hub.card(good.body.card.id), journal: f.db.all('SELECT * FROM journal WHERE card_id=?', good.body.card.id) });
  for (const bad of ['/Users/private', 'name:pass', 'token=SECRET', 'sk-' + 'A'.repeat(40), body.install_id, body.session_id, body.task_id]) assert.ok(!stored.includes(bad), bad);
  assert.ok(stored.includes('<path>')); assert.ok(!JSON.stringify(good.body.capture).includes('summary'));
  const before = snapshot(f);
  for (const [user, board, repo, status] of [[f.users.amember, f.B.board, f.B.repo, 404], [f.users.amember, f.A.board, f.B.repo, 404], [f.users.aviewer, f.A.board, f.A.repo, 403], [f.users.bguest, f.B.board, f.B.repo, 404], [f.users.amember, f.A.board, null, 404], [f.users.amember, f.A.board, randomUUID(), 404]]) {
    const r = await f.as(user, 'POST', path(board), observation(repo)); assert.equal(r.status, status, r.text);
  }
  assert.equal(snapshot(f), before);
});

const losses = {
  device: [401, (f) => f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?', f.h.hub.iso(), f.users.amember.device_id)],
  epoch: [401, (f) => f.db.setMeta('session_epoch', Number(f.db.meta('session_epoch')) + 1)],
  role: [403, (f) => f.db.run("UPDATE members SET role='viewer' WHERE id=?", f.A.member)],
  member: [404, (f) => f.db.run('UPDATE members SET removed_at=? WHERE id=?', f.h.hub.iso(), f.A.member)],
  user: [401, (f) => f.db.run('UPDATE users SET deleted_at=? WHERE id=?', f.h.hub.iso(), f.users.amember.id)],
  team: [404, (f) => f.db.run('UPDATE orgs SET deleted_at=? WHERE id=?', f.h.hub.iso(), f.A.team)],
  board: [409, (f) => f.db.run('UPDATE boards SET archived_at=? WHERE id=?', f.h.hub.iso(), f.A.board)],
  repo_optin: [404, (f) => f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?', f.A.board, f.A.repo)],
};
async function held(f, call, invalidate) {
  const original = f.h.hub.withBoard.bind(f.h.hub); let release, enter, queue;
  const ready = new Promise((r) => { enter = r; }), observed = new Promise((r) => { queue = r; }), gate = new Promise((r) => { release = r; });
  const holding = original(f.A.board, () => { enter(); return gate; }); await ready;
  f.h.hub.withBoard = (id, fn) => { if (id === f.A.board) queue(); return original(id, fn); };
  let timer; try {
    const pending = call(); await Promise.race([observed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('capture did not enter board queue')), 3000); })]);
    invalidate(f); const before = snapshot(f); release(); await holding; const result = await pending;
    assert.equal(snapshot(f), before, 'revoked queued operation has zero durable effects'); return result;
  } finally { clearTimeout(timer); release(); await holding; f.h.hub.withBoard = original; }
}
for (const [loss, [status, revoke]] of Object.entries(losses)) for (const mode of ['create', 'update']) test(`queued ${mode} rechecks ${loss} after awaiting ordinary board queue`, async (t) => {
  const f = await rig(t), body = observation(f.A.repo);
  if (mode === 'update') assert.equal((await f.as(f.users.amember, 'POST', path(f.A.board), body)).status, 200);
  const result = await held(f, () => f.as(f.users.amember, 'POST', path(f.A.board), { ...body, title: 'Queued observed change' }), revoke);
  assert.equal(result.status, status, result.text);
});

test('private server context rejects missing, wrong-owner and unknown grant credentials', async (t) => {
  const f = await rig(t), capture = new WorkCapture(f.h.hub), member = f.h.hub.member(f.A.member), body = observation(f.A.repo), before = snapshot(f);
  for (const cred of [null, { kind: 'device', id: f.users.ub.device_id }, { kind: 'remote', id: f.users.amember.device_id }]) {
    assert.throws(() => capture.observe(member, f.A.board, body, cred), { code: 'UNAUTHENTICATED' });
  }
  assert.throws(() => f.h.hub.actVia({ member_id: member.id }, () => capture.observe(member, f.A.board, body, { kind: 'device', id: f.users.amember.device_id })), { code: 'UNAUTHENTICATED' });
  assert.equal(snapshot(f), before);
});

test('owned capture fields can change, absent summary preserves brief and waiting/idle preserve review', async (t) => {
  const f = await rig(t), body = observation(f.A.repo, { summary: 'Opted-in first brief' });
  const first = await f.as(f.users.amember, 'POST', path(f.A.board), body); assert.equal(first.status, 200);
  const update = await f.as(f.users.amember, 'POST', path(f.A.board), { ...body, title: 'Current task title', summary: 'Opted-in current brief', status: 'review' });
  assert.equal(update.status, 200, update.text); assert.equal(update.body.card.title, 'Current task title'); assert.equal(update.body.card.column, 'in_review');
  assert.equal(f.h.hub.card(first.body.card.id).body, 'Opted-in current brief'); assert.deepEqual(update.body.capture.managed, { title: true, body: true, column: true });
  for (const status of ['waiting', 'idle']) {
    const { summary, ...withoutSummary } = body;
    const r = await f.as(f.users.amember, 'POST', path(f.A.board), { ...withoutSummary, title: 'Latest title', status });
    assert.equal(r.status, 200); assert.equal(r.body.card.column, 'in_review'); assert.equal(f.h.hub.card(first.body.card.id).body, 'Opted-in current brief');
  }
});

for (const takeover of ['manual_repo', 'real_run']) test(`${takeover} permanently relinquishes capture-managed card fields`, async (t) => {
  const f = await rig(t), body = observation(f.A.repo, { summary: 'Original observed brief' }), first = await f.as(f.users.amember, 'POST', path(f.A.board), body), id = first.body.card.id;
  assert.equal(first.status, 200);
  if (takeover === 'manual_repo') {
    const edit = await f.as(f.users.ua, 'PATCH', `/api/cards/${id}`, { request_id: randomUUID(), version: first.body.card.version, repo_id: null }); assert.equal(edit.status, 200);
    const back = await f.as(f.users.ua, 'PATCH', `/api/cards/${id}`, { request_id: randomUUID(), version: edit.body.card.version, repo_id: f.A.repo }); assert.equal(back.status, 200);
  } else {
    // Actual states always set run_state and its corresponding column; the
    // database safety gate takes effect even before an observer next reports.
    f.db.run("UPDATE cards SET run_state='queued',column_name='todo' WHERE id=?", id);
    f.db.run("UPDATE cards SET run_state=NULL,column_name='in_progress' WHERE id=?", id);
  }
  const r = await f.as(f.users.amember, 'POST', path(f.A.board), { ...body, title: 'Must not replace goal', summary: 'Must not replace brief', status: 'ended' });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.card.title, body.title); assert.equal(f.h.hub.card(id).body, body.summary); assert.equal(r.body.card.column, 'in_progress');
  assert.deepEqual(r.body.capture.managed, { title: false, body: false, column: false });
});

test('account browser session supports reports but session revocation during create and stop queues denies effects', async (t) => {
  const f = await rig(t), body = observation(f.A.repo), web = await f.h.webSignIn(f.users.amember.email); assert.equal(web.res.status, 200);
  const call = (url, payload) => f.h.call('POST', url, { body: payload, cookie: web.cookie, headers: { origin: f.h.base, 'x-csrf-token': web.csrf } });
  const first = await call(path(f.A.board), body); assert.equal(first.status, 200, first.text);
  const result = await held(f, () => call(`/api/cards/${first.body.card.id}/work-capture/stop`, {}), (x) => x.db.run('DELETE FROM sessions WHERE user_id=?', x.users.amember.id));
  assert.equal(result.status, 401, result.text);
  const fresh = await f.h.webSignIn(f.users.amember.email);
  const denied = await held(f, () => f.h.call('POST', path(f.A.board), { body: observation(f.A.repo), cookie: fresh.cookie, headers: { origin: f.h.base, 'x-csrf-token': fresh.csrf } }), (x) => x.db.run('DELETE FROM sessions WHERE user_id=?', x.users.amember.id));
  assert.equal(denied.status, 401, denied.text);
});

for (const loss of ['device', 'member', 'user', 'team']) test(`queued own stop rechecks ${loss} without a tombstone write`, async (t) => {
  const f = await rig(t), first = await f.as(f.users.amember, 'POST', path(f.A.board), observation(f.A.repo)); assert.equal(first.status, 200);
  const [status, revoke] = losses[loss];
  const result = await held(f, () => f.as(f.users.amember, 'POST', `/api/cards/${first.body.card.id}/work-capture/stop`, {}), revoke);
  assert.equal(result.status, status, result.text);
});

test('catalog filters hidden memberships before its bounded limit and reports eligible truncation', async (t) => {
  const f = await rig(t);
  for (let i = 0; i < 205; i++) {
    const id = randomUUID(); f.db.insert('boards', { id, org_id: f.B.team, name: 'Hidden board', key_prefix: `H${i}` });
    f.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)', id, f.B.repo);
  }
  const a = await f.as(f.users.ua, 'GET', '/api/work-capture/routes'); assert.equal(a.status, 200); assert.equal(a.body.routes.length, 1); assert.equal(a.body.truncated, false);
  const b = await f.as(f.users.ub, 'GET', '/api/work-capture/routes'); assert.equal(b.status, 200); assert.equal(b.body.routes.length, 200); assert.equal(b.body.truncated, true); assert.equal(b.body.complete, false);
  assert.ok(b.body.routes.every((r) => r.team_id === f.B.team));
  f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?', f.h.hub.iso(), f.users.ub.device_id);
  assert.equal((await f.as(f.users.ub, 'GET', '/api/work-capture/routes')).status, 401);
});

test('new capture quota is durable, excludes authorized exact updates and cannot reset through another membership', async (t) => {
  const f = await rig(t); let first, source;
  for (let i = 0; i < 20; i++) {
    const body = observation(f.A.repo, { task_id: `bounded-task-${i}` }), r = await f.as(f.users.s, 'POST', path(f.A.board), body);
    assert.equal(r.status, 200, r.text); if (!first) { first = r.body.card.id; source = body; }
  }
  const before = snapshot(f), denied = await f.as(f.users.s, 'POST', path(f.B.board), observation(f.B.repo)); assert.equal(denied.status, 429, denied.text); assert.equal(snapshot(f), before);
  const update = await f.as(f.users.s, 'POST', path(f.A.board), { ...source, title: 'Existing task continues' }); assert.equal(update.status, 200); assert.equal(update.body.card.id, first);
  f.h.clock.advance(3_600_001);
  assert.equal((await f.as(f.users.s, 'POST', path(f.B.board), observation(f.B.repo))).status, 200);
});

test('migration refuses cross-team mapping, identity changes, tombstone revival and field reauthorization', async (t) => {
  const f = await rig(t), first = await f.as(f.users.amember, 'POST', path(f.A.board), observation(f.A.repo)); assert.equal(first.status, 200);
  const row = f.db.get('SELECT * FROM work_capture_cards');
  assert.throws(() => f.db.insert('work_capture_cards', { ...row, id: randomUUID(), source_hash: 'a'.repeat(64), card_id: f.B.card }), /destination/);
  assert.throws(() => f.db.run('UPDATE work_capture_cards SET board_id=? WHERE id=?', f.B.board, row.id), /immutable/);
  f.db.run('UPDATE work_capture_cards SET title_managed=0 WHERE id=?', row.id);
  assert.throws(() => f.db.run('UPDATE work_capture_cards SET title_managed=1 WHERE id=?', row.id), /reclaim/);
  f.db.run("UPDATE work_capture_cards SET tracking='stopped' WHERE id=?", row.id);
  assert.throws(() => f.db.run("UPDATE work_capture_cards SET tracking='active' WHERE id=?", row.id), /permanent/);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM work_capture_cards').n, 1);
});

test('oversized capture and stop bodies close through their explicit HTTP body ceilings', async (t) => {
  const f = await rig(t), before = snapshot(f);
  const large = await f.as(f.users.amember, 'POST', path(f.A.board), { ...observation(f.A.repo), transcript: 'x'.repeat(20_000) });
  assert.equal(large.status, 413); assert.equal(snapshot(f), before);
  const first = await f.as(f.users.amember, 'POST', path(f.A.board), observation(f.A.repo)); assert.equal(first.status, 200);
  const state = snapshot(f), stop = await f.as(f.users.amember, 'POST', `/api/cards/${first.body.card.id}/work-capture/stop`, { transcript: 'x'.repeat(2000) });
  assert.equal(stop.status, 413); assert.equal(snapshot(f), state);
});

test('a tombstoned capture does not project a card later moved out of its pinned board', async (t) => {
  const f = await rig(t), body = observation(f.A.repo), first = await f.as(f.users.amember, 'POST', path(f.A.board), body), id = first.body.card.id; assert.equal(first.status, 200);
  assert.equal((await f.as(f.users.amember, 'POST', `/api/cards/${id}/work-capture/stop`, {})).status, 200);
  // There is no HTTP move operation; defend a restored/externally repaired DB.
  f.db.run("UPDATE cards SET board_id=?,repo_id=?,created_by=?,key='MOVED-1' WHERE id=?", f.B.board, f.B.repo, f.B.owner, id);
  const r = await f.as(f.users.amember, 'POST', path(f.A.board), body); assert.equal(r.status, 200, r.text); assert.equal(r.body.card, null);
  assert.equal(r.body.capture.tracking, 'stopped'); assert.ok(!JSON.stringify(r.body).includes('MOVED-1')); assert.ok(!JSON.stringify(r.body).includes(f.B.board));
});

test('new-card transaction failure rolls back card, key, mapping and journal before a safe retry', async (t) => {
  const f = await rig(t), body = observation(f.A.repo), before = snapshot(f), key = f.h.hub.board(f.A.board).next_key;
  f.db.exec("CREATE TRIGGER capture_test_fault BEFORE INSERT ON work_capture_cards BEGIN SELECT RAISE(ABORT,'injected mapping failure'); END;");
  assert.equal((await f.as(f.users.amember, 'POST', path(f.A.board), body)).status, 500);
  assert.equal(snapshot(f), before); assert.equal(f.h.hub.board(f.A.board).next_key, key);
  f.db.exec('DROP TRIGGER capture_test_fault');
  assert.equal((await f.as(f.users.amember, 'POST', path(f.A.board), body)).status, 200); assert.equal(f.db.get('SELECT COUNT(*) AS n FROM work_capture_cards').n, 1);
});

test('durable mapping and tombstone survive hub restart; old observations never regain live freshness', async (t) => {
  const f = await rig(t), body = observation(f.A.repo), first = await f.as(f.users.amember, 'POST', path(f.A.board), body); assert.equal(first.status, 200);
  const dir = f.h.app.config?.dataDir ?? f.h.hub.config.dataDir; await f.h.close();
  const h = await startAccounts({ config: { dataDir: dir, dbPath: join(dir, 'board.db') } }); t.after(() => h.close());
  const call = (method, url, payload) => h.call(method, url, { body: payload, token: f.users.amember.token, headers: { origin: h.base } });
  const stale = await call('GET', `/api/cards/${first.body.card.id}`); assert.equal(stale.status, 200, stale.text); assert.equal(stale.body.card.capture.status, 'unknown');
  const retry = await call('POST', path(f.A.board), body); assert.equal(retry.status, 200, retry.text); assert.equal(retry.body.card.id, first.body.card.id); assert.equal(retry.body.capture.fresh, true);
  assert.equal((await call('POST', `/api/cards/${first.body.card.id}/work-capture/stop`, {})).status, 200);
  await h.close();
  const next = await startAccounts({ config: { dataDir: dir, dbPath: join(dir, 'board.db') } }); t.after(() => next.close());
  const stopped = await next.call('POST', path(f.A.board), { body, token: f.users.amember.token, headers: { origin: next.base } });
  assert.equal(stopped.status, 200, stopped.text); assert.equal(stopped.body.capture.tracking, 'stopped'); assert.equal(next.db.get('SELECT COUNT(*) AS n FROM work_capture_cards').n, 1);
});

test('embedded local owner captures no-repo work through actual private cookie and preserves restart mapping', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'capture-local-')), cookie = `board_local=${'x'.repeat(64)}`;
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = testConfig({ auth: 'local', localSecret: 'x'.repeat(64), devLoginSecret: null, dataDir, dbPath: join(dataDir, 'board.db') });
  async function start() {
    const app = createApp(config, { clock: fakeClock(), log: silentLogger, github: fakeGitHub(), timers: false }); t.after(() => app.close());
    const addr = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${addr.port}`;
    const call = async (method, url, body, hs = {}) => { const r = await fetch(`${base}${url}`, { method, headers: { cookie, origin: base, 'content-type': 'application/json', ...hs }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
    return { app, call, board: app.hub.boardList(app.hub.member(app.hub.localMemberId).org_id)[0].id };
  }
  const a = await start(), body = observation(null);
  assert.equal((await a.call('POST', path(a.board), body, { cookie: '' })).status, 401);
  const first = await a.call('POST', path(a.board), body); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.card.column, 'in_progress');
  assert.equal(first.body.card.repo, null); assert.equal(first.body.card.run, null);
  await a.app.close(); const b = await start(), repeat = await b.call('POST', path(b.board), body);
  assert.equal(repeat.status, 200); assert.equal(repeat.body.card.id, first.body.card.id); assert.equal(b.app.db.get('SELECT COUNT(*) AS n FROM work_capture_cards').n, 1);
  const stop = await b.call('POST', `/api/cards/${first.body.card.id}/work-capture/stop`, {}); assert.equal(stop.status, 200); assert.equal(stop.body.capture.tracking, 'stopped');
  assert.ok(!dumpDb(b.app.db).includes(body.session_id));
});
