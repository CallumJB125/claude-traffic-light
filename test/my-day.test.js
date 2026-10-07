const test = require('node:test');
const assert = require('node:assert/strict');
const { createMyDayBroker } = require('../src/my-day-broker');
const { createMyDayService, availability } = require('../src/my-day-service');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixture = () => ({ ok: true, status: 'complete', principal: { user_id: 'u1' }, cards: [{ member_id: 'm1', team_id: 't1', board_id: 'b1', board_name: 'Board', team_name: 'Team', card: { id: 'c1', key: 'T-1', title: 'Own work', start_date: '2026-10-01', due_date: '2026-10-02', run_state: 'todo', body: 'private body' } }], decisions: [], agents: [] });
test('main My day broker opens only fresh opaque own-work handles and rejects renderer-selected URLs', async () => {
  let current = true, value = fixture(), opened = 0;
  const source = { name: 'Registered hub', userId: 'u1', current: () => current, read: async () => value, open: async (row, fresh) => { assert.equal(row.card.id, 'c1'); assert.equal(fresh(), true); opened++; return true; } };
  const broker = createMyDayBroker({ sources: async () => [source] });
  const state = await broker.snapshot(), handle = state.sources[0].cards[0].handle;
  assert.equal(await broker.open('https://other.example/api/my-day'), false); assert.equal(await broker.open(handle), true); assert.equal(opened, 1);
  value = { ...value, cards: [] }; assert.equal(await broker.open(handle), false); assert.equal(opened, 1);
  current = false; assert.equal(await broker.open(handle), false);
});
test('held asynchronous summaries drop an account/device switch and mismatched principal', async () => {
  let current = true, release, entered;
  const gate = new Promise(r => { release = r; }), reached = new Promise(r => { entered = r; });
  const source = { name: 'Hub', userId: 'u1', current: () => current, read: async () => { entered(); await gate; return fixture(); }, open: async () => true };
  const broker = createMyDayBroker({ sources: async () => [source] }), pending = broker.snapshot();
  await reached; current = false; release(); assert.deepEqual(await pending, { status: 'changed', sources: [] });
  current = true; source.read = async () => ({ ...fixture(), principal: { user_id: 'different' } });
  assert.equal((await broker.snapshot()).sources[0].status, 'unavailable');
});
test('held open action checks account again after its scope read and handle expiry', async () => {
  let current = true, slow = false, release, entered, opened = 0, time = 0;
  const gate = new Promise(r => { release = r; }), reached = new Promise(r => { entered = r; });
  const source = { name: 'Hub', userId: 'u1', current: () => current, read: async () => { if (slow) { entered(); await gate; } return fixture(); }, open: async () => { opened++; return true; } };
  const broker = createMyDayBroker({ sources: async () => [source], now: () => time }), handle = (await broker.snapshot()).sources[0].cards[0].handle;
  slow = true; const pending = broker.open(handle); await reached; current = false; release(); assert.equal(await pending, false); assert.equal(opened, 0);
  current = true; slow = false; time = 45001; assert.equal(await broker.open(handle), false);
});
test('My day source and item bounds report partial/unavailable rather than success', async () => {
  let read = 0;
  const source = { name: 'Hub', userId: 'u1', current: () => true, read: async () => { read++; return fixture(); }, open: async () => true };
  const broker = createMyDayBroker({ sources: async () => Array(10).fill(source) });
  const state = await broker.snapshot(); assert.equal(state.status, 'partial'); assert.equal(state.sources.length, 9); assert.equal(read, 9);
  source.read = async () => ({ ...fixture(), cards: Array(501).fill(fixture().cards[0]) }); assert.equal((await broker.snapshot()).sources[0].status, 'unavailable');
});
test('My day service exposes own safe fields, labels reported freshness and excludes remote devices', async () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const service = createMyDayService({ work: async () => ({ status: 'complete', sources: [{ name: 'Hub', ...fixture() }] }), now: () => now, open: async () => true,
    sessions: () => [{ ai: 'Codex', label: 'Local', signal: 'tool-end', updatedAt: '2026-10-01T11:59:50Z', transcript: 'SECRET CHAT' }, { ai: 'Claude', updatedAt: '2026-10-01T11:00:00Z' }, { ai: 'Unknown' }, { remote: true, ai: 'Remote' }, { device: 'other', ai: 'Other device' }, { sessionId: 'remote:1', ai: 'Remote id' }],
    busy: () => ({ busy: true, reasons: ['SECRET EVENT'], calendar: { on: true, status: 'fullAccess', next: { title: 'SECRET EVENT' } }, focus: { on: false } }),
  });
  const state = await service.snapshot(); assert.equal(state.reported.length, 3); assert.deepEqual(state.reported.map(r => r.freshness), ['recent', 'stale', 'unknown']); assert.equal(state.availability.state, 'busy'); assert.equal(JSON.stringify(state).includes('SECRET'), false); assert.equal(JSON.stringify(state).includes('private body'), false);
});
test('calendar context never turns denied, errored, missing permission or unsupported feed into free time', () => {
  for (const input of [null, { busy: false, calendar: { on: true, status: 'denied' } }, { busy: false, calendar: { on: true, status: 'fullAccess', error: 'failed' } }, { busy: false, calendar: { on: false }, focus: { on: true, focused: false, error: 'failed' } }, { busy: false, calendar: { on: true, status: 'fullAccess' }, ics: { on: true } }]) assert.equal(availability(input).state, 'unknown');
  assert.equal(availability({ busy: false, calendar: { on: true, status: 'fullAccess' }, focus: { on: false } }).state, 'free');
  assert.equal(availability({ busy: false, calendar: { on: false }, focus: { on: true, via: null, focused: false } }).state, 'unknown');
  assert.equal(availability({ busy: true, calendar: { on: false }, focus: { on: true, via: 'assertions', focused: true } }).state, 'busy');
});
test('My day aggregate display limits remain bounded across registered hubs', async () => {
  const source = { name: 'Hub', status: 'complete', cards: Array(500).fill(fixture().cards[0]), decisions: [], agents: [] };
  const service = createMyDayService({ work: async () => ({ status: 'complete', sources: [source, source] }), open: async () => false });
  const result = await service.snapshot(); assert.equal(result.status, 'partial'); assert.equal(result.sources.reduce((n, s) => n + s.cards.length, 0), 500); assert.equal(result.sources[1].status, 'partial');
});
function productionBroker() {
  const source = fs.readFileSync(path.join(__dirname, '../buddy-window/index.js'), 'utf8');
  const body = source.slice(source.indexOf('  async function overviewSources()'), source.indexOf('  // A page with a localScreen'));
  const origin = 'https://registered.example', markers = new Map([[origin, { user: { id: 'u1' } }]]), launch = { url: 'http://127.0.0.1:43123' }, launches = { current: launch }, urls = [], reads = [];
  const local = { ...fixture(), principal: { member_id: 'local-owner' } };
  const workspaces = [{ id: 'local', kind: 'local' }, { id: 'team-ws', kind: 'team', hub: origin, teamId: 't1' }];
  let active = workspaces[0];
  const { pageById, hubPageUrl } = require('../buddy-window/pages');
  const context = { createMyDayBroker, setupLocalGeneration:0, store: { hubs: () => [origin], list: () => workspaces }, vault: key => ({ load: () => markers.get(key) }), userOf: key => markers.get(key)?.user, hostOf: url => new URL(url).host,
    clientFor: key => ({ myDay: async () => { reads.push(key); return fixture(); } }), supervisor: { ensure: async () => launch, launchCurrent: captured => launches.current === captured, myDay: async () => local },
    switchWorkspace(id) { active = workspaces.find(w => w.id === id); }, selected: 'myday', flow: { leftAccountPages() {} }, pageById, hubPageUrl, URL,
    hubView: { webContents: { loadURL: async url => { urls.push(url); } } }, hubInfo: null, async showHubPage() { context.hubInfo = active.kind === 'team' ? { origin, org: active.teamId, team: true } : { url: launch.url, team: false }; }, pushState() {},
  };
  vm.createContext(context); vm.runInContext(`${body}\nthis.broker = myDayBroker;this.overviewSources=overviewSources;`, context);
  return { broker: context.broker, context, markers, origin, launch, launches, urls, reads };
}
test('production desktop My day wiring uses registered hubs and fixed local launch, then opens the verified board/card', async () => {
  const p = productionBroker(), state = await p.broker.snapshot(); assert.equal(state.status, 'complete'); assert.equal(state.sources[0].name, 'My board (this Mac)'); assert.deepEqual(p.reads, [p.origin]);
  assert.equal(await p.broker.open(state.sources[1].cards[0].handle), true);
  const target = new URL(p.urls[0]); assert.equal(target.origin, p.origin); assert.equal(target.searchParams.get('org'), 't1'); assert.equal(target.searchParams.get('board'), 'b1'); assert.equal(target.hash, '#card=c1');
});
test('production desktop source keeps signed-out hubs visibly unavailable and rejects replaced embedded launches', async () => {
  const p = productionBroker(); p.markers.set(p.origin, null);
  const state = await p.broker.snapshot(); assert.equal(state.status, 'partial'); assert.equal(state.sources[1].status, 'unavailable'); assert.equal(p.reads.length, 0);
  p.launches.current = { ...p.launch }; assert.equal((await p.broker.snapshot()).status, 'changed');
});
test('production main My day handlers accept only the exact registered top-level local page', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), body = source.slice(source.indexOf('const MyDay = require('), source.indexOf('const SessionOverview = require(')) + source.slice(source.indexOf("ipcMain.handle('myday:state'"), source.indexOf('\nfunction openBuddy('));
  const handlers = new Map(), frame = {}, page = { mainFrame: frame };
  const context = { require: name => { assert.equal(name, './src/my-day-service.js'); return { createMyDayService: () => ({ snapshot: () => 'own snapshot', open: id => id === 'allowed-handle' }) }; }, buddyWin: { pageWebContents: id => id === 'myday' ? page : null }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, localSessions: v => v, aggregateState: () => ({ sessions: [] }), BusyWatch: { status: () => null } };
  vm.createContext(context); vm.runInContext(body, context);
  assert.equal(handlers.get('myday:state')({ sender: page, senderFrame: frame }), 'own snapshot');
  assert.equal(handlers.get('myday:state')({ sender: page, senderFrame: {} }), null);
  assert.equal(handlers.get('myday:state')({ sender: null, senderFrame: frame }), null);
  assert.equal(handlers.get('myday:state')({ sender: { mainFrame: frame }, senderFrame: frame }), null);
  assert.equal(handlers.get('myday:open')({ sender: page, senderFrame: frame }, 'allowed-handle'), true);
  assert.equal(handlers.get('myday:open')({ sender: page, senderFrame: frame }, 'https://renderer.example'), false);
  assert.equal(typeof handlers.get('myday:show-meetings'), 'function');
  assert.equal(handlers.get('myday:show-meetings')({ sender: page, senderFrame: {} }), false, 'only the registered page can ask');
  context.buddyWin = { pageWebContents: () => ({ mainFrame: frame }) };
  assert.equal(handlers.get('myday:state')({ sender: page, senderFrame: frame }), null);
  assert.equal(handlers.get('myday:open')({ sender: page, senderFrame: frame }, 'allowed-handle'), false);
});

test('Overview production navigation refuses a changed board document generation after its await',async()=>{
 const p=productionBroker(),sources=await p.context.overviewSources();let release;
 p.context.showHubPage=()=>new Promise(r=>release=r);
 const pending=sources[1].open(fixture().cards[0],()=>true,()=>true);
 await Promise.resolve();p.context.setupLocalGeneration++;release();
 assert.equal(await pending,false);assert.equal(p.urls.length,0);
});
test('Overview production registered source sends a selected fixed card/run/fence through native account route only',async()=>{
 const p=productionBroker(),calls=[];p.context.clientFor=()=>({nativeBoard:async(...args)=>{calls.push(args);return{ok:true};},myDay:async()=>fixture()});
 const sources=await p.context.overviewSources(),row={...fixture().cards[0],card:{...fixture().cards[0].card,fence:7,run:{id:'selected-run'}}};
 assert.equal((await sources[1].send(row,'Explicit message','selected-request',()=>true)).ok,true);
 assert.equal(calls.length,1);assert.equal(calls[0][0],'sendMessage');assert.equal(calls[0][1].card,'c1');assert.equal(calls[0][1].team,'t1');assert.deepEqual(Array.from(calls[0][1].boardIds),['b1']);assert.equal(calls[0][2].expected_fence,7);assert.equal(calls[0][2].recipient_run_ids[0],'selected-run');
 await sources[1].send(row,'No send','another-request',()=>false);assert.equal(calls.length,1);
});
test('My day states use the board vocabulary instead of raw run_state', async () => {
  const value = fixture(); value.cards[0].state = 'in_progress';
  const service = createMyDayService({ work: async () => ({ status: 'complete', sources: [{ name: 'Hub', status: 'complete', cards: value.cards, decisions: [], agents: [] }] }) });
  assert.equal((await service.snapshot()).sources[0].cards[0].state, 'In progress');
});

test('calendar opt-in: offered only with the helper and only while off; the click alone enables it', async () => {
  let enabled = 0, helper = true;
  const service = createMyDayService({ work: async () => ({ status: 'complete', sources: [] }), open: async () => false, busy: () => ({ busy: false, calendar: { on: false }, focus: { on: false } }), calendarHelper: () => helper, enableCalendar: () => { enabled++; } });
  assert.equal((await service.snapshot()).availability.can_enable, true);
  assert.equal(enabled, 0, 'a snapshot never asks for permission');
  assert.equal(await service.showMeetings(), true); assert.equal(enabled, 1);
  helper = false;
  assert.equal((await service.snapshot()).availability.can_enable, false);
  assert.equal(await service.showMeetings(), false); assert.equal(enabled, 1);
  const on = createMyDayService({ work: async () => ({ status: 'complete', sources: [] }), open: async () => false, busy: () => ({ busy: false, calendar: { on: true, status: 'fullAccess' }, focus: { on: false } }), calendarHelper: () => true });
  assert.equal((await on.snapshot()).availability.can_enable, false, 'nothing to offer once on');
});
test('My day page: no availability block; a plain sentence when known; the button only when offered', async () => {
  const body = fs.readFileSync(path.join(__dirname, '../myday.js'), 'utf8');
  const el = tag => ({ tag, children: [], className: '', textContent: '', listeners: {}, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, addEventListener(t, f) { this.listeners[t] = f; } });
  const text = n => `${n.textContent ?? ''}${(n.children ?? []).map(text).join('')}`;
  const buttons = n => [...(n.tag === 'button' ? [n] : []), ...(n.children ?? []).flatMap(buttons)];
  const run = async availability => {
    const content = el('div'), status = el('p'); let asked = 0;
    const context = { document: { getElementById: id => id === 'content' ? content : id === 'status' ? status : el('button'), createElement: el, addEventListener() {}, hidden: false }, window: { myDayApi: { state: async () => ({ status: 'complete', sources: [], reported: [], availability, observed_at: 0 }), showMeetings: async () => { asked++; return true; }, open: async () => true, changed: () => {} } }, setInterval: () => 0, clearInterval: () => {}, console };
    vm.createContext(context); vm.runInContext(body, context); await new Promise(r => setImmediate(r)); return { content, asked: () => asked };
  };
  const off = await run({ state: 'unknown', calendar: 'off', focus: 'off', can_enable: false });
  assert.doesNotMatch(text(off.content), /Availability|Calendar|focus/i);
  assert.equal(buttons(off.content).length, 0);
  const busy = await run({ state: 'busy', calendar: 'available', focus: 'off', can_enable: false });
  assert.match(text(busy.content), /You are busy right now\./);
  const offer = await run({ state: 'unknown', calendar: 'off', focus: 'off', can_enable: true });
  const ask = buttons(offer.content).find(b => b.textContent === 'Show my meetings');
  assert.ok(ask); assert.equal(offer.asked(), 0, 'rendering never asks');
  await ask.listeners.click(); assert.equal(offer.asked(), 1);
});
