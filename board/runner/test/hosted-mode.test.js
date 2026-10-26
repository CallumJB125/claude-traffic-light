// The supervisor in hosted (cloud) mode against the fake hub, the fake claude
// and a fake cgroup tree: on-demand clone with a repo token, the team's
// provider key delivered per run to the CLI's key file only, the per-run
// cgroup wrapper, cancel, and the token / wall-clock / memory caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor } from '../supervisor.js';
import { HostedMode, HOSTED_BRIEF, hostedConfig } from '../hosted/index.js';
import { makeLogger } from '../util.js';
import { execFileSync } from 'node:child_process';
import { tmpDir, rm, makeRepo, startFakeHub, fakeClaudeBin, fakeClock, offerFor, claimRun, waitFor, readFakeLog, alive, filesHolding, REPO_ID } from './helpers.js';

const SECRET = 'sk-ant-api03-hosted-test-secret-0123456789';
const GH_TOKEN = 'ghs_hostedtesttoken0123456789abcdef';
const posix = process.platform !== 'win32';

function capturingLog() {
  const lines = [];
  const stream = { write: (s) => { lines.push(String(s)); return true; } };
  return { log: makeLogger(stream), text: () => lines.join('') };
}

async function hostedRig({ scenario, caps = {}, rpc, tokenAnswer = null, claudeCarry, codexCarry } = {}) {
  const root = tmpDir('hst-');
  const repo = makeRepo(root);
  // What GitHub is to the Pi: the clone URL reaches the local bare repo.
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, `[url "file://${repo.bare}"]\n\tinsteadOf = https://github.com/acme/app.git\n`);
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  const cgroot = path.join(root, 'cgroup', 'buddy-runner.service');
  fs.mkdirSync(path.join(cgroot, 'supervisor'), { recursive: true });
  const tokenCalls = [];
  const fetchImpl = async (url, init) => {
    tokenCalls.push({ url, auth: init.headers.authorization });
    if (tokenAnswer) return { status: tokenAnswer.status, ok: tokenAnswer.status < 300, json: async () => tokenAnswer.body };
    return { status: 200, ok: true, json: async () => ({ token: GH_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }) };
  };
  const hub = await startFakeHub();
  hub.rpcReply = rpc ?? ((f) => (f.method === 'runner_provider_config'
    ? { ok: true, result: { provider: 'claude', configured: true, api_key: SECRET, model: 'claude-hosted-model' } }
    : { ok: true, result: {} }));
  const home = path.join(root, 'home');
  const config = {
    hub: 'http://127.0.0.1:1', team: 'team-1', runnerToken: 'brt_hostedrunnertoken0123456789', tokenFile: null, home,
    repos: ['github.com/acme/app'], ais: ['claude'], allowUnsandboxed: false, sandbox: 'cgroup', credentialsDir: path.join(root, 'creds'),
    maxConcurrent: 2, hermesEndpoint: null, gitName: 'Cloud', gitEmail: 'cloud@example.test',
    caps: { wallMs: 60_000, maxTokens: 1_000_000, maxUsd: 5, cpuPercent: 100, tasksMax: 256, memoryBytes: 1 << 30, ...caps },
  };
  const cap = capturingLog();
  const hosted = new HostedMode({ config, log: cap.log, fetchImpl, cgroup: { ok: true, base: cgroot, controllers: ['cpu', 'pids'], memory: false }, memoryPollMs: 50 });
  const clock = fakeClock();
  const bin = fakeClaudeBin(root, scenario);
  const sup = new Supervisor({
    home: hosted.boardHome, device: hosted.device, hubUrl: hub.url, clock, claudeBin: bin, autoTick: false, hosted, log: cap.log, claudeCarry, codexCarry,
    env: hosted.childEnv({ HOME: path.join(home, 'cli-home'), USER: process.env.USER ?? 'runner', PATH: process.env.PATH, TMPDIR: process.platform === 'darwin' ? '/tmp' : os.tmpdir(), LANG: 'en_US.UTF-8' }),
    interruptWaitMs: 500, stopGraceMs: 800, gitleaks: null, rand: () => 0, reconnectDelayFn: () => 30, keepRunFiles: false, buddyHome: null, detectAis: async () => null,
    controlSocket: false,
  });
  await sup.start();
  await waitFor(() => sup.connected, { what: 'hosted runner connected' });
  const close = async () => {
    await sup.shutdown({ stopRuns: true }).catch(() => {});
    hosted.close();
    await hub.close();
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    rm(root);
  };
  return { root, repo, hub, sup, hosted, cap, cgroot, tokenCalls, close, clock };
}

const failedOf = (hub, run) => hub.outs('run.failed').find((m) => m.run_id === run.run_id);

test('hostedConfig: refuses an unreadable or wrong token file, a plaintext remote hub and non-GitHub repos; unsandboxed AIs stay off', () => {
  const base = { BUDDY_RUNNER_TOKEN_FILE: '/x/runner-token', BUDDY_RUNNER_HUB: 'https://hub.example.test', BUDDY_RUNNER_TEAM: 'team-1', BUDDY_RUNNER_HOME: '/var/lib/buddy-runner', BUDDY_RUNNER_REPOS: 'github.com/acme/app,https://github.com/acme/other.git' };
  const tok = { readFile: () => 'brt_abcdefghijklmnopqrstuvwxyz0123\n' };
  const c = hostedConfig({ ...base, BUDDY_RUNNER_AIS: 'claude,codex,hermes-dgx,gemini' }, tok);
  assert.deepEqual(c.repos, ['github.com/acme/app', 'github.com/acme/other']);
  assert.deepEqual(c.ais, ['claude', 'codex'], 'Hermes and Gemini have no OS sandbox: off unless the operator opts in');
  assert.deepEqual(hostedConfig({ ...base, BUDDY_RUNNER_AIS: 'claude,hermes-dgx', BUDDY_RUNNER_ALLOW_UNSANDBOXED: '1' }, tok).ais, ['claude', 'hermes-dgx']);
  assert.equal(c.caps.wallMs, 90 * 60_000);
  assert.throws(() => hostedConfig(base, { readFile: () => { throw new Error('EACCES'); } }), /unreadable/);
  assert.throws(() => hostedConfig(base, { readFile: () => 'not-a-token' }), /does not hold a runner token/);
  assert.throws(() => hostedConfig({ ...base, BUDDY_RUNNER_HUB: 'http://hub.example.test' }, tok), /https/);
  assert.ok(hostedConfig({ ...base, BUDDY_RUNNER_HUB: 'http://127.0.0.1:8787' }, tok), 'the hub on this host over loopback');
  assert.throws(() => hostedConfig({ ...base, BUDDY_RUNNER_REPOS: 'gitlab.com/a/b' }, tok), /github\.com/);
  assert.throws(() => { try { hostedConfig(base, { readFile: () => 'brt_short' }); } catch (e) { assert.ok(!e.message.includes('brt_short'), 'never echoes the token'); throw e; } });
});

test('hosted mode refuses to start without its run sandbox unless the operator turns it off', () => {
  const root = tmpDir('hst-');
  try {
    const config = { hub: 'http://127.0.0.1:1', team: 't', runnerToken: 'brt_x', home: path.join(root, 'h'), repos: [], ais: ['claude'], sandbox: 'cgroup', caps: { wallMs: 1000 } };
    assert.throws(() => new HostedMode({ config, log: makeLogger(null, { quiet: true }), cgroup: { ok: false, reason: 'no delegation' } }), /refuses to start without its run sandbox: no delegation/);
    const off = new HostedMode({ config: { ...config, sandbox: 'off' }, log: makeLogger(null, { quiet: true }) });
    assert.equal(off.cgroup.ok, false);
    off.close();
  } finally { rm(root); }
});

test('a cloud run: clone with a repo token, provider key only in the CLI key file, per-run cgroup, cancel kills the tree and removes it', { skip: !posix }, async () => {
  const rig = await hostedRig({ scenario: { steps: [{ tool: 'Write', input: { file_path: 'src/fix.js', content: 'export const fixed = true;\n' } }, { tool: 'Bash', input: { command: 'make test' }, ms: 30_000, grandchild: true }] } });
  try {
    const { hub, sup, cgroot } = rig;
    const policy = JSON.parse(fs.readFileSync(path.join(rig.hosted.boardHome, 'policy.json'), 'utf8'));
    assert.equal(policy.repos[REPO_ID].opt_in, true, 'the allowlisted, configured repo is opted in');
    assert.equal(policy.repos[REPO_ID].budget_per_run, 5);
    const run = await claimRun(sup, hub, offerFor());
    assert.ok(rig.tokenCalls.length >= 1 && rig.tokenCalls[0].url.endsWith(`/api/runner/v1/repo-token?repo_id=${REPO_ID}`));
    assert.ok(fs.existsSync(path.join(rig.hosted.repoPath(REPO_ID), '.git')), 'cloned on first offer');
    const start = readFakeLog(run.runDir).find((e) => e.ev === 'start');
    assert.ok(!Object.values(start.env).some((v) => String(v).includes(SECRET)), 'the provider key is not in the CLI environment');
    const argv = start.argv;
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-hosted-model');
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '1', 'the card budget, under the hosted per-run cap');
    assert.ok(argv[argv.indexOf('--append-system-prompt') + 1].includes(HOSTED_BRIEF));
    const settings = JSON.parse(fs.readFileSync(path.join(run.runDir, 'settings.json'), 'utf8'));
    assert.match(settings.apiKeyHelper, /api\.key/);
    assert.ok(settings.sandbox.filesystem.denyRead.includes(rig.hosted.config.credentialsDir), 'the agent sandbox cannot read the runner credentials');
    assert.equal(fs.readFileSync(path.join(run.runDir, 'api.key'), 'utf8'), SECRET);
    assert.equal(fs.statSync(path.join(run.runDir, 'api.key')).mode & 0o077, 0);
    const cgdir = path.join(cgroot, `run-${run.run_id}`);
    assert.equal(fs.readFileSync(path.join(cgdir, 'pids.max'), 'utf8'), '256');
    assert.equal(fs.readFileSync(path.join(cgdir, 'cpu.max'), 'utf8'), '100000 100000');
    assert.deepEqual(fs.readFileSync(path.join(cgdir, 'cgroup.procs'), 'utf8').trim(), String(run.backend.pid), 'the CLI started inside its run cgroup');
    const grandchild = readFakeLog(run.runDir).find((e) => e.ev === 'grandchild')?.pid ?? (await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'grandchild'), { what: 'grandchild' })).pid;
    const pid = run.backend.pid;
    // Cancel from the board.
    hub.send({ type: 'cmd', cmd_id: 'c1', run_id: run.run_id, card_id: run.card_id, fence: run.fence, cmd: 'stop' });
    await waitFor(() => run.ended, { what: 'run ended', timeout: 15_000 });
    assert.equal(alive(pid), false);
    assert.equal(alive(grandchild), false);
    await waitFor(() => !fs.existsSync(cgdir), { what: 'run cgroup removed' });
    await waitFor(() => !fs.existsSync(run.runDir), { what: 'run dir (and its key file) removed' });
    const snap = hub.outs('snapshot').find((m) => m.run_id === run.run_id && m.status === 'pushed') ?? hub.of('salvage').map((f) => ({ ...f.payload, run_id: f.run_id })).find((m) => m.run_id === run.run_id && m.status === 'pushed');
    assert.ok(snap, 'the final snapshot was pushed through the token-authenticated remote');
    assert.equal(execFileSync('git', ['--git-dir', rig.repo.bare, 'rev-parse', snap.ref], { encoding: 'utf8' }).trim(), snap.sha);
    assert.ok(!hub.raw.join('\n').includes(SECRET) && !rig.cap.text().includes(SECRET), 'the key is in no frame and no log line');
    assert.ok(!rig.cap.text().includes(GH_TOKEN) && !rig.cap.text().includes('brt_hosted'), 'no token in the log');
    assert.deepEqual(filesHolding(rig.root, GH_TOKEN), [], 'the repo token never reached disk');
  } finally { await rig.close(); }
});

test('cap exceeded: the hosted token cap fails the run as the machine owner\'s limit', { skip: !posix }, async () => {
  const rig = await hostedRig({ scenario: { steps: [{ assistant: 'working' }, { result: 'success' }] }, caps: { maxTokens: 10 } });
  try {
    const run = await claimRun(rig.sup, rig.hub, offerFor({ key: 'APP-2' }));
    await waitFor(() => failedOf(rig.hub, run), { what: 'run.failed', timeout: 10_000 });
    const f = failedOf(rig.hub, run);
    assert.equal(f.fail_kind, 'budget');
    assert.equal(f.budget_scope, 'device');
    assert.match(f.reason, /token cap/);
    await waitFor(() => run.ended, { what: 'ended' });
  } finally { await rig.close(); }
});

test('cap exceeded: the wall-clock cap stops a run that keeps working', { skip: !posix }, async () => {
  const rig = await hostedRig({ scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep' }, ms: 30_000 }] }, caps: { wallMs: 400 } });
  try {
    const run = await claimRun(rig.sup, rig.hub, offerFor({ key: 'APP-3' }));
    const pid = run.backend.pid;
    await waitFor(() => failedOf(rig.hub, run), { what: 'run.failed', timeout: 10_000 });
    assert.equal(failedOf(rig.hub, run).fail_kind, 'error');
    assert.match(failedOf(rig.hub, run).reason, /time limit/);
    await waitFor(() => run.ended && !alive(pid), { what: 'stopped', timeout: 10_000 });
  } finally { await rig.close(); }
});

test('cap exceeded: without a kernel memory controller the watchdog kills the run cgroup', { skip: !posix }, async () => {
  const rig = await hostedRig({ scenario: { steps: [{ tool: 'Bash', input: { command: 'build' }, ms: 30_000 }] }, caps: { memoryBytes: 64 * 1048576 } });
  try {
    const run = await claimRun(rig.sup, rig.hub, offerFor({ key: 'APP-4' }));
    const pid = run.backend.pid;
    rig.hosted.watches.get(run.run_id).cg.rssBytes = () => 65 * 1048576;
    await waitFor(() => failedOf(rig.hub, run), { what: 'run.failed', timeout: 10_000 });
    assert.match(failedOf(rig.hub, run).reason, /memory limit/);
    await waitFor(() => run.ended && !alive(pid), { what: 'killed', timeout: 10_000 });
  } finally { await rig.close(); }
});

test('no provider key on the hub: the run starts with the CLI\'s own login; hub refusal of the credential fails the start', { skip: !posix }, async () => {
  const rig = await hostedRig({ scenario: { steps: [{ result: 'success' }] }, rpc: (f) => (f.method === 'runner_provider_config' ? { ok: true, result: { provider: 'claude', configured: false } } : { ok: true, result: {} }) });
  try {
    const run = await claimRun(rig.sup, rig.hub, offerFor({ key: 'APP-5' }));
    assert.equal(fs.existsSync(path.join(run.runDir, 'api.key')), false);
    rig.hub.rpcReply = (f) => (f.method === 'runner_provider_config' ? { ok: false, error: { code: 'FORBIDDEN', message: 'provider credentials go only to a hosted runner' } } : { ok: true, result: {} });
    rig.hub.send({ type: 'cmd', cmd_id: 'c5', run_id: run.run_id, card_id: run.card_id, fence: run.fence, cmd: 'stop' });
    await waitFor(() => run.ended, { what: 'first ended' });
    rig.hub.send(offerFor({ key: 'APP-6' }));
    await waitFor(() => rig.hub.outs('prep.failed').length, { what: 'prep.failed', timeout: 10_000 });
    assert.match(rig.hub.outs('prep.failed')[0].cause, /spawn: provider credentials go only to a hosted runner/);
  } finally { await rig.close(); }
});

test('no GitHub App installation for the repo: the offer is declined with the hub\'s reason, never left queued; a hub outage keeps it queued', { skip: !posix }, async () => {
  const why = 'this repository is not linked to the team\'s GitHub App installation (Integrations → GitHub → Choose repositories)';
  const rig = await hostedRig({ scenario: { steps: [{ result: 'success' }] }, tokenAnswer: { status: 404, body: { error: { code: 'NOT_FOUND', message: why, reason: 'no_installation' } } } });
  try {
    const offer = offerFor({ key: 'APP-7' });
    rig.hub.send(offer);
    const d = await waitFor(() => rig.hub.of('decline').find((f) => f.card_id === offer.card_id), { what: 'decline' });
    assert.equal(d.request_id, offer.request_id);
    assert.equal(d.reason, `The cloud runner cannot clone this repository: ${why}`);
    assert.equal(rig.hub.of('claim').length, 0);
    assert.equal(fs.existsSync(path.join(rig.hosted.repoPath(REPO_ID), '.git')), false);
  } finally { await rig.close(); }
  const down = await hostedRig({ scenario: { steps: [{ result: 'success' }] }, tokenAnswer: { status: 503, body: { error: { code: 'PROVIDER_UNAVAILABLE', message: 'GitHub could not be reached; try again shortly' } } } });
  try {
    const offer = offerFor({ key: 'APP-8' });
    down.hub.send(offer);
    await waitFor(() => down.tokenCalls.length >= 1, { what: 'token asked' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(down.hub.of('decline').length, 0, 'a transient failure is not a decline');
    assert.equal(down.hub.of('claim').length, 0);
    assert.match(down.cap.text(), /the offer stays queued/);
  } finally { await down.close(); }
});

test('C6: a hosted run carries nothing from the service user\'s own Claude config; the hub config is the only source', { skip: !posix }, async () => {
  let asked = 0;
  const claudeCarry = { prepare: async () => { asked++; return { carry: true, failure: null, settingsEnv: { ANTHROPIC_BASE_URL: 'https://service-user.example/v1' }, model: 'service-user-model', disallowed: [], denyRead: [], cliEnv: {}, apiKeyFile: null, release() {} }; } };
  let codexAsked = 0;
  const codexCarry = { prepare: async () => { codexAsked++; return { carry: true, failure: null, overrides: ['model_provider="service-user"'], model: 'service-user-model', cliEnv: {}, release() {} }; } };
  const rig = await hostedRig({ scenario: { steps: [{ result: 'success' }] }, claudeCarry, codexCarry });
  try {
    const run = await claimRun(rig.sup, rig.hub, offerFor());
    const start = readFakeLog(run.runDir).find((e) => e.ev === 'start');
    const settings = JSON.parse(fs.readFileSync(path.join(run.runDir, 'settings.json'), 'utf8'));
    assert.equal(asked, 0, 'the carry was never consulted');
    assert.equal(codexAsked, 0, 'nor the Codex carry');
    assert.ok(!('env' in settings), 'no routing in the run settings');
    assert.equal(start.argv[start.argv.indexOf('--model') + 1], 'claude-hosted-model', 'the hub\'s model, not the service user\'s');
    assert.ok(!JSON.stringify(start).includes('service-user'));
  } finally { await rig.close(); }
});
