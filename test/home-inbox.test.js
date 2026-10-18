'use strict';
// Home with the Inbox and tour scripts loaded: rows come only from parts main
// already sends Home, each with one action; the tour shows once per account.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('home.html');
const SCRIPTS = ['src/attention-inbox.js', 'src/session-follow.js', 'src/teammate-tour.js', 'home.js', 'home-inbox-view.js'].map(read);
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const NOW = Date.UTC(2026, 9, 18, 12);
const state = { observed_at: NOW, banner: null, needs: { total: 1, items: [{ headline: 'Allow git push?', kind: 'permission', project: 'app', age: '2 min', late: false }] }, running: { quiet: 0, items: [] }, today: { spend: null, longestWaitMs: null }, team: null, morning: { count: 1, costUsd: 0, items: [{ title: 'Nightly tests', state: 'failed', summary: 'exit 1' }], asks: [], more: 0 } };

function setup({ calls = [], storage = {}, st = state, answerInput = null } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://plexiform.test/home.html' });
  for (const [k, v] of Object.entries(storage)) dom.window.localStorage.setItem(k, v);
  const intervals = []; dom.window.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  dom.window.homeApi = {
    ...(answerInput ? { answerInput } : {}),
    state: async () => st, navigate: async (d) => { calls.push(['navigate', d]); return true; }, openCard: async () => true,
    alerts: async () => ({ stuck: [{ handle: 'h-stuck', title: 'Stuck: app silent for 12 min', meta: 'Codex', canOpen: true, canHand: true }], limits: [], mail: [] }),
    alertAct: async (kind, op, handle) => { calls.push(['alert', kind, op, handle]); return { ok: true }; },
    teamToday: async () => ({ people: { items: [], more: 0 }, changes: { items: [{ kind: 'handoff', text: 'Ana handed "Fix login" to the team', repo: 'app', team: 'Core', at: new Date(NOW - 60_000).toISOString() }], more: 0 }, overlaps: { items: [], more: 0 } }),
  };
  for (const s of SCRIPTS) dom.window.eval(s);
  const doc = dom.window.document;
  return { dom, doc, calls, $: (id) => doc.getElementById(id), close: () => dom.window.close() };
}

test('Home Inbox: approvals, blockers, failures and handoffs in one ordered list with one action each', async () => {
  const s = setup();
  try {
    await tick(12);
    assert.equal(s.$('inbox').hidden, false);
    const rows = [...s.$('inbox').querySelectorAll('li')];
    assert.deepEqual(rows.map((r) => r.dataset.kind), ['approval', 'blocker', 'failed', 'handoff']);
    assert.equal(s.$('inbox-count').textContent, '4 items');
    rows[0].querySelector('button').click(); await tick();
    assert.deepEqual(s.calls.at(-1), ['navigate', 'waiting']);
    rows[1].querySelector('button').click(); await tick(8);
    assert.deepEqual(s.calls.find((c) => c[0] === 'alert'), ['alert', 'stuck', 'open', 'h-stuck']);
    assert.doesNotMatch(read('home-inbox-view.js'), /innerHTML/);
  } finally { s.close(); }
});

test('Home Inbox: followed-session events from the Sessions page appear until marked seen; ⌘K goes to shared sessions', async () => {
  const follows = JSON.stringify({ follows: [], events: [{ key: 'k', transition: 'attention', at: NOW - 30_000, title: 'Retries', owner: 'Ben', seen: false }] });
  const s = setup({ storage: { 'plexiform.follows': follows, 'plexiform.tour': JSON.stringify({ done: { local: 1 } }) } });
  try {
    await tick(12);
    assert.match(s.$('inbox').textContent, /Ben's "Retries" needs input/);
    [...s.$('inbox').querySelectorAll('button')].find((b) => /Mark followed sessions as seen/.test(b.textContent)).click(); await tick();
    assert.doesNotMatch(s.$('inbox').textContent, /Retries/);
    assert.equal(JSON.parse(s.dom.window.localStorage.getItem('plexiform.follows')).events[0].seen, true);
    s.doc.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    assert.deepEqual(s.calls.at(-1), ['navigate', 'overview']);
    assert.equal(s.doc.querySelector('.tour'), null, 'tour already done for this account');
  } finally { s.close(); }
});

test('Home tour: shown once for a new account, labelled, four steps, dismissal persists', async () => {
  const s = setup();
  try {
    await tick(12);
    const dialog = s.doc.querySelector('.tour-dialog');
    assert.ok(dialog, 'tour shown'); assert.equal(dialog.getAttribute('role'), 'dialog'); assert.equal(dialog.getAttribute('aria-labelledby'), 'tour-title');
    assert.equal(s.$('tour-title').textContent, 'Home');
    const next = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Next');
    next.click(); next.click(); next.click();
    assert.match(s.$('tour-title').textContent, /Find a shared session and ask/);
    assert.equal(next.textContent, 'Done'); next.click();
    assert.equal(s.doc.querySelector('.tour'), null);
    assert.equal(JSON.parse(s.dom.window.localStorage.getItem('plexiform.tour')).done.local > 0, true);
  } finally { s.close(); }
});

test('Home Inbox: a wait with simple options is a quick decision card; a click answers by request id and option id', async () => {
  const quick = { ...state, needs: { total: 1, items: [{ id: 'req-9', headline: 'Allow git push?', kind: 'permission', project: 'app', age: '2 min', late: false, options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }] } };
  const calls = [];
  const s = setup({ calls, st: quick, answerInput: async (id, optionId) => { calls.push(['answer', id, optionId]); return { ok: true }; } });
  try {
    await tick(12);
    const row = s.$('inbox').querySelector('li[data-kind="approval"]');
    const quickButtons = [...row.querySelectorAll('button.quick-option')];
    assert.deepEqual(quickButtons.map((b) => b.textContent), ['Allow once', 'Deny']);
    assert.ok(quickButtons[0].classList.contains('primary'));
    assert.equal([...row.querySelectorAll('button')].at(-1).textContent, 'Answer', 'fallback stays');
    quickButtons[1].click(); await tick(8);
    assert.deepEqual(s.calls.find((c) => c[0] === 'answer'), ['answer', 'req-9', 'deny']);
    assert.equal(s.$('inbox-status').textContent, 'Answered.');
  } finally { s.close(); }
});
