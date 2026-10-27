'use strict';
// T1 (plan-t1.md): teammates' shared sessions in the chat-first sidebar's Team
// filter. Main side: the hub client's passive read, the service's side-effect-free
// projection, the fixed sidebar shape, the sidebar:team-rows channel and the
// one-shot open hint. The renderer is in sidebar-chat.test.js.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createTeamHubClient } = require('../src/team-hub-client');
const { createFakeTeamHub } = require('../src/team-hub-fake');
const { createOverviewMain } = require('../src/overview-main');
const { createInteractionHub } = require('../src/session-interaction');
const SidebarRows = require('../src/overview-sidebar-rows');

const NOW = 1_800_000_000_000;
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const json = (status, body) => ({ status, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
const RUN = '11111111-2222-4333-8444-555555555555';

// A board-directory hub: two teams, `n` explicit shares in team-1, one board run per team.
function boardRig({ n = 1 } = {}) {
  const s = { now: NOW, calls: [], state: 0, dir: { 'team-1': 0, 'team-2': 0 } };
  const shared = Array.from({ length: n }, (_, i) => ({ id: uuid(100 + i), session: uuid(500 + i), scope: 'watch', team: { id: 'team-1', name: 'One' }, owner: { id: 'u-bob', name: 'Bob' }, online: true, expires_at: null }));
  const directory = (team) => ({ schema: 1, status: 'complete', team: { id: team, name: team }, principal: { user_id: 'u-ana', member_id: 'm-ana', role: 'member' }, observed_at: s.now, message_contract: 'task-inbox',
    sessions: [{ ref: RUN, owner: { id: 'm-bob', user_id: 'u-bob', name: 'Bob' }, board: { id: 'board-1', name: 'Eng' }, card: { id: 'card-1', key: 'E-1', title: 'Card', fence: 1, repo_id: 'repo-1' }, provider: { id: 'claude' }, state: 'running', online: true, hb_age_ms: 0, canSend: true }] });
  const fetch = async (url, init = {}) => {
    s.calls.push({ url, init });
    if (url.endsWith('/shared')) return json(200, { shared });
    if (url.endsWith('/account')) return json(200, { user: { id: 'u-ana' }, teams: [{ id: 'team-1', name: 'One' }, { id: 'team-2', name: 'Two' }] });
    if (url.endsWith('/team-session-directory')) { const team = init.headers['X-Board-Team']; s.dir[team]++; return json(200, directory(team)); }
    if (url.includes('/call')) { s.state++; const body = JSON.parse(init.body); return json(200, { result: { ok: true, state: { session: body.args.session, status: 'working', observed_at: s.now - 10, provider: { id: 'claude', label: 'Claude Code' }, deliveries: [{ id: 'd', text: 'PRIVATE DELIVERY', state: 'replied' }] } } }); }
    if (init.method === 'POST') return json(200, { message: {} });
    return json(200, { messages: [] });
  };
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', viewerId: 'u-ana', token: () => 'tok', fetch, boardDirectory: true }, { now: () => s.now, pollMs: 20, timeoutMs: 500, deadlineMs: 1000 });
  return { s, hub };
}

test('passiveSessions: one shared list, the first 4 teams, entries per team; never moves what Overview watches', async () => {
  const { s, hub } = boardRig();
  await hub.sessions(hub.viewer(), 'team-1'); // Overview is on team-1
  const out = await hub.passiveSessions(hub.viewer());
  assert.equal(out.teamsTotal, 2);
  assert.deepEqual(out.teams.map((t) => [t.id, t.name]), [['team-1', 'One'], ['team-2', 'Two']]);
  assert.equal(s.calls.filter((c) => c.url.endsWith('/shared')).length, 2, 'one shared list per read');
  // poll() follows Overview's watched team only: team-2's directory is never polled.
  const before = { ...s.dir };
  let fired = 0; const off = hub.onChange(() => { fired++; });
  for (let i = 0; i < 20 && s.dir['team-1'] === before['team-1']; i++) await new Promise((r) => setTimeout(r, 10));
  off();
  assert.ok(s.dir['team-1'] > before['team-1'], 'the poll ran');
  assert.equal(s.dir['team-2'], before['team-2'], 'watchedTeams is still {team-1}');
  assert.ok(fired >= 1);
});

test('passiveSessions never records a board route: a board-run send from a passive row alone is refused before any POST', async () => {
  const { s, hub } = boardRig();
  const out = await hub.passiveSessions(hub.viewer());
  const run = out.teams[0].entries.find((e) => e.kind === 'board-run');
  assert.ok(run, 'board runs are listed');
  const r = await hub.send(hub.viewer(), 'team-1', run.ref, 'hello', crypto.randomUUID(), () => true);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'stale');
  assert.equal(s.calls.filter((c) => c.init.method === 'POST' && !c.url.includes('/call')).length, 0, 'no task-inbox message was posted');
});

test('passiveSessions shares the 45 s state cache and refreshes at most 24 expired slots per pass; slot writes fire no listener', async () => {
  const { s, hub } = boardRig({ n: 40 });
  await hub.sessions(hub.viewer(), 'team-1');
  const filled = s.state;
  assert.equal(filled, 40);
  await hub.passiveSessions(hub.viewer());
  assert.equal(s.state, filled, 'inside the window Overview filled: no new relay call');
  s.now += 46_000;
  const out = await hub.passiveSessions(hub.viewer());
  assert.equal(s.state - filled, 24, 'the budget');
  assert.equal(out.partial, true, 'the rest are served from the cache and marked partial');
  // A listener is told only by poll()'s fingerprint, which never reads slots.
  let fired = 0; const off = hub.onChange(() => { fired++; });
  for (let i = 0; i < 20 && !fired; i++) await new Promise((r) => setTimeout(r, 10));
  const after = fired;
  s.now += 46_000;
  await hub.passiveSessions(hub.viewer());
  assert.equal(fired, after, 'zero onChange from a passive pass');
  off();
});

// ── service + overview-main through the real IPC shape ─────────────────────
const FIXTURE = {
  viewer: 'u-me', users: { 'u-me': 'Me', 'u-bob': 'Bob Stone', 'u-ann': 'Ann Lee' },
  teams: [{ id: 't-1', name: 'Dev team', members: ['u-me', 'u-bob', 'u-ann'] }, ...[2, 3, 4, 5, 6].map((n) => ({ id: `t-${n}`, name: `Team ${n}`, members: ['u-me', 'u-bob'] }))],
  sessions: [
    { ref: 'r-bob', owner: 'u-bob', provider: { id: 'claude', label: 'Claude Code' }, device: { label: "Bob's laptop" }, task_title: 'Ship the importer', state: 'working', observed_ago_ms: 1000, shares: [{ team: 't-1', scope: 'interact' }, { team: 't-5', scope: 'watch' }] },
    { ref: 'r-ann', owner: 'u-ann', provider: { id: 'codex', label: 'Codex' }, device: { label: 'mini' }, state: 'idle', observed_ago_ms: 1000, shares: [{ team: 't-1', scope: 'watch' }] },
    { ref: 'r-me', owner: 'u-me', provider: { id: 'codex', label: 'Codex' }, state: 'working', observed_ago_ms: 1000, shares: [{ team: 't-1', scope: 'watch' }] },
  ],
};
function sidebarRig({ hub = createFakeTeamHub(FIXTURE), chatPreview = true } = {}) {
  let sidebarGen = 1, overviewGen = 1, hubOn = true, time = NOW;
  const swc = { mainFrame: {}, isDestroyed: () => false }, owc = { mainFrame: {}, isDestroyed: () => false };
  const win = { isDestroyed: () => false, isVisible: () => true, isFocused: () => true, isMinimized: () => false };
  const buddy = {
    sidebarReadContext: () => ({ window: win, contents: swc, generation: sidebarGen, document: 1 }),
    overviewContext: () => ({ window: win, contents: owc, foreground: true, generation: overviewGen, document: 1 }),
    overviewReadContext: () => ({ window: win, contents: owc, foreground: true, generation: overviewGen, document: 1 }),
  };
  let current = hub;
  const presence = { reads: 0, views: 0 };
  const main = createOverviewMain({ buddy: () => buddy, sessions: () => [], teamHub: () => (hubOn ? current : null), chatPreview, now: () => time,
    presence: () => { presence.reads++; return null; }, presenceView: () => { presence.views++; return 0; } });
  const handlers = new Map(); main.register({ handle: (name, fn) => handlers.set(name, fn) });
  const side = { sender: swc, senderFrame: swc.mainFrame }, over = { sender: owc, senderFrame: owc.mainFrame };
  return { main, handlers, side, over, hub, presence,
    rows: (...a) => handlers.get('sidebar:team-rows')(side, ...a), hint: (e = over) => handlers.get('overview:open-hint')(e),
    tick: (ms) => { time += ms; }, reloadSidebar: () => { sidebarGen++; }, signOut: () => { hubOn = false; },
    switchTo: (next) => { current = next; } };
}

test('sidebar:team-rows: teammates only, a fixed path-free shape, the first 4 teams with the total, no delivery text', async () => {
  const x = sidebarRig();
  const out = await x.rows();
  assert.equal(out.schema, 1); assert.equal(out.status, 'complete');
  assert.match(out.viewer, /^[0-9a-f]{64}$/);
  assert.equal(out.teamsTotal, 6);
  assert.deepEqual(out.teams.map((t) => t.name), ['Dev team', 'Team 2', 'Team 3', 'Team 4']);
  assert.deepEqual(out.rows.map((r) => [r.person, r.scope]).sort(), [['Ann Lee', 'watch'], ['Bob Stone', 'interact']], 'my own share and team 5 (past the cap) are not here');
  for (const r of out.rows) {
    assert.deepEqual(Object.keys(r), [...SidebarRows.TEAM_KEYS]);
    assert.match(r.id, /^[0-9a-f]{64}$/);
  }
  const bob = out.rows.find((r) => r.person === 'Bob Stone'), ann = out.rows.find((r) => r.person === 'Ann Lee');
  assert.equal(bob.title, 'Ship the importer');
  assert.equal(bob.team, 'Dev team (test data)', 'a fake hub says so');
  assert.equal(ann.title, "Ann Lee's Codex session", 'no task reported');
  const text = JSON.stringify(out);
  for (const bad of ['r-bob', 'r-ann', "Bob's laptop", 'mini', 'u-bob', 't-1']) assert.ok(!text.includes(bad), bad);
  assert.deepEqual(x.presence, { reads: 0, views: 0 }, 'no presence read, and the person is never shown as viewing');
  // A teammate's delivery text never reaches the sidebar.
  await x.hub.send({ id: 'u-me' }, 't-1', 'r-bob', 'PRIVATE MESSAGE TEXT');
  x.tick(16_000);
  assert.ok(!JSON.stringify(await x.rows()).includes('PRIVATE MESSAGE TEXT'));
});

test('teamRows: the fixed key list holds whatever the entry carries; ids are their own HMAC domain', () => {
  const entry = { owner: { name: 'Bob', initials: 'B' }, provider: { label: 'Codex' }, task: { title: 'T', source: 'reported' }, bucket: 'needs', freshness: 'recent', ageMs: 5,
    messageContract: 'live', deliveries: [{ text: 'secret' }], children: [{ name: 'c' }], capabilities: { receive: {} }, device: { label: 'd' }, board: { label: 'b' }, provenance: ['shared'], selfReported: { state: 'x' }, notice: 'n' };
  const out = SidebarRows.teamRows({ viewerScope: 'f'.repeat(64), teams: [{ name: 'A' }], teamsTotal: 1, entries: [{ rowId: 'e'.repeat(64), entryId: 'x'.repeat(40), teamKey: 'k'.repeat(32), teamName: 'A', fake: false, scope: 'watch', entry }], partial: false });
  assert.deepEqual(Object.keys(out.rows[0]), [...SidebarRows.TEAM_KEYS]);
  assert.ok(!JSON.stringify(out).includes('secret'));
  assert.ok(!JSON.stringify(out).includes('x'.repeat(40)), 'no entry id');
  assert.deepEqual(SidebarRows.teamRows(null), { schema: 1, status: 'unavailable', viewer: null, teams: [], teamsTotal: 0, rows: [] });
  const src = fs.readFileSync(path.join(__dirname, '../src/overview-service.js'), 'utf8');
  assert.match(src, /rowId:stable\(\['shared',e\.id\]\)/);
  // T2's bind re-derives the same id to find its row; nothing else uses the domain.
  assert.match(src, /stable\(\['shared',e\.id\]\)!==rowId/);
  assert.equal((src.match(/stable\(\['shared'/g) || []).length, 2, "no other row id uses the 'shared' domain");
});

test('sidebar:team-rows guard: other senders, preview off, args, a document change mid-read; 15 s floor shared by concurrent reads', async () => {
  const x = sidebarRig();
  assert.equal(await x.handlers.get('sidebar:team-rows')(x.over), null, 'the Overview document is not the sidebar');
  assert.equal(await x.rows('extra'), null);
  const off = sidebarRig({ chatPreview: false });
  assert.equal(await off.rows(), null, 'preview off');
  let reads = 0; const hub = createFakeTeamHub(FIXTURE), inner = hub.passiveSessions.bind(hub);
  hub.passiveSessions = async (v) => { reads++; return inner(v); };
  const y = sidebarRig({ hub });
  const [a, b] = await Promise.all([y.rows(), y.rows()]);
  assert.equal(reads, 1, 'one pass for concurrent reads');
  assert.deepEqual(a, b);
  await y.rows(); assert.equal(reads, 1, 'reused inside 15 s');
  y.tick(15_001); await y.rows(); assert.equal(reads, 2);
  // The sidebar document changes while the read is in flight: nothing is returned for it.
  const slow = createFakeTeamHub(FIXTURE), slowInner = slow.passiveSessions.bind(slow); let z;
  slow.passiveSessions = async (v) => { z.reloadSidebar(); return slowInner(v); };
  z = sidebarRig({ hub: slow });
  const got = await z.rows();
  assert.equal(got.status, 'unavailable'); assert.deepEqual(got.rows, []);
  assert.match(got.viewer, /^[0-9a-f]{64}$/);
  // ... and after the service read, before the reply: the final re-check.
  const late = sidebarRig(), project = SidebarRows.teamRows;
  SidebarRows.teamRows = (out) => { late.reloadSidebar(); return project(out); };
  try { const r = await late.rows(); assert.equal(r.status, 'unavailable'); assert.deepEqual(r.rows, []); } finally { SidebarRows.teamRows = project; }
});

test('open hint: armed only for a listed row of this viewer, consumed once by the Overview document, 10 s, gone after sign-out', async () => {
  const x = sidebarRig();
  const out = await x.rows(), id = out.rows[0].id;
  assert.equal(x.main.armTeamHint('0'.repeat(64)), false, 'unknown id');
  assert.equal(x.main.armTeamHint('short'), false);
  assert.equal(x.main.armTeamHint(id), true);
  assert.equal(await x.hint(x.side), null, 'the sidebar cannot read it');
  const h = await x.hint();
  assert.match(h.team, /^[0-9a-f]{32}$/); assert.match(h.entry, /^[0-9a-f]{40}$/);
  assert.equal(await x.hint(), null, 'consumed once');
  // It opens the same entry Overview's own directory lists for that team.
  const dir = await x.handlers.get('overview:directory')(x.over, { view: 'team', team: h.team });
  assert.ok(dir.entries.some((e) => e.id === h.entry));
  assert.equal(x.main.armTeamHint(id), true); x.tick(10_001);
  assert.equal(await x.hint(), null, 'expired');
  assert.equal(x.main.armTeamHint(id), true); x.signOut();
  assert.equal(await x.hint(), null, 'a viewer change drops the hint (S4)');
  assert.equal(x.main.armTeamHint(id), false, 'and its route');
  const y = sidebarRig(); const r2 = await y.rows(); y.tick(60_001);
  assert.equal(y.main.armTeamHint(r2.rows[0].id), false, 'a route lasts 60 s');
});

// The Overview selection survives a sidebar read (real client + interaction hub, as in overview-team-controls.test.js).
test('a sidebar read leaves Overview alone: an open team selection still sends afterwards', async () => {
  const ee = new EventEmitter(), calls = [], actor = 'owner-document', share = crypto.randomUUID();
  const adapter = { label: 'Codex', capabilities: { newTurn: true, steer: true, interrupt: true, ack: true, echo: true, stream: true },
    open: async () => ({ target: 'native' }), alive: () => true, on: (fn) => { ee.on('event', fn); return () => ee.off('event', fn); },
    send: async (req) => { calls.push(req); return { turnId: `turn-${calls.length}`, mode: 'new-turn' }; }, interrupt: async () => true };
  const ih = createInteractionHub({ adapters: { codex: adapter }, boardCurrent: () => true });
  const session = (await ih.launch({ provider: 'codex', board: 'b' }, actor)).state.session;
  const client = createTeamHubClient({ baseUrl: 'https://synthetic.invalid', token: () => 't', viewer: { id: 'viewer', name: 'Viewer' }, fetch: async (url, init) => {
    if (url.endsWith('/shared')) return json(200, { shared: [{ id: share, session, scope: 'interact', team: { id: 'team', name: 'Team' }, owner: { id: 'owner', name: 'Owner' }, online: true, expires_at: null }] });
    const req = JSON.parse(init.body);
    const result = req.op === 'state' ? { ok: true, state: { ...ih.state({ session }, actor), observed_at: Date.now() } } : await ih.send({ ...req.args, board: 'b' }, actor, { by: 'Viewer' });
    return json(200, { result });
  } });
  const win = { isDestroyed: () => false, isVisible: () => true, isFocused: () => true, isMinimized: () => false };
  const owc = { mainFrame: {}, isDestroyed: () => false }, swc = { mainFrame: {}, isDestroyed: () => false };
  const ctx = () => ({ window: win, contents: owc, foreground: true, generation: 1, document: 1 });
  const buddy = { overviewContext: ctx, overviewReadContext: ctx, sidebarReadContext: () => ({ window: win, contents: swc, generation: 1, document: 1 }) };
  const main = createOverviewMain({ buddy: () => buddy, sessions: () => [], teamHub: () => client, chatPreview: true });
  const handlers = new Map(); main.register({ handle: (name, fn) => handlers.set(name, fn) });
  const event = { sender: owc, senderFrame: owc.mainFrame };
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../overview-preload.js'), 'utf8'), { Buffer, Promise, require: () => ({ contextBridge: { exposeInMainWorld: (_n, v) => { api = v; } }, ipcRenderer: { invoke: (name, ...args) => handlers.get(name)(event, ...args) } }) });
  try {
    const first = await api.directory({ view: 'team', team: null });
    const inspected = await api.teamInspect({ id: first.entries[0].id });
    assert.equal(inspected.capabilities.send.available, true);
    const side = await handlers.get('sidebar:team-rows')({ sender: swc, senderFrame: swc.mainFrame });
    assert.equal(side.rows.length, 1, 'the sidebar sees the shared session');
    const result = await api.teamAction({ selection: inspected.selection, operation: 'send', text: 'Status?' });
    assert.equal(result.status, 'acknowledged', 'the selection was not retired by the sidebar read');
    assert.equal(calls.length, 1);
  } finally { main.close(); ih.stopAll(); }
});

test('buddy:open-team-row: sidebar main frame only, one 64-hex id; arms the hint, then a plain select of Overview (not route())', () => {
  const src = fs.readFileSync(path.join(__dirname, '../buddy-window/index.js'), 'utf8');
  // A small named handler (T2 opens a thread first, with this hint as the fallback).
  assert.match(src, /if \(chatFirst === true\) ipcMain\.on\('buddy:open-team-row', openTeamRowFromSidebar\);/);
  const at = src.indexOf('function openTeamRowFromSidebar(');
  const body = src.slice(at, src.indexOf('\n  }\n', at));
  assert.match(body, /!fromSidebar\(e\) \|\| e\.senderFrame !== sidebar\.webContents\.mainFrame \|\| args\.length !== 1 \|\| typeof args\[0\] !== 'string' \|\| !ROW_ID\.test\(args\[0\]\)/);
  // T2: a bindable share opens the thread; otherwise T1's hint and plain select stay the fallback.
  assert.match(body, /bound = \(await threadBindShared\(id, current\)\) === true/);
  assert.match(body, /if \(bound && openThread\(id\)\) return;/);
  assert.match(body, /armed = openTeamRow\(id\) === true/);
  assert.match(body, /if \(armed\) select\('overview'\);/);
  assert.doesNotMatch(body, /route\(/);
  assert.match(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), /openTeamRow: \(id\) => OverviewMain\.armTeamHint\(id\),/);
});

test('a viewer switch (another person on a hub) refuses the old routes and drops an armed hint', async () => {
  const x = sidebarRig();
  const id = (await x.rows()).rows[0].id;
  assert.equal(x.main.armTeamHint(id), true);
  x.switchTo(createFakeTeamHub({ ...FIXTURE, viewer: 'u-ann' }));
  assert.equal(await x.hint(), null, 'the hint was for the previous viewer');
  assert.equal(x.main.armTeamHint(id), false, 'so is the route');
});

test('teammates only: my own board run on a team board is not a Shared with you row', async () => {
  const x = sidebarRig({ hub: boardRig().hub });
  const before = await x.rows();
  assert.equal(before.rows.filter((r) => r.inbox).length, 2, "Bob's run on both teams");
  // The same board run, now mine (owner.self).
  const y = sidebarRig({ hub: boardRigOwn().hub });
  const after = await y.rows();
  assert.equal(after.rows.filter((r) => r.inbox).length, 0, 'my own run is in Your team work, not here');
});
function boardRigOwn() {
  const r = boardRig();
  return { ...r, hub: new Proxy(r.hub, { get: (t, k) => (k === 'passiveSessions' ? async (v) => { const out = await t.passiveSessions(v); for (const team of out.teams) for (const e of team.entries) if (e.kind === 'board-run') e.owner = { ...e.owner, id: 'u-ana', self: true }; return out; } : t[k]) }) };
}

test('an account switch whose first read fails answers unavailable with the new viewer, not the old one', async () => {
  const x = sidebarRig();
  const first = await x.rows();
  const broken = createFakeTeamHub({ ...FIXTURE, viewer: 'u-ann' });
  broken.passiveSessions = async () => { throw new Error('hub down'); };
  x.switchTo(broken); x.tick(15_001);
  const failed = await x.rows();
  assert.equal(failed.status, 'unavailable');
  assert.match(failed.viewer, /^[0-9a-f]{64}$/);
  assert.notEqual(failed.viewer, first.viewer, 'the renderer can tell the account changed');
  x.signOut(); x.tick(15_001);
  assert.equal((await x.rows()).viewer, null, 'signed out: no viewer');
});
