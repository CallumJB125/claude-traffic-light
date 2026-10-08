'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Limits = require('../src/limit-resets.js');
const HomeAlerts = require('../src/home-alerts.js');
const SessionHandover = require('../src/session-handover.js');

const ROOT = path.join(__dirname, '..');
const MIN = 60_000;
const local = (h, m) => { const d = new Date(2026, 9, 8, h, m, 0, 0); return d.getTime(); };
const NOW = local(12, 0);
const iso = (ms) => new Date(ms).toISOString();
const stuck = (id, minQuiet, extra = {}) => ({ sessionId: id, cwd: `/work/${id}`, signal: 'tool-use', updatedAt: iso(NOW - minQuiet * MIN), stuck: { sinceMs: minQuiet * MIN, tool: 'Bash' }, ...extra });
const limited = (id, extra = {}) => ({ sessionId: id, cwd: `/work/${id}`, signal: 'limit-hit', updatedAt: iso(NOW - MIN), ...extra });
const burstUntil = (at, extra = {}) => ({ kind: 'present', state: { route: 'SECONDARY', until: iso(at), reason: 'Claude hit its limit', primary: { provider: 'anthropic' }, rejected: [], ...extra } });

function make(over = {}) {
  const calls = [];
  let clock = NOW;
  let n = 0;
  const state = { sessions: [], burst: null, tasks: [], confirm: true, doc: '<!-- plexiform-handover -->\n# Handover\nnext step: ship it', ...over };
  const alerts = HomeAlerts.createHomeAlerts({
    sessions: () => state.sessions, burst: () => state.burst, tasks: () => state.tasks, now: () => clock, newHandle: () => `h${++n}`,
    jump: async (s) => { calls.push(['jump', s.sessionId]); },
    copyHandover: async (s) => { calls.push(['copy', s.sessionId]); return state.doc ? { ok: true, mode: 'copied' } : { ok: false, error: 'No handover could be built for this session.' }; },
    docFor: async (s) => { calls.push(['doc', s.sessionId]); return state.doc; },
    confirm: async (info) => { calls.push(['confirm', info]); return state.confirm; },
    resume: async (r) => { calls.push(['resume', r.session.sessionId, r.provider, r.resetAtMs]); return { ok: true, id: 't1' }; },
  });
  return { alerts, calls, state, tick: (ms) => { clock += ms; } };
}

test('a stuck session gets a Home card with opaque handles, and Dismiss holds only for that silence', async () => {
  const { alerts, calls, state } = make();
  state.sessions = [stuck('app', 7), { sessionId: 'busy', signal: 'tool-use', cwd: '/work/busy', updatedAt: iso(NOW) }];
  const s = alerts.snapshot();
  assert.deepEqual(s.stuck.map((c) => [c.title, c.meta, c.canOpen, c.canHand]), [['Stuck: app silent for 7 min', 'Claude Code · last tool Bash', true, true]]);
  assert.ok(!JSON.stringify(s).includes('/work/') && !JSON.stringify(s).includes('"app"'), 'no session id or path reaches the page');
  const h = s.stuck[0].handle;
  assert.deepEqual(await alerts.act('stuck', 'open', h), { ok: true });
  const hand = await alerts.act('stuck', 'handoff', h);
  assert.equal(hand.ok, true); assert.match(hand.note, /Copied its handover/);
  assert.deepEqual(calls, [['jump', 'app'], ['copy', 'app']]);
  assert.equal((await alerts.act('limit', 'dismiss', h)).ok, false, 'a handle answers only for its own kind');
  assert.deepEqual(await alerts.act('stuck', 'dismiss', h), { ok: true });
  assert.deepEqual(alerts.snapshot().stuck, []);
  state.sessions = [stuck('app', 6, { updatedAt: iso(NOW + 5 * MIN) })];
  assert.equal(alerts.snapshot().stuck.length, 1, 'a new silent stretch shows again');
});

test('a remote stuck session can only be dismissed; an unknown handle changes nothing', async () => {
  const { alerts, calls, state } = make();
  state.sessions = [stuck('remote:box:1', 9, { remote: true, deviceName: 'Studio', cwd: '/w/site' })];
  const [c] = alerts.snapshot().stuck;
  assert.deepEqual([c.canOpen, c.canHand], [false, false]);
  assert.match(c.meta, /on Studio/);
  assert.equal((await alerts.act('stuck', 'open', c.handle)).ok, false);
  assert.equal((await alerts.act('stuck', 'open', 'nope')).ok, false);
  assert.deepEqual(calls, []);
});

test('limit hit with a known reset: Resume asks first, a No queues nothing, a Yes queues one task at the reset time', async () => {
  const at = local(14, 30);
  const { alerts, calls, state } = make();
  state.sessions = [limited('api')];
  state.burst = burstUntil(at);
  const [c] = alerts.snapshot().limits;
  assert.deepEqual([c.title, c.meta, c.canResume], ['Limit hit: resets at 14:30', 'Claude Code · api', true]);
  state.confirm = false;
  assert.deepEqual(await alerts.act('limit', 'resume', c.handle), { ok: false, cancelled: true });
  assert.ok(!calls.some(([k]) => k === 'resume'), 'the dialog answer No queues nothing');
  assert.deepEqual(calls.find(([k]) => k === 'confirm')[1], { project: 'api', where: '/work/api', provider: 'Claude Code', at: '14:30' });
  state.confirm = true;
  const r = await alerts.act('limit', 'resume', c.handle);
  assert.equal(r.ok, true); assert.match(r.note, /at 14:30/);
  assert.deepEqual(calls.filter(([k]) => k === 'resume'), [['resume', 'api', 'claude', at]]);
  const after = alerts.snapshot().limits[0];
  assert.equal(after.canResume, false);
  assert.match(after.meta, /Resume queued for 14:30/);
});

test('limit hit with no known reset says so and offers no resume; nothing is invented', async () => {
  const { alerts, calls, state } = make();
  state.sessions = [limited('cx', { source: 'codex' })];
  state.burst = burstUntil(local(14, 0));
  const [c] = alerts.snapshot().limits.filter((x) => /Codex/.test(x.meta));
  assert.equal(c.title, 'Limit hit: reset time not known');
  assert.equal(c.canResume, false);
  assert.equal((await alerts.act('limit', 'resume', c.handle)).ok, false);
  assert.ok(!calls.some(([k]) => k === 'confirm' || k === 'resume'));
});

test('a limit reported only by Burst or a paused task gets a card without a resume button', () => {
  const { alerts, state } = make();
  state.burst = burstUntil(local(13, 5));
  state.tasks = [{ id: 't', title: 'Refactor', parkReason: 'limit', ai: { id: 'codex' }, limitResetsAtMs: local(16, 45) }];
  const cards = alerts.snapshot().limits;
  assert.deepEqual(cards.map((c) => [c.title, c.meta, c.canResume]), [
    ['Limit hit: resets at 13:05', 'Claude Code · reported by Claude Burst: Claude hit its limit', false],
    ['Limit hit: resets at 16:45', 'Codex · a task is paused on it', false],
  ]);
});

test('a reset already in the past is not a known reset', () => {
  const { alerts, state, tick } = make();
  state.sessions = [limited('api')];
  state.burst = burstUntil(local(12, 10));
  assert.equal(alerts.snapshot().limits[0].title, 'Limit hit: resets at 12:10');
  tick(15 * MIN);
  assert.equal(alerts.snapshot().limits[0].title, 'Limit hit: reset time not known');
});

test('Limits panel: per provider from existing data only, models apart, unknown said plainly', () => {
  const entries = Limits.collect({
    burst: burstUntil(local(15, 0), { rejected: [{ model: 'claude-opus-5', until: iso(local(12, 20)), fallsBackTo: 'claude-sonnet-5' }, { model: 'old', until: iso(NOW - MIN) }] }),
    tasks: [{ parkReason: 'limit', ai: { id: 'claude' }, limitResetsAtMs: local(14, 0) }, { parkReason: 'limit', ai: { id: 'gemini' }, limitResetsAtMs: null }],
    sessions: [limited('cx', { source: 'codex' })],
    now: NOW,
  });
  const p = Limits.panel(entries, NOW);
  assert.deepEqual(p.rows.map((r) => [r.label, r.text, r.source]), [
    ['Claude Code', 'Resets at 14:00', 'from a paused task'],
    ['Codex', 'Limit hit. Reset time not known', ''],
    ['Gemini', 'Limit hit. Reset time not known', ''],
  ]);
  assert.deepEqual(p.models.map((m) => m.text), ['claude-opus-5: available again at 12:20 (falls back to claude-sonnet-5)']);
  const clear = Limits.panel(Limits.collect({ now: NOW }), NOW);
  assert.ok(clear.rows.every((r) => r.status === 'clear' && r.text === 'No limit reported right now'));
  assert.match(clear.note, /never guesses/i);
  assert.equal(Limits.clock(local(9, 5) + 24 * 3600_000, NOW).slice(-5), '09:05');
  assert.notEqual(Limits.clock(local(9, 5) + 24 * 3600_000, NOW), '09:05', 'another day names the day');
});

test('queueResume: waits for the supervisor, then one reset task continuing the handover at the known time', async () => {
  const made = [];
  let polls = 0;
  const tasks = {
    start: () => made.push(['start']),
    snapshot: () => ({ conn: { status: ++polls > 2 ? 'connected' : 'connecting' } }),
    registerFolder: (p) => { made.push(['folder', p]); return { handle: 'f1', label: p }; },
    create: async (draft, extra) => { made.push(['create', draft, extra]); return { ok: true, id: 'T9' }; },
  };
  const doc = `${SessionHandover.MARKER}\n# Handover\nOpen questions / next step: finish the parser`;
  const r = await HomeAlerts.queueResume({ tasks, doc, session: { cwd: '/work/api' }, provider: 'codex', resetAtMs: 123, sleep: async () => {} });
  assert.deepEqual(r, { ok: true, id: 'T9' });
  const [, draft, extra] = made.find(([k]) => k === 'create');
  assert.deepEqual([draft.folder, draft.ai, draft.when, draft.surface, extra], ['f1', 'codex', 'reset', 'background', { startAfter: 123 }]);
  assert.match(draft.text, /^Continue the work described below/);
  assert.match(draft.text, /finish the parser/);
  const none = await HomeAlerts.queueResume({ tasks, doc: null, session: { cwd: '/w' }, provider: 'claude', resetAtMs: 1, sleep: async () => {} });
  assert.equal(none.ok, false);
  assert.equal(made.filter(([k]) => k === 'create').length, 1, 'no handover, no task');
  const refused = await HomeAlerts.queueResume({ tasks: { ...tasks, create: async () => ({ ok: false, code: 'VALIDATION', text: 'Check the folder.' }) }, doc, session: { cwd: '/w' }, provider: 'x', resetAtMs: 1, sleep: async () => {} });
  assert.deepEqual(refused, { ok: false, error: 'Check the folder.' });
});

test('IPC: Home and Usage channels answer only their own page', async () => {
  const handlers = new Map();
  const alerts = { snapshot: () => ({ stuck: [], limits: [] }), act: async () => ({ ok: true }), limits: () => ({ rows: [] }) };
  HomeAlerts.register({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, homeAllowed: (e) => e.page === 'home', usageAllowed: (e) => e.page === 'usage', alerts });
  assert.deepEqual(await handlers.get('home:alerts')({ page: 'home' }), { stuck: [], limits: [] });
  assert.equal(await handlers.get('home:alerts')({ page: 'usage' }), null);
  assert.equal((await handlers.get('home:alert')({ page: 'x' }, 'stuck', 'dismiss', 'h')).ok, false);
  assert.deepEqual(await handlers.get('usage:limits')({ page: 'usage' }), { rows: [] });
  assert.equal(await handlers.get('usage:limits')({ page: 'home' }), null);
});

const tick = () => new Promise((r) => setImmediate(r));

test('Home renders the cards with their buttons and sends only the handle', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'home.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.setInterval = () => 0;
  const sent = [];
  let reply = { stuck: [{ handle: 'h1', title: 'Stuck: app silent for 7 min', meta: 'Claude Code', canOpen: true, canHand: true }], limits: [{ handle: 'h2', title: 'Limit hit: resets at 14:30', meta: 'Claude Code · api', canResume: true }, { handle: 'h3', title: 'Limit hit: reset time not known', meta: 'Codex', canResume: false }] };
  dom.window.homeApi = { alerts: async () => reply, alertAct: async (...a) => { sent.push(a); return { ok: true, note: 'Queued in Tasks.' }; } };
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'home-alerts-view.js'), 'utf8'));
  await tick(); await tick();
  const doc = dom.window.document, sec = doc.getElementById('alerts');
  assert.equal(sec.hidden, false);
  const labels = [...sec.querySelectorAll('li')].map((li) => [li.querySelector('.title').textContent, [...li.querySelectorAll('button')].map((b) => b.textContent)]);
  assert.deepEqual(labels, [
    ['Stuck: app silent for 7 min', ['Open session', 'Hand to another AI', 'Dismiss']],
    ['Limit hit: resets at 14:30', ['Resume this at reset', 'Dismiss']],
    ['Limit hit: reset time not known', ['Dismiss']],
  ]);
  [...sec.querySelectorAll('button')].find((b) => b.textContent === 'Resume this at reset').click();
  await tick(); await tick();
  assert.deepEqual(sent, [['limit', 'resume', 'h2']]);
  assert.match(sec.textContent, /Queued in Tasks/);
  reply = { stuck: [], limits: [] };
  [...sec.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss').click();
  await tick(); await tick();
  assert.equal(sec.hidden, true);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'home-alerts-view.js'), 'utf8'), /innerHTML/);
  dom.window.close();
});

test('Usage Limits panel lists each provider and says when a time is unknown', async () => {
  const dom = new JSDOM('<div id="usage-history"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.setInterval = () => 0;
  const p = Limits.panel(Limits.collect({ burst: burstUntil(local(15, 0)), sessions: [limited('cx', { source: 'codex' })], now: NOW }), NOW);
  dom.window.lightsApi = { limits: async () => p };
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'limits-panel.js'), 'utf8'));
  await tick(); await tick();
  const sec = dom.window.document.getElementById('usage-limits');
  assert.equal(sec.hidden, false);
  assert.deepEqual([...sec.querySelectorAll('li')].map((li) => li.textContent), ['Claude Code: Resets at 15:00 (from Burst)', 'Codex: Limit hit. Reset time not known', 'Gemini: No limit reported right now']);
  assert.match(fs.readFileSync(path.join(ROOT, 'lights.html'), 'utf8'), /<script src="limits-panel\.js"><\/script>/);
  assert.match(fs.readFileSync(path.join(ROOT, 'lights-preload.js'), 'utf8'), /limits: \(\) => ipcRenderer\.invoke\('usage:limits'\)/);
  dom.window.close();
});
