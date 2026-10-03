// One claimed run: its CLI, gate G, facts, hook answers and board tools.
// Everything hub-bound goes through supervisor.emitOut / salvage / rpc, which
// serialize with scope.serializeOutbound under this run's scope.
import { gate as gateOf, ackAge, NARRATIVE_NUDGE_MS, NARRATIVE_NUDGE_CALLS, DEGRADED_NO_SESSIONSTART_MS,
  T_CLAIM_MS, STOP_GRACE_MS, HANDOVER_WAIT_MS } from '../shared/liveness.js';
import { filterPath, redact } from '../shared/scope.js';
import { snapshotRef, salvageRef } from '../shared/fence.js';
import { AGENT_WRITABLE, applyPatch, mergeHandover, renderMarkdown } from '../shared/handover.js';
import { MCP_OUTBOX_TOOLS } from '../shared/protocol.js';
import { confine, globBase, realish } from './paths.js';
import { answererAllowed, runAllowKey } from './policy.js';
import { snapshot as gitSnapshot, pushRef, gitFacts } from './git.js';
import { clip } from './util.js';
import { randomBytes } from 'node:crypto';
import { untrusted } from '../shared/untrusted.js';

export const ACTIVITY_THROTTLE_MS = 5000;
export const FACT_FLUSH_MS = 2000;
export const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;
export const RATE_LIMIT_RETRIES = 3;

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DEFAULT_TEST_PATTERNS = [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/, /\bnode\s+--test\b/, /\b(jest|vitest|pytest|mocha)\b/, /\bgo\s+test\b/, /\bcargo\s+test\b/, /\bmake\s+(test|check)\b/];

const planStatus = (s) => ({ pending: 'todo', in_progress: 'doing', completed: 'done' }[s] ?? 'todo');

function hso(event, extra) {
  return { hookSpecificOutput: { hookEventName: event, ...extra } };
}

function deny(reason) {
  return { stdout: hso('PreToolUse', { permissionDecision: 'deny', permissionDecisionReason: reason }), exit_code: 0 };
}

const PROCEED = { stdout: {}, exit_code: 0 };

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Failure kind from result text, reusing hooks/set-status.js failureOf() regexes. */
export function failKindOf(text) {
  if (/network|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|connection|offline|socket/i.test(text)) return 'network';
  if (/rate[ _-]?limit|overloaded|\b529\b|\b429\b|usage limit/i.test(text)) return 'limit';
  return 'error';
}

// Split a shell command into simple-command token lists (good enough for a gate).
function segments(cmd) {
  return String(cmd).split(/\|\||&&|[;|&\n]/).map((s) => s.trim().split(/\s+/).filter(Boolean)).filter((t) => t.length);
}

/** null = allowed; else the deny reason. Only `git push origin board/<KEY>-r<n>` passes (D24). */
export function checkGitPush(cmd, branch) {
  for (const toks of segments(cmd)) {
    let i = toks.findIndex((t) => t === 'git' || t.endsWith('/git'));
    if (i < 0) continue;
    i++;
    while (i < toks.length && toks[i].startsWith('-')) i += (toks[i] === '-C' || toks[i] === '-c') ? 2 : 1;
    if (toks[i] !== 'push') continue;
    const args = toks.slice(i + 1);
    const pos = [];
    for (const a of args) {
      if (a.startsWith('-')) {
        if (!['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--no-verify'].includes(a)) return `git push flag ${a} is not allowed on board runs`;
      } else pos.push(a.replace(/^['"]|['"]$/g, ''));
    }
    const okRef = [branch, `HEAD:${branch}`, `${branch}:${branch}`, `HEAD:refs/heads/${branch}`];
    if (pos.length !== 2 || pos[0] !== 'origin' || !okRef.includes(pos[1])) return `board runs may only push to origin ${branch}`;
  }
  return null;
}

export class Run {
  constructor(sup, info) {
    this.sup = sup;
    this.log = sup.log;
    this.clock = sup.clock;
    Object.assign(this, info);   // run_id, card_id, key, fence, repo_id, run_token, branch, worktree, runDir, socketPath, sessionId, offer, scope
    // Envelope nonce (D30): content authors never see it, so they cannot forge our closing tag.
    this.nonce = randomBytes(8).toString('hex');
    this.backend = null;
    this.generation = 0;
    this.resumePending = null;
    this.localState = 'running';
    this.fenced = false;
    this.endedNormally = false;  // fenced because board_complete/board_release ended it, not a takeover
    this.releaseRequeued = false;
    this.postFence = false;      // hub already bumped the fence (stop/park/fenced): final writes go as salvage
    this.ending = false;
    this.ended = false;
    this.endReason = null;
    const now = this.clock.mono();
    // A successful claim is a fence-confirming round trip.
    this.ack = { mono: info.claimAckMono ?? now, wall: info.claimAckWall ?? this.clock.wall() };
    this.wake = null;
    this.postWakeActivity = false;
    this.gateOpen = true;
    this.gateReason = 'ok';
    this.spawnMono = now;
    this.sawInit = false;
    this.firstActivity = false;
    this.sessionStartSeen = false;
    this.degradedSent = false;
    this.lastActivityMono = null;
    this.pendingActivity = null;
    this.lastActivitySentMono = -Infinity;
    this.toolInFlight = null;
    this.streamTools = new Map();
    this.tasks = new Map();      // CLI task list mirror (TaskCreate/TaskUpdate)
    this.facts = [];
    this.lastFactFlush = now;
    this.costUsd = 0;
    this.numTurns = 0;
    this.narrative = null;
    this.lastHandoverMono = now;
    this.callsSinceHandover = 0;
    this.nudgedAt = -Infinity;
    this.pending = [];           // [{text, kind, comment_ids?}] awaiting a tool boundary or idle
    this.approvals = new Map();  // key `${connId}:${reqId}` → {resolve, prid}
    this.runAllow = new Set();
    this.answered = new Set();
    this.turnSignals = { complete: false, ask: false, release: false };
    this.completed = false;
    this.released = false;
    this.handover = null;        // {mode:'handover'|'park', deadline, written, resolve}
    this.teamContext = info.team_context ?? null;
    this.overlapDelta = null;
    this.lastSnapshotMono = now;
    this.snapshotChain = Promise.resolve();
    this.unpushed = null;
    this.expectInterrupt = false;
    this.rateLimited = null;
    this.limitRetries = 0;
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }

  // ── gate G ────────────────────────────────────────────────────────────────
  gateState() {
    if (this.windowsStopUnconfirmed) return { open: false, reason: 'windows_stop_unconfirmed' };
    const age = ackAge({ mono_since_ack_ms: this.clock.mono() - this.ack.mono, wall_since_ack_ms: this.clock.wall() - this.ack.wall });
    const wake = this.wake ? { slept_ms: this.wake.slept_ms, age_ms: this.clock.mono() - this.wake.mono } : null;
    return gateOf({ ack_age_ms: age, fenced: this.fenced, wake });
  }

  onCurrentAck(sentMono, sentWall) {
    if (sentMono < this.ack.mono) return;
    this.ack = { mono: sentMono, wall: sentWall };
    if (this.wake && this.wake.mono <= sentMono) this.wake = null;
    const g = this.gateState();
    if (g.open && !this.gateOpen) this.#reopen();
    this.gateOpen = g.open;
    this.gateReason = g.reason;
  }

  onWake(slept_ms) {
    this.wake = { slept_ms, mono: this.clock.mono() };
    this.postWakeActivity = false;
    // An event held by the activity throttle happened before sleep. Sending
    // it after the recovery heartbeat would falsely count it as fresh work.
    this.pendingActivity = null;
  }

  // Called every tick.
  evaluateGate() {
    const g = this.gateState();
    // await_ack is the short-wake wait: pre holds each tool, nothing is closed.
    const closed = !g.open && g.reason !== 'await_ack';
    if (closed && this.gateOpen) this.#closeGate(g.reason);
    this.gateOpen = !closed;
    this.gateReason = g.reason;
    return g;
  }

  #closeGate(reason) {
    if (this.ending) return;
    this.log.warn('gate closed', { run_id: this.run_id, reason });
    this.localState = this.fenced ? 'fenced' : 'paused_offline';
    this.#interruptTurn();
    this.snapshotNow({ push: false, why: 'gate closed' });
    this.sup.notifyLocal({ event: 'paused_offline', run_id: this.run_id, key: this.key, reason });
  }

  // Interrupt the turn; SIGKILL the tree if it hasn't ended within STOP_GRACE_MS.
  #interruptTurn() {
    const b = this.backend;
    if (!b?.alive()) return;
    this.expectInterrupt = true;
    b.interrupt();
    const grace = this.sup.opts.stopGraceMs ?? STOP_GRACE_MS;
    setTimeout(() => { if (b.alive() && b.turnActive && !this.gateOpen) b.kill(); }, grace).unref?.();
  }

  #reopen() {
    if (this.localState !== 'paused_offline') return;
    this.log.info('gate reopened', { run_id: this.run_id });
    this.localState = 'running';
    if (this.unpushed) this.#retryPush();
    if (!this.backend?.alive()) {
      if (this.backend?.oneTurn && this.pending.length) this.#resumePending();
      else Promise.resolve(this.sup.resumeRun(this)).catch(() => {});
    }
    else if (!this.backend.turnActive) this.#deliverIdle('Board connection restored and your run is still current. Continue where you left off.', 'system');
  }

  // ── activity + facts ──────────────────────────────────────────────────────
  activity(source) {
    const now = this.clock.mono();
    this.lastActivityMono = now;
    if (this.wake) this.postWakeActivity = true;
    if (!this.firstActivity && this.sawInit) {
      this.firstActivity = true;
      this.lastActivitySentMono = now;
      this.emit({ kind: 'activity', source });
      return;
    }
    this.pendingActivity = source;
  }

  fact(kind, body = {}) {
    this.facts.push({ kind, ...body });
    if (this.facts.length >= 20) this.flushFacts();
  }

  flushFacts() {
    if (!this.facts.length) return;
    const items = this.facts;
    this.facts = [];
    this.lastFactFlush = this.clock.mono();
    this.emit({ kind: 'facts', items });
  }

  emit(body) {
    const msg = { ...body, run_id: this.run_id, card_id: this.card_id, fence: this.fence, repo_id: this.repo_id };
    if (this.postFence) {
      if (body.kind === 'handover.write') return this.sup.salvage(this, 'handover', { patch: body.patch });
      if (body.kind === 'snapshot') return this.sup.salvage(this, 'snapshot', { status: body.status, sha: body.sha, ref: body.ref, reason: body.reason });
    }
    return this.sup.emitOut(this, msg);
  }

  tick() {
    const now = this.clock.mono();
    if (this.pendingActivity && now - this.lastActivitySentMono >= ACTIVITY_THROTTLE_MS) {
      this.lastActivitySentMono = now;
      this.emit({ kind: 'activity', source: this.pendingActivity });
      this.pendingActivity = null;
    }
    if (this.facts.length && now - this.lastFactFlush >= FACT_FLUSH_MS) this.flushFacts();
    if (!this.sessionStartSeen && !this.degradedSent && now - this.spawnMono >= DEGRADED_NO_SESSIONSTART_MS && this.backend?.alive()) {
      this.degradedSent = true;
      this.fact('degraded', { reason: 'no SessionStart hook within 30 s of spawn' });
    }
    if ((!this.sawInit || !this.firstActivity) && !this.ending && now - this.spawnMono >= (this.sup.opts.claimBudgetMs ?? T_CLAIM_MS)) {
      this.prepFailed('no init/activity within T_claim');
    }
    if (this.handover && !this.handover.done && now >= this.handover.deadline) this.#finishHandover('timeout');
    if ((this.toolInFlight || this.streamTools.size) && now - (this.treeAt ?? -Infinity) >= 3000) {
      this.treeAt = now;
      this.backend?.refreshTree?.();
    }
    this.evaluateGate();
  }

  hb() {
    const now = this.clock.mono();
    const t = this.toolInFlight;
    return {
      run_id: this.run_id, card_id: this.card_id, fence: this.fence,
      child_alive: !!this.backend?.alive(),
      read_only: this.readOnly === true,
      tool_in_flight: t ? { name: t.name, summary: t.summary, age_ms: Math.round(now - t.mono), ...(t.bash_timeout_ms ? { bash_timeout_ms: t.bash_timeout_ms } : {}) } : null,
      last_activity_age_ms: this.lastActivityMono == null ? null : Math.round(now - this.lastActivityMono),
      cost_usd: this.costUsd,
      post_wake_activity: this.postWakeActivity,
      wake_age_ms: this.wake ? Math.round(now - this.wake.mono) : null,
      gate: this.gateOpen ? 'open' : 'closed',
      local_state: this.localState,
    };
  }

  // ── backend wiring ────────────────────────────────────────────────────────
  attach(backend) {
    this.backend = backend;
    const generation = ++this.generation;
    this.turnSucceeded = false;
    this.localState = 'running';
    const current = () => this.backend === backend && this.generation === generation && !this.ended;
    const on = (name, fn) => backend.on(name, (...args) => { if (current()) fn(...args); });
    on('init', (e) => {
      this.sawInit = true;
      if (backend.oneTurn) { this.sessionStartSeen = true; this.costUsd = null; }
      if (e.session_id) { this.sessionId = e.session_id; this.sup.saveLedger(this); }
      this.fact('session', { session_id: e.session_id ?? this.sessionId, event: 'init' });
      this.activity('init');
    });
    on('tool_start', (e) => {
      this.streamTools.set(e.id, { name: e.name, input: e.input, mono: this.clock.mono() });
      if (!this.toolInFlight) this.toolInFlight = { name: e.name, summary: this.#summary(e.name, e.input), mono: this.clock.mono() };
      this.activity('tool_start');
    });
    on('tool_end', (e) => {
      const start = this.streamTools.get(e.id);
      this.streamTools.delete(e.id);
      if (!this.streamTools.size) this.toolInFlight = null;
      if (backend.oneTurn && start) {
        const duration = Math.max(0, Math.round(this.clock.mono() - start.mono));
        this.fact('tool_end', { name: start.name, ok: e.ok, duration_ms: duration });
        if (WRITE_TOOLS.has(start.name)) {
          const rel = this.#relPath(start.input?.file_path);
          if (rel) this.fact('file', { path: rel, op: 'write' });
        }
        if (start.name === 'Bash') this.#bashFacts(e.input ?? start.input ?? {}, { tool_response: e.output }, e.ok, duration, current).catch(() => {});
      }
      this.activity('tool_end');
    });
    on('assistant', (e) => {
      this.lastAssistant = e.text;
      this.activity('assistant');
    });
    on('rate_limit', ({ info }) => {
      if (info?.status === 'rejected') this.rateLimited = { resetsAt: info.resetsAt ?? null };
    });
    on('result', (r) => this.#onResult(r));
    on('exit', (info) => this.#onExit(info));
  }

  #onResult(r) {
    this.turnSignals = { complete: false, ask: false, release: false };
    this.toolInFlight = null;
    this.streamTools.clear();
    if (Number.isFinite(r.total_cost_usd)) this.costUsd = r.total_cost_usd;
    if (Number.isSafeInteger(r.num_turns)) this.numTurns = r.num_turns;
    if (Number.isFinite(this.costUsd)) this.fact('cost', { cost_usd: this.costUsd, num_turns: this.numTurns });
    if (this.ending) return;
    if (this.completed || this.released) { this.finish(this.completed ? 'completed' : 'released'); return; }
    if (r.subtype === 'success') {
      this.turnSucceeded = true;
      this.limitRetries = 0;
      if (this.gateOpen && this.pending.length) this.#flushIdle();
      return;
    }
    if (r.terminal_reason === 'budget' || r.subtype === 'error_max_budget_usd') {
      this.sup.onBudgetReached?.(this);
      return this.fail('budget', 'budget cap reached (--max-budget-usd)', this.budgetScope ? { budget_scope: this.budgetScope } : {});
    }
    // A turn limit is not a budget: it must never read "Budget reached" (D-5).
    if (r.subtype === 'error_max_turns') return this.fail('error', 'max_turns');
    if (this.expectInterrupt) {
      this.expectInterrupt = false;
      if (this.gateOpen && this.pending.length) this.#flushIdle();
      return;
    }
    const text = [r.result, ...(Array.isArray(r.errors) ? r.errors : []), r.terminal_reason, r.subtype].filter(Boolean).join(' ');
    const kind = this.rateLimited ? 'limit' : failKindOf(text);
    if (kind === 'limit' && !this.rateLimited && this.limitRetries < RATE_LIMIT_RETRIES) {
      const wait = (this.sup.opts.limitBackoffMs ?? 30000) * 2 ** this.limitRetries++;
      this.log.warn('rate limited, retrying', { run_id: this.run_id, wait });
      setTimeout(() => { if (!this.ending && this.backend?.alive()) this.backend.send('You were rate limited; continue where you left off.'); }, wait).unref?.();
      return;
    }
    const resetsAt = this.rateLimited?.resetsAt ? this.rateLimited.resetsAt * 1000 : null;
    const extra = kind === 'limit' && resetsAt ? { resets_in_ms: Math.max(0, Math.round(resetsAt - this.clock.wall())) } : {};
    this.fail(kind, clip(text, 180), extra);
  }

  async #onExit(info) {
    if (this.backend?.platform === 'win32' && !(await this.#windowsStopConfirmed())) return;
    this.toolInFlight = null;
    if (this.ended) return;
    if (this.ending) return;   // whoever set `ending` stopped the CLI and finishes the run
    if (this.localState === 'paused_offline' || this.fenced) return;   // killed at gate close; resumed on reopen
    if (this.backend?.oneTurn && info.code === 0 && !info.signal && info.sawResult && this.turnSucceeded) {
      this.backend.reap?.();
      this.localState = this.readOnly ? 'awaiting_plan_approval' : 'idle';
      this.flushFacts();
      this.sup.sendHbNow();
      if (this.pending.length) this.#resumePending();
      return;
    }
    // Unexpected death: report before anything slow (exit b: < 1 s).
    this.backend?.reap?.();
    const provider = this.backend?.oneTurn ? this.backend.constructor.describe?.().label ?? 'Codex' : 'claude';
    const why = info.error ? `${provider} failed to start: ${info.error}` : `${provider} exited (code ${info.code ?? '-'}${info.signal ? `, ${info.signal}` : ''})${info.sawResult ? '' : ' without a result'}`;
    this.emit({ kind: 'run.failed', fail_kind: 'error', reason: redact(why, this.worktree) });
    this.endReason = 'failed';
    this.ending = true;
    this.#afterExit();
  }

  async #windowsStopConfirmed() {
    if (this.backend?.platform !== 'win32') return true;
    let confirmed = false;
    try { confirmed = await this.backend.confirmStopped(); } catch { /* unknown */ }
    return confirmed || this.#quarantine('Windows process stop');
  }

  // Every platform: stop() must return a positive receipt (true). Anything
  // else means the old process tree may still be working in the worktree, so
  // the run, its workspace and its repo are held exactly like an unconfirmed
  // Windows stop: no snapshot, release, cleanup or redispatch.
  async #stopConfirmed(stopped) {
    if (!this.backend) return true;
    if (this.backend.platform === 'win32') return this.#windowsStopConfirmed();
    return stopped === true || this.#quarantine('Process stop');
  }

  // Never throws: a throw here would strand a handover or quit waiting on it.
  #quarantine(what) {
    this.windowsStopUnconfirmed = true;
    this.ending = true; this.gateOpen = false; this.localState = 'paused_offline';
    this.sup.windowsQuarantinedRepos?.add(this.repo_id);
    try { this.sup.saveLedger?.(this); } catch { /* the in-memory hold still applies */ }
    this.log.warn(`${what} is unconfirmed; preserving run and workspace`, { run_id: this.run_id });
    this.sup.notifyLocal?.({ event: 'paused_offline', run_id: this.run_id, key: this.key, reason: `${what} is unconfirmed. This run is quarantined for manual recovery.` });
    return false;
  }

  async #afterExit() {
    if (this.backend?.platform === 'win32' && !(await this.#windowsStopConfirmed())) return;
    this.flushFacts();
    await this.snapshotNow({ push: true, why: 'final' });
    this.#end();
  }

  #end() {
    if (this.ended) return;
    this.ended = true;
    for (const a of this.approvals.values()) a.resolve({ behavior: 'deny', message: 'The run ended.' });
    this.approvals.clear();
    // A quit window reads false (not parked) whichever path ends the run first.
    this.handover?.resolve?.(this.handover.mode === 'quit' ? false : undefined);
    this.flushFacts();
    this.sup.runEnded(this);
    this.resolveDone();
  }

  // Terminal: report, stop the CLI, final snapshot, end.
  async fail(kind, reason, extra = {}) {
    if (this.ending) return;
    this.ending = true;
    this.endReason = 'failed';
    this.emit({ kind: 'run.failed', fail_kind: kind, reason: redact(reason, this.worktree), ...extra });
    if (!(await this.#stopConfirmed(await this.backend?.stop()))) return;
    if (!this.ended) await this.#afterExit();
  }

  async prepFailed(cause) {
    if (this.ending) return;
    this.ending = true;
    this.endReason = 'prep_failed';
    this.emit({ kind: 'prep.failed', cause: redact(cause, this.worktree) });
    if (!(await this.#stopConfirmed(await this.backend?.stop()))) return;
    this.#end();
  }

  // Ends after a result that followed board_complete / board_release.
  async finish(reason) {
    if (this.ending) return;
    this.ending = true;
    this.endReason = reason;
    this.backend?.endInput();
    const exited = await Promise.race([
      new Promise((r) => { if (this.backend?.exited) r(true); else this.backend?.once('exit', () => r(true)); }),
      new Promise((r) => setTimeout(() => r(false), this.sup.opts.interruptWaitMs ?? 5000).unref?.()),
    ]);
    if (!exited && !(await this.#stopConfirmed(await this.backend?.stop()))) return;
    if (!this.ended) await this.#afterExit();
  }

  // ── hub commands ──────────────────────────────────────────────────────────
  async command(c) {
    switch (c.cmd) {
      case 'interrupt':
        this.expectInterrupt = true;
        await this.backend?.interrupt();
        return;
      case 'stop':
        this.postFence = this.#fenceBumpedOnHub();
        if (this.ending) return;
        this.ending = true;
        this.endReason = 'stopped';
        if (!(await this.#stopConfirmed(await this.backend?.stop()))) return;
        await this.#afterExit();
        return;
      case 'park':
        this.postFence = true;
        return this.#beginHandover('park', c.wait_ms ?? 30000);
      case 'handover_begin':
        return this.#beginHandover('handover', c.wait_ms ?? HANDOVER_WAIT_MS);
      default:
        this.log.warn('unknown cmd', { cmd: c.cmd });
    }
  }

  // App quit (D37a): the handover window, stop, a pushed snapshot at the
  // current fence, then release{requeue} so the card goes back to the queue
  // instead of failing. → true once the hub requeued it; false leaves the run
  // (and its ledger entry) to the next start's orphan handling.
  parkForQuit(waitMs) {
    if (this.handover || this.ending || this.ended || this.fenced || !this.backend || !this.sup.connected) return Promise.resolve(false);
    return this.#beginHandover('quit', waitMs);
  }

  // Inside a hub-requested park or handover window (not our own quit): the
  // hub already moved the card on, so a quit counts it as parked-pending.
  get hubHandoverPending() {
    return !!this.handover && !this.handover.done && this.handover.mode !== 'quit' && !this.ended;
  }

  #beginHandover(mode, waitMs) {
    if (this.handover || this.ending) return;
    const text = 'The board asked for a handover: write your final handover now via board_write_handover (plan, done, hypothesis, dead_ends, next, questions), then stop working.';
    return new Promise((resolve) => {
      this.handover = { mode, deadline: this.clock.mono() + waitMs, done: false, resolve };
      this.#deliver(text, 'handover');
      // Wall-time guard too, in case ticks stall.
      setTimeout(() => this.#finishHandover('timeout'), waitMs).unref?.();
    });
  }

  async #finishHandover(why) {
    const h = this.handover;
    if (!h || h.done) return;
    // A fence (or any end) landed inside the window: the fence path already
    // stopped and salvaged; no stop, snapshot or release at a stale fence.
    if (this.fenced || this.ended) { h.done = true; h.resolve(false); return; }
    h.done = true;
    this.log.info('handover finishing', { run_id: this.run_id, why, mode: h.mode });
    this.ending = true;
    this.endReason = h.mode === 'handover' ? 'handed_over' : 'parked';
    const stopped = await this.backend?.stop();
    if (!(await this.#stopConfirmed(stopped))) { h.resolve(false); return; }
    // A completed handover is the authority to start a replacement. A failed
    // stop must never be reported as completion, even after its deadline.
    if (h.mode === 'handover' && (stopped !== true || this.backend?.alive() !== false)) {
      this.log.warn('handover stop not confirmed', { run_id: this.run_id });
      h.resolve(false);
      return;
    }
    this.flushFacts();
    const snapshot = await this.snapshotNow({ push: true, why: 'final handover' });
    if (h.mode === 'handover') this.emit({ kind: 'handover.complete', stop_confirmed: true,
      checkpoint_confirmed: snapshot?.status === 'pushed', handover_written: why === 'written' });
    if (h.mode === 'quit') {
      const ok = await this.#releaseForQuit();
      h.resolve(ok);
      if (ok) this.#end();
      return;
    }
    h.resolve();
    this.#end();
  }

  async #releaseForQuit() {
    try {
      const r = await this.sup.rpc(this, 'board_release', { reason: 'The desktop app quit; parked with a final handover.', requeue: true }, { timeoutMs: 5000 });
      this.released = true;
      this.releaseRequeued = r.state === 'queued';
    } catch (e) {
      this.log.warn('quit: release failed; left to orphan handling', { run_id: this.run_id, err: e.message });
    }
    return this.releaseRequeued;
  }

  // Only a stop from the hub, park, a takeover or a requeueing release bump the
  // fence. board_complete (row 31) and a failing release (row 25) end the run
  // at the same fence, so their final writes stay on the outbox, not salvage.
  #fenceBumpedOnHub() {
    if (this.completed) return false;
    if (this.released) return this.releaseRequeued === true;
    return true;
  }

  // hb.ack current:false / fenced / rpc FENCED|RUN_ENDED → zombie revival (§6.9).
  async onFenced(reason) {
    if (this.fenced) return;
    // board_complete/board_release already ended the run on the hub (RUN_ENDED,
    // or FENCED after a requeue): expected, not a takeover. Deny further tools
    // and finish normally.
    if (this.completed || this.released) {
      this.fenced = true;
      this.endedNormally = true;
      this.postFence = this.#fenceBumpedOnHub();
      for (const a of this.approvals.values()) a.resolve({ behavior: 'deny', message: 'The run has ended normally.' });
      this.approvals.clear();
      if (!this.ending) await this.finish(this.completed ? 'completed' : 'released');
      return;
    }
    // Park already bumped the fence; its handover window (wait_ms) still runs
    // to the end, and its final writes go as salvage.
    if (this.handover?.mode === 'park' && !this.handover.done) {
      this.log.info('fenced during park: letting the handover window finish', { run_id: this.run_id, reason });
      return;
    }
    this.fenced = true;
    this.postFence = true;
    this.localState = 'fenced';
    this.gateOpen = false;
    this.log.warn('run fenced', { run_id: this.run_id, reason });
    for (const a of this.approvals.values()) a.resolve({ behavior: 'deny', message: 'This card was taken over.' });
    this.approvals.clear();
    this.sup.notifyLocal({ event: 'fenced', run_id: this.run_id, key: this.key });
    if (this.ending && !this.handover) return;
    this.ending = true;
    this.endReason = 'fenced';
    if (!(await this.#stopConfirmed(await this.backend?.stop()))) return;
    this.flushFacts();
    const snap = await this.snapshotNow({ push: true, ref: salvageRef(this.key, this.fence), why: 'salvage', emitAs: 'none' });
    if (snap?.sha) this.sup.salvage(this, 'snapshot', { status: snap.status, sha: snap.sha, ref: snap.ref, reason: snap.reason });
    if (this.narrative) this.sup.salvage(this, 'handover', { patch: this.#narrativePatch() });
    this.sup.salvage(this, 'note', { text: `run r${this.fence} was fenced (${reason}); stopped and salvaged` });
    this.#end();
  }

  #narrativePatch() {
    const n = this.narrative ?? {};
    const out = {};
    for (const k of AGENT_WRITABLE) if (n[k] != null && !(Array.isArray(n[k]) && !n[k].length)) out[k] = n[k];
    return out;
  }

  // ── delivery (comments, answers, handover requests) ───────────────────────
  #deliver(text, kind, comment_ids) {
    if (this.ending || this.ended || this.fenced || this.completed || this.released) return;
    if (this.backend?.alive() && !this.backend.turnActive && this.gateOpen) {
      this.#deliverIdle(text, kind, comment_ids);
    } else {
      this.pending.push({ text, kind, comment_ids });
      if (this.backend?.oneTurn && !this.backend.alive()) this.#resumePending();
    }
  }

  #deliverIdle(text, kind, comment_ids) {
    if (!this.backend?.send(text)) { this.pending.push({ text, kind, comment_ids }); return; }
    if (comment_ids?.length) this.emit({ kind: 'comment.delivered', comment_ids, via: 'stdin' });
  }

  #flushIdle() {
    if (this.backend?.oneTurn) { if (!this.backend.alive()) this.#resumePending(); return; }
    const items = this.pending;
    this.pending = [];
    if (!items.length) return;
    const ids = items.flatMap((i) => i.comment_ids ?? []);
    if (!this.backend?.send(items.map((i) => i.text).join('\n\n'))) { this.pending = items; return; }
    if (ids.length) this.emit({ kind: 'comment.delivered', comment_ids: ids, via: 'stdin' });
  }

  #resumePending() {
    if (this.resumePending || !this.pending.length || this.backend?.alive() || !this.gateState().open || this.ending || this.ended || this.fenced) return;
    let items;
    this.resumePending = Promise.resolve().then(() => {
      items = [...this.pending];
      return this.sup.resumeRun(this, items.map((i) => i.text).join('\n\n'));
    }).then((backend) => {
      if (!backend || this.ending || this.ended || this.fenced) return;
      this.pending = this.pending.filter((item) => !items.includes(item));
      const ids = items.flatMap((i) => i.comment_ids ?? []);
      if (ids.length) this.emit({ kind: 'comment.delivered', comment_ids: ids, via: 'stdin' });
    }).catch((e) => {
      if (!this.ending && !this.ended && !this.fenced && !this.backend?.alive() && this.gateState().open) {
        this.localState = this.readOnly ? 'awaiting_plan_approval' : 'idle';
        this.sup.sendHbNow();
      }
      this.log.info('resume held', { run_id: this.run_id, code: e.code ?? 'INTERNAL' });
    }).finally(() => { this.resumePending = null; });
  }

  onComments(comments) {
    for (const c of comments ?? []) {
      this.#deliver(`New comment on card ${this.key}:\n${this.#wrap(`card:${this.key} comment by ${c.author_name ?? 'a teammate'}`, c.body)}`, 'comment', [c.comment_id]);
    }
  }

  // The hub re-sends every answer of an unended run on each hello: apply each once.
  onAnswer(a) {
    const key = a.permission_request_id ? `p:${a.permission_request_id}` : a.ask_id ? `a:${a.ask_id}` : null;
    if (key && this.answered.has(key)) return;
    if (a.permission_request_id) {
      for (const [k, p] of this.approvals) {
        if (p.prid === a.permission_request_id) { this.answered.add(key); this.approvals.delete(k); p.onAnswer(a); return; }
      }
      if (this.backend?.oneTurn && this.offer.require_plan_approval) {
        // This frame only schedules a fresh authenticated status read. Its
        // decision/text never changes the sandbox authority itself.
        if (key) this.answered.add(key);
        this.#deliver('A plan authorization was answered on the board. Check the recorded board state and continue within your current sandbox.', 'plan');
        return;
      }
      this.log.info('late permission answer dropped', { run_id: this.run_id });
      return;
    }
    if (key) this.answered.add(key);
    const text = a.answer != null ? String(a.answer) : a.decision ?? '';
    const by = a.answered_by?.name ?? 'a teammate';
    this.#deliver(`Your question${a.ask_id ? ` (${a.ask_id})` : ''} was answered:\n${this.#wrap(`card:${this.key} answer by ${by}`, text)}`, 'answer');
  }

  onContextUpdate(u) {
    if (u.team_context) this.teamContext = u.team_context;
    if (u.delta) this.overlapDelta = u.delta;
  }

  // ── snapshots ─────────────────────────────────────────────────────────────
  snapshotNow({ push = true, ref = snapshotRef(this.key, this.fence), why = 'checkpoint', emitAs = 'snapshot' } = {}) {
    if (this.windowsStopUnconfirmed) return Promise.resolve(null);
    const job = this.snapshotChain.then(async () => {
      if (this.windowsStopUnconfirmed) return null;
      this.lastSnapshotMono = this.clock.mono();
      let res;
      try {
        res = await gitSnapshot({ wt: this.worktree, ref, push: push && this.sup.connected, message: `board snapshot ${this.key} r${this.fence} ${why}`, gitleaks: this.sup.opts.gitleaks });
      } catch (e) {
        this.log.warn('snapshot failed', { run_id: this.run_id, err: e.message });
        return null;
      }
      if (res.status === 'unchanged') return res;
      if (res.status === 'local') {
        this.unpushed = { sha: res.sha, ref };
        res = { ...res, status: 'push_failed', reason: push ? 'offline: kept locally, will push on reconnect' : 'gate closed: kept locally' };
      } else if (res.status === 'push_failed') this.unpushed = { sha: res.sha, ref };
      else if (res.status === 'pushed') this.unpushed = null;
      if (emitAs === 'snapshot') this.emit({ kind: 'snapshot', status: res.status, sha: res.sha, ref: res.ref, reason: res.reason ? redact(res.reason, this.worktree) : null });
      return res;
    });
    this.snapshotChain = job.catch(() => null);
    return job;
  }

  #retryPush() {
    const u = this.unpushed;
    if (!u) return;
    this.snapshotChain = this.snapshotChain.then(async () => {
      if (this.windowsStopUnconfirmed) return;
      const res = await pushRef(this.worktree, u.sha, u.ref);
      if (res.status === 'pushed') {
        this.unpushed = null;
        this.emit({ kind: 'snapshot', status: 'pushed', sha: u.sha, ref: u.ref, reason: null });
      }
    }).catch(() => null);
  }

  onReconnect() {
    if (this.unpushed && this.gateOpen) this.#retryPush();
    if (this.backend?.oneTurn && !this.backend.alive() && this.pending.length) this.#resumePending();
  }

  #quiescent() {
    for (const t of this.streamTools.values()) if (WRITE_TOOLS.has(t.name)) return false;
    return true;
  }

  // ── hooks ─────────────────────────────────────────────────────────────────
  #relPath(p) {
    if (typeof p !== 'string' || !p) return null;
    return filterPath(realish(p.startsWith('/') ? p : `${this.worktree}/${p}`), this.worktree);
  }

  #summary(name, input = {}) {
    let s;
    if (name === 'Bash') s = String(input.command ?? '');
    else if (input.file_path || input.notebook_path) s = this.#relPath(input.file_path ?? input.notebook_path) ?? '(outside repo)';
    else if (input.pattern) s = String(input.pattern);
    else s = name;
    return clip(redact(s, this.worktree), 120);
  }

  async hook(event, payload = {}) {
    switch (event) {
      case 'start': return this.#hookStart(payload);
      case 'prompt': return this.#hookPrompt();
      case 'pre': return this.#hookPre(payload);
      case 'post': return this.#hookPost(payload, true);
      case 'postfail': return this.#hookPost(payload, false);
      case 'precompact':
        this.snapshotNow({ why: 'pre-compact' });
        this.fact('compacted', {});
        return PROCEED;
      case 'stop': return this.#hookStop(payload);
      case 'stopfail':
        this.fact('error', { first_line: clip(redact(String(payload.error ?? payload.error_details ?? 'stop failure').split('\n')[0], this.worktree), 300) });
        return PROCEED;
      case 'substop':
        if (payload.last_assistant_message) this.fact('subagent', { summary: clip(redact(String(payload.last_assistant_message), this.worktree), 500) });
        return PROCEED;
      default:
        throw err('VALIDATION', `unknown hook event ${event}`);
    }
  }

  #hookStart(payload) {
    this.sessionStartSeen = true;
    const source = payload.source ?? 'startup';
    this.fact('session', { session_id: String(payload.session_id ?? this.sessionId ?? ''), event: source });
    const parts = [];
    const seed = this.offer?.seed ?? {};
    const str = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
    const prev = seed.prev_run_n != null ? `r${seed.prev_run_n}` : 'the previous run';
    if (source === 'startup') {
      if (seed.handover_md) {
        parts.push(`You are run r${this.fence} of card ${this.key}.${seed.prev_run_n != null ? ` Run r${seed.prev_run_n} ended; its handover follows.` : ''}`);
        parts.push(this.#wrap(`card:${this.key} handover from ${prev}`, seed.handover_md));
      }
      if (seed.answer) parts.push(`Answer to ${prev}'s question:\n${this.#wrap(`card:${this.key} answer`, str(seed.answer))}`);
      if (seed.review) parts.push(`Review requested changes:\n${this.#wrap(`card:${this.key} review`, str(seed.review))}`);
      for (const c of seed.comments ?? []) parts.push(`Comment on card ${this.key}:\n${this.#wrap(`card:${this.key} comment by ${c.author_name ?? 'a teammate'}`, c.body)}`);
    } else if (source === 'compact') {
      parts.push(this.#handoverText());
    }
    if (this.teamContext?.text) parts.push(this.#teamContextText());
    const ctx = parts.filter(Boolean).join('\n\n');
    return { stdout: ctx ? hso('SessionStart', { additionalContext: ctx }) : {}, exit_code: 0 };
  }

  #handoverText() {
    const doc = mergeHandover({ card: { key: this.key, title: this.offer?.title ?? '', repo_id: this.repo_id }, narrative: this.narrative });
    return `Your current handover (re-injected after compaction):\n${this.#wrap(`card:${this.key} handover (this run)`, renderMarkdown(doc, { now_ms: this.clock.wall() }))}`;
  }

  #teamContextText() {
    return this.#wrap('board:team context (other runs in this repo)', this.teamContext.text);
  }

  #hookPrompt() {
    const text = this.teamContext?.text ? this.#teamContextText() : '';
    return { stdout: text ? hso('UserPromptSubmit', { additionalContext: text }) : {}, exit_code: 0 };
  }

  async #hookPre(payload) {
    if (this.endedNormally) return deny('this run has ended (the card was completed or released); no more tools');
    if (this.fenced) return deny('this card was taken over; this run is fenced');
    let g = this.gateState();
    if (!g.open && g.reason === 'await_ack') {
      this.sup.sendHbNow();
      const until = Date.now() + Math.min(g.wait_ms ?? 0, 20000);
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 250));
        g = this.gateState();
        if (g.open || g.reason !== 'await_ack') break;
      }
      if (!g.open && g.reason === 'await_ack') g = { open: true, reason: 'ok' };   // rule 5: then proceed under rule 1
    }
    if (!g.open) return deny(`board offline gate is closed (${g.reason}); tools are paused until the board confirms this run`);
    if (this.localState !== 'running' || this.ending) return deny('this run is stopping');
    const name = payload.tool_name ?? '';
    const input = payload.tool_input ?? {};
    const cwd = payload.cwd || this.worktree;
    if (FILE_TOOLS.has(name)) {
      const cands = [];
      if (input.file_path != null) cands.push(input.file_path);
      if (input.notebook_path != null) cands.push(input.notebook_path);
      if (name === 'Glob' || name === 'Grep') {
        if (input.path != null) cands.push(input.path);
        if (name === 'Glob' && input.pattern != null) cands.push(globBase(input.pattern));
        if (name === 'Grep' && input.glob != null && /^[/~]|\.\./.test(input.glob)) cands.push(globBase(input.glob));
      }
      for (const p of cands) {
        if (!confine(String(p), { cwd, rootReal: this.worktree }).ok) return deny(`${name} outside this run's worktree is not allowed`);
      }
    }
    if (name === 'Bash') {
      const bad = checkGitPush(input.command ?? '', this.branch);
      if (bad) return deny(bad);
    }
    const bt = name === 'Bash' && Number.isFinite(input.timeout) ? input.timeout : undefined;
    this.toolInFlight = { name, summary: this.#summary(name, input), mono: this.clock.mono(), bash_timeout_ms: bt };
    this.fact('tool_start', { name, summary: this.toolInFlight.summary, ...(bt ? { bash_timeout_ms: bt } : {}) });
    this.activity('tool_start');
    return PROCEED;
  }

  async #hookPost(payload, ok) {
    const name = payload.tool_name ?? '';
    const input = payload.tool_input ?? {};
    const t = this.toolInFlight;
    const duration = t ? Math.round(this.clock.mono() - t.mono) : null;
    this.toolInFlight = null;
    this.callsSinceHandover++;
    this.fact('tool_end', { name, ok, ...(duration != null ? { duration_ms: duration } : {}) });
    if (!ok) {
      const first = String(payload.error ?? payload.tool_response?.error ?? payload.tool_response ?? 'tool failed').split('\n')[0];
      this.fact('error', { first_line: clip(redact(first, this.worktree), 300) });
    }
    const op = { Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write', Read: 'read' }[name];
    if (op) {
      const rel = this.#relPath(input.file_path ?? input.notebook_path);
      if (rel) this.fact('file', { path: rel, op });
    }
    if (name === 'Bash') await this.#bashFacts(input, payload, ok, duration);
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      this.fact('plan', { items: input.todos.slice(0, 50).map((x) => ({ text: clip(redact(String(x.content ?? ''), this.worktree), 300), status: planStatus(x.status) })) });
    }
    if ((name === 'TaskCreate' || name === 'TaskUpdate') && ok) this.#taskPlan(name, input, payload.tool_response);
    this.activity('tool_end');

    const ctx = [];
    const delivered = [];
    for (const p of this.pending) { ctx.push(p.text); if (p.comment_ids) delivered.push(...p.comment_ids); }
    this.pending = [];
    if (delivered.length) this.emit({ kind: 'comment.delivered', comment_ids: delivered, via: 'post_tool_use' });
    if (this.overlapDelta) { ctx.push(this.#wrap('board:overlap update', typeof this.overlapDelta === 'string' ? this.overlapDelta : JSON.stringify(this.overlapDelta))); this.overlapDelta = null; }
    const now = this.clock.mono();
    const stale = now - this.lastHandoverMono > NARRATIVE_NUDGE_MS || this.callsSinceHandover > NARRATIVE_NUDGE_CALLS;
    if (stale && now - this.nudgedAt > NARRATIVE_NUDGE_MS) {
      this.nudgedAt = now;
      ctx.push('Board reminder: your handover narrative is getting old. Update it with board_write_handover (done, hypothesis, next).');
    }
    if (now - this.lastSnapshotMono >= SNAPSHOT_EVERY_MS && this.#quiescent()) this.snapshotNow({ why: 'periodic' });
    const text = ctx.join('\n\n');
    const event = ok ? 'PostToolUse' : 'PostToolUseFailure';
    return { stdout: text ? hso(event, { additionalContext: text }) : {}, exit_code: 0 };
  }

  // Plan mirror for the CLI's task list (TaskCreate/TaskUpdate, which replaced
  // TodoWrite): keep id → {text, status} and send the whole list as a plan fact.
  #taskPlan(name, input, resp) {
    let id;
    if (name === 'TaskCreate') {
      const r = resp && typeof resp === 'object' ? resp : {};
      id = r.task?.id ?? r.id ?? /#?(\d+)/.exec(typeof resp === 'string' ? resp : JSON.stringify(resp ?? ''))?.[1] ?? `n${this.tasks.size + 1}`;
      this.tasks.set(String(id), { text: String(input.subject ?? input.description ?? ''), status: 'todo' });
    } else {
      id = String(input.taskId ?? '');
      if (!id) return;
      if (input.status === 'deleted') this.tasks.delete(id);
      else {
        const t = this.tasks.get(id) ?? { text: `task ${id}`, status: 'todo' };
        if (input.subject) t.text = String(input.subject);
        if (input.status) t.status = planStatus(input.status);
        this.tasks.set(id, t);
      }
    }
    this.fact('plan', { items: [...this.tasks.values()].slice(0, 50).map((t) => ({ text: clip(redact(t.text, this.worktree), 300), status: t.status })) });
  }

  async #bashFacts(input, payload, ok, duration, current = () => !this.ended) {
    const cmd = String(input.command ?? '');
    const patterns = (this.sup.policy.repos?.[this.repo_id]?.test_patterns ?? []).map((p) => new RegExp(p));
    if ([...DEFAULT_TEST_PATTERNS, ...patterns].some((re) => re.test(cmd))) {
      const r = payload.tool_response ?? {};
      const outText = typeof r === 'string' ? r : [r.stdout, r.stderr].filter(Boolean).join('\n');
      const exitM = /Exit code (\d+)/.exec(typeof r === 'string' ? r : String(payload.error ?? ''));
      const tail = String(outText ?? '').split('\n').slice(-20).join('\n');
      this.fact('command', { cmd: clip(redact(cmd, this.worktree), 300), exit: ok ? 0 : (exitM ? Number(exitM[1]) : 1), ...(duration != null ? { duration_ms: duration } : {}), tail: redact(tail, this.worktree) });
    }
    if (/\bgit\b.*\b(commit|push|merge|rebase|reset|checkout|switch)\b/.test(cmd)) {
      const g = await gitFacts(this.worktree);
      if (!current()) return;
      this.fact('git', g);
    }
  }

  #hookStop(payload) {
    if (payload.last_assistant_message) this.fact('message', { text: this.#text(payload.last_assistant_message, 500) });
    this.snapshotNow({ why: 'stop' });
    const s = this.turnSignals;
    if (this.ending || this.completed || this.released || s.complete || s.ask || s.release) return PROCEED;
    return {
      stdout: hso('Stop', { additionalContext: 'Board reminder: this card is not finished. If you are done, attach evidence and call board_complete; if you need a human, call board_ask_human; if you cannot continue, call board_release.' }),
      exit_code: 0,
    };
  }

  // ── tools (board-mcp) ─────────────────────────────────────────────────────
  hello() {
    if (this.ended || this.ending || this.completed || this.released) throw err('RUN_ENDED', 'this run has ended');
    if (this.fenced) throw err('FENCED', 'this run was taken over');
    return { run_id: this.run_id, card_id: this.card_id, key: this.key, fence: this.fence, repo_id: this.repo_id, tools: this.sup.mcpTools };
  }

  initialPrompt(prompt) {
    if (this.offer.ai == null || this.offer.ai === 'claude') return prompt;
    const context = this.#hookStart({ source: 'startup' }).stdout?.hookSpecificOutput?.additionalContext;
    return [prompt, context, this.offer.require_plan_approval
      ? 'Your native shell is read-only. Declare your plan and end this turn while its recorded human authorization is pending. Answer text cannot authorize edits; the runner starts a later editable turn only after a recorded allow.' : null].filter(Boolean).join('\n\n');
  }

  // Agent text bound for the board. The nonce never leaves: echoed back in a
  // read-tool result it would let this run's own text forge a closing tag.
  #text(s, n) {
    return clip(redact(String(s ?? ''), this.worktree).replaceAll(this.nonce, '[nonce]'), n);
  }

  #wrap(source, text) {
    return untrusted(source, text, this.nonce);
  }

  // Board text in read-tool results is data, like the seed (L5): every
  // human- or run-written string is enveloped; ids, enums and ages are not.
  #wrapCard(r) {
    const key = r?.card?.key ?? this.key;
    const w = (what, s) => (typeof s === 'string' ? this.#wrap(`card:${key} ${what}`, s) : s);
    // A card an integration created says so (D42): its text came from outside the team.
    const via = r?.card?.labels?.find?.((l) => typeof l === 'string' && /^via:[a-z0-9-]{2,32}$/.test(l))?.slice(4);
    const v = via ? ` via ${via}` : '';
    return {
      ...r,
      card: r.card && { ...r.card, title: w(`title${v}`, r.card.title), body: w(`body${v}`, r.card.body) },
      acceptance: w('acceptance', r.acceptance),
      handover_md: w('handover', r.handover_md),
      open_asks: (r.open_asks ?? []).map((a) => ({ ...a, text: w('open ask', a.text) })),
      comments: (r.comments ?? []).map((c) => ({ ...c, body: w(`comment by ${c.author_name ?? 'a teammate'}`, c.body) })),
    };
  }

  // Paths, reasons and owner names in overlap results come from other runs
  // and members: data, enveloped like card text.
  #wrapOverlaps(r) {
    const ownership = (p) => p && ({ ...p,
      ...(p.author ? { author: { ...p.author, name: this.#wrap(`ownership:${p.card_id} participant`, p.author.name) } } : {}),
      paths: (p.paths ?? []).map((s) => this.#wrap(`ownership:${p.card_id} reported path`, s)) });
    return {
      ...r,
      ...(r.ownership ? { ownership: ownership(r.ownership) } : {}),
      ...(r.ownership_intents ? { ownership_intents: r.ownership_intents.map(ownership) } : {}),
      ...(r.ownership_overlaps ? { ownership_overlaps: r.ownership_overlaps.map(ownership) } : {}),
      overlaps: (r?.overlaps ?? []).map((o) => {
        const w = (what, s) => (typeof s === 'string' ? this.#wrap(`overlap:${o.other_key ?? 'card'} ${what}`, s) : s);
        return {
          ...o,
          other_owner: w('owner', o.other_owner),
          reasons: Array.isArray(o.reasons) ? o.reasons.map((x) => w('reason', x)) : o.reasons,
          paths: Array.isArray(o.paths) ? o.paths.map((x) => w('path', x)) : o.paths,
        };
      }),
    };
  }

  async tool(name, args = {}, ctx = {}) {
    if (this.endedNormally || this.ended || this.ending || this.completed || this.released) throw err('RUN_ENDED', 'this run has ended');
    if (this.fenced) throw err('FENCED', 'this card was taken over');
    if (name === 'approval') {
      if (this.backend?.oneTurn) throw err('NOT_AVAILABLE', 'Codex interactive tool approvals are unavailable');
      return this.#approval(args, ctx);
    }
    if (MCP_OUTBOX_TOOLS[name]) return this.#outboxTool(name, args);
    switch (name) {
      case 'board_send_message':
        return this.#wrapMessages(await this.sup.rpc(this, name, { ...args, body: this.#text(args.body, 4000) }));
      case 'board_list_messages': {
        const result = await this.sup.rpc(this, name, args);
        const receipts = (result.inbox ?? []).map((m) => ({ receipt_id: m.delivery.receipt_id, receipt_token: m.delivery.receipt_token }));
        if (receipts.length) {
          // Host receipt is recorded only after the response reaches this
          // live supervisor. The server rechecks current socket/run/fence.
          const accepted = await this.sup.rpc(this, 'runner_messages_received', { receipts });
          for (const m of result.inbox) {
            const receipt = accepted.receipts?.find((r) => r.message_id === m.id);
            if (!receipt || !['received', 'acknowledged'].includes(receipt.state)) throw err('INTERNAL', 'host receipt was not confirmed');
            m.delivery.state = receipt.state;
          }
        }
        return this.#wrapMessages(result);
      }
      case 'board_ack_message':
        return this.sup.rpc(this, name, args);
      case 'board_read_packet':
        return this.#wrapPacket(await this.sup.rpc(this, name, args));
      case 'board_write_packet': {
        const p = args.data ?? {};
        const data = { ...p, brief: this.#text(p.brief, 4000), progress: this.#text(p.progress, 4000), nextAction: this.#text(p.nextAction, 2000),
          decisions: Array.isArray(p.decisions) ? p.decisions.map((s) => this.#text(s, 500)) : p.decisions,
          reportedChecks: Array.isArray(p.reportedChecks) ? p.reportedChecks.map((s) => this.#text(s, 500)) : p.reportedChecks,
          artifacts: Array.isArray(p.artifacts) ? p.artifacts.map((a) => a?.kind === 'path' ? { ...a, path: this.#text(a.path, 1024) } : a) : p.artifacts };
        return this.#wrapPacket(await this.sup.rpc(this, name, { ...args, data }));
      }
      case 'board_get_card': return this.#wrapCard(await this.sup.rpc(this, 'board_get_card', args.key ? { key: String(args.key) } : {}));
      case 'board_list_cards': {
        const r = await this.sup.rpc(this, 'board_list_cards', { ...(args.column ? { column: String(args.column) } : {}), ...(args.mine != null ? { mine: !!args.mine } : {}) });
        return { ...r, cards: (r.cards ?? []).map((c) => ({ ...c, title: this.#wrap(`card:${c.key} title`, c.title) })) };
      }
      case 'board_ask_human': {
        const r = await this.sup.rpc(this, 'board_ask_human', { kind: args.kind, text: this.#text(args.text, 2000), ...(Array.isArray(args.options) ? { options: args.options.map((o) => this.#text(o, 200)) } : {}) });
        this.turnSignals.ask = true;
        return r;
      }
      case 'board_attach_evidence': {
        const ref = this.#text(args.ref, 500);
        if (this.backend?.oneTurn && args.kind === 'commit') await this.sup.publishCommit(this, ref);
        return this.sup.rpc(this, 'board_attach_evidence', { kind: args.kind, ref, summary: this.#text(args.summary, 1000), ...(args.result ? { result: args.result } : {}) });
      }
      case 'board_complete': {
        const r = await this.sup.rpc(this, 'board_complete', { summary: this.#text(args.summary, 2000), evidence_ids: (args.evidence_ids ?? []).map(String) });
        this.turnSignals.complete = true;
        this.completed = true;
        return r;
      }
      case 'board_release': {
        this.flushFacts();
        await this.snapshotNow({ why: 'release' });
        const r = await this.sup.rpc(this, 'board_release', { reason: this.#text(args.reason, 500), requeue: !!args.requeue });
        this.turnSignals.release = true;
        this.released = true;
        this.releaseRequeued = r.state === 'queued';
        return r;
      }
      case 'board_declare_plan': {
        const paths = (args.paths ?? []).map((p) => filterPath(String(p), this.worktree)).filter((p) => p && p !== '.');
        const current = await this.sup.rpc(this, 'board_check_overlap', {});
        return this.#wrapOverlaps(await this.sup.rpc(this, 'board_declare_plan', { summary: this.#text(args.summary, 1000), paths,
          ...(current.ownership?.generation ? { ownership_generation: current.ownership.generation } : {}),
          ...(args.areas ? { areas: args.areas.map((a) => this.#text(a, 100)) } : {}) }));
      }
      case 'board_check_overlap': return this.#wrapOverlaps(await this.sup.rpc(this, 'board_check_overlap', {}));
      case 'board_recall': {
        const params = {};
        if (args.paths) params.paths = args.paths.map((p) => filterPath(String(p), this.worktree)).filter(Boolean);
        if (args.query) params.query = this.#text(args.query, 500);
        if (args.kinds) params.kinds = args.kinds.map(String);
        const r = await this.sup.rpc(this, 'board_recall', params);
        return { ...r, memories: (r.memories ?? []).map((m) => ({ ...m, body: this.#wrap(`memory:${m.card_key ?? 'repo'} ${m.kind}`, m.body) })) };
      }
      case 'board_create_card':
        return this.sup.rpc(this, 'board_create_card', {
          title: this.#text(args.title, 200),
          ...(args.body ? { body: this.#text(args.body, 20_000) } : {}),
          ...(args.acceptance ? { acceptance: this.#text(args.acceptance, 10_000) } : {}),
        });
      case 'board_add_lesson':
        return this.sup.rpc(this, 'board_add_lesson', { text: this.#text(args.text, 500), ...(args.evidence ? { evidence: this.#text(args.evidence, 1000) } : {}) });
      default:
        throw err('VALIDATION', `unknown tool ${name}`);
    }
  }

  #wrapPacket(result) {
    const p = result.packet;
    if (!p) return result;
    const w = (label, s) => typeof s === 'string' ? this.#wrap(`packet:${p.version} ${label}`, s) : s;
    return { ...result, packet: { ...p, author: { ...p.author, name: w('author', p.author.name) },
      data: { ...p.data, brief: w('brief', p.data.brief), progress: w('progress', p.data.progress), nextAction: w('next action', p.data.nextAction),
        decisions: p.data.decisions.map((s) => w('decision', s)), reportedChecks: p.data.reportedChecks.map((s) => w('reported check', s)),
        artifacts: p.data.artifacts.map((a) => a.kind === 'path' ? { ...a, path: w('reported path', a.path) } : a) },
      evidence: p.evidence.map((e) => ({ ...e, summary: w('evidence summary', e.summary), ref: w('evidence ref', e.ref) })) } };
  }

  #wrapMessages(result) {
    const wrap = (m) => ({ ...m, body: this.#wrap(`message:${m.id} reported body`, m.body),
      author: { ...m.author, name: this.#wrap(`message:${m.id} author`, m.author.name) } });
    return { ...result, ...(result.message ? { message: wrap(result.message) } : {}),
      ...(result.inbox ? { inbox: result.inbox.map(wrap) } : {}), ...(result.history ? { history: result.history.map(wrap) } : {}),
      ...(result.peers ? { peers: result.peers.map((p) => ({ ...p, name: this.#wrap(`peer:${p.run_id} owner`, p.name), title: this.#wrap(`peer:${p.run_id} task`, p.title) })) } : {}) };
  }

  async #outboxTool(name, args) {
    const kind = MCP_OUTBOX_TOOLS[name];
    let body;
    if (kind === 'status.update') body = { kind, summary: this.#text(args.summary, 140) };
    else if (kind === 'progress.append') body = { kind, text: this.#text(args.text, 500) };
    else if (kind === 'comment.create') body = { kind, text: this.#text(args.text, 4000), reply_to: args.reply_to ?? null };
    else {
      const patch = args.patch ?? {};
      const bad = Object.keys(patch).filter((k) => !AGENT_WRITABLE.includes(k));
      if (bad.length) throw err('VALIDATION', `not writable: ${bad.join(', ')}`);
      const clean = {};
      for (const [k, v] of Object.entries(patch)) {
        clean[k] = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? this.#text(x, 4000) : { ...x, text: this.#text(x?.text, 300) })) : v == null ? null : this.#text(v, 4000);
      }
      try { this.narrative = applyPatch(this.narrative, clean, { at_ms: this.clock.wall() }); } catch (e) { throw err('VALIDATION', e.message); }
      this.lastHandoverMono = this.clock.mono();
      this.callsSinceHandover = 0;
      body = { kind, patch: clean };
    }
    const entry = this.emit(body);
    if (kind === 'handover.write') {
      this.snapshotNow({ why: 'handover' });
      if (this.handover && !this.handover.done) setTimeout(() => this.#finishHandover('written'), 0);
      // {version} is the hub's handover version from the ack; without one it is
      // queued (delivered later, the hub assigns the version then).
      if (entry?.seq && this.sup.connected) {
        const a = await this.sup.waitAck(entry.seq, 5000);
        if (a.acked && a.version != null) return { ok: true, version: a.version };
      }
      return { ok: true, queued: true };
    }
    return { ok: true, ...(this.sup.connected && !this.postFence ? {} : { queued: true }) };
  }

  // The CLI cancelled a held approval: deny locally and withdraw it on the hub.
  cancel(connId, reqId) {
    const key = `${connId}:${reqId}`;
    const p = this.approvals.get(key);
    if (!p) return;
    this.approvals.delete(key);
    p.cancelled = true;
    this.log.info('approval cancelled by the CLI', { run_id: this.run_id });
    if (p.prid) this.#withdrawApproval(p.prid);
    p.resolve({ behavior: 'deny', message: 'Permission prompt was cancelled.' });
  }

  #withdrawApproval(prid) {
    this.sup.rpc(this, 'approval_cancel', { permission_request_id: prid }).catch((e) => {
      this.log.info('approval withdraw not delivered', { run_id: this.run_id, code: e.code });
    });
  }

  async #waitStreamTool(id, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (this.streamTools.has(id)) return this.streamTools.get(id);
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.streamTools.get(id) ?? null;
  }

  async #approval(args, ctx) {
    const toolName = String(args.tool_name ?? '');
    const input = args.input && typeof args.input === 'object' ? args.input : {};
    const tuid = args.tool_use_id ? String(args.tool_use_id) : null;
    // A real CLI permission prompt is tied to an in-flight tool_use of that tool;
    // a model calling mcp__board__approval itself is not (and can never allow).
    const st = tuid ? await this.#waitStreamTool(tuid, 1500) : null;
    const direct = !st || st.name !== toolName || toolName === 'mcp__board__approval' || toolName.startsWith('mcp__board__');
    const summary = this.#text(`${toolName} ${JSON.stringify(input)}`, 300);
    if (direct) {
      try {
        await this.sup.rpc(this, 'board_ask_human', { kind: 'question', text: this.#text(`The agent asked for permission: ${summary}`, 2000) });
      } catch { /* one open ask already, or offline */ }
      return { behavior: 'deny', message: 'Calling approval directly cannot grant anything. Your request was posted to the board as a question.' };
    }
    if (this.runAllow.has(runAllowKey(toolName, input))) return { behavior: 'allow' };
    if (!this.gateOpen) return { behavior: 'deny', message: 'board offline gate is closed' };
    const key = `${ctx.connId}:${ctx.reqId}`;
    return new Promise((resolve) => {
      const entry = {
        prid: null,
        cancelled: false,
        resolve,
        onAnswer: (a) => {
          if (!answererAllowed(this.sup.policy, this.repo_id, this.sup.memberId, a.answered_by)) {
            this.fact('message', { text: clip(`Permission answer from ${a.answered_by?.name ?? 'unknown'} ignored: not in this machine's approvals_from`, 500) });
            resolve({ behavior: 'deny', message: 'The answer came from someone this machine does not accept approvals from.' });
            return;
          }
          if (a.decision === 'allow') {
            if (a.scope === 'run') this.runAllow.add(runAllowKey(toolName, input));
            resolve({ behavior: 'allow' });
          } else resolve({ behavior: 'deny', message: `Denied on the board by ${a.answered_by?.name ?? 'a teammate'}.` });
        },
      };
      // Registered before the rpc so a cancel that races it is not lost.
      this.approvals.set(key, entry);
      this.sup.rpc(this, 'approval', { tool_name: toolName, input_summary: summary, ...(tuid ? { tool_use_id: tuid } : {}) }).then((r) => {
        entry.prid = r.permission_request_id;
        if (entry.cancelled) this.#withdrawApproval(entry.prid);
      }, (e) => {
        this.approvals.delete(key);
        resolve({ behavior: 'deny', message: `${e.code ?? 'INTERNAL'}: ${e.message}` });
      });
    });
  }
}
