// The relay's end-to-end envelope ships twice: in the app (src/e2e/) and in
// the phone PWA the hub serves (board/web/js/phone-e2e.js). They must be the
// same bytes, and the desktop host must load it. Behaviour is tested in
// remote/test/envelope.test.js and board/hub/test/relay-e2e.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('the phone copy of the envelope is byte-identical to the app copy', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/e2e/relay-envelope.js'));
  const phone = fs.readFileSync(path.join(ROOT, 'board/web/js/phone-e2e.js'));
  assert.ok(app.equals(phone), 'run: cp src/e2e/relay-envelope.js board/web/js/phone-e2e.js');
  assert.match(fs.readFileSync(path.join(ROOT, 'remote/src/envelope.js'), 'utf8'), /export \* from '\.\.\/\.\.\/src\/e2e\/relay-envelope\.js'/);
});

test('the envelope uses only WebCrypto primitives and no network or Node-only API', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src/e2e/relay-envelope.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(text, /\bimport\b|require\(|\bBuffer\b|\bprocess\.|fetch\(|Math\.random/);
  for (const alg of ["'ECDH'", "'HKDF'", "'AES-GCM'", "'SHA-256'"]) assert.ok(text.includes(alg), alg);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/e2e/package.json'), 'utf8'), /"type": "module"/);
});

test('the desktop host loads it and still works without e2e (plain relay unchanged)', async () => {
  const Envelope = require('../src/e2e/relay-envelope.js');
  assert.equal(typeof Envelope.createDesktopChannel, 'function');
  const { createRemoteInteractionHost } = require('../src/remote-interaction.js');
  const host = createRemoteInteractionHost({ userId: 'u1', adapters: {} });
  const r = await host.handle({ type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: 'u1', from: 'd', op: 'list', args: {} });
  assert.deepEqual(r, { ok: true, sessions: [] });
  const sealed = await host.handle({ type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: 'u1', from: 'd', op: 'list', enc: {} });
  assert.equal(sealed.e2e, 'unsupported');
  host.close();
});
