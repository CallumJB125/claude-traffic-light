// W2-B phone push (push.js) and the approval ping (approval-relay.js) with a
// fake push service (no network; throwaway VAPID keys made here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { startAccounts } from './accounts-helpers.js';
import { PushService, vapidKey, PUSH_HOSTS } from '../push.js';
import { loadConfig } from '../config.js';

function vapid() {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  return { pub: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'), d: jwk.d };
}

async function rig(statuses = []) {
  const v = vapid();
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return new Response(null, { status: statuses.shift() ?? 201 }); };
  const h = await startAccounts({ fetchImpl, config: { pushVapidPublicKey: v.pub, pushVapidPrivateKey: v.d, pushVapidSubject: 'mailto:ops@plexiform.test' } });
  const mac = await h.signIn('alice@dev.local', { device_name: 'Alice Mac' });
  const s = await h.start('alice@dev.local', { device_name: 'Alice iPhone', platform: 'phone-web' });
  const phone = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code: h.codeFor('alice@dev.local'), device_name: 'Alice iPhone', platform: 'phone-web', scope: 'relay' } });
  assert.equal(phone.status, 200, phone.text);
  return { h, v, sent, mac: mac.body, phone: phone.body };
}

test('subscriptions: only a push service address; the phone token may subscribe; the key is served', async () => {
  const r = await rig();
  try {
    const sub = (endpoint, token = r.phone.device_token) => r.h.call('PUT', '/api/push/v1/subscription', { token, body: { endpoint } });
    assert.equal((await r.h.call('GET', '/api/push/v1/key', { token: r.phone.device_token })).body.publicKey, r.v.pub);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://push.apple.com/x', 'ftp://fcm.googleapis.com/x']) {
      assert.equal((await sub(bad)).status, 400, bad);
    }
    for (const good of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QAbc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
      const res = await sub(good);
      assert.equal(res.status, 200, `${good} ${res.text}`);
    }
    assert.equal(r.h.db.all('SELECT * FROM push_subscriptions').length, 1, 'one per device, replaced in place');
    const del = await r.h.call('DELETE', '/api/push/v1/subscription', { token: r.phone.device_token, body: {} });
    assert.equal(del.status, 200, del.text);
    assert.equal(r.h.db.all('SELECT * FROM push_subscriptions').length, 0);
    assert.ok(PUSH_HOSTS.includes('web.push.apple.com'));
  } finally { await r.h.close(); }
});

test('a ping is an empty, VAPID-signed POST; 410 forgets the subscription; revoked devices get nothing', async () => {
  const r = await rig([201, 410]);
  try {
    await r.h.call('PUT', '/api/push/v1/subscription', { token: r.phone.device_token, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' } });
    assert.deepEqual(await r.h.hub.push.ping(r.mac.user.id), { sent: 1, failed: 0 });
    const { url, init } = r.sent[0];
    assert.equal(url, 'https://fcm.googleapis.com/fcm/send/abc');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, undefined, 'no payload');
    assert.equal(init.redirect, 'manual');
    assert.match(init.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${r.v.pub}$`));
    assert.deepEqual(Object.keys(init.headers).sort(), ['authorization', 'content-length', 'topic', 'ttl', 'urgency']);
    assert.deepEqual(await r.h.hub.push.ping(r.mac.user.id), { sent: 0, failed: 1 });
    assert.equal(r.h.db.all('SELECT * FROM push_subscriptions').length, 0, '410: gone');
    await r.h.call('PUT', '/api/push/v1/subscription', { token: r.phone.device_token, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' } });
    r.h.db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', new Date().toISOString(), r.phone.device_id);
    assert.deepEqual(await r.h.hub.push.ping(r.mac.user.id), { sent: 0, failed: 0 });
  } finally { await r.h.close(); }
});

test('the ping route: hosting computer only, coalesced, rate-limited, and a no-op without subscriptions', async () => {
  const r = await rig();
  try {
    const ping = (token = r.mac.device_token) => r.h.call('POST', '/api/approvals/v1/ping', { token, body: {} });
    assert.equal((await ping()).status, 403, 'not a host yet');
    assert.equal((await r.h.call('PUT', '/api/interaction/v1/role', { token: r.mac.device_token, body: { role: 'host' } })).status, 200);
    await r.h.call('PUT', '/api/push/v1/subscription', { token: r.phone.device_token, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' } });
    assert.deepEqual((await ping()).body, { ok: true, sent: 1 });
    assert.deepEqual((await ping()).body, { ok: true, sent: 0, coalesced: true });
    for (let i = 0; i < 119; i++) { r.h.clock.advance?.(5_001); await ping(); }
    r.h.clock.advance?.(5_001);
    const limited = await ping();
    assert.equal(limited.status, 429, JSON.stringify(limited.body));
  } finally { await r.h.close(); }
});

test('config: the three VAPID values go together, the private key is hidden, and a bad pair is refused', () => {
  const v = vapid();
  const base = { BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_ACCOUNTS_DEV: '1' };
  assert.throws(() => loadConfig({ ...base, BOARD_PUSH_VAPID_PUBLIC_KEY: v.pub }), /together/);
  assert.throws(() => loadConfig({ ...base, BOARD_PUSH_VAPID_PUBLIC_KEY: v.pub, BOARD_PUSH_VAPID_PRIVATE_KEY: v.d, BOARD_PUSH_VAPID_SUBJECT: 'ops' }), /mailto/);
  const cfg = loadConfig({ ...base, BOARD_PUSH_VAPID_PUBLIC_KEY: v.pub, BOARD_PUSH_VAPID_PRIVATE_KEY: v.d, BOARD_PUSH_VAPID_SUBJECT: 'mailto:ops@plexiform.test' });
  assert.equal(cfg.pushVapidPrivateKey, v.d);
  assert.ok(!JSON.stringify(cfg).includes(v.d), 'never in a dump of the config');
  assert.throws(() => vapidKey({ publicKey: v.pub, privateKey: 'AAAA' }), /key pair/);
  assert.equal(new PushService({ config: {} }, {}).configured, false);
});
