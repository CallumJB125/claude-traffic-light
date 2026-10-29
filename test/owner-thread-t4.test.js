'use strict';
// T4 (plan-t4 Rev 3 + Rev 4): owner controls in my own thread. A real interaction-main and hub (in-memory providers),
// the real overview-service and thread-main, a stand-in remote host, and the renderer in JSDOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { createInteractionMain, CHANNELS: IX } = require('../src/interaction-main');
const { createOverviewService } = require('../src/overview-service');
const { createOwnedRows } = require('../src/owned-rows');
const { createThreadMain, CHANNELS } = require('../src/thread-main');
const Owner = require('../src/thread-owner-main');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function memAdapter(label, target) {
  const ee = new EventEmitter();
  return {
    label, capabilities: { newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false },
    open: async () => ({ target: target() }), send: async () => ({ turnId: 'turn-1', mode: 'new-turn' }),
    interrupt: async () => true, release: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}

// The remote host's owner surface, as remote-interaction.js returns it.
function fakeHost() {
  const shares = new Map(), proposals = [], calls = [];
  let connected = true, n = 0;
  const h = {
    calls, shares, proposals, setConnected: (v) => { connected = v; },
    connected: () => connected,
    viewers: new Map(), // L32: share id → names the hub's owner list carries
    shared: () => [...shares.values()].map((s) => ({ ...s, viewers: [...(h.viewers.get(s.id) ?? [])] })),
    async listShares() { calls.push(['list']); return { ok: true, teams: [{ id: 'team-1', name: 'Design team' }, { id: 'team-2', name: 'Ops' }], shares: h.shared() }; },
    async shareSession(req) {
      calls.push(['share', req]);
      for (const [id, s] of shares) if (s.session === req.session && s.team.id === req.team) shares.delete(id);
      const s = { id: `share-${++n}`, session: req.session, team: { id: req.team, name: req.team === 'team-1' ? 'Design team' : 'Ops' }, scope: req.scope, expiresAt: req.expiresInS === null ? null : Date.now() + req.expiresInS * 1000, members: [{ id: 'u-alex', name: 'Alex', canSend: req.scope === 'interact' }, { id: 'u-vic', name: 'Vic', canSend: false }] };
      shares.set(s.id, s);
      return { ok: true, share: { ...s } };
    },
    stopSharing(id) { calls.push(['stop', id]); if (!shares.delete(id)) return { ok: false, status: 'stale', error: 'That share has already stopped.' }; return { ok: true }; },
    async proposalList(share, fresh = () => true) {
      calls.push(['plist', share]);
      if (!fresh()) return { ok: false, status: 'gone' };
      return { ok: true, proposals: proposals.filter((p) => p.share === share).map((p) => ({ ...p, requester: { ...p.requester } })) };
    },
    async proposalApprove(req, fresh = () => true) {
      calls.push(['approve', req]);
      const p = proposals.find((x) => x.id === req.id);
      if (!fresh() || !p || p.status !== 'pending' || p.digest !== req.digest || p.version !== req.version) return { ok: false, status: 'gone', error: 'This proposal changed.' };
      p.status = 'approved'; p.expiresAt = new Date(Date.now() + 600000).toISOString();
      return { ok: true, proposal: { ...p } };
    },
    async proposalRevoke(req, fresh = () => true) {
      calls.push(['revoke', req]);
      const p = proposals.find((x) => x.id === req.id && x.share === req.share);
      if (!fresh() || !p) return { ok: false, status: 'unavailable', error: 'Revoked on this computer.' };
      p.status = 'revoked';
      return { ok: true, proposal: { ...p } };
    },
    propose(share, { requester = { id: 'u-alex', name: 'Alex' }, text = 'Run the tests', version = 1, at = Date.now() } = {}) {
      const p = { id: crypto.randomUUID(), share, requester, title: 'Proposal', text, digest: crypto.createHash('sha256').update(`${text}${Math.random()}`).digest('hex'), version, generation: 1, status: 'pending', createdAt: new Date(at).toISOString(), expiresAt: null };
      proposals.push(p);
      return p;
    },
  };
  return h;
}

function rig({ codexTargets = null } = {}) {
  let scope = 'acct-a', doc = 1, n = 0, time = Date.now(), visible = true, minimized = false, foreground = true, generation = 1, boundId = null, ovShown = true;
  const ovWc = { id: 1, mainFrame: {}, isDestroyed: () => false, send() {} };
  // buddy-window's overviewReadContext is null unless Overview is the page shown in a visible, unminimised window.
  const ovCtx = () => (ovShown ? { contents: ovWc, document: doc, generation: 1, foreground: true } : null);
  const host = fakeHost();
  const x = createInteractionMain({
    owned: null, localModels: null, context: ovCtx, readContext: ovCtx, currentBoard: () => 'local', accountScope: () => scope, shares: () => host,
    workspace: (id) => `/private/tmp/proj-${id.slice(-4)}`,
    adapters: { codex: memAdapter('Codex', codexTargets ?? (() => `native-${++n}`)), claude: memAdapter('Claude Code', () => `claude-${++n}`) },
    now: () => time,
  });
  const ix = new Map();
  x.register({ handle: (ch, fn) => ix.set(ch, fn) });
  const ovEv = { sender: ovWc, senderFrame: ovWc.mainFrame };
  let reaps = 0;
  const reap = x.hub.reap;
  x.hub.reap = (...a) => { reaps++; return reap(...a); };
  const raw = [];
  const ownedThreads = { view: () => x.ownedView(), state: (e, a, s) => x.ownedState(e, a, s), epoch: () => x.ownedEpoch(), account: () => x.ownedAccount(), twin: (q) => x.ownedTwin(q) };
  const svc = createOverviewService({ sessions: () => raw, ownedThreads, now: () => time });
  // The thread document: one window, one bound row.
  const contents = { id: 7, isDestroyed: () => false, mainFrame: {}, send() {} };
  const win = { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => minimized };
  const buddy = { threadContext: () => (boundId ? { window: win, contents, frame: contents.mainFrame, generation, boundId, foreground, account: 'a', workspace: 'w' } : null) };
  const automatic = new Set();
  const tm = createThreadMain({ buddy: () => buddy, chatPreview: true, target: (id) => svc.threadTarget(id), now: () => time,
    tasks: () => ({ act: async () => ({ ok: true }), openTask: async () => ({ ok: false }), closeTask: async () => {} }),
    activity: async () => null, openInTasks: async () => true, goToTerminal: async () => ({ ok: true }), ownedRead: (id) => svc.ownedThreadRead(id),
    owner: { target: (id) => svc.ownerTarget(id), host: () => host, account: () => x.ownedAccount(), automatic: (id) => automatic.has(id) },
    ownerTimers: { setInterval: () => 1, clearInterval() {} } });
  const handlers = {};
  tm.register({ handle: (ch, fn) => { handlers[ch] = fn; } });
  const ev = { sender: contents, senderFrame: contents.mainFrame };
  return {
    x, svc, raw, host, tm, handlers, automatic, reaps: () => reaps,
    ix: (ch, req) => ix.get(ch)(ovEv, req),
    launch: async (provider) => (await ix.get(IX.launch)(ovEv, { provider })).state,
    reload: async () => { doc++; await ix.get(IX.list)(ovEv); },
    setScope: (v) => { scope = v; },
    rows: async () => svc.passiveRows(() => true),
    bind: (id) => { boundId = id; },
    overviewShown: (v) => { ovShown = v; },
    set: (o) => { if ('visible' in o) visible = o.visible; if ('minimized' in o) minimized = o.minimized; if ('foreground' in o) foreground = o.foreground; if ('generation' in o) generation = o.generation; },
    advance: (ms) => { time += ms; },
    call: (ch, ...a) => handlers[ch](ev, boundId, ...a),
    close: () => { tm.stop(); x.close(); },
  };
}
// The bound owned row of one launched session.
async function ownedRow(r, provider = 'claude') {
  const s = await r.launch(provider);
  const out = await r.rows();
  const row = out.rows.find((x) => r.svc.threadTarget(x.id)?.kind === 'owned');
  r.bind(row.id);
  return { s, id: row.id };
}
const plist = (r) => r.host.calls.filter(([k]) => k === 'plist').length;
async function review(r, req) { const out = await r.call('thread:owner-review', req); r.advance(Owner.ARM_MS); return out; }

// ── Guard T and kinds ───────────────────────────────────────────────────
test('the four owner channels: Guard T, only an owned or session row, effects need focus', async () => {
  const r = rig();
  try {
    await ownedRow(r);
    for (const c of ['thread:owner-state', 'thread:owner-review', 'thread:owner-confirm', 'thread:owner-act']) assert.ok(CHANNELS.includes(c), c);
    assert.equal(CHANNELS.length, 24); // + L32's thread:shared-painted, T5b's two
    assert.equal(await r.handlers['thread:owner-state']({ sender: {}, senderFrame: {} }, 'a'.repeat(64)), null, 'another sender');
    assert.equal(await r.handlers['thread:owner-state']({ sender: { id: 7 }, senderFrame: {} }, 'b'.repeat(64)), null);
    const st = await r.call('thread:owner-state');
    assert.equal(st.shareable, true);
    r.set({ foreground: false });
    assert.equal(await r.call('thread:owner-review', { op: 'share', team: 'f'.repeat(32), scope: 'watch', expiry: '' }), null, 'an effect needs the focused window');
    assert.equal(await r.call('thread:owner-act', { op: 'stop', key: 'f'.repeat(32) }), null);
    r.set({ foreground: true });
  } finally { r.close(); }
});

// T4c-2: a task (chat) row now reaches the owner channels (ownerTarget decides); a shared row never does.
test('a shared row gets null from every owner channel (the kind check)', async () => {
  for (const kind of ['shared']) {
    let asked = 0;
    const contents = { id: 3, isDestroyed: () => false, mainFrame: {} };
    const ctx = { window: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false }, contents, frame: contents.mainFrame, generation: 1, boundId: 'c'.repeat(64), foreground: true, account: 'a', workspace: 'w' };
    const tm = createThreadMain({ buddy: () => ({ threadContext: () => ctx }), chatPreview: true, target: () => ({ kind, taskId: 't' }), tasks: () => null, activity: async () => null,
      openInTasks: async () => true, goToTerminal: async () => ({}), owner: { target: () => { asked++; return { session: '10000000-0000-4000-8000-000000000001', provider: 'Codex' }; }, host: () => fakeHost(), account: () => 'a' },
      ownerTimers: { setInterval: () => 1, clearInterval() {} } });
    const h = {}; tm.register({ handle: (ch, fn) => { h[ch] = fn; } });
    const ev = { sender: contents, senderFrame: contents.mainFrame };
    assert.equal(await h['thread:owner-state'](ev, ctx.boundId), null, kind);
    assert.equal(await h['thread:owner-review'](ev, ctx.boundId, { op: 'share', team: 'f'.repeat(32), scope: 'watch', expiry: '' }), null, kind);
    assert.equal(await h['thread:owner-confirm'](ev, ctx.boundId, { selection: crypto.randomUUID() }), null, kind);
    assert.equal(await h['thread:owner-act'](ev, ctx.boundId, { op: 'stop', key: 'f'.repeat(32) }), null, kind);
    assert.equal(asked, 0, `${kind}: the owned session was never resolved`);
    tm.stop();
  }
});

// ── ownedTwin and the session row ───────────────────────────────────────
test('ownedTwin is read-only and only maps one listed owned Codex session', async () => {
  const r = rig();
  try {
    const cdx = await r.launch('codex'), cl = await r.launch('claude');
    const native = r.x.hub.targetOf(cdx.session), before = { reaps: r.reaps(), docs: r.x.documents(), epoch: r.x.ownedEpoch() };
    assert.equal(r.x.ownedTwin({ provider: 'codex', nativeSessionId: native }).session, cdx.session);
    assert.deepEqual({ reaps: r.reaps(), docs: r.x.documents(), epoch: r.x.ownedEpoch() }, before, 'no reap, no document change');
    assert.equal(r.x.ownedTwin({ provider: 'claude', nativeSessionId: r.x.hub.targetOf(cl.session) }), null, 'only codex maps');
    assert.equal(r.x.ownedTwin({ provider: 'codex', nativeSessionId: 'nope' }), null);
    r.setScope('acct-b');
    assert.equal(r.x.ownedTwin({ provider: 'codex', nativeSessionId: native }), null, "another account's session");
  } finally { r.close(); }
  // Two owned sessions on one native target: ambiguous, so none.
  const same = rig({ codexTargets: () => 'native-same' });
  try {
    await same.launch('codex'); await same.launch('codex');
    assert.equal(same.x.ownedTwin({ provider: 'codex', nativeSessionId: 'native-same' }), null, 'ambiguous');
  } finally { same.close(); }
  // The target gone (replaceTarget whose reopen failed): none.
  let t = 'native-x';
  const gone = rig({ codexTargets: () => t });
  try {
    const s = await gone.launch('codex');
    t = null;
    await gone.x.hub.replaceTarget(s.session);
    assert.equal(gone.x.ownedTwin({ provider: 'codex', nativeSessionId: 'native-x' }), null);
  } finally { gone.close(); }
});

test('a Codex session row its owned session folded into carries the controls; an unfolded one does not', async () => {
  const r = rig();
  try {
    const cdx = await r.launch('codex');
    const native = r.x.hub.targetOf(cdx.session);
    r.raw.push({ sessionId: native, source: 'codex', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: '/private/tmp/checkout' });
    const out = await r.rows();
    const row = out.rows.find((x) => r.svc.threadTarget(x.id)?.kind === 'session');
    assert.ok(row, 'the folded reported row');
    assert.equal(r.svc.ownerTarget(row.id).session, cdx.session);
    // Another observed Codex session with no owned twin: no controls.
    r.raw.push({ sessionId: 'native-other', source: 'codex', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: '/private/tmp/o' });
    const out2 = await r.rows();
    const other = out2.rows.find((x) => x.id !== row.id && r.svc.threadTarget(x.id)?.kind === 'session');
    assert.equal(r.svc.ownerTarget(other.id), null);
  } finally { r.close(); }
});

// ── share, review, confirm ──────────────────────────────────────────────
test('share: review then confirm, watch by default in the sheet, armed 600 ms in main, one use; no reap', async () => {
  const r = rig();
  try {
    const { s } = await ownedRow(r);
    const before = { reaps: r.reaps(), docs: r.x.documents() };
    const st = await r.call('thread:owner-state');
    assert.deepEqual(st.teams.map((t) => t.name), ['Design team', 'Ops']);
    assert.ok(!JSON.stringify(st).includes('team-1') && !JSON.stringify(st).includes(s.session), 'no raw ids');
    const rv = await r.call('thread:owner-review', { op: 'share', team: st.teams[0].key, scope: 'watch', expiry: '3600' });
    assert.equal(rv.card.title, 'Share this session with Design team');
    assert.equal(rv.card.confirm, 'Share');
    assert.deepEqual((await r.call('thread:owner-confirm', { selection: rv.selection })).status, 'not-ready', 'inside 600 ms');
    r.advance(600);
    const ok = await r.call('thread:owner-confirm', { selection: rv.selection });
    assert.equal(ok.ok, true);
    const share = r.host.calls.find(([k]) => k === 'share')[1];
    assert.deepEqual(share, { session: s.session, team: 'team-1', scope: 'watch', expiresInS: 3600 });
    assert.equal((await r.call('thread:owner-confirm', { selection: rv.selection })).status, 'stale', 'one use');
    r.advance(600);
    assert.equal((await r.call('thread:owner-review', { op: 'share', team: 'f'.repeat(32), scope: 'watch', expiry: '3600' })).status, 'stale', 'an unknown team key');
    r.advance(600);
    assert.equal((await r.call('thread:owner-review', { op: 'share', team: st.teams[0].key, scope: 'admin', expiry: '3600' })).status, 'invalid');
    r.advance(600);
    assert.equal((await r.call('thread:owner-review', { op: 'share', team: st.teams[0].key, scope: 'watch', expiry: '99' })).status, 'invalid', "only Overview's expiry choices");
    assert.deepEqual({ reaps: r.reaps(), docs: r.x.documents() }, before, 'the Overview actor is untouched');
  } finally { r.close(); }
});

test('the Overview document replaced between review and confirm: stale, nothing sent', async () => {
  const r = rig();
  try {
    await ownedRow(r);
    const st = await r.call('thread:owner-state');
    const rv = await review(r, { op: 'share', team: st.teams[0].key, scope: 'watch', expiry: '' });
    await r.reload();
    assert.equal((await r.call('thread:owner-confirm', { selection: rv.selection })).status, 'stale');
    assert.ok(!r.host.calls.some(([k]) => k === 'share'), 'nothing sent');
  } finally { r.close(); }
});

test('Allow sending: the time left comes from the host record at confirm; under 60 s refused; one interact share', async () => {
  const r = rig();
  try {
    const { s } = await ownedRow(r);
    await r.host.shareSession({ session: s.session, team: 'team-1', scope: 'watch', expiresInS: 3600 });
    r.advance(5000);
    const st = await r.call('thread:owner-state');
    assert.equal(st.shares.length, 1);
    assert.equal(st.shares[0].scope, 'watch');
    const rv = await review(r, { op: 'allow-sending', share: st.shares[0].key });
    assert.equal(rv.card.title, 'Allow Design team to send');
    assert.ok(rv.card.notes[0].includes('Claude Code account and quota'), rv.card.notes[0]);
    const out = await r.call('thread:owner-confirm', { selection: rv.selection });
    assert.equal(out.ok, true);
    const up = r.host.calls.filter(([k]) => k === 'share').at(-1)[1];
    assert.equal(up.scope, 'interact');
    assert.ok(up.expiresInS >= 3590 && up.expiresInS <= 3600, String(up.expiresInS));
    assert.equal(r.host.shares.size, 1, 'it replaced the watch share');
    // About to end: refused, at review.
    await r.host.shareSession({ session: s.session, team: 'team-2', scope: 'watch', expiresInS: 3600 });
    for (const sh of r.host.shares.values()) if (sh.team.id === 'team-2') sh.expiresAt = Date.now() + 6000 + 30_000;
    r.advance(6000);
    const st2 = await r.call('thread:owner-state');
    const soon = st2.shares.find((x) => x.team === 'Ops');
    const no = await r.call('thread:owner-review', { op: 'allow-sending', share: soon.key });
    assert.deepEqual([no.status, no.error], ['refused', Owner.TEXT.SOON]);
  } finally { r.close(); }
});

// ── one click: stop, with the fresh-list session check ──────────────────
test('Stop sharing: one click, re-resolved on a fresh list; a share that moved to another session is stale', async () => {
  const r = rig();
  try {
    const { s } = await ownedRow(r);
    await r.host.shareSession({ session: s.session, team: 'team-1', scope: 'watch', expiresInS: null });
    const st = await r.call('thread:owner-state');
    // The host's record now names another session: the key must not stop it.
    const sh = [...r.host.shares.values()][0];
    sh.session = '10000000-0000-4000-8000-00000000000f';
    r.advance(600);
    assert.equal((await r.call('thread:owner-act', { op: 'stop', key: st.shares[0].key })).status, 'stale');
    assert.ok(!r.host.calls.some(([k]) => k === 'stop'));
    sh.session = s.session;
    r.advance(600);
    const out = await r.call('thread:owner-act', { op: 'stop', key: st.shares[0].key });
    assert.deepEqual([out.ok, out.note], [true, Owner.TEXT.STOPPED]);
    r.advance(600);
    assert.equal((await r.call('thread:owner-act', { op: 'stop', key: st.shares[0].key })).status, 'stale', 'already stopped');
  } finally { r.close(); }
});

// ── the poller ──────────────────────────────────────────────────────────
async function interactRow(r) {
  const o = await ownedRow(r);
  await r.host.shareSession({ session: o.s.session, team: 'team-1', scope: 'interact', expiresInS: null });
  return { ...o, share: [...r.host.shares.values()][0] };
}
test('poll: only while the bound thread is visible (main checks); a show/hide burst in 15 s makes 1 call; hide drops the cache', async () => {
  const r = rig();
  try {
    const { share } = await interactRow(r);
    r.host.propose(share.id);
    r.set({ visible: false });
    await r.call('thread:owner-state'); await r.tm.ownerTick(); await tick();
    assert.equal(plist(r), 0, 'a read from a hidden window polls nothing');
    r.set({ visible: true });
    r.advance(6000);
    const a = await r.call('thread:owner-state'); await tick();
    assert.equal(plist(r), 1, 'once at show');
    r.advance(6000);
    const b = await r.call('thread:owner-state');
    assert.equal(b.groups.length, 1, 'the proposal from the cache');
    assert.ok(a);
    for (let i = 0; i < 4; i++) { r.set({ visible: i % 2 === 1 }); r.advance(500); await r.tm.ownerTick(); await r.call('thread:owner-state'); await tick(); }
    assert.equal(plist(r), 1, 'still one inside 15 s');
    r.set({ minimized: true }); r.advance(16000); await r.tm.ownerTick(); await tick();
    assert.equal(plist(r), 1, 'minimised: nothing');
    assert.equal(r.tm.ownerSize().polls, 0, 'and nothing is kept');
  } finally { r.close(); }
});

test('poll: every 15 s while shown; watch shares never; the cache empties on hide; one call per share across documents', async () => {
  const r = rig();
  try {
    const { s, share } = await interactRow(r);
    await r.host.shareSession({ session: s.session, team: 'team-2', scope: 'watch', expiresInS: null });
    const watch = [...r.host.shares.values()].find((x) => x.scope === 'watch');
    await r.call('thread:owner-state'); await tick();
    r.advance(15000); await r.tm.ownerTick(); await tick();
    const shares = r.host.calls.filter(([k]) => k === 'plist').map(([, id]) => id);
    assert.deepEqual(shares, [share.id, share.id]);
    assert.ok(!shares.includes(watch.id), 'watch shares are never polled');
    assert.ok(r.tm.ownerSize().polls >= 1);
    // A new document (reload) on the same share, inside the floor: no extra call.
    r.set({ generation: 2 }); r.advance(1000);
    await r.call('thread:owner-state'); await tick();
    assert.equal(plist(r), 2);
    // Hidden: main's next pass drops the cache (no new retention).
    r.set({ visible: false }); await r.tm.ownerTick();
    assert.equal(r.tm.ownerSize().polls, 0);
  } finally { r.close(); }
});

test('poll: a renderer read on a hidden window does not keep it running; the lease ends without reads', async () => {
  const r = rig();
  try {
    const { share } = await interactRow(r);
    r.host.propose(share.id);
    await r.call('thread:owner-state'); await tick();
    assert.equal(plist(r), 1);
    r.set({ visible: false });
    for (let i = 0; i < 3; i++) { r.advance(16000); await r.call('thread:owner-state'); await r.tm.ownerTick(); await tick(); }
    assert.equal(plist(r), 1, 'main sees the hidden window; the page cannot say otherwise');
    r.set({ visible: true });
    r.advance(Owner.LEASE_MS + 1000); await r.tm.ownerTick(); await tick();
    assert.equal(plist(r), 1, 'no reads for longer than the lease: the poll stopped');
  } finally { r.close(); }
});

// ── approve (Rev 3) and the grouped cards (Rev 4) ───────────────────────
test('approve: only via review → confirm; bound to the proposal shown; a changed proposal is stale; 10 minutes', async () => {
  const r = rig();
  try {
    const { share } = await interactRow(r);
    const p = r.host.propose(share.id, { text: 'Run the tests' });
    await r.call('thread:owner-state'); await tick(); r.advance(6000);
    const st = await r.call('thread:owner-state');
    const g = st.groups[0];
    assert.deepEqual([g.requester, g.latest.text, g.latest.version], ['Alex', 'Run the tests', 1]);
    const rv = await review(r, { op: 'approve', proposal: g.latest.key });
    assert.equal(rv.card.title, 'Alex proposes a message');
    assert.equal(rv.card.confirm, 'Approve one send · 10 min');
    // The proposal changed after review (same id, new digest): stale, no approve.
    const real = p.digest; p.digest = 'e'.repeat(64);
    assert.equal((await r.call('thread:owner-confirm', { selection: rv.selection })).status, 'stale');
    assert.ok(!r.host.calls.some(([k]) => k === 'approve'));
    p.digest = real; r.advance(6000);
    const st2 = await r.call('thread:owner-state');
    const rv2 = await review(r, { op: 'approve', proposal: st2.groups[0].latest.key });
    const ok = await r.call('thread:owner-confirm', { selection: rv2.selection });
    assert.equal(ok.ok, true);
    const req = r.host.calls.find(([k]) => k === 'approve')[1];
    assert.deepEqual(req, { share: share.id, id: p.id, version: 1, digest: real, expiresInS: 600 });
    // A key from before a newer version: never the newer one (R4-S2).
    const p2 = r.host.propose(share.id, { text: 'Run them again', version: 2 });
    assert.equal((await r.call('thread:owner-review', { op: 'approve', proposal: st2.groups[0].latest.key })).status, 'stale', 'the shown one was approved; the newer one needs its own card');
    assert.ok(p2);
  } finally { r.close(); }
});

test('Rev 4: one card per teammate; Reject all revokes only what was rendered, still the same; a later one is untouched', async () => {
  const r = rig();
  try {
    const { share } = await interactRow(r);
    const t = Date.now();
    const old1 = r.host.propose(share.id, { text: 'first', at: t - 3000 });
    const old2 = r.host.propose(share.id, { text: 'second', at: t - 2000 });
    const latest = r.host.propose(share.id, { text: 'third', at: t - 1000 });
    r.host.propose(share.id, { text: 'from Sam', requester: { id: 'u-sam', name: 'Sam' } });
    await r.call('thread:owner-state'); await tick(); r.advance(6000);
    const st = await r.call('thread:owner-state');
    assert.equal(st.groups.length, 2, 'two teammates, two cards');
    const alex = st.groups.find((g) => g.requester === 'Alex');
    assert.equal(alex.latest.text, 'third');
    assert.deepEqual(alex.earlier.map((x) => x.text), ['second', 'first']);
    assert.match(alex.rejectAll, /^[0-9a-f]{32}$/);
    assert.equal(st.groups.find((g) => g.requester === 'Sam').rejectAll, null, 'one proposal: no Reject all');
    // After the render: one of Alex's changed version, and a new one arrived.
    old2.version = 2;
    const late = r.host.propose(share.id, { text: 'arrived later' });
    r.advance(600);
    const out = await r.call('thread:owner-act', { op: 'reject-all', key: alex.rejectAll });
    assert.equal(out.ok, true);
    const revoked = r.host.calls.filter(([k]) => k === 'revoke').map(([, q]) => q.id).sort();
    assert.deepEqual(revoked, [old1.id, latest.id].sort(), 'the carded one is in the snapshot: the button says "Reject all 3 from Alex"');
    assert.equal(late.status, 'pending', 'never one that arrived after the render');
    assert.equal(old2.status, 'pending', 'a changed one reports stale');
    assert.match(out.note, /^2 rejected\. 1 had already changed/);
    r.advance(600);
    assert.equal((await r.call('thread:owner-act', { op: 'reject-all', key: alex.rejectAll })).status, 'stale', 'one use');
  } finally { r.close(); }
});

test('Rev 4: earlier is capped at 20, then +N more', async () => {
  const r = rig();
  try {
    const { share } = await interactRow(r);
    for (let i = 0; i < 24; i++) r.host.propose(share.id, { text: `p${i}`, at: Date.now() - 100000 + i });
    await r.call('thread:owner-state'); await tick(); r.advance(6000);
    const g = (await r.call('thread:owner-state')).groups[0];
    assert.deepEqual([g.earlier.length, g.more], [Owner.EARLIER_MAX, 3]);
  } finally { r.close(); }
});

// ── keys, account switch, Overview's approve ────────────────────────────
test('no raw share, team, proposal or session id in any owner payload', async () => {
  const r = rig();
  try {
    const { s, share } = await interactRow(r);
    const p = r.host.propose(share.id);
    await r.call('thread:owner-state'); await tick(); r.advance(6000);
    const json = JSON.stringify(await r.call('thread:owner-state'));
    for (const id of [s.session, share.id, p.id, 'team-1', 'u-alex', p.digest]) assert.ok(!json.includes(id), id);
  } finally { r.close(); }
});

test('the T4a nit: an account switch with an owned thread open leaves silently, not "ended", and no tombstone', async () => {
  const r = rig();
  try {
    const { id } = await ownedRow(r);
    assert.ok(!r.svc.ownedThreadRead(id).gone);
    r.setScope('acct-b');
    assert.deepEqual(r.svc.ownedThreadRead(id), { gone: true, reason: 'account' });
    const out = await r.rows();
    assert.deepEqual(out.ended, [], 'no tombstone');
    assert.deepEqual(r.svc.ownedThreadRead(id), { gone: true, reason: 'account' }, 'still says why');
    // And through thread-main, which passes 'account' on.
    assert.deepEqual(await r.call('thread:owned-state'), { gone: true, reason: 'account' });
  } finally { r.close(); }
  // Unit: a pass after an account switch tombstones nothing either.
  const secret = crypto.randomBytes(8), stable = (p) => crypto.createHmac('sha256', secret).update(JSON.stringify(p)).digest('hex');
  const rows = createOwnedRows({ stable });
  const view = (account, sessions) => ({ epoch: 1, account, sessions });
  const o = { actor: 'a', session: 's-1', state: { session: 's-1', provider: { id: 'claude' }, status: 'ready', deliveries: [] }, leaf: null, nativeSessionId: null };
  const id = rows.pass(view('x', [o]), new Map()).rows[0].dto.id;
  assert.deepEqual(rows.pass(view('y', []), new Map()).ended, []);
  assert.deepEqual(rows.read(id, { state: () => null, currentEpoch: () => 1 }), { gone: true, reason: 'account' });
});

test("Q5: with the gate on, Overview's one-click approve is refused before actorOf, and its list says so; off, unchanged", async () => {
  for (const gated of [false, true]) {
    const r = rig();
    try {
      const { share } = await interactRow(r);
      const p = r.host.propose(share.id);
      if (gated) r.x.approveInThread();
      const reaps = r.reaps();
      const out = await r.ix(IX.proposalApprove, { share: share.id, id: p.id, version: 1, digest: p.digest, expiresInS: 600 });
      const list = await r.ix(IX.proposalList, { share: share.id });
      if (gated) {
        assert.deepEqual([out.ok, out.status], [false, 'forbidden']);
        assert.match(out.error, /thread in the sidebar/);
        assert.equal(r.reaps(), reaps, 'no actorOf, no reap');
        assert.ok(!r.host.calls.some(([k]) => k === 'approve'));
        assert.equal(list.approve, false);
        // Reject and revoke stay in Overview.
        const rj = await r.ix(IX.proposalRevoke, { share: share.id, id: p.id });
        assert.equal(rj.ok, true);
      } else {
        assert.equal(out.ok, true);
        assert.equal(Object.hasOwn(list, 'approve'), false, 'gate off: the reply is unchanged');
      }
    } finally { r.close(); }
  }
  const main = read('main.js');
  assert.match(main, /ThreadMain\.register\(ipcMain\);\n  \/\/ T4 \(Q5\)[^\n]*\n  InteractionMain\.approveInThread\(\);/, 'set inside the chat-first gate block');
  assert.equal((main.match(/CHAT_PREVIEW/g) || []).length, 15);
});

test('no other approve path: only thread-owner-main and Overview call proposalApprove', () => {
  const files = require('node:child_process').execFileSync('git', ['ls-files', '*.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).split('\n').filter((f) => f && !f.startsWith('test') && !f.startsWith('board/') && !f.startsWith('site/'));
  const callers = files.filter((f) => /proposalApprove\s*\(/.test(read(f)));
  assert.deepEqual(callers.sort(), ['overview-share.js', 'src/remote-interaction.js', 'src/thread-owner-main.js'].sort());
});

// ── the renderer ────────────────────────────────────────────────────────
const html = read('thread.html').replace(/<script[^]*?<\/script>/g, '');
const ID = 'a'.repeat(64);
function page(owner, { calls = [] } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let ready = null;
  const VIEW = { header: { title: 'Fix the login', provider: 'Codex', channel: false }, activity: { category: null, ageMs: 0, stale: false }, status: 'ready', deliveries: [] };
  w.threadApi = { open: async () => ({ kind: 'owned', header: null }), state: async () => ({ kind: 'owned', header: null }), close: async () => true, ownedState: async () => VIEW, openOverview: async () => true,
    ownerState: async () => owner, ownerReview: async (_r, req) => { calls.push(['review', req]); return { ok: true, status: 'review', selection: crypto.randomUUID(), card: { op: req.op, title: 'Share this session with Design team', text: '', notes: ['n1'], confirm: 'Share', armMs: 600, scope: 'Watch only' } }; },
    ownerConfirm: async () => { calls.push(['confirm']); return { ok: true, note: 'Shared.' }; }, ownerAct: async (_r, op, key) => { calls.push(['act', op, key]); return { ok: true, note: 'Done.' }; },
    onReady: (cb) => { ready = cb; }, onEvent: () => {}, onInputsChanged: () => {}, board: () => {} };
  for (const f of ['brand.js', 'src/tasks-view.js', 'src/transcript-md.js', 'src/transcript-dom.js', 'thread-shared.js', 'thread-owned.js', 'thread-owner.js', 'thread.js']) w.eval(read(f));
  return { w, $: (id) => w.document.getElementById(id), calls, start: async () => { ready(ID); await tick(12); } };
}
const KEY = (c) => c.repeat(32);
const OWNER = { shareable: true, available: true, provider: 'Codex', reason: '', teams: [{ key: KEY('1'), name: 'Design team' }, { key: KEY('2'), name: '<b>Ops</b>' }],
  shares: [{ key: KEY('3'), team: 'Design team', scope: 'watch', expiresAt: null, automatic: false, members: 3 }, { key: KEY('4'), team: 'Ops', scope: 'interact', expiresAt: null, automatic: true, members: 1 }],
  groups: [{ requester: 'Alex', latest: { key: KEY('5'), text: '<i>run it</i>', version: 3, status: 'awaiting' }, earlier: [{ key: KEY('6'), text: 'older', version: 1 }], more: 0, rejectAll: KEY('7') }],
  others: [{ key: KEY('8'), requester: 'Sam', status: 'approved', expiresAt: null }] };

test('renderer: share line (manual, automatic), ⋯ Share with team…, sheet defaults to Watch only, textContent only', async () => {
  const p = page(OWNER);
  try {
    await p.start();
    const lines = [...p.$('th-owner-line').querySelectorAll('.th-own-share-text')].map((n) => n.textContent);
    assert.deepEqual(lines, ['Shared with Design team · Watch only · until you stop it · 3 members', 'Shared automatically with Ops (team workspace) · Watch and send']);
    assert.equal(p.$('th-more').hidden, false, "my owned thread's ⋯ shows with Share with team…");
    assert.equal(p.$('th-share').hidden, false);
    p.$('th-share').click(); await tick();
    assert.equal(p.$('th-own-scope').value, 'watch');
    assert.deepEqual([...p.$('th-own-expiry').options].map((o) => o.textContent), ['For 1 hour', 'For 8 hours', 'For 1 day', 'For 7 days', 'Until you stop it']);
    assert.equal(p.$('th-own-team').options[1].textContent, '<b>Ops</b>');
    p.$('th-own-continue').click(); await tick();
    assert.equal(JSON.stringify(p.calls[0]), JSON.stringify(['review', { op: 'share', team: KEY('1'), scope: 'watch', expiry: '3600' }]));
    assert.equal(p.$('th-own-yes').disabled, true, 'armed');
  } finally { p.w.close(); }
  const src = read('thread-owner.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  assert.doesNotMatch(src, /\bMac\b|\bmacOS\b|\bWindows\b/);
});

test('renderer: one card per teammate with earlier folded, Reject all, approved line with Revoke; several teams → +N more', async () => {
  const p = page(OWNER);
  try {
    await p.start();
    const card = p.$('th-own-proposals').querySelector('.th-own-proposal');
    assert.equal(card.querySelector('.th-card-title').textContent, 'Alex proposes a message');
    assert.equal(card.querySelector('.th-card-text').textContent, '<i>run it</i>');
    assert.equal(card.querySelector('i'), null);
    assert.equal(card.querySelector('summary').textContent, '1 earlier from Alex');
    const btn = (label) => [...p.$('th-owner').querySelectorAll('button')].find((b) => b.textContent === label);
    // C-S1: it rejects the carded one too, so it says how many and sits with Reject, outside the fold.
    const all = btn('Reject all 2 from Alex');
    assert.ok(all && all.closest('.th-card-btns') && !all.closest('details'));
    all.click(); await tick();
    assert.equal(JSON.stringify(p.calls.at(-1)), JSON.stringify(['act', 'reject-all', KEY('7')]));
    assert.match(p.$('th-own-proposals').textContent, /Sam: approved for one send/);
    btn('Revoke').click(); await tick();
    assert.equal(JSON.stringify(p.calls.at(-1)), JSON.stringify(['act', 'revoke', KEY('8')]));
  } finally { p.w.close(); }
  const many = page({ ...OWNER, shares: Array.from({ length: 5 }, (_, i) => ({ key: KEY(String(i)), team: `T${i}`, scope: 'watch', expiresAt: null, automatic: false, members: 1 })) });
  try { await many.start(); assert.match(many.$('th-owner-line').textContent, /\+2 more$/); } finally { many.w.close(); }
});

test('renderer: not held → the reason and no Share item; a session thread keeps its ⋯', async () => {
  const p = page({ shareable: false, reason: Owner.TEXT.NOT_HELD });
  try {
    await p.start();
    assert.equal(p.$('th-share').hidden, true);
    assert.equal(p.$('th-owner-line').textContent, Owner.TEXT.NOT_HELD);
  } finally { p.w.close(); }
});

// ── L32: who is watching (plan-l32 App PR delta D3/D4) ──────────────────
const lists = (r) => r.host.calls.filter(([k]) => k === 'list').length;
test('L32 owner thread: the share line names who is watching; the catalog (and so the viewers) is fetched only while main sees it shown', async () => {
  const r = rig();
  try {
    const { s } = await ownedRow(r);
    await r.host.shareSession({ session: s.session, team: 'team-1', scope: 'watch', expiresInS: null });
    const share = [...r.host.shares.values()][0];
    r.host.viewers.set(share.id, ['Alice', 'Sam']);
    const st = await r.call('thread:owner-state');
    assert.deepEqual(st.shares[0].viewers, ['Alice', 'Sam']);
    assert.ok(!JSON.stringify(st).includes(share.id));
    assert.equal(lists(r), 1);
    // Hidden: reads go on (the page polls) but never fetch; the floor alone would have allowed one by now.
    r.set({ visible: false });
    for (let i = 0; i < 3; i++) { r.advance(16_000); await r.call('thread:owner-state'); }
    assert.equal(lists(r), 1, 'no listShares while hidden');
    r.set({ visible: true, minimized: true }); r.advance(16_000); await r.call('thread:owner-state');
    assert.equal(lists(r), 1, 'minimised: none either');
    r.set({ minimized: false }); r.advance(16_000); await r.call('thread:owner-state');
    assert.equal(lists(r), 2, 'shown: one');
    // A-S1: an effect's fresh list is not floored or gated: Stop sharing while hidden still re-lists.
    const key = (await r.call('thread:owner-state')).shares[0].key;
    r.set({ visible: false }); r.advance(600);
    const out = await r.call('thread:owner-act', { op: 'stop', key });
    assert.equal(out.ok, true);
    assert.equal(lists(r), 3, 'the effect listed fresh');
  } finally { r.close(); }
});

test('L32 Overview: interaction:share-viewers only while Overview is shown, one listShares per 15 s, only my sessions, names only', async () => {
  const r = rig();
  try {
    const { s } = await ownedRow(r);
    await r.host.shareSession({ session: s.session, team: 'team-1', scope: 'watch', expiresInS: null });
    const share = [...r.host.shares.values()][0];
    r.host.viewers.set(share.id, ['Alice']);
    // Someone else's share on the same host: never mine to show.
    r.host.shares.set('share-x', { id: 'share-x', session: '10000000-0000-4000-8000-0000000000aa', team: { id: 'team-2', name: 'Ops' }, scope: 'watch', expiresAt: null, members: [] });
    r.host.viewers.set('share-x', ['Mallory']);
    const before = lists(r);
    const out = await r.ix('interaction:share-viewers');
    assert.deepEqual(out, { ok: true, sessions: { [s.session]: ['Alice'] } });
    assert.equal(lists(r), before + 1);
    await r.ix('interaction:share-viewers'); r.advance(10_000); await r.ix('interaction:share-viewers');
    assert.equal(lists(r), before + 1, 'inside 15 s: from the host copy');
    r.advance(6_000); await r.ix('interaction:share-viewers');
    assert.equal(lists(r), before + 2);
    // Overview not the page shown (or the window hidden or minimised): refused before anything is read.
    r.overviewShown(false); r.advance(16_000);
    assert.equal(await r.ix('interaction:share-viewers'), null);
    assert.equal(lists(r), before + 2);
  } finally { r.close(); }
});

test('L32 renderer: the share line says who is watching', async () => {
  const one = page({ ...OWNER, shares: [{ ...OWNER.shares[0], viewers: ['Alice'] }] });
  try { await one.start(); assert.match(one.$('th-owner-line').textContent, /4 members|3 members · Alice is watching/); assert.match(one.$('th-owner-line').textContent, /· Alice is watching/); } finally { one.w.close(); }
  const three = page({ ...OWNER, shares: [{ ...OWNER.shares[0], viewers: ['Alice', '<b>Sam</b>', 'Kim'] }] });
  try { await three.start(); assert.match(three.$('th-owner-line').textContent, /· Alice and 2 others are watching/); assert.equal(three.$('th-owner-line').querySelector('b'), null); } finally { three.w.close(); }
  const none = page(OWNER);
  try { await none.start(); assert.doesNotMatch(none.$('th-owner-line').textContent, /watching/); } finally { none.w.close(); }
});
