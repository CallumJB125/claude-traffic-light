// Buddy main window: page registry, navigation lock, and the embedded hub
// supervisor (fake utilityProcess child, no Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PAGES, flat, pageById, hubPageUrl, navDecision, pageForHubUrl } = require('../buddy-window/pages');
const { createHubSupervisor, hubEnv, MAX_RESTARTS } = require('../buddy-window/hub-process');

// ── pages ──────────────────────────────────────────────────────────────────

test('every page has a unique id, a title and a known kind', () => {
  const all = flat();
  assert.equal(new Set(all.map((p) => p.id)).size, all.length);
  for (const p of all) {
    assert.ok(p.title, p.id);
    assert.ok(['hub', 'window', 'local', 'soon'].includes(p.kind), p.id);
    if (p.kind === 'window') assert.ok(p.window, p.id);
  }
  for (const want of ['board', 'myday', 'tasks', 'integrations', 'team', 'usage', 'setups', 'plugins', 'settings']) assert.ok(pageById(want), want);
  assert.equal(PAGES[0].id, 'board');
});

test('hub page URLs carry ?view= for every view but the board itself', () => {
  assert.equal(hubPageUrl('http://127.0.0.1:5000', pageById('board')), 'http://127.0.0.1:5000/');
  assert.equal(hubPageUrl('http://127.0.0.1:5000/', pageById('board:table')), 'http://127.0.0.1:5000/?view=table');
  assert.equal(pageForHubUrl('http://127.0.0.1:5000/?view=table#card=x'), 'board:table');
  assert.equal(pageForHubUrl('http://127.0.0.1:5000/'), 'board');
  assert.equal(pageForHubUrl('http://127.0.0.1:5000/?view=nope'), 'board');
});

test('the hub view only navigates within its origin (+ the team Access login)', () => {
  const o = { hubOrigin: 'http://127.0.0.1:5000', accessTeam: 'pistor' };
  assert.equal(navDecision('http://127.0.0.1:5000/?view=table', o), 'allow');
  assert.equal(navDecision('http://127.0.0.1:5001/', o), 'external');
  assert.equal(navDecision('https://pistor.cloudflareaccess.com/cdn-cgi/access/login', o), 'allow');
  assert.equal(navDecision('https://evil.cloudflareaccess.com/', o), 'external');
  assert.equal(navDecision('http://pistor.cloudflareaccess.com/', o), 'external');
  assert.equal(navDecision('https://github.com/o/r/pull/1', o), 'external');
  assert.equal(navDecision('file:///etc/passwd', o), 'deny');
  assert.equal(navDecision('javascript:alert(1)', o), 'deny');
  assert.equal(navDecision('not a url', o), 'deny');
  assert.equal(navDecision('https://pistor.cloudflareaccess.com/', { hubOrigin: o.hubOrigin }), 'external');
});

// ── hub env ────────────────────────────────────────────────────────────────

test('hub env is an allowlist: no secrets from our env, loopback bind, no secret in local mode', () => {
  const base = { HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-x', GITHUB_TOKEN: 'ghp_x', BOARD_LOCAL_SECRET: 'x'.repeat(40), BOARD_AUTH: 'access' };
  const local = hubEnv({ mode: 'local', dataDir: '/d', baseEnv: base });
  assert.equal(local.BOARD_AUTH, 'local');
  assert.equal(local.BOARD_BIND, '127.0.0.1');
  assert.equal(local.BOARD_PORT, '0');
  assert.equal(local.HOME, '/h');
  for (const k of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'BOARD_LOCAL_SECRET', 'BOARD_DEV_LOGIN_SECRET']) assert.equal(local[k], undefined, k);
  const dev = hubEnv({ mode: 'dev', dataDir: '/d', port: 4321, devSecret: 's', baseEnv: base });
  assert.equal(dev.BOARD_AUTH, 'dev');
  assert.equal(dev.BOARD_PORT, '4321');
  assert.equal(dev.BOARD_DEV_LOGIN_SECRET, 's');
});

test('dev auth is refused in a packaged build', () => {
  assert.throws(() => createHubSupervisor({ fork: () => {}, hubEntry: '/x/board/hub/server.js', dataDir: '/tmp/x', mode: 'dev', isPackaged: true }), /packaged/);
});

// ── supervisor ─────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = 0; this.killed = 0; this.stderr = new (require('node:stream').PassThrough)(); }
  kill() { this.killed += 1; setImmediate(() => this.emit('exit', 0)); return true; }
}

function harness(overrides = {}) {
  const children = [];
  const statuses = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-hub-'));
  let t = 0;
  const sup = createHubSupervisor({
    fork: (entry, args, opts) => { const c = new FakeChild(); c.entry = entry; c.opts = opts; children.push(c); return c; },
    hubEntry: '/app/board/hub/server.js',
    dataDir: path.join(dataDir, 'board'),
    onStatus: (s) => statuses.push(s),
    now: () => t,
    readyTimeoutMs: 200,
    ...overrides,
  });
  return { sup, children, statuses, dataDir: path.join(dataDir, 'board'), tick: (ms) => { t += ms; } };
}

const SECRET = 'a'.repeat(43);

test('local mode: ready on board.listening; the secret comes from the port report, never env', async () => {
  const { sup, children, dataDir } = harness();
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1);
  assert.equal(children[0].opts.env.BOARD_AUTH, 'local');
  assert.equal(children[0].opts.serviceName, 'Buddy Board Hub');
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  children[0].emit('message', { type: 'board.listening', port: 5123, hub_epoch: 'e1', local_secret: SECRET });
  const info = await p;
  assert.deepEqual({ url: info.url, port: info.port, mode: info.mode, localSecret: info.localSecret }, { url: 'http://127.0.0.1:5123', port: 5123, mode: 'local', localSecret: SECRET });
  assert.equal(sup.status().state, 'ready');
  // A second ensure() reuses the running hub.
  assert.equal(await sup.ensure(), info);
  assert.equal(children.length, 1);
});

test('local mode: a hub without local auth (no secret) is a start failure, not a silent open board', async () => {
  const { sup, children } = harness();
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  children[0].emit('message', { type: 'board.listening', port: 5123, hub_epoch: 'e1' });
  await assert.rejects(p, /no local secret/);
  assert.equal(sup.status().state, 'failed');
});

test('board.fatal before exit fails the start with the hub message', async () => {
  const { sup, children } = harness();
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  children[0].emit('message', { type: 'board.fatal', message: 'EADDRINUSE' });
  children[0].emit('exit', 1);
  await assert.rejects(p, /EADDRINUSE/);
  assert.equal(sup.status().state, 'failed');
  assert.match(sup.status().error, /EADDRINUSE/);
});

test('no report in time → failed; retry() starts a new child', async () => {
  const { sup, children } = harness({ readyTimeoutMs: 30 });
  await assert.rejects(sup.ensure(), /did not report/);
  const p = sup.retry();
  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 2);
  children[1].emit('message', { type: 'board.listening', port: 5, local_secret: SECRET });
  await p;
  assert.equal(sup.status().state, 'ready');
});

test('a crash after ready restarts with backoff; the 6th crash in 10 min gives up', async () => {
  const delays = [];
  const pending = [];
  const { sup, children, tick } = harness({ schedule: (fn, ms) => { delays.push(ms); pending.push(fn); } });
  const ready = async (c) => { await new Promise((r) => setImmediate(r)); c.emit('message', { type: 'board.listening', port: 5, local_secret: SECRET }); };
  const p = sup.ensure();
  await ready(children[0]);
  await p;
  for (let i = 0; i < MAX_RESTARTS; i += 1) {
    children.at(-1).emit('exit', 1);
    assert.equal(sup.status().state, 'restarting');
    tick(1000);
    pending.shift()();
    await ready(children.at(-1));
    await new Promise((r) => setImmediate(r));
    assert.equal(sup.status().state, 'ready');
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000]);
  children.at(-1).emit('exit', 1);
  assert.equal(sup.status().state, 'failed');
  assert.match(sup.status().error, /keeps crashing/);
  assert.equal(pending.length, 0);
});

test('crashes older than the window no longer count', async () => {
  const pending = [];
  const { sup, children, tick } = harness({ schedule: (fn) => pending.push(fn) });
  const ready = async (c) => { await new Promise((r) => setImmediate(r)); c.emit('message', { type: 'board.listening', port: 5, local_secret: SECRET }); };
  const p = sup.ensure();
  await ready(children[0]);
  await p;
  for (let i = 0; i < MAX_RESTARTS * 2; i += 1) {
    children.at(-1).emit('exit', 1);
    tick(11 * 60_000);
    assert.equal(sup.status().state, 'restarting');
    pending.shift()();
    await ready(children.at(-1));
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(sup.status().state, 'ready');
});

test('stop() sends SIGTERM (kill) and resolves on exit; no restart after stop', async () => {
  const { sup, children } = harness();
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  children[0].emit('message', { type: 'board.listening', port: 5, local_secret: SECRET });
  await p;
  await sup.stop({ graceMs: 1000 });
  assert.equal(children[0].killed, 1);
  assert.equal(sup.status().state, 'stopped');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(children.length, 1);
});

test('retry() while a hub is running stops it first: never two hubs on one DB', async () => {
  const { sup, children } = harness();
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  children[0].emit('message', { type: 'board.listening', port: 5, local_secret: SECRET });
  await p;
  const q = sup.retry();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(children[0].killed, 1);
  assert.equal(children.length, 2);
  children[1].emit('message', { type: 'board.listening', port: 6, local_secret: SECRET });
  const info = await q;
  assert.equal(info.port, 6);
  assert.equal(sup.status().state, 'ready');
  // The old child's late exit must not disturb the new one.
  assert.equal(sup.status().url, 'http://127.0.0.1:6');
});

test('a failed start kills only its own child', async () => {
  const { sup, children } = harness({ readyTimeoutMs: 30 });
  const first = sup.ensure();
  await assert.rejects(first, /did not report/);
  assert.equal(children[0].killed, 1);
  const p = sup.retry();
  await new Promise((r) => setImmediate(r));
  children[1].emit('message', { type: 'board.listening', port: 7, local_secret: SECRET });
  await p;
  assert.equal(children[1].killed, 0);
});

test('stop() during a dev start (before the fork) forks nothing; final stop blocks later starts', async () => {
  let release;
  const { sup, children } = harness({ mode: 'dev', pickPort: () => new Promise((r) => { release = r; }) });
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  await sup.stop({ final: true });
  release(4444);
  await assert.rejects(p, /stopped/);
  assert.equal(children.length, 0);
  await assert.rejects(sup.ensure(), /quitting/);
  assert.equal(sup.status().state, 'stopped');
});

test('dev mode never logs the dev login secret from the hub stderr', async () => {
  const lines = [];
  const { sup, children } = harness({ mode: 'dev', pickPort: async () => 4555, log: (...a) => lines.push(a.join(' ')), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await sup.ensure();
  children[0].stderr.write('Sign in at:\n  http://127.0.0.1:4555/#dev_secret=SuperSecretValue123\n');
  await new Promise((r) => setImmediate(r));
  assert.ok(lines.some((l) => l.includes('dev_secret=<redacted>')), lines.join('|'));
  assert.ok(!lines.some((l) => l.includes('SuperSecretValue123')));
});

// ── workspaces ─────────────────────────────────────────────────────────────

const { createWorkspaceStore, normalizeHubUrl, accessTeamFromLocation, partitionFor: teamPartition } = require('../buddy-window/workspaces');

test('team hub URLs: https origins only, bare hosts become https, junk refused', () => {
  assert.equal(normalizeHubUrl('buddy.bondly.co.za'), 'https://buddy.bondly.co.za');
  assert.equal(normalizeHubUrl(' https://buddy.bondly.co.za/some/path?x=1#y '), 'https://buddy.bondly.co.za');
  assert.throws(() => normalizeHubUrl('http://buddy.bondly.co.za'), /https/);
  assert.throws(() => normalizeHubUrl('https://user:pw@buddy.bondly.co.za'), /password/);
  assert.throws(() => normalizeHubUrl('localhost:8787'), /public address/);
  assert.throws(() => normalizeHubUrl('https://127.0.0.1'), /public address/);
  assert.throws(() => normalizeHubUrl(''), /Enter/);
  assert.throws(() => normalizeHubUrl('javascript:alert(1)'), /web address|https/);
  assert.equal(teamPartition('https://buddy.bondly.co.za'), 'persist:board-buddy.bondly.co.za');
});

test('the Access team comes only from a *.cloudflareaccess.com redirect', () => {
  assert.equal(accessTeamFromLocation('https://restless-hall-ab0c.cloudflareaccess.com/cdn-cgi/access/login/buddy.bondly.co.za?kid=1'), 'restless-hall-ab0c');
  assert.equal(accessTeamFromLocation('https://evil.example.com/cloudflareaccess.com'), null);
  assert.equal(accessTeamFromLocation('https://a.b.cloudflareaccess.com/'), null);
  assert.equal(accessTeamFromLocation('not a url'), null);
});

test('workspace store: local is always there; add makes a team active; persisted without secrets; remove falls back to local', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ws-'));
  const file = path.join(dir, 'ws.json');
  const s1 = createWorkspaceStore(file);
  assert.equal(s1.active().id, 'local');
  const t = s1.add({ url: 'buddy.bondly.co.za', name: 'Bondly team', accessTeam: 'restless-hall-ab0c' });
  assert.equal(t.id, 'team:buddy.bondly.co.za');
  assert.equal(s1.active().id, t.id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.teams[0]).sort(), ['accessTeam', 'name', 'url']);
  const s2 = createWorkspaceStore(file);
  assert.deepEqual(s2.list().map((w) => w.id), ['local', 'team:buddy.bondly.co.za']);
  assert.equal(s2.active().name, 'Bondly team');
  assert.equal(s2.setActive('team:nope'), false);
  assert.equal(s2.setActive('local'), true);
  s2.setActive(t.id);
  assert.equal(s2.remove(t.id), true);
  assert.equal(s2.active().id, 'local');
});

test('workspace store: a tampered file cannot smuggle in a non-https hub or a bad Access team', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ws-'));
  const file = path.join(dir, 'ws.json');
  fs.writeFileSync(file, JSON.stringify({ active: 'team:evil', teams: [
    { name: 'x', url: 'http://evil.example.com' },
    { name: 'y', url: 'https://ok.example.com', accessTeam: 'evil.example.com/../' },
  ] }));
  const s = createWorkspaceStore(file);
  assert.deepEqual(s.list().map((w) => w.id), ['local', 'team:ok.example.com']);
  assert.equal(s.get('team:ok.example.com').accessTeam, null);
  assert.equal(s.active().id, 'local');
});

// ── this Mac as a runner ──────────────────────────────────────────────────

const { createDeviceController, defaultDeviceName } = require('../buddy-window/device');

function deviceHarness(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-dev-'));
  const calls = [];
  const children = [];
  const statuses = [];
  const pending = [];
  const hub = {
    origin: 'https://buddy.bondly.co.za',
    fetch: async (p, init) => {
      calls.push({ p, init });
      if (over.fetch) return over.fetch(p, init);
      if (init.method === 'POST') return { status: 200, json: { device_id: 'dev-1', device_token: 'bdt_secret_token_value' } };
      return { status: 200, json: { ok: true } };
    },
  };
  const make = () => createDeviceController({
    hub, credsFile: path.join(dir, 'device.bin'),
    seal: (s) => Buffer.from(`SEALED:${Buffer.from(s).toString('base64')}`),
    unseal: (b) => Buffer.from(String(b).slice(7), 'base64').toString(),
    fork: (entry, args, opts) => { const c = new FakeChild(); c.entry = entry; c.args = args; c.opts = opts; c.sent = []; c.postMessage = (m) => c.sent.push(m); children.push(c); return c; },
    runnerEntry: '/app/board/runner/cli.js', dataDir: path.join(dir, 'runner'),
    onStatus: (s) => statuses.push(s), schedule: (fn) => pending.push(fn),
  });
  return { dir, calls, children, statuses, pending, make, credsFile: path.join(dir, 'device.bin') };
}

const CF_ID = `${'a1'.repeat(16)}.access`;
const CF_SECRET = 'c'.repeat(64);

test('device name reads like a person made it', () => {
  assert.equal(defaultDeviceName('Callum', 'Callums-MacBook-Air.local'), 'Callum’s Callums MacBook Air');
  assert.equal(defaultDeviceName('', ''), 'My’s Mac'.replace('My’s', 'My’s'));
});

test('enroll: validates the service token, enrols with cf_service_token_id = client id, seals secrets, starts the runner over parentPort', async () => {
  const h = deviceHarness();
  const d = h.make();
  assert.match((await d.enroll({ name: 'Mac', cfClientId: 'nope', cfClientSecret: CF_SECRET })).error, /Client ID/);
  assert.match((await d.enroll({ name: 'Mac', cfClientId: CF_ID, cfClientSecret: 'short' })).error, /whole Client Secret/);
  assert.equal(h.calls.length, 0);
  const r = await d.enroll({ name: 'Callum’s Mac', cfClientId: CF_ID, cfClientSecret: CF_SECRET });
  assert.equal(r.ok, true);
  assert.equal(h.calls[0].p, '/api/devices');
  assert.equal(h.calls[0].init.body.cf_service_token_id, CF_ID);
  assert.equal(h.calls[0].init.body.cf_service_token_secret, undefined, 'the secret never goes to the hub');
  // Sealed at rest, 0600, no plaintext secret in the file.
  const raw = fs.readFileSync(h.credsFile, 'utf8');
  assert.ok(raw.startsWith('SEALED:'));
  assert.ok(!raw.includes(CF_SECRET) && !raw.includes('bdt_secret'));
  assert.equal(fs.statSync(h.credsFile).mode & 0o777, 0o600);
  // Runner: no secret in argv/env; config over parentPort.
  const c = h.children[0];
  assert.deepEqual(c.args, ['--parent-port']);
  assert.ok(!JSON.stringify(c.opts.env).includes(CF_SECRET) && !JSON.stringify(c.opts.env).includes('bdt_'));
  assert.equal(c.sent[0].type, 'runner.config');
  assert.equal(c.sent[0].device_token, 'bdt_secret_token_value');
  assert.equal(c.sent[0].cf_client_secret, CF_SECRET);
  c.emit('message', { type: 'runner.status', state: 'connected' });
  assert.equal(d.status().runner.state, 'connected');
  assert.equal(d.status().enrolled, true);
});

test('enroll: a signed-out team session says so; the hub refusing is shown, nothing is stored', async () => {
  const h = deviceHarness({ fetch: async () => ({ status: 401, json: {} }) });
  const d = h.make();
  assert.match((await d.enroll({ name: 'Mac', cfClientId: CF_ID, cfClientSecret: CF_SECRET })).error, /Sign in/);
  assert.equal(fs.existsSync(h.credsFile), false);
});

test('off → SIGTERM, stays off across restarts; on again restarts; remove revokes and forgets every secret', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enroll({ name: 'Mac', cfClientId: CF_ID, cfClientSecret: CF_SECRET });
  await d.setEnabled(false);
  assert.equal(h.children[0].killed, 1);
  assert.equal(d.status().enabled, false);
  const d2 = h.make();
  d2.resume();
  assert.equal(h.children.length, 1, 'left off: not started at launch');
  await d2.setEnabled(true);
  assert.equal(h.children.length, 2);
  await d2.remove();
  assert.equal(h.children[1].killed, 1);
  assert.equal(fs.existsSync(h.credsFile), false);
  assert.equal(h.calls.at(-1).init.method, 'DELETE');
  assert.equal(h.calls.at(-1).p, '/api/devices/dev-1');
});

test('runner crash restarts with backoff; revoked/unauthenticated does not loop', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enroll({ name: 'Mac', cfClientId: CF_ID, cfClientSecret: CF_SECRET });
  h.children[0].emit('exit', 1);
  assert.equal(d.status().runner.state, 'restarting');
  h.pending.shift()();
  assert.equal(h.children.length, 2);
  h.children[1].emit('message', { type: 'runner.status', state: 'revoked', detail: 'device revoked' });
  h.children[1].emit('exit', 0);
  assert.equal(h.pending.length, 0);
  assert.equal(d.status().runner.state, 'revoked');
});

test('creds for another hub are ignored', async () => {
  const h = deviceHarness();
  await h.make().enroll({ name: 'Mac', cfClientId: CF_ID, cfClientSecret: CF_SECRET });
  const other = createDeviceController({
    hub: { origin: 'https://other.example.com', fetch: async () => ({}) }, credsFile: h.credsFile,
    seal: (s) => Buffer.from(s), unseal: (b) => Buffer.from(String(b).slice(7), 'base64').toString(),
    fork: () => { throw new Error('must not start'); }, runnerEntry: 'x', dataDir: path.join(h.dir, 'r2'),
  });
  assert.equal(other.status().enrolled, false);
});

// ── Buddy accounts (client against the mock hub) ─────────────────────────

const { createAccountClient, ROUTES, parseInvite, routeInvite, bearerScope, maskEmail } = require('../buddy-window/accounts');
const { createMockAccountsHub, MAX_ATTEMPTS } = require('../buddy-window/mock-accounts-hub');

function memStore() {
  let v = null;
  return { load: () => v, save: (o) => { v = JSON.parse(JSON.stringify(o)); }, clear: () => { v = null; }, peek: () => v };
}

async function withHub(fn) {
  const hub = createMockAccountsHub();
  const origin = await hub.listen();
  try { await fn(hub, origin); } finally { await hub.close(); }
}

async function signIn(hub, origin, email, extra = {}) {
  const store = memStore();
  const c = createAccountClient({ origin, store, ...extra });
  assert.equal((await c.startEmail(email)).ok, true);
  const r = await c.verifyCode(hub.lastCode(email), { deviceName: 'Test Mac', platform: 'darwin' });
  assert.equal(r.ok, true, r.error);
  return { c, store, r };
}

test('ROUTES: every endpoint is one [method, path] row', () => {
  for (const [name, [method, p]] of Object.entries(ROUTES)) {
    assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(method), name);
    assert.match(p, /^\/api\//, name);
  }
});

test('accounts: email + 6-digit code signs in; the device token is sealed in the store, never returned', async () => withHub(async (hub, origin) => {
  const store = memStore();
  const c = createAccountClient({ origin, store });
  assert.match((await c.startEmail('nope')).error, /email/);
  assert.equal((await c.startEmail(' Callum@Example.com ')).ok, true);
  assert.equal(c.pendingEmail(), 'callum@example.com');
  assert.match((await c.verifyCode('12')).error, /6 digits/);
  const code = hub.lastCode('callum@example.com');
  const r = await c.verifyCode(`${code.slice(0, 3)} ${code.slice(3)}`, { deviceName: 'Mac' });
  assert.equal(r.ok, true);
  assert.equal(r.user.email, 'callum@example.com');
  assert.deepEqual(r.teams, []);
  assert.ok(!JSON.stringify(r).includes('bdt_'), 'no token in the result');
  assert.match(store.peek().token, /^bdt_/);
  assert.equal(store.peek().hub, origin);
  assert.equal(c.signedIn(), true);
  const me = await c.me();
  assert.equal(me.user.email, 'callum@example.com');
  assert.deepEqual(me.teams, []);
}));

test('accounts: wrong codes are counted; the flow dies after the limit; codes expire after 10 minutes', async () => withHub(async (hub, origin) => {
  const c = createAccountClient({ origin, store: memStore() });
  await c.startEmail('a@example.com');
  const good = hub.lastCode('a@example.com');
  const wrong = good === '000000' ? '111111' : '000000';
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) assert.match((await c.verifyCode(wrong)).error, /isn’t right/);
  assert.match((await c.verifyCode(wrong)).error, /Too many wrong codes/);
  assert.match((await c.verifyCode(good)).error, /Start again/, 'the flow is gone');
  await c.startEmail('a@example.com');
  hub.setNow(Date.now() + 10 * 60_000 + 1);
  assert.match((await c.verifyCode(hub.lastCode('a@example.com'))).error, /expired/);
}));

test('accounts: a 401 means the token was revoked: wiped, signed-out callback, plain error', async () => withHub(async (hub, origin) => {
  let signedOut = 0;
  const { c, store } = await signIn(hub, origin, 'b@example.com', { onSignedOut: () => { signedOut += 1; } });
  hub.revokeAll('b@example.com');
  const r = await c.me();
  assert.equal(r.ok, false);
  assert.equal(r.signedOut, true);
  assert.match(r.error, /signed out/);
  assert.equal(store.peek(), null);
  assert.equal(signedOut, 1);
  assert.equal((await c.createTeam('x')).signedOut, true, 'no request without a token');
}));

test('accounts: a token saved for another hub is never sent', async () => withHub(async (hub, origin) => {
  const seen = [];
  const store = memStore();
  store.save({ hub: 'https://evil.example.com', token: 'bdt_other_hub' });
  const c = createAccountClient({ origin, store, fetchImpl: async (u, init) => { seen.push(init.headers); return fetch(u, init); } });
  assert.equal(c.signedIn(), false);
  assert.equal((await c.me()).signedOut, true);
  assert.equal(seen.length, 0);
  await c.previewInvite('inv_x');
  assert.ok(seen.every((h) => !h.Authorization));
}));

test('accounts: network failure is a sentence, not a thrown fetch error', async () => {
  const c = createAccountClient({ origin: 'https://buddy.example.com', store: memStore(), fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const r = await c.startEmail('a@example.com');
  assert.deepEqual(r, { ok: false, error: 'Couldn’t reach buddy.example.com. Check the address and your connection.' });
});

test('accounts: create a team, invite by email, second user previews and accepts; wrong account and reuse are refused', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'owner@example.com');
  const t = await owner.c.createTeam('Bondly');
  assert.equal(t.ok, true);
  assert.equal(t.team.role, 'owner');
  assert.equal(t.board.name, 'Bondly');
  const teamId = t.team.id;
  const inv = await owner.c.invite(teamId, 'Sam@Example.com', 'member');
  assert.equal(inv.ok, true);
  assert.equal(inv.invite.email, 'sam@example.com');
  assert.match(inv.code, /^inv_/);
  assert.equal((await owner.c.listInvites(teamId)).invites.length, 1);

  const other = await signIn(hub, origin, 'other@example.com');
  const pv = await other.c.previewInvite(inv.code);
  assert.deepEqual({ team: pv.team_name, role: pv.role, inviter: pv.inviter_name }, { team: 'Bondly', role: 'member', inviter: 'Owner' });
  const wrong = await other.c.acceptInvite({ t: inv.code });
  assert.equal(wrong.code, 'WRONG_ACCOUNT');
  assert.equal(wrong.detail.email_masked, 's…@example.com');

  const sam = await signIn(hub, origin, 'sam@example.com');
  assert.equal(sam.r.ok, true);
  const pending = (await sam.c.me()).pending_invites;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].team_name, 'Bondly');
  const acc = await sam.c.acceptInvite({ inviteId: pending[0].id });
  assert.equal(acc.ok, true);
  assert.equal(acc.team.id, teamId);
  assert.deepEqual((await sam.c.me()).teams.map((x) => [x.name, x.role]), [['Bondly', 'member']]);
  assert.match((await sam.c.acceptInvite({ t: inv.code })).error, /isn’t valid any more/);
  const members = (await owner.c.listMembers(teamId)).members;
  assert.deepEqual(members.map((m) => m.email).sort(), ['owner@example.com', 'sam@example.com']);
  assert.equal((await owner.c.listInvites(teamId)).invites.length, 0);
}));

test('accounts: roles: members cannot manage; the last owner cannot be demoted or removed', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'o@example.com');
  const teamId = (await owner.c.createTeam('T')).team.id;
  const inv = await owner.c.invite(teamId, 'm@example.com', 'member');
  const m = await signIn(hub, origin, 'm@example.com');
  await m.c.acceptInvite({ t: inv.code });
  const list = (await owner.c.listMembers(teamId)).members;
  const me = list.find((x) => x.email === 'o@example.com');
  const them = list.find((x) => x.email === 'm@example.com');
  const r = await owner.c.setRole(teamId, me.id, 'admin');
  assert.equal(r.code, 'LAST_OWNER');
  assert.match(r.error, /at least one owner/);
  assert.equal((await owner.c.removeMember(teamId, me.id)).code, 'LAST_OWNER');
  assert.match((await m.c.setRole(teamId, them.id, 'admin')).error, /permission/);
  assert.match((await m.c.invite(teamId, 'x@example.com', 'member')).error, /permission/);
  assert.equal((await owner.c.setRole(teamId, them.id, 'owner')).ok, true);
  assert.equal((await owner.c.setRole(teamId, me.id, 'admin')).ok, true, 'fine once there is another owner');
  assert.match((await owner.c.setRole(teamId, them.id, 'boss')).error, /Pick a role/);
}));

test('accounts: revoke and resend invites; a revoked code is refused with a plain sentence', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'o@example.com');
  const teamId = (await owner.c.createTeam('T')).team.id;
  const a = await owner.c.invite(teamId, 'x@example.com', 'guest');
  const b = await owner.c.invite(teamId, 'x@example.com', 'guest'); // resend replaces
  const live = (await owner.c.listInvites(teamId)).invites;
  assert.deepEqual(live.map((i) => i.id), [b.invite.id]);
  assert.match((await owner.c.previewInvite(a.code)).error, /isn’t valid any more/);
  assert.equal((await owner.c.revokeInvite(teamId, b.invite.id)).ok, true);
  assert.equal((await owner.c.listInvites(teamId)).invites.length, 0);
  assert.match((await owner.c.previewInvite(b.code)).error, /isn’t valid any more/);
  assert.match((await owner.c.previewInvite('inv_nope')).error, /isn’t valid any more/);
}));

test('accounts: already a member gets a clear answer with the team', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'o@example.com');
  const team = (await owner.c.createTeam('T')).team;
  const inv = await owner.c.invite(team.id, 'o2@example.com', 'member');
  const o2 = await signIn(hub, origin, 'o2@example.com');
  await o2.c.acceptInvite({ t: inv.code });
  const again = await owner.c.invite(team.id, 'o2@example.com', 'member');
  const r = await o2.c.acceptInvite({ t: again.code });
  assert.equal(r.code, 'ALREADY_MEMBER');
  assert.equal(r.detail.team.id, team.id);
}));

test('accounts: sign out revokes on the hub and forgets locally; delete account needs a fresh emailed code', async () => withHub(async (hub, origin) => {
  const a = await signIn(hub, origin, 'a@example.com');
  const token = a.store.peek().token;
  assert.equal((await a.c.signOut()).revoked, true);
  assert.equal(a.store.peek(), null);
  const res = await fetch(`${origin}/api/account`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401, 'the old token is dead on the hub');

  const d = await signIn(hub, origin, 'd@example.com');
  assert.match((await d.c.deleteAccount('123456')).error, /new code/);
  assert.equal((await d.c.startStepUp()).ok, true);
  const code = hub.lastCode('d@example.com');
  assert.equal((await d.c.deleteAccount(code)).ok, true);
  assert.equal(d.store.peek(), null);
  const again = await signIn(hub, origin, 'd@example.com');
  assert.deepEqual((await again.c.me()).teams, [], 'a fresh account');
}));

// ── invite links ───────────────────────────────────────────────────────────

const httpsOnly = (s) => normalizeHubUrl(s);

test('invite links: the accepted shapes', () => {
  const T = 'inv_AbC-123_xyz';
  assert.deepEqual(parseInvite(`claudebuddy://join?hub=https://buddy.example.com&t=${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`claudebuddy://join?hub=https%3A%2F%2Fbuddy.example.com%2F&t=${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`claudebuddy://invite/${T}`, { normalizeHub: httpsOnly }), { hub: null, token: T });
  assert.deepEqual(parseInvite(`claudebuddy://invite?t=${T}`, { normalizeHub: httpsOnly }), { hub: null, token: T });
  assert.deepEqual(parseInvite(`https://buddy.example.com/invite#${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`https://buddy.example.com/invite/${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`  ${T}  `, { normalizeHub: httpsOnly }), { hub: null, token: T });
});

test('invite links: anything else is ignored', () => {
  const T = 'inv_ok';
  const bad = [
    '', 'x'.repeat(201), `claudebuddy://invite/${'a'.repeat(201)}`, 'claudebuddy://invite/a+b', 'claudebuddy://invite/a%2Fb',
    'claudebuddy://invite/a.b', `claudebuddy://invite/${T}/more`, 'claudebuddy://invite/', 'claudebuddy://invite?t=',
    `claudebuddy://join?t=${T}`, `claudebuddy://join?hub=http://buddy.example.com&t=${T}`, `claudebuddy://join?hub=https://127.0.0.1&t=${T}`,
    `claudebuddy://join?hub=https://buddy.example.com/evil&t=${T}`, `claudebuddy://join?hub=https://u:p@buddy.example.com&t=${T}`,
    `claudebuddy://join/x?hub=https://buddy.example.com&t=${T}`, `claudebuddy://settings?t=${T}`, `javascript:alert(1)`,
    `http://buddy.example.com/invite/${T}`, `http://buddy.example.com/invite#${T}`, `https://buddy.example.com/other#${T}`, `https://buddy.example.com/invite?x=1#${T}`, 'https://buddy.example.com/invite#', `https://buddy.example.com/other/${T}`, `file:///invite/${T}`, `claudebuddy://invite/<script>`,
  ];
  for (const s of bad) assert.equal(parseInvite(s, { normalizeHub: httpsOnly }), null, s);
});

test('invite routing: unknown hub → confirm; known + signed out → sign in; known + signed in → preview', () => {
  const known = ['https://buddy.example.com'];
  const signedIn = (h) => h === 'https://buddy.example.com';
  assert.deepEqual(routeInvite({ hub: 'https://evil.example.com', token: 't' }, { knownHubs: known, signedIn }), { action: 'confirm', hub: 'https://evil.example.com' });
  assert.deepEqual(routeInvite({ hub: 'https://buddy.example.com', token: 't' }, { knownHubs: known, signedIn: () => false }), { action: 'signin', hub: 'https://buddy.example.com' });
  assert.deepEqual(routeInvite({ hub: 'https://buddy.example.com', token: 't' }, { knownHubs: known, signedIn }), { action: 'preview', hub: 'https://buddy.example.com' });
  // No hub in the link: the last known hub, else ask.
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: known, signedIn, lastHub: 'https://buddy.example.com' }), { action: 'preview', hub: 'https://buddy.example.com' });
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: [], signedIn }), { action: 'need-hub' });
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: ['https://a.example.com', 'https://b.example.com'], signedIn }), { action: 'need-hub' });
  // A stale lastHub that isn't known any more is not trusted.
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: [], lastHub: 'https://evil.example.com', signedIn }), { action: 'need-hub' });
  assert.equal(maskEmail('callum@example.com'), 'c…@example.com');
});

test('bearer scope: the exact hub origin and its WebSocket twin, never another host, port or scheme', () => {
  const s = bearerScope('https://buddy.example.com');
  assert.deepEqual(s.urls, ['https://buddy.example.com/*', 'wss://buddy.example.com/*']);
  for (const u of ['https://buddy.example.com/', 'https://buddy.example.com/api/me?x=1', 'wss://buddy.example.com/ws/board?org=t', 'https://buddy.example.com:443/x']) assert.equal(s.matches(u), true, u);
  for (const u of ['http://buddy.example.com/', 'ws://buddy.example.com/ws', 'https://buddy.example.com:8443/', 'wss://buddy.example.com:8443/',
    'https://evil.buddy.example.com/', 'https://buddy.example.com.evil.com/', 'https://evilbuddy.example.com/', 'https://u:p@buddy.example.com/',
    'https://other.example.com/', 'file:///x', 'not a url']) assert.equal(s.matches(u), false, u);
  const l = bearerScope('http://127.0.0.1:5123');
  assert.deepEqual(l.urls, ['http://127.0.0.1:5123/*', 'ws://127.0.0.1:5123/*']);
  assert.equal(l.matches('http://127.0.0.1:5123/api'), true);
  assert.equal(l.matches('ws://127.0.0.1:5123/ws/board'), true);
  assert.equal(l.matches('http://127.0.0.1:5124/api'), false);
  assert.equal(l.matches('http://localhost:5123/api'), false);
  assert.throws(() => bearerScope('https://buddy.example.com/path'));
});
