// Buddy main window: page registry, navigation lock, and the embedded hub
// supervisor (fake utilityProcess child, no Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PAGES, flat, pageById, hubPageUrl, navDecision, openDecision, isConnectCallback, pageForHubUrl } = require('../buddy-window/pages');
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
  assert.equal(hubPageUrl('https://buddy.example.com', pageById('board:table'), { org: 'team_1' }), 'https://buddy.example.com/?org=team_1&view=table');
  assert.equal(hubPageUrl('https://buddy.example.com/?org=old&view=x', pageById('board'), { org: 'team_2' }), 'https://buddy.example.com/?org=team_2');
  assert.equal(pageForHubUrl('https://buddy.example.com/?org=t&view=table'), 'board:table');
  for (const id of ['team', 'thismac', 'account']) assert.ok(pageById(id).screen, id);
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

test('window.open from the hub view: buddy-connect (https) gets the in-app connect window; nothing else does', () => {
  const o = { hubOrigin: 'https://buddy.example.com' };
  assert.equal(openDecision({ url: 'https://github.com/login/oauth/authorize?x=1', frameName: 'buddy-connect' }, o), 'connect');
  assert.equal(openDecision({ url: 'https://slack.com/oauth/v2/authorize', frameName: 'buddy-connect' }, o), 'connect');
  assert.equal(openDecision({ url: 'http://github.com/login', frameName: 'buddy-connect' }, o), 'deny');
  assert.equal(openDecision({ url: 'javascript:alert(1)', frameName: 'buddy-connect' }, o), 'deny');
  assert.equal(openDecision({ url: 'https://github.com/o/r', frameName: '' }, o), 'external');
  assert.equal(openDecision({ url: 'https://github.com/o/r', frameName: 'other' }, o), 'external');
  assert.equal(openDecision({ url: 'https://buddy.example.com/x', frameName: '' }, o), 'deny', 'no second hub window');
  assert.equal(openDecision({ url: 'file:///etc/passwd', frameName: '' }, o), 'deny');
  assert.equal(isConnectCallback('https://buddy.example.com/integrations/github/callback?code=x&state=y', o.hubOrigin), true);
  assert.equal(isConnectCallback('https://buddy.example.com/integrations/slack/callback/', o.hubOrigin), true);
  assert.equal(isConnectCallback('https://evil.example.com/integrations/github/callback', o.hubOrigin), false);
  assert.equal(isConnectCallback('https://buddy.example.com/integrations/github', o.hubOrigin), false);
  assert.equal(isConnectCallback('https://buddy.example.com/integrations/../callback', o.hubOrigin), false);
  assert.equal(hubPageUrl(o.hubOrigin, pageById('integrations'), { org: 't1' }), 'https://buddy.example.com/?org=t1&view=integrations');
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
  assert.equal(children[0].opts.serviceName, 'Plexiform Board Hub');
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

const { createWorkspaceStore, buildWorkspaceList, teamsFromAccount, normalizeHubUrl, normalizeLinkHub, isPrivateHost, accessTeamFromLocation, partitionFor: teamPartition, integrationPartitionFor, hubKey } = require('../buddy-window/workspaces');

test('team hub URLs: https origins only, bare hosts become https, junk refused', () => {
  assert.equal(normalizeHubUrl('buddy.bondly.co.za'), 'https://buddy.bondly.co.za');
  assert.equal(normalizeHubUrl(' https://buddy.bondly.co.za/some/path?x=1#y '), 'https://buddy.bondly.co.za');
  assert.throws(() => normalizeHubUrl('http://buddy.bondly.co.za'), /https/);
  assert.throws(() => normalizeHubUrl('https://user:pw@buddy.bondly.co.za'), /password/);
  assert.throws(() => normalizeHubUrl('localhost:8787'), /public address/);
  assert.throws(() => normalizeHubUrl('https://127.0.0.1'), /public address/);
  assert.throws(() => normalizeHubUrl(''), /Enter/);
  assert.throws(() => normalizeHubUrl('javascript:alert(1)'), /web address|https/);
  assert.match(teamPartition('https://buddy.bondly.co.za'), /^persist:board-[0-9a-f]{16}$/);
});

test('hub files and partitions are named by sha256(origin)[0:16], never by the host spelling', () => {
  const crypto = require('node:crypto');
  const o = 'https://buddy.bondly.co.za';
  const key = crypto.createHash('sha256').update(o).digest('hex').slice(0, 16);
  assert.equal(hubKey(o), key);
  assert.equal(teamPartition(o), `persist:board-${key}`);
  assert.equal(integrationPartitionFor(o), `persist:integration-auth-${key}`);
  // The old host-derived names collided (a.b_c vs a.b:c); hashes of distinct origins don't.
  assert.notEqual(hubKey('http://127.0.0.1:5123'), hubKey('http://127.0.0.1:5124'));
  assert.notEqual(teamPartition(o), integrationPartitionFor(o));
});

test('link hubs: no private, link-local, CGNAT or loopback addresses (the dev mock origin excepted)', () => {
  for (const h of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', '100.127.255.254', '127.0.0.1', '0.0.0.0']) {
    assert.equal(isPrivateHost(h), true, h);
    assert.throws(() => normalizeLinkHub(`https://${h}`), /public address/, h);
  }
  for (const h of ['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '8.8.8.8', 'buddy.example.com']) assert.equal(isPrivateHost(h), false, h);
  assert.equal(normalizeLinkHub('https://8.8.8.8'), 'https://8.8.8.8');
  assert.equal(normalizeLinkHub('buddy.example.com'), 'https://buddy.example.com');
  // Typed hubs keep today's rule: a private address the member typed is their call.
  assert.equal(normalizeHubUrl('https://10.0.0.5'), 'https://10.0.0.5');
  assert.equal(normalizeLinkHub('http://127.0.0.1:5000', { allowOrigins: ['http://127.0.0.1:5000'] }), 'http://127.0.0.1:5000');
  const { parseInvite: parse } = require('../buddy-window/accounts');
  assert.equal(parse('claudebuddy://join?hub=https://192.168.1.10&t=inv_x', { normalizeHub: (u) => normalizeLinkHub(u) }), null);
  assert.equal(parse('https://10.1.2.3/invite#inv_x', { normalizeHub: (u) => normalizeLinkHub(u) }), null);
});

test('the Access team comes only from a *.cloudflareaccess.com redirect', () => {
  assert.equal(accessTeamFromLocation('https://restless-hall-ab0c.cloudflareaccess.com/cdn-cgi/access/login/buddy.bondly.co.za?kid=1'), 'restless-hall-ab0c');
  assert.equal(accessTeamFromLocation('https://evil.example.com/cloudflareaccess.com'), null);
  assert.equal(accessTeamFromLocation('https://a.b.cloudflareaccess.com/'), null);
  assert.equal(accessTeamFromLocation('not a url'), null);
});

test('workspace list from /api/account: this Mac, then each signed-in hub’s teams, then Access-fallback hubs', () => {
  const A = 'https://a.example.com';
  const B = 'https://b.example.com';
  const acct = { user: { id: 'u' }, teams: [{ id: 'team_2', name: 'Zeta', role: 'member', boards: [] }, { id: 'team_1', name: 'Alpha', role: 'owner', boards: [] }, { id: 'bad id/..', name: 'x' }, { id: 't3' }] };
  const teams = { [A]: teamsFromAccount(acct), [B]: teamsFromAccount({ teams: [{ id: 'b1', name: 'Bee', role: 'weird' }] }) };
  assert.deepEqual(teams[A].map((t) => t.id), ['team_2', 'team_1'], 'junk ids and nameless teams dropped');
  assert.equal(teams[B][0].role, 'member', 'unknown role read as member');
  const list = buildWorkspaceList({ hubs: [A, B], teams, access: [{ url: 'https://old.example.com', name: 'Old', accessTeam: 'x' }] });
  assert.deepEqual(list.map((w) => w.id), ['local', 'team:a.example.com:team_1', 'team:a.example.com:team_2', 'team:b.example.com:b1', 'access:old.example.com']);
  assert.deepEqual(list.map((w) => w.group ?? null), [null, 'a.example.com', 'a.example.com', 'b.example.com', null], 'hub names shown when there are several');
  assert.deepEqual({ hub: list[1].hub, teamId: list[1].teamId, role: list[1].role }, { hub: A, teamId: 'team_1', role: 'owner' });
  const one = buildWorkspaceList({ hubs: [A, B], teams, signedIn: (h) => h === A });
  assert.deepEqual(one.map((w) => w.id), ['local', 'team:a.example.com:team_1', 'team:a.example.com:team_2'], 'a signed-out hub shows no teams');
  assert.equal(one[1].group, null);
  // Every team on one hub shares that hub's partition.
  assert.equal(teamPartition(A), `persist:board-${hubKey(A)}`);
});

test('workspace store: hubs, teams from the account, active team, persisted without secrets, 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ws-'));
  const file = path.join(dir, 'ws.json');
  const s1 = createWorkspaceStore(file);
  assert.equal(s1.active().id, 'local');
  const hub = s1.addHub('buddy.bondly.co.za');
  assert.equal(hub, 'https://buddy.bondly.co.za');
  assert.equal(s1.lastHub(), hub);
  assert.equal(s1.setTeams(hub, { teams: [{ id: 't1', name: 'Bondly', role: 'owner' }, { id: 't2', name: 'Side', role: 'guest' }] }), true);
  assert.equal(s1.activateTeam(hub, 't2'), true);
  assert.equal(s1.active().name, 'Side');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!/token|bdt_|secret/i.test(saved), saved);
  const s2 = createWorkspaceStore(file);
  assert.equal(s2.active().id, 'team:buddy.bondly.co.za:t2');
  // Removed from a team (the next /api/account lacks it) → back to this Mac.
  s2.setTeams(hub, { teams: [{ id: 't1', name: 'Bondly', role: 'owner' }] });
  assert.equal(s2.active().id, 'local');
  s2.activateTeam(hub, 't1');
  s2.forgetTeams(hub);
  assert.equal(s2.active().id, 'local');
  assert.deepEqual(s2.list().map((w) => w.id), ['local']);
  assert.equal(s2.knows(hub), true, 'the hub is remembered for the next sign-in');
  assert.equal(s2.setActive('team:nope'), false);
  assert.equal(s2.sharesPresence(hub), false, 'presence is off by default');
  s2.setSharesPresence(hub, true);
  assert.equal(createWorkspaceStore(file).sharesPresence(hub), true);
});

test('workspace store: v1 files migrate: every entry the old probe accepted stays an Access workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ws-'));
  const file = path.join(dir, 'ws.json');
  fs.writeFileSync(file, JSON.stringify({ active: 'team:signedin.example.com', teams: [
    { name: 'Old', url: 'https://old.example.com', accessTeam: 'restless-hall' },
    // Saved while already signed in to Access: the probe got a 200 and no team.
    { name: 'Signed in', url: 'https://signedin.example.com', accessTeam: null },
    { name: 'Bad team', url: 'https://bad.example.com', accessTeam: 'evil.example.com/..' },
  ] }));
  const s = createWorkspaceStore(file);
  assert.deepEqual(s.list().map((w) => w.id), ['local', 'access:old.example.com', 'access:signedin.example.com', 'access:bad.example.com']);
  assert.equal(s.active().id, 'access:signedin.example.com');
  assert.equal(s.get('access:old.example.com').accessTeam, 'restless-hall');
  assert.equal(s.get('access:bad.example.com').accessTeam, null);
  assert.deepEqual(s.hubs(), [], 'nothing became an account hub to sign in to');
  assert.equal(s.lastHub(), null);
  s.setActive('local');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  assert.equal(s.removeAccess('access:old.example.com'), true);
});

test('workspace store: a tampered file cannot smuggle in a non-https hub, a loopback hub or a bad Access team', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ws-'));
  const file = path.join(dir, 'ws.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, active: 'team:evil', hubs: ['http://evil.example.com', 'http://127.0.0.1:5000', 'https://ok.example.com', 'https://ok.example.com/path'],
    teams: { 'https://ok.example.com': [{ id: '../x', name: 'bad' }, { id: 'good', name: 'Good' }] },
    access: [{ name: 'y', url: 'https://acc.example.com', accessTeam: 'evil.example.com/../' }] }));
  const s = createWorkspaceStore(file);
  assert.deepEqual(s.hubs(), ['https://ok.example.com']);
  assert.deepEqual(s.list().map((w) => w.id), ['local', 'team:ok.example.com:good', 'access:acc.example.com']);
  assert.equal(s.get('access:acc.example.com').accessTeam, null);
  assert.equal(s.active().id, 'local');
  // The dev mock's exact origin is let through only when named.
  const d = createWorkspaceStore(file, { allowOrigins: ['http://127.0.0.1:5000'] });
  assert.deepEqual(d.hubs(), ['http://127.0.0.1:5000', 'https://ok.example.com']);
  assert.throws(() => normalizeHubUrl('http://127.0.0.1:5001', { allowOrigins: ['http://127.0.0.1:5000'] }));
});

// ── this Mac as a runner ──────────────────────────────────────────────────

const { createDeviceController, defaultDeviceName, presenceSessions, runnerTokenFrom, NO_RUNNER } = require('../buddy-window/device');

const HUB = 'https://buddy.bondly.co.za';

function deviceHarness(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-dev-'));
  const calls = [];
  const children = [];
  const statuses = [];
  const pending = [];
  let t = 0;
  const account = over.account ?? {
    origin: HUB,
    enrol: async (team) => { calls.push({ op: 'enrol', team }); return over.enrol ? over.enrol() : { ok: true, enrollment_id: 'enr-1', team_id: team }; },
    unenrol: async (team) => { calls.push({ op: 'unenrol', team }); return { ok: true }; },
    accessToken: async () => ('token' in over ? over.token : 'bdt_account_token_value'),
  };
  const make = (teamId = 'team-1') => createDeviceController({
    account, teamId, credsFile: path.join(dir, 'device.bin'), canSeal: () => over.canSeal ?? true,
    seal: over.seal ?? ((s) => Buffer.from(`SEALED:${Buffer.from(s).toString('base64')}`)),
    unseal: (b) => Buffer.from(String(b).slice(7), 'base64').toString(),
    fork: (entry, args, opts) => { const c = new FakeChild(); c.entry = entry; c.args = args; c.opts = opts; c.sent = []; c.postMessage = (m) => c.sent.push(m); children.push(c); return c; },
    runnerEntry: '/app/board/runner/app-entry.js', entryExists: () => over.entryExists ?? true, dataDir: path.join(dir, 'runner'),
    onStatus: (s) => statuses.push(s), schedule: (fn) => pending.push(fn), now: () => t, stopGraceMs: 1000,
  });
  return { dir, calls, children, statuses, pending, make, credsFile: path.join(dir, 'device.bin'), tick: (ms) => { t += ms; } };
}

test('device name reads like a person made it', () => {
  assert.equal(defaultDeviceName('Callum', 'Callums-MacBook-Air.local'), 'Callum’s Callums MacBook Air');
  assert.equal(defaultDeviceName('', ''), 'My’s Mac');
});

test('enroll: with the account (no service tokens), seals the enrolment 0600, starts the runner with the account token over parentPort', async () => {
  const h = deviceHarness();
  const d = h.make();
  assert.match((await d.enroll({ name: '  ' })).error, /name/);
  assert.equal(h.calls.length, 0);
  const r = await d.enroll({ name: 'Callum’s Mac' });
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls[0], { op: 'enrol', team: 'team-1' });
  const raw = fs.readFileSync(h.credsFile, 'utf8');
  assert.ok(raw.startsWith('SEALED:'));
  assert.ok(!raw.includes('bdt_'), 'the account token is not copied into the runner file');
  assert.equal(fs.statSync(h.credsFile).mode & 0o777, 0o600);
  const c = h.children[0];
  assert.deepEqual(c.args, [], 'app-entry takes no args');
  assert.equal(c.opts.cwd, undefined);
  assert.ok(!JSON.stringify(c.opts.env).includes('bdt_'));
  assert.deepEqual(c.sent[0], { type: 'runner.config', hub_url: HUB, device_token: 'bdt_account_token_value', team_id: 'team-1', data_dir: path.join(h.dir, 'runner') });
  c.emit('message', { type: 'runner.ready' });
  c.emit('message', { type: 'runner.status', state: 'connected' });
  assert.equal(d.status().runner.state, 'connected');
  assert.equal(d.status().enrolled, true);
  assert.equal((await d.enroll({ name: 'again' })).ok, false);
});

test('device enrol via the account against the mock hub', async () => withHub(async (hub, origin) => {
  const { c } = await signIn(hub, origin, 'runner@example.com');
  const team = (await c.createTeam('Runners')).team;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-dev-'));
  const sent = [];
  const d = createDeviceController({
    account: c, teamId: team.id, credsFile: path.join(dir, 'd.bin'), seal: (s) => Buffer.from(s), unseal: (b) => String(b),
    fork: () => { const k = new FakeChild(); k.postMessage = (m) => sent.push(m); return k; }, runnerEntry: 'x', entryExists: () => true, dataDir: path.join(dir, 'r'), schedule: () => {}, stopGraceMs: 1000,
  });
  assert.equal((await d.enroll({ name: 'Mac' })).ok, true);
  assert.equal(hub.enrolments().length, 1);
  assert.equal(hub.enrolments()[0].team_id, team.id);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['data_dir', 'device_token', 'hub_url', 'team_id', 'type']);
  assert.equal(sent[0].device_token, await c.accessToken(), 'the account’s own bdt_ token');
  assert.equal(sent[0].team_id, team.id);
  await d.remove();
  assert.equal(hub.enrolments()[0].revoked, true, 'DELETE /api/teams/:id/enrol');
}));

test('enrol: a runner-only brt_ token from the hub wins over the account token and is sealed', async () => {
  const brt = `brt_${'x'.repeat(20)}`;
  assert.equal(runnerTokenFrom({ enrollment_id: 'e', runner_token: brt }), brt);
  assert.equal(runnerTokenFrom({ enrollment_id: 'e', device_token: brt }), brt);
  assert.equal(runnerTokenFrom({ enrollment_id: 'e', device_token: 'bdt_nope' }), null);
  assert.equal(runnerTokenFrom({ enrollment_id: 'e' }), null);
  const h = deviceHarness({ enrol: () => ({ ok: true, enrollment_id: 'enr-9', team_id: 'team-1', runner_token: brt }) });
  await h.make().enroll({ name: 'Mac' });
  assert.equal(h.children[0].sent[0].device_token, brt);
  assert.ok(!fs.readFileSync(h.credsFile, 'utf8').includes('brt_'), 'sealed, not plain');
  // A new controller (next launch) starts with the sealed brt_.
  const d2 = h.make();
  await d2.resume();
  assert.equal(h.children[1].sent[0].device_token, brt);
});

test('enrol: no Keychain, no enrolment; a sealing failure after the hub enrolled undoes it on the hub', async () => {
  const no = deviceHarness({ canSeal: false });
  assert.match((await no.make().enroll({ name: 'Mac' })).error, /securely/);
  assert.equal(no.calls.length, 0, 'the hub was never asked');
  const bad = deviceHarness({ seal: () => { throw new Error('keychain locked'); } });
  const d = bad.make();
  const r = await d.enroll({ name: 'Mac' });
  assert.equal(r.ok, false);
  assert.match(r.error, /securely/);
  assert.deepEqual(bad.calls.map((c) => c.op), ['enrol', 'unenrol']);
  assert.equal(d.status().enrolled, false);
  assert.equal(bad.children.length, 0, 'no runner started');
  assert.equal(fs.existsSync(bad.credsFile), false);
});

test('signed out (no account token): the runner is not started and says why', async () => {
  const h = deviceHarness({ token: null });
  const d = h.make();
  assert.equal((await d.enroll({ name: 'Mac' })).ok, true);
  assert.equal(h.children.length, 0);
  assert.equal(d.status().runner.state, 'unauthenticated');
});

test('discard: stops the runner and deletes the sealed file without asking the hub', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enroll({ name: 'Mac' });
  h.children[0].emit('message', { type: 'runner.ready' });
  h.children[0].emit('message', { type: 'runner.status', state: 'connected' });
  assert.equal(d.running(), true);
  await d.discard();
  assert.equal(h.children[0].killed, 1);
  assert.equal(fs.existsSync(h.credsFile), false);
  assert.deepEqual(h.calls.map((c) => c.op), ['enrol'], 'no unenrol');
  assert.equal(d.running(), false);
});

test('enroll: signed out or refused says so in words; nothing is stored', async () => {
  const h = deviceHarness({ enrol: () => ({ ok: false, signedOut: true, error: 'x' }) });
  assert.match((await h.make().enroll({ name: 'Mac' })).error, /Sign in again/);
  const g = deviceHarness({ enrol: () => ({ ok: false, error: 'You don’t have permission to do that in this team.' }) });
  assert.match((await g.make().enroll({ name: 'Mac' })).error, /permission/);
  assert.equal(fs.existsSync(h.credsFile) || fs.existsSync(g.credsFile), false);
});

test('off → SIGTERM, stays off across restarts; on again restarts; remove revokes and forgets every secret', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enroll({ name: 'Mac' });
  await d.setEnabled(false);
  assert.equal(h.children[0].killed, 1);
  assert.equal(d.status().enabled, false);
  const d2 = h.make();
  await d2.resume();
  assert.equal(h.children.length, 1, 'left off: not started at launch');
  await d2.setEnabled(true);
  assert.equal(h.children.length, 2);
  await d2.remove();
  assert.equal(h.children[1].killed, 1);
  assert.equal(fs.existsSync(h.credsFile), false);
  assert.deepEqual(h.calls.at(-1), { op: 'unenrol', team: 'team-1' });
});

test('runner crash restarts with backoff; revoked/unauthenticated does not loop', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enroll({ name: 'Mac' });
  h.children[0].emit('message', { type: 'runner.ready' });
  h.tick(60_000);
  h.children[0].emit('exit', 1);
  assert.equal(d.status().runner.state, 'restarting');
  await h.pending.shift()();
  assert.equal(h.children.length, 2);
  h.children[1].emit('message', { type: 'runner.ready' });
  h.children[1].emit('message', { type: 'runner.status', state: 'revoked', detail: 'device revoked' });
  h.children[1].emit('exit', 0);
  assert.equal(h.pending.length, 0);
  assert.equal(d.status().runner.state, 'revoked');
});

test('no runner in this build (missing entry, or an exit before ready) is "not available", not a crash loop', async () => {
  const gone = deviceHarness({ entryExists: false });
  const g = gone.make();
  assert.match((await g.enroll({ name: 'Mac' })).error, /not available/);
  assert.equal(gone.calls.length, 0, 'nothing enrolled on the hub');
  assert.equal(gone.children.length, 0);
  assert.deepEqual(g.status().runner, { state: 'missing', detail: NO_RUNNER });
  const h = deviceHarness();
  const d = h.make();
  await d.enroll({ name: 'Mac' });
  h.tick(300);
  h.children[0].emit('exit', 2);
  assert.deepEqual(d.status().runner, { state: 'missing', detail: NO_RUNNER });
  assert.equal(h.pending.length, 0);
});

test('runner.fatal with exit 2 (bad config) is shown and not restarted; runner.stopped reports parked runs', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enroll({ name: 'Mac' });
  const c = h.children[0];
  c.emit('message', { type: 'runner.ready' });
  c.emit('message', { type: 'runner.status', state: 'unavailable', detail: 'hub unreachable' });
  assert.equal(d.status().runner.state, 'unavailable');
  c.emit('message', { type: 'runner.stopped', parked: 2, orphaned: 0 });
  assert.equal(d.status().parked, 2);
  c.emit('message', { type: 'runner.fatal', message: 'device_token missing' });
  h.tick(60_000);
  c.emit('exit', 2);
  assert.deepEqual(d.status().runner, { state: 'failed', detail: 'device_token missing' });
  assert.equal(h.pending.length, 0);
});

test('presence: off by default; on sends the minimal session fields once ready; off clears at once', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enroll({ name: 'Mac' });
  const c = h.children[0];
  const sessions = [{ sessionId: 's1', via: 'claude', cwd: '/Users/callum/Development/secret-client/proj', signal: 'tool-use', signalSince: '2026-09-30T10:00:00.000Z', model: 'secret-ish', tasks: [{ title: 'x' }] }];
  d.setPresence(true, sessions);
  assert.equal(c.sent.length, 1, 'nothing before ready');
  c.emit('message', { type: 'runner.ready' });
  assert.deepEqual(c.sent[1], { type: 'runner.presence', enabled: true, sessions: [{ session_id: 's1', agent: 'claude', project: 'proj', state: 'tool-use', since: '2026-09-30T10:00:00.000Z' }] });
  assert.ok(!JSON.stringify(c.sent).includes('/Users/'), 'never an absolute path');
  d.setPresence(true, sessions);
  assert.equal(c.sent.length, 2, 'unchanged: not resent');
  d.setPresence(false, sessions);
  assert.deepEqual(c.sent[2], { type: 'runner.presence', enabled: false, sessions: [] });
  assert.deepEqual(presenceSessions([{ nope: 1 }, null]), []);
});

test('creds for another hub or team are ignored', async () => {
  const h = deviceHarness();
  await h.make().enroll({ name: 'Mac' });
  assert.equal(h.make('team-2').status().enrolled, false);
  const other = createDeviceController({
    account: { origin: 'https://other.example.com' }, teamId: 'team-1', credsFile: h.credsFile,
    seal: (s) => Buffer.from(s), unseal: (b) => Buffer.from(String(b).slice(7), 'base64').toString(),
    fork: () => { throw new Error('must not start'); }, runnerEntry: 'x', dataDir: path.join(h.dir, 'r2'),
  });
  assert.equal(other.status().enrolled, false);
});

// ── Buddy accounts (client against the mock hub) ─────────────────────────

const { createAccountClient, ROUTES, parseInvite, routeInvite, bearerScope, maskEmail } = require('../buddy-window/accounts');
const { createMockAccountsHub, VERIFY_PER_ADDRESS } = require('../buddy-window/mock-accounts-hub');

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

test('accounts: start names the client, device and platform; wrong, used and expired codes are one message with tries left', async () => withHub(async (hub, origin) => {
  const c = createAccountClient({ origin, store: memStore() });
  await c.startEmail('a@example.com', { deviceName: 'Jo’s MacBook Pro', platform: 'darwin-arm64' });
  assert.deepEqual(hub.starts().at(-1), { email: 'a@example.com', client: 'buddy_desktop', purpose: 'signin', device_name: 'Jo’s MacBook Pro', platform: 'darwin-arm64' });
  const good = hub.lastCode('a@example.com');
  const wrong = good === '000000' ? '111111' : '000000';
  assert.equal((await c.verifyCode(wrong)).error, 'That code didn’t work. 4 tries left.');
  for (let left = 3; left >= 1; left -= 1) assert.equal((await c.verifyCode(wrong)).error, `That code didn’t work. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  assert.equal((await c.verifyCode(wrong)).error, 'That code didn’t work. Send a new code.', 'the flow died');
  assert.equal((await c.verifyCode(good)).error, 'That code didn’t work. Send a new code.', 'even the right code: same words');
  assert.equal(c.pendingEmail(), 'a@example.com', '"Send a new code" still knows the address');
  await c.startEmail('a@example.com');
  hub.setNow(Date.now() + 10 * 60_000 + 1);
  assert.equal((await c.verifyCode(hub.lastCode('a@example.com'))).error, 'That code didn’t work. Send a new code.', 'expired');
}));

test('accounts: too many tries (429 RATE_LIMITED) says to wait, whatever the code', async () => withHub(async (hub, origin) => {
  const c = createAccountClient({ origin, store: memStore() });
  let r;
  for (let i = 0; i <= VERIFY_PER_ADDRESS; i += 1) {
    if (i % 5 === 0) await c.startEmail('rl@example.com');
    r = await c.verifyCode('000000');
  }
  assert.equal(r.status, 429);
  assert.match(r.error, /^Too many tries\. Wait (a minute|\d+ minutes) and try again\.$/);
  await c.startEmail('rl@example.com');
  assert.match((await c.verifyCode(hub.lastCode('rl@example.com'))).error, /Too many tries/, 'locked out even with the right code');
  const { humanError } = require('../buddy-window/accounts');
  assert.equal(humanError(429, { error: { code: 'RATE_LIMITED', retry_after_s: 30 } }, 'h'), 'Too many tries. Wait a minute and try again.');
  assert.equal(humanError(429, { error: { code: 'RATE_LIMITED', retry_after_s: 600 } }, 'h'), 'Too many tries. Wait 10 minutes and try again.');
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

test('accounts: create a team, invite by email (link shown once), preview without auth, accept; wrong account and reuse refused', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'owner@example.com');
  const t = await owner.c.createTeam('Bondly');
  assert.equal(t.ok, true);
  assert.equal(t.team.slug, 'bondly');
  assert.equal(t.board.name, 'Bondly');
  const teamId = t.team.id;
  const inv = await owner.c.invite(teamId, 'Sam@Example.com', 'member');
  assert.equal(inv.ok, true);
  assert.equal(inv.invite.email, 'sam@example.com');
  assert.ok(inv.link.startsWith(`${origin}/invite#`), inv.link);
  const token = inv.link.split('#')[1];
  const listed = (await owner.c.listInvites(teamId)).invites;
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(token), 'the list never carries tokens');

  const seen = [];
  const anon = createAccountClient({ origin, store: memStore(), fetchImpl: async (u, init) => { seen.push(init.headers); return fetch(u, init); } });
  const pv = await anon.previewInvite(token);
  assert.deepEqual({ team: pv.team_name, role: pv.role, inviter: pv.inviter_first_name }, { team: 'Bondly', role: 'member', inviter: 'owner' });
  assert.equal(pv.email_masked, undefined, 'preview never names the invitee');
  assert.equal(seen[0].Authorization, undefined);

  const other = await signIn(hub, origin, 'other@example.com');
  const wrong = await other.c.acceptInvite({ t: token });
  assert.equal(wrong.wrongAccount, true);
  assert.equal(wrong.error, 'This invite is for s…@example.com. Switch account?');

  const sam = await signIn(hub, origin, 'sam@example.com');
  const pending = (await sam.c.me()).pending_invites;
  assert.equal(pending.length, 1);
  assert.deepEqual(Object.keys(pending[0]).sort(), ['expires_at', 'id', 'inviter_first_name', 'role', 'team_name']);
  const acc = await sam.c.acceptInvite({ inviteId: pending[0].id });
  assert.equal(acc.ok, true);
  assert.equal(acc.team.id, teamId);
  assert.equal(acc.member.role, 'member');
  assert.deepEqual((await sam.c.me()).teams.map((x) => [x.name, x.role]), [['Bondly', 'member']]);
  const again = await sam.c.acceptInvite({ t: token });
  assert.equal(again.gone, true);
  assert.equal(again.error, 'This invite link isn’t valid any more. Ask for a new one.');
  const members = (await owner.c.listMembers(teamId)).members;
  assert.deepEqual(members.map((m) => m.email).sort(), ['owner@example.com', 'sam@example.com']);
  assert.ok(members.every((m) => m.member_id && m.user_id && m.joined_at));
  assert.ok((await sam.c.listMembers(teamId)).members.every((m) => m.email === undefined), 'emails only for admins');
  assert.equal((await owner.c.listInvites(teamId)).invites.length, 0);
}));

test('accounts: the accept error codes are read in either encoding', () => {
  const { createAccountClient: make } = require('../buddy-window/accounts');
  const reply = (status, error) => async () => new Response(JSON.stringify({ error }), { status });
  const run = (status, error) => make({ origin: 'https://h.example.com', store: { load: () => ({ hub: 'https://h.example.com', token: 'bdt_x' }), save() {}, clear() {} }, fetchImpl: reply(status, error) }).acceptInvite({ t: 'tok' });
  return Promise.all([
    run(403, { code: 'WRONG_ACCOUNT', email_masked: 'c…@example.com' }).then((r) => assert.equal(r.error, 'This invite is for c…@example.com. Switch account?')),
    run(403, { code: 'FORBIDDEN', reason: 'WRONG_ACCOUNT', email_masked: 'c…@example.com' }).then((r) => assert.equal(r.wrongAccount, true)),
    run(409, { code: 'ALREADY_MEMBER', team: { id: 't1', name: 'Bondly' } }).then((r) => assert.deepEqual([r.alreadyMember, r.team, r.error], [true, { id: 't1', name: 'Bondly' }, 'You’re already in Bondly.'])),
    run(409, { code: 'CONFLICT', reason: 'ALREADY_MEMBER', team: { id: 't1', name: 'Bondly' } }).then((r) => assert.equal(r.alreadyMember, true)),
    run(400, { code: 'INVALID_TOKEN' }).then((r) => assert.equal(r.error, 'This invite link isn’t valid any more. Ask for a new one.')),
    run(403, { code: 'FORBIDDEN' }).then((r) => assert.equal(r.wrongAccount, undefined)),
  ]);
});

test('accounts: roles: members cannot manage; the last owner cannot be demoted or removed', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'o@example.com');
  const teamId = (await owner.c.createTeam('T')).team.id;
  const inv = await owner.c.invite(teamId, 'm@example.com', 'member');
  const m = await signIn(hub, origin, 'm@example.com');
  await m.c.acceptInvite({ t: inv.link.split('#')[1] });
  const list = (await owner.c.listMembers(teamId)).members;
  const me = list.find((x) => x.email === 'o@example.com');
  const them = list.find((x) => x.email === 'm@example.com');
  const r = await owner.c.setRole(teamId, me.member_id, 'admin');
  assert.equal(r.code, 'LAST_OWNER');
  assert.match(r.error, /at least one owner/);
  assert.equal((await owner.c.removeMember(teamId, me.member_id)).code, 'LAST_OWNER');
  assert.match((await m.c.setRole(teamId, them.member_id, 'admin')).error, /permission/);
  assert.match((await m.c.invite(teamId, 'x@example.com', 'member')).error, /permission/);
  assert.equal((await owner.c.setRole(teamId, them.member_id, 'owner')).ok, true);
  assert.equal((await owner.c.setRole(teamId, me.member_id, 'admin')).ok, true, 'fine once there is another owner');
  assert.match((await owner.c.setRole(teamId, them.member_id, 'boss')).error, /Pick a role/);
}));

test('accounts: resend mints a new link and the old one dies; a revoked link is refused with a plain sentence', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'o@example.com');
  const teamId = (await owner.c.createTeam('T')).team.id;
  const a = await owner.c.invite(teamId, 'x@example.com', 'guest');
  const b = await owner.c.invite(teamId, 'x@example.com', 'guest');
  assert.notEqual(a.link, b.link);
  const live = (await owner.c.listInvites(teamId)).invites;
  assert.deepEqual(live.map((i) => i.id), [b.invite.id]);
  assert.match((await owner.c.previewInvite(a.link.split('#')[1])).error, /isn’t valid any more/);
  assert.equal((await owner.c.revokeInvite(teamId, b.invite.id)).ok, true);
  assert.equal((await owner.c.listInvites(teamId)).invites.length, 0);
  assert.match((await owner.c.previewInvite(b.link.split('#')[1])).error, /isn’t valid any more/);
  assert.match((await owner.c.previewInvite('inv_nope')).error, /isn’t valid any more/);
}));

test('accounts: already a member gets a clear answer with the team', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'o@example.com');
  const team = (await owner.c.createTeam('T')).team;
  const inv = await owner.c.invite(team.id, 'o2@example.com', 'member');
  const o2 = await signIn(hub, origin, 'o2@example.com');
  await o2.c.acceptInvite({ t: inv.link.split('#')[1] });
  const again = await owner.c.invite(team.id, 'o2@example.com', 'member');
  const r = await o2.c.acceptInvite({ t: again.link.split('#')[1] });
  assert.equal(r.alreadyMember, true);
  assert.deepEqual(r.team, { id: team.id, name: 'T' });
  assert.equal(r.error, 'You’re already in T.');
}));

test('accounts: sign out revokes on the hub and forgets locally', async () => withHub(async (hub, origin) => {
  const a = await signIn(hub, origin, 'a@example.com');
  const token = a.store.peek().token;
  assert.equal((await a.c.signOut()).revoked, true);
  assert.equal(a.store.peek(), null);
  const res = await fetch(`${origin}/api/account`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401, 'the old token is dead on the hub');
}));

test('accounts: delete = start {purpose:delete} (Bearer) → verify {flow_id, code} → DELETE /api/account {flow_id}', async () => withHub(async (hub, origin) => {
  const d = await signIn(hub, origin, 'd@example.com');
  assert.match((await d.c.deleteAccount('123456')).error, /new code/);
  assert.deepEqual(await d.c.startDelete(), { ok: true, email: 'd@example.com' });
  assert.deepEqual(hub.starts().at(-1), { purpose: 'delete', client: 'buddy_desktop' });
  const code = hub.lastCode('d@example.com');
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await d.c.deleteAccount(wrong)).error, 'That code didn’t work. 4 tries left.');
  assert.equal(d.store.peek() !== null, true, 'a bad code is not a sign-out');
  assert.equal((await d.c.deleteAccount(code)).ok, true);
  assert.equal(d.store.peek(), null);
  const again = await signIn(hub, origin, 'd@example.com');
  assert.deepEqual((await again.c.me()).teams, [], 'a fresh account');
  // The old route is gone from the client.
  assert.deepEqual(ROUTES.deleteAccount, ['DELETE', '/api/account']);
  assert.ok(!Object.values(ROUTES).some(([, p]) => p === '/api/account/delete'));
}));

test('accounts: delete is refused while sole owner (names the team); a stale check asks to do it again', async () => withHub(async (hub, origin) => {
  const o = await signIn(hub, origin, 'solo@example.com');
  const team = (await o.c.createTeam('Bondly')).team;
  const inv = await o.c.invite(team.id, 'mate@example.com', 'member');
  const mate = await signIn(hub, origin, 'mate@example.com');
  await mate.c.acceptInvite({ t: inv.link.split('#')[1] });
  await o.c.startDelete();
  const r = await o.c.deleteAccount(hub.lastCode('solo@example.com'));
  assert.deepEqual([r.ok, r.soleOwner, r.error], [false, true, 'Transfer ownership of Bondly first.']);
  assert.ok(o.store.peek(), 'still signed in');
  // Ownership handed over within the 5 minutes: the verified check is reused.
  const list = (await o.c.listMembers(team.id)).members;
  await o.c.setRole(team.id, list.find((m) => m.email === 'mate@example.com').member_id, 'owner');
  hub.setNow(Date.now() + 6 * 60_000);
  const late = await o.c.deleteAccount('');
  assert.deepEqual([late.ok, late.stepUp, late.error], [false, true, 'That check timed out. Send a new code and do the check again.']);
  assert.ok(o.store.peek(), 'STEP_UP_REQUIRED is a 401 that must not sign anyone out');
  await o.c.startDelete();
  assert.equal((await o.c.deleteAccount(hub.lastCode('solo@example.com'))).ok, true);
  const { humanError } = require('../buddy-window/accounts');
  assert.equal(humanError(409, { error: { code: 'CONFLICT' } }, 'h').length > 0, true);
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

test('invite links: plexiform:// and the legacy claudebuddy:// parse identically; any other scheme is ignored', () => {
  const T = 'inv_AbC-123_xyz';
  const shapes = [`://join?hub=https://buddy.example.com&t=${T}`, `://invite/${T}`, `://invite?t=${T}`, `://join?hub=https://127.0.0.1&t=${T}`, `://invite/${T}/more`, `://settings?t=${T}`, `://join?hub=https://buddy.example.com/evil&t=${T}`];
  for (const rest of shapes) {
    const a = parseInvite(`plexiform${rest}`, { normalizeHub: httpsOnly });
    assert.deepEqual(a, parseInvite(`claudebuddy${rest}`, { normalizeHub: httpsOnly }), rest);
    assert.deepEqual(parseInvite(`PLEXIFORM${rest}`, { normalizeHub: httpsOnly }), a, 'schemes are case-insensitive');
  }
  assert.deepEqual(parseInvite(`plexiform://join?hub=https://buddy.example.com&t=${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`plexiform://invite/${T}`, { normalizeHub: httpsOnly }), { hub: null, token: T });
  for (const other of ['plexi', 'buddy', 'claude', 'plexiformx', 'x-plexiform']) {
    assert.equal(parseInvite(`${other}://invite/${T}`, { normalizeHub: httpsOnly }), null, other);
    assert.equal(parseInvite(`${other}://join?hub=https://buddy.example.com&t=${T}`, { normalizeHub: httpsOnly }), null, other);
  }
});

test('brand: one module holds the name, scheme and the Plexiform window’s copy', () => {
  const BRAND = require('../buddy-window/brand');
  assert.equal(BRAND.NAME, 'Plexiform');
  assert.equal(BRAND.SCHEME, 'plexiform');
  assert.deepEqual(BRAND.LEGACY_SCHEMES, ['claudebuddy']);
  assert.deepEqual(BRAND.SCHEMES, ['plexiform', 'claudebuddy']);
  assert.ok(Object.isFrozen(BRAND) && Object.isFrozen(BRAND.HUB_TEXT) && Object.isFrozen(BRAND.COPY));
  for (const s of [BRAND.WINDOW_TITLE, BRAND.OPEN_MENU_LABEL, BRAND.COPY.signInHeading, BRAND.COPY.inviteHint, BRAND.COPY.startingBoard]) assert.match(s, /Plexiform/);
  assert.ok(!JSON.stringify(BRAND).includes('Buddy'));
  // No old name in what the window shows: its pages, and the strings main sends them.
  const dir = path.join(__dirname, '..', 'buddy-window');
  for (const f of ['sidebar.html', 'info.html', 'account.html', 'account.js', 'sidebar.js', 'info.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Claude Buddy|['"`>][^'"`<]*\bBuddy\b/.test(src), f);
  }
  assert.ok(!/blurb: [^\n]*\bBuddy\b/.test(fs.readFileSync(path.join(dir, 'pages.js'), 'utf8')));
});

test('invite links: malformed percent-encoding is null, never a thrown URIError', () => {
  for (const s of ['claudebuddy://invite/%E0%A4%A', 'claudebuddy://invite/%', 'https://buddy.example.com/invite#%E0%A4%A', 'https://buddy.example.com/invite/%ZZ%']) {
    assert.doesNotThrow(() => parseInvite(s, { normalizeHub: httpsOnly }), s);
    assert.equal(parseInvite(s, { normalizeHub: httpsOnly }), null, s);
  }
});

test('invite routing: unknown hub → confirm; known + signed out → sign in; known + signed in → preview', () => {
  const known = ['https://buddy.example.com'];
  const signedIn = (h) => h === 'https://buddy.example.com';
  assert.deepEqual(routeInvite({ hub: 'https://evil.example.com', token: 't' }, { knownHubs: known, signedIn }), { action: 'confirm', hub: 'https://evil.example.com' });
  assert.deepEqual(routeInvite({ hub: 'https://buddy.example.com', token: 't' }, { knownHubs: known, signedIn: () => false }), { action: 'signin', hub: 'https://buddy.example.com' });
  assert.deepEqual(routeInvite({ hub: 'https://buddy.example.com', token: 't' }, { knownHubs: known, signedIn }), { action: 'preview', hub: 'https://buddy.example.com' });
  // No hub in the link: the one known hub, else ask.
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: known, signedIn }), { action: 'preview', hub: 'https://buddy.example.com' });
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: [], signedIn }), { action: 'need-hub' });
  // Several known hubs: ask, never guess the last one used (it would get a token minted elsewhere).
  const two = ['https://a.example.com', 'https://b.example.com'];
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: two, signedIn, lastHub: 'https://b.example.com' }), { action: 'need-hub' });
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

