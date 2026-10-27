'use strict';
// PR 0s: SessionRef, the driver state machine, chatState and openInTerminal
// (plan-agent-terminal §R2.13 PR 0s; plan-pr0s §3.1–3.2, §8 S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/session-surface');

const ref = (over) => S.sessionRef({ provider: 'claude', sessionId: 's-1', taskId: 'tsk_0123456789ab', origin: 'chat', driver: 'chat', ...over });

test('the driver state machine table', () => {
  const rows = [
    // origin, driver, takeover, handback
    ['chat', 'chat', 'terminal', null],
    ['chat', 'terminal', null, 'chat'],
    ['plexiform-tab', 'terminal', null, null],
    ['external', 'external', null, null],
  ];
  for (const [origin, driver, onTakeover, onHandback] of rows) {
    const r = ref({ origin, driver, taskId: origin === 'chat' ? 'tsk_0123456789ab' : null });
    assert.deepEqual(S.nextDriver(r, 'takeover'), onTakeover ? { ok: true, driver: onTakeover } : { ok: false, code: 'ILLEGAL_TRANSITION' }, `${origin}/${driver} takeover`);
    assert.deepEqual(S.nextDriver(r, 'handback'), onHandback ? { ok: true, driver: onHandback } : { ok: false, code: 'ILLEGAL_TRANSITION' }, `${origin}/${driver} handback`);
    assert.deepEqual(S.nextDriver(r, 'detach'), { ok: false, code: 'ILLEGAL_TRANSITION' });
  }
  assert.deepEqual(S.nextDriver(null, 'takeover'), { ok: false, code: 'ILLEGAL_TRANSITION' });
});

test('sessionRef refuses every pair the table has no row for, and other bad fields', () => {
  for (const origin of S.ORIGINS) for (const driver of S.DRIVERS) {
    const legal = (origin === 'chat' && driver !== 'external') || (origin === 'plexiform-tab' && driver === 'terminal') || (origin === 'external' && driver === 'external');
    const make = () => ref({ origin, driver, taskId: origin === 'chat' ? 'tsk_0123456789ab' : null });
    if (legal) assert.equal(make().driver, driver); else assert.throws(make, { code: 'VALIDATION' }, `${origin}/${driver}`);
  }
  for (const bad of [{ provider: 'Claude Code' }, { sessionId: '' }, { sessionId: '../x' }, { taskId: null }, { hostApp: 'Warp' }, { tabId: 7 }, { origin: 'tab' }]) {
    assert.throws(() => ref(bad), { code: 'VALIDATION' }, JSON.stringify(bad));
  }
  const r = ref({ hostApp: 'Ghostty Dock', tabId: 'k1' });
  assert.ok(Object.isFrozen(r));
  assert.deepEqual(Object.keys(r), ['provider', 'sessionId', 'taskId', 'origin', 'driver', 'hostApp', 'tabId']);
});

test('driverOfTaskState covers every engine task state', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../board/tasks-api/schema.json'), 'utf8'));
  const states = new Set();
  JSON.stringify(schema, (k, v) => { if (k === 'enum' && Array.isArray(v) && v.includes('handed_over')) v.forEach((s) => states.add(s)); return v; });
  assert.ok(states.size >= 15 && states.has('in_review'));
  for (const s of states) assert.equal(S.driverOfTaskState(s), s === 'handing_over' || s === 'handed_over' ? 'terminal' : 'chat', s);
});

test('chatStateOf table', () => {
  const rows = [
    [{ state: 'running' }, {}, 'working'],
    [{ state: 'queued' }, {}, 'working'],
    [{ state: 'queued', awaitingConfirm: true }, {}, 'needs-you'],
    [{ state: 'blocked', actions: ['approve', 'deny'] }, {}, 'needs-you'],
    [{ state: 'running', actions: ['answer'] }, {}, 'needs-you'],
    [{ state: 'in_review' }, { diffFiles: 0 }, 'your-turn'],
    [{ state: 'in_review' }, { diffFiles: 3 }, 'review'],
    [{ state: 'in_review' }, { diffFiles: null }, 'review'],
    [{ state: 'in_review' }, {}, 'review'],
    [{ state: 'handed_over' }, {}, 'in-terminal'],
    [{ state: 'handing_over' }, {}, 'in-terminal'],
    // parked for any reason but a limit or a login is paused
    [{ state: 'parked', parkReason: 'manual' }, {}, 'paused'],
    [{ state: 'parked', parkReason: 'limit' }, {}, 'needs-you'],
    [{ state: 'parked', parkReason: 'auth' }, {}, 'needs-you'],
    [{ state: 'failed', failKind: 'limit' }, {}, 'needs-you'],
    [{ state: 'failed', failKind: 'crash' }, {}, 'failed'],
    [{ state: 'stalled' }, {}, 'failed'],
    [{ state: 'done', outcome: 'merged' }, {}, 'ended'],
  ];
  for (const [task, opts, want] of rows) assert.equal(S.chatStateOf(task, opts), want, JSON.stringify([task, opts]));
  assert.equal(S.chatStateOf(null), null);
});

// plan-pr0s §8 S1: tasks-service.js stays untouched; this proves the predicate
// C1 uses is canOpen's task half (tasks-service.js:404), combination by combination.
test('openInTerminalOf agrees with canOpen\'s task half for every combination', () => {
  const oldTaskHalf = (t) => t?.state === 'handed_over' && !!t.repo && !t.workInPlace && !t.hub && ['claude', 'codex'].includes(t.ai.id) && t.cost.budgetUsd === null;
  let n = 0;
  for (const state of ['handed_over', 'in_review']) for (const repo of [{ name: 'r' }, null]) for (const workInPlace of [false, true]) for (const hub of [false, true])
    for (const ai of ['claude', 'codex', 'gemini']) for (const budgetUsd of [null, 5]) {
      const t = { state, repo, workInPlace, hub, ai: { id: ai }, cost: { usd: 0, budgetUsd } };
      assert.equal(t?.state === 'handed_over' && S.openInTerminalOf(t).available, oldTaskHalf(t), JSON.stringify(t));
      n++;
    }
  assert.equal(n, 96);
});

test('openInTerminalOf reasons', () => {
  const ok = { repo: { name: 'r' }, workInPlace: false, hub: false, ai: { id: 'claude' }, cost: { budgetUsd: null } };
  assert.deepEqual(S.openInTerminalOf(ok), { available: true, code: null, reason: null });
  const why = (over, opts) => S.openInTerminalOf({ ...ok, ...over }, opts).reason;
  assert.equal(why({}, { quickChat: true }), 'quick-chat');
  assert.equal(why({ repo: null }), 'no-repo');
  assert.equal(why({ workInPlace: true }), 'in-place');
  assert.equal(why({ hub: true }), 'hub');
  assert.equal(why({ ai: { id: 'gemini' } }), 'provider');
  assert.equal(why({ cost: { budgetUsd: 2 } }), 'budgeted');
  assert.equal(S.openInTerminalOf({ ...ok, repo: null }).code, 'CANT_OPEN');
});
