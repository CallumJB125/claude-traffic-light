'use strict';
// T3 (plan-t3): send, steer, stop and propose inside a teammate's shared thread. Real interaction hub, real
// team-hub client, real Overview service (its own controls and a thread's), real thread-main; the network and
// the provider are deterministic substitutes, as in overview-team-controls.test.js.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { createInteractionHub } = require('../src/session-interaction');
const { createTeamHubClient } = require('../src/team-hub-client');
const { createOverviewService } = require('../src/overview-service');
const { createThreadMain, CHANNELS } = require('../src/thread-main');
const SharedMain = require('../src/thread-shared-main');
const SharedView = require('../src/shared-thread-view');
const { withTargetLock } = require('../src/team-session-controls');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
const WATCH = 'Shared with you to watch only. The owner can choose Allow sending.';

async function rig({ accountName = null, adapterCaps = {} } = {}) {
  const ee = new EventEmitter(), calls = [], actor = 'owner-document', share = crypto.randomUUID();
  const adapter = { label: 'Codex', capabilities: { newTurn: true, steer: true, interrupt: true, ack: true, echo: true, stream: true, ...adapterCaps },
    open: async () => ({ target: 'private-native-thread' }), alive: () => true, on: (fn) => { ee.on('event', fn); return () => ee.off('event', fn); },
    send: async (req) => { calls.push(req); return { turnId: req.expectedTurnId ?? `private-native-turn-${calls.length}`, mode: req.expectedTurnId ? 'steer' : 'new-turn' }; },
    interrupt: async (req) => { calls.push({ interrupt: req }); return true; },
  };
  const hub = createInteractionHub({ adapters: { codex: adapter }, boardCurrent: () => true });
  const launched = await hub.launch({ provider: 'codex', board: 'private-board' }, actor), session = launched.state.session;
  let shared = true, scope = 'interact', hold = null, failSend = false, offline = false, expired = false;
  const proposals = [], net = [];
  const json = (body, status = 200) => ({ status, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
  const client = createTeamHubClient({ baseUrl: 'https://synthetic.invalid', token: () => 'test-only-token', viewer: { id: 'viewer', name: 'You' }, fetch: async (url, init) => {
    const u = new URL(url), method = init?.method ?? 'GET';
    net.push([method, u.pathname]);
    if (u.pathname.endsWith('/shared')) return json({ shared: shared ? [{ id: share, session, scope, team: { id: 'team', name: 'Team' }, owner: { id: 'owner', name: 'Bob' }, online: !offline, expires_at: null }] : [] });
    if (!shared) return json({}, 404);
    if (expired) return json({}, 401);
    if (offline) return json({}, 404); // the hub answers 404 for a listed share whose owner's computer is offline
    const m = u.pathname.match(/\/proposals(?:\/([^/]+))?(\/send)?$/);
    if (m) {
      if (!m[1] && method === 'GET') return json({ ok: true, proposals: proposals.map((p) => ({ ...p })) });
      if (!m[1] && method === 'POST') {
        const b = JSON.parse(init.body);
        const p = { id: b.id, share, requester: { id: 'viewer', name: 'Viewer' }, decision: b.decision, version: b.version, generation: b.generation, digest: 'a'.repeat(64), title: b.title, text: b.text, status: 'pending', action: 'send', budget: 1, expiresAt: null, receipt: null };
        proposals.push(p);
        return json({ ok: true, proposal: { ...p } });
      }
      const p = proposals.find((x) => x.id === m[1]);
      if (!p) return json({}, 404);
      if (method === 'DELETE') { if (p.status !== 'pending' && p.status !== 'approved') return json({}, 409); p.status = 'revoked'; return json({ ok: true, proposal: { ...p } }); }
      if (m[2]) {
        if (hold) await hold({ op: 'proposal-send' });
        if (p.status !== 'approved') return json({}, 409);
        const r = await hub.send({ session, generation: p.generation, text: p.text, board: 'private-board' }, actor, { by: 'Viewer' });
        p.status = 'sent'; p.receipt = { id: r?.delivery?.id ?? 'r', state: r?.delivery?.state ?? 'acknowledged' };
        return json({ ok: true, proposal: { ...p } });
      }
      return json({}, 404);
    }
    const req = JSON.parse(init.body);
    if (hold) await hold(req);
    if (req.op === 'send' && failSend) throw new Error('reply lost');
    let result;
    if (req.op === 'state') result = { ok: true, state: { ...hub.state({ session }, actor), observed_at: Date.now() } };
    else if (req.op === 'send') result = await hub.send({ ...req.args, board: 'private-board' }, actor, { by: 'Viewer' });
    else if (req.op === 'interrupt') result = await hub.interrupt(req.args, actor);
    return json({ result });
  } });
  let overviewFocus = true;
  const svc = createOverviewService({ sessions: () => [], work: async () => ({ sources: [], capture: [] }), teamHub: () => client, current: () => true, actionCurrent: () => overviewFocus, accountName: () => accountName });
  // The thread document.
  let clock = 1_000_000, generation = 1, foreground = true;
  const win = { isDestroyed: () => false }, frame = {}, wc = { id: 7, mainFrame: frame, isDestroyed: () => false };
  let boundId = null;
  const buddy = { threadContext: () => (boundId ? { window: win, contents: wc, frame, generation, boundId, foreground, account: 'a', workspace: 'w' } : null) };
  const tm = createThreadMain({ buddy: () => buddy, chatPreview: true, target: (id) => svc.threadTarget(id), tasks: () => null, now: () => clock,
    sharedRead: (id, alive) => svc.sharedThreadRead(id, alive), sharedAuthority: (id, live) => svc.sharedThreadAuthority(id, { read: () => live.read() === true, effect: () => live.effect() === true }) });
  const handlers = new Map(); tm.register({ handle: (n, f) => handlers.set(n, f) });
  const ev = { sender: wc, senderFrame: frame };
  const rows = await svc.passiveTeamRows(() => true);
  boundId = rows.entries[0].rowId;
  assert.equal(await svc.sharedThreadBind(boundId), true);
  const x = {
    hub, svc, tm, client, calls, proposals, net, session, actor, share, handlers, ev,
    get id() { return boundId; },
    // A review mints a token, so it has the per-document 500 ms floor: each one here starts past it.
    review: (op, text, e = ev, id = boundId) => { clock += 501; return handlers.get('thread:shared-review')(e, id, { op, text }); },
    confirm: (selection, text, e = ev, id = boundId) => handlers.get('thread:shared-confirm')(e, id, { selection, text }),
    list: (e = ev, id = boundId) => handlers.get('thread:shared-proposals')(e, id),
    state: () => handlers.get('thread:shared-state')(ev, boundId),
    later: (ms = 700) => { clock += ms; },
    // Review, wait out the arm, confirm.
    async send(op, text) { const r = await x.review(op, text); assert.equal(r?.ok, true, JSON.stringify(r)); x.later(); return x.confirm(r.selection, op === 'stop' ? '' : text); },
    emit: (event) => ee.emit('event', { target: 'private-native-thread', ...event }),
    watch: () => { scope = 'watch'; }, interact: () => { scope = 'interact'; }, revoke: () => { shared = false; }, setOffline: (v = true) => { offline = v; }, setExpired: (v = true) => { expired = v; },
    blur: () => { foreground = false; }, focus: () => { foreground = true; }, overviewBlur: () => { overviewFocus = false; },
    reopen: () => { generation++; tm.retire(wc.id); },
    hold: (fn) => { hold = fn; }, failSend: (v = true) => { failSend = v; },
    approve: (i = 0) => { proposals[i].status = 'approved'; proposals[i].expiresAt = new Date(Date.now() + 600_000).toISOString(); },
    async overviewInspect() { const d = await svc.directory({ view: 'team', team: null }); return svc.teamInspect({ id: d.entries[0].id }); },
    close: () => { tm.stop(); hub.stopAll(); },
  };
  return x;
}
// An expected refusal answers at once; a missing lock would wait on the held dispatch instead.
const within = (p, ms = 1500) => Promise.race([p, new Promise((r) => setTimeout(() => r({ status: 'no answer: dispatched past the lock' }), ms))]);
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { wait: p, release }; };

test('channels: the three T3 channels exist and nothing else was added', () => {
  for (const c of ['thread:shared-review', 'thread:shared-confirm', 'thread:shared-proposals']) assert.ok(CHANNELS.includes(c), c);
  assert.equal(CHANNELS.length, 15);
});

test('Guard T: wrong sender or frame, args, an unbound id, a watch scope, a task row', async () => {
  const x = await rig();
  try {
    assert.equal(await x.review('send', 'hi', { sender: {}, senderFrame: x.ev.senderFrame }), null);
    assert.equal(await x.review('send', 'hi', { sender: x.ev.sender, senderFrame: {} }), null);
    assert.equal(await x.review('send', 'hi', x.ev, 'f'.repeat(64)), null, 'another row id');
    assert.equal(await x.handlers.get('thread:shared-review')(x.ev, x.id), null, 'no request');
    x.later(501);
    assert.equal((await x.handlers.get('thread:shared-review')(x.ev, x.id, { op: 'send', text: 'a' })).ok, true);
    assert.equal((await x.handlers.get('thread:shared-review')(x.ev, x.id, { op: 'send', text: 'a' })).status, 'busy', 'a 500 ms floor per document');
    assert.equal(await x.handlers.get('thread:shared-review')(x.ev, x.id, { op: 'send', text: 'a' }, 'extra'), null, 'extra args');
    assert.equal(await x.handlers.get('thread:shared-proposals')(x.ev, x.id, 'extra'), null);
    assert.equal((await x.review('queue', 'hi')).status, 'invalid', 'no Queue in T3');
    assert.equal((await x.review('send', 'a\0b')).status, 'invalid');
    assert.equal((await x.review('send', 'x'.repeat(4001))).status, 'invalid');
    assert.equal((await x.review('stop', 'text')).status, 'invalid', 'stop never carries text');
    x.watch();
    const w = await x.review('send', 'hi');
    assert.deepEqual([w.status, w.error], ['forbidden', WATCH]);
    assert.equal((await x.list()).status, 'forbidden');
    assert.equal(x.calls.length, 0);
  } finally { x.close(); }
  // A row that isn't a teammate's share gets nothing.
  const contents = { id: 1, mainFrame: 1 };
  let asked = 0;
  const tm = createThreadMain({ buddy: () => ({ threadContext: () => ({ window: {}, contents, frame: 1, generation: 1, boundId: 'a'.repeat(64), foreground: true }) }), chatPreview: true,
    target: () => ({ kind: 'task', taskId: 't' }), tasks: () => null, sharedAuthority: () => { asked++; return null; } });
  const h = new Map(); tm.register({ handle: (n, f) => h.set(n, f) });
  const e = { sender: contents, senderFrame: 1 };
  assert.equal(await h.get('thread:shared-review')(e, 'a'.repeat(64), { op: 'send', text: 'x' }), null, 'a task row');
  assert.equal(await h.get('thread:shared-confirm')(e, 'a'.repeat(64), { selection: crypto.randomUUID(), text: 'x' }), null);
  assert.equal(await h.get('thread:shared-proposals')(e, 'a'.repeat(64)), null);
  assert.equal(asked, 0, 'no authority is asked for a row that isn\'t a teammate\'s share');
});

test('send: review card from main, 600 ms arm, exact text, one use, receipt; effects need the focused window', async () => {
  const x = await rig();
  try {
    const r = await x.review('send', 'Reply with the task status');
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r).sort(), ['card', 'ok', 'selection', 'status']);
    assert.deepEqual(r.card, { op: 'send', title: "Send to Bob's session", text: 'Reply with the task status', target: "Bob's Codex session", notes: [], confirm: 'Send', armMs: 600 });
    assert.ok(!JSON.stringify(r).includes(x.share) && !JSON.stringify(r).includes(x.session), 'no ref or session id');
    assert.equal((await x.confirm(r.selection, 'Reply with the task status')).status, 'not-ready', 'main arms 600 ms from delivery');
    x.later(599);
    assert.equal((await x.confirm(r.selection, 'Reply with the task status')).status, 'not-ready');
    x.later(1);
    assert.equal((await x.confirm(r.selection, 'Reply with something else')).status, 'invalid', 'the exact reviewed text');
    x.blur();
    assert.equal(await x.confirm(r.selection, 'Reply with the task status'), null, 'confirm is an effect: focused window only');
    x.focus();
    assert.equal(x.calls.length, 0, 'nothing consumed or dispatched yet');
    const done = await x.confirm(r.selection, 'Reply with the task status');
    assert.equal(done.ok, true); assert.equal(done.status, 'sent'); assert.equal(typeof done.receipt.id, 'string');
    assert.equal(x.calls.length, 1); assert.equal(x.calls[0].text, 'Reply with the task status');
    assert.equal((await x.confirm(r.selection, 'Reply with the task status')).status, 'stale', 'one use');
    assert.equal(x.calls.length, 1);
    assert.equal((await x.handlers.get('thread:shared-confirm')(x.ev, x.id, { selection: r.selection, text: 'x', op: 'send' })).status, 'invalid', 'confirm takes no op');
  } finally { x.close(); }
});

test('a double click dispatches once', async () => {
  const x = await rig();
  try {
    const r = await x.review('send', 'Once'); x.later();
    const [a, b] = await Promise.all([x.confirm(r.selection, 'Once'), x.confirm(r.selection, 'Once')]);
    assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
    assert.equal(x.calls.length, 1);
  } finally { x.close(); }
});

test('steer and stop: bound to the reviewed turn; a steer selection can never confirm as send', async () => {
  const x = await rig();
  try {
    assert.equal((await x.send('send', 'Start this task')).ok, true);
    await x.state(); x.later(2100);
    const s = await x.review('steer', 'Check the new decision first');
    assert.equal(s.card.title, "Steer Bob's current turn");
    assert.equal(s.card.target, "Bob's Codex session · this current turn only");
    assert.deepEqual(s.card.notes, ['This does not confirm the requested change was applied.']);
    x.later();
    const out = await x.confirm(s.selection, 'Check the new decision first');
    assert.equal(out.ok, true); assert.equal(x.calls[1].expectedTurnId, 'private-native-turn-1');
    const p = await x.review('propose', 'Later');
    assert.equal(p.ok, false); assert.equal(p.status, 'unavailable', 'propose is idle-only (M2)');
    const stop = await x.review('stop', '');
    assert.equal(stop.card.title, "Stop Bob's current turn"); assert.equal(stop.card.text, '');
    assert.deepEqual(stop.card.notes, ['Asks the provider to stop the current turn. Work already done stays.']);
    x.later();
    assert.equal((await x.confirm(stop.selection, '')).ok, true);
    assert.deepEqual(x.calls[2], { interrupt: x.calls[2].interrupt });
    assert.equal(x.calls.length, 3, 'a stop never sends text afterwards');
  } finally { x.close(); }
});

test('a turn change between review and confirm is stale: no dispatch, and the draft is the page\'s', async () => {
  const x = await rig();
  try {
    const r = await x.review('send', 'Thread message');
    // Overview starts a turn on the same session meanwhile.
    const o = await x.overviewInspect();
    assert.equal((await x.svc.teamAction({ selection: o.selection, operation: 'send', text: 'Overview message' })).ok, true);
    x.later();
    const out = await x.confirm(r.selection, 'Thread message');
    assert.equal(out.status, 'stale'); assert.equal(out.error, SharedMain.TEXT.MOVED);
    assert.deepEqual(x.calls.map((c) => c.text), ['Overview message']);
  } finally { x.close(); }
});

test('a scope downgraded to watch between review and confirm refuses before any dispatch', async () => {
  const x = await rig();
  try {
    const r = await x.review('send', 'Hello'); x.later();
    x.watch();
    const out = await x.confirm(r.selection, 'Hello');
    assert.deepEqual([out.status, out.error], ['forbidden', WATCH]);
    assert.equal(x.calls.length, 0);
    // Propose too (M3): refused with the watch reason, never Awaiting.
    x.interact();
    const p = await x.review('propose', 'Proposal'); assert.equal(p.ok, true, JSON.stringify(p));
    x.later(); x.watch();
    const q = await x.confirm(p.selection, 'Proposal');
    assert.equal(q.ok, false); assert.equal(q.error, WATCH);
    assert.equal(x.proposals.length, 0);
  } finally { x.close(); }
});

test('M3: requestOwner\'s result is mapped from the assignment, not from ok', async () => {
  const fake = (assignment) => ({ live: () => true, owner: 'Bob', seen: () => null, invalidate() {},
    resolve: async () => ({ hub: {}, scope: 'interact' }),
    propose: async () => ({ ok: true, proposal: crypto.randomUUID(), expiresAt: Date.now() + 30_000, assignments: [{ status: 'review', target: { provider: 'Codex' }, text: 'x' }] }),
    requestOwner: async () => ({ ok: true, assignments: [assignment] }) });
  for (const [a, want] of [[{ status: 'refused', reason: WATCH }, ['refused', WATCH]], [{ status: 'unconfirmed', reason: 'Request outcome is unknown.' }, ['unconfirmed', 'Request outcome is unknown.']], [{ status: 'awaiting-owner' }, ['awaiting', undefined]]]) {
    let t = 0; const actions = SharedMain.createSharedThreadActions({ authority: () => fake(a), now: () => t });
    const c = { contents: { id: 1 }, generation: 1, boundId: 'b'.repeat(64) }, still = () => true;
    const r = await actions.review(c, { op: 'propose', text: 'x' }, still); t += 700;
    const out = await actions.confirm(c, { selection: r.selection, text: 'x' }, still);
    assert.deepEqual([out.status, out.error], want);
  }
});

test('shared lock (S1, S3): Overview and the thread serialise on one session, across close and reopen, and a remote send holds it too', async () => {
  const x = await rig();
  try {
    // Overview's send awaits a receipt → the thread is busy.
    const g = gate();
    const o = await x.overviewInspect();
    const r = await x.review('send', 'Thread'); x.later();
    x.hold(async (req) => { if (req.op === 'send') await g.wait; });
    const pending = x.svc.teamAction({ selection: o.selection, operation: 'send', text: 'Overview' });
    await tick(); await tick(); await tick();
    const busy = await within(x.confirm(r.selection, 'Thread'));
    assert.equal(busy.status, 'busy'); assert.equal(busy.error, SharedMain.TEXT.BUSY);
    g.release(); assert.equal((await pending).ok, true);
    x.hold(null);
    x.emit({ kind: 'turn-completed', turnId: 'private-native-turn-1', status: 'completed' }); await tick();
    // The reverse, held across the thread's close and reopen.
    const g2 = gate();
    const r2 = await x.review('send', 'Thread two'); x.later();
    x.hold(async (req) => { if (req.op === 'send') await g2.wait; });
    const held = x.confirm(r2.selection, 'Thread two');
    await tick(); await tick(); await tick(); await tick();
    x.hold(null);
    const o2 = await x.overviewInspect();
    assert.equal((await within(x.svc.teamAction({ selection: o2.selection, operation: 'send', text: 'Overview two' }))).status, 'busy');
    x.reopen();
    const r3 = await x.review('send', 'After reopen'); x.later();
    assert.equal((await within(x.confirm(r3.selection, 'After reopen'))).status, 'busy', 'still serialised after close and reopen');
    g2.release(); await held;
    x.emit({ kind: 'turn-completed', turnId: 'private-native-turn-2', status: 'completed' }); await tick();
    assert.equal((await x.send('send', 'Now it goes')).ok, true, 'released in finally');
  } finally { x.close(); }
  // withTargetLock: the same key as action(), and scope isn't part of it.
  const hub = {}, t = { hub, viewer: { id: 'v' }, team: 't', ref: 'r', scope: 'interact' };
  const g = gate(); const first = withTargetLock(t, () => g.wait);
  assert.equal((await withTargetLock({ ...t, scope: 'watch' }, async () => 'x')).status, 'busy');
  g.release(); await first;
  assert.equal(await withTargetLock(t, async () => 'free'), 'free');
  assert.match(read('src/team-coordinator.js'), /operation==='send'\?await withTargetLock\(t,call\)/, 'the approved send takes the lock inside remoteAction');
});

test('selections per authority: an Overview selection is refused on the thread, and the reverse', async () => {
  const x = await rig();
  try {
    const o = await x.overviewInspect(); x.later();
    assert.equal((await x.confirm(o.selection, 'x')).status, 'stale');
    const r = await x.review('send', 'Thread'); x.later();
    assert.equal((await x.svc.teamAction({ selection: r.selection, operation: 'send', text: 'Thread' })).status, 'stale');
    assert.equal(x.calls.length, 0);
  } finally { x.close(); }
});

test('M1 and no Overview side effects: the real coordinator gives a review on one entry; Overview\'s selection still works after', async () => {
  const x = await rig({ accountName: { userId: 'viewer', name: 'Callum' } });
  try {
    const o2 = await x.overviewInspect();
    const p = await x.review('propose', 'Please run the tests');
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(p.card.title, 'Propose to Bob');
    assert.deepEqual(p.card.notes, ['Nothing runs until Bob approves it. Approval allows one send.']);
    x.later();
    assert.equal((await x.confirm(p.selection, 'Please run the tests')).status, 'awaiting');
    assert.equal(x.proposals.length, 1);
    assert.equal(x.proposals[0].title, 'From Callum');
    assert.equal(x.proposals[0].text, 'Please run the tests');
    assert.ok(Number.isSafeInteger(x.proposals[0].generation));
    assert.equal(x.calls.length, 0, 'a proposal is not a dispatch');
    assert.equal((await x.svc.teamAction({ selection: o2.selection, operation: 'send', text: 'Overview still works' })).ok, true, 'an Overview selection minted before a thread propose dispatches after it');
    // The thread's authority never reads Overview's directory or moves its route, view or refs.
    const src = read('src/overview-service.js'), body = src.slice(src.indexOf('function sharedThreadAuthority'), src.indexOf('\n // Message a teammate'));
    for (const w of ['directory(', 'routeEpoch', 'directoryEpoch', 'teamView', 'teamRefs', 'resolveTeam(', 'handles.']) assert.ok(!body.includes(w), w);
    assert.match(body, /const controls=createTeamSessionControls\(\{resolve:threadResolve,/);
    assert.match(body, /const coordinator=createTeamCoordinator\(\{inventory:oneEntry,/);
  } finally { x.close(); }
});

test('S2: the thread target always has isCurrent, the read fence', async () => {
  const x = await rig();
  try {
    let alive = true;
    const auth = x.svc.sharedThreadAuthority(x.id, { read: () => alive, effect: () => alive });
    const t = await auth.resolve();
    assert.equal(typeof t.isCurrent, 'function'); assert.equal(t.isCurrent(), true);
    assert.equal(t.scope, 'interact');
    alive = false; assert.equal(t.isCurrent(), false);
    assert.equal(x.svc.sharedThreadAuthority('0'.repeat(64), { read: () => true, effect: () => true }), null, 'an unbound row has none');
  } finally { x.close(); }
});

test('proposals: chips from my own list, approval alone sends nothing, [Send approved message] reviews and sends once', async () => {
  const x = await rig();
  try {
    assert.equal((await x.send('propose', 'Run the migration')).status, 'awaiting');
    x.later(10_000);
    let l = await x.list();
    assert.equal(l.proposals[0].status, 'awaiting'); assert.equal(l.proposals[0].action.card.confirm, 'Withdraw');
    assert.equal(l.proposals[0].title, 'From a teammate', 'the client\'s default "You" is never a name');
    x.approve();
    await tick();
    assert.equal(x.calls.length, 0, 'approval alone sends nothing');
    x.later(10_000);
    l = await x.list();
    const p = l.proposals[0];
    assert.equal(p.status, 'approved');
    assert.deepEqual(Object.keys(p).sort(), ['action', 'expiresAt', 'receipt', 'status', 'text', 'title']);
    assert.equal(p.action.card.title, "Send Bob's approved message");
    assert.ok(!JSON.stringify(l).includes(x.proposals[0].id) && !JSON.stringify(l).includes(x.proposals[0].digest), 'no proposal id or digest');
    x.later();
    const out = await x.confirm(p.action.selection, '');
    assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.status, 'sent');
    assert.equal(x.calls.length, 1); assert.equal(x.calls[0].text, 'Run the migration');
    assert.equal((await x.confirm(p.action.selection, '')).status, 'stale', 'one use');
    assert.equal(x.calls.length, 1);
    assert.equal((await x.list()).proposals[0].status, 'approved', 'a read inside 10 s returns the same result');
  } finally { x.close(); }
});

test('withdraw: my own awaiting proposal only; refused at confirm once the owner has acted', async () => {
  const x = await rig();
  try {
    await x.send('propose', 'First'); x.later(10_000);
    let l = await x.list(); x.later();
    x.approve(0);
    const out = await x.confirm(l.proposals[0].action.selection, '');
    assert.deepEqual([out.status, out.error], ['stale', SharedMain.TEXT.OWNER_ACTED]);
    assert.equal(x.proposals[0].status, 'approved', 'not cancelled');
    await x.send('propose', 'Second'); x.later(10_000);
    l = await x.list();
    const second = l.proposals.find((p) => p.text === 'Second');
    assert.equal(second.status, 'awaiting'); x.later();
    assert.equal((await x.confirm(second.action.selection, '')).status, 'withdrawn');
    assert.equal(x.proposals[1].status, 'revoked');
  } finally { x.close(); }
});

test('unconfirmed: a reply lost after dispatch says so and is never retried', async () => {
  const x = await rig();
  try {
    const r = await x.review('send', 'Maybe'); x.later();
    x.failSend();
    const out = await x.confirm(r.selection, 'Maybe');
    assert.equal(out.status, 'unconfirmed');
    assert.equal(out.error, SharedMain.TEXT.UNCONFIRMED);
    assert.equal(x.net.filter(([m, p]) => m === 'POST' && p.endsWith('/call')).length >= 1, true);
    const sends = x.net.length; await tick();
    assert.equal(x.net.length, sends, 'no retry');
  } finally { x.close(); }
});

test('proposal name: the account\'s display name for this viewer; email-like, "You", or another account\'s → "a teammate"', async () => {
  for (const [name, want] of [[{ userId: 'viewer', name: 'Callum Baker' }, 'From Callum Baker'], [{ userId: 'viewer', name: 'c@example.com' }, 'From a teammate'], [{ userId: 'someone-else', name: 'Mallory' }, 'From a teammate'], [null, 'From a teammate'], [{ userId: 'viewer', name: 'Ca‮llum\n' }, 'From Callum']]) {
    const x = await rig({ accountName: name });
    try { await x.send('propose', 'x'); assert.equal(x.proposals[0].title, want, JSON.stringify(name)); } finally { x.close(); }
  }
});

test('retirement: close, a reopened document and a turn change drop selections; nothing dispatches', async () => {
  const x = await rig();
  try {
    const h = await x.review('send', 'Hidden'); x.later();
    x.tm.retire(7);
    assert.equal((await x.confirm(h.selection, 'Hidden')).status, 'stale', 'hidden and shown again: the same document, but its cards are gone');
    const r = await x.review('send', 'Old'); x.later();
    x.reopen();
    assert.equal((await x.confirm(r.selection, 'Old')).status, 'stale');
    const r2 = await x.review('send', 'Old two'); x.later();
    await x.handlers.get('thread:close')(x.ev, x.id);
    assert.equal((await x.confirm(r2.selection, 'Old two')).status, 'stale');
    // A read that sees a new turn retires a card bound to the old one.
    const s = await x.review('send', 'Bound to idle');
    const o = await x.overviewInspect(); await x.svc.teamAction({ selection: o.selection, operation: 'send', text: 'Overview' });
    await x.state();
    x.later();
    assert.equal((await x.confirm(s.selection, 'Bound to idle')).status, 'stale');
    assert.deepEqual(x.calls.map((c) => c.text), ['Overview']);
  } finally { x.close(); }
});

// ── the projection and the renderer ─────────────────────────────────────
test('projection: controls are booleans and fixed reasons; Propose is idle-only; watch has nothing available', () => {
  const route = { ownerName: 'Bob', fake: false };
  const st = (o) => ({ status: 'ready', generation: 2, activeTurn: null, provider: { label: 'Codex' }, capabilities: { newTurn: true, steer: true, interrupt: true }, deliveries: [], ...o });
  const idle = SharedView.project({ state: st(), share: { scope: 'interact' }, route, now: 1 });
  assert.deepEqual(Object.keys(idle.controls), [...SharedView.CONTROL_KEYS]);
  assert.deepEqual(idle.controls.send, { available: true, reason: '' });
  assert.deepEqual(idle.controls.propose, { available: true, reason: '' });
  const busy = SharedView.project({ state: st({ status: 'working', activeTurn: '11111111-1111-4111-8111-111111111111' }), share: { scope: 'interact' }, route, now: 1 });
  assert.equal(busy.controls.steer.available, true); assert.equal(busy.controls.interrupt.available, true);
  assert.deepEqual(busy.controls.propose, { available: false, reason: "Bob's session is busy. Propose when it's idle." });
  assert.ok(!JSON.stringify(busy).includes('11111111'), 'no turn id');
  const claude = SharedView.project({ state: st({ status: 'working', activeTurn: '11111111-1111-4111-8111-111111111111', capabilities: { newTurn: true, steer: false, interrupt: true } }), share: { scope: 'interact' }, route, now: 1 });
  assert.deepEqual(claude.controls.steer, { available: false, reason: 'This provider does not support steering a running turn.' });
  const watch = SharedView.project({ state: st(), share: { scope: 'watch' }, route, now: 1 });
  for (const k of SharedView.CONTROL_KEYS) assert.equal(watch.controls[k].available, false, k);
});

const html = read('thread.html').replace(/<script[^]*?<\/script>/g, '');
const opened = [];
test.afterEach(() => { while (opened.length) opened.pop().close(); });
const ID = 'e'.repeat(64), TURN = '11111111-1111-4111-8111-111111111111';
const pv = (o = {}, scope = 'interact') => SharedView.project({ state: { status: 'ready', generation: 2, activeTurn: null, provider: { label: 'Codex' }, capabilities: { newTurn: true, steer: true, interrupt: true }, deliveries: [], ...o }, share: { scope }, route: { ownerName: 'Bob', fake: false }, now: 1 });
function page(views, api = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; opened.push(w);
  const calls = []; let ready = null, i = 0;
  const seq = Array.isArray(views) ? views : [views];
  w.threadApi = { open: async () => ({ kind: 'shared', header: null }), state: async () => ({}), close: async () => true,
    sharedState: async () => seq[Math.min(i++, seq.length - 1)], openTeam: async () => true,
    sharedReview: async (id, op, text) => { calls.push(['review', op, text]); return api.review ? api.review(op, text) : { ok: true, status: 'review', selection: crypto.randomUUID(), card: { op, title: 'From main', text, target: "Bob's Codex session", notes: ['a note'], confirm: 'Send', armMs: 600 } }; },
    sharedConfirm: async (id, sel, text) => { calls.push(['confirm', sel, text]); return api.confirm ? api.confirm() : { ok: true, status: 'sent', receipt: { id: 'r', state: 'acknowledged' } }; },
    sharedProposals: async () => { calls.push(['proposals']); return api.proposals ? api.proposals() : { ok: true, status: 'ready', proposals: [] }; },
    board: () => {}, onReady: (cb) => { ready = cb; }, onEvent() {} };
  for (const f of ['brand.js', 'src/tasks-view.js', 'src/transcript-md.js', 'src/transcript-dom.js', 'thread-shared.js', 'thread.js']) w.eval(read(f));
  return { w, calls, $: (id) => w.document.getElementById(id), ready: () => ready(ID), poll: () => w.document.dispatchEvent(new w.Event('visibilitychange')) };
}
const items = (p) => [...p.$('th-sh-menu').querySelectorAll('[role="menuitemradio"]')].map((b) => [b.dataset.op, b.disabled]);

test('renderer: idle default is Send; options Send / Steer / Propose, no Queue; placeholder and quota line', async () => {
  const p = page(pv());
  p.ready(); await tick(); await tick();
  assert.equal(p.$('th-sh-chip').textContent, 'Send ▾');
  assert.deepEqual(items(p), [['send', false], ['steer', true], ['propose', false]]);
  assert.ok(!/queue/i.test(p.$('th-sh-menu').textContent), 'no Queue option at all');
  assert.equal(p.$('th-sh-text').placeholder, "Message Bob's session");
  assert.equal(p.$('th-sh-quota').textContent, "Runs on Bob's Codex account and quota.");
  assert.equal(p.$('th-sh-stop').hidden, true, 'Stop only while a turn can be interrupted');
  assert.match(p.$('th-sh-menu').textContent, /Bob reviews this exact text before it runs\./);
});

test('renderer: busy Codex defaults to Steer with Stop; busy Claude (no steer) has no default, the box is disabled with the reason', async () => {
  const codex = page(pv({ status: 'working', activeTurn: TURN }));
  codex.ready(); await tick(); await tick();
  assert.equal(codex.$('th-sh-chip').textContent, 'Steer this turn ▾');
  assert.deepEqual(items(codex), [['send', true], ['steer', false], ['propose', true]]);
  assert.match(codex.$('th-sh-menu').textContent, /Bob's session is busy\. Propose when it's idle\./);
  assert.equal(codex.$('th-sh-stop').hidden, false);
  const claude = page(pv({ status: 'working', activeTurn: TURN, capabilities: { newTurn: true, steer: false, interrupt: true } }));
  claude.ready(); await tick(); await tick();
  assert.equal(claude.$('th-sh-text').disabled, true);
  assert.equal(claude.$('th-sh-note').textContent, 'A turn is running. Steer it where supported, or wait for it to finish.');
  assert.match(claude.$('th-sh-menu').textContent, /This provider does not support steering a running turn\./);
  assert.equal(claude.$('th-sh-stop').hidden, false);
});

test('renderer: the card shows main\'s fields only, arms 600 ms, sends just the selection and the exact text; success clears the draft', async () => {
  const p = page(pv());
  p.ready(); await tick(); await tick();
  p.$('th-sh-text').value = 'Exact <b>text</b>';
  p.$('th-sh-form').requestSubmit(); await tick(); await tick();
  assert.deepEqual(p.calls.find((c) => c[0] === 'review'), ['review', 'send', 'Exact <b>text</b>']);
  const card = p.$('th-sh-card');
  assert.equal(card.querySelector('.th-card-title').textContent, 'From main');
  assert.match(card.textContent, /Exact <b>text<\/b>Bob's Codex sessiona note/);
  assert.equal(card.querySelector('b'), null, 'textContent only');
  assert.equal(p.$('th-sh-yes').disabled, true, 'armed after 600 ms');
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(p.$('th-sh-yes').disabled, false);
  p.$('th-sh-yes').click(); await tick(); await tick();
  const conf = p.calls.find((c) => c[0] === 'confirm');
  assert.equal(conf.length, 3); assert.equal(conf[2], 'Exact <b>text</b>');
  assert.equal(p.$('th-sh-text').value, '', 'cleared after a send');
  assert.equal(card.children.length, 0);
});

test('renderer: a refused confirm keeps the draft and shows main\'s reason; a downgrade to watch clears it and shows the watch footer', async () => {
  const p = page([pv(), pv(), pv({}, 'watch')], { confirm: () => ({ ok: false, status: 'stale', error: SharedMain.TEXT.MOVED }) });
  p.ready(); await tick(); await tick();
  p.$('th-sh-text').value = 'Keep me';
  p.$('th-sh-form').requestSubmit(); await tick(); await tick();
  await new Promise((r) => setTimeout(r, 650));
  p.$('th-sh-yes').click(); await tick(); await tick(); await tick();
  assert.equal(p.$('th-sh-text').value, 'Keep me');
  assert.equal(p.$('th-sh-note').textContent, SharedMain.TEXT.MOVED);
  p.poll(); await tick(); await tick();
  assert.equal(p.$('th-shared').querySelector('.th-shared-foot').textContent, WATCH);
  assert.equal(p.$('th-sh-text'), null, 'no box on a watch share, so no private text left in it');
});

test('renderer: my proposals show their chips; Approved offers [Send approved message], disabled until idle', async () => {
  const sel = crypto.randomUUID();
  const list = { ok: true, status: 'ready', proposals: [
    { status: 'awaiting', title: 'From Callum', text: 'one', expiresAt: null, receipt: null, action: { selection: crypto.randomUUID(), card: { op: 'withdraw', title: 'Withdraw this proposal', text: 'one', target: 't', notes: [], confirm: 'Withdraw', armMs: 600 } } },
    { status: 'approved', title: 'From Callum', text: 'two', expiresAt: '2030-01-01T14:10:00.000Z', receipt: null, action: { selection: sel, card: { op: 'send-approved', title: "Send Bob's approved message", text: 'two', target: 't', notes: [], confirm: 'Send approved message', armMs: 600 } } },
    { status: 'rejected', title: 'From Callum', text: 'three', expiresAt: null, receipt: null, action: null }] };
  const p = page(pv({ status: 'working', activeTurn: TURN }), { proposals: () => list });
  p.ready(); await tick(); await tick(); await tick();
  const li = [...p.$('th-sh-proposals').children];
  assert.equal(li.length, 3);
  assert.equal(li[0].querySelector('.th-chip').textContent, 'Awaiting Bob');
  assert.equal(li[0].querySelector('button').textContent, 'Withdraw');
  assert.match(li[1].querySelector('.th-chip').textContent, /^Approved, one send until /);
  const send = li[1].querySelector('button');
  assert.equal(send.textContent, 'Send approved message'); assert.equal(send.disabled, true);
  assert.match(li[1].textContent, /Waiting for Bob's session to be idle\./);
  assert.equal(li[2].querySelector('.th-chip').textContent, 'Rejected'); assert.equal(li[2].querySelector('button'), null);
});

test('copy: T3 strings pass the glossary and platform-words rules', () => {
  const src = read('thread-shared.js') + read('src/thread-shared-main.js');
  assert.ok(!/this Mac/.test(src));
  assert.ok(!/Ask \$\{h\.owner\} to allow sending/.test(src), 'T2\'s watch wording is replaced');
});

test('afterRead: a read that sees a new generation or turn, or a watch scope, retires the card before any act', async () => {
  for (const next of [{ generation: 3, turn: null, scope: 'interact' }, { generation: 2, turn: TURN, scope: 'interact' }, { generation: 2, turn: null, scope: 'watch' }]) {
    let t = 0, seen = { generation: 2, turn: null, scope: 'interact' }, acted = 0;
    const auth = { live: () => true, owner: 'Bob', seen: () => seen, invalidate() {}, resolve: async () => ({ hub: {}, scope: 'interact' }),
      inspect: async () => ({ ok: true, selection: crypto.randomUUID(), state: { generation: 2, activeTurn: null, provider: { label: 'Codex' } }, capabilities: { send: { available: true, reason: '' } } }),
      act: async () => { acted++; return { ok: true, delivery: { id: 'd', state: 'acknowledged' } }; } };
    const a = SharedMain.createSharedThreadActions({ authority: () => auth, now: () => t });
    const c = { contents: { id: 1 }, generation: 1, boundId: 'b'.repeat(64) }, still = () => true;
    const r = await a.review(c, { op: 'send', text: 'x' }, still); t += 700;
    a.afterRead(c, { header: {} });
    assert.equal(a.size(), 1, 'the same generation and turn keeps it');
    seen = next; a.afterRead(c, { header: {} });
    assert.equal(a.size(), 0, JSON.stringify(next));
    assert.equal((await a.confirm(c, { selection: r.selection, text: 'x' }, still)).error, SharedMain.TEXT.MOVED);
    assert.equal(acted, 0);
  }
});

test('one use at the thread level: a second confirm never reaches the subsystem', async () => {
  let t = 0, acted = 0;
  const auth = { live: () => true, owner: 'Bob', seen: () => null, invalidate() {}, resolve: async () => ({ hub: {}, scope: 'interact' }),
    inspect: async () => ({ ok: true, selection: crypto.randomUUID(), state: { generation: 2, activeTurn: null, provider: { label: 'Codex' } }, capabilities: { send: { available: true, reason: '' } } }),
    act: async () => { acted++; return { ok: true, delivery: { id: 'd', state: 'acknowledged' } }; } };
  const a = SharedMain.createSharedThreadActions({ authority: () => auth, now: () => t });
  const c = { contents: { id: 1 }, generation: 1, boundId: 'b'.repeat(64) }, still = () => true;
  const r = await a.review(c, { op: 'send', text: 'x' }, still); t += 700;
  const [one, two] = await Promise.all([a.confirm(c, { selection: r.selection, text: 'x' }, still), a.confirm(c, { selection: r.selection, text: 'x' }, still)]);
  assert.deepEqual([one.ok, two.status], [true, 'stale']);
  assert.equal(acted, 1);
});

test('L35: an offline owner is not a moved-on session: review and confirm say offline, dispatch nothing, and recover', async () => {
  const x = await rig();
  try {
    const r = await x.review('send', 'hello');
    assert.equal(r.ok, true);
    x.later();
    x.setOffline();
    const c = await x.confirm(r.selection, 'hello');
    assert.equal(c.status, 'unavailable');
    assert.match(c.error, /offline/i);
    assert.doesNotMatch(c.error, /moved on/);
    assert.equal(x.calls.length, 0, 'nothing reached the provider');
    const again = await x.review('send', 'hello');
    assert.equal(again.status, 'unavailable');
    assert.match(again.error, /offline/i);
    assert.equal((await x.review('propose', 'hello')).status, 'unavailable');
    assert.equal(x.calls.length, 0);
    x.setOffline(false);
    const ok = await x.send('send', 'hello');
    assert.equal(ok.ok, true, 'recovers when the owner is back');
    assert.equal(x.calls.length, 1);
  } finally { x.close(); }
});

test('L35: an expired sign-in (401) at confirm says sign in again, is not "forbidden", dispatches nothing and does not retire the thread', async () => {
  const x = await rig();
  try {
    const r = await x.review('send', 'hello');
    x.later();
    x.setExpired();
    const c = await x.confirm(r.selection, 'hello');
    assert.equal(c.status, 'unavailable');
    assert.match(c.error, /sign in again/i);
    assert.equal(x.calls.length, 0);
    assert.equal((await x.state()).unavailable, true, 'the read says unavailable, not gone');
    x.setExpired(false);
    assert.equal((await x.send('send', 'hello')).ok, true, 'recovers');
  } finally { x.close(); }
});

test('L35: with the owner offline the proposal paths say offline too (list, request, withdraw, send-approved) and change nothing', async () => {
  const x = await rig();
  try {
    // request
    const r = await x.review('propose', 'Run it');
    assert.equal(r.ok, true); x.later();
    x.setOffline();
    const req = await x.confirm(r.selection, 'Run it');
    assert.equal(req.status, 'refused'); assert.match(req.error, /offline/i);
    assert.equal(x.proposals.length, 0, 'no proposal was created');
    x.setOffline(false);
    assert.equal((await x.send('propose', 'Run it')).status, 'awaiting');
    x.later(10_000);
    // withdraw
    let l = await x.list();
    const withdraw = l.proposals[0].action.selection; x.later();
    x.setOffline();
    const w = await x.confirm(withdraw, '');
    assert.equal(w.status, 'unavailable'); assert.match(w.error, /offline/i); assert.doesNotMatch(w.error, /already acted/);
    assert.equal(x.proposals[0].status, 'pending', 'not cancelled');
    // list
    x.later(10_000);
    const off = await x.list();
    assert.equal(off.status, 'unavailable'); assert.match(off.error, /offline/i);
    // send-approved
    x.setOffline(false); x.approve(); x.later(10_000);
    l = await x.list();
    const send = l.proposals[0].action.selection; x.later();
    x.setOffline();
    const s = await x.confirm(send, '');
    assert.equal(s.status, 'unavailable'); assert.match(s.error, /offline/i); assert.doesNotMatch(s.error, /busy, ended or changed/);
    assert.equal(x.calls.length, 0, 'nothing sent');
    x.setOffline(false); x.later(10_000);
    assert.equal((await x.list()).ok, true, 'recovers');
  } finally { x.close(); }
});
