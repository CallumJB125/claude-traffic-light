import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy, MARK } from './tenancy/fixture.js';
import { startHub } from './helpers.js';
import { teamOverview } from '../team-overview.js';

test('overview reads only the selected live staff team, excludes guests/archives and rechecks revocation', async () => {
  const f = await tenancy();
  try {
    const { h, as, db, A, B, users } = f;
    const alpha = await as(users.ua, 'GET', '/api/team-overview');
    assert.equal(alpha.status, 200, alpha.text); assert.equal(alpha.body.team.id, A.team);
    assert.ok(!JSON.stringify(alpha.body).includes(MARK));
    assert.equal((await as(users.aviewer, 'GET', `/api/team-overview?team=${A.team}`)).status, 200);
    const beta = await as(users.s, 'GET', `/api/team-overview?team=${B.team}`);
    assert.equal(beta.status, 200, beta.text); assert.equal(beta.body.recent.items[0].id, B.card);
    assert.equal((await as(users.s, 'GET', `/api/team-overview?team=${A.team}`)).body.team.id, A.team);
    assert.equal((await as(users.ua, 'GET', `/api/team-overview?team=${B.team}`)).status, 404);
    assert.equal((await as(users.bguest, 'GET', `/api/team-overview?team=${B.team}`)).status, 404);
    const bytes = JSON.stringify(beta.body);
    for (const privateField of ['token_hash', 'primary_email', 'input_summary', 'device_id', 'planned_paths', 'runner_token', 'body']) assert.ok(!bytes.includes(`"${privateField}"`), privateField);
    db.run('UPDATE boards SET archived_at = ? WHERE id = ?', h.hub.iso(), B.board);
    assert.equal((await as(users.ub, 'GET', '/api/team-overview')).body.totals.total, 0);
    assert.equal((await as(users.ub, 'GET', '/api/team-overview')).body.board_count, 0);
    db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), B.s);
    assert.throws(() => teamOverview(h.hub, { id: B.s, org_id: B.team }, new URLSearchParams()), /team not found/);
    db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), users.ua.device_id);
    assert.equal((await as(users.ua, 'GET', '/api/team-overview')).status, 401);
  } finally { await f.h.close(); }
});

test('live activity needs current runner, fence and enrolment; idle and unknown Codex cost stay truthful', async () => {
  const f = await tenancy();
  try {
    const { h, as, db, B, users } = f;
    const enrolled = db.get('SELECT * FROM runner_enrollments WHERE id = ?', B.enrollment);
    db.run('UPDATE runs SET device_id = ?, ai = ? WHERE id = ?', enrolled.device_id, 'codex', B.run);
    db.run('UPDATE cards SET active_run_id = ?, fence = 1, run_state = ?, column_name = ? WHERE id = ?', B.run, 'running', 'in_progress', B.card);
    const conn = { ready: true, closed: false, device_id: enrolled.device_id, member_id: B.owner, enrollmentId: B.enrollment };
    h.hub.runners.set(conn.device_id, conn);
    h.hub.live.set(B.run, { hb_mono: h.hub.mono(), activity_mono: h.hub.mono(), child_alive: true, tool: null });
    const item = async () => (await as(users.ub, 'GET', '/api/team-overview')).body.work.items[0];
    assert.equal((await item()).activity, 'working'); assert.equal((await item()).actor_current, true);
    assert.deepEqual((await item()).cost, { cost_usd: null, cost_source: 'unavailable' });
    h.hub.live.get(B.run).child_alive = false;
    assert.equal((await item()).activity, 'idle');
    h.hub.live.get(B.run).child_alive = true;
    db.run('UPDATE runner_enrollments SET revoked_at = ? WHERE id = ?', h.hub.iso(), B.enrollment);
    assert.equal((await item()).activity, 'disconnected'); assert.equal((await item()).actor_current, false);
    h.hub.runners.clear();
  } finally { f.h.hub.runners.clear(); await f.h.close(); }
});

test('overview counts all active tasks but bounds lists and refuses arbitrary selectors', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    for (let i = 0; i < 23; i++) await h.createCard(alice, { title: `Task ${i}` });
    const other = (await h.api(alice, 'POST', '/api/boards', { request_id: randomUUID(), name: 'Second board' })).body.board;
    await h.api(alice, 'POST', `/api/boards/${other.id}/cards`, { request_id: randomUUID(), title: 'Review this' });
    h.db.run('UPDATE cards SET column_name = ? WHERE board_id = ?', 'in_review', other.id);
    const res = await h.api(alice, 'GET', '/api/team-overview');
    assert.equal(res.status, 200, res.text); assert.equal(res.body.totals.total, 24); assert.equal(res.body.totals.review, 1);
    assert.equal(res.body.board_count, 2); assert.equal(res.body.recent.items.length, 20); assert.equal(res.body.recent.truncated, true);
    assert.equal(res.body.review.items[0].board.id, other.id);
    for (const q of ['member_id=alice', 'board_id=anything', 'include_archived=1', 'limit=999', 'team=a&team=b']) assert.equal((await h.api(alice, 'GET', `/api/team-overview?${q}`)).status, 400, q);
    assert.equal((await h.api(null, 'GET', '/api/team-overview')).status, 401);
  } finally { await h.close(); }
});
