'use strict';
// T4a (plan-t4a.md, Rev 1): my own Plexiform-held sessions as chat-first sidebar rows and read-only
// `owned` threads. A real interaction-main and hub (in-memory providers), the real overview-service,
// sidebar projection and thread-main, and the renderer in JSDOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { createInteractionMain, CHANNELS: IX } = require('../src/interaction-main');
const { createOverviewService } = require('../src/overview-service');
const { sidebarRows, KEYS } = require('../src/overview-sidebar-rows');
const { createOwnedRows, MAX_ROWS } = require('../src/owned-rows');
const OwnedThread = require('../src/owned-thread-view');
const { createThreadMain, CHANNELS } = require('../src/thread-main');
const crypto = require('node:crypto');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function memAdapter(label, target) {
  const ee = new EventEmitter();
  return {
    label, capabilities: { newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false },
    open: async () => ({ target: target() }), send: async () => ({ turnId: 'turn-1', mode: 'new-turn' }),
    interrupt: async () => true, release: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}
function channelAdapter() {
  const ee = new EventEmitter();
  return {
    label: 'Claude Code terminal channel', capabilities: { existingSessions: true, newTurn: true, steer: false, interrupt: false, ack: 'channel-accept-tool', echo: 'channel-accept-exact-text' },
    alive: () => true, discover: async () => [{ id: 'grant-target', title: 'Synthetic terminal', project: '/tmp/synthetic', status: 'idle' }],
    attach: async ({ target }) => ({ target, status: 'idle', permissions: { approvalPolicy: 'unknown', sandbox: 'unknown' } }),
    release: async () => true, stop() {}, on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}

function rig() {
  let scope = 'acct-a', doc = 1, n = 0;
  const wc = { id: 1, mainFrame: {}, isDestroyed: () => false, send() {} };
  const ctx = () => ({ contents: wc, document: doc, generation: 1, foreground: true });
  const x = createInteractionMain({
    owned: null, localModels: null, context: ctx, readContext: ctx, currentBoard: () => 'local', accountScope: () => scope,
    workspace: (id) => `/private/tmp/proj-${id.slice(-4)}`,
    adapters: { codex: memAdapter('Codex', () => `native-${++n}`), claude: memAdapter('Claude Code', () => `claude-${++n}`), 'claude-channel': channelAdapter() },
  });
  const handlers = new Map();
  x.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const ev = { sender: wc, senderFrame: wc.mainFrame };
  const call = (ch, req) => handlers.get(ch)(ev, req);
  let reaps = 0;
  const reap = x.hub.reap;
  x.hub.reap = (...a) => { reaps++; return reap(...a); };
  const raw = [];
  const ownedThreads = { view: () => x.ownedView(), state: (e, a, s) => x.ownedState(e, a, s), epoch: () => x.ownedEpoch() };
  const svc = createOverviewService({ sessions: () => raw, ownedThreads });
  return {
    x, svc, raw, call, reaps: () => reaps,
    launch: async (provider) => (await call(IX.launch, { provider })).state,
    attachChannel: async () => { const d = await call(IX.discover, { provider: 'claude-channel' }); return (await call(IX.attach, { provider: 'claude-channel', handle: d.threads[0].handle })).state; },
    reload: async () => { doc++; await call(IX.list); },
    setScope: (v) => { scope = v; },
    rows: async () => sidebarRows(await svc.passiveRows(() => true)),
    close: () => x.close(),
  };
}
const reported = (sessionId) => ({ sessionId, source: 'codex', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: '/private/tmp/checkout' });

// ── condition 1: the non-reaping accessor ───────────────────────────────
test('ownedView and ownedState are read-only: no reap, documents unchanged, nothing after a retire', async () => {
  const r = rig();
  try {
    const s = await r.launch('codex');
    const before = { reaps: r.reaps(), docs: r.x.documents(), epoch: r.x.ownedEpoch() };
    for (let i = 0; i < 3; i++) {
      const v = r.x.ownedView();
      assert.equal(v.sessions.length, 1);
      assert.equal(v.sessions[0].session, s.session);
      assert.ok(r.x.ownedState(v.epoch, v.sessions[0].actor, s.session));
    }
    assert.deepEqual({ reaps: r.reaps(), docs: r.x.documents(), epoch: r.x.ownedEpoch() }, before, 'no reap, no document change, same epoch');
    const v = r.x.ownedView();
    await r.x.retireDocuments();
    assert.equal(r.x.ownedView().sessions.length, 0);
    assert.equal(r.x.ownedState(v.epoch, v.sessions[0].actor, s.session), null, 'an old epoch never reads');
  } finally { r.close(); }
});

test('the epoch moves on replacement (before the reap), retire and close; ownedState re-checks it', async () => {
  const r = rig();
  try {
    const s = await r.launch('codex');
    const v = r.x.ownedView(), e0 = v.epoch;
    let atReap = null;
    const reap = r.x.hub.reap;
    r.x.hub.reap = (...a) => { atReap = r.x.ownedEpoch(); return reap(...a); };
    await r.reload();
    assert.equal(atReap, e0 + 1, 'the epoch moved before the reap was awaited');
    assert.equal(r.x.ownedState(e0, v.sessions[0].actor, s.session), null);
    const e1 = r.x.ownedEpoch();
    await r.x.retireDocuments();
    assert.equal(r.x.ownedEpoch(), e1 + 1);
    r.x.close();
    assert.equal(r.x.ownedEpoch(), e1 + 2);
  } finally { r.close(); }
});

// ── S1: account, shareable set, channels ────────────────────────────────
test('only this account\'s shareable sessions are listed; an account switch empties the list', async () => {
  const r = rig();
  try {
    await r.launch('codex');
    assert.equal(r.x.ownedView().sessions.length, 1);
    r.setScope('acct-b');
    assert.equal(r.x.ownedView().sessions.length, 0, "another account's session isn't listed");
    const b = await r.launch('claude');
    assert.deepEqual(r.x.ownedView().sessions.map((o) => o.session), [b.session]);
  } finally { r.close(); }
});

test('a claude-channel attach is listed for its account, and is still not a follow-up target', async () => {
  const r = rig();
  try {
    const c = await r.attachChannel();
    assert.equal(c.provider.id, 'claude-channel');
    assert.equal(c.ownership, 'existing-unmanaged');
    assert.deepEqual(r.x.ownedView().sessions.map((o) => o.session), [c.session]);
    assert.equal(r.x.followupTarget(c.session), null, 'followupTarget needs plexiform-owned');
  } finally { r.close(); }
});

// ── condition 2 and M1: rows ────────────────────────────────────────────
function unit() {
  const secret = crypto.randomBytes(8), stable = (p) => crypto.createHmac('sha256', secret).update(JSON.stringify(p)).digest('hex');
  let time = 1_000_000;
  const rows = createOwnedRows({ stable, now: () => time });
  const st = (over = {}) => ({ session: over.session ?? 's-1', provider: { id: over.provider ?? 'codex' }, status: 'ready', task_title: null, input_needed: false, activity: null, deliveries: [], ...over.state });
  const view = (epoch, list, account = 'a') => ({ epoch, account, sessions: list.map((o) => ({ actor: 'overview:1:1', session: o.session ?? 's-1', leaf: 'proj', nativeSessionId: o.native ?? null, state: st(o) })) });
  const refs = (...natives) => new Map(natives.map((nv, i) => [`r${i}`.padEnd(64, '0'), { ref: { provider: 'codex', sessionId: nv, origin: 'external' } }]));
  return { rows, view, refs, stable, tick: (ms) => { time += ms; } };
}

test('Codex dedupe: one twin folds, two twins or none keep the owned row; Claude and channel rows', () => {
  const u = unit();
  let p = u.rows.pass(u.view(1, [{ native: 'n-1' }]), u.refs('n-1'));
  assert.equal(p.rows.length, 0, 'exactly one reported twin: the twin is the one row');
  const v = unit();
  p = v.rows.pass(v.view(1, [{ native: 'n-1' }]), v.refs('n-1', 'n-1'));
  assert.equal(p.rows.length, 1, 'ambiguous: the owned row'); assert.equal(p.hide.size, 0, 'and both reported rows stay');
  const w = unit();
  p = w.rows.pass(w.view(1, [{ native: 'n-1' }, { session: 's-2', provider: 'claude' }, { session: 's-3', provider: 'claude-channel' }]), w.refs());
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows.map((x) => x.vm.title), ['Codex session in proj', 'Claude session in proj', 'Plexiform channel']);
  assert.ok(p.rows.every((x) => x.vm.ref.origin === 'owned' && x.vm.ref.driver === 'owned'));
});

test('M1: sticky per epoch: present → absent → present never tombstones or shows two owner rows', () => {
  const u = unit();
  const v = u.view(1, [{ native: 'n-1' }]);
  for (const twins of [u.refs('n-1'), u.refs(), u.refs('n-1'), u.refs()]) {
    const p = u.rows.pass(v, twins);
    assert.equal(p.rows.length, 0, 'folded for the whole epoch');
    assert.deepEqual(p.ended, [], 'no tombstone');
  }
  // Never folded, then a late twin: the owned row stays and the twin is hidden, so still one row.
  const w = unit(), vw = w.view(1, [{ native: 'n-1' }]);
  let p = w.rows.pass(vw, w.refs());
  assert.equal(p.rows.length, 1);
  const id = p.rows[0].dto.id;
  p = w.rows.pass(vw, w.refs('n-1'));
  assert.deepEqual([p.rows.length, p.rows[0].dto.id, [...p.hide].length], [1, id, 1]);
  p = w.rows.pass(vw, w.refs());
  assert.deepEqual([p.rows.length, p.ended.length], [1, 0]);
});

test('tombstones only with a reason: epoch move → overview, end or close → ended; account and cap are silent', () => {
  const u = unit();
  let p = u.rows.pass(u.view(1, [{ session: 's-1', provider: 'claude' }, { session: 's-2', provider: 'claude' }]), u.refs());
  const [a, b] = p.rows.map((x) => x.dto.id);
  p = u.rows.pass(u.view(1, [{ session: 's-1', provider: 'claude', state: { status: 'ended' } }]), u.refs());
  assert.deepEqual(p.ended.sort((x, y) => x.id.localeCompare(y.id)), [{ id: a, reason: 'ended' }, { id: b, reason: 'ended' }].sort((x, y) => x.id.localeCompare(y.id)));
  const w = unit();
  p = w.rows.pass(w.view(1, [{ session: 's-1', provider: 'claude' }]), w.refs());
  const c = p.rows[0].dto.id;
  p = w.rows.pass(w.view(2, [{ session: 's-1', provider: 'claude' }]), w.refs());
  assert.deepEqual(p.ended, [{ id: c, reason: 'overview' }]);
  assert.notEqual(p.rows[0].dto.id, c, 'the new epoch gives a new id');
  assert.equal(w.rows.target(c).vm, null, 'the old id resolves only to its tombstone');
  const z = unit();
  z.rows.pass(z.view(1, [{ session: 's-1', provider: 'claude' }], 'a'), z.refs());
  p = z.rows.pass(z.view(1, [], 'b'), z.refs());
  assert.deepEqual(p.ended, [], 'another account: silent');
  const many = Array.from({ length: MAX_ROWS + 3 }, (_, i) => ({ session: `s-${i}`, provider: 'claude' }));
  const q = unit();
  p = q.rows.pass(q.view(1, many), q.refs());
  assert.equal(p.rows.length, MAX_ROWS);
  assert.deepEqual(p.ended, [], 'over the cap: silent');
  p = q.rows.pass(q.view(1, many.slice(3)), q.refs());
  assert.equal(p.ended.length, 3, 'the three that closed tombstone');
});

// ── the service and the sidebar payload ─────────────────────────────────
test('sidebarRows passes ended through as a 64-hex id and a closed reason only', () => {
  const good = 'c'.repeat(64);
  const out = sidebarRows({ status: 'complete', rows: [], vms: new Map(), ended: [{ id: good, reason: 'overview', session: 'x' }, { id: 'short', reason: 'ended' }, { id: 'd'.repeat(64), reason: 'account' }, null] });
  assert.deepEqual(out.ended, [{ id: good, reason: 'overview' }]);
});

test('passiveRows: the owned rows join the sidebar with fixed keys; a reported twin folds; retire tombstones', async () => {
  const r = rig();
  try {
    const cdx = await r.launch('codex'), cl = await r.launch('claude');
    const native = r.x.hub.targetOf(cdx.session);
    r.raw.push(reported(native));
    let out = await r.rows();
    assert.equal(out.sessions.length, 2, 'the Codex twin is its one row, plus the Claude owned row');
    for (const s of out.sessions) assert.deepEqual(Object.keys(s), KEYS);
    const owned = out.sessions.find((s) => s.title.startsWith('Claude session'));
    assert.ok(owned, JSON.stringify(out.sessions));
    assert.deepEqual([owned.chat, owned.terminal, owned.thread], [false, false, true]);
    assert.ok(!JSON.stringify(out).includes(cl.session) && !JSON.stringify(out).includes(native), 'no session or native id');
    assert.equal(r.svc.threadTarget(owned.id).kind, 'owned');
    await r.x.retireDocuments();
    out = await r.rows();
    assert.deepEqual(out.ended, [{ id: owned.id, reason: 'overview' }]);
    assert.ok(!out.sessions.some((s) => s.id === owned.id));
  } finally { r.close(); }
});

test('the thread read: fixed keys and bounds, no ids; gone with the right reason', async () => {
  const r = rig();
  try {
    const cl = await r.launch('claude');
    assert.equal((await r.call(IX.send, { session: cl.session, generation: cl.generation, text: 'please check the build' })).ok, true);
    const id = (await r.rows()).sessions[0].id;
    const v = r.svc.ownedThreadRead(id);
    assert.deepEqual(Object.keys(v), OwnedThread.TOP_KEYS);
    assert.deepEqual(Object.keys(v.header), OwnedThread.HEADER_KEYS);
    assert.equal(v.deliveries.length, 1);
    assert.equal(v.deliveries[0].text, 'please check the build');
    // T2's own bounds and cleaners (shared-thread-view), on a hostile state.
    const big = OwnedThread.project({ now: 10, state: { provider: { id: 'codex', label: 'Codex' }, status: 'weird', task_title: `a\u202e${'t'.repeat(300)}`,
      deliveries: Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, text: 'x'.repeat(9000), response: 'y'.repeat(20000), state: 'nope' })) } });
    assert.deepEqual([big.deliveries.length, big.deliveries[0].text.length, big.deliveries[0].response.length, big.deliveries[0].state, big.status], [10, 4000, 16000, 'unknown', 'ready']);
    assert.equal(big.header.title.length, 120); assert.ok(!big.header.title.includes('\u202e'));
    assert.ok(!JSON.stringify(v).includes(cl.session), 'no session id');
    await r.reload();
    assert.deepEqual(r.svc.ownedThreadRead(id), { gone: true, reason: 'overview' });
    const r2 = rig();
    try {
      const s2 = await r2.launch('claude');
      const id2 = (await r2.rows()).sessions[0].id;
      await r2.call(IX.close, { session: s2.session, generation: s2.generation });
      assert.deepEqual(r2.svc.ownedThreadRead(id2), { gone: true, reason: 'ended' });
    } finally { r2.close(); }
  } finally { r.close(); }
});

// ── thread-main: Guard T, no effect path ────────────────────────────────
const ID = 'a'.repeat(64);
function threadRig({ target = { kind: 'owned', vm: null }, ownedRead = () => ({ header: { title: 'T' } }) } = {}) {
  let time = 100000, foreground = true;
  const contents = { id: 7, isDestroyed: () => false, mainFrame: {}, send() {} };
  const win = { isDestroyed: () => false };
  const buddy = { threadContext: () => ({ window: win, contents, frame: contents.mainFrame, generation: 1, boundId: ID, foreground, account: 'a', workspace: 'w' }) };
  const calls = { read: 0, overview: 0, copy: 0, act: 0 };
  const handlers = {};
  const tm = createThreadMain({ buddy: () => buddy, chatPreview: true, target: () => target, now: () => time, copy: () => { calls.copy++; },
    tasks: () => ({ act: async () => { calls.act++; return { ok: true }; }, openTask: async () => ({ ok: false }), closeTask: async () => {} }),
    activity: async () => null, openInTasks: async () => true, goToTerminal: async () => ({ ok: true }),
    ownedRead: (rowId) => { calls.read++; return ownedRead(rowId); }, openOverview: () => { calls.overview++; return true; } });
  tm.register({ handle: (ch, fn) => { handlers[ch] = fn; } });
  const ev = { sender: contents, senderFrame: contents.mainFrame };
  return { handlers, ev, calls, tick: (ms) => { time += ms; }, setTarget: (t) => { target = t; }, setForeground: (f) => { foreground = f; }, call: (ch, ...a) => handlers[ch](ev, ...a) };
}

test('Guard T on thread:owned-state: sender, frame, args, kind; a 2 s floor', async () => {
  const t = threadRig();
  assert.equal(await t.handlers['thread:owned-state']({ sender: {}, senderFrame: {} }, ID), null);
  assert.equal(await t.call('thread:owned-state', ID, 'extra'), null);
  assert.equal(await t.call('thread:owned-state', 'b'.repeat(64)), null);
  for (const kind of ['task', 'session', 'shared']) { t.setTarget({ kind, taskId: 't', sessionId: 's', source: 'claude' }); assert.equal(await t.call('thread:owned-state', ID), null, kind); }
  assert.equal(t.calls.read, 0);
  t.setTarget({ kind: 'owned', vm: null });
  assert.deepEqual(await t.call('thread:owned-state', ID), { header: { title: 'T' } });
  await t.call('thread:owned-state', ID);
  assert.equal(t.calls.read, 1, 'inside the 2 s floor');
  t.tick(2000); await t.call('thread:owned-state', ID);
  assert.equal(t.calls.read, 2);
  t.setTarget(null);
  assert.deepEqual(await t.call('thread:owned-state', ID), { gone: true, reason: 'ended' });
  assert.deepEqual(await t.call('thread:open', ID), { gone: true });
});

test('owned rows have no effect path: no message, act or copy link; Open in Overview is focused and rate-limited', async () => {
  const t = threadRig();
  assert.deepEqual(await t.call('thread:open', ID), { kind: 'owned', header: null });
  assert.equal((await t.call('thread:message', { id: ID, body: 'hi' })).ok, false);
  assert.equal((await t.call('thread:act', { id: ID, action: 'stop', confirmed: true })).ok, false);
  assert.equal(await t.call('thread:copy-link', ID), false);
  assert.equal(t.calls.act + t.calls.copy, 0);
  t.setForeground(false);
  assert.equal(await t.call('thread:open-overview', ID), false);
  t.setForeground(true);
  assert.equal(await t.call('thread:open-overview', ID), true);
  assert.equal(await t.call('thread:open-overview', ID), false, '500 ms floor');
  t.tick(600); t.setTarget({ kind: 'shared' });
  assert.equal(await t.call('thread:open-overview', ID), false, 'only an owned row');
  assert.equal(t.calls.overview, 1);
  const added = CHANNELS.filter((c) => c.startsWith('thread:owned') || c === 'thread:open-overview');
  assert.deepEqual(added, ['thread:owned-state', 'thread:open-overview']);
  const src = read('src/thread-main.js'), body = src.slice(src.indexOf('function ownedState'), src.indexOf('// "Team overview"'));
  for (const word of ['send(', 'act(', 'interrupt', 'share', 'proposal']) assert.ok(!body.includes(word), `${word} is not in the owned path`);
});

// ── the renderer ────────────────────────────────────────────────────────
const html = read('thread.html').replace(/<script[^]*?<\/script>/g, '');
function page(states) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [];
  let ready = null, i = 0;
  w.threadApi = { open: async () => ({ kind: 'owned', header: null }), state: async () => ({ kind: 'owned', header: null }), close: async () => true,
    ownedState: async () => states[Math.min(i++, states.length - 1)], openOverview: async () => { calls.push('overview'); return true; },
    onReady: (cb) => { ready = cb; }, onEvent: () => {}, onInputsChanged: () => {}, board: () => calls.push('board') };
  for (const f of ['brand.js', 'src/tasks-view.js', 'src/transcript-md.js', 'src/transcript-dom.js', 'thread-shared.js', 'thread-owned.js', 'thread.js']) w.eval(read(f));
  return { w, $: (id) => w.document.getElementById(id), calls, start: () => ready(ID) };
}
const VIEW = { header: { title: 'Fix the login', provider: 'Codex', channel: false }, activity: { category: 'Editing files', ageMs: 4000, stale: false }, status: 'working',
  deliveries: [{ id: 'd1', by: null, text: '<b>hi</b>', state: 'replied', response: 'Done it', at: 1 }] };

test('renderer: header, activity, messages, footer and no prompt box; textContent only', async () => {
  const p = page([VIEW]);
  try {
    p.start(); await tick(10);
    assert.equal(p.$('th-title').textContent, 'Fix the login');
    assert.equal(p.$('th-meta').textContent, 'Codex session · Started from Overview');
    const root = p.$('th-owned');
    assert.match(root.querySelector('.th-activity').textContent, /^Now: Editing files/);
    assert.equal(root.querySelector('.th-msg-text').textContent, '<b>hi</b>');
    assert.equal(root.querySelector('.th-msg b'), null);
    assert.match(root.querySelector('.th-shared-foot').textContent, /Started from Overview\. To message it, use Overview\./);
    assert.equal(root.querySelector('textarea'), null, 'no prompt box');
    assert.ok(p.$('th-reply').hidden && p.$('th-more').hidden);
    p.$('th-ow-overview').click(); await tick();
    assert.deepEqual(p.calls, ['overview']);
    const ch = page([{ ...VIEW, header: { title: OwnedThread.CHANNEL_TITLE, provider: 'Claude Code', channel: true } }]);
    try { ch.start(); await tick(10); assert.equal(ch.$('th-title').textContent, 'Plexiform channel'); assert.equal(ch.$('th-meta').textContent, 'Claude Code in your terminal · Connected from Overview'); } finally { ch.w.close(); }
  } finally { p.w.close(); }
  const src = read('thread-owned.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  assert.ok(!/api\.(message|act|answerInput|copyLink|openInTasks|goToTerminal|shared)/.test(src), 'no write path');
  assert.doesNotMatch(src, /\bMac\b|\bmacOS\b|\bWindows\b/);
});

test('renderer: the tombstone says why, and keeps nothing', async () => {
  for (const [reason, text] of [['overview', 'This session ended when Overview reloaded.'], ['ended', 'This session has ended.']]) {
    const p = page([{ gone: true, reason }]);
    try {
      p.start(); await tick(10);
      assert.equal(p.$('th-empty-title').textContent, text);
      assert.equal(p.$('th-empty-text').textContent, 'Nothing from it is kept here.');
      assert.ok(p.$('th-owned').hidden);
    } finally { p.w.close(); }
  }
});

// The sidebar's tombstones are in test/sidebar-chat.test.js (its boot harness).
