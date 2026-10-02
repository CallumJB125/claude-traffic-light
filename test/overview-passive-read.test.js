'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {createOverviewMain} = require('../src/overview-main');
const {createOverviewService} = require('../src/overview-service');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const state = { visible: true, focused: true, minimized: false, destroyed: false, loading: false, generation: 1, selected: 'overview' };
  const dir = path.join(__dirname, '../buddy-window'), expected = pathToFileURL(path.join(dir, '..', 'overview.html')).href;
  const wc = { getURL: () => state.url, mainFrame: { url: expected }, isDestroyed: () => state.destroyed, isLoading: () => state.loading };
  state.url = expected;
  const view = { webContents: wc }, win = { isDestroyed: () => state.destroyed, isVisible: () => state.visible, isFocused: () => state.focused, isMinimized: () => state.minimized, contentView: { children: [view] } };
  const context = { win, selected: state.selected, content: view, localViews: new Map([['overview', view]]), path, pathToFileURL, DIR: dir, setupLocalGeneration: 1 };
  // Both methods are copied from the actual shipped Buddy factory, not mocks.
  const source = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
  const methods = source.slice(source.indexOf('    overviewReadContext(){'), source.indexOf('    setupSources,', source.indexOf('    overviewReadContext(){')));
  vm.runInNewContext(`globalThis.buddy={${methods}}`, context);
  const row = { board_id: 'board', board_name: 'Personal', member_id: 'member', card: { id: 'card', title: 'Human card title', key: 'T-1', fence: 1, repo: { id: 'repo' }, run: { id: 'run', ai: 'codex' }, run_state: 'running', live: { hb_age_ms: 1 } } };
  const data = { ok: true, status: 'complete', principal: { user_id: 'owner' }, cards: [row], agents: [{ card_id: 'card', board_id: 'board', member_id: 'member', connection: 'accepted', live: { green: true, hb_age_ms: 1 } }] };
  let readDelay = null, sendDelay = null, workDelay = null, reads = 0, effects = 0, identity = true;
  const sourceRecord = { key: 'source', kind: 'personal', userId: 'owner', current: () => identity, read: async () => { reads++; if (readDelay) await readDelay(); return data; }, open: async (_r, fresh) => { if (sendDelay) await sendDelay(); if (!fresh()) return false; effects++; return true; }, send: async (_r, _text, _id, fresh) => { if (sendDelay) await sendDelay(); if (!fresh()) return { ok: false }; effects++; return { ok: true }; } };
  const main = createOverviewMain({ buddy: () => context.buddy, sessions: () => [], work: async () => { if (workDelay) await workDelay(); return { sources: [sourceRecord], capture: [] }; } });
  const ipc = { handlers: {}, handle(name, fn) { this.handlers[name] = fn; } }; main.register(ipc);
  const event = { sender: wc, senderFrame: wc.mainFrame };
  return { state, context, win, wc, row, data, sourceRecord, main, event, read: (...args) => ipc.handlers['overview:state'](event, ...args), action: (kind, request) => ipc.handlers[`overview:${kind}`](event, request), rawRead: (...args) => ipc.handlers['overview:state'](...args), get reads() { return reads; }, get effects() { return effects; }, blur() { state.focused = false; context.setupLocalGeneration++; }, focus() { state.focused = true; }, holdRead(fn) { readDelay = fn; }, holdSend(fn) { sendDelay = fn; }, holdWork(fn) { workDelay = fn; }, revoke() { identity = false; } };
}
test('actual Buddy passive context preserves visible exact document unfocused; focused context remains unavailable', () => {
  const x = fixture(); assert.equal(x.context.buddy.overviewContext().foreground, true); x.blur();
  const passive = x.context.buddy.overviewReadContext(); assert.equal(passive.foreground, false); assert.equal(passive.window, x.win); assert.equal(passive.contents, x.wc); assert.equal(x.context.buddy.overviewContext(), null);
});
for (const [name, change] of [
  ['hidden', x => x.state.visible = false], ['minimized', x => x.state.minimized = true], ['destroyed', x => x.state.destroyed = true],
  ['detached', x => x.win.contentView.children = []], ['other selected', x => x.context.selected = 'board'], ['replaced view', x => x.context.content = {}],
  ['foreign URL', x => x.state.url += '?foreign=1'], ['foreign frame', x => x.wc.mainFrame.url = 'https://foreign.example'], ['loading', x => x.state.loading = true],
]) test(`passive ${name} refuses before source read and effects`, async () => {
  const x = fixture(); x.blur(); change(x); assert.equal(await x.read(), null); assert.equal(x.reads, 0); assert.equal(x.context.buddy.overviewReadContext(), null);
});
test('passive real IPC still rejects siblings, subframes and arbitrary state authority', async () => {
  const x = fixture(); x.blur();
  assert.equal(await x.rawRead({ sender: {}, senderFrame: x.wc.mainFrame }), null); assert.equal(await x.rawRead({ sender: x.wc, senderFrame: {} }), null);
  assert.equal(await x.read({ actor: 'forged' }), null); assert.equal(x.reads, 0);
});
test('unfocused passive snapshot retains real human title/fresh activity and projects disabled controls with closed shape', async () => {
  const x = fixture(); x.blur(); const dto = await x.read(), row = dto.sessions[0];
  assert.equal(dto.status, 'complete'); assert.equal(row.task.title, 'Human card title'); assert.equal(row.status, 'Working');
  for (const kind of ['open', 'message']) { assert.equal(row.capabilities[kind].enabled, false); assert.equal(row.capabilities[kind].reason, 'Focus Plexiform and refresh before acting.'); }
  assert.deepEqual(Object.keys(dto).sort(), ['observed_at', 'omitted', 'schema', 'sessions', 'status']);
  assert.equal((await x.action('open', { handle: row.handle })).ok, false); assert.equal((await x.action('message', { handle: row.handle, text: 'Hi' })).ok, false); assert.equal(x.effects, 0);
  x.focus(); const current = (await x.read()).sessions[0]; assert.equal(current.capabilities.message.enabled, true); assert.equal((await x.action('message', { handle: current.handle, text: 'Hi' })).status, 'queued'); assert.equal(x.effects, 1);
});
test('focus lost while passive source await finishes remains readable with final controls disabled', async () => {
  const x = fixture(); let release; x.holdRead(() => new Promise(r => release = r)); const pending = x.read(); await tick();
  // Real blur retires this captured generation, so the old read is withheld.
  x.blur(); release(); assert.equal(await pending, null); x.holdRead(null);
  const dto = await x.read(); assert.equal(dto.sessions.length, 1); assert.equal(dto.sessions[0].capabilities.open.enabled, false);
});
test('passive capture can finish while still unfocused and becomes actionable only under current foreground checks', async () => {
  const x = fixture(); x.blur(); let release; x.holdRead(() => new Promise(r => release = r)); const pending = x.read(); await tick(); release();
  const row = (await pending).sessions[0]; assert.equal(row.capabilities.message.enabled, false); assert.equal((await x.action('message', { handle: row.handle, text: 'Hi' })).ok, false); assert.equal(x.effects, 0);
});
for (const boundary of ['source read', 'before effect']) for (const kind of ['open', 'message']) test(`foreground ${kind} loses focus during ${boundary}, refuses every pending effect and retired handles`, async () => {
  const x = fixture(), row = (await x.read()).sessions[0]; let release;
  if (boundary === 'source read') x.holdRead(() => new Promise(r => release = r)); else x.holdSend(() => new Promise(r => release = r));
  const pending = x.action(kind, { handle: row.handle, ...(kind === 'message' ? { text: 'Hi' } : {}) }); await tick(); x.blur(); release();
  assert.equal((await pending).ok, false); assert.equal(x.effects, 0); x.focus(); assert.equal((await x.action('open', { handle: row.handle })).ok, false);
});
for (const mutation of ['title', 'principal', 'source']) test(`passive reads do not bypass current ${mutation} retirement during an explicit action`, async () => {
  const x = fixture(), row = (await x.read()).sessions[0]; let release; x.holdRead(() => new Promise(r => release = r));
  const pending = x.action('message', { handle: row.handle, text: 'Hi' }); await tick();
  if (mutation === 'title') x.row.card.title = 'Human replacement'; if (mutation === 'principal') x.data.principal.user_id = 'replacement'; if (mutation === 'source') x.revoke(); release();
  assert.equal((await pending).ok, false); assert.equal(x.effects, 0);
});
test('source snapshot rechecks actionCurrent at final projection without changing private source authority', async () => {
  let focused = true, release;
  const task = { id: 'task', title: 'Task', state: 'running', ai: { id: 'codex' }, label: 'Working', green: true, actions: ['message'] };
  const svc = createOverviewService({ current: () => true, actionCurrent: () => focused, work: () => new Promise(r => release = r), managed: () => ({ conn: { status: 'connected' }, tasks: [task] }), messageManaged: async (_id, _text, fresh) => ({ ok: fresh() }) });
  const pending = svc.snapshot(); await tick(); focused = false; release({ sources: [], capture: [] }); const row = (await pending).sessions[0]; assert.equal(row.capabilities.message.enabled, false);
  assert.equal((await svc.message({ handle: row.handle, text: 'Hi' })).ok, false);
});
test('main final await recomputes focus even after service projection was complete', async () => {
  const x = fixture();
  const original = x.context.buddy.overviewContext;
  x.context.buddy.overviewContext = () => {
    const context = original();
    if (context) queueMicrotask(() => { x.state.focused = false; });
    return context;
  };
  const dto = await x.read(); assert.equal(dto.sessions.length, 1); assert.equal(x.state.focused, false);
  assert.equal(dto.sessions[0].capabilities.open.enabled, false); assert.equal(dto.sessions[0].capabilities.message.enabled, false);
  assert.equal((await x.action('message', { handle: dto.sessions[0].handle, text: 'Hi' })).ok, false); assert.equal(x.effects, 0);
});
