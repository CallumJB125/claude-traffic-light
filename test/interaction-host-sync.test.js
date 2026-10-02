// src/interaction-host-sync.js with fake hosts, identities and role resets:
// opt-in/opt-out, sign-out, account switch (the old reset uses the OLD
// account's token value, and finishes before the new host enables), an
// unacknowledged reset retried until the hub takes it, remembered across a
// restart, and the bounded reset on quit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInteractionHostSync } = require('../src/interaction-host-sync.js');

const T = { timeout: 10_000 };
const tick = () => new Promise((r) => setImmediate(r));

function world({ resetAnswers = [], attach = null, enableState } = {}) {
  const log = [];
  const w = {
    want: true,
    id: { origin: 'https://hub.example', userId: 'alice', tok: 'bdt_alice' },
    pending: null,
    resets: [],
    timers: [],
    listeners: [],
    log,
  };
  w.emit = (st) => { for (const fn of w.listeners) fn(st); };
  const identity = () => (w.id ? { origin: w.id.origin, userId: w.id.userId, token: () => w.id?.tok ?? null } : null);
  const createHost = (id) => {
    const h = {
      user: id.userId, closed: false,
      async enable(o) { log.push(['enable', id.userId, o.token()]); return enableState === undefined ? undefined : { state: enableState }; },
      async disable(o) { log.push(['disable', id.userId, o.token, o.timeoutMs]); return resetAnswers.length ? resetAnswers.shift() : true; },
      close() { h.closed = true; log.push(['close', id.userId]); },
      onState(fn) { w.listeners.push(fn); },
    };
    return h;
  };
  const timers = {
    setTimeout: (fn, ms) => { const t = { fn, ms }; w.timers.push(t); return t; },
    clearTimeout: (t) => { const i = w.timers.indexOf(t); if (i >= 0) w.timers.splice(i, 1); },
  };
  w.fire = async () => { const t = w.timers.shift(); await t.fn(); await tick(); return t.ms; };
  w.sync = createInteractionHostSync({
    want: () => w.want, identity, createHost,
    connect: (host, o) => host.enable(o),
    resetRole: async (o) => { w.resets.push(o.token); return resetAnswers.length ? resetAnswers.shift() : true; },
    fetch: () => { throw new Error('not used'); },
    pending: { get: () => w.pending, set: (v) => { w.pending = v; } },
    timers, attach,
  });
  return w;
}

test('opt in enables with the sign-in; opting out disables with the same token and closes', T, async () => {
  const w = world();
  await w.sync.sync();
  assert.deepEqual(w.log, [['enable', 'alice', 'bdt_alice']]);
  assert.equal(w.sync.active(), true);
  await w.sync.sync(); // nothing changed: nothing happens
  assert.equal(w.log.length, 1);
  w.want = false;
  await w.sync.sync();
  assert.deepEqual(w.log.slice(1), [['disable', 'alice', 'bdt_alice', 5000], ['close', 'alice']]);
  assert.equal(w.sync.host(), null);
  assert.equal(w.pending, null);
});

test('sign-out: the old host is disabled with its own token value and nothing new starts', T, async () => {
  const w = world();
  await w.sync.sync();
  w.id = null; // signed out: the getter would now answer null
  await w.sync.sync();
  assert.deepEqual(w.log.slice(1), [['disable', 'alice', 'bdt_alice', 5000], ['close', 'alice']]);
  assert.equal(w.sync.active(), false);
});

test('account switch: the old reset uses the OLD token and completes before the new host enables', T, async () => {
  const w = world();
  await w.sync.sync();
  w.id = { origin: 'https://hub.example', userId: 'bob', tok: 'bdt_bob' };
  await w.sync.sync();
  assert.deepEqual(w.log.slice(1), [
    ['disable', 'alice', 'bdt_alice', 5000],
    ['close', 'alice'],
    ['enable', 'bob', 'bdt_bob'],
  ]);
  assert.equal(w.sync.host().user, 'bob');
});

test('rapid changes run in order; a host superseded before its turn never enables', T, async () => {
  const w = world();
  w.sync.sync();
  w.id = { origin: 'https://hub.example', userId: 'bob', tok: 'bdt_bob' };
  w.sync.sync();
  w.want = false;
  await w.sync.sync();
  const kinds = w.log.map((x) => x.join(' '));
  assert.deepEqual(kinds, ['disable alice bdt_alice 5000', 'close alice', 'disable bob bdt_bob 5000', 'close bob']);
  assert.equal(w.sync.active(), false);
});

test('unticked while the hub is unreachable: the reset is retried with backoff until acknowledged, and remembered meanwhile', T, async () => {
  const w = world({ resetAnswers: [false, false, false, true] });
  await w.sync.sync();
  w.want = false;
  await w.sync.sync();
  assert.deepEqual(w.pending, { origin: 'https://hub.example', userId: 'alice' });
  assert.ok(!JSON.stringify(w.pending).includes('bdt_'), 'no token in the config');
  const waits = [await w.fire(), await w.fire()];
  assert.deepEqual(w.resets, ['bdt_alice', 'bdt_alice']);
  assert.ok(waits[1] > waits[0], 'backs off');
  assert.deepEqual(w.pending, { origin: 'https://hub.example', userId: 'alice' });
  await w.fire();
  assert.equal(w.pending, null);
  assert.equal(w.timers.length, 0);
});

test('next start: a remembered reset is retried with that account\'s current sign-in; another account or re-opting in clears it', T, async () => {
  const w = world();
  w.want = false;
  w.pending = { origin: 'https://hub.example', userId: 'alice' };
  await w.sync.sync();
  assert.equal(w.timers.length, 1);
  await w.fire();
  assert.deepEqual(w.resets, ['bdt_alice']);
  assert.equal(w.pending, null);

  const other = world();
  other.want = false;
  other.pending = { origin: 'https://hub.example', userId: 'carol' }; // carol signed out since: that token is revoked
  await other.sync.sync();
  assert.equal(other.pending, null);
  assert.equal(other.timers.length, 0);

  const again = world();
  again.pending = { origin: 'https://hub.example', userId: 'alice' };
  await again.sync.sync(); // ticked again: enable sets the role, nothing owed
  assert.equal(again.pending, null);
  assert.deepEqual(again.log, [['enable', 'alice', 'bdt_alice']]);
});

test('quit: hosting is turned off within the short bound; if the hub is not told it is remembered for next start', T, async () => {
  const w = world();
  await w.sync.sync();
  await w.sync.release();
  assert.deepEqual(w.log.slice(1), [['disable', 'alice', 'bdt_alice', 1500], ['close', 'alice']]);
  assert.equal(w.pending, null);
  const off = world({ resetAnswers: [false] });
  await off.sync.sync();
  await off.sync.release();
  assert.deepEqual(off.pending, { origin: 'https://hub.example', userId: 'alice' });
  assert.equal(off.timers.length, 0, 'no retry timer keeps a quitting app alive');
});

test('messaging attaches only to a connected host, reads the live token, and stops before that host is disabled (sign-out, untick, quit)', T, async () => {
  const attached = [];
  const attach = (host, o) => { const a = { user: o.userId, token: o.token, stopped: false }; attached.push(a); return { stop() { a.stopped = true; host.closed || attached.push(`stop ${o.userId}`); } }; };
  const off = world({ attach, enableState: 'retrying' });
  await off.sync.sync();
  assert.deepEqual(attached, [], 'not while the hub has not taken the host role');

  const w = world({ attach, enableState: 'connected' });
  await w.sync.sync();
  assert.equal(attached.length, 1);
  assert.equal(attached[0].token(), 'bdt_alice');
  w.id.tok = 'bdt_alice_refreshed';
  assert.equal(attached[0].token(), 'bdt_alice_refreshed', 'a refreshed sign-in is picked up');
  w.id = null; // sign-out
  await w.sync.sync();
  assert.equal(attached[0].stopped, true);
  assert.equal(attached[1], 'stop alice', 'stopped before the host was disabled and closed');

  const q = world({ attach, enableState: 'connected' });
  await q.sync.sync();
  await q.sync.release();
  assert.equal(attached.at(-1), 'stop alice');
  const c = world({ attach, enableState: 'connected' });
  await c.sync.sync();
  c.sync.close();
  assert.equal(attached.at(-1), 'stop alice');
  const plain = world({ enableState: 'connected' });
  await plain.sync.sync();
  assert.equal(plain.sync.active(), true, 'no attach: hosting unchanged');
});

test('messaging follows the host: starts when it connects later, stops when it is replaced, held, refused or signed out', T, async () => {
  const attached = [];
  const attach = (host, o) => { const a = { user: o.userId, stopped: false }; attached.push(a); return { stop() { a.stopped = true; } }; };
  const w = world({ attach, enableState: 'retrying' });
  await w.sync.sync();
  assert.equal(attached.length, 0, 'not while retrying');
  w.emit('connected');
  assert.equal(attached.length, 1, 'started once the host reconnected');
  w.emit('connected');
  assert.equal(attached.length, 1, 'never twice');
  w.emit('retrying');
  assert.equal(attached[0].stopped, false, 'a brief retry keeps it');
  for (const st of ['replaced', 'held', 'refused', 'signed-out']) {
    w.emit('connected');
    const a = attached.at(-1);
    assert.equal(a.stopped, false);
    w.emit(st);
    assert.equal(a.stopped, true, `stopped on ${st}`);
  }
  // A superseded host's late news does nothing.
  w.id = { origin: 'https://hub.example', userId: 'bob', tok: 'bdt_bob' };
  await w.sync.sync();
  const n = attached.length;
  w.listeners[0]('connected');
  assert.equal(attached.length, n);
});
