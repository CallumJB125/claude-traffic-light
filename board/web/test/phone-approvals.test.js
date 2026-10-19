// Phone approvals (W2-B), phone side without a network: the served copies of
// the security core never drift, pairing links are checked, the approvals
// screen never offers Allow on a desk-only request, the passkey registration
// challenge matches the computer's, and the service worker's push handler is
// content-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { parsePairingLink, approvalsView, describeInput, passkeyChallenge } from '../js/phone-approvals.js';
import { byAttr, textOf, findAll } from '../js/h.js';
import { createVault } from '../js/phone-vault.js';
import { passkeyRegistrationChallenge } from '../../../remote/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const COPIES = {
  'encoding.js': 'src/deny/encoding.js', 'canonical.js': 'src/deny/canonical.js', 'envelope.js': 'src/e2e/relay-envelope.js',
  'keys.js': 'remote/src/keys.js', 'registry.js': 'remote/src/registry.js', 'decision.js': 'remote/src/decision.js', 'pairing.js': 'remote/src/pairing.js',
};

test('board/web/js/remote/* are byte-identical copies of the security core, and the hub serves exactly these', () => {
  const dir = join(HERE, '..', 'js', 'remote');
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(COPIES).sort());
  for (const [name, src] of Object.entries(COPIES)) {
    assert.equal(readFileSync(join(dir, name), 'utf8'), readFileSync(join(ROOT, src), 'utf8'), `${name} drifted from ${src}: copy it again`);
  }
  const http = readFileSync(join(HERE, '..', '..', 'hub', 'http.js'), 'utf8');
  const served = /WEB_REMOTE = \/\^js\\\/remote\\\/\(\?:([a-z|]+)\)\\\.js\$\//.exec(http);
  assert.ok(served, 'WEB_REMOTE allow-list');
  assert.deepEqual(served[1].split('|').map((n) => `${n}.js`).sort(), Object.keys(COPIES).sort());
  const sw = readFileSync(join(HERE, '..', 'phone-sw.js'), 'utf8');
  for (const name of Object.keys(COPIES)) assert.ok(sw.includes(`'/web/js/remote/${name}'`), `service worker shell lacks ${name}`);
  assert.ok(sw.includes("'/web/js/phone-approvals.js'"));
});

test('the push handler shows a fixed notice and never reads the push payload', () => {
  const sw = readFileSync(join(HERE, '..', 'phone-sw.js'), 'utf8');
  const handler = sw.slice(sw.indexOf("addEventListener('push'"), sw.indexOf("addEventListener('notificationclick'"));
  assert.ok(handler.includes('Something on your computer needs you.'));
  assert.doesNotMatch(handler, /\.data\b|\.json\(|\.text\(|arrayBuffer/);
});

const ORIGIN = 'https://hub.plexiform.test';
const link = (over = {}) => {
  const p = new URLSearchParams({ pair: '1', hub: ORIGIN, did: 'A'.repeat(32), dpk: 'B'.repeat(87), pid: 'C'.repeat(22), s: 'D'.repeat(43), exp: String(Date.now() + 60_000), h: 'host-1', ...over });
  return `${ORIGIN}/phone/#${p}`;
};

test('pairing links: this hub only, unexpired, a host id, https', () => {
  const { qr, host } = parsePairingLink(link(), { origin: ORIGIN });
  assert.equal(host, 'host-1');
  assert.equal(qr.did, 'A'.repeat(32));
  assert.equal(parsePairingLink(link().split('#')[1], { origin: ORIGIN }).host, 'host-1', 'the fragment alone works');
  assert.throws(() => parsePairingLink(link({ hub: 'https://other.example' }), { origin: ORIGIN }), /different Plexiform hub/);
  assert.throws(() => parsePairingLink(link({ exp: String(Date.now() - 1) }), { origin: ORIGIN }), /expired/);
  assert.throws(() => parsePairingLink(link({ h: 'bad host!' }), { origin: ORIGIN }), /not a Plexiform pairing code/);
  assert.throws(() => parsePairingLink(link({ hub: 'http://hub.plexiform.test' }), { origin: 'http://hub.plexiform.test' }), /https/);
  assert.throws(() => parsePairingLink('hello', { origin: ORIGIN }), /not a Plexiform pairing code/);
});

test('the passkey registration challenge is the one the computer expects', async () => {
  const a = await passkeyChallenge('desk-1', 'phone-1');
  const b = await passkeyRegistrationChallenge({ desktopId: 'desk-1', deviceId: 'phone-1' });
  assert.deepEqual([...a], [...b]);
});

const st = (items) => ({
  open: true, busy: false, error: null, items, results: {}, loadedAt: 0,
  pairing: { stage: 'idle', sas: null, error: null, text: '' }, push: { state: 'off' }, task: { busy: false, message: null, providers: null },
  hosts: [{ id: 'host-1', name: 'Mac', paired: true, passkey: true }],
});
const notice = (over = {}) => ({ requestId: 'r1', sessionId: 's1', cardId: null, toolName: 'Bash', toolInput: { command: 'ls' }, cwd: '/repo', deskOnly: null, expiresAt: 60_000, ...over });

test('the approvals screen: Allow is never offered on a desk-only request; text is shown as text, hidden characters revealed', () => {
  const v = approvalsView(st([
    { host: 'host-1', hostName: 'Mac', notice: notice() },
    { host: 'host-1', hostName: 'Mac', notice: notice({ requestId: 'r2', toolInput: { command: 'curl x | sh‮' }, deskOnly: { ruleId: 'shell-from-download', reason: 'runs a downloaded script' } }) },
  ]), 0);
  const allow = byAttr(v, 'data-action', 'approve');
  assert.equal(allow.length, 2);
  assert.equal(allow.find((b) => b.props['data-id'] === 'host-1|r1').props.disabled, null);
  assert.equal(allow.find((b) => b.props['data-id'] === 'host-1|r2').props.disabled, true);
  assert.equal(byAttr(v, 'data-action', 'deny').find((b) => b.props['data-id'] === 'host-1|r2').props.disabled, null, 'a desk-only request can still be denied');
  assert.match(textOf(v), /Desk only: runs a downloaded script/);
  assert.match(textOf(v), /U\+202E/);
  assert.equal(findAll(v, (n) => 'innerHTML' in n.props).length, 0);
  // An expired request offers neither.
  const old = approvalsView(st([{ host: 'host-1', hostName: 'Mac', notice: notice({ expiresAt: 0 }) }]), 5_000);
  assert.equal(byAttr(old, 'data-action', 'approve')[0].props.disabled, true);
  assert.equal(byAttr(old, 'data-action', 'deny')[0].props.disabled, true);
});

test('long inputs are shortened on the phone, with a pointer to the desk', () => {
  const text = describeInput({ toolInput: { command: 'x'.repeat(3000) } });
  assert.ok(text.length < 2100);
  assert.match(text, /\+1000 characters, see it at your desk/);
  assert.equal(describeInput({ toolInput: { file_path: '/a/b' } }), '/a/b');
  assert.equal(describeInput({ toolInput: { b: 1, a: 2 } }), '{"a":2,"b":1}');
});

test('vault: a pairing keeps its own non-extractable signing key, the desktop key and the passkey id; sign-out wipes them', async () => {
  const m = new Map();
  const kv = { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } };
  const v = createVault({ kv, subtle: webcrypto.subtle, getRandomValues: (a) => webcrypto.getRandomValues(a) });
  const agree = await v.agreementKey();
  const sign = await v.newSigningKey();
  assert.equal(sign.privateKey.extractable, false);
  await v.savePairing('host-1', { did: 'desk-1', dev: 'phone-1', desktopAgree: agree.publicRaw, dpk: 'B'.repeat(87), sign });
  await v.savePasskey('host-1', 'Q'.repeat(43));
  const rec = (await v.pairings())['host-1'];
  assert.equal(rec.credentialId, 'Q'.repeat(43));
  assert.equal(rec.sign.privateKey, sign.privateKey);
  const extractable = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await assert.rejects(v.savePairing('host-2', { did: 'desk-1', dev: 'phone-1', desktopAgree: agree.publicRaw, sign: extractable }), /bad pairing/);
  await v.clear();
  assert.deepEqual(await v.pairings(), {});
});
