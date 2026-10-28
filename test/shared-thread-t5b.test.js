'use strict';
// T5b (plan-t5b): Queue for when idle inside a teammate's shared thread, its list, cancel and discard.
// Same rig as shared-thread-t3.test.js plus the real follow-up store. Real interaction hub, real
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
const { createSessionFollowups } = require('../src/session-followups');
const os = require('node:os');
const { resolveFollowup } = require('../src/followup-resolve');

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
  let shared = true, scope = 'interact', expiresAt = null, hold = null, failSend = false, offline = false, expired = false;
  const proposals = [], net = [];
  const json = (body, status = 200) => ({ status, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
  const client = createTeamHubClient({ baseUrl: 'https://synthetic.invalid', token: () => 'test-only-token', viewer: { id: 'viewer', name: 'You' }, fetch: async (url, init) => {
    const u = new URL(url), method = init?.method ?? 'GET';
    net.push([method, u.pathname]);
    if (u.pathname.endsWith('/shared')) return json({ shared: shared ? [{ id: share, session, scope, team: { id: 'team', name: 'Team' }, owner: { id: 'owner', name: 'Bob' }, online: !offline, expires_at: expiresAt }] : [] });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-t5b-')), key = crypto.randomBytes(32), SCOPE = 'a'.repeat(64);
  const storage = {
    encryptAsync: async (text) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, Buffer.concat([c.update(text), c.final()]), c.getAuthTag()]); },
    decryptAsync: async (b) => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString(); },
  };
  const file = path.join(dir, 'outbox.bin'), q = createSessionFollowups({ file, storage, scope: () => SCOPE });
  const disk = async () => JSON.parse(await storage.decryptAsync(fs.readFileSync(file))).entries;
  let overviewFocus = true;
  const svc = createOverviewService({ followups: q, followupScope: () => SCOPE, backgroundFollowups: true, sessions: () => [], work: async () => ({ sources: [], capture: [] }), teamHub: () => client, current: () => true, actionCurrent: () => overviewFocus, accountName: () => accountName });
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
    expires: (v) => { expiresAt = v; },
    watch: () => { scope = 'watch'; }, interact: () => { scope = 'interact'; }, revoke: () => { shared = false; }, setOffline: (v = true) => { offline = v; }, setExpired: (v = true) => { expired = v; },
    blur: () => { foreground = false; }, focus: () => { foreground = true; }, overviewBlur: () => { overviewFocus = false; },
    reopen: () => { generation++; tm.retire(wc.id); },
    hold: (fn) => { hold = fn; }, failSend: (v = true) => { failSend = v; },
    approve: (i = 0) => { proposals[i].status = 'approved'; proposals[i].expiresAt = new Date(Date.now() + 600_000).toISOString(); },
    async overviewInspect() { const d = await svc.directory({ view: 'team', team: null }); return svc.teamInspect({ id: d.entries[0].id }); },
    q, disk, SCOPE, storage, file,
    // The main-level pump's pass (src/followup-pump.js), which is what runs with the chat-first gate on.
    deliver: () => q.advance((t) => resolveFollowup(t, { teamHub: () => client, local: null, scope: () => SCOPE })),
    close: () => { tm.stop(); hub.stopAll(); q.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return x;
}
// An expected refusal answers at once; a missing lock would wait on the held dispatch instead.
const within = (p, ms = 1500) => Promise.race([p, new Promise((r) => setTimeout(() => r({ status: 'no answer: dispatched past the lock' }), ms))]);
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { wait: p, release }; };

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
    sharedReview: async (id, op, text, seen) => { calls.push(seen ? ['review', op, text, seen] : ['review', op, text]); return api.review ? api.review(op, text) : { ok: true, status: 'review', selection: crypto.randomUUID(), card: { op, title: 'From main', text, target: "Bob's Codex session", notes: ['a note'], confirm: 'Send', armMs: 600 } }; },
    sharedAskEach: async (id, on) => { calls.push(['ask-each', on]); return api.askEach ? api.askEach(on) : { ok: true, status: 'ask-each', askEach: on }; },
    sharedConfirm: async (id, sel, text) => { calls.push(['confirm', sel, text]); return api.confirm ? api.confirm() : { ok: true, status: 'sent', receipt: { id: 'r', state: 'acknowledged' } }; },
    sharedQueue: async () => { calls.push(['queue']); return api.queue ? api.queue() : { ok: true, status: 'ready', items: [] }; },
    sharedQueueRemove: async (id, key, op) => { calls.push(['queue-remove', key, op]); return api.remove ? api.remove() : { ok: true, status: 'cancelled' }; },
    sharedProposals: async () => { calls.push(['proposals']); return api.proposals ? api.proposals() : { ok: true, status: 'ready', proposals: [] }; },
    board: () => {}, onReady: (cb) => { ready = cb; }, onEvent() {} };
  for (const f of ['brand.js', 'src/tasks-view.js', 'src/transcript-md.js', 'src/transcript-dom.js', 'thread-shared.js', 'thread.js']) w.eval(read(f));
  return { w, calls, $: (id) => w.document.getElementById(id), ready: () => ready(ID), poll: () => w.document.dispatchEvent(new w.Event('visibilitychange')) };
}
const items = (p) => [...p.$('th-sh-menu').querySelectorAll('[role="menuitemradio"]')].map((b) => [b.dataset.op, b.disabled]);

// ── helpers ──
const NOTICE = 'Sent once, when the session is idle, while Plexiform is running and you are signed in as you. If the share ends, becomes watch-only or you sign in as someone else, it is dropped and not sent.';
const generationOf = (x) => x.hub.state({ session: x.session }, x.actor).generation;
async function makeBusy(x) { const r = await x.hub.send({ session: x.session, generation: generationOf(x), text: 'owner turn', board: 'private-board' }, x.actor, { by: 'Owner' }); assert.equal(r.ok, true, JSON.stringify(r)); }
const finishTurn = (x) => x.emit({ kind: 'turn-completed', turnId: 'private-native-turn-1', status: 'completed' });
async function queue(x, text = 'Run the tests when you are free') { const r = await x.review('queue', text); assert.equal(r?.ok, true, JSON.stringify(r)); x.later(); return { r, done: await x.confirm(r.selection, text), text }; }
const qlist = (x, e = x.ev, id = x.id) => x.handlers.get('thread:shared-queue')(e, id);
const qremove = (x, key, op, e = x.ev, id = x.id) => { x.later(2100); return x.handlers.get('thread:shared-queue-remove')(e, id, { key, op }); };
const fresh = async (x) => { x.later(2100); return qlist(x); };

test('channels: the two T5b channels exist; nothing else was added', () => {
  for (const c of ['thread:shared-queue', 'thread:shared-queue-remove']) assert.ok(CHANNELS.includes(c), c);
  assert.equal(CHANNELS.length, 24);
});

test('queue review: a working session gets a card from main (notice, 7 days); an idle one is told to send; no `seen`', async () => {
  const x = await rig();
  try {
    const idle = await x.review('queue', 'later');
    assert.equal(idle.status, 'unavailable'); assert.equal(idle.error, 'Send now; the session is idle.');
    await makeBusy(x);
    const r = await x.review('queue', 'Run the tests when you are free');
    assert.equal(r.ok, true); assert.equal(r.status, 'review');
    assert.deepEqual({ ...r.card, notes: undefined }, { op: 'queue', title: "Queue for Bob's session", text: 'Run the tests when you are free', target: "Bob's Codex session", notes: undefined, confirm: 'Queue message', armMs: 600 });
    assert.deepEqual(r.card.notes, [NOTICE, 'Expires in 7 days.']);
    x.later(); const withSeen = await x.handlers.get('thread:shared-review')(x.ev, x.id, { op: 'queue', text: 'hi', seen: { generation: 1, turn: null } });
    assert.equal(withSeen.status, 'invalid', 'a queued message is never window-eligible');
    assert.equal((await x.disk().catch(() => [])).length, 0, 'a review stores nothing');
  } finally { x.close(); }
});

test('queue confirm: armed 600 ms, exact text, one use; stored once with the pinned target; the list carries opaque keys only', async () => {
  const x = await rig();
  try {
    await makeBusy(x);
    const text = 'Run the tests when you are free';
    const r = await x.review('queue', text);
    assert.equal((await x.confirm(r.selection, text)).status, 'not-ready', 'armed 600 ms');
    x.later();
    assert.equal((await x.confirm(r.selection, 'changed')).status, 'invalid');
    const ok = await x.confirm(r.selection, text);
    assert.equal(ok.ok, true); assert.equal(ok.status, 'queued');
    assert.equal((await x.confirm(r.selection, text)).status, 'stale', 'one use');
    const items = await x.disk();
    assert.equal(items.length, 1); assert.equal(items[0].text, text); assert.equal(items[0].status, 'queued');
    assert.equal(items[0].target.kind, 'team'); assert.equal(items[0].target.route.ref, x.share); assert.equal(items[0].label, 'Shared Codex session');
    assert.deepEqual(Object.keys(items[0].target.route), ['origin', 'viewer', 'team', 'ref']);
    x.later(2100);
    const l = await qlist(x);
    assert.equal(l.ok, true); assert.equal(l.items.length, 1);
    assert.deepEqual(Object.keys(l.items[0]).sort(), ['expiresAt', 'key', 'reason', 'receipt', 'state', 'text']);
    assert.match(l.items[0].key, /^[0-9a-f]{32}$/); assert.equal(l.items[0].state, 'queued');
    const raw = JSON.stringify(l);
    for (const secret of [items[0].id, items[0].target.key, x.share, 'synthetic.invalid', 'team']) assert.ok(!raw.includes(secret), `DTO leaks ${secret}`);
  } finally { x.close(); }
});

test('queue selection is bound to its op: a send selection cannot queue, a queue selection cannot send', async () => {
  const x = await rig();
  try {
    const sentBefore = x.calls.length;
    const s = await x.review('send', 'hello'); x.later();
    await x.confirm(s.selection, 'hello');
    assert.equal((await x.disk().catch(() => [])).length, 0, 'a send never lands in the queue');
    const q = await x.review('queue', 'wait for idle'); x.later(); // the carded send above left it working
    const before = x.calls.length;
    await x.confirm(q.selection, 'wait for idle');
    assert.equal(x.calls.length, before, 'queueing dispatches nothing');
    assert.ok(sentBefore <= before);
  } finally { x.close(); }
});

test('watch-only between review and confirm refuses and stores nothing; Queue is not offered on a watch share', async () => {
  const x = await rig();
  try {
    await makeBusy(x);
    const r = await x.review('queue', 'later'); x.later();
    x.watch();
    const out = await x.confirm(r.selection, 'later');
    assert.equal(out.status, 'forbidden');
    assert.equal((await x.disk().catch(() => [])).length, 0);
    assert.equal((await x.review('queue', 'later')).status, 'forbidden');
    const st = SharedView.project({ state: { status: 'working', generation: 2, activeTurn: '11111111-1111-4111-8111-111111111111', provider: { label: 'Codex' }, capabilities: { newTurn: true }, deliveries: [] }, share: { scope: 'watch' }, route: { ownerName: 'Bob', fake: false }, now: 1 });
    assert.deepEqual(st.controls.queue, { available: false, reason: 'Queueing needs an interact share.' });
  } finally { x.close(); }
});

test('Queue never opens or uses the 30-minute window: inside an open window it still gets a card', async () => {
  const x = await rig();
  try {
    const sent = await x.send('send', 'first'); assert.equal(sent.ok, true);
    const st = await x.state(); assert.ok(st.window > 0, 'a carded send opened the window');
    x.later(2100);
    const r = await x.review('queue', 'later');
    assert.equal(r.status, 'review', 'not direct'); assert.ok(r.card);
    x.later(); const q = await x.confirm(r.selection, 'later');
    assert.equal(q.ok, true);
    assert.equal((await x.disk()).length, 1);
  } finally { x.close(); }
});

test('a queue selection survives the turn ending between review and confirm (it waits for idle by design)', async () => {
  const x = await rig();
  try {
    await makeBusy(x);
    const r = await x.review('queue', 'after this turn'); x.later();
    finishTurn(x); x.later(2100); await x.state();
    const out = await x.confirm(r.selection, 'after this turn');
    assert.equal(out.ok, true, JSON.stringify(out));
  } finally { x.close(); }
});

test('a queued message is delivered once when the session is idle; the thread list then says Received; the lock is free', async () => {
  const x = await rig();
  try {
    await makeBusy(x);
    await queue(x);
    await x.deliver();
    assert.equal(x.calls.filter((c) => c.text === 'Run the tests when you are free').length, 0, 'still working: nothing sent');
    finishTurn(x);
    await x.deliver();
    assert.equal(x.calls.filter((c) => c.text === 'Run the tests when you are free').length, 1);
    assert.equal((await x.disk())[0].status, 'acknowledged');
    const l = await fresh(x);
    assert.equal(l.items[0].state, 'received');
    await x.deliver();
    assert.equal(x.calls.filter((c) => c.text === 'Run the tests when you are free').length, 1, 'never again');
    const { takeLock } = require('../src/team-session-controls');
    const rel = takeLock({ hub: x.client, viewer: { id: 'viewer' }, team: 'team', ref: x.share });
    assert.equal(typeof rel, 'function'); rel();
  } finally { x.close(); }
});

test('thread and Overview items for one session share one target and its 3-per-target cap', async () => {
  const x = await rig();
  try {
    await makeBusy(x);
    for (let i = 0; i < 3; i++) await queue(x, `queued ${i}`);
    const keys = new Set((await x.disk()).map((e) => e.target.key)); assert.equal(keys.size, 1);
    const d = await x.svc.directory({ view: 'team', team: null });
    const review = await x.svc.followupReview({ text: 'from overview', id: d.entries[0].id });
    assert.equal(review.ok, true, JSON.stringify(review));
    const added = await x.svc.followupEnqueue({ selection: review.selection, requestId: crypto.randomUUID(), text: 'from overview' });
    assert.equal(added.status, 'full', 'a 4th from Overview is refused');
    const r = await x.review('queue', 'fourth'); x.later();
    const out = await x.confirm(r.selection, 'fourth');
    assert.equal(out.status, 'refused'); assert.match(out.error, /Three follow-ups/);
    assert.equal((await x.disk()).length, 3);
  } finally { x.close(); }
});

test('cancel and discard: by key, per status; unknown, stale or other items are refused and untouched', async () => {
  const x = await rig();
  try {
    await makeBusy(x);
    await queue(x, 'one'); await queue(x, 'two');
    let l = await fresh(x); assert.equal(l.items.length, 2);
    const [a, b] = l.items;
    assert.equal((await qremove(x, a.key, 'discard')).status, 'stale', 'a waiting message is cancelled, not discarded');
    assert.equal((await qremove(x, 'f'.repeat(32), 'cancel')).status, 'stale', 'unknown key');
    assert.equal((await qremove(x, a.key, 'cancel')).ok, true);
    let disk = await x.disk();
    const gone = disk.find((e) => e.text === ''); assert.equal(gone.status, 'cancelled');
    assert.equal(disk.find((e) => e.text === 'two').status, 'queued');
    l = await fresh(x); assert.equal(l.items.length, 1, 'cancelled rows are hidden');
    finishTurn(x); await x.deliver();
    l = await fresh(x); assert.equal(l.items[0].state, 'received');
    assert.equal((await qremove(x, l.items[0].key, 'cancel')).status, 'stale', 'a received message cannot be cancelled');
    assert.equal((await qremove(x, l.items[0].key, 'discard')).ok, true);
    assert.equal((await x.disk()).some((e) => e.id && e.text === 'two'), false);
    assert.ok(b.key);
  } finally { x.close(); }
});

test('an item for another share is not in this thread\'s list and cannot be reached by key', async () => {
  const x = await rig();
  try {
    await makeBusy(x);
    await queue(x, 'mine');
    const other = { kind: 'team', key: 'd'.repeat(64), route: { origin: 'https://synthetic.invalid', viewer: 'viewer', team: 'team', ref: crypto.randomUUID() }, generation: 1, provider: 'codex' };
    assert.equal((await x.q.enqueue({ id: crypto.randomUUID(), target: other, text: 'other share', label: 'x', current: () => true })).ok, true);
    const l = await fresh(x);
    assert.deepEqual(l.items.map((i) => i.text), ['mine']);
    for (let i = 0; i < 3; i++) assert.equal((await qremove(x, crypto.randomBytes(16).toString('hex'), 'cancel')).status, 'stale');
    assert.equal((await x.disk()).find((e) => e.text === 'other share').status, 'queued');
  } finally { x.close(); }
});

test('Guard T on both channels: sender, frame, args, unbound id; the remove channel has a rate floor and a closed shape', async () => {
  const x = await rig();
  try {
    await makeBusy(x);
    await queue(x);
    x.later(2100);
    assert.equal(await qlist(x, { sender: {}, senderFrame: x.ev.senderFrame }), null);
    assert.equal(await qlist(x, { sender: x.ev.sender, senderFrame: {} }), null);
    assert.equal(await qlist(x, x.ev, 'f'.repeat(64)), null, 'another row id');
    assert.equal(await x.handlers.get('thread:shared-queue')(x.ev, x.id, 'extra'), null, 'extra args');
    const key = (await qlist(x)).items[0].key;
    const rm = x.handlers.get('thread:shared-queue-remove');
    assert.equal(await rm({ sender: {}, senderFrame: x.ev.senderFrame }, x.id, { key, op: 'cancel' }), null);
    assert.equal(await rm(x.ev, 'f'.repeat(64), { key, op: 'cancel' }), null);
    x.later(2100);
    assert.equal((await rm(x.ev, x.id, { key, op: 'cancel', extra: 1 })).status, 'invalid');
    x.later(2100);
    assert.equal((await rm(x.ev, x.id, { key: 'nothex', op: 'cancel' })).status, 'invalid');
    x.later(2100);
    assert.equal((await rm(x.ev, x.id, { key, op: 'delete' })).status, 'invalid');
    x.later(2100);
    assert.equal((await rm(x.ev, x.id, { key, op: 'cancel' })).ok, true);
    assert.equal((await rm(x.ev, x.id, { key, op: 'cancel' })).status, 'busy', '2 s floor per document');
    x.blur(); x.later(2100);
    assert.equal(await rm(x.ev, x.id, { key, op: 'cancel' }), null, 'an effect needs the focused document');
  } finally { x.close(); }
});

test('a revoked share reads as unavailable and its queue stays out of the thread', async () => {
  const x = await rig();
  try {
    await makeBusy(x);
    await queue(x);
    x.revoke(); x.later(2100);
    const l = await qlist(x);
    assert.notEqual(l.ok, true);
    assert.ok(!JSON.stringify(l).includes('Run the tests'));
  } finally { x.close(); }
});

test('static: the one enqueue call site is the queue branch of run(); thread-main never touches the store; the target keeps Overview\'s route order', () => {
  const sm = read('src/thread-shared-main.js'), tm = read('src/thread-main.js'), os_ = read('src/overview-service.js');
  assert.equal((sm.match(/auth\.queue\.enqueue\(/g) || []).length, 1);
  assert.match(sm, /if \(op === 'queue'\) \{\n      try \{ out = await auth\.queue\.enqueue\(/);
  assert.ok(!/queue\.enqueue|followups/.test(tm));
  assert.match(os_, /route:\{origin:hub\.origin,viewer:r\.viewerId,team:r\.team,ref:r\.ref\}/);
  assert.match(os_, /target=pinned\(\{kind:'team',route:\{origin:r\.hub\.origin,viewer:r\.viewer\.id,team:r\.team,ref:r\.ref\}/);
});

// ── the page ──
test('page: Queue is an option; with a window open it says Review, sends no `seen`, and gets a card', async () => {
  const p = page(pv({ status: 'working', activeTurn: TURN }));
  p.ready(); await tick(); await tick();
  assert.deepEqual(items(p), [['send', true], ['steer', false], ['queue', false], ['propose', true]]);
  const q = p.$('th-sh-menu').querySelector('[data-op="queue"]'); assert.match(q.textContent, /Queue for when idle/);
  q.click();
  assert.equal(p.$('th-sh-chip').textContent, 'Queue for when idle ▾');
  p.$('th-sh-text').value = 'later';
  p.$('th-sh-form').requestSubmit(); await tick(); await tick();
  assert.deepEqual(p.calls.find((c) => c[0] === 'review'), ['review', 'queue', 'later']);
  assert.ok(p.$('th-sh-card').querySelector('.th-review'));
});

test('page: inside an open window Queue still shows Review and sends no seen', async () => {
  const view = { ...pv({ status: 'working', activeTurn: TURN }), window: Date.now() + 600000, askEach: false };
  const p = page(view);
  p.ready(); await tick(); await tick();
  assert.equal(p.$('th-sh-go').textContent, 'Steer', 'Steer is window-eligible');
  p.$('th-sh-menu').querySelector('[data-op="queue"]').click();
  assert.equal(p.$('th-sh-go').textContent, 'Review');
  p.$('th-sh-text').value = 'later'; p.$('th-sh-form').requestSubmit(); await tick(); await tick();
  const call = p.calls.find((c) => c[0] === 'review'); assert.deepEqual(call, ['review', 'queue', 'later']);
});

test('page: a working Claude session without Steer can still pick Queue', async () => {
  const p = page(pv({ status: 'working', activeTurn: TURN, capabilities: { newTurn: true, steer: false, interrupt: true } }));
  p.ready(); await tick(); await tick();
  assert.equal(p.$('th-sh-chip').disabled, false);
  assert.equal(p.$('th-sh-text').disabled, true, 'no option chosen yet');
  p.$('th-sh-menu').querySelector('[data-op="queue"]').click();
  assert.equal(p.$('th-sh-text').disabled, false);
});

test('page: the Queued block shows main\'s rows with Cancel or Discard that send only the opaque key', async () => {
  const rows = [
    { key: 'a'.repeat(32), text: 'waiting one', state: 'queued', reason: '', expiresAt: Date.now() + 6 * 86400000, receipt: null },
    { key: 'b'.repeat(32), text: 'done one', state: 'received', reason: '', expiresAt: null, receipt: { state: 'acknowledged' } },
    { key: 'c'.repeat(32), text: 'dropped one', state: 'not-sent', reason: 'Bob changed this share to watch only; this follow-up won\'t be sent.', expiresAt: null, receipt: null },
  ];
  const p = page(pv({ status: 'working', activeTurn: TURN }), { queue: async () => ({ ok: true, status: 'ready', items: rows }) });
  p.ready(); await tick(); await tick(); await tick();
  const host = p.$('th-sh-queue'); assert.equal(host.hidden, false);
  const li = [...host.querySelectorAll('li')];
  assert.equal(li.length, 3);
  assert.match(li[0].textContent, /waiting one[^]*Queued[^]*Expires in 6d[^]*Cancel/);
  assert.match(li[1].textContent, /done one[^]*Received[^]*Discard/);
  assert.match(li[2].textContent, /dropped one[^]*Not sent[^]*Bob changed this share/);
  li[0].querySelector('button').click(); await tick();
  li[1].querySelector('button').click(); await tick();
  assert.deepEqual(p.calls.filter((c) => c[0] === 'queue-remove'), [['queue-remove', 'a'.repeat(32), 'cancel'], ['queue-remove', 'b'.repeat(32), 'discard']]);
});
