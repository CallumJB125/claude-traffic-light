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

function page(responses) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  open.push(w);
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
    board: () => calls.push(['board']),
    onReady: (cb) => { ready = cb; },
    onEvent: (cb) => { onEvent = cb; },
  };
  for (const s of scripts) w.eval(s);
  const $ = (id) => w.document.getElementById(id);
  return { w, $, calls, ready: (id = ID) => ready(id), event: (m) => onEvent(m) };
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
