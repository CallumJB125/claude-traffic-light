const test = require('node:test');
const { mock } = require('node:test');
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

// Push: fake timers drive the 15s identity recheck and the client's own poll.
const flush = () => new Promise((r) => setImmediate(r));
const SHARE = { id: '11111111-2222-4333-8444-555555555555', session: '10000000-0000-4000-8000-000000000001', scope: 'watch', team: { id: 't1', name: 'T' }, owner: { id: 'o1', name: 'O' }, online: true };
function hubFetch() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init.headers.authorization);
    const body = JSON.stringify({ shared: [SHARE] });
    return { status: 200, headers: { get: () => null }, text: async () => body, body: null };
  };
  return { fetch, calls };
}
const tick = async (ms) => { mock.timers.tick(ms); await flush(); await flush(); };
const withTimers = (fn) => async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try { await fn(); } finally { mock.timers.reset(); }
};
const identFor = (userId) => ({ origin: 'https://hub.example', userId, token: () => `tok-${userId}` });

test('push: nothing runs without listeners; the first listener starts polling and the last off() stops it', withTimers(async () => {
  const { fetch, calls } = hubFetch();
  const live = createLiveTeamHub({ identity: () => identFor('u1'), fetch });
  live.current();
  await tick(120_000);
  assert.equal(calls.length, 0, 'no listener, no poll');
  let n = 0;
  const off1 = live.onChange(() => { n++; });
  const off2 = live.onChange(() => { n++; });
  await tick(1);
  assert.equal(calls.length, 1, 'two listeners share one poll');
  assert.equal(n, 2, 'the first poll reaches every listener');
  await tick(5_000);
  assert.equal(calls.length, 2, 'keeps polling while listened to');
  off1();
  await tick(5_000);
  assert.equal(calls.length, 3, 'still polling with one listener left');
  off2();
  const stopped = calls.length;
  await tick(300_000);
  assert.equal(calls.length, stopped, 'no leak after the last off()');
  const off3 = live.onChange(() => {});
  await tick(1);
  assert.equal(calls.length, stopped + 1, 'a later listener starts it again');
  off3();
}));

test('push: an account switch re-subscribes to the new client and tells listeners', withTimers(async () => {
  const { fetch, calls } = hubFetch();
  let id = identFor('u1');
  const live = createLiveTeamHub({ identity: () => id, fetch });
  let n = 0;
  const off = live.onChange(() => { n++; });
  await tick(1);
  assert.deepEqual(calls, ['Bearer tok-u1']);
  assert.equal(n, 1);
  id = identFor('u2');
  await tick(15_000);
  assert.equal(n >= 2, true, 'the switch is announced');
  const afterSwitch = calls.length;
  await tick(30_000);
  const later = calls.slice(afterSwitch);
  assert.ok(later.length >= 1 && later.every((a) => a === 'Bearer tok-u2'), 'only the new account polls');
  off();
}));

test('push: sign-out drops the poll and re-sign-in resumes it', withTimers(async () => {
  const { fetch, calls } = hubFetch();
  let id = identFor('u1');
  const live = createLiveTeamHub({ identity: () => id, fetch });
  let n = 0;
  const off = live.onChange(() => { n++; });
  await tick(1);
  id = null;
  await tick(15_000);
  const seen = n, atOut = calls.length;
  assert.ok(seen >= 2, 'listeners hear about the sign-out');
  await tick(300_000);
  assert.equal(calls.length, atOut, 'signed out: no polling');
  id = identFor('u1');
  await tick(15_000);
  await tick(1);
  assert.ok(calls.length > atOut, 'signed back in: polling resumes');
  off();
}));

test('push: close() drops listeners and the timer; a listener that throws or a bad callback is contained', withTimers(async () => {
  const { fetch, calls } = hubFetch();
  const live = createLiveTeamHub({ identity: () => identFor('u1'), fetch });
  assert.throws(() => live.onChange('nope'), /function/);
  let ok = 0;
  live.onChange(() => { throw new Error('boom'); });
  live.onChange(() => { ok++; });
  await tick(1);
  assert.equal(ok, 1, 'a throwing listener does not starve the others');
  live.close();
  const atClose = calls.length;
  await tick(300_000);
  assert.equal(calls.length, atClose, 'close() stops everything');
  const off = live.onChange(() => { ok++; });
  await tick(300_000);
  assert.equal(calls.length, atClose, 'a closed hub does not restart');
  off();
}));

test('after an account switch the old client never sends the new account\'s token', async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push(init?.headers?.authorization ?? null); return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"shared":[]}' }; };
  let account = 'u1';
  const token = () => `tok-${account}`; // like the real identity: the getter answers for the CURRENT account
  const live = createLiveTeamHub({ identity: () => ({ origin: 'https://hub.example', userId: account, token }), fetch });
  const oldClient = live.current();
  await oldClient.teams({ id: 'u1' });
  assert.deepEqual(seen, ['Bearer tok-u1']);
  account = 'u2';
  seen.length = 0;
  await oldClient.teams({ id: 'u1' }).catch(() => {});
  assert.ok(!seen.some((h) => String(h).includes('tok-u2')), `leaked: ${seen}`);
});
