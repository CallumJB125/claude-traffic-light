// The local agent bus (board/AGENT-BUS.md), inside the tasks utilityProcess:
// ops from main's /bus relay and from runs' task tools → guard → bus.db →
// dispatcher → engine.createTask(source 'bus') in-process → the run's end
// becomes the handoff's result. No dialog, folder picker or prompt is on this
// path: a refusal is a {reason}. Electron main never loads this module.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openBusLog, DEAD_AFTER } from './local-log.js';
import { createNotes } from './notes.js';
import { createProviderHealth, reasonOf } from './provider-health.js';
import { machine } from '../../shared/brand.js';
import { admit, strictSettings, dayOf } from './guard.js';
import { runCost } from './pricing.js';
import { BUS_VERSION, Envelope, HelloArgs, HandoffArgs, ReadArgs, WaitArgs, StatusArgs, RunHandoffArgs, ResultArgs, LIMITS, issue } from '../../shared/bus-schema.js';
import { redactSecrets } from '../../shared/secret-patterns.mjs';
import { KIND_SENTENCE } from '../../shared/failure.js';
import { cleanPacketText } from '../../shared/packet-text.js';
import { normalizeRemoteUrl } from '../../shared/scope.js';
import untrustedFrame from '../../shared/untrusted-frame.cjs';
import { createRequire } from 'node:module';

const Contract = createRequire(import.meta.url)('../../../src/bus-contract.js');
const BusTrace = createRequire(import.meta.url)('../../../src/bus-trace.js');

const { frame, fold } = untrustedFrame;
const HOUR_MS = 60 * 60 * 1000;
const LEASE_MS = 120_000;
const RENEW_MS = 30_000;
const PUMP_MS = 15_000;
const DEFAULT_TTL_S = 24 * 60 * 60;
// Automatic mode: a repo a session called the bus from stays eligible this long, so an offer can still start after a restart.
const SESSION_REPO_MS = 2 * 24 * HOUR_MS;
const SESSION_REPO_MAX = 100;
const ACTIVE = new Set(['queued', 'claimed', 'running', 'quiet', 'blocked', 'handing_over', 'handed_over', 'suspended', 'unresponsive']);
const DEAD_END = new Set(['result.failed', 'result.expired', 'result.outcome_unknown']);
const AI_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const SESSION_KEY = /^(?:claude|codex|gemini)\|[\w.-]{1,120}$/;
const HANDLE = /^(?:claude|codex|gemini)-[a-z0-9-]{1,16}-[0-9a-f]{4,6}$/;
// Breaker reasons that mean the provider, not the task, failed: a run asked with 'any' or a list moves on (D4).
const MOVE_ON = new Set(['QUOTA', 'AUTH', 'MISSING']);
const BREAKER_WORDS = { QUOTA: 'is out of its usage quota', AUTH: 'needs its person to sign in again', MISSING: 'is not installed or not signed in', CRASH: 'kept failing to start' };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class BusRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// What the calling session is told about a run that did not finish. A reason the CLI produced is untrusted text
// (it can echo the worktree or a model): the caller gets the kind's fixed sentence. Reasons the engine wrote
// itself (stopped, budget, released) pass through.
const CLI_KINDS = new Set(['provider', 'network', 'error', 'limit']);
function failedText(task) {
  if (task.state === 'parked') return KIND_SENTENCE[task.parkReason] ?? 'The run stopped.';
  if (CLI_KINDS.has(task.failKind)) return KIND_SENTENCE[task.failKind];
  return task.failReason ?? 'The run stopped.';
}

/** Run-originated text (results, onward handoffs) never passes main's scrubber: it is folded and scrubbed here, then truncated. */
export function scrubRun(text, max, root = null) {
  if (typeof text !== 'string' || !text) return '';
  const s = redactSecrets(fold(text.slice(0, max * 2)));
  return cleanPacketText(s, s.length, root, { anyPath: false }).slice(0, max);
}

/**
 * engine: {createTask, act, tasks, on/off('event'), git, busPolicy(), busRepoAllowed(top)}.
 * Returns {op(op, args, caller), runTool(task, name, args), context, sessionRepo(top), close()}.
 */
export function createAgentBus({ engine, dataDir, now = Date.now, log: logger }) {
  const log = openBusLog(path.join(dataDir, 'bus.db'), { now });
  const deviceId = log.state('device_id') ?? (() => { const id = crypto.randomBytes(8).toString('hex'); log.setState('device_id', id); return id; })();
  // ready: main has pushed its Preferences (busSetContext) since this helper started. Until then nothing
  // starts, so a reopened claim or a queued offer never runs on defaults or misses a Preferences-ticked repo.
  // fallback (owner decision D4): 'any' and lists move to the next provider in order when one is unavailable.
  const context = { ready: false, settings: null, scope: 'auto', repos: [], exclude: [], folders: [], self: null, fallback: { enabled: true, order: [...Contract.DEFAULT_FALLBACK] } };
  const tops = new Map(); // dir → its git top, until main's next push (git runs once per folder per push)
  const commons = new Map(); // git top → its git-common-dir (shared by every linked worktree of one repository)
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
  // Notes (plan-agent-awareness §3.6): main's ops only; their events carry handles and states, never the text.
  const notes = createNotes({ log, now, halted: () => log.state('halted', false),
    record: (kind, data) => append(envelope({ topic: 'note', kind, handoff: null, source: systemSource, data })) });
  // The trace (src/bus-trace.js): this helper's half, same shape and trace_ids as main's. A hand-off's trace_id is
  // kept on its offer, so its claim, start, result and returned note are lines of the same collaboration.
  const trace = BusTrace.createTrace({ file: path.join(dataDir, 'bus-trace.jsonl'), now });
  const traceOf = (ev) => (Contract.isTraceId(ev?.data?.trace_id) ? ev.data.trace_id : undefined);
  const span = (ev, op, extra = {}) => trace.append({ trace_id: traceOf(ev), op, provider: ev?.to?.provider ?? null, repo_key_hash: BusTrace.repoKeyHash(ev?.repo?.root), ref: ev?.handoff_id ?? null, ...extra });
  const health = createProviderHealth({ log, now, onChange: (h) => {
    logger?.info?.('bus provider', { provider: h.provider, state: h.state, reason: h.reason });
    trace.append({ op: 'breaker', provider: h.provider, result: h.state === 'closed' ? 'ok' : 'refused', reason: h.reason ?? null });
  } });
  const unavailableRefusal = (u) => ({ reason: 'PROVIDER_UNAVAILABLE', provider: u.provider, retry_at: u.retry_at ?? null, provider_reason: u.reason ?? null,
    message: `${AI_NAME[u.provider] ?? 'That AI'} ${BREAKER_WORDS[u.reason] ?? 'cannot take work on this Mac now'}${u.retry_at ? `; Plexiform tries it again after ${new Date(u.retry_at).toISOString()}` : ''}. Ask for to.provider "any" to use the next AI in your person's order.` });

  async function gitTop(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
    if (tops.has(dir)) return tops.get(dir);
    const top = await engine.git(dir, ['rev-parse', '--show-toplevel']).then((s) => s.trim(), () => null);
    let real = null;
    if (top) try { real = await fs.promises.realpath(top); } catch { real = null; }
    if (tops.size >= 1000) tops.clear();
    tops.set(dir, real);
    return real;
  }

  // Automatic mode's restart cache: repos seen in main's session folders when a session called the bus
  // (root → last seen, fresh entries only). A caller's own word never puts a repo here.
  const sessionRoots = () => {
    const m = log.state('session_repos', {});
    const cut = now() - SESSION_REPO_MS;
    return Object.fromEntries(Object.entries(m && typeof m === 'object' && !Array.isArray(m) ? m : {}).filter(([, at]) => at > cut));
  };
  // Folders main observed itself (task folders, hook-reported Claude and Codex sessions): cheap path checks first.
  async function folderRepo(top) {
    for (const f of new Set(context.folders)) {
      if (!path.isAbsolute(f)) continue;
      let real;
      try { real = await fs.promises.realpath(f); } catch { continue; }
      if ((real === top || real.startsWith(`${top}${path.sep}`)) && (await gitTop(real)) === top) return true;
    }
    return false;
  }
  // Remembered only while the bus is on and running, for a repo main observed that the rule allows.
  async function rememberSession(top) {
    if (!top || !settings().enabled || log.state('halted', false) || !(await folderRepo(top)) || !(await engine.busRepoAllowed(top))) return;
    const kept = Object.entries(sessionRoots()).filter(([r]) => r !== top).sort((a, b) => b[1] - a[1]).slice(0, SESSION_REPO_MAX - 1);
    log.setState('session_repos', Object.fromEntries([[top, now()], ...kept]));
  }
  async function commonDir(top) {
    if (!top) return null;
    if (commons.has(top)) return commons.get(top);
    const c = await engine.git(top, ['rev-parse', '--git-common-dir']).then((x) => fs.promises.realpath(path.resolve(top, x.trim())), () => null);
    if (commons.size >= 1000) commons.clear();
    commons.set(top, c);
    return c;
  }
  // A live session in another linked worktree of the same repository (BACKBONE plan G3): a worktree made for the
  // work counts as the repository whose session made it.
  async function worktreeRepo(top) {
    const mine = await commonDir(top);
    if (!mine) return false;
    for (const f of new Set([...context.folders, ...Object.keys(sessionRoots())])) {
      if (!path.isAbsolute(f)) continue;
      let real;
      try { real = await fs.promises.realpath(f); } catch { continue; }
      const t = await gitTop(real);
      if (t && t !== top && (await commonDir(t)) === mine) return true;
    }
    return false;
  }
  /** Whether a live or recent Claude or Codex session on this Mac works in this checkout (automatic mode): true, 'worktree' (in another worktree of the same repository) or false. */
  async function sessionRepo(top) {
    if (!top) return false;
    if (sessionRoots()[top]) return true;
    if (await folderRepo(top)) return true;
    return (await worktreeRepo(top)) ? 'worktree' : false;
  }
  // repo_enabled with its reason (contract REPO_REASON); halted is reported apart, as before.
  // offIsReason: hello reports a bus turned off as the repo's reason; a hand-off leaves that to the guard (POLICY_DENIED).
  // unbound: set only by main's relay (agent-awareness) for a caller it could not bind; see engine.busRepoReason.
  async function repoVerdict(top, cwd = null, { offIsReason = false, unbound = false } = {}) {
    if (offIsReason && !settings().enabled) return { allowed: false, reason: 'BUS_OFF' };
    if (engine.busRepoReason) return engine.busRepoReason(top, undefined, { cwd, unbound });
    return top && (await engine.busRepoAllowed(top)) ? { allowed: true, why: null } : { allowed: false, reason: top ? 'NO_SESSION' : 'NOT_GIT' };
  }
  const repoRefusal = (reason) => ({ reason: reason === 'NOT_GIT' ? 'NO_LOCAL_CHECKOUT' : 'NO_ELIGIBLE_AGENT', repo_reason: reason, message: Contract.REPO_REASON_TEXT[reason] ?? 'The agent bus does not run in this repository on this Mac.' });

  // Repos map only from policy keys, the Preferences lists, folders main knows (task folders, live sessions)
  // and repos sessions called from; never a picker. Returns {root} or a refusal.
  async function resolveRepo(target, { unbound = false } = {}) {
    let top = null;
    if (typeof target === 'string' && path.isAbsolute(target)) top = await gitTop(target);
    else if (typeof target === 'string') {
      const want = normalizeRemoteUrl(target) ?? target;
      const known = [...context.folders, ...context.repos, ...Object.keys(sessionRoots()), ...Object.keys(engine.busPolicy().repos)].filter((p) => path.isAbsolute(p));
      for (const dir of new Set(known)) {
        const t = await gitTop(dir);
        const url = t ? await engine.git(t, ['config', '--get', 'remote.origin.url']).then((x) => x.trim(), () => null) : null;
        if (url && normalizeRemoteUrl(url) === want) { top = t; break; }
      }
    }
    if (!top) return typeof target === 'string' && path.isAbsolute(target) ? repoRefusal((await repoVerdict(null, target)).reason) : { reason: 'NO_LOCAL_CHECKOUT', message: 'No registered checkout of that repository on this Mac.' };
    const v = await repoVerdict(top, null, { unbound });
    if (!v.allowed) return repoRefusal(v.reason);
    return { root: top };
  }

  function stateOf(handoffId) {
    const r = log.result(handoffId);
    if (r) return r.kind.slice('result.'.length);
    const c = log.claimOf(handoffId);
    return c ? (c.state === 'started' ? 'running' : c.state) : 'offered';
  }

  // Post a handoff after admission. h: {request_id, requestKey, source, to, card_id, repoRoot, hop, visited, caused_by, title, brief, files, branch, budget_usd, ttl_s}
  function post(input) {
    let h = input;
    const prior = log.byRequest(h.requestKey);
    if (prior) return { handoff_id: prior.handoff_id, state: stateOf(prior.handoff_id), duplicate: true };
    // Content dedupe (same card or repo, title and brief, within the hour) is per requested target: asking another
    // provider, 'any' or a list is a new request. It joins a hand-off still under way or done (its result is the
    // answer); one that failed (stopped or cancelled included), expired or ended unknown is never handed back, so a
    // retry with a new request_id runs.
    const target = h.to?.agent_id ? `agent:${h.to.agent_id}` : JSON.stringify(h.to?.provider ?? Contract.ANY_PROVIDER);
    const dedupeKey = sha(`${h.card_id ?? h.repoRoot}\n${h.title}\n${h.brief}\n${target}${h.fallback_of ? `\n${h.fallback_of}` : ''}`);
    const dup = h.fallback_of ? null : log.byDedupe(dedupeKey, now() - HOUR_MS);
    if (dup && !DEAD_END.has(log.result(dup.handoff_id)?.kind)) return { handoff_id: dup.handoff_id, state: stateOf(dup.handoff_id), duplicate: true };
    // One provider before the offer is written (G4): a named one only if its breaker admits it; 'any' or a list, the
    // first that does, and the rest kept for a fallback.
    let rest = [];
    const want = h.to?.provider ?? (h.to?.agent_id ? null : Contract.ANY_PROVIDER);
    // A single provider that cannot take bus runs at all (Gemini today) is the guard's NO_ELIGIBLE_AGENT, not an outage.
    if (want != null && !(typeof want === 'string' && want !== Contract.ANY_PROVIDER && !Contract.RECEIVE_PROVIDERS.includes(want))) {
      const pick = health.choose(want, { order: context.fallback.order, fallback: context.fallback.enabled });
      if (pick.unavailable) {
        const r = unavailableRefusal(pick.unavailable);
        append(envelope({ topic: 'handoff', kind: 'handoff.refused', request_id: h.request_id, data: { reason: r.reason, title: h.title, provider: r.provider },
          handoff: { handoff_id: null, card_id: h.card_id ?? null, repo: { root: h.repoRoot }, source: h.source, to: { provider: r.provider ?? undefined }, hop: h.hop, visited: h.visited, caused_by: h.caused_by ?? null } }));
        return r;
      }
      h = { ...h, to: { ...h.to, provider: pick.provider } };
      rest = pick.rest;
    }
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
      data: { title: h.title, files: h.files ?? [], branch: h.branch ?? null, requires: { provider: h.to.provider }, budget_usd: h.budget_usd ?? null, reservation, ...(h.after_note ? { after_note: true } : {}),
        ...(rest.length ? { fallback: rest } : {}), ...(h.origin ? { origin: h.origin } : {}), ...(h.fallback_of ? { fallback_of: h.fallback_of } : {}),
        ...(Contract.isTraceId(h.trace_id) ? { trace_id: h.trace_id } : {}) } });
    append(ev, { requestKey: h.requestKey, dedupeKey });
    if (reservation) log.reserve(dayOf(now()), reservation);
    setImmediate(pump);
    return { handoff_id: handoff.handoff_id, state: 'offered', hop: h.hop, provider: h.to.provider ?? null, ...(h.fallback_of ? { fallback_of: h.fallback_of } : {}) };
  }

  function taskText(ev) {
    const d = ev.data;
    const body = [d.title, ev.body, d.files.length ? `Files: ${d.files.join(', ')}` : '', d.branch ? `Branch: ${d.branch}` : ''].filter(Boolean).join('\n\n');
    const who = { kind: 'session', name: ev.source.tier === 'run_capability' ? 'A Plexiform run' : `This ${machine()}`, provider: ev.source.provider };
    return frame({ kind: 'handoff', source: who, card_id: ev.card_id, body, afterNote: d.after_note === true }, crypto.randomBytes(9).toString('hex'));
  }

  // Claim → engine.createTask. Exactly one start per handoff: the claim CAS hands out one fence.
  async function dispatch(ev) {
    if (stopped()) return;
    const claim = log.claim(ev.handoff_id, deviceId, LEASE_MS);
    if (!claim) return;
    log.setClaim(ev.handoff_id, claim.fence, { reserved_usd: ev.data.reservation ?? 0 });
    append(envelope({ topic: 'claim', kind: 'claim.granted', handoff: ev, source: systemSource, data: { fence: claim.fence } }));
    span(ev, 'claim', { result: 'ok' });
    // Everything after the claim is inside the try: a granted claim always ends in a start or a result.
    try {
      const s = settings();
      const provider = ev.to.provider;
      // Its breaker opened after the offer was written (another run hit the quota): no start, and 'any' moves on.
      if (!health.admits(provider)) {
        const h = health.get(provider);
        log.setClaim(ev.handoff_id, claim.fence, { state: 'released' });
        append(envelope({ topic: 'claim', kind: 'claim.denied', handoff: ev, source: systemSource, data: { fence: claim.fence, reason: 'PROVIDER_UNAVAILABLE' } }));
        finish(ev, claim.fence, 'failed', { summary: `Not started: ${unavailableRefusal(h ?? { provider }).message}`, cost_usd: 0, cost_basis: 'native', providerReason: h?.reason ?? null });
        return;
      }
      const spec = {
        text: taskText(ev), title: ev.data.title.slice(0, 120), cwd: ev.repo.root, ai: provider, surface: 'background', permissionLevel: 'auto-edits', planFirst: false,
        source: 'bus', sourceMeta: { displayName: 'Agent bus', handoffId: ev.handoff_id, fence: claim.fence, originTier: ev.source.tier, scope: 'local', ...(ev.card_id ? { cardId: ev.card_id } : {}),
          // G8 rule 2: the run's work inherits the asker's board (work-capture routeBoard inherited).
          ...(ev.data?.origin?.board ? { originBoard: ev.data.origin.board } : {}) },
        wallClockMs: s.wall_clock_min * 60_000,
        ...(provider === 'claude' && (s.caps.enabled || ev.data.budget_usd != null) ? { budgetUsd: ev.data.budget_usd ?? (ev.data.reservation || s.caps.handoff_usd) } : {}),
      };
      const { id } = await engine.createTask({ requestId: `bus-${ev.handoff_id}-${claim.fence}`, spec });
      if (closed) return;
      log.setClaim(ev.handoff_id, claim.fence, { state: 'started', task_id: id, lease_until: now() + LEASE_MS });
      append(envelope({ topic: 'claim', kind: 'claim.started', handoff: ev, source: systemSource, data: { fence: claim.fence, task_id: id } }));
      span(ev, 'start', { result: 'ok' });
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
      const providerReason = reasonOf({ code: e?.code ?? null });
      if (providerReason) health.failed(ev.to.provider, providerReason);
      log.setClaim(ev.handoff_id, claim.fence, { state: 'released' });
      append(envelope({ topic: 'claim', kind: 'claim.denied', handoff: ev, source: systemSource, data: { fence: claim.fence, reason: code } }));
      finish(ev, claim.fence, 'failed', { summary: `Not started: ${scrubRun(e?.message ?? 'the run could not start', 300)}`, cost_usd: 0, cost_basis: 'native', providerReason });
    }
  }

  function finish(ev, fence, outcome, { summary, evidence = [], cost_usd, cost_basis, branch = null, task_id = null, provider = null, providerReason = null }) {
    if (log.result(ev.handoff_id)?.data?.fence === fence) return;
    const c = log.claimOf(ev.handoff_id);
    if (c && c.fence !== fence) return; // a stale fence's result is refused
    // Settled against the day it was reserved, so a run that crosses midnight strands nothing.
    log.settle(dayOf(ev.created_at), c?.reserved_usd ?? ev.data.reservation ?? 0, cost_usd);
    log.setClaim(ev.handoff_id, fence, { state: outcome === 'outcome_unknown' ? 'lost' : 'done' });
    const next = outcome === 'failed' ? fallbackFor(ev, providerReason) : null;
    const r = append(envelope({ topic: 'result', kind: `result.${outcome}`, handoff: ev, source: systemSource,
      data: { fence, summary, evidence, cost_usd, cost_basis, branch, task_id, provider: provider ?? ev.to?.provider ?? null,
        // The provider, not the task, failed: the contract's PROVIDER_UNAVAILABLE with the breaker's retry_at.
        ...(providerReason ? { reason: Contract.BUS_REASON.PROVIDER_UNAVAILABLE, provider_reason: providerReason, retry_at: health.get(provider ?? ev.to?.provider)?.retry_at ?? null } : {}),
        ...(next?.handoff_id ? { fallback: { handoff_id: next.handoff_id, provider: next.provider } } : {}) } }));
    for (const w of waiters.get(ev.handoff_id) ?? []) w(r);
    waiters.delete(ev.handoff_id);
    span(ev, 'result', { provider: provider ?? ev.to?.provider ?? null, result: outcome === 'done' ? 'ok' : outcome === 'failed' ? 'error' : 'deferred',
      reason: providerReason ? Contract.BUS_REASON.PROVIDER_UNAVAILABLE : outcome === 'done' ? null : outcome.toUpperCase() });
    returnResult(ev, outcome, { summary, provider: provider ?? ev.to?.provider ?? null, next, providerReason });
    setImmediate(pump);
  }

  // D4: a hand-off asked with 'any' or a list whose provider failed for a provider reason goes to the next one in
  // order, once per provider, within the same caps (post() reserves and admits it like any offer). Same hop: it is the
  // same work, not an onward hand-off. Nothing moves on while halted or off.
  function fallbackFor(ev, providerReason) {
    if (!providerReason || !MOVE_ON.has(providerReason) && health.admits(ev.to?.provider)) return null;
    const rest = Array.isArray(ev.data?.fallback) ? ev.data.fallback.filter((p) => p !== ev.to?.provider) : [];
    if (!rest.length || !context.fallback.enabled || log.state('halted', false) || !settings().enabled) return null;
    const left = Math.floor((ev.expires_at - now()) / 1000);
    if (left < 60) return null;
    try {
      const r = post({ request_id: `fb-${ev.handoff_id.slice(4)}`, requestKey: `${ev.source.agent_id}|fb|${ev.handoff_id}`, source: ev.source, to: { provider: rest },
        card_id: ev.card_id ?? undefined, repoRoot: ev.repo?.root, hop: ev.hop, visited: ev.visited, caused_by: ev.handoff_id, title: ev.data.title, brief: ev.body ?? '',
        files: ev.data.files, branch: ev.data.branch ?? undefined, budget_usd: ev.data.budget_usd ?? undefined, ttl_s: Math.min(left, DEFAULT_TTL_S),
        after_note: ev.data.after_note === true, origin: ev.data.origin, fallback_of: ev.handoff_id, trace_id: traceOf(ev) });
      return r?.handoff_id ? r : null;
    } catch (e) { logger?.warn?.('bus fallback failed', { code: e?.code ?? null }); return null; }
  }

  // G5: the result goes back to the session that asked, as a note from Plexiform it hears about at its next tool call
  // or prompt. One line of outcome, the handoff_id, the start of the summary (framed as data when read). The full
  // result stays in bus_wait and bus_read. Main re-addresses it to a same-repo successor if that session has ended.
  function returnResult(ev, outcome, { summary, provider, next, providerReason }) {
    const o = ev.data?.origin;
    if (!o || !SESSION_KEY.test(o.key ?? '') || !HANDLE.test(o.handle ?? '')) return;
    const who = AI_NAME[provider] ?? 'An AI';
    const title = String(ev.data?.title ?? '').slice(0, 80);
    const head = next ? `Hand-off ${ev.handoff_id} ("${title}"): ${who} ${BREAKER_WORDS[providerReason] ?? 'could not take it'}, so Plexiform gave it to ${AI_NAME[next.provider] ?? 'the next AI'} as ${next.handoff_id}. That result will follow.`
      : outcome === 'done' ? `Hand-off ${ev.handoff_id} ("${title}") is done, by ${who} running in Plexiform.`
        : outcome === 'expired' ? `Hand-off ${ev.handoff_id} ("${title}") expired before it started.`
          : outcome === 'outcome_unknown' ? `Hand-off ${ev.handoff_id} ("${title}") ended with no known outcome.`
            : `Hand-off ${ev.handoff_id} ("${title}") failed.`;
    const tail = next ? '' : ` Summary: ${String(summary ?? '').replace(/\s+/g, ' ').slice(0, 400)} Full result: bus_wait with this handoff_id.`;
    try {
      const n = notes.system({ to: o, handoff_id: ev.handoff_id, text: `${head}${tail}` });
      span(ev, 'returned', { to: o.handle, ...BusTrace.resultOf(n) });
    } catch (e) { logger?.warn?.('bus result note failed', { code: e?.code ?? null }); }
  }

  // A hand-off run that stops for its person (a tool approval, a plan to approve) tells the asker in one line: the
  // handoff_id and the AI, never the title, brief, tool input or a path. One note per blocking ask.
  function noteBlocked(task) {
    const ev = log.handoff(task.sourceMeta.handoffId);
    const o = ev?.data?.origin;
    if (!ev || !o || !SESSION_KEY.test(o.key ?? '') || !HANDLE.test(o.handle ?? '') || log.result(ev.handoff_id)) return;
    if (log.claimOf(ev.handoff_id)?.task_id !== task.id) return;
    const ask = task.openApprovals?.[0]?.approvalId ?? task.openAsk?.askId ?? task.blockedKind ?? 'blocked';
    const what = task.blockedKind === 'plan' ? 'its plan approved' : 'a step approved';
    const text = `Hand-off ${ev.handoff_id}: ${AI_NAME[task.ai?.id ?? ev.to?.provider] ?? 'The AI'} running in Plexiform is waiting for your person to get ${what} (Needs you in Plexiform). It goes on once they answer; nothing for you to do.`;
    try {
      const n = notes.system({ to: o, handoff_id: ev.handoff_id, text, kind: 'blocked', key: ask });
      const r = BusTrace.resultOf(n);
      if (!n.duplicate) span(ev, 'returned', { to: o.handle, ...r, reason: r.reason ?? 'BLOCKED' });
    } catch (e) { logger?.warn?.('bus blocked note failed', { code: e?.code ?? null }); }
  }

  // A bus task reached an end state: its handoff gets one result.
  function onTaskState(task) {
    if (task.source !== 'bus' || !task.sourceMeta?.handoffId) return;
    if (task.state === 'blocked') { noteBlocked(task); return; }
    const outcome = task.state === 'in_review' || (task.state === 'done' && task.outcome !== 'discarded') ? 'done'
      : task.state === 'failed' || task.state === 'done' || (task.state === 'parked' && task.parkReason !== 'user') ? 'failed' : null;
    if (!outcome) return;
    const ev = log.handoff(task.sourceMeta.handoffId);
    if (!ev) return;
    const c = log.claimOf(ev.handoff_id);
    if (c?.task_id !== task.id || halting.has(task.id)) return; // a run halted mid-start reports nothing
    let report = null;
    try { report = c?.report ? JSON.parse(c.report) : null; } catch { report = null; }
    const own = outcome === 'done' ? task.evidence?.summary ?? task.lastAssistant ?? 'Done.' : failedText(task);
    const worker = task.ai?.id ?? ev.to?.provider;
    const providerReason = outcome === 'failed' ? reasonOf({ failKind: task.failKind, parkReason: task.state === 'parked' ? task.parkReason : null }) : null;
    if (providerReason) health.failed(worker, providerReason, { text: task.failReason, retryAt: task.limitResetAt ?? null });
    else if (outcome === 'done') health.succeeded(worker);
    finish(ev, task.sourceMeta.fence, report?.outcome === 'failed' ? 'failed' : outcome, {
      summary: report?.summary ?? scrubRun(own, LIMITS.summary, task.worktree), evidence: report?.evidence ?? [],
      ...runCost(task), branch: task.branch, task_id: task.id, provider: task.ai?.id ?? null, providerReason,
    });
    // A parked run has its result now (and maybe a fallback): end it, so a later "resume" never redoes the work unseen.
    if (task.state === 'parked') engine.act({ id: task.id, action: 'stop', requestId: `bus-parked-${task.id}` }).catch(() => {});
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
  const sweep = setInterval(() => { try { log.sweep(); notes.expire(); } catch { /* next time */ } }, HOUR_MS);
  for (const t of [renew, tick, sweep]) t.unref?.();
  setImmediate(pump);

  // ── ops ────────────────────────────────────────────────────────────────────
  const parse = (S, a) => { const r = S.safeParse(a ?? {}); if (!r.success) throw new BusRefusal('VALIDATION', issue(r)); return r.data; };
  const callerProvider = (args, caller) => args.provider ?? caller?.provider ?? 'agent';
  const consume = (domain, events) => { const hop = Math.max(0, ...events.map((e) => e.hop ?? 0)); if (hop) log.consumed(domain, hop, now() - HOUR_MS); };
  function view(ev) {
    const result = ev.topic === 'result';
    const text = result ? ev.data?.summary : ev.body;
    // A result is posted by the dispatcher, but the work is the run's: name the AI that did it.
    const worker = result ? ev.data?.provider ?? ev.to?.provider ?? null : null;
    const from = result ? { provider: worker ?? 'agent', tier: 'run_capability' } : { provider: ev.source.provider, tier: ev.source.tier };
    // Nothing ran for an expired or never-started handoff: the result is Plexiform's own.
    const who = !result ? { kind: 'session', name: `This ${machine()}`, provider: ev.source.provider }
      : { kind: 'run', name: ev.data?.task_id ? `${AI_NAME[worker] ?? 'An AI'} running in Plexiform` : 'Plexiform' };
    return { offset: ev.offset, topic: ev.topic, kind: ev.kind, handoff_id: ev.handoff_id, card_id: ev.card_id, hop: ev.hop, at: ev.created_at,
      from, title: ev.data?.title ?? null,
      ...(result ? { cost_usd: ev.data.cost_usd, cost_basis: ev.data.cost_basis, branch: ev.data.branch } : {}),
      ...(result && ev.data?.reason ? { reason: ev.data.reason, provider: worker, provider_reason: ev.data.provider_reason ?? null, retry_at: ev.data.retry_at ?? null } : {}),
      ...(result && ev.data?.fallback ? { fallback: ev.data.fallback } : {}),
      text: text ? frame({ kind: result ? 'message' : 'handoff', source: who, card_id: ev.card_id, body: text, afterNote: !result && ev.data?.after_note === true }) : null };
  }

  // One trace line per agent-facing op (main traces the notes ops it answers itself).
  const TRACED = new Set(['hello', 'handoff', 'read', 'wait', 'status', 'halt', 'resume']);
  async function op(name, rawArgs = {}, caller = null) {
    if (!TRACED.has(name)) return opInner(name, rawArgs, caller);
    const t0 = now();
    let r, err = null;
    try { r = await opInner(name, rawArgs, caller); } catch (e) { err = e; }
    const a = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    trace.append({ trace_id: caller?.trace?.trace_id, op: name, from_handle: caller?.origin?.handle ?? caller?.trace?.from_handle ?? null,
      to: name === 'handoff' ? (r?.provider ?? (typeof a.to?.provider === 'string' ? a.to.provider : null)) : null,
      provider: name === 'handoff' ? r?.provider ?? null : null, ref: r?.handoff_id ?? (typeof a.handoff_id === 'string' ? a.handoff_id : null),
      repo_key_hash: r?.handoff_id ? BusTrace.repoKeyHash(log.handoff(r.handoff_id)?.repo?.root) : null,
      ms: now() - t0, ...BusTrace.resultOf(r, err) });
    if (err) throw err;
    return r;
  }
  async function opInner(name, rawArgs = {}, caller = null) {
    if (closed) throw new BusRefusal('INTERNAL', 'the agent bus is closed');
    const s = settings();
    switch (name) {
      case 'hello': {
        const a = parse(HelloArgs, rawArgs);
        const top = await gitTop(caller?.cwd);
        await rememberSession(top);
        const v = await repoVerdict(top, caller?.cwd ?? null, { offIsReason: true, unbound: caller?.unbound === true });
        return { agent_id: agentFor(a.provider, top ?? caller?.cwd ?? ''), tier: 'local_attested', scope_allowed: ['local'],
          policy_summary: { enabled: s.enabled, halted: log.state('halted', false), repo_enabled: v.allowed === true,
            ...(v.allowed ? { repo_why: v.why ?? null } : { repo_reason: v.reason, repo_reason_text: Contract.REPO_REASON_TEXT[v.reason] ?? null }),
            max_hops: s.max_hops, wall_clock_min: s.wall_clock_min, caps_enabled: s.caps.enabled, auto_accept: s.auto_accept } };
      }
      case 'handoff': {
        const a = parse(HandoffArgs, rawArgs);
        await rememberSession(await gitTop(caller?.cwd));
        // Halted comes first: a stopped bus says so before anything about the repository.
        const repo = log.state('halted', false) ? { reason: 'HALTED', message: 'The agent bus is stopped on this Mac. Your person can resume it from the tray or Sessions.' }
          : await resolveRepo(a.repo ?? caller?.cwd, { unbound: caller?.unbound === true });
        const provider = callerProvider(a, caller);
        if (repo.reason) {
          const agent_id = agentFor(provider, caller?.cwd ?? '');
          append(envelope({ topic: 'handoff', kind: 'handoff.refused', request_id: a.request_id, data: { reason: repo.reason, title: a.title },
            handoff: { handoff_id: null, card_id: a.card_id ?? null, repo: null, to: a.to, hop: 0, visited: [agent_id],
              source: { device_id: deviceId, agent_id, provider, tier: 'local_attested', identity_source: 'local_token' } } }));
          return repo;
        }
        const agent_id = agentFor(provider, repo.root);
        // The session main verified as the caller (agent-awareness relay), for the result note (G5); never the request's.
        const origin = caller?.origin && SESSION_KEY.test(caller.origin.key ?? '') && HANDLE.test(caller.origin.handle ?? '')
          ? { key: caller.origin.key, handle: caller.origin.handle, ...(/^[a-f0-9]{64}$/.test(caller.origin.board ?? '') ? { board: caller.origin.board } : {}) } : null;
        return post({ ...a, requestKey: `${agent_id}|${a.request_id}`, repoRoot: repo.root, brief: a.brief ?? '', ...(origin ? { origin } : {}), trace_id: caller?.trace?.trace_id,
          source: { device_id: deviceId, agent_id, provider, tier: 'local_attested', identity_source: 'local_token' },
          hop: log.hopOf(await hopDomain(caller), now() - HOUR_MS) + 1, visited: [agent_id], after_note: caller?.after_note === true });
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
        if (!a.handoff_id) return { halted: log.state('halted', false), enabled: s.enabled, head: log.head(), providers: health.all() };
        const chain = log.chain(a.handoff_id);
        if (!chain.length) return { reason: 'NOT_FOUND', message: 'No such handoff.' };
        const c = log.claimOf(a.handoff_id);
        return { handoff_id: a.handoff_id, state: stateOf(a.handoff_id), fence: c?.fence ?? null, task_id: c?.task_id ?? null,
          chain: chain.map((e) => ({ offset: e.offset, kind: e.kind, at: e.created_at, ...(e.data?.reason ? { reason: e.data.reason } : {}) })) };
      }
      case 'list': {
        const day = log.spend(dayOf(now()));
        return { halted: log.state('halted', false), settings: s, providers: health.all(), fallback: { ...context.fallback }, spend_today: { reserved_usd: day.reserved, spent_usd: day.spent },
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
        if (a.scope === 'auto' || a.scope === 'listed') context.scope = a.scope;
        tops.clear();
        commons.clear();
        context.exclude = abs(a.exclude) ?? context.exclude;
        context.folders = abs(a.folders) ?? context.folders;
        if (a.fallback && typeof a.fallback === 'object') {
          const order = Array.isArray(a.fallback.order) ? a.fallback.order.filter((p, i, l) => Contract.PROVIDERS.includes(p) && l.indexOf(p) === i) : null;
          context.fallback = { enabled: a.fallback.enabled !== false, order: order?.length ? order : [...Contract.DEFAULT_FALLBACK] };
        }
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
      // From main only: who sends and who receives were settled there, from the calling process.
      case 'note': case 'notes': case 'notes_ack': case 'notes_pending': case 'notified': return notes.op(name, rawArgs);
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
    op, runTool, context, log, sessionRepo, health, trace,
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
