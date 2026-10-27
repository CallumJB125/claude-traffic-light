'use strict';
// Redesign R2a: the thread page's own logic (thread.js) with a fake bridge.
// Electron renders it for real in test-visual/thread.spec.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'thread.html'), 'utf8').replace(/<script[^]*?<\/script>/g, '');
const scripts = ['brand.js', 'src/tasks-view.js', 'src/transcript-md.js', 'src/transcript-dom.js', 'thread.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
const ID = 'e'.repeat(64);
const open = [];
test.afterEach(() => { while (open.length) open.pop().close(); });
const tick = () => new Promise((r) => setTimeout(r, 0));

function page(responses, { clock = null } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  open.push(w);
  // R4-1a: a fake clock for the 600 ms arms (Date.now and the page's timers), when asked for.
  const timers = [];
  if (clock) { w.Date.now = () => clock.t; w.setTimeout = (fn, ms = 0) => { timers.push({ at: clock.t + ms, fn }); return timers.length; }; }
  const calls = [];
  let ready = null, onEvent = null;
  w.threadApi = {
    open: async (id) => { calls.push(['open', id]); return responses.open; },
    state: async (id) => { calls.push(['state', id]); return responses.state ?? null; },
    close: async (id) => { calls.push(['close', id]); return true; },
    openInTasks: async (id) => { calls.push(['tasks', id]); return true; },
    goToTerminal: async (id) => { calls.push(['terminal', id]); return responses.terminal ?? { ok: true }; },
    copyLink: async (id) => { calls.push(['copy', id]); return true; },
    message: async (id, body) => { calls.push(['message', id, body]); return typeof responses.message === 'function' ? responses.message(body) : (responses.message ?? { ok: true }); },
    act: async (id, req) => { calls.push(['act', id, req]); return typeof responses.act === 'function' ? responses.act(req) : (responses.act ?? { ok: true }); },
    board: () => calls.push(['board']),
    onReady: (cb) => { ready = cb; },
    onEvent: (cb) => { onEvent = cb; },
  };
  for (const s of scripts) w.eval(s);
  const $ = (id) => w.document.getElementById(id);
  const advance = (ms) => { clock.t += ms; for (const x of timers.splice(0)) { if (x.at <= clock.t) x.fn(); else timers.push(x); } };
  return { w, $, calls, ready: (id = ID) => ready(id), event: (m) => onEvent(m), advance };
}

const task = (over = {}) => ({ kind: 'task', header: { title: 'Fix the flaky test', project: 'billing', bucket: 'working', origin: null, ai: 'Claude', terminal: false },
  detail: { id: 't', title: 'Fix the flaky test', state: 'running', ai: { id: 'claude' }, repo: { name: 'billing' }, branch: 'fix/flaky', where: '~/work/billing', text: 'Fix it', openApprovals: [], openAsk: null, messages: [], ...over }, replay: [] });

test('a chat: title, project · branch · AI, the bucket in words and shape; no button with nothing to decide', async () => {
  const p = page({ open: task() });
  p.ready();
  await tick(); await tick();
  assert.deepEqual(p.calls[0], ['open', ID]);
  assert.equal(p.$('th-title').textContent, 'Fix the flaky test');
  assert.equal(p.$('th-meta').textContent, 'billing · fix/flaky · Claude');
  assert.equal(p.$('th-bucket').textContent, 'Working on it');
  assert.equal(p.$('th-dot').dataset.bucket, 'working');
  assert.equal(p.$('th-primary').hidden, true);
  assert.equal(p.$('th-waiting').hidden, true);
  assert.equal(p.$('th').getAttribute('aria-busy'), 'false');
});

test('an open approval: the read-only waiting card and "Open to answer" (to the Tasks page, this row only)', async () => {
  const p = page({ open: task({ openApprovals: [{ approvalId: 'a', tool: 'Bash', inputSummary: 'rm -rf build' }] }) });
  p.ready();
  await tick(); await tick();
  assert.equal(p.$('th-waiting').hidden, false);
  assert.equal(p.$('th-waiting-title').textContent, 'Claude is waiting for you');
  assert.equal(p.$('th-waiting-what').textContent, 'Bash: rm -rf build');
  assert.equal(p.$('th-waiting-where').textContent, 'In ~/work/billing');
  assert.equal(p.$('th-bucket').textContent, 'Needs you', 'an open approval wins over a stale list bucket');
  assert.equal(p.$('th-primary').hidden, true, 'one button for one decision: the card\'s');
  p.$('th-answer').click();
  await tick();
  assert.deepEqual(p.calls.filter(([k]) => k === 'tasks'), [['tasks', ID]]);
  assert.equal(p.w.document.querySelectorAll('#th-waiting button').length, 1, 'no Allow or Deny here');
});

test('a live detail event updates the card; events for another row are ignored', async () => {
  const p = page({ open: task() });
  p.ready();
  await tick(); await tick();
  p.event({ id: 'f'.repeat(64), event: { type: 'detail', detail: { ...task().detail, openAsk: { text: 'Which branch?' } } } });
  assert.equal(p.$('th-waiting').hidden, true);
  p.event({ id: ID, event: { type: 'detail', detail: { ...task().detail, openAsk: { text: 'Which branch?' } } } });
  assert.equal(p.$('th-waiting-title').textContent, 'Claude has a question');
  assert.equal(p.$('th-waiting-what').textContent, 'Which branch?');
});

test('a terminal session: the banner names its terminal and [Go to it] asks main for the bound session', async () => {
  const p = page({ open: { kind: 'session', origin: 'iTerm', header: { title: 'Claude session in billing', project: 'billing', bucket: 'needs', origin: 'iTerm', ai: 'Claude', terminal: true }, activity: { title: 'x', view: { status: 'Waiting for you', events: [] } } }, terminal: { ok: false, note: 'iTerm is not running.' } });
  p.ready();
  await tick(); await tick();
  assert.equal(p.$('th-banner').hidden, false);
  assert.equal(p.$('th-banner').textContent, 'Running in iTerm');
  assert.equal(p.$('th-primary').textContent, 'Go to it');
  p.$('th-primary').click();
  await tick(); await tick();
  assert.deepEqual(p.calls.at(-1), ['terminal', ID]);
  assert.equal(p.$('th-status').textContent, 'iTerm is not running.');
});

test('a row that ended or moved: the ended state with Back to Board', async () => {
  const p = page({ open: { gone: true } });
  p.ready();
  await tick(); await tick();
  assert.equal(p.$('th-empty').hidden, false);
  assert.equal(p.$('th-empty-title').textContent, 'This chat has ended or moved');
  assert.equal(p.$('th-board').hidden, false);
  p.$('th-board').click();
  assert.deepEqual(p.calls.at(-1), ['board']);
  assert.equal(p.$('th-primary').hidden, true);
});

test('Copy link from the ⋯ menu; Escape closes it and returns focus', async () => {
  const p = page({ open: task() });
  p.ready();
  await tick(); await tick();
  p.$('th-more').click();
  assert.equal(p.$('th-menu').hidden, false);
  assert.equal(p.$('th-more').getAttribute('aria-expanded'), 'true');
  assert.equal(p.w.document.activeElement, p.$('th-tasks'), 'the first item: a chat\'s Open in Tasks (R2b-1)');
  p.$('th-menu').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(p.$('th-menu').hidden, true);
  assert.equal(p.w.document.activeElement, p.$('th-more'));
  p.$('th-more').click();
  p.$('th-copy').click();
  await tick();
  assert.deepEqual(p.calls.at(-1), ['copy', ID]);
  assert.equal(p.$('th-status').textContent, 'Link copied');
});

test('readiness for another row is ignored once bound', async () => {
  const p = page({ open: task() });
  p.ready();
  p.ready('f'.repeat(64));
  await tick(); await tick();
  assert.deepEqual(p.calls.filter(([k]) => k === 'open'), [['open', ID]]);
});

test('thread.html: the frame is sandboxed without scripts, srcdoc with its own CSP, styles linked', () => {
  const src = fs.readFileSync(path.join(root, 'thread.html'), 'utf8');
  assert.match(src, /content="default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self' about:; base-uri 'none'; form-action 'none'"/);
  const frame = src.match(/<iframe[^]*?<\/iframe>/)[0];
  assert.match(frame, /sandbox="allow-same-origin"/);
  assert.match(frame, /srcdoc="/);
  assert.match(frame, /content=&quot;default-src 'none'; style-src 'self'&quot;/);
  assert.match(frame, /href=&quot;thread-transcript\.css&quot;/);
  assert.doesNotMatch(frame, /&lt;style|<style|&lt;script/);
});

// ── R2b-1: the reply box ─────────────────────────────────────────────────
const key = (p, over) => p.$('th-reply-text').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...over }));
const type = (p, text) => { p.$('th-reply-text').value = text; p.$('th-reply-text').dispatchEvent(new p.w.Event('input', { bubbles: true })); };

test('reply: a chat that takes messages shows the box; ⌘↩ sends the row and the text only, Enter is a newline', async () => {
  const p = page({ open: task({ actions: ['message', 'stop'] }) });
  p.ready();
  await tick(); await tick();
  assert.equal(p.$('th-reply').hidden, false);
  assert.equal(p.$('th-reply').dataset.state, 'on');
  assert.equal(p.$('th-reply-text').placeholder, 'Reply to Claude…');
  assert.equal(p.$('th-send').disabled, true, 'nothing to send yet');
  type(p, 'Use the staging database');
  assert.equal(p.$('th-send').disabled, false);
  key(p, {});
  await tick();
  assert.equal(p.calls.filter(([k]) => k === 'message').length, 0, 'Enter alone never sends');
  key(p, { metaKey: true });
  await tick(); await tick();
  assert.deepEqual(p.calls.filter(([k]) => k === 'message'), [['message', ID, 'Use the staging database']]);
  assert.equal(p.$('th-reply-text').value, '', 'sent, so cleared');
  assert.equal(p.$('th-reply-note').textContent, '');
});

test('reply: the Send button sends; a refusal keeps the text and says why', async () => {
  const p = page({ open: task({ actions: ['message'] }), message: { ok: false, code: 'CONFLICT', text: 'Your message may have been sent. Check the chat before sending again.' } });
  p.ready();
  await tick(); await tick();
  type(p, 'hello');
  p.$('th-send').click();
  await tick(); await tick();
  assert.deepEqual(p.calls.filter(([k]) => k === 'message'), [['message', ID, 'hello']]);
  assert.equal(p.$('th-reply-text').value, 'hello');
  assert.equal(p.$('th-reply-note').textContent, 'Your message may have been sent. Check the chat before sending again.');
  assert.equal(p.$('th-reply-note').dataset.tone, 'error');
});

test('reply: while a reply is in flight, a second press sends nothing', async () => {
  let release;
  const p = page({ open: task({ actions: ['message'] }), message: () => new Promise((r) => { release = () => r({ ok: true }); }) });
  p.ready();
  await tick(); await tick();
  type(p, 'one');
  p.$('th-send').click();
  await tick();
  assert.equal(p.$('th-send').textContent, 'Sending…');
  assert.equal(p.$('th-send').disabled, true);
  key(p, { metaKey: true });
  await tick();
  assert.equal(p.calls.filter(([k]) => k === 'message').length, 1);
  release();
  await tick(); await tick();
  assert.equal(p.$('th-send').textContent, 'Send');
});

test('reply: an open approval comes first: no box, or the draft kept and the box off, saying why', async () => {
  const p = page({ open: task({ actions: ['message'] }) });
  p.ready();
  await tick(); await tick();
  type(p, 'half-written');
  p.event({ id: ID, event: { type: 'detail', detail: { ...task().detail, actions: ['approve', 'deny'], openApprovals: [{ approvalId: 'a', tool: 'Bash', inputSummary: 'npm i' }] } } });
  assert.equal(p.$('th-reply').hidden, false, 'the draft is kept on screen');
  assert.equal(p.$('th-reply-text').value, 'half-written');
  assert.equal(p.$('th-reply').dataset.state, 'wait');
  assert.equal(p.$('th-reply-text').disabled, true);
  assert.equal(p.$('th-reply-text').placeholder, 'Allow or deny the request above to continue');
  assert.equal(p.$('th-send').disabled, true);
  const q = page({ open: task({ actions: ['approve', 'deny'], openApprovals: [{ approvalId: 'a', tool: 'Bash', inputSummary: 'npm i' }] }) });
  q.ready();
  await tick(); await tick();
  assert.equal(q.$('th-reply').hidden, true, 'no draft: the waiting card is the one thing to do');
});

test('reply: a chat in the terminal, or one that can\'t take a message now, has the box off with a reason', async () => {
  const p = page({ open: { ...task({ actions: [] }), header: { ...task().header, chatState: 'in-terminal' } } });
  p.ready();
  await tick(); await tick();
  assert.equal(p.$('th-reply').dataset.state, 'off');
  assert.equal(p.$('th-reply-text').placeholder, 'This chat is in your terminal. Reply there.');
  const q = page({ open: task({ state: 'parked', actions: ['resume'] }) });
  q.ready();
  await tick(); await tick();
  assert.equal(q.$('th-reply').hidden, true, 'nothing to send and nothing to say: no dead box');
});

test('reply: a chat that stops taking messages keeps the draft, with the box off', async () => {
  const p = page({ open: task({ actions: ['message'] }) });
  p.ready();
  await tick(); await tick();
  type(p, 'keep me');
  p.event({ id: ID, event: { type: 'detail', detail: { ...task().detail, state: 'parked', actions: ['resume'] } } });
  assert.equal(p.$('th-reply').hidden, false);
  assert.equal(p.$('th-reply-text').placeholder, 'Claude can’t take a message right now.');
  assert.equal(p.$('th-reply-text').disabled, true);
  assert.equal(p.$('th-reply-text').value, 'keep me');
});

test('the R2a fixtures keep their look: a running chat whose actions lack message has no box', async () => {
  const p = page({ open: task({ actions: [] }) });
  p.ready();
  await tick(); await tick();
  assert.equal(p.$('th-reply').hidden, true);
  assert.equal(p.$('th-ended').hidden, true);
});

test('ended: no reply box; Resume in Tasks goes to this chat in Tasks', async () => {
  const p = page({ open: { ...task({ state: 'done', actions: [] }), header: { ...task().header, chatState: 'ended' } } });
  p.ready();
  await tick(); await tick();
  assert.equal(p.$('th-reply').hidden, true);
  assert.equal(p.$('th-ended').hidden, false);
  assert.equal(p.$('th-ended-title').textContent, 'This chat has ended');
  p.$('th-resume').click();
  await tick();
  assert.deepEqual(p.calls.filter(([k]) => k === 'tasks'), [['tasks', ID]]);
});

test('⋯ menu: Open in Tasks, and Open in a terminal says why not (openInTerminal), or goes to Tasks', async () => {
  const p = page({ open: { ...task({ actions: ['message'] }), header: { ...task().header, chatState: 'working', openInTerminal: { available: false, reason: 'in-place' } } } });
  p.ready();
  await tick(); await tick();
  assert.equal(p.$('th-tasks').hidden, false);
  assert.equal(p.$('th-terminal').hidden, false);
  assert.equal(p.$('th-terminal').getAttribute('aria-disabled'), 'true');
  assert.equal(p.$('th-terminal-why').textContent, 'It works directly in your folder.');
  p.$('th-more').click();
  p.$('th-terminal').click();
  await tick();
  assert.equal(p.calls.filter(([k]) => k === 'tasks').length, 0, 'unavailable does nothing');
  p.$('th-tasks').click();
  await tick();
  assert.deepEqual(p.calls.filter(([k]) => k === 'tasks'), [['tasks', ID]]);
  const q = page({ open: { ...task(), header: { ...task().header, openInTerminal: { available: true, reason: null } } } });
  q.ready();
  await tick(); await tick();
  assert.equal(q.$('th-terminal').hasAttribute('aria-disabled'), false);
  assert.equal(q.$('th-terminal-why').textContent, 'From the Tasks page');
  q.$('th-terminal').click();
  await tick();
  assert.deepEqual(q.calls.filter(([k]) => k === 'tasks'), [['tasks', ID]]);
});

test('a terminal session\'s thread has no reply box and no Tasks items', async () => {
  const p = page({ open: { kind: 'session', header: { title: 'Claude session in billing', project: 'billing', bucket: 'working', origin: 'iTerm', ai: 'Claude', terminal: true, chatState: null, openInTerminal: null }, origin: 'iTerm', activity: { view: { events: [] } } } });
  p.ready();
  await tick(); await tick();
  assert.equal(p.$('th-reply').hidden, true);
  assert.equal(p.$('th-ended').hidden, true);
  assert.equal(p.$('th-tasks').hidden, true);
  assert.equal(p.$('th-terminal').hidden, true);
});

// ── R4-1a: stacked requests (plan-r4 §4, §11) ────────────────────────────

const ap = (n, over = {}) => ({ approvalId: `ap-${n}`, tool: 'Bash', inputSummary: `step ${n}`, ...over });
const ASK = { askId: 'ask-1', text: 'Which branch?', options: ['main', 'dev'], choices: null };
const ACTS = ['approve', 'deny', 'answer', 'stop', 'resume', 'message'];
const live = (over = {}) => task({ actions: ACTS, confirm: [], openApprovals: [ap(1), ap(2)], openAsk: ASK, ...over });
async function stacked(over = {}, responses = {}) {
  const clock = { t: 1_000_000 };
  const p = page({ open: live(over), ...responses }, { clock });
  p.ready();
  await tick(); await tick();
  const cards = () => [...p.w.document.querySelectorAll('#th-cards .th-card')];
  const btn = (card, label) => [...card.querySelectorAll('button')].find((b) => b.textContent === label);
  return { ...p, clock, cards, btn };
}
// The page's objects come from its own realm: compared as JSON.
const acts = (p) => p.calls.filter(([k]) => k === 'act').map(([, , req]) => JSON.parse(JSON.stringify(req)));

test('stacked: every pending request is its own card, approvals first then the question; R2a\'s card is not shown', async () => {
  const p = await stacked();
  const cards = p.cards();
  assert.deepEqual(cards.map((c) => c.dataset.key), ['approval:ap-1', 'approval:ap-2', 'ask:ask-1']);
  assert.equal(cards[0].querySelector('.th-card-title').textContent, 'Claude wants to use Bash');
  assert.equal(cards[0].querySelector('.th-card-what').textContent, 'step 1');
  assert.equal(cards[2].querySelector('.th-card-title').textContent, 'Claude has a question');
  assert.deepEqual([...cards[0].querySelectorAll('button')].map((b) => b.textContent), ['Allow once', 'Deny']);
  assert.deepEqual([...cards[2].querySelectorAll('button')].map((b) => b.textContent), ['main', 'dev']);
  assert.equal(p.$('th-waiting').hidden, true);
  assert.equal(p.$('th-bucket').textContent, 'Needs you');
});

test('stacked: every button waits 600 ms after its card appears, then works', async () => {
  const p = await stacked();
  assert.ok(p.cards().every((c) => [...c.querySelectorAll('button')].every((b) => b.disabled)));
  p.btn(p.cards()[0], 'Allow once').click();
  await tick();
  assert.deepEqual(acts(p), [], 'a click under the arm sends nothing');
  p.advance(600);
  assert.ok(p.cards().every((c) => [...c.querySelectorAll('button')].every((b) => !b.disabled)));
});

test('stacked: acting on A sends A only; while it is in flight every other card and the reply box wait; after it, they re-arm', async () => {
  let release;
  const p = await stacked({}, { act: () => new Promise((res) => { release = res; }) });
  p.advance(600);
  p.btn(p.cards()[0], 'Allow once').click();
  await tick();
  assert.deepEqual(acts(p), [{ action: 'approve', approvalId: 'ap-1', scope: 'once' }]);
  assert.ok([...p.cards()[1].querySelectorAll('button')].every((b) => b.disabled), 'B waits');
  assert.ok([...p.cards()[2].querySelectorAll('button')].every((b) => b.disabled), 'the question waits');
  assert.equal(p.$('th-reply-text').disabled, true, 'the reply box waits');
  p.btn(p.cards()[1], 'Deny').click();
  await tick();
  assert.equal(acts(p).length, 1, 'nothing else goes while A is in flight');
  release({ ok: true });
  await tick(); await tick();
  assert.equal(p.cards()[0].querySelector('.th-card-receipt').textContent, 'Allowed once');
  assert.ok(p.btn(p.cards()[1], 'Deny').disabled, 'B re-arms after A settles');
  p.advance(600);
  assert.equal(p.btn(p.cards()[1], 'Deny').disabled, false);
  p.btn(p.cards()[1], 'Deny').click();
  await tick(); await tick();
  assert.deepEqual(acts(p)[1], { action: 'deny', approvalId: 'ap-2' });
});

test('stacked: a refusal shows on its own card only, and keeps that card', async () => {
  const p = await stacked({}, { act: () => ({ ok: false, code: 'NOT_READY', text: 'This request changed. Look at it again, then choose.' }) });
  p.advance(600);
  p.btn(p.cards()[1], 'Allow once').click();
  await tick(); await tick();
  assert.equal(p.cards()[1].querySelector('.th-card-note').textContent, 'This request changed. Look at it again, then choose.');
  assert.equal(p.cards()[0].querySelector('.th-card-note'), null);
  assert.equal(p.cards()[2].querySelector('.th-card-note'), null);
  assert.equal(p.cards()[1].dataset.state, 'idle');
});

test('stacked: a done card collapses in place; when the next detail drops it, the cards below re-arm because they moved', async () => {
  const p = await stacked();
  p.advance(600);
  p.btn(p.cards()[0], 'Allow once').click();
  await tick(); await tick();
  p.advance(600);
  assert.deepEqual(p.cards().map((c) => c.dataset.key), ['approval:ap-1', 'approval:ap-2', 'ask:ask-1'], 'nothing moved under the pointer');
  assert.ok(p.cards()[0].classList.contains('th-card-done'));
  assert.equal(p.btn(p.cards()[1], 'Allow once').disabled, false);
  p.event({ id: ID, event: { type: 'detail', detail: live({ openApprovals: [ap(2)] }).detail } });
  assert.deepEqual(p.cards().map((c) => c.dataset.key), ['approval:ap-2', 'ask:ask-1']);
  assert.equal(p.btn(p.cards()[0], 'Allow once').disabled, true, 'B moved up, so it re-arms');
  p.advance(600);
  assert.equal(p.btn(p.cards()[0], 'Allow once').disabled, false);
});

test('stacked: a changed request re-arms itself only', async () => {
  const p = await stacked();
  p.advance(600);
  p.event({ id: ID, event: { type: 'detail', detail: live({ openApprovals: [ap(1), ap(2, { inputSummary: 'rm -rf /' })] }).detail } });
  assert.equal(p.btn(p.cards()[0], 'Allow once').disabled, false, 'A is unchanged');
  assert.equal(p.btn(p.cards()[1], 'Allow once').disabled, true, 'B changed');
  assert.equal(p.cards()[1].querySelector('.th-card-what').textContent, 'rm -rf /');
});

test('stacked: a late result for a card that has gone is dropped, never shown on another card', async () => {
  let release;
  const p = await stacked({}, { act: () => new Promise((res) => { release = res; }) });
  p.advance(600);
  p.btn(p.cards()[0], 'Allow once').click();
  await tick();
  p.event({ id: ID, event: { type: 'detail', detail: live({ openApprovals: [ap(2)] }).detail } });
  release({ ok: false, code: 'CONFLICT', text: 'Your answer may have been sent. Check the chat before choosing again.' });
  await tick(); await tick();
  assert.deepEqual(p.cards().map((c) => c.dataset.key), ['approval:ap-2', 'ask:ask-1']);
  assert.ok(p.cards().every((c) => !c.querySelector('.th-card-note') && !c.querySelector('.th-card-receipt')));
});

test('stacked: at most 10 approval cards, as main relays (11 or 12 handed in)', async () => {
  for (const n of [11, 12]) {
    const p = await stacked({ openApprovals: Array.from({ length: n }, (_, i) => ap(i + 1)), openAsk: null });
    const keys = p.cards().map((c) => c.dataset.key);
    assert.equal(keys.length, 10);
    assert.ok(!keys.includes('approval:ap-11'), 'the 11th is never drawn');
  }
});

test('stacked: a state event never shows a card; only a detail does (S5)', async () => {
  const p = await stacked({ openApprovals: [], openAsk: null });
  assert.equal(p.$('th-cards').hidden, true);
  p.event({ id: ID, event: { type: 'state', patch: { openApprovals: [ap(1)] } } });
  assert.equal(p.$('th-cards').hidden, true);
  p.event({ id: ID, event: { type: 'detail', detail: live({ openApprovals: [ap(1)], openAsk: null }).detail } });
  assert.equal(p.$('th-cards').hidden, false);
});

test('stacked: a crafted summary or question renders as text, never markup (C3 test 7)', async () => {
  const evil = '<img src=x onerror="window.pwned=1">‮gnp.exe';
  const p = await stacked({ openApprovals: [ap(1, { tool: '<b>Bash</b>', inputSummary: evil })], openAsk: { ...ASK, text: evil, options: [evil] } });
  assert.equal(p.w.document.querySelectorAll('#th-cards img, #th-cards b').length, 0);
  assert.equal(p.cards()[0].querySelector('.th-card-what').textContent, evil);
  assert.equal(p.cards()[1].querySelector('.th-card-text').textContent, evil);
});

test('reply box with a question open: it answers that askId, with the question placeholder; with approvals too it says so', async () => {
  const p = await stacked();
  assert.equal(p.$('th-reply').hidden, false);
  assert.equal(p.$('th-reply-text').placeholder, 'Type your answer to the question above');
  assert.equal(p.$('th-send').textContent, 'Send answer');
  p.$('th-reply-text').value = 'release/2';
  p.$('th-reply-text').dispatchEvent(new p.w.Event('input'));
  assert.equal(p.$('th-send').disabled, true, 'armed for 600 ms');
  p.advance(600);
  assert.equal(p.$('th-send').disabled, false);
  p.$('th-send').click();
  await tick(); await tick();
  assert.deepEqual(acts(p), [{ action: 'answer', askId: 'ask-1', answer: 'release/2' }]);
  assert.deepEqual(p.calls.filter(([k]) => k === 'message'), [], 'an answer, never a message to the AI');
  assert.equal(p.$('th-reply-text').value, '', 'sent, so cleared');
  const q = await stacked({ openApprovals: [] });
  assert.equal(q.$('th-reply-text').placeholder, 'Pick an option above, or type an answer');
});

test('reply box: a refused answer stays in the box; a changed question rebinds only after its own arm', async () => {
  const p = await stacked({ openApprovals: [] }, { act: () => ({ ok: false, code: 'BUSY', text: 'Still sending your last choice.' }) });
  p.advance(600);
  p.$('th-reply-text').value = 'dev please';
  p.$('th-reply-text').dispatchEvent(new p.w.Event('input'));
  p.$('th-send').click();
  await tick(); await tick();
  assert.equal(p.$('th-reply-text').value, 'dev please');
  assert.equal(p.$('th-reply-note').textContent, 'Still sending your last choice.');
  p.advance(600);
  p.event({ id: ID, event: { type: 'detail', detail: live({ openApprovals: [], openAsk: { ...ASK, askId: 'ask-2', text: 'Which remote?' } }).detail } });
  assert.equal(p.$('th-reply-text').value, 'dev please', 'the draft is kept');
  assert.equal(p.$('th-send').disabled, true, 'bound to the new question only after 600 ms');
  p.advance(600);
  p.$('th-send').click();
  await tick(); await tick();
  assert.deepEqual(acts(p).map((r) => r.askId), ['ask-1', 'ask-2'], 'each send names the askId the box was bound to');
});

test('reply box with approvals and no question: no box, or the draft kept and the box off, plural when several', async () => {
  const p = await stacked({ openAsk: null });
  assert.equal(p.$('th-reply').hidden, true);
  p.$('th-reply-text').value = 'later';
  p.$('th-reply-text').dispatchEvent(new p.w.Event('input'));
  p.event({ id: ID, event: { type: 'detail', detail: live({ openAsk: null }).detail } });
  assert.equal(p.$('th-reply').hidden, false);
  assert.equal(p.$('th-reply-text').disabled, true);
  assert.equal(p.$('th-reply-text').placeholder, 'Allow or deny the requests above to continue');
});

test('Stop: two steps, the second armed for 600 ms, then stop with confirmed only', async () => {
  const p = await stacked({ openApprovals: [], openAsk: null });
  assert.equal(p.$('th-stop').hidden, false);
  p.$('th-stop-btn').click();
  assert.equal(p.$('th-stop-confirm').hidden, false);
  assert.equal(p.$('th-stop-q').textContent, 'Stop this chat?');
  assert.equal(p.$('th-stop-yes').disabled, true);
  p.$('th-stop-yes').click();
  await tick();
  assert.deepEqual(acts(p), []);
  p.advance(600);
  p.$('th-stop-yes').click();
  await tick(); await tick();
  assert.deepEqual(acts(p), [{ action: 'stop', confirmed: true }]);
  const k = await stacked({ openApprovals: [], openAsk: null });
  k.$('th-stop-btn').click();
  k.$('th-stop-no').click();
  assert.equal(k.$('th-stop-confirm').hidden, true, 'Keep going');
  const none = await stacked({ actions: ['message'], openApprovals: [], openAsk: null });
  assert.equal(none.$('th-stop').hidden, true, 'only when the task offers stop');
});

test('task.confirm: the card asks again, armed for 600 ms, then sends confirmed', async () => {
  const p = await stacked({ confirm: ['approve'], openAsk: null });
  p.advance(600);
  p.btn(p.cards()[0], 'Allow once').click();
  await tick();
  assert.deepEqual(acts(p), []);
  assert.equal(p.cards()[0].querySelector('.th-card-ask').textContent, 'Allow this request?');
  assert.equal(p.btn(p.cards()[0], 'Allow').disabled, true);
  p.advance(600);
  p.btn(p.cards()[0], 'Allow').click();
  await tick(); await tick();
  assert.deepEqual(acts(p), [{ action: 'approve', approvalId: 'ap-1', scope: 'once', confirmed: true }]);
  p.advance(600);
  p.btn(p.cards()[1], 'Deny').click();
  await tick(); await tick();
  assert.deepEqual(acts(p)[1], { action: 'deny', approvalId: 'ap-2' }, 'deny is not in this task\'s confirm');
});

test('choices: a resume choice is one click by its id; a choice this chat can\'t make yet, and StartTask, go to Tasks', async () => {
  const p = await stacked({ openApprovals: [ap(1, { tool: 'StartTask', inputSummary: 'Ship the fix' })], actions: [...ACTS, 'switchAi'],
    openAsk: { askId: 'ask-1', text: 'Claude hit its usage limit.', options: null, choices: [{ id: 'wait_reset', label: 'Wait for the reset', action: 'resume', payload: { when: 'reset' } }, { id: 'switch_ai', label: 'Continue with Codex', action: 'switchAi', payload: { ai: 'codex' } }] } });
  const [start, ask] = p.cards();
  assert.equal(start.querySelector('.th-card-title').textContent, 'Waiting for you to accept this task');
  assert.deepEqual([...start.querySelectorAll('button')].map((b) => b.textContent), ['Open in Tasks']);
  assert.equal(ask.querySelector('.th-card-title').textContent, 'Claude needs you to choose');
  assert.deepEqual([...ask.querySelectorAll('button')].map((b) => b.textContent), ['Wait for the reset', 'Open in Tasks']);
  p.advance(600);
  p.btn(p.cards()[1], 'Wait for the reset').click();
  await tick(); await tick();
  assert.deepEqual(acts(p), [{ action: 'choose', askId: 'ask-1', choiceId: 'wait_reset' }], 'the id only, never the payload');
  p.btn(p.cards()[0], 'Open in Tasks').click();
  await tick();
  assert.deepEqual(p.calls.filter(([k]) => k === 'tasks'), [['tasks', ID]]);
  assert.equal(p.$('th-reply').hidden, true, 'a choices card has no free-text answer');
});

test('ALREADY_ANSWERED: the card says so and the page refreshes', async () => {
  const p = await stacked({ openAsk: null }, { act: () => ({ ok: false, code: 'ALREADY_ANSWERED', text: 'x' }) });
  p.advance(600);
  p.btn(p.cards()[0], 'Deny').click();
  await tick(); await tick();
  assert.equal(p.cards()[0].querySelector('.th-card-receipt').textContent, 'Already answered');
  assert.ok(p.calls.some(([k]) => k === 'state'));
});
