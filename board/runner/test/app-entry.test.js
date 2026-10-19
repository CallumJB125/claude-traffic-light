// The runner under the desktop app (D37a) and team presence end to end
// (D37b): a real child process with a fake parentPort, against the fake hub.
// Credentials arrive only over parentPort, are used only for the WS connect,
// and never reach a log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WS_CLOSE } from '../../shared/protocol.js';
import { snapshotRef } from '../../shared/fence.js';
import { startFakeHub, makeRepo, tmpDir, rm, waitFor, fakeClaudeBin, offerFor, REPO_ID } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'app-entry.js');
const PRELOAD = path.join(HERE, 'fixtures', 'fake-parent-port.js');
const TOKEN = 'bdt_APPTOKEN0123456789abcdefghijklmnopqrstu';
const CF_ID = 'cfid.APPCLIENTID.access';
const CF_SECRET = 'cfsecret-APPSECRET-0123456789abcdef';

function spawnApp(root, { env = {} } = {}) {
  const child = spawn(process.execPath, ['--import', PRELOAD, ENTRY], {
    // BOARD_HOME points somewhere the app-mode runner must never touch; BOARD_DEBUG logs everything.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: '/tmp', BOARD_HOME: path.join(root, 'cli-home'), BOARD_DEBUG: '1', BOARD_AI_DETECT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const app = { child, stdout: '', stderr: '', messages: [], exit: null };
  child.stdout.on('data', (d) => { app.stdout += d; });
  child.stderr.on('data', (d) => { app.stderr += d; });
  child.on('message', (m) => app.messages.push(m));
  app.exited = new Promise((r) => child.on('exit', (code) => { app.exit = code; r(code); }));
  app.next = (type, pred = () => true, what = type) => waitFor(() => app.messages.find((m) => m.type === type && pred(m)), { what, timeout: 15000 });
  app.statuses = () => app.messages.filter((m) => m.type === 'runner.status').map((m) => m.state);
  app.logs = () => app.stdout + app.stderr;
  return app;
}

const config = (hub, root, over = {}) => ({
  type: 'runner.config', hub_url: hub.url.replace('ws://', 'http://').replace('/ws/runner', ''), device_id: 'dev-app',
  device_token: TOKEN, cf_client_id: CF_ID, cf_client_secret: CF_SECRET, data_dir: path.join(root, 'app-data'), ai_ids: ['claude'], ...over,
});

function assertNoSecrets(text) {
  for (const s of [TOKEN, CF_SECRET, CF_ID, 'APPTOKEN', 'APPSECRET']) assert.equal(text.includes(s), false, `a credential (${s.slice(0, 6)}…) reached the logs`);
}

test('app mode: config → ready → connected, credentials only on the WS connect, no device file, SIGTERM exits 0', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const app = spawnApp(root);
  try {
    app.child.send(config(hub, root));
    await app.next('runner.ready');
    await app.next('runner.status', (m) => m.state === 'connected');
    assert.equal(app.messages.findIndex((m) => m.type === 'runner.ready') < app.messages.findIndex((m) => m.type === 'runner.status'), true, 'ready first');
    assert.equal(hub.lastAuth, `Bearer ${TOKEN}`);
    assert.equal(hub.lastHeaders['cf-access-client-id'], CF_ID);
    assert.equal(hub.lastHeaders['cf-access-client-secret'], CF_SECRET);
    assert.equal(hub.of('hello')[0].device_id, 'dev-app');
    for (const raw of hub.raw) assertNoSecrets(raw);

    const data = path.join(root, 'app-data');
    assert.ok(fs.existsSync(path.join(data, 'outbox')), 'data_dir is the home');
    assert.ok(fs.existsSync(path.join(data, 'worktrees')));
    assert.equal(fs.existsSync(path.join(data, 'device.json')), false, 'no device file');
    assert.equal(fs.statSync(data).mode & 0o777, 0o700, 'data_dir is private');
    assert.equal(fs.statSync(path.join(data, 'runner.sock')).mode & 0o777, 0o600, 'control socket 0600');
    assert.equal(fs.existsSync(path.join(root, 'cli-home')), false, 'BOARD_HOME is ignored');

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hub.of('presence').length, 0, 'no runner.presence → nothing sent');

    app.child.kill('SIGTERM');
    assert.equal(await app.exited, 0);
    assertNoSecrets(app.logs());
    for (const m of app.messages) assertNoSecrets(JSON.stringify(m));
  } finally {
    app.child.kill('SIGKILL');
    await hub.close();
    rm(root);
  }
});

test('app mode, accounts P4 (D80): {hub_url, runner_token, team_id, data_dir} → Bearer + Board-Team on the WS connect only; hello names no device', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  // Runtime-assembled (never a token-shaped literal in the source).
  const runnerToken = ['brt', '_'].join('') + crypto.randomBytes(32).toString('base64url');
  const teamId = crypto.randomUUID();
  const app = spawnApp(root);
  try {
    app.child.send({ type: 'runner.config', hub_url: hub.url.replace('ws://', 'http://').replace('/ws/runner', ''), runner_token: runnerToken, team_id: teamId, data_dir: path.join(root, 'app-data') });
    await app.next('runner.ready');
    await app.next('runner.status', (m) => m.state === 'connected');
    assert.equal(hub.lastAuth, `Bearer ${runnerToken}`);
    assert.equal(hub.lastHeaders['board-team'], teamId);
    assert.equal(hub.lastHeaders['cf-access-client-id'], undefined);
    assert.equal(hub.of('hello')[0].device_id, '', 'the hub names the device in welcome');
    for (const raw of hub.raw) assert.ok(!raw.includes(runnerToken));
    const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.isSocket() ? [] : [path.join(dir, e.name)]));
    for (const f of files(path.join(root, 'app-data'))) assert.ok(!fs.readFileSync(f, 'utf8').includes(runnerToken), `${f} holds the token`);
    app.child.kill('SIGTERM');
    assert.equal(await app.exited, 0);
    assert.ok(!app.logs().includes(runnerToken) && !app.logs().includes(runnerToken.slice(4, 24)), 'never logged');
    for (const m of app.messages) assert.ok(!JSON.stringify(m).includes(runnerToken));
  } finally {
    app.child.kill('SIGKILL');
    await hub.close();
    rm(root);
  }
});

test('app mode: a bad runner.config is fatal with a non-zero exit (and never echoes the token)', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  try {
    for (const [over, re] of [
      [{ device_token: '' }, /device_token/],
      [{ data_dir: 'relative/dir' }, /data_dir/],
      [{ ai_ids: ['codex', 'arbitrary'] }, /ai_ids/],
      [{ ai_ids: ['codex', 'codex'] }, /ai_ids/],
      [{ ai_ids: 'claude' }, /ai_ids/],
      [{ hub_url: 'ftp://x' }, /hub_url/],
      [{ hub_url: 'http://hub.example.com' }, /hub_url must be https: or wss:/],
      [{ hub_url: 'ws://10.0.0.5:8080/ws/runner' }, /hub_url must be https: or wss:/],
      [{ hub_url: 'http://localhost.evil.com' }, /hub_url must be https: or wss:/],
      [{ hub_url: 'http://127.0.0.1.nip.io' }, /hub_url must be https: or wss:/],
      [{ cf_client_secret: undefined }, /cf_client_id and cf_client_secret/],
      [{ runner_token: ['bdt', '_x'].join(''), team_id: 't1', device_id: undefined, device_token: undefined, cf_client_id: undefined, cf_client_secret: undefined }, /runner_token required/],
      [{ runner_token: ['brt', '_x'].join(''), device_id: undefined, device_token: undefined, cf_client_id: undefined, cf_client_secret: undefined }, /team_id required/],
      [{ runner_token: ['brt', '_x'].join(''), team_id: 't1' }, /runner_token goes without/],
    ]) {
      const app = spawnApp(root);
      app.child.send(config(hub, root, over));
      const f = await app.next('runner.fatal');
      assert.match(f.message, re);
      assert.notEqual(await app.exited, 0);
      assert.equal(app.messages.some((m) => m.type === 'runner.ready'), false);
      assertNoSecrets(app.logs() + JSON.stringify(app.messages));
    }
    assert.equal(hub.upgrades ?? 0, 0, 'never connected');
  } finally {
    await hub.close();
    rm(root);
  }
});

test('app mode: close codes map to runner.status (4503 unavailable → connected; 4401 unauthenticated), no secret logged', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  hub.closeWith = WS_CLOSE.UNAVAILABLE;
  const app = spawnApp(root);
  try {
    app.child.send(config(hub, root));
    await app.next('runner.status', (m) => m.state === 'unavailable');
    hub.closeWith = null;
    await app.next('runner.status', (m) => m.state === 'connected');
    hub.closeWith = WS_CLOSE.UNAUTHENTICATED;
    hub.dropAll();
    await app.next('runner.status', (m) => m.state === 'unauthenticated');
    // The dropped socket (1006) is a backoff; the reconnect is then refused 4401.
    assert.deepEqual(app.statuses(), ['unavailable', 'connected', 'backoff', 'unauthenticated']);
    app.child.kill('SIGTERM');
    assert.equal(await app.exited, 0);
    assertNoSecrets(app.logs());
  } finally {
    app.child.kill('SIGKILL');
    await hub.close();
    rm(root);
  }
});

test('app mode presence: default deny, no paths, hashed ids, opt-in redacted ≤ 120-char summary; enabled:false clears', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  fs.mkdirSync(path.join(root, 'a'));
  fs.mkdirSync(path.join(root, 'b'));
  const repo = makeRepo(path.join(root, 'a'));
  const other = makeRepo(path.join(root, 'b'), { remoteUrl: 'https://github.com/acme/secret-other.git' });
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  fs.mkdirSync(path.join(repo.checkout, 'src'));
  const app = spawnApp(root);
  try {
    app.child.send(config(hub, root));
    await app.next('runner.status', (m) => m.state === 'connected');
    const longSummary = `editing ${repo.checkout}/src/parser.js and /Users/someone/notes.txt with sk-ant-api03-SECRETSECRETSECRET ${'x'.repeat(200)}`;
    app.child.send({ type: 'runner.presence', enabled: true, share_summaries: true, sessions: [
      { session_id: 'local-session-1', agent: 'claude', cwd: path.join(repo.checkout, 'src'), state: 'working', since: '2026-09-30T10:00:00Z', summary: longSummary },
      { session_id: 'local-session-2', agent: 'codex', cwd: other.checkout, state: 'idle', since: '2026-09-30T10:00:00Z', summary: 'the other repo' },
      { session_id: 'local-session-3', agent: 'cursor', cwd: plain, state: 'waiting', since: '2026-09-30T10:00:00Z' },
      { session_id: 'local-session-4', agent: 'unknown-agent', cwd: repo.checkout, state: 'working', since: 1 },
    ] });
    const f = await waitFor(() => hub.of('presence')[0], { what: 'presence frame', timeout: 15000 });
    assert.equal(f.sessions.length, 1, 'only the board-linked repo session survives');
    const [s] = f.sessions;
    assert.deepEqual(Object.keys(s).sort(), ['agent', 'branch', 'repo_id', 'session_id', 'since', 'state', 'summary']);
    assert.equal(s.repo_id, REPO_ID);
    assert.equal(s.branch, 'main');
    assert.equal(s.agent, 'claude');
    assert.notEqual(s.session_id, 'local-session-1');
    assert.ok(s.summary.length <= 120);
    assert.match(s.summary, /^editing src\/parser\.js and <path> with <redacted:anthropic_key>/);
    const raw = hub.raw.find((r) => r.includes('"type":"presence"'));
    for (const bad of [root, '/tmp/', '/private/', '/Users/', 'local-session', 'secret-other', 'the other repo', 'SECRETSECRET', '"cwd"']) assert.equal(raw.includes(bad), false, `presence frame leaked ${bad}`);

    app.child.send({ type: 'runner.presence', enabled: false, sessions: [] });
    const cleared = await waitFor(() => hub.of('presence')[1], { what: 'clearing frame', timeout: 15000 });
    assert.deepEqual(cleared.sessions, []);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hub.of('presence').length, 2, 'disabled sends nothing more');

    app.child.kill('SIGTERM');
    assert.equal(await app.exited, 0);
    assertNoSecrets(app.logs());
  } finally {
    app.child.kill('SIGKILL');
    await hub.close();
    rm(root);
  }
});

// A live run under the app, then SIGTERM: the handover window, a pushed
// snapshot at the run's fence and release{requeue}, not a crash orphan.
function appWithRepo(root, scenario, { acceptFrom = [] } = {}) {
  const repo = makeRepo(root);
  const data = path.join(root, 'app-data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({
    repos: { [REPO_ID]: { opt_in: true, local_path: repo.checkout, max_concurrent: 2, approvals_from: [] } },
    accept_from: { [REPO_ID]: acceptFrom }, backends: { claude: fakeClaudeBin(root, scenario) }, never_auto_labels: ['never_auto'],
  }), { mode: 0o600 });
  return repo;
}

const HANDOVER_SCENARIO = {
  steps: [{ result: 'success' }],
  on_input: { 'asked for a handover': [{ mcp: 'board_write_handover', args: { patch: { next: 'finish the parser after the restart' } } }, { result: 'success' }] },
};

test('app mode quit: SIGTERM parks a live run (handover, pushed snapshot, release{requeue}); the next start finds no orphan', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  hub.rpcReply = (f) => ({ ok: true, result: f.method === 'board_release' ? { state: 'queued' } : {} });
  appWithRepo(root, HANDOVER_SCENARIO);
  let app = spawnApp(root);
  try {
    app.child.send(config(hub, root));
    await app.next('runner.status', (m) => m.state === 'connected');
    hub.send(offerFor({ key: 'Q-1' }));
    const claim = await waitFor(() => hub.of('claim')[0], { what: 'claim', timeout: 15000 });
    await waitFor(() => hub.outs('activity').length, { what: 'the run is live', timeout: 15000 });
    await waitFor(() => hub.facts('cost').length, { what: 'the first turn ended (idle)', timeout: 15000 });

    const t0 = Date.now();
    app.child.kill('SIGTERM');
    assert.equal(await app.exited, 0);
    assert.ok(Date.now() - t0 < 26_000, 'bounded by the quit budget');
    assert.deepEqual(app.statuses().slice(-1), ['stopping']);
    const stopped = app.messages.find((m) => m.type === 'runner.stopped');
    assert.deepEqual({ ...stopped }, { type: 'runner.stopped', parked: 1, parked_pending: 0, orphaned: 0 });

    const fence = claim.expected_fence + 1;
    assert.equal(hub.outs('handover.write')[0]?.patch.next, 'finish the parser after the restart');
    const snap = hub.outs('snapshot').at(-1);
    assert.equal(snap.fence, fence);
    assert.equal(snap.ref, snapshotRef('Q-1', fence));
    const rel = hub.of('rpc').filter((f) => f.method === 'board_release');
    assert.equal(rel.length, 1);
    assert.equal(rel[0].params.requeue, true);
    assert.equal(rel[0].fence, fence);
    assert.equal(hub.outs('run.failed').length, 0, 'never run.failed');
    assert.equal(hub.outs('handover.complete').length, 0, 'not a hub-requested handover');
    const iWrite = hub.frames.findIndex((f) => f.type === 'out' && f.msg.kind === 'handover.write');
    const iSnap = hub.frames.lastIndexOf(hub.frames.findLast((f) => f.type === 'out' && f.msg.kind === 'snapshot'));
    assert.ok(iWrite < iSnap && iSnap < hub.frames.indexOf(rel[0]), 'handover, then snapshot, then release');
    assert.equal(hub.of('claim').length, 1, 'the requeued card is not claimed again while quitting');

    app = spawnApp(root);
    app.child.send(config(hub, root));
    await app.next('runner.status', (m) => m.state === 'connected');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hub.outs('run.failed').length, 0, 'no supervisor-crash orphan on the next start');
    app.child.kill('SIGTERM');
    assert.equal(await app.exited, 0);
    assert.deepEqual(app.messages.find((m) => m.type === 'runner.stopped'), { type: 'runner.stopped', parked: 0, parked_pending: 0, orphaned: 0 });
  } finally {
    app.child.kill('SIGKILL');
    await hub.close();
    rm(root);
  }
});

test('app mode quit: a release the hub refuses leaves the run to the next start\'s orphan handling', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  hub.rpcReply = (f) => (f.method === 'board_release' ? { ok: false, error: { code: 'POLICY_DENIED', message: 'never_auto' } } : { ok: true, result: {} });
  appWithRepo(root, HANDOVER_SCENARIO);
  let app = spawnApp(root);
  try {
    app.child.send(config(hub, root));
    await app.next('runner.status', (m) => m.state === 'connected');
    hub.send(offerFor({ key: 'Q-2' }));
    await waitFor(() => hub.outs('activity').length, { what: 'the run is live', timeout: 15000 });
    app.child.kill('SIGTERM');
    assert.equal(await app.exited, 0);
    assert.deepEqual(app.messages.find((m) => m.type === 'runner.stopped'), { type: 'runner.stopped', parked: 0, parked_pending: 0, orphaned: 1 });
    assert.equal(hub.outs('run.failed').length, 0);

    app = spawnApp(root);
    app.child.send(config(hub, root));
    const f = await waitFor(() => hub.outs('run.failed')[0], { what: 'orphan run.failed', timeout: 15000 });
    assert.equal(f.reason, 'supervisor crash');
    app.child.kill('SIGTERM');
    assert.equal(await app.exited, 0);
  } finally {
    app.child.kill('SIGKILL');
    await hub.close();
    rm(root);
  }
});

test('app mode: data_dir must be private: a symlink is refused, a wider directory is tightened to 0700', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  try {
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, path.join(root, 'link'));
    let app = spawnApp(root);
    app.child.send(config(hub, root, { data_dir: path.join(root, 'link') }));
    assert.match((await app.next('runner.fatal')).message, /symlink/);
    assert.notEqual(await app.exited, 0);
    assert.equal(app.messages.some((m) => m.type === 'runner.ready'), false);

    const wide = path.join(root, 'wide');
    fs.mkdirSync(wide);
    fs.chmodSync(wide, 0o777);
    app = spawnApp(root);
    app.child.send(config(hub, root, { data_dir: wide }));
    await app.next('runner.ready');
    assert.equal(fs.statSync(wide).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(wide, 'runner.sock')).mode & 0o777, 0o600);
    app.child.kill('SIGTERM');
    assert.equal(await app.exited, 0);
  } finally {
    await hub.close();
    rm(root);
  }
});

// "Budget reached" reaches the giver's own desktop (and only theirs) as exactly
// {type:'runner.event', event:'run.budget_reached', run_id, card_id, spent_usd, budget_usd, card_key?}.
async function budgetRun(scenario, { by, acceptFrom } = {}) {
  const root = tmpDir();
  const hub = await startFakeHub();
  appWithRepo(root, scenario, { acceptFrom });
  const app = spawnApp(root);
  try {
    app.child.send(config(hub, root));
    await app.next('runner.status', (m) => m.state === 'connected');
    hub.send(offerFor({ key: 'BUD-7', ...(by ? { by } : {}) }));
    await waitFor(() => hub.outs('run.failed')[0], { what: 'run.failed', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 300));
    return { failed: hub.outs('run.failed')[0], events: app.messages.filter((m) => m.type === 'runner.event') };
  } finally {
    app.child.kill('SIGKILL');
    await hub.close();
    rm(root);
  }
}

test('app mode: a budget stop on the giver\'s own device posts exactly run.budget_reached', async () => {
  const { failed, events } = await budgetRun({ steps: [{ result: 'error_max_budget_usd', cost: 1.25 }] });
  assert.equal(failed.fail_kind, 'budget');
  assert.equal(events.length, 1);
  const e = events[0];
  assert.deepEqual(Object.keys(e).sort(), ['budget_usd', 'card_id', 'card_key', 'event', 'run_id', 'spent_usd', 'type']);
  assert.equal(e.event, 'run.budget_reached');
  assert.equal(e.card_id, 'card-BUD-7');
  assert.equal(e.card_key, 'BUD-7');
  assert.match(e.run_id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(e.spent_usd, 1.25);
  assert.equal(e.budget_usd, 1);
});

test('app mode: max_turns never posts run.budget_reached', async () => {
  const { failed, events } = await budgetRun({ steps: [{ result: 'error_max_turns' }] });
  assert.equal(failed.fail_kind, 'error');
  assert.deepEqual(events, []);
});

test('app mode: a budget stop of a teammate\'s card on this device posts nothing (only the giver\'s device hears it)', async () => {
  const { failed, events } = await budgetRun({ steps: [{ result: 'error_max_budget_usd', cost: 1.25 }] }, { by: 'm-teammate', acceptFrom: ['m-teammate'] });
  assert.equal(failed.fail_kind, 'budget');
  assert.deepEqual(events, []);
});
