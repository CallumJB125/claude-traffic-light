'use strict';
// Home with the Inbox and tour scripts loaded: rows come only from parts main
// already sends Home, each with one action; the tour shows once per account.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('home.html');
const SCRIPTS = ['src/work-organise.js', 'src/attention-inbox.js', 'src/session-follow.js', 'src/teammate-tour.js', 'home.js', 'home-inbox-view.js'].map(read);
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const NOW = Date.UTC(2026, 9, 18, 12);
const state = { observed_at: NOW, banner: null, needs: { total: 1, items: [{ headline: 'Allow git push?', kind: 'permission', project: 'app', age: '2 min', late: false }] }, running: { quiet: 0, items: [] }, today: { spend: null, longestWaitMs: null }, team: null, morning: { count: 1, costUsd: 0, items: [{ title: 'Nightly tests', state: 'failed', summary: 'exit 1' }], asks: [], more: 0 } };

function setup({ calls = [], storage = {}, st = state, answerInput = null, teamInbox = null, inboxRead = null } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://plexiform.test/home.html' });
  for (const [k, v] of Object.entries(storage)) dom.window.localStorage.setItem(k, v);
  const intervals = []; dom.window.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  dom.window.homeApi = {
    ...(answerInput ? { answerInput } : {}), ...(teamInbox ? { teamInbox } : {}), ...(inboxRead ? { inboxRead } : {}),
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
    assert.equal(s.$('tour-title').textContent, 'Inbox', 'step 1 describes the Inbox, so it is called that');
    const next = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Next');
    next.click(); next.click(); next.click();
    assert.match(s.$('tour-title').textContent, /Find a shared session and ask/);
    assert.equal(next.textContent, 'Done'); next.click();
    assert.equal(s.doc.querySelector('.tour'), null);
    assert.equal(JSON.parse(s.dom.window.localStorage.getItem('plexiform.tour')).done.local > 0, true);
  } finally { s.close(); }
});

test('Home tour (A5): one tour at a time; waits for a settled team and for the widget tour, done when that one is skipped', async () => {
  const fire = (s, detail) => s.doc.dispatchEvent(new s.dom.window.CustomEvent('home:state', { detail }));
  const unsettled = setup({ st: { ...state, team: undefined } });
  try {
    await tick(12);
    assert.equal(unsettled.doc.querySelector('.tour'), null, 'no decision before Home has asked about the team');
    fire(unsettled, { ...state, team: null, firstRunTour: 'running' });
    assert.equal(unsettled.doc.querySelector('.tour'), null, 'the widget tour is running: Home waits');
    fire(unsettled, { ...state, team: null, firstRunTour: 'finished' });
    assert.equal(unsettled.doc.querySelectorAll('[role="dialog"]').length, 1, 'then exactly one tour');
    fire(unsettled, { ...state, team: null, firstRunTour: 'running' });
    assert.equal(unsettled.doc.querySelector('.tour'), null, 'a widget tour started again: Home steps aside');
    assert.equal(unsettled.dom.window.localStorage.getItem('plexiform.tour'), null, 'stepping aside is not a dismissal');
  } finally { unsettled.close(); }
  const skipped = setup({ st: { ...state, firstRunTour: 'skipped' } });
  try {
    await tick(12);
    assert.equal(skipped.doc.querySelector('.tour'), null, 'skipping the widget tour skips this one');
    assert.ok(JSON.parse(skipped.dom.window.localStorage.getItem('plexiform.tour')).done.local > 0, 'and it is remembered');
  } finally { skipped.close(); }
  const esc = setup();
  try {
    await tick(12);
    esc.doc.querySelector('.tour-dialog').dispatchEvent(new esc.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(esc.doc.querySelector('.tour'), null, 'Esc dismisses');
    fire(esc, { ...state, team: { account: 'acct-1' } });
    assert.equal(esc.doc.querySelector('.tour'), null, 'a dismissal before the account was known still holds once it is');
  } finally { esc.close(); }
});

test('Home Inbox: a wait with simple options is a quick decision card; a click answers by request id and option id', async () => {
  const quick = { ...state, needs: { total: 1, items: [{ id: 'req-9', headline: 'Allow git push?', kind: 'permission', project: 'app', age: '2 min', late: false, action: 'answer', options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }] } };
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

test('Home Inbox: hub inbox rows render with Open and Mark read; Mark read sends the row keys and reloads; the badge-free list drops the row', async () => {
  const calls = [];
  let rows = [
    { kind: 'mention', title: 'Ana mentioned you: Fix login', meta: 'Core', ageMs: 5 * 60_000, action: { kind: 'navigate', destination: 'overview', label: 'Open' }, read: { kind: 'inbox-read', ids: ['https://hub.test:i1'] }, key: 'team:https://hub.test:i1' },
    { kind: 'handoff', title: 'Ben handed you a card: Retries', meta: 'Core', ageMs: 60_000, action: { kind: 'navigate', destination: 'sessions', label: 'Open' }, read: { kind: 'inbox-read', ids: ['https://hub.test:i2'] }, key: 'team:https://hub.test:i2' },
  ];
  const s = setup({ calls, storage: { 'plexiform.tour': JSON.stringify({ done: { local: 1 } }) }, teamInbox: async () => rows, inboxRead: async (ids) => { calls.push(['inbox-read', ids]); rows = rows.filter((r) => !ids.includes(r.read.ids[0])); return { ok: true, read: ids.length }; } });
  try {
    await tick(12);
    const li = [...s.$('inbox').querySelectorAll('li')];
    assert.deepEqual(li.map((r) => r.dataset.kind).sort(), ['approval', 'blocker', 'failed', 'handoff', 'handoff', 'mention']);
    const mention = li.find((r) => r.dataset.kind === 'mention');
    assert.match(mention.textContent, /Ana mentioned you: Fix login/);
    assert.ok(mention.querySelector('.tag.team'), 'team rows carry the team tag');
    const buttons = [...mention.querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(buttons, ['Open', 'Mark read']);
    mention.querySelectorAll('button')[0].click(); await tick();
    assert.deepEqual(calls.at(-1), ['navigate', 'overview']);
    const handoff = li.filter((r) => r.dataset.kind === 'handoff').find((r) => /Ben handed/.test(r.textContent));
    handoff.querySelectorAll('button')[0].click(); await tick();
    assert.deepEqual(calls.at(-1), ['navigate', 'sessions']);
    mention.querySelectorAll('button')[1].click(); await tick(10);
    assert.deepEqual(calls.find((c) => c[0] === 'inbox-read'), ['inbox-read', ['https://hub.test:i1']]);
    assert.doesNotMatch(s.$('inbox').textContent, /Ana mentioned you/);
    assert.equal(s.$('inbox-count').textContent, '5 items');
    assert.equal([...s.$('inbox').querySelectorAll('li')].find((r) => /Ana handed/.test(r.textContent)).querySelectorAll('button').length, 1, 'team-today handoffs have no Mark read');
  } finally { s.close(); }
});
