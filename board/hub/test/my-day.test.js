import test from 'node:test';
import assert from 'node:assert/strict';
import { tenancy, MARK } from './tenancy/fixture.js';
import { startHub } from './helpers.js';
test('My day shows own relations and only eligible decisions, never unrelated teams or colleagues', async () => {
  const fx = await tenancy();
  try {
    const member = await fx.as(fx.users.amember, 'GET', '/api/my-day'); assert.equal(member.status, 200, member.text); assert.deepEqual(member.body.cards, []); assert.deepEqual(member.body.decisions, []); assert.equal(member.text.includes(MARK), false);
    fx.db.run("INSERT INTO card_assignees VALUES (?, ?, 'collaborator')", fx.A.card, fx.A.member);
    const owned = await fx.as(fx.users.amember, 'GET', '/api/my-day'); assert.deepEqual(owned.body.cards.map(r => r.card.id), [fx.A.card]); assert.equal(owned.text.includes(MARK), false);
    fx.db.run("UPDATE cards SET active_run_id = ?, run_state = 'blocked', blocked_kind = 'permission', column_name = 'in_progress' WHERE id = ?", fx.B.run, fx.B.card);
    const shared = await fx.as(fx.users.s, 'GET', '/api/my-day'); assert.equal(shared.status, 200, shared.text); assert.deepEqual(shared.body.cards, []); assert.deepEqual(shared.body.decisions.map(d => d.id), [fx.B.permission]); assert.deepEqual(shared.body.agents, []);
    const viewer = await fx.as(fx.users.aviewer, 'GET', '/api/my-day'); assert.deepEqual(viewer.body.decisions, []);
    const nobody = await fx.as(fx.users.n, 'GET', '/api/my-day'); assert.equal(nobody.status, 200); assert.deepEqual(nobody.body.cards, []);
  } finally { await fx.h.close(); }
});
test('My day drops archived, unlinked and removed memberships and revoked device context', async () => {
  const fx = await tenancy();
  try {
    fx.db.run("INSERT INTO card_assignees VALUES (?, ?, 'collaborator')", fx.A.card, fx.A.member);
    assert.equal((await fx.as(fx.users.amember, 'GET', '/api/my-day')).body.cards.length, 1);
    fx.db.run('DELETE FROM board_repos WHERE board_id = ? AND repo_id = ?', fx.A.board, fx.A.repo); assert.deepEqual((await fx.as(fx.users.amember, 'GET', '/api/my-day')).body.cards, []);
    fx.db.run('INSERT INTO board_repos VALUES (?, ?)', fx.A.board, fx.A.repo);
    fx.db.run('UPDATE cards SET archived_at = ? WHERE id = ?', fx.h.hub.iso(), fx.A.card); assert.deepEqual((await fx.as(fx.users.amember, 'GET', '/api/my-day')).body.cards, []);
    fx.db.run('UPDATE cards SET archived_at = NULL WHERE id = ?', fx.A.card); fx.db.run('UPDATE members SET removed_at = ? WHERE id = ?', fx.h.hub.iso(), fx.A.member); assert.deepEqual((await fx.as(fx.users.amember, 'GET', '/api/my-day')).body.cards, []);
    fx.db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', fx.h.hub.iso(), fx.users.amember.device_id); assert.equal((await fx.as(fx.users.amember, 'GET', '/api/my-day')).status, 401);
  } finally { await fx.h.close(); }
});
test('My day own-run liveness requires an accepted actual runner connection and heartbeat', async () => {
  const h = await startHub();
  try {
    const cookie = await h.login('alice'), bob = await h.login('bob'), device = await h.enroll(cookie), runner = await h.runner(device), run = await h.startRun(cookie, runner);
    const current = await h.api(cookie, 'GET', '/api/my-day'); assert.equal(current.status, 200, current.text); assert.equal(current.body.agents[0].connection, 'accepted'); assert.equal(current.body.agents[0].live.green, true);
    assert.deepEqual((await h.api(bob, 'GET', '/api/my-day')).body.agents, []);
    h.db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), device.device_id);
    const revoked = await h.api(cookie, 'GET', '/api/my-day'); assert.equal(revoked.body.agents[0].connection, 'unavailable'); assert.equal(revoked.body.agents[0].live, null);
    runner.terminate(); await new Promise(resolve => setTimeout(resolve, 40));
    const gone = await h.api(cookie, 'GET', '/api/my-day'); assert.equal(gone.body.agents[0].connection, 'unavailable'); assert.equal(gone.body.agents[0].live, null);
    assert.equal(h.card(run.card_id).active_run_id, run.run_id, 'run history survives while liveness becomes unavailable');
  } finally { await h.destroy(); }
});
test('My day includes eligible parked decisions and excludes stale requests of other runs', async () => {
  const fx = await tenancy();
  try {
    fx.db.run("UPDATE cards SET run_state = 'parked', blocked_kind = 'permission', column_name = 'in_progress' WHERE id = ?", fx.B.card);
    fx.db.run("UPDATE runs SET ended_at = ? WHERE id = ?", fx.h.hub.iso(), fx.B.run);
    fx.db.run("UPDATE permission_requests SET state = 'parked' WHERE id = ?", fx.B.permission);
    const state = await fx.as(fx.users.s, 'GET', '/api/my-day'); assert.deepEqual(state.body.decisions.map(d => d.id), [fx.B.permission]); assert.deepEqual(state.body.agents, []);
    fx.db.run("UPDATE cards SET run_state = 'failed', fail_kind = 'error', blocked_kind = NULL WHERE id = ?", fx.B.card);
    assert.deepEqual((await fx.as(fx.users.s, 'GET', '/api/my-day')).body.decisions, []);
  } finally { await fx.h.close(); }
});
test('My day card limits report partial rather than pretending all own work was loaded', async () => {
  const fx = await tenancy();
  try {
    const template = fx.h.hub.card(fx.A.card);
    fx.h.hub.txn(() => { for (let i = 0; i < 501; i++) fx.db.insert('cards', { ...template, id: `myday-${i}`, key: `MYDAY-${i}` }); });
    const response = await fx.as(fx.users.ua, 'GET', '/api/my-day'); assert.equal(response.status, 200, response.text); assert.equal(response.body.status, 'partial'); assert.equal(response.body.cards.length, 500);
  } finally { await fx.h.close(); }
});
test('My day maps observed sessions with the board lane rules: idle and day-old sessions are excluded', async () => {
  const { stateKey, observedLane } = await import('../../shared/capture-lane.js');
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  const v = (ms, extra = {}) => ({ run: null, run_state: 'todo', column: 'in_progress', capture: { source: 'local_observation', tracking: 'active', reported_status: 'idle', fresh: false, age_ms: null, received_at: at(ms), ...extra } });
  assert.equal(stateKey(v(5 * 60_000)), 'idle'); assert.equal(observedLane(v(5 * 60_000)), 'idle');
  assert.equal(observedLane(v(2 * 86_400_000)), 'archived');
  assert.equal(stateKey(v(1000, { fresh: true, age_ms: 1000, reported_status: 'working' })), 'in_progress');
  assert.equal(stateKey({ run: { id: 'r' }, run_state: 'running', column: 'in_progress' }), 'running');
});
