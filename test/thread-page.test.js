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
  assert.equal(p.w.document.activeElement, p.$('th-copy'));
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
