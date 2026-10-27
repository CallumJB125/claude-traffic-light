'use strict';
// Home's task box page (home-compose.js) when main says the task started but Home changed meanwhile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const pages = [];
// The page keeps a 30 s repaint timer for the running card: close each page so the process can exit.
test.after(() => pages.forEach((d) => d.window.close()));

async function open(runReply, { draft = null, stored = '' } = {}) {
  const dom = new JSDOM('<section id="compose" hidden><div class="body"></div><p id="compose-hint"></p><p id="compose-status"></p></section>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  pages.push(dom);
  const w = dom.window, runs = [];
  if (stored) w.sessionStorage.setItem('plexiform.compose.draft', stored);
  const folder = { handle: 'h-1', label: '~/work' };
  w.composeApi = {
    info: async () => ({ connected: true, folder, recent: [], ais: [{ id: 'claude', label: 'Claude', installed: true, loggedIn: true, tasks: true }], task: null, draft, shortcut: { state: 'off' } }),
    route: async () => ({ ok: true, route: { decision: 'run', ai: 'claude', reason: 'Claude: your default', alternatives: [] } }),
    preflight: async () => ({ ok: true, preflight: { peers: [], key: 'k' } }),
    run: async (d) => { runs.push(d); return runReply; },
    pickFolder: async () => null, stop: async () => ({ ok: true }), openInTasks: async () => true,
    onFocus() {}, onEvent() {}, onTask() {}, onChanged() {},
  };
  w.homeApi = { navigate() {} };
  w.eval(read('src/compose-view.js')); w.eval(read('home-compose.js'));
  await tick(20);
  return { w, doc: w.document, runs };
}

test('task started but Home changed: the draft is cleared, Run stays off for that text, no duplicate can start', async () => {
  const { w, doc, runs } = await open({ ok: false, code: 'STARTED_ELSEWHERE', id: 't1', text: "Started. It's in Tasks." });
  const ta = doc.getElementById('compose-text');
  ta.value = 'fix the flaky login test'; ta.dispatchEvent(new w.Event('input'));
  await tick(500);
  const run = doc.getElementById('compose-run');
  assert.equal(run.disabled, false);
  run.click();
  await tick(20);
  assert.equal(runs.length, 1);
  assert.equal(ta.value, '');
  assert.equal(w.sessionStorage.getItem('plexiform.compose.draft'), '');
  assert.equal(doc.getElementById('compose-run').disabled, true);
  assert.equal(doc.getElementById('compose-status').textContent, "Started. It's in Tasks.");
  assert.equal(doc.getElementById('compose-card').hidden, true, 'no card: Home does not own the task');
  ta.value = 'a second task'; ta.dispatchEvent(new w.Event('input'));
  await tick(500);
  assert.equal(doc.getElementById('compose-run').disabled, false, 'the next task can run');
  assert.equal(runs.length, 1);
});

test('a prompt from Sessions fills an empty box, picks its folder, and waits: nothing runs until Run', async () => {
  const draft = { text: 'fix the bug', folder: { handle: 'h-9', label: '~/app' }, ai: 'claude' };
  const { doc, runs } = await open({ ok: true, id: 't1' }, { draft });
  assert.equal(doc.getElementById('compose-text').value, 'fix the bug');
  assert.equal(doc.getElementById('compose-folder').value, 'h-9');
  assert.match(doc.getElementById('compose-status').textContent, /Press Run/);
  await tick(500);
  assert.equal(runs.length, 0);
  assert.equal(doc.getElementById('compose-run').disabled, false);
});
test('a prompt from Sessions never replaces text already in the box', async () => {
  const draft = { text: 'fix the bug', folder: { handle: 'h-9', label: '~/app' }, ai: 'claude' };
  const { doc, runs } = await open({ ok: true, id: 't1' }, { draft, stored: 'my own draft' });
  assert.equal(doc.getElementById('compose-text').value, 'my own draft');
  assert.equal(doc.getElementById('compose-folder').value, 'h-1');
  assert.match(doc.getElementById('compose-status').textContent, /already has one/);
  assert.equal(runs.length, 0);
});
