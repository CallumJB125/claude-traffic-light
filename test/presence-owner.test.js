'use strict';
// Ledger 31: one main-level presence owner; Overview and (later) threads register as viewers.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createPresenceOwner } = require('../src/presence-owner');
const { createOverviewService } = require('../src/overview-service');
const { createFakeTeamHub } = require('../src/team-hub-fake');
const { JSDOM } = require('jsdom');
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const spy = () => { const sent = []; return { sent, presenceView: r => { sent.push(structuredClone(r)); } }; };

test('owner: one send per change; same card again is a no-op; a clear by a non-owner sends nothing', () => {
  const s = spy(), p = createPresenceOwner({ presenceView: s.presenceView });
  assert.equal(p.set('overview', { team: 't', card: 'A' }), true);
  assert.equal(p.set('overview', { team: 't', card: 'A' }), false);
  assert.equal(p.set('thread', null), false);
  assert.deepEqual(s.sent, [{ team: 't', card_id: 'A' }]);
});
test('owner: a second viewer takes the slot; its clear gives the slot back to the first, not null', () => {
  const s = spy(), p = createPresenceOwner({ presenceView: s.presenceView });
  p.set('overview', { team: 't', card: 'A' });
  p.set('thread', { team: 't', card: 'B' });
  p.set('thread', null);
  p.set('overview', null);
  assert.deepEqual(s.sent, [{ team: 't', card_id: 'A' }, { team: 't', card_id: 'B' }, { team: 't', card_id: 'A' }, { team: 't', card_id: null }]);
});
test('owner: the older viewer clearing while the newer holds sends nothing', () => {
  const s = spy(), p = createPresenceOwner({ presenceView: s.presenceView });
  p.set('overview', { team: 't', card: 'A' });
  p.set('thread', { team: 't', card: 'B' });
  p.set('overview', null);
  assert.deepEqual(s.sent, [{ team: 't', card_id: 'A' }, { team: 't', card_id: 'B' }]);
});
test('owner: clearAll sends null per team once; presenceView throwing is swallowed; bad values clear', () => {
  const s = spy(), p = createPresenceOwner({ presenceView: s.presenceView });
  p.set('overview', { team: 't1', card: 'A' }); p.set('thread', { team: 't2', card: 'B' });
  p.clearAll(); p.clearAll();
  assert.deepEqual(s.sent.slice(2).sort((a, b) => a.team.localeCompare(b.team)), [{ team: 't1', card_id: null }, { team: 't2', card_id: null }]);
  const q = createPresenceOwner({ presenceView: () => { throw new Error('down'); } });
  assert.doesNotThrow(() => q.set('overview', { team: 't', card: 'A' }));
  const r = createPresenceOwner({ presenceView: s.presenceView }); const n = s.sent.length;
  r.set('overview', { team: '', card: 'A' }); r.set('overview', { team: 't', card: 5 });
  assert.equal(s.sent.length, n);
});

function fixture() {
  const hub = createFakeTeamHub({ viewer: 'u-me', users: { 'u-me': 'Me', bob: 'Bob' }, teams: [{ id: 'team1', name: 'Team', members: ['u-me', 'bob'] }],
    sessions: ['one', 'two'].map(n => ({ ref: `ref-${n}`, owner: 'bob', provider: { id: 'claude', label: 'Claude' }, device: { label: 'Bob Mac' }, card: { id: `card-${n}`, key: n.toUpperCase(), title: n }, task_title: n, state: 'working', observed_ago_ms: 1000, shares: [{ team: 'team1', scope: 'watch' }] })) });
  const s = spy(), owner = createPresenceOwner({ presenceView: s.presenceView });
  const svc = createOverviewService({ sessions: () => [], work: async () => ({ sources: [], capture: [] }), current: () => true, teamHub: () => hub, presenceOwner: owner });
  return { svc, owner, sent: s.sent };
}
async function ids(svc) { const d = await svc.directory({ view: 'team', team: null }); return d.entries.map(e => e.id); }

test('service: Overview A, thread B, thread closes -> A again; Overview clears -> null; reopening A resends', async () => {
  const { svc, owner, sent } = fixture();
  const [a] = await ids(svc);
  assert.equal((await svc.viewing({ id: a })).status, 'viewing');
  owner.set('thread', { team: sent[0].team, card: 'card-thread' });
  owner.set('thread', null);
  assert.deepEqual(sent.map(x => x.card_id), [sent[0].card_id, 'card-thread', sent[0].card_id]);
  assert.equal((await svc.viewing({ id: null })).status, 'cleared');
  assert.equal(sent.at(-1).card_id, null);
  assert.equal((await svc.viewing({ id: a })).status, 'viewing');
  assert.equal(sent.at(-1).card_id, sent[0].card_id);
});
test('service: Overview cannot clear a card the thread set; invalidate and clearViewing release only Overview\'s slot', async () => {
  const { svc, owner, sent } = fixture();
  const [a] = await ids(svc);
  await svc.viewing({ id: a });
  owner.set('thread', { team: sent[0].team, card: 'card-thread' });
  const n = sent.length;
  await svc.viewing({ id: null }); svc.clearViewing(); svc.invalidate();
  assert.equal(sent.length, n);
  owner.set('thread', null);
  assert.equal(sent.at(-1).card_id, null);
});
test('service: invalidate and a changed team clear Overview\'s presence', async () => {
  const f = fixture();
  const [a] = await ids(f.svc);
  await f.svc.viewing({ id: a });
  f.svc.invalidate();
  assert.equal(f.sent.at(-1).card_id, null);
  await ids(f.svc);
  assert.equal((await f.svc.viewing({ id: a })).status, 'viewing');
  await f.svc.directory({ view: 'mine' });
  assert.equal(f.sent.at(-1).card_id, null);
});
test('service: switching to another team clears the presence sent for the first', async () => {
  const hub = createFakeTeamHub({ viewer: 'u-me', users: { 'u-me': 'Me', bob: 'Bob' }, teams: [{ id: 'team1', name: 'One', members: ['u-me', 'bob'] }, { id: 'team2', name: 'Two', members: ['u-me', 'bob'] }],
    sessions: [{ ref: 'r1', owner: 'bob', provider: { id: 'claude', label: 'Claude' }, device: { label: 'M' }, card: { id: 'c1', key: 'K', title: 't' }, task_title: 't', state: 'working', observed_ago_ms: 1000, shares: [{ team: 'team1', scope: 'watch' }, { team: 'team2', scope: 'watch' }] }] });
  const s = spy(), svc = createOverviewService({ sessions: () => [], work: async () => ({ sources: [], capture: [] }), current: () => true, teamHub: () => hub, presenceOwner: createPresenceOwner({ presenceView: s.presenceView }) });
  const first = await svc.directory({ view: 'team', team: null });
  await svc.viewing({ id: first.entries[0].id });
  assert.deepEqual(s.sent, [{ team: 'team1', card_id: 'c1' }]);
  const other = first.teams.find(t => t.key !== first.team.key);
  await svc.directory({ view: 'team', team: other.key });
  assert.deepEqual(s.sent.at(-1), { team: 'team1', card_id: null });
  // Open a card in the second team, then fall back to the default team: that is also a team change.
  const second = await svc.directory({ view: 'team', team: other.key });
  await svc.viewing({ id: second.entries[0].id });
  assert.deepEqual(s.sent.at(-1), { team: 'team2', card_id: 'c1' });
  await svc.directory({ view: 'team', team: null });
  assert.deepEqual(s.sent.at(-1), { team: 'team2', card_id: null });
});
test('service without an injected owner still sends through presenceView', async () => {
  const hub = createFakeTeamHub({ viewer: 'u-me', users: { 'u-me': 'Me', bob: 'Bob' }, teams: [{ id: 'team1', name: 'Team', members: ['u-me', 'bob'] }], sessions: [{ ref: 'r', owner: 'bob', provider: { id: 'claude', label: 'Claude' }, device: { label: 'M' }, card: { id: 'c1', key: 'K', title: 't' }, task_title: 't', state: 'working', observed_ago_ms: 1000, shares: [{ team: 'team1', scope: 'watch' }] }] });
  const s = spy(), svc = createOverviewService({ sessions: () => [], work: async () => ({ sources: [], capture: [] }), current: () => true, teamHub: () => hub, presenceView: s.presenceView });
  const [a] = await ids(svc);
  await svc.viewing({ id: a });
  assert.deepEqual(s.sent, [{ team: 'team1', card_id: 'c1' }]);
});

test('wiring: one owner in main.js cleared with the invalidate sites; hide/minimise/attach hooks, never blur', () => {
  const main = read('main.js'), win = read('buddy-window/index.js'), om = read('src/overview-main.js');
  assert.match(main, /const PresenceOwner=require\('\.\/src\/presence-owner'\)\.createPresenceOwner\(\{presenceView:r=>PresenceLink\.view\(r\)\}\);/);
  assert.match(main, /chatPreview:CHAT_PREVIEW,presenceOwner:PresenceOwner,/);
  assert.equal((main.match(/OverviewMain\.invalidate\(\);\s*PresenceOwner\.clearAll\(\)/g) || []).length, 3);
  assert.match(main, /onPresenceLeave: \(\) => PresenceOwner\.clearAll\(\),\s*onOverviewLeft: \(\) => OverviewMain\.clearViewing\(\)/);
  assert.match(win, /win\.on\('hide', \(\) => \{ try \{ onPresenceLeave\(\)/);
  assert.match(win, /win\.on\('minimize', \(\) => \{ try \{ onPresenceLeave\(\)/);
  assert.match(win, /content === localViews\.get\('overview'\) && view !== content\) \{ try \{ onOverviewLeft\(\)/);
  for (const m of win.matchAll(/win\.on\('blur'[^\n]*/g)) assert.doesNotMatch(m[0], /onPresenceLeave|onOverviewLeft/);
  assert.match(main, /onRouteDropped:\(\)=>PresenceOwner\.clearAll\(\)/);
  assert.match(om, /clearViewing\(\)\{if\(!stopped\)service\.clearViewing\(\);\}/);
});

// Page side: main clears presence on hide / leaving Overview, so a panel still open tells it again.
async function page() {
  const viewing = [], id = 'a'.repeat(40);
  const dom = new JSDOM(read('overview.html'), { runScripts: 'outside-only', pretendToBeVisual: true });
  const entry = { id, kind: 'shared', owner: { name: 'Bob', self: false, initials: 'B' }, scope: 'team', teams: [{ key: 'b'.repeat(32), name: 'Team' }], board: { label: 'Board' }, provider: { id: 'codex', label: 'Codex' }, device: { label: 'Mac', local: false }, task: { title: 'Fix login', source: 'human' }, state: 'Working', input: false, freshness: 'recent', ageMs: 1000, observedAt: Date.now() - 1000, selfReported: null, provenance: ['shared'], capabilities: Object.fromEntries(['discovery', 'telemetry', 'taskReporting', 'receive', 'reply', 'resume', 'steer', 'interrupt', 'remoteControl'].map(k => [k, { available: true, reason: '' }])), interact: { kind: 'team', ref: 'opaque' }, children: [], deliveries: [] };
  dom.window.overviewApi = { directory: async req => ({ schema: 1, view: req.view, status: 'complete', observed_at: Date.now(), notice: '', teams: [{ key: 'b'.repeat(32), name: 'Team', source: 'hub', label: 'Team hub' }], team: req.view === 'team' ? { key: 'b'.repeat(32), name: 'Team' } : null, entries: req.view === 'team' ? [entry] : [] }), viewing: async r => { viewing.push(r.id); return { ok: true }; } };
  dom.window.eval(read('src/work-organise.js')); dom.window.eval(read('overview-directory.js'));
  dom.window.OverviewDirectory.start({ focusOwned() {}, composeWork() {} });
  dom.window.document.getElementById('tab-team').click(); await tick();
  await dom.window.OverviewDirectory.refresh(); await tick();
  return { dom, viewing, id, panel: () => dom.window.document.querySelector('details.caps') };
}
test('page: reannounce resends an open panel once on becoming visible; nothing when no panel is open', async () => {
  const p = await page();
  p.panel().open = true; p.panel().dispatchEvent(new p.dom.window.Event('toggle')); await tick();
  assert.deepEqual(p.viewing, [p.id]);
  p.dom.window.document.dispatchEvent(new p.dom.window.Event('visibilitychange')); await tick();
  assert.deepEqual(p.viewing, [p.id, p.id]);
  p.panel().open = false; p.panel().dispatchEvent(new p.dom.window.Event('toggle')); await tick();
  const n = p.viewing.length;
  p.dom.window.OverviewDirectory.reannounce(); await tick();
  assert.equal(p.viewing.length, n);
});
test('page: overview.js calls reannounce when main sends overview:ready', () => {
  assert.match(read('overview.js'), /dir\?\.refresh\(\); dir\?\.reannounce\?\.\(\);/);
});

// Real window sequence (attach() is the single content-change point): the extracted attach() drives the real service.
test('window: Overview A -> thread B (no select) -> thread closes -> back to Overview -> ready re-announce sends A again', async () => {
  const src = read('buddy-window/index.js');
  const from = src.indexOf('  function attach(view) {'), to = src.indexOf('  function ', from + 10);
  const vm = require('node:vm');
  const { svc, owner, sent } = fixture();
  const overviewView = { id: 'overview' }, threadView = { id: 'thread' };
  const ctx = { win: { contentView: { removeChildView() {}, addChildView() {}, children: [] } }, content: overviewView, threadView, newChatView: null, localViews: new Map([['overview', overviewView]]),
    retireThread: () => {}, retireNewChat: () => {}, layout: () => {}, lifecycle: { setCurrent() {} }, optimiser: { sync() {} }, onOverviewLeft: () => svc.clearViewing() };
  vm.createContext(ctx);
  vm.runInContext(src.slice(from, to) + '\nthis.attach = attach; this.state = () => content;', ctx);
  const [a] = await ids(svc);
  await svc.viewing({ id: a });
  const cardA = sent.at(-1).card_id, team = sent.at(-1).team;
  ctx.attach(threadView);                                   // no select() involved
  assert.equal(sent.at(-1).card_id, null);                  // Overview's hold is cleared as the thread takes the window
  owner.set('thread', { team, card: 'card-thread' });
  assert.equal(sent.at(-1).card_id, 'card-thread');
  owner.set('thread', null);                                // thread closes: null, not A
  assert.equal(sent.at(-1).card_id, null);
  ctx.attach(overviewView);
  const n = sent.length;
  assert.equal((await svc.viewing({ id: a })).status, 'viewing');   // overview:ready -> reannounce -> viewing
  assert.equal(sent.length, n + 1); assert.equal(sent.at(-1).card_id, cardA);
});
test('window: leaving Overview clears only Overview\'s slot; a live thread slot survives', async () => {
  const { svc, owner, sent } = fixture();
  const [a] = await ids(svc);
  await svc.viewing({ id: a });
  owner.set('thread', { team: sent[0].team, card: 'card-thread' });
  const n = sent.length;
  svc.clearViewing();
  assert.equal(sent.length, n);
});
