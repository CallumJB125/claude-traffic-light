'use strict';
// T4c-2 (outputs/plan-t4c2.md): the owner shares one of this computer's chats from its thread, through the same four
// thread:owner-* channels as a session. A real thread-main, owner actions and chat target; a stand-in remote host.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createThreadMain } = require('../src/thread-main');
const Owner = require('../src/thread-owner-main');
const { createRemoteChatTargets } = require('../src/remote-chat-target');

const PROVIDER = '7b0c3f2e-4a1d-4c55-9e0f-1234567890ab'; // the provider's session id: never sent anywhere
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function rig({ workInPlace = false } = {}) {
  let time = 1_000_000;
  const row = { id: 'tsk_1', sessionId: PROVIDER, state: 'in_review', source: 'local', ai: { id: 'claude' }, permissionLevel: 'auto-edits', workInPlace, lastSeq: 10, repo: { name: 'plexiform' } };
  const watchers = [];
  let unsubscribed = 0, registers = 0;
  const chats = createRemoteChatTargets({
    now: () => time,
    tasks: {
      row: (id) => (id === row.id ? row : null),
      detail: async (id) => (id === row.id ? { sessionId: PROVIDER, workInPlace: row.workInPlace, lastSeq: row.lastSeq } : null),
      watch: async (...a) => { watchers.push(a); return { stop() { unsubscribed++; } }; },
      shareMessage: async () => ({ ok: false, code: 'INTERNAL' }),
    },
  });
  const shares = new Map();
  let n = 0;
  const host = {
    calls: [], failNext: false,
    connected: () => true,
    shared: () => [...shares.values()].map((s) => ({ ...s })),
    async listShares() { return { ok: true, teams: [{ id: 'team-1', name: 'Design team' }], shares: host.shared() }; },
    async shareSession(req) {
      host.calls.push(['share', req]);
      // As remote-interaction createShare: only a target main can resolve is shareable.
      if (!chats.target(req.session)) return { ok: false, status: 'stale', error: 'This session has ended and cannot be shared.' };
      if (host.failNext) { host.failNext = false; return { ok: false, status: 'unavailable', error: 'The hub did not accept the share.' }; }
      const s = { id: `share-${++n}`, session: req.session, team: { id: req.team, name: 'Design team' }, scope: req.scope, expiresAt: null, members: [], allowOk: true };
      shares.set(s.id, s);
      return { ok: true, share: { ...s } };
    },
    stopSharing(id) { host.calls.push(['stop', id]); return shares.delete(id) ? { ok: true } : { ok: false, status: 'stale' }; },
    async proposalList() { return { ok: true, proposals: [] }; },
  };
  const contents = { id: 3, isDestroyed: () => false, mainFrame: {} };
  const ctx = { window: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false }, contents, frame: contents.mainFrame, generation: 1, boundId: 'c'.repeat(64), foreground: true, account: 'a', workspace: 'w' };
  const tm = createThreadMain({
    buddy: () => ({ threadContext: () => ctx }), chatPreview: true, target: () => ({ kind: 'task', taskId: 'tsk_1' }), now: () => time,
    tasks: () => null, activity: async () => null, openInTasks: async () => true, goToTerminal: async () => ({}),
    owner: { target: () => chats.ownerTarget('tsk_1'), register: (id) => { registers++; return chats.register(id); }, release: (s, h) => chats.release(s, h), host: () => host, account: () => 'a' },
    ownerTimers: { setInterval: () => 1, clearInterval() {} },
  });
  const h = {};
  tm.register({ handle: (ch, fn) => { h[ch] = fn; } });
  const ev = { sender: contents, senderFrame: contents.mainFrame };
  const call = (ch, ...a) => h[ch](ev, ctx.boundId, ...a);
  return {
    row, chats, host, shares, watchers, call, tm,
    unsubscribed: () => unsubscribed, registers: () => registers,
    advance: (ms) => { time += ms; },
    state: async () => { time += Owner.STATE_MIN_MS; return call('thread:owner-state'); },
    review: async (req) => { time += 2000; const out = await call('thread:owner-review', req); time += Owner.ARM_MS; return out; },
    confirm: (selection) => call('thread:owner-confirm', { selection }),
  };
}

test('owner-state on a chat row: shareable, and a read never registers or subscribes', async () => {
  const r = rig();
  const st = await r.state();
  assert.equal(st.shareable, true);
  assert.equal(st.chat, true);
  assert.equal(st.sendNote, '');
  assert.equal(st.provider, 'Claude');
  assert.deepEqual(st.shares, []);
  await r.state(); await r.state();
  assert.equal(r.registers(), 0);
  assert.equal(r.watchers.length, 0);
  assert.equal(r.chats.registered().length, 0);
  r.tm.stop();
});

test('the Share card for a chat (plan §4, S2); confirm is the one place that registers, with a fresh id', async () => {
  const r = rig();
  const st = await r.state();
  const team = st.teams[0].key;
  const watch = await r.review({ op: 'share', team, scope: 'watch', expiry: '' });
  assert.equal(watch.card.title, 'Share this chat with Design team');
  assert.deepEqual(watch.card.notes, [Owner.TEXT.CHAT_WATCH, 'Until you stop it']);
  const send = await r.review({ op: 'share', team, scope: 'interact', expiry: '3600' });
  assert.equal(send.card.notes[0], Owner.TEXT.CHAT_WATCH);
  assert.equal(send.card.notes[1], 'They can send messages that this chat runs on this computer, in plexiform, with its current permissions (Edit files), using your Claude account and quota. They can’t approve requests, stop the chat, merge or open a pull request.');
  assert.equal(send.card.notes[2], Owner.TEXT.CHAT_REOPENS);
  assert.ok(!JSON.stringify(send).includes('steer'), 'no steer or stop for a chat');
  assert.equal(r.registers(), 0, 'a review never registers');
  const out = await r.confirm(send.selection);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(r.registers(), 1);
  const [, req] = r.host.calls.find((c) => c[0] === 'share');
  assert.match(req.session, UUID);
  assert.notEqual(req.session, PROVIDER, 'the hub\'s session is never the provider session id');
  assert.ok(!JSON.stringify(r.host.calls).includes(PROVIDER));
  assert.equal(req.scope, 'interact');
  assert.deepEqual(r.chats.registered(), [{ session: req.session, taskId: 'tsk_1' }]);
  assert.equal(r.watchers[0][1], 11, 'from after the chat\'s latest message');
  const after = await r.state();
  assert.equal(after.shares.length, 1);
  assert.ok(!JSON.stringify([after, out, send, watch, st]).includes(PROVIDER), 'owner-state, cards and receipts');
  r.tm.stop();
});

test('C2-S1: a Share the hub refuses leaves nothing registered or subscribed', async () => {
  const r = rig();
  const st = await r.state();
  const card = await r.review({ op: 'share', team: st.teams[0].key, scope: 'watch', expiry: '' });
  r.host.failNext = true;
  const out = await r.confirm(card.selection);
  assert.equal(out.ok, false);
  assert.equal(r.registers(), 1);
  assert.equal(r.chats.registered().length, 0);
  assert.equal(r.unsubscribed(), 1);
  r.tm.stop();
});

test('C2-M1: Stop sharing the chat\'s last share drops its subscription', async () => {
  const r = rig();
  const st = await r.state();
  const card = await r.review({ op: 'share', team: st.teams[0].key, scope: 'watch', expiry: '' });
  assert.equal((await r.confirm(card.selection)).ok, true);
  const shown = await r.state();
  r.advance(2000);
  const out = await r.call('thread:owner-act', { op: 'stop', key: shown.shares[0].key });
  assert.equal(out.ok, true);
  assert.equal(out.note, Owner.TEXT.CHAT_STOPPED);
  assert.equal(r.chats.registered().length, 0);
  assert.equal(r.unsubscribed(), 1);
  r.tm.stop();
});

test('S1: a chat that works in place is offered Watch only; every sending card is refused', async () => {
  const r = rig({ workInPlace: true });
  const st = await r.state();
  assert.equal(st.sendNote, Owner.TEXT.IN_PLACE);
  const team = st.teams[0].key;
  const no = await r.review({ op: 'share', team, scope: 'interact', expiry: '' });
  assert.deepEqual([no.ok, no.status, no.error], [false, 'refused', Owner.TEXT.IN_PLACE]);
  // Watch only still works, through register (which refuses work in place itself: nothing is shared).
  const card = await r.review({ op: 'share', team, scope: 'watch', expiry: '' });
  assert.equal(card.ok, true);
  const out = await r.confirm(card.selection);
  assert.equal(out.ok, false, 'register refuses a work-in-place chat (T4c-1); never shared');
  assert.equal(r.host.calls.filter((c) => c[0] === 'share').length, 0);
  r.tm.stop();
});

test('a chat that ended reads as not shareable, with the chat wording', async () => {
  const r = rig();
  assert.equal((await r.state()).shareable, true);
  r.row.state = 'done';
  const st = await r.state();
  assert.deepEqual(st, { shareable: false, reason: Owner.TEXT.CHAT_GONE });
  r.tm.stop();
});

// ── renderer: a chat thread's ⋯ has Share with team… (thread.js starts ThreadOwner for a task row) ──
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'thread.html'), 'utf8').replace(/<script[^]*?<\/script>/g, '');
const sleep = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const opened = [];
test.afterEach(() => { while (opened.length) opened.pop().close(); });
function page(owner) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  opened.push(w);
  let ready = null;
  const open = { kind: 'task', header: { title: 'Fix the flaky test', project: 'billing', bucket: 'working', origin: null, ai: 'Claude', terminal: false },
    detail: { id: 't', title: 'Fix the flaky test', state: 'running', ai: { id: 'claude' }, repo: { name: 'billing' }, branch: 'fix/flaky', where: '~/work/billing', text: 'Fix it', openApprovals: [], openAsk: null, messages: [] }, replay: [] };
  w.threadApi = { open: async () => open, state: async () => null, close: async () => true, openInTasks: async () => true, goToTerminal: async () => ({ ok: true }), copyLink: async () => true,
    message: async () => ({ ok: true }), act: async () => ({ ok: true }), board: () => {}, onReady: (cb) => { ready = cb; }, onEvent: () => {}, onInputsChanged: () => {},
    ownerState: async () => owner, ownerReview: async () => null, ownerConfirm: async () => null, ownerAct: async () => null };
  for (const f of ['brand.js', 'src/tasks-view.js', 'src/transcript-md.js', 'src/transcript-dom.js', 'thread-shared.js', 'thread-owned.js', 'thread-owner.js', 'thread.js']) w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  return { w, $: (id) => w.document.getElementById(id), start: async () => { ready('e'.repeat(64)); await sleep(); } };
}
const K = (c) => c.repeat(32);
const CHAT = { shareable: true, available: true, provider: 'Claude', chat: true, sendNote: '', reason: '', teams: [{ key: K('1'), name: 'Design team' }],
  shares: [{ key: K('3'), team: 'Design team', scope: 'watch', expiresAt: null, automatic: false, members: 2, viewers: [], allowNote: '', allowed: [], allowable: [] }], groups: [], others: [] };

test('renderer: a chat\'s ⋯ has Share with team…; the sheet says "this chat"', async () => {
  const p = page(CHAT);
  await p.start();
  assert.equal(p.$('th-share').hidden, false);
  assert.ok([...p.$('th-owner-line').querySelectorAll('button')].some((b) => b.textContent === 'Allow sending'));
  p.$('th-share').click(); await sleep(2);
  assert.deepEqual([...p.$('th-own-scope').options].map((o) => o.value), ['watch', 'interact']);
  assert.ok(p.$('th-own-sheet').textContent.includes('Members see this chat from the moment you share it'));
});

test('renderer (S1): a work-in-place chat offers Watch only, says why, and has no Allow sending', async () => {
  const p = page({ ...CHAT, sendNote: Owner.TEXT.IN_PLACE, shares: [{ ...CHAT.shares[0], allowNote: Owner.TEXT.IN_PLACE }] });
  await p.start();
  assert.ok(![...p.$('th-owner-line').querySelectorAll('button')].some((b) => b.textContent === 'Allow sending'));
  assert.ok(p.$('th-owner-line').textContent.includes(Owner.TEXT.IN_PLACE));
  p.$('th-share').click(); await sleep(2);
  assert.deepEqual([...p.$('th-own-scope').options].map((o) => o.value), ['watch']);
  assert.ok(p.$('th-own-sheet').textContent.includes(Owner.TEXT.IN_PLACE));
});
