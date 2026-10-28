'use strict';
// T2: a teammate's shared session as a read-only thread. Projection, service bind/read, thread-main
// authority, presence through the shared owner, and the renderer.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const SharedView = require('../src/shared-thread-view');
const { createOverviewService } = require('../src/overview-service');
const { createThreadMain, CHANNELS } = require('../src/thread-main');
const { createPresenceOwner } = require('../src/presence-owner');
const { createPresenceLink } = require('../src/team-presence-link');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const ID = 'e'.repeat(64);
const UUID1 = '11111111-1111-4111-8111-111111111111', UUID2 = '22222222-2222-4222-8222-222222222222';

// ── the projection ──────────────────────────────────────────────────────
const state = (over = {}) => ({ status: 'working', generation: 3, provider: { id: 'claude', label: 'Claude Code' }, task_title: 'Fix login', activity: { label: 'Editing files', phase: 'working', observed_at: 1000, turn: UUID1 },
  deliveries: [{ id: 'd1', text: 'hello', by: 'Alice', state: 'replied', response: 'done', sentAt: 500 }], ...over });
const route = { ownerName: 'Bob', fake: false, ref: UUID1, cardId: 'card-secret', team: 'team-secret' };

test('projection: a fixed key list, no route fields, scope and expiry from the share, deliveries bounded and cleaned', () => {
  const hostile = { ...state({ deliveries: Array.from({ length: 14 }, (_, i) => ({ id: `d${i}`, text: `t${i}\u0000\u0007${'x'.repeat(5000)}`, by: 'Al\u202eice', state: 'bogus', response: 'r'.repeat(20000), sentAt: i, ref: UUID2, token: 'tok-secret', selection: 's' })) }), ref: UUID2, selection: 'sel', capabilities: { steer: true } };
  const out = SharedView.project({ state: hostile, share: { scope: 'interact', expiresAt: '2030-01-01T10:00:00.000Z' }, route, now: 2000 });
  assert.deepEqual(Object.keys(out), [...SharedView.TOP_KEYS]);
  assert.deepEqual(Object.keys(out.header), [...SharedView.HEADER_KEYS]);
  assert.equal(out.deliveries.length, 10, 'the newest 10');
  assert.equal(out.deliveries[0].id, 'd4');
  for (const d of out.deliveries) {
    assert.deepEqual(Object.keys(d), [...SharedView.DELIVERY_KEYS]);
    assert.ok(d.text.length <= 4000 && d.response.length <= 16000);
    assert.doesNotMatch(d.text + d.by, /[\u0000-\u0008\u202a-\u202e]/);
    assert.equal(d.state, 'unknown');
  }
  const json = JSON.stringify(out);
  for (const secret of ['card-secret', 'team-secret', 'tok-secret', UUID1, UUID2, 'sel']) assert.ok(!json.includes(secret), secret);
  assert.equal(out.header.scope, 'interact'); assert.equal(out.canSendLater, true);
  assert.equal(out.header.expiresAt, '2030-01-01T10:00:00.000Z');
  assert.equal(out.banner, true);
});
test('projection: a missing share or unknown scope is watch; activity is a fixed category and goes stale', () => {
  const a = SharedView.project({ state: state(), share: null, route, now: 2000 });
  assert.equal(a.header.scope, 'watch'); assert.equal(a.canSendLater, false); assert.equal(a.header.expiresAt, null);
  assert.deepEqual(a.activity, { category: 'Editing files', ageMs: 1000, stale: false });
  const b = SharedView.project({ state: state({ activity: { label: 'rm -rf /', phase: 'working', observed_at: 1000, turn: UUID1 } }), share: { scope: 'weird' }, route, now: 2000 });
  assert.deepEqual(b.activity, { category: null, ageMs: null, stale: false }, 'a free-text label never passes');
  const c = SharedView.project({ state: state(), share: null, route, now: 1000 + SharedView.STALE_MS + 1 });
  assert.equal(c.activity.stale, true);
  assert.equal(SharedView.project({ state: state({ task_title: '' }), share: null, route, now: 1 }).header.title, "Bob's Claude Code session");
});

// ── the service: bind from one list read, read through inspect only ─────
const entry = (ref, over = {}) => ({ ref, team: { id: 'team1', name: 'Team one' }, owner: { id: 'bob', name: 'Bob' }, share: { explicit: true, scope: 'watch', expiresAt: null, revoked: false },
  provider: null, device: null, card: null, task_title: null, state: 'Unknown', input_needed: false, input_reported_needed: false, observed_at: null, self_reported: null, online: true, capabilities: {}, handoffs: [], children: [], deliveries: [], ...over });
function rig({ entries = [entry(UUID1)], inspectResult = null } = {}) {
  const calls = { sharedEntries: 0, inspect: [], other: 0 };
  let viewer = { id: 'alice', name: 'Alice' }, inspectOut = inspectResult;
  const hub = { origin: 'https://hub.example', viewer: () => viewer,
    sharedEntries: async () => { calls.sharedEntries++; return { teams: [{ id: 'team1', name: 'Team one', entries }] }; },
    passiveSessions: async () => ({ teamsTotal: 1, teams: [{ id: 'team1', name: 'Team one', entries }], partial: false }),
    inspect: async (v, team, ref) => { calls.inspect.push([v.id, team, ref]); return typeof inspectOut === 'function' ? inspectOut() : inspectOut ?? { ok: true, status: 'ok', state: state({ observed_at: 1 }), share: { scope: 'watch', expiresAt: null } }; },
    teams: async () => { calls.other++; return []; }, sessions: async () => { calls.other++; return []; } };
  let current = hub; const sent = [];
  const svc = createOverviewService({ sessions: () => [], work: async () => ({ sources: [], capture: [] }), current: () => true, teamHub: () => current, now: () => 5000, presenceView: (r) => sent.push(r) });
  return { svc, hub, calls, sent, setInspect: (v) => { inspectOut = v; }, setViewer: (v) => { viewer = v; }, swapHub: (h) => { current = h; } };
}
const rowIds = async (svc) => (await svc.passiveTeamRows(() => true)).entries.map((e) => e.rowId);

test('bind: one shared-list read, no state read, ids equal the sidebar\'s; board refs, missing rows and the viewer\'s own are refused', async () => {
  const x = rig({ entries: [entry(UUID1), entry(UUID2), entry('board-run:abc'), entry('33333333-3333-4333-8333-333333333333', { owner: { id: 'alice', name: 'Alice' } })] });
  const ids = await rowIds(x.svc);
  assert.equal(ids.length, 3, 'the sidebar lists the three teammates\' rows');
  x.calls.sharedEntries = 0;
  assert.equal(await x.svc.sharedThreadBind(ids[0]), true);
  assert.equal(await x.svc.sharedThreadBind(ids[1]), true);
  assert.equal(x.calls.sharedEntries, 2, 'one list read per bind');
  assert.deepEqual(x.calls.inspect, [], 'no state read at bind');
  assert.equal(x.calls.other, 0, 'no teams/sessions fan-out');
  assert.equal(await x.svc.sharedThreadBind(ids[2]), false, 'a board run cannot be inspected: Overview keeps it');
  assert.equal(await x.svc.sharedThreadBind('f'.repeat(64)), false);
  assert.equal(await x.svc.sharedThreadBind('nope'), false);
});
test('read: inspect only, the fixed projection, the scope refreshed on every read, nothing for Overview to see', async () => {
  const x = rig();
  const [id] = await rowIds(x.svc);
  assert.equal(await x.svc.sharedThreadBind(id), true);
  assert.equal(x.svc.threadTarget(id).kind, 'shared');
  assert.deepEqual(Object.keys(x.svc.threadTarget(id)).sort(), ['cardId', 'fake', 'kind', 'teamId', 'vm']);
  const a = await x.svc.sharedThreadRead(id);
  assert.deepEqual(Object.keys(a), [...SharedView.TOP_KEYS]);
  assert.equal(a.header.scope, 'watch');
  assert.deepEqual(x.calls.inspect, [['alice', 'team1', UUID1]]);
  x.setInspect({ ok: true, status: 'ok', state: state({ observed_at: 1 }), share: { scope: 'interact', expiresAt: null } });
  assert.equal((await x.svc.sharedThreadRead(id)).header.scope, 'interact', 'not cached from bind');
  assert.deepEqual(x.sent, [], 'a read never touches presence');
  assert.ok(!JSON.stringify(a).includes(UUID1) && !JSON.stringify(a).includes('team1'));
  const src = read('src/overview-service.js'), at = src.indexOf('async function sharedThreadRead'), body = src.slice(at, src.indexOf('\n // Message a teammate', at));
  for (const word of ['routeEpoch', 'teamRefs', 'teamView', 'controls', 'coordinator', 'presenceView', 'holder', 'directoryEpoch']) assert.ok(!body.includes(word), `${word} is not used by a shared-thread read`);
});
test('read outcomes: forbidden/stale/ended end the thread and drop the route; unavailable keeps it; a stale read returns null', async () => {
  const x = rig();
  const [id] = await rowIds(x.svc);
  await x.svc.sharedThreadBind(id);
  x.setInspect({ ok: false, status: 'unavailable', error: 'x' });
  assert.deepEqual(await x.svc.sharedThreadRead(id), { unavailable: true });
  assert.equal(x.svc.threadTarget(id).kind, 'shared', 'kept');
  assert.equal(await x.svc.sharedThreadRead(id, () => false), null, 'a read whose document moved on sends nothing');
  x.setInspect({ ok: false, status: 'forbidden', error: 'x' });
  assert.deepEqual(await x.svc.sharedThreadRead(id), { gone: true, reason: 'removed' });
  assert.equal(x.svc.threadTarget(id), null, 'unbound: no polling forever');
  assert.deepEqual(await x.svc.sharedThreadRead(id), { gone: true, reason: 'unavailable' });
  await x.svc.sharedThreadBind(id); x.setInspect({ ok: false, status: 'stale', error: 'x' });
  assert.deepEqual(await x.svc.sharedThreadRead(id), { gone: true, reason: 'removed' }, 'gone from the list or expired is not "ended"');
  await x.svc.sharedThreadBind(id); x.setInspect({ ok: true, status: 'ok', state: state({ status: 'ended' }), share: null });
  assert.deepEqual(await x.svc.sharedThreadRead(id), { gone: true, reason: 'ended' });
});
test('a different viewer, a replaced hub, a sign-out or invalidate ends access at once, even mid-read', async () => {
  for (const change of ['viewer', 'hub', 'invalidate']) {
    const x = rig();
    const [id] = await rowIds(x.svc);
    await x.svc.sharedThreadBind(id);
    let release; x.setInspect(() => new Promise((r) => { release = () => r({ ok: true, status: 'ok', state: state({ observed_at: 1 }), share: null }); }));
    const pending = x.svc.sharedThreadRead(id);
    await tick();
    if (change === 'viewer') x.setViewer({ id: 'eve', name: 'Eve' }); else if (change === 'hub') x.swapHub({ ...x.hub, origin: 'https://other.example' }); else x.svc.invalidate();
    release();
    assert.equal(await pending, null, `${change}: the in-flight read is dropped`);
    assert.equal(x.svc.threadTarget(id), null, `${change}: no target`);
  }
});

// ── thread-main ─────────────────────────────────────────────────────────
function threadRig({ target = { kind: 'shared', teamId: 'team1', cardId: 'card-1' }, sharedRead = async () => ({ header: { title: 'T' } }) } = {}) {
  let time = 100000, gen = 1, boundId = ID;
  const contents = { id: 7, isDestroyed: () => false, mainFrame: {}, send() {} };
  const win = { isDestroyed: () => false };
  const buddy = { threadContext: () => ({ window: win, contents, frame: contents.mainFrame, generation: gen, boundId, foreground: true, account: 'a', workspace: 'w' }) };
  const calls = { read: 0, copy: 0, tasks: 0, act: 0, hook: 0, team: [], terminal: 0, openInTasks: 0, presence: [] };
  const presence = { set: (tag, v) => calls.presence.push([tag, v]) };
  const handlers = {};
  const tm = createThreadMain({ buddy: () => buddy, chatPreview: true, target: () => target, tasks: () => ({ act: async () => { calls.act++; return { ok: true }; }, openTask: async () => { calls.tasks++; return { ok: false }; }, closeTask: async () => {} }),
    activity: async () => null, openInTasks: async () => { calls.openInTasks++; return true; }, goToTerminal: async () => { calls.terminal++; return { ok: true }; },
    hook: { inputs: () => { calls.hook++; return { items: [] }; }, checkMore: () => true, prepare: () => { calls.hook++; return null; } }, copy: () => { calls.copy++; },
    now: () => time, sharedRead: (id, alive) => { calls.read++; return sharedRead(id, alive); }, presence, openTeam: async (id) => { calls.team.push(id); return true; } });
  tm.register({ handle: (ch, fn) => { handlers[ch] = fn; } });
  const ev = { sender: contents, senderFrame: contents.mainFrame };
  return { tm, handlers, ev, calls, contents, tick: (ms) => { time += ms; }, bump: () => { gen++; }, setTarget: (t) => { target = t; }, call: (ch, ...a) => handlers[ch](ev, ...a) };
}

test('the new channels are registered once and refuse another sender, a subframe, a wrong id and extra args', async () => {
  const x = threadRig();
  assert.ok(CHANNELS.includes('thread:shared-state') && CHANNELS.includes('thread:open-team'));
  assert.deepEqual(Object.keys(x.handlers).sort(), [...CHANNELS].sort());
  for (const ch of ['thread:shared-state', 'thread:open-team']) {
    const none = ch === 'thread:open-team' ? false : null; // an effect answers false, a read null
    assert.equal(await x.handlers[ch]({ sender: {}, senderFrame: {} }, ID), none, ch);
    assert.equal(await x.handlers[ch]({ sender: x.contents, senderFrame: {} }, ID), none, ch);
    assert.equal(await x.call(ch, 'f'.repeat(64)), none, ch);
    assert.equal(await x.call(ch, ID, 'extra'), none, ch);
    assert.equal(await x.call(ch), none, ch);
  }
  assert.equal(x.calls.read, 0);
});
test('shared-state: the projection for a shared row only; a task or session row gets null; a 2 s floor and one read in flight', async () => {
  let release, n = 0;
  const x = threadRig({ sharedRead: () => new Promise((r) => { n++; release = () => r({ header: { title: `read ${n}` } }); }) });
  const first = x.call('thread:shared-state', ID), second = x.call('thread:shared-state', ID);
  await tick(); release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.header.title, 'read 1'); assert.equal(b.header.title, 'read 1');
  assert.equal(x.calls.read, 1, 'concurrent calls share one read');
  x.tick(1500);
  assert.equal((await x.call('thread:shared-state', ID)).header.title, 'read 1');
  assert.equal(x.calls.read, 1, 'inside 2 s: the last result');
  x.tick(600);
  const third = x.call('thread:shared-state', ID); await tick(); release();
  assert.equal((await third).header.title, 'read 2');
  // A read that outlasts the floor is still shared by a later caller.
  let slow; let k = 0;
  const y = threadRig({ sharedRead: () => new Promise((r) => { k++; slow = () => r({ header: { title: 'slow' } }); }) });
  const s1 = y.call('thread:shared-state', ID); await tick(); y.tick(3000);
  const s2 = y.call('thread:shared-state', ID); await tick(); slow();
  assert.equal(k, 1, 'one read in flight, even past the 2 s floor');
  assert.equal((await s1).header.title, 'slow'); assert.equal((await s2).header.title, 'slow');
  for (const kind of ['task', 'session']) { x.setTarget({ kind, taskId: 't', sessionId: 's', source: 'claude' }); assert.equal(await x.call('thread:shared-state', ID), null, kind); }
  x.setTarget(null);
  assert.deepEqual(await x.call('thread:shared-state', ID), { gone: true, reason: 'unavailable' });
});
test('shared-state: a document change mid-read sends nothing and is not remembered', async () => {
  let release;
  const x = threadRig({ sharedRead: () => new Promise((r) => { release = () => r({ header: {} }); }) });
  const p = x.call('thread:shared-state', ID);
  await tick(); x.bump(); release();
  assert.equal(await p, null);
});
test('every other thread channel refuses a shared row: no Tasks, terminal, hook or clipboard effect', async () => {
  const x = threadRig();
  assert.equal(await x.call('thread:copy-link', ID), false, 'its row id is per-run, not a link');
  assert.equal(await x.call('thread:open-in-tasks', ID), false);
  assert.deepEqual(await x.call('thread:go-to-terminal', ID), { ok: false });
  assert.deepEqual(await x.call('thread:inputs', ID), { gone: true });
  assert.equal((await x.call('thread:message', { id: ID, body: 'hi' })).ok, false);
  assert.equal((await x.call('thread:act', { id: ID, action: 'stop', confirmed: true })).ok, false);
  assert.equal((await x.call('thread:answer-input', { id: ID, inputId: 'i', optionId: 'o' })).ok, false);
  assert.deepEqual(await x.call('thread:state', ID), { kind: 'shared', header: null });
  assert.deepEqual([x.calls.copy, x.calls.tasks, x.calls.act, x.calls.hook, x.calls.terminal, x.calls.openInTasks], [0, 0, 0, 0, 0, 0]);
});
test('open-team: navigation only, shared rows only, foreground, rate-limited', async () => {
  const x = threadRig();
  assert.equal(await x.call('thread:open-team', ID), true);
  assert.deepEqual(x.calls.team, [ID]);
  assert.equal(await x.call('thread:open-team', ID), false, 'inside 500 ms');
  x.tick(600); x.setTarget({ kind: 'task', taskId: 't' });
  assert.equal(await x.call('thread:open-team', ID), false);
  assert.equal(x.calls.team.length, 1);
});
test('presence: set on open when the share has a card, cleared on close, retire and a share that ended; none without a card', async () => {
  const x = threadRig();
  assert.deepEqual(await x.call('thread:open', ID), { kind: 'shared', header: null });
  assert.deepEqual(x.calls.presence, [['thread', { team: 'team1', card: 'card-1' }]]);
  await x.call('thread:close', ID);
  assert.deepEqual(x.calls.presence.at(-1), ['thread', null]);
  await x.call('thread:open', ID); x.tm.retire(7);
  assert.deepEqual(x.calls.presence.slice(-2), [['thread', { team: 'team1', card: 'card-1' }], ['thread', null]]);
  const y = threadRig({ sharedRead: async () => ({ gone: true, reason: 'ended' }) });
  await y.call('thread:open', ID);
  assert.deepEqual(await y.call('thread:shared-state', ID), { gone: true, reason: 'ended' });
  assert.deepEqual(y.calls.presence.at(-1), ['thread', null]);
  const z = threadRig({ target: { kind: 'shared', teamId: 'team1', cardId: null } });
  await z.call('thread:open', ID); await z.call('thread:close', ID);
  assert.deepEqual(z.calls.presence, [], 'no card, no presence, and nothing to clear');
  const before = x.calls.presence.length; await x.call('thread:shared-state', ID); x.tm.retire(7);
  assert.equal(x.calls.presence.length, before, 'a read never touches presence');
});

// ── presence through the shared owner ───────────────────────────────────
test('the owner: Overview A -> a thread (attach clears Overview) B -> the thread closes: null -> Overview ready: A again; a thread never clears Overview\'s card', () => {
  const sent = []; const owner = createPresenceOwner({ presenceView: (r) => sent.push(r.card_id) });
  owner.set('overview', { team: 't', card: 'A' });
  owner.set('overview', null);                       // attach() leaving Overview
  owner.set('thread', { team: 't', card: 'B' });
  owner.set('thread', null);
  owner.set('overview', { team: 't', card: 'A' });   // overview:ready re-announce
  assert.deepEqual(sent, ['A', null, 'B', null, 'A']);
});
test('a hub change reaches the thread\'s slot too: clearAll sends the null on the old hub\'s open socket before it closes', async () => {
  class WS extends EventEmitter { constructor() { super(); this.sent = []; WS.all.push(this); } send(s) { this.sent.push(JSON.parse(s)); } close(code) { this.closedAfter = this.sent.length; this.closed = code; } }
  WS.all = [];
  let links = [{ route: { hub: 'https://hub.example', team_id: 'team1', board_id: 'b1' }, token: () => 'tok' }], link = null;
  const owner = createPresenceOwner({ presenceView: (r) => link.view(r) });
  link = createPresenceLink({ links: async () => links, WebSocket: WS, setTimeout: () => ({ unref() {} }), clearTimeout() {}, onRouteDropped: () => owner.clearAll() });
  await link.refresh();
  const ws = WS.all[0]; ws.emit('open'); ws.emit('message', Buffer.from(JSON.stringify({ type: 'snapshot', board_id: 'b1', board: {}, cards: [], members: [] })));
  const WIN = { isDestroyed: () => false };
  const x = threadRig({ target: { kind: 'shared', teamId: 'team1', cardId: 'card-1' } });
  const tm = createThreadMain({ buddy: () => ({ threadContext: () => ({ window: WIN, contents: x.contents, frame: x.contents.mainFrame, generation: 1, boundId: ID, foreground: true, account: 'a', workspace: 'w' }) }), chatPreview: true,
    target: () => ({ kind: 'shared', teamId: 'team1', cardId: 'card-1' }), tasks: () => null, activity: async () => null, openInTasks: async () => false, goToTerminal: async () => null, presence: owner });
  const h = {}; tm.register({ handle: (ch, fn) => { h[ch] = fn; } });
  await h['thread:open'](x.ev, ID);
  assert.deepEqual(ws.sent.filter((f) => f.type === 'presence.view').map((f) => f.card_id), ['card-1']);
  links = [];
  await link.refresh();
  assert.deepEqual(ws.sent.filter((f) => f.type === 'presence.view').map((f) => f.card_id), ['card-1', null]);
  assert.equal(ws.closedAfter, ws.sent.length, 'nothing was sent after the close');
  assert.equal(ws.closed, 1000);
});

// ── wiring ──────────────────────────────────────────────────────────────
test('wiring: no new authority; main passes the presence owner and the bind; the window opens a thread first and falls back to Overview', () => {
  const main = read('main.js'), win = read('buddy-window/index.js'), tm = read('src/thread-main.js');
  assert.match(main, /sharedRead: \(id, alive\) => OverviewMain\.sharedThreadRead\(id, alive\),\n    openTeam: \(id\) => buddyWin\?\.openTeamRow\?\.\(id\) \?\? false,\n    presence: PresenceOwner,/);
  assert.match(main, /threadBindShared: \(id, alive\) => OverviewMain\.sharedThreadBind\(id, alive\),/);
  assert.match(win, /openTeamRow\(id\) \{ if \(typeof id !== 'string' \|\| !ROW_ID\.test\(id\)\) return false;/);
  const body = tm.slice(tm.indexOf('async function sharedState'), tm.indexOf('// "Team overview"'));
  for (const word of ['controls', 'selection', 'token', 'presenceView', 'presence.', 'setPresence', 'clearPresence']) assert.ok(!body.includes(word) || word === 'clearPresence', `${word} is not part of the read channel`);
  assert.ok(!/setPresence/.test(body), 'a read never sets presence');
});

// ── the renderer ────────────────────────────────────────────────────────
const html = read('thread.html').replace(/<script[^]*?<\/script>/g, '');
const opened = [];
test.afterEach(() => { while (opened.length) opened.pop().close(); });
function page(first, later = first) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; opened.push(w);
  const calls = []; let ready = null, reads = 0;
  w.threadApi = { open: async (id) => { calls.push(['open', id]); return { kind: 'shared', header: null }; }, state: async () => { calls.push(['state']); return { kind: 'shared', header: null }; }, close: async () => true,
    sharedState: async (id) => { calls.push(['shared', id]); return reads++ === 0 ? first : later; }, openTeam: async (id) => { calls.push(['team', id]); return true; },
    openInTasks: async () => { calls.push(['tasks']); return true; }, goToTerminal: async () => ({ ok: true }), copyLink: async () => { calls.push(['copy']); return true; }, message: async () => ({ ok: true }), act: async () => ({ ok: true }),
    board: () => calls.push(['board']), onReady: (cb) => { ready = cb; }, onEvent() {} };
  for (const f of ['brand.js', 'src/tasks-view.js', 'src/transcript-md.js', 'src/transcript-dom.js', 'thread-shared.js', 'thread.js']) w.eval(read(f));
  return { w, calls, $: (id) => w.document.getElementById(id), ready: () => ready(ID) };
}
const view = (over = {}) => SharedView.project({ state: state(), share: { scope: 'watch', expiresAt: null }, route, now: 2000, ...over });

test('renderer: a watch share shows the header line, the banner first, the activity, the messages and a watch-only footer; no prompt box', async () => {
  const p = page(view({ state: state({ deliveries: [
    { id: 'a', text: 'Please <img src=x onerror="globalThis.pwned=1"> fix', by: 'Alice', state: 'replied', response: 'Done <b>x</b>', sentAt: 1 },
    { id: 'b', text: 'second', by: null, state: 'bogus', response: '', sentAt: 2 }] }) }));
  p.ready(); await tick(); await tick();
  assert.deepEqual(p.calls[0], ['open', ID]); assert.deepEqual(p.calls[1], ['shared', ID]);
  assert.equal(p.$('th-title').textContent, 'Fix login');
  assert.equal(p.$('th-meta').textContent, "Bob's Claude Code session · Shared with you to watch");
  assert.equal(p.$('th-banner').textContent, 'You see messages sent since it was shared, and its current activity. Earlier history stays private.');
  assert.equal(p.$('th-banner').hidden, false);
  const root = p.$('th-shared');
  assert.match(root.querySelector('.th-activity').textContent, /^Now: Editing files · /);
  const msgs = [...root.querySelectorAll('.th-msg')];
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].textContent, /Sent by AlicePlease/);
  assert.match(msgs[0].textContent, /Please <img src=x onerror=/, 'markup is text');
  assert.equal(p.w.document.querySelector('img'), null); assert.equal(p.w.pwned, undefined);
  assert.equal(msgs[0].querySelector('.th-chip').textContent, 'Done');
  assert.match(msgs[1].textContent, /Sent through this share/);
  assert.equal(msgs[1].querySelector('.th-chip').textContent, 'Unconfirmed');
  assert.match(msgs[1].textContent, /Receipt unconfirmed\. The agent may still act; do not resend automatically\./);
  assert.equal(root.querySelector('.th-shared-foot').textContent, 'Shared with you to watch only. Ask Bob to allow sending.');
  for (const id of ['th-reply', 'th-stop', 'th-tx', 'th-waiting', 'th-cards', 'th-hooks', 'th-primary']) assert.equal(p.$(id).hidden, true, id);
  assert.equal(p.$('th-copy').hidden, true, 'no Copy link in T2');
  assert.equal(p.$('th-team').hidden, false);
  p.$('th-team').click(); await tick();
  assert.deepEqual(p.calls.at(-1), ['team', ID]);
});
test('renderer: an interact share still has no prompt box; the footer points to Team sessions and the expiry shows', async () => {
  const iso = '2030-06-01T18:00:00.000Z';
  const p = page(view({ share: { scope: 'interact', expiresAt: iso } }));
  p.ready(); await tick(); await tick();
  assert.match(p.$('th-meta').textContent, /^Bob's Claude Code session · Watch and send · until \d\d:\d\d( [AP]M)?$/);
  assert.equal(p.$('th-reply').hidden, true);
  const foot = p.$('th-shared').querySelector('.th-shared-foot');
  assert.match(foot.textContent, /^To send, steer or interrupt, use Team sessions\.Open in Team sessions$/);
  foot.querySelector('button').click(); await tick();
  assert.deepEqual(p.calls.at(-1), ['team', ID]);
});
test('renderer: no messages yet says so; a tombstone drops the body, stops reading and offers the way back', async () => {
  const p = page(view({ state: state({ deliveries: [] }) }));
  p.ready(); await tick(); await tick();
  assert.equal(p.$('th-shared').querySelector('.th-shared-empty').textContent, 'No messages have been sent through this share yet.');
  const g = page({ gone: true, reason: 'removed' });
  g.ready(); await tick(); await tick();
  assert.equal(g.$('th-title').textContent, 'This session is no longer shared with you.');
  assert.equal(g.$('th-banner').hidden, true);
  assert.equal(g.$('th-shared').querySelectorAll('.th-msg').length, 0);
  assert.equal(g.$('th-board').hidden, false);
  const e = page({ gone: true, reason: 'ended' });
  e.ready(); await tick(); await tick();
  assert.equal(e.$('th-title').textContent, 'This session has ended.');
});
test('renderer: an unavailable read keeps the last view and says so; thread.js stops its own reads for a shared row', async () => {
  const p = page(view(), { unavailable: true });
  p.ready(); await tick(); await tick();
  p.w.document.dispatchEvent(new p.w.Event('visibilitychange')); await tick(); await tick();
  assert.equal(p.$('th-shared').querySelector('.th-activity').textContent, 'Showing the last known state.');
  assert.equal(p.$('th-shared').querySelectorAll('.th-msg').length, 1, 'the last view is kept');
  assert.deepEqual(p.calls.filter(([k]) => k === 'state'), [], 'thread.js does not run its own refresh for a shared row');
  const src = read('thread-shared.js');
  assert.ok(!/api\.(message|act|answerInput|copyLink|openInTasks|goToTerminal)/.test(src), 'no write path');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), 'text only');
  assert.match(read('thread.js'), /kind === 'shared'/);
});
test('copy: the shared view\'s words come from the glossary and avoid platform words', () => {
  const src = read('thread-shared.js');
  assert.doesNotMatch(src, /\bMac\b|\bmacOS\b|\bWindows\b/);
  assert.match(read('package.json'), /"thread-shared\.js"/);
  assert.match(read('thread.html'), /<script src="thread-shared\.js"><\/script>\n  <script src="thread\.js">/);
});

// ── the real hub client ─────────────────────────────────────────────────
test('hub client: sharedEntries is one list read (no state, account or board read); inspect returns the share\'s current terms', async () => {
  const { createTeamHubClient } = require('../src/team-hub-client');
  const calls = []; let scope = 'watch';
  const json = (status, body) => ({ status, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
  const NOW = 1_800_000_000_000, SESS = '33333333-3333-4333-8333-333333333333';
  const fetch = async (url, init = {}) => {
    calls.push(url.replace('https://hub.test', ''));
    if (url.endsWith('/shared')) return json(200, { shared: [{ id: UUID1, session: SESS, scope, team: { id: 'team-1', name: 'One' }, owner: { id: 'u-bob', name: 'Bob' }, online: true, expires_at: '2030-01-01T00:00:00.000Z' }] });
    if (url.includes('/call')) { const body = JSON.parse(init.body); return json(200, { result: { ok: true, state: { session: body.args.session, status: 'working', generation: 1, activeTurn: null, observed_at: NOW - 10, provider: { id: 'claude', label: 'Claude Code' }, capabilities: {}, deliveries: [] } } }); }
    return json(404, {});
  };
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', viewerId: 'u-ana', token: () => 'tok', fetch }, { now: () => NOW, pollMs: 100000, timeoutMs: 500, deadlineMs: 1000 });
  const got = await hub.sharedEntries(hub.viewer());
  assert.deepEqual(calls, ['/api/interaction/v1/shared'], 'one relay list call');
  assert.deepEqual(got.teams.map((t) => [t.id, t.name, t.entries.length]), [['team-1', 'One', 1]]);
  assert.equal(got.teams[0].entries[0].ref, UUID1);
  assert.deepEqual(await hub.sharedEntries({ id: 'someone-else' }), { teams: [] }, 'another viewer gets nothing');
  const out = await hub.inspect(hub.viewer(), 'team-1', UUID1);
  assert.equal(out.ok, true);
  assert.deepEqual(out.share, { scope: 'watch', expiresAt: '2030-01-01T00:00:00.000Z' });
  scope = 'interact';
  assert.equal((await hub.inspect(hub.viewer(), 'team-1', UUID1)).share.scope, 'interact', 'each read carries the current scope');
  assert.equal((await hub.inspect(hub.viewer(), 'team-9', UUID1)).ok, false);
  assert.equal((await hub.inspect(hub.viewer(), 'team-9', UUID1)).share, undefined);
});

test('bind: a share in any listed team binds, not only the first 4 by list order (the sidebar picks teams in its own order)', async () => {
  const teams = Array.from({ length: 6 }, (_, i) => ({ id: `team${i}`, name: `T${i}`, entries: [entry(`${i + 1}`.repeat(8) + '-1111-4111-8111-111111111111', { team: { id: `team${i}`, name: `T${i}` } })] }));
  const hub = { origin: 'https://hub.example', viewer: () => ({ id: 'alice', name: 'Alice' }), inspect: async () => null,
    sharedEntries: async () => ({ teams }), // listed order: team0..team5
    passiveSessions: async () => ({ teamsTotal: 6, teams: [teams[5], ...teams.slice(0, 5)], partial: false }) }; // the sidebar's order differs
  const svc = createOverviewService({ sessions: () => [], work: async () => ({ sources: [], capture: [] }), current: () => true, teamHub: () => hub, now: () => 5000 });
  // the real client lists every team's rows too
  const { createTeamHubClient } = require('../src/team-hub-client');
  const shared = teams.map((t, i) => ({ id: t.entries[0].ref, session: `${i + 1}`.repeat(8) + '-2222-4222-8222-222222222222', scope: 'watch', team: { id: t.id, name: t.name }, owner: { id: 'u-bob', name: 'Bob' }, online: true, expires_at: null }));
  const real = createTeamHubClient({ baseUrl: 'https://hub.test', viewerId: 'u-ana', token: () => 'tok', fetch: async () => ({ status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify({ shared }) }) }, { now: () => 1, pollMs: 100000, timeoutMs: 500, deadlineMs: 1000 });
  assert.equal((await real.sharedEntries(real.viewer())).teams.length, 6, 'no 4-team cap');
  const rows = (await svc.passiveTeamRows(() => true)).entries;
  const sixth = rows.find((r) => r.teamId === 'team5');
  assert.ok(sixth, 'the sidebar shows team5 first');
  assert.equal(await svc.sharedThreadBind(sixth.rowId), true, 'team5 is 6th in the shared list but still binds');
});

test('a click that binds late opens nothing: a second click, a navigation or a hidden window drops it, and arms no hint', async () => {
  const vm = require('node:vm');
  const src = read('buddy-window/index.js');
  const from = src.indexOf('  let teamClick = 0;'), to = src.indexOf("  if (chatFirst === true) ipcMain.on('buddy:open-team-row'");
  assert.ok(from > 0 && to > from);
  const ID1 = 'a'.repeat(64), ID2 = 'b'.repeat(64);
  const build = () => {
    const log = []; const holds = [];
    const ctx = { log, holds, homeGeneration: 0, win: { isDestroyed: () => false, isVisible: () => ctx.visible, isMinimized: () => false }, visible: true,
      ROW_ID: /^[0-9a-f]{64}$/, fromSidebar: () => true, sidebar: { webContents: { mainFrame: 'F' } },
      threadBindShared: (id, alive) => new Promise((r) => holds.push(() => r(true))).then((v) => { log.push(['bound', id]); return v; }),
      openThread: (id) => { log.push(['thread', id]); return true; }, openTeamRow: (id) => { log.push(['hint', id]); return true; }, select: (id) => log.push(['select', id]) };
    vm.createContext(ctx); vm.runInContext(src.slice(from, to) + '\nthis.click = openTeamRowFromSidebar;', ctx);
    return ctx;
  };
  const e = { senderFrame: 'F' };
  const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
  // one click, nothing moves: the thread opens
  let c = build(); c.click(e, ID1); c.holds[0](); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(c.log)), [['bound', ID1], ['thread', ID1]]);
  // a second click: only the latest opens
  c = build(); c.click(e, ID1); c.click(e, ID2); c.holds[0](); c.holds[1](); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(c.log.filter(([k]) => k !== 'bound'))), [['thread', ID2]]);
  // a navigation (select / openThread bump homeGeneration) during the bind
  c = build(); c.click(e, ID1); c.homeGeneration++; c.holds[0](); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(c.log.filter(([k]) => k !== 'bound'))), [], 'no thread, no hint, no select');
  // a hidden window
  c = build(); c.click(e, ID1); c.visible = false; c.holds[0](); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(c.log.filter(([k]) => k !== 'bound'))), []);
  const body = src.slice(from, to);
  assert.match(body, /threadBindShared\(id, current\)/);
});
