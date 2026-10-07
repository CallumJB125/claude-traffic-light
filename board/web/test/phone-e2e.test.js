// Phone side of the end-to-end relay: the vault keeps a non-extractable ECDH
// key and public pairing records, sign-out wipes them, and the API client
// seals calls to a paired computer (plain to an unpaired one). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createApi, createE2E } from '../js/phone-core.js';
import { createVault } from '../js/phone-vault.js';
import { generateAgreementKey, exportAgreementPublic, createDesktopChannel } from '../js/phone-e2e.js';

function memKv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } };
}
const vaultOf = (kv) => createVault({ kv, subtle: webcrypto.subtle, getRandomValues: (a) => webcrypto.getRandomValues(a) });

test('vault: one non-extractable ECDH key per phone, public pairing records, all wiped on sign-out', async () => {
  const kv = memKv();
  const v = vaultOf(kv);
  const a = await v.agreementKey();
  assert.equal(a.privateKey.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('jwk', a.privateKey));
  assert.equal((await v.agreementKey()).publicRaw, a.publicRaw, 'stable across loads');
  const desk = await exportAgreementPublic((await generateAgreementKey()).publicKey);
  await v.savePairing('host-1', { did: 'desk-1', dev: 'phone-1', desktopAgree: desk });
  assert.deepEqual(await v.pairings(), { 'host-1': { did: 'desk-1', dev: 'phone-1', desktopAgree: desk } });
  await assert.rejects(v.savePairing('host-2', { did: 'desk-1', dev: 'phone-1', desktopAgree: 'AAAA' }));
  await assert.rejects(v.savePairing('host-2', { did: 'bad id!', dev: 'phone-1', desktopAgree: desk }));
  await v.forgetPairing('host-1');
  assert.deepEqual(await v.pairings(), {});
  await v.savePairing('host-1', { did: 'desk-1', dev: 'phone-1', desktopAgree: desk });
  await v.save(`bdt_${'Z'.repeat(43)}`);
  await v.clear();
  assert.equal(kv.m.size, 0, 'token, token key, ECDH key and pairings all gone');
  assert.notEqual((await v.agreementKey()).publicRaw, a.publicRaw, 'a new sign-in gets a new key');
});

test('api: calls to a paired computer go sealed and come back opened; unpaired calls stay plain', async () => {
  const v = vaultOf(memKv());
  const deskKeys = await generateAgreementKey({ extractable: true });
  const mine = await v.agreementKey();
  await v.savePairing('mac', { did: 'desk-1', dev: 'phone-1', desktopAgree: await exportAgreementPublic(deskKeys.publicKey) });
  const desktop = createDesktopChannel({ did: 'desk-1', privateKey: deskKeys.privateKey, peer: (d) => (d === 'phone-1' ? mine.publicRaw : null) });
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(init.body);
    let result;
    if (!body.enc) result = { ok: true, plain: true };
    else {
      const o = await desktop.open({ rid: body.request_id, op: body.op, enc: body.enc });
      result = !o.ok ? { ok: false, e2e: o.code } : o.hello ? { enc: o.reply } : { enc: await o.seal({ ok: true, got: o.args }) };
    }
    return { status: 200, json: async () => ({ host: 'mac', result }) };
  };
  const api = createApi({ fetch, uuid: () => webcrypto.randomUUID(), e2e: createE2E({ store: v }) });
  api.setToken('bdt_x');
  const r = await api.call('mac', 'send', { text: 'secret words' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.result, { ok: true, got: { text: 'secret words' } });
  assert.ok(bodies.every((b) => !b.includes('secret words')));
  assert.deepEqual(bodies.map((b) => JSON.parse(b).op), ['hello', 'send']);
  const plain = await api.call('other', 'list');
  assert.deepEqual(plain.body.result, { ok: true, plain: true });
  assert.deepEqual(JSON.parse(bodies.at(-1)).args, {});
});

test('sign-in asks the hub for a relay-scoped token', async () => {
  const seen = [];
  const api = createApi({ fetch: async (url, init) => { seen.push(JSON.parse(init.body)); return { status: 200, json: async () => ({}) }; }, uuid: () => 'u' });
  await api.verifyEmail('f', '123456', 'iPhone');
  assert.deepEqual(seen[0], { flow_id: 'f', code: '123456', device_name: 'iPhone', platform: 'phone-web', scope: 'relay' });
});
