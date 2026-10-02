// BOARD_AUTH=local (D35): the hub embedded in the desktop app. Config
// refusals, the per-launch board_local cookie on HTTP, static and WS, the L1
// loopback guard, runner device tokens, the local owner seed, /api/me, and
// server.js's parentPort messages (a real child process with a fake port).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { silentLogger } from '../log.js';
import { fakeClock, fakeGitHub, testConfig, startHub, FakeRunner, FakeBrowser } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..', 'server.js');
const PRELOAD = new URL('./fixtures/fake-parent-port.js', import.meta.url).href;
const SECRET = 'l'.repeat(64);

async function startLocal({ dataDir } = {}) {
  const cfg = testConfig({ auth: 'local', localSecret: SECRET, devLoginSecret: null, ...(dataDir ? { dataDir, dbPath: join(dataDir, 'board.db') } : {}) });
  const app = createApp(cfg, { clock: fakeClock(), log: silentLogger, github: fakeGitHub(), timers: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const get = (path, headers = {}) => new Promise((ok, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let body = null; try { body = JSON.parse(text); } catch { /* static */ } ok({ status: res.statusCode, body }); });
    });
    req.on('error', fail);
    req.end();
  });
  const wsStatus = (path, headers) => new Promise((ok) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers });
    ws.on('unexpected-response', (_, res) => ok(res.statusCode));
    ws.on('open', () => { ws.terminate(); ok(101); });
    ws.on('error', () => {});
  });
  return { app, cfg, port, base, get, wsStatus, cookie: `board_local=${SECRET}` };
}

test('local auth refuses non-loopback binds, proxies, tunnels and the dev seed; BOARD_LOCAL_SECRET ≥ 32 bytes', () => {
  assert.equal(loadConfig({ BOARD_AUTH: 'local' }).auth, 'local');
  for (const bind of ['127.0.0.1', '::1', 'localhost']) assert.equal(loadConfig({ BOARD_AUTH: 'local', BOARD_BIND: bind }).bind, bind);
  for (const bind of ['0.0.0.0', '192.168.1.5', '::', '127.0.0.2']) assert.throws(() => loadConfig({ BOARD_AUTH: 'local', BOARD_BIND: bind }), /BOARD_BIND/, bind);
  assert.throws(() => loadConfig({ BOARD_AUTH: 'local', BOARD_PUBLIC_URL: 'https://board.example.com' }), /proxy or tunnel/);
  assert.throws(() => loadConfig({ BOARD_AUTH: 'local', BOARD_TUNNEL_PROBE_URL: 'https://board.example.com/api/health' }), /proxy or tunnel/);
  assert.throws(() => loadConfig({ BOARD_AUTH: 'local', BOARD_DEV_SEED: '1' }), /DEV_SEED/);
  assert.throws(() => loadConfig({ BOARD_AUTH: 'local', BOARD_LOCAL_SECRET: 'short' }), /32 bytes/);
  assert.throws(() => loadConfig({ BOARD_AUTH: 'dev', BOARD_LOCAL_SECRET: SECRET }), /BOARD_AUTH=local/);
  assert.throws(() => loadConfig({ BOARD_AUTH: 'nope' }), /access, dev or local/);
  const c = loadConfig({ BOARD_AUTH: 'local', BOARD_PORT: '0', BOARD_LOCAL_SECRET: SECRET });
  assert.equal(c.port, 0);
  assert.equal(c.localSecret, SECRET);
  assert.equal(c.bootstrapBoard, 'Me:ME');
});

test('local auth: only the board_local cookie authenticates (API, static, browser WS); runners keep device tokens', async () => {
  const h = await startLocal();
  try {
    for (const path of ['/api/me', '/api/health', '/', '/web/app.js']) {
      assert.notEqual((await h.get(path, { cookie: h.cookie })).status, 401, path);
      assert.equal((await h.get(path)).status, 401, `${path} without a cookie`);
      assert.equal((await h.get(path, { cookie: `board_local=${'m'.repeat(64)}` })).status, 401, `${path} with a wrong cookie`);
      assert.equal((await h.get(path, { cookie: `board_local=${SECRET.slice(1)}` })).status, 401, `${path} with a short cookie`);
      assert.equal((await h.get(path, { cookie: `board_dev=${SECRET}` })).status, 401, `${path} with another cookie`);
      assert.equal((await h.get(path, { cookie: 'board_local=%E0' })).status, 401, `${path} with a malformed cookie`);
    }
    assert.equal((await h.get('/', { cookie: h.cookie })).status, 200);

    assert.equal(await h.wsStatus('/ws/board', {}), 401);
    assert.equal(await h.wsStatus('/ws/board', { cookie: 'board_local=nope' }), 401);
    assert.equal(await h.wsStatus('/ws/board', { cookie: 'board_local=%E0' }), 401);
    const me = (await h.get('/api/me', { cookie: h.cookie })).body;
    const b = new FakeBrowser(h.base, h.cookie);
    await b.open();
    const snap = await b.subscribe(me.boards[0].id);
    assert.equal(snap.board_id, me.boards[0].id);
    b.terminate();

    // Enrol a device the way the web does, then connect a runner with no cookie.
    const res = await fetch(`${h.base}/api/devices`, { method: 'POST', headers: { cookie: h.cookie, 'content-type': 'application/json', origin: h.base }, body: JSON.stringify({ request_id: randomUUID(), name: 'This Mac' }) });
    assert.equal(res.status, 200);
    const dev = await res.json();
    const r = new FakeRunner(h.base, dev);
    await r.open();
    const welcome = await r.hello([]);
    assert.equal(welcome.type, 'welcome');
    r.terminate();
    const bad = new FakeRunner(h.base, { ...dev, device_token: 'bdt_nope' });
    await bad.open();
    assert.equal(await bad.closed(), 4401);
  } finally {
    await h.app.close({ graceMs: 200 });
    rmSync(h.cfg.dataDir, { recursive: true, force: true });
  }
});

test('local auth refuses proxy headers and a non-loopback Host even with the right cookie (HTTP and WS)', async () => {
  const h = await startLocal();
  try {
    for (const host of ['localhost', `localhost:${h.port}`, `127.0.0.1:${h.port}`, `[::1]:${h.port}`]) assert.equal((await h.get('/api/health', { host, cookie: h.cookie })).status, 200, host);
    for (const host of ['board.example.com', `board.example.com:${h.port}`, '127.0.0.1.evil.io', '10.0.0.5']) assert.equal((await h.get('/api/health', { host, cookie: h.cookie })).status, 403, host);
    for (const hdr of ['cf-connecting-ip', 'cf-ray', 'cf-access-jwt-assertion', 'x-forwarded-for', 'forwarded']) {
      assert.equal((await h.get('/api/me', { [hdr]: '1.2.3.4', cookie: h.cookie })).status, 403, hdr);
      assert.equal((await h.get('/', { [hdr]: '1.2.3.4', cookie: h.cookie })).status, 403, `${hdr} (static)`);
      assert.equal(await h.wsStatus('/ws/board', { [hdr]: '1.2.3.4', cookie: h.cookie }), 403, `${hdr} (browser WS)`);
      assert.equal(await h.wsStatus('/ws/runner', { [hdr]: '1.2.3.4', authorization: 'Bearer bdt_x' }), 403, `${hdr} (runner WS)`);
    }
  } finally {
    await h.app.close({ graceMs: 200 });
    rmSync(h.cfg.dataDir, { recursive: true, force: true });
  }
});

test('local auth seeds one org, "My board" and an email-less owner once; /api/me answers with it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-local-'));
  try {
    let h = await startLocal({ dataDir });
    const me = (await h.get('/api/me', { cookie: h.cookie })).body;
    const user = userInfo().username;
    assert.deepEqual(me.member, { id: me.member.id, github_login: null, display_name: user, role: 'owner', avatar_url: null });
    assert.equal(me.org.name, 'Me');
    assert.deepEqual(me.boards.map((b) => [b.name, b.key_prefix]), [['My board', 'ME']]);
    const row = h.app.db.get('SELECT * FROM members WHERE id = ?', me.member.id);
    assert.equal(row.github_login, `local:${user}`);
    assert.equal(row.email, null);
    await h.app.close({ graceMs: 200 });

    h = await startLocal({ dataDir });
    const again = (await h.get('/api/me', { cookie: h.cookie })).body;
    assert.equal(again.member.id, me.member.id, 'a restart maps to the same owner');
    assert.equal(h.app.db.get('SELECT count(*) AS n FROM members').n, 1);
    await h.app.close({ graceMs: 200 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function runServer(env, { preload = true } = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BOARD_')));
  const child = spawn(process.execPath, [...(preload ? ['--import', PRELOAD] : []), SERVER], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const out = { stdout: '', stderr: '', messages: [] };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  child.on('message', (m) => out.messages.push(m));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const message = () => new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`no parentPort message; stderr: ${out.stderr}`)), 10_000);
    const done = (m) => { clearTimeout(t); ok(m); };
    if (out.messages.length) done(out.messages[0]); else child.once('message', done);
  });
  return { child, out, exited, message };
}

test('server.js under a parentPort: board.listening with the real port (BOARD_PORT=0) and the secret, which never reaches the logs', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-local-'));
  const s = runServer({ BOARD_AUTH: 'local', BOARD_PORT: '0', BOARD_DATA_DIR: dataDir, BOARD_LOG_LEVEL: 'debug' });
  try {
    const m = await s.message();
    assert.equal(m.type, 'board.listening');
    assert.ok(Number.isInteger(m.port) && m.port > 0, 'a real port, not 0');
    assert.match(m.hub_epoch, /\S/);
    assert.match(m.local_secret, /^[0-9a-f]{64}$/, '32 random bytes, hex');
    const base = `http://127.0.0.1:${m.port}`;
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: `board_local=${m.local_secret}` } })).status, 200);
    assert.equal((await fetch(`${base}/api/me`)).status, 401);
    assert.match(s.out.stderr, new RegExp(`"port":${m.port}`), 'the log reports the real port');
    s.child.kill('SIGTERM');
    assert.equal(await s.exited, 0);
    assert.equal(s.out.stdout, '');
    assert.ok(!s.out.stderr.includes(m.local_secret), 'the secret is not in the log');
    assert.ok(!s.out.stdout.includes(m.local_secret));
  } finally {
    s.child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('server.js under a parentPort: board.enc_key is accepted once, bad keys are refused, and the key never reaches the logs (D36)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-local-'));
  const s = runServer({ BOARD_AUTH: 'local', BOARD_PORT: '0', BOARD_DATA_DIR: dataDir, BOARD_LOG_LEVEL: 'debug' });
  const reply = () => new Promise((ok) => s.child.once('message', ok));
  try {
    assert.equal((await s.message()).type, 'board.listening');
    let r = reply();
    s.child.send({ type: 'board.enc_key', key: Buffer.alloc(16, 1).toString('base64') });
    assert.deepEqual(await r, { type: 'board.enc_key', ok: false, reason: 'vault key must be 32 bytes' });
    const key = Buffer.alloc(32, 7).toString('base64');
    r = reply();
    s.child.send({ type: 'board.enc_key', key });
    assert.deepEqual(await r, { type: 'board.enc_key', ok: true });
    r = reply();
    s.child.send({ type: 'board.enc_key', key: Buffer.alloc(32, 9).toString('base64') });
    assert.deepEqual(await r, { type: 'board.enc_key', ok: false, reason: 'vault key already set' });
    s.child.kill('SIGTERM');
    assert.equal(await s.exited, 0);
    assert.ok(!s.out.stderr.includes(key) && !s.out.stdout.includes(key), 'the key is not in the log');
  } finally {
    s.child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('server.js under a parentPort: startup errors send board.fatal and exit non-zero; dev mode sends no local_secret', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-local-'));
  try {
    const bad = runServer({ BOARD_AUTH: 'local', BOARD_BIND: '0.0.0.0', BOARD_DATA_DIR: dataDir });
    const m = await bad.message();
    assert.equal(m.type, 'board.fatal');
    assert.match(m.message, /BOARD_BIND/);
    assert.equal(await bad.exited, 2);

    const blocker = await startLocal();
    const busy = runServer({ BOARD_AUTH: 'local', BOARD_PORT: String(blocker.port), BOARD_DATA_DIR: dataDir});
    const f = await busy.message();
    assert.equal(f.type, 'board.fatal');
    assert.match(f.message, /EADDRINUSE/);
    assert.notEqual(await busy.exited, 0);
    await blocker.app.close({ graceMs: 200 });
    rmSync(blocker.cfg.dataDir, { recursive: true, force: true });

    const devDir = mkdtempSync(join(tmpdir(), 'board-local-'));
    const dev = runServer({ BOARD_AUTH: 'dev', BOARD_PORT: '0', BOARD_DATA_DIR: devDir });
    const d = await dev.message();
    assert.equal(d.type, 'board.listening');
    assert.equal('local_secret' in d, false);
    dev.child.kill('SIGTERM');
    await dev.exited;
    rmSync(devDir, { recursive: true, force: true });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('server.js without a parentPort behaves as before (no message, starts normally)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-local-'));
  const s = runServer({ BOARD_AUTH: 'local', BOARD_PORT: '0', BOARD_DATA_DIR: dataDir }, { preload: false });
  try {
    const deadline = Date.now() + 10_000;
    while (!/hub listening/.test(s.out.stderr) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.match(s.out.stderr, /hub listening/);
    assert.deepEqual(s.out.messages, []);
    s.child.kill('SIGTERM');
    assert.equal(await s.exited, 0);
    assert.equal(s.out.stdout, '');
  } finally {
    s.child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('L1: a database created in local mode refuses to start in dev/access mode, and dev login never yields a local: member', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-local-'));
  try {
    const h = await startLocal({ dataDir });
    await h.app.close({ graceMs: 200 });
    for (const auth of ['dev', 'access']) {
      const cfg = testConfig({ auth, dataDir, dbPath: join(dataDir, 'board.db'), ...(auth === 'access' ? { accessTeam: 't', accessAud: 'a' } : {}) });
      assert.throws(() => createApp(cfg, { clock: fakeClock(), log: silentLogger, github: fakeGitHub(), timers: false }), /belongs to the desktop app/);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }

  const d = await startHub();
  try {
    d.db.insert('members', { id: randomUUID(), org_id: d.ids.org, github_id: -5, github_login: 'local:evil', email: null, display_name: 'evil', role: 'owner', created_at: new Date().toISOString() });
    const res = await fetch(`${d.base}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...d.devHeaders }, body: JSON.stringify({ github_login: 'local:evil' }) });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await d.close?.();
  }
});

test('L2: BOARD_LOCAL_SECRET is refused under a parentPort and scrubbed from the environment after loading', () => {
  process.parentPort = {};
  try {
    assert.throws(() => loadConfig({ BOARD_AUTH: 'local', BOARD_PORT: '0', BOARD_LOCAL_SECRET: SECRET }), /tests only/);
    assert.doesNotThrow(() => loadConfig({ BOARD_AUTH: 'local', BOARD_PORT: '0' }));
  } finally {
    delete process.parentPort;
  }
  process.env.BOARD_LOCAL_SECRET = SECRET;
  process.env.BOARD_AUTH = 'local';
  process.env.BOARD_PORT = '0';
  assert.equal(loadConfig().localSecret, SECRET);
  assert.equal(process.env.BOARD_LOCAL_SECRET, undefined);
  delete process.env.BOARD_AUTH;
  delete process.env.BOARD_PORT;
});

test('L3: a stored local owner that is missing or removed is fatal at startup', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-local-'));
  try {
    const h = await startLocal({ dataDir });
    const id = h.app.hub.localMemberId;
    // A team keeps an owner (D59 trigger): simulate the damage with the trigger out of the way.
    h.app.db.run('DROP TRIGGER members_keep_an_owner');
    h.app.db.run('UPDATE members SET removed_at = ? WHERE id = ?', new Date().toISOString(), id);
    await h.app.close({ graceMs: 200 });
    const cfg = testConfig({ auth: 'local', localSecret: SECRET, devLoginSecret: null, dataDir, dbPath: join(dataDir, 'board.db') });
    assert.throws(() => createApp(cfg, { clock: fakeClock(), log: silentLogger, github: fakeGitHub(), timers: false }), /local owner missing or removed/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('L4: createMember rejects a local: github_login like email:', async () => {
  const h = await startHub();
  try {
    const cookie = await h.login('alice');
    for (const github_login of ['local:x', 'email:x']) {
      const r = await h.api(cookie, 'POST', '/api/members', { request_id: randomUUID(), email: 'pat@example.com', github_login, role: 'member' });
      assert.equal(r.status, 400, github_login);
    }
  } finally {
    await h.close?.();
  }
});

test('db file is created 0600 in a 0700 data dir', async () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'board-local-')), 'nested');
  try {
    const h = await startLocal({ dataDir });
    await h.app.close({ graceMs: 200 });
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dataDir, 'board.db')).mode & 0o777, 0o600);
  } finally {
    rmSync(dirname(dataDir), { recursive: true, force: true });
  }
});
