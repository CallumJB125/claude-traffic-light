'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Home = require('../src/home-main.js');
const { testTempDir } = require('./helpers/tmp');

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
  assert.equal(two.text, 'Found Claude Code, Codex and Gemini CLI on this Mac. Claude Code connected; Codex and Gemini CLI not connected yet. Connect them to see what they are doing here.');
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
  assert.equal(s.banner.kind, 'connect'); assert.equal(s.team, null); assert.deepEqual(s.needs, { paused: null, total: 0, items: [] });
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
    f.section('today').querySelector('.actions button').click();
    assert.deepEqual(calls.at(-1), ['navigate', 'usage'], 'the limit is set inline on Usage & cost');
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
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.doesNotMatch(read('overview-directory.js'), /'Waiting on you'/, 'Overview tile says Need you');
  assert.doesNotMatch(read('lights.html'), />Waiting on you</, 'Stats shows time waiting, not a second list label');
  assert.doesNotMatch(read('board/web/js/render-dashboard.js'), /'Waiting on'\)/);
  assert.match(read('overview.html'), /<details class="reason"><summary>How to add a local model endpoint<\/summary>/, 'the local-models.json how-to is folded away');
});

test('no team boards: Home offers Sign in or create a team, which opens the Team page; on a team it is gone', async () => {
  const calls = [];
  const h = setup([{ ...fresh, teamless: true }], calls);
  await tick(); await tick();
  const sec = h.section('teamwork');
  assert.equal(sec.hidden, false);
  assert.match(sec.textContent, /Share a board with your teammates/);
  const b = [...sec.querySelectorAll('button')].find((x) => x.textContent === 'Sign in or create a team');
  b.click(); await tick();
  assert.deepEqual(calls, [['navigate', 'team']]);
  h.close();
  const t = setup([{ ...fresh, teamless: false, team: { unavailable: false, cards: [], decisions: [] } }]);
  await tick(); await tick();
  assert.equal(t.section('teamwork').hidden, true);
  t.close();
});

test('teamless is true only when the board list was read and holds no team board', async () => {
  const handlers = new Map();
  const reg = (myDay) => { handlers.clear(); Home.register({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, allowed: () => true, state: () => null, localSessions: () => [], tools: () => [], myDay, openPage() {}, openAiTools() {}, morning: () => null, now: () => NOW }); return handlers.get('home:state')({}); };
  assert.equal((await reg({ snapshot: async () => ({ sources: [{ name: Home.LOCAL_BOARD, cards: [] }] }) })).teamless, true);
  assert.equal((await reg({ snapshot: async () => ({ sources: [{ name: 'Core', cards: [], decisions: [] }] }) })).teamless, false);
  assert.equal((await reg({ snapshot: async () => { throw new Error('x'); } })).teamless, false, 'unknown is not teamless');
});

test('costs: the cost guard report becomes one card of receipt headline, cap status and top waste finding', () => {
  assert.equal(Home.costs(null), null);
  assert.equal(Home.costs({ enforce: { available: false }, waste: null, receipt: null }), null, 'nothing on this plan: no card');
  const c = Home.costs({
    receipt: { month: 'October 2026', headline: 'Saved about $12 this month', teaser: false },
    enforce: { available: true, settings: { enforceCaps: true, stopRunaways: false }, capActive: false, sessionsStopped: 0 },
    waste: { days: 7, files: 3, findings: [{ kind: 'reread', path: '/a/b/app.js', count: 5, approxTokens: 1200, evidence: [] }, { kind: 'failloop', tool: 'Bash', count: 3, evidence: [] }] },
  });
  assert.deepEqual(c.receipt, { month: 'October 2026', headline: 'Saved about $12 this month' });
  assert.deepEqual(c.enforce, { on: true, paused: null, status: 'Your limit is enforced. Nothing is being refused right now.' });
  assert.equal(c.waste.top, 'app.js was read 5 times with no edit in between (about 1,200 tokens re-sent)', 'the same sentence Usage & cost shows');
  assert.equal(c.waste.count, 2);
  assert.equal(Home.costs({ enforce: { available: true, settings: { enforceCaps: true }, capActive: true } }).enforce.status, 'Your limit is spent: tool calls are being refused.');
  assert.equal(Home.costs({ enforce: { available: true, settings: { enforceCaps: false } } }).enforce.on, false);
});

test('Home reads the cost guard without waiting on it, and a failing report hides the card', async () => {
  const handlers = new Map();
  let t = NOW, report = { receipt: { month: 'October 2026', headline: 'No activity yet this month' } };
  const reg = (costGuard) => { handlers.clear(); Home.register({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, allowed: () => true, state: () => null, localSessions: () => [], tools: () => [], myDay: { snapshot: async () => ({ sources: [] }) }, openPage() {}, openAiTools() {}, morning: () => null, now: () => t, costGuard }); return handlers.get('home:state'); };
  const state = reg(async () => report);
  assert.equal((await state({})).costs, null, 'the first read does not wait for the scan');
  await new Promise(setImmediate);
  assert.equal((await state({})).costs.receipt.headline, 'No activity yet this month');
  const failing = reg(async () => { throw new Error('x'); });
  await failing({}); await new Promise(setImmediate);
  assert.equal((await failing({})).costs, null);
});

test('the cost card links to Usage & cost and hides when there is nothing to show', async () => {
  const calls = [];
  const costs = { receipt: { month: 'October 2026', headline: 'Saved about $12 this month' }, enforce: { on: false, status: 'Your limit is not enforced.' }, waste: { days: 7, count: 0, top: null, files: 2 } };
  const f = setup([{ ...fresh, banner: null, costs }], calls);
  try {
    await tick();
    const sec = f.section('costs');
    assert.equal(sec.hidden, false);
    assert.equal(sec.querySelectorAll('li').length, 3);
    assert.match(sec.textContent, /Saved about \$12 this month/);
    assert.match(sec.textContent, /Not enforced/);
    assert.match(sec.textContent, /Nothing wasteful found in 2 transcripts/);
    sec.querySelector('.actions button').click();
    assert.deepEqual(calls.at(-1), ['navigate', 'usage']);
  } finally { f.close(); }
  const g = setup([{ ...fresh, costs: null }]);
  try { await tick(); assert.equal(g.section('costs').hidden, true); } finally { g.close(); }
});

test('the cost guard hands its report to main for Home', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /setCostGuardReport: \(fn\) => \{ costGuardReport = fn; \}/);
  assert.match(main, /costGuard: \(\) => \(costGuardReport \? costGuardReport\(\) : null\)/);
  let handed = null;
  const os = require('node:os');
  const dir = testTempDir('cg-');
  const reg = require('../src/spend-enforce.js').register({ rootDir: dir, entitlements: { has: () => false, limits: () => ({}) }, ipcMain: { handle() {} }, fromPage: () => false, onQuit: (fn) => fn(), setCostGuardReport: (fn) => { handed = fn; } });
  assert.equal(handed, reg.report);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('needs you: the cost guard pause sits first, Resume asks main and Raise limit opens Usage & cost', async () => {
  const paused = { text: 'Paused at your $10.00 daily limit ($12.00 spent)', note: 'Claude Code tool calls are refused until you resume or raise the limit.', resumable: true };
  const n = Home.needs([], NOW, paused);
  assert.equal(n.total, 0); assert.deepEqual(n.paused, paused);
  assert.equal(Home.needs([], NOW, null).paused, null);
  assert.equal(Home.costs({ enforce: { available: true, settings: { enforceCaps: true }, capActive: true, paused } }).enforce.status, 'Paused at your $10.00 daily limit ($12.00 spent): tool calls are being refused.');
  const calls = [];
  const state = { ...fresh, banner: null, needs: { paused, total: 1, items: [{ kind: 'Permission', headline: 'Bash: npm test', project: 'app', age: 'waiting 6 min', late: false }] } };
  const f = setup([state, { ...state, needs: { paused: null, total: 1, items: state.needs.items } }], calls);
  f.dom.window.homeApi.resumeCap = async () => { calls.push(['resume']); return { ok: true }; };
  try {
    await tick();
    const items = f.section('needs').querySelectorAll('li');
    assert.equal(items.length, 2);
    assert.equal(items[0].id, 'needs-paused');
    assert.match(items[0].textContent, /Paused at your \$10\.00 daily limit/);
    const [resume, raise] = items[0].querySelectorAll('button');
    assert.equal(resume.textContent, 'Resume'); assert.equal(raise.textContent, 'Raise limit');
    raise.click();
    assert.deepEqual(calls.at(-1), ['navigate', 'usage']);
    resume.click(); await tick(); await tick();
    assert.ok(calls.some((c) => c[0] === 'resume'));
    assert.equal(f.section('needs').querySelectorAll('li').length, 1, 'after the resume the card is gone');
  } finally { f.close(); }
});

test('home:resume-cap forwards to the cost guard and re-reads the costs card at once', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  let paused = { text: 'Paused at your $10.00 daily limit ($12.00 spent)', note: 'n', resumable: true };
  const report = () => ({ enforce: { available: true, settings: { enforceCaps: true }, capActive: !!paused, paused }, waste: null, receipt: null });
  Home.register({ ipcMain, allowed: () => true, state: () => ({ inputs: [], sessions: [], spend: null }), localSessions: (s) => s, tools: () => [], myDay: { snapshot: async () => ({ sources: [] }) }, openPage() {}, openAiTools() {}, morning: () => null, now: () => NOW, costGuard: report, resumeCap: async () => { if (!paused) return { error: 'nothing is paused' }; paused = null; return { settings: {} }; } });
  await handlers.get('home:state')({}); await tick();
  assert.equal((await handlers.get('home:state')({})).needs.paused.text, paused.text);
  assert.deepEqual(await handlers.get('home:resume-cap')({}), { ok: true });
  assert.equal((await handlers.get('home:state')({})).needs.paused, null);
  assert.deepEqual(await handlers.get('home:resume-cap')({ }), { ok: false, error: 'nothing is paused' }, 'nothing to resume is reported honestly');
});
