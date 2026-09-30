// The runner under the desktop app (D37a) and team presence end to end
// (D37b): a real child process with a fake parentPort, against the fake hub.
// Credentials arrive only over parentPort, are used only for the WS connect,
// and never reach a log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WS_CLOSE } from '../../shared/protocol.js';
import { startFakeHub, makeRepo, tmpDir, rm, waitFor, REPO_ID } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'app-entry.js');
const PRELOAD = path.join(HERE, 'fixtures', 'fake-parent-port.js');
const TOKEN = 'bdt_APPTOKEN0123456789abcdefghijklmnopqrstu';
const CF_ID = 'cfid.APPCLIENTID.access';
const CF_SECRET = 'cfsecret-APPSECRET-0123456789abcdef';

function spawnApp(root, { env = {} } = {}) {
  const child = spawn(process.execPath, ['--import', PRELOAD, ENTRY], {
    // BOARD_HOME points somewhere the app-mode runner must never touch; BOARD_DEBUG logs everything.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: '/tmp', BOARD_HOME: path.join(root, 'cli-home'), BOARD_DEBUG: '1', ...env },
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
  device_token: TOKEN, cf_client_id: CF_ID, cf_client_secret: CF_SECRET, data_dir: path.join(root, 'app-data'), ...over,
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

test('app mode: a bad runner.config is fatal with a non-zero exit (and never echoes the token)', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  try {
    for (const [over, re] of [
      [{ device_token: '' }, /device_token/],
      [{ data_dir: 'relative/dir' }, /data_dir/],
      [{ hub_url: 'ftp://x' }, /hub_url/],
      [{ cf_client_secret: undefined }, /cf_client_id and cf_client_secret/],
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

test('app mode presence: default deny, no paths, hashed ids, redacted ≤ 120-char summary; enabled:false clears', async () => {
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
    app.child.send({ type: 'runner.presence', enabled: true, sessions: [
      { session_id: 'local-session-1', agent: 'claude', cwd: path.join(repo.checkout, 'src'), state: 'working', since: 1_790_000_000_000, summary: longSummary },
      { session_id: 'local-session-2', agent: 'codex', cwd: other.checkout, state: 'idle', since: 1_790_000_000_000, summary: 'the other repo' },
      { session_id: 'local-session-3', agent: 'cursor', cwd: plain, state: 'waiting', since: 1_790_000_000_000 },
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
