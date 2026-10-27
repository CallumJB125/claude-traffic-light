'use strict';
// Redesign R4-1a and R4-1b: thread:act, the chat's own choices on its own task's requests (plan-r4.md §2, §10, §11).
// The real index.js thread lifecycle and the real src/thread-main.js (test/helpers/thread-world.js), against a
// fake Tasks service that relays per document the way tasks-service's remember()/shownHash do, and records
// every act. The order of refusals is §2.2's; each refusal makes zero acts.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { world, fakeTasks, A, B, SESSION } = require('./helpers/thread-world');
const { ACT_TEXT, ARM_MS } = require('../src/thread-main');

const settle = () => new Promise((r) => setImmediate(r));
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ap = (n, over = {}) => ({ approvalId: `ap-${n}`, tool: 'Bash', inputSummary: `step ${n}`, ...over });
const DETAIL = (over = {}) => ({
  id: 'task-a', title: 'Fix the tests', messages: [], actions: ['approve', 'deny', 'answer', 'stop', 'resume'], confirm: [],
  openApprovals: [ap(1), ap(2)], openAsk: { askId: 'ask-1', text: 'Which branch?', options: ['main', 'dev'], choices: null }, ...over,
});

// A fake service: relays what each document was sent (per wcId) and answers shownHash from that.
function rig({ detail = DETAIL(), act, row = { id: 'task-a', confirm: [] }, targets } = {}) {
  const clock = { t: 1_000_000 };
  const calls = [];
  const tasks = fakeTasks();
  const relayed = new Map(); // wcId → { taskId, d }
  let now = clone(detail);
  const remember = (wcId, taskId) => relayed.set(wcId, { taskId, d: clone(now) });
  Object.assign(tasks, {
    async openTask(id, wcId) { await this.closeTask(wcId); this.slots.set(wcId, id); remember(wcId, id); return { ok: true, detail: clone(now), replay: [] }; },
    async closeTask(wcId) { relayed.delete(wcId); if (this.slots.delete(wcId)) this.log.push(['close', wcId]); },
    shownHash(wcId, taskId, kind, id) {
      const r = relayed.get(wcId);
      if (!r || r.taskId !== taskId) return null;
      if (kind === 'approval') { const a = (r.d.openApprovals || []).slice(0, 10).find((x) => x.approvalId === id); return a ? { hash: sha(`${a.tool}\0${a.inputSummary}`), tool: a.tool } : null; }
      if (kind === 'ask') { const k = r.d.openAsk; return k && k.askId === id ? { hash: sha(JSON.stringify([k.askId, k.text, k.options, k.choices])), tool: null } : null; }
      return null;
    },
    snapshot: () => ({ conn: { status: 'connected' }, tasks: row ? [row] : [] }),
    async act(req, wcId, current) {
      if (act) return act(req, wcId, current, calls);
      const ok = current() === true;
      calls.push(['act', req, wcId, ok]);
      return ok ? { ok: true, task: null } : { ok: false, code: 'ILLEGAL_TRANSITION', text: '' };
    },
  });
  const w = world({ tasks, now: () => clock.t, ...(targets ? { targets } : {}) });
  const call = (d, ...a) => w.ipc.handlers['thread:act'](d, ...a);
  // Open the thread and read it, as the page does; then the arm runs out unless told otherwise.
  async function open(row = A, { wait = ARM_MS } = {}) { w.ctx.openThread(row); const d = w.doc(); await w.ipc.handlers['thread:open'](d, row); clock.t += wait; return d; }
  const wcId = () => w.doc().sender.id;
  // A refresh: tasks-service remember()s, then (unless `silent`) sends {type:'detail'} to the document.
  function refresh(next, { silent = false, send = true } = {}) {
    now = clone(next);
    remember(wcId(), 'task-a');
    if (silent) return;
    const wc = w.doc().sender;
    if (!send) { const real = wc.send; wc.send = () => { throw new Error('closed'); }; w.thread.onEvent(wc.id, 'task-a', { type: 'detail', detail: clone(next) }); wc.send = real; return; }
    w.thread.onEvent(wc.id, 'task-a', { type: 'detail', detail: clone(next) });
  }
  return { w, tasks, calls, clock, call, open, refresh, wcId, setRow: (r) => { row = r; } };
}
const once = (n = 1) => ({ id: A, action: 'approve', approvalId: `ap-${n}`, scope: 'once' });
function held() { let release; const gate = new Promise((res) => { release = res; }); return { gate, release }; }

// ── the shapes main sends (§2.1) ─────────────────────────────────────────

test('each 1a shape reaches act exactly as main builds it; the page names only the row and the request', async () => {
  const r = rig({ detail: DETAIL({ openAsk: { askId: 'ask-1', text: 'Paused at the limit', options: null, choices: [{ id: 'wait_reset', label: 'Wait for the reset', action: 'resume', payload: { when: 'reset' } }] } }) });
  const d = await r.open();
  assert.deepEqual(await r.call(d, once(1)), { ok: true });
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, { id: A, action: 'deny', approvalId: 'ap-2' }), { ok: true });
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, { id: A, action: 'choose', askId: 'ask-1', choiceId: 'wait_reset' }), { ok: true });
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, { id: A, action: 'stop', confirmed: true }), { ok: true });
  assert.deepEqual(r.calls.map(([, req]) => req), [
    { id: 'task-a', action: 'approve', payload: { approvalId: 'ap-1', scope: 'once' } },
    { id: 'task-a', action: 'deny', payload: { approvalId: 'ap-2' } },
    { id: 'task-a', action: 'resume', payload: { when: 'reset' } },
    { id: 'task-a', action: 'stop', confirmed: true },
  ]);
  assert.ok(r.calls.every(([, , wcId, ok]) => wcId === d.sender.id && ok === true));
});

test('answer: trimmed, with the askId main delivered; options and free text alike', async () => {
  const r = rig();
  const d = await r.open();
  assert.deepEqual(await r.call(d, { id: A, action: 'answer', askId: 'ask-1', answer: '  dev  ' }), { ok: true });
  assert.deepEqual(r.calls[0][1], { id: 'task-a', action: 'answer', payload: { askId: 'ask-1', answer: 'dev' } });
});

// ── the order of refusals (§2.2), each with zero acts ────────────────────

test('1. another sender, another frame, or two arguments → null, before anything else', async () => {
  const r = rig();
  const d = await r.open();
  assert.equal(await r.call({ sender: { id: 1 }, senderFrame: {} }, once()), null);
  assert.equal(await r.call({ sender: d.sender, senderFrame: { url: 'about:srcdoc' } }, once()), null);
  assert.equal(await r.call(d, once(), 'more'), null);
  assert.equal(await r.call(d), null);
  assert.deepEqual(r.calls, []);
});

test('2. an unfocused window → ILLEGAL_TRANSITION "Focus this chat and try again."', async () => {
  const r = rig();
  const d = await r.open();
  r.w.win.focused = false;
  assert.deepEqual(await r.call(d, once()), { ok: false, code: 'ILLEGAL_TRANSITION', text: ACT_TEXT.FOCUS });
  assert.deepEqual(r.calls, []);
});

test('3. the exact shape: wrong keys, extra keys, payload, a scope outside once|task, another row, a non-plain object → VALIDATION', async () => {
  const r = rig();
  const d = await r.open();
  const bad = [
    { ...once(), payload: { approvalId: 'ap-1' } },
    { ...once(), extra: 1 },
    { id: A, action: 'approve', approvalId: 'ap-1' },
    { ...once(), scope: 'forever' },
    { ...once(), id: B },
    { ...once(), approvalId: '' },
    { ...once(), approvalId: 'x'.repeat(129) },
    { id: A, action: 'deny', approvalId: 'ap-1', scope: 'once' },
    { id: A, action: 'answer', askId: 'ask-1', answer: '   ' },
    { id: A, action: 'answer', askId: 'ask-1', answer: 'x'.repeat(20001) },
    { id: A, action: 'choose', askId: 'ask-1', choiceId: 'x'.repeat(61) },
    { id: A, action: 'stop' },
    { id: A, action: 'stop', confirmed: 'yes' },
    { id: A, action: 'discard', confirmed: true },
    { id: A, action: 'message', body: 'hi' },
    { id: A, action: 'switchAi', ai: 'gpt' },
    { id: A, action: 'switchAi' },
    { id: A, action: 'switchAi', ai: 'codex', review: '00000000-0000-4000-8000-000000000000' },
    { id: A, action: 'switchAi', review: 'not-a-handle' },
    { id: A, action: 'switchAi', ai: 'codex', confirmed: true },
    { id: A, action: 'switchAi', ai: 'codex', payload: { phase: 'apply' } },
    { ...once(), confirmed: false },
    Object.assign(Object.create({ extra: 1 }), once()),
    'ap-1',
  ];
  for (const req of bad) assert.equal((await r.call(d, req))?.code, 'VALIDATION', JSON.stringify(req));
  assert.deepEqual(r.calls, []);
});

test('4. BUSY: one act per document, shared with a reply, and the per-document 500 ms rate', async () => {
  const h = held();
  const r = rig({ act: async (req, wcId, current, calls) => { calls.push(['act', req]); await h.gate; return { ok: true }; } });
  const d = await r.open();
  const first = r.call(d, once(1));
  assert.deepEqual(await r.call(d, once(2)), { ok: false, code: 'BUSY', text: ACT_TEXT.BUSY });
  // Past the 500 ms rate, so only the in-flight act holds these back.
  r.clock.t += 1000;
  assert.deepEqual(await r.call(d, once(2)), { ok: false, code: 'BUSY', text: ACT_TEXT.BUSY }, 'still in flight');
  assert.equal((await r.w.ipc.handlers['thread:message'](d, { id: A, body: 'hi' })).code, 'BUSY', 'a reply waits for the act');
  h.release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await r.call(d, once(2)), { ok: true }, 'A settled: B goes');
  assert.equal((await r.call(d, { id: A, action: 'deny', approvalId: 'ap-1' })).code, 'BUSY', 'within 500 ms of the last act');
  r.clock.t += 500;
  assert.deepEqual(await r.call(d, { id: A, action: 'deny', approvalId: 'ap-1' }), { ok: true });
  assert.deepEqual(r.calls.map(([, req]) => [req.action, req.payload.approvalId]), [['approve', 'ap-1'], ['approve', 'ap-2'], ['deny', 'ap-1']]);
});

test('a reply in flight makes an act BUSY too', async () => {
  const h = held();
  const r = rig({ act: async (req, wcId, current, calls) => { calls.push(['act', req]); await h.gate; return { ok: true }; } });
  const d = await r.open();
  const reply = r.w.ipc.handlers['thread:message'](d, { id: A, body: 'hi' });
  r.clock.t += 1000;
  assert.equal((await r.call(d, once(1))).code, 'BUSY', 'past the rate: the reply in flight holds it');
  h.release();
  await reply;
  assert.deepEqual(r.calls.map(([, req]) => req.action), ['message']);
});

test('5. a terminal session\'s thread, or a gone row → NOT_FOUND', async () => {
  const r = rig();
  r.w.ctx.openThread(SESSION);
  r.clock.t += 700;
  assert.equal((await r.call(r.w.doc(), { ...once(), id: SESSION })).code, 'NOT_FOUND');
  const targets = { [A]: { kind: 'task', taskId: 'task-a' } };
  const g = rig({ targets });
  const d = await g.open();
  delete targets[A];
  assert.equal((await g.call(d, once())).code, 'NOT_FOUND');
  assert.deepEqual([...r.calls, ...g.calls], []);
});

test('6. the shown arm: under 600 ms → NOT_READY; at 600 ms → sent', async () => {
  const r = rig();
  const d = await r.open(A, { wait: 0 });
  r.clock.t += ARM_MS - 1;
  assert.deepEqual(await r.call(d, once(1)), { ok: false, code: 'NOT_READY', text: ACT_TEXT.NOT_READY });
  const e = await r.open(A, { wait: 0 });
  r.clock.t += ARM_MS;
  assert.deepEqual(await r.call(e, once(1)), { ok: true }, 'exactly 600 ms after delivery');
});

test('6. same id, changed inputSummary → NOT_READY until 600 ms after the new delivery (S4)', async () => {
  const r = rig();
  const d = await r.open();
  r.refresh(DETAIL({ openApprovals: [ap(1, { inputSummary: 'rm -rf /' }), ap(2)] }));
  assert.equal((await r.call(d, once(1))).code, 'NOT_READY');
  r.clock.t += ARM_MS;
  assert.deepEqual(await r.call(d, once(1)), { ok: true });
});

test('6. relayed but never sent to this document (a state event, or a send that threw) → NOT_READY (S5)', async () => {
  const r = rig();
  const d = await r.open();
  r.refresh(DETAIL({ openApprovals: [ap(1), ap(2), ap(3)] }), { silent: true });
  r.clock.t += 5000;
  assert.equal((await r.call(d, once(3))).code, 'NOT_READY', 'relayed, never shown');
  r.refresh(DETAIL({ openApprovals: [ap(1), ap(2), ap(4)] }), { send: false });
  r.clock.t += 5000;
  assert.equal((await r.call(d, once(4))).code, 'NOT_READY', 'the send threw, so nothing armed');
  assert.deepEqual(r.calls, []);
});

test('6. an id armed in one document generation is refused in the next', async () => {
  const r = rig();
  const d = await r.open();
  d.sender.reload();
  const fresh = r.w.doc();
  assert.equal(await r.call(d, once()), null, 'the old document is not the sender any more');
  assert.equal((await r.call(fresh, once())).code, 'NOT_FOUND', 'the old slot was closed on reload, and the new document has not read its chat');
  await r.w.ipc.handlers['thread:open'](fresh, A);
  r.clock.t += 100;
  assert.equal((await r.call(fresh, once())).code, 'BUSY', 'the per-document rate counts the refused try');
  r.clock.t += 500;
  assert.deepEqual(await r.call(fresh, once()), { ok: true }, 'armed afresh in the new generation');
  r.calls.length = 0;
  assert.deepEqual(r.calls, []);
});

test('7. a choice whose action main does not allow → CONFIRM_REQUIRED, zero acts', async () => {
  const r = rig({ detail: DETAIL({ openAsk: { askId: 'ask-1', text: 'Paused', options: null, choices: [{ id: 'merge_it', label: 'Merge', action: 'merge', payload: {} }, { id: 'bad_ai', label: 'Use GPT', action: 'switchAi', payload: { ai: 'gpt' } }] } }) });
  const d = await r.open();
  for (const choiceId of ['merge_it', 'bad_ai']) {
    assert.deepEqual(await r.call(d, { id: A, action: 'choose', askId: 'ask-1', choiceId }), { ok: false, code: 'CONFIRM_REQUIRED', text: ACT_TEXT.CONFIRM_REQUIRED });
    r.clock.t += 600;
  }
  assert.deepEqual(r.calls, []);
});

// ── R4-1b: the dialog kinds (plan-r4 §2.5, §3, §5 R4-1b) ────────────────
// The fake service does what tasks-service's act() and switchProvider() do around the dialog: the native
// kinds (scope 'task', a StartTask approve, a switch apply) ask confirmDialog first; then current();
// then the send. A switch apply also re-asks the preview's own `current` (r.current) first.
const REVIEW_ID = '11111111-2222-4333-8444-555555555555';
function native(r, { answer = async () => true } = {}) {
  const st = { dialogs: [], previewCurrent: null, previews: 0 };
  const act = async (req, wcId, current, calls) => {
    if (req.action === 'switchAi') {
      if (current() !== true) return { ok: false, code: 'ILLEGAL_TRANSITION', text: '' };
      if (req.payload.phase !== 'apply') {
        calls.push(['preview', req]); st.previewCurrent = current; st.previews++;
        return { ok: true, providerChange: { status: 'review', review: st.previews === 1 ? REVIEW_ID : REVIEW_ID.replace('1111', '9999'), from: 'claude', to: req.payload.ai, permissionLevel: 'ask', planFirst: false, budgetUsd: 5, spentUsd: 1.25, contextVersion: 3, branch: 'fix/tests', handover: 'Handover <b>text</b>', messagesText: 'one queued', files: [{ path: 'a.js', status: 'M' }], patch: '+<script>x</script>', expiresAt: r.clock.t + 120000 } };
      }
      if (st.previewCurrent?.() !== true) return { ok: false, code: 'CONFLICT', text: '' };
      st.dialogs.push(req);
      if (await answer(req) !== true) return { ok: false, code: 'CONFIRM_REQUIRED', text: '', cancelled: true };
      if (current() !== true) return { ok: false, code: 'CONFLICT', text: '' };
      calls.push(['act', req]);
      return { ok: true, providerChange: { status: 'queued' } };
    }
    const tool = req.action === 'approve' ? r.tasks.shownHash(wcId, 'task-a', 'approval', req.payload.approvalId)?.tool : null;
    if (req.action === 'approve' && (req.payload.scope === 'task' || tool === 'StartTask')) {
      st.dialogs.push(req);
      if (await answer(req) !== true) return { ok: false, code: 'CONFIRM_REQUIRED', text: '', cancelled: true };
    }
    if (current() !== true) return { ok: false, code: 'ILLEGAL_TRANSITION', text: '' };
    calls.push(['act', req]);
    return { ok: true, task: null };
  };
  return { st, act };
}
function nativeRig(opts = {}, rigOpts = {}) {
  let n = null;
  const r = rig({ ...rigOpts, act: (...a) => n.act(...a) });
  n = native(r, opts);
  return { ...r, st: n.st };
}
const sent = (r) => r.calls.filter(([k]) => k === 'act').map(([, q]) => q);
const startDetail = () => DETAIL({ openApprovals: [ap(1), ap(2, { tool: 'StartTask', inputSummary: 'Ship the fix' })] });

test('1b scope task: Yes → one dialog, then act with scope task; Cancel → cancelled, zero acts', async () => {
  for (const yes of [true, false]) {
    const r = nativeRig({ answer: async () => yes });
    const d = await r.open();
    const out = await r.call(d, { ...once(1), scope: 'task' });
    assert.equal(r.st.dialogs.length, 1);
    if (yes) { assert.deepEqual(out, { ok: true }); assert.deepEqual(sent(r), [{ id: 'task-a', action: 'approve', payload: { approvalId: 'ap-1', scope: 'task' } }]); }
    else { assert.deepEqual(out, { ok: false, code: 'CONFIRM_REQUIRED', cancelled: true, text: '' }); assert.deepEqual(sent(r), []); }
  }
});

test('1b: a dialog refused because the chat lost focus (the ticket is null) → cancelled, never "may have been sent"', async () => {
  let r = null;
  r = nativeRig({ answer: async () => { r.w.win.focused = false; return false; } });
  const d = await r.open();
  assert.deepEqual(await r.call(d, { ...once(1), scope: 'task' }), { ok: false, code: 'CONFIRM_REQUIRED', cancelled: true, text: '' });
  assert.deepEqual(sent(r), []);
});

test('1b: the request changed while the dialog was open → Yes is refused at the send: NOT_READY, zero acts', async () => {
  let r = null;
  r = nativeRig({ answer: async () => { r.refresh(DETAIL({ openApprovals: [ap(1, { inputSummary: 'rm -rf build' }), ap(2)] })); return true; } });
  const d = await r.open();
  assert.deepEqual(await r.call(d, { ...once(1), scope: 'task' }), { ok: false, code: 'NOT_READY', text: ACT_TEXT.NOT_READY });
  assert.deepEqual(sent(r), []);
});

test('1b: the chat reloaded while the dialog was open → NOT_READY, zero acts', async () => {
  let r = null, d = null;
  r = nativeRig({ answer: async () => { d.sender.reload(); return true; } });
  d = await r.open();
  assert.deepEqual(await r.call(d, { ...once(1), scope: 'task' }), { ok: false, code: 'NOT_READY', text: ACT_TEXT.NOT_READY });
  assert.deepEqual(sent(r), []);
});

test('1b StartTask: Accept → one dialog, scope once; scope task → VALIDATION before any dialog; Deny → zero dialogs', async () => {
  const r = nativeRig({}, { detail: startDetail() });
  const d = await r.open();
  assert.equal((await r.call(d, { ...once(2), scope: 'task' })).code, 'VALIDATION');
  assert.equal(r.st.dialogs.length, 0);
  r.clock.t += 600; // past the per-document rate the refusal used
  assert.deepEqual(await r.call(d, once(2)), { ok: true });
  assert.equal(r.st.dialogs.length, 1, 'Accept and start asks once');
  r.clock.t += 600;
  r.refresh(startDetail(), { silent: false });
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, { id: A, action: 'deny', approvalId: 'ap-2' }), { ok: true });
  assert.equal(r.st.dialogs.length, 1, 'Deny has no dialog, the same as Tasks');
  assert.deepEqual(sent(r), [{ id: 'task-a', action: 'approve', payload: { approvalId: 'ap-2', scope: 'once' } }, { id: 'task-a', action: 'deny', payload: { approvalId: 'ap-2' } }]);
});

test('1b: Allow once, Deny, answers, resume choices and Stop raise zero dialogs', async () => {
  const r = nativeRig({}, { detail: DETAIL({ openAsk: { askId: 'ask-1', text: 'Paused', options: null, choices: [{ id: 'wait_reset', label: 'Wait for the reset', action: 'resume', payload: { when: 'reset' } }] } }) });
  const d = await r.open();
  for (const req of [once(1), { id: A, action: 'deny', approvalId: 'ap-2' }, { id: A, action: 'choose', askId: 'ask-1', choiceId: 'wait_reset' }, { id: A, action: 'stop', confirmed: true }]) {
    assert.deepEqual(await r.call(d, req), { ok: true }, JSON.stringify(req));
    r.clock.t += 600;
  }
  assert.equal(r.st.dialogs.length, 0);
  assert.equal(sent(r).length, 4);
});

test('1b BUSY: while a dialog is open, a second act or a reply → BUSY, no second dialog', async () => {
  const h = held();
  const r = nativeRig({ answer: async () => { await h.gate; return true; } });
  const d = await r.open();
  const p = r.call(d, { ...once(1), scope: 'task' });
  await settle();
  r.clock.t += 1000;
  assert.deepEqual(await r.call(d, { ...once(2), scope: 'task' }), { ok: false, code: 'BUSY', text: ACT_TEXT.BUSY });
  assert.equal((await r.w.ipc.handlers['thread:message'](d, { id: A, body: 'hello' })).code, 'BUSY');
  assert.equal(r.st.dialogs.length, 1);
  h.release();
  assert.deepEqual(await p, { ok: true });
});

const switchTo = (ai = 'codex') => ({ id: A, action: 'switchAi', ai });
const applyIt = (review = REVIEW_ID) => ({ id: A, action: 'switchAi', review });

test('1b switch AI: preview → the review for the page; apply under 600 ms → NOT_READY; at 600 ms → one dialog, then the apply', async () => {
  const r = nativeRig();
  const d = await r.open();
  const pv = await r.call(d, switchTo());
  assert.equal(pv.ok, true);
  assert.deepEqual(Object.keys(pv.review).sort(), ['branch', 'budgetUsd', 'contextVersion', 'expiresAt', 'files', 'from', 'handover', 'messagesText', 'patch', 'permissionLevel', 'planFirst', 'review', 'spentUsd', 'to']);
  assert.equal(pv.review.review, REVIEW_ID);
  assert.equal(r.st.dialogs.length, 0, 'a preview has no dialog');
  r.clock.t += 550; // past the 500 ms rate, inside the 600 ms arm
  assert.deepEqual(await r.call(d, applyIt()), { ok: false, code: 'NOT_READY', text: ACT_TEXT.NOT_READY });
  assert.equal(r.st.dialogs.length, 0);
  r.clock.t += 550;
  assert.deepEqual(await r.call(d, applyIt()), { ok: true });
  assert.equal(r.st.dialogs.length, 1);
  assert.deepEqual(sent(r), [{ id: 'task-a', action: 'switchAi', payload: { phase: 'apply', review: REVIEW_ID } }]);
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, applyIt()), { ok: false, code: 'NOT_READY', text: ACT_TEXT.REVIEW_GONE }, 'a handle is used once');
});

test('1b switch AI: Cancel → cancelled, zero acts; the handle is spent, so the page reviews again', async () => {
  const r = nativeRig({ answer: async () => false });
  const d = await r.open();
  await r.call(d, switchTo());
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, applyIt()), { ok: false, code: 'CONFIRM_REQUIRED', cancelled: true, text: '' });
  assert.deepEqual(sent(r), []);
});

test('1b switch AI: an old handle after a re-preview, or one from the previous document → NOT_READY, zero dialogs', async () => {
  const r = nativeRig();
  let d = await r.open();
  await r.call(d, switchTo());
  r.clock.t += 600;
  const second = await r.call(d, switchTo());
  assert.notEqual(second.review.review, REVIEW_ID);
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, applyIt(REVIEW_ID)), { ok: false, code: 'NOT_READY', text: ACT_TEXT.REVIEW_GONE });
  d.sender.reload();
  d = await r.open();
  assert.deepEqual(await r.call(d, applyIt(second.review.review)), { ok: false, code: 'NOT_READY', text: ACT_TEXT.REVIEW_GONE }, 'generation n+1');
  assert.equal(r.st.dialogs.length, 0);
  assert.deepEqual(sent(r), []);
});

test('1b switch AI (S2): approving something else between preview and apply leaves the review good', async () => {
  const r = nativeRig();
  const d = await r.open();
  await r.call(d, switchTo());
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, once(1)), { ok: true });
  r.refresh(DETAIL({ openApprovals: [ap(2)] }));
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, applyIt()), { ok: true });
  assert.equal(r.st.dialogs.length, 1);
});

test('1b switch AI: the chat changed before the apply was sent (alive() false) → NOT_READY, never "may have started"', async () => {
  let r = null, d = null;
  r = nativeRig({ answer: async () => { r.w.ctx.store.ws = 'ws-2'; return true; } });
  d = await r.open();
  await r.call(d, switchTo());
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, applyIt()), { ok: false, code: 'NOT_READY', text: ACT_TEXT.NOT_READY });
  assert.deepEqual(sent(r), []);
});

test('1b switch AI: a review taken before a workspace switch fails its own check at apply → NOT_READY, never "may have started"', async () => {
  const r = nativeRig();
  const d = await r.open();
  await r.call(d, switchTo());
  r.w.ctx.store.ws = 'ws-2'; // the preview's current() is now false; the apply's own is true
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, applyIt()), { ok: false, code: 'NOT_READY', text: ACT_TEXT.NOT_READY });
  assert.equal(r.st.dialogs.length, 0);
  assert.deepEqual(sent(r), []);
});

test('1b switch AI: the same document reloaded (same webContents, generation n+1) → the handle is gone, zero dialogs', async () => {
  const r = nativeRig();
  const d = await r.open();
  const pv = await r.call(d, switchTo());
  const wc = d.sender.id;
  d.sender.reload();
  const again = r.w.doc();
  assert.equal(again.sender.id, wc, 'the same webContents');
  await r.w.ipc.handlers['thread:open'](again, A);
  r.clock.t += 600;
  assert.deepEqual(await r.call(again, applyIt(pv.review.review)), { ok: false, code: 'NOT_READY', text: ACT_TEXT.REVIEW_GONE });
  assert.equal(r.st.dialogs.length, 0);
  assert.deepEqual(sent(r), []);
});

test('1b switch AI from a choice: the choice\'s own AI, as a preview, from main\'s copy', async () => {
  const r = nativeRig({}, { detail: DETAIL({ openAsk: { askId: 'ask-1', text: 'Claude hit its usage limit.', options: null, choices: [{ id: 'switch_ai', label: 'Continue with Codex', action: 'switchAi', payload: { ai: 'codex' } }] } }) });
  const d = await r.open();
  const out = await r.call(d, { id: A, action: 'choose', askId: 'ask-1', choiceId: 'switch_ai' });
  assert.equal(out.ok, true);
  assert.equal(out.review.to, 'codex');
  assert.deepEqual(r.calls.map(([k, q]) => [k, q.payload]), [['preview', { ai: 'codex' }]]);
});

test('choose: an unknown choiceId → VALIDATION; the payload is main\'s copy, never the page\'s', async () => {
  const r = rig({ detail: DETAIL({ openAsk: { askId: 'ask-1', text: 'Paused', options: null, choices: [{ id: 'resume_now', label: 'Try again now', action: 'resume', payload: { when: 'now' } }] } }) });
  const d = await r.open();
  assert.equal((await r.call(d, { id: A, action: 'choose', askId: 'ask-1', choiceId: 'wait_reset' })).code, 'VALIDATION');
  assert.equal((await r.call(d, { id: A, action: 'choose', askId: 'ask-1', choiceId: 'resume_now', payload: { when: 'reset' } })).code, 'VALIDATION', 'no payload key');
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, { id: A, action: 'choose', askId: 'ask-1', choiceId: 'resume_now' }), { ok: true });
  assert.deepEqual(r.calls.map(([, req]) => req), [{ id: 'task-a', action: 'resume', payload: { when: 'now' } }]);
});

test('choose: the choices changed under the same askId → NOT_READY', async () => {
  const ask = (when) => ({ askId: 'ask-1', text: 'Paused', options: null, choices: [{ id: 'resume', label: 'Resume', action: 'resume', payload: { when } }] });
  const r = rig({ detail: DETAIL({ openAsk: ask('now') }) });
  const d = await r.open();
  r.refresh(DETAIL({ openAsk: ask('reset') }), { silent: true });
  assert.equal((await r.call(d, { id: A, action: 'choose', askId: 'ask-1', choiceId: 'resume' })).code, 'NOT_READY');
  assert.deepEqual(r.calls, []);
});

test('task.confirm: confirmed is forwarded only when main\'s own row asks for that action; otherwise VALIDATION', async () => {
  const r = rig({ row: { id: 'task-a', confirm: ['approve'] } });
  const d = await r.open();
  assert.equal((await r.call(d, { id: A, action: 'deny', approvalId: 'ap-2', confirmed: true })).code, 'VALIDATION', 'the row asks for approve only');
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, { ...once(1), confirmed: true }), { ok: true });
  assert.deepEqual(r.calls.map(([, req]) => req), [{ id: 'task-a', action: 'approve', payload: { approvalId: 'ap-1', scope: 'once' }, confirmed: true }]);
  r.setRow(null);
  r.clock.t += 600;
  assert.equal((await r.call(d, { ...once(2), confirmed: true })).code, 'VALIDATION', 'no cached row, no confirmed');
});

// ── stale paths (§10 S1): nothing sent → NOT_READY; maybe sent → CONFLICT ─

test('the request changes between the click and the send: current() is false at the send, nothing goes, NOT_READY', async () => {
  const h = held();
  let sent = 0;
  const r = rig({ act: async (req, wcId, current) => { await h.gate; if (current() !== true) return { ok: false, code: 'ILLEGAL_TRANSITION', text: '' }; sent++; return { ok: true }; } });
  const d = await r.open();
  const p = r.call(d, once(1));
  r.refresh(DETAIL({ openApprovals: [ap(1, { inputSummary: 'something else' }), ap(2)] }));
  h.release();
  assert.deepEqual(await p, { ok: false, code: 'NOT_READY', text: ACT_TEXT.NOT_READY });
  assert.equal(sent, 0);
});

test('a reload before the send: NOT_READY with zero sends; a reload after it: CONFLICT, sent once', async () => {
  for (const after of [false, true]) {
    const h = held();
    let sent = 0;
    const r = rig({ act: async (req, wcId, current) => { if (!after) await h.gate; if (current() !== true) return { ok: false, code: 'ILLEGAL_TRANSITION', text: '' }; sent++; if (after) await h.gate; return { ok: true }; } });
    const d = await r.open();
    const p = r.call(d, after ? { id: A, action: 'stop', confirmed: true } : once(1));
    await settle();
    d.sender.reload();
    h.release();
    if (after) assert.deepEqual(await p, { ok: false, code: 'CONFLICT', text: ACT_TEXT.CONFLICT_STOP });
    else assert.deepEqual(await p, { ok: false, code: 'NOT_READY', text: ACT_TEXT.NOT_READY });
    assert.equal(sent, after ? 1 : 0);
  }
});

test('a successful act whose request resolves while it is in flight (the engine\'s state lands first) → ok, not CONFLICT', async () => {
  for (const [req, next] of [
    [once(1), DETAIL({ openApprovals: [ap(2)] })],
    [{ id: A, action: 'deny', approvalId: 'ap-1' }, DETAIL({ openApprovals: [ap(2)] })],
    [{ id: A, action: 'answer', askId: 'ask-1', answer: 'dev' }, DETAIL({ openAsk: null })],
  ]) {
    const h = held();
    const r = rig({ act: async (q, wcId, current, calls) => { if (current() !== true) return { ok: false }; calls.push(['act', q]); await h.gate; return { ok: true }; } });
    const d = await r.open();
    const p = r.call(d, req);
    await settle();
    r.refresh(next); // remember() drops the answered request from what was relayed
    h.release();
    assert.deepEqual(await p, { ok: true }, req.action);
    assert.equal(r.calls.length, 1);
  }
});

test('task.confirm on a choice: the row is checked for the engine action (resume), not the page action (choose)', async () => {
  const ask = { askId: 'ask-1', text: 'Paused at the limit', options: null, choices: [{ id: 'wait_reset', label: 'Wait for the reset', action: 'resume', payload: { when: 'reset' } }] };
  const r = rig({ detail: DETAIL({ openAsk: ask }), row: { id: 'task-a', confirm: ['resume'] } });
  const d = await r.open();
  assert.deepEqual(await r.call(d, { id: A, action: 'choose', askId: 'ask-1', choiceId: 'wait_reset', confirmed: true }), { ok: true });
  assert.deepEqual(r.calls.map(([, q]) => q), [{ id: 'task-a', action: 'resume', payload: { when: 'reset' }, confirmed: true }]);
  const s = rig({ detail: DETAIL({ openAsk: ask }), row: { id: 'task-a', confirm: ['choose'] } });
  const e = await s.open();
  assert.equal((await s.call(e, { id: A, action: 'choose', askId: 'ask-1', choiceId: 'wait_reset', confirmed: true })).code, 'VALIDATION');
  assert.equal(s.calls.length, 0);
});

test('an account or workspace switch, focus loss, or the row moving to another task after the send → CONFLICT', async () => {
  for (const flip of [(r) => { r.w.ctx.setupSourcesGeneration++; }, (r) => { r.w.ctx.store.ws = 'ws-2'; }, (r) => { r.w.win.focused = false; }]) {
    const h = held();
    const r = rig({ act: async (req, wcId, current, calls) => { if (current() !== true) return { ok: false }; calls.push(['act', req]); await h.gate; return { ok: true }; } });
    const d = await r.open();
    const p = r.call(d, { id: A, action: 'answer', askId: 'ask-1', answer: 'dev' });
    await settle();
    flip(r);
    h.release();
    assert.deepEqual(await p, { ok: false, code: 'CONFLICT', text: ACT_TEXT.CONFLICT });
    assert.equal(r.calls.length, 1);
  }
});

test('engine refusals pass through as sentences: ALREADY_ANSWERED, ILLEGAL_TRANSITION with its own text', async () => {
  const replies = [{ ok: false, code: 'ALREADY_ANSWERED', text: 'x' }, { ok: false, code: 'ILLEGAL_TRANSITION', text: 'The task is not in a state where that can be done any more.' }];
  const r = rig({ act: async (req, wcId, current) => (current(), replies.shift()) });
  const d = await r.open();
  assert.deepEqual(await r.call(d, once(1)), { ok: false, code: 'ALREADY_ANSWERED', text: ACT_TEXT.ALREADY_ANSWERED });
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, once(2)), { ok: false, code: 'ILLEGAL_TRANSITION', text: 'The task is not in a state where that can be done any more.' });
});

// ── stacked requests (§11): per-card arms, no misroute ───────────────────

test('stacked: each request has its own arm; an old A never lets a new B through', async () => {
  const r = rig();
  const d = await r.open();
  r.refresh(DETAIL({ openApprovals: [ap(1), ap(2), ap(3)] }));
  assert.deepEqual(await r.call(d, once(1)), { ok: true }, 'A was armed long ago');
  r.clock.t += 500;
  assert.equal((await r.call(d, once(3))).code, 'NOT_READY', 'B arrived 500 ms ago');
  r.clock.t += 500;
  assert.deepEqual(await r.call(d, once(3)), { ok: true });
});

test('stacked: a refresh that re-sends B unchanged keeps its arm; a changed B re-arms B only', async () => {
  const r = rig();
  const d = await r.open();
  r.refresh(DETAIL());
  assert.deepEqual(await r.call(d, once(2)), { ok: true }, 'same hash: the first delivery time stands');
  r.clock.t += 600;
  r.refresh(DETAIL({ openApprovals: [ap(1, { inputSummary: 'changed' }), ap(3)] }));
  r.refresh(DETAIL({ openApprovals: [ap(1, { inputSummary: 'changed' }), ap(3)] }));
  assert.equal((await r.call(d, once(1))).code, 'NOT_READY', 'A changed');
  assert.deepEqual(r.calls.map(([, req]) => req.payload.approvalId), ['ap-2']);
});

test('stacked: the approvalId sent is exactly the one requested, never another open one', async () => {
  const r = rig({ detail: DETAIL({ openApprovals: [ap(1), ap(2), ap(3)] }) });
  const d = await r.open();
  for (const n of [3, 1, 2]) { assert.deepEqual(await r.call(d, { id: A, action: n === 1 ? 'deny' : 'approve', approvalId: `ap-${n}`, ...(n === 1 ? {} : { scope: 'once' }) }), { ok: true }); r.clock.t += 600; }
  assert.deepEqual(r.calls.map(([, req]) => [req.action, req.payload.approvalId]), [['approve', 'ap-3'], ['deny', 'ap-1'], ['approve', 'ap-2']]);
});

test('stacked: answering the question leaves every approval untouched, and approving leaves the question', async () => {
  const r = rig();
  const d = await r.open();
  assert.deepEqual(await r.call(d, { id: A, action: 'answer', askId: 'ask-1', answer: 'main' }), { ok: true });
  r.clock.t += 600;
  assert.deepEqual(await r.call(d, once(2)), { ok: true });
  assert.deepEqual(r.calls.map(([, req]) => [req.action, req.payload.askId ?? req.payload.approvalId]), [['answer', 'ask-1'], ['approve', 'ap-2']]);
});

test('the cap: 11 or 12 raw approvals relay 10; an act on the 11th or 12th is NOT_FOUND, zero acts', async () => {
  const r = rig({ detail: DETAIL({ openApprovals: Array.from({ length: 12 }, (_, i) => ap(i + 1)) }) });
  const d = await r.open();
  for (const n of [11, 12]) { assert.equal((await r.call(d, once(n))).code, 'NOT_FOUND', `approval ${n}`); r.clock.t += 600; }
  assert.deepEqual(r.calls, []);
  assert.deepEqual(await r.call(d, once(10)), { ok: true });
});

test('retire clears the arm: a closed slot keeps nothing', async () => {
  const r = rig();
  const d = await r.open();
  const wcId = d.sender.id;
  r.w.thread.retire(wcId);
  await settle();
  assert.equal((await r.call(d, once(1))).code, 'NOT_FOUND', 'the service closed the slot');
  assert.deepEqual(r.calls, []);
});
