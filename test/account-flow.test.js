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

// The system browser's part in a provider sign-in: open the hub's page,
// follow its redirect to the loopback, like a person clicking "Allow".
async function realBrowser(url) {
  const r = await fetch(url, { redirect: 'manual' });
  const to = r.headers.get('location');
  if (to) await fetch(to);
}

async function harness(fn, { oauthTimeoutMs } = {}) {
  const hub = createMockAccountsHub();
  const origin = await hub.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-flow-'));
  const devDir = path.join(dir, 'devices');
  fs.mkdirSync(devDir);
  const allowOrigins = [origin];
  let skew = null;
  const now = () => skew ?? Date.now();
  const vaults = new Map();
  const vault = (o) => {
    if (!vaults.has(o)) { let v = null; vaults.set(o, { load: () => v, save: (x) => { v = JSON.parse(JSON.stringify(x)); }, clear: () => { v = null; } }); }
    return vaults.get(o);
  };
  const signedIn = (o) => !!vault(o).load();
  const store = createWorkspaceStore(path.join(dir, 'ws.json'), { allowOrigins, signedIn });
  const requests = []; // every URL any client asked for
  const bodies = []; // every request body sent
  const logs = [];
  const opened = [];
  let browser = realBrowser;
  let afterHub = null; // runs once the hub has answered, before the client sees the answer
  const fetchImpl = async (u, init) => {
    requests.push(new URL(u));
    if (init?.body) bodies.push(String(init.body));
    if (!u.startsWith(origin)) throw new TypeError('fetch failed');
    const res = await fetch(u, init);
    if (afterHub) await afterHub(u);
    return res;
  };
  const clients = new Map();
  let flow = null;
  const clientFor = (o) => {
    if (!clients.has(o)) clients.set(o, createAccountClient({ origin: o, store: vault(o), fetchImpl, now, onSignedOut: () => { flow.signedOutOf(o, { tell: true }); } }));
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
  const mails = [];
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
    openBrowser: (u) => { opened.push(u); Promise.resolve().then(() => browser(u)).catch(() => {}); },
    oauthAllowOrigins: allowOrigins,
    oauthTimeoutMs,
    now,
    log: (...a) => logs.push(JSON.stringify(a)),
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
      openMail: (u) => mails.push(u),
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
  const h = { hub, origin, dir, devDir, store, flow, A, requests, shown, selects, sessions, signedOutHubs, children, deviceFile, signInAs, other, vault, mails, bodies, logs, opened, setBrowser: (b) => { browser = b; }, setAfterHub: (f) => { afterHub = f; }, setNow: (ms) => { skew = ms; }, host: hostOf(origin) };
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
  assert.ok(r.invite.link.startsWith(`${h.origin}/invite#`), 'the link is shown once');
  assert.match(r.invite.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(r.invite.email, 'sam@example.com');
  assert.equal(r.notice, 'Invite created. Share the link or the code.');
  const invId = (await h.A.state()).invites[0].id;
  const re = await h.A.resendInvite(bondly.id, invId);
  assert.equal(re.ok, true);
  assert.notEqual(re.invite.link, r.invite.link, 'resend mints a new link');
  assert.notEqual(re.invite.code, r.invite.code, 'and a new code');
  assert.equal(re.notice, 'New link and code created. The old ones no longer work.');
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

// ── accounts P2/P3 alignment ───────────────────────────────────────────────

test('P3: the top-level error codes read as plain sentences', () => {
  const { humanError } = require('../buddy-window/accounts');
  const say = (status, error) => humanError(status, { error }, 'hub.example.com');
  assert.equal(say(403, { code: 'QUOTA_EXCEEDED', resource: 'members', limit: 25 }), 'This team has reached its limit.');
  assert.equal(say(403, { code: 'EMAIL_UNVERIFIED' }), 'Verify your email first.');
  assert.equal(say(403, { code: 'WRONG_ACCOUNT', email_masked: 'c…@example.com' }), 'This invite is for c…@example.com.');
  assert.equal(say(409, { code: 'ALREADY_MEMBER', team: { id: 't', name: 'T' } }), 'They’re already in this team.');
  assert.equal(say(409, { code: 'CONFLICT', reason: 'LAST_OWNER' }), 'A team needs at least one owner. Make someone else an owner first.');
  assert.equal(say(409, { code: 'CONFLICT', invite_id: 'inv_1' }), 'There’s already an invite waiting for that address. Resend it instead.');
});

test('P3: roles are owner, admin, member, viewer (no guest) in the client, the store and the page', () => {
  const { ROLES } = require('../buddy-window/accounts');
  assert.deepEqual(ROLES, ['owner', 'admin', 'member', 'viewer']);
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.ok(!/guest/i.test(page), 'no guest anywhere on the page');
  assert.match(page, /viewer: 'Can look, not change'/);
  const { teamsFromAccount } = require('../buddy-window/workspaces');
  assert.deepEqual(teamsFromAccount({ teams: [{ id: 'a', name: 'A', role: 'viewer' }, { id: 'b', name: 'B', role: 'guest' }] }).map((t) => t.role), ['viewer', 'member']);
});

test('P3: invites never above your own role; a second pending invite is a CONFLICT; a full team is QUOTA_EXCEEDED', async () => {
  const hub = createMockAccountsHub({ quotas: { members: 3 } });
  const origin = await hub.listen();
  const signIn = async (email) => {
    let v = null;
    const c = createAccountClient({ origin, store: { load: () => v, save: (x) => { v = x; }, clear: () => { v = null; } } });
    await c.startEmail(email);
    await c.verifyCode(hub.lastCode(email));
    return c;
  };
  try {
    const owner = await signIn('o@example.com');
    const team = (await owner.createTeam('T')).team;
    const adm = await signIn('a@example.com');
    await adm.acceptInvite({ t: (await owner.invite(team.id, 'a@example.com', 'admin')).link.split('#')[1] });
    assert.equal((await adm.invite(team.id, 'v@example.com', 'viewer')).ok, true, 'an admin invites a viewer');
    assert.equal((await adm.invite(team.id, 'x@example.com', 'owner')).error, 'Pick a role.', 'never as owner');
    const full = await owner.invite(team.id, 'y@example.com', 'member');
    assert.deepEqual([full.code, full.error], ['QUOTA_EXCEEDED', 'This team has reached its limit.'], 'pending invites count');
    hub.setVerified('o@example.com', false);
    assert.equal((await owner.createTeam('U')).error, 'Verify your email first.');
  } finally { await hub.close(); }
});

test('P3: accept with the mail’s XXXX-XXXX code, only for the signed-in address; joinCode routes a code there too', async () => harness(async (h) => {
  const luke = await h.other('luke@example.com');
  const team = (await luke.createTeam('Pistor')).team;
  await luke.invite(team.id, 'me@example.com', 'member');
  const code = h.hub.inviteCode('me@example.com');
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await h.A.acceptCode(code)).error, 'Sign in first, then enter the code.');
  await h.signInAs('me@example.com');
  assert.equal((await h.A.acceptCode('nope')).error, 'The code looks like ABCD-EFGH.');
  assert.equal((await h.A.acceptCode('ZZZZ-ZZZZ')).error, 'That code didn’t work. Check it, or ask for a new invite.');
  // Someone else's code is just invalid for me: codes reveal nothing.
  await luke.invite(team.id, 'sam@example.com', 'member');
  assert.equal((await h.A.acceptCode(h.hub.inviteCode('sam@example.com'))).error, 'That code didn’t work. Check it, or ask for a new invite.');
  const r = await h.A.joinCode(code.toLowerCase().replace('-', ''));
  assert.equal(r.ok, true, r.error);
  assert.equal(h.store.active().name, 'Pistor');
  assert.ok(h.requests.some((u) => u.pathname === '/api/invites/accept'));
}));

test('P3: a pending invite is accepted with POST /api/account/invites/:id/accept', async () => harness(async (h) => {
  const luke = await h.other('luke@example.com');
  const team = (await luke.createTeam('Pistor')).team;
  await luke.invite(team.id, 'me@example.com', 'viewer');
  await h.signInAs('me@example.com');
  assert.equal(h.flow.acct.screen, 'invites');
  const id = (await h.A.state()).invites[0].id;
  assert.equal((await h.A.acceptPending(id)).ok, true);
  assert.ok(h.requests.some((u) => u.pathname === `/api/account/invites/${id}/accept`));
  assert.equal(h.store.active().role, 'viewer');
  // Viewers can look, not run cards: refused before any enrolment.
  assert.equal((await h.A.runner(h.store.active().id, true)).error, 'Viewers can’t run cards.');
  assert.equal(h.hub.enrolments().length, 0);
}));

test('P2: team settings: rename, add a board, resend with the resend route, delete by typing the slug', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly Team');
  const ws = h.store.active();
  let s = await h.A.state();
  assert.deepEqual([s.team.slug, s.team.boards], ['bondly-team', 1]);
  assert.equal((await h.A.renameTeam(ws.id, 'Bondly')).ok, true);
  assert.equal(h.store.active().name, 'Bondly');
  assert.equal((await h.A.addBoard(ws.id, 'Marketing')).notice, 'Added the Marketing board.');
  assert.equal((await h.A.state()).team.boards, 2);
  await h.A.invite(ws.id, 'sam@example.com', 'member');
  s = await h.A.state();
  const re = await h.A.resendInvite(ws.id, s.invites[0].id);
  assert.equal(re.ok, true);
  assert.ok(h.requests.some((u) => u.pathname === `/api/teams/${ws.teamId}/invites/${s.invites[0].id}/resend`));
  assert.equal((await h.A.deleteTeam(ws.id, 'Bondly')).error, 'That doesn’t match the team’s name. Type it exactly as shown.');
  assert.equal((await h.A.deleteTeam(ws.id, 'bondly-team')).ok, true);
  assert.equal(h.flow.acct.screen, 'team');
  assert.match((await h.A.state()).notice ?? '', /was deleted/);
  assert.equal(h.store.list().some((w) => w.id === ws.id), false, 'gone from the switcher');
}));

test('P2: team-scoped calls name the team in X-Board-Team; a header naming another team is a 404', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  await h.A.state();
  assert.ok(h.hub.teamHeaders().length > 0 && h.hub.teamHeaders().every((t) => t === ws.teamId));
  const token = h.vault(h.origin).load().token;
  const res = await fetch(`${h.origin}/api/teams/${ws.teamId}/members`, { headers: { Authorization: `Bearer ${token}`, 'X-Board-Team': 'team_other' } });
  assert.equal(res.status, 404);
}));

test('no invite mail from the hub: Email it opens a mailto: the flow built from the invite it minted, never a page URL', async () => harness(async (h) => {
  await h.signInAs('owner@example.com');
  await h.A.createTeam('Bondly & Co');
  const ws = h.store.active();
  const r = await h.A.invite(ws.id, 'sam@example.com', 'member');
  assert.equal((await h.A.emailInvite(ws.id, 'inv_someone_else')).ok, false, 'only the invite just shown');
  assert.deepEqual(h.mails, []);
  assert.equal((await h.A.emailInvite(ws.id, r.invite.id)).ok, true);
  const u = new URL(h.mails[0]);
  assert.equal(u.protocol, 'mailto:');
  assert.equal(u.pathname, 'sam@example.com');
  assert.equal(u.searchParams.get('subject'), 'Join Bondly & Co on Plexiform');
  const body = u.searchParams.get('body');
  assert.ok(body.includes(r.invite.link) && body.includes(r.invite.code));
  assert.ok(body.length <= 1500);
  // Resend replaces what Email it drafts; signing out forgets it.
  const re = await h.A.resendInvite(ws.id, r.invite.id);
  assert.equal((await h.A.emailInvite(ws.id, r.invite.id)).ok, false);
  assert.equal((await h.A.emailInvite(ws.id, re.invite.id)).ok, true);
  assert.ok(h.mails[1].includes(encodeURIComponent(re.invite.code)));
  await h.A.signOut(h.host);
  assert.equal((await h.A.emailInvite(ws.id, re.invite.id)).ok, false);
  const { inviteMailto } = require('../buddy-window/accounts');
  assert.equal(inviteMailto({ to: 'x?cc=evil@example.com', team: 'T', link: 'l', brand: 'P' }), null, 'no header smuggling in the address');
  const long = inviteMailto({ to: 'a@example.com', team: 'T\r\nBcc: e@x.com'.padEnd(500, 'x'), link: 'https://h/invite#t', code: 'ABCD-EFGH', brand: 'P' });
  assert.ok(!decodeURIComponent(long).includes('\r\nBcc'), 'control characters in the team name are flattened');
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.ok(!/emailed it|Invite sent|Send invite|from your email|invite email/i.test(page));
  assert.ok(!/email/i.test(require('../buddy-window/brand').COPY.inviteHint.replace('doesn’t email', '')), 'no promise of an email');
}));

// ── Google / GitHub sign-in (system browser, PKCE, loopback) ───────────────

const { pkcePair, providerUrlOk, callbackHandler, listenOnce } = require('../buddy-window/oauth');
const crypto = require('node:crypto');

test('oauth: PKCE is 32 random bytes and base64url(sha256(verifier))', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(pkcePair().verifier, verifier);
});

test('oauth: the browser is sent only to https on a public name', () => {
  for (const u of ['https://accounts.google.com/o/oauth2/v2/auth?x=1', 'https://github.com/login/oauth/authorize', 'https://app.plexiform.dev/api/auth/oauth/go']) assert.equal(providerUrlOk(u), true, u);
  for (const u of ['http://accounts.google.com/', 'https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.8/', 'https://192.168.1.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://intranet/', 'https://user:pw@github.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url']) assert.equal(providerUrlOk(u), false, u);
  assert.equal(providerUrlOk('http://127.0.0.1:5555/dev/oauth/authorize', { allowOrigins: ['http://127.0.0.1:5555'] }), true, 'the dev mock’s exact origin only');
  assert.equal(providerUrlOk('http://127.0.0.1:5556/', { allowOrigins: ['http://127.0.0.1:5555'] }), false);
});

test('oauth: Continue with Google, full path against the mock: loopback, exchange, signed in; no code, verifier or token in any log', async () => harness(async (h) => {
  h.hub.setOAuthIdentity('google', { email: 'callum@example.com' });
  await h.A.hub(h.origin);
  const s = await h.A.state();
  assert.deepEqual(s.methods, { google: true, github: true, email: true });
  assert.equal((await h.A.oauth('google')).ok, true);
  assert.equal(h.flow.acct.screen, 'browser');
  assert.equal((await h.A.state()).provider, 'google');
  const r = await h.flow.pendingOAuth();
  assert.equal(r.ok, true, r.error);
  assert.equal(h.vault(h.origin).load().user.email, 'callum@example.com');
  assert.equal(h.flow.acct.screen, 'create-team');
  const start = h.hub.oauthStarts()[0];
  assert.equal(start.provider, 'google');
  assert.match(start.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.match(start.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(start.device_name, 'Test Mac');
  assert.equal(start.code_verifier, undefined, 'the verifier goes only to the exchange');
  assert.equal(start.state, undefined, 'the hub mints the state; the app never sends one');
  assert.equal(start.client, 'buddy_desktop');
  const ex = JSON.parse(h.bodies.find((b) => b.includes('code_verifier')));
  assert.equal(crypto.createHash('sha256').update(ex.code_verifier).digest('base64url'), start.code_challenge);
  assert.equal(ex.state, new URL(h.hub.oauthCallback()).searchParams.get('state'), 'the exchange returns the hub’s own state');
  const logged = h.logs.join('\n');
  for (const secret of [ex.code, ex.code_verifier, h.vault(h.origin).load().token, ex.state]) assert.ok(!logged.includes(secret), 'never logged');
  assert.ok(h.opened[0].startsWith(`${h.origin}/dev/oauth/authorize`));
  assert.equal(h.hub.liveTokens(), 1, 'the token it keeps is live on the hub');
  // The listener is gone: replaying the callback reaches nothing.
  await assert.rejects(fetch(h.hub.oauthCallback()));
}));

test('oauth: a wrong state or a stray request never completes the flow nor echoes input; the right one then does', async () => harness(async (h) => {
  let callback = null;
  h.setBrowser(async (u) => { callback = (await fetch(u, { redirect: 'manual' })).headers.get('location'); });
  await h.A.hub(h.origin);
  await h.A.oauth('github');
  await until(() => callback);
  const good = new URL(callback);
  const bad = new URL(callback);
  bad.searchParams.set('state', 'x'.repeat(43));
  const res = await fetch(bad);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(!text.includes(good.searchParams.get('code')) && !text.includes('xxxx'), 'nothing echoed');
  const noState = new URL(callback);
  noState.searchParams.delete('state');
  assert.equal((await fetch(noState)).status, 400);
  assert.equal((await fetch(new URL('/other', callback))).status, 404);
  assert.equal((await fetch(callback, { method: 'POST' })).status, 405, 'GET only');
  assert.equal(h.flow.acct.screen, 'browser', 'still waiting');
  const ok = await fetch(callback);
  assert.equal(await ok.text(), 'Finish signing in in Plexiform. You can close this tab.', 'nothing claims a sign-in the exchange hasn’t made yet');
  await until(() => h.flow.acct.screen === 'create-team');
  assert.ok(h.vault(h.origin).load());
}));

test('oauth: the hub refuses a replayed code and a verifier that doesn’t match the challenge', async () => harness(async (h) => {
  const c = createAccountClient({ origin: h.origin, store: { load: () => null, save() {}, clear() {} } });
  const { verifier, challenge } = pkcePair();
  const start = await c.startOAuth('google', { challenge, redirectUri: 'http://127.0.0.1:9/callback' });
  const state = start.state;
  assert.ok(state.length >= 16, 'the hub minted a state');
  const loc = new URL((await fetch(start.url, { redirect: 'manual' })).headers.get('location'));
  const code = loc.searchParams.get('code');
  assert.equal(loc.searchParams.get('state'), state);
  const wrong = await c.exchangeOAuth({ flowId: start.flow_id, code, state, verifier: pkcePair().verifier, provider: 'google' });
  assert.equal(wrong.error, 'That sign-in didn’t work. Try again.');
  const again = await c.exchangeOAuth({ flowId: start.flow_id, code, state, verifier, provider: 'google' });
  assert.equal(again.ok, false, 'the code was spent by the first try');
  // A fresh flow, the right verifier: signed in once, and only once.
  let saved = null;
  const c2 = createAccountClient({ origin: h.origin, store: { load: () => saved, save: (x) => { saved = x; }, clear: () => { saved = null; } } });
  const p = pkcePair();
  const s2 = await c2.startOAuth('github', { challenge: p.challenge, redirectUri: 'http://127.0.0.1:9/callback' });
  const code2 = new URL((await fetch(s2.url, { redirect: 'manual' })).headers.get('location')).searchParams.get('code');
  assert.equal((await c2.exchangeOAuth({ flowId: s2.flow_id, code: code2, state: 'z'.repeat(43), verifier: p.verifier, provider: 'github' })).ok, false, 'wrong state at the hub');
  const s3 = await c2.startOAuth('github', { challenge: p.challenge, redirectUri: 'http://127.0.0.1:9/callback' });
  const code3 = new URL((await fetch(s3.url, { redirect: 'manual' })).headers.get('location')).searchParams.get('code');
  assert.equal((await c2.exchangeOAuth({ flowId: s3.flow_id, code: code3, state: s3.state, verifier: p.verifier, provider: 'github' })).ok, true);
  assert.equal((await c2.exchangeOAuth({ flowId: s3.flow_id, code: code3, state: s3.state, verifier: p.verifier, provider: 'github' })).ok, false, 'replay');
  assert.equal(saved.user.email, 'github-user@example.com');
  h.hub.setNow(Date.now() + 11 * 60_000);
  assert.equal((await fetch(s3.url, { redirect: 'manual' })).status, 400, 'expired');
}));

test('oauth: the listener times out; Cancel closes it; a second sign-in replaces the first', async () => harness(async (h) => {
  h.setBrowser(async () => {});
  await h.A.hub(h.origin);
  await h.A.oauth('google');
  const r = await h.flow.pendingOAuth();
  assert.equal(r.error, 'The browser sign-in timed out. Try again.');
  assert.equal(h.flow.acct.screen, 'email');
  assert.equal((await h.A.state()).alert, 'The browser sign-in timed out. Try again.');
  await h.A.oauth('google');
  await until(() => h.hub.oauthStarts().length === 2);
  const first = h.hub.oauthStarts()[1].redirect_uri;
  await h.A.oauth('github');
  await until(() => h.hub.oauthStarts().length === 3);
  await assert.rejects(fetch(first), 'the first listener closed');
  const second = h.hub.oauthStarts()[2].redirect_uri;
  const done = h.flow.pendingOAuth();
  assert.equal((await h.A.cancelOAuth()).ok, true);
  assert.equal((await done).cancelled, true);
  assert.equal(h.flow.acct.screen, 'email');
  await assert.rejects(fetch(second), 'cancel closes the listener');
  assert.equal(h.vault(h.origin).load(), null);
}, { oauthTimeoutMs: 300 }));

test('oauth: Cancel while the exchange is in flight: the token the hub still mints is revoked there, never stored, no workspace', async () => harness(async (h) => {
  h.hub.setOAuthIdentity('google', { email: 'callum@example.com' });
  await h.A.hub(h.origin);
  h.setAfterHub(async (u) => { if (u.includes('/oauth/exchange')) await h.A.cancelOAuth(); });
  await h.A.oauth('google');
  const r = await h.flow.pendingOAuth();
  h.setAfterHub(null);
  assert.deepEqual(r, { ok: false, cancelled: true });
  assert.equal(h.vault(h.origin).load(), null, 'nothing sealed');
  assert.equal(h.hub.liveTokens(), 0, 'revoked on the hub');
  assert.ok(h.requests.some((u) => u.pathname === '/api/auth/signout'));
  assert.deepEqual(h.store.list().filter((w) => w.kind === 'team'), []);
  assert.ok(!h.store.hubs().includes(h.origin), 'no hub added');
  assert.equal(h.flow.acct.screen, 'email');
}));

test('oauth: a sign-in replaced by a newer one while its exchange is in flight is revoked, not stored', async () => harness(async (h) => {
  h.hub.setOAuthIdentity('google', { email: 'callum@example.com' });
  await h.A.hub(h.origin);
  h.setAfterHub(async (u) => {
    if (!u.includes('/oauth/exchange')) return;
    h.setAfterHub(null);
    h.setBrowser(async () => {});
    await h.A.oauth('github');
  });
  await h.A.oauth('google');
  const first = h.flow.pendingOAuth();
  await until(() => h.hub.oauthStarts().length === 2);
  assert.deepEqual(await first, { ok: false, cancelled: true });
  assert.equal(h.vault(h.origin).load(), null, 'nothing sealed');
  assert.equal(h.hub.liveTokens(), 0, 'revoked on the hub');
  assert.deepEqual(h.store.list().filter((w) => w.kind === 'team'), []);
  assert.equal(h.flow.acct.screen, 'browser', 'the newer sign-in still waits on the browser');
  const second = h.flow.pendingOAuth();
  await h.A.cancelOAuth();
  assert.equal((await second).cancelled, true);
}));

test('oauth: the listener binds 127.0.0.1 only; other addresses, other Hosts and non-GET are refused', async () => {
  const l = await listenOnce({ brand: 'Plexiform', timeoutMs: 5000 });
  assert.equal(typeof l.expect, 'function');
  try {
    assert.equal(l.address, '127.0.0.1');
    const finished = [];
    const handler = callbackHandler({ port: 4242, state: 'st', brand: 'Plexiform', finish: (r) => finished.push(r) });
    const fake = (over) => {
      const socket = { remoteAddress: '127.0.0.1', destroyed: false, destroy() { this.destroyed = true; } };
      const req = { method: 'GET', url: '/callback?code=abc&state=st', headers: { host: '127.0.0.1:4242' }, socket, ...over };
      const res = { status: null, body: null, writeHead(st) { this.status = st; }, end(b) { this.body = b; } };
      handler(req, res);
      return { req, res, socket: req.socket };
    };
    const far = fake({ socket: { remoteAddress: '192.168.1.20', destroy() { this.destroyed = true; } } });
    assert.equal(far.socket.destroyed, true, 'a non-loopback peer is cut off');
    assert.equal(far.res.status, null);
    assert.equal(fake({ headers: { host: 'evil.example:4242' } }).res.status, 400, 'DNS rebinding: wrong Host');
    assert.equal(fake({ method: 'POST' }).res.status, 405);
    assert.equal(fake({ method: 'HEAD' }).res.status, 405);
    assert.deepEqual(finished, []);
    assert.equal(fake({ socket: { remoteAddress: '::ffff:127.0.0.1' } }).res.status, 200);
    assert.equal(fake({}).res.status, 400, 'only one request completes it');
    assert.deepEqual(finished, [{ ok: true, code: 'abc' }]);
  } finally { l.close(); }
  assert.deepEqual(await l.result, { ok: false, reason: 'cancelled' });
});

test('oauth: an invite waits through Continue with Google, then the join preview', async () => harness(async (h) => {
  const luke = await h.other('luke@example.com');
  const team = (await luke.createTeam('Pistor')).team;
  const inv = await luke.invite(team.id, 'callum@example.com', 'member');
  h.hub.setOAuthIdentity('google', { email: 'callum@example.com' });
  h.flow.openInvite(inv.link);
  assert.equal(h.flow.acct.screen, 'confirm', 'a hub never used before is confirmed first');
  await h.A.confirm(true);
  assert.equal(h.flow.acct.screen, 'email');
  await h.A.oauth('google');
  assert.equal((await h.flow.pendingOAuth()).ok, true);
  assert.equal(h.flow.acct.screen, 'join');
  const s = await h.A.state();
  assert.equal(s.invite.team, 'Pistor');
  assert.equal((await h.A.accept(s.invite.id)).ok, true);
  assert.equal(h.store.active().name, 'Pistor');
}));

test('oauth: nothing starts for an unconfirmed hub; hub errors are plain sentences', async () => harness(async (h) => {
  h.flow.openInvite('claudebuddy://join?hub=https://buddy.stranger.example&t=inv_abc123');
  assert.match((await h.A.oauth('google')).error, /Start again/);
  assert.equal((await h.A.oauth('facebook')).ok, false);
  assert.deepEqual(h.requests, []);
  await h.A.notNow();
  await h.A.hub(h.origin);
  assert.equal((await h.A.oauth('facebook')).error, 'Pick Google or GitHub.');
  // The hub's own error codes (accounts link by verified email, so there is no account-conflict code).
  const { oauthOutcome } = require('../buddy-window/accounts');
  assert.match(oauthOutcome({ ok: false, code: 'PROVIDER_UNAVAILABLE' }, 'github', 'h').error, /GitHub didn’t answer/);
  assert.match(oauthOutcome({ ok: false, code: 'PROVIDER_ERROR' }, 'google', 'h').error, /Google didn’t answer/);
  assert.match(oauthOutcome({ ok: false, code: 'METHOD_DISABLED' }, 'google', 'h').error, /turned off on h/);
  assert.match(oauthOutcome({ ok: false, code: 'INVALID_TOKEN' }, 'google', 'h').error, /didn’t work/);
  assert.equal(oauthOutcome({ ok: false, code: 'ACCOUNT_CONFLICT', error: 'x' }, 'google', 'h').error, 'x', 'that code no longer exists');
  h.hub.setOAuthIdentity('google', { email: 'y@example.com', verified: false });
  await h.A.oauth('google');
  assert.match((await h.flow.pendingOAuth()).error, /Google hasn’t verified that email address/);
  const { humanError } = require('../buddy-window/accounts');
  assert.match(humanError(429, { error: { code: 'RATE_LIMITED', retry_after_s: 120 } }, 'h'), /Wait 2 minutes/);
}));

test('sign-in methods: GET /api/auth/methods decides the buttons; each combination; a failed fetch says so', async () => harness(async (h) => {
  await h.A.hub(h.origin);
  const combos = [];
  for (const google of [true, false]) for (const github of [true, false]) for (const email of [true, false]) combos.push({ google, github, email });
  for (const m of combos) {
    h.hub.setMethods(m);
    const s = await h.A.state();
    assert.deepEqual(s.methods, m);
    assert.equal(s.methodsError, null);
  }
  h.hub.setMethods({ google: true });
  assert.equal((await h.A.email('me@example.com')).ok, false, 'the hub refuses a switched-off email sign-in');
  await h.hub.close();
  const s = await h.A.state();
  assert.equal(s.methods, null);
  assert.match(s.methodsError, /Couldn’t reach/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  for (const t of ['Continue with Google', 'Continue with GitHub', 'Use an email code instead', 'This server has no sign-in method enabled. Ask the admin.', 'Try again']) assert.ok(page.includes(t), t);
  const { ROUTES } = require('../buddy-window/accounts');
  assert.deepEqual([ROUTES.authMethods, ROUTES.oauthStart, ROUTES.oauthExchange], [['GET', '/api/auth/methods'], ['POST', '/api/auth/oauth/start'], ['POST', '/api/auth/oauth/exchange']]);
}));

test('This Mac: “Include one-line summaries” is its own per-hub switch, off by default, effective only while sharing is on', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const { child } = await runnerOn(h);
  h.flow.sessionsChanged([{ sessionId: 's1', cwd: '/Users/me/p/proj', signal: 'tool-use', tool: 'Edit', signalSince: '2026-09-30T10:00:00.000Z' }]);
  await h.A.go('thismac');
  let hub = (await h.A.state()).hubs[0];
  assert.deepEqual([hub.share, hub.summaries], [false, false]);
  assert.equal((await h.A.summaries(h.host, true)).ok, true);
  assert.equal(child.sent.filter((m) => m.type === 'runner.presence').length, 0, 'summaries alone share nothing');
  await h.A.presence(h.host, true);
  const p = child.sent.filter((m) => m.type === 'runner.presence').at(-1);
  assert.deepEqual([p.enabled, p.share_summaries, p.sessions[0].summary, p.sessions[0].cwd, p.sessions[0].project], [true, true, 'Using Edit', '/Users/me/p/proj', undefined]);
  await h.A.summaries(h.host, false);
  const q = child.sent.filter((m) => m.type === 'runner.presence').at(-1);
  assert.deepEqual([q.enabled, q.share_summaries, q.sessions[0].summary], [true, false, undefined]);
  hub = (await h.A.state()).hubs[0];
  assert.deepEqual([hub.share, hub.summaries], [true, false]);
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.match(page, /'Share my live sessions'/);
  assert.match(page, /'Include one-line summaries'/);
  assert.match(page, /disabled: !h\.share/);
  assert.match(page, /Applies to every team on/);
}));

test('the default team hub comes from the app’s brand module and prefills the hub field until another hub is used', async () => harness(async (h) => {
  const BRAND = require('../buddy-window/brand');
  assert.equal(BRAND.DEFAULT_HUB, 'https://app.plexiform.dev');
  await h.A.go('hub');
  let s = await h.A.state();
  assert.equal(s.lastHub, new URL(BRAND.DEFAULT_HUB).host);
  assert.equal(s.brand.defaultHost, new URL(BRAND.DEFAULT_HUB).host);
  await h.signInAs('me@example.com');
  await h.A.go('hub');
  s = await h.A.state();
  assert.equal(s.lastHub, h.origin, 'the hub last used wins');
  const { execFileSync } = require('node:child_process');
  // git grep exits 1 when nothing matches: that is the answer we want.
  const grep = (args) => { try { return execFileSync('git', args, { cwd: path.join(__dirname, '..'), encoding: 'utf8' }); } catch (e) { if (e.status === 1) return ''; throw e; } };
  const hits = grep(['grep', '-l', '-e', 'plexiform\\.dev', '-e', 'bondly\\.co\\.za', '--', 'buddy-window', 'main.js']).trim().split('\n').filter(Boolean);
  assert.deepEqual(hits, [], 'the URL comes from the app’s brand module, not a literal in the window');
  const Root = require('../brand');
  assert.equal(BRAND.DEFAULT_HUB, Root.urls.hub);
  assert.deepEqual([BRAND.NAME, BRAND.SCHEME, [...BRAND.LEGACY_SCHEMES]], [Root.name, Root.scheme, [...Root.legacySchemes]]);
}));

test('oauth: the listener refuses every callback until the hub’s state is known, then only that state', async () => {
  const l = await listenOnce({ brand: 'Plexiform', timeoutMs: 5000 });
  try {
    const hit = (qs) => fetch(`http://127.0.0.1:${l.port}/callback?${qs}`);
    assert.equal((await hit('code=abc&state=anything')).status, 400, 'no state known yet');
    l.expect('');
    assert.equal((await hit('code=abc')).status, 400, 'an empty state is no state');
    assert.equal((await hit('code=abc&state=')).status, 400, 'an empty state is no state');
    l.expect('short-state');
    assert.equal((await hit('code=abc&state=short-state')).status, 400, 'under 16 characters is refused');
    l.expect('hub-minted-state-0123456789');
    assert.equal((await hit('code=abc&state=anything')).status, 400, 'wrong state');
    assert.equal((await hit('code=abc')).status, 400, 'no state');
    assert.equal((await hit('code=abcDEF123&state=hub-minted-state-0123456789')).status, 200);
    assert.deepEqual(await l.result, { ok: true, code: 'abcDEF123' });
  } finally { l.close(); }
});

// A draft opened in the inviter's own mail app: nothing the team name or the invite carries may add a
// header (cc/bcc/to, a second subject) or a line break to the mailto: URL itself.
test('mailto: a team name with newlines, %0d%0a and &cc= adds no header and no raw break', () => {
  const { inviteMailto } = require('../buddy-window/accounts');
  const nasty = ['Acme\r\nBcc: attacker@evil.example', 'Acme%0d%0aBcc:%20attacker@evil.example', 'Acme&cc=attacker@evil.example&bcc=x@y.z', 'Acme?subject=pwned', 'Acme\u2028Cc: a@b.c', 'Acme\u0000\u0007\u007f'];
  for (const team of nasty) {
    const url = inviteMailto({ to: 'sam@example.com', team, link: 'https://app.plexiform.dev/invite#tok_abc', code: 'ABCD-EFGH', brand: 'Plexiform' });
    assert.ok(url.startsWith('mailto:sam@example.com?subject='), url);
    const q = url.slice('mailto:sam@example.com?'.length);
    // Exactly the two fields we built, in this order, and nothing else can open a new one.
    assert.deepEqual([...new URLSearchParams(q).keys()], ['subject', 'body'], `only subject and body for ${JSON.stringify(team)}`);
    assert.ok(!/[\r\n\u2028\u2029\u0000-\u001f\u007f]/.test(decodeURIComponent(q.split('&body=')[0].slice('subject='.length))), 'no control character in the subject');
    // The body's own lines are ours; the team name must not add a single line break to it or to the subject.
    const base = inviteMailto({ to: 'sam@example.com', team: 'Acme', link: 'https://app.plexiform.dev/invite#tok_abc', code: 'ABCD-EFGH', brand: 'Plexiform' });
    const breaks = (u) => (u.match(/%0[da]/gi) ?? []).length;
    assert.equal(breaks(url), breaks(base), `no extra line break for ${JSON.stringify(team)}`);
    assert.ok(!/%0[da]/i.test(url.split('&body=')[0]), 'no break at all in the subject');
    assert.ok(!/[\r\n\s]/.test(url), 'no raw whitespace in the URL');
  }
  // The address itself is validated: a header smuggled into `to` yields no draft at all.
  for (const to of ['a@b.co\r\nBcc: x@y.z', 'a@b.co,c@d.ef', 'a@b.co?cc=x@y.z', 'a@b.co&bcc=x@y.z', '<a@b.co>', 'a b@c.de']) {
    assert.equal(inviteMailto({ to, team: 'T', link: 'https://h/invite#t', code: 'ABCD-EFGH', brand: 'Plexiform' }), null, JSON.stringify(to));
  }
  // A long body is cut, never left half-encoded.
  const long = inviteMailto({ to: 'sam@example.com', team: 'T', link: 'https://h/invite#' + 'x'.repeat(5000), code: 'ABCD-EFGH', brand: 'Plexiform' });
  assert.doesNotThrow(() => decodeURIComponent(long.slice(long.indexOf('&body=') + 6)));
});

// ── deleting an account on a hub with no mailer: the Google/GitHub check ──

// Signed in with a provider on a hub that can't send email: the account's only way to prove itself.
async function providerAccount(h, { email = 'callum@example.com', provider = 'google' } = {}) {
  h.hub.setMethods({ google: true, github: true, email: false });
  h.hub.setOAuthIdentity(provider, { email });
  await h.A.hub(h.origin);
  await h.A.oauth(provider);
  const r = await h.flow.pendingOAuth();
  assert.equal(r.ok, true, r.error);
}

const deleteCalls = (h) => h.bodies.filter((b) => { try { const j = JSON.parse(b); return Object.keys(j).join() === 'flow_id'; } catch { return false; } });
const exchangeBodies = (h) => h.bodies.filter((b) => b.includes('code_verifier')).map((b) => JSON.parse(b));

test('delete via provider (email:false): choose, browser, confirmed with a countdown, delete; signed out and cleared as the email path; no token ever', async () => harness(async (h) => {
  await providerAccount(h);
  const { ws, child } = await runnerOn(h);
  const before = h.vault(h.origin).load();
  const live = h.hub.liveTokens();
  await h.A.go('account');
  assert.deepEqual(await h.A.deleteStart(h.host), { ok: true, via: 'provider' });
  assert.ok(!h.requests.some((u) => u.pathname === '/api/auth/email/start'), 'no emailed code on a hub without a mailer');
  let s = await h.A.state();
  assert.equal(s.deleting, h.host);
  assert.deepEqual(s.deleteCheck, { providers: [{ id: 'google', name: 'Google' }], phase: 'choose' }, 'only the provider the account signs in with');
  assert.equal((await h.A.deleteOAuth('google')).ok, true);
  const r = await h.flow.pendingDeleteCheck();
  assert.deepEqual(Object.keys(r).sort(), ['flowId', 'ok', 'stepupUntil']);
  const start = h.hub.oauthStarts().at(-1);
  assert.deepEqual(Object.keys(start).sort(), ['client', 'code_challenge', 'provider', 'purpose', 'redirect_uri']);
  assert.deepEqual([start.provider, start.client, start.purpose], ['google', 'buddy_desktop', 'delete']);
  assert.match(start.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(start.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const ex = exchangeBodies(h).at(-1);
  assert.equal(ex.flow_id, r.flowId);
  assert.equal(crypto.createHash('sha256').update(ex.code_verifier).digest('base64url'), start.code_challenge);
  assert.deepEqual(h.vault(h.origin).load(), before, 'the vault is exactly as it was');
  assert.equal(h.hub.liveTokens(), live, 'no new token on the hub either');
  assert.equal(h.flow.acct.screen, 'account');
  s = await h.A.state();
  assert.equal(s.notice, 'Confirmed with Google.');
  assert.equal(s.deleteCheck.phase, 'confirmed');
  assert.equal(s.deleteCheck.provider, 'Google');
  assert.ok(s.deleteCheck.secondsLeft > 290 && s.deleteCheck.secondsLeft <= 300, String(s.deleteCheck.secondsLeft));
  assert.equal((await h.A.deleteConfirm('')).ok, true);
  assert.deepEqual(deleteCalls(h).map((b) => JSON.parse(b).flow_id), [r.flowId], 'DELETE /api/account spends the check’s own flow_id');
  assert.equal(child.killed, 1);
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assertHubCleared(h, h.origin);
  assert.equal(h.vault(h.origin).load(), null);
  assert.deepEqual(h.store.list().filter((w) => w.kind === 'team'), []);
  s = await h.A.state();
  assert.equal(s.accounts.length, 0);
  assert.equal(s.notice, 'Your account was deleted.');
  const logged = h.logs.join('\n');
  for (const secret of [ex.code, ex.code_verifier, ex.state, before.token]) assert.ok(!logged.includes(secret), 'never logged');
}));

test('delete via provider: the confirmation runs out after 5 minutes (injected clock) and a fresh check is needed; the hub’s own expiry resets it too', async () => harness(async (h) => {
  await providerAccount(h);
  await h.A.go('account');
  await h.A.deleteStart(h.host);
  await h.A.deleteOAuth('google');
  assert.equal((await h.flow.pendingDeleteCheck()).ok, true);
  assert.equal((await h.A.state()).deleteCheck.phase, 'confirmed');
  h.setNow(Date.now() + 5 * 60_000 + 1000);
  const s = await h.A.state();
  assert.equal(s.deleteCheck.phase, 'choose');
  assert.equal(s.notice, 'That check ran out. Confirm it’s you again.');
  const r = await h.A.deleteConfirm('');
  assert.deepEqual([r.ok, r.stepUp], [false, true]);
  assert.equal(deleteCalls(h).length, 0, 'nothing sent with a lapsed check');
  h.setNow(null);
  // A fresh check works; if the hub's own window has closed meanwhile, its STEP_UP_REQUIRED sends us back to the start.
  await h.A.deleteOAuth('google');
  assert.equal((await h.flow.pendingDeleteCheck()).ok, true);
  h.hub.setNow(Date.now() + 6 * 60_000);
  const late = await h.A.deleteConfirm('');
  assert.equal(late.error, 'That check timed out. Confirm it’s you again.');
  assert.equal(late.stepUp, true);
  assert.equal((await h.A.state()).deleteCheck.phase, 'choose');
  assert.ok(h.vault(h.origin).load(), 'still signed in: nothing was deleted');
}));

test('delete via provider: Cancel (waiting on the browser, or with the exchange in flight) leaves the vault, the hub’s tokens and the workspaces unchanged', async () => harness(async (h) => {
  await providerAccount(h);
  await h.A.createTeam('Bondly');
  await h.A.go('account');
  await h.A.deleteStart(h.host);
  const signIns = exchangeBodies(h).length;
  const vault = JSON.stringify(h.vault(h.origin).load());
  const list = JSON.stringify(h.store.list());
  const live = h.hub.liveTokens();
  const same = () => {
    assert.equal(JSON.stringify(h.vault(h.origin).load()), vault);
    assert.equal(JSON.stringify(h.store.list()), list);
    assert.equal(h.hub.liveTokens(), live);
  };
  h.setBrowser(async () => {});
  await h.A.deleteOAuth('google');
  await until(() => h.hub.oauthStarts().some((b) => b.purpose === 'delete'));
  assert.equal((await h.A.state()).deleteCheck.phase, 'browser');
  const waiting = h.flow.pendingDeleteCheck();
  assert.equal((await h.A.cancelDeleteOAuth()).ok, true);
  assert.deepEqual(await waiting, { ok: false, cancelled: true });
  await assert.rejects(fetch(h.hub.oauthStarts().at(-1).redirect_uri), 'the listener closed');
  assert.equal((await h.A.state()).deleteCheck.phase, 'choose');
  assert.equal(exchangeBodies(h).length, signIns);
  same();
  // Now cancel after the hub has answered the exchange: the confirmation it gave is dropped.
  h.setBrowser(realBrowser);
  h.setAfterHub(async (u) => { if (u.includes('/oauth/exchange')) await h.A.cancelDeleteOAuth(); });
  await h.A.deleteOAuth('google');
  assert.deepEqual(await h.flow.pendingDeleteCheck(), { ok: false, cancelled: true });
  h.setAfterHub(null);
  assert.equal(exchangeBodies(h).length, signIns + 1, 'the hub did answer');
  assert.equal((await h.A.state()).deleteCheck.phase, 'choose');
  assert.equal((await h.A.deleteConfirm('')).stepUp, true);
  assert.equal(deleteCalls(h).length, 0);
  same();
  // Cancel on the whole delete drops it too.
  assert.equal((await h.A.cancelDelete()).ok, true);
  assert.equal((await h.A.state()).deleteCheck, null);
  same();
}));

test('delete via provider: a check replaced by a newer one while its exchange is in flight can’t confirm the delete', async () => harness(async (h) => {
  await providerAccount(h);
  await h.A.go('account');
  await h.A.deleteStart(h.host);
  const vault = JSON.stringify(h.vault(h.origin).load());
  h.setAfterHub(async (u) => {
    if (!u.includes('/oauth/exchange')) return;
    h.setAfterHub(null);
    h.setBrowser(async () => {});
    await h.A.deleteOAuth('google');
  });
  await h.A.deleteOAuth('google');
  const first = h.flow.pendingDeleteCheck();
  assert.deepEqual(await first, { ok: false, cancelled: true });
  assert.equal((await h.A.state()).deleteCheck.phase, 'browser', 'the newer check still waits on the browser');
  const r = await h.A.deleteConfirm('');
  assert.deepEqual([r.ok, r.error], [false, 'Confirm it’s you first.']);
  assert.equal(deleteCalls(h).length, 0, 'the replaced check’s flow_id is never sent');
  assert.equal(JSON.stringify(h.vault(h.origin).load()), vault);
  const second = h.flow.pendingDeleteCheck();
  await h.A.cancelDeleteOAuth();
  assert.equal((await second).cancelled, true);
}));

test('delete via provider: another account at the provider is refused (WRONG_ACCOUNT) in plain words; unlisted providers aren’t offered', async () => harness(async (h) => {
  await providerAccount(h);
  await h.A.go('account');
  await h.A.deleteStart(h.host);
  assert.equal((await h.A.deleteOAuth('github')).error, 'Pick Google or GitHub.', 'GitHub isn’t linked, so it isn’t offered');
  const vault = JSON.stringify(h.vault(h.origin).load());
  h.hub.setOAuthIdentity('google', { email: 'someone-else@example.com' });
  await h.A.deleteOAuth('google');
  const r = await h.flow.pendingDeleteCheck();
  assert.equal(r.code, 'WRONG_ACCOUNT');
  assert.equal(r.error, 'That isn’t the Google account you sign in with. Use that one.');
  const s = await h.A.state();
  assert.equal(s.alert, r.error);
  assert.equal(s.deleteCheck.phase, 'choose');
  assert.equal((await h.A.deleteConfirm('')).stepUp, true);
  assert.equal(deleteCalls(h).length, 0);
  assert.equal(JSON.stringify(h.vault(h.origin).load()), vault);
  // The hub checks the provider too: a GitHub identity with the same address but never linked is refused.
  const c = createAccountClient({ origin: h.origin, store: h.vault(h.origin) });
  h.hub.setOAuthIdentity('github', { email: 'callum@example.com' });
  const p = pkcePair();
  const st = await c.startOAuth('github', { challenge: p.challenge, redirectUri: 'http://127.0.0.1:9/callback' }, {}, { purpose: 'delete' });
  const code = new URL((await fetch(st.url, { redirect: 'manual' })).headers.get('location')).searchParams.get('code');
  const x = await c.exchangeOAuth({ flowId: st.flow_id, code, state: st.state, verifier: p.verifier, provider: 'github', purpose: 'delete' });
  assert.deepEqual([x.code, x.error], ['WRONG_ACCOUNT', 'That isn’t the GitHub account you sign in with. Use that one.']);
  // An account the hub lists no identities for is offered every provider the hub has.
  const { oauthOutcome } = require('../buddy-window/accounts');
  assert.equal(oauthOutcome({ ok: false, code: 'STEP_UP_REQUIRED' }, 'google', 'h').error, 'That check timed out. Confirm it’s you again.');
}));

test('delete via provider: an account that lists no linked sign-in is offered both providers; a hub with none says so', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  h.hub.setMethods({ google: true, github: true, email: false });
  await h.A.go('account');
  await h.A.deleteStart(h.host);
  assert.deepEqual((await h.A.state()).deleteCheck.providers.map((p) => p.id), ['google', 'github']);
  h.hub.setMethods({ email: false });
  const r = await h.A.deleteStart(h.host);
  assert.equal(r.ok, false);
  assert.match(r.error, /can’t check it’s you/);
  assert.equal((await h.A.state()).deleteCheck, null);
}));

test('delete via provider: single use: the exchange can’t be replayed and a spent flow_id can’t delete again', async () => harness(async (h) => {
  await providerAccount(h);
  const c = createAccountClient({ origin: h.origin, store: h.vault(h.origin) });
  const p = pkcePair();
  const st = await c.startOAuth('google', { challenge: p.challenge, redirectUri: 'http://127.0.0.1:9/callback' }, {}, { purpose: 'delete' });
  assert.ok(st.state.length >= 16);
  const code = new URL((await fetch(st.url, { redirect: 'manual' })).headers.get('location')).searchParams.get('code');
  const args = { flowId: st.flow_id, code, state: st.state, verifier: p.verifier, provider: 'google', purpose: 'delete' };
  assert.equal((await c.exchangeOAuth(args)).ok, true);
  assert.equal((await c.exchangeOAuth(args)).error, 'That sign-in didn’t work. Try again.', 'replay');
  // A sign-in flow is not a delete check.
  const q = pkcePair();
  const si = await c.startOAuth('google', { challenge: q.challenge, redirectUri: 'http://127.0.0.1:9/callback' });
  assert.equal((await c.deleteAccountWith(si.flow_id)).stepUp, true);
  assert.equal((await c.deleteAccountWith(st.flow_id)).ok, true);
  // Signed in again (a new, empty account): the spent flow_id is dead.
  await providerAccount(h);
  const res = await fetch(`${h.origin}/api/account`, { method: 'DELETE', headers: { Authorization: `Bearer ${h.vault(h.origin).load().token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ flow_id: st.flow_id }) });
  assert.equal(res.status, 401);
  assert.deepEqual((await res.json()).error, { code: 'STEP_UP_REQUIRED', message: 'confirm it is you first', max_age_s: 300, purpose: 'delete' });
  // Without the Bearer the hub won't even start a check.
  const anon = createAccountClient({ origin: h.origin, store: { load: () => null, save() {}, clear() {} } });
  assert.equal((await anon.startOAuth('google', { challenge: q.challenge, redirectUri: 'http://127.0.0.1:9/callback' }, {}, { purpose: 'delete' })).signedOut, true);
}));

test('delete with email:true is the emailed code as before: no provider check, no oauth start', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.go('account');
  const r = await h.A.deleteStart(h.host);
  assert.deepEqual(r, { ok: true, email: 'me@example.com' });
  assert.deepEqual(h.hub.starts().at(-1), { purpose: 'delete', client: 'buddy_desktop' });
  const s = await h.A.state();
  assert.equal(s.deleting, h.host);
  assert.equal(s.deleteCheck, null);
  assert.equal((await h.A.deleteOAuth('google')).ok, false, 'no provider check on the email path');
  assert.deepEqual(h.hub.oauthStarts(), []);
  assert.equal((await h.A.deleteConfirm(h.hub.lastCode('me@example.com'))).ok, true);
  assert.equal(h.vault(h.origin).load(), null);
}));

test('team deletion with email:false: a plain sentence, no button, no request; with email:true the slug form as before', async () => harness(async (h) => {
  await providerAccount(h);
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  let s = await h.A.state();
  const msg = `Deleting a team needs a code sent by email, and ${h.host} can’t send email. Ask whoever runs ${h.host} to delete it.`;
  assert.equal(s.team.deleteNeedsEmail, msg);
  assert.equal((await h.A.deleteTeam(ws.id, s.team.slug)).error, msg);
  assert.ok(!h.requests.some((u) => u.pathname === `/api/teams/${ws.teamId}` && h.bodies.some((b) => b.includes('confirm_slug'))), 'no delete sent');
  assert.ok(!h.hub.oauthStarts().some((b) => b.purpose === 'delete'), 'no provider path for teams');
  assert.ok(h.store.list().some((w) => w.id === ws.id));
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.match(page, /s\.isOwner && s\.team\.deleteNeedsEmail\) \{\n\s+out\.push\(el\('section', \{ class: 'acct-section' \}, el\('h2', \{\}, 'Delete team'\), el\('p', \{ class: 'acct-hint' \}, s\.team\.deleteNeedsEmail\)\)\);\n\s+\} else if/, 'text only, and no delete form in that branch');
  h.hub.setMethods({ google: true, github: true, email: true });
  s = await h.A.state();
  assert.equal(s.team.deleteNeedsEmail, null);
}));

test('a step-up exchange never stores a token, even when a hub sends one; its expiry is capped at 5 minutes', async () => {
  const mine = `bdt_${crypto.randomBytes(32).toString('base64url')}`;
  const leaked = `bdt_${crypto.randomBytes(32).toString('base64url')}`;
  let v = { hub: 'https://hub.example.com', token: mine, device_id: 'd1', user: { email: 'me@example.com' } };
  let saves = 0;
  let clears = 0;
  const store = { load: () => v, save: (x) => { saves += 1; v = x; }, clear: () => { clears += 1; v = null; } };
  const seen = [];
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  const fetchImpl = async (u, init) => {
    seen.push({ u, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ stepup_until: new Date(t0 + 3600_000).toISOString(), device_token: leaked, device_id: 'd2', user: { email: 'x@example.com' } }), { status: 200 });
  };
  const c = createAccountClient({ origin: 'https://hub.example.com', store, fetchImpl, now: () => t0 });
  const r = await c.exchangeOAuth({ flowId: 'f1', code: 'c', state: 's'.repeat(43), verifier: 'v', provider: 'google', purpose: 'delete' }, { deviceName: 'Mac' });
  assert.deepEqual(r, { ok: true, flowId: 'f1', stepupUntil: t0 + 5 * 60_000 });
  assert.deepEqual([saves, clears, v.token], [0, 0, mine]);
  assert.equal(seen[0].auth, `Bearer ${mine}`);
  assert.deepEqual(Object.keys(seen[0].body).sort(), ['code', 'code_verifier', 'flow_id', 'state'], 'no device named: no token comes of it');
  const x = await c.exchangeOAuth({ flowId: 'f2', code: 'c', state: 's'.repeat(43), verifier: 'v', provider: 'google', purpose: 'delete' }, {}, { keep: () => false });
  assert.deepEqual(x, { ok: false, cancelled: true });
  assert.deepEqual([saves, clears, v.token], [0, 0, mine]);
  assert.equal(seen.filter((q) => q.u.endsWith('/api/auth/signout')).length, 0, 'nothing to revoke: it was never ours');
  assert.ok(!JSON.stringify(r).includes(leaked));
});

test('the delete check’s page: plain text, keyboard buttons, status announced, a countdown that isn’t read out every second', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.ok(!/\.innerHTML|insertAdjacentHTML|outerHTML/.test(page));
  for (const t of ['`Confirm it’s you with ${p.name}`', 'Waiting for your browser…', "'Delete my account'", 'confirm it’s you first']) assert.ok(page.includes(t), t);
  assert.match(page, /'aria-live': 'off' \}, 'Delete within '/);
  assert.match(page, /role: 'status' \}, `Confirmed with \$\{c\.provider\}/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account-preload.js'), 'utf8');
  assert.match(preload, /deleteOAuth: \(provider\) => call\('deleteOAuth', str\(provider\)\)/);
  assert.match(preload, /cancelDeleteOAuth: \(\) => call\('cancelDeleteOAuth'\)/);
  assert.deepEqual([ACCT_ARGS.deleteOAuth, ACCT_ARGS.cancelDeleteOAuth], [['string'], []]);
});
