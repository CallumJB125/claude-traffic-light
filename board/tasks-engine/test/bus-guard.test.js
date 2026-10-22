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
import { admit, mergeSettings, DEFAULT_SETTINGS } from '../bus/guard.js';
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
    // Another tool in the same repo is its own hop domain.
    assert.equal((await bus.op('handoff', { request_id: 'req-gemini-0001', to: { provider: 'codex' }, title: 'From gemini', provider: 'gemini' }, { provider: 'gemini', cwd: root })).hop, 1);
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
    // Two interactive hop domains (device, provider, repo), each capped at max_hops: AC8's expected bound.
    assert.ok(starts >= 2 && starts <= 2 * DEFAULT_SETTINGS.max_hops, `runs started: ${starts}`);
  } finally { bus.close(); rm(dir); }
});
