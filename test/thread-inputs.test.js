'use strict';
// Redesign R4-2: a terminal session's hook requests in its own thread (plan-r4-2.md).
// Part 1 is src/thread-main.js's side (the real index.js lifecycle, test/helpers/thread-world.js) against a fake
// main hook: reads filtered to the bound session, the 600 ms arm, C-F's main-side "Allow anyway" token, the push.
// Part 2 is main.js's own threadHook, run from its source in a vm against fake request files: the setting, the
// session and host binding, the rebuilt answer, the decision hash and the write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { world, between, A, SESSION, root } = require('./helpers/thread-world');
const { ARM_MS, INPUT_TEXT } = require('../src/thread-main');
const AnswerMore = require('../src/answer-more');
const PendingInputs = require('../src/pending-inputs');

const json = (v) => JSON.parse(JSON.stringify(v));
const S2 = 'e'.repeat(64);
const TARGETS = () => ({ [A]: { kind: 'task', taskId: 'task-a' }, [SESSION]: { kind: 'session', source: 'claude', sessionId: 's-1' }, [S2]: { kind: 'session', source: 'claude', sessionId: 's-2' } });
const REQS = () => [
  { id: 'req-1', sessionId: 's-1', hash: 'dh-1', danger: null, kind: 'permission' },
  { id: 'req-2', sessionId: 's-2', hash: 'dh-2', danger: null, kind: 'permission' },
];

function rig({ row = SESSION, flagged, requests = REQS() } = {}) {
  const clock = { t: 1_000_000 };
  const w = world({ targets: TARGETS(), now: () => clock.t, hook: { requests, ...(flagged ? { flagged } : {}) } });
  w.ctx.openThread(row);
  const d = w.doc();
  const read = () => w.ipc.handlers['thread:inputs'](d, row);
  const answer = (inputId, optionId = 'allow', more) => w.ipc.handlers['thread:answer-input'](d, { id: row, inputId, optionId, ...(more ? { more } : {}) });
  const tick = (ms = ARM_MS) => { clock.t += ms; };
  return { w, d, clock, read, answer, tick, row };
}

// ── reads ────────────────────────────────────────────────────────────────

test('thread:inputs returns only the bound session\'s requests, never another session\'s', () => {
  const r = rig();
  const out = json(r.read());
  assert.deepEqual(out.inputs.map((i) => i.id), ['req-1']);
  assert.equal(out.answering, true);
  const s = rig({ row: S2 });
  assert.deepEqual(json(s.read()).inputs.map((i) => i.id), ['req-2']);
});

test('thread:inputs: a task thread, another row\'s id and a non-thread sender read nothing', () => {
  const r = rig({ row: A });
  assert.deepEqual(json(r.read()), { gone: true });
  const s = rig();
  assert.equal(s.w.ipc.handlers['thread:inputs'](s.d, A), null);
  assert.equal(s.w.ipc.handlers['thread:inputs']({ sender: { id: 1 }, senderFrame: {} }, SESSION), null);
});

test('thread:inputs is rate-limited per document: inside 500 ms the last reply comes back, unless main pinged', () => {
  const r = rig();
  r.read();
  r.w.hook.requests.push({ id: 'req-3', sessionId: 's-1', hash: 'dh-3', danger: null, kind: 'permission' });
  r.tick(100);
  assert.deepEqual(json(r.read()).inputs.map((i) => i.id), ['req-1'], 'cached');
  // A change: main pings (no data), and the next read is fresh at once.
  const before = r.d.sender.sent.length;
  r.w.thread.inputsChanged();
  assert.deepEqual(r.d.sender.sent.slice(before), [['thread:inputs-changed', { id: SESSION }]]);
  assert.deepEqual(json(r.read()).inputs.map((i) => i.id), ['req-1', 'req-3']);
  // No change: no ping.
  const n = r.d.sender.sent.length;
  r.w.thread.inputsChanged();
  assert.equal(r.d.sender.sent.length, n);
});

test('the push is a ping with no data, and only to a session thread that has read', () => {
  const r = rig();
  r.w.thread.inputsChanged();
  assert.deepEqual(r.d.sender.sent.filter(([ch]) => ch === 'thread:inputs-changed'), [], 'never read: no ping');
  const t = rig({ row: A });
  t.read();
  t.w.thread.inputsChanged();
  assert.deepEqual(t.d.sender.sent.filter(([ch]) => ch === 'thread:inputs-changed'), []);
});

// ── answers: the order and the arm ───────────────────────────────────────

test('an answer to its own session\'s request, read 600 ms ago, is written once', () => {
  const r = rig();
  r.read(); r.tick();
  assert.deepEqual(r.answer('req-1'), { ok: true });
  assert.deepEqual(r.w.hook.writes, [['req-1', 'allow']]);
});

test('another session\'s request from this thread: NOT_FOUND, zero writes (even if its id were shown)', () => {
  const r = rig();
  r.read(); r.tick();
  assert.equal(r.answer('req-2').code, 'NOT_FOUND');
  assert.deepEqual(r.w.hook.writes, []);
});

test('the arm: never read, under 600 ms, a hash change, a danger change, a reload → NOT_READY, zero writes', () => {
  const r = rig();
  assert.equal(r.answer('req-1').code, 'NOT_READY', 'never read');
  r.read(); r.tick(ARM_MS - 1);
  assert.equal(r.answer('req-1').code, 'NOT_READY', 'under 600 ms');
  r.tick(600);
  r.w.hook.requests[0].hash = 'dh-1b';
  assert.equal(r.answer('req-1').code, 'NOT_READY', 'the request changed');
  r.w.hook.requests[0].hash = 'dh-1';
  r.w.hook.requests[0].danger = 'deletes files';
  r.tick(600);
  assert.equal(r.answer('req-1').code, 'NOT_READY', 'the danger label changed');
  assert.deepEqual(r.w.hook.writes, []);
  // A reload is a new generation: what the old document read arms nothing.
  const s = rig();
  s.read(); s.tick();
  s.d.sender.reload();
  const d2 = s.w.doc();
  assert.equal(s.w.ipc.handlers['thread:answer-input'](d2, { id: SESSION, inputId: 'req-1', optionId: 'allow' }).code, 'NOT_READY');
  assert.deepEqual(s.w.hook.writes, []);
});

test('re-reading an unchanged request keeps its first delivery time; a changed one re-arms', () => {
  const r = rig();
  r.read(); r.tick(400);
  r.tick(EFFECT());
  r.read();
  r.tick(100);
  assert.deepEqual(r.answer('req-1'), { ok: true }, 'shown 1000 ms ago, unchanged');
});
function EFFECT() { return require('../src/thread-main').EFFECT_MS; }

test('answering off, a gone request and a bad option each say why, with zero writes', () => {
  const r = rig();
  r.read(); r.tick();
  r.w.hook.answering = false;
  assert.deepEqual(r.answer('req-1'), { ok: false, code: 'OFF', text: INPUT_TEXT.OFF });
  r.w.hook.answering = true;
  r.tick();
  assert.equal(r.answer('req-9').code, 'GONE');
  r.tick();
  assert.equal(r.answer('req-1', 'allow-session-0').code, 'VALIDATION');
  assert.deepEqual(r.w.hook.writes, []);
});

test('shape: oneKey, unknown keys, over-long ids, non-plain objects and another row → VALIDATION before main is asked', () => {
  const r = rig();
  r.read(); r.tick();
  let asked = 0;
  const prep = r.w.hook.prepare;
  r.w.hook.prepare = (...a) => { asked++; return prep(...a); };
  const h = (req) => r.w.ipc.handlers['thread:answer-input'](r.d, req);
  for (const req of [
    { id: SESSION, inputId: 'req-1', optionId: 'allow', more: { oneKey: true } },
    { id: SESSION, inputId: 'req-1', optionId: 'allow', more: { anyway: false } },
    { id: SESSION, inputId: 'req-1', optionId: 'allow', action: 'approve' },
    { id: SESSION, inputId: 'x'.repeat(101), optionId: 'allow' },
    { id: SESSION, inputId: 'req-1', optionId: '' },
    { id: A, inputId: 'req-1', optionId: 'allow' },
    Object.assign(Object.create({ x: 1 }), { id: SESSION, inputId: 'req-1', optionId: 'allow' }),
  ]) assert.equal(h(req).code, 'VALIDATION', JSON.stringify(req));
  assert.equal(asked, 0);
  assert.deepEqual(r.w.hook.writes, []);
});

test('unfocused → ILLEGAL_TRANSITION; a second answer inside 500 ms → BUSY', () => {
  const r = rig({ requests: [...REQS(), { id: 'req-3', sessionId: 's-1', hash: 'dh-3', danger: null, kind: 'permission' }] });
  r.read(); r.tick();
  r.w.win.focused = false;
  assert.deepEqual(r.answer('req-1'), { ok: false, code: 'ILLEGAL_TRANSITION', text: INPUT_TEXT.FOCUS });
  r.w.win.focused = true;
  assert.deepEqual(r.answer('req-1'), { ok: true });
  assert.equal(r.answer('req-3').code, 'BUSY');
  assert.deepEqual(r.w.hook.writes, [['req-1', 'allow']]);
});

test('a task thread can\'t answer a hook request', () => {
  const r = rig({ row: A });
  r.tick();
  assert.equal(r.answer('req-1').code, 'NOT_FOUND');
  assert.deepEqual(r.w.hook.writes, []);
});

// ── C-F: "Allow anyway" is main's own second click (plan-r4-2 §8 S1) ────

test('a flagged allow: the first click is FLAGGED; anyway 600 ms later sends once', () => {
  const r = rig({ flagged: (req, o) => o === 'allow' });
  r.read(); r.tick();
  assert.deepEqual(r.answer('req-1'), { ok: false, code: 'FLAGGED', text: INPUT_TEXT.FLAGGED });
  r.tick();
  assert.deepEqual(r.answer('req-1', 'allow', { anyway: true }), { ok: true });
  assert.deepEqual(r.w.hook.writes, [['req-1', 'allow']]);
});

test('anyway with no FLAGGED reply first is FLAGGED (the page\'s say-so is not enough), zero writes', () => {
  const r = rig({ flagged: () => true });
  r.read(); r.tick();
  assert.equal(r.answer('req-1', 'allow', { anyway: true }).code, 'FLAGGED');
  assert.deepEqual(r.w.hook.writes, []);
});

test('anyway too soon, for another option, or after the request changed → NOT_READY; the token is used once', () => {
  const r = rig({ flagged: () => true });
  r.read(); r.tick();
  r.answer('req-1');
  r.tick(EFFECT());
  assert.equal(r.answer('req-1', 'allow', { anyway: true }).code, 'NOT_READY', 'under 600 ms after FLAGGED');
  r.tick(EFFECT());
  assert.equal(r.answer('req-1', 'deny', { anyway: true }).code, 'NOT_READY', 'another option');
  r.tick();
  assert.equal(r.answer('req-1', 'allow', { anyway: true }).code, 'FLAGGED', 'the token was used: it starts again');
  r.tick();
  r.w.hook.requests[0].hash = 'dh-1b';
  assert.equal(r.answer('req-1', 'allow', { anyway: true }).code, 'NOT_READY', 'the request changed');
  assert.deepEqual(r.w.hook.writes, []);
});

test('the anyway token doesn\'t survive a reload', () => {
  const r = rig({ flagged: () => true });
  r.read(); r.tick();
  r.answer('req-1');
  r.d.sender.reload();
  const d2 = r.w.doc();
  r.w.ipc.handlers['thread:inputs'](d2, SESSION);
  r.tick(); r.tick();
  assert.equal(r.w.ipc.handlers['thread:answer-input'](d2, { id: SESSION, inputId: 'req-1', optionId: 'allow', more: { anyway: true } }).code, 'FLAGGED');
  assert.deepEqual(r.w.hook.writes, []);
});

// ── Part 2: main.js's threadHook, from its source ────────────────────────

const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const hookSrc = between(mainSrc, 'const threadSession = ', 'if (CHAT_PREVIEW) {\n  const SidebarRows');
const refusalSrc = between(mainSrc, 'function homeAnswerRefusal', "ipcMain.handle('answer-input'"); // includes rebuildAnswer
const rebuildSrc = mainSrc.slice(mainSrc.indexOf('const rebuildAnswer = '), mainSrc.indexOf('\n', mainSrc.indexOf('const rebuildAnswer = ')));

function mainHook({ requests, reads = { n: 0 }, config = { askFromWidget: true }, sessions = [{ sessionId: 's-1', source: 'claude', host: 'mac' }], danger = () => null, inputs } = {}) {
  const writes = [];
  const ctx = {
    console: { log() {} }, setTimeout: () => {}, broadcastStatus() {},
    loadConfig: () => config, readRequests: () => { reads.n += 1; return requests; },
    aggregateState: () => ({ sessions, inputs: inputs ?? PendingInputs.collect({ requests, sessions: [], dialogs: [] }) }),
    localSessions: (s) => s, TourMain: { isDemoId: (id) => id === 'demo' },
    AutoRules: { danger }, AnswerMore, PendingInputs, REQUESTS_DIR: '/x', keyFor: () => Buffer.alloc(32),
    AnswerFile: { writeAnswer: (dir, id, decision, o) => { writes.push({ id, decision, ...o }); return { ok: true }; } },
  };
  const hook = vm.runInNewContext(`${refusalSrc}\n${hookSrc}\nthreadHook`, ctx);
  return { hook, writes };
}
const REQ = (over = {}) => ({ id: 'r1', sessionId: 's-1', host: 'mac', tool: 'Bash', toolInput: { command: 'ls' }, cwd: '/p', createdAt: new Date().toISOString(), decisionHash: 'a'.repeat(64), ...over });
const T = { source: 'claude', sessionId: 's-1' };

test('main: prepare writes the rebuilt answer, by:thread, with the request\'s decision hash', () => {
  const { hook, writes } = mainHook({ requests: [REQ()] });
  const p = hook.prepare(T, 'r1', 'deny', { message: 'not now' });
  assert.equal(p.ok, true);
  assert.equal(p.hash, 'a'.repeat(64));
  assert.equal(p.flagged, false);
  assert.equal(p.write().ok, true);
  assert.deepEqual(json(writes), [{ id: 'r1', decision: 'deny', by: 'thread', extra: { message: 'not now' }, key: json(Buffer.alloc(32)), decisionHash: 'a'.repeat(64) }]);
});

test('main: another session, another host, another provider, or no local row → NOT_FOUND, nothing written', () => {
  for (const [req, t] of [[REQ({ sessionId: 's-2' }), T], [REQ({ host: 'vm' }), T], [REQ(), { source: 'codex', sessionId: 's-1' }], [REQ(), { source: 'claude', sessionId: 's-9' }]]) {
    const { hook, writes } = mainHook({ requests: [req], sessions: [{ sessionId: 's-1', source: 'claude', host: 'mac' }, { sessionId: 's-1', source: 'codex', host: 'mac' }] });
    assert.deepEqual(json(hook.prepare(t, 'r1', 'allow', {})), { ok: false, code: 'NOT_FOUND' }, JSON.stringify([req.sessionId, req.host, t]));
    assert.deepEqual(writes, []);
  }
});

test('main: answering off, a demo id, a gone request, an edited (unhashed) request and an unknown option are refused', () => {
  assert.equal(mainHook({ requests: [REQ()], config: { askFromWidget: false } }).hook.prepare(T, 'r1', 'allow', {}).code, 'OFF');
  assert.equal(mainHook({ requests: [REQ({ id: 'demo' })] }).hook.prepare(T, 'demo', 'allow', {}).code, 'VALIDATION');
  assert.equal(mainHook({ requests: [] }).hook.prepare(T, 'r1', 'allow', {}).code, 'GONE');
  assert.equal(mainHook({ requests: [REQ({ decisionHash: undefined })] }).hook.prepare(T, 'r1', 'allow', {}).code, 'NOT_READY');
  assert.equal(mainHook({ requests: [REQ()] }).hook.prepare(T, 'r1', 'allow-session-0', {}).code, 'VALIDATION');
});

test('main: C-F is homeAnswerRefusal\'s: a flagged allow and a plan\'s auto-accept; a rules error is flagged', () => {
  assert.equal(mainHook({ requests: [REQ()], danger: () => 'deletes files' }).hook.prepare(T, 'r1', 'allow', {}).flagged, true);
  assert.equal(mainHook({ requests: [REQ()], danger: () => 'deletes files' }).hook.prepare(T, 'r1', 'deny', {}).flagged, false);
  const boom = mainHook({ requests: [REQ()], danger: () => { throw new Error('x'); } }).hook.prepare(T, 'r1', 'allow', {});
  assert.equal(boom.flagged, true);
  assert.equal(boom.danger, 'it could not be checked');
  const plan = REQ({ kind: 'plan', tool: 'ExitPlanMode', toolInput: { plan: 'do it' } });
  assert.equal(mainHook({ requests: [plan] }).hook.prepare(T, 'r1', 'allow-accept-edits', {}).flagged, true);
  assert.equal(mainHook({ requests: [plan] }).hook.prepare(T, 'r1', 'allow', {}).flagged, false);
});

test('main: inputs are the bound session\'s on this host only, with each hook request\'s hash', () => {
  const requests = [REQ(), REQ({ id: 'r2', sessionId: 's-2' }), REQ({ id: 'r3', host: 'vm' })];
  const { hook } = mainHook({ requests });
  const out = json(hook.inputs(T));
  assert.deepEqual(out.items.map((x) => [x.input.id, x.hash]), [['r1', 'a'.repeat(64)]]);
  assert.equal(out.answering, true);
  assert.deepEqual(json(mainHook({ requests, sessions: [] }).hook.inputs(T)), { answering: false, items: [] });
});

test('main: rebuildAnswer passes exactly answers, content and message; answer-input uses it', () => {
  assert.match(rebuildSrc, /\{ answers: m\.answers, content: m\.content, message: m\.message \}\)/);
  const handler = between(mainSrc, "ipcMain.handle('answer-input'", "ipcMain.handle('home:answer-input'");
  assert.ok(handler.includes('const answer = rebuildAnswer(req, optionId, m);'));
  assert.ok(!handler.includes('PendingInputs.answerFor'), 'one rebuild, shared');
});

test('AnswerMore.check is cleanExtra\'s rules plus anyway, and never oneKey', () => {
  assert.equal(AnswerMore.check({}), true);
  assert.equal(AnswerMore.check({ answers: { q: 'a' }, message: 'why', anyway: true }), true);
  assert.equal(AnswerMore.check({ content: { name: 'x' } }), true);
  for (const bad of [null, [], 'x', { oneKey: true }, { anyway: false }, { anyway: 1 }, { mode: 'acceptEdits' }, { message: 'x'.repeat(1001) }, { answers: [] }, { content: { a: { b: 1 } } }, Object.create({ x: 1 })]) {
    assert.equal(AnswerMore.check(bad), false, JSON.stringify(bad));
  }
});

// Ledger 21: the thread reads the request files only when this session has a hook input waiting.
test('main: inputs reads the request files only for a hook input; none waiting means no disk read', () => {
  const hookInput = (id) => ({ id, source: 'hook', session: 's-1', host: 'mac', provider: 'claude', answerable: true });
  const none = { n: 0 };
  assert.deepEqual(json(mainHook({ requests: [REQ()], reads: none, inputs: [] }).hook.inputs(T)).items, []);
  assert.equal(none.n, 0, 'nothing waiting: no read');
  const other = { n: 0 };
  assert.equal(json(mainHook({ requests: [REQ()], reads: other, inputs: [{ ...hookInput('r9'), session: 's-2' }] }).hook.inputs(T)).items.length, 0);
  assert.equal(other.n, 0, 'another session\'s input: no read');
  const dialog = { n: 0 };
  const d = json(mainHook({ requests: [REQ()], reads: dialog, inputs: [{ id: 'p1', source: 'pane', session: 's-1', host: 'mac', provider: 'claude' }] }).hook.inputs(T));
  assert.deepEqual(d.items.map((x) => [x.input.id, x.hash, x.danger]), [['p1', null, null]]);
  assert.equal(dialog.n, 0, 'a non-hook input: no read, same null hash and danger');
  const hook = { n: 0 };
  const h = json(mainHook({ requests: [REQ()], reads: hook, inputs: [hookInput('r1')], danger: () => 'deletes files' }).hook.inputs(T));
  assert.equal(hook.n, 1);
  assert.deepEqual(h.items.map((x) => [x.input.id, x.hash, x.danger]), [['r1', 'a'.repeat(64), 'deletes files']]);
  const noRow = { n: 0 }; // no local row for the thread's session (the travel return is the same early exit)
  assert.deepEqual(json(mainHook({ requests: [REQ()], reads: noRow, inputs: [hookInput('r1')] }).hook.inputs({ source: 'claude', sessionId: 's-none' })), { answering: false, items: [] });
  assert.equal(noRow.n, 0);
});

test('main: computeState still reads the requests on every build, so dead-pid reaping does not depend on an open thread', () => {
  const compute = between(mainSrc, 'function computeState(', 'const sessions = ');
  assert.ok(compute.includes('const requests = readRequests();'));
});

test('signal-server readRequests reaps a request whose hook process is dead, with no thread involved', () => {
  const fs2 = require('node:fs'), os2 = require('node:os');
  const dir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'l21-req-'));
  try {
    const AF = require('../hooks/answer-file.js');
    const mk = (id, pid) => { const r = { id, createdAt: new Date().toISOString(), host: os2.hostname().split('.')[0], pid, sessionId: 's-1', tool: 'Bash', toolInput: { command: 'ls' }, cwd: '/p' }; r.decisionHash = AF.decisionHashOf(r); fs2.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(r)); };
    mk('live', process.pid);
    const dead = require('node:child_process').spawnSync(process.execPath, ['-e', '0']);
    mk('gone', dead.pid);
    const S = require('../src/signal-server.js')({ rootDir: dir, sessionsDir: dir, requestsDir: dir, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port: 0, app: { on: () => {} } });
    assert.deepEqual(S.readRequests().map((r) => r.id), ['live']);
    assert.equal(fs2.existsSync(path.join(dir, 'gone.json')), false, 'the dead hook\'s request file was removed');
  } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
});
