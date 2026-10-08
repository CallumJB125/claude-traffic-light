'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Home = require('../src/home-main.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'home.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'home.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const NOW = Date.parse('2026-10-07T10:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const tool = (id, label, installed, connected) => ({ id, label, installed, connected, state: !installed ? 'missing' : connected ? 'connected' : 'ready' });

function setup(states, calls = []) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const intervals = [];
  dom.window.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  let n = 0;
  dom.window.homeApi = {
    state: async () => states[Math.min(n++, states.length - 1)],
    navigate: async (d) => { calls.push(['navigate', d]); return true; },
    openCard: async (h) => { calls.push(['open', h]); return true; },
  };
  dom.window.eval(script);
  const document = dom.window.document;
  const section = (id) => document.getElementById(id);
  return { dom, document, intervals, section, close: () => dom.window.close() };
}
const fresh = { observed_at: NOW, banner: Home.banner([tool('claude', 'Claude Code', false, false), tool('codex', 'Codex', false, false)]), needs: { total: 0, items: [] }, running: { quiet: 0, items: [] }, today: { spend: null, longestWaitMs: null }, team: null };

test('Home is a registered local page with its own sandboxed files', () => {
  const page = require('../buddy-window/pages').pageById('home');
  assert.equal(page.kind, 'local'); assert.equal(page.file, 'home.html'); assert.equal(page.preload, 'home-preload.js');
  for (const file of ['home.html', 'home.js', 'home.css', 'home-preload.js']) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  assert.match(html, /default-src 'none'/); assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(script, /innerHTML/);
});

test('the connect banner: nothing found, some unconnected, all connected', () => {
  assert.equal(Home.banner([tool('claude', 'Claude Code', false, false)]).kind, 'none');
  const two = Home.banner([tool('claude', 'Claude Code', true, true), tool('codex', 'Codex', true, false), tool('gemini', 'Gemini CLI', true, false)]);
  assert.match(two.text, /We found Codex and Gemini CLI on this Mac/);
  assert.deepEqual(two.action, { label: 'Connect 2 tools', destination: 'aitools:all' });
  assert.deepEqual(Home.banner([tool('codex', 'Codex', true, false)]).action, { label: 'Connect Codex', destination: 'aitools:codex' });
  assert.equal(Home.banner([tool('claude', 'Claude Code', true, true)]), null);
  assert.equal(Home.banner(null), null);
});

test('needs, running and today read only what other pages already show', () => {
  const inputs = [{ id: 'b', kind: 'permission', tool: 'Bash', headline: 'npm test', cwd: '/w/app', created_at: iso(6 * 60_000) }, { id: 'a', kind: 'question', text: 'Which branch?', cwd: '/w/site', created_at: iso(30_000) }];
  const n = Home.needs(inputs, NOW);
  assert.equal(n.total, 2);
  assert.deepEqual(n.items.map((i) => [i.project, i.late]), [['app', true], ['site', false]], 'longest wait first');
  const r = Home.running([
    { sessionId: 'live', cwd: '/w/plexiform', signal: 'tool-use', updatedAt: iso(5000) },
    { sessionId: 'quiet', cwd: '/w/old', signal: 'stop', updatedAt: iso(10 * 60_000) },
    { sessionId: 'done', cwd: '/w/done', signal: 'session-end', updatedAt: iso(1000) },
  ], NOW);
  assert.deepEqual(r.items.map((s) => [s.provider, s.project, s.status]), [['Claude Code', 'plexiform', 'Working']]);
  assert.equal(r.quiet, 1);
  assert.ok(!('sessionId' in r.items[0]), 'no session ids reach the page');
  const t = Home.today({ mode: 'subscription', budget: { day: { spent: 3.5, budget: 10, level: null, unpriced: 0 } } }, inputs, NOW);
  assert.deepEqual(t.spend, { spent: 3.5, budget: 10, level: null, unpriced: 0, equivalent: true });
  assert.equal(t.longestWaitMs, 6 * 60_000);
  assert.equal(Home.today(null, [], NOW).spend, null);
});

test('Your cards appear only on a team', () => {
  const local = { sources: [{ name: Home.LOCAL_BOARD, status: 'complete', cards: [{ handle: 'h', key: 'L-1', title: 'Local', board: 'b', team: 't', state: 'To do' }], decisions: [] }] };
  assert.equal(Home.cards(local), null);
  const team = Home.cards({ sources: [...local.sources, { name: 'Acme', status: 'complete', cards: [], decisions: [{ handle: 'd', key: 'A-2', title: 'Ship', board: 'Dev', kind: 'Question', summary: 'Which?' }] }] });
  assert.equal(team.cards.length, 1); assert.equal(team.decisions[0].key, 'A-2');
});

test('Home IPC answers only the Home page and navigates only to known pages', async () => {
  const handlers = new Map(), opened = [], tools = [];
  const page = {};
  Home.register({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, allowed: (e) => e.sender === page,
    state: () => ({ inputs: [], sessions: [], spend: null }), localSessions: (s) => s, tools: () => [tool('codex', 'Codex', true, false)],
    myDay: { snapshot: async () => ({ sources: [] }), open: async (h) => h === 'ok' }, openPage: (id) => opened.push(id), openAiTools: (d) => { tools.push(d); return true; }, now: () => NOW,
  });
  assert.equal(await handlers.get('home:state')({ sender: {} }), null);
  const s = await handlers.get('home:state')({ sender: page });
  assert.equal(s.banner.kind, 'connect'); assert.equal(s.team, null); assert.deepEqual(s.needs, { total: 0, items: [] });
  assert.equal(handlers.get('home:navigate')({ sender: page }, 'https://example.com'), false);
  assert.equal(handlers.get('home:navigate')({ sender: page }, 'thismac'), false);
  assert.equal(handlers.get('home:navigate')({ sender: {} }, 'waiting'), false);
  assert.equal(handlers.get('home:navigate')({ sender: page }, 'waiting'), true);
  assert.equal(handlers.get('home:navigate')({ sender: page }, 'aitools:all'), true);
  assert.deepEqual(opened, ['waiting']); assert.deepEqual(tools, ['aitools:all']);
  assert.equal(await handlers.get('home:open-card')({ sender: page }, 'ok'), true);
  assert.equal(await handlers.get('home:open-card')({ sender: {} }, 'ok'), false);
});

test('a part that fails to read is unavailable, not empty, and the rest still render', async () => {
  const handlers = new Map();
  Home.register({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, allowed: () => true, state: () => { throw new Error('x'); }, localSessions: (s) => s, tools: () => { throw new Error('y'); }, myDay: { snapshot: async () => { throw new Error('z'); } }, openPage() {}, openAiTools() {}, now: () => NOW });
  const s = await handlers.get('home:state')({});
  assert.deepEqual([s.banner, s.needs, s.running, s.today, s.team], [null, null, null, null, null]);
});

test('a brand-new user sees one empty message per section, each with a button', async () => {
  const calls = [];
  const f = setup([fresh], calls);
  try {
    await tick();
    assert.equal(f.section('banner').hidden, false);
    assert.match(f.section('banner').textContent, /No AI tools found yet/);
    for (const id of ['needs', 'running']) {
      const empties = f.section(id).querySelectorAll('.empty');
      assert.equal(empties.length, 1, `${id}: one empty message`);
      assert.equal(empties[0].querySelectorAll('button').length, 1, `${id}: one action`);
    }
    assert.equal(f.section('today').querySelectorAll('.actions button').length, 1);
    assert.equal(f.section('cards').hidden, true, 'no team, no Your cards');
    f.section('running').querySelector('button').click();
    assert.deepEqual(calls.at(-1), ['navigate', 'aitools']);
    assert.doesNotMatch(f.document.body.textContent, /Waiting on you|observed/i);
  } finally { f.close(); }
});

test('a live session appears on Home within one refresh tick', async () => {
  const live = { ...fresh, banner: null, running: { quiet: 0, items: [{ provider: 'Codex', project: '<img src=x>', status: 'Working', age_ms: 2000 }] } };
  const f = setup([{ ...fresh, banner: null }, live]);
  try {
    await tick();
    assert.equal(f.section('running').querySelectorAll('li').length, 0);
    assert.match(f.section('running').textContent, /Start a session/);
    f.intervals[0](); await tick();
    assert.equal(f.section('running').querySelectorAll('li').length, 1);
    assert.match(f.section('running').querySelector('li').textContent, /Codex · <img src=x>/);
    assert.equal(f.document.querySelectorAll('img').length, 0);
    assert.equal(f.section('today').querySelector('.metric:nth-child(2) strong').textContent, '1');
  } finally { f.close(); }
});

test('needs you lists each wait once with an Answer that opens the Waiting page; team cards open by handle', async () => {
  const calls = [];
  const state = { ...fresh, banner: null, needs: { total: 1, items: [{ kind: 'Permission', headline: 'Bash: npm test', project: 'app', age: 'waiting 6 min', late: true }] },
    today: { spend: { spent: 4, budget: 0, level: null, unpriced: 0, equivalent: false }, longestWaitMs: 360000 },
    team: { unavailable: false, cards: [{ handle: 'h1', key: 'A-1', title: 'Fix', board: 'Dev', team: 'Acme', state: 'In progress', due_date: null }], decisions: [] } };
  const f = setup([state], calls);
  try {
    await tick();
    assert.equal(f.section('needs').querySelectorAll('li').length, 1);
    f.section('needs').querySelector('li button').click();
    assert.deepEqual(calls.at(-1), ['navigate', 'waiting']);
    assert.match(f.section('today').textContent, /\$4\.00.*no daily limit/);
    assert.equal(f.section('today').querySelector('.actions button').textContent, 'Set a daily limit');
    assert.equal(f.section('cards').hidden, false);
    f.section('cards').querySelector('li button').click(); await tick();
    assert.deepEqual(calls.at(-1), ['open', 'h1']);
  } finally { f.close(); }
});

test('"Waiting on you" is a list in one place only: the old My day block and Overview tile are gone', () => {
  const myday = fs.readFileSync(path.join(ROOT, 'myday.js'), 'utf8'), overview = fs.readFileSync(path.join(ROOT, 'overview.js'), 'utf8');
  assert.doesNotMatch(myday, /'Waiting on you'/); assert.match(myday, /'Team decisions'/);
  assert.doesNotMatch(overview, /'Reported sessions'/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'overview.html'), 'utf8'), /id="summary"/);
});
