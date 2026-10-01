import test from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from './helpers.js';
import { CODEX_PLAN_PERMISSION, MCP_TOOLS, RUNNER_ONLY_RPC } from '../../shared/protocol.js';
async function rig(t, { gate = true } = {}) {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice'), bob = await h.login('bob');
  const dev = await h.enroll(alice), runner = await h.runner(dev);
  const run = await h.startRun(alice, runner, { labels: gate ? ['plan-approval'] : [] });
  h.db.run("UPDATE runs SET ai = 'codex', backend = 'codex_cli' WHERE id = ?", run.run_id);
  return { h, alice, bob, dev, runner, run };
}
test('only declared Codex plan creates one reserved explicit human permission; text answers do not authorize edits', async (t) => {
  const { h, alice, runner, run } = await rig(t);
  assert.ok(RUNNER_ONLY_RPC.includes('runner_plan_status')); assert.ok(!MCP_TOOLS.includes('runner_plan_status'));
  assert.equal((await runner.rpc(run, 'runner_plan_status')).result.decision, 'pending');
  assert.equal((await runner.rpc(run, 'approval', { tool_name: CODEX_PLAN_PERMISSION })).error.code, 'FORBIDDEN');
  const declared = await runner.rpc(run, 'board_declare_plan', { paths: ['src/a.js'], summary: 'Fix the scoped API' });
  assert.equal(declared.ok, true); const id = declared.result.plan_permission_request_id;
  const pr = h.db.get('SELECT * FROM permission_requests WHERE id = ?', id);
  assert.equal(pr.tool, CODEX_PLAN_PERMISSION); assert.match(pr.input_summary, /Fix the scoped API/); assert.match(pr.input_summary, /src\/a.js/);
  assert.equal((await runner.rpc(run, 'board_declare_plan', { paths: ['src/b.js'] })).result.plan_permission_request_id, id);
  assert.equal(h.db.get('SELECT count(*) AS n FROM permission_requests WHERE run_id = ?', run.run_id).n, 1);
  const ask = await runner.rpc(run, 'board_ask_human', { kind: 'question', text: 'Should I continue?' });
  assert.equal((await h.action(alice, run.card_id, 'answer', { ask_id: ask.result.ask_id, answer: 'YES APPROVED' })).status, 200);
  assert.equal((await runner.rpc(run, 'runner_plan_status')).result.decision, 'pending');
  const allowed = await h.api(alice, 'POST', `/api/permission-requests/${id}/answer`, { decision: 'allow', scope: 'run' });
  assert.equal(allowed.status, 200);
  const status = (await runner.rpc(run, 'runner_plan_status')).result;
  assert.equal(status.decision, 'allow'); assert.equal(status.answered_by.member_id, h.ids.alice); assert.equal(status.permission_request_id, id);
  h.db.run("UPDATE cards SET labels = '[]' WHERE id = ?", run.card_id);
  assert.equal((await runner.rpc(run, 'runner_plan_status')).result.required, true, 'label removal cannot shed the recorded run gate');
});
test('plan grant follows active human authorization: downgrade/removal, device revoke and fence fail closed', async (t) => {
  const { h, alice, dev, runner, run } = await rig(t);
  const id = (await runner.rpc(run, 'board_declare_plan', { paths: ['src/a.js'] })).result.plan_permission_request_id;
  h.hub.runners.get(dev.device_id).repos.get(h.ids.repo).approvals_from = [h.ids.bob];
  // The recorded approver must be in this request's explicit allowlist.
  h.db.run('UPDATE permission_requests SET approvers = ? WHERE id = ?', JSON.stringify([h.ids.bob]), id);
  const bob = await h.login('bob'); assert.equal((await h.api(bob, 'POST', `/api/permission-requests/${id}/answer`, { decision: 'allow' })).status, 200);
  assert.equal((await runner.rpc(run, 'runner_plan_status')).result.decision, 'allow');
  h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.bob);
  assert.equal((await runner.rpc(run, 'runner_plan_status')).result.decision, 'pending');
  h.db.run("UPDATE members SET role = 'member', removed_at = ? WHERE id = ?", h.hub.iso(), h.ids.bob);
  assert.equal((await runner.rpc(run, 'runner_plan_status')).result.decision, 'pending');
  h.db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), dev.device_id);
  runner.send({ type: 'rpc', id: 'revoked-plan', method: 'runner_plan_status', ...run, repo_id: h.ids.repo, params: {} });
  assert.equal(await runner.closed(), 4403);
  h.db.run('UPDATE devices SET revoked_at = NULL WHERE id = ?', dev.device_id);
  const current = await h.runner(dev);
  h.db.run('UPDATE cards SET fence = fence + 1 WHERE id = ?', run.card_id);
  assert.equal((await current.rpc(run, 'runner_plan_status')).error.code, 'FENCED');
});
test('plan status is denied cross-repo/run/device and a denied permission stays read-only', async (t) => {
  const { h, alice, bob, runner, run } = await rig(t);
  const id = (await runner.rpc(run, 'board_declare_plan', { paths: ['src/a.js'] })).result.plan_permission_request_id;
  assert.equal((await h.api(bob, 'POST', `/api/permission-requests/${id}/answer`, { decision: 'allow' })).status, 403);
  assert.equal((await h.api(alice, 'POST', `/api/permission-requests/${id}/answer`, { decision: 'deny' })).status, 200);
  assert.equal((await runner.rpc(run, 'runner_plan_status')).result.decision, 'deny');
  assert.equal((await runner.rpc(run, 'runner_plan_status', {}, { repo_id: 'foreign' })).error.code, 'FORBIDDEN');
  const other = await h.runner(await h.enroll(bob));
  assert.equal((await other.rpc(run, 'runner_plan_status')).error.code, 'FORBIDDEN');
  h.db.run('UPDATE runs SET ended_at = ? WHERE id = ?', h.hub.iso(), run.run_id);
  assert.equal((await runner.rpc(run, 'runner_plan_status')).error.code, 'RUN_ENDED');
});
test('a queued plan status reads fresh authorization after approver removal', async (t) => {
  const { h, alice, runner, run } = await rig(t);
  const id = (await runner.rpc(run, 'board_declare_plan', { paths: [] })).result.plan_permission_request_id;
  assert.equal((await h.api(alice, 'POST', `/api/permission-requests/${id}/answer`, { decision: 'allow' })).status, 200);
  h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", h.ids.bob);
  let release;
  const held = h.hub.withBoard(h.ids.board, () => new Promise((r) => release = r)); await new Promise((r) => setImmediate(r));
  const pending = runner.rpc(run, 'runner_plan_status'); await new Promise((r) => setTimeout(r, 20));
  h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), h.ids.alice);
  release(); await held;
  assert.equal((await pending).error.code, 'FORBIDDEN');
});
