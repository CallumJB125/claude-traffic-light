// The local agent bus (board/AGENT-BUS.md), inside the tasks utilityProcess:
// ops from main's /bus relay and from runs' task tools → guard → bus.db →
// dispatcher → engine.createTask(source 'bus') in-process → the run's end
// becomes the handoff's result. No dialog, folder picker or prompt is on this
// path: a refusal is a {reason}. Electron main never loads this module.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openBusLog, DEAD_AFTER } from './local-log.js';
import { admit, strictSettings, dayOf } from './guard.js';
import { runCost } from './pricing.js';
import { BUS_VERSION, Envelope, HelloArgs, HandoffArgs, ReadArgs, WaitArgs, StatusArgs, RunHandoffArgs, ResultArgs, LIMITS, issue } from '../../shared/bus-schema.js';
import { redactSecrets } from '../../shared/secret-patterns.mjs';
import { cleanPacketText } from '../../shared/packet-text.js';
import { normalizeRemoteUrl } from '../../shared/scope.js';
import untrustedFrame from '../../shared/untrusted-frame.cjs';

const { frame } = untrustedFrame;
const HOUR_MS = 60 * 60 * 1000;
const LEASE_MS = 120_000;
const RENEW_MS = 30_000;
const PUMP_MS = 15_000;
const DEFAULT_TTL_S = 24 * 60 * 60;
const ACTIVE = new Set(['queued', 'claimed', 'running', 'quiet', 'blocked', 'handing_over', 'handed_over', 'suspended', 'unresponsive']);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class BusRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Run-originated text (results, onward handoffs) never passes main's scrubber: it is scrubbed here, then truncated. */
export function scrubRun(text, max, root = null) {
  if (typeof text !== 'string' || !text) return '';
  const s = redactSecrets(text.slice(0, max * 2));
  return cleanPacketText(s, s.length, root, { anyPath: false }).slice(0, max);
}

/**
 * engine: {createTask, act, tasks, on/off('event'), git, busPolicy(), busRepoAllowed(top)}.
 * Returns {op(op, args, caller), runTool(task, name, args), context, close()}.
 */
export function createAgentBus({ engine, dataDir, now = Date.now, log: logger }) {
  const log = openBusLog(path.join(dataDir, 'bus.db'), { now });
  const deviceId = log.state('device_id') ?? (() => { const id = crypto.randomBytes(8).toString('hex'); log.setState('device_id', id); return id; })();
  // ready: main has pushed its Preferences (busSetContext) since this helper started. Until then nothing
  // starts, so a reopened claim or a queued offer never runs on defaults or misses a Preferences-ticked repo.
  const context = { ready: false, settings: null, repos: [], folders: [], self: null };
  const halting = new Set(); // task ids being stopped by a halt mid-start: their end posts no result
  const waiters = new Map(); // handoff_id → Set(resolve)
  const failures = new Map(); // offset → tries
  let pumping = null, closed = false;

  const settings = () => strictSettings(engine.busPolicy().bus, context.settings);
  // Halted, turned off in Preferences or policy.json, or Preferences not received yet: nothing new starts.
  const stopped = () => !context.ready || log.state('halted', false) || !settings().enabled;
  const agentFor = (provider, repoRoot) => `${provider}:local:${sha(`${deviceId}\n${provider}\n${repoRoot}`).slice(0, 16)}`;
  const runAgent = (task) => `${task.ai.id}:run:${task.id.replace(/^tsk_/, '')}`;
  // Hop inheritance is keyed on what the caller cannot choose: this Mac and the repo of its working folder.
  const hopDomain = async (caller) => `local:${sha(`${deviceId}\n${(await gitTop(caller?.cwd)) ?? caller?.cwd ?? ''}`).slice(0, 16)}`;

  function envelope({ topic, kind, handoff, source, to = null, body = null, data = null, request_id = null, hop, visited, caused_by = null, ttlS = null }) {
    const at = now();
    const ev = {
      v: BUS_VERSION, request_id, topic, scope: 'local', org_id: null, board_id: null, card_id: handoff?.card_id ?? null,
      repo: handoff?.repo ?? null, source: source ?? handoff.source, to: to ?? handoff?.to ?? null, kind, handoff_id: handoff?.handoff_id ?? null,
      body, data, hop: hop ?? handoff?.hop ?? 0, visited: visited ?? handoff?.visited ?? [], caused_by: caused_by ?? handoff?.caused_by ?? null,
      created_at: at, expires_at: at + (ttlS ?? DEFAULT_TTL_S) * 1000, grants_execution: false, approval: false,
    };
    const v = Envelope.safeParse({ ...ev, id: 'evt_0000000000000000', offset: 0 });
    if (!v.success) throw new Error(`bus envelope: ${issue(v)}`);
    return ev;
  }
  const append = (ev, keys) => log.append(ev, keys);
  const systemSource = { device_id: deviceId, agent_id: 'bus:local:dispatcher', provider: 'bus', tier: 'person', identity_source: 'local_token' };

  async function gitTop(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
    const top = await engine.git(dir, ['rev-parse', '--show-toplevel']).then((s) => s.trim(), () => null);
    if (!top) return null;
    try { return await fs.promises.realpath(top); } catch { return null; }
  }

  // Repos map only from policy keys, the Preferences opt-in list and folders the user already registered
  // as task folders; never a picker. Returns {root} or a refusal.
  async function resolveRepo(target) {
    let top = null;
    if (typeof target === 'string' && path.isAbsolute(target)) top = await gitTop(target);
    else if (typeof target === 'string') {
      const want = normalizeRemoteUrl(target) ?? target;
      const known = [...context.folders, ...context.repos, ...Object.keys(engine.busPolicy().repos)].filter((p) => path.isAbsolute(p));
      for (const dir of new Set(known)) {
        const t = await gitTop(dir);
        const url = t ? await engine.git(t, ['config', '--get', 'remote.origin.url']).then((x) => x.trim(), () => null) : null;
        if (url && normalizeRemoteUrl(url) === want) { top = t; break; }
      }
    }
    if (!top) return { reason: 'NO_LOCAL_CHECKOUT', message: 'No registered checkout of that repository on this Mac.' };
    if (!(await engine.busRepoAllowed(top))) return { reason: 'NO_ELIGIBLE_AGENT', message: 'The agent bus is not turned on for this repository on this Mac.' };
    return { root: top };
  }

  function stateOf(handoffId) {
    const r = log.result(handoffId);
    if (r) return r.kind.slice('result.'.length);
    const c = log.claimOf(handoffId);
    return c ? (c.state === 'started' ? 'running' : c.state) : 'offered';
  }

  // Post a handoff after admission. h: {request_id, requestKey, source, to, card_id, repoRoot, hop, visited, caused_by, title, brief, files, branch, budget_usd, ttl_s}
  function post(h) {
    const prior = log.byRequest(h.requestKey);
    if (prior) return { handoff_id: prior.handoff_id, state: stateOf(prior.handoff_id), duplicate: true };
    const dedupeKey = sha(`${h.card_id ?? h.repoRoot}\n${h.title}\n${h.brief}`);
    const dup = log.byDedupe(dedupeKey, now() - HOUR_MS);
    if (dup) return { handoff_id: dup.handoff_id, state: stateOf(dup.handoff_id), duplicate: true };
    const s = settings();
    const reservation = s.caps.enabled ? h.budget_usd ?? s.caps.handoff_usd : 0;
    const handoff = { handoff_id: `hof_${crypto.randomBytes(8).toString('hex')}`, card_id: h.card_id ?? null, repo: { root: h.repoRoot }, source: h.source,
      to: h.to, hop: h.hop, visited: h.visited, caused_by: h.caused_by ?? null };
    const refusal = admit({ ...h, scope: h.scope ?? 'local', reservation }, { log, settings: s, now, self: context.self });
    if (refusal) {
      append(envelope({ topic: 'handoff', kind: 'handoff.refused', handoff, request_id: h.request_id, data: { reason: refusal.reason, title: h.title } }));
      return refusal;
    }
    const ev = envelope({ topic: 'handoff', kind: 'handoff.offer', handoff, request_id: h.request_id, ttlS: h.ttl_s, body: h.brief || null,
      data: { title: h.title, files: h.files ?? [], branch: h.branch ?? null, requires: { provider: h.to.provider }, budget_usd: h.budget_usd ?? null, reservation } });
    append(ev, { requestKey: h.requestKey, dedupeKey });
    if (reservation) log.reserve(dayOf(now()), reservation);
    setImmediate(pump);
    return { handoff_id: handoff.handoff_id, state: 'offered', hop: h.hop };
  }

  function taskText(ev) {
    const d = ev.data;
    const body = [d.title, ev.body, d.files.length ? `Files: ${d.files.join(', ')}` : '', d.branch ? `Branch: ${d.branch}` : ''].filter(Boolean).join('\n\n');
    const who = { kind: 'session', name: ev.source.tier === 'run_capability' ? 'A Plexiform run' : 'This Mac', provider: ev.source.provider };
    return frame({ kind: 'handoff', source: who, card_id: ev.card_id, body }, crypto.randomBytes(9).toString('hex'));
  }

  // Claim → engine.createTask. Exactly one start per handoff: the claim CAS hands out one fence.
  async function dispatch(ev) {
    if (stopped()) return;
    const claim = log.claim(ev.handoff_id, deviceId, LEASE_MS);
    if (!claim) return;
    log.setClaim(ev.handoff_id, claim.fence, { reserved_usd: ev.data.reservation ?? 0 });
    append(envelope({ topic: 'claim', kind: 'claim.granted', handoff: ev, source: systemSource, data: { fence: claim.fence } }));
    // Everything after the claim is inside the try: a granted claim always ends in a start or a result.
    try {
      const s = settings();
      const provider = ev.to.provider;
      const spec = {
        text: taskText(ev), title: ev.data.title.slice(0, 120), cwd: ev.repo.root, ai: provider, surface: 'background', permissionLevel: 'auto-edits', planFirst: false,
        source: 'bus', sourceMeta: { displayName: 'Agent bus', handoffId: ev.handoff_id, fence: claim.fence, originTier: ev.source.tier, scope: 'local', ...(ev.card_id ? { cardId: ev.card_id } : {}) },
        wallClockMs: s.wall_clock_min * 60_000,
        ...(provider === 'claude' && (s.caps.enabled || ev.data.budget_usd != null) ? { budgetUsd: ev.data.budget_usd ?? (ev.data.reservation || s.caps.handoff_usd) } : {}),
      };
      const { id } = await engine.createTask({ requestId: `bus-${ev.handoff_id}-${claim.fence}`, spec });
      if (closed) return;
      log.setClaim(ev.handoff_id, claim.fence, { state: 'started', task_id: id, lease_until: now() + LEASE_MS });
      append(envelope({ topic: 'claim', kind: 'claim.started', handoff: ev, source: systemSource, data: { fence: claim.fence, task_id: id } }));
      // Halted while it was starting: stop the run (its end posts no result), then release the claim so the
      // handoff starts again on resume. A stop that fails leaves a run that may still be going: lost, never rerun.
      if (stopped()) {
        halting.add(id);
        const ok = await engine.act({ id, action: 'stop', requestId: `bus-halt-${id}-${now()}` }).then(() => true, () => false);
        halting.delete(id);
        if (closed) return;
        if (ok) {
          log.setClaim(ev.handoff_id, claim.fence, { state: 'reopened', task_id: null });
          append(envelope({ topic: 'claim', kind: 'claim.released', handoff: ev, source: systemSource, data: { fence: claim.fence } }));
        } else {
          append(envelope({ topic: 'claim', kind: 'claim.lost', handoff: ev, source: systemSource, data: { fence: claim.fence } }));
          finish(ev, claim.fence, 'outcome_unknown', { summary: 'The agent bus was stopped while this run started, and the run could not be stopped. It is not retried.', cost_usd: 0, cost_basis: 'estimated', task_id: id });
        }
        return;
      }
      const t = engine.tasks.get(id);
      if (t && !ACTIVE.has(t.state)) onTaskState(t);
    } catch (e) {
      // Shutting down mid-start: the claim stays granted and reopens on the next start (recover()).
      if (closed) return;
      const code = typeof e?.details?.reason === 'string' ? e.details.reason : typeof e?.code === 'string' ? e.code : 'INTERNAL';
      log.setClaim(ev.handoff_id, claim.fence, { state: 'released' });
      append(envelope({ topic: 'claim', kind: 'claim.denied', handoff: ev, source: systemSource, data: { fence: claim.fence, reason: code } }));
      finish(ev, claim.fence, 'failed', { summary: `Not started: ${scrubRun(e?.message ?? 'the run could not start', 300)}`, cost_usd: 0, cost_basis: 'native' });
    }
  }

  function finish(ev, fence, outcome, { summary, evidence = [], cost_usd, cost_basis, branch = null, task_id = null }) {
    if (log.result(ev.handoff_id)?.data?.fence === fence) return;
    const c = log.claimOf(ev.handoff_id);
    if (c && c.fence !== fence) return; // a stale fence's result is refused
    // Settled against the day it was reserved, so a run that crosses midnight strands nothing.
    log.settle(dayOf(ev.created_at), c?.reserved_usd ?? ev.data.reservation ?? 0, cost_usd);
    log.setClaim(ev.handoff_id, fence, { state: outcome === 'outcome_unknown' ? 'lost' : 'done' });
    const r = append(envelope({ topic: 'result', kind: `result.${outcome}`, handoff: ev, source: systemSource,
      data: { fence, summary, evidence, cost_usd, cost_basis, branch, task_id } }));
    for (const w of waiters.get(ev.handoff_id) ?? []) w(r);
    waiters.delete(ev.handoff_id);
    setImmediate(pump);
  }

  // A bus task reached an end state: its handoff gets one result.
  function onTaskState(task) {
    if (task.source !== 'bus' || !task.sourceMeta?.handoffId) return;
    const outcome = task.state === 'in_review' || (task.state === 'done' && task.outcome !== 'discarded') ? 'done'
      : task.state === 'failed' || task.state === 'done' || (task.state === 'parked' && task.parkReason !== 'user') ? 'failed' : null;
    if (!outcome) return;
    const ev = log.handoff(task.sourceMeta.handoffId);
    if (!ev) return;
    const c = log.claimOf(ev.handoff_id);
    if (c?.task_id !== task.id || halting.has(task.id)) return; // a run halted mid-start reports nothing
    let report = null;
    try { report = c?.report ? JSON.parse(c.report) : null; } catch { report = null; }
    const own = outcome === 'done' ? task.evidence?.summary ?? task.lastAssistant ?? 'Done.' : task.failReason ?? task.parkReason ?? 'The run stopped.';
    finish(ev, task.sourceMeta.fence, report?.outcome === 'failed' ? 'failed' : outcome, {
      summary: report?.summary ?? scrubRun(own, LIMITS.summary, task.worktree), evidence: report?.evidence ?? [],
      ...runCost(task), branch: task.branch, task_id: task.id,
    });
  }
  const onEvent = (e) => { if (e.type === 'state') { const t = engine.tasks.get(e.taskId); if (t) onTaskState(t); } };
  engine.on('event', onEvent);

  // An offer that expired before it started: one result, and its reservation is released.
  function expire(ev) {
    if (log.result(ev.handoff_id)) return;
    finish(ev, log.claimOf(ev.handoff_id)?.fence ?? 0, 'expired', { summary: 'Expired before it started.', cost_usd: 0, cost_basis: 'native' });
  }

  // The dispatcher's own consumer over the handoff topic (local-log cursor): in order, at-least-once,
  // a row that keeps failing is dead-lettered. max_parallel bus runs at a time; halted or turned off means
  // nothing new starts (checked before every start, and again inside dispatch).
  async function pump() {
    if (closed) return;
    if (pumping) { pumping.again = true; return; }
    pumping = { again: false };
    const full = () => [...engine.tasks.values()].filter((t) => t.source === 'bus' && ACTIVE.has(t.state)).length >= settings().max_parallel;
    try {
      do {
        pumping.again = false;
        // Expiry runs whatever the switch: an offer that can no longer start releases its reservation now.
        for (const ev of log.expiredOpen(now())) expire(ev);
        if (stopped()) break;
        // Claims reopened by a restart or a halt mid-start: the cursor is already past their offers.
        let busy = false;
        for (const c of log.reopenedClaims()) {
          if (closed) return;
          const ev = log.handoff(c.handoff_id);
          if (!ev) continue;
          if (ev.expires_at <= now()) { expire(ev); continue; }
          if (stopped() || full()) { busy = true; break; }
          await dispatch(ev).catch((e) => logger?.warn?.('bus dispatch failed', { code: e?.code ?? null }));
        }
        if (busy) break;
        let from = log.offsetOf('dispatcher', 'handoff', { fromHead: false });
        for (const ev of log.read({ topics: ['handoff'], after: from, limit: 50 })) {
          if (closed) return;
          if (stopped()) break;
          const open = ev.kind === 'handoff.offer' && [undefined, 'reopened'].includes(log.claimOf(ev.handoff_id)?.state);
          if (open && ev.expires_at <= now()) expire(ev);
          else if (open) {
            if (full()) break;
            try { await dispatch(ev); } catch (e) {
              const n = (failures.get(ev.offset) ?? 0) + 1;
              failures.set(ev.offset, n);
              logger?.warn?.('bus dispatch failed', { code: e?.code ?? null });
              if (n < DEAD_AFTER) break;
              log.deadLetter(ev.offset, 'dispatcher', e?.code ?? 'error');
              failures.delete(ev.offset);
              if (!log.result(ev.handoff_id)) finish(ev, log.claimOf(ev.handoff_id)?.fence ?? 0, 'failed', { summary: 'Not started: the agent bus could not start this handoff.', cost_usd: 0, cost_basis: 'native' });
            }
          }
          if (closed) return;
          log.advance('dispatcher', 'handoff', ev.offset);
          from = ev.offset;
        }
      } while (pumping.again && !closed);
    } finally { pumping = null; }
  }

  // Leases: renewed while the run lives. After a restart a granted claim with no task reopens; a started
  // one whose run is gone becomes outcome_unknown (never retried automatically).
  function recover() {
    for (const c of log.openClaims()) {
      const ev = log.handoff(c.handoff_id);
      if (!ev) continue;
      const t = c.task_id ? engine.tasks.get(c.task_id) : null;
      if (c.state === 'granted' && !t) {
        // Reopened only: pump() starts it again, and pump honours halt and the off switch.
        log.setClaim(c.handoff_id, c.fence, { state: 'reopened' });
        append(envelope({ topic: 'claim', kind: 'claim.released', handoff: ev, source: systemSource, data: { fence: c.fence } }));
        continue;
      }
      if (t && ACTIVE.has(t.state)) continue;
      if (t) { onTaskState(t); if (log.result(c.handoff_id)) continue; }
      append(envelope({ topic: 'claim', kind: 'claim.lost', handoff: ev, source: systemSource, data: { fence: c.fence } }));
      finish(ev, c.fence, 'outcome_unknown', { summary: 'The run ended without a known outcome (Plexiform restarted). It is not retried.', cost_usd: 0, cost_basis: 'estimated', task_id: c.task_id });
    }
  }
  recover();
  const renew = setInterval(() => {
    for (const c of log.openClaims()) if (c.state === 'started' && ACTIVE.has(engine.tasks.get(c.task_id)?.state)) log.setClaim(c.handoff_id, c.fence, { lease_until: now() + LEASE_MS });
  }, RENEW_MS);
  const tick = setInterval(() => { pump(); }, PUMP_MS);
  const sweep = setInterval(() => { try { log.sweep(); } catch { /* next time */ } }, HOUR_MS);
  for (const t of [renew, tick, sweep]) t.unref?.();
  setImmediate(pump);

  // ── ops ────────────────────────────────────────────────────────────────────
  const parse = (S, a) => { const r = S.safeParse(a ?? {}); if (!r.success) throw new BusRefusal('VALIDATION', issue(r)); return r.data; };
  const callerProvider = (args, caller) => args.provider ?? caller?.provider ?? 'agent';
  const consume = (domain, events) => { const hop = Math.max(0, ...events.map((e) => e.hop ?? 0)); if (hop) log.consumed(domain, hop, now() - HOUR_MS); };
  function view(ev) {
    const text = ev.topic === 'result' ? ev.data?.summary : ev.body;
    return { offset: ev.offset, topic: ev.topic, kind: ev.kind, handoff_id: ev.handoff_id, card_id: ev.card_id, hop: ev.hop, at: ev.created_at,
      from: { provider: ev.source.provider, tier: ev.source.tier }, title: ev.data?.title ?? null,
      ...(ev.topic === 'result' ? { cost_usd: ev.data.cost_usd, cost_basis: ev.data.cost_basis, branch: ev.data.branch } : {}),
      text: text ? frame({ kind: ev.topic === 'result' ? 'message' : 'handoff', source: { kind: 'session', name: ev.topic === 'result' ? 'A Plexiform run' : 'This Mac', provider: ev.source.provider }, card_id: ev.card_id, body: text }) : null };
  }

  async function op(name, rawArgs = {}, caller = null) {
    if (closed) throw new BusRefusal('INTERNAL', 'the agent bus is closed');
    const s = settings();
    switch (name) {
      case 'hello': {
        const a = parse(HelloArgs, rawArgs);
        const top = await gitTop(caller?.cwd);
        return { agent_id: agentFor(a.provider, top ?? caller?.cwd ?? ''), tier: 'local_attested', scope_allowed: ['local'],
          policy_summary: { enabled: s.enabled, halted: log.state('halted', false), repo_enabled: top ? await engine.busRepoAllowed(top) : false,
            max_hops: s.max_hops, wall_clock_min: s.wall_clock_min, caps_enabled: s.caps.enabled, auto_accept: s.auto_accept } };
      }
      case 'handoff': {
        const a = parse(HandoffArgs, rawArgs);
        // Halted comes first: a stopped bus says so before anything about the repository.
        const repo = log.state('halted', false) ? { reason: 'HALTED', message: 'The agent bus is stopped on this Mac. Your person can resume it from the tray or Sessions.' }
          : await resolveRepo(a.repo ?? caller?.cwd);
        const provider = callerProvider(a, caller);
        if (repo.reason) {
          const agent_id = agentFor(provider, caller?.cwd ?? '');
          append(envelope({ topic: 'handoff', kind: 'handoff.refused', request_id: a.request_id, data: { reason: repo.reason, title: a.title },
            handoff: { handoff_id: null, card_id: a.card_id ?? null, repo: null, to: a.to, hop: 0, visited: [agent_id],
              source: { device_id: deviceId, agent_id, provider, tier: 'local_attested', identity_source: 'local_token' } } }));
          return repo;
        }
        const agent_id = agentFor(provider, repo.root);
        return post({ ...a, requestKey: `${agent_id}|${a.request_id}`, repoRoot: repo.root, brief: a.brief ?? '',
          source: { device_id: deviceId, agent_id, provider, tier: 'local_attested', identity_source: 'local_token' },
          hop: log.hopOf(await hopDomain(caller), now() - HOUR_MS) + 1, visited: [agent_id] });
      }
      case 'read': {
        const a = parse(ReadArgs, rawArgs);
        const rows = log.read({ topics: [a.topic], after: a.after_offset ?? 0, limit: a.limit ?? 20, cardId: a.card_id ?? null });
        const events = rows.filter((e) => e.kind === 'handoff.offer' || e.topic === 'result');
        consume(await hopDomain(caller), events);
        return { events: events.map(view), next_offset: rows.at(-1)?.offset ?? a.after_offset ?? 0 };
      }
      case 'wait': {
        const a = parse(WaitArgs, rawArgs);
        if (!log.handoff(a.handoff_id)) return { reason: 'NOT_FOUND', message: 'No such handoff.' };
        let r = log.result(a.handoff_id);
        if (!r && (a.timeout_s ?? 60) > 0) {
          r = await new Promise((resolve) => {
            const set = waiters.get(a.handoff_id) ?? new Set();
            waiters.set(a.handoff_id, set);
            const done = (x) => { clearTimeout(t); set.delete(done); resolve(x); };
            const t = setTimeout(() => done(null), (a.timeout_s ?? 60) * 1000);
            set.add(done);
          });
        }
        if (!r) return { handoff_id: a.handoff_id, state: 'pending', detail: stateOf(a.handoff_id) };
        consume(await hopDomain(caller), [r]);
        return { handoff_id: a.handoff_id, state: r.kind.slice('result.'.length), result: view(r), task_id: r.data.task_id };
      }
      case 'status': {
        const a = parse(StatusArgs, rawArgs);
        if (!a.handoff_id) return { halted: log.state('halted', false), enabled: s.enabled, head: log.head() };
        const chain = log.chain(a.handoff_id);
        if (!chain.length) return { reason: 'NOT_FOUND', message: 'No such handoff.' };
        const c = log.claimOf(a.handoff_id);
        return { handoff_id: a.handoff_id, state: stateOf(a.handoff_id), fence: c?.fence ?? null, task_id: c?.task_id ?? null,
          chain: chain.map((e) => ({ offset: e.offset, kind: e.kind, at: e.created_at, ...(e.data?.reason ? { reason: e.data.reason } : {}) })) };
      }
      case 'list': {
        const day = log.spend(dayOf(now()));
        return { halted: log.state('halted', false), settings: s, spend_today: { reserved_usd: day.reserved, spent_usd: day.spent },
          events: log.recent(Math.min(200, Math.max(1, Number(rawArgs?.limit) || 100))).map((e) => ({ offset: e.offset, topic: e.topic, kind: e.kind,
            handoff_id: e.handoff_id, card_id: e.card_id, at: e.created_at, hop: e.hop, tier: e.source.tier, provider: e.source.provider,
            to: e.to?.provider ?? null, title: e.data?.title ?? null, reason: e.data?.reason ?? null, cost_usd: e.data?.cost_usd ?? null })) };
      }
      case 'busSetContext': {
        const a = rawArgs ?? {};
        if (a.settings && typeof a.settings === 'object') context.settings = a.settings;
        context.ready = true;
        const abs = (l) => (Array.isArray(l) ? l.filter((p) => typeof p === 'string' && p.length <= 1024).slice(0, 200) : null);
        context.repos = abs(a.repos) ?? context.repos;
        context.folders = abs(a.folders) ?? context.folders;
        if (a.self !== undefined) context.self = a.self && typeof a.self.userId === 'string' ? { userId: a.self.userId } : null;
        append(envelope({ topic: 'control', kind: 'control.policy_changed', handoff: null, source: systemSource, data: { repos: context.repos.length } }));
        setImmediate(pump);
        return { ok: true };
      }
      case 'halt': {
        log.setState('halted', true);
        append(envelope({ topic: 'control', kind: 'control.halt', handoff: null, source: systemSource }));
        const live = [...engine.tasks.values()].filter((t) => t.source === 'bus' && ACTIVE.has(t.state));
        await Promise.allSettled(live.map((t) => engine.act({ id: t.id, action: 'stop', requestId: `bus-halt-${t.id}-${now()}` })));
        return { ok: true, halted: true, stopped: live.length };
      }
      case 'resume': {
        log.setState('halted', false);
        append(envelope({ topic: 'control', kind: 'control.resume', handoff: null, source: systemSource }));
        setImmediate(pump);
        return { ok: true, halted: false };
      }
      default: throw new BusRefusal('VALIDATION', 'unknown bus op');
    }
  }

  // The run surface: bus_result and bus_handoff from a bus-started run's per-run MCP. Identity, hop,
  // visited and caused_by come from the run's own handoff; the caller can set none of them.
  function runTool(task, name, raw) {
    if (task.source !== 'bus' || !task.sourceMeta?.handoffId) throw new BusRefusal('POLICY_DENIED', 'Only runs the agent bus started can use bus tools.');
    const parent = log.handoff(task.sourceMeta.handoffId);
    const c = log.claimOf(task.sourceMeta.handoffId);
    if (!parent || !c || c.fence !== task.sourceMeta.fence || c.task_id !== task.id) throw new BusRefusal('POLICY_DENIED', 'This run no longer holds its handoff.');
    if (name === 'bus_result') {
      const a = parse(ResultArgs, raw);
      const prev = c.report ? JSON.parse(c.report) : null;
      if (prev && prev.request_id !== a.request_id) throw new BusRefusal('CONFLICT', 'A result was already reported for this run.');
      if (!prev) log.setClaim(parent.handoff_id, c.fence, { report: JSON.stringify({ request_id: a.request_id, outcome: a.outcome,
        summary: scrubRun(a.summary, LIMITS.summary, task.worktree), evidence: (a.evidence ?? []).map((x) => scrubRun(x, LIMITS.file, task.worktree)).filter(Boolean) }) });
      return { handoff_id: parent.handoff_id, state: 'recorded', note: 'Delivered to the requester when this run ends.' };
    }
    const a = parse(RunHandoffArgs, raw);
    const agent_id = runAgent(task);
    return post({ ...a, requestKey: `${agent_id}|${a.request_id}`, repoRoot: task.repo.root, card_id: a.card_id ?? parent.card_id ?? undefined,
      title: scrubRun(a.title, LIMITS.title, task.worktree) || 'Handoff', brief: scrubRun(a.brief ?? '', LIMITS.brief, task.worktree),
      files: (a.files ?? []).map((f) => scrubRun(f, LIMITS.file, task.worktree)).filter(Boolean), branch: a.branch ? scrubRun(a.branch, LIMITS.branch, task.worktree) : undefined,
      source: { device_id: deviceId, agent_id, provider: task.ai.id, tier: 'run_capability', identity_source: 'local_token' },
      hop: parent.hop + 1, visited: [...parent.visited, agent_id], caused_by: parent.handoff_id });
  }

  return {
    op, runTool, context, log,
    close() {
      if (closed) return;
      closed = true;
      engine.off('event', onEvent);
      for (const t of [renew, tick, sweep]) clearInterval(t);
      for (const set of waiters.values()) for (const w of set) w(null);
      waiters.clear();
      log.close();
    },
  };
}
