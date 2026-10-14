import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startBrowserSignIn, finishBrowserSignIn } from '../js/phone-browser-auth.js';
const hubOrigin = 'https://app.plexiform.test';
const id = 'a'.repeat(32);
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
test('phone browser sign-in pins destination and proof, preserves pairing and saves no token in URLs', async () => {
  const store = storage(); let challenge; let saved;
  const api = { request: async (_method, path, body) => {
    if (path.endsWith('/start')) { challenge = body.challenge; return { status: 200, body: { id, code: '123456', url: `${hubOrigin}/phone-connect#${id}` } }; }
    assert.equal(body.id, id); assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), challenge);
    return { status: 200, body: { device_token: 'bdt_test' } };
  } };
  const flow = await startBrowserSignIn({ api, storage: store, hubOrigin, pair: 'pair=fixture' });
  assert.equal(flow.code, '123456'); assert.ok(!flow.url.includes('bdt_'));
  const pair = await finishBrowserSignIn({ id, api, storage: store, vault: { save: async (t) => { saved = t; } } });
  assert.equal(saved, 'bdt_test'); assert.equal(pair, 'pair=fixture');
  await assert.rejects(() => finishBrowserSignIn({ id, api, storage: store, vault: {} }), /Start sign-in again/);
});
test('untrusted sign-in destination and missing browser proof are refused', async () => {
  const store = storage();
  await assert.rejects(() => startBrowserSignIn({ hubOrigin, storage: store, api: { request: async () => ({ status: 200, body: { id, code: '123456', url: `https://evil.test/phone-connect#${id}` } }) } }), /Invalid sign-in address/);
  await assert.rejects(() => finishBrowserSignIn({ id, storage: store, api: {}, vault: {} }), /Start sign-in again/);
});
