'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountClient } = require('../buddy-window/accounts');
const { storageHelp } = require('../buddy-window/secure-storage');

const ORIGIN = 'https://hub.example';
const TOKEN = 'synthetic-device-token';
const USER = { id: 'user-fixture', email: 'person@example.com' };
const TEAMS = [{ id: 'team-fixture', name: 'Fixture team' }];
const EXCHANGE = { flowId: 'flow-fixture', code: 'synthetic-code', state: 'synthetic-state', verifier: 'synthetic-verifier', provider: 'google' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture({ save, initial = null, beforeReply = async () => {}, accountStatus = 200 } = {}) {
  let value = initial, revision = 0, clears = 0, signedOut = 0;
  const requests = [], entered = deferred();
  const store = {
    load: () => value,
    save(record, options) {
      entered.resolve();
      if (save) return save(record, options, { set: next => { value = next; }, revision: () => revision });
      value = record;
    },
    clear() { revision += 1; clears += 1; value = null; },
  };
  const client = createAccountClient({
    origin: ORIGIN,
    store,
    onSignedOut: () => { signedOut += 1; },
    fetchImpl: async (url, init) => {
      const route = new URL(url).pathname;
      requests.push({ route, auth: init.headers.Authorization ?? null });
      await beforeReply(route);
      const body = route === '/api/auth/email/start' ? { flow_id: 'flow-fixture' }
        : route === '/api/auth/email/verify' || route === '/api/auth/oauth/exchange'
          ? { device_token: TOKEN, device_id: 'device-fixture', user: USER, teams: TEAMS }
          : accountStatus === 401 && route === '/api/account' ? { error: { code: 'UNAUTHENTICATED' } } : {};
      return { status: route === '/api/account' ? accountStatus : 200, json: async () => body };
    },
  });
  return { client, entered: entered.promise, requests, value: () => value, clears: () => clears,
    signedOut: () => signedOut, set: next => { value = next; } };
}

async function begin(f, method, options = {}) {
  if (method === 'oauth') return f.client.exchangeOAuth(EXCHANGE, {}, options);
  assert.equal((await f.client.startEmail(USER.email)).ok, true);
  return f.client.verifyCode('123456');
}

for (const method of ['email', 'oauth']) {
  test(`${method} sign-in waits for asynchronous secure save before returning success`, async () => {
    const gate = deferred();
    const f = fixture({ save: async (record, { keep }, { set }) => {
      await gate.promise;
      assert.equal(keep(), true);
      set(record);
    } });
    let settled = false;
    const pending = begin(f, method).then(result => { settled = true; return result; });
    await f.entered;
    await turn();
    assert.equal(settled, false, 'no success while the OS vault is still saving');
    assert.equal(f.client.signedIn(), false);
    gate.resolve();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.deepEqual(result.user, USER);
    assert.deepEqual(result.teams, TEAMS);
    assert.equal(f.client.signedIn(), true);
    assert.equal(f.value().token, TOKEN);
    assert.equal(JSON.stringify(result).includes(TOKEN), false, 'device tokens stay inside the account client');
  });

  test(`${method} asynchronous save rejection fails closed and revokes the unusable device token`, async () => {
    const gate = deferred();
    const f = fixture({ save: () => gate.promise });
    const pending = begin(f, method);
    await f.entered;
    gate.reject(new Error(`private native path and ${TOKEN}`));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error, /Plexiform couldn’t save your sign-in securely/);
    assert.ok(result.error.includes(storageHelp()));
    assert.doesNotMatch(result.error, /private native|synthetic-device-token/);
    assert.equal(f.client.signedIn(), false);
    assert.equal(f.value(), null);
    assert.deepEqual(f.requests.filter(r => r.route === '/api/auth/signout'), [
      { route: '/api/auth/signout', auth: `Bearer ${TOKEN}` },
    ]);
  });

  test(`${method} sign-in remains compatible with synchronous token stores`, async () => {
    const f = fixture();
    const result = await begin(f, method);
    assert.equal(result.ok, true);
    assert.equal(result.email, USER.email);
    assert.deepEqual(f.client.user(), USER);
    assert.equal(f.client.signedIn(), true);
    assert.equal(f.requests.some(r => r.route === '/api/auth/signout'), false);
  });
}

for (const failure of [false, true]) {
  test(`OAuth cancellation while secure save is held revokes the token after ${failure ? 'rejection' : 'completion'}`, async () => {
    const gate = deferred();
    let keep = true;
    const f = fixture({ save: async (record, options, { set }) => {
      await gate.promise;
      if (failure || !options.keep()) throw new Error('private cancelled native operation');
      set(record);
    } });
    const pending = begin(f, 'oauth', { keep: () => keep });
    await f.entered;
    keep = false;
    gate.resolve();
    assert.deepEqual(await pending, { ok: false, cancelled: true });
    assert.equal(f.value(), null);
    assert.equal(f.client.signedIn(), false);
    assert.equal(f.requests.filter(r => r.route === '/api/auth/signout').length, 1);
  });
}

test('cancelled OAuth also removes its own token when an older store ignores the commit predicate', async () => {
  const gate = deferred();
  let keep = true;
  const f = fixture({ save: async (record, _options, { set }) => { await gate.promise; set(record); } });
  const pending = begin(f, 'oauth', { keep: () => keep });
  await f.entered;
  keep = false;
  gate.resolve();
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.equal(f.value(), null);
  assert.equal(f.clears(), 1);
});

test('cancelled OAuth never clears a newer sign-in when its held save rejects', async () => {
  const gate = deferred();
  let keep = true;
  const f = fixture({ save: () => gate.promise });
  const pending = begin(f, 'oauth', { keep: () => keep });
  await f.entered;
  const newer = { hub: ORIGIN, token: 'synthetic-newer-token', user: { id: 'new-user' } };
  f.set(newer);
  keep = false;
  gate.reject(new Error('private stale save'));
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.equal(f.value(), newer);
  assert.equal(f.clears(), 0);
  assert.deepEqual(f.requests.filter(r => r.route === '/api/auth/signout'), [
    { route: '/api/auth/signout', auth: `Bearer ${TOKEN}` },
  ]);
});

test('sign-out fences a held sign-in save and prevents late success', async () => {
  const gate = deferred();
  const f = fixture({ save: async (record, { keep }, { set, revision }) => {
    const started = revision();
    await gate.promise;
    if (revision() !== started || !keep()) throw new Error('private retired operation');
    set(record);
  } });
  const pending = begin(f, 'oauth');
  await f.entered;
  assert.deepEqual(await f.client.signOut(), { ok: true, revoked: true });
  gate.resolve();
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.equal(f.client.signedIn(), false);
  assert.equal(f.value(), null);
});

test('revocation of the current account fences a held replacement sign-in', async () => {
  const gate = deferred();
  const f = fixture({ initial: { hub: ORIGIN, token: 'synthetic-old-token', user: USER }, accountStatus: 401,
    save: async (record, { keep }, { set }) => {
      await gate.promise;
      if (!keep()) throw new Error('private retired operation');
      set(record);
    } });
  const pending = begin(f, 'oauth');
  await f.entered;
  assert.equal((await f.client.me()).signedOut, true);
  assert.equal(f.signedOut(), 1);
  gate.resolve();
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.equal(f.value(), null);
});

test('sign-out while email verification is in flight drops the late token without saving it', async () => {
  const gate = deferred(), requested = deferred();
  const f = fixture({ beforeReply: async route => {
    if (route !== '/api/auth/email/verify') return;
    requested.resolve();
    await gate.promise;
  } });
  const pending = begin(f, 'email');
  await requested.promise;
  await f.client.signOut();
  gate.resolve();
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.equal(f.value(), null);
  assert.equal(f.requests.filter(r => r.route === '/api/auth/signout').length, 1);
});
