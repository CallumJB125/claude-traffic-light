const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveTeamHub } = require('../src/team-hub-live');

const ident = (userId, origin = 'https://hub.example') => ({ origin, userId, token: () => 't' });
const noFetch = async () => { throw new Error('no network in this test'); };

test('no identity, or an incomplete one, gives no hub', () => {
  for (const id of [null, undefined, {}, { origin: 'https://hub.example', userId: '', token: () => 't' }, { origin: 'https://hub.example', userId: 'u1', token: 'str' }]) {
    assert.equal(createLiveTeamHub({ identity: () => id, fetch: noFetch }).current(), null);
  }
  assert.equal(createLiveTeamHub({ identity: () => { throw new Error('x'); }, fetch: noFetch }).current(), null);
});

test('same account keeps one client; an account or hub switch makes a new one', () => {
  let id = ident('u1');
  const live = createLiveTeamHub({ identity: () => id, fetch: noFetch });
  const a = live.current();
  assert.equal(live.current(), a);
  id = ident('u2');
  const b = live.current();
  assert.notEqual(b, a);
  id = ident('u2', 'https://other.example');
  assert.notEqual(live.current(), b);
});

test('the client reports the signed-in user as the viewer and never the token', () => {
  const live = createLiveTeamHub({ identity: () => ident('u1'), fetch: noFetch });
  const hub = live.current();
  assert.equal(hub.viewer().id, 'u1');
  assert.ok(!JSON.stringify(hub.viewer()).includes('"t"'));
});

test('sign-out drops the client; an insecure origin yields no hub', () => {
  let id = ident('u1');
  const live = createLiveTeamHub({ identity: () => id, fetch: noFetch });
  assert.ok(live.current());
  id = null;
  assert.equal(live.current(), null);
  id = ident('u1', 'http://hub.example');
  assert.equal(live.current(), null);
});
