'use strict';
// Redesign R1: the chat-first sidebar reads the session list and nothing else
// (plan-redesign authority table: read-only, navigation only; review M2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOverviewMain } = require('../src/overview-main');
const { sidebarRows, KEYS } = require('../src/overview-sidebar-rows');
const { originOf } = require('../src/focus/ids');

const now = () => new Date().toISOString();
const SESSIONS = [
  { sessionId: 's-iterm', source: 'claude', signal: 'waiting', updatedAt: now(), hostApp: 'iTerm2', cwd: '/Users/someone/private/alpha', taskTitle: 'Fix the login page' },
  { sessionId: 's-term', source: 'codex', signal: 'tool-use', updatedAt: now(), terminal: { env: { TERM_PROGRAM: 'Apple_Terminal' } }, cwd: '/Users/someone/private/beta' },
  { sessionId: 's-warp', source: 'claude', signal: 'tool-use', updatedAt: now(), hostApp: 'Warp', cwd: '/Users/someone/private/gamma' },
];

function fixture({ chatPreview = true, now, sessions = SESSIONS } = {}) {
  let overviewVisible = true, sidebarGen = 1, sidebarOn = true, release = null, delayed = false;
  const win = { isDestroyed: () => false, isVisible: () => true, isFocused: () => true, isMinimized: () => false };
  const overviewWc = { mainFrame: {}, isDestroyed: () => false };
  const sidebarWc = { mainFrame: {}, isDestroyed: () => false };
  const buddy = {
    overviewContext: () => (overviewVisible ? { window: win, contents: overviewWc, generation: 1, foreground: true } : null),
    overviewReadContext: () => (overviewVisible ? { window: win, contents: overviewWc, generation: 1, foreground: true } : null),
    sidebarReadContext: () => (sidebarOn ? { window: win, contents: sidebarWc, generation: sidebarGen, document: 0, foreground: false } : null),
  };
  let workCalls = 0;
  const main = createOverviewMain({ buddy: () => buddy, chatPreview, ...(now ? { now } : {}), sessions: () => sessions,
    work: () => { workCalls++; return delayed ? new Promise((r) => { release = r; }) : Promise.resolve({ sources: [], capture: [] }); } });
  const ipc = { handlers: {}, handle(name, fn) { this.handlers[name] = fn; }, on(name, fn) { this.handlers[name] = fn; } };
  main.register(ipc);
  return {
    main, ipc, call: (name, e, ...a) => ipc.handlers[name](e, ...a),
    sidebar: { sender: sidebarWc, senderFrame: sidebarWc.mainFrame }, overview: { sender: overviewWc, senderFrame: overviewWc.mainFrame },
    hideOverview: () => { overviewVisible = false; }, reloadSidebar: () => { sidebarGen++; }, sidebarOff: () => { sidebarOn = false; },
    delay: () => { delayed = true; }, release: () => { delayed = false; release({ sources: [], capture: [] }); }, workCalls: () => workCalls,
  };
}

test('originOf: a closed label set, host app first, TERM_PROGRAM only without one', () => {
  const env = (t) => ({ terminal: { env: { TERM_PROGRAM: t } } });
  assert.equal(originOf({ hostApp: 'iTerm2' }), 'iTerm');
  assert.equal(originOf(env('iTerm.app')), 'iTerm');
  assert.equal(originOf({ hostApp: 'Terminal' }), 'Terminal');
  assert.equal(originOf(env('Apple_Terminal')), 'Terminal');
  assert.equal(originOf({ hostApp: 'Warp', ...env('Apple_Terminal') }), null, 'a recorded host wins over TERM_PROGRAM');
  for (const s of [null, undefined, {}, { hostApp: 'Ghostty' }, env('vscode'), { hostApp: '/Applications/iTerm.app' }, env('iterm2 ')]) assert.equal(originOf(s), null, JSON.stringify(s));
  // Plexiform Terminal has no app id yet: nothing maps to it.
  for (const s of [{ hostApp: 'Plexiform Terminal' }, env('Plexiform Terminal'), { hostApp: null }]) assert.equal(originOf(s), null);
});

test('gate on: the sidebar reads a fixed projection of the session rows', async () => {
  const f = fixture();
  const out = await f.call('overview:state', f.sidebar);
  assert.equal(out.schema, 1);
  assert.equal(out.sessions.length, 3);
  for (const row of out.sessions) assert.deepEqual(Object.keys(row).sort(), [...KEYS].sort());
  const by = (o) => out.sessions.find((r) => r.origin === o);
  assert.ok(by('iTerm') && by('Terminal'));
  assert.equal(out.sessions.filter((r) => r.origin === null).length, 1, 'Warp is not a known origin');
  assert.equal(by('iTerm').title, 'Fix the login page');
  assert.match(by('Terminal').title, /^Codex session( in .+)?$/, 'no title reported → "<AI> session in <project>"');
  assert.ok(out.sessions.every((r) => /^[0-9a-f]{64}$/.test(r.id) && typeof r.bucket === 'string' && r.terminal === true), 'all three are terminal sessions');
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /\/Users\/|private\/|handle|capabilit|sessionId|s-iterm|cwd/, 'no paths, handles or native ids');
});

test('a paired-device session is listed, but not as in a terminal on this computer', async () => {
  const remote = { sessionId: 's-remote', source: 'claude', signal: 'tool-use', updatedAt: now(), hostApp: 'iTerm2', remote: true, device: 'dev-1', deviceName: 'Studio Mac', taskTitle: 'Remote work' };
  const f = fixture({ sessions: [...SESSIONS, remote] });
  const out = await f.call('overview:state', f.sidebar);
  const row = out.sessions.find((r) => r.title === 'Remote work');
  assert.ok(row, 'All lists it');
  assert.equal(row.terminal, false, 'In terminals does not');
  assert.equal(row.origin, null, 'and it gets no origin label');
  assert.equal(out.sessions.filter((r) => r.terminal).length, 3);
});

test('gate on: the sidebar reads while the Overview page is not showing, and the overview still reads its own state', async () => {
  const f = fixture();
  f.hideOverview();
  assert.equal((await f.call('overview:state', f.sidebar)).sessions.length, 3);
  assert.equal(await f.call('overview:state', f.overview), null, 'the hidden Overview page is still refused');
  const g = fixture();
  const page = await g.call('overview:state', g.overview);
  assert.equal(page.sessions.length, 3);
  assert.ok(page.sessions[0].handle, 'the Overview page gets its handles');
  await g.call('overview:state', g.sidebar);
  // The sidebar read left the Overview page's handles valid: opening with one is not 'stale' for that reason.
  const r = await g.call('overview:open', g.overview, { handle: page.sessions[0].handle });
  assert.notEqual(r.status, 'stale', JSON.stringify(r));
});

test('gate off: the sidebar gets nothing', async () => {
  const f = fixture({ chatPreview: false });
  assert.equal(await f.call('overview:state', f.sidebar), null);
  const g = fixture();
  g.sidebarOff();
  assert.equal(await g.call('overview:state', g.sidebar), null, 'no sidebar context → refused');
});

test('the sidebar is refused every other overview channel, including viewing, team-inspect, directory and followup-list', async () => {
  const f = fixture();
  f.hideOverview();
  const refused = (v) => v === null || (v && typeof v === 'object' && v.ok !== true && (v.status === 'unavailable' || v.status === 'stale' || 'error' in v));
  const argsFor = { 'overview:directory': [{ view: 'mine' }], 'overview:viewing': [{}], 'overview:team-inspect': [{}], 'overview:team-action': [{}], 'overview:team-message': [{}], 'overview:share-view': [{}], 'overview:open': [{ handle: '00000000-0000-4000-8000-000000000000' }], 'overview:message': [{ handle: '00000000-0000-4000-8000-000000000000', text: 'hi' }] };
  const names = Object.keys(f.ipc.handlers).filter((n) => n.startsWith('overview:') && n !== 'overview:state');
  assert.ok(names.includes('overview:viewing') && names.includes('overview:team-inspect') && names.includes('overview:followup-list') && names.includes('overview:directory'));
  for (const name of names) {
    const v = await f.call(name, f.sidebar, ...(argsFor[name] ?? []));
    assert.ok(refused(v), `${name} answered the sidebar: ${JSON.stringify(v)}`);
  }
});

test('a sidebar reload mid-read voids that read; the sidebar must pass no arguments', async () => {
  const f = fixture();
  f.delay();
  const pending = f.call('overview:state', f.sidebar);
  await new Promise((r) => setImmediate(r));
  f.reloadSidebar();
  f.release();
  assert.equal(await pending, null);
  const g = fixture();
  assert.equal(await g.call('overview:state', g.sidebar, {}), null);
  assert.equal(await g.call('overview:state', g.sidebar, { view: 'mine' }), null);
});

test('a page change elsewhere does not void an in-flight sidebar read (its generation is its own)', async () => {
  const f = fixture();
  f.delay();
  const pending = f.call('overview:state', f.sidebar);
  await new Promise((r) => setImmediate(r));
  f.hideOverview();
  f.release();
  assert.equal((await pending).sessions.length, 3);
});

test('a burst of sidebar reads is one source pass; a finished pass is reused for 5 s, then read again', async () => {
  let t = Date.parse('2026-10-27T10:00:00Z');
  const f = fixture({ now: () => t });
  f.delay();
  const burst = Array.from({ length: 6 }, () => f.call('overview:state', f.sidebar));
  await new Promise((r) => setImmediate(r));
  f.release();
  const outs = await Promise.all(burst);
  assert.equal(f.workCalls(), 1, 'six concurrent reads, one pass over the sources');
  assert.ok(outs.every((o) => o.sessions.length === 3));
  outs[0].sessions.length = 0; // each caller gets its own copy
  assert.equal(outs[1].sessions.length, 3);
  t += 4999;
  assert.equal((await f.call('overview:state', f.sidebar)).sessions.length, 3);
  assert.equal(f.workCalls(), 1, 'inside 5 s: reused');
  t += 2;
  await f.call('overview:state', f.sidebar);
  assert.equal(f.workCalls(), 2, 'after 5 s: read again');
  // The Overview page's own reads are not bounded or shared by this.
  await f.call('overview:state', f.overview);
  assert.equal(f.workCalls(), 3);
});

test('a reloaded sidebar never gets the old document\'s pass, even mid-read', async () => {
  let t = Date.parse('2026-10-27T10:00:00Z');
  const f = fixture({ now: () => t });
  await f.call('overview:state', f.sidebar);
  f.reloadSidebar();
  assert.equal((await f.call('overview:state', f.sidebar)).sessions.length, 3);
  assert.equal(f.workCalls(), 2, 'a new document reads afresh, inside 5 s');
  t += 6000;
  f.delay();
  const pending = f.call('overview:state', f.sidebar);
  await new Promise((r) => setImmediate(r));
  f.reloadSidebar();
  f.release();
  assert.equal(await pending, null, 'the pass started for the old document answers nobody');
  assert.equal((await f.call('overview:state', f.sidebar)).sessions.length, 3);
  assert.equal(f.workCalls(), 4);
});

test('sidebarRows: pinned keys, clamped values, path-like labels dropped, at most 200 rows', () => {
  const id = (n) => n.toString(16).padStart(64, '0');
  const rows = [
    { id: id(1), bucket: 'needs', task: { status: 'tracked', title: 'Ship it' }, project: 'alpha', age_ms: 1200.4, board: { kind: 'team' }, handle: 'x', capabilities: {}, cwd: '/Users/x' },
    { id: id(2), bucket: 'weird', task: { status: 'tracked', title: '/Users/me/secret/file.txt' }, project: '~/code/beta', age_ms: -1 },
    { id: id(3), bucket: 'working', provider: { id: 'claude' }, task: { status: 'unknown', title: 'Task not reported' }, project: 'billing' },
    { id: id(4), bucket: 'idle', provider: { id: 'mystery' }, project: 'Local project' },
    { id: 'not-an-id', bucket: 'needs' },
  ];
  const out = sidebarRows({ status: 'complete', rows, origins: new Map([[id(1), 'iTerm'], [id(2), '/Applications/Evil.app']]) });
  assert.deepEqual(out, { schema: 1, status: 'complete', sessions: [
    { id: id(1), bucket: 'needs', title: 'Ship it', project: 'alpha', origin: 'iTerm', age_ms: 1200, team: true, terminal: true, chat: false, thread: false },
    { id: id(2), bucket: 'idle', title: 'AI session', project: '', origin: null, age_ms: null, team: false, terminal: true, chat: false, thread: false },
    { id: id(3), bucket: 'working', title: 'Claude session in billing', project: 'billing', origin: null, age_ms: null, team: false, terminal: false, chat: false, thread: false },
    { id: id(4), bucket: 'idle', title: 'AI session', project: '', origin: null, age_ms: null, team: false, terminal: false, chat: false, thread: false },
  ] });
  const many = Array.from({ length: 250 }, (_, i) => ({ id: id(i + 10), bucket: 'idle' }));
  assert.equal(sidebarRows({ status: 'partial', rows: many }).sessions.length, 200);
  assert.deepEqual(sidebarRows(null), { schema: 1, status: 'unavailable', sessions: [] });
});

test('index.js: the sidebar context exists only with the gate on and has its own generation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  const ctx = src.slice(src.indexOf('    sidebarReadContext(){'), src.indexOf('    overviewReadContext(){'));
  assert.match(ctx, /^    sidebarReadContext\(\)\{\n      if\(chatFirst!==true\)return null;/);
  assert.match(ctx, /generation:sidebarGeneration,/);
  assert.doesNotMatch(ctx, /setupLocalGeneration/);
  assert.match(src, /if \(chatFirst === true\) sidebar\.webContents\.on\('did-start-navigation', \(\) => \{ sidebarGeneration\+\+; \}\);/);
  assert.equal((src.match(/sidebarGeneration\+\+/g) || []).length, 1, 'select() never bumps it');
  const om = fs.readFileSync(path.join(__dirname, '..', 'src', 'overview-main.js'), 'utf8');
  assert.equal((om.match(/fromSidebarDoc\(e\)/g) || []).length, 1, 'only overview:state consults the sidebar');
  assert.match(om, /ipc\.handle\('overview:state',async\(e,\.\.\.args\)=>\{const side=fromSidebarDoc\(e\);if\(side\)return sidebarState\(side,args\);/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), /createOverviewMain\(\{\n  buddy:\(\)=>buddyWin,chatPreview:CHAT_PREVIEW,/);
});
