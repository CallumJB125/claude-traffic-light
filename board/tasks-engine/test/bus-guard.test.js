// Admission (AGENT-BUS.md §5): halt, tier, loops, rate and per-card/per-repo
// caps, reservation; and hop inheritance through what a session consumed
// (bus_wait/bus_read), derived by the store, never by the caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openBusLog } from '../bus/local-log.js';
import { admit, mergeSettings, strictSettings, DEFAULT_SETTINGS } from '../bus/guard.js';
import { createAgentBus } from '../bus/dispatcher.js';
import { tmpDir, rm, makeRepo } from './helpers.js';

const run = promisify(execFile);
const src = (tier = 'local_attested', agent_id = 'claude:local:aaaa') => ({ agent_id, tier, provider: agent_id.split(':')[0], device_id: 'd', identity_source: 'local_token' });
const h = (extra = {}) => ({ source: src(), to: { provider: 'codex' }, scope: 'local', card_id: null, repoRoot: '/r', hop: 1, visited: ['claude:local:aaaa'], reservation: 0, ...extra });
const offer = (log, extra = {}) => log.append({ v: 1, topic: 'handoff', kind: 'handoff.offer', handoff_id: `hof_${Math.random().toString(16).slice(2, 14)}`, source: src(), card_id: null, repo: { root: '/r' }, hop: 1, visited: [], created_at: Date.now(), expires_at: Date.now() + 1e6, ...extra });

function withLog(fn) {
  const dir = tmpDir('pxbg-');
  const log = openBusLog(path.join(dir, 'bus.db'));
  try { return fn(log); } finally { log.close(); rm(dir); }
}

test('halt and the off switch refuse with HALTED', () => withLog((log) => {
  const s = mergeSettings();
  assert.equal(admit(h(), { log, settings: s, now: Date.now }), null);
  log.setState('halted', true);
  assert.equal(admit(h(), { log, settings: s, now: Date.now }).reason, 'HALTED');
  log.setState('halted', false);
  assert.equal(admit(h(), { log, settings: mergeSettings({ enabled: false }), now: Date.now }).reason, 'HALTED');
}));

test('tier: interactive sessions are local only (TIER_NOT_ACCEPTED cross-user or team); run tier needs the hub', () => withLog((log) => {
  const s = mergeSettings();
  assert.deepEqual(DEFAULT_SETTINGS.accept_tiers, ['person', 'run_capability']);
  assert.equal(admit(h({ scope: 'team', card_id: 'c1' }), { log, settings: s, now: Date.now }).reason, 'TIER_NOT_ACCEPTED');
  assert.equal(admit(h({ to: { provider: 'codex', user: 'u-bob' } }), { log, settings: s, now: Date.now, self: { userId: 'u-me' } }).reason, 'TIER_NOT_ACCEPTED');
  assert.equal(admit(h({ to: { provider: 'codex', user: 'u-me' } }), { log, settings: s, now: Date.now, self: { userId: 'u-me' } }), null, 'the same user is local');
  assert.equal(admit(h({ scope: 'team', card_id: 'c1', source: src('run_capability', 'codex:run:x') }), { log, settings: s, now: Date.now }).reason, 'NO_ELIGIBLE_AGENT');
}));

test('loops: hop over max_hops, a visited agent, and handing straight back are LOOP', () => withLog((log) => {
  const s = mergeSettings();
  assert.equal(admit(h({ hop: 2 }), { log, settings: s, now: Date.now }), null);
  assert.equal(admit(h({ hop: 3 }), { log, settings: s, now: Date.now }).reason, 'LOOP');
  assert.equal(admit(h({ to: { agent_id: 'claude:local:aaaa' } }), { log, settings: s, now: Date.now }).reason, 'LOOP');
  assert.equal(admit(h({ source: src('run_capability', 'codex:run:b'), visited: ['claude:local:aaaa', 'codex:run:b'], to: { provider: 'claude' }, hop: 2 }), { log, settings: s, now: Date.now }).reason, 'LOOP');
  assert.equal(admit(h({ to: { agent_id: 'gemini:local:zzzz' } }), { log, settings: s, now: Date.now }).reason, 'NO_ELIGIBLE_AGENT', 'live sessions cannot be addressed');
}));

test('rate: per agent per hour, per card 6/day, per repo 12/day, circuit breaker after 3 failures', () => withLog((log) => {
  const s = mergeSettings();
  for (let i = 0; i < 6; i++) offer(log, { card_id: 'card-1', source: src('local_attested', `claude:local:a${i}`) });
  assert.equal(admit(h({ card_id: 'card-1' }), { log, settings: s, now: Date.now }).reason, 'RATE');
  assert.equal(admit(h({ card_id: 'card-2' }), { log, settings: s, now: Date.now }), null);
  for (let i = 0; i < 6; i++) offer(log, { source: src('local_attested', `claude:local:b${i}`) });
  assert.equal(admit(h({ card_id: 'card-2' }), { log, settings: s, now: Date.now }).reason, 'RATE', '12 runs/day on the repo');
  assert.equal(admit(h({ repoRoot: '/other' }), { log, settings: s, now: Date.now }), null);
  const tight = mergeSettings({ rates: { agent_per_h: 1 } });
  offer(log, { repo: { root: '/third' }, source: src('local_attested', 'claude:local:solo') });
  assert.equal(admit(h({ repoRoot: '/fourth', source: src('local_attested', 'claude:local:solo') }), { log, settings: tight, now: Date.now }).reason, 'RATE');
  for (let i = 0; i < 3; i++) log.append({ v: 1, topic: 'result', kind: 'result.failed', handoff_id: `hof_f${i}`, source: src(), card_id: null, repo: { root: '/flaky' }, hop: 1, visited: [], created_at: Date.now(), expires_at: Date.now() + 1e6 });
  assert.equal(admit(h({ repoRoot: '/flaky' }), { log, settings: s, now: Date.now }).reason, 'RATE');
}));

test('reservation: SPEND_CAP only when caps are on (owner default off)', () => withLog((log) => {
  const off = mergeSettings();
  assert.equal(off.caps.enabled, false);
  assert.equal(admit(h({ reservation: 1000 }), { log, settings: off, now: Date.now }), null);
  const on = mergeSettings({ caps: { enabled: true, member_usd: 8, handoff_usd: 5 } });
  assert.equal(admit(h({ reservation: 5 }), { log, settings: on, now: Date.now }), null);
  assert.equal(admit(h({ reservation: 6 }), { log, settings: on, now: Date.now }).reason, 'SPEND_CAP', 'over the per-handoff cap');
  log.reserve(new Date().toISOString().slice(0, 10), 5);
  assert.equal(admit(h({ reservation: 5 }), { log, settings: on, now: Date.now }).reason, 'SPEND_CAP', 'member remaining < reservation');
}));

// The dispatcher on a stub engine: tasks end when the test says so.
function stubEngine(repoRoot) {
  const e = new EventEmitter();
  e.tasks = new Map();
  e.git = (cwd, args) => run('git', args, { cwd }).then((r) => r.stdout);
  e.busPolicy = () => ({ bus: null, repos: { [repoRoot]: { bus_auto: true } } });
  e.busRepoAllowed = async () => true;
  let n = 0;
  e.createTask = async ({ spec }) => {
    const id = `tsk_${(++n).toString(16).padStart(6, '0')}`;
    e.tasks.set(id, { id, spec, source: spec.source, sourceMeta: spec.sourceMeta, state: 'running', ai: { id: spec.ai, model: null }, cost: { usd: 0 }, worktree: repoRoot, branch: 'buddy/x', repo: { root: repoRoot } });
    return { id };
  };
  e.end = (id, state = 'in_review') => { const t = e.tasks.get(id); Object.assign(t, { state, evidence: { summary: 'ok' } }); e.emit('event', { type: 'state', taskId: id }); };
  e.act = async ({ id }) => e.end(id, 'failed');
  return e;
}

test('hop inheritance: a session that waited on a result hands off at hop+1, and after reading that one is refused with LOOP', async () => {
  const dir = tmpDir('pxbh-');
  const repo = makeRepo(dir);
  const { realpathSync } = await import('node:fs');
  const root = realpathSync(repo.checkout);
  const engine = stubEngine(root);
  const bus = createAgentBus({ engine, dataDir: dir });
  await bus.op('busSetContext', {}); // what main does on every helper connection
  const caller = { provider: 'claude', cwd: root };
  const hand = (title) => bus.op('handoff', { request_id: `req-${title.replace(/\W/g, '')}-0001`, to: { provider: 'codex' }, title, provider: 'claude' }, caller);
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); return fn(); };
  try {
    const first = await hand('First');
    assert.equal(first.hop, 1, 'nothing consumed: hop 1');
    const fresh = await hand('Unrelated');
    assert.equal(fresh.hop, 1, 'a handoff that read no earlier result stays at hop 1');
    const t1 = await until(() => [...engine.tasks.values()].find((t) => t.sourceMeta.handoffId === first.handoff_id));
    engine.end(t1.id);
    assert.equal((await bus.op('wait', { handoff_id: first.handoff_id, timeout_s: 5, provider: 'claude' }, caller)).state, 'done');
    const second = await hand('Second');
    assert.equal(second.hop, 2, 'built on a hop-1 result it read');
    const t2 = await until(() => [...engine.tasks.values()].find((t) => t.sourceMeta.handoffId === second.handoff_id));
    engine.end(t2.id);
    const read = await bus.op('read', { topic: 'result', provider: 'claude' }, caller);
    assert.ok(read.events.length >= 2 && read.next_offset > 0);
    assert.equal((await hand('Third')).reason, 'LOOP', 'hop 3 > max_hops 2');
    // The hop domain is this Mac and the caller's own repo: a self-declared provider, or another target repo, does not reset it.
    assert.equal((await bus.op('handoff', { request_id: 'req-spoof-0001', to: { provider: 'codex' }, title: 'Spoofed', provider: 'zz' }, { provider: 'zz', cwd: root })).reason, 'LOOP');
    const elsewhere = tmpDir('pxbh2-');
    try {
      const other = realpathSync(makeRepo(elsewhere).checkout);
      assert.equal((await bus.op('handoff', { request_id: 'req-elsewhere-01', to: { provider: 'codex' }, repo: other, title: 'Elsewhere', provider: 'claude' }, caller)).reason, 'LOOP');
      assert.equal((await bus.op('handoff', { request_id: 'req-fromother-1', to: { provider: 'codex' }, title: 'From the other repo', provider: 'claude' }, { provider: 'claude', cwd: other })).hop, 1, 'a session in another repo is its own domain');
    } finally { rm(elsewhere); }
    // Same content again within the hour: the same handoff, no second run.
    const dup = await bus.op('handoff', { request_id: 'req-other-0001', to: { provider: 'codex' }, title: 'First', provider: 'claude' }, caller);
    assert.deepEqual([dup.handoff_id, dup.duplicate], [first.handoff_id, true]);
  } finally { bus.close(); rm(dir); }
});

test('100 ping-pong attempts between two sessions start at most max_hops runs per hop domain', async () => {
  const dir = tmpDir('pxbp-');
  const repo = makeRepo(dir);
  const { realpathSync } = await import('node:fs');
  const root = realpathSync(repo.checkout);
  const engine = stubEngine(root);
  const bus = createAgentBus({ engine, dataDir: dir });
  await bus.op('busSetContext', {}); // what main does on every helper connection
  try {
    let starts = 0;
    for (let i = 0; i < 100; i++) {
      // Each side hands to the other, waits for its own result and reads everything on the bus before the next turn.
      const p = i % 2 ? 'codex' : 'claude';
      const caller = { provider: p, cwd: root };
      const r = await bus.op('handoff', { request_id: `ping-${i}-pong`, to: { provider: p === 'claude' ? 'codex' : 'claude' }, title: `Ping ${i}`, provider: p }, caller);
      if (r.handoff_id && !r.duplicate) {
        starts++;
        let t;
        for (let k = 0; k < 100 && !(t = [...engine.tasks.values()].find((x) => x.sourceMeta.handoffId === r.handoff_id)); k++) await new Promise((res) => setTimeout(res, 5));
        engine.end(t.id);
        await bus.op('wait', { handoff_id: r.handoff_id, timeout_s: 2, provider: p }, caller);
      } else assert.equal(r.reason, 'LOOP');
      await bus.op('read', { topic: 'result', limit: 50, provider: p }, caller);
    }
    // One hop domain (this Mac, this repo) whatever each side calls itself: at most max_hops runs (AC8).
    assert.ok(starts >= 1 && starts <= DEFAULT_SETTINGS.max_hops, `runs started: ${starts}`);
  } finally { bus.close(); rm(dir); }
});

test('gemini is never a bus target: NO_ELIGIBLE_AGENT at admission', () => withLog((log) => {
  const s = mergeSettings();
  assert.equal(admit(h({ to: { provider: 'gemini' } }), { log, settings: s, now: Date.now }).reason, 'NO_ELIGIBLE_AGENT');
  assert.equal(admit(h({ to: { provider: 'claude' } }), { log, settings: s, now: Date.now }), null);
}));

test('policy.json and Preferences: the stricter of the two wins for enabled, auto_accept, wall clock and caps', () => {
  const s = strictSettings({ enabled: false, auto_accept: true, wall_clock_min: 5, caps: { enabled: true, member_usd: 30 } },
    { enabled: true, auto_accept: false, wall_clock_min: 20, caps: { enabled: false, member_usd: 10, handoff_usd: 2 } });
  assert.deepEqual([s.enabled, s.auto_accept, s.wall_clock_min, s.caps.enabled, s.caps.member_usd, s.caps.handoff_usd], [false, false, 5, true, 10, 2]);
  const prefsOnly = strictSettings(null, { wall_clock_min: 45, caps: { enabled: true, member_usd: 50 } });
  assert.deepEqual([prefsOnly.wall_clock_min, prefsOnly.caps.member_usd, prefsOnly.enabled], [45, 50, true], 'a key only one side sets comes from it');
  assert.equal(strictSettings({ wall_clock_min: 60 }, { wall_clock_min: 20 }).wall_clock_min, 20);
});

// A stub-engine bus with a clock, max_parallel and caps from policy.json, and whatever Preferences pushed.
async function stubBus(policyBus = {}) {
  const dir = tmpDir('pxbd-');
  const repo = makeRepo(dir);
  const { realpathSync } = await import('node:fs');
  const root = realpathSync(repo.checkout);
  const engine = stubEngine(root);
  engine.busPolicy = () => ({ bus: policyBus, repos: { [root]: { bus_auto: true } } });
  const clock = { t: Date.parse('2026-10-22T23:59:00Z') };
  const bus = createAgentBus({ engine, dataDir: dir, now: () => clock.t });
  await bus.op('busSetContext', {});
  const caller = { provider: 'claude', cwd: root };
  let n = 0;
  const hand = (extra = {}) => bus.op('handoff', { request_id: `req-stub-${++n}-000`, to: { provider: 'codex' }, title: `Job ${n}`, provider: 'claude', ...extra }, caller);
  const taskOf = (id) => [...engine.tasks.values()].find((t) => t.sourceMeta.handoffId === id);
  const until = async (fn, label = 'condition') => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`timed out: ${label}`); };
  const settle = () => new Promise((r) => setTimeout(r, 60));
  return { engine, bus, clock, hand, taskOf, until, settle, root, cleanup() { bus.close(); rm(dir); } };
}

test('turning the bus off stops queued offers from starting; turning it on starts them', async () => {
  const b = await stubBus({ max_parallel: 1 });
  try {
    const first = await b.hand();
    const second = await b.hand();
    const t1 = await b.until(() => b.taskOf(first.handoff_id), 'first started');
    await b.bus.op('busSetContext', { settings: { enabled: false } });
    b.engine.end(t1.id);
    await b.settle();
    assert.equal(b.bus.log.claimOf(second.handoff_id), null, 'off: no claim for the queued offer');
    assert.equal((await b.hand()).reason, 'HALTED');
    await b.bus.op('busSetContext', { settings: { enabled: true } });
    await b.until(() => b.taskOf(second.handoff_id), 'second starts once on');
  } finally { b.cleanup(); }
});

test('a halt that lands while a run is starting stops it and releases the claim; resume starts it again', async () => {
  const b = await stubBus();
  try {
    const create = b.engine.createTask;
    let release;
    const gate = new Promise((r) => { release = r; });
    const stopped = [];
    b.engine.act = async ({ id }) => { stopped.push(id); b.engine.end(id, 'failed'); };
    b.engine.createTask = async (a) => { await gate; return create(a); };
    const offer = await b.hand();
    await b.until(() => b.bus.log.claimOf(offer.handoff_id)?.state === 'granted', 'claim granted');
    await b.bus.op('halt');
    release();
    await b.until(() => stopped.length === 1, 'the new run is stopped');
    const c = b.bus.log.claimOf(offer.handoff_id);
    assert.deepEqual([c.state, c.task_id, c.fence], ['reopened', null, 1]);
    assert.equal(b.bus.log.result(offer.handoff_id), null, 'a released start posts no result');
    b.engine.createTask = create;
    await b.bus.op('resume');
    await b.until(() => b.bus.log.claimOf(offer.handoff_id)?.state === 'started' && b.bus.log.claimOf(offer.handoff_id).fence === 2, 'restarted on resume');
  } finally { b.cleanup(); }
});

test('wall clock: the shorter of policy.json and Preferences reaches the run', async () => {
  const b = await stubBus({ wall_clock_min: 5 });
  try {
    await b.bus.op('busSetContext', { settings: { wall_clock_min: 20 } });
    const offer = await b.hand();
    assert.equal((await b.until(() => b.taskOf(offer.handoff_id))).spec.wallClockMs, 5 * 60_000);
  } finally { b.cleanup(); }
});

test('caps on: reservation at claim, settled to the measured cost on the day it was reserved', async () => {
  const b = await stubBus({ caps: { enabled: true, handoff_usd: 5, member_usd: 20 } });
  try {
    const offer = await b.hand();
    const t = await b.until(() => b.taskOf(offer.handoff_id));
    assert.equal(b.bus.log.claimOf(offer.handoff_id).reserved_usd, 5);
    assert.deepEqual({ ...b.bus.log.spend('2026-10-22') }, { reserved: 5, spent: 0 });
    b.clock.t += 2 * 60_000; // past midnight
    t.tokens = { inputTokens: 400_000, outputTokens: 50_000 }; // $0.50 + $0.50 at gpt-5-codex list price
    b.engine.end(t.id);
    await b.until(() => b.bus.log.result(offer.handoff_id));
    assert.deepEqual({ ...b.bus.log.spend('2026-10-22') }, { reserved: 0, spent: 1 });
    assert.deepEqual({ ...b.bus.log.spend('2026-10-23') }, { reserved: 0, spent: 0 }, 'nothing stranded on the next day');
  } finally { b.cleanup(); }
});

test('caps on: Claude runs get budgetUsd (the handoff budget, else the per-handoff cap); Codex runs get none', async () => {
  const b = await stubBus({ caps: { enabled: true, handoff_usd: 4, member_usd: 20 }, max_parallel: 3 });
  try {
    const own = await b.hand({ to: { provider: 'claude' }, budget_usd: 2 });
    const cap = await b.hand({ to: { provider: 'claude' } });
    const codex = await b.hand();
    assert.equal((await b.until(() => b.taskOf(own.handoff_id))).spec.budgetUsd, 2);
    assert.equal((await b.until(() => b.taskOf(cap.handoff_id))).spec.budgetUsd, 4);
    assert.equal((await b.until(() => b.taskOf(codex.handoff_id))).spec.budgetUsd, undefined);
  } finally { b.cleanup(); }
});

test('caps on: a start that fails, and an offer that expires, release their reservations', async () => {
  const b = await stubBus({ caps: { enabled: true, handoff_usd: 5, member_usd: 10 }, max_parallel: 1 });
  try {
    const create = b.engine.createTask;
    b.engine.createTask = async () => { throw Object.assign(new Error('Codex is not logged in'), { code: 'AI_UNAVAILABLE' }); };
    // $10 a day at $5 a handoff: a leaked reservation would refuse the third with SPEND_CAP.
    for (let i = 0; i < 3; i++) {
      const r = await b.hand();
      assert.ok(r.handoff_id, r.reason);
      await b.until(() => b.bus.log.result(r.handoff_id)?.kind === 'result.failed', 'failed start');
    }
    assert.deepEqual({ ...b.bus.log.spend('2026-10-22') }, { reserved: 0, spent: 0 }, 'failed starts lock nothing');
    b.clock.t += 61 * 60_000; // past the failure circuit breaker's hour
    b.engine.createTask = create;
    const running = await b.hand({ request_id: 'req-running-001', title: 'Running' });
    const t = await b.until(() => b.taskOf(running.handoff_id));
    const queued = await b.hand({ request_id: 'req-queued-0001', title: 'Queued', ttl_s: 60 });
    assert.equal(queued.state, 'offered');
    b.clock.t += 61_000;
    b.engine.end(t.id);
    await b.until(() => b.bus.log.result(queued.handoff_id), 'expired');
    assert.equal(b.bus.log.result(queued.handoff_id).kind, 'result.expired');
    assert.equal(b.taskOf(queued.handoff_id), undefined, 'never started');
    assert.equal({ ...b.bus.log.spend('2026-10-23') }.reserved, 0, 'the expired offer released its reservation');
  } finally { b.cleanup(); }
});

test('a halt mid-start whose stop fails marks the claim lost (outcome_unknown) and never starts it again', async () => {
  const b = await stubBus();
  try {
    const create = b.engine.createTask;
    let release;
    const gate = new Promise((r) => { release = r; });
    b.engine.act = async () => { throw new Error('stop failed'); };
    b.engine.createTask = async (a) => { await gate; return create(a); };
    const offer = await b.hand();
    await b.until(() => b.bus.log.claimOf(offer.handoff_id)?.state === 'granted', 'claim granted');
    await b.bus.op('halt');
    release();
    await b.until(() => b.bus.log.result(offer.handoff_id), 'result');
    assert.equal(b.bus.log.result(offer.handoff_id).kind, 'result.outcome_unknown');
    assert.equal(b.bus.log.claimOf(offer.handoff_id).state, 'lost');
    await b.bus.op('resume');
    await b.settle();
    assert.equal([...b.engine.tasks.values()].length, 1, 'no second run beside the one that would not stop');
  } finally { b.cleanup(); }
});

test('while halted, an offer that expires still gets result.expired and releases its reservation', async () => {
  const b = await stubBus({ caps: { enabled: true, handoff_usd: 5, member_usd: 20 }, max_parallel: 1 });
  try {
    const first = await b.hand();
    await b.until(() => b.taskOf(first.handoff_id), 'first started');
    const queued = await b.hand({ ttl_s: 60 });
    await b.bus.op('halt');
    await b.until(() => b.bus.log.result(first.handoff_id), 'halted run ended');
    b.clock.t += 61_000;
    await b.bus.op('busSetContext', {}); // any pump pass
    await b.until(() => b.bus.log.result(queued.handoff_id), 'expired while halted');
    assert.equal(b.bus.log.result(queued.handoff_id).kind, 'result.expired');
    assert.equal(b.bus.log.state('halted'), true);
    assert.equal({ ...b.bus.log.spend('2026-10-22') }.reserved, 0, 'nothing held while halted');
  } finally { b.cleanup(); }
});

test('a granted claim whose start throws before createTask still ends in a result (never stuck granted)', async () => {
  const b = await stubBus({ caps: { enabled: true, handoff_usd: 5, member_usd: 20 } });
  try {
    const at = b.clock.t;
    const bad = b.bus.log.append({ v: 1, topic: 'handoff', kind: 'handoff.offer', request_id: null, scope: 'local', card_id: null, repo: { root: b.root }, handoff_id: 'hof_badbadbadbad0001',
      source: { device_id: 'd', agent_id: 'claude:local:aaaa', provider: 'claude', tier: 'local_attested', identity_source: 'local_token' }, to: { provider: 'codex' },
      body: null, data: { title: 'Malformed', reservation: 5 }, hop: 1, visited: [], caused_by: null, created_at: at, expires_at: at + 3_600_000, grants_execution: false, approval: false });
    b.bus.log.reserve('2026-10-22', 5);
    await b.bus.op('busSetContext', {});
    await b.until(() => b.bus.log.result(bad.handoff_id), 'result');
    assert.equal(b.bus.log.result(bad.handoff_id).kind, 'result.failed');
    assert.deepEqual({ ...b.bus.log.spend('2026-10-22') }, { reserved: 0, spent: 0 });
  } finally { b.cleanup(); }
});
