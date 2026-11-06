// BACKBONE G4 (provider health, owner decision D4 fallback) and G5 (results come back as a note).
// A stub engine stands in for the CLIs: a Codex run that ends "usage limit … try again at <date>" opens its breaker,
// a hand-off naming Codex is refused at once with PROVIDER_UNAVAILABLE and retry_at, 'any' goes to the next AI in the
// person's order, and the asking session gets one Plexiform note with the handoff_id and outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentBus } from '../bus/dispatcher.js';
import { createProviderHealth, parseRetryAt, reasonOf } from '../bus/provider-health.js';
import { openBusLog } from '../bus/local-log.js';
import { tmpDir, rm, makeRepo } from './helpers.js';

const run = promisify(execFile);
const QUOTA_TEXT = "ERROR: You've hit your usage limit. Upgrade to Pro or try again at Nov 12th, 2026 7:42 PM.";
const ORIGIN = { key: 'claude|sess-origin-1', handle: 'claude-app-a1e0' };

function stubEngine(root) {
  const e = new EventEmitter();
  e.tasks = new Map();
  e.git = (cwd, args) => run('git', args, { cwd }).then((r) => r.stdout);
  e.busPolicy = () => ({ bus: null, repos: { [root]: { bus_auto: true } } });
  e.busRepoAllowed = async () => true;
  let n = 0;
  e.createTask = async ({ spec }) => {
    const id = `tsk_${(++n).toString(16).padStart(6, '0')}`;
    e.tasks.set(id, { id, spec, source: spec.source, sourceMeta: spec.sourceMeta, state: 'running', ai: { id: spec.ai, model: null }, cost: { usd: 0 }, worktree: root, branch: 'buddy/x', repo: { root } });
    return { id };
  };
  e.end = (id, state = 'in_review', extra = {}) => { const t = e.tasks.get(id); Object.assign(t, { state, evidence: { summary: 'Parser fixed; 12 tests pass.' }, ...extra }); e.emit('event', { type: 'state', taskId: id }); };
  e.act = async ({ id }) => e.end(id, 'failed');
  return e;
}

async function world({ fallback } = {}) {
  const dir = tmpDir('pxph-');
  const repo = makeRepo(dir);
  const root = fs.realpathSync(repo.checkout);
  const engine = stubEngine(root);
  const clock = { t: Date.parse('2026-11-06T10:00:00Z') };
  const bus = createAgentBus({ engine, dataDir: dir, now: () => clock.t });
  await bus.op('busSetContext', fallback ? { fallback } : {});
  const caller = { provider: 'claude', cwd: root, origin: ORIGIN };
  let n = 0;
  const hand = (to, extra = {}) => bus.op('handoff', { request_id: `req-ph-${++n}-0000`, to, title: `Job ${n}`, brief: 'Fix the parser.', provider: 'claude', ...extra }, caller);
  const taskOf = (id) => [...engine.tasks.values()].find((t) => t.sourceMeta.handoffId === id);
  const until = async (fn, label = 'condition') => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`timed out: ${label}`); };
  const notesFor = (key) => bus.op('notes', { me: { key } });
  return { dir, root, engine, bus, clock, hand, taskOf, until, notesFor, cleanup() { bus.close(); rm(dir); } };
}

test('parseRetryAt: the provider\'s own "try again" time, bounded; reasonOf maps failure kinds', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  assert.equal(parseRetryAt(QUOTA_TEXT, now), new Date(2026, 10, 12, 19, 42).getTime());
  assert.equal(parseRetryAt('Rate limited. Try again in 3 hours.', now), now + 3 * 3_600_000);
  assert.equal(parseRetryAt('usage limit; resets in 45 minutes', now), now + 45 * 60_000);
  assert.equal(parseRetryAt('try again at Jan 1st, 2031', now), null, 'beyond 14 days');
  assert.equal(parseRetryAt('usage limit reached', now), null);
  assert.equal(parseRetryAt('try again at banana', now), null);
  assert.equal(reasonOf({ failKind: 'limit' }), 'QUOTA');
  assert.equal(reasonOf({ failKind: 'auth' }), 'AUTH');
  assert.equal(reasonOf({ code: 'AI_UNAVAILABLE' }), 'MISSING');
  assert.equal(reasonOf({ failKind: 'provider' }), 'CRASH');
  assert.equal(reasonOf({ failKind: 'error' }), null, 'a task\'s own error is not the provider\'s');
});

test('breaker: CRASH opens on the third in a row, QUOTA at once; half open after retry_at admits runs and re-opens on the next failure; a success closes it', () => {
  const dir = tmpDir('pxph-u-');
  const log = openBusLog(`${dir}/bus.db`);
  const clock = { t: 1_000_000 };
  try {
    const h = createProviderHealth({ log, now: () => clock.t });
    h.failed('claude', 'CRASH'); h.failed('claude', 'CRASH');
    assert.equal(h.get('claude').state, 'closed');
    h.failed('claude', 'CRASH');
    assert.equal(h.get('claude').state, 'open');
    h.failed('codex', 'QUOTA', { text: 'try again in 2 hours' });
    assert.deepEqual([h.get('codex').state, h.get('codex').reason, h.get('codex').retry_at], ['open', 'QUOTA', clock.t + 7_200_000]);
    // Survives a restart (bus.db state).
    const again = createProviderHealth({ log, now: () => clock.t });
    assert.equal(again.get('claude').state, 'open');
    assert.deepEqual(Object.keys(again.get('claude')).sort(), ['failures', 'provider', 'reason', 'retry_at', 'since', 'state']);
    clock.t += 7_200_001;
    assert.equal(h.get('codex').state, 'half_open');
    assert.equal(h.admits('codex'), true);
    // Half open: the next provider failure re-opens it at once, even a CRASH.
    h.failed('codex', 'CRASH');
    assert.equal(h.get('codex').state, 'open');
    clock.t += 5 * 60_000 + 1;
    h.succeeded('codex');
    assert.deepEqual([h.get('codex').state, h.get('codex').failures], ['closed', 0]);
  } finally { log.close(); rm(dir); }
});

test('G4: a Codex run out of quota opens its breaker; a hand-off to Codex is refused in under 100 ms with retry_at; "any" goes to Claude', async () => {
  const w = await world();
  try {
    const first = await w.hand({ provider: 'codex' });
    assert.equal(first.provider, 'codex');
    const t = await w.until(() => w.taskOf(first.handoff_id), 'codex run');
    w.engine.end(t.id, 'failed', { failKind: 'limit', failReason: QUOTA_TEXT });
    await w.until(() => w.bus.log.result(first.handoff_id), 'result');
    const health = w.bus.health.get('codex');
    assert.deepEqual([health.state, health.reason, health.retry_at], ['open', 'QUOTA', new Date(2026, 10, 12, 19, 42).getTime()]);
    const t0 = process.hrtime.bigint();
    const refused = await w.hand({ provider: 'codex' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(refused.reason, 'PROVIDER_UNAVAILABLE');
    assert.equal(refused.provider, 'codex');
    assert.equal(refused.retry_at, health.retry_at);
    assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
    assert.doesNotMatch(refused.message, /usage limit|Upgrade/, 'the CLI\'s own text is never relayed');
    const any = await w.hand({ provider: 'any' });
    assert.equal(any.state, 'offered');
    assert.equal(any.provider, 'claude');
    assert.equal((await w.until(() => w.taskOf(any.handoff_id), 'claude run')).spec.ai, 'claude');
    // A list in the caller's order skips the open one too.
    assert.equal((await w.hand({ provider: ['codex', 'claude'] })).provider, 'claude');
    // G8 rule 2: the asker's board (main's route key) rides on the hand-off into the run's sourceMeta.
    const KEY = 'a'.repeat(64);
    for (const t of [...w.engine.tasks.values()].filter((x) => x.state === 'running')) w.engine.end(t.id);
    const boarded = await w.bus.op('handoff', { request_id: 'req-board-0001', to: { provider: 'claude' }, title: 'Boarded', provider: 'claude' }, { provider: 'claude', cwd: w.root, origin: { ...ORIGIN, board: KEY } });
    assert.equal((await w.until(() => w.taskOf(boarded.handoff_id))).spec.sourceMeta.originBoard, KEY);
    // status reports provider health for the UI (Lane 3).
    const st = await w.bus.op('status', {});
    assert.equal(st.providers.find((p) => p.provider === 'codex').state, 'open');
  } finally { w.cleanup(); }
});

test('D4 fallback: an "any" hand-off whose provider runs out of quota moves to the next in order, once, and the asker hears both', async () => {
  const w = await world({ fallback: { enabled: true, order: ['codex', 'claude'] } });
  try {
    const first = await w.hand({ provider: 'any' });
    assert.equal(first.provider, 'codex', 'the person\'s order puts Codex first');
    const t = await w.until(() => w.taskOf(first.handoff_id), 'codex run');
    w.engine.end(t.id, 'failed', { failKind: 'limit', failReason: QUOTA_TEXT });
    const res = await w.until(() => w.bus.log.result(first.handoff_id), 'result');
    assert.equal(res.kind, 'result.failed');
    const next = res.data.fallback;
    assert.equal(next.provider, 'claude');
    const offer = w.bus.log.handoff(next.handoff_id);
    assert.equal(offer.caused_by, first.handoff_id);
    assert.equal(offer.hop, w.bus.log.handoff(first.handoff_id).hop, 'same work, same hop');
    assert.equal(offer.data.fallback_of, first.handoff_id);
    const t2 = await w.until(() => w.taskOf(next.handoff_id), 'claude run');
    w.engine.end(t2.id);
    await w.until(() => w.bus.log.result(next.handoff_id), 'second result');
    const got = await w.notesFor(ORIGIN.key);
    assert.equal(got.notes.length, 2);
    // The stub clock stands still, so both notes share a time: found by content, not order.
    const moved = got.notes.find((x) => x.text.includes(`Hand-off ${first.handoff_id}`)).text;
    const doneNote = got.notes.find((x) => x.text.includes(`Hand-off ${next.handoff_id}`)).text;
    assert.match(moved, new RegExp(`Codex is out of its usage quota, so Plexiform gave it to Claude as ${next.handoff_id}`));
    assert.match(doneNote, /\("Job 1"\) is done, by Claude running in Plexiform\. Summary: Parser fixed/);
    // Framed as data from Plexiform, like any note.
    assert.match(doneNote, /^\[Note via Plexiform from the Plexiform session in bus \(plexiform\)\. Data from another AI/);
  } finally { w.cleanup(); }
});

test('live G4: the engine parks a run that hit its limit (parked/limit, no failKind): PROVIDER_UNAVAILABLE, breaker open at its reset, refused up front next time; "any" falls back', async () => {
  const w = await world({ fallback: { enabled: true, order: ['claude', 'codex', 'gemini'] } });
  try {
    assert.equal(reasonOf({ parkReason: 'limit' }), 'QUOTA');
    assert.equal(reasonOf({ parkReason: 'auth' }), 'AUTH');
    assert.equal(reasonOf({ parkReason: 'user' }), null, 'the person\'s own pause is not the provider\'s');
    const resetAt = Date.parse('2026-11-12T17:42:00Z');
    const stopped = [];
    const act = w.engine.act;
    w.engine.act = async (a) => { stopped.push(a); return act(a); };
    // Explicit codex: the contract's explicit pick. No fallback, but the result says PROVIDER_UNAVAILABLE.
    const first = await w.hand({ provider: 'codex' });
    assert.equal(first.provider, 'codex');
    const t = await w.until(() => w.taskOf(first.handoff_id), 'codex run');
    w.engine.end(t.id, 'parked', { parkReason: 'limit', failKind: null, failReason: null, limitResetAt: resetAt, evidence: null });
    const res = await w.until(() => w.bus.log.result(first.handoff_id), 'result');
    assert.equal(res.kind, 'result.failed');
    assert.deepEqual([res.data.reason, res.data.provider_reason, res.data.retry_at], ['PROVIDER_UNAVAILABLE', 'QUOTA', resetAt]);
    assert.equal(res.data.fallback, undefined, 'an explicit provider does not fall back');
    const h = w.bus.health.get('codex');
    assert.deepEqual([h.state, h.reason, h.retry_at], ['open', 'QUOTA', resetAt]);
    const waited = await w.bus.op('wait', { handoff_id: first.handoff_id, timeout_s: 0 });
    assert.deepEqual([waited.result.reason, waited.result.retry_at], ['PROVIDER_UNAVAILABLE', resetAt]);
    assert.ok(stopped.some((a) => a.id === t.id && a.action === 'stop'), 'the parked run is ended, so a resume never redoes it unseen');
    // Next explicit codex: refused up front.
    const again = await w.hand({ provider: 'codex' });
    assert.deepEqual([again.reason, again.provider, again.retry_at], ['PROVIDER_UNAVAILABLE', 'codex', resetAt]);
    // 'any' (and a list with codex first) go to Claude straight away.
    assert.equal((await w.hand({ provider: 'any' })).provider, 'claude');
    assert.equal((await w.hand({ provider: ['codex', 'claude'] })).provider, 'claude');
  } finally { w.cleanup(); }
});

test('live G4: an "any" hand-off whose run parks on its limit moves to the next AI in order', async () => {
  const w = await world({ fallback: { enabled: true, order: ['codex', 'claude'] } });
  try {
    const first = await w.hand({ provider: 'any' });
    assert.equal(first.provider, 'codex');
    const t = await w.until(() => w.taskOf(first.handoff_id), 'codex run');
    w.engine.end(t.id, 'parked', { parkReason: 'limit', failKind: null, limitResetAt: null, evidence: null });
    const res = await w.until(() => w.bus.log.result(first.handoff_id), 'result');
    assert.equal(res.data.reason, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.data.fallback.provider, 'claude');
    assert.equal((await w.until(() => w.taskOf(res.data.fallback.handoff_id), 'claude run')).spec.ai, 'claude');
  } finally { w.cleanup(); }
});

test('dedupe: never hands back a failed, expired or unknown-outcome hand-off; a different target is a new request; same request_id stays idempotent', async () => {
  const w = await world({ fallback: { enabled: false, order: ['claude', 'codex'] } });
  try {
    const same = { title: 'Same job', brief: 'Same brief.' };
    // The live failure: codex fails, a retry with 'any' and a new request_id got the old failed one back.
    const first = await w.hand({ provider: 'codex' }, same);
    const t = await w.until(() => w.taskOf(first.handoff_id), 'codex run');
    // Same content, same target, new request_id, still running: joins the live one.
    const live = await w.bus.op('handoff', { request_id: 'req-dd-live-0001', to: { provider: 'codex' }, ...same, provider: 'claude' }, { provider: 'claude', cwd: w.root, origin: ORIGIN });
    assert.deepEqual([live.handoff_id, live.duplicate], [first.handoff_id, true]);
    // Same content but 'any': another target, another hand-off.
    const other = await w.hand({ provider: 'any' }, same);
    assert.notEqual(other.handoff_id, first.handoff_id);
    assert.equal(other.duplicate, undefined);
    w.engine.end(t.id, 'failed', { failKind: 'error', failReason: 'boom' });
    await w.until(() => w.bus.log.result(first.handoff_id), 'result');
    // Failed now: the same content and target with a new request_id runs again.
    const retry = await w.bus.op('handoff', { request_id: 'req-dd-retry-0001', to: { provider: 'codex' }, ...same, provider: 'claude' }, { provider: 'claude', cwd: w.root, origin: ORIGIN });
    assert.notEqual(retry.handoff_id, first.handoff_id);
    assert.equal(retry.state, 'offered');
    // The same request_id again is the same request (idempotent), whatever its state.
    const replay = await w.bus.op('handoff', { request_id: 'req-dd-retry-0001', to: { provider: 'codex' }, ...same, provider: 'claude' }, { provider: 'claude', cwd: w.root, origin: ORIGIN });
    assert.deepEqual([replay.handoff_id, replay.duplicate], [retry.handoff_id, true]);
  } finally { w.cleanup(); }
});

test('D4 switch off: "any" does not move past an unavailable provider', async () => {
  const w = await world({ fallback: { enabled: false, order: ['codex', 'claude'] } });
  try {
    w.bus.health.failed('codex', 'QUOTA', { text: 'try again in 1 hour' });
    const r = await w.hand({ provider: 'any' });
    assert.equal(r.reason, 'PROVIDER_UNAVAILABLE');
    assert.equal(r.provider, 'codex');
  } finally { w.cleanup(); }
});

test('security review #5: a list hand-off only reaches AIs in the person\'s fallback order', async () => {
  const w = await world({ fallback: { enabled: true, order: ['claude'] } });
  try {
    const refused = await w.hand({ provider: ['codex'] });
    assert.equal(refused.reason, 'PROVIDER_UNAVAILABLE', JSON.stringify(refused));
    assert.equal(refused.provider, 'codex');
    assert.equal([...w.engine.tasks.values()].length, 0, 'no run started');
    const mixed = await w.hand({ provider: ['codex', 'claude'] });
    assert.equal(mixed.provider, 'claude', 'codex is skipped, not tried first');
    assert.equal(w.bus.health.choose(['codex', 'claude'], { order: ['claude', 'codex'] }).provider, 'codex', 'the caller\'s order within the person\'s');
    assert.ok(w.bus.health.choose(['codex'], { order: [] }).unavailable);
  } finally { w.cleanup(); }
});

test('G5: the asker gets exactly one Plexiform note with the handoff_id and outcome, for done and failed; a halted bus refuses first; none without a verified origin', async () => {
  const w = await world();
  try {
    const done = await w.hand({ provider: 'claude' });
    w.engine.end((await w.until(() => w.taskOf(done.handoff_id))).id);
    await w.until(() => w.bus.log.result(done.handoff_id));
    const failed = await w.hand({ provider: 'claude' });
    w.engine.end((await w.until(() => w.taskOf(failed.handoff_id))).id, 'failed', { failKind: 'error', failReason: 'tests fail' });
    await w.until(() => w.bus.log.result(failed.handoff_id));
    const pending = await w.bus.op('notes_pending', {});
    const mine = pending.notes.filter((n) => n.to_key === ORIGIN.key);
    assert.equal(mine.length, 2);
    assert.ok(mine.every((n) => n.from_handle === 'plexiform' && n.from_provider === 'plexiform'));
    assert.ok(!JSON.stringify(pending).includes('Parser fixed'), 'notices are metadata only');
    const got = await w.notesFor(ORIGIN.key);
    assert.match(got.notes.find((x) => x.text.includes(done.handoff_id)).text, /\("Job 1"\) is done/);
    assert.match(got.notes.find((x) => x.text.includes(failed.handoff_id)).text, /\("Job 2"\) failed\. Summary: The AI stopped with an error\./);
    assert.equal(w.engine.tasks.get((w.taskOf(failed.handoff_id)).id).state, 'failed');
    // A task's own error never opens the provider's breaker.
    assert.equal(w.bus.health.get('claude').state, 'closed');
    // Expired before it started.
    await w.bus.op('halt', {});
    const late = await w.hand({ provider: 'claude' }, { ttl_s: 60 });
    assert.equal(late.reason, 'HALTED');
    // A caller main did not verify (no origin): the result stays in bus_wait/bus_read only.
    await w.bus.op('resume', {});
    const anon = await w.bus.op('handoff', { request_id: 'req-anon-00001', to: { provider: 'claude' }, title: 'Anon', provider: 'claude' }, { provider: 'claude', cwd: w.root, origin: { key: 'bogus', handle: 'x' } });
    w.engine.end((await w.until(() => w.taskOf(anon.handoff_id))).id);
    await w.until(() => w.bus.log.result(anon.handoff_id));
    // bus_notes leaves notes unread until main acks them (two-phase): still the same two, and none for the anonymous caller.
    const all = (await w.bus.op('notes_pending', {})).notes;
    assert.deepEqual(all.map((x) => x.to_key), [ORIGIN.key, ORIGIN.key]);
  } finally { w.cleanup(); }
});

test('trace (acceptance 7): every op and lifecycle step is one line; a hand-off\'s lines share its trace_id; no title, brief, summary or path', async () => {
  const w = await world();
  try {
    const TRACE = 'tr_0123456789abcdef';
    const r = await w.bus.op('handoff', { request_id: 'req-trace-0001', to: { provider: 'claude' }, title: 'SECRET-TITLE', brief: 'SECRET-BRIEF at /Users/someone/x', provider: 'claude' },
      { provider: 'claude', cwd: w.root, origin: ORIGIN, trace: { trace_id: TRACE, from_handle: ORIGIN.handle } });
    w.engine.end((await w.until(() => w.taskOf(r.handoff_id))).id);
    await w.until(() => w.bus.log.result(r.handoff_id));
    await w.bus.op('wait', { handoff_id: r.handoff_id, timeout_s: 0 }, { provider: 'claude', cwd: w.root });
    await w.bus.trace.flush();
    const text = fs.readFileSync(`${w.dir}/bus-trace.jsonl`, 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    const mine = lines.filter((l) => l.trace_id === TRACE).map((l) => l.op);
    assert.deepEqual(mine, ['handoff', 'claim', 'start', 'result', 'returned']);
    assert.ok(lines.some((l) => l.op === 'wait' && l.ref === r.handoff_id));
    const h = lines.find((l) => l.trace_id === TRACE && l.op === 'handoff');
    assert.deepEqual([h.from_handle, h.to, h.provider, h.result, h.ref], [ORIGIN.handle, 'claude', 'claude', 'ok', r.handoff_id]);
    assert.match(h.repo_key_hash, /^[0-9a-f]{16}$/);
    for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ['from_handle', 'ms', 'op', 'provider', 'reason', 'ref', 'repo_key_hash', 'result', 'span', 't', 'to', 'trace_id']);
    for (const bit of ['SECRET', 'Parser fixed', '/Users/', w.root, 'Job ']) assert.ok(!text.includes(bit), `trace has ${bit}`);
    assert.doesNotMatch(text, /"(?:\/|~\/)[^"]*"/, 'no absolute path anywhere');
  } finally { w.cleanup(); }
});

