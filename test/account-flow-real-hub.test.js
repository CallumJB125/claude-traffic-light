'use strict';
// The desktop account flow (buddy-window/account-flow.js) against the REAL
// hub process in accounts mode (loopback try-out, console mailer: codes are
// read from its stderr), not the mock: a new person signs in with an email
// code, gets a first team and board automatically in the switcher, makes
// an invite and turns This Mac on (a runner token, sealed on disk, a live
// /ws/runner socket). A second person opens the invite link signed out,
// confirms the hub, signs in and resumes the explicit invite; a third
// joins with the 8-letter code. The owner, signing in again on a fresh
// install, lands on the team, not the create screen. Skipped when the board's
// dependencies aren't installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createAccountFlow } = require('../buddy-window/account-flow');
const { createAccountClient } = require('../buddy-window/accounts');
const { createDeviceController } = require('../buddy-window/device');
const { createWorkspaceStore, normalizeHubUrl, normalizeLinkHub, hubKey } = require('../buddy-window/workspaces');

const BOARD = path.join(__dirname, '..', 'board');
const ready = fs.existsSync(path.join(BOARD, 'node_modules', 'ws'));
let WebSocket = null;
try { WebSocket = require('ws'); } catch { /* skipped below */ }

const until = async (fn, ms = 15000, what = 'condition') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function startRealHub(dir) {
  const port = await freePort();
  let err = '';
  const proc = spawn(process.execPath, [path.join(BOARD, 'hub', 'server.js')], {
    env: {
      PATH: process.env.PATH, HOME: dir, LANG: 'en_US.UTF-8', BOARD_AUTH: 'accounts', BOARD_SIGNUP: 'open', BOARD_ACCOUNTS_DEV: '1', BOARD_CONSOLE_MAILER: '1',
      BOARD_BIND: '127.0.0.1', BOARD_PORT: String(port), BOARD_DATA_DIR: dir, BOARD_SECRET: crypto.randomBytes(32).toString('hex'), BOARD_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => { err += d; });
  const origin = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } }, 15000, 'hub health');
  // The console mailer prints each mail; a sign-in mail's subject starts with its code.
  const codes = (email) => [...err.matchAll(/To: (\S+)\nSubject: (\d{6}) is your \S+ sign-in code\n/g)].filter((m) => m[1] === email).map((m) => m[2]);
  return {
    origin, proc,
    nextCode: (email, seen) => until(() => (codes(email).length > seen ? codes(email).at(-1) : null), 15000, `code for ${email}`),
    seen: (email) => codes(email).length,
    async stop() { proc.kill('SIGTERM'); await until(() => proc.exitCode != null || proc.signalCode != null, 10000, 'hub exit').catch(() => proc.kill('SIGKILL')); },
  };
}

class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = 0; this.sent = []; }
  postMessage(m) {
    this.sent.push(m);
    if (m.type !== 'runner.config') return;
    // What app-entry does with runner.config: one /ws/runner socket with the two headers, then hello.
    this.ws = new WebSocket(`${m.hub_url.replace(/^http/, 'ws')}/ws/runner`, { headers: { Authorization: `Bearer ${m.runner_token}`, 'Board-Team': m.team_id } });
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'hello', protocol: 1, device_id: '', runner_version: 'test', outbox_head_seq: 0, outbox_id: crypto.randomUUID(), outbox_acked_seq: 0, runs: [] })));
    this.ws.on('close', (code) => { this.closed = code; });
    this.ws.on('message', (d) => { const f = JSON.parse(d); if (f.type === 'welcome') { this.welcome = f; this.emit('message', { type: 'runner.status', state: 'connected' }); } });
    this.ws.on('error', () => {});
    this.emit('message', { type: 'runner.ready' });
  }
  kill() { this.ws?.terminate(); setImmediate(() => this.emit('exit', 0)); return true; }
}

function install(hub, root, name) {
  const dir = path.join(root, name);
  const devDir = path.join(dir, 'devices');
  fs.mkdirSync(devDir, { recursive: true });
  const allowOrigins = [hub.origin];
  let token = null;
  const vault = { load: () => token, save: (x) => { token = JSON.parse(JSON.stringify(x)); }, clear: () => { token = null; } };
  const signedIn = (o) => o === hub.origin && !!vault.load();
  const store = createWorkspaceStore(path.join(dir, 'ws.json'), { allowOrigins, signedIn });
  const client = createAccountClient({ origin: hub.origin, store: vault, onSignedOut: () => {} });
  const children = [];
  const opened = [];
  const deviceFile = (ws) => path.join(devDir, `${hubKey(ws.hub)}-${ws.teamId}.bin`);
  const flow = createAccountFlow({
    store, clientFor: () => client, signedIn, userOf: () => vault.load()?.user ?? null,
    normHub: (u) => normalizeHubUrl(u, { allowOrigins }), normLink: (u) => normalizeLinkHub(u, { allowOrigins }),
    probe: async () => ({ ok: true, auth: 'accounts' }),
    makeDevice: (ws, { onStatus }) => createDeviceController({
      account: client, teamId: ws.teamId, credsFile: deviceFile(ws),
      seal: (s) => Buffer.from(`SEALED:${Buffer.from(s).toString('base64')}`), unseal: (b) => Buffer.from(String(b).slice(7), 'base64').toString(),
      fork: () => { const c = new FakeChild(); children.push(c); return c; }, runnerEntry: 'x', entryExists: () => true,
      dataDir: path.join(dir, 'runner', ws.teamId), onStatus, schedule: () => {}, stopGraceMs: 500,
    }),
    hasDeviceFile: (ws) => fs.existsSync(deviceFile(ws)),
    discardDeviceFiles: () => {},
    deviceInfo: () => ({ deviceName: `${name} Mac`, platform: 'darwin-arm64' }),
    openBrowser: async (url) => { opened.push(url); },
    ui: { show() {}, select() {}, openClients: async (origin) => { opened.push(`${origin}/clients`); }, switchWorkspace: (id) => { if (id) store.setActive(id); }, pushState() {}, forgetHub() {}, hubSignedOut: async () => {}, isOpen: () => true, onHubPage: () => false, devicesChanged() {}, openMail() {} },
  });
  const A = flow.ACCT;
  const signIn = async (email) => {
    const seen = hub.seen(email);
    assert.equal((await A.email(email)).ok, true);
    assert.equal(flow.acct.screen, 'code');
    const r = await A.code(await hub.nextCode(email, seen));
    assert.equal(r.ok, true, r.error);
  };
  return { flow, A, store, client, children, opened, deviceFile, signIn, token: () => vault.load()?.token ?? null };
}

test('desktop real hub: pending and accepted client-only access stays outside staff teams and runners', { skip: (!ready || !WebSocket) && 'board dependencies not installed' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-clienthub-'));
  let hub;
  try {
    hub = await startRealHub(path.join(root, 'hub'));
    const owner = install(hub, root, 'staff'); await owner.A.hub(hub.origin); await owner.signIn('staff@clients.test');
    const call = async (token, method, url, body) => {
      const res = await fetch(`${hub.origin}${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data;
    };
    const made = await call(owner.token(), 'POST', '/api/client-workspaces', { name: 'Delivery', request_id: crypto.randomUUID() });
    const invite = await call(owner.token(), 'POST', `/api/teams/${made.workspace.id}/client-invites`, { email: 'client@clients.test', grants: [{ project_id: made.projects[0].id, scopes: ['status.read'] }] });
    const guest = install(hub, root, 'guest'); await guest.A.hub(hub.origin); await guest.signIn('client@clients.test');
    assert.equal(guest.flow.acct.screen, 'clients');
    assert.equal((await guest.A.state()).invitations.length, 1);
    assert.equal(guest.store.list().filter((w) => w.kind === 'team').length, 0);
    assert.equal(guest.children.length, 0, 'guest admission never enrols or starts a runner');
    assert.equal((await guest.A.openClients()).ok, true);
    assert.deepEqual(guest.opened, [`${hub.origin}/clients`], 'derived-origin client view continuation carries no desktop token');
    await call(guest.token(), 'POST', '/api/client-invites/accept', { t: invite.link.split('#')[1] });
    const returning = install(hub, root, 'returning'); await returning.A.hub(hub.origin); await returning.signIn('client@clients.test');
    assert.equal(returning.flow.acct.screen, 'clients');
    assert.deepEqual((await returning.A.state()).workspaces.map((w) => w.id), [made.workspace.id]);
    assert.equal(returning.store.list().filter((w) => w.kind === 'team').length, 0);
    assert.equal(returning.children.length, 0);
  } finally { await hub?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('desktop on the real hub: automatic first team → This Mac runs it; invited sign-in joins directly, code join and returning owner', { skip: (!ready || !WebSocket) && 'board dependencies not installed' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-realhub-'));
  const hub = await startRealHub(path.join(root, 'hub'));
  const installs = [];
  try {
    // Owner: email, a wrong code (plain words with the tries left), then automatic setup.
    const o = install(hub, root, 'owner');
    installs.push(o);
    assert.equal((await o.A.hub(hub.origin)).ok, true);
    assert.equal(o.flow.acct.screen, 'email');
    const s = await o.A.state();
    assert.deepEqual(s.methods, { google: false, github: false, email: true }, 'the email option shows');
    const seen = hub.seen('owner@e2e.test');
    assert.equal((await o.A.email('owner@e2e.test')).ok, true);
    const code = await hub.nextCode('owner@e2e.test', seen);
    const wrong = await o.A.code(code === '000000' ? '000001' : '000000');
    assert.deepEqual([wrong.ok, wrong.error], [false, 'That code didn’t work. 4 tries left.']);
    assert.equal((await o.A.code(code)).ok, true);
    assert.notEqual(o.flow.acct.screen, 'create-team', 'first sign-in completes setup without an extra screen');

    // Automatic setup: one team and board, active in the switcher.
    const ws = o.store.active();
    assert.equal(ws.kind, 'team');
    assert.equal(ws.name, "owner's team");
    assert.equal(ws.role, 'owner');
    assert.ok(o.store.list().some((w) => w.id === ws.id), 'in the sidebar switcher');
    assert.deepEqual((await o.client.me()).teams.map((t) => [t.name, t.boards.length]), [["owner's team", 1]]);
    await o.A.go('team');
    const team = await o.A.state();
    assert.equal(team.screen, 'team');
    assert.deepEqual(team.members.map((m) => [m.role, m.you]), [['owner', true]]);

    // Invites for two people.
    const inv = await o.A.invite(ws.id, 'joiner@e2e.test', 'member');
    assert.equal(inv.ok, true, inv.error);
    const inv2 = await o.A.invite(ws.id, 'coder@e2e.test', 'member');
    assert.equal(inv2.ok, true, inv2.error);

    // This Mac on: a runner token for this team only, sealed on disk, and a live runner socket.
    assert.equal((await o.A.runner(ws.id, true)).ok, true);
    const child = o.children.at(-1);
    const cfg = child.sent.find((m) => m.type === 'runner.config');
    assert.equal(cfg.team_id, ws.teamId);
    assert.match(cfg.runner_token, /^brt_/);
    assert.equal(cfg.device_token, undefined);
    await until(() => child.welcome || child.closed, 15000, 'runner welcome');
    assert.equal(child.closed, undefined, `runner socket closed ${child.closed}`);
    assert.ok(child.welcome.device_id && child.welcome.member_id, 'the hub knows this runner and whose it is');
    const sealed = fs.readFileSync(o.deviceFile(ws), 'utf8');
    assert.ok(sealed.startsWith('SEALED:') && !sealed.includes(cfg.runner_token), 'the runner token is stored sealed');
    assert.ok(!sealed.includes(o.token()), 'the device token is not in the runner file');

    // Joiner by link, signed out on a new install: confirm the hub, sign in, the invite resumes.
    const j = install(hub, root, 'joiner');
    installs.push(j);
    assert.equal(j.flow.openInvite(inv.invite.link), true);
    assert.equal(j.flow.acct.screen, 'confirm');
    assert.equal((await j.A.confirm(true)).ok, true);
    assert.equal(j.flow.acct.screen, 'email');
    await j.signIn('joiner@e2e.test');
    assert.equal(j.store.active().teamId, ws.teamId);
    assert.equal(j.store.active().role, 'member');
    assert.deepEqual((await j.client.me()).teams.map((t) => t.id), [ws.teamId], 'the invite creates no personal team');

    // Joiner by code: the invite addressed to them is offered at once; the code works too.
    const c = install(hub, root, 'coder');
    installs.push(c);
    assert.equal((await c.A.hub(hub.origin)).ok, true);
    await c.signIn('coder@e2e.test');
    assert.equal(c.flow.acct.screen, 'invites', 'an invite for this address is offered, not the create screen');
    assert.equal((await c.A.joinCode(inv2.invite.code.toLowerCase())).ok, true);
    assert.equal(c.store.active().teamId, ws.teamId);

    // Returning owner on a fresh install: straight to the team.
    const back = install(hub, root, 'owner-again');
    installs.push(back);
    assert.equal((await back.A.hub(hub.origin)).ok, true);
    await back.signIn('owner@e2e.test');
    assert.notEqual(back.flow.acct.screen, 'create-team');
    assert.equal(back.store.active().teamId, ws.teamId);
    assert.deepEqual((await back.client.me()).teams.map((t) => t.id), [ws.teamId], 'a returning install reuses the same team');
  } finally {
    for (const i of installs) await i.flow.stopDevices().catch(() => {});
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
