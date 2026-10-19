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

test('agent mail: one Needs-you card counts held asks and teammates\' questions; Open shows it, nothing else acts', async () => {
  let pending = null;
  const opened = [];
  const alerts = HomeAlerts.createHomeAlerts({ sessions: () => [], now: () => NOW, mail: () => pending, openMail: async () => { opened.push(1); } });
  assert.deepEqual(alerts.snapshot().mail, []);
  assert.equal((await alerts.act('mail', 'open', 'agent-mail')).ok, false, 'no card, nothing to open');
  pending = { held: 2, inbox: 1 };
  assert.deepEqual(alerts.snapshot().mail, [{ handle: 'agent-mail', title: 'Agent mail: 3 waiting', meta: '2 from your AI waiting for your OK · 1 from teammates\' AIs' }]);
  assert.equal((await alerts.act('mail', 'dismiss', 'agent-mail')).ok, false);
  assert.equal((await alerts.act('mail', 'open', 'other')).ok, false);
  assert.deepEqual(await alerts.act('mail', 'open', 'agent-mail'), { ok: true });
  assert.equal(opened.length, 1);
  pending = { held: 0, inbox: 1 };
  assert.equal(alerts.snapshot().mail[0].meta, '1 from teammates\' AIs');
  assert.deepEqual(HomeAlerts.createHomeAlerts({ mail: () => { throw new Error('x'); } }).snapshot().mail, []);
});

// B2 (main side): the Burst card facts Home composes its one Burst row from, and the one action it may run.
test('Burst card: statusView facts plus loose-ends totals; the one action runs only the step the card shows, through Burst\'s own consent', async () => {
  const LE = require('../src/burst-loose-ends-view.js');
  const acted = [];
  const state = { burst: null, loose: null };
  const alerts = HomeAlerts.createHomeAlerts({ sessions: () => [], burst: () => state.burst, tasks: () => [], platform: 'darwin', now: () => NOW,
    burstLooseEnds: () => state.loose, burstAct: async (kind) => { acted.push(kind); return { ok: true, retried: kind === 'retry' }; },
    jump: async () => {}, copyHandover: async () => ({ ok: true }), docFor: async () => null, confirm: async () => true, resume: async () => ({ ok: true }) });
  assert.equal(alerts.snapshot().burst, null, 'before the first detection: no card');
  state.burst = { kind: 'checking' };
  assert.equal(alerts.snapshot().burst, null);
  state.burst = { kind: 'present', installed: true, capabilities: { upgradeStatus: true, looseEnds: true }, upgrade: { canUpgrade: true, upToDate: false }, state: { version: '0.20.36', mode: 'base-url', active: true, route: 'PRIMARY', until: '', rejected: [], primaryFailures: 0, compaction: null } };
  state.loose = LE.looseEndsView({ report: { at: 1, scanned: 1, repos: [{ root: '/r', uncommitted: [{ path: 'a' }], unpushed: [], ahead: 2, stashes: [] }] } });
  const b = alerts.snapshot().burst;
  assert.equal(b.view.kind, 'on');
  assert.deepEqual(b.view.action, { kind: 'update', label: 'Update' });
  assert.deepEqual(b.view.chip, { tone: 'green', label: 'Primary' });
  assert.deepEqual(b.looseEnds, { repos: 1, uncommitted: 1, unpushed: 2, stashes: 0, text: '1 uncommitted file, 2 unpushed commits in 1 repository.' });
  assert.deepEqual(Object.keys(b.view).sort(), ['action', 'chip', 'detail', 'dimmed', 'headline', 'kind'], 'facts only: no actions list, no version string the page did not ask for');
  // The action: only the kind the card is showing.
  assert.deepEqual(await alerts.act('burst', 'act', 'update'), { ok: true, retried: false });
  assert.deepEqual(acted, ['update']);
  assert.equal((await alerts.act('burst', 'act', 'uninstall')).ok, false, 'not the shown step');
  assert.equal((await alerts.act('burst', 'open', 'update')).ok, false, 'only "act"');
  assert.equal((await alerts.act('burst', 'act', 42)).ok, false);
  assert.deepEqual(acted, ['update'], 'nothing else ran');
  state.burst = { kind: 'present', installed: true, capabilities: {}, upgrade: null, state: { version: '0.20.36', mode: 'base-url', active: true, route: 'PRIMARY', until: '', rejected: ['x'], primaryFailures: 0, compaction: null } };
  state.loose = null;
  const near = alerts.snapshot().burst;
  assert.equal(near.view.action, null);
  assert.equal(near.view.chip.label, 'Limit near');
  assert.equal(near.looseEnds, null);
  assert.equal((await alerts.act('burst', 'act', 'update')).ok, false, 'no step shown: nothing to run');
});

test('Home renders the Burst row with its one button, which sends only the action kind through alertAct', async () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const dom = new JSDOM(read('home.html'), { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  dom.window.setInterval = () => 0;
  const calls = [];
  dom.window.homeApi = {
    state: async () => ({}), navigate: async (d) => { calls.push(['navigate', d]); return true; },
    alerts: async () => ({ stuck: [], limits: [], mail: [], waiting: [], burst: { view: { kind: 'off', headline: 'Claude Burst', detail: 'Installed, and not in Claude Code’s path.', chip: { tone: 'grey', label: 'Off' }, action: { kind: 'enable', label: 'Turn on' }, dimmed: false }, looseEnds: null } }),
    alertAct: async (kind, action, handle) => { calls.push(['alertAct', kind, action, handle]); return { ok: true }; },
    teamToday: async () => null, teamInbox: async () => [],
  };
  for (const f of ['src/attention-inbox.js', 'home-inbox-view.js']) dom.window.eval(read(f));
  await new Promise((r) => setTimeout(r, 20));
  const li = dom.window.document.querySelector('#inbox li[data-kind="burst"]');
  assert.ok(li, 'the Burst row is in the Inbox');
  assert.equal(li.querySelector('.title').textContent, 'Claude Burst');
  assert.match(li.querySelector('.muted').textContent, /not in Claude Code/);
  assert.equal(li.querySelector('.tag').textContent, 'Burst');
  const buttons = [...li.querySelectorAll('button')];
  assert.deepEqual(buttons.map((b) => b.textContent), ['Turn on'], 'one button');
  buttons[0].click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.filter((c) => c[0] === 'alertAct'), [['alertAct', 'burst', 'act', 'enable']]);
  dom.window.close();
});
