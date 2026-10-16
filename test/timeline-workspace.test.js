'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Timeline = require('../src/session-timeline.js');
const Replay = require('../src/session-replay.js');
const Main = require('../src/session-timeline-main.js');
const lines = rows => rows.map(x => JSON.stringify({ timestamp: '2026-10-16T12:00:00Z', ...x }));
const response = payload => ({ type: 'response_item', payload });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

test('Codex subagent requests and matching tool results remain observations of the parent only', () => {
  const data = Timeline.codexEvents(lines([
    response({ type: 'function_call', call_id: 'one', name: 'collaboration.spawn_agent', arguments: JSON.stringify({ task_name: 'review', message: '<img src=x onerror=alert(1)> Review auth; password=TestSecret123' }) }),
    response({ type: 'function_call_output', call_id: 'unrelated', output: 'Never show unrelated tool output' }),
    response({ type: 'function_call_output', call_id: 'one', output: 'Created child; outcome unknown' }),
    response({ type: 'function_call_output', call_id: 'one', output: 'Duplicate output' }),
  ]));
  assert.deepEqual(data.events.map(x => x.kind), ['delegation', 'delegation-result']);
  assert.equal(data.events[0].target, 'review');
  assert.match(data.events[1].text, /outcome unknown/);
  const timeline = Timeline.build({ adapter: 'codex', sessionId: 'parent', transcript: data });
  const display = Timeline.forDisplay(timeline);
  assert.doesNotMatch(JSON.stringify(display), /TestSecret123/);
  assert.equal(Timeline.describe(data.events[0]).label, 'Subagent request recorded');
  assert.equal(Timeline.describe(data.events[1]).label, 'Subagent tool result recorded');
  const off = Replay.exportReplay(timeline);
  assert.doesNotMatch(off.html, /Review auth|Created child|TestSecret123/);
  const on = Replay.exportReplay(timeline, { includePrompts: true });
  assert.match(on.html, /&lt;img/); assert.doesNotMatch(on.html, /<img|TestSecret123|target.*review/);
  assert.match(on.summary.included.join(' '), /subagent requests and tool results/);
});

test('Claude subagent output is bounded, paired by tool id and excludes child-sidechain content', () => {
  const data = Timeline.claudeEvents(lines([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'Agent', input: { description: 'Audit', prompt: 'Review files' } }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'private', name: 'Agent', input: { prompt: 'Private child text' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'Result '.repeat(3000), is_error: true }] } },
  ]));
  assert.deepEqual(data.events.map(x => x.kind), ['delegation', 'delegation-result', 'failed']);
  assert.ok(data.events[1].text.length <= 8001); assert.equal(data.events[1].failed, true);
  assert.doesNotMatch(JSON.stringify(data), /Private child/);
});

test('native Codex functions aliases pair only explicit subagent calls and expose their named target', () => {
  const data = Timeline.codexEvents(lines([
    response({ type: 'function_call', call_id: 'spawn', name: 'functions.spawn_agent', arguments: JSON.stringify({ message: 'Review only' }) }),
    response({ type: 'function_call_output', call_id: 'spawn', output: 'Started a child' }),
    response({ type: 'function_call', call_id: 'send', name: 'functions.send_input', arguments: JSON.stringify({ id: 'recorded-child-id', message: 'Finish the review' }) }),
    response({ type: 'function_call_output', call_id: 'send', output: 'Input queued' }),
    response({ type: 'function_call', call_id: 'wait', name: 'functions.wait', arguments: JSON.stringify({ cell_id: 'exec-cell' }) }),
    response({ type: 'function_call_output', call_id: 'wait', output: 'Unrelated process output' }),
  ]));
  assert.deepEqual(data.events.map(e => e.kind), ['delegation','delegation-result','delegation','delegation-result','tool']);
  assert.equal(data.events[2].target, 'recorded-child-id');
  assert.doesNotMatch(JSON.stringify(data), /Unrelated process output/);
});

function harness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-timeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map(), sender = {}, frame = { processId: 1, routingId: 2, url: 'file:///timeline.html' };
  const state = { allowed: true, muted: false, saved: 0 };
  Main.register({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, rootDir: dir, home: dir,
    sessions: () => ({ live: [{ sessionId: 'one', cwd: '/project/a' }, { sessionId: 'two', cwd: '/project/b' }] }),
    sessionsAllowed: () => true, pageAllowed: () => state.allowed, isExcluded: () => state.muted,
    openPage() {}, transitions: () => [], checkpointTurns: async () => [], locator: { find: () => null },
    dialog: { showSaveDialog: async () => { state.saved++; return { filePath: path.join(dir, 'out.html') }; } },
    BrowserWindow: { fromWebContents: () => null }, ...overrides });
  const call = (name, ...args) => handlers.get(`timeline:${name}`)({ sender, senderFrame: frame }, ...args);
  return { dir, state, frame, call };
}

test('named missing or malformed timeline never silently loads/exports another session', async t => {
  const h = harness(t);
  assert.equal((await h.call('load', 'claude-code-one')).key, 'claude-code-one');
  for (const key of ['claude-code-missing', '../etc/passwd', '']) {
    assert.match((await h.call('load', key)).empty, /selected session/);
    assert.equal(await h.call('preview', key, true), null);
    assert.equal((await h.call('export', key, true)).ok, false);
  }
  assert.equal(h.state.saved, 0);
});

test('muting or document navigation while timeline loads prevents content return', async t => {
  for (const mutate of [h => { h.state.muted = true; }, h => { h.frame.routingId++; }, h => { h.state.allowed = false; }]) {
    const wait = deferred(), h = harness(t, { checkpointTurns: () => wait.promise });
    const reading = h.call('load', 'claude-code-one'); mutate(h); wait.resolve([]);
    assert.equal(await reading, null);
  }
});

test('changing the selected session while native export dialog is open prevents file write', async t => {
  const wait = deferred(), h = harness(t, { dialog: { showSaveDialog: () => wait.promise } });
  const exporting = h.call('export', 'claude-code-one', true); await tick();
  await h.call('load', 'claude-code-two');
  wait.resolve({ filePath: path.join(h.dir, 'out.html') });
  assert.equal((await exporting).ok, false); assert.equal(fs.existsSync(path.join(h.dir, 'out.html')), false);
});

test('even an unavailable new selection cancels the earlier pending export', async t => {
  const wait=deferred(),h=harness(t,{dialog:{showSaveDialog:()=>wait.promise}});
  const exporting=h.call('export','claude-code-one',true);await tick();
  await h.call('load','claude-code-no-longer-listed');wait.resolve({filePath:path.join(h.dir,'out.html')});
  assert.equal((await exporting).ok,false);assert.equal(fs.existsSync(path.join(h.dir,'out.html')),false);
});

test('renderer searches and filters recorded activity with safe long-result disclosure', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '..', 'timeline.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, d = window.document;
  const events = [
    { at: '2026-10-16T12:00:00Z', kind: 'turn-end', label: 'Turn finished', text: '<img src=x> Final outcome '.repeat(100) },
    { at: '2026-10-16T12:00:01Z', kind: 'delegation', label: 'Subagent request recorded', text: 'Audit\nReview auth.js' },
    { at: '2026-10-16T12:00:02Z', kind: 'edit', label: 'Edited', text: 'login.js' },
  ];
  window.timelineApi = { list: async () => ({ sessions: [{ key: 'one', label: 'One' }] }), load: async () => ({ key: 'one', title: 'One', view: { counts: { files: 0, commands: 0, approvals: 0, answered: 0, denied: 0 }, files: [], events } }), preview: async () => ({ included: [], excluded: [] }), changed() {} };
  window.eval(fs.readFileSync(path.join(__dirname, '..', 'timeline.js'), 'utf8')); await tick();
  assert.equal(d.querySelectorAll('#events details').length, 1); assert.equal(d.querySelectorAll('#events img').length, 0);
  d.getElementById('event-kind').value = 'subagents'; d.getElementById('event-kind').dispatchEvent(new window.Event('change'));
  assert.match(d.getElementById('events').textContent, /Review auth/); assert.doesNotMatch(d.getElementById('events').textContent, /login|Final outcome/);
  d.getElementById('event-search').value = 'missing'; d.getElementById('event-search').dispatchEvent(new window.Event('input'));
  assert.match(d.getElementById('status').textContent, /No activity matches/);
});
