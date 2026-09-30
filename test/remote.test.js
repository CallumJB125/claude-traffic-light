const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const Protocol = require('../hooks/remote-protocol.js');
const Transport = require('../hooks/transport.js');
const Remote = require('../hooks/remote.js');
const SessionState = require('../hooks/session-state.js');
const Rules = require('../rules.js');
const createRemoteDevices = require('../src/remote-devices.js');

const ROOT = path.join(__dirname, '..');
const EMIT = path.join(ROOT, 'hooks', 'emit.js');
const REMOTE_CLI = path.join(ROOT, 'hooks', 'remote.js');
const HOST = os.hostname().split('.')[0];
const tmp = (p = 'ctl-remote-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const TOKEN = 'ab'.repeat(32);
const ch = (...codes) => String.fromCharCode(...codes);

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── Protocol ────────────────────────────────────────────────────────────────
function signed(body, { device = 'devbox-a1b2c3', token = TOKEN, now = Date.now(), nonce } = {}) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { body: buf, headers: Protocol.signedHeaders({ device, token, body: buf, now, nonce }) };
}
const registry = { 'devbox-a1b2c3': { id: 'devbox-a1b2c3', token: TOKEN, name: 'devbox' } };
const lookup = (id) => registry[id] || null;

test('protocol: a signed request verifies, and names its device', () => {
  const r = Protocol.verify({ ...signed({ v: 1 }), lookup, nonces: Protocol.nonceCaches() });
  assert.equal(r.ok, true);
  assert.equal(r.device.id, 'devbox-a1b2c3');
});

test('protocol: a changed body, device, timestamp or nonce breaks the signature', () => {
  const nonces = Protocol.nonceCaches();
  const { body, headers } = signed({ v: 1, kind: 'ping' });
  assert.equal(Protocol.verify({ headers, body: Buffer.from('{"v":1,"kind":"pong"}'), lookup, nonces }).status, 401);
  for (const [k, v] of [[Protocol.HEADERS.ts, String(Number(headers[Protocol.HEADERS.ts]) + 1)], [Protocol.HEADERS.nonce, 'f'.repeat(32)]]) {
    assert.equal(Protocol.verify({ headers: { ...headers, [k]: v }, body, lookup, nonces }).error, 'bad signature');
  }
  const two = { ...registry, 'other-000000': { id: 'other-000000', token: 'cd'.repeat(32) } };
  assert.equal(Protocol.verify({ headers: { ...headers, [Protocol.HEADERS.device]: 'other-000000' }, body, lookup: (id) => two[id], nonces }).status, 401);
  assert.equal(Protocol.verify({ ...signed({ v: 1 }, { token: 'ef'.repeat(32) }), lookup, nonces }).error, 'bad signature');
});

test('protocol: more than 60 s of skew either way is refused', () => {
  const nonces = Protocol.nonceCaches();
  const now = 1790000000000;
  for (const skew of [61000, -61000]) {
    const r = Protocol.verify({ ...signed({ v: 1 }, { now: now + skew }), lookup, nonces, now });
    assert.equal(r.ok, false);
    assert.match(r.error, /60 s/);
  }
  assert.equal(Protocol.verify({ ...signed({ v: 1 }, { now: now + 59000 }), lookup, nonces, now }).ok, true);
});

test('protocol: a replayed request is refused, a fresh nonce is not', () => {
  const nonces = Protocol.nonceCaches();
  const req = signed({ v: 1 });
  assert.equal(Protocol.verify({ ...req, lookup, nonces }).ok, true);
  assert.equal(Protocol.verify({ ...req, lookup, nonces }).error, 'replayed request');
  assert.equal(Protocol.verify({ ...signed({ v: 1 }), lookup, nonces }).ok, true);
});

test('protocol: nonces live 2×skew + 5 s on the monotonic clock; a wall clock step back replays nothing', () => {
  assert.equal(Protocol.NONCE_TTL_MS, 125000);
  const nonces = Protocol.nonceCaches();
  const wall = 1790000000000;
  const req = signed({ v: 1 }, { now: wall });
  assert.equal(Protocol.verify({ ...req, lookup, nonces, now: wall, mono: 0 }).ok, true);
  assert.equal(Protocol.verify({ ...req, lookup, nonces, now: wall + 60000, mono: 60000 }).error, 'replayed request');
  assert.equal(nonces.check('devbox-a1b2c3', req.headers[Protocol.HEADERS.nonce], 120000), 'replay', 'the exact +120000 boundary');
  // The wall clock steps back: the timestamp passes again, the nonce is still remembered.
  assert.equal(Protocol.verify({ ...req, lookup, nonces, now: wall - 1000, mono: 121000 }).error, 'replayed request');
  const c = Protocol.nonceCaches();
  assert.equal(c.check('d', 'n', 0), 'fresh');
  assert.equal(c.check('d', 'n', 124999), 'replay');
  assert.equal(c.check('d', 'n', 125000), 'fresh', 'expired exactly at the TTL');
});

test('protocol: each device has its own nonce cache, and only a full one fails closed', () => {
  const c = Protocol.nonceCaches({ max: 2 });
  assert.equal(c.check('a', 'n1', 0), 'fresh');
  assert.equal(c.check('a', 'n2', 0), 'fresh');
  assert.equal(c.check('a', 'n3', 0), 'full');
  assert.equal(c.check('b', 'n1', 0), 'fresh', 'another device is unaffected');
  assert.equal(Protocol.verify({ ...signed({ v: 1 }), lookup, nonces: { check: () => 'full' } }).status, 429);
});

test('protocol: unknown device, malformed or duplicated headers are one flat 401', () => {
  const nonces = Protocol.nonceCaches();
  assert.deepEqual(Protocol.verify({ ...signed({ v: 1 }, { device: 'nobody-000000' }), lookup, nonces }), { ok: false, status: 401, error: 'bad signature' });
  const good = signed({ v: 1 });
  for (const h of Object.values(Protocol.HEADERS)) {
    const without = { ...good.headers }; delete without[h];
    assert.equal(Protocol.verify({ headers: without, body: good.body, lookup, nonces }).status, 401);
    assert.equal(Protocol.verify({ headers: { ...good.headers, [h]: [good.headers[h], good.headers[h]] }, body: good.body, lookup, nonces }).status, 401);
  }
  assert.equal(Protocol.verify({ headers: { ...good.headers, [Protocol.HEADERS.device]: '../etc' }, body: good.body, lookup, nonces }).status, 401);
});

test('protocol: a stepped-back wall clock cannot replay a request older than the device\'s latest', () => {
  const nonces = Protocol.nonceCaches();
  const T0 = 1790000000000;
  const R0 = signed({ v: 1 }, { now: T0 });
  const dev = { ...registry['devbox-a1b2c3'] };
  const look = () => dev;
  assert.equal(Protocol.verify({ ...R0, lookup: look, nonces, now: T0, mono: 0 }).ok, true);
  // Legitimate traffic moves the device's high-water mark on.
  const later = Protocol.verify({ ...signed({ v: 1 }, { now: T0 + 120000 }), lookup: look, nonces, now: T0 + 120000, mono: 120000 });
  assert.equal(later.ok, true);
  Object.assign(dev, { highTs: later.ts, highMono: 120000 });
  // 126 s on the monotonic clock: R0's nonce has expired. The wall clock has stepped back.
  for (const back of [66000, 125000]) {
    const r = Protocol.verify({ ...R0, lookup: look, nonces, now: T0 + 126000 - back, mono: 126000 });
    assert.equal(r.ok, false, `wall -${back / 1000} s`);
    assert.match(r.error, /older than this device/);
  }
  // A fresh request within 60 s of the mark still passes.
  assert.equal(Protocol.verify({ ...signed({ v: 1 }, { now: T0 + 70000 }), lookup: look, nonces, now: T0 + 70000, mono: 127000 }).ok, true);
});

test('protocol: past its nonce\'s life, the newest request can\'t be replayed once; same-ms requests still pass', () => {
  const nonces = Protocol.nonceCaches();
  const T = 1790000000000;
  const dev = { ...registry['devbox-a1b2c3'] };
  const look = () => dev;
  const a = signed({ v: 1 }, { now: T });
  const b = signed({ v: 1 }, { now: T });
  assert.equal(Protocol.verify({ ...a, lookup: look, nonces, now: T, mono: 0 }).ok, true);
  Object.assign(dev, { highTs: T, highMono: 0 });
  assert.equal(Protocol.verify({ ...b, lookup: look, nonces, now: T, mono: 1000 }).ok, true, 'same millisecond, its own nonce: fine while the cache holds a');
  // 126 s later the cache has forgotten a; the wall clock stepped back to T.
  const replay = Protocol.verify({ ...a, lookup: look, nonces, now: T, mono: 126000 });
  assert.equal(replay.ok, false);
  assert.match(replay.error, /not newer/);
  assert.equal(Protocol.verify({ ...signed({ v: 1 }, { now: T + 1 }), lookup: look, nonces, now: T + 1, mono: 126001 }).ok, true, 'anything newer still passes');
  // A mark read back from disk (no highMono) has no nonces behind it at all.
  const restarted = { ...registry['devbox-a1b2c3'], highTs: T };
  assert.equal(Protocol.verify({ ...signed({ v: 1 }, { now: T }), lookup: () => restarted, nonces: Protocol.nonceCaches(), now: T, mono: 5 }).ok, false);
});

test('registry: the newest request replayed after its nonce expires is refused, end to end', async () => {
  let t = 1790000000000;
  let m = 0;
  const { R } = devices(tmp(), { now: () => t, mono: () => m });
  const p = R.pair('devbox');
  const req = signed(env(p.device.id, { kind: 'ping' }), { device: p.device.id, token: tokenOf(p), now: t });
  assert.equal((await call(R, req)).code, 200);
  m += 126000;
  assert.equal((await call(R, req)).code, 401, 'clock stepped back to the same moment, nonce forgotten');
});

test('registry: the high-water mark survives a restart', async () => {
  const root = tmp('ctl-desk-');
  let t = 1790000000000;
  const first = devices(root, { now: () => t }).R;
  const p = first.pair('devbox');
  const t0 = t;
  for (const at of [t0, t0 + 30000, t0 + 120000]) { t = at; assert.equal((await ping(first, p, at)).code, 200); }
  const stored = JSON.parse(fs.readFileSync(first.registryFile, 'utf8')).devices[0];
  assert.ok(stored.highTs >= t0 + 110000, `persisted ${stored.highTs - t0}`);
  t = t0 + 130000;
  const again = devices(root, { now: () => t }).R;
  const old = await ping(again, p, 1790000000000 + 30000);
  assert.equal(old.code, 401, 'within skew of a stepped-back clock, but older than the mark');
});

test('protocol: responses are signed over the request nonce, status and body', () => {
  const parts = { nonce: 'a'.repeat(32), status: 200, body: '{"ok":true}' };
  const sig = Protocol.signResponse(TOKEN, parts);
  assert.equal(Protocol.responseAuthentic(TOKEN, { ...parts, sig }), true);
  assert.equal(Protocol.responseAuthentic(TOKEN, { ...parts, status: 201, sig }), false);
  assert.equal(Protocol.responseAuthentic(TOKEN, { ...parts, body: '{"ok":false}', sig }), false);
  assert.equal(Protocol.responseAuthentic(TOKEN, { ...parts, nonce: 'b'.repeat(32), sig }), false);
  assert.equal(Protocol.responseAuthentic('cd'.repeat(32), { ...parts, sig }), false);
  assert.equal(Protocol.responseAuthentic(TOKEN, { ...parts, sig: undefined }), false);
});

test('protocol: safeEqualHex only compares well-formed digests', () => {
  const a = 'a'.repeat(64);
  assert.equal(Protocol.safeEqualHex(a, a), true);
  assert.equal(Protocol.safeEqualHex(a, 'b'.repeat(64)), false);
  assert.equal(Protocol.safeEqualHex(a, 'a'.repeat(63)), false);
  assert.equal(Protocol.safeEqualHex(a, null), false);
});

test('protocol: pairing codes, allowed urls, session ids', () => {
  assert.deepEqual(Protocol.parsePairingCode(`  ${Protocol.pairingCode('devbox-a1b2c3', TOKEN)}\n`), { device: 'devbox-a1b2c3', token: TOKEN });
  for (const bad of ['', 'buddy-pair-v1.devbox.short', `buddy-pair-v2.devbox-a1b2c3.${TOKEN}`, `buddy-pair-v1.Dev.${TOKEN}`]) assert.equal(Protocol.parsePairingCode(bad), null);
  for (const ok of ['http://127.0.0.1:47999', 'http://localhost:1', 'http://[::1]:5', 'http://100.101.102.103:47173', 'https://mac.tail1234.ts.net:47173', 'https://buddy.example.com']) assert.equal(Protocol.urlAllowed(ok), true, ok);
  for (const bad of ['http://mac.tail1234.ts.net:47173', 'http://192.168.1.4:47173', 'http://example.com', 'ftp://127.0.0.1', 'http://user:pw@127.0.0.1:1', 'http://100.128.0.1:1', 'nonsense']) assert.equal(Protocol.urlAllowed(bad), false, bad);
  for (const ok of ['abc', 'a.b-c_d', '0f1e2d3c-aaaa-bbbb']) assert.equal(Protocol.validSessionId(ok), true, ok);
  for (const bad of ['', '.', '..', '...', '../x', 'a/b', 'a\\b', 'x'.repeat(121), 7, null, '%2e%2e']) assert.equal(Protocol.validSessionId(bad), false, String(bad));
});

test('protocol: the display sanitiser drops control, zero-width, separator, bidi, tag and filler characters', () => {
  const nasty = [0x1b, 0x7f, 0x85, 0xad, 0x34f, 0x61c, 0x17b4, 0x17b5, 0x180e, 0x200b, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0x2800, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xfff9, 0xfffb, 0xe0000, 0xe0041, 0xe007f, 0xe0100, 0xe01ef];
  assert.equal(Protocol.displayString(`a${nasty.map((c) => String.fromCodePoint(c)).join('')}b`, 100), 'ab');
  assert.equal(Protocol.displayString(`a${ch(0xa0)}b${ch(0x202f)}c`, 100), 'a b c', 'no-break spaces read as spaces');
  const face = String.fromCodePoint(0x1f600);
  assert.equal(Protocol.displayString(`x${face}y`, 2), `x${face}`, 'cut by code point, never mid surrogate pair');
  assert.equal(Protocol.displayString(face.repeat(3), 1), face);
  assert.equal(Protocol.displayString('/srv/äpp', 100), '/srv/äpp');
  assert.equal(Protocol.displayString('x'.repeat(10), 4), 'xxxx');
});

// ── Device registry and the event route ─────────────────────────────────────
function devices(root = tmp(), opts = {}) {
  const changes = [];
  const R = createRemoteDevices({ rootDir: root, onChange: () => changes.push(1), ...opts });
  return { R, root, changes };
}
let seqN = 1;
const ev = (over = {}) => ({ source: 'claude', sessionId: 'sess-1', seq: seqN++, signal: 'tool-use', tool: 'Bash', cwd: '/home/me/proj', ...over });
const env = (device, over = {}) => ({ v: 1, kind: 'session', device, sentAt: new Date().toISOString(), events: [ev()], ...over });
const fileOf = (R, device, source, id) => path.join(R.remoteDir, device, `${createRemoteDevices.fileKey(source, id)}.json`);

// Drives handle() with a fake request stream.
function call(R, { headers, body }) {
  return new Promise((resolve) => {
    const { EventEmitter } = require('events');
    const req = new EventEmitter();
    req.headers = headers;
    req.destroy = () => {};
    R.handle(req, (code, text, hdrs = {}) => resolve({ code, json: JSON.parse(text), headers: hdrs, text }));
    req.emit('data', body);
    req.emit('end');
  });
}
const tokenOf = (paired) => Protocol.parsePairingCode(paired.code).token;
const ping = (R, paired, now) => call(R, signed(env(paired.device.id, { kind: 'ping' }), { device: paired.device.id, token: tokenOf(paired), now }));

test('registry: pairing mints a key shown once, stored 0600, never listed', () => {
  const { R, root } = devices();
  const r = R.pair('Dev Box');
  assert.match(r.device.id, /^dev-box-[0-9a-f]{6}$/);
  assert.equal(Protocol.parsePairingCode(r.code).device, r.device.id);
  assert.equal(fs.statSync(path.join(root, 'devices.json')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(R.list()).includes(tokenOf(r)), false);
  assert.equal(R.lookup(r.device.id).token, tokenOf(r));
  assert.match(R.pair('dev box').error, /already paired/);
  assert.match(R.pair('').error, /name/);
  assert.match(R.pair('<script>').error, /name/);
  // A device named like this machine would pass for a local session wherever hosts are compared.
  assert.match(R.pair(HOST.toUpperCase()).error, /own name/);
  assert.match(R.pair(os.hostname()).error, /own name/);
});

test('registry: a code unused for 10 minutes expires; once used it never does', async () => {
  let t = Date.parse('2026-09-30T10:00:00Z');
  const { R } = devices(tmp(), { now: () => t });
  const a = R.pair('alpha');
  const b = R.pair('beta');
  assert.equal(R.list().find((d) => d.id === a.device.id).pairing, 'waiting');
  t += 5 * 60000;
  assert.equal((await ping(R, a, t)).code, 200);
  t += 6 * 60000;
  assert.equal(R.lookup(b.device.id), null, 'b never used its code');
  assert.equal((await ping(R, b, t)).code, 401);
  t += 24 * 3600000;
  assert.equal((await ping(R, a, t)).code, 200);
  assert.deepEqual(Object.fromEntries(R.list().map((d) => [d.id, d.pairing])), { [a.device.id]: 'paired', [b.device.id]: 'expired' });
});

test('registry: revoking forgets the key and drops the device\'s sessions', () => {
  const { R, changes } = devices();
  const { device } = R.pair('devbox');
  assert.equal(R.apply(R.lookup(device.id), env(device.id)).status, 200);
  assert.equal(R.readSessions().length, 1);
  assert.equal(R.revoke(device.id), true);
  assert.equal(R.lookup(device.id), null);
  assert.equal(R.readSessions().length, 0);
  assert.equal(fs.existsSync(path.join(R.remoteDir, device.id)), false);
  assert.equal(R.revoke(device.id), false);
  assert.ok(changes.length >= 1);
});

test('registry: list counts live sessions only', () => {
  let t = Date.parse('2026-09-30T10:00:00Z');
  const { R } = devices(tmp(), { now: () => t });
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  R.apply(d, env(device.id, { events: [ev({ sessionId: 'a', seq: 5 }), ev({ sessionId: 'b', seq: 5 })] }), t);
  R.apply(d, env(device.id, { kind: 'heartbeat', sessions: [ev({ sessionId: 'a', seq: 5 })] }), t);
  assert.equal(R.list()[0].sessions, 2);
  t += createRemoteDevices.HEARTBEAT_TTL_MS + 1;
  assert.equal(R.list()[0].sessions, 1, 'a lapsed; b was never vouched for');
  assert.equal(R.list({ [device.id]: 7 })[0].sessions, 7, 'main.js passes its own count');
});

test('route: a revoked device\'s correctly signed request is refused, unsigned', async () => {
  const { R } = devices();
  const p = R.pair('devbox');
  R.revoke(p.device.id);
  const r = await call(R, signed(env(p.device.id), { device: p.device.id, token: tokenOf(p) }));
  assert.equal(r.code, 401);
  assert.equal(r.headers[Protocol.HEADERS.sig], undefined, 'nothing to sign with');
  assert.equal(fs.existsSync(path.join(R.remoteDir, p.device.id)), false);
});

test('route: answers to a verified request are signed with the device key', async () => {
  const { R } = devices();
  const p = R.pair('devbox');
  const req = signed(env(p.device.id, { kind: 'ping' }), { device: p.device.id, token: tokenOf(p) });
  const r = await call(R, req);
  assert.equal(r.code, 200);
  assert.equal(Protocol.responseAuthentic(tokenOf(p), { nonce: req.headers[Protocol.HEADERS.nonce], status: 200, body: r.text, sig: r.headers[Protocol.HEADERS.sig] }), true);
  const bad = await call(R, signed(env(p.device.id, { v: 9 }), { device: p.device.id, token: tokenOf(p) }));
  assert.equal(bad.code, 400);
  assert.ok(bad.headers[Protocol.HEADERS.sig], 'refusals are signed too');
});

test('route: each device is rate-limited on its own (10/s, burst 30)', async () => {
  const { R } = devices(tmp(), { mono: () => 1000 });
  const a = R.pair('alpha');
  const b = R.pair('beta');
  const codes = [];
  for (let i = 0; i < 31; i++) codes.push((await ping(R, a)).code);
  assert.equal(codes.filter((c) => c === 200).length, 30);
  assert.equal(codes[30], 429);
  assert.equal((await ping(R, b)).code, 200);
});

test('route: an oversized body is refused before it is verified', async () => {
  const { R } = devices();
  assert.equal((await call(R, { headers: {}, body: Buffer.alloc(Protocol.MAX_BODY_BYTES + 1, 32) })).code, 413);
});

test('terminal: a remote event carrying terminal-jump data is stripped, on ingest and on read', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  const terminal = { env: { TERM_PROGRAM: 'iTerm.app' }, tty: '/dev/ttys003', shellPid: 4242 };
  assert.equal(R.apply(d, env(device.id, { events: [ev({ terminal, hostApp: 'iTerm2', claudePid: 7 })] })).status, 200);
  const file = fileOf(R, device.id, 'claude', 'sess-1');
  assert.equal('terminal' in JSON.parse(fs.readFileSync(file, 'utf8')), false, 'never written');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), terminal, claudePid: 7, hostApp: 'iTerm2', sessionId: 'sess-1', remote: false, device: 'someone-else' }));
  const [s] = R.readSessions();
  assert.equal(s.terminal, undefined);
  assert.equal(s.claudePid, undefined);
  assert.equal(s.hostApp, undefined);
  assert.equal(s.remote, true);
  assert.equal(s.device, device.id);
  assert.match(s.sessionId, /^remote:/);
  R.apply(d, env(device.id, { events: [ev({ signal: 'stop' })] }));
  assert.equal('terminal' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
});

test('markers: localSessions drops a session carrying any one remote marker', () => {
  const { localSessions, isRemote } = createRemoteDevices;
  const list = [{ sessionId: 'a' }, { sessionId: 'b', remote: true }, { sessionId: 'c', device: 'devbox-1' }, { sessionId: 'remote:x:y' }, { sessionId: 'e', remote: false }];
  assert.deepEqual(localSessions(list).map((s) => s.sessionId), ['a', 'e']);
  assert.equal(isRemote(null), false);
});

// Everything in main.js that finds, jumps to or knocks on a terminal is handed local sessions only.
test('markers: main.js hands terminal lookups, roaming and actions local sessions only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const calls = src.match(/terminalForSessions\([^;]*;/g).filter((c) => !/^terminalForSessions,/.test(c));
  assert.ok(calls.length >= 2, 'roamAndKnock and the knock demo');
  for (const c of calls) assert.match(c, /^terminalForSessions\(localSessions\(/, c);
  assert.match(src, /require\('\.\/src\/terminal\.js'\)\(\{ getSessions: \(\) => localSessions\(/);
  assert.match(src, /const waiting = st\.pending\?\.length \|\| localSessions\(st\.sessions\)/);
  assert.match(src, /async function runAction\(action, st\) \{\n  const local = localSessions\(st\.sessions\);/);
  assert.match(src, /ipcMain\.handle\('go-to-needing-session', async \(\) => \{\n  const sessions = localSessions\(/);
  assert.match(src, /async function jumpToNeeding\(\) \{\n  const sessions = localSessions\(/);
});

test('namespace: a remote session named like a local one never touches the local file', () => {
  const { R, root } = devices();
  const localDir = path.join(root, 'sessions');
  fs.mkdirSync(localDir, { recursive: true });
  const localFile = path.join(localDir, `${HOST}-sess-1.json`);
  fs.writeFileSync(localFile, JSON.stringify({ sessionId: 'sess-1', signal: 'stop', cwd: '/local' }));
  const before = fs.readFileSync(localFile, 'utf8');
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  assert.equal(R.apply(d, env(device.id)).status, 200);
  assert.equal(R.apply(d, env(device.id, { events: [ev({ signal: 'session-end' })] })).status, 200);
  assert.equal(R.apply(d, env(device.id)).status, 200);
  assert.equal(fs.readFileSync(localFile, 'utf8'), before);
  const [s] = R.readSessions();
  assert.equal(s.sessionId, `remote:${device.id}:claude-sess-1`);
  assert.equal(s.logId, `${device.id}:sess-1`);
});

test('namespace: ids differing only in case are two sessions, two files', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  R.apply(R.lookup(device.id), env(device.id, { events: [ev({ sessionId: 'Case', signal: 'stop' }), ev({ sessionId: 'case', signal: 'tool-use' })] }));
  assert.deepEqual(Object.fromEntries(R.readSessions().map((s) => [s.remoteId, s.signal])), { Case: 'stop', case: 'tool-use' });
  assert.equal(fs.readdirSync(path.join(R.remoteDir, device.id)).filter((f) => f.endsWith('.json')).length, 2);
});

test('namespace: ids that could leave the device directory are refused, nothing written', () => {
  const { R, root } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  for (const sessionId of ['../x', '..', '../../sessions/evil', 'a/b', '/etc/passwd', '..\\x', '', 'x'.repeat(200)]) {
    assert.equal(R.apply(d, env(device.id, { events: [ev({ sessionId })] })).status, 400, sessionId);
  }
  for (const source of ['../claude', 'Claude', '', 'x'.repeat(30)]) assert.equal(R.apply(d, env(device.id, { events: [ev({ source })] })).status, 400, source);
  for (const seq of [0, -1, 1.5, '7', null, 2 ** 60]) assert.equal(R.apply(d, env(device.id, { events: [ev({ seq })] })).status, 400, String(seq));
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).filter((f) => !f.startsWith('devices.json')), []);
});

test('namespace: one device cannot write for another, even with a valid signature of its own', async () => {
  const { R } = devices();
  const a = R.pair('alpha');
  const b = R.pair('beta');
  const r = await call(R, signed(env(b.device.id), { device: a.device.id, token: tokenOf(a) }));
  assert.equal(r.code, 400);
  assert.match(r.json.error, /does not match/);
  assert.equal(R.readSessions().length, 0);
  assert.equal((await call(R, signed(env(b.device.id), { device: b.device.id, token: tokenOf(a) }))).code, 401);
});

test('events: the whole batch, session cap included, is checked before anything is written', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  assert.equal(R.apply(d, env(device.id, { events: [ev(), ev({ signal: 'rm-rf' })] })).status, 400);
  assert.equal(R.readSessions().length, 0, 'the good event was not applied either');
  for (let i = 0; i < createRemoteDevices.MAX_SESSIONS_PER_DEVICE - 1; i++) R.apply(d, env(device.id, { events: [ev({ sessionId: `s${i}` })] }));
  assert.equal(R.apply(d, env(device.id, { events: [ev({ sessionId: 'new-1' }), ev({ sessionId: 'new-2' })] })).status, 429);
  assert.equal(R.readSessions().some((s) => /^new-/.test(s.remoteId)), false, 'not even the one that fitted');
  assert.equal(R.apply(d, env(device.id, { events: [ev({ sessionId: 'new-1' })] })).status, 200, 'one alone still fits');
  assert.equal(R.apply(d, env(device.id, { events: [ev({ sessionId: 's0', signal: 'stop' })] })).status, 200, 'existing ones still update');
  assert.equal(R.apply(d, env(device.id, { v: 2 })).status, 400);
  assert.equal(R.apply(d, env(device.id, { kind: 'exec' })).status, 400);
  assert.equal(R.apply(d, env(device.id, { events: [] })).status, 400);
  assert.equal(R.apply(d, env(device.id, { events: Array(9).fill(0).map(() => ev()) })).status, 400);
  assert.deepEqual(R.apply(d, env(device.id, { kind: 'ping' })).body, { ok: true, name: 'devbox' });
});

test('events: out-of-order events are dropped by seq, and an ended session stays ended', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  R.apply(d, env(device.id, { events: [ev({ seq: 100, signal: 'stop' })] }));
  assert.deepEqual(R.apply(d, env(device.id, { events: [ev({ seq: 99, signal: 'tool-use' })] })).body, { ok: true, applied: 0 });
  assert.equal(R.readSessions()[0].signal, 'stop');
  R.apply(d, env(device.id, { events: [ev({ seq: 101, signal: 'tool-use' })] }));
  assert.equal(R.readSessions()[0].signal, 'tool-use');
  R.apply(d, env(device.id, { events: [ev({ seq: 110, signal: 'session-end' })] }));
  R.apply(d, env(device.id, { events: [ev({ seq: 105, signal: 'tool-done' })] }));
  assert.equal(R.readSessions().length, 0, 'a late event can\'t resurrect it');
  R.apply(d, env(device.id, { events: [ev({ seq: 111, signal: 'session-start' })] }));
  assert.equal(R.readSessions().length, 1, 'a newer start can');
});

test('ordering: a session-end older than what the desktop holds is dropped', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  R.apply(d, env(device.id, { events: [ev({ seq: 200, signal: 'tool-use' })] }));
  assert.deepEqual(R.apply(d, env(device.id, { events: [ev({ seq: 150, signal: 'session-end' })] })).body, { ok: true, applied: 0 });
  assert.equal(R.readSessions().length, 1, 'a stale end arriving late does not end the live session');
  R.apply(d, env(device.id, { events: [ev({ seq: 201, signal: 'session-end' })] }));
  assert.equal(R.readSessions().length, 0);
});

test('ordering: an ended session stays ended across a desktop restart', () => {
  const root = tmp('ctl-desk-');
  const first = devices(root).R;
  const { device } = first.pair('devbox');
  first.apply(first.lookup(device.id), env(device.id, { events: [ev({ seq: 300, signal: 'tool-use' })] }));
  first.apply(first.lookup(device.id), env(device.id, { events: [ev({ seq: 310, signal: 'session-end' })] }));
  assert.equal(fs.statSync(path.join(first.remoteDir, device.id, 'ended')).mode & 0o777, 0o600);
  const again = devices(root).R;
  const d = again.lookup(device.id);
  assert.deepEqual(again.apply(d, env(device.id, { events: [ev({ seq: 305, signal: 'tool-done' })] })).body, { ok: true, applied: 0 });
  assert.equal(again.readSessions().length, 0, 'the late event did not resurrect it');
  again.apply(d, env(device.id, { events: [ev({ seq: 311, signal: 'session-start' })] }));
  assert.equal(again.readSessions().length, 1, 'a newer start still can');
  assert.equal(again.list()[0].sessions, 1, 'the tombstone file is not counted as a session');
});

test('atomicity: a batch whose second session is locked writes neither', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  R.apply(d, env(device.id, { events: [ev({ sessionId: 'a', seq: 10 }), ev({ sessionId: 'b', seq: 10 })] }));
  const lockB = `${fileOf(R, device.id, 'claude', 'b')}.lock`;
  fs.writeFileSync(lockB, 'someone');
  const r = R.apply(d, env(device.id, { events: [ev({ sessionId: 'a', seq: 20, signal: 'stop' }), ev({ sessionId: 'b', seq: 20, signal: 'stop' })] }));
  fs.rmSync(lockB);
  assert.equal(r.status, 503);
  assert.deepEqual(R.readSessions().map((s) => s.signal).sort(), ['tool-use', 'tool-use'], 'a was not written either');
  assert.equal(fs.existsSync(`${fileOf(R, device.id, 'claude', 'a')}.lock`), false, 'and its lock was released');
});

test('events: remote strings are display-only; pids, host apps and blocking asks are never taken', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  R.apply(d, env(device.id, { events: [ev({ signal: 'permission-ask', askKind: 'request', cwd: `/x${ch(0x1b)}[2J${ch(0x202e)}evil${ch(0x2028)}`, tool: `Bash${ch(10)}rm`, pid: 1234, hostApp: 'Terminal', claudePid: 99 })] }));
  const [s] = R.readSessions();
  assert.equal(s.cwd, '/x[2Jevil');
  assert.equal(s.tool, 'Bashrm');
  assert.equal(s.askKind, 'notification');
  assert.equal(s.claudePid, undefined);
  assert.equal(s.hostApp, undefined);
  assert.equal(s.host, 'devbox');
  assert.equal(s.deviceName, 'devbox');
  assert.equal(s.via, 'remote');
  R.apply(d, env(device.id, { events: [ev({ signal: 'permission-ask', askKind: 'question' })] }));
  assert.equal(R.readSessions()[0].askKind, 'question');
});

test('events: a background agent\'s tool call after the turn ended stays bookkeeping', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  R.apply(d, env(device.id, { events: [ev({ signal: 'stop' })] }));
  R.apply(d, env(device.id, { events: [ev({ signal: 'tool-use', fromSubagent: true })] }));
  assert.equal(R.readSessions()[0].signal, 'stop');
});

test('events: a session whose file is locked answers 503 at once rather than waiting', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  R.apply(d, env(device.id));
  const file = fileOf(R, device.id, 'claude', 'sess-1');
  fs.writeFileSync(`${file}.lock`, 'someone');
  const start = Date.now();
  assert.equal(R.apply(d, env(device.id, { events: [ev({ signal: 'stop' })] })).status, 503);
  assert.ok(Date.now() - start < 100);
  fs.rmSync(`${file}.lock`);
});

test('events: a burst of writes refreshes the widget once', async () => {
  const { R, changes } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  for (let i = 0; i < 5; i++) R.apply(d, env(device.id));
  assert.equal(changes.length, 0);
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(changes.length, 1);
});

test('heartbeat: rebuilds a session the desktop missed, and never overwrites newer news', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  const t0 = Date.parse('2026-09-30T10:00:00Z');
  const snap = (over) => ({ source: 'claude', sessionId: 'lost', seq: 500, signal: 'permission-ask', tool: 'Bash', cwd: '/srv', updatedAt: '2026-09-30T09:59:00Z', ...over });
  assert.equal(R.apply(d, env(device.id, { kind: 'heartbeat', sessions: [snap()] }), t0).status, 200);
  let [s] = R.readSessions();
  assert.equal(s.signal, 'permission-ask');
  assert.equal(s.heartbeatMode, true);
  R.apply(d, env(device.id, { events: [ev({ sessionId: 'lost', seq: 600, signal: 'stop' })] }), t0 + 1000);
  R.apply(d, env(device.id, { kind: 'heartbeat', sessions: [snap({ seq: 550, signal: 'tool-use' })] }), t0 + 2000);
  [s] = R.readSessions();
  assert.equal(s.signal, 'stop', 'the snapshot was older than the event');
  assert.equal(s.heartbeatAt, new Date(t0 + 2000).toISOString(), 'but it still vouches the session is alive');
  R.apply(d, env(device.id, { kind: 'heartbeat', sessions: [snap({ seq: 700, signal: 'tool-use' })] }), t0 + 3000);
  assert.equal(R.readSessions()[0].signal, 'tool-use');
  for (const bad of [[snap({ sessionId: '../a' })], [snap({ signal: 'session-end' })], [snap({ seq: 0 })], ['a']]) {
    assert.equal(R.apply(d, env(device.id, { kind: 'heartbeat', sessions: bad })).status, 400);
  }
});

test('liveness: only heartbeat-vouched sessions go stale by heartbeat age, on this clock', () => {
  const { R } = devices();
  const { device } = R.pair('devbox');
  const d = R.lookup(device.id);
  const t0 = Date.parse('2026-09-30T10:00:00Z');
  R.apply(d, env(device.id, { events: [ev({ sessionId: 'a', seq: 10 }), ev({ sessionId: 'b', seq: 10 })] }), t0);
  R.apply(d, env(device.id, { kind: 'heartbeat', sessions: [ev({ sessionId: 'a', seq: 10 })] }), t0);
  const byId = () => Object.fromEntries(R.readSessions().map((s) => [s.remoteId, s]));
  const TTL = createRemoteDevices.HEARTBEAT_TTL_MS;
  assert.equal(R.isGone(byId().a, t0 + TTL - 1), false);
  assert.equal(R.isGone(byId().a, t0 + TTL + 1), true);
  assert.equal(R.isGone(byId().b, t0 + TTL * 100), false, 'never vouched for: the usual stale windows apply');
  R.apply(d, env(device.id, { events: [ev({ sessionId: 'a', seq: 11 })] }), t0 + TTL);
  assert.equal(R.isGone(byId().a, t0 + TTL + 1000), false);
  const c = Rules.classifySession(byId().a, { now: t0 + 3 * TTL, isGone: () => R.isGone(byId().a, t0 + 3 * TTL), workingStaleMs: 6e5, waitingStaleMs: 1.44e7 });
  assert.equal(c.dropped, 'gone');
});

// ── Tailscale address ───────────────────────────────────────────────────────
// Shaped like a real Mac with Tailscale on utun6 and a stale look-alike on utun0.
const MAC = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0' }],
  en0: [{ address: '192.168.3.178', family: 'IPv4', internal: false, netmask: '255.255.240.0' }],
  utun0: [{ address: '100.100.254.82', family: 'IPv4', internal: false, netmask: '255.255.255.255' }, { address: 'fd7a:115c:a1e0::735:fe54', family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' }],
  utun6: [{ address: '100.93.49.107', family: 'IPv4', internal: false, netmask: '255.255.255.255' }, { address: 'fd7a:115c:a1e0::c835:316c', family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff::' }],
};

test('tailnet: the Tailscale CLI decides between look-alike interfaces', () => {
  const { chooseTailnet, tailnetCandidates } = createRemoteDevices;
  assert.equal(tailnetCandidates(MAC, 'darwin').length, 2);
  assert.deepEqual(chooseTailnet({ ifaces: MAC, cliIp: '100.93.49.107', platform: 'darwin' }), { address: '100.93.49.107' });
  assert.match(chooseTailnet({ ifaces: MAC, cliIp: null, platform: 'darwin' }).error, /Several interfaces/);
  assert.match(chooseTailnet({ ifaces: MAC, cliIp: '100.64.0.9', platform: 'darwin' }).error, /no Tailscale interface carries it/);
  assert.deepEqual(chooseTailnet({ ifaces: { utun6: MAC.utun6 }, platform: 'darwin' }), { address: '100.93.49.107' });
});

test('tailnet: a CGNAT address off a Tailscale interface is refused, and none means no listener', () => {
  const { chooseTailnet } = createRemoteDevices;
  const fake = { en0: [{ address: '100.88.1.2', family: 'IPv4', internal: false, netmask: '255.255.255.255' }], utun3: [{ address: '100.88.1.3', family: 'IPv4', internal: false, netmask: '255.255.255.0' }, { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }] };
  assert.match(chooseTailnet({ ifaces: fake, platform: 'darwin' }).error, /is not a Tailscale interface/);
  assert.match(chooseTailnet({ ifaces: { en0: MAC.en0 }, platform: 'darwin' }).error, /No Tailscale address/);
  assert.deepEqual(chooseTailnet({ ifaces: { tailscale0: MAC.utun6, utun6: MAC.utun6 }, platform: 'linux' }), { address: '100.93.49.107' });
  const { R } = devices();
  const st = R.setTailnet(true, 47173, { ifaces: { en0: MAC.en0 }, platform: 'darwin' });
  assert.equal(st.listening, false);
  assert.match(st.error, /Tailscale/);
  assert.match(R.setTailnet(true, Number('x'), { ifaces: MAC }).error, /not a port/);
  assert.equal(R.setTailnet(false, 0).listening, false);
});

// ── Listeners ───────────────────────────────────────────────────────────────
async function deviceListener(root = tmp('ctl-desk-')) {
  const port = await freePort();
  const { R } = devices(root);
  R.listenLoopback(port);
  await waitFor(() => R.loopbackStatus().listening);
  return { R, port, close: () => R.closeLoopback() };
}

test('listener: reports listening, a port in use, and a bad port without throwing', async () => {
  const desk = await deviceListener();
  try {
    assert.deepEqual(desk.R.loopbackStatus(), { listening: true, port: desk.port, error: null });
    const { R } = devices();
    R.listenLoopback(desk.port);
    assert.match(await waitFor(() => R.loopbackStatus().error), /EADDRINUSE/);
    const { R: R2 } = devices();
    assert.match(R2.listenLoopback(NaN).error, /not a port/);
    assert.match(R2.listenLoopback(70000).error, /not a port/);
  } finally { desk.close(); }
});

test('listener: a slowloris client is cut off within 6 s', async () => {
  const desk = await deviceListener();
  try {
    const start = Date.now();
    const sock = net.connect(desk.port, '127.0.0.1');
    sock.on('error', () => {});
    // Read what the server sends (its 408), or 'close' waits on us, not it.
    sock.resume();
    sock.write('POST /remote/event HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    const drip = setInterval(() => { try { sock.write('X-Slow: 1\r\n'); } catch {} }, 500);
    await new Promise((r) => sock.on('close', r));
    clearInterval(drip);
    assert.ok(Date.now() - start <= 6000, `closed after ${Date.now() - start} ms`);
  } finally { desk.close(); }
});

// ── Transport ───────────────────────────────────────────────────────────────
test('transport: each transport validates its own fields; hub is not built', () => {
  assert.equal(Transport.validate({ url: 'http://example.com', device: 'd', token: TOKEN }), null);
  assert.equal(Transport.validate({ url: 'http://127.0.0.1:1', device: 'd', token: TOKEN, transport: 'hub' }), null);
  assert.equal(Transport.validate({ url: 'http://127.0.0.1:1', device: 'd', token: 'short' }), null);
  assert.deepEqual(Transport.validate({ url: 'http://127.0.0.1:1/x', device: 'd', token: TOKEN, timeoutMs: 1e9, extra: 1 }), { transport: 'direct', device: 'd', token: TOKEN, timeoutMs: 2000, url: 'http://127.0.0.1:1' });
  const open = tmp('ctl-sock-');
  fs.chmodSync(open, 0o755);
  assert.equal(Transport.validate({ socketPath: path.join(open, 's.sock'), device: 'd', token: TOKEN }), null, 'a socket in a directory others can enter');
  assert.equal(Transport.validate({ socketPath: 'relative.sock', device: 'd', token: TOKEN }), null);
  const priv = tmp('ctl-sock-');
  fs.chmodSync(priv, 0o700);
  assert.equal(Transport.validate({ socketPath: path.join(priv, 's.sock'), device: 'd', token: TOKEN }).socketPath, path.join(priv, 's.sock'));
});

test('transport: send settles within its timeout against a server that never answers', async () => {
  const hang = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => hang.once('listening', r));
  const start = Date.now();
  const r = await Transport.create({ url: `http://127.0.0.1:${hang.address().port}`, device: 'devbox-a1b2c3', token: TOKEN, timeoutMs: 150 }).send({ v: 1 });
  assert.equal(r.error, 'timeout');
  assert.ok(Date.now() - start < 1000);
  hang.close();
});

test('transport: an unsigned 200 (a squatter on the tunnel port) is a failure', async () => {
  const fake = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"name":"devbox"}'); }); }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  try {
    const r = await Transport.create({ url: `http://127.0.0.1:${fake.address().port}`, device: 'devbox-a1b2c3', token: TOKEN }).send({ v: 1, kind: 'ping' });
    assert.equal(r.status, 200);
    assert.equal(r.authentic, false);
    assert.equal(r.ok, false);
    assert.equal(r.body, null, 'an unauthenticated body is not even parsed');
  } finally { fake.close(); }
});

test('transport: end to end over a unix socket in a private directory', async () => {
  const dir = tmp('ctl-sock-');
  fs.chmodSync(dir, 0o700);
  const sock = path.join(dir, 'buddy.sock');
  const desk = await deviceListener();
  // What `ssh -R <sock>:127.0.0.1:47173` gives the reporter: a socket that reaches the listener.
  const bridge = net.createServer((c) => { const up = net.connect(desk.port, '127.0.0.1'); c.pipe(up).pipe(c); up.on('error', () => c.destroy()); c.on('error', () => up.destroy()); }).listen(sock);
  await new Promise((r) => bridge.once('listening', r));
  try {
    const home = tmp('ctl-reporter-');
    const pc = Protocol.parsePairingCode(desk.R.pair('devbox').code);
    Remote.saveConfig(home, { transport: 'direct', socketPath: sock, device: pc.device, token: pc.token });
    const r = await Remote.send('ping', {}, { rootDir: home, ignoreBackoff: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.body, { ok: true, name: 'devbox' });
  } finally { bridge.close(); desk.close(); }
});

// ── Reporter side ───────────────────────────────────────────────────────────
test('reporter: only the signal, seq, tool name and folder leave the machine', () => {
  const w = Remote.wireEvent('claude', { signal: 'tool-use', sessionId: 'a/b', seq: 42, tool: 'Bash', cwd: '/p', pid: 42, extra: { raw: 'tool-use', via: 'tool-use', askKind: null, fromSubagent: true, tool_input: { command: 'secret' } }, payload: { prompt: 'secret' } });
  assert.deepEqual(w, { source: 'claude', sessionId: 'a_b', seq: 42, signal: 'tool-use', tool: 'Bash', cwd: '/p', askKind: null, via: 'tool-use', fromSubagent: true });
});

test('reporter: seq only goes up', () => {
  assert.equal(Remote.nextSeq(undefined, 1000), 1000);
  assert.equal(Remote.nextSeq(5000, 1000), 5001, 'a clock behind the last seq still moves forward');
  assert.equal(Remote.nextSeq(999, 1000), 1000);
});

test('reporter: remote.json is written 0600 and validated on load', () => {
  const root = tmp();
  assert.equal(Remote.loadConfig(root), null);
  Remote.saveConfig(root, { url: 'http://127.0.0.1:47999', device: 'devbox-a1b2c3', token: TOKEN, timeoutMs: 99999 });
  assert.equal(fs.statSync(Remote.configPath(root)).mode & 0o777, 0o600);
  assert.equal(Remote.loadConfig(root).timeoutMs, 2000);
  Remote.saveConfig(root, { url: 'http://evil.example:80', device: 'devbox-a1b2c3', token: TOKEN });
  assert.equal(Remote.loadConfig(root), null);
});

test('reporter: heartbeat snapshots live sessions it wrote, and sweeps its own old dead ones', () => {
  const root = tmp();
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir);
  const put = (name, s) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ host: HOST, source: 'claude', signal: 'tool-use', remoteSeq: 5, ...s }));
  put('a.json', { sessionId: 'alive', claudePid: process.pid, cwd: '/srv', tool: 'Bash', updatedAt: '2026-09-30T10:00:00.000Z' });
  put('b.json', { sessionId: 'dead', claudePid: 2 ** 22 + 12345 });
  put('c.json', { sessionId: 'nopid' });
  put('d.json', { sessionId: 'elsewhere', claudePid: process.pid, host: 'another-host' });
  put('e.json', { sessionId: 'not-mine', claudePid: process.pid, remoteSeq: undefined });
  put('f.json', { sessionId: 'old-dead', claudePid: 2 ** 22 + 12346 });
  const old = new Date(Date.now() - Remote.SWEEP_AFTER_MS - 60000);
  fs.utimesSync(path.join(dir, 'f.json'), old, old);
  assert.deepEqual(Remote.liveSessions(root), [{ source: 'claude', sessionId: 'alive', seq: 5, signal: 'tool-use', tool: 'Bash', cwd: '/srv', updatedAt: '2026-09-30T10:00:00.000Z' }]);
  assert.equal(fs.existsSync(path.join(dir, 'f.json')), false, 'swept');
  assert.equal(fs.existsSync(path.join(dir, 'b.json')), true, 'dead but recent: kept');
  assert.equal(fs.existsSync(path.join(dir, 'e.json')), true, 'not a reporter file: never touched');
});

test('reporter: agentPid walks one ps listing past shells, and trusts a cached pid', () => {
  const ps = '    1     0 launchd\n  500     1 claude\n  600   500 /bin/zsh\n  700   600 -bash\n';
  const unix = process.platform !== 'win32';
  assert.equal(Remote.agentPid(null, 700, ps), unix ? 500 : null);
  assert.equal(Remote.agentPid(null, 500, ps), unix ? 500 : null);
  assert.equal(Remote.agentPid(null, 999, ps), null);
  assert.equal(Remote.agentPid(null, 1), null);
  assert.equal(Remote.agentPid(4242, 4242), unix ? 4242 : null);
});

test('reporter hooks: every Claude Code event runs emit.js; set-status and foreign hooks are left alone', () => {
  const { apply, strip, Claude, Runtime } = Remote.reporterHooks();
  const rt = Runtime.make({ execPath: null, hooksDir: '/opt/buddy/hooks', dataDir: '/home/me/.claude-traffic-light' });
  const foreign = { matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] };
  const desktop = Claude.apply({ hooks: { Stop: [foreign] } }, rt);
  const once = apply(desktop, rt);
  assert.deepEqual(apply(once, rt), once, 'idempotent');
  for (const [event] of Claude.HOOK_EVENTS) {
    const cmds = once.hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.includes(`node "/opt/buddy/hooks/emit.js" --adapter claude ${event}`), event);
    assert.ok(cmds.some((c) => c.includes('set-status.js')), `${event}: the app's own hook stays`);
  }
  assert.deepEqual(strip(once), desktop, 'unpair leaves exactly what the app installed');
});

test('reporter: a Buddy app on the same machine is detected', () => {
  const home = tmp('ctl-home-');
  const root = tmp('ctl-root-');
  assert.equal(Remote.localBuddy({ home, rootDir: root }), null);
  fs.writeFileSync(path.join(root, 'port'), '47172');
  assert.match(Remote.localBuddy({ home, rootDir: root }), /running here/);
  fs.rmSync(path.join(root, 'port'));
  const { Claude, Runtime } = Remote.reporterHooks();
  Runtime.writeJsonConfig(Claude.configPath(home), Claude.apply({}, Runtime.make({ execPath: null, hooksDir: '/opt/buddy/hooks', dataDir: root })));
  assert.match(Remote.localBuddy({ home, rootDir: root }), /hooks are installed/);
});

test('reporter: http to a Tailscale address needs this machine on the tailnet', () => {
  const on = { utun6: MAC.utun6 };
  const off = { en0: MAC.en0 };
  assert.equal(Remote.routeProblem({ url: 'http://100.93.49.107:47173' }, on), null);
  assert.match(Remote.routeProblem({ url: 'http://100.93.49.107:47173' }, off), /this machine has none/);
  assert.equal(Remote.routeProblem({ url: 'http://127.0.0.1:47173' }, off), null);
  assert.equal(Remote.routeProblem({ socketPath: '/x' }, off), null);
});

function runCli(args, { home, root, stdin = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REMOTE_CLI, ...args], { env: { ...process.env, HOME: home, CLAUDE_TRAFFIC_LIGHT_HOME: root, BUDDY_PAIRING_CODE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(stdin);
  });
}

test('cli: pair refuses beside a Buddy app unless forced, and never prints server text raw', async () => {
  const home = tmp('ctl-home-');
  const root = tmp('ctl-root-');
  fs.writeFileSync(path.join(root, 'port'), '47172');
  const code = Protocol.pairingCode('devbox-a1b2c3', TOKEN);
  const refused = await runCli(['pair', 'http://127.0.0.1:1'], { home, root, stdin: code });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /--force/);
  assert.equal(fs.existsSync(path.join(root, 'remote.json')), false);
  // A squatter answering with a terminal escape.
  const evil = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `x${ch(0x1b)}]0;pwned${ch(7)}` })); }); }).listen(0, '127.0.0.1');
  await new Promise((r) => evil.once('listening', r));
  try {
    const forced = await runCli(['pair', `http://127.0.0.1:${evil.address().port}`, '--force', '--no-hooks'], { home, root, stdin: code });
    assert.equal(forced.code, 0);
    assert.match(forced.out, /not your Buddy/);
    assert.equal(forced.out.includes(ch(0x1b)), false);
  } finally { evil.close(); }
});

// ── Hooks end to end ────────────────────────────────────────────────────────
function runEmit(home, args, stdin = '') {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn(process.execPath, [EMIT, ...args], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_SESSION_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('exit', (code) => resolve({ code, ms: Number(process.hrtime.bigint() - start) / 1e6 }));
    child.stdin.end(stdin);
  });
}
const payload = (over = {}) => JSON.stringify({ session_id: 'remote-sess-1', cwd: '/srv/app', tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/id_rsa' }, prompt: 'top secret', ...over });

function pairReporter(desk, name = 'devbox') {
  const { device, token } = Protocol.parsePairingCode(desk.R.pair(name).code);
  const home = tmp('ctl-reporter-');
  Remote.saveConfig(home, { url: `http://127.0.0.1:${desk.port}`, device, token, transport: 'direct' });
  return { home, device, token };
}
const one = (R) => R.readSessions()[0];

test('e2e: a hook on the reporter lights a namespaced session on the desktop; the payload stays home', async () => {
  const desk = await deviceListener();
  try {
    const rep = pairReporter(desk);
    assert.equal((await runEmit(rep.home, ['--adapter', 'claude', 'PreToolUse'], payload())).code, 0);
    const s = await waitFor(() => one(desk.R));
    assert.ok(s, 'session appeared');
    assert.equal(s.sessionId, `remote:${rep.device}:claude-remote-sess-1`);
    assert.equal(s.signal, 'tool-use');
    assert.equal(s.cwd, '/srv/app');
    assert.ok(Protocol.validSeq(s.remoteSeq));
    const stored = fs.readFileSync(fileOf(desk.R, rep.device, 'claude', 'remote-sess-1'), 'utf8');
    assert.equal(/id_rsa|top secret/.test(stored), false);
    const local = SessionState.readJson(path.join(rep.home, 'sessions', `${HOST}-remote-sess-1.json`));
    assert.equal(local.remoteSeq, s.remoteSeq, 'the reporter keeps the seq it sent');
    await runEmit(rep.home, ['--adapter', 'claude', 'Stop'], payload());
    assert.ok(await waitFor(() => one(desk.R)?.signal === 'stop'));
    await runEmit(rep.home, ['--adapter', 'claude', 'SessionEnd'], payload());
    assert.ok(await waitFor(() => desk.R.readSessions().length === 0));
    await runEmit(rep.home, ['stop', '--source', 'Aider', '--session', 'x1', '--cwd', '/w']);
    assert.ok(await waitFor(() => one(desk.R)?.sessionId === `remote:${rep.device}:custom-x1`), 'bare signals forward, source lowered');
  } finally { desk.close(); }
});

test('e2e: over HTTP, a browser Origin and a replayed request are refused; nothing but the device route is served', async () => {
  const desk = await deviceListener();
  try {
    const rep = pairReporter(desk);
    const body = JSON.stringify(env(rep.device));
    const headers = Protocol.signedHeaders({ device: rep.device, token: rep.token, body: Buffer.from(body) });
    const post = (p, h) => fetch(`http://127.0.0.1:${desk.port}${p}`, { method: 'POST', headers: h, body });
    assert.equal((await post('/remote/event', { ...headers, origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/remote/event', headers)).status, 200);
    assert.equal((await post('/remote/event', headers)).status, 401, 'replay');
    for (const p of ['/signal', '/hook/claude']) assert.equal((await post(p, headers)).status, 404, p);
    assert.equal((await fetch(`http://127.0.0.1:${desk.port}/status`)).status, 404, 'no session list for the far end of a tunnel');
  } finally { desk.close(); }
});

test('e2e: ping and heartbeat talk to the desktop, and the heartbeat resyncs a lost session', async () => {
  const desk = await deviceListener();
  try {
    const rep = pairReporter(desk);
    await runEmit(rep.home, ['--adapter', 'claude', 'UserPromptSubmit'], payload());
    assert.ok(await waitFor(() => one(desk.R)));
    const r = await Remote.send('ping', {}, { rootDir: rep.home, ignoreBackoff: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.body, { ok: true, name: 'devbox' });
    // The heartbeat vouches only for sessions whose agent pid is on file; a
    // ps that timed out under load leaves none, so give the hook another go.
    const localFile = path.join(rep.home, 'sessions', `${HOST}-remote-sess-1.json`);
    for (let i = 0; i < 3 && !SessionState.readJson(localFile)?.claudePid; i++) await runEmit(rep.home, ['--adapter', 'claude', 'UserPromptSubmit'], payload());
    assert.ok(SessionState.readJson(localFile).claudePid, 'the reporter recorded the agent pid');
    // Let any sender still in flight land before the desktop "loses" the session.
    await new Promise((r) => setTimeout(r, 300));
    // The desktop loses the session (restart, missed events); the heartbeat brings it back.
    fs.rmSync(path.join(desk.R.remoteDir, rep.device), { recursive: true });
    assert.equal(desk.R.readSessions().length, 0);
    let s;
    for (const end = Date.now() + 2000; !s && Date.now() < end;) {
      assert.equal((await Remote.heartbeat({ rootDir: rep.home })).ok, true);
      s = one(desk.R);
      if (!s) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(s, 'the heartbeat rebuilt the session');
    assert.equal(s.signal, 'prompt-submit');
    assert.equal(s.heartbeatMode, true);
  } finally { desk.close(); }
});

// Paired, a hook costs a spawn, not a round trip; unpaired, nothing changes.
test('hook: exits 0 fast paired and unpaired; latencies are reported', async () => {
  const hang = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => hang.once('listening', r));
  try {
    const plain = tmp('ctl-plain-');
    const paired = tmp('ctl-reporter-');
    Remote.saveConfig(paired, { url: `http://127.0.0.1:${hang.address().port}`, device: 'devbox-a1b2c3', token: TOKEN, timeoutMs: 2000 });
    const times = { unpaired: [], paired: [] };
    for (let i = 0; i < 3; i++) {
      const u = await runEmit(plain, ['--adapter', 'claude', 'PreToolUse'], payload({ session_id: `u${i}` }));
      const p = await runEmit(paired, ['--adapter', 'claude', 'PreToolUse'], payload({ session_id: `p${i}` }));
      assert.equal(u.code, 0);
      assert.equal(p.code, 0);
      times.unpaired.push(Math.round(u.ms));
      times.paired.push(Math.round(p.ms));
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[1];
    console.log(`# hook latency (median of 3): unpaired ${med(times.unpaired)} ms, paired against a desktop that never answers ${med(times.paired)} ms`);
    assert.ok(med(times.paired) < 1000, 'far under the 2 s send timeout: the hook did not wait for it');
    assert.equal(fs.existsSync(path.join(plain, 'remote-state.json')), false);
    assert.equal(SessionState.readJson(path.join(plain, 'sessions', `${HOST}-u0.json`)).claudePid, undefined, 'unpaired: no pid lookup');
  } finally { hang.close(); }
});

test('hook: an unreachable desktop backs off: the next hook sends nothing', async () => {
  let connections = 0;
  const hang = net.createServer(() => { connections += 1; }).listen(0, '127.0.0.1');
  await new Promise((r) => hang.once('listening', r));
  try {
    const home = tmp('ctl-reporter-');
    Remote.saveConfig(home, { url: `http://127.0.0.1:${hang.address().port}`, device: 'devbox-a1b2c3', token: TOKEN, timeoutMs: 200 });
    await runEmit(home, ['--adapter', 'claude', 'PreToolUse'], payload());
    assert.ok(await waitFor(() => Remote.backingOff(home), 3000), 'the detached sender recorded the silence');
    assert.equal(connections, 1);
    await runEmit(home, ['--adapter', 'claude', 'PostToolUse'], payload());
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connections, 1, 'backing off: no second attempt');
  } finally { hang.close(); }
});

test('backoff: only an authentic, prompt answer clears it; unsigned or slow answers set it', async () => {
  assert.equal(Remote.healthy({ authentic: true, status: 200 }, 100, 800), true);
  assert.equal(Remote.healthy({ authentic: true, status: 400 }, 100, 800), true, 'a signed refusal is the desktop, up');
  assert.equal(Remote.healthy({ authentic: false, status: 200 }, 10, 800), false, 'unsigned');
  assert.equal(Remote.healthy({ authentic: true, status: 200 }, 401, 800), false, 'slower than half the timeout');
  assert.equal(Remote.healthy({ error: 'ECONNREFUSED' }, 1, 800), false);
  const desk = await deviceListener();
  try {
    // A key the desktop doesn't know: its 401 can't be signed, so it backs off.
    const stranger = tmp('ctl-reporter-');
    Remote.saveConfig(stranger, { url: `http://127.0.0.1:${desk.port}`, device: 'devbox-a1b2c3', token: TOKEN });
    await Remote.send('ping', {}, { rootDir: stranger, ignoreBackoff: true });
    assert.equal(Remote.backingOff(stranger), true);
    // A paired device's signed 400 doesn't.
    const rep = pairReporter(desk);
    const r = await Remote.send('bogus', {}, { rootDir: rep.home, ignoreBackoff: true });
    assert.equal(r.status, 400);
    assert.equal(r.authentic, true);
    assert.equal(Remote.backingOff(rep.home), false);
    // The real desktop behind a link that answers slower than half the timeout.
    const slow = net.createServer((c) => { const up = net.connect(desk.port, '127.0.0.1'); c.pipe(up); up.on('data', (d) => setTimeout(() => c.write(d), 300)); up.on('end', () => setTimeout(() => c.end(), 320)); c.on('error', () => {}); up.on('error', () => {}); }).listen(0, '127.0.0.1');
    await new Promise((res) => slow.once('listening', res));
    const lagged = tmp('ctl-reporter-');
    Remote.saveConfig(lagged, { url: `http://127.0.0.1:${slow.address().port}`, device: rep.device, token: rep.token, timeoutMs: 500 });
    const lr = await Remote.send('ping', {}, { rootDir: lagged, ignoreBackoff: true });
    assert.equal(lr.authentic, true);
    assert.equal(Remote.backingOff(lagged), true, 'answered, signed, but too slowly');
    slow.close();
  } finally { desk.close(); }
});

test('senders: at most four detached senders at once; stale slots are reclaimed', () => {
  const root = tmp('ctl-reporter-');
  const slots = [0, 1, 2, 3, 4].map(() => Remote.claimSlot(root));
  assert.equal(slots.filter(Boolean).length, Remote.MAX_SENDERS);
  assert.equal(slots[4], null);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(slots[0], old, old);
  assert.equal(Remote.claimSlot(root), slots[0], 'a slot its sender never freed');
});

// A sender's command line carries its slot, which lives under its reporter's
// data dir: that tells this test's senders from any other test's.
function sendersRunning(home) {
  let out = '';
  try { out = require('child_process').execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', maxBuffer: 1 << 24 }); } catch {}
  return out.split('\n').filter((l) => l.includes(`${REMOTE_CLI} __send`) && l.includes(home)).length;
}

test('senders: 100 hooks in a second against a desktop that never answers keep the peak at 4 or fewer', { skip: process.platform === 'win32' }, async () => {
  const hole = http.createServer(() => {});
  await new Promise((r) => hole.listen(0, '127.0.0.1', r));
  const home = tmp('ctl-pileup-');
  Remote.saveConfig(home, { url: `http://127.0.0.1:${hole.address().port}`, device: 'devbox-a1b2c3', token: TOKEN, timeoutMs: 2000 });
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, sendersRunning(home)); }, 50);
  try {
    const runs = [];
    for (let i = 0; i < 100; i++) {
      runs.push(runEmit(home, ['--adapter', 'claude', 'PreToolUse'], payload({ session_id: `pile-${i % 5}` })));
      await new Promise((r) => setTimeout(r, 10));
    }
    const res = await Promise.all(runs);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual([...new Set(res.map((r) => r.code))], [0]);
    console.log(`# pile-up: peak concurrent senders ${peak}`);
    assert.ok(peak <= Remote.MAX_SENDERS, `peak ${peak}`);
  } finally { clearInterval(sampler); hole.closeAllConnections(); hole.close(); }
});

test('cli: on a terminal the pairing prompt stays visible and the pasted code is never echoed', { skip: process.platform === 'win32' }, async () => {
  const py = require('child_process').spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' });
  if (py.status !== 0) return;
  const home = tmp('ctl-home-');
  const code = Protocol.pairingCode('probe-1', 'b'.repeat(64));
  const script = [
    'import os, pty, time, select, sys',
    'pid, fd = pty.fork()',
    'if pid == 0:',
    `    os.execvpe(${JSON.stringify(process.execPath)}, ['node', ${JSON.stringify(REMOTE_CLI)}, 'pair', 'http://127.0.0.1:9', '--no-hooks'], dict(os.environ, HOME=${JSON.stringify(home)}, CLAUDE_TRAFFIC_LIGHT_HOME=${JSON.stringify(path.join(home, '.ctl'))}, BUDDY_PAIRING_CODE=''))`,
    'out = b""',
    'def drain(t):',
    '    global out',
    '    end = time.time() + t',
    '    while time.time() < end:',
    '        r, _, _ = select.select([fd], [], [], 0.05)',
    '        if r:',
    '            try: out += os.read(fd, 4096)',
    '            except OSError: return',
    'drain(1.5)',
    'before = out; out = b""',
    `os.write(fd, ${JSON.stringify(code.slice(0, 20))}.encode()); drain(0.4)`,
    `os.write(fd, ${JSON.stringify(code.slice(20))}.encode() + b"\\r"); drain(2.5)`,
    'sys.stdout.write(repr(before.decode(errors="replace")) + "\\n" + repr(out.decode(errors="replace")))',
  ].join('\n');
  const run = require('child_process').spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  const [before, after] = run.stdout.split('\n');
  // Readline would redraw with ESC[1G ESC[0J; the prompt must survive it.
  assert.match(before, /Pairing code/);
  assert.equal(/\\x1b\[0J/.test(before.split('Pairing code').pop()), false, 'nothing wipes the prompt after it');
  assert.equal(after.includes('bbbbbbbb'), false, 'the key was echoed');
  assert.equal(after.includes('buddy-pair'), false, 'the code was echoed');
  assert.match(after, /Saved/);
});

// ── How remote sessions read ────────────────────────────────────────────────
test('wording: notifications and the Help line name the device, and never send you to this terminal', () => {
  const Help = require('../help.js');
  const remote = { sessionId: 'remote:devbox-1:claude-s', remote: true, device: 'devbox-1', deviceName: 'devbox', cwd: '/srv/api', signal: 'turn-failed', failKind: 'error' };
  const local = { sessionId: 's', cwd: '/Users/me/app', signal: 'turn-failed', failKind: 'error' };
  const first = Help.notifications(null, { sessions: [] }, {});
  const { fire } = Help.notifications(first.keys, { sessions: [remote, local] }, {});
  const r = fire.find((n) => n.sessionId === remote.sessionId);
  const l = fire.find((n) => n.sessionId === local.sessionId);
  assert.match(r.title, /api on devbox/);
  assert.doesNotMatch(r.body, /terminal/);
  assert.match(r.body, /Retry it on devbox/);
  assert.match(l.body, /Retry in the terminal/);
  const ask = Help.notifications(first.keys, { sessions: [{ ...remote, signal: 'permission-ask', tool: 'Bash' }] }, {}).fire[0];
  assert.match(ask.title, /Needs your input — api on devbox/);
  const h = Help.explain({ look: {}, sessions: [remote, { ...remote, sessionId: 'remote:devbox-1:claude-t' }, local] }, []);
  assert.equal(h.remote, '2 on devbox');
  assert.equal(Help.explain({ look: {}, sessions: [local] }, []).remote, '');
});
