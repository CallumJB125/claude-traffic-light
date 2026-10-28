'use strict';
// L32 (plan-l32 App PR delta, Rev 4): owners see who is watching a shared session.
// The grantee's beat (src/share-view.js), the hub call (team-hub-client view), the thread wiring (thread-main
// thread:shared-painted and `watching`), and the owner's copy of the hub's viewers (remote-interaction).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createShareView } = require('../src/share-view');
const { createTeamHubClient } = require('../src/team-hub-client');
const { createThreadMain } = require('../src/thread-main');
const { createRemoteInteractionHost } = require('../src/remote-interaction');
const { BEAT_MS } = require('../src/session-presence');

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const REF = '11111111-1111-4111-8111-111111111111', REF2 = '22222222-2222-4222-8222-222222222222';

function timers() {
  const q = [];
  return {
    q,
    setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; q.push(t); return t; },
    clearTimeout: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    async fire() { const t = q.shift(); if (t) t.fn(); await flush(); },
  };
}
// A route whose beat answers from `answers` (true beats) and records every call.
function route(ref = REF, answers = []) {
  const sent = [];
  return { sent, r: { ref, live: () => true, beat: async (v) => { sent.push(v); if (!v) return { ok: true, viewing: false }; const a = answers.length ? answers.shift() : { ok: true, viewing: true }; if (a === 'throw') throw new Error('network'); return typeof a === 'function' ? a() : a; } } };
}
function viewRig() {
  let shown = true;
  const t = timers();
  const sv = createShareView({ showing: () => shown, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  return { sv, t, show: (v) => { shown = v; } };
}

// ── share-view ──────────────────────────────────────────────────────────
test('share-view: nothing before painted; then a beat now and every BEAT_MS; painted once; one in flight', async () => {
  const x = viewRig(), a = route();
  x.sv.open('7:1', a.r);
  await flush();
  assert.deepEqual(a.sent, [], 'open alone sends nothing (the banner is not on screen yet)');
  assert.equal(x.sv.watching('7:1'), 'pending');
  assert.equal(x.sv.painted('7:1', REF), true); await flush();
  assert.deepEqual(a.sent, [true]);
  assert.equal(x.sv.watching('7:1'), 'on');
  assert.equal(x.t.q[0].ms, BEAT_MS);
  assert.equal(x.sv.painted('7:1', REF), false, 'once');
  assert.equal(x.sv.painted('9:9', REF), false, 'another document');
  await x.t.fire();
  assert.deepEqual(a.sent, [true, true]);
  // One in flight: a slow beat, and the next timer fires before it answers.
  let release;
  a.r.beat = (v) => { a.sent.push(v); return new Promise((r) => { release = () => r({ ok: true, viewing: true }); }); };
  await x.t.fire(); await x.t.fire();
  assert.deepEqual(a.sent, [true, true, true]);
  release(); await flush();
});

test('share-view: hidden says viewing:false once (only after a beat); shown again the line comes back and no beat goes until a fresh paint (D-S2)', async () => {
  const x = viewRig(), a = route();
  x.sv.open('7:1', a.r); x.sv.painted('7:1', REF); await flush();
  x.show(false); await x.t.fire(); await x.t.fire();
  assert.deepEqual(a.sent, [true, false], 'false once, never twice in a row');
  assert.equal(x.sv.watching('7:1'), 'off');
  x.show(true); x.sv.poke('7:1'); await flush(); await x.t.fire();
  assert.deepEqual(a.sent, [true, false], 'shown: no beat before the line is painted again');
  assert.equal(x.sv.watching('7:1'), 'pending', 'the line shows again');
  assert.equal(x.sv.painted('7:1', REF2), false, 'another share does not count');
  assert.equal(x.sv.painted('7:1', REF), true); await flush();
  assert.deepEqual(a.sent, [true, false, true]);
  assert.equal(x.sv.watching('7:1'), 'on');
  x.sv.close('7:1'); x.sv.clearAll();
  assert.deepEqual(a.sent, [true, false, true, false]);
  assert.equal(x.t.q.length, 0);
  // Hidden from the start: nothing was sent, so nothing to take back.
  const y = viewRig(), b = route();
  y.show(false); y.sv.open('7:1', b.r); y.sv.painted('7:1', REF); await flush(); await y.t.fire(); y.sv.close();
  assert.deepEqual(b.sent, []);
});

test('share-view: a 404 on the first beat (old hub or gone) stops it for this (document, share): off, no more beats, nothing to take back', async () => {
  const x = viewRig(), a = route(REF, [{ ok: false, status: 'unsupported' }]);
  x.sv.open('7:1', a.r); x.sv.painted('7:1', REF); await flush();
  assert.deepEqual(a.sent, [true]);
  assert.equal(x.sv.watching('7:1'), 'off');
  assert.equal(x.t.q.length, 0, 'no timer left');
  x.sv.poke('7:1'); x.sv.open('7:1', a.r); assert.equal(x.sv.painted('7:1', REF), false); await flush();
  x.sv.close();
  assert.deepEqual(a.sent, [true], 'not again in this open, and no viewing:false');
  // Reopened (a new document): it tries again.
  x.sv.open('7:2', a.r); x.sv.painted('7:2', REF); await flush();
  assert.deepEqual(a.sent, [true, true]);
});

test('share-view (D-S1): 401s and network failures keep the line and keep beating; an accepted viewing:false (the cap) is off and stops', async () => {
  const x = viewRig(), a = route(REF, ['throw', 'throw', { ok: true, viewing: true }, { ok: false, status: 'sign-in' }, { ok: false, status: 'sign-in' }, 'throw', { ok: false, status: 'failed' }]);
  x.sv.open('7:1', a.r); x.sv.painted('7:1', REF); await flush();
  assert.equal(x.sv.watching('7:1'), 'pending', 'a lost beat may have landed: the line stays');
  await x.t.fire();
  assert.equal(x.sv.watching('7:1'), 'pending');
  await x.t.fire();
  assert.equal(x.sv.watching('7:1'), 'on');
  for (let i = 0; i < 4; i++) { await x.t.fire(); assert.equal(x.sv.watching('7:1'), 'on', `failure ${i}: kept`); }
  assert.equal(a.sent.length, 7, 'still beating');
  assert.equal(x.t.q.length, 1);
  // The hub at its 50-viewer cap answers {viewing:false}: not seen, so off, and no more beats this open.
  const y = viewRig(), b = route(REF, [{ ok: true, viewing: false }]);
  y.sv.open('7:1', b.r); y.sv.painted('7:1', REF); await flush();
  assert.equal(y.sv.watching('7:1'), 'off');
  assert.equal(y.t.q.length, 0);
  y.sv.close();
  assert.deepEqual(b.sent, [true], 'nothing to take back');
});

test('share-view: another share in the same document closes the old one and needs its own paint (A-S3); a moved route stops', async () => {
  const x = viewRig(), a = route(REF), b = route(REF2);
  x.sv.open('7:1', a.r); x.sv.painted('7:1', REF); await flush();
  x.sv.open('7:1', b.r); await flush();
  assert.deepEqual(a.sent, [true, false]);
  assert.deepEqual(b.sent, [], 'not before its own paint');
  assert.equal(x.sv.painted('7:1', REF), false, "the old share's paint does not count");
  assert.equal(x.sv.painted('7:1', REF2), true); await flush();
  assert.deepEqual(b.sent, [true]);
  // The route moved (another hub, viewer or row): stop and say so once.
  let live = true; b.r.live = () => live;
  live = false; await x.t.fire();
  assert.deepEqual(b.sent, [true, false]);
  assert.equal(x.t.q.length, 0);
});

// ── team-hub-client view ────────────────────────────────────────────────
function hubClient(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (answer === 'throw') throw new Error('offline');
    const { status, body } = typeof answer === 'function' ? answer(url) : answer;
    const raw = body === undefined ? '' : JSON.stringify(body);
    return { status, headers: { get: () => String(Buffer.byteLength(raw)) }, text: async () => raw };
  };
  const c = createTeamHubClient({ baseUrl: 'https://hub.example', token: () => 'tok-1', fetch, viewerId: 'u-me' });
  return { c, calls };
}
test('team-hub-client view: POST …/shared/:ref/view {viewing} with the bearer; 404/405 unsupported, 401 sign-in, network; bad args refused unsent', async () => {
  const ok = hubClient({ status: 200, body: { viewing: true } });
  assert.deepEqual(await ok.c.view({ id: 'u-me' }, 'team-1', REF, true), { ok: true, viewing: true });
  assert.deepEqual(ok.calls, [{ url: `https://hub.example/api/interaction/v1/shared/${REF}/view`, method: 'POST', auth: 'Bearer tok-1', body: { viewing: true } }]);
  for (const [status, want] of [[404, 'unsupported'], [405, 'unsupported'], [401, 'sign-in'], [429, 'failed'], [500, 'failed']]) {
    assert.equal((await hubClient({ status, body: { error: {} } }).c.view({ id: 'u-me' }, 'team-1', REF, true)).status, want, String(status));
  }
  assert.equal((await hubClient({ status: 200, body: { nope: 1 } }).c.view({ id: 'u-me' }, 'team-1', REF, false)).ok, false, 'an unreadable answer');
  assert.equal((await hubClient('throw').c.view({ id: 'u-me' }, 'team-1', REF, true)).status, 'network');
  const bad = hubClient({ status: 200, body: { viewing: true } });
  for (const args of [[{ id: 'u-other' }, 'team-1', REF, true], [{ id: 'u-me' }, 'team-1', 'not-a-uuid', true], [{ id: 'u-me' }, 'team-1', REF, 'yes'], [null, 'team-1', REF, true]]) {
    assert.equal((await bad.c.view(...args)).status, 'invalid');
  }
  assert.equal(bad.calls.length, 0);
});

// ── thread-main: the paint, the beat, `watching` ────────────────────────
const ID = 'a'.repeat(64);
function threadRig({ kind = 'shared', answers = [] } = {}) {
  let visible = true, gen = 1;
  const contents = { id: 7, isDestroyed: () => false, mainFrame: {}, send() {} };
  const win = { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false };
  const buddy = { threadContext: () => ({ window: win, contents, frame: contents.mainFrame, generation: gen, boundId: ID, foreground: true, account: 'a', workspace: 'w' }) };
  const a = route(REF, answers), t = timers();
  let target = { kind, teamId: 'team1', taskId: 'task-1' }, time = 100000;
  const tm = createThreadMain({ buddy: () => buddy, chatPreview: true, target: () => target, tasks: () => ({ openTask: async () => ({ ok: false }), closeTask: async () => {} }),
    activity: async () => null, openInTasks: async () => true, goToTerminal: async () => ({ ok: true }), now: () => time,
    sharedRead: async () => ({ header: { title: 'T' } }), sharedView: () => a.r, viewTimers: { setTimeout: t.setTimeout, clearTimeout: t.clearTimeout } });
  const h = {}; tm.register({ handle: (ch, fn) => { h[ch] = fn; } });
  const ev = { sender: contents, senderFrame: contents.mainFrame };
  return { tm, h, ev, a, t, call: (ch, ...x) => h[ch](ev, ...x), setVisible: (v) => { visible = v; }, advance: (ms) => { time += ms; }, setTarget: (x) => { target = x; }, bump: () => { gen++; } };
}
test('thread:shared-painted: Guard T, the bound shared row only, once; the beat starts then and never from a read', async () => {
  const x = threadRig();
  await x.call('thread:open', ID);
  await x.call('thread:shared-state', ID); await flush();
  assert.deepEqual(x.a.sent, [], 'open and reads send nothing');
  assert.equal(await x.h['thread:shared-painted']({ sender: {}, senderFrame: {} }, ID), false, 'another sender');
  assert.equal(await x.call('thread:shared-painted', 'f'.repeat(64)), false, 'not the bound row');
  assert.equal(await x.call('thread:shared-painted', ID, 'extra'), false);
  assert.deepEqual(x.a.sent, []);
  assert.equal(await x.call('thread:shared-painted', ID), true); await flush();
  assert.deepEqual(x.a.sent, [true]);
  // A task row or an owned row can't start a beat.
  for (const kind of ['task', 'owned', 'session']) {
    const y = threadRig({ kind });
    await y.call('thread:open', ID);
    assert.equal(await y.call('thread:shared-painted', ID), false, kind);
    await flush();
    assert.deepEqual(y.a.sent, [], kind);
  }
});

test('thread:shared-state carries watching: pending before the first beat, on after one, off after a 404 (and no more beats)', async () => {
  const x = threadRig({ answers: [{ ok: false, status: 'unsupported' }] });
  await x.call('thread:open', ID);
  assert.equal((await x.call('thread:shared-state', ID)).watching, 'pending');
  await x.call('thread:shared-painted', ID); await flush();
  assert.equal((await x.call('thread:shared-state', ID)).watching, 'off', 'current, not the cached read');
  await x.t.fire(); await flush();
  assert.deepEqual(x.a.sent, [true]);
  const y = threadRig();
  await y.call('thread:open', ID); await y.call('thread:shared-painted', ID); await flush();
  y.advance(3000);
  assert.equal((await y.call('thread:shared-state', ID)).watching, 'on');
  // Hidden: the next beat says false; the state says off.
  y.setVisible(false); await y.t.fire();
  assert.deepEqual(y.a.sent, [true, false]);
  assert.equal((await y.call('thread:shared-state', ID)).watching, 'off');
  // Shown again (D-S2): the read says pending (the line comes back) and nothing is sent until the paint.
  y.setVisible(true); y.advance(3000);
  assert.equal((await y.call('thread:shared-state', ID)).watching, 'pending');
  await y.t.fire(); await flush();
  assert.deepEqual(y.a.sent, [true, false], 'no beat before the paint');
  assert.equal(await y.call('thread:shared-painted', ID), true); await flush();
  assert.deepEqual(y.a.sent, [true, false, true]);
  // Leaving the share for a task row closes it.
  y.setTarget({ kind: 'task', taskId: 'task-1' }); await y.call('thread:open', ID);
  assert.deepEqual(y.a.sent, [true, false, true, false]);
});

// ── remote-interaction: the owner's copy of who is watching ─────────────
const USER = 'u-owner';
function stubAdapter() {
  return { label: 'Stub', capabilities: { newTurn: true, steer: false, interrupt: false, ack: true, echo: false, stream: false, existingSessions: false },
    on: () => () => {}, alive: () => true, open: async () => ({ target: 'stub-target-1' }) };
}
const frame = (op, args = {}) => ({ type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: USER, from: 'phone', op, args });
async function ownerHost(listBody) {
  let time = 1_000_000;
  const shares = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    let status = 200, body = {};
    if (u.pathname === '/api/interaction/v1/role') body = { ok: true };
    else if (u.pathname === '/api/interaction/v1/shares' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      const s = { id: crypto.randomUUID(), session: b.session, team: { id: b.team, name: 'Design' }, scope: b.scope, owner: { name: 'Owner' }, members: [{ id: 'u-alice', name: 'Alice', role: 'member' }] };
      shares.push(s); body = { share: s };
    } else if (u.pathname === '/api/interaction/v1/shares') body = { teams: [{ id: 'team-1', name: 'Design' }], shares: shares.map((s) => ({ ...s, ...listBody(s) })) };
    return { status, ok: status === 200, json: async () => body };
  };
  class WS extends EventEmitter { constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'relay.welcome', user: USER, device: 'd-1', resume: 'r-1' })), false)); } send() {} close() {} }
  const host = createRemoteInteractionHost({ userId: USER, adapters: { stub: stubAdapter() }, boardCurrent: (b) => b === null, now: () => time });
  await host.enable({ baseUrl: 'https://hub.example', token: 'tok', WebSocket: WS, fetch });
  const launched = await host.handle(frame('launch', { provider: 'stub' }));
  const made = await host.shareSession({ session: launched.state.session, team: 'team-1', scope: 'watch' });
  assert.equal(made.ok, true, JSON.stringify(made));
  return { host, advance: (ms) => { time += ms; } };
}
test('remote-interaction: viewers are names only, cleaned and capped, shown while fresh (35 s); a hub without them shows none', async () => {
  const names = [{ user_id: 'u-alice', name: 'Al‮ice\u0007', at: '2026-11-03T10:00:00Z' }, ...Array.from({ length: 60 }, (_, i) => ({ user_id: `u-${i}`, name: `P${i}`, at: 'x' })), { user_id: 'u-x', name: 7 }, null];
  const x = await ownerHost(() => ({ viewers: names }));
  try {
    assert.deepEqual(x.host.shared()[0].viewers, [], 'nothing before a list');
    const r = await x.host.listShares();
    assert.equal(r.ok, true);
    const v = r.shares[0].viewers;
    assert.equal(v.length, 50, 'capped at 50');
    assert.equal(v[0], 'Alice', 'control and bidi characters stripped');
    assert.ok(v.every((n) => typeof n === 'string'), 'names only');
    assert.ok(!JSON.stringify(v).includes('u-'), 'no viewer ids');
    x.advance(34_000);
    assert.equal(x.host.shared()[0].viewers.length, 50);
    x.advance(2_000);
    assert.deepEqual(x.host.shared()[0].viewers, [], 'not refreshed for 35 s: no one is said to be watching');
  } finally { x.host.close(); }
  const old = await ownerHost(() => ({}));
  try {
    const r = await old.host.listShares();
    assert.equal(r.ok, true);
    assert.deepEqual(r.shares[0].viewers, [], 'an older hub: none, no error');
  } finally { old.host.close(); }
});
