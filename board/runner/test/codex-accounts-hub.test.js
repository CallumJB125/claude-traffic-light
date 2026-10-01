import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startAccounts } from '../../hub/test/accounts-helpers.js';
import { makeRepo, tmpDir, rm, waitFor } from './helpers.js';
import { CodexBackend } from '../backends/codex.js';
import { Supervisor } from '../supervisor.js';
import { makeLogger } from '../util.js';
const fixture = fileURLToPath(new URL('./fixtures/fake-board-codex.js', import.meta.url));
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
async function rig(t, { plan = false } = {}) {
  const dir = tmpDir('px-account-run-'), repo = makeRepo(dir), home = path.join(dir, 'board');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(path.join(repo.checkout, 'AGENTS.md'), 'Trusted Codex instructions\n');
  fs.writeFileSync(path.join(repo.checkout, 'test.js'), "const assert = require('node:assert/strict'); assert.equal(2+2,4);\n");
  repo.git('add', '-A'); repo.git('commit', '-qm', 'fixture'); repo.git('push', '-q', 'origin', 'main');
  const hubDir = path.join(dir, 'hub');
  const h = await startAccounts({ config: { dataDir: hubDir, dbPath: path.join(hubDir, 'board.db') } });
  let sup;
  t.after(async () => { await sup?.shutdown(); await h.close(); rm(dir); });
  const login = await h.signIn('alice@dev.local'); assert.equal(login.status, 200); const token = login.body.device_token;
  const enr = await h.call('POST', `/api/teams/${h.ids.org}/enrol`, { token, body: { device_name: 'Codex fixture' } }); assert.equal(enr.status, 200);
  const added = await h.call('POST', '/api/repos', { token, body: { request_id: randomUUID(), url: 'https://github.com/acme/app.git' } }); assert.equal(added.status, 200);
  const repoId = added.body.repo.id;
  assert.equal((await h.call('POST', `/api/boards/${h.ids.board}/repos`, { token, body: { request_id: randomUUID(), repo_id: repoId } })).status, 200);
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({ ai_ids: ['codex'], repos: { [repoId]: { opt_in: true, local_path: repo.checkout } } }), { mode: 0o600 });
  const scenario = path.join(dir, 'scenario.json'), log = path.join(dir, 'codex.log'), bin = path.join(dir, 'codex');
  fs.writeFileSync(scenario, JSON.stringify({ complete: true }));
  fs.writeFileSync(bin, `#!/bin/sh\nexport PLEXIFORM_FAKE_CODEX_SCENARIO=${q(scenario)}\nexport PLEXIFORM_FAKE_CODEX_LOG=${q(log)}\nexec ${q(process.execPath)} ${q(fixture)} "$@"\n`, { mode: 0o755 });
  // Evidence is verified by the hub against the actual local bare remote,
  // after the trusted host publishes the exact observed task HEAD.
  h.hub.github.getCommit = async (canonical, sha) => {
    if (canonical !== 'github.com/acme/app') return null;
    try { execFileSync('git', ['--git-dir', repo.bare, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'pipe' }); return { sha }; } catch { return null; }
  };
  sup = new Supervisor({ home, device: { hub: h.base, runner_token: enr.body.runner_token, team_id: enr.body.team_id },
    env: { HOME: dir, CODEX_HOME: path.join(dir, 'auth'), PATH: process.env.PATH },
    detectAis: async () => [{ ...CodexBackend.describe(), installed: true, version: '0.159.2', signedIn: true, bin }],
    log: makeLogger(process.stderr, { quiet: true }), controlSocket: false, keepRunFiles: true, buddyHome: null, stopGraceMs: 500 });
  await sup.start(); await waitFor(() => sup.connected);
  const ready = () => [...h.hub.runners.values()].find((r) => r.member_id === h.ids.alice && r.ready && r.repos.has(repoId));
  await waitFor(ready);
  const create = await h.call('POST', `/api/boards/${h.ids.board}/cards`, { token, body: { request_id: randomUUID(), title: 'A real Codex board flow', repo_id: repoId, labels: plan ? ['plan-approval'] : [] } }); assert.equal(create.status, 200);
  const dispatch = await h.call('POST', `/api/cards/${create.body.card.id}/actions/dispatch`, { token, body: { request_id: randomUUID(), ai: 'codex', budget_usd: null } }); assert.equal(dispatch.status, 200);
  const run = await waitFor(() => [...sup.runs.values()].find((r) => r.card_id === create.body.card.id));
  return { h, sup, run, token, repo, scenario, log, conn: ready(), read: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
test('accounts hub → dispatch/claim → real Codex adapter/stdio → observed commit/tests → hub-verified complete', async (t) => {
  const r = await rig(t);
  await r.run.done;
  assert.equal(r.run.endReason, 'completed'); assert.equal(r.h.hub.card(r.run.card_id).run_state, 'in_review');
  const stored = r.h.hub.run(r.run.run_id); assert.equal(stored.ai, 'codex'); assert.equal(stored.backend, 'codex_cli');
  const ev = r.h.db.all('SELECT * FROM evidence WHERE run_id = ?', r.run.run_id);
  assert.equal(ev.find((e) => e.kind === 'commit').verification, 'hub_verified'); assert.equal(ev.find((e) => e.kind === 'test_run').result, 'pass');
  const head = r.repo.gitIn(r.run.worktree, 'rev-parse', 'HEAD'); assert.equal(r.repo.gitIn(r.repo.bare, 'rev-parse', `refs/heads/${r.run.branch}`), head);
  assert.equal(fs.existsSync(path.join(r.repo.checkout, 'result.txt')), false);
  const facts = JSON.parse(stored.facts); assert.ok(facts.commands?.some((f) => f.cmd.includes('--test') && f.exit === 0));
  assert.equal(r.read().filter((x) => x.kind === 'start').length, 1);
});
test('accounts human plan approval creates a later editable generation; first generation stays read-only', async (t) => {
  const r = await rig(t, { plan: true }); await waitFor(() => r.run.localState === 'awaiting_plan_approval');
  assert.equal(fs.existsSync(path.join(r.run.worktree, 'result.txt')), false);
  const permission = r.h.db.get("SELECT * FROM permission_requests WHERE run_id = ? AND state = 'open'", r.run.run_id);
  assert.ok(permission); assert.match(permission.input_summary, /fixture result/);
  const answer = await r.h.call('POST', `/api/permission-requests/${permission.id}/answer`, { token: r.token, body: { decision: 'allow', scope: 'run' } }); assert.equal(answer.status, 200);
  await r.run.done; assert.equal(r.run.endReason, 'completed');
  const starts = r.read().filter((x) => x.kind === 'start'), profiles = r.read().filter((x) => x.kind === 'profile');
  assert.equal(starts.length, 2); assert.ok(starts[1].argv.includes('resume')); assert.deepEqual(profiles.map((x) => x.readOnly), [true, false]);
  assert.equal(r.h.hub.card(r.run.card_id).run_state, 'in_review');
});
test('queued accounts RPC cannot mutate after its authenticated enrolment is revoked, even with the device row live', async (t) => {
  const r = await rig(t, { plan: true }); await waitFor(() => r.run.localState === 'awaiting_plan_approval');
  const before = r.h.db.get('SELECT count(*) AS n FROM cards').n;
  let release; const held = r.h.hub.withBoard(r.h.ids.board, () => new Promise((resolve) => release = resolve)); await new Promise((resolve) => setImmediate(resolve));
  t.after(() => release());
  const pending = r.sup.rpc(r.run, 'board_create_card', { title: 'FORBIDDEN AFTER UNENROL' }).catch((e) => e);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await r.h.call('DELETE', `/api/teams/${r.h.ids.org}/enrol`, { token: r.token, body: {} })).status, 200);
  assert.equal(r.h.hub.device(r.conn.device_id).revoked_at, null, 'the retained device row alone cannot authorize this socket');
  release(); await held; await pending; await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(r.h.db.get('SELECT count(*) AS n FROM cards').n, before);
});

for (const revoke of ['signout', 'downgrade']) test(`queued human plan approval cannot survive ${revoke}`, async (t) => {
  const r = await rig(t, { plan: true }); await waitFor(() => r.run.localState === 'awaiting_plan_approval');
  const permission = r.h.db.get("SELECT * FROM permission_requests WHERE run_id = ? AND state = 'open'", r.run.run_id);
  let release; const held = r.h.hub.withBoard(r.h.ids.board, () => new Promise((resolve) => release = resolve)); await new Promise((resolve) => setImmediate(resolve));
  t.after(() => release());
  const pending = r.h.call('POST', `/api/permission-requests/${permission.id}/answer`, { token: r.token, body: { decision: 'allow', scope: 'run' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (revoke === 'signout') assert.equal((await r.h.call('POST', '/api/auth/signout', { token: r.token, body: {} })).status, 200);
  else {
    r.h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", r.h.ids.bob);
    r.h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", r.h.ids.alice);
  }
  release(); await held;
  assert.equal((await pending).status, revoke === 'signout' ? 401 : 403);
  assert.equal(r.h.db.get('SELECT state FROM permission_requests WHERE id = ?', permission.id).state, 'open');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(r.read().filter((x) => x.kind === 'start').length, 1, 'no editable generation was created');
  assert.equal(fs.existsSync(path.join(r.run.worktree, 'result.txt')), false);
});

test('evidence verification continuation cannot persist after its accounts enrolment is revoked', async (t) => {
  const r = await rig(t, { plan: true }); await waitFor(() => r.run.localState === 'awaiting_plan_approval');
  let release, started = false;
  r.h.hub.github.getCommit = async (_canonical, sha) => { started = true; await new Promise((resolve) => release = resolve); return { sha }; };
  t.after(() => release?.());
  const pending = r.sup.rpc(r.run, 'board_attach_evidence', { kind: 'commit', ref: r.repo.gitIn(r.run.worktree, 'rev-parse', 'HEAD') }).catch((e) => e);
  await waitFor(() => started);
  assert.equal((await r.h.call('DELETE', `/api/teams/${r.h.ids.org}/enrol`, { token: r.token, body: {} })).status, 200);
  release(); await pending; await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(r.h.db.get('SELECT count(*) AS n FROM evidence WHERE run_id = ?', r.run.run_id).n, 0);
});
