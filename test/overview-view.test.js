'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../overview.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../overview.js'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, '../overview-preload.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const uuid = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const caps = enabled => ({ open: { enabled, label: 'Open task', reason: enabled ? '' : 'No supported open connection.' }, message: { enabled, label: 'Message', reason: enabled ? '' : 'No supported message connection.' } });
const row = (id = 'parent', overrides = {}) => ({ id, handle: uuid(1), label: 'Reported session', provider: { id: 'codex', label: 'Codex', kind: 'integrated' }, device: { label: 'This Mac', local: true }, board: { label: 'My board', kind: 'personal' }, project: 'Plexiform', status: 'Working', freshness: 'recent', age_ms: 1000, task: { status: 'tracked', title: 'Human edited task', key: 'card-key' }, children: [], capabilities: caps(true), ...overrides });
const child = overrides => ({ id: 'child', handle: uuid(2), label: 'Child agent', status: 'Waiting on you', freshness: 'recent', age_ms: 1000, task: { status: 'tracked', title: 'Review the native adapter', key: 'child-key' }, capabilities: caps(false), ...overrides });
const snapshot = overrides => ({ schema: 1, status: 'complete', observed_at: Date.now(), omitted: 0, sessions: [row()], ...overrides });
function setup(api, initialHidden = false) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  let hidden = initialHidden; const intervals = [];
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  dom.window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  dom.window.overviewApi = api; dom.window.eval(script);
  return { dom, document: dom.window.document, intervals, hide(value) { hidden = value; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); }, close() { dom.window.close(); } };
}
const click = (f, key) => [...f.document.querySelectorAll('button[data-focus]')].find(el => el.dataset.focus === key)?.click();
const choose = (f, kind, value) => { const el = f.document.getElementById(`${kind}-filter`); el.value = value; el.dispatchEvent(new f.dom.window.Event('change')); };
const fill = (f, value) => { const el = f.document.querySelector('textarea'); el.value = value; el.dispatchEvent(new f.dom.window.Event('input')); return el; };
test('main Overview registry resolves exact local assets and sandboxed narrow bridge', () => {
  const page = require('../buddy-window/pages').pageById('overview');
  assert.equal(page.kind, 'local'); assert.equal(page.file, 'overview.html'); assert.equal(page.preload, 'overview-preload.js');
  for (const file of [page.file, page.preload, 'overview.js', 'overview.css']) assert.equal(fs.existsSync(path.join(__dirname, '..', file)), true);
  assert.match(html, /default-src 'none'/); assert.match(html, /form-action 'none'/);
});
test('parent/child task hierarchy renders human edits and hostile strings only as text', async () => {
  const f = setup({ state: async () => snapshot({ sessions: [row('parent', { task: { status: 'tracked', title: '<img src=x onerror=alert(1)> human edit', key: 'card' }, children: [child()] })] }) });
  try {
    await tick(); assert.equal(f.document.querySelectorAll('#content img').length, 0);
    assert.match(f.document.querySelector('article h3').textContent, /<img/);
    assert.match(f.document.querySelector('article details li h3').textContent, /Review the native adapter/);
    assert.equal(f.document.querySelector('details').open, true); assert.match(f.document.body.textContent, /Waiting on you/);
    assert.equal(f.document.querySelectorAll('li button:disabled').length, 2); assert.match(f.document.querySelector('li').textContent, /No supported message connection/);
  } finally { f.close(); }
});
test('device/board/provider/status filters compose over remote and local-model reports', async () => {
  const f = setup({ state: async () => snapshot({ sessions: [row(), row('remote', { handle: uuid(3), device: { label: 'Windows runner', local: false }, board: { label: 'Team delivery', kind: 'team' }, provider: { id: 'ollama', label: 'Ollama', kind: 'local' }, status: 'Idle', capabilities: caps(false) })] }) });
  try {
    await tick(); assert.equal(f.document.querySelectorAll('article').length, 2); assert.match(f.document.body.textContent, /Ollama · local model/);
    choose(f, 'provider', 'ollama'); choose(f, 'device', 'Windows runner'); choose(f, 'board', 'Team delivery'); choose(f, 'status', 'Idle');
    assert.equal(f.document.querySelectorAll('article').length, 1); assert.match(f.document.querySelector('article').textContent, /Team delivery/);
    choose(f, 'status', 'Working'); assert.equal(f.document.querySelectorAll('article').length, 0); assert.match(f.document.querySelector('#content').textContent, /No work matches/);
    f.document.getElementById('clear-filters').click(); assert.equal(f.document.querySelectorAll('article').length, 2);
  } finally { f.close(); }
});
test('unknown task and stale report retain explicit limits and cannot grant actions', async () => {
  let actions = 0; const f = setup({ state: async () => snapshot({ sessions: [row('parent', { freshness: 'stale', task: { status: 'unknown', title: 'Task not reported', key: null } })] }), open: async () => { actions++; } });
  try { await tick(); assert.match(f.document.querySelector('#content').textContent, /Task not reported/); assert.match(f.document.querySelector('#content').textContent, /Stale/); click(f, 'parent:open'); assert.equal(actions, 0); assert.match(f.document.body.textContent, /Refresh before acting/); }
  finally { f.close(); }
});
test('freshness expires between reads even while the next backend read is pending', async () => {
  let calls = 0; const f = setup({ state: () => ++calls === 1 ? Promise.resolve(snapshot({ observed_at: Date.now() - 10000, sessions: [row('parent', { age_ms: 85000 })] })) : new Promise(() => {}) });
  try { await tick(); f.intervals[0](); assert.match(f.document.querySelector('.tag').textContent, /Stale/); assert.equal(f.document.querySelector('button[data-focus="parent:open"]').disabled, true); }
  finally { f.close(); }
});
test('poll preserves expanded choice, focused composer selection and draft but uses latest handle', async () => {
  let count = 0; const requests = [];
  const f = setup({ state: async () => snapshot({ sessions: [row('parent', { handle: uuid(++count), children: [child()] })] }), message: async request => { requests.push(request); return { ok: true, status: 'queued', error: '' }; } });
  try {
    await tick(); const details = f.document.querySelector('details'); details.open = false; details.dispatchEvent(new f.dom.window.Event('toggle'));
    click(f, 'parent:message'); const input = fill(f, '  review this change  '); input.focus(); input.setSelectionRange(3, 8);
    f.intervals[0](); await tick(); assert.equal(f.document.querySelector('textarea').value, '  review this change  '); assert.equal(f.document.activeElement.tagName, 'TEXTAREA'); assert.equal(f.document.activeElement.selectionStart, 3); assert.equal(f.document.querySelector('details').open, false);
    click(f, 'parent:send'); await tick(); assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ handle: uuid(2), text: 'review this change' }]);
    assert.equal(f.document.querySelector('textarea'), null); assert.match(f.document.body.textContent, /Delivery is not yet verified/);
  } finally { f.close(); }
});
test('changed task identity clears old draft before any send to the replacement task', async () => {
  let calls = 0, sent = 0;
  const f = setup({ state: async () => snapshot({ sessions: [row('parent', { task: { status: 'tracked', title: ++calls === 1 ? 'Old task' : 'New task', key: calls === 1 ? 'old' : 'new' } })] }), message: async () => { sent++; } });
  try { await tick(); click(f, 'parent:message'); fill(f, 'old-target message'); f.intervals[0](); await tick(); assert.equal(f.document.querySelector('textarea'), null); assert.match(f.document.querySelector('article').textContent, /New task/); click(f, 'parent:send'); assert.equal(sent, 0); }
  finally { f.close(); }
});
test('queued-message notice cannot follow a human title edit of the same reported task', async () => {
  let title = 'Original human task';
  const f = setup({ state: async () => snapshot({ sessions: [row('parent', { task: { status: 'tracked', title, key: 'same-card' } })] }), message: async () => ({ ok: true, status: 'queued' }) });
  try {
    await tick(); click(f, 'parent:message'); fill(f, 'review this original task'); click(f, 'parent:send'); await tick();
    assert.match(f.document.querySelector('article').textContent, /Message queued/);
    title = 'Current human edited task'; f.intervals[0](); await tick();
    assert.match(f.document.querySelector('article h3').textContent, /Current human edited task/);
    assert.doesNotMatch(f.document.querySelector('article').textContent, /Message queued|Delivery is not yet verified/);
  } finally { f.close(); }
});
test('explicit message validates UTF8 bound, NUL, whitespace and never auto-sends', async () => {
  const sent = []; const f = setup({ state: async () => snapshot(), message: async request => { sent.push(request); return { ok: true, status: 'queued' }; } });
  try {
    await tick(); click(f, 'parent:message'); assert.equal(sent.length, 0);
    for (const text of ['   ', 'x\0y', 'a'.repeat(4001), '汉'.repeat(2731)]) { fill(f, text); click(f, 'parent:send'); await tick(); assert.equal(sent.length, 0); assert.match(f.document.querySelector('.composer').textContent, /4,000 characters and 8 KB/); }
    fill(f, '汉'.repeat(2730) + 'ab'); click(f, 'parent:send'); await tick(); assert.equal(sent.length, 1); assert.equal(Buffer.byteLength(sent[0].text), 8192);
  } finally { f.close(); }
});
test('child action uses only the child handle and requires its own supported capability', async () => {
  const opened = []; const f = setup({ state: async () => snapshot({ sessions: [row('parent', { children: [child({ capabilities: caps(true) })] })] }), open: async request => { opened.push(request); return { ok: true, status: 'opened' }; } });
  try { await tick(); click(f, 'child:open'); await tick(); assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ handle: uuid(2) }]); assert.match(f.document.querySelector('li').textContent, /Opened this task/); }
  finally { f.close(); }
});
test('nullable child handle preserves the trusted specific unsupported-action reasons', async () => {
  const f = setup({ state: async () => snapshot({ sessions: [row('parent', { children: [child({ handle: null })] })] }) });
  try { await tick(); assert.equal(f.document.querySelectorAll('li button:disabled').length, 2); assert.match(f.document.querySelector('li').textContent, /No supported open connection/); assert.match(f.document.querySelector('li').textContent, /No supported message connection/); }
  finally { f.close(); }
});
test('hidden page clears metadata and action replies, pauses polling, rejects an old read', async () => {
  let oldRead, opened; const reads = [];
  const f = setup({ state: () => new Promise(resolve => reads.push(resolve)), open: () => new Promise(resolve => { opened = resolve; }) });
  try {
    oldRead = reads[0]; f.document.getElementById('refresh').click(); reads[1](snapshot()); await tick(); click(f, 'parent:open');
    f.hide(true); f.intervals[0](); assert.equal(reads.length, 2); assert.equal(f.document.querySelector('#content').textContent, '');
    opened({ ok: true, status: 'opened', error: 'private secret' }); oldRead(snapshot({ sessions: [row('private-old')] })); await tick();
    assert.doesNotMatch(f.document.body.textContent, /Opened this task|private-old|private secret/);
    f.hide(false); reads[2](snapshot()); await tick(); assert.equal(f.document.querySelectorAll('article').length, 1);
  } finally { f.close(); }
});
test('filter invalidation suppresses pending action reply and repeat dispatch until it settles', async () => {
  let finish, calls = 0; const f = setup({ state: async () => snapshot(), open: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  try {
    await tick(); click(f, 'parent:open'); choose(f, 'provider', 'codex'); click(f, 'parent:open'); assert.equal(calls, 1);
    finish({ ok: true, status: 'opened' }); await tick(); assert.doesNotMatch(f.document.body.textContent, /Opened this task/); assert.equal(f.document.querySelector('button[data-focus="parent:open"]').disabled, false);
  } finally { f.close(); }
});
test('out-of-order read and unavailable or malformed state cannot retain stale authority', async () => {
  const reads = []; const f = setup({ state: () => new Promise(resolve => reads.push(resolve)) });
  try {
    f.document.getElementById('refresh').click(); reads[1](snapshot({ sessions: [row('new')] })); await tick(); reads[0](snapshot({ sessions: [row('old')] })); await tick(); assert.equal(f.document.querySelector('article').dataset.id, 'new');
    click(f, 'new:message'); fill(f, 'secret draft'); f.intervals[0](); reads[2](snapshot({ status: 'unavailable' })); await tick(); assert.equal(f.document.querySelector('article'), null); assert.equal(f.document.querySelector('textarea'), null); assert.doesNotMatch(f.document.body.textContent, /secret draft/);
    f.intervals[0](); reads[3](snapshot({ sessions: [row('parent', { handle: [uuid(1)] })] })); await tick(); assert.equal(f.document.querySelector('article'), null); assert.match(f.document.body.textContent, /Activity unavailable/);
  } finally { f.close(); }
});
test('forged success status and thrown private errors cannot invent delivery or disclose errors', async () => {
  const f = setup({ state: async () => snapshot(), message: async () => ({ ok: true, status: 'opened', error: '/private/credential' }), open: async () => { throw new Error('/private/credential'); } });
  try { await tick(); click(f, 'parent:message'); fill(f, 'hello'); click(f, 'parent:send'); await tick(); assert.equal(f.document.querySelector('textarea').value, 'hello'); assert.doesNotMatch(f.document.body.textContent, /Message queued|\/private\/credential/); click(f, 'parent:open'); await tick(); assert.match(f.document.querySelector('article').textContent, /action is unavailable/); }
  finally { f.close(); }
});
test('initially hidden page makes no read and empty/partial states remain honest', async () => {
  let count = 0; const f = setup({ state: async () => { count++; return snapshot({ status: 'partial', omitted: 4, sessions: [] }); } }, true);
  try { assert.equal(count, 0); f.intervals[0](); assert.equal(count, 0); f.hide(false); await tick(); assert.equal(count, 1); assert.match(f.document.body.textContent, /No activity reported yet/); assert.match(f.document.body.textContent, /Some activity is unavailable/); assert.match(f.document.body.textContent, /4 additional reports/); }
  finally { f.close(); }
});
test('bridge projects only closed primitive requests and rejects forged authority before IPC', async () => {
  let api; const calls = [];
  vm.runInNewContext(bridge, { Buffer, Promise, require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'overviewApi'); api = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } }; } });
  await api.state(); await api.open({ handle: uuid(1) }); await api.message({ handle: uuid(1), text: ' hello ' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['overview:state'], ['overview:open', { handle: uuid(1) }], ['overview:message', { handle: uuid(1), text: 'hello' }]]);
  for (const request of [{ handle: [uuid(1)] }, { handle: uuid(1), path: '/private' }, { handle: uuid(1), device: 'foreign' }, { handle: uuid(1), text: 'x' }]) assert.equal((await api.open(request)).status, 'invalid');
  for (const request of [{ handle: uuid(1), text: ' ' }, { handle: uuid(1), text: 'x\0y' }, { handle: uuid(1), text: 'a'.repeat(4001) }, { handle: uuid(1), text: '汉'.repeat(2731) }, { handle: uuid(1), text: ['x'] }, { handle: uuid(1), text: 'x', provider: 'codex' }]) assert.equal((await api.message(request)).status, 'invalid');
  assert.equal(calls.length, 3);
});
