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
