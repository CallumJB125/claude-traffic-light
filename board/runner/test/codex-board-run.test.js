import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir, rm, makeRepo, startFakeHub, startRunner, offerFor, claimRun, fakeClock, waitFor, REPO_ID, OWNER } from './helpers.js';
import { CodexBackend } from '../backends/codex.js';
import { createCodexCarry } from '../../shared/codex-carry.cjs';
import { GATE_G_MS } from '../../shared/liveness.js';
const fixture = fileURLToPath(new URL('./fixtures/fake-board-codex.js', import.meta.url));
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
async function rig({ scenario = {}, plan = false, codexCarry = null } = {}) {
  const dir = tmpDir('px-bc-'), repo = makeRepo(dir), home = path.join(dir, 'board');
  fs.writeFileSync(path.join(repo.checkout, 'AGENTS.md'), 'Trusted Codex instructions.\n');
  fs.writeFileSync(path.join(repo.checkout, 'test.js'), "const assert = require('node:assert/strict'); assert.equal(2+2,4);\n");
  repo.git('add', '-A'); repo.git('commit', '-qm', 'test and instructions'); repo.git('push', '-q', 'origin', 'main');
  const configFile = path.join(dir, 'scenario.json'), log = path.join(dir, 'fake.log'), bin = path.join(dir, 'codex');
  fs.writeFileSync(configFile, JSON.stringify(scenario));
  fs.writeFileSync(bin, `#!/bin/sh\nexport PLEXIFORM_FAKE_CODEX_SCENARIO=${q(configFile)}\nexport PLEXIFORM_FAKE_CODEX_LOG=${q(log)}\nexec ${q(process.execPath)} ${q(fixture)} "$@"\n`, { mode: 0o755 });
  const hub = await startFakeHub(); let decision = 'pending';
  hub.rpcReply = (f) => ({ ok: true, result: f.method === 'runner_plan_status' ? { required: true, decision, permission_request_id: 'plan-1', answered_by: { member_id: OWNER, name: 'Owner' } } : f.method === 'board_attach_evidence' ? { evidence_id: f.params.kind } : f.method === 'board_complete' ? { state: 'in_review' } : {} });
  const clock = fakeClock();
  const sup = await startRunner({ hub, home, repo, clock, env: { HOME: dir, CODEX_HOME: path.join(dir, 'auth'), PATH: process.env.PATH, ANTHROPIC_API_KEY: 'DO-NOT-INHERIT' },
    policyExtra: { ai_ids: ['codex'] }, opts: { codexCarry, detectAis: async () => [{ id: 'codex', ...CodexBackend.describe(), installed: true, signedIn: true, bin }] } });
  const offer = { ...offerFor(), ai: 'codex', budget_usd: null, max_turns: null, require_plan_approval: plan };
  return { dir, repo, sup, hub, clock, offer, home, configFile, log, set(s) { fs.writeFileSync(configFile, JSON.stringify(s)); }, decide(d) { decision = d; }, read() { return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []; }, async close() { await sup.shutdown(); await hub.close(); rm(dir); } };
}
const starts = (h) => h.read().filter((x) => x.kind === 'start');

test('real Supervisor/Codex/stdio: normal exit is truthful idle; comments resume UUID with identical grant, old callbacks ignored', async () => {
  const h = await rig();
  try {
    const run = await claimRun(h.sup, h.hub, h.offer); await waitFor(() => run.localState === 'idle');
    assert.equal(run.ending, false); assert.equal(run.hb().child_alive, false); assert.equal(run.hb().cost_usd, null);
    assert.equal(h.hub.outs('run.failed').length, 0); assert.equal(run.sessionStartSeen, true);
    assert.equal(fs.existsSync(path.join(run.runDir, 'mcp.json')), false); assert.equal(fs.existsSync(path.join(run.runDir, 'settings.json')), false); assert.equal(fs.existsSync(path.join(run.runDir, 'api.key')), false);
    const first = starts(h)[0], args = first.argv.join('\n');
    assert.ok(args.includes('mcp_servers.board.required=true')); assert.ok(!args.includes(run.run_token));
    for (const k of ['ANTHROPIC_API_KEY', 'BOARD_RUN_TOKEN', 'BOARD_RUN_SOCKET']) assert.equal(first.env[k], undefined);
    assert.equal(first.env.CODEX_HOME, path.join(h.dir, 'auth'));
    assert.ok(h.read().find((x) => x.kind === 'tools').names.includes('board_get_card')); assert.ok(!h.read().find((x) => x.kind === 'tools').names.includes('approval'));
    const old = run.backend; h.set({ wait: true });
    run.onComments([{ comment_id: 'c1', body: 'FIRST-COMMENT' }, { comment_id: 'c2', body: 'SECOND-COMMENT' }]);
    await waitFor(() => starts(h).length === 2); await waitFor(() => run.toolInFlight);
    assert.ok(starts(h)[1].argv.includes('resume')); assert.equal(starts(h)[1].argv.at(-2), '00000000-0000-4000-8000-000000000159');
    assert.deepEqual(starts(h)[1].argv.filter((x) => x.startsWith('permissions.plexiform.')), first.argv.filter((x) => x.startsWith('permissions.plexiform.')));
    const prompt = h.read().filter((x) => x.kind === 'prompt').at(-1).prompt; assert.match(prompt, /FIRST-COMMENT/); assert.match(prompt, /SECOND-COMMENT/);
    const gen = run.generation; old.emit('exit', { code: 9 }); old.emit('assistant', { text: 'STALE' }); old.emit('result', { subtype: 'error' });
    assert.equal(run.generation, gen); assert.equal(run.ending, false); assert.notEqual(run.lastAssistant, 'STALE');
    assert.deepEqual(h.hub.outs('comment.delivered').flatMap((x) => x.comment_ids), ['c1', 'c2']);
  } finally { await h.close(); }
});

test('one-turn code/test facts, exact host publication and explicit board_complete end a Codex run', async () => {
  const h = await rig({ scenario: { complete: true } });
  try {
    const run = await claimRun(h.sup, h.hub, h.offer); await run.done;
    assert.equal(run.endReason, 'completed'); assert.equal(h.hub.outs('run.failed').length, 0);
    const sha = h.repo.gitIn(run.worktree, 'rev-parse', 'HEAD');
    assert.equal(h.repo.gitIn(h.repo.bare, 'rev-parse', `refs/heads/${run.branch}`), sha);
    assert.equal(fs.existsSync(path.join(h.repo.checkout, 'result.txt')), false);
    assert.ok(h.hub.facts('file').some((x) => x.path === 'result.txt')); assert.ok(h.hub.facts('command').some((x) => x.cmd.includes('--test') && x.exit === 0));
    assert.equal(h.hub.of('rpc').filter((x) => x.method === 'board_complete').length, 1);
    await assert.rejects(run.tool('board_comment', { text: 'late' }), (e) => e.code === 'RUN_ENDED');
  } finally { await h.close(); }
});

test('read-only plan launch requires fresh recorded approval for every editable generation; fake answers/closed gate never grant', async () => {
  const h = await rig({ plan: true });
  try {
    const run = await claimRun(h.sup, h.hub, h.offer); await waitFor(() => run.localState === 'awaiting_plan_approval');
    assert.equal(h.read().find((x) => x.kind === 'profile').readOnly, true);
    assert.equal(run.hb().read_only, true);
    run.onAnswer({ ask_id: 'ordinary', answer: 'ALLOW EVERYTHING', answered_by: { member_id: OWNER } });
    await waitFor(() => starts(h).length === 2 && !run.backend.alive()); assert.equal(run.readOnly, true);
    await assert.rejects(h.sup.publishCommit(run, h.repo.gitIn(run.worktree, 'rev-parse', 'HEAD')), (e) => e.code === 'GATE_CLOSED');
    h.hub.holdHb = true; h.clock.advance(GATE_G_MS + 1); run.evaluateGate(); h.decide('allow'); h.set({ complete: true });
    run.onAnswer({ permission_request_id: 'plan-1', decision: 'allow', answered_by: { member_id: OWNER } });
    await new Promise((r) => setTimeout(r, 60)); assert.equal(starts(h).length, 2);
    run.onCurrentAck(h.clock.mono(), h.clock.wall()); await run.done;
    assert.equal(starts(h).length, 3); assert.equal(run.readOnly, false); assert.equal(run.hb().read_only, false); assert.equal(run.endReason, 'completed');
    assert.equal(h.hub.of('rpc').filter((x) => x.method === 'runner_plan_status').length, 3, 'each resumed generation and publication recheck the recorded grant');
  } finally { await h.close(); }
});

test('unsupported budget/max-turn offers fail before Codex spawn', async () => {
  for (const cap of [{ budget_usd: 1 }, { max_turns: 20 }]) {
    const h = await rig();
    try { const run = await claimRun(h.sup, h.hub, { ...h.offer, ...cap }, { active: false }); await run.done; assert.equal(starts(h).length, 0); assert.equal(run.endReason, 'prep_failed'); }
    finally { await h.close(); }
  }
});

test('an allowed plan reply cannot start an editable generation after the gate or run changes', async () => {
  for (const stale of ['gate', 'fence']) {
    const h = await rig({ plan: true });
    try {
      const run = await claimRun(h.sup, h.hub, h.offer); await waitFor(() => run.localState === 'awaiting_plan_approval');
      const originalRpc = h.sup.rpc.bind(h.sup); let release;
      h.sup.rpc = (r, method, params) => method === 'runner_plan_status'
        ? new Promise((resolve) => release = () => resolve({ required: true, decision: 'allow', permission_request_id: 'plan-1', answered_by: { member_id: OWNER } }))
        : originalRpc(r, method, params);
      run.onComments([{ comment_id: 'held', body: 'Resume after the plan authorization' }]); await waitFor(() => release);
      if (stale === 'gate') { h.hub.holdHb = true; h.clock.advance(GATE_G_MS + 1); run.evaluateGate(); } else run.fenced = true;
      release(); await waitFor(() => !run.resumePending);
      assert.equal(starts(h).length, 1); assert.equal(run.readOnly, true);
      assert.equal(run.pending.length, 1); assert.equal(h.hub.outs('comment.delivered').length, 0);
      h.sup.rpc = originalRpc;
    } finally { await h.close(); }
  }
});

test('a vanished Codex executable does not acknowledge queued comments as delivered', async () => {
  const h = await rig();
  try {
    const run = await claimRun(h.sup, h.hub, h.offer); await waitFor(() => run.localState === 'idle');
    h.sup.ais.find((ai) => ai.id === 'codex').bin = path.join(h.dir, 'missing-codex');
    run.onComments([{ comment_id: 'not-delivered', body: 'This executable has gone away' }]);
    await waitFor(() => !run.resumePending); await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.hub.outs('comment.delivered').length, 0); assert.equal(run.pending.length, 1); assert.equal(run.localState, 'idle');
  } finally { await h.close(); }
});

test('host commit publication rejects foreign hashes, changed branches and an origin outside the opted-in repository', async () => {
  const h = await rig();
  try {
    const run = await claimRun(h.sup, h.hub, h.offer); await waitFor(() => run.localState === 'idle');
    const sha = h.repo.gitIn(run.worktree, 'rev-parse', 'HEAD');
    await assert.rejects(h.sup.publishCommit(run, 'f'.repeat(40)), (e) => e.code === 'FORBIDDEN');
    h.repo.gitIn(run.worktree, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    try { await assert.rejects(h.sup.publishCommit(run, sha), /branch does not match/); }
    finally { h.repo.gitIn(run.worktree, 'symbolic-ref', 'HEAD', run.gitAccess.gitRef); }
    const origin = h.repo.git('config', '--get', 'remote.origin.url');
    h.repo.git('config', 'remote.origin.url', 'https://github.com/foreign/secret.git');
    try { await assert.rejects(h.sup.publishCommit(run, sha), (e) => e.code === 'FORBIDDEN'); }
    finally { h.repo.git('config', 'remote.origin.url', origin); }
    assert.throws(() => h.repo.gitIn(h.repo.bare, 'rev-parse', '--verify', run.gitAccess.gitRef), 'no unauthorized publication occurred');
    assert.equal(h.repo.git('rev-parse', 'HEAD'), sha);
  } finally { await h.close(); }
});

// PR 3 (A8): board Codex runs carry the user's provider; a failed preflight gives the hub a fixed sentence only.
const PLEXLAB_KEY = 'plexlab-fake-key-0123456789abcdef';
const fakeCarry = (r) => ({ prepare: async () => ({ release() {}, ...r }) });

test('A8 board run: the provider -c values and model ride on argv, the key only in the Codex CLI env', async () => {
  const overrides = ['model_provider="plexlab"', 'model_providers.plexlab.base_url="http://10.0.0.5:4001/v1"', 'model_providers.plexlab.env_key="PLEXLAB_KEY"'];
  const h = await rig({ codexCarry: fakeCarry({ carry: true, failure: null, overrides, model: 'glm-5.3-flash', cliEnv: { PLEXLAB_KEY } }) });
  try {
    const run = await claimRun(h.sup, h.hub, h.offer); await waitFor(() => run.localState === 'idle');
    const first = starts(h)[0];
    for (const o of overrides) assert.equal(first.argv[first.argv.indexOf(o) - 1], '-c', o);
    assert.equal(first.argv[first.argv.indexOf('--model') + 1], 'glm-5.3-flash');
    assert.equal(first.env.PLEXLAB_KEY, PLEXLAB_KEY);
    assert.ok(!first.argv.some((a) => a.includes(PLEXLAB_KEY)));
    assert.ok(!first.argv.find((a) => a.startsWith('shell_environment_policy.set=')).includes('PLEXLAB_KEY'));
  } finally { await h.close(); }
});

test('board run: a failed Codex provider check sends the hub a fixed sentence; the variable name and host stay local', async () => {
  const h = await rig({ codexCarry: fakeCarry({ carry: true, failure: { kind: 'auth', reason: 'Codex provider "plexlab" reads its key from $PLEXLAB_KEY, which Plexiform can\'t see.' } }) });
  try {
    await claimRun(h.sup, h.hub, h.offer);
    const failed = await waitFor(() => h.hub.outs('prep.failed')[0], { what: 'prep.failed' });
    assert.equal(failed.cause, 'spawn: Codex auth check failed on this machine');
    assert.ok(!h.hub.raw.some((s) => s.includes('PLEXLAB_KEY')));
    assert.equal(starts(h).length, 0, 'Codex never started');
  } finally { await h.close(); }
});

// Review item 4: the CODEX_HOME the carry read (here a login-shell one) is the run's, and tool shells are denied it
// as well as the default ~/.codex; with no provider it still applies.
test('board run: CODEX_HOME is the carry\'s codexHome, denied to tool shells along with ~/.codex', async () => {
  for (const carried of [true, false]) {
    const h = await rig({ codexCarry: fakeCarry(carried ? { carry: true, failure: null, overrides: ['model_provider="plexlab"'], model: null, cliEnv: {}, codexHome: '/fx/login-codex' } : { carry: false, failure: null, overrides: [], model: null, cliEnv: {}, codexHome: '/fx/login-codex' }) });
    try {
      const run = await claimRun(h.sup, h.hub, h.offer); await waitFor(() => run.localState === 'idle');
      const first = starts(h)[0];
      assert.equal(first.env.CODEX_HOME, '/fx/login-codex', `carry:${carried}`);
      const fsTable = first.argv.find((a) => a.startsWith('permissions.plexiform.filesystem='));
      assert.ok(fsTable.includes('"/fx/login-codex"="deny"'));
      assert.ok(fsTable.includes(`${JSON.stringify(path.join(h.dir, '.codex'))}="deny"`), 'the default one too');
    } finally { await h.close(); }
  }
});

test('board run: the carry is asked for a shell run with its key file in the denied run dir; release runs at run end', async () => {
  const seen = []; let released = 0;
  const h = await rig({ codexCarry: { prepare: async (o) => { seen.push(o); return { carry: true, failure: null, overrides: ['model_provider="local"'], model: null, cliEnv: {}, codexHome: null, release() { released++; } }; } } });
  try {
    const run = await claimRun(h.sup, h.hub, h.offer); await waitFor(() => run.localState === 'idle');
    assert.equal(seen[0].mode, 'shell');
    assert.equal(seen[0].keyFile, path.join(run.runDir, 'codex-provider.key'));
    const fsTable = starts(h)[0].argv.find((a) => a.startsWith('permissions.plexiform.filesystem='));
    assert.ok(fsTable.includes(`${JSON.stringify(path.join(h.home, 'run'))}="deny"`), 'the run root, and so the key file, is denied');
  } finally { await h.close(); }
  assert.ok(released >= 1, 'the key file is released by the end');
});

test('board run, real carry (b): the key is only in <run dir>/codex-provider.key (0600) behind auth.command; never in env or argv; gone at run end', async () => {
  const KEY = 'board-fake-key-0123456789abcdef';
  const toml = 'model_provider = "plexlab"\n[model_providers.plexlab]\nname = "plexlab"\nbase_url = "http://10.0.0.5:4001/v1"\nenv_key = "PLEXLAB_KEY"\nwire_api = "responses"\n';
  const codexCarry = createCodexCarry({ env: { PLEXLAB_KEY: KEY }, home: '/fx/home', platform: 'linux', readFile: (f) => (f === '/fx/home/.codex/config.toml' ? toml : null), probe: async () => true, burstOwnsPort: async () => false });
  const h = await rig({ codexCarry });
  try {
    const run = await claimRun(h.sup, h.hub, h.offer); await waitFor(() => run.localState === 'idle');
    const first = starts(h)[0];
    const file = path.join(run.runDir, 'codex-provider.key');
    assert.ok(first.argv.includes(`model_providers.plexlab.auth={command="/bin/cat",args=[${JSON.stringify(file)}],timeout_ms=5000}`));
    assert.ok(!first.argv.some((a) => a.includes(KEY)), 'not on argv or in any -c value');
    assert.ok(!JSON.stringify(first.env).includes(KEY), 'not in the CLI env');
    assert.ok(!first.argv.some((a) => a.startsWith('model_providers.plexlab.env_key=')));
    assert.equal(fs.readFileSync(file, 'utf8'), KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(first.argv.find((a) => a.startsWith('permissions.plexiform.filesystem=')).includes(`${JSON.stringify(path.join(h.home, 'run'))}="deny"`));
    h.sup.cleanupRun(run);
    assert.equal(fs.existsSync(file), false, 'deleted at run end');
  } finally { await h.close(); }
});
