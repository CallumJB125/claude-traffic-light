// Phone approvals on the desktop (W2-B, src/remote-approvals-main.js): the
// paid-wiring entry, the entitlement gate, the host wiring (lazy e2e, extra
// ops), the content-free ping, pairing guards, the Settings → Phone page and
// the QR encoder. The full flow through a real hub is
// board/hub/test/approvals-e2e.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Answer = require('../hooks/answer-file.js');
const { createRemoteApprovals, register, EXTRA_OPS, PAIR_OPS } = require('../src/remote-approvals-main.js');
const { createRemoteInteractionHost } = require('../src/remote-interaction.js');
const Wiring = require('../src/paid-wiring.js');
const QR = require('../src/qr.js');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w2b-unit-'));
const uuid = () => crypto.randomUUID();

function rig({ entitled = true, devices = 3, connected = true } = {}) {
  const dir = tmp();
  const requestsDir = path.join(dir, 'requests');
  fs.mkdirSync(requestsDir);
  const ent = { on: entitled, has(f) { return f === 'phone' && this.on; }, limits() { return { devices: this.on ? devices : 0 }; } };
  const pings = [];
  const status = { connected, device: 'host-dev-1' };
  let clock = 1_800_000_000_000;
  const core = createRemoteApprovals({
    dir: path.join(dir, 'remote'), requestsDir, entitlements: ent, keyFor: () => Buffer.alloc(32, 1),
    hub: () => ({ origin: 'https://hub.plexiform.test', userId: 'alice', token: () => 'bdt_x' }),
    host: () => ({ status: () => status, forgetDevice() {} }),
    ping: async (url, token) => { pings.push({ url, token }); return 200; },
    clock: () => clock,
  });
  return { dir, requestsDir, ent, core, pings, status, advance: (ms) => { clock += ms; } };
}

// A paired phone, written to the registry file before the core first reads it (as a restart would).
async function addDevice(r, ownerId = 'alice') {
  const Remote = require('../remote/src/index.js');
  const RemoteNode = require('../remote/src/node/index.js');
  const reg = new Remote.DeviceRegistry({ storage: RemoteNode.fileStorage(path.join(r.dir, 'remote', 'devices.json')) });
  const kp = await Remote.generateSigningKey();
  return (await reg.add({ publicKey: await Remote.exportPublicRaw(kp.publicKey), name: 'p', ownerId })).deviceId;
}

function writeRequest(requestsDir, command = 'ls', createdAt = new Date(1_800_000_000_000).toISOString()) {
  const id = `mac-${uuid()}`;
  const toolInput = { command };
  const r = { id, kind: 'permission', sessionId: 's1', host: 'mac', cwd: '/repo', tool: 'Bash', summary: command, createdAt, toolInput, toolInputHash: Answer.hashToolInput(toolInput) };
  r.decisionHash = Answer.decisionHashOf(r);
  fs.writeFileSync(path.join(requestsDir, `${id}.json`), JSON.stringify(r));
  return id;
}

test('paid wiring lists phone approvals by a literal require, and register() hands main the host options', async () => {
  assert.ok(Wiring.PACKAGES.some(([name]) => name === 'phone-approvals'));
  assert.match(fs.readFileSync(path.join(ROOT, 'src/paid-wiring.js'), 'utf8'), /\['phone-approvals', \(\) => require\.resolve\('\.\/remote-approvals-main'\), \(\) => require\('\.\/remote-approvals-main'\)\]/);
  const handlers = new Map();
  let extras = null;
  const quits = [];
  const dir = tmp();
  const out = Wiring.registerAll({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, rootDir: dir, fromPage: (e, id) => e?.page === id, onQuit: (fn) => quits.push(fn), log: () => {},
    entitlements: { has: () => false, limits: () => ({ devices: 0 }) }, setInteractionHostExtras: (fn) => { extras = fn; },
  }, Wiring.PACKAGES.filter(([n]) => n === 'phone-approvals'));
  assert.deepEqual(out, [{ name: 'phone-approvals', status: 'ok' }]);
  const opts = extras();
  assert.deepEqual(opts.extra.ops, EXTRA_OPS);
  assert.deepEqual(opts.extra.plainOps, PAIR_OPS);
  for (const ch of ['phone:state', 'phone:set', 'phone:pair-start', 'phone:pair-confirm', 'phone:pair-cancel', 'phone:revoke', 'phone:upgrade']) assert.ok(handlers.has(ch), ch);
  assert.equal(await handlers.get('phone:state')({ page: 'settings' }), null, 'only the Phone page may ask');
  const st = await handlers.get('phone:state')({ page: 'phone' });
  assert.equal(st.entitled, false);
  assert.equal(st.enabled, false);
  // The identity file is private.
  assert.equal(fs.statSync(path.join(dir, 'remote', 'identity.json')).mode & 0o777, 0o600);
  for (const q of quits) q();
});

test('free plan or switched off: no approvals, no pairing, no ping, and end-to-end is not forced on other devices', async () => {
  const r = rig({ entitled: false });
  await r.core.ready;
  const d = await addDevice(r);
  const bob = await addDevice(r, 'bob');
  assert.equal((await r.core.run('approvals.list', {}, { dev: d })).status, 'plan');
  assert.equal((await r.core.startPairing()).status, 'plan');
  assert.equal(r.core.e2eConfig().required, false);
  r.ent.on = true;
  assert.equal((await r.core.run('approvals.list', {}, { dev: d })).status, 'off');
  r.core.setEnabled(true);
  assert.equal(r.core.e2eConfig().required, true, 'on: a plain own-device call is refused');
  assert.equal((await r.core.run('approvals.list', {}, { dev: d })).ok, true);
  assert.equal((await r.core.run('approvals.list', {}, { dev: 'never-paired' })).status, 'forbidden');
  // A phone paired under another account: no channel, no ops, but listed so it can be removed.
  assert.equal(await r.core.e2eConfig().peer(bob), null);
  assert.equal((await r.core.run('tasks.start', { provider: 'codex', text: 'x' }, { dev: bob, run: async () => ({ ok: true }) })).status, 'forbidden');
  assert.deepEqual((await r.core.state()).devices.map((x) => x.otherAccount).sort(), [false, true]);
  assert.equal(await r.core.revoke(bob), true);
  writeRequest(r.requestsDir);
  await r.core.tick();
  assert.deepEqual(r.pings, [], 'no ping without a phone that has a passkey');
});

test('a sealed op without a channel device, an unknown op, or extra args is refused', async () => {
  const r = rig();
  await r.core.ready;
  r.core.setEnabled(true);
  const d = await addDevice(r);
  assert.equal((await r.core.run('approvals.list', {}, {})).status, 'invalid');
  assert.equal((await r.core.run('approvals.list', { x: 1 }, { dev: d })).status, 'invalid');
  assert.equal((await r.core.run('approvals.drop', {}, { dev: d })).status, 'invalid');
  assert.equal((await r.core.run('tasks.start', { provider: 'codex', text: 'x' }, { dev: d })).status, 'unavailable', 'no host session ops');
  const calls = [];
  const run = async (op, args) => { calls.push([op, args]); return op === 'launch' ? { ok: true, state: { session: 's-1', generation: 1 } } : { ok: true, status: 'acknowledged' }; };
  assert.equal((await r.core.run('tasks.start', { provider: 'codex', text: '  ' }, { dev: d, run })).status, 'invalid');
  assert.equal((await r.core.run('tasks.start', { provider: 'Codex!', text: 'go' }, { dev: d, run })).status, 'invalid');
  assert.equal((await r.core.run('tasks.start', { provider: 'codex', text: 'x'.repeat(4001) }, { dev: d, run })).status, 'invalid');
  const ok = await r.core.run('tasks.start', { provider: 'codex', text: ' fix the build ' }, { dev: d, run });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [['launch', { provider: 'codex' }], ['send', { session: 's-1', generation: 1, text: 'fix the build' }]]);
  assert.equal((await r.core.run('approvals.passkey', { credentialId: 'x' }, { dev: 'unknown' })).status, 'forbidden', 'only a paired device adds a passkey');
});

test('pairing needs the host connected, respects the plan\'s phone limit, and pairing steps only reach the open pairing', async () => {
  const r = rig({ devices: 1 });
  await r.core.ready;
  r.core.setEnabled(true);
  r.status.connected = false;
  assert.equal((await r.core.startPairing()).status, 'offline');
  r.status.connected = true;
  assert.equal((await r.core.startPairing()).ok, true);
  const st = await r.core.state();
  assert.match(st.pairing.link, /^https:\/\/hub\.plexiform\.test\/phone\/#pair=1&hub=https%3A%2F%2Fhub\.plexiform\.test&did=[\w-]{32}&dpk=[\w-]{87}&pid=[\w-]{22}&s=[\w-]{43}&exp=\d+&h=host-dev-1$/);
  assert.deepEqual(await r.core.run('pair.init', { pid: 'someone-else' }, {}), { ok: false, reason: 'pairing-closed' });
  assert.deepEqual(await r.core.run('pair.poll', { pid: 'someone-else' }, {}), { ok: false, reason: 'pairing-closed' });
  assert.deepEqual(await r.core.run('pair.poll', { pid: st.pairing.pid }, {}), { ok: true, state: 'waiting' });
  assert.equal((await r.core.confirmPairing('nope', '123456')).status, 'stale');
  r.core.cancelPairing();
  assert.equal((await r.core.state()).pairing, null);
});

test('the ping says nothing and fires once per new request, at most every 5 s', async () => {
  const r = rig();
  await r.core.ready;
  r.core.setEnabled(true);
  // A paired phone with a passkey, written the way the registry keeps one.
  const Remote = require('../remote/src/index.js');
  const RemoteNode = require('../remote/src/node/index.js');
  const reg = new Remote.DeviceRegistry({ storage: RemoteNode.fileStorage(path.join(r.dir, 'remote', 'devices.json')) });
  const kp = await Remote.generateSigningKey();
  const d = await reg.add({ publicKey: await Remote.exportPublicRaw(kp.publicKey), name: 'p', ownerId: 'alice' });
  await reg.setPasskey(d.deviceId, { credentialId: 'c'.repeat(22), publicKey: await Remote.exportPublicRaw(kp.publicKey) });
  // The core reads the same file (a fresh process would); reload by recreating.
  const core = createRemoteApprovals({
    dir: path.join(r.dir, 'remote'), requestsDir: r.requestsDir, entitlements: r.ent, keyFor: () => null,
    hub: () => ({ origin: 'https://hub.plexiform.test', userId: 'alice', token: () => 'bdt_x' }), host: () => ({ status: () => r.status }),
    ping: async (url, token) => { r.pings.push({ url, token }); return 200; }, clock: Date.now,
  });
  await core.ready;
  writeRequest(r.requestsDir, 'ls', new Date().toISOString());
  await core.tick();
  await core.tick();
  assert.deepEqual(r.pings, [{ url: 'https://hub.plexiform.test/api/approvals/v1/ping', token: 'bdt_x' }]);
  writeRequest(r.requestsDir, 'pwd', new Date().toISOString());
  await core.tick();
  assert.equal(r.pings.length, 1, 'coalesced within 5 s');
  r.status.connected = false;
  assert.equal(r.pings.length, 1);
});

test('the remote host: e2e may be a function; pairing steps go plain even when e2e is required; approval ops only sealed', async () => {
  let cfg = null;
  const seen = [];
  const host = createRemoteInteractionHost({
    userId: 'u1', adapters: {}, e2e: () => cfg,
    extra: { ops: ['approvals.list'], plainOps: ['pair.poll'], run: async (op, args, ctx) => { seen.push([op, ctx.dev]); return { ok: true, op }; } },
  });
  const frame = (op, extra) => ({ type: 'relay.request', id: uuid(), rid: uuid(), user: 'u1', from: 'phone', op, ...extra });
  assert.deepEqual(await host.handle(frame('list', { args: {} })), { ok: true, sessions: [] }, 'no e2e yet: plain as before');
  const Envelope = require('../src/e2e/relay-envelope.js');
  const desk = await Envelope.generateAgreementKey({ extractable: true });
  cfg = { did: 'desk-1', privateKey: desk.privateKey, peer: () => null, required: true };
  assert.equal((await host.handle(frame('list', { args: {} }))).e2e, 'required');
  assert.deepEqual(await host.handle(frame('pair.poll', { args: { pid: 'x' } })), { ok: true, op: 'pair.poll' });
  assert.deepEqual(seen, [['pair.poll', null]]);
  assert.equal((await host.handle(frame('approvals.list', { args: {} }))).status, 'invalid', 'an approval op is never served plain');
  assert.equal((await host.handle(frame('approvals.list', { enc: { v: 1 } }))).e2e, 'malformed');
  assert.equal((await host.handle(frame('pair.poll', { args: {}, share: { id: 's', team: 't', user: 'u2', name: 'n', scope: 'watch' } }))).status, 'invalid', 'never through a team share');
  assert.equal(host.status().device, null);
  host.close();
});

test('Phone is a page of its own with its preload, packaged, and CSP-locked', () => {
  const { PAGES, SECTIONS } = require('../buddy-window/pages.js');
  const p = PAGES.find((x) => x.id === 'phone');
  assert.deepEqual([p.file, p.preload, p.kind], ['phone-pairing.html', 'phone-pairing-preload.js', 'local']);
  assert.ok(SECTIONS.find((s) => s.id === 'phone').pages.includes('phone'));
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build.files;
  for (const f of ['phone-pairing.html', 'phone-pairing.css', 'phone-pairing-preload.js', 'remote/src/**/*', 'remote/package.json']) assert.ok(files.includes(f), f);
  const html = fs.readFileSync(path.join(ROOT, 'phone-pairing.html'), 'utf8');
  assert.match(html, /default-src 'none'; script-src 'self'/);
  assert.match(html, /<script src="src\/qr\.js"><\/script><script src="src\/remote-pairing-view\.js"><\/script>/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src/remote-pairing-view.js'), 'utf8'), /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('QR: sizes, quiet zone and a real decoder agree (zbarimg when installed)', (t) => {
  const q = QR.encode('HELLO', { ecc: 'M' });
  assert.equal(q.size, 21);
  assert.equal(q.modules[0][0], true);
  assert.ok(QR.svgPath(q).startsWith('M4 4h1v1h-1z'));
  assert.throws(() => QR.encode('x'.repeat(3000), { ecc: 'H' }), /too long/);
  const link = `https://hub.plexiform.test/phone/#pair=1&hub=x&did=${'A'.repeat(32)}&dpk=${'B'.repeat(87)}&pid=${'C'.repeat(22)}&s=${'D'.repeat(43)}&exp=1800000000000&h=0b0c9a2e-1111-4222-8333-944445555666`;
  const big = QR.encode(link, { ecc: 'M' });
  assert.ok(big.version >= 7 && big.version <= 15, `v${big.version}`);
  let zbar = null;
  try { zbar = execFileSync('/bin/sh', ['-c', 'command -v zbarimg'], { encoding: 'utf8' }).trim(); } catch { zbar = null; }
  if (!zbar) { t.diagnostic('zbarimg not installed: decode check skipped'); return; }
  for (const [text, code] of [['HELLO', q], [link, big]]) {
    const sc = 4, b = 4, n = (code.size + 2 * b) * sc;
    const rows = [];
    for (let y = 0; y < n; y++) { const row = []; for (let x = 0; x < n; x++) { const mx = Math.floor(x / sc) - b, my = Math.floor(y / sc) - b; row.push(mx >= 0 && my >= 0 && mx < code.size && my < code.size && code.modules[my][mx] ? 1 : 0); } rows.push(row.join(' ')); }
    const file = path.join(tmp(), 'q.pbm');
    fs.writeFileSync(file, `P1\n${n} ${n}\n${rows.join('\n')}\n`);
    assert.equal(execFileSync(zbar, ['-q', '--raw', file], { encoding: 'utf8' }).trim(), text);
  }
});
