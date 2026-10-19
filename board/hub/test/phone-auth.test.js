import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { startAccounts } from './accounts-helpers.js';
const phone = 'https://phone.plexiform.test';
const proof = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
const rig = () => startAccounts({ config: { publicUrl: 'https://app.plexiform.test', phoneOrigin: phone, trustCfIp: true, signinMethods: ['google'] } });
const origin = { origin: 'https://app.plexiform.test' };
test('phone browser authorization: PKCE, explicit session approval, single use, relay scope and expiry', async () => {
  const h = await rig();
  try {
    const web = await h.webSignIn('alice@dev.local'); const p = proof();
    const start = await h.call('POST', '/api/auth/phone/start', { body: { challenge: p.challenge }, headers: { origin: phone } });
    assert.equal(start.status, 200, start.text); const id = start.body.id;
    assert.equal(start.headers.get('access-control-allow-origin'), phone);
    assert.equal(start.headers.get('access-control-allow-credentials'), null);
    const exchange = (verifier = p.verifier) => h.call('POST', '/api/auth/phone/exchange', { body: { id, verifier }, headers: { origin: phone } });
    assert.equal((await exchange()).body.pending, true);
    assert.equal((await exchange(proof().verifier)).status, 400);
    const approve = (code, headers = origin, cookie = web.cookie) => h.call('POST', '/api/auth/phone/approve', { cookie, headers: { ...headers, 'x-csrf-token': web.csrf }, body: { id, code } });
    assert.equal((await approve(start.body.code, { origin: phone })).status, 403);
    assert.equal((await approve('000000')).status, 400);
    assert.equal((await approve(start.body.code)).status, 200);
    const done = await exchange(); assert.equal(done.status, 200, done.text);
    assert.equal((await exchange()).status, 400);
    assert.equal(h.db.get('SELECT scope FROM user_devices WHERE id = ?', done.body.device_id).scope, 'relay');
    assert.equal((await h.call('GET', '/api/account', { token: done.body.device_token })).status, 403);
    assert.equal((await h.call('GET', '/api/interaction/v1/hosts', { token: done.body.device_token, headers: { origin: phone } })).status, 200);
    const next = await h.call('POST', '/api/auth/phone/start', { body: { challenge: proof().challenge } });
    h.clock.advance(301000);
    assert.equal((await h.call('GET', `/api/auth/phone/${next.body.id}`, { cookie: web.cookie })).status, 400);
  } finally { await h.close(); }
});
test('CORS cannot carry cookies, full desktop tokens, arbitrary headers or non-phone paths', async () => {
  const h = await rig();
  try {
    const user = await h.signIn('alice@dev.local');
    assert.equal((await h.call('GET', '/api/interaction/v1/hosts', { token: user.body.device_token, headers: { origin: phone } })).status, 403);
    assert.equal((await h.call('GET', '/api/account', { token: user.body.device_token, headers: { origin: phone } })).status, 403);
    const preflight = (headers) => h.call('OPTIONS', '/api/auth/phone/start', { headers: { origin: phone, 'access-control-request-method': 'POST', ...headers } });
    assert.equal((await preflight({ 'access-control-request-headers': 'content-type' })).status, 204);
    assert.equal((await preflight({ 'access-control-request-headers': 'x-csrf-token' })).status, 403);
    assert.equal((await preflight({ cookie: 'x=y' })).status, 403);
    assert.equal((await preflight({ origin: 'https://evil.test' })).headers.get('access-control-allow-origin'), null);
  } finally { await h.close(); }
});

test('revoking the approving browser session invalidates an unexchanged phone grant', async () => {
  const h = await rig();
  try {
    const web = await h.webSignIn('alice@dev.local'); const p = proof();
    const start = await h.call('POST', '/api/auth/phone/start', { body: { challenge: p.challenge } });
    const id = start.body.id; const headers = { ...origin, 'x-csrf-token': web.csrf };
    assert.equal((await h.call('POST', '/api/auth/phone/approve', { cookie: web.cookie, headers, body: { id, code: start.body.code } })).status, 200);
    assert.equal((await h.call('POST', '/api/auth/signout', { cookie: web.cookie, headers, body: {} })).status, 200);
    assert.equal((await h.call('POST', '/api/auth/phone/exchange', { body: { id, verifier: p.verifier } })).status, 400);
  } finally { await h.close(); }
});
