// Phone control PWA: the API client, the state machine (liveness, backoff,
// sign-out on 401, op results), the text-only renderer, the token vault and
// the service worker's never-cache-the-API rule. No DOM, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { textOf, findAll, byClass, byAttr } from '../js/h.js';
import { createApi, createController, sessionView, backoffMs, NetworkError, LIVE_MS } from '../js/phone-core.js';
import { phoneView } from '../js/phone-render.js';
import { createVault } from '../js/phone-vault.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };

const SID = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const dto = (over = {}) => ({
  session: SID, generation: 1, provider: { id: 'codex', label: 'Codex' }, ownership: 'plexiform-owned', label: 'Started by Plexiform · Codex',
  board: null, status: 'ready', activeTurn: null, capabilities: { steer: true, interrupt: true }, deliveries: [], ...over,
});
const ok = (result) => ({ status: 200, body: { host: 'mac', result } });

function memVault(token = null) {
  let t = token;
  return { saved: () => t, load: async () => t, save: async (x) => { t = x; }, clear: async () => { t = null; } };
}

// A scripted relay: handler(op, args) → response | 'network'.
function fakeApi(handler, { hosts = { status: 200, body: { hosts: [{ id: 'mac', name: 'Alice Mac', platform: 'darwin-arm64', current: false }] } } } = {}) {
  const calls = [];
  let token = null;
  const net = (r) => { if (r === 'network') throw new NetworkError(); return r; };
  return {
    calls,
    setToken(t) { token = t; },
    hasToken: () => !!token,
    token: () => token,
    hosts: async () => net(typeof hosts === 'function' ? hosts() : hosts),
    call: async (host, op, args = {}) => { calls.push({ host, op, args }); return net(await handler(op, args)); },
    startEmail: async () => ({ status: 200, body: { flow_id: 'f1', expires_in: 600 } }),
    verifyEmail: async (flow, code) => (code === '123456' ? { status: 200, body: { user: {}, teams: [], device_token: `bdt_${'a'.repeat(43)}`, device_id: 'phone' } } : { status: 400, body: { error: { code: 'INVALID_TOKEN', message: 'that code is wrong or has expired: ask for a new one' } } }),
    signOut: async () => ({ status: 200, body: { ok: true } }),
  };
}

test('backoff grows, is jittered and capped at 30 s', () => {
  assert.equal(backoffMs(1, () => 0), 500);
  assert.equal(backoffMs(1, () => 1), 1000);
  assert.equal(backoffMs(3, () => 1), 4000);
  assert.equal(backoffMs(50, () => 1), 30_000);
  assert.ok(backoffMs(50, () => 0) >= 15_000);
});

test('api: Bearer only, cookies omitted, never cached, a fresh request_id per relay call, nothing secret in the URL', async () => {
  const seen = [];
  const api = createApi({ fetch: async (url, init) => { seen.push({ url, init }); return { status: 200, json: async () => ({}) }; }, uuid: () => webcrypto.randomUUID() });
  const tok = `bdt_${'b'.repeat(43)}`;
  api.setToken(tok);
  await api.hosts();
  await api.call('mac/../x', 'list');
  await api.call('mac', 'list');
  await api.startEmail('a@b.c', 'Phone');
  for (const { url, init } of seen) {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.ok(!url.includes(tok));
  }
  assert.equal(seen[0].init.headers.authorization, `Bearer ${tok}`);
  assert.equal(seen[1].url, '/api/interaction/v1/hosts/mac%2F..%2Fx/call');
  const [a, b] = [JSON.parse(seen[1].init.body), JSON.parse(seen[2].init.body)];
  assert.match(a.request_id, UUID);
  assert.notEqual(a.request_id, b.request_id);
  assert.deepEqual(Object.keys(a).sort(), ['args', 'op', 'request_id']);
  // Sign-in calls never carry the token.
  assert.equal(seen[3].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(seen[3].init.body), { email: 'a@b.c', client: 'buddy_desktop', device_name: 'Phone', platform: 'phone-web' });
  // A network failure is a NetworkError, not a status.
  const down = createApi({ fetch: async () => { throw new TypeError('fetch failed'); }, uuid: () => 'x' });
  await assert.rejects(down.hosts(), NetworkError);
});

test('sessionView: a status is live only while the poll answers; stale "ready" is never shown as live', () => {
  const t = 1_000_000;
  const live = sessionView({ state: dto(), link: 'live', lastOkAt: t - 1000 }, t);
  assert.equal(live.live, true); assert.equal(live.label, 'Ready'); assert.equal(live.canSend, true);
  // The poll stopped answering: old lastOkAt, even though link still says live.
  const old = sessionView({ state: dto(), link: 'live', lastOkAt: t - LIVE_MS - 1 }, t);
  assert.equal(old.live, false); assert.equal(old.status, 'unknown'); assert.equal(old.canSend, false);
  assert.notEqual(old.label, 'Ready');
  assert.match(old.detail, /^Last known: Ready/);
  const stale = sessionView({ state: dto(), link: 'stale', lastOkAt: t }, t);
  assert.equal(stale.label, 'Reconnecting'); assert.equal(stale.canSend, false);
  assert.equal(sessionView({ state: dto(), link: 'offline', lastOkAt: t }, t).label, 'Offline');
  // Ended is final, so it is shown as ended whatever the link.
  const ended = sessionView({ state: dto({ status: 'ended' }), link: 'stale', lastOkAt: 0 }, t);
  assert.equal(ended.label, 'Ended'); assert.equal(ended.canSend, false);
  // Working + steer capability → steer; no interrupt while a request is pending.
  const working = sessionView({ state: dto({ status: 'working', activeTurn: TURN }), link: 'live', lastOkAt: t, pending: true }, t);
  assert.equal(working.canSteer, true); assert.equal(working.canInterrupt, false); assert.equal(working.canSend, false);
});

test('controller: sign-in stores the token in the vault; a wrong code stays on the code step', async () => {
  const vault = memVault();
  const api = fakeApi(async () => ok({ ok: true, sessions: [] }));
  const ctl = createController({ api, vault });
  await ctl.boot();
  assert.equal(ctl.state.view, 'signin');
  await ctl.startSignIn('not-an-email', 'Phone');
  assert.match(ctl.state.auth.error, /email/);
  await ctl.startSignIn('alice@dev.local', 'My phone');
  assert.equal(ctl.state.auth.flowId, 'f1');
  await ctl.verifyCode('000000');
  assert.equal(ctl.state.view, 'signin');
  assert.match(ctl.state.auth.error, /wrong/);
  assert.equal(vault.saved(), null);
  await ctl.verifyCode('123 456');
  assert.equal(ctl.state.view, 'hosts');
  assert.match(vault.saved(), /^bdt_/);
  assert.equal(api.token(), vault.saved());
  assert.deepEqual(ctl.state.hosts.items.map((h) => h.id), ['mac']);
});

test('controller: a 401 anywhere wipes the token and returns to sign-in', async () => {
  const vault = memVault('bdt_x');
  const api = fakeApi(async () => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'device token unknown or revoked' } } }));
  const ctl = createController({ api, vault });
  await ctl.boot();
  await ctl.openHost('mac');
  await until(() => ctl.state.view === 'signin');
  assert.equal(vault.saved(), null);
  assert.equal(api.token(), null);
  assert.match(ctl.state.notice.text, /signed out/i);
});

test('controller: a sign-out the hub never heard about says so and keeps a retry', async () => {
  const vault = memVault('bdt_x');
  const api = fakeApi(async () => ok({ ok: true, sessions: [], providers: [] }));
  const seen = [];
  const answers = ['network', { status: 503, body: { error: { code: 'UNAVAILABLE' } } }, { status: 200, body: { ok: true } }];
  api.signOut = async () => { seen.push(api.token()); const a = answers.shift(); if (a === 'network') throw new NetworkError(); return a; };
  const ctl = createController({ api, vault });
  await ctl.boot();
  await ctl.signOut();
  // Local sign-out happened; the claim is the truth, not "no longer has access".
  assert.equal(ctl.state.view, 'signin');
  assert.equal(vault.saved(), null);
  assert.equal(api.token(), null);
  assert.match(ctl.state.notice.text, /could not be told/);
  assert.match(ctl.state.notice.text, /another device/);
  assert.doesNotMatch(ctl.state.notice.text, /no longer has access/);
  const bar = phoneView(ctl.state, Date.now());
  assert.ok(findAll(bar, (n) => n.props?.['data-action'] === 'retry-signout').length === 1);
  ctl.dismissNotice();
  assert.ok(ctl.state.notice, 'the warning cannot be dismissed while the hub still accepts the sign-in');
  // Retry with the hub refusing (503): still untold. Then it lands.
  await ctl.retrySignOut();
  assert.match(ctl.state.notice.text, /could not be told/);
  await ctl.retrySignOut();
  assert.match(ctl.state.notice.text, /no longer has access/);
  assert.deepEqual(seen, ['bdt_x', 'bdt_x', 'bdt_x']);
  assert.equal(api.token(), null);
  ctl.dismissNotice();
  assert.equal(ctl.state.notice, null);
  // A 401 from sign-out means the hub already refuses it: that is "no access".
  const api2 = fakeApi(async () => ok({ ok: true, sessions: [], providers: [] }));
  api2.signOut = async () => ({ status: 401, body: {} });
  const ctl2 = createController({ api: api2, vault: memVault('bdt_y') });
  await ctl2.boot();
  await ctl2.signOut();
  assert.match(ctl2.state.notice.text, /no longer has access/);
});

test('controller: the long-poll goes stale on failure, backs off, and recovers live; a closed session is not shown as live', async () => {
  let now = 1_000_000;
  const script = [];
  const api = fakeApi(async (op, args) => {
    if (op === 'list') return ok({ ok: true, sessions: [dto()] });
    if (op === 'capabilities') return ok({ ok: true, providers: [{ provider: 'codex', label: 'Codex', available: true }] });
    if (op === 'state') return ok({ ok: true, state: dto() });
    // Each poll waits for the test to script its answer.
    if (op === 'watch') { await until(() => script.length, 5000); return script.shift()(args); }
    throw new Error(op);
  });
  const ctl = createController({ api, vault: memVault('bdt_x'), now: () => now, rand: () => 0 });
  await ctl.boot();
  await ctl.openHost('mac');
  assert.equal(ctl.state.sessions.items.length, 1);
  let release;
  const gate = new Promise((r) => { release = r; });
  script.push(async (args) => { assert.equal(args.after, 0); await gate; return 'network'; });
  await ctl.openSession(SID);
  assert.equal(ctl.state.view, 'session');
  assert.equal(sessionView(ctl.state.session, now).live, true);
  release();
  await until(() => ctl.state.session.link === 'stale');
  assert.equal(ctl.state.session.failures, 1);
  assert.equal(sessionView(ctl.state.session, now).live, false);
  // The renderer says "Reconnecting", never "Ready", while stale.
  const tree = phoneView(ctl.state, now);
  const pill = byClass(tree, 'pill')[0];
  assert.equal(textOf(pill), 'Reconnecting');
  assert.match(textOf(tree), /Last known: Ready/);
  assert.ok(byAttr(tree, 'disabled').some((n) => n.tag === 'textarea'));
  // Recovery: the next poll (woken early, as on 'online') answers.
  script.push(async () => ok({ ok: true, version: 3, state: dto({ status: 'working', activeTurn: TURN }) }));
  now += 1000;
  ctl.wake();
  await until(() => ctl.state.session.version === 3);
  assert.equal(ctl.state.session.link, 'live');
  assert.equal(ctl.state.session.failures, 0);
  assert.equal(textOf(byClass(phoneView(ctl.state, now), 'pill')[0]), 'Working');
  // Time passes with no answer: not live any more.
  assert.equal(sessionView(ctl.state.session, now + LIVE_MS + 1).live, false);
  // The session was closed elsewhere: the poll says stale → gone, the loop stops.
  script.push(async (args) => { assert.equal(args.after, 3); return ok({ ok: false, status: 'stale', error: 'This session changed. Refresh and select it again.' }); });
  await until(() => ctl.state.session.link === 'gone');
  assert.match(textOf(phoneView(ctl.state, now)), /This session changed/);
  ctl.back();
});

test('controller: host offline (404) keeps retrying and shows unavailable, not ready', async () => {
  let n = 0;
  const api = fakeApi(async (op) => {
    if (op === 'state') return ok({ ok: true, state: dto() });
    if (op === 'watch') { n++; return n === 1 ? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'that device is not available' } } } : new Promise(() => {}); }
    return ok({ ok: true, sessions: [], providers: [] });
  });
  const ctl = createController({ api, vault: memVault('bdt_x'), rand: () => 0 });
  await ctl.boot();
  await ctl.openHost('mac');
  await ctl.openSession(SID);
  await until(() => ctl.state.session.link === 'gone');
  assert.equal(sessionView(ctl.state.session, Date.now()).label, 'Unavailable');
  assert.match(ctl.state.session.error, /not reachable/);
  ctl.wake();
  await until(() => n === 2);
  ctl.back();
});

test('controller: send, steer, busy, interrupt and close carry the session contract', async () => {
  let current = dto();
  const replies = [];
  const api = fakeApi(async (op, args) => {
    if (op === 'state') return ok({ ok: true, state: current });
    if (op === 'watch') return new Promise(() => {});
    if (op === 'list' || op === 'capabilities') return ok({ ok: true, sessions: [], providers: [] });
    return replies.shift()(op, args);
  });
  const ctl = createController({ api, vault: memVault('bdt_x') });
  await ctl.boot();
  await ctl.openHost('mac');
  await ctl.openSession(SID);

  replies.push(() => ok({ ok: true, status: 'acknowledged', delivery: {}, state: (current = dto({ status: 'working', activeTurn: TURN, deliveries: [{ id: 'd1', text: 'hi', mode: 'new-turn', state: 'acknowledged', recorded: false, turn: TURN, response: '', error: null, notices: [], sentAt: 1, finishedAt: null }] })) }));
  assert.equal(await ctl.send('hi'), true);
  let last = api.calls.at(-1);
  assert.deepEqual(last, { host: 'mac', op: 'send', args: { session: SID, generation: 1, text: 'hi' } });
  // Working: the next send steers the active turn.
  replies.push(() => ok({ ok: false, status: 'busy', error: 'A message is being sent or a turn is running. Steer it or wait for it to finish.' }));
  assert.equal(await ctl.send('more'), false);
  last = api.calls.at(-1);
  assert.equal(last.args.expectedTurn, TURN);
  assert.equal(ctl.state.notice.tone, 'warn');
  assert.match(ctl.state.notice.text, /turn is running/);
  // Too long is refused before it leaves the phone.
  const before = api.calls.length;
  assert.equal(await ctl.send('x'.repeat(4001)), false);
  assert.equal(api.calls.length, before);
  replies.push(() => ok({ ok: true, status: 'interrupt-requested', state: current }));
  assert.equal(await ctl.interrupt(), true);
  assert.deepEqual(api.calls.at(-1).args, { session: SID, generation: 1, turn: TURN });
  // A network failure on send says it may not have been sent.
  replies.push(() => 'network');
  assert.equal(await ctl.send('lost?'), false);
  assert.match(ctl.state.notice.text, /may not have been sent/);
  // The link dropped with the send on the wire: outcome unknown, not "not reachable".
  replies.push(() => ({ status: 408, body: { error: { code: 'TIMEOUT', message: 'The connection to that device dropped.', reason: 'OUTCOME_UNKNOWN' } } }));
  assert.equal(await ctl.send('dropped?'), false);
  assert.match(ctl.state.notice.text, /Outcome unknown/);
  assert.match(ctl.state.notice.text, /Check the session/);
  assert.doesNotMatch(ctl.state.notice.text, /not reachable/);
  replies.push(() => ok({ ok: true, status: 'closed' }));
  assert.equal(await ctl.close(), true);
  assert.deepEqual(api.calls.at(-1), { host: 'mac', op: 'close', args: { session: SID, generation: 1 } });
  ctl.back();
});

test('controller: sending is refused locally while not live', async () => {
  const api = fakeApi(async (op) => (op === 'state' ? ok({ ok: true, state: dto() }) : op === 'watch' ? 'network' : ok({ ok: true, sessions: [], providers: [] })));
  const ctl = createController({ api, vault: memVault('bdt_x'), online: () => false, rand: () => 0 });
  await ctl.boot();
  await ctl.openHost('mac');
  await ctl.openSession(SID);
  await until(() => ctl.state.session.link === 'offline');
  const n = api.calls.length;
  assert.equal(await ctl.send('hello'), false);
  assert.ok(api.calls.slice(n).every((c) => c.op === 'watch'));
  assert.match(ctl.state.notice.text, /Not connected/);
  ctl.back();
});

test('render: provider text is text only, never markup; notices and errors show', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const st = {
    view: 'session', busy: false, notice: null, host: { id: 'mac', name: '<b>Mac</b>' },
    session: { id: SID, link: 'live', lastOkAt: 1000, pending: false, state: dto({ provider: { id: 'codex', label: evil }, deliveries: [
      { id: 'd1', text: evil, mode: 'new-turn', state: 'completed', recorded: true, turn: TURN, response: evil, error: evil, notices: ['The provider asked for an approval; Plexiform refused it.'], sentAt: 1, finishedAt: 2 },
    ] }) },
  };
  const tree = phoneView(st, 1000);
  assert.deepEqual(findAll(tree, (n) => ['img', 'script', 'b', 'iframe'].includes(n.tag)), []);
  assert.ok(textOf(tree).includes(evil));
  assert.match(textOf(tree), /Plexiform refused it/);
  // No element carries an inline handler or a style attribute string (CSP).
  findAll(tree, () => true).forEach((n) => { for (const k of Object.keys(n.props)) assert.ok(!/^on/i.test(k) && k !== 'style', k); });
  // Sessions screen: list statuses are labelled as last known.
  const list = phoneView({ view: 'sessions', busy: false, notice: null, host: { id: 'mac', name: 'Mac' }, sessions: { items: [dto()], providers: [], loadedAt: 0, error: null } }, 100_000);
  assert.match(textOf(list), /Last known: Ready/);
  assert.match(textOf(list), /Checked 2 min ago/);
});

test('render: hosts empty state explains the opt-in; sign-in has labelled fields', () => {
  const empty = phoneView({ view: 'hosts', busy: false, notice: null, hosts: { items: [], loadedAt: 0, error: null } }, 0);
  assert.match(textOf(empty), /Let my other devices use sessions/);
  const si = phoneView({ view: 'signin', busy: false, notice: null, auth: { email: '', flowId: null, deviceName: 'iPhone', error: null } }, 0);
  for (const input of findAll(si, (n) => n.tag === 'input')) assert.ok(findAll(si, (n) => n.tag === 'label' && n.props.for === input.props.id).length, input.props.id);
  const code = phoneView({ view: 'signin', busy: false, notice: null, auth: { email: 'a@b.c', flowId: 'f', deviceName: 'x', error: 'bad' } }, 0);
  assert.equal(findAll(code, (n) => n.props.id === 'code')[0].props.autocomplete, 'one-time-code');
  assert.equal(findAll(code, (n) => n.props.role === 'alert').length, 1);
});

test('vault: the token is stored encrypted under a non-extractable key; clear and corruption drop it', async () => {
  const m = new Map();
  const kv = { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } };
  const v = createVault({ kv, subtle: webcrypto.subtle, getRandomValues: (a) => webcrypto.getRandomValues(a) });
  const tok = `bdt_${'Z'.repeat(43)}`;
  assert.equal(await v.load(), null);
  await v.save(tok);
  assert.equal(await v.load(), tok);
  const rec = m.get('token');
  assert.ok(!Buffer.from(rec.data).toString('latin1').includes('bdt_'));
  assert.equal(m.get('key').extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', m.get('key')));
  rec.data[0] ^= 1;
  assert.equal(await v.load(), null);
  assert.equal(m.has('token'), false);
  await v.save(tok);
  await v.clear();
  assert.equal(await v.load(), null);
  assert.equal(m.size, 0);
});

test('service worker: only the app shell is cached; API, auth and non-GET requests are never intercepted', async () => {
  const src = readFileSync(new URL('../phone-sw.js', import.meta.url), 'utf8');
  const listeners = {};
  const puts = [];
  const cache = { addAll: async () => {}, put: async (k) => { puts.push(k); } };
  const self = { location: { origin: 'https://hub.example' }, addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting: () => {}, clients: { claim: () => {} } };
  const ctx = { self, URL, caches: { open: async () => cache, keys: async () => [], match: async () => null }, fetch: async () => ({ ok: true, type: 'basic', clone() { return this; } }) };
  vm.runInNewContext(src, ctx);
  const dispatch = async (url, method = 'GET') => {
    let responded = null;
    const waits = [];
    listeners.fetch({ request: { url, method }, respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) });
    if (responded) await responded;
    await Promise.all(waits);
    return !!responded;
  };
  for (const u of ['/api/interaction/v1/hosts', '/api/interaction/v1/hosts/mac/call', '/api/auth/email/verify', '/api/auth/signout', '/auth/email', '/', '/web/js/app.js', '/phone/?x=1']) {
    assert.equal(await dispatch(`https://hub.example${u}`), false, u);
  }
  assert.equal(await dispatch('https://hub.example/phone/', 'POST'), false);
  assert.equal(await dispatch('https://evil.example/phone/'), false);
  assert.equal(await dispatch('https://hub.example/phone/'), true);
  assert.equal(await dispatch('https://hub.example/web/js/phone-core.js'), true);
  assert.deepEqual(puts, ['/phone/', '/web/js/phone-core.js']);
});

test('shared with me: the hosts screen labels read-only vs can-send; a read-only session has no composer and no close; "Sent by" shows who typed', async () => {
  const shareCalls = [];
  const api = fakeApi(async () => ok({ ok: true, sessions: [] }), { hosts: { status: 200, body: { hosts: [] } } });
  const items = [
    { id: 'sh-1', session: SID, scope: 'watch', expires_at: null, team: { id: 't', name: 'Dev' }, owner: { name: 'Alice' }, online: true },
    { id: 'sh-2', session: SID, scope: 'interact', expires_at: null, team: { id: 't', name: 'Dev' }, owner: { name: 'Carl' }, online: false },
  ];
  api.shared = async () => ({ status: 200, body: { shared: items } });
  api.sharedCall = async (share, op, args) => { shareCalls.push({ share, op, args }); return op === 'watch' ? new Promise(() => {}) : ok({ ok: true, state: dto({ deliveries: [{ id: TURN, text: 'hi <b>', by: 'Bob', mode: 'new-turn', state: 'completed', recorded: true, turn: null, response: 'yo', error: null, notices: [], sentAt: 1, finishedAt: 2 }, { id: SID, text: 'owner text', by: null, mode: 'new-turn', state: 'completed', recorded: true, turn: null, response: '', error: null, notices: [], sentAt: 1, finishedAt: 2 }] }) }); };
  const ctl = createController({ api, vault: memVault('bdt_x') });
  await ctl.boot();
  await until(() => ctl.state.shared.items);
  const home = phoneView(ctl.state, Date.now());
  assert.match(textOf(home), /Shared with me/);
  assert.match(textOf(home), /Alice’s session/);
  assert.match(textOf(home), /Dev · Read-only/);
  assert.match(textOf(home), /Dev · Can send · Offline/);
  assert.equal(byAttr(home, 'data-id', 'sh-2')[0].props.disabled, true, 'an offline share cannot be opened');
  await ctl.openShared('sh-1');
  assert.equal(ctl.state.view, 'session');
  assert.deepEqual(shareCalls[0], { share: 'sh-1', op: 'state', args: { session: SID } });
  const view = phoneView(ctl.state, Date.now());
  assert.equal(findAll(view, (n) => n.tag === 'textarea').length, 0, 'no composer when read-only');
  assert.equal(byAttr(view, 'data-action', 'close').length, 0, 'only the owner closes');
  assert.match(textOf(view), /Read-only: you can watch this session/);
  assert.match(textOf(view), /Sent by Bob · Done/);
  assert.match(textOf(view), /Alice · Done/);
  assert.equal(await ctl.send('nope'), false);
  assert.ok(!shareCalls.some((c) => c.op === 'send'));
  ctl.back();
  assert.equal(ctl.state.view, 'hosts');
});
