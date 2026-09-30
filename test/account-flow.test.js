'use strict';
// The account flow's state machine (buddy-window/account-flow.js) against the
// mock accounts hub, with the Electron side replaced by recorders.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createAccountFlow, clearHubSessions, PAGE_SCREENS, ACCT_ARGS } = require('../buddy-window/account-flow');
const { createAccountClient, bearerScope, bearerHeaders } = require('../buddy-window/accounts');
const { createMockAccountsHub } = require('../buddy-window/mock-accounts-hub');
const { createDeviceController } = require('../buddy-window/device');
const { createWorkspaceStore, normalizeHubUrl, normalizeLinkHub, hubKey, partitionFor, integrationPartitionFor, hostOf } = require('../buddy-window/workspaces');

class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = 0; this.killed = 0; this.sent = []; }
  postMessage(m) { this.sent.push(m); }
  kill() { this.killed += 1; setImmediate(() => this.emit('exit', 0)); return true; }
}

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timed out');
};

async function harness(fn) {
  const hub = createMockAccountsHub();
  const origin = await hub.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-flow-'));
  const devDir = path.join(dir, 'devices');
  fs.mkdirSync(devDir);
  const allowOrigins = [origin];
  const vaults = new Map();
  const vault = (o) => {
    if (!vaults.has(o)) { let v = null; vaults.set(o, { load: () => v, save: (x) => { v = JSON.parse(JSON.stringify(x)); }, clear: () => { v = null; } }); }
    return vaults.get(o);
  };
  const signedIn = (o) => !!vault(o).load();
  const store = createWorkspaceStore(path.join(dir, 'ws.json'), { allowOrigins, signedIn });
  const requests = []; // every URL any client asked for
  const fetchImpl = async (u, init) => {
    requests.push(new URL(u));
    if (!u.startsWith(origin)) throw new TypeError('fetch failed');
    return fetch(u, init);
  };
  const clients = new Map();
  let flow = null;
  const clientFor = (o) => {
    if (!clients.has(o)) clients.set(o, createAccountClient({ origin: o, store: vault(o), fetchImpl, onSignedOut: () => { flow.signedOutOf(o, { tell: true }); } }));
    return clients.get(o);
  };
  const children = [];
  const deviceFile = (ws) => path.join(devDir, `${hubKey(ws.hub)}-${ws.teamId}.bin`);
  const shown = [];
  const selects = [];
  const sessions = new Map();
  const fromPartition = (p) => {
    if (!sessions.has(p)) sessions.set(p, { calls: [], clearStorageData() { this.calls.push('storage'); return Promise.resolve(); }, clearCache() { this.calls.push('cache'); return Promise.resolve(); }, clearAuthCache() { this.calls.push('auth'); return Promise.resolve(); } });
    return sessions.get(p);
  };
  const signedOutHubs = [];
  flow = createAccountFlow({
    store, clientFor, signedIn, userOf: (o) => vault(o).load()?.user ?? null,
    normHub: (u) => normalizeHubUrl(u, { allowOrigins }), normLink: (u) => normalizeLinkHub(u, { allowOrigins }),
    probe: async (o) => (o === origin ? { ok: true, auth: 'accounts' } : { ok: false, error: 'unreachable' }),
    makeDevice: (ws, { onStatus }) => createDeviceController({
      account: clientFor(ws.hub), teamId: ws.teamId, credsFile: deviceFile(ws),
      seal: (s) => Buffer.from(`SEALED:${Buffer.from(s).toString('base64')}`), unseal: (b) => Buffer.from(String(b).slice(7), 'base64').toString(),
      fork: () => { const c = new FakeChild(); children.push(c); return c; }, runnerEntry: 'x', entryExists: () => true,
      dataDir: path.join(dir, 'runner', ws.teamId), onStatus, schedule: () => {}, stopGraceMs: 500,
    }),
    hasDeviceFile: (ws) => fs.existsSync(deviceFile(ws)),
    discardDeviceFiles: (o) => { for (const n of fs.readdirSync(devDir)) if (n.startsWith(`${hubKey(o)}-`)) fs.rmSync(path.join(devDir, n)); },
    deviceInfo: () => ({ deviceName: 'Test Mac', platform: 'darwin-arm64' }),
    ui: {
      show: (s) => shown.push(s),
      select: (id) => selects.push(id),
      switchWorkspace: (id) => { if (id) store.setActive(id); },
      pushState() {},
      forgetHub() {},
      hubSignedOut: async (o) => { signedOutHubs.push(o); await clearHubSessions(o, fromPartition); },
      isOpen: () => true,
      onHubPage: () => false,
      devicesChanged() {},
    },
  });
  const A = flow.ACCT;
  const signInAs = async (email) => {
    assert.equal((await A.hub(origin)).ok, true);
    assert.equal(flow.acct.screen, 'email');
    assert.equal((await A.email(email)).ok, true);
    const r = await A.code(hub.lastCode(email));
    assert.equal(r.ok, true, r.error);
  };
  // Another person on the same hub, driven directly with a client.
  const other = async (email) => {
    let v = null;
    const c = createAccountClient({ origin, store: { load: () => v, save: (x) => { v = x; }, clear: () => { v = null; } } });
    await c.startEmail(email);
    await c.verifyCode(hub.lastCode(email));
    return c;
  };
  const h = { hub, origin, dir, devDir, store, flow, A, requests, shown, selects, sessions, signedOutHubs, children, deviceFile, signInAs, other, vault, host: hostOf(origin) };
  try { await fn(h); } finally { await flow.stopDevices(); await hub.close(); }
}

// ── L12: the flow is Electron-free ─────────────────────────────────────────

test('account flow loads without Electron and every page action has an argument signature', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account-flow.js'), 'utf8');
  assert.ok(!/require\(['"]electron['"]\)/.test(src));
  for (const s of PAGE_SCREENS) assert.ok(!['confirm', 'code'].includes(s), 'confirm/code are reached only through the flow');
  assert.deepEqual(ACCT_ARGS.accept, ['string'], 'accept names the previewed invite');
  for (const op of ['invite', 'resendInvite', 'revokeInvite', 'setRole', 'removeMember']) assert.equal(ACCT_ARGS[op][0], 'string', op);
});

// ── M1: nothing reaches an unconfirmed hub ─────────────────────────────────

test('M1: a deep link to an unknown hub, then navigating anywhere, makes no request to that hub until confirmed', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const evil = 'https://buddy.stranger.example';
  const toEvil = () => h.requests.filter((u) => u.origin === evil);
  assert.equal(h.flow.openInvite(`claudebuddy://join?hub=${evil}&t=inv_abc123`), true);
  assert.equal(h.flow.acct.screen, 'confirm');
  assert.equal(h.flow.hubTrusted(evil), false);
  // Every screen the page can reach, plus every action that could talk to a hub.
  for (const s of PAGE_SCREENS) { await h.A.go(s); await h.A.state(); }
  await h.A.email('me@example.com');
  await h.A.code('123456');
  await h.A.resend();
  await h.A.accept('anything');
  await h.A.switchAccount();
  assert.deepEqual(toEvil(), [], 'no request to the unconfirmed hub');
  // Having navigated away, the old question can't be answered yes.
  assert.equal((await h.A.confirm(true)).ok, false);
  assert.equal(h.flow.hubTrusted(evil), false);

  // Asked again and confirmed: now (and only now) the hub may be asked.
  h.flow.openInvite(`claudebuddy://join?hub=${evil}&t=inv_abc123`);
  assert.equal((await h.A.confirm(true)).ok, true);
  assert.equal(h.flow.acct.screen, 'email');
  await h.A.email('me@example.com');
  assert.equal(toEvil().length, 1, 'the confirmed hub gets the sign-in request');
}));

test('M1: go(join) drops an invite for an untrusted hub; its preview never shows', async () => harness(async (h) => {
  h.flow.openInvite('claudebuddy://join?hub=https://buddy.stranger.example&t=inv_abc123');
  assert.equal(h.flow.acct.screen, 'confirm');
  await h.A.go('join');
  const s = await h.A.state();
  assert.equal(s.screen, 'join');
  assert.equal(s.invite, null);
  assert.equal(s.host, null);
  assert.equal(h.requests.length, 0);
}));

test('confirm answers only the question on screen, about the hub it named', async () => harness(async (h) => {
  assert.equal((await h.A.confirm(true)).ok, false, 'nothing awaiting');
  h.flow.openInvite('claudebuddy://join?hub=https://a.stranger.example&t=inv_a');
  await h.A.go('hub');
  assert.equal((await h.A.confirm(true)).ok, false, 'not on the confirm screen');
  h.flow.openInvite('claudebuddy://join?hub=https://a.stranger.example&t=inv_a');
  // A second link naming another hub replaces the question; only that one is answerable.
  h.flow.openInvite('claudebuddy://join?hub=https://b.stranger.example&t=inv_b');
  assert.equal((await h.A.confirm(true)).ok, true);
  assert.equal(h.flow.hubTrusted('https://b.stranger.example'), true);
  assert.equal(h.flow.hubTrusted('https://a.stranger.example'), false);
  // Cancel on a fresh question clears the invite and goes back to the board.
  h.flow.openInvite('claudebuddy://join?hub=https://c.stranger.example&t=inv_c');
  assert.equal((await h.A.confirm(false)).ok, true);
  assert.deepEqual(h.selects.at(-1), 'board');
  assert.equal(h.flow.hubTrusted('https://c.stranger.example'), false);
}));

test('L5: an invite link naming a private or loopback address is ignored', async () => harness(async (h) => {
  for (const hub of ['https://192.168.1.10', 'https://10.0.0.2', 'https://169.254.169.254', 'https://100.64.1.1']) {
    assert.equal(h.flow.openInvite(`claudebuddy://join?hub=${hub}&t=inv_abc`), false, hub);
    assert.equal((await h.A.joinCode(`${hub}/invite#inv_abc`)).ok, false, hub);
  }
  assert.equal(h.flow.acct.screen, null, 'no screen shown for them');
}));

test('L3: a hub-less invite with more than one known hub asks which hub', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  h.store.addHub('https://second.example.com');
  h.flow.openInvite('claudebuddy://invite/inv_token123');
  assert.equal(h.flow.acct.screen, 'hub');
  assert.equal((await h.A.state()).forInvite, true);
}));

// ── L4: actions carry what the screen rendered ─────────────────────────────

test('L4: accept needs the preview id the screen rendered; a newer link does not ride on the old click', async () => harness(async (h) => {
  const luke = await h.other('luke@example.com');
  const pistor = (await luke.createTeam('Pistor')).team;
  const first = await luke.invite(pistor.id, 'me@example.com', 'member');
  await h.signInAs('me@example.com');
  h.flow.openInvite(first.link);
  assert.equal(h.flow.acct.screen, 'join');
  const s = await h.A.state();
  assert.equal(s.invite.team, 'Pistor');
  assert.equal(s.invite.inviter, 'luke');
  assert.match(s.invite.id, /^[0-9a-f-]{36}$/);
  const accepts = () => h.requests.filter((u) => u.pathname === '/api/invites/accept').length;
  assert.equal((await h.A.accept('not-the-id')).ok, false);
  // Another link arrives before the click: the rendered id no longer matches.
  const sidecar = (await luke.createTeam('Sidecar')).team;
  h.flow.openInvite((await luke.invite(sidecar.id, 'me@example.com', 'member')).link);
  assert.match((await h.A.accept(s.invite.id)).error, /changed/);
  assert.equal(accepts(), 0, 'no accept was sent');
  const s2 = await h.A.state();
  assert.equal(s2.invite.team, 'Sidecar');
  assert.equal((await h.A.accept(s2.invite.id)).ok, true);
  assert.equal(h.store.active().name, 'Sidecar');
}));

test('L4: team actions name the rendered team and are refused once the active team changed', async () => harness(async (h) => {
  await h.signInAs('owner@example.com');
  await h.A.createTeam('Bondly');
  const bondly = h.store.active();
  const s = await h.A.state();
  assert.equal(s.screen, 'team');
  assert.equal(s.team.id, bondly.id);
  const r = await h.A.invite(bondly.id, 'sam@example.com', 'member');
  assert.equal(r.ok, true);
  assert.ok(r.link.startsWith(`${h.origin}/invite#`), 'the link is shown once');
  assert.equal(r.email, 'sam@example.com');
  const invId = (await h.A.state()).invites[0].id;
  const re = await h.A.resendInvite(bondly.id, invId);
  assert.equal(re.ok, true);
  assert.notEqual(re.link, r.link, 'resend mints a new link');
  assert.match(re.notice, /old one no longer works/);
  // The page still shows Bondly, but the member switched to another team meanwhile.
  await h.A.createTeam('Other');
  assert.notEqual(h.store.active().id, bondly.id);
  for (const call of [() => h.A.invite(bondly.id, 'x@example.com', 'member'), () => h.A.resendInvite(bondly.id, invId), () => h.A.revokeInvite(bondly.id, invId), () => h.A.setRole(bondly.id, 'm1', 'admin'), () => h.A.removeMember(bondly.id, 'm1')]) {
    assert.match((await call()).error, /team changed/);
  }
}));

// ── M2 + M3: signing out undoes everything ─────────────────────────────────

async function runnerOn(h, name = 'Bondly') {
  await h.A.createTeam(name);
  const ws = h.store.active();
  assert.equal((await h.A.runner(ws.id, true)).ok, true);
  const child = h.children.at(-1);
  child.emit('message', { type: 'runner.ready' });
  child.emit('message', { type: 'runner.status', state: 'connected' });
  assert.ok(fs.existsSync(h.deviceFile(ws)), 'sealed enrolment on disk');
  assert.deepEqual(h.flow.runningTeams(), [name]);
  return { ws, child };
}

function assertHubCleared(h, origin) {
  for (const p of [partitionFor(origin), integrationPartitionFor(origin)]) assert.deepEqual(h.sessions.get(p)?.calls.sort(), ['auth', 'cache', 'storage'], p);
  assert.equal(h.flow.hubTrusted(origin) && !h.store.knows(origin), false);
}

test('M2/M3: sign out stops and revokes the runner, deletes the sealed file, clears the hub’s partitions', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const { ws, child } = await runnerOn(h);
  // A sealed file for a team not loaded this run goes too.
  const stray = path.join(h.devDir, `${hubKey(h.origin)}-team_elsewhere.bin`);
  fs.writeFileSync(stray, 'SEALED:x');
  assert.equal((await h.A.signOut(h.host)).ok, true);
  assert.equal(child.killed, 1);
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assert.equal(fs.existsSync(stray), false);
  assert.equal(h.hub.enrolments()[0].revoked, true, 'unenrolled on the hub');
  assert.deepEqual(h.flow.runningTeams(), []);
  assertHubCleared(h, h.origin);
  assert.equal(h.flow.acct.screen, 'account');
}));

test('M2/M3: a 401 (revoked elsewhere) stops the runner, deletes its file, clears storage and shows sign-in', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const { ws, child } = await runnerOn(h);
  h.hub.revokeAll('me@example.com');
  await h.flow.checkSignedIn(h.origin);
  assert.equal(child.killed, 1);
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assertHubCleared(h, h.origin);
  assert.equal(h.flow.acct.screen, 'email');
  assert.match((await h.A.state()).notice, /signed out/);
  assert.equal(h.store.active().id, 'local');
}));

test('a runner reporting its token refused triggers the same check', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const { ws, child } = await runnerOn(h);
  h.hub.revokeAll('me@example.com');
  child.emit('message', { type: 'runner.status', state: 'unauthenticated' });
  await until(() => !fs.existsSync(h.deviceFile(ws)));
  assert.equal(h.flow.acct.screen, 'email');
}));

test('the check signs nobody out while the hub still answers 200', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const { child } = await runnerOn(h);
  const r = await h.flow.checkSignedIn(h.origin);
  assert.equal(r.ok, true);
  assert.equal(child.killed, 0);
  assert.deepEqual(h.signedOutHubs, []);
}));

test('B6: session.revoked then close 4401 on /ws/board is treated as a 401', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly');
  const token = h.vault(h.origin).load().token;
  const ws = new WebSocket(`${h.origin.replace('http', 'ws')}/ws/board`, { headers: { Authorization: `Bearer ${token}` } });
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  await until(() => frames.some((f) => f.type === 'welcome'));
  h.hub.revokeAll('me@example.com');
  const code = await closed;
  assert.equal(code, 4401);
  assert.ok(frames.some((f) => f.type === 'session.revoked'));
  // What main does on 4401 (via the board web's re-check → 401): ask /api/account.
  await h.flow.checkSignedIn(h.origin);
  assert.equal(h.vault(h.origin).load(), null);
  assert.equal(h.flow.acct.screen, 'email');
  // With no credential the upgrade is a plain HTTP 401.
  const anon = new WebSocket(`${h.origin.replace('http', 'ws')}/ws/board`);
  const status = await new Promise((r) => anon.once('unexpected-response', (_req, res) => r(res.statusCode)));
  assert.equal(status, 401);
}));

test('M2: switch account (wrong-account invite) stops the runner and deletes its file, then keeps the invite', async () => harness(async (h) => {
  const luke = await h.other('luke@example.com');
  const team = (await luke.createTeam('Pistor')).team;
  const inv = await luke.invite(team.id, 'callum@example.com', 'member');
  await h.signInAs('someone@example.com');
  const { ws, child } = await runnerOn(h);
  h.flow.openInvite(inv.link);
  const s = await h.A.state();
  const r = await h.A.accept(s.invite.id);
  assert.equal(r.wrongAccount, true);
  assert.equal(r.error, 'This invite is for c…@example.com. Switch account?');
  assert.equal((await h.A.switchAccount()).ok, true);
  assert.equal(child.killed, 1);
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assertHubCleared(h, h.origin);
  assert.equal(h.flow.acct.screen, 'email');
  assert.equal((await h.A.email('callum@example.com')).ok, true);
  await h.A.code(h.hub.lastCode('callum@example.com'));
  assert.equal(h.flow.acct.screen, 'join', 'the invite waited for the right account');
}));

test('M2/M3: delete account stops the runner, deletes its file and clears the hub’s storage', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const { ws, child } = await runnerOn(h);
  await h.A.go('account');
  assert.equal((await h.A.deleteStart(h.host)).ok, true);
  assert.equal((await h.A.state()).deleting, h.host);
  assert.equal((await h.A.deleteConfirm(h.hub.lastCode('me@example.com'))).ok, true);
  assert.equal(child.killed, 1);
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assertHubCleared(h, h.origin);
  assert.equal((await h.A.state()).accounts.length, 0);
}));

test('M3: signing out clears a pending invite, the trusted hub and a half-done delete for that hub', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const luke = await h.other('luke@example.com');
  const team = (await luke.createTeam('Pistor')).team;
  h.flow.openInvite((await luke.invite(team.id, 'me@example.com', 'member')).link);
  await h.A.deleteStart(h.host);
  await h.A.signOut(h.host);
  assert.equal(h.flow.acct.deleting, false);
  await h.A.go('join');
  assert.equal((await h.A.state()).invite, null, 'the invite went with the sign-out');
}));

test('L9: runningTeams names the teams whose runner is on', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const { ws } = await runnerOn(h, 'Bondly');
  await h.A.runner(ws.id, false);
  assert.deepEqual(h.flow.runningTeams(), []);
}));

test('B2/B3 through the flow: start names this device; a wrong code shows tries left', async () => harness(async (h) => {
  await h.A.hub(h.origin);
  await h.A.email('x@example.com');
  assert.deepEqual(h.hub.starts().at(-1), { email: 'x@example.com', client: 'buddy_desktop', purpose: 'signin', device_name: 'Test Mac', platform: 'darwin-arm64' });
  const good = h.hub.lastCode('x@example.com');
  assert.equal((await h.A.code(good === '000000' ? '111111' : '000000')).error, 'That code didn’t work. 4 tries left.');
}));

// ── M4: the bearer header never follows a redirect off the hub ─────────────

test('M4: a hub URL that 302s to another loopback server: the second server sees no Authorization', async () => {
  const hub = createMockAccountsHub();
  const origin = await hub.listen();
  const seen = [];
  const other = http.createServer((req, res) => { seen.push(req.headers); res.end('ok'); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const second = `http://127.0.0.1:${other.address().port}`;
  try {
    const scope = bearerScope(origin);
    const token = 'bdt_secret_value';
    let url = `${origin}/api/dev/bounce?to=${encodeURIComponent(`${second}/landing`)}`;
    // The page may add its own header too; both must be gone off the hub.
    let headers = { Accept: '*/*', authorization: 'Basic cGFnZTpwdw==' };
    const hops = [];
    for (let i = 0; i < 3; i += 1) {
      // As the listener runs on every hop, with the headers Chromium would carry over (worst case: all of them).
      headers = bearerHeaders(headers, url, { scope, token });
      hops.push({ url, auth: headers.Authorization ?? headers.authorization ?? null });
      const res = await fetch(url, { headers, redirect: 'manual' });
      if (res.status !== 302) break;
      url = new URL(res.headers.get('location'), url).href;
    }
    assert.equal(hops[0].auth, `Bearer ${token}`, 'ours on the hub (the page’s own replaced)');
    assert.equal(hops.length, 2);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, undefined, 'nothing reached the second server');
  } finally {
    await hub.close();
    await new Promise((r) => other.close(r));
  }
});

test('M4: the listener strips ours anywhere, a page’s own only outside the hub, and sets ours only in scope', () => {
  const scope = bearerScope('https://buddy.example.com');
  const token = 'bdt_t';
  const ours = { Authorization: `Bearer ${token}` };
  assert.deepEqual(bearerHeaders({}, 'https://buddy.example.com/api/me', { scope, token }), ours);
  assert.deepEqual(bearerHeaders({ authorization: 'Bearer page' }, 'https://buddy.example.com/api/me', { scope, token }), ours, 'ours replaces the page’s in scope');
  assert.deepEqual(bearerHeaders({ authorization: 'Bearer page' }, 'https://buddy.example.com/api/me', { scope, token: null }), { authorization: 'Bearer page' }, 'signed out: the page’s own stays on its own origin');
  for (const u of ['https://evil.example.com/', 'https://buddy.example.com:8443/', 'http://buddy.example.com/', 'wss://evil.example.com/ws']) {
    assert.deepEqual(bearerHeaders({ ...ours, X: '1' }, u, { scope, token }), { X: '1' }, u);
    assert.deepEqual(bearerHeaders({ AUTHORIZATION: 'Basic x' }, u, { scope, token }), {}, u);
  }
  assert.deepEqual(bearerHeaders({}, 'wss://buddy.example.com/ws/board', { scope, token }), ours, 'the socket upgrade too');
});
