'use strict';
// The team sessions overview with the shared-workspace helpers loaded: the
// doing-now line and four-step freshness, pins and saved views, follow events,
// Ask templates drafting into the reviewed composer, presence chips and the
// ⌘K palette index. Same real bridge/IPC/fake-hub stack as overview-directory.test.js.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createInteractionMain } = require('../src/interaction-main');
const { createOverviewMain } = require('../src/overview-main');
const { createFakeTeamHub } = require('../src/team-hub-fake');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('overview.html'), bridge = read('overview-preload.js');
const SCRIPTS = ['src/work-organise.js', 'src/session-pulse.js', 'src/session-pins.js', 'src/session-follow.js', 'src/request-templates.js', 'src/session-presence.js', 'src/command-palette.js', 'overview-directory.js', 'overview.js', 'palette.js'].map(read);
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const FIXTURE = {
  viewer: 'u-me', users: { 'u-me': 'Me', 'u-bob': 'Bob', 'u-cara': 'Cara' },
  teams: [{ id: 't-dev', name: 'Dev team', members: ['u-me', 'u-bob', 'u-cara'] }],
  sessions: [
    { ref: 'bob-1', owner: 'u-bob', provider: { id: 'claude', label: 'Claude Code' }, device: { label: 'Bob’s PC' }, card: { key: 'DEV-7', title: 'Fix login', edited_by: 'human' }, task_title: 'agent title', state: 'working', observed_ago_ms: 2000, capabilities: { interrupt: true }, children: [], shares: [{ team: 't-dev', scope: 'interact' }] },
    { ref: 'cara-1', owner: 'u-cara', provider: { id: 'codex', label: 'Codex' }, device: { label: 'Cara’s Mac' }, task_title: 'Write docs', state: 'idle', observed_ago_ms: 11 * 60_000, shares: [{ team: 't-dev', scope: 'watch' }] },
    { ref: 'bob-private', owner: 'u-bob', provider: { id: 'cursor', label: 'Cursor' }, device: { label: 'Bob’s PC' }, task_title: 'PRIVATE side project', state: 'working', observed_ago_ms: 1000, shares: [] },
  ],
};

function stack() {
  const teamHub = createFakeTeamHub(structuredClone(FIXTURE));
  const handlers = new Map(), listeners = new Map();
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true };
  const contents = { id: 9, isDestroyed: () => false, mainFrame: {}, send: (ch, ...a) => { for (const fn of listeners.get(ch) ?? []) fn({}, ...structuredClone(a)); } };
  const ctx = { window: win, contents, generation: 1, document: 1, foreground: true };
  const buddy = { overviewContext: () => ctx, overviewReadContext: () => ctx };
  const interaction = createInteractionMain({ context: () => ctx, readContext: () => ctx, adapters: {}, owned: null, localModels: null, workspace: (id) => `/tmp/x-${id.slice(-4)}`, currentBoard: () => 'local' });
  interaction.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const overview = createOverviewMain({ buddy: () => buddy, sessions: () => [], work: async () => ({ sources: [], capture: [] }), now: () => Date.now(), owned: () => interaction.listOwned(), shares: () => ({ origin: 'https://hub.example', list: [] }), hubTeams: async () => ({ origin: 'https://hub.example', teams: [] }), teamHub: () => teamHub });
  overview.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  teamHub.onChange(() => overview.directoryChanged());
  let api;
  vm.runInNewContext(bridge, { Buffer, Promise, require: () => ({ contextBridge: { exposeInMainWorld(_n, v) { api = v; } }, ipcRenderer: {
    invoke: async (ch, ...args) => { const fn = handlers.get(ch); assert.ok(fn, `no handler ${ch}`); return structuredClone(await fn({ sender: contents, senderFrame: contents.mainFrame }, ...structuredClone(args))); },
    on: (ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, new Set()); listeners.get(ch).add(fn); }, removeListener: () => {},
  } }) });
  let ready;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://plexiform.test/overview.html' });
  const intervals = [];
  dom.window.setInterval = (fn) => intervals.push(fn);
  dom.window.overviewApi = { ...api, onReady: (fn) => { ready = fn; return () => {}; } };
  for (const s of SCRIPTS) dom.window.eval(s);
  const doc = dom.window.document, $ = (id) => doc.getElementById(id);
  const rows = () => [...$('team-list').querySelectorAll('.dir-entry')];
  const row = (re) => rows().find((r) => re.test(r.textContent));
  return { dom, doc, $, rows, row, teamHub, ready: async () => { ready(); await tick(); }, poll: async () => { for (const fn of intervals) fn(); await tick(); }, team: async () => { $('tab-team').click(); await tick(); }, close: () => { overview.close(); interaction.close(); dom.window.close(); } };
}

test('team sessions: doing-now line with four-step freshness; stale sessions cannot be asked', async () => {
  const s = stack();
  try {
    await s.ready(); await s.team();
    const bob = s.row(/Fix login/), cara = s.row(/Write docs/);
    assert.ok(bob && cara, 'both shared rows');
    assert.equal(s.row(/PRIVATE/), undefined, 'private session never listed');
    assert.equal(bob.dataset.pulse, 'fresh');
    assert.match(bob.querySelector('.dir-pulse').textContent, /^Working on DEV-7 Fix login · \d+s ago$|^Working.* · \d+s ago$/);
    assert.equal(cara.dataset.pulse, 'stale');
    assert.match(cara.querySelector('.dir-pulse').textContent, /^Idle · 11m ago$/);
    const ask = bob.querySelector('.session-ask'); assert.ok(ask, 'Ask menu on an interact-shared row'); assert.equal(ask.disabled, false);
    const caraAsk = cara.querySelector('.session-ask'); assert.ok(caraAsk.closest('.ask-menu').hidden || caraAsk.disabled, 'watch-only or stale rows cannot ask');
    assert.match(cara.querySelector('.session-message')?.title || '', /over ten minutes|^$/);
  } finally { s.close(); }
});

test('team sessions: Ask drafts the exact template into the reviewed composer and shows a receipt; nothing is sent by the template itself', async () => {
  const s = stack();
  try {
    await s.ready(); await s.team();
    const bob = s.row(/Fix login/);
    bob.querySelector('.session-ask').click();
    const item = [...bob.querySelectorAll('.ask-list button')].find((b) => b.textContent === 'Status update');
    item.click(); await tick(10);
    const composer = s.doc.querySelector('.team-activity textarea, .composer textarea');
    assert.ok(composer, 'a composer opened');
    assert.match(composer.value, /short status update/);
    assert.match(bob.querySelector('.ask-receipt').textContent, /Status update:Drafted · review and send/);
    assert.deepEqual(s.teamHub.sent?.() ?? [], [], 'the fake hub received nothing');
  } finally { s.close(); }
});

test('team sessions: pins sort to the top and persist; saved views restore filters; follow records one event per transition', async () => {
  const s = stack();
  try {
    await s.ready(); await s.team();
    const cara = s.row(/Write docs/);
    assert.equal(s.rows()[0], s.row(/Fix login/), 'attention/fresh first by default');
    cara.querySelector('.session-pin').click(); await tick();
    assert.equal(s.rows()[0].dataset.pinned, 'true');
    assert.match(s.rows()[0].textContent, /Write docs/);
    assert.match(s.dom.window.localStorage.getItem('plexiform.pins'), /Cara/);
    s.$('team-search').value = 'docs'; s.$('team-search').dispatchEvent(new s.dom.window.Event('input')); await tick();
    s.$('saved-filter-name').value = 'Docs work'; [...s.$('saved-filters').querySelectorAll('button')].find((b) => b.textContent === 'Save filters').click(); await tick();
    s.$('team-clear-filters').click(); await tick();
    assert.equal(s.$('team-search').value, '');
    [...s.$('saved-filters').querySelectorAll('button')].find((b) => b.textContent === 'Docs work').click(); await tick();
    assert.equal(s.$('team-search').value, 'docs');
    s.$('team-clear-filters').click(); await tick();
    const bob = s.row(/Fix login/);
    bob.querySelector('.session-follow').click(); await tick();
    assert.equal(bob.querySelector('.session-follow').getAttribute('aria-pressed'), 'true');
    s.teamHub.update?.('bob-1', { state: 'input' }); await s.poll(); await s.poll();
    const follows = JSON.parse(s.dom.window.localStorage.getItem('plexiform.follows'));
    assert.equal(follows.events.filter((e) => e.transition === 'attention').length, 1);
    await s.poll();
    assert.equal(JSON.parse(s.dom.window.localStorage.getItem('plexiform.follows')).events.length, 1, 'no duplicate event');
  } finally { s.close(); }
});

test('team sessions: ⌘K palette indexes only listed work and opens the exact row', async () => {
  const s = stack();
  try {
    await s.ready(); await s.team();
    s.doc.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    assert.equal(s.$('palette').hidden, false);
    assert.equal(s.doc.activeElement, s.$('palette-input'));
    s.$('palette-input').value = 'login'; s.$('palette-input').dispatchEvent(new s.dom.window.Event('input'));
    const first = s.$('palette-list').querySelector('.palette-item');
    assert.match(first.textContent, /Fix login/);
    assert.equal(s.$('palette-list').textContent.includes('PRIVATE'), false);
    s.$('palette-input').dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(8);
    assert.equal(s.$('palette').hidden, true);
    assert.ok(s.doc.querySelector('.team-activity'), 'the exact session’s activity opened');
  } finally { s.close(); }
});
