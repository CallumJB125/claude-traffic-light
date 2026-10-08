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
  postMessage(m) { this.sent.push(m); if (m.type === 'runner.config') this.onConfig?.(m); }
  kill() { this.killed += 1; this.ws?.terminate(); setImmediate(() => this.emit('exit', 0)); return true; }
}

// What app-entry does with runner.config (D37a/D81), as far as the app can see: one /ws/runner socket
// with the two headers, `connected` on welcome, and the runner's words for a 4401/4403 close.
function liveRunner(c, m) {
  c.ws = new WebSocket(`${m.hub_url.replace(/^http/, 'ws')}/ws/runner`, { headers: { Authorization: `Bearer ${m.runner_token}`, 'Board-Team': m.team_id } });
  c.ws.on('message', (d) => { const f = JSON.parse(d); if (f.type === 'welcome') { c.welcome = f; c.emit('message', { type: 'runner.status', state: 'connected' }); } });
  c.ws.on('close', (code) => { const state = { 4401: 'unauthenticated', 4403: 'revoked' }[code]; if (state) c.emit('message', { type: 'runner.status', state, detail: `closed ${code}` }); });
  c.emit('message', { type: 'runner.ready' });
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

async function harness(fn, { oauthTimeoutMs, live = false, quotas } = {}) {
  const hub = createMockAccountsHub({ quotas });
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
  let probeImpl = null; // a test's /api/health probe, in place of "the mock hub answers itself"
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
    probe: async (o) => (probeImpl ? probeImpl(o) : o === origin ? { ok: true, auth: 'accounts' } : { ok: false, error: 'unreachable' }),
    makeDevice: (ws, { onStatus }) => createDeviceController({
      account: clientFor(ws.hub), teamId: ws.teamId, credsFile: deviceFile(ws),
      seal: (s) => Buffer.from(`SEALED:${Buffer.from(s).toString('base64')}`), unseal: (b) => Buffer.from(String(b).slice(7), 'base64').toString(),
      fork: (entry, args, opts) => { const c = new FakeChild(); c.args = args; c.opts = opts; if (live) c.onConfig = (m) => liveRunner(c, m); children.push(c); return c; }, runnerEntry: 'x', entryExists: () => true,
      dataDir: path.join(dir, 'runner', ws.teamId), onStatus, schedule: () => {}, stopGraceMs: 500,
    }),
    hasDeviceFile: (ws) => fs.existsSync(deviceFile(ws)),
    discardDeviceFiles: (o, { keep = [] } = {}) => { for (const n of fs.readdirSync(devDir)) if (n.startsWith(`${hubKey(o)}-`) && !keep.some((t) => n === `${hubKey(o)}-${t}.bin`)) fs.rmSync(path.join(devDir, n)); },
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
    c.testToken = () => v?.token ?? null;
    return c;
  };
  const h = { hub, origin, dir, devDir, store, flow, A, requests, shown, selects, sessions, signedOutHubs, children, deviceFile, signInAs, other, vault, mails, bodies, logs, opened, setBrowser: (b) => { browser = b; }, setAfterHub: (f) => { afterHub = f; }, setProbe: (f) => { probeImpl = f; }, setNow: (ms) => { skew = ms; }, host: hostOf(origin) };
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

test('invite: a replayed request says the invite was already made and leaves it under Pending invites with Resend; no generic error, no silent retry', async () => harness(async (h) => {
  await h.signInAs('owner@example.com');
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  const nodeCrypto = require('node:crypto');
  const realUUID = nodeCrypto.randomUUID;
  // A retry of the same request (one request_id twice) is what the hub's replay cache answers.
  nodeCrypto.randomUUID = () => '00000000-0000-4000-8000-0000000000aa';
  let first;
  let again;
  const posts = () => h.requests.filter((u) => /\/invites$/.test(u.pathname)).length;
  let before;
  try {
    first = await h.A.invite(ws.id, 'sam@example.com', 'member');
    before = posts();
    again = await h.A.invite(ws.id, 'sam@example.com', 'member');
  } finally {
    nodeCrypto.randomUUID = realUUID;
  }
  assert.equal(first.ok, true);
  assert.deepEqual(again, { ok: true, replayed: true, notice: 'This invite was already made. Resend it to get a new link.' });
  assert.equal(posts(), before + 1, 'asked once, never retried');
  const s = await h.A.state();
  assert.deepEqual(s.invites.map((i) => i.email), ['sam@example.com'], 'listed with its Resend button');
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.match(page, /onclick: \(\) => act\(api\.resendInvite\(team, i\.id\)\) \}, 'Resend'/);
}));

test('wording: the desktop says a code was asked for, never that it was sent (the hub cannot know it arrived)', () => {
  for (const f of ['account.js', 'account-flow.js', 'accounts.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', f), 'utf8');
    assert.ok(!/[Ww]e sent|code we sent/.test(src), f);
  }
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.match(page, /'We’ve asked for a code to be sent to ', el\('strong', \{\}, s\.email \?\? 'your email'\)/);
  assert.match(page, /`We’ve asked for a code to be sent to \$\{a\.email\}\. Enter it to delete your account/);
  assert.match(page, /`We’ve asked for a code to be sent to \$\{d\.email \?\? 'your email'\}\. Enter it to confirm/);
});

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
  assert.equal(fs.existsSync(h.deviceFile(ws)), false, 'the dead token goes at once');
  await until(() => h.flow.acct.screen === 'email');
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
  assert.equal(r.error, 'This invite was sent to a different email address. Switch account?');
  assert.equal((await h.A.switchAccount()).ok, true);
  assert.equal(child.killed, 1);
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assertHubCleared(h, h.origin);
  assert.equal(h.flow.acct.screen, 'email');
  assert.equal((await h.A.email('callum@example.com')).ok, true);
  await h.A.code(h.hub.lastCode('callum@example.com'));
  assert.equal(h.store.active().teamId, team.id, 'the invite resumes for the right account');
  assert.equal(h.store.list().filter((w) => w.kind === 'team').length, 1, 'no personal team for the invited account');
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
  assert.equal(say(403, { code: 'WRONG_ACCOUNT' }), 'This invite was sent to a different email address.');
  assert.equal(say(403, { code: 'WRONG_ACCOUNT', email_masked: 'c…@example.com' }), 'This invite was sent to a different email address.', 'no address, even if a hub sends one');
  assert.equal(say(409, { code: 'CONFLICT', reason: 'REPLAYED' }), 'This invite was already made. Resend it to get a new link.');
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
  assert.equal((await h.A.teamDeleteStart(ws.id, 'Bondly')).error, 'That doesn’t match the team’s name. Type it exactly as shown.');
  assert.equal((await h.A.teamDeleteStart(ws.id, 'bondly-team')).ok, true);
  assert.equal((await h.A.teamDeleteCode(ws.id, h.hub.lastCode('me@example.com'))).ok, true);
  assert.equal((await h.A.deleteTeam(ws.id)).ok, true);
  assert.equal(h.flow.acct.screen, 'account');
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
  assert.equal(h.store.active().name, "callum's team");
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
  await until(() => h.store.active()?.kind === 'team');
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

test('oauth: a delete check’s tab says it is confirming, never signing in', () => {
  const page = (confirming, url) => {
    const handler = callbackHandler({ port: 4242, state: 'st', brand: 'Plexiform', finish() {}, confirming });
    const res = { body: null, writeHead() {}, end(b) { this.body = b; } };
    handler({ method: 'GET', url, headers: { host: '127.0.0.1:4242' }, socket: { remoteAddress: '127.0.0.1' } }, res);
    return res.body;
  };
  assert.equal(page(true, '/callback?code=abc&state=st'), 'Finish confirming in Plexiform. You can close this tab.');
  assert.equal(page(true, '/callback?error=access_denied&state=st'), 'Confirming was cancelled. You can close this tab and go back to Plexiform.');
  assert.equal(page(true, '/callback?state=zz&code=abc'), 'This confirmation link isn’t valid. Go back to Plexiform and try again.');
  assert.equal(page(false, '/callback?code=abc&state=st'), 'Finish signing in in Plexiform. You can close this tab.');
});

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

test('oauth: an explicit invite waits through Continue with Google, then joins directly', async () => harness(async (h) => {
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
  assert.equal(h.store.active().name, 'Pistor');
  assert.equal(h.store.list().filter((w) => w.kind === 'team').length, 1);
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
  for (const t of ['Continue with Google', 'Continue with GitHub', 'Use an email code instead', 'Google and GitHub sign-in aren’t set up at this address yet. Ask your team’s admin.', 'Try again']) assert.ok(page.includes(t), t);
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

test('delete via provider: another account at the provider is refused (a generic INVALID_TOKEN) in plain words; unlisted providers aren’t offered', async () => harness(async (h) => {
  await providerAccount(h);
  await h.A.go('account');
  await h.A.deleteStart(h.host);
  assert.equal((await h.A.deleteOAuth('github')).error, 'Pick Google or GitHub.', 'GitHub isn’t linked, so it isn’t offered');
  const vault = JSON.stringify(h.vault(h.origin).load());
  h.hub.setOAuthIdentity('google', { email: 'someone-else@example.com' });
  await h.A.deleteOAuth('google');
  const r = await h.flow.pendingDeleteCheck();
  assert.equal(r.code, 'INVALID_TOKEN');
  assert.equal(r.error, 'That didn’t confirm it’s you. Use the Google account you sign in with, and try again.');
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
  assert.deepEqual([x.status, x.code, x.error], [400, 'INVALID_TOKEN', 'That didn’t confirm it’s you. Use the GitHub account you sign in with, and try again.']);
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
  assert.equal((await c.exchangeOAuth(args)).code, 'INVALID_TOKEN', 'replay');
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

// ── deleting a team: typed slug, then a step-up bound to that team ─────────

const teamDeletes = (h) => h.bodies.map((b) => { try { return JSON.parse(b); } catch { return null; } }).filter((j) => j && 'confirm_slug' in j);
const hubCall = async (h, method, p, body, token = h.vault(h.origin).load().token) => {
  const res = await fetch(`${h.origin}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
};
// A verified emailed step-up of either purpose, straight against the hub.
const stepUp = async (h, purpose, email = 'me@example.com') => {
  const flowId = (await hubCall(h, 'POST', '/api/auth/email/start', { purpose })).body.flow_id;
  assert.equal((await hubCall(h, 'POST', '/api/auth/email/verify', { flow_id: flowId, code: h.hub.lastCode(email) })).status, 200);
  return flowId;
};
const confirmTeamByEmail = async (h, ws, slug) => {
  assert.equal((await h.A.teamDeleteStart(ws.id, slug)).ok, true);
  assert.equal((await h.A.teamDeleteCode(ws.id, h.hub.lastCode('me@example.com'))).ok, true);
  return JSON.parse(h.bodies.at(-1)).flow_id;
};

test('delete team (email): slug, code, a countdown, delete with that flow; only that team goes, the session and vault untouched', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const personal = h.store.active();
  await h.A.createTeam('Other');
  const other = h.store.active();
  await h.A.createTeam('Bondly Team');
  const ws = h.store.active();
  const before = JSON.stringify(h.vault(h.origin).load());
  const live = h.hub.liveTokens();
  let s = await h.A.state();
  assert.deepEqual([s.team.deleteVia, s.team.deleteStep], ['email', null]);
  assert.deepEqual(await h.A.teamDeleteStart(ws.id, 'bondly-team'), { ok: true, email: 'me@example.com' });
  assert.deepEqual(h.hub.starts().at(-1), { purpose: 'delete_team', client: 'buddy_desktop' }, 'no device named: no token comes of it');
  s = await h.A.state();
  assert.deepEqual(s.team.deleteStep, { via: 'email', email: 'me@example.com', phase: 'code' });
  assert.equal((await h.A.teamDeleteCode(ws.id, h.hub.lastCode('me@example.com'))).ok, true);
  const verify = JSON.parse(h.bodies.at(-1));
  assert.deepEqual(Object.keys(verify).sort(), ['code', 'flow_id']);
  s = await h.A.state();
  assert.equal(s.team.deleteStep.phase, 'confirmed');
  assert.ok(s.team.deleteStep.secondsLeft > 290 && s.team.deleteStep.secondsLeft <= 300, String(s.team.deleteStep.secondsLeft));
  assert.equal(teamDeletes(h).length, 0, 'nothing deleted before the button');
  assert.equal((await h.A.deleteTeam(ws.id)).ok, true);
  assert.deepEqual(teamDeletes(h), [{ confirm_slug: 'bondly-team', flow_id: verify.flow_id }]);
  assert.equal(h.flow.acct.screen, 'account');
  s = await h.A.state();
  assert.equal(s.notice, 'Bondly Team was deleted.');
  assert.equal(s.accounts.length, 1, 'still signed in');
  assert.deepEqual(h.store.list().filter((w) => w.kind === 'team').map((w) => w.id), [personal.id, other.id]);
  assert.equal(JSON.stringify(h.vault(h.origin).load()), before, 'the vault is exactly as it was');
  assert.equal(h.hub.liveTokens(), live);
}));

test('delete team: a wrong slug is refused before any code is sent or DELETE made; no check, no delete', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly Team');
  const ws = h.store.active();
  for (const typed of ['Bondly Team', 'bondly', 'BONDLY-TEAM', '']) assert.equal((await h.A.teamDeleteStart(ws.id, typed)).error, 'That doesn’t match the team’s name. Type it exactly as shown.', typed);
  assert.ok(!h.hub.starts().some((b) => b.purpose === 'delete_team'), 'no code sent');
  assert.equal((await h.A.state()).team.deleteStep, null);
  const r = await h.A.deleteTeam(ws.id);
  assert.deepEqual([r.ok, r.stepUp], [false, true]);
  assert.equal(teamDeletes(h).length, 0, 'the hub never saw a delete');
  assert.ok(h.store.list().some((w) => w.id === ws.id));
}));

test('delete team: a wrong code says so; a lapsed check (injected clock) starts over; the hub’s own lapse too', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  await h.A.teamDeleteStart(ws.id, 'bondly');
  const good = h.hub.lastCode('me@example.com');
  assert.equal((await h.A.teamDeleteCode(ws.id, good === '000000' ? '111111' : '000000')).error, 'That code didn’t work. 4 tries left.');
  assert.equal((await h.A.teamDeleteCode(ws.id, '12')).error, 'The code is 6 digits.');
  assert.equal((await h.A.state()).team.deleteStep.phase, 'code');
  assert.equal((await h.A.teamDeleteCode(ws.id, good)).ok, true);
  h.setNow(Date.now() + 5 * 60_000 + 1000);
  const r = await h.A.deleteTeam(ws.id);
  assert.deepEqual([r.ok, r.stepUp, r.error], [false, true, 'That check ran out. Type the name and confirm it’s you again.']);
  assert.equal((await h.A.state()).team.deleteStep, null, 'back to the start');
  assert.equal(teamDeletes(h).length, 0, 'nothing sent with a lapsed check');
  h.setNow(Date.now() + 5 * 60_000 + 1000);
  await confirmTeamByEmail(h, ws, 'bondly');
  h.setNow(Date.now() + 10 * 60_000 + 2000);
  const s = await h.A.state();
  assert.equal(s.team.deleteStep, null);
  assert.equal(s.notice, 'That check ran out. Type the name and confirm it’s you again.');
  h.setNow(null);
  // Fresh here, but the hub's 5 minutes have gone: its STEP_UP_REQUIRED starts over too.
  await confirmTeamByEmail(h, ws, 'bondly');
  h.hub.setNow(Date.now() + 6 * 60_000);
  const late = await h.A.deleteTeam(ws.id);
  assert.deepEqual([late.ok, late.stepUp, late.error], [false, true, 'That check timed out or was already used. Confirm it’s you again to delete the team.']);
  assert.equal((await h.A.state()).team.deleteStep, null);
  assert.ok(h.store.list().some((w) => w.id === ws.id), 'the team is still there');
}));

test('delete team: the account’s `delete` step-up can’t delete a team, a team’s can’t delete the account; each is single use', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Alpha');
  const a = h.store.active();
  await h.A.createTeam('Beta');
  const b = h.store.active();
  const acctFlow = await stepUp(h, 'delete');
  const refused = await hubCall(h, 'DELETE', `/api/teams/${b.teamId}`, { confirm_slug: 'beta', flow_id: acctFlow });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.max_age_s, refused.body.error.purpose], [401, 'STEP_UP_REQUIRED', 300, 'delete_team']);
  const teamFlow = await stepUp(h, 'delete_team');
  const noAcct = await hubCall(h, 'DELETE', '/api/account', { flow_id: teamFlow });
  assert.deepEqual([noAcct.status, noAcct.body.error.code, noAcct.body.error.purpose], [401, 'STEP_UP_REQUIRED', 'delete']);
  assert.equal((await hubCall(h, 'DELETE', `/api/teams/${b.teamId}`, { confirm_slug: 'wrong', flow_id: teamFlow })).status, 400, 'a wrong slug spends nothing');
  assert.equal((await hubCall(h, 'DELETE', `/api/teams/${b.teamId}`, { confirm_slug: 'beta', flow_id: teamFlow })).status, 200);
  const again = await hubCall(h, 'DELETE', `/api/teams/${a.teamId}`, { confirm_slug: 'alpha', flow_id: teamFlow });
  assert.deepEqual([again.status, again.body.error.code], [401, 'STEP_UP_REQUIRED'], 'spent');
  assert.ok(h.vault(h.origin).load(), 'still signed in');
  // Through the app: a spent flow can't be sent twice, and the account path never sees a team's code.
  h.store.setActive(a.id);
  await h.A.go('team');
  const f = await confirmTeamByEmail(h, a, 'alpha');
  await h.A.go('account');
  assert.equal((await h.A.deleteConfirm(h.hub.lastCode('me@example.com'))).error, 'Ask for a new code first.');
  assert.equal((await hubCall(h, 'DELETE', `/api/teams/${a.teamId}`, { confirm_slug: 'alpha', flow_id: f })).status, 200, 'the hub still holds it: leaving the screen only dropped it here');
  assert.ok(h.vault(h.origin).load());
}));

test('delete team: switching team, leaving the screen or the account pages, and signing out each drop the check', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Alpha');
  const a = h.store.active();
  await h.A.createTeam('Beta');
  const b = h.store.active();
  const refusedNow = async () => { const r = await h.A.deleteTeam(b.id); assert.deepEqual([r.ok, r.stepUp], [false, true], JSON.stringify(r)); };
  await confirmTeamByEmail(h, b, 'beta');
  h.store.setActive(a.id);
  assert.equal((await h.A.deleteTeam(b.id)).error, 'The team changed while this page was open. Look again, then try once more.');
  assert.equal((await h.A.state()).team.deleteStep, null, 'Alpha never shows Beta’s check');
  h.store.setActive(b.id);
  assert.equal((await h.A.state()).team.deleteStep, null, 'and it is gone for Beta too');
  await refusedNow();
  await confirmTeamByEmail(h, b, 'beta');
  h.flow.leftAccountPages();
  await refusedNow();
  await confirmTeamByEmail(h, b, 'beta');
  await h.A.go('thismac');
  await h.A.go('team');
  await refusedNow();
  await confirmTeamByEmail(h, b, 'beta');
  h.flow.startFlow('join');
  h.flow.show('team');
  await refusedNow();
  await confirmTeamByEmail(h, b, 'beta');
  await h.A.signOut(h.host);
  await h.signInAs('me@example.com');
  h.store.setActive(b.id);
  h.flow.show('team');
  assert.equal((await h.A.state()).team.deleteStep, null);
  await refusedNow();
  assert.equal(teamDeletes(h).length, 0);
  assert.equal(h.store.list().filter((w) => w.kind === 'team').length, 3);
}));

test('delete team: a failed DELETE (no longer an owner) keeps the check; once owner again the same check deletes it', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  const luke = await h.other('luke@example.com');
  const inv = await h.A.invite(ws.id, 'luke@example.com', 'admin');
  assert.equal((await luke.acceptInvite({ code: inv.invite.code })).ok, true);
  let s = await h.A.state();
  const lukeId = s.members.find((m) => m.email === 'luke@example.com').id;
  const meId = s.members.find((m) => m.you).id;
  assert.equal((await h.A.setRole(ws.id, lukeId, 'owner')).ok, true);
  const flowId = await confirmTeamByEmail(h, ws, 'bondly');
  const before = JSON.stringify(h.vault(h.origin).load());
  assert.equal((await luke.setRole(ws.teamId, meId, 'admin')).ok, true);
  const r = await h.A.deleteTeam(ws.id);
  assert.deepEqual([r.ok, r.error], [false, 'You don’t have permission to do that in this team.']);
  assert.equal(h.flow.acct.screen, 'team', 'kept on the screen');
  s = await h.A.state();
  assert.equal(s.team.deleteStep.phase, 'confirmed', 'not spent');
  assert.equal((await luke.setRole(ws.teamId, meId, 'owner')).ok, true);
  assert.equal((await h.A.deleteTeam(ws.id)).ok, true);
  assert.deepEqual(teamDeletes(h).map((b) => b.flow_id), [flowId, flowId]);
  assert.equal(JSON.stringify(h.vault(h.origin).load()), before);
}));

test('delete team (email:false): slug, a Google check for that team, DELETE with its flow_id; account and team checks aren’t interchangeable', async () => harness(async (h) => {
  await providerAccount(h);
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  const before = JSON.stringify(h.vault(h.origin).load());
  const live = h.hub.liveTokens();
  let s = await h.A.state();
  assert.deepEqual([s.team.deleteVia, s.team.deleteStep], ['provider', null]);
  assert.equal((await h.A.teamDeleteStart(ws.id, 'Bondly')).error, 'That doesn’t match the team’s name. Type it exactly as shown.');
  assert.deepEqual(await h.A.teamDeleteStart(ws.id, 'bondly'), { ok: true, via: 'provider' });
  assert.ok(!h.requests.some((u) => u.pathname === '/api/auth/email/start'), 'no emailed code on a hub without a mailer');
  assert.deepEqual((await h.A.state()).team.deleteStep, { via: 'provider', providers: [{ id: 'google', name: 'Google' }], phase: 'choose' });
  assert.equal((await h.A.teamDeleteOAuth(ws.id, 'github')).error, 'Pick Google or GitHub.');
  assert.equal((await h.A.teamDeleteOAuth(ws.id, 'google')).ok, true);
  let r = await h.flow.pendingDeleteCheck();
  assert.equal(r.ok, true, r.error);
  const teamStart = h.hub.oauthStarts().at(-1);
  assert.deepEqual([teamStart.purpose, teamStart.team_id], ['delete_team', ws.teamId], 'the team’s check names the team');
  assert.equal('device_name' in teamStart, false);
  s = await h.A.state();
  assert.equal(s.notice, 'Confirmed with Google.');
  assert.deepEqual([s.team.deleteStep.phase, s.team.deleteStep.provider], ['confirmed', 'Google']);
  // The team's check is not the account's: the account page neither shows nor spends it, and leaving drops it.
  await h.A.go('account');
  assert.equal((await h.A.state()).deleteCheck, null);
  assert.equal((await h.A.deleteConfirm('')).ok, false);
  await h.A.go('team');
  assert.equal((await h.A.deleteTeam(ws.id)).stepUp, true);
  // Nor is the account's check the team's.
  await h.A.go('account');
  assert.equal((await h.A.deleteStart(h.host)).via, 'provider');
  await h.A.deleteOAuth('google');
  assert.equal((await h.flow.pendingDeleteCheck()).ok, true);
  assert.equal((await h.A.state()).deleteCheck.phase, 'confirmed');
  await h.A.go('team');
  assert.equal((await h.A.state()).team.deleteStep, null);
  assert.equal((await h.A.deleteTeam(ws.id)).stepUp, true);
  assert.equal(teamDeletes(h).length, 0);
  assert.equal(deleteCalls(h).length, 0);
  // The real thing.
  await h.A.teamDeleteStart(ws.id, 'bondly');
  await h.A.teamDeleteOAuth(ws.id, 'google');
  r = await h.flow.pendingDeleteCheck();
  assert.equal((await h.A.deleteTeam(ws.id)).ok, true);
  assert.deepEqual(teamDeletes(h), [{ confirm_slug: 'bondly', flow_id: r.flowId }]);
  assert.equal(h.flow.acct.screen, 'account');
  assert.equal((await h.A.state()).notice, 'Bondly was deleted.');
  assert.equal(h.store.list().some((w) => w.id === ws.id), false);
  assert.equal(JSON.stringify(h.vault(h.origin).load()), before);
  assert.equal(h.hub.liveTokens(), live);
  const spent = await hubCall(h, 'DELETE', '/api/account', { flow_id: r.flowId });
  assert.deepEqual([spent.status, spent.body.error.code], [401, 'STEP_UP_REQUIRED'], 'single use across both routes');
}));

test('the hub spends a provider check only where it was made: a team’s on that team, an account’s never on a team', async () => harness(async (h) => {
  await providerAccount(h);
  await h.A.createTeam('Alpha');
  const a = h.store.active();
  await h.A.createTeam('Beta');
  const b = h.store.active();
  const { pkcePair } = require('../buddy-window/oauth');
  const c = createAccountClient({ origin: h.origin, store: h.vault(h.origin) });
  const check = async (opts) => {
    const p = pkcePair();
    const st = await c.startOAuth('google', { challenge: p.challenge, redirectUri: 'http://127.0.0.1:9/callback' }, {}, opts);
    assert.equal(st.ok, true, st.error);
    const loc = (await fetch(st.url, { redirect: 'manual' })).headers.get('location');
    const code = new URL(loc).searchParams.get('code');
    const x = await c.exchangeOAuth({ flowId: st.flow_id, code, state: st.state, verifier: p.verifier, provider: 'google', purpose: opts.purpose });
    assert.equal(x.ok, true, x.error);
    return st.flow_id;
  };
  assert.equal((await hubCall(h, 'POST', '/api/auth/oauth/start', { provider: 'google', purpose: 'delete_team', code_challenge: 'x'.repeat(43), redirect_uri: 'http://127.0.0.1:9/callback' })).status, 400, 'delete_team needs team_id');
  assert.match((await c.startOAuth('google', { challenge: 'x'.repeat(43), redirectUri: 'http://127.0.0.1:9/callback' }, {}, { purpose: 'delete_team' })).error, /valid team/);
  const del = (ws, flow) => hubCall(h, 'DELETE', `/api/teams/${ws.teamId}`, { confirm_slug: ws.name.toLowerCase(), flow_id: flow });
  const account = await check({ purpose: 'delete' });
  assert.equal((await del(a, account)).status, 401, 'an account check never deletes a team');
  const forA = await check({ purpose: 'delete_team', teamId: a.teamId });
  assert.equal((await del(b, forA)).status, 401, 'Alpha’s check never deletes Beta');
  assert.equal((await hubCall(h, 'DELETE', '/api/account', { flow_id: forA })).status, 401, 'a team’s check never deletes the account');
  assert.equal((await del(a, forA)).status, 200);
  assert.equal((await del(b, forA)).status, 401, 'spent');
}));

test('step-up codes count against the user, never lock the address out of sign-in; someone else’s flow is a plain INVALID_TOKEN', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  const luke = await h.other('luke@example.com');
  const mine = (await hubCall(h, 'POST', '/api/auth/email/start', { purpose: 'delete_team' })).body.flow_id;
  const lukeToken = luke.testToken();
  const theirs = await hubCall(h, 'POST', '/api/auth/email/verify', { flow_id: mine, code: h.hub.lastCode('me@example.com') }, lukeToken);
  assert.deepEqual([theirs.status, theirs.body.error.code], [400, 'INVALID_TOKEN']);
  let limited = null;
  for (let i = 0; i < 3 && !limited; i += 1) {
    const f = (await hubCall(h, 'POST', '/api/auth/email/start', { purpose: 'delete_team' })).body.flow_id;
    const good = h.hub.lastCode('me@example.com');
    for (let j = 0; j < 4; j += 1) {
      const r = await hubCall(h, 'POST', '/api/auth/email/verify', { flow_id: f, code: good === '000000' ? '111111' : '000000' });
      if (r.status === 429) { limited = r; break; }
    }
  }
  assert.equal(limited?.body.error.code, 'RATE_LIMITED', 'the user’s step-up tries ran out');
  let v = null;
  const c = createAccountClient({ origin: h.origin, store: { load: () => v, save: (x) => { v = x; }, clear: () => { v = null; } } });
  assert.equal((await c.startEmail('me@example.com')).ok, true);
  const signIn = await c.verifyCode(h.hub.lastCode('me@example.com'));
  assert.equal(signIn.ok, true, 'email sign-in for the same address still works');
}));

test('the team delete page: text only, the slug typed before any code, the same code input as the account’s, status announced, a quiet countdown', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.ok(!/\.innerHTML|insertAdjacentHTML|outerHTML/.test(page));
  const team = page.slice(page.indexOf('function teamDelete('), page.indexOf('function deleteCheck('));
  assert.ok(team.length > 0);
  assert.match(team, /if \(!d\) \{[\s\S]*Type \$\{s\.team\.slug\} to confirm[\s\S]*api\.teamDeleteStart\(team, v\.slug\)/, 'the slug first');
  assert.match(team, /'Send me a code'/);
  assert.match(team, /inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12', placeholder: '123456', class: 'input input-code', 'aria-label': '6-digit code'/);
  assert.match(team, /return deleteCheck\(d, \{[\s\S]*submit: 'Delete team'[\s\S]*api\.deleteTeam\(team\)[\s\S]*api\.teamDeleteOAuth\(team, id\)/, 'the confirmed step and the provider check are the account’s, with the team’s actions');
  assert.match(page, /'aria-live': 'off' \}, 'Delete within '/);
  assert.match(page, /role: 'status' \}, `Confirmed with \$\{c\.provider\}/);
  assert.ok(!/deleteNeedsEmail/.test(page), 'no dead end without a mailer');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account-preload.js'), 'utf8');
  assert.match(preload, /teamDeleteStart: \(team, slug\) => call\('teamDeleteStart', str\(team\), str\(slug\)\)/);
  assert.match(preload, /teamDeleteCode: \(team, code\) => call\('teamDeleteCode', str\(team\), str\(code\)\)/);
  assert.match(preload, /teamDeleteResend: \(team\) => call\('teamDeleteResend', str\(team\)\)/);
  assert.match(preload, /teamDeleteOAuth: \(team, provider\) => call\('teamDeleteOAuth', str\(team\), str\(provider\)\)/);
  assert.match(preload, /deleteTeam: \(team\) => call\('deleteTeam', str\(team\)\)/);
  assert.deepEqual([ACCT_ARGS.teamDeleteStart, ACCT_ARGS.teamDeleteCode, ACCT_ARGS.teamDeleteResend, ACCT_ARGS.teamDeleteOAuth, ACCT_ARGS.deleteTeam], [['string', 'string'], ['string', 'string'], ['string'], ['string', 'string'], ['string']]);
  const main = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  assert.match(main, /if \(page\.kind === 'local' && page\.screen\) \{ flow\.show\(page\.screen\); return; \}\n\s+flow\.leftAccountPages\(\);/, 'a board or another page drops a team’s check');
});

test('delete team: Send a new code replaces the flow; the old code no longer confirms', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  await h.A.teamDeleteStart(ws.id, 'bondly');
  const old = h.hub.lastCode('me@example.com');
  const re = await h.A.teamDeleteResend(ws.id);
  assert.deepEqual(re, { ok: true, notice: 'We’ve asked for a new code to be sent to me@example.com.' });
  const fresh = h.hub.lastCode('me@example.com');
  if (old !== fresh) assert.equal((await h.A.teamDeleteCode(ws.id, old)).ok, false, 'the old flow isn’t the one verified');
  assert.equal((await h.A.teamDeleteCode(ws.id, fresh)).ok, true);
  assert.equal((await h.A.deleteTeam(ws.id)).ok, true);
}));

// ── P4: This Mac enrols per team with a runner token ──────────────────────

const flowRunner = async (h, ws) => {
  assert.equal((await h.A.runner(ws.id, true)).ok, true);
  const child = h.children.at(-1);
  if (!child.onConfig) { child.emit('message', { type: 'runner.ready' }); child.emit('message', { type: 'runner.status', state: 'connected' }); return child; }
  await until(() => child.welcome);
  return child;
};
const macRow = async (h, ws) => { await h.A.go('thismac'); return (await h.A.state()).hubs[0].teams.find((t) => t.id === ws.id); };

test('P4: the switch enrols (runner.config with the runner token only), off calls DELETE enrol and stops the process', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  const child = await flowRunner(h, ws);
  const cfg = child.sent[0];
  assert.deepEqual(Object.keys(cfg).sort(), ['data_dir', 'hub_url', 'runner_token', 'team_id', 'type']);
  assert.match(cfg.runner_token, /^brt_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(cfg.runner_token, h.vault(h.origin).load().token, 'never the account token');
  assert.ok(!JSON.stringify(child.args) .includes('brt_') && !JSON.stringify(child.opts).includes('brt_'));
  assert.ok(!h.logs.some((l) => l.includes(cfg.runner_token)) && !fs.readFileSync(h.deviceFile(ws), 'utf8').includes('brt_'));
  assert.deepEqual(h.hub.enrolments().map((e) => [e.name, e.revoked]), [['Test Mac', false]]);
  assert.equal(h.hub.runnerSockets(h.hub.enrolments()[0].id), 1);
  assert.deepEqual(h.flow.runningTeams(), ['Bondly']);
  assert.equal((await h.A.runner(ws.id, false)).ok, true);
  assert.equal(child.killed, 1);
  assert.equal(h.hub.enrolments()[0].revoked, true, 'DELETE /api/teams/:id/enrol');
  assert.ok(h.requests.some((u) => u.pathname === `/api/teams/${ws.teamId}/enrol`));
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assert.deepEqual(h.flow.runningTeams(), []);
  assert.equal((await h.vault(h.origin).load()) != null, true, 'still signed in');
}, { live: true }));

for (const code of [4403, 4401]) {
  test(`P4: the hub closes the runner ${code}: the runner stops, the sealed token goes, This Mac says so with Turn on again`, async () => harness(async (h) => {
    await h.signInAs('me@example.com');
    await h.A.createTeam('Bondly');
    const ws = h.store.active();
    const child = await flowRunner(h, ws);
    h.hub.closeRunner(h.hub.enrolments()[0].id, code);
    await until(() => child.killed === 1);
    assert.equal(fs.existsSync(h.deviceFile(ws)), false);
    await until(async () => (await macRow(h, ws)).state === 'removed');
    const row = await macRow(h, ws);
    assert.deepEqual([row.enabled, row.ended], [false, code]);
    const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
    assert.ok(page.includes('This Mac no longer runs ${t.name} cards.') && /link\('Turn on again', \(\) => act\(api\.runner\(t\.id, true\)\)\)/.test(page));
    // A 4401 asks the hub; it still answers 200 here, so nobody is signed out.
    assert.deepEqual(h.signedOutHubs, []);
    assert.equal((await h.A.runner(ws.id, true)).ok, true, 'Turn on again enrols afresh');
    await until(() => h.children.at(-1).welcome);
    assert.equal(h.children.length, 2);
  }, { live: true }));
}

test('P4: rotation — enrolling again replaces the sealed token and the runner restarts on the new one', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  const first = await flowRunner(h, ws);
  const d = h.flow.dropDevices; // not called; the device is reached through the switch
  assert.equal(typeof d, 'function');
  const second = await flowRunner(h, ws);
  assert.equal(first.killed, 1);
  assert.notEqual(second.sent[0].runner_token, first.sent[0].runner_token);
  assert.equal(h.hub.enrolments().length, 1, 'one enrolment, rotated');
  assert.equal(h.hub.runnerSockets(h.hub.enrolments()[0].id), 1);
}, { live: true }));

test('P4: sign-out stops every team’s runner and the hub ends the enrolments; two teams are two processes', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Alpha');
  const a = h.store.active();
  await h.A.createTeam('Beta');
  const b = h.store.active();
  const ca = await flowRunner(h, a);
  const cb = await flowRunner(h, b);
  assert.notEqual(ca, cb);
  assert.deepEqual([ca.sent[0].team_id, cb.sent[0].team_id], [a.teamId, b.teamId]);
  assert.notEqual(ca.sent[0].data_dir, cb.sent[0].data_dir);
  assert.deepEqual(h.flow.runningTeams().sort(), ['Alpha', 'Beta']);
  assert.equal((await h.A.signOut(h.host)).ok, true);
  assert.deepEqual([ca.killed, cb.killed], [1, 1]);
  assert.ok(h.hub.enrolments().every((e) => e.revoked));
  assert.equal(fs.readdirSync(h.devDir).length, 0);
}, { live: true }));

test('P4: deleting the team from the app stops its runner (and only its)', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Keep');
  const keep = h.store.active();
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  const kc = await flowRunner(h, keep);
  const child = await flowRunner(h, ws);
  await confirmTeamByEmail(h, ws, 'bondly');
  assert.equal((await h.A.deleteTeam(ws.id)).ok, true);
  assert.equal(child.killed, 1);
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assert.equal(kc.killed, 0);
  assert.ok(fs.existsSync(h.deviceFile(keep)));
  assert.deepEqual(h.flow.runningTeams(), ['Keep']);
}, { live: true }));

for (const live of [true, false]) test(`P4: removed from a team or demoted to viewer: ${live ? 'the socket closing 4403' : 'with no socket, the next look at the account'} stops that runner`, async () => harness(async (h) => {
  const luke = await h.other('luke@example.com');
  const t1 = (await luke.createTeam('Removed')).team;
  const t2 = (await luke.createTeam('Demoted')).team;
  for (const t of [t1, t2]) await luke.invite(t.id, 'me@example.com', 'member');
  await h.signInAs('me@example.com');
  for (const i of (await h.A.state()).invites) assert.equal((await h.A.acceptPending(i.id)).ok, true);
  await h.flow.refreshAccount(h.origin);
  const w1 = h.store.list().find((w) => w.teamId === t1.id);
  const w2 = h.store.list().find((w) => w.teamId === t2.id);
  const c1 = await flowRunner(h, w1);
  const c2 = await flowRunner(h, w2);
  const meIn = async (t) => (await luke.listMembers(t.id)).members.find((m) => m.display_name === 'me').member_id;
  assert.equal((await luke.removeMember(t1.id, await meIn(t1))).ok, true);
  assert.equal((await luke.setRole(t2.id, await meIn(t2), 'viewer')).ok, true);
  await h.flow.refreshAccount(h.origin);
  await until(() => c1.killed === 1 && c2.killed === 1);
  assert.equal(fs.existsSync(h.deviceFile(w1)) || fs.existsSync(h.deviceFile(w2)), false);
  assert.deepEqual(h.flow.runningTeams(), []);
}, { live }));

test('P4: a team deleted by its other owner: the next look at the account stops this Mac’s runner and deletes its token', async () => harness(async (h) => {
  const luke = await h.other('luke@example.com');
  const team = (await luke.createTeam('Gone')).team;
  await luke.invite(team.id, 'me@example.com', 'member');
  await h.signInAs('me@example.com');
  assert.equal((await h.A.acceptPending((await h.A.state()).invites[0].id)).ok, true);
  const ws = h.store.active();
  const child = await flowRunner(h, ws);
  const flowId = (await hubCall(h, 'POST', '/api/auth/email/start', { purpose: 'delete_team' }, luke.testToken())).body.flow_id;
  await hubCall(h, 'POST', '/api/auth/email/verify', { flow_id: flowId, code: h.hub.lastCode('luke@example.com') }, luke.testToken());
  assert.equal((await hubCall(h, 'DELETE', `/api/teams/${team.id}`, { confirm_slug: 'gone', flow_id: flowId }, luke.testToken())).status, 200);
  await h.flow.refreshAccount(h.origin);
  assert.equal(child.killed, 1);
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
}));

test('P4: QUOTA_EXCEEDED and 429 come back as plain words on the switch', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  // Another install of mine already uses the one slot.
  const mine2 = await h.other('me@example.com');
  assert.equal((await mine2.enrol(ws.teamId)).ok, true);
  const r = await h.A.runner(ws.id, true);
  assert.equal(r.error, 'You already have 1 Macs running cards, the most allowed. Turn one off or remove one, then try again.');
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assert.equal(h.children.length, 0);
  await mine2.unenrol(ws.teamId);
  assert.equal((await h.A.runner(ws.id, true)).ok, true);
  assert.equal((await h.A.runner(ws.id, true)).ok, true, 'a rotation: the third enrolment this hour');
  const slow = await h.A.runner(ws.id, true);
  assert.match(slow.error, /^This Mac was turned on and off too often\. Wait \d+ minutes and try again\.$/);
  assert.ok(fs.existsSync(h.deviceFile(ws)), 'a refused rotation leaves the working token alone');
}, { quotas: { enrolPerTeam: 1, enrolPerHour: 3 } }));

test('P4: the team screen lists this team’s runners as text; revoke shows only where allowed; revoking this Mac stops it here', async () => harness(async (h) => {
  await h.signInAs('me@example.com');
  await h.A.createTeam('Bondly');
  const ws = h.store.active();
  const luke = await h.other('luke@example.com');
  const inv = await h.A.invite(ws.id, 'luke@example.com', 'member');
  assert.equal((await luke.acceptInvite({ code: inv.invite.code })).ok, true);
  await luke.enrol(ws.teamId, { deviceName: 'Luke’s Mac' });
  const mine = await flowRunner(h, ws);
  await h.A.go('team');
  let s = await h.A.state();
  assert.deepEqual(s.runners.map((r) => [r.name, r.person, r.online, r.current, r.canRevoke]), [['Test Mac', 'me', true, true, true], ['Luke’s Mac', 'luke', false, false, true]]);
  for (const r of s.runners) assert.deepEqual(Object.keys(r).sort(), ['canRevoke', 'current', 'id', 'lastSeenAt', 'name', 'online', 'person']);
  // As a member, Luke sees only his own, and may revoke only it.
  const lukeList = await luke.listEnrolments(ws.teamId);
  assert.deepEqual(lukeList.enrolments.map((e) => e.name), ['Luke’s Mac']);
  assert.equal((await luke.revokeEnrolment(ws.teamId, s.runners[0].id)).status, 403);
  // Revoking this Mac from the list: the hub closes it, and it stops here at once.
  const r = await h.A.revokeRunner(ws.id, s.runners[0].id);
  assert.equal(r.ok, true);
  assert.equal(r.notice, 'This Mac no longer runs cards for this team.');
  assert.equal(mine.killed, 1);
  assert.equal(fs.existsSync(h.deviceFile(ws)), false);
  assert.equal((await h.A.revokeRunner(ws.id, s.runners[0].id)).error, 'That runner is already gone.');
  assert.equal((await h.A.revokeRunner(ws.id, s.runners[1].id)).ok, true, 'an owner removes anyone’s');
  s = await h.A.state();
  assert.deepEqual(s.runners, []);
  // The page draws the rows with text only, and offers Remove only when canRevoke.
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.match(page, /r\.canRevoke \? el\('button'/);
  assert.match(page, /'this Mac'/);
  assert.ok(!/\.innerHTML\s*=/.test(page));
  assert.deepEqual(ACCT_ARGS.revokeRunner, ['string', 'string']);
}, { live: true }));

test('P4: a member’s team screen offers revoke only on their own runner', async () => harness(async (h) => {
  const luke = await h.other('luke@example.com');
  const team = (await luke.createTeam('Pistor')).team;
  await luke.invite(team.id, 'me@example.com', 'member');
  await luke.enrol(team.id, { deviceName: 'Luke’s Mac' });
  await h.signInAs('me@example.com');
  assert.equal((await h.A.acceptPending((await h.A.state()).invites[0].id)).ok, true);
  const ws = h.store.active();
  await flowRunner(h, ws);
  await h.A.go('team');
  const s = await h.A.state();
  assert.deepEqual(s.runners.map((r) => [r.name, r.canRevoke]), [['Test Mac', true]], 'a member sees only their own');
}, { live: true }));

test('no copy promises to merge or link accounts: GitHub always makes its own account, Google joins only an authoritative address', () => {
  const dir = path.join(__dirname, '..', 'buddy-window');
  const texts = [...fs.readdirSync(dir).filter((f) => /\.(js|html)$/.test(f) && f !== 'mock-accounts-hub.js').map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]), ['PRIVACY.md', fs.readFileSync(path.join(__dirname, '..', 'PRIVACY.md'), 'utf8')]];
  const promise = [/\bmerg\w*\b[^.\n]{0,80}\baccounts?\b/i, /\baccounts?\b[^.\n]{0,80}\bmerg\w*/i, /\b(?:link|join|connect)s?\b[^.\n]{0,40}\b(?:to|with) (?:your|an|the) (?:existing |other )?account\b/i, /\bsame account\b/i];
  for (const [f, t] of texts) for (const re of promise) assert.ok(!re.test(t), `${f}: ${t.match(re)?.[0]}`);
});

test('signed-out pages: signInWith refuses an unknown provider and starts nothing; the Integrations screen lists the tools with honest status', async () => harness(async (h) => {
  const r = await h.A.signInWith('twitter');
  assert.deepEqual([r.ok, h.opened.length, h.flow.acct.screen], [false, 0, null]);
  h.flow.show('integrations');
  const st = await h.A.state();
  assert.equal(st.screen, 'integrations');
  assert.deepEqual(st.connectors.map((c) => [c.id, c.status]), [['github', 'available'], ['slack', 'soon'], ['sentry', 'soon']]);
  assert.equal(st.brand.defaultHost, 'app.plexiform.dev');
  assert.deepEqual(st.signedInHubs, []);
  h.flow.show('team');
  assert.deepEqual([(await h.A.state()).team, (await h.A.state()).signedInHubs], [null, []]);
}));

// ── email codes: the words a person sees, and never a code that can't arrive ──

function stubClient(answer, { now = () => 0 } = {}) {
  const sent = [];
  const fetchImpl = async (u, init) => {
    sent.push({ path: new URL(u).pathname, body: init.body ? JSON.parse(init.body) : null });
    const a = typeof answer === 'function' ? answer(sent.at(-1)) : answer;
    return { status: a.status, json: async () => a.body };
  };
  let v = null;
  const c = createAccountClient({ origin: 'https://hub.example.com', fetchImpl, now, store: { load: () => v, save: (x) => { v = x; }, clear: () => { v = null; } } });
  return { c, sent };
}

test('email start: a hub with email off says so, a failing send says it plainly, never the provider’s words', async () => {
  const off = stubClient({ status: 404, body: { error: { code: 'METHOD_DISABLED', message: 'email sign-in is not enabled on this hub' } } });
  assert.equal((await off.c.startEmail('jo@example.com')).error, 'Email sign-in is turned off on hub.example.com.');
  for (const status of [500, 502, 503]) {
    const bad = stubClient({ status, body: { error: { code: 'MAIL_FAILED', message: 'SES MessageRejected: Email address is not verified (eu-west-1)' } } });
    const r = await bad.c.startEmail('jo@example.com');
    assert.equal(r.error, 'We couldn’t send the email. Try again in a minute.');
    assert.equal(bad.c.pendingEmail(), null, 'no code screen for a code that never went');
  }
});

test('email codes: a new code waits 30 s after the last, never a fourth in 15 minutes; signing in again is no resend', async () => {
  let t = 1_000_000;
  let n = 0;
  const { c, sent } = stubClient((req) => (req.path.endsWith('/verify')
    ? { status: 200, body: { user: { id: 'u' }, teams: [], device_token: `bdt_${'x'.repeat(43)}`, device_id: 'd' } }
    : { status: 200, body: { flow_id: `f${++n}`.padEnd(24, '0'), expires_in: 600 } }), { now: () => t });
  assert.equal((await c.startEmail('jo@example.com')).ok, true);
  const soon = await c.startEmail('jo@example.com');
  assert.deepEqual([soon.ok, soon.error], [false, 'You can ask for a new code in 30 seconds.']);
  assert.equal(sent.length, 1, 'nothing asked of the hub');
  t += 31_000;
  assert.equal((await c.startEmail('jo@example.com')).ok, true);
  assert.equal((await c.verifyCode('123456')).ok, true);
  assert.equal((await c.startEmail('jo@example.com')).ok, true, 'signed in and out again: no gap');
  t += 31_000;
  const fourth = await c.startEmail('jo@example.com');
  assert.equal(fourth.ok, false);
  assert.match(fourth.error, /^You can ask for a new code in 14 minutes\.$/);
  assert.equal((await c.startEmail('other@example.com')).ok, true, 'per address');
});

test('waits read in hours for a day-long lockout', () => {
  const { humanError } = require('../buddy-window/accounts');
  assert.equal(humanError(429, { error: { code: 'RATE_LIMITED', retry_after_s: 86_400 } }, 'h'), 'Too many tries. Wait 24 hours and try again.');
  assert.equal(humanError(429, { error: { code: 'RATE_LIMITED', retry_after_s: 3600 } }, 'h'), 'Too many tries. Wait 60 minutes and try again.');
});

test('first sign-in creates one personal team and board without an extra screen', async () => harness(async (h) => {
  await h.signInAs('new@example.com');
  assert.equal(h.store.active().name, "new's team");
  assert.equal(h.store.active().role, 'owner');
  assert.equal(h.store.list().filter((w) => w.kind === 'team').length, 1);
  assert.equal(h.shown.includes('create-team'), false);
  await h.A.signOut(h.host);
  await h.signInAs('new@example.com');
  assert.equal(h.store.list().filter((w) => w.kind === 'team').length, 1);
}));

test('automatic setup quota failure keeps create or join with a code or link', async () => harness(async (h) => {
  await h.signInAs('new@example.com');
  assert.equal(h.flow.acct.screen, 'create-team');
  assert.match((await h.A.state()).alert, /plan|team|limit/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  const screen = page.slice(page.indexOf("'create-team'(s) {"), page.indexOf('  integrations(s) {'));
  assert.match(screen, /heading\('Create or join a team', null\)/);
  assert.match(screen, /onclick: \(\) => api\.go\('join'\) \}, 'Join with a code or link'\)/);
  assert.equal((await h.A.go('join')).ok, true);
  assert.equal(h.flow.acct.screen, 'join');
}, { quotas: { teams: 0 } }));

test('a setup reply after sign-out cannot restore the old account or workspace', async () => harness(async (h) => {
  h.setAfterHub(async (u) => {
    if (new URL(u).pathname !== '/api/account/setup') return;
    h.setAfterHub(null);
    await h.A.signOut(h.host);
  });
  await h.signInAs('new@example.com');
  assert.equal(h.vault(h.origin).load(), null);
  assert.equal(h.store.list().filter((w) => w.kind === 'team').length, 0);
}));

test('a newer invite during sign-in preview cannot ride the previous explicit join intent', async () => harness(async (h) => {
  const owner = await h.other('owner@example.com');
  const first = (await owner.createTeam('First')).team;
  const second = (await owner.createTeam('Second')).team;
  const oldInvite = await owner.invite(first.id, 'new@example.com', 'member');
  const newInvite = await owner.invite(second.id, 'new@example.com', 'member');
  h.flow.openInvite(oldInvite.link);
  await h.A.confirm(true);
  h.setAfterHub((u) => {
    if (new URL(u).pathname !== '/api/invites/preview') return;
    h.setAfterHub(null);
    h.flow.openInvite(newInvite.link);
  });
  assert.equal((await h.A.email('new@example.com')).ok, true);
  assert.equal((await h.A.code(h.hub.lastCode('new@example.com'))).ok, true);
  assert.equal(h.requests.filter((u) => u.pathname === '/api/invites/accept').length, 0);
  assert.equal((await h.A.state()).invite.team, 'Second');
  assert.equal(h.store.list().filter((w) => w.kind === 'team').length, 0);
}));

test('sign-up control (D104): SIGNUP_CLOSED reads as the one fixed sentence on the OAuth and email-code paths, never the hub message', () => {
  const { oauthOutcome, humanError } = require('../buddy-window/accounts');
  const text = 'Sign-up is invite-only right now. Ask a team owner for an invite.';
  for (const p of ['google', 'github']) assert.equal(oauthOutcome({ ok: false, status: 403, code: 'SIGNUP_CLOSED', error: 'hub words' }, p, 'h').error, text);
  assert.equal(humanError(403, { error: { code: 'SIGNUP_CLOSED', message: 'hub words' } }, 'h'), text);
});

// ── a hub leaving Cloudflare Access ─────────────────────────────────────────

test('an Access workspace whose hub now answers /api/health itself is dropped, and the member goes to the Google/GitHub sign-in', async () => harness(async (h) => {
  // The shape a v53-era app left in buddy-workspaces.json: the hub as a legacy Access entry, no accounts hub.
  const ws = h.store.addAccess({ url: h.origin, name: 'Team hub', accessTeam: 'acme' });
  assert.equal(ws.kind, 'access');
  // Still behind Access (redirects to its login), or unreachable: nothing changes.
  h.setProbe(async () => ({ ok: true, accessTeam: 'acme', signedIn: false }));
  assert.equal(await h.flow.recheckAccess(ws), false);
  h.setProbe(async () => ({ ok: false, error: 'offline' }));
  assert.equal(await h.flow.recheckAccess(ws), false);
  h.setProbe(async () => ({ ok: true, accessTeam: null, signedIn: true, auth: 'access' }));
  assert.equal(await h.flow.recheckAccess(ws), false, 'a hub that itself runs Access auth stays an Access workspace');
  assert.equal(h.store.get(ws.id)?.kind, 'access');
  // Access removed: the hub answers health directly in accounts mode.
  h.setProbe(null);
  assert.equal(await h.flow.recheckAccess(ws), true);
  assert.equal(h.store.get(ws.id), null, 'the stale Access entry is gone');
  assert.equal(h.store.list().some((w) => w.kind === 'access'), false);
  assert.equal(h.store.activeId(), 'local');
  assert.equal(h.flow.acct.screen, 'email');
  assert.equal(h.flow.acct.hub, h.origin);
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'ws.json'), 'utf8'));
  assert.deepEqual(saved.access, [], 'persisted');
  // The sign-in screen shows the hub's methods; with email off there, no email form can be reached.
  h.hub.setMethods({ google: true, github: true, email: false });
  const st = await h.A.state();
  assert.deepEqual(st.methods, { google: true, github: true, email: false });
  const before = h.requests.filter((u) => u.pathname === '/api/auth/email/start').length;
  const r = await h.A.email('me@example.com');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Sign in with Google or GitHub.');
  assert.equal(h.requests.filter((u) => u.pathname === '/api/auth/email/start').length, before, 'no code is even asked for');
}));

test('typing a hub that left Access drops its old Access entry and goes to the hub sign-in', async () => harness(async (h) => {
  h.store.addAccess({ url: h.origin, name: 'Team hub', accessTeam: 'acme' });
  assert.equal((await h.A.hub(h.origin)).ok, true);
  assert.equal(h.store.list().some((w) => w.kind === 'access'), false);
  assert.equal(h.flow.acct.screen, 'email');
}));

test('the workspaces file: an Access entry for a hub survives a reload until a direct health answer retires it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ws-'));
  const file = path.join(dir, 'buddy-workspaces.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, active: 'access:app.acme.example', access: [{ url: 'https://app.acme.example', name: 'app.acme.example', accessTeam: 'acme' }], hubs: [] }));
  const store = createWorkspaceStore(file);
  assert.equal(store.active().kind, 'access');
  assert.equal(store.removeAccess('access:app.acme.example'), true);
  const again = createWorkspaceStore(file);
  assert.equal(again.active().id, 'local');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).access, []);
});
