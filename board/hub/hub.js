// The hub core: one single-writer queue per board, every state change is
// shared/states.js step() plus its effects in ONE SQLite transaction (CONTRACT
// §2, §10.3), the 1 s reaper on the hub monotonic clock (§11), in-memory lease
// liveness (D11), overlap recompute, notifications (N-rules) and the GitHub
// merge poll. Transports (HTTP, /ws/board, /ws/runner) call into this class.

import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { step, fromDb, toDb, ACTIVE, PLAN_APPROVAL_LABEL, EVENTS } from '../shared/states.js';
import { CARD_STATE } from '../shared/journal.js';
import {
  timerEvent, ORPHAN_NOTIFY_MS, OVERLAP_DEBOUNCE_MS, TICK_MAX_RATE_MS,
} from '../shared/liveness.js';
import { branchName, snapshotRef, RESTORE_BUMP } from '../shared/fence.js';
import { applyPatch, mergeHandover, renderMarkdown, syncAges, handoffMemoryText } from '../shared/handover.js';
import { computeOverlaps, overlapsFor, teamContextBlock, overlapDelta, kindOf } from '../shared/overlap.js';
import { applyRestoreBump } from '../shared/migrate.js';
import { FEED_KINDS, WS_CLOSE } from '../shared/protocol.js';
import { HubError, json } from './db.js';
import { mintRunToken } from './auth.js';
import { noGitHub, prNumberOf } from './github.js';
import { cardView, leaseView } from './views.js';
import { RateLimiter } from './ratelimit.js';

const TICK_EVERY_MS = 5_000;          // lease.tick heartbeat when nothing changed
const REQUEST_CACHE_MS = 10 * 60_000; // D8
const NOTIFY_KEEP = 500;
// Commands for an offline device: bounded. Anything older is re-derived from
// card state on its hello (stop for stale runs, handover_begin for handing_over).
const PENDING_CMD_TTL_MS = 30 * 60_000;
const PENDING_CMDS_MAX = 50;

export const defaultClock = { mono: () => performance.now(), wall: () => Date.now() };

export class Hub extends EventEmitter {
  constructor({ db, config, clock = defaultClock, log, github = noGitHub }) {
    super();
    this.db = db;
    this.config = config;
    this.clock = clock;
    this.log = log;
    this.github = github;
    this.bootMono = clock.mono();
    this.queues = new Map();
    this.inflight = new Set();
    this.post = [];
    this.live = new Map();          // run_id → lease memory (hub monotonic)
    this.runners = new Map();       // device_id → runner connection (ws-runner.js)
    this.browsers = new Set();      // browser connections (ws-board.js)
    this.offered = new Map();       // card_id → Set(device_id)
    this.pendingCmds = new Map();   // device_id → cmd frames for an offline device
    this.notifications = [];
    this.overlapDue = new Map();    // repo_id → due (mono)
    this.prStatus = new Map();      // card_id → PR status from the merge poll
    this.requestCache = new Map();  // `${member}|${request_id}` → {status, body, exp}
    this.tunnel = { ok: true, okSinceMono: this.bootMono };
    this.secret = config.secret ?? this.loadSecret();
    this.vaultKey = null;
    this.limiter = new RateLimiter({ now: () => this.mono(), limits: config.rateLimits });
  }

  // ── clocks ────────────────────────────────────────────────────────────────
  mono() { return this.clock.mono(); }
  wallMs() { return this.clock.wall(); }
  iso() { return new Date(this.clock.wall()).toISOString(); }
  uptime() { return this.mono() - this.bootMono; }
  ageOf(isoTime) { return isoTime == null ? null : Math.max(0, this.wallMs() - Date.parse(isoTime)); }

  // Integrations encryption key handed in by the desktop app (local mode, over
  // parentPort; D36). Held in memory only; set once.
  setVaultKey(buf) {
    if (this.vaultKey) throw new Error('vault key already set');
    if (!Buffer.isBuffer(buf) || buf.length !== 32) throw new Error('vault key must be 32 bytes');
    this.vaultKey = Buffer.from(buf);
    this.emit('vault-key');
  }

  loadSecret() {
    let s = this.db.meta('secret');
    if (!s) { s = randomBytes(32).toString('hex'); this.db.setMeta('secret', s); }
    return s;
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  boot() {
    const epoch = randomUUID();
    const marker = this.config.dbPath && this.config.dbPath !== ':memory:' ? `${this.config.dbPath}.restored` : null;
    const restored = this.config.restore || (marker && existsSync(marker));
    this.epoch = epoch;
    if (restored) {
      applyRestoreBump(this.db.raw, epoch, this.iso());
      this.journal({ board_id: null, actor_kind: 'system', kind: 'hub.restore_bump', payload: { bump: RESTORE_BUMP } });
      if (marker && existsSync(marker)) unlinkSync(marker);
      this.log.warn('restore bump applied', { hub_epoch: epoch });
    } else {
      this.db.setMeta('hub_epoch', epoch);
    }
    this.epoch = epoch;
    this.db.setMeta('booted_at', this.iso());
    const live = this.db.all(`SELECT id FROM cards WHERE run_state IN (${[...ACTIVE].map(() => '?').join(',')})`, ...ACTIVE);
    for (const { id } of live) {
      const r = this.apply(id, { type: 'hub_boot' }, { ctx: this.timerCtx() });
      if (!r.ok) this.log.warn('hub_boot step failed', { card_id: id, code: r.error.code });
    }
    this.log.info('hub booted', { hub_epoch: epoch, restored: !!restored, live_cards: live.length });
  }

  // ── single-writer queues ──────────────────────────────────────────────────
  withBoard(boardId, fn) {
    const prev = this.queues.get(boardId) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const settled = run.then(() => {}, () => {});
    this.queues.set(boardId, settled);
    this.inflight.add(settled);
    settled.then(() => {
      this.inflight.delete(settled);
      if (this.queues.get(boardId) === settled) this.queues.delete(boardId);
    });
    return run;
  }

  withCard(cardId, fn) {
    const row = this.db.get('SELECT board_id FROM cards WHERE id = ?', cardId);
    if (!row) return Promise.reject(new HubError('NOT_FOUND', 'card not found'));
    return this.withBoard(row.board_id, fn);
  }

  async idle() {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  // Transaction whose after-commit actions (sends, broadcasts) run only once
  // the outermost transaction committed.
  txn(fn) {
    const outer = this.db.depth === 0;
    const mark = this.post.length;
    try {
      const r = this.db.tx(fn);
      if (outer) this.flushPost();
      return r;
    } catch (e) {
      this.post.length = mark;
      throw e;
    }
  }

  later(fn) {
    if (this.db.depth === 0) fn(); else this.post.push(fn);
  }

  flushPost() {
    const list = this.post;
    this.post = [];
    for (const fn of list) {
      try { fn(); } catch (e) { this.log.error('after-commit action failed', { err: e }); }
    }
  }

  // ── lookups ───────────────────────────────────────────────────────────────
  card(id) { return this.db.get('SELECT * FROM cards WHERE id = ?', id); }
  cardByKey(boardId, key) { return this.db.get('SELECT * FROM cards WHERE board_id = ? AND key = ?', boardId, key); }
  run(id) { return id ? this.db.get('SELECT * FROM runs WHERE id = ?', id) : null; }
  latestRun(cardId) { return this.db.get('SELECT * FROM runs WHERE card_id = ? ORDER BY fence DESC LIMIT 1', cardId); }
  member(id) { return id ? this.db.get('SELECT * FROM members WHERE id = ?', id) : null; }
  activeMember(id) { return id ? this.db.get('SELECT * FROM members WHERE id = ? AND removed_at IS NULL', id) : null; }
  memberName(id) { return this.member(id)?.display_name ?? null; }
  board(id) { return this.db.get('SELECT * FROM boards WHERE id = ?', id); }
  repo(id) { return id ? this.db.get('SELECT * FROM repos WHERE id = ?', id) : null; }
  device(id) { return id ? this.db.get('SELECT * FROM devices WHERE id = ?', id) : null; }
  pendingDispatch(cardId) { return this.db.get("SELECT * FROM dispatches WHERE card_id = ? AND state = 'pending'", cardId); }
  lastDispatch(cardId) { return this.db.get('SELECT * FROM dispatches WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', cardId); }
  dispatchTarget(d) { return d ? d.target_member_id ?? d.dispatched_by : null; }
  assignees(cardId) { return this.db.all('SELECT member_id FROM card_assignees WHERE card_id = ?', cardId).map((r) => r.member_id); }
  labels(row) { return json(row.labels, []); }
  boardSettings(boardId) { return json(this.board(boardId)?.settings, {}); }
  openAsks(cardId) { return this.db.all("SELECT * FROM asks WHERE card_id = ? AND state = 'open'", cardId); }
  openPermissions(cardId) { return this.db.all("SELECT * FROM permission_requests WHERE card_id = ? AND state = 'open' ORDER BY created_at", cardId); }
  isAdmin(m) { return m && (m.role === 'owner' || m.role === 'admin'); }
  canWrite(m) { return !!m && m.role !== 'viewer'; }
  cardSpentCents(cardId) { return this.db.get('SELECT COALESCE(SUM(cost_cents), 0) AS s FROM runs WHERE card_id = ?', cardId).s; }

  // ── journal (P-1): append-only, same transaction as the change ─────────────
  /** {board_id? (else from card_id), card_id?, run_id?, actor_kind, actor_id?, kind, payload} */
  journal({ board_id, card_id = null, run_id = null, actor_kind = 'system', actor_id = null, kind, payload = {} }) {
    const board = board_id !== undefined ? board_id : this.db.get('SELECT board_id FROM cards WHERE id = ?', card_id)?.board_id ?? null;
    this.db.insert('journal', {
      board_id: board, card_id, run_id, at_hub: this.iso(), hub_epoch: this.epoch ?? null,
      actor_kind, actor_id, kind, payload: JSON.stringify(payload),
    });
  }

  // ── apply: step() + effects in one transaction ────────────────────────────
  /**
   * Must run inside the card's board queue. opts: {ctx, actor (member id),
   * device (device row), pre(res) (runs first inside the txn; may throw
   * HubError), extra (effect inputs such as the answer)}.
   * Returns step()'s result plus {row, run_id} or {ok:false, error}.
   */
  apply(cardId, event, { ctx = {}, actor = null, device = null, pre = null, extra = {} } = {}) {
    const row = this.card(cardId);
    if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: 'card not found' } };
    const card = fromDb(row);
    const res = step(card, event, ctx);
    if (!res.ok) return res;
    if (!res.effects.length && res.to === res.from && !pre) return { ...res, row };
    const env = { row, card, res, event, actor, device, extra, runId: row.active_run_id, newRunId: null };
    try {
      this.txn(() => {
        pre?.(res);
        this.writeCard(env);
        for (const e of res.effects) this.effect(e, env);
        this.cleanupAsks(env);
        this.journalTransition(env);
      });
    } catch (e) {
      if (e instanceof HubError) return { ok: false, error: { code: e.code, message: e.message, ...e.extra } };
      throw e;
    }
    return { ...res, row: this.card(cardId), run_id: env.newRunId ?? env.runId };
  }

  journalTransition(env) {
    const { row, res, event, actor, device } = env;
    const after = this.card(row.id);
    const state = {};
    for (const f of CARD_STATE) state[f] = after[f] ?? null;
    const src = EVENTS[event.type];
    this.journal({
      board_id: row.board_id, card_id: row.id, run_id: env.newRunId ?? env.runId ?? null,
      actor_kind: src === 'human' ? 'member' : src === 'runner' ? 'runner' : 'system',
      actor_id: src === 'human' ? actor : src === 'runner' ? device?.id ?? null : null,
      kind: 'card.transition',
      payload: { rule: res.rule, event: event.type, from: res.from, to: res.to, state, effects: res.effects.map((e) => e.type) },
    });
  }

  writeCard(env) {
    const { row, res, event, actor } = env;
    const next = toDb(res.card);
    const set = {
      run_state: next.run_state, column_name: next.column_name, blocked_kind: next.blocked_kind ?? null,
      fail_kind: next.fail_kind ?? null, resume_to: next.resume_to ?? null, pre_reconnect_state: next.pre_reconnect_state ?? null,
      handover_target: next.handover_target, handover_provenance: next.handover_provenance ?? null, updated_at: this.iso(),
    };
    if (res.to === 'failed') {
      if (event.type === 'run_failed' || event.type === 'release') set.fail_reason = event.reason ?? null;
      if (event.type === 'stop') { set.stopped_by = actor; set.fail_reason = null; }
    } else { set.fail_reason = null; set.stopped_by = null; }
    // The fence trigger fires on any SET of fence, so include it only when it moved.
    if (next.fence !== row.fence) set.fence = next.fence;
    if (res.effects.some((e) => e.type === 'state_changed')) {
      set.state_since = this.iso();
      set.version = row.version + 1;
      if (res.to === 'queued' && res.from !== 'queued') set.queued_nudged_at = null;
      if (res.from === 'orphaned' || res.to === 'orphaned') set.orphan_notified_at = null;
    }
    const keys = Object.keys(set);
    this.db.run(`UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k]), row.id);
    this.later(() => this.broadcastCard(row.id));
  }

  // Asks of an ended run can't be answered by that run; parked permission
  // requests only live while the card is parked.
  cleanupAsks(env) {
    const cardId = env.row.id;
    if (env.res.to !== 'parked') {
      this.db.run("UPDATE asks SET state = 'cancelled' WHERE card_id = ? AND state = 'open' AND run_id IN (SELECT id FROM runs WHERE ended_at IS NOT NULL)", cardId);
      this.db.run("UPDATE permission_requests SET state = 'cancelled' WHERE card_id = ? AND state = 'parked'", cardId);
    }
  }

  effect(e, env) {
    const { row, event, actor } = env;
    const cardId = row.id;
    const now = this.iso();
    switch (e.type) {
      case 'fence_bump':
        break;
      case 'release_path_locks':
        if (env.runId) this.db.run('DELETE FROM path_locks WHERE run_id = ?', env.runId);
        break;
      case 'dispatch_create': {
        this.db.run("UPDATE dispatches SET state = 'superseded' WHERE card_id = ? AND state = 'pending'", cardId);
        this.db.insert('dispatches', {
          request_id: e.request_id, card_id: cardId, dispatched_by: actor, target_member_id: e.target_member_id,
          backend: event.backend ?? 'claude_cli', needs_confirm: e.needs_confirm ? 1 : 0, seed: '{}', state: 'pending', created_at: now,
        });
        break;
      }
      case 'dispatch_cancel': {
        this.db.run('UPDATE dispatches SET state = ? WHERE card_id = ? AND state = \'pending\'', e.reason === 'declined' ? 'declined' : 'cancelled', cardId);
        this.later(() => this.withdrawOffers(cardId, null, e.reason));
        break;
      }
      case 'offer_to_runners':
        this.ensurePendingDispatch(cardId);
        this.later(() => this.sendOffers(cardId));
        break;
      case 'run_create':
        this.createRun(env);
        break;
      case 'lease_create': {
        const run = this.run(env.newRunId);
        this.db.insert('leases', { card_id: cardId, run_id: run.id, fence: run.fence, device_id: run.device_id, hub_epoch: this.epoch, last_hb_at: now });
        this.live.set(run.id, { hb_mono: this.mono(), child_alive: null, tool: null, activity_mono: null, wake_mono: null, runner_wake_mono: null });
        break;
      }
      case 'lease_release':
        this.db.run('DELETE FROM leases WHERE card_id = ?', cardId);
        this.db.run('UPDATE cards SET active_run_id = NULL WHERE id = ?', cardId);
        break;
      case 'run_end': {
        const runId = env.runId;
        if (!runId) break;
        this.db.run('UPDATE runs SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL', now, e.reason, runId);
        this.db.run("UPDATE asks SET state = 'cancelled' WHERE run_id = ? AND state = 'open' AND ? != 'parked'", runId, e.reason);
        this.db.run("UPDATE permission_requests SET state = ? WHERE run_id = ? AND state = 'open'", e.reason === 'parked' ? 'parked' : 'cancelled', runId);
        this.live.delete(runId);
        this.scheduleOverlap(row.repo_id, 0);
        break;
      }
      case 'runner_command': {
        const run = this.run(env.runId);
        if (!run) break;
        const frame = { type: 'cmd', cmd_id: randomUUID(), run_id: run.id, card_id: cardId, fence: e.fence, cmd: e.cmd, ...(e.wait_ms != null ? { wait_ms: e.wait_ms } : {}), reason: event.type };
        this.later(() => this.sendToDevice(run.device_id, frame, { queue: true }));
        break;
      }
      case 'deliver_answer':
        this.deliverAnswer(env);
        break;
      case 'notify':
        this.later(() => this.notify(e.rule, cardId, e.to));
        break;
      case 'notify_after':
        this.db.run('UPDATE cards SET orphan_notified_at = NULL WHERE id = ?', cardId);
        break;
      case 'notify_cancel':
        this.db.run('UPDATE cards SET orphan_notified_at = NULL WHERE id = ?', cardId);
        break;
      case 'mark_nudged':
        this.db.run('UPDATE cards SET queued_nudged_at = ? WHERE id = ?', now, cardId);
        break;
      case 'handover_freeze': {
        const h = this.latestHandover(cardId);
        const run = this.run(env.runId) ?? this.latestRun(cardId);
        this.feed(cardId, 'handover_frozen', { version: h?.version ?? null, snapshot_sha: run?.last_snapshot_sha ?? null }, { run });
        break;
      }
      case 'seed':
        this.writeSeed(cardId, e.from, env);
        break;
      case 'memory_write':
        this.writeHandoffMemory(cardId, e.provenance, env);
        break;
      case 'lease_mark_wake': {
        const lm = this.live.get(env.runId);
        if (lm) { lm.wake_mono = this.mono(); lm.post_wake = false; }
        this.db.run('UPDATE leases SET woke_at = ?, post_wake_activity = 0 WHERE card_id = ?', now, cardId);
        break;
      }
      case 'relabel_orphan': {
        // Append-only: a relabel row that feedEvent() joins onto the orphaned line.
        const ev = this.db.get("SELECT id FROM events WHERE card_id = ? AND kind = 'orphaned' ORDER BY id DESC LIMIT 1", cardId);
        if (ev) {
          this.db.insert('events', { card_id: cardId, run_id: env.runId ?? null, kind: 'orphan_relabel', payload: JSON.stringify({ event_id: ev.id, relabel: 'was asleep' }), actor: null, at_hub: now, delayed: 0 });
          this.journal({ board_id: row.board_id, card_id: cardId, run_id: env.runId ?? null, kind: 'feed.relabel', payload: { event_id: ev.id, relabel: 'was asleep' } });
          this.later(() => this.broadcastEvent(cardId, ev.id));
        }
        break;
      }
      case 'restart_state_timer':
        this.db.run('UPDATE cards SET state_since = ? WHERE id = ?', now, cardId);
        break;
      case 'follow_up': {
        const target = env.card.handover_target ?? {};
        this.later(() => this.followUp(cardId, e.event, target));
        break;
      }
      case 'assign':
        if (e.member_id) this.db.run('INSERT INTO card_assignees (card_id, member_id, role) VALUES (?, ?, ?) ON CONFLICT(card_id, member_id) DO UPDATE SET role = excluded.role', cardId, e.member_id, e.role);
        break;
      case 'feed': {
        const { type, kind, ...data } = e;
        this.feed(cardId, kind, data, { actor, run: this.run(env.newRunId ?? env.runId) });
        break;
      }
      case 'state_changed':
      case 'return_existing':
        break;
      default:
        this.log.warn('unknown effect', { type: e.type });
    }
  }

  createRun(env) {
    const { row, res, device } = env;
    const d = this.pendingDispatch(row.id);
    if (!d || !device) throw new HubError('CLAIM_LOST', 'no pending dispatch');
    const repo = this.repo(row.repo_id);
    const fence = res.card.fence;
    const id = randomUUID();
    const seed = json(d.seed, {});
    this.db.insert('runs', {
      id, card_id: row.id, fence, device_id: device.id, on_behalf_of: device.member_id, dispatched_by: d.dispatched_by,
      dispatch_request_id: d.request_id, backend: d.backend, repo_id: row.repo_id, base_ref: row.base_ref ?? repo.default_branch,
      branch: branchName(row.key, fence), snapshot_ref: snapshotRef(row.key, fence), started_at: this.iso(),
      seeded_from_handover: seed.handover_version ?? null,
    });
    this.db.run("UPDATE dispatches SET state = 'claimed', run_id = ? WHERE request_id = ?", id, d.request_id);
    this.journal({ board_id: row.board_id, card_id: row.id, run_id: id, actor_kind: 'runner', actor_id: device.id, kind: 'run.create', payload: { fence, device_id: device.id, branch: branchName(row.key, fence), snapshot_ref: snapshotRef(row.key, fence), dispatch_request_id: d.request_id } });
    this.db.run('UPDATE cards SET active_run_id = ? WHERE id = ?', id, row.id);
    env.newRunId = id;
    env.runId = id;
    this.later(() => this.withdrawOffers(row.id, device.id, 'claimed'));
    this.scheduleOverlap(row.repo_id, OVERLAP_DEBOUNCE_MS);
  }

  // Requeue rows without a dispatch_create (#5, #5b, #11, #24) re-offer the
  // card as a fresh dispatch with the same dispatcher and target (D19).
  ensurePendingDispatch(cardId) {
    if (this.pendingDispatch(cardId)) return;
    const last = this.lastDispatch(cardId);
    if (!last) return;
    this.db.insert('dispatches', {
      request_id: randomUUID(), card_id: cardId, dispatched_by: last.dispatched_by, target_member_id: last.target_member_id,
      backend: last.backend, needs_confirm: last.needs_confirm, seed: '{}', state: 'pending', created_at: this.iso(),
    });
  }

  writeSeed(cardId, from, env) {
    this.ensurePendingDispatch(cardId);
    const d = this.pendingDispatch(cardId);
    if (!d) return;
    const seed = { ...json(d.seed, {}), from };
    const a = env.extra.answer;
    if (from.includes('answer') && a) seed.answer = a.answer ?? (a.decision ? `${a.decision}${a.scope === 'run' ? ' (for this run)' : ''}` : null);
    if (from.includes('review') && env.event.comment) seed.review = env.event.comment;
    const h = this.latestHandover(cardId);
    if (h) seed.handover_version = h.version;
    this.db.run('UPDATE dispatches SET seed = ? WHERE request_id = ?', JSON.stringify(seed), d.request_id);
  }

  writeHandoffMemory(cardId, provenance, env) {
    const row = this.card(cardId);
    const run = this.run(env.runId) ?? this.latestRun(cardId);
    if (!run) return;
    const nar = json(this.latestHandover(cardId)?.sections, {});
    const repo = this.repo(row.repo_id);
    const body = handoffMemoryText({
      from_n: run.fence, taker: env.actor ? this.memberName(env.actor) : null, provenance,
      hypothesis: nar.hypothesis ?? null, next: nar.next ?? null,
    });
    this.db.insert('memories', {
      id: randomUUID(), org_id: repo.org_id, repo_id: row.repo_id, kind: 'handoff', body, card_id: cardId,
      author_member_id: env.actor, author_run_id: env.actor ? null : run.id, created_at: this.iso(), updated_at: this.iso(),
    });
  }

  deliverAnswer(env) {
    const a = env.extra.answer;
    if (!a) return;
    const run = this.run(env.runId);
    if (!run || run.ended_at) return;
    const frame = {
      type: 'answer', run_id: run.id, card_id: env.row.id, fence: env.res.card.fence,
      ...(a.ask_id ? { ask_id: a.ask_id } : {}), ...(a.permission_request_id ? { permission_request_id: a.permission_request_id } : {}),
      ...(a.decision ? { decision: a.decision, scope: a.scope ?? 'once' } : {}), ...(a.answer != null ? { answer: a.answer } : {}),
      answered_by: a.answered_by,
    };
    this.later(() => {
      if (this.sendToDevice(run.device_id, frame) && a.ask_id) this.db.run('UPDATE asks SET delivered_at = ? WHERE id = ?', this.iso(), a.ask_id);
    });
  }

  // Every answer of an unended run, re-sent on each runner hello: an answer
  // given while the runner was dark (or sent into a dying socket) is never
  // lost. The runner dedupes by ask_id / permission_request_id.
  answerFrames(run) {
    const row = this.card(run.card_id);
    const by = (id) => ({ member_id: id, name: this.memberName(id) });
    const asks = this.db.all("SELECT * FROM asks WHERE run_id = ? AND state = 'answered' ORDER BY answered_at", run.id)
      .map((a) => ({ type: 'answer', run_id: run.id, card_id: row.id, fence: row.fence, ask_id: a.id, answer: a.answer, answered_by: by(a.answered_by) }));
    const perms = this.db.all("SELECT * FROM permission_requests WHERE run_id = ? AND state IN ('allowed','denied') ORDER BY answered_at", run.id)
      .map((p) => ({ type: 'answer', run_id: run.id, card_id: row.id, fence: row.fence, permission_request_id: p.id, decision: p.state === 'allowed' ? 'allow' : 'deny', scope: p.scope ?? 'once', answered_by: by(p.answered_by) }));
    return [...asks, ...perms];
  }

  // Trusted @claude comments to the live run (the runner acks with outbox
  // comment.delivered). Undelivered ones also ride the next offer's seed.
  deliverComments(cardId) {
    const row = this.card(cardId);
    const run = this.run(row?.active_run_id);
    if (!run || run.ended_at) return false;
    const comments = this.db.all("SELECT * FROM comments WHERE card_id = ? AND for_agent = 1 AND trusted = 1 AND delivered_at IS NULL AND source != 'agent' ORDER BY created_at, rowid", cardId);
    if (!comments.length) return false;
    return this.sendToDevice(run.device_id, {
      type: 'comment.deliver', run_id: run.id, card_id: cardId, fence: row.fence,
      comments: comments.map((c) => ({ comment_id: c.id, author_name: this.memberName(c.author_member_id), body: c.body, created_age_ms: this.ageOf(c.created_at) })),
    });
  }

  async followUp(cardId, ev, target) {
    return this.withCard(cardId, () => {
      const by = target.by ?? target.member_id ?? null;
      const actor = this.member(by);
      let event;
      if (ev.type === 'redispatch') event = { type: 'redispatch', request_id: randomUUID(), target_member_id: ev.target_member_id ?? null, by };
      else event = { type: 'take_myself', by: target.member_id ?? by };
      const row = this.card(cardId);
      const ctx = { can_write: true, needs_confirm: event.type === 'redispatch' ? this.needsConfirm(by, event.target_member_id ?? by, row.repo_id) : false };
      const r = this.apply(cardId, event, { ctx, actor: actor?.id ?? null });
      if (!r.ok) this.log.warn('follow_up failed', { card_id: cardId, code: r.error.code });
    });
  }

  // ── feed + notifications ──────────────────────────────────────────────────
  feed(cardId, kind, data = {}, { actor = null, run = null, device = null, seq = null, delayed = false } = {}) {
    const info = this.db.insert('events', {
      card_id: cardId, run_id: run?.id ?? null, fence: run?.fence ?? null, device_id: device, seq, kind,
      payload: JSON.stringify(data), actor, at_hub: this.iso(), delayed: delayed ? 1 : 0,
    });
    const id = Number(info.lastInsertRowid);
    this.later(() => this.broadcastEvent(cardId, id));
    return id;
  }

  recipients(cardId, roles) {
    const out = new Set();
    const row = this.card(cardId);
    if (roles.includes('dispatcher')) {
      const run = this.run(row.active_run_id) ?? this.latestRun(cardId);
      const d = this.pendingDispatch(cardId) ?? this.lastDispatch(cardId);
      if (run?.dispatched_by) out.add(run.dispatched_by);
      else if (d?.dispatched_by) out.add(d.dispatched_by);
    }
    if (roles.includes('assignees')) for (const m of this.assignees(cardId)) out.add(m);
    return [...out];
  }

  // N-rules (design §5.2): failed/blocked immediately, parked once, orphaned
  // after ≥ 10 min orphaned. Delivery channels are later phases; this emits.
  notify(rule, cardId, roles) {
    const row = this.card(cardId);
    const n = { id: randomUUID(), rule, card_id: cardId, key: row?.key, board_id: row?.board_id, to: this.recipients(cardId, roles), at: this.iso() };
    this.notifications.push(n);
    if (this.notifications.length > NOTIFY_KEEP) this.notifications.splice(0, this.notifications.length - NOTIFY_KEEP);
    this.log.info('notify', { rule, card_id: cardId, to: n.to.length });
    this.emit('notify', n);
  }

  // ── runner sends ──────────────────────────────────────────────────────────
  sendToDevice(deviceId, frame, { queue = false } = {}) {
    const conn = this.runners.get(deviceId);
    if (conn?.ready) { conn.send(frame); return true; }
    if (queue) {
      const now = this.mono();
      const list = (this.pendingCmds.get(deviceId) ?? []).filter((p) => now - p.at < PENDING_CMD_TTL_MS);
      list.push({ frame, at: now });
      this.pendingCmds.set(deviceId, list.slice(-PENDING_CMDS_MAX));
    }
    return false;
  }

  takePendingCmds(deviceId) {
    const now = this.mono();
    const list = this.pendingCmds.get(deviceId) ?? [];
    this.pendingCmds.delete(deviceId);
    return list.filter((p) => now - p.at < PENDING_CMD_TTL_MS).map((p) => p.frame);
  }

  sweepPendingCmds() {
    const now = this.mono();
    for (const [dev, list] of this.pendingCmds) {
      const keep = list.filter((p) => now - p.at < PENDING_CMD_TTL_MS);
      if (keep.length) this.pendingCmds.set(dev, keep); else this.pendingCmds.delete(dev);
    }
  }

  eligibleDevices(cardId) {
    const row = this.card(cardId);
    const d = this.pendingDispatch(cardId);
    if (!row || !d) return [];
    const target = this.dispatchTarget(d);
    return [...this.runners.values()].filter((c) => c.ready && c.member_id === target && c.repos.has(row.repo_id));
  }

  offerFrame(cardId) {
    const row = this.card(cardId);
    const d = this.pendingDispatch(cardId);
    if (!row || !d || row.run_state !== 'queued') return null;
    const settings = this.boardSettings(row.board_id);
    const seed = json(d.seed, {});
    const labels = this.labels(row);
    const out = {};
    if (seed.from?.includes('handover') || seed.handover_version) {
      const h = this.handoverDoc(cardId);
      if (h) out.handover_md = h.markdown;
    }
    if (seed.answer) out.answer = seed.answer;
    if (seed.review) out.review = seed.review;
    const prev = this.latestRun(cardId);
    if (prev) {
      out.prev_run_n = prev.fence;
      if (prev.snapshot_status === 'pushed' && prev.last_snapshot_sha) out.from_snapshot = { ref: prev.snapshot_ref, sha: prev.last_snapshot_sha };
    }
    const comments = this.db.all("SELECT id, author_member_id, body, created_at FROM comments WHERE card_id = ? AND for_agent = 1 AND trusted = 1 AND delivered_at IS NULL AND source != 'agent' ORDER BY created_at", cardId);
    if (comments.length) out.comments = comments.map((c) => ({ comment_id: c.id, author_name: this.memberName(c.author_member_id), body: c.body, created_age_ms: this.ageOf(c.created_at) }));
    const budgetCents = row.budget_cents ?? (settings.default_budget_usd != null ? Math.round(settings.default_budget_usd * 100) : null);
    return {
      type: 'offer', card_id: row.id, key: row.key, title: row.title, body: row.body, repo_id: row.repo_id,
      base_ref: row.base_ref ?? this.repo(row.repo_id)?.default_branch ?? 'main', fence: row.fence, request_id: d.request_id,
      dispatched_by: { member_id: d.dispatched_by, name: this.memberName(d.dispatched_by) }, needs_confirm: !!d.needs_confirm,
      labels, budget_usd: budgetCents == null ? null : budgetCents / 100, max_turns: settings.default_max_turns ?? null,
      require_plan_approval: labels.includes(PLAN_APPROVAL_LABEL), seed: out,
    };
  }

  sendOffers(cardId, onlyDevice = null) {
    const frame = this.offerFrame(cardId);
    if (!frame) return;
    const set = this.offered.get(cardId) ?? new Set();
    for (const conn of this.eligibleDevices(cardId)) {
      if (onlyDevice && conn.device_id !== onlyDevice) continue;
      conn.send(frame);
      set.add(conn.device_id);
    }
    this.offered.set(cardId, set);
  }

  sendOffersForDevice(deviceId) {
    const conn = this.runners.get(deviceId);
    if (!conn) return;
    const rows = this.db.all(`SELECT c.id FROM cards c JOIN dispatches d ON d.card_id = c.id AND d.state = 'pending'
      WHERE c.run_state = 'queued' AND COALESCE(d.target_member_id, d.dispatched_by) = ?`, conn.member_id);
    for (const { id } of rows) this.sendOffers(id, deviceId);
  }

  withdrawOffers(cardId, exceptDevice, reason) {
    const set = this.offered.get(cardId);
    if (!set) return;
    const d = this.lastDispatch(cardId);
    for (const dev of set) {
      if (dev === exceptDevice) continue;
      this.sendToDevice(dev, { type: 'offer.withdrawn', card_id: cardId, request_id: d?.request_id ?? '', reason: reason ?? 'withdrawn' });
    }
    this.offered.delete(cardId);
  }

  // needs_confirm = target ≠ dispatcher ∧ dispatcher ∉ the target runner's auto_accept_from (display only).
  needsConfirm(dispatcher, target, repoId) {
    if (!target || target === dispatcher) return false;
    for (const c of this.runners.values()) {
      if (c.member_id !== target) continue;
      if (c.repos.get(repoId)?.auto_accept_from?.includes(dispatcher)) return false;
    }
    return true;
  }

  runnerOnline(cardId) {
    return this.eligibleDevices(cardId).length > 0;
  }

  mintRunToken(run) {
    return mintRunToken(this.secret, { card_id: run.card_id, run_id: run.id, fence: run.fence, hub_epoch: this.epoch });
  }

  // ── liveness memory ───────────────────────────────────────────────────────
  lease(runId) { return this.live.get(runId) ?? null; }

  noteHeartbeat(runId, rhb, rx) {
    let lm = this.live.get(runId);
    if (!lm) { lm = { hb_mono: null, child_alive: null, tool: null, activity_mono: null, wake_mono: null, runner_wake_mono: null }; this.live.set(runId, lm); }
    lm.hb_mono = rx;
    lm.child_alive = rhb.child_alive === true;
    const t = rhb.tool_in_flight;
    lm.tool = t ? { name: t.name, summary: t.summary ?? null, bash_timeout_ms: t.bash_timeout_ms ?? null, since_mono: rx - (t.age_ms ?? 0) } : null;
    if (Number.isFinite(rhb.last_activity_age_ms)) {
      const act = rx - rhb.last_activity_age_ms;
      if (lm.activity_mono == null || act > lm.activity_mono) lm.activity_mono = act;
    }
    if (Number.isFinite(rhb.wake_age_ms)) lm.runner_wake_mono = rx - rhb.wake_age_ms;
    return lm;
  }

  noteActivity(runId) {
    const lm = this.live.get(runId);
    if (!lm) return;
    lm.activity_mono = this.mono();
    if (lm.wake_mono != null) {
      lm.post_wake = true;
      this.db.run('UPDATE leases SET post_wake_activity = 1 WHERE run_id = ?', runId);
    }
  }

  noteTool(runId, tool) {
    const lm = this.live.get(runId);
    if (lm) lm.tool = tool ? { ...tool, since_mono: this.mono() } : null;
  }

  // ── reaper ────────────────────────────────────────────────────────────────
  timerCtx() {
    return { hub_uptime_ms: this.uptime(), tunnel_ok: this.tunnel.ok };
  }

  timerSnapshot(row) {
    const now = this.mono();
    const lm = this.lease(row.active_run_id);
    const run = this.run(row.active_run_id);
    const oldest = this.db.get(`SELECT MIN(created_at) AS t FROM (
      SELECT created_at FROM asks WHERE card_id = ? AND state = 'open'
      UNION ALL SELECT created_at FROM permission_requests WHERE card_id = ? AND state = 'open')`, row.id, row.id)?.t ?? null;
    return {
      run_state: row.run_state ?? 'todo', resume_to: row.resume_to, pre_reconnect_state: row.pre_reconnect_state,
      hb_age_ms: lm?.hb_mono != null ? now - lm.hb_mono : null,
      state_age_ms: this.ageOf(row.state_since) ?? 0,
      claim_age_ms: run ? this.ageOf(run.started_at) : null,
      ask_age_ms: this.ageOf(oldest),
      hub_uptime_ms: this.uptime(),
      tunnel_ok_ms: this.tunnel.ok ? now - this.tunnel.okSinceMono : 0,
      runner_online: row.run_state === 'queued' ? this.runnerOnline(row.id) : true,
      nudged: row.queued_nudged_at != null,
      activity_age_ms: lm?.activity_mono != null ? now - lm.activity_mono : null,
      tool_in_flight: lm?.tool ? { name: lm.tool.name, age_ms: now - lm.tool.since_mono, bash_timeout_ms: lm.tool.bash_timeout_ms } : null,
    };
  }

  reapCard(cardId) {
    const row = this.card(cardId);
    if (!row?.run_state) return;
    const ev = timerEvent(this.timerSnapshot(row));
    if (ev) {
      const r = this.apply(cardId, ev, { ctx: this.timerCtx() });
      if (!r.ok && !['BOOT_GRACE', 'TUNNEL_DOWN'].includes(r.error.code)) this.log.warn('timer step failed', { card_id: cardId, event: ev.type, code: r.error.code });
    }
    const after = this.card(cardId);
    if (after.run_state === 'orphaned' && after.orphan_notified_at == null && this.ageOf(after.state_since) >= ORPHAN_NOTIFY_MS) {
      const roles = ['dispatcher', 'assignees'];
      this.txn(() => {
        this.db.run('UPDATE cards SET orphan_notified_at = ? WHERE id = ?', this.iso(), cardId);
        this.journal({ board_id: after.board_id, card_id: cardId, run_id: after.active_run_id ?? null, kind: 'card.notify', payload: { rule: 'orphaned', to: this.recipients(cardId, roles) } });
        this.later(() => this.notify('orphaned', cardId, roles));
      });
    }
  }

  /** One reaper pass (the 1 s interval calls this; tests call it with a fake clock). */
  async tick() {
    const rows = this.db.all("SELECT id, board_id FROM cards WHERE run_state IS NOT NULL AND run_state NOT IN ('done','failed','in_review','handed_over','parked')");
    const byBoard = new Map();
    for (const r of rows) {
      if (!byBoard.has(r.board_id)) byBoard.set(r.board_id, []);
      byBoard.get(r.board_id).push(r.id);
    }
    const jobs = [];
    for (const [boardId, ids] of byBoard) jobs.push(this.withBoard(boardId, () => { for (const id of ids) this.reapCard(id); }));
    await Promise.all(jobs);
    const now = this.mono();
    for (const [repoId, due] of this.overlapDue) {
      if (now >= due) {
        this.overlapDue.delete(repoId);
        this.recomputeOverlaps(repoId);
      }
    }
    this.pushLeaseTicks();
    this.sweepRequestCache();
    this.sweepPendingCmds();
    this.limiter.sweep();
    this.recheckBrowsers();
    await this.idle();
  }

  pushLeaseTicks() {
    if (!this.browsers.size) return;
    const now = this.mono();
    const rows = this.db.all(`SELECT * FROM cards WHERE run_state IN (${[...ACTIVE].map(() => '?').join(',')})`, ...ACTIVE);
    for (const row of rows) {
      const live = leaseView(this, row);
      if (!live) continue;
      const lm = this.lease(row.active_run_id);
      const sig = JSON.stringify([row.run_state, live.green, live.child_alive, lm?.hb_mono, lm?.activity_mono, lm?.tool?.name, lm?.tool?.since_mono, lm?.wake_mono]);
      for (const b of this.browsers) {
        if (b.boardId !== row.board_id) continue;
        const last = b.ticks.get(row.id);
        if (last && now - last.mono < TICK_MAX_RATE_MS) continue;
        if (last && last.sig === sig && now - last.mono < TICK_EVERY_MS) continue;
        b.ticks.set(row.id, { mono: now, sig });
        b.send({ type: 'lease.tick', card_id: row.id, live, state_age_ms: Math.round(this.ageOf(row.state_since) ?? 0) });
      }
    }
  }

  // Long-lived browser sockets: closed at Access session expiry, and when the
  // member is removed (memberChanged, and every reaper pass as a backstop).
  recheckBrowsers(memberId = null) {
    const now = this.wallMs();
    for (const b of [...this.browsers]) {
      if (b.expMs != null && now >= b.expMs) { b.close(WS_CLOSE.UNAUTHENTICATED, 'Access session expired'); continue; }
      if (memberId == null || b.member?.id === memberId || b.candidates.some((c) => c.id === memberId)) b.recheck();
    }
  }

  memberChanged(memberId) {
    this.recheckBrowsers(memberId);
  }

  // ── browser broadcasts ────────────────────────────────────────────────────
  broadcastCard(cardId) {
    const row = this.card(cardId);
    if (!row) return;
    for (const b of this.browsers) {
      if (b.boardId !== row.board_id) continue;
      b.send({ type: 'card.upsert', board_id: row.board_id, card: cardView(this, row, b.member.id) });
    }
  }

  broadcastEvent(cardId, eventId) {
    const row = this.card(cardId);
    const ev = this.db.get('SELECT * FROM events WHERE id = ?', eventId);
    if (!row || !ev || !isFeedKind(ev.kind)) return;
    const fe = feedEvent(this, ev);
    for (const b of this.browsers) if (b.boardId === row.board_id) b.send({ type: 'event.append', card_id: cardId, event: fe });
  }

  // ── handover ──────────────────────────────────────────────────────────────
  latestHandover(cardId) {
    return this.db.get('SELECT * FROM handovers WHERE card_id = ? ORDER BY version DESC LIMIT 1', cardId);
  }

  writeNarrative(cardId, patch, { written_by, run = null, provenance = null, writable } = {}) {
    const prev = this.latestHandover(cardId);
    const next = applyPatch(json(prev?.sections, null), patch, { written_by, at_ms: this.wallMs(), ...(writable ? { writable } : {}) });
    const version = (prev?.version ?? 0) + 1;
    next.version = version;
    this.db.insert('handovers', { card_id: cardId, version, run_id: run?.id ?? null, fence: run?.fence ?? null, sections: JSON.stringify(next), written_by, provenance, created_at: this.iso() });
    this.journal({ card_id: cardId, run_id: run?.id ?? null, actor_kind: written_by === 'claude' ? 'runner' : 'member', actor_id: written_by === 'claude' ? run?.device_id ?? null : null, kind: 'handover.version', payload: { version, written_by, provenance } });
    this.later(() => this.broadcastCard(cardId));
    return version;
  }

  handoverDoc(cardId) {
    const row = this.card(cardId);
    if (!row) return null;
    const run = this.run(row.active_run_id) ?? this.latestRun(cardId);
    const h = this.latestHandover(cardId);
    const facts = run ? json(run.facts, null) : null;
    const salvage = this.db.all("SELECT payload, fence, at_hub FROM events WHERE card_id = ? AND kind = 'salvage' ORDER BY id", cardId).map((e) => {
      const p = json(e.payload, {});
      return { at_ms: Date.parse(e.at_hub), run_n: e.fence, text: p.text ?? p.note ?? p.kind ?? 'salvage', ref: p.ref ?? null };
    });
    const owner = run ? this.memberName(run.on_behalf_of) : null;
    const doc = mergeHandover({
      card: { key: row.key, title: row.title, goal: row.body || row.title, done_means: row.acceptance, repo_id: this.repo(row.repo_id)?.short_name ?? row.repo_id },
      run: run ? { n: run.fence, fence: run.fence, run_state: row.run_state ?? 'todo', agent_label: owner ? `${owner}'s Claude` : 'Claude', base_ref: run.base_ref, base_sha: run.base_sha } : null,
      facts: facts && Object.keys(facts).length ? facts : null,
      narrative: json(h?.sections, null),
      snapshot: run?.snapshot_status ? { sha: run.last_snapshot_sha, ref: run.snapshot_ref, status: run.snapshot_status, reason: run.snapshot_reason, at_ms: run.snapshot_at ? Date.parse(run.snapshot_at) : null } : null,
      salvage,
    });
    const now = this.wallMs();
    return { doc, ages: syncAges(doc, now), markdown: renderMarkdown(doc, { now_ms: now }), version: h?.version ?? 0 };
  }

  // ── overlaps ──────────────────────────────────────────────────────────────
  scheduleOverlap(repoId, delay = OVERLAP_DEBOUNCE_MS) {
    if (!repoId) return;
    const due = this.mono() + delay;
    const cur = this.overlapDue.get(repoId);
    if (cur == null || due < cur) this.overlapDue.set(repoId, due);
  }

  liveRunsInRepo(repoId) {
    const rows = this.db.all(`SELECT r.*, c.key AS card_key, c.title AS card_title, c.body AS card_body FROM runs r JOIN cards c ON c.active_run_id = r.id
      WHERE r.repo_id = ? AND r.ended_at IS NULL`, repoId);
    return rows.map((r) => ({
      run_id: r.id, card_id: r.card_id, card_key: r.card_key, owner_label: `${this.memberName(r.on_behalf_of) ?? '?'}'s Claude`,
      owner_name: this.memberName(r.on_behalf_of), repo_id: r.repo_id, branch: r.branch, fence: r.fence, device_id: r.device_id,
      touched_paths: json(r.touched_paths, []), planned_paths: json(r.planned_paths, []),
      locked_paths: this.db.all('SELECT path FROM path_locks WHERE run_id = ?', r.id).map((x) => x.path),
      title: r.card_title, body: r.card_body,
    }));
  }

  overlapRows(repoId) {
    return this.db.all('SELECT * FROM overlaps WHERE repo_id = ? AND resolved_at IS NULL', repoId)
      .map((o) => ({ ...o, paths: json(o.paths, []), kind: kindOf(o.level) }));
  }

  recomputeOverlaps(repoId) {
    const runs = this.liveRunsInRepo(repoId);
    const rows = computeOverlaps(runs);
    const now = this.iso();
    const key = (r) => `${r.run_a}|${r.run_b}|${r.reason}`;
    const before = new Map(this.overlapRows(repoId).map((o) => [key(o), o]));
    const seen = new Set();
    const fresh = [];
    const changed = new Set();
    this.txn(() => {
      for (const r of rows) {
        const k = key(r);
        seen.add(k);
        const old = before.get(k);
        if (!old) {
          fresh.push(r);
          changed.add(r.run_a).add(r.run_b);
        } else if (JSON.stringify(old.paths) !== JSON.stringify(r.paths) || old.level !== r.level) {
          changed.add(r.run_a).add(r.run_b);
        }
        this.db.run(`INSERT INTO overlaps (id, repo_id, run_a, run_b, level, reason, paths, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_a, run_b, reason) DO UPDATE SET level = excluded.level, paths = excluded.paths, last_seen = excluded.last_seen,
          resolved_at = NULL, first_seen = CASE WHEN overlaps.resolved_at IS NULL THEN overlaps.first_seen ELSE excluded.first_seen END`,
        randomUUID(), repoId, r.run_a, r.run_b, r.level, r.reason, JSON.stringify(r.paths), now, now);
      }
      for (const [k, o] of before) {
        if (seen.has(k)) continue;
        this.db.run('UPDATE overlaps SET resolved_at = ? WHERE id = ?', now, o.id);
        changed.add(o.run_a).add(o.run_b);
      }
    });
    if (!changed.size) return;
    const byId = new Map(runs.map((r) => [r.run_id, r]));
    const current = this.overlapRows(repoId);
    for (const runId of changed) {
      const r = byId.get(runId);
      if (!r) continue;
      this.broadcastCard(r.card_id);
      const mine = overlapsFor(runId, current, byId);
      const newOnes = overlapsFor(runId, fresh, byId);
      const frame = {
        type: 'context.update', run_id: runId, card_id: r.card_id, fence: r.fence, team_context: this.teamContext(runId),
        overlap_ids: current.filter((o) => o.run_a === runId || o.run_b === runId).map((o) => o.id),
      };
      if (newOnes.length) frame.delta = overlapDelta(newOnes[0]);
      if (this.sendToDevice(r.device_id, frame) && newOnes.length) {
        this.db.run('UPDATE overlaps SET injected_a_at = COALESCE(injected_a_at, ?) WHERE run_a = ? AND resolved_at IS NULL', now, runId);
        this.db.run('UPDATE overlaps SET injected_b_at = COALESCE(injected_b_at, ?) WHERE run_b = ? AND resolved_at IS NULL', now, runId);
      }
      if (mine.length !== 0 || newOnes.length) this.log.debug('overlap update', { run_id: runId, count: mine.length });
    }
  }

  teamContext(runId) {
    const run = this.run(runId);
    if (!run) return { text: '', tokens: 0 };
    const card = this.card(run.card_id);
    const runs = this.liveRunsInRepo(run.repo_id);
    const byId = new Map(runs.map((r) => [r.run_id, r]));
    const overlaps = overlapsFor(runId, this.overlapRows(run.repo_id), byId);
    const memories = this.db.all("SELECT kind, body, path, status FROM memories WHERE repo_id = ? AND status != 'archived' AND (card_id IS NULL OR card_id != ?) ORDER BY created_at DESC LIMIT 10", run.repo_id, run.card_id);
    const budget = this.boardSettings(card.board_id).team_context_budget ?? undefined;
    const { text, tokens } = teamContextBlock({ overlaps, memories }, budget);
    return { text, tokens };
  }

  overlapViews(row) {
    if (!row.active_run_id || !row.repo_id) return [];
    const runs = this.liveRunsInRepo(row.repo_id);
    const byId = new Map(runs.map((r) => [r.run_id, r]));
    const raw = this.overlapRows(row.repo_id).filter((o) => o.run_a === row.active_run_id || o.run_b === row.active_run_id);
    return overlapsFor(row.active_run_id, raw, byId).map((o) => {
      const first = raw.filter((x) => x.run_a === o.other.run_id || x.run_b === o.other.run_id).map((x) => this.ageOf(x.first_seen));
      return {
        other_card_id: o.other.card_id ?? null, other_key: o.other.card_key ?? null, other_owner: o.other.owner_name ?? null,
        level: o.level, kind: o.kind, reasons: o.reasons, paths: o.paths, age_ms: first.length ? Math.max(...first) : 0,
      };
    });
  }

  // ── GitHub merge poll (Done on merge, #33/#34) ────────────────────────────
  async pollMerges() {
    if (this.pollingMerges) return;   // a slow GitHub must not stack polls
    this.pollingMerges = true;
    try { await this.#pollMerges(); } finally { this.pollingMerges = false; }
  }

  async #pollMerges() {
    const rows = this.db.all("SELECT * FROM cards WHERE run_state = 'in_review'");
    for (const row of rows) {
      const ev = this.db.get("SELECT * FROM evidence WHERE card_id = ? AND kind = 'pr' AND verification = 'hub_verified' ORDER BY created_at DESC, rowid DESC LIMIT 1", row.id);
      const number = prNumberOf(ev?.ref);
      if (number == null) continue;
      let pull;
      try { pull = await this.github.getPull(this.repo(row.repo_id)?.canonical_url, number); } catch (e) {
        this.log.warn('merge poll failed', { card_id: row.id, err: e });
        continue;
      }
      if (!pull) continue;
      this.prStatus.set(row.id, { number, url: pull.html_url, state: pull.merged ? 'merged' : pull.state, merged_by: pull.merged_by, merged_at: pull.merged_at });
      if (pull.merged || pull.state === 'closed') {
        await this.withBoard(row.board_id, () => {
          const r = this.apply(row.id, { type: pull.merged ? 'pr_merged' : 'pr_closed', pr: number, by: pull.merged_by ?? null });
          if (!r.ok) this.log.warn('merge poll step failed', { card_id: row.id, code: r.error.code });
        });
      } else {
        this.broadcastCard(row.id);
      }
    }
  }

  // ── tunnel self-probe ─────────────────────────────────────────────────────
  noteTunnel(ok) {
    if (ok && !this.tunnel.ok) this.tunnel.okSinceMono = this.mono();
    if (!ok && this.tunnel.ok) this.log.warn('tunnel self-probe unhealthy: orphaning suspended');
    this.tunnel.ok = ok;
  }

  // ── HTTP idempotency cache (D8) ───────────────────────────────────────────
  cachedResponse(memberId, requestId) {
    const hit = this.requestCache.get(`${memberId}|${requestId}`);
    return hit && hit.exp > this.mono() ? hit : null;
  }

  cacheResponse(memberId, requestId, status, body) {
    this.requestCache.set(`${memberId}|${requestId}`, { status, body, exp: this.mono() + REQUEST_CACHE_MS });
  }

  sweepRequestCache() {
    const now = this.mono();
    for (const [k, v] of this.requestCache) if (v.exp <= now) this.requestCache.delete(k);
  }
}

// ── feed rendering (shared by views and broadcasts) ─────────────────────────
const SHOWN_KINDS = new Set(FEED_KINDS);
export const isFeedKind = (k) => SHOWN_KINDS.has(k);

const FEED_TEXT = {
  dispatched: 'Given to Claude', claimed: 'Runner claimed the card', started: 'Claude started', cancelled: 'Dispatch cancelled',
  declined: 'Dispatch declined', blocked: 'Needs you', answered: 'Answered', parked: 'Parked: no agent running',
  requeued_answered: 'Requeued with the answer', suspended: 'Laptop asleep', unresponsive: 'No signal', orphaned: 'Orphaned',
  recovered: 'Runner back', reconnecting: 'Board restarted', failed: 'Failed', stopped: 'Stopped', released: 'Released',
  retried: 'Retried', taken_over: 'Taken over', handing_over: 'Handing over', handed_over: 'Handed over',
  human_on_it: 'A human took it', in_review: 'In review', changes_requested: 'Changes requested', pr_closed_unmerged: 'PR closed without merge',
  merged: 'Merged', approved_done: 'Approved as done', prep_failed: 'Preparation failed', requeued_claim_timeout: 'Requeued: runner never started',
  handover_frozen: 'Handover frozen', salvage: 'Salvage attached', withdrawn: 'Request withdrawn', created: 'Created',
};

export function feedEvent(hub, ev) {
  const data = json(ev.payload, {});
  let text = FEED_TEXT[ev.kind] ?? null;
  if (ev.kind === 'progress') text = data.text;
  else if (ev.kind === 'message') text = data.text;
  else if (ev.kind === 'error') text = data.first_line;
  else if (ev.kind === 'subagent') text = data.summary;
  else if (ev.kind === 'file') text = `${data.op} ${data.path}`;
  else if (ev.kind === 'command') text = `${data.cmd} · exit ${data.exit ?? '?'}`;
  else if (ev.kind === 'orphaned') {
    const rl = hub.db.get("SELECT payload FROM events WHERE card_id = ? AND kind = 'orphan_relabel' AND json_extract(payload, '$.event_id') = ? ORDER BY id DESC LIMIT 1", ev.card_id, ev.id);
    if (rl) text = `Orphaned (${json(rl.payload, {}).relabel})`;
  }
  else if (ev.kind === 'failed' && data.reason) text = `Failed: ${data.reason}`;
  return {
    id: ev.id, kind: ev.kind, at_age_ms: hub.ageOf(ev.at_hub), actor_name: ev.actor ? hub.memberName(ev.actor) : null,
    run_n: ev.fence ?? null, text, data,
  };
}
