'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createGuard, takeoverCommand } = require('../src/tasks-guard.js');

const api = (f) => import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', f)).href);
let G;
let P;
test.before(async () => { P = await api('protocol.js'); G = createGuard({ P, taskFace: (await api('face.js')).taskFace }); });

const view = (over = {}) => ({
  id: 't1', title: 'Add dark mode', state: 'running', blockedKind: null, failKind: null, parkReason: null, outcome: null, green: true,
  label: 'Running', tone: 'green', reason: 'Claude is working', actions: ['message', 'pause', 'takeover', 'stop'], confirm: [],
  ai: { id: 'claude', reason: null, model: null }, surface: 'background', permissionLevel: 'auto-edits', planFirst: false, source: 'local', awaitingConfirm: false,
  repo: { root: '/Users/me/Dev/acme', name: 'acme' }, branch: 'buddy/x', workInPlace: false, cost: { usd: 0.5, budgetUsd: null }, stateAgeMs: 5000, createdAgeMs: 60000, lastSeq: 4, hub: null, live: null, ...over,
});

test('sanitizeTask keeps the face and drops anything not whitelisted (extra fields, unknown actions, odd tones)', () => {
  const t = G.sanitizeTask({ ...view({ actions: ['stop', 'rm -rf', 'message'], tone: '<script>' }), token: 'btk_secret', env: { A: 'b' } }, { now: 1_000_000, homeDir: '/Users/me' });
  assert.deepEqual(t.actions, ['stop', 'message']);
  assert.equal(t.tone, 'grey');
  assert.equal(t.where, '~/Dev/acme');
  assert.equal(t.createdAtMs, 940_000);
  assert.equal(t.green, true);
  assert.ok(!('token' in t) && !('env' in t) && !('live' in t));
  assert.equal(G.sanitizeTask({ id: '' }), null);
  assert.equal(G.sanitizeTask(null), null);
  assert.equal(G.sanitizeTask({ id: 'x'.repeat(200) }), null);
});

test('only a running task can be green, and strings are bounded', () => {
  assert.equal(G.sanitizeTask(view({ state: 'parked', green: true })).green, false);
  assert.equal(G.sanitizeTask(view({ title: 'x'.repeat(5000) })).title.length, 200);
  assert.equal(G.sanitizeTask(view({ green: 'true' })).green, false);
});

test('taskFace fills in when the supervisor sent no face', () => {
  const v = view({ state: 'parked', parkReason: 'user', actions: undefined, label: undefined, reason: undefined, tone: undefined, green: undefined });
  const t = G.sanitizeTask(v);
  assert.equal(t.label, 'Paused');
  assert.match(t.reason, /paused by you/);
  assert.ok(t.actions.includes('resume'));
});

test('the green lease: green only while it holds; a dropped connection never leaves a live-looking task', () => {
  const t = G.sanitizeTask(view());
  assert.equal(G.withLease(t, { connected: true, leaseGreen: true }).green, true);
  const stale = G.withLease(t, { connected: true, leaseGreen: false });
  assert.deepEqual([stale.green, stale.tone], [false, 'unknown']);
  const lost = G.withLease(t, { connected: false, leaseGreen: true });
  assert.deepEqual([lost.green, lost.label, lost.tone, lost.actions, lost.stale], [false, 'Connection lost', 'unknown', [], true]);
  const done = G.withLease(G.sanitizeTask(view({ state: 'done', label: 'Done', tone: 'done', green: false, actions: [] })), { connected: false });
  assert.equal(done.label, 'Done');
  assert.equal(done.stale, true);
});

test('detail: messages, approvals and choices are sanitised and bounded', () => {
  const d = G.sanitizeDetail({
    ...view({ state: 'blocked' }), text: 'x'.repeat(30000), worktree: '/Users/me/wt', baseBranch: 'main', handover: { version: 3, markdown: '# h', provenance: 'continuous', syncedAgeMs: 2000 },
    evidence: { tests: 'pass', testCommand: 'npm test', testTail: 'secret tail', diffStat: { files: 2, added: 5, removed: 1 }, summary: 'ok' }, pr: null,
    openApprovals: [{ approvalId: 'a1', tool: 'Bash', inputSummary: 'ls', requestedAgeMs: 1 }],
    openAsk: { askId: 'k1', kind: 'limit', text: 'limit', options: null, choices: [{ id: 'c', label: 'Wait', action: 'resume', payload: { when: 'reset' } }, { id: 'z', label: 'Evil', action: 'launchMissiles', payload: {} }], askedAgeMs: 1 },
    messages: [{ id: 'm1', seq: 2, taskId: 't1', direction: 'in', from: { kind: 'task', id: 'task:t2', label: 'Other' }, to: { kind: 'task', id: 'task:t1', label: 'Me' }, body: 'hi', replyTo: null, createdAt: 1, deliveredAt: null, readAt: null, source: null, quarantined: true, flags: ['suspected_injection'] }],
  }, { now: 10_000, homeDir: '/Users/me' });
  assert.equal(d.text.length, 20000);
  assert.equal(d.worktree, '~/wt');
  assert.equal(d.handover.syncedAtMs, 8000);
  assert.ok(!('testTail' in d.evidence));
  assert.deepEqual(d.openAsk.choices.map((c) => c.action), ['resume'], 'a choice naming an unknown action is dropped');
  assert.equal(d.messages[0].quarantined, true);
});

test('events: only the shown types cross, error text is replaced by its code, text is bounded', () => {
  assert.equal(G.sanitizeEvent({ type: 'handover', seq: 1 }), null);
  assert.equal(G.sanitizeEvent({ type: 'bogus' }), null);
  assert.equal(G.sanitizeEvent(null), null);
  assert.deepEqual(G.sanitizeEvent({ type: 'error', seq: 3, code: 'DISK_FULL', message: 'ENOSPC /private/path', fatal: false }), { type: 'error', seq: 3, code: 'DISK_FULL' });
  assert.equal(G.sanitizeEvent({ type: 'error', seq: 3, code: 'WHATEVER', message: 'x' }).code, 'INTERNAL');
  assert.equal(G.sanitizeEvent({ type: 'transcript', seq: 1, role: 'assistant', text: 'y'.repeat(100000), turn: 1 }).text.length, P.MAX_TRANSCRIPT_CHUNK);
  assert.equal(G.sanitizeEvent({ type: 'transcript', seq: 1, role: 'hacker', text: 'a', turn: 1 }).role, 'system');
  const st = G.sanitizeEvent({ type: 'state', seq: 5, taskId: 't1', state: 'blocked', prevState: 'running', green: false, label: 'Needs you', tone: 'amber', reason: 'asks', actions: ['approve', 'deny'], confirm: [] });
  assert.equal(st.patch.state, 'blocked');
  const next = G.applyState(G.sanitizeTask(view()), { type: 'state', seq: 5, taskId: 't1', state: 'blocked', prevState: 'running', green: false, label: 'Needs you', tone: 'amber', reason: 'asks', actions: ['approve', 'deny'], confirm: [] }, 99);
  assert.deepEqual([next.state, next.label, next.actions, next.stateSinceMs, next.title], ['blocked', 'Needs you', ['approve', 'deny'], 99, 'Add dark mode']);
});

test('validateAct: an action the face does not offer, an unknown one, a bad id or a missing task is refused', () => {
  const t = G.sanitizeTask(view());
  assert.equal(G.validateAct({ id: 't1', action: 'merge', payload: {} }, t).code, 'ILLEGAL_TRANSITION');
  assert.equal(G.validateAct({ id: 't1', action: 'format-disk' }, t).code, 'VALIDATION');
  assert.equal(G.validateAct({ id: 7, action: 'pause' }, t).code, 'VALIDATION');
  assert.equal(G.validateAct({ id: 't1', action: 'pause' }, null).code, 'NOT_FOUND');
  assert.equal(G.validateAct({ id: 'other', action: 'pause' }, t).code, 'NOT_FOUND');
  assert.equal(G.validateAct(null, t).code, 'VALIDATION');
  assert.deepEqual(G.validateAct({ id: 't1', action: 'pause' }, t), { ok: true, id: 't1', action: 'pause', payload: {} });
});

const ids = (extra = {}) => ({ approvals: new Map([['a1', { tool: 'Bash' }], ['st', { tool: 'StartTask' }]]), asks: new Set(['k']), ...extra });

test('validateAct: the lighter destructive actions need the page’s confirmed flag (stop, merge)', () => {
  const t = G.sanitizeTask(view({ actions: ['stop', 'merge'], confirm: [] }));
  for (const a of ['stop', 'merge']) assert.equal(G.validateAct({ id: 't1', action: a }, t, ids()).code, 'CONFIRM_REQUIRED', a);
  assert.equal(G.validateAct({ id: 't1', action: 'stop', confirmed: 'yes' }, t, ids()).code, 'CONFIRM_REQUIRED', 'only true counts');
  assert.equal(G.validateAct({ id: 't1', action: 'stop', confirmed: true }, t, ids()).ok, true);
});

test('validateAct: discard, openPr, takeover, approve-for-task and a StartTask accept are main-confirmed; the page’s confirmed:true never bypasses', () => {
  const t = G.sanitizeTask(view({ state: 'blocked', actions: ['takeover', 'discard', 'openPr', 'approve', 'deny'], confirm: ['discard', 'takeover'] }));
  const need = (req) => G.validateAct({ id: 't1', confirmed: true, ...req }, t, ids());
  for (const req of [{ action: 'discard' }, { action: 'openPr' }, { action: 'takeover' }, { action: 'approve', payload: { approvalId: 'a1', scope: 'task' } }, { action: 'approve', payload: { approvalId: 'st' } }]) {
    const r = need(req);
    assert.deepEqual([r.ok, r.code, r.native], [false, 'CONFIRM_REQUIRED', true], JSON.stringify(req));
  }
  assert.equal(need({ action: 'approve', payload: { approvalId: 'a1', scope: 'once' } }).ok, true, 'an ordinary one-off approval needs no dialog');
  assert.equal(need({ action: 'deny', payload: { approvalId: 'st' } }).ok, true, 'denying is never risky');
  const ok = (req) => G.validateAct({ id: 't1', ...req }, t, ids({ nativeConfirmed: true }));
  assert.deepEqual(ok({ action: 'discard' }).payload, { confirm: true });
  assert.deepEqual(ok({ action: 'takeover', payload: { mode: 'tab' } }).payload, { mode: 'print', confirm: true }, 'the page cannot pick a mode that opens a terminal');
  assert.deepEqual(ok({ action: 'approve', payload: { approvalId: 'st', scope: 'task' } }).payload, { approvalId: 'st', scope: 'once' }, 'a StartTask accept is always once');
});

test('validateAct: an approval or ask id main did not relay is refused', () => {
  const t = G.sanitizeTask(view({ state: 'blocked', actions: ['approve', 'deny', 'answer'] }));
  assert.equal(G.validateAct({ id: 't1', action: 'approve', payload: { approvalId: 'forged' } }, t, ids()).code, 'NOT_FOUND');
  assert.equal(G.validateAct({ id: 't1', action: 'deny', payload: { approvalId: 'forged' } }, t, ids()).code, 'NOT_FOUND');
  assert.equal(G.validateAct({ id: 't1', action: 'answer', payload: { askId: 'forged', answer: 'x' } }, t, ids()).code, 'NOT_FOUND');
  assert.equal(G.validateAct({ id: 't1', action: 'approve', payload: { approvalId: 'a1' } }, t, {}).code, 'NOT_FOUND', 'nothing relayed, nothing answerable');
});

test('validateAct: payloads are rebuilt from known keys with the protocol limits', () => {
  const t = G.sanitizeTask(view({ state: 'blocked', actions: ['message', 'approve', 'deny', 'answer', 'switchAi', 'resume', 'retry'] }));
  const ok = (action, payload) => G.validateAct({ id: 't1', action, payload }, t, ids());
  assert.deepEqual(ok('message', { body: '  hello ', extra: 1 }).payload, { body: 'hello' });
  assert.equal(ok('message', { body: '   ' }).code, 'VALIDATION');
  assert.equal(ok('message', { body: 'x'.repeat(8193) }).code, 'VALIDATION');
  assert.equal(ok('message', { body: 'x'.repeat(8192) }).ok, true);
  assert.equal(ok('message', { body: 'é'.repeat(4097) }).code, 'VALIDATION', 'bytes, not characters');
  assert.equal(ok('message', undefined).code, 'VALIDATION');
  assert.deepEqual(ok('approve', { approvalId: 'a1', scope: 'forever' }).payload, { approvalId: 'a1', scope: 'once' });
  assert.deepEqual(ok('deny', { approvalId: 'a1', message: 'ignored' }).payload, { approvalId: 'a1' });
  assert.deepEqual(ok('answer', { askId: 'k', answer: ' yes ' }).payload, { askId: 'k', answer: 'yes' });
  assert.equal(ok('answer', { askId: 'k', answer: '' }).code, 'VALIDATION');
  assert.deepEqual(ok('switchAi', { ai: 'codex' }).payload, { ai: 'codex' });
  assert.equal(ok('switchAi', { ai: 'skynet' }).code, 'VALIDATION');
  assert.deepEqual(ok('resume', { when: 'tomorrow' }).payload, { when: 'now' });
  assert.deepEqual(ok('retry', { fresh: true, junk: 1 }).payload, { fresh: true });
});

test('validateCreate: the folder comes from main, the words are bounded, defaults are safe', () => {
  assert.equal(G.validateCreate({ text: 'do it' }, undefined).code, 'VALIDATION', 'no resolved folder, no task');
  assert.equal(G.validateCreate({ text: '   ' }, '/p').code, 'VALIDATION');
  assert.equal(G.validateCreate({ text: 'x'.repeat(20001) }, '/p').code, 'VALIDATION');
  assert.equal(G.validateCreate(null, '/p').code, 'VALIDATION');
  const v = G.validateCreate({ text: ' fix it ', cwd: '/etc', ai: 'gpt9', surface: 'rm', permissionLevel: 'bypass', source: 'board', planFirst: 1 }, '/p');
  assert.deepEqual(v, { ok: true, spec: { text: 'fix it', cwd: '/p', source: 'local', ai: 'auto', surface: 'background' } }, 'bypass is never offered; the page cannot set cwd or source');
  assert.deepEqual(G.validateCreate({ text: 'x', ai: 'codex', surface: 'tab', permissionLevel: 'ask', planFirst: true }, '/p').spec, { text: 'x', cwd: '/p', source: 'local', ai: 'codex', surface: 'tab', permissionLevel: 'ask', planFirst: true });
});

test('every action the contract names is either handled or deliberately refused by validateAct', () => {
  for (const a of P.ACTIONS) {
    const t = G.sanitizeTask(view({ actions: [a], confirm: [] }));
    const r = G.validateAct({ id: 't1', action: a, confirmed: true, payload: { body: 'b', approvalId: 'a1', askId: 'k', answer: 'y', ai: 'codex' } }, t, ids({ nativeConfirmed: true }));
    assert.equal(r.ok, true, `${a} should be accepted with a good payload: ${r.code}`);
  }
});

test('choices relayed with an ask carry a payload rebuilt through the allow-list', () => {
  const d = G.sanitizeDetail({ ...view({ state: 'parked' }), text: '', openAsk: { askId: 'k', kind: 'limit', text: 't', options: null, askedAgeMs: 0, choices: [
    { id: 'a', label: 'Wait', action: 'resume', payload: { when: 'reset', evil: 1 } }, { id: 'b', label: 'Switch', action: 'switchAi', payload: { ai: 'skynet' } }, { id: 'c', label: 'Discard', action: 'discard', payload: { rm: 1 } },
  ] }, messages: [], openApprovals: [] });
  assert.deepEqual(d.openAsk.choices.map((c) => [c.action, c.payload]), [['resume', { when: 'reset' }], ['discard', { confirm: true }]], 'bad switchAi dropped, extras stripped');
});

test('tilde only replaces a whole home directory prefix', () => {
  const { tilde } = require('../src/tasks-guard.js');
  assert.equal(tilde('/Users/me', '/Users/me'), '~');
  assert.equal(tilde('/Users/me/dev', '/Users/me'), '~/dev');
  assert.equal(tilde('/Users/mel/dev', '/Users/me'), '/Users/mel/dev');
});

test('takeoverCommand: no secret-looking env var, an absolute binary, quoted for a shell; the screen masks the rest', () => {
  const fake = ['btk', 'run', 'abcdef0123456789abcdef'].join('_');
  const t = { argv: ['claude', '--resume', 's 1', "it's"], cwd: '/Users/me/my repo', env: { BOARD_RUN_TOKEN: fake, MY_API_KEY: 'k', DB_PASSWORD: 'p', CLIENT_SECRET: 's', BUDDY_TASK_ID: 'tsk1', 'bad name': 'x' } };
  const resolve = (n) => `/opt/homebrew/bin/${n}`;
  const copy = takeoverCommand(t, { resolve });
  assert.ok(!copy.includes('BOARD_RUN_TOKEN') && !copy.includes(fake) && !/KEY|PASSWORD|SECRET/.test(copy), copy);
  assert.equal(copy, "cd '/Users/me/my repo' && BUDDY_TASK_ID='tsk1' /opt/homebrew/bin/claude --resume 's 1' 'it'\\''s'");
  assert.equal(takeoverCommand(t, { resolve, mask: true }), "cd '/Users/me/my repo' && BUDDY_TASK_ID=… /opt/homebrew/bin/claude --resume 's 1' 'it'\\''s'");
  assert.equal(takeoverCommand({ argv: ['/usr/bin/codex', 'resume'] }, { resolve: () => 'NOPE' }).split(' ')[0], 'NOPE', 'resolve is the only thing that rewrites argv[0]');
});

test('resolveBin finds an executable on PATH, leaves an absolute path alone, and falls back to the name', () => {
  const { resolveBin } = require('../src/tasks-guard.js');
  const fs = require('node:fs'); const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  fs.writeFileSync(path.join(dir, 'fakeai'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveBin('fakeai', { PATH: dir }), path.join(dir, 'fakeai'));
  assert.equal(resolveBin('/abs/bin/x', { PATH: dir }), '/abs/bin/x');
  assert.equal(resolveBin('definitely-not-here-xyz', { PATH: dir }), 'definitely-not-here-xyz');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sanitizeAis keeps known AIs only', () => {
  const a = G.sanitizeAis([{ id: 'claude', installed: true, loggedIn: true, health: 'ok', notes: ['n'] }, { id: 'evil', installed: true }, { id: 'codex', installed: false, loggedIn: null, health: 'weird', notes: [] }]);
  assert.deepEqual(a.map((x) => [x.id, x.label, x.installed, x.loggedIn, x.health]), [['claude', 'Claude', true, true, 'ok'], ['codex', 'Codex', false, null, 'warn']]);
});
