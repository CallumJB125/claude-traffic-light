'use strict';
// Overview owned-session UI driven through the real preload bridge, the real
// interaction IPC (interaction-main) and the real hub, with an in-memory
// provider adapter standing in for Codex.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { createInteractionMain, CHANNELS } = require('../src/interaction-main');
const { createOverviewService } = require('../src/overview-service');
const html = fs.readFileSync(path.join(__dirname, '../overview.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../overview.js'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, '../overview-preload.js'), 'utf8');
const routerScript = fs.readFileSync(path.join(__dirname, '../src/session-router.js'), 'utf8');
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const ALLOWED = new Set(['overview:state', 'overview:open', 'overview:message', ...Object.values(CHANNELS).filter((c) => c !== CHANNELS.event)]);
const U = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function memAdapter({ label = 'Codex', steer = true, interrupt = true, target = 'target-1' } = {}) {
  const ee = new EventEmitter(); const calls = [];
  return {
    label, calls,
    capabilities: { newTurn: true, steer, interrupt, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false },
    emit: (e) => ee.emit('e', e),
    open: async () => ({ target }),
    async send(a) { calls.push(a); return a.expectedTurnId ? { turnId: a.expectedTurnId, mode: 'steer' } : { turnId: `turn-${calls.length}`, mode: 'new-turn' }; },
    interrupt: async () => true, release: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}
function loadBridge(ipcRenderer) {
  let api, exposed = 0;
  vm.runInNewContext(bridge, { Buffer, Promise, require: (name) => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, value) { exposed++; assert.equal(name, 'overviewApi'); api = value; } }, ipcRenderer }; } });
  assert.equal(exposed, 1, 'one narrow global only');
  return api;
}
function stack({ snapshot = { schema: 1, status: 'complete', observed_at: Date.now(), omitted: 0, sessions: [] }, extra = {}, local = { endpoints: [], models: [] }, router = true } = {}) {
  const handlers = new Map(), listeners = new Map(), invoked = [];
  const contents = { id: 9, isDestroyed: () => false, mainFrame: {}, send: (ch, s) => { for (const fn of listeners.get(ch) ?? []) fn({ sender: 'private-event' }, structuredClone(s)); } };
  const ctx = { contents, generation: 1, document: 1, foreground: true };
  let board = 'local', readable = true;
  const adapter = memAdapter();
  const main = createInteractionMain({ context: () => (ctx.foreground ? ctx : null), readContext: () => (readable ? ctx : null), adapters: { codex: adapter, ...extra }, owned: null, workspace: () => null, currentBoard: () => board, localModels: { refresh: async () => (typeof local === 'function' ? local() : local) } });
  main.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const api = loadBridge({
    invoke: (ch, ...args) => { invoked.push(ch); if (ch === 'overview:state') return Promise.resolve(snapshot); return Promise.resolve(handlers.get(ch)({ sender: contents, senderFrame: contents.mainFrame }, ...structuredClone(args))); },
    on: (ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, new Set()); listeners.get(ch).add(fn); },
    removeListener: (ch, fn) => listeners.get(ch)?.delete(fn),
  });
  let ready;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const intervals = [];
  dom.window.setInterval = (fn) => intervals.push(fn);
  dom.window.overviewApi = { ...api, onReady: (fn) => { ready = fn; return () => {}; } };
  if (router) dom.window.eval(routerScript);
  dom.window.eval(script);
  const doc = dom.window.document;
  const card = (n = 0) => doc.querySelectorAll('.owned-session')[n] ?? null;
  const option = (id) => doc.querySelector(`#provider-list input[value="${id}"]`);
  const start = async (id = 'codex') => { const o = option(id); o.checked = true; o.dispatchEvent(new dom.window.Event('change')); doc.getElementById('start-session').click(); await tick(); };
  const btn = (label) => [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
  return {
    dom, doc, adapter, ctx, main, invoked, card, btn, option, start, handlers, contents,
    ready: async () => { ready(); await tick(); },
    poll: async () => { for (const fn of intervals) fn(); await tick(); },
    type: (value) => { const t = card().querySelector('textarea'); t.value = value; t.dispatchEvent(new dom.window.Event('input')); return t; },
    setBoard: (b) => { board = b; }, setReadable: (v) => { readable = v; },
    close: () => { main.close(); dom.window.close(); },
  };
}

test('Owned UI: start, send a literal message and see ack → recorded → responding → completed live', async () => {
  const s = stack();
  try {
    await s.ready();
    const start = s.doc.getElementById('start-session');
    assert.equal(s.doc.getElementById('owned-section').hidden, false);
    assert.equal(start.disabled, false);
    assert.equal(start.textContent, 'Start Codex session');
    start.click(); await tick();
    assert.match(s.card().textContent, /Started by Plexiform · Codex/);
    assert.equal(s.doc.activeElement, s.card().querySelector('textarea'), 'new session is selected for typing');
    s.type('  ping <b>nonce</b>  ');
    s.btn('Send').click(); await tick();
    assert.equal(s.adapter.calls.length, 1); assert.equal(s.adapter.calls[0].text, 'ping <b>nonce</b>', 'literal text, trimmed');
    assert.match(s.card().textContent, /Acknowledged by Codex/);
    assert.match(s.card().textContent, /Delivered: Codex acknowledged this message/);
    assert.equal(s.card().querySelector('.delivery-text b'), null, 'user text is not markup');

    // Draft and focus survive pushes.
    const box = s.type('draft in progress'); box.focus();
    s.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'turn-1' }); await tick();
    assert.match(s.card().querySelector('.tag').textContent, /Working/);
    assert.equal(s.btn('Send').disabled, true); assert.equal(s.btn('Steer current turn').disabled, false); assert.equal(s.btn('Interrupt').disabled, false);
    s.adapter.emit({ kind: 'input-recorded', target: 'target-1', turnId: 'turn-1', clientId: s.adapter.calls[0].clientId, text: 'ping <b>nonce</b>' }); await tick();
    assert.match(s.card().textContent, /Recorded by Codex/);
    s.adapter.emit({ kind: 'delta', target: 'target-1', turnId: 'turn-1', text: '<img src=x onerror="globalThis.pwned=1">PONG' }); await tick();
    assert.match(s.card().textContent, /Responding…/);
    assert.equal(s.card().querySelector('.delivery-response').textContent, '<img src=x onerror="globalThis.pwned=1">PONG');
    assert.equal(s.doc.querySelector('img'), null, 'response is text, never markup');
    s.adapter.emit({ kind: 'refused-request', target: 'target-1', turnId: 'turn-1' }); await tick();
    assert.match(s.card().textContent, /asked for an approval; Plexiform refused it/);
    s.adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: 'turn-1', status: 'completed' }); await tick();
    assert.match(s.card().textContent, /Completed/);
    assert.equal(s.btn('Send').disabled, false);
    assert.equal(s.doc.activeElement, box); assert.equal(box.value, 'draft in progress');
    for (const ch of s.invoked) assert(ALLOWED.has(ch), ch);
  } finally { s.close(); }
});

test('Owned UI: focus changes keep the session; a stale board refusal is shown with its reason', async () => {
  const s = stack();
  try {
    await s.ready();
    await s.start();
    // Window blur/refocus bumps Buddy's generation; ownership follows the document.
    s.ctx.generation += 5;
    s.type('one'); s.btn('Send').click(); await tick();
    assert.equal(s.adapter.calls.length, 1, 'refocused page can still send');
    s.adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: 'turn-1', status: 'completed' }); await tick();
    s.setBoard('team:example:t1');
    s.type('two'); s.btn('Send').click(); await tick();
    assert.equal(s.adapter.calls.length, 1, 'no provider effect for a stale board');
    assert.match(s.card().textContent, /Refused: stale\. This session belongs to another board/);
    assert.equal(s.card().querySelector('textarea').value, 'two', 'refused draft is kept');
    // Never 'Ready' with Send enabled while on another board; Interrupt/Close stay usable.
    assert.equal(s.card().querySelector('.tag').textContent, 'On another board — switch back to use it');
    assert.equal(s.btn('Send').disabled, true);
    assert.equal(s.btn('Close session').disabled, false);
    assert.equal(s.btn('Check again').hidden, false);
    await s.poll();
    assert.equal(s.btn('Send').disabled, true, 'a poll does not silently re-enable Send');
    s.setBoard('local');
    s.btn('Check again').click(); await tick();
    assert.match(s.card().querySelector('.tag').textContent, /Ready/);
    assert.equal(s.btn('Check again').hidden, true);
    s.btn('Send').click(); await tick();
    assert.equal(s.adapter.calls.length, 2);
  } finally { s.close(); }
});

test('Owned UI: rows never vanish — unreadable state keeps the card; a reloaded document reaps it and the card shows Ended', async () => {
  const s = stack();
  try {
    await s.ready();
    await s.start();
    s.type('hello'); s.btn('Send').click(); await tick();
    s.setReadable(false); await s.poll();
    assert.ok(s.card(), 'card kept when state cannot be read');
    assert.match(s.doc.getElementById('owned-status').textContent, /Showing the last known state/);
    s.setReadable(true);
    s.ctx.document = 2; // a new document of the same contents: the old actor is reaped
    await s.poll();
    assert.ok(s.card(), 'card kept after its session is gone');
    assert.match(s.card().querySelector('.tag').textContent, /Ended/);
    assert.match(s.card().textContent, /hello/, 'last known messages stay readable');
    assert.equal(s.btn('Send').disabled, true);
    assert.equal(s.card().querySelector('textarea').disabled, true);
    s.btn('Dismiss').click();
    assert.equal(s.card(), null);
    assert.match(s.doc.getElementById('owned').textContent, /No Plexiform sessions/);
  } finally { s.close(); }
});

test('Owned UI: close removes the card; unavailable Codex disables Start with its reason', async () => {
  const s = stack();
  try {
    await s.ready();
    await s.start();
    s.btn('Close session').click(); await tick();
    assert.equal(s.card(), null);
    assert.match(s.doc.getElementById('owned-status').textContent, /Session closed/);
  } finally { s.close(); }
  const u = stack();
  try {
    u.adapter.available = false; u.adapter.reason = 'Codex CLI not found';
    await u.ready();
    const start = u.doc.getElementById('start-session');
    assert.equal(start.disabled, true); assert.equal(start.title, 'Choose an available AI first.');
    assert.equal(u.option('codex').disabled, true);
    assert.match(u.option('codex').closest('label').textContent, /Codex\s*Unavailable\s*Codex CLI not found/);
  } finally { u.close(); }
});

test('Bridge: interaction calls are closed primitive projections; forged board/actor/provider never reach IPC', async () => {
  const calls = [], subscriptions = [];
  const api = loadBridge({ invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); }, on: (ch, fn) => subscriptions.push([ch, fn]), removeListener: () => {} });
  const ix = api.interaction;
  await ix.list(); await ix.capabilities(); await ix.state({ session: U(1) });
  await ix.launch({ provider: 'codex' });
  await ix.send({ session: U(1), generation: 1, text: ' hi ' });
  await ix.send({ session: U(1), generation: 1, text: 'steer', expectedTurn: U(2) });
  await ix.interrupt({ session: U(1), generation: 1, turn: U(2) });
  await ix.close({ session: U(1), generation: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['interaction:list'], ['interaction:capabilities'], ['interaction:state', { session: U(1) }], ['interaction:launch', { provider: 'codex' }],
    ['interaction:send', { session: U(1), generation: 1, text: 'hi' }], ['interaction:send', { session: U(1), generation: 1, text: 'steer', expectedTurn: U(2) }],
    ['interaction:interrupt', { session: U(1), generation: 1, turn: U(2) }], ['interaction:close', { session: U(1), generation: 1 }]]);
  const before = calls.length;
  for (const r of [{ provider: 'codex', board: 'b' }, { provider: 'Claude Code' }, { provider: '__proto__' }, { provider: '../x' }, { provider: 'a'.repeat(81) }, { provider: 7 }, { provider: 'codex', actor: 'x' }, null]) assert.equal((await ix.launch(r)).status, 'invalid');
  for (const r of [{ session: U(1), generation: 1, text: 'x', board: 'b' }, { session: U(1), generation: 1, text: 'x', actor: 'overview:1:1' }, { session: 'x', generation: 1, text: 'x' }, { session: U(1), generation: '1', text: 'x' }, { session: U(1), generation: 1, text: 'x', expectedTurn: 'turn-1' }, { session: U(1), generation: 1, text: ' ' }, { session: U(1), generation: 1, text: 'a\0b' }, { session: U(1), generation: 1, text: 'a'.repeat(4001) }]) assert.equal((await ix.send(r)).status, 'invalid');
  assert.equal((await ix.interrupt({ session: U(1), generation: 1 })).status, 'invalid');
  assert.equal((await ix.close({ session: U(1), generation: 1, target: 't' })).status, 'invalid');
  assert.equal(await ix.state({ session: U(1), actor: 'x' }), null);
  assert.equal(calls.length, before, 'nothing forged reached IPC');
  let got = []; const off = ix.onEvent((...a) => got.push(a));
  assert.equal(subscriptions.length, 1); assert.equal(subscriptions[0][0], 'interaction:event');
  subscriptions[0][1]({ sender: 'private' }, { session: U(1) }, 'extra'); subscriptions[0][1]({ sender: 'private' }, 'string');
  subscriptions[0][1]({ sender: 'private' }, { session: U(1) });
  assert.deepEqual(got, [[{ session: U(1) }]], 'only the single state object, never the IPC event');
  assert.equal(typeof off, 'function'); assert.equal(typeof ix.onEvent(null), 'function'); assert.equal(subscriptions.length, 1);
  assert.equal(api.interaction.adopt, undefined);
});

test('Unmanaged Codex parent keeps Message disabled with the exact reason, even when stale', async () => {
  const time = Date.parse('2026-10-02T10:00:00Z');
  const raw = { sessionId: 'private-session', source: 'codex', signal: 'tool-use', codexLifecycle: 1, codexClosedTurn: false, codexTurnId: 'turn', codexHookAt: new Date(time - 10).toISOString(), updatedAt: new Date(time - 10).toISOString(), cwd: '/Users/private/project' };
  const svc = createOverviewService({ sessions: () => [raw], work: async () => ({ sources: [], capture: [] }), current: () => true, now: () => time });
  const snap = await svc.snapshot();
  const msg = snap.sessions[0].capabilities.message;
  assert.equal(msg.enabled, false);
  assert.equal(msg.reason, 'Plexiform can message sessions it starts itself. This one was started in Codex, which has no supported way for another app to send to it.');
  assert.doesNotMatch(msg.reason, /opt|daemon/, 'no promise of a setting that does not exist');
  snap.observed_at = Date.now() - 200_000; // stale on the page
  const s = stack({ snapshot: snap });
  try {
    await s.ready();
    const button = [...s.doc.querySelectorAll('#content button')].find((b) => b.textContent === 'Message');
    assert.equal(button.disabled, true);
    assert.match(s.doc.getElementById('content').textContent, /This one was started in Codex, which has no supported way for another app to send to it\./);
  } finally { s.close(); }
});

// ── Multi-provider picker, local models, Ask all, router hint ──
const { NOT_VERIFIED } = require('../src/gemini-acp');
const LOCAL = 'local-ollama-0123456789';
function multi(opts = {}) {
  const claude = memAdapter({ label: 'Claude Code', steer: false, target: 'claude-1' });
  const gemini = Object.assign(memAdapter({ label: 'Gemini CLI', steer: false, target: 'g-1' }), { available: false, reason: NOT_VERIFIED });
  const llama = memAdapter({ label: 'llama3.2 · Ollama (this computer)', steer: false, interrupt: true, target: 'l-1' });
  let lastUsed = null;
  const local = opts.local ?? (() => ({ endpoints: [{ id: 'ollama', label: 'Ollama (this computer)', kind: 'ollama', source: 'discovered', reachable: true, error: null, checkedAt: 1, host: '127.0.0.1:11434', publicOptIn: false, keyFromEnv: null }], models: [{ provider: LOCAL, model: 'llama3.2', endpoint: 'ollama', endpointLabel: 'Ollama (this computer)', reachable: true, lastUsed }] }));
  const s = stack({ ...opts, extra: { claude, gemini, [LOCAL]: llama, ...opts.extra }, local });
  return Object.assign(s, { claude, gemini, llama, setLastUsed: (v) => { lastUsed = v; } });
}

test('Picker lists every provider with availability and the exact reason; capability-aware cards per provider', async () => {
  const s = multi();
  try {
    await s.ready();
    const rows = [...s.doc.querySelectorAll('#provider-list .provider-option')];
    assert.deepEqual(rows.map((r) => r.querySelector('.provider-name').textContent), ['Codex', 'Claude Code', 'Gemini CLI', 'llama3.2 · Ollama (this computer)']);
    assert.equal(s.option('gemini').disabled, true);
    assert.equal(s.option('gemini').closest('label').querySelector('.reason').textContent, NOT_VERIFIED, 'exact reason, not a summary');
    assert.equal(s.option('gemini').closest('label').querySelector('.tag').textContent, 'Unavailable');
    for (const id of ['codex', 'claude', LOCAL]) assert.equal(s.option(id).disabled, false, id);
    assert.equal(s.option('codex').checked, true, 'Codex preselected when available');
    assert.equal(s.doc.getElementById('start-session').textContent, 'Start Codex session');

    await s.start('claude');
    assert.equal(s.claude.calls.length, 0);
    const c = s.card(0);
    assert.equal(c.querySelector('h3').textContent, 'Claude Code session');
    assert.match(c.querySelector('.row-meta').textContent, /^Started by Plexiform · Claude Code/);
    assert.equal(s.btn('Steer current turn').hidden, true, 'Claude Code cannot steer: Steer not offered');
    assert.equal(s.btn('Interrupt').hidden, false);
    assert.equal(c.querySelector('label').textContent, 'Message this Claude Code session');
    s.type('hi claude'); s.btn('Send').click(); await tick();
    assert.equal(s.claude.calls[0].text, 'hi claude'); assert.equal(s.adapter.calls.length, 0, 'only the chosen provider');
    assert.match(c.textContent, /Acknowledged by Claude Code/);
    assert.match(c.textContent, /Delivered: Claude Code acknowledged this message/);

    await s.start(LOCAL);
    const l = s.card(1);
    assert.match(l.querySelector('.row-meta').textContent, /Started by Plexiform · llama3\.2 · Ollama \(this computer\)/);
    const steer = [...l.querySelectorAll('button')].find((b) => b.textContent === 'Steer current turn');
    assert.equal(steer.hidden, true);

    // Local models panel: endpoint label/host/kind, reachable, models, last used.
    assert.equal(s.doc.getElementById('local-section').hidden, false);
    const ep = s.doc.querySelector('#local-endpoints .endpoint');
    assert.equal(ep.querySelector('h3').textContent, 'Ollama (this computer)');
    assert.equal(ep.querySelector('.tag').textContent, 'Reachable');
    assert.match(ep.querySelector('.row-meta').textContent, /127\.0\.0\.1:11434 · Ollama · found on this computer/);
    assert.match(ep.querySelector('.model-list').textContent, /llama3\.2 · not used yet/);
    s.setLastUsed(Date.now() - 120_000); await s.poll();
    assert.match(ep.querySelector('.model-list').textContent, /llama3\.2 · last used 2m ago/);
    assert.match(s.doc.getElementById('local-section').textContent, /local-models\.json/);
    assert.equal(s.doc.querySelector('#local-section input, #local-section textarea, #local-section select'), null, 'read-only: no editing UI');
    for (const ch of s.invoked) assert(ALLOWED.has(ch), ch);
  } finally { s.close(); }
});

test('Picker refresh is stable: rows never vanish, selection/draft/focus kept, a gone local model is marked not listed', async () => {
  let gone = false;
  const s = multi({ local: () => (gone ? { endpoints: [], models: [] } : { endpoints: [{ id: 'ollama', label: 'Ollama (this computer)', kind: 'ollama', source: 'discovered', reachable: true, error: null, checkedAt: 1, host: '127.0.0.1:11434', publicOptIn: false, keyFromEnv: null }], models: [{ provider: LOCAL, model: 'llama3.2', endpoint: 'ollama', endpointLabel: 'Ollama', reachable: true, lastUsed: null }] }) });
  try {
    await s.ready();
    const claudeRow = s.option('claude'), routerText = s.doc.getElementById('router-text');
    claudeRow.checked = true; claudeRow.dispatchEvent(new s.dom.window.Event('change'));
    routerText.value = 'what time is it'; routerText.focus();
    gone = true; s.llama.available = false; s.llama.reason = 'Not reachable';
    await s.poll(); await s.poll();
    assert.equal(s.option('claude'), claudeRow, 'same element, updated in place');
    assert.equal(claudeRow.checked, true);
    assert.equal(s.doc.activeElement, routerText); assert.equal(routerText.value, 'what time is it');
    assert.equal(s.option(LOCAL).disabled, true);
    assert.match(s.option(LOCAL).closest('label').textContent, /Unavailable\s*Not reachable/);
    const ep = s.doc.querySelector('#local-endpoints .endpoint');
    assert.ok(ep, 'endpoint row kept');
    assert.equal(ep.querySelector('.tag').textContent, 'Not found');
  } finally { s.close(); }
});

test('Router hint: advisory "Suggested: <provider> (cheaper)"; clicking it starts that provider with the text as a draft; never auto-routes', async () => {
  const s = multi();
  try {
    await s.ready();
    const input = s.doc.getElementById('router-text'), use = s.doc.getElementById('router-use');
    assert.equal(use.hidden, true);
    input.value = 'what is the capital of France?'; input.dispatchEvent(new s.dom.window.Event('input'));
    assert.match(s.doc.getElementById('router-hint').textContent, /^Suggested: llama3\.2 · Ollama \(this computer\) \(cheaper\)\./);
    assert.equal(s.doc.querySelectorAll('.owned-session').length, 0, 'nothing started by the suggestion itself');
    input.value = 'refactor the auth module across the codebase and write tests'; input.dispatchEvent(new s.dom.window.Event('input'));
    assert.match(s.doc.getElementById('router-hint').textContent, /^Suggested: Codex \(standard\)/);
    input.value = 'explain this regex'; input.dispatchEvent(new s.dom.window.Event('input'));
    assert.match(s.doc.getElementById('router-hint').textContent, /^Suggested: Claude Code \(cheaper\)/);
    assert.equal(use.textContent, 'Start with Claude Code');
    use.click(); await tick();
    assert.equal(s.card(0).querySelector('h3').textContent, 'Claude Code session');
    assert.equal(s.card(0).querySelector('textarea').value, 'explain this regex', 'text becomes the draft, not a sent message');
    assert.equal(s.claude.calls.length, 0);
  } finally { s.close(); }
  const n = multi({ router: false });
  try { await n.ready(); assert.equal(n.doc.getElementById('router-use').hidden, true); assert.equal(n.doc.getElementById('router-hint').textContent, ''); } finally { n.close(); }
});

test('Ask all: one message to chosen sessions through main fan-out; answers side by side by provider; a refused target does not block the other', async () => {
  const s = multi();
  try {
    await s.ready();
    assert.equal(s.doc.getElementById('ask-all').hidden, true, 'needs two sessions');
    await s.start('codex'); await s.start('claude');
    assert.equal(s.doc.getElementById('ask-all').hidden, false);
    const boxes = [...s.doc.querySelectorAll('#ask-targets input')];
    assert.deepEqual(boxes.map((b) => b.closest('label').textContent), ['Codex', 'Claude Code']);
    for (const b of boxes) { b.checked = true; b.dispatchEvent(new s.dom.window.Event('change')); }
    s.doc.getElementById('ask-text').value = ' nonce-42 ';
    assert.equal(s.doc.getElementById('ask-send').textContent, 'Ask 2 selected');
    s.doc.getElementById('ask-send').click(); await tick();
    assert(s.invoked.includes('interaction:fanout'));
    assert.equal(s.adapter.calls[0].text, 'nonce-42'); assert.equal(s.claude.calls[0].text, 'nonce-42');
    s.adapter.emit({ kind: 'delta', target: 'target-1', turnId: 'turn-1', text: '<b>codex says</b>' });
    s.claude.emit({ kind: 'message', target: 'claude-1', turnId: 'turn-1', text: 'claude says' });
    s.claude.emit({ kind: 'turn-completed', target: 'claude-1', turnId: 'turn-1', status: 'completed' }); await tick();
    const cols = [...s.doc.querySelectorAll('#ask-results .ask-answer')];
    assert.equal(cols.length, 2);
    assert.equal(cols[0].querySelector('strong').textContent, 'Codex');
    assert.equal(cols[0].querySelector('.delivery-response').textContent, '<b>codex says</b>');
    assert.equal(s.doc.querySelector('#ask-results b'), null, 'answers are text');
    assert.equal(cols[1].querySelector('.tag').textContent, 'Answered by Claude Code');
    assert.equal(cols[1].querySelector('.delivery-response').textContent, 'claude says');
    assert.match(s.doc.getElementById('ask-status').textContent, /Sent to 2 sessions/);
    assert.equal(s.doc.getElementById('ask-text').value, '');
    // Streaming updates the column node in place (selection-safe).
    const response = cols[0].querySelector('.delivery-response');
    s.adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: 'turn-1', status: 'completed' }); await tick();
    assert.equal(s.doc.querySelectorAll('#ask-results .delivery-response')[0], response);

    // Second round: Claude's provider throws; Codex still gets it.
    s.claude.send = async () => { throw new Error('<img src=x onerror=1>'); };
    for (const b of s.doc.querySelectorAll('#ask-targets input')) if (!b.checked) { b.checked = true; b.dispatchEvent(new s.dom.window.Event('change')); }
    s.doc.getElementById('ask-text').value = 'round two';
    s.doc.getElementById('ask-send').click(); await tick();
    assert.equal(s.adapter.calls.at(-1).text, 'round two');
    const after = [...s.doc.querySelectorAll('#ask-results .ask-answer')];
    assert.match(after[1].textContent, /Refused/);
    assert.match(s.doc.getElementById('ask-status').textContent, /Sent to 1 of 2 sessions/);
    assert.equal(s.doc.querySelector('img'), null);
  } finally { s.close(); }
});

test('Hostile strings in provider reasons, launch errors and notices render as text only', async () => {
  const evil = '<img src=x onerror="globalThis.pwned=1">';
  const s = multi({ extra: { gemini: Object.assign(memAdapter({ label: `Gem ${evil}` }), { available: false, reason: `Off ${evil}` }) } });
  try {
    await s.ready();
    s.claude.open = async () => { throw new Error(evil); };
    assert.match(s.option('gemini').closest('label').textContent, /Gem <img.*Off <img/);
    await s.start('claude');
    assert.match(s.doc.getElementById('owned-status').textContent, /Could not start Claude Code\. Unavailable/);
    s.adapter.available = false; s.adapter.reason = evil; await s.poll();
    assert.equal(s.option('codex').closest('label').querySelector('.reason').textContent, evil);
    assert.equal(s.option('codex').disabled, true);
    assert.equal(s.doc.getElementById('start-session').title, '', 'the Start title never carries provider text');
    assert.equal(s.doc.querySelector('img'), null); assert.equal(s.dom.window.pwned, undefined);
  } finally { s.close(); }
});

test('Push filter: events for a session this page does not own never create or change a card', async () => {
  const s = stack();
  try {
    await s.ready();
    await s.start();
    const before = s.card().textContent;
    s.contents.send('interaction:event', { session: U(77), generation: 1, provider: { id: 'codex', label: 'Codex' }, ownership: 'plexiform-owned', label: 'Started by Plexiform · Codex', board: null, status: 'ready', activeTurn: null, capabilities: {}, deliveries: [] });
    await tick();
    assert.equal(s.doc.querySelectorAll('.owned-session').length, 1);
    assert.equal(s.card().textContent, before);
  } finally { s.close(); }
});

test('List read taken before a push/launch never applies older state or marks the session missing', async () => {
  const s = stack();
  try {
    await s.ready();
    // Hold the next list read open across a launch and a push.
    const list = s.handlers.get('interaction:list');
    let release; const held = new Promise((r) => { release = r; });
    s.handlers.set('interaction:list', async (...a) => { await held; return []; });
    const polling = s.poll();
    await s.start();
    s.type('hi'); s.btn('Send').click(); await tick();
    s.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'turn-1' }); await tick();
    release(); await polling; await tick();
    assert.match(s.card().querySelector('.tag').textContent, /Working/, 'not Ended from an older empty list');
    s.handlers.set('interaction:list', list);
    await s.poll();
    assert.match(s.card().querySelector('.tag').textContent, /Working/);
  } finally { s.close(); }
});

test('Streaming tokens update one node: the notice live region is not re-set and focus returns after a busy send', async () => {
  const s = stack();
  try {
    await s.ready();
    await s.start();
    const box = s.type('hello'); box.focus();
    const send = s.btn('Send'); send.focus();
    s.btn('Send').click(); await tick();
    assert.notEqual(s.doc.activeElement, s.doc.body, 'focus is not dropped to <body>');
    s.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'turn-1' }); await tick();
    const notice = s.card().querySelector('[role=status]'), item = s.card().querySelector('.delivery');
    let writes = 0;
    new s.dom.window.MutationObserver((m) => { writes += m.length; }).observe(notice, { childList: true, characterData: true, subtree: true });
    for (const t of ['a', 'b', 'c']) { s.adapter.emit({ kind: 'delta', target: 'target-1', turnId: 'turn-1', text: t }); await tick(); }
    await tick();
    assert.equal(writes, 0, 'no re-announcement per token');
    assert.equal(s.card().querySelector('.delivery'), item, 'delivery node kept');
    assert.equal(item.querySelector('.delivery-response').textContent, 'abc');
  } finally { s.close(); }
});

test('Bridge: fan-out is a closed projection — duplicates, >6 targets, forged keys and bad text never reach IPC', async () => {
  const calls = [];
  const api = loadBridge({ invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); }, on: () => {}, removeListener: () => {} });
  const ix = api.interaction;
  await ix.fanout({ sessions: [{ session: U(1), generation: 1 }, { session: U(2), generation: 3 }], text: ' hi ' });
  await ix.launch({ provider: LOCAL }); await ix.localModels();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['interaction:fanout', { sessions: [{ session: U(1), generation: 1 }, { session: U(2), generation: 3 }], text: 'hi' }], ['interaction:launch', { provider: LOCAL }], ['interaction:local-models']]);
  const before = calls.length;
  const t = (n) => ({ session: U(n), generation: 1 });
  for (const r of [{ sessions: [t(1), t(1)], text: 'x' }, { sessions: [1, 2, 3, 4, 5, 6, 7].map(t), text: 'x' }, { sessions: [], text: 'x' }, { sessions: [t(1)], text: 'x', board: 'b' },
    { sessions: [{ ...t(1), actor: 'a' }], text: 'x' }, { sessions: [{ session: 'nope', generation: 1 }], text: 'x' }, { sessions: [t(1)], text: ' ' }, { sessions: [t(1)], text: 'a'.repeat(4001) }, { sessions: t(1), text: 'x' }, null]) assert.equal((await ix.fanout(r)).status, 'invalid');
  assert.equal(calls.length, before);
});
