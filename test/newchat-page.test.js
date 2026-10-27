'use strict';
// Redesign R2b-2: the new-chat page's own logic (newchat.js) with a fake bridge. Electron renders it for real in
// test-visual/newchat.spec.js. Nothing starts before Send or ⌘↩; Enter is a newline; the page never names a thread.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'newchat.html'), 'utf8').replace(/<script[^]*?<\/script>/g, '');
const scripts = ['src/compose-view.js', 'newchat.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
const open = [];
test.afterEach(() => { while (open.length) open.pop().close(); });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const FOLDER = { handle: 'h-1', label: 'acme' };

function page(over = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///app/newchat.html' });
  const w = dom.window;
  open.push(w);
  const calls = [];
  let changed = null;
  w.newChatApi = {
    info: async () => { calls.push(['info']); return over.info ?? { hidden: false, connected: true, ais: [{ id: 'claude', label: 'Claude', usable: true }], folder: FOLDER, recent: [], shortcut: null, task: null }; },
    pickFolder: async () => null,
    route: async (req) => { calls.push(['route', req]); return { ok: true, route: { decision: 'run', ai: 'claude', reason: 'Claude: it fits this task', alternatives: [] } }; },
    preflight: async (folder) => { calls.push(['preflight', folder]); return over.preflight ?? { ok: true, preflight: { peers: [], key: 'k0' } }; },
    create: async (draft) => { calls.push(['create', draft]); return typeof over.create === 'function' ? over.create(draft) : (over.create ?? { ok: true, id: 't1', opened: true }); },
    openInTasks: async (id) => { calls.push(['tasks', id]); return true; },
    onChanged: (cb) => { changed = cb; },
  };
  for (const s of scripts) w.eval(s);
  const $ = (id) => w.document.getElementById(id);
  const type = async (text) => { const ta = $('nc-text'); ta.value = text; ta.dispatchEvent(new w.Event('input')); await tick(450); };
  const key = (k, mods = {}) => $('nc-text').dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
  return { w, $, calls, type, key, changed: () => changed() };
}
const creates = (p) => p.calls.filter(([k]) => k === 'create');

test('the screen: heading, hint, the box focused, folder and AI chips, Send disabled until there is something to send', async () => {
  const p = page();
  await tick(10);
  assert.equal(p.$('nc-title').textContent, 'New chat');
  assert.match(p.$('nc-hint').textContent, /Nothing starts until you press Send/);
  assert.equal(p.w.document.activeElement, p.$('nc-text'));
  assert.equal(p.$('nc-folder').value, 'h-1');
  assert.deepEqual([...p.$('nc-who').options].map((o) => o.textContent), ['Choose for me', 'Claude']);
  assert.equal(p.$('nc-send').disabled, true);
  assert.equal(p.$('nc').getAttribute('aria-busy'), 'false');
  await p.type('add a dark mode toggle');
  assert.equal(p.$('nc-send').disabled, false);
  assert.match(p.$('nc-route').textContent, /Claude/);
});

test('nothing starts without Send or ⌘↩: typing, Enter, chip changes and a push create nothing', async () => {
  const p = page();
  await tick(10);
  await p.type('add a dark mode toggle');
  p.key('Enter');
  p.key('Enter', { shiftKey: true });
  p.$('nc-perm').value = 'plan'; p.$('nc-perm').dispatchEvent(new p.w.Event('change'));
  p.changed();
  await tick(450);
  assert.equal(creates(p).length, 0);
  p.key('Enter', { metaKey: true });
  await tick(10);
  assert.equal(creates(p).length, 1);
});

test('Send sends Home\'s draft shape only: the folder handle, no path, no task id, no confirmed flag', async () => {
  const p = page();
  await tick(10);
  await p.type('add a dark mode toggle');
  p.$('nc-send').click();
  await tick(10);
  const [, draft] = creates(p)[0];
  assert.deepEqual(Object.keys(draft).sort(), ['ai', 'expectAi', 'folder', 'peersKey', 'permissionLevel', 'requestId', 'text']);
  assert.equal(draft.folder, 'h-1');
  assert.equal(draft.expectAi, 'claude');
});

test('opened: main moved to the thread; the page clears its draft and shows nothing of its own', async () => {
  const p = page();
  await tick(10);
  await p.type('add a dark mode toggle');
  p.$('nc-send').click();
  await tick(10);
  assert.equal(p.$('nc-text').value, '');
  assert.equal(p.$('nc-started').hidden, true);
});

test('not yet listed: "Started." with Open in Tasks for that id; New chat gives a fresh box', async () => {
  const p = page({ create: { ok: true, id: 't7' } });
  await tick(10);
  await p.type('add a dark mode toggle');
  p.$('nc-send').click();
  await tick(10);
  assert.equal(p.$('nc-started').hidden, false);
  assert.equal(p.$('nc-box').hidden, true);
  assert.equal(p.$('nc-started-title').textContent, 'Started.');
  p.$('nc-open').click();
  await tick(1);
  assert.deepEqual(p.calls.filter(([k]) => k === 'tasks'), [['tasks', 't7']]);
  p.$('nc-again').click();
  assert.equal(p.$('nc-box').hidden, false);
  assert.equal(p.$('nc-started').hidden, true);
});

test('sending, started elsewhere, moved and a guard error each say so; the box locks while sending', async () => {
  let release;
  const p = page({ create: () => new Promise((r) => { release = r; }) });
  await tick(10);
  await p.type('add a dark mode toggle');
  p.$('nc-send').click();
  await tick(1);
  assert.equal(p.$('nc-send').textContent, 'Starting…');
  assert.equal(p.$('nc-text').disabled, true);
  p.$('nc-send').click(); p.key('Enter', { metaKey: true });
  await tick(1);
  assert.equal(creates(p).length, 1, 'one at a time from the page too');
  release({ ok: false, code: 'STARTED_ELSEWHERE', id: 't1', text: "Started. It's in Tasks." });
  await tick(10);
  assert.equal(p.$('nc-note').textContent, "Started. It's in Tasks.");
  assert.equal(p.$('nc-text').value, '');

  const moved = 'The new chat changed while that was being checked. Nothing was started. Look again, then press Send.';
  const m = page({ create: { ok: false, code: 'CONFLICT', text: moved } });
  await tick(10); await m.type('x y'); m.$('nc-send').click(); await tick(10);
  assert.equal(m.$('nc-note').textContent, moved);
  assert.equal(m.$('nc-note').dataset.tone, 'error');

  const c = page({ create: { ok: false, code: 'CONFIRM_REQUIRED', cancelled: true, text: '' } });
  await tick(10); await c.type('x y'); c.$('nc-send').click(); await tick(10);
  assert.equal(c.$('nc-note').textContent, 'Nothing was started.');

  const e = page({ create: { ok: false, code: 'VALIDATION', text: 'Check the task text and folder.' } });
  await tick(10); await e.type('x y'); e.$('nc-send').click(); await tick(10);
  assert.equal(e.$('nc-note').textContent, 'Check the task text and folder.');
});

test('peers: the card shows above Send, and Send waits for Start anyway', async () => {
  const p = page({ preflight: { ok: true, preflight: { peers: [{ id: 'p1' }], key: 'k1' } } });
  await tick(10);
  await p.type('add a dark mode toggle');
  assert.match(p.$('nc-peers').textContent, /1 other task is working in this project/);
  assert.equal(p.$('nc-send').disabled, true);
  p.$('nc-ack').click();
  assert.equal(p.$('nc-send').disabled, false);
});

test('a chat this document started that isn\'t listed yet comes back as "Started." after a reload', async () => {
  const p = page({ info: { hidden: false, connected: true, ais: [], folder: FOLDER, recent: [], task: { id: 't3', title: 'x', row: null } } });
  await tick(10);
  assert.equal(p.$('nc-started').hidden, false);
});
