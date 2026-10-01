// /ws/runner (CONTRACT §6): device auth, hello/welcome/replay, advertise,
// offers + CAS claims, heartbeats → hb.ack (current:true only for the card's
// current fence), the durable outbox (per-device seq, dedupe, cumulative
// acks, stale fence = ack + drop + salvage note), RPC, commands and the
// salvage lane. Frames from one connection are handled strictly in order,
// except that an rpc never holds up the frames after it.

import { randomUUID } from 'node:crypto';
import { validate, compatible, PROTOCOL_VERSION, WS_CLOSE } from '../shared/protocol.js';
import { HubError, json } from './db.js';
import { bearer, sha256hex } from './auth.js';
import { handleRpc, relPath } from './rpc.js';
import { BAD_RUNNER_TOKEN, isRunnerToken } from './identity/enrolments.js';
import { HANDOVER_WAIT_MS } from '../shared/liveness.js';

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Upgrade auth: → {device, enrollmentId?} or {close: code, reason}. */
export async function authenticateRunner(hub, req, { ip = null } = {}) {
  const token = bearer(req);
  // Accounts (D80, H1): only a runner token enrolled in one team, named by
  // Board-Team. Anything else (no token, a legacy device token) gets the
  // same answer as an unknown runner token: no legacy lookup at all.
  if (hub.config.auth === 'accounts') {
    if (!hub.enrolments || !isRunnerToken(token)) return { close: WS_CLOSE.UNAUTHENTICATED, reason: BAD_RUNNER_TOKEN };
    return hub.enrolments.authenticate(token, req.headers['board-team'], { ip });
  }
  if (!token) return { close: WS_CLOSE.UNAUTHENTICATED, reason: 'missing device token' };
  const device = hub.db.get('SELECT * FROM devices WHERE token_hash = ?', sha256hex(token));
  if (!device) return { close: WS_CLOSE.UNAUTHENTICATED, reason: 'unknown device token' };
  if (device.revoked_at) return { close: WS_CLOSE.REVOKED, reason: 'device revoked' };
  if (!hub.activeMember(device.member_id)) return { close: WS_CLOSE.REVOKED, reason: 'member removed' };
  if (hub.config.auth === 'access') {
    try {
      const claims = await hub.access.verify(req.headers['cf-access-jwt-assertion']);
      if (!device.cf_service_token_id || claims.common_name !== device.cf_service_token_id) {
        return { close: WS_CLOSE.UNAUTHENTICATED, reason: 'service token does not belong to this device' };
      }
    } catch (e) {
      return { close: e.code === 'ACCESS_UNAVAILABLE' ? WS_CLOSE.UNAVAILABLE : WS_CLOSE.UNAUTHENTICATED, reason: e.message };
    }
  }
  return { device };
}

export class RunnerConn {
  constructor(hub, ws, device, { enrollmentId = null } = {}) {
    this.hub = hub;
    this.ws = ws;
    this.device = device;
    this.enrollmentId = enrollmentId;   // accounts: the runner enrolment this socket authenticated with (D80)
    this.device_id = device.id;
    this.member_id = device.member_id;
    this.member = hub.member(device.member_id);
    this.ready = false;
    this.repos = new Map();
    this.pendingOut = new Map();
    this.ackVersions = [];          // [{seq, version}] of handover.write entries, carried by the next ack
    this.lastSeqAcked = device.last_seq_acked;
    this.seqBase = device.seq_base ?? 0;
    this.chain = Promise.resolve();
    this.closed = false;
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.onClose());
    ws.on('error', () => {});
  }

  send(frame) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  // Closed means closed now: frames the peer sends during the close handshake
  // (a hello, an out) are never handled, and a peer that never answers the
  // close frame is cut off.
  close(code, reason) {
    this.closed = true;
    this.ready = false;
    if (this.hub.runners.get(this.device_id) === this) this.hub.runners.delete(this.device_id);
    try { this.ws.close(code, reason); } catch { /* already closed */ }
    setTimeout(() => { try { this.ws.terminate(); } catch { /* gone */ } }, 1000).unref();
  }

  error(code, message, re) {
    this.send({ type: 'error', code, message, ...(re != null ? { re } : {}) });
  }

  onClose() {
    this.closed = true;
    this.ready = false;
    if (this.hub.runners.get(this.device_id) === this) this.hub.runners.delete(this.device_id);
    this.hub.log.info('runner disconnected', { device_id: this.device_id });
  }

  onMessage(data) {
    if (this.closed) return;
    // A runner past its frame cap is disconnected, not dropped frame by frame:
    // it reconnects with backoff and replays its outbox, so nothing is lost.
    if (!this.hub.limiter.take('ws_runner', this.device_id).ok) {
      this.hub.log.warn('runner over its frame rate: disconnecting', { device_id: this.device_id });
      this.close(WS_CLOSE.RATE_LIMITED, 'rate limited');
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch {
      this.error('VALIDATION', 'frame is not JSON');
      return;
    }
    const failed = (e) => {
      if (e instanceof HubError) this.error(e.code, e.message, msg?.id);
      else {
        this.hub.log.error('runner frame failed', { device_id: this.device_id, type: msg?.type, err: e });
        this.error('INTERNAL', 'internal error', msg?.id);
      }
    };
    // An rpc can wait on the network (GitHub evidence checks). It still starts
    // after every earlier frame, but later frames (out, hb) never wait for it:
    // a slow rpc must not stall the heartbeats that keep healthy cards green.
    if (msg?.type === 'rpc') {
      this.chain.then(() => this.handle(msg)).catch(failed);
      return;
    }
    this.chain = this.chain.then(() => this.handle(msg)).catch(failed);
  }

  async handle(msg) {
    if (this.closed) return;
    const bad = validate('runner→hub', msg);
    if (bad) {
      this.error(bad.code, bad.message, msg?.id);
      return;
    }
    if (!this.ready && msg.type !== 'hello') {
      this.error('VALIDATION', 'hello must be the first frame');
      return;
    }
    switch (msg.type) {
      case 'hello': return this.onHello(msg);
      case 'advertise': return this.onAdvertise(msg);
      case 'claim': return this.onClaim(msg);
      case 'decline': return this.onDecline(msg);
      case 'hb': return this.onHb(msg);
      case 'host.suspending': return this.onSuspending(msg);
      case 'out': return this.onOut(msg);
      case 'rpc': return this.onRpc(msg);
      case 'salvage': return this.onSalvage(msg);
      case 'presence': return this.hub.presence.update(this, msg);
      default: return undefined;
    }
  }

  // ── hello / advertise ─────────────────────────────────────────────────────
  allowlist() {
    return this.hub.db.all(`SELECT DISTINCT r.id AS repo_id, r.canonical_url, r.aliases FROM repos r
      JOIN board_repos br ON br.repo_id = r.id JOIN boards b ON b.id = br.board_id WHERE b.org_id = ?`, this.member.org_id)
      .map((r) => ({ repo_id: r.repo_id, canonical_url: r.canonical_url, aliases: json(r.aliases, []) }));
  }

  onHello(msg) {
    const hub = this.hub;
    // Revoked or removed after the upgrade (maybe before this socket was
    // registered, so nobody closed it): never (re)register.
    const dev = hub.device(this.device_id);
    if (!dev || dev.revoked_at || !hub.activeMember(dev.member_id)) {
      this.close(WS_CLOSE.REVOKED, dev?.revoked_at ? 'device revoked' : 'member removed');
      return;
    }
    const bad = this.enrollmentId && hub.enrolments?.problem(hub.db.get('SELECT * FROM runner_enrollments WHERE id = ?', this.enrollmentId));
    if (bad) {
      this.close(bad.close, bad.reason);
      return;
    }
    if (!compatible(msg.protocol)) {
      this.error('PROTOCOL_UNSUPPORTED', `hub speaks protocol ${PROTOCOL_VERSION}`);
      this.close(WS_CLOSE.PROTOCOL_UNSUPPORTED, 'protocol unsupported');
      return;
    }
    // An enrolled runner learns its device id from welcome: it may send ''.
    if (msg.device_id !== this.device_id && !(this.enrollmentId && msg.device_id === '')) {
      this.close(WS_CLOSE.UNAUTHENTICATED, 'device_id does not match the token');
      return;
    }
    const old = hub.runners.get(this.device_id);
    if (old && old !== this) old.close(WS_CLOSE.REPLACED, 'replaced by a newer connection');
    hub.runners.set(this.device_id, this);
    this.syncOutbox(msg);
    this.outSeen = false;
    this.repos = new Map(hub.db.all('SELECT repo_id FROM runner_repos WHERE device_id = ?', this.device_id).map((r) => [r.repo_id, { approvals_from: [], auto_accept_from: [] }]));
    hub.db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', hub.iso(), this.device_id);
    if (msg.form_factor === 'laptop' || msg.form_factor === 'desktop') hub.db.run('UPDATE devices SET form_factor = ? WHERE id = ?', msg.form_factor, this.device_id);
    this.send({ type: 'welcome', protocol: PROTOCOL_VERSION, hub_epoch: hub.epoch, device_id: this.device_id, member_id: this.member_id, last_seq_acked: this.lastSeqAcked, allowlist: this.allowlist() });
    this.ready = true;
    hub.log.info('runner connected', { device_id: this.device_id, runs: msg.runs.length });

    const pending = hub.takePendingCmds(this.device_id);
    for (const f of pending) this.send(f);
    // Commands still implied by card state (§6.1 step 4).
    for (const r of msg.runs) {
      if (!r || typeof r.run_id !== 'string') continue;
      const run = hub.run(r.run_id);
      const row = run ? hub.card(run.card_id) : null;
      if (!run || run.device_id !== this.device_id || !row) continue;
      const stale = run.ended_at || row.fence !== r.fence || row.active_run_id !== run.id;
      if (!stale) {
        // A handover asked for while the hub restarted or the runner was away
        // is asked again (the runner ignores a second one for the same run).
        if (row.run_state === 'handing_over' && !pending.some((f) => f.type === 'cmd' && f.run_id === run.id && f.cmd === 'handover_begin')) {
          this.send({ type: 'cmd', cmd_id: randomUUID(), run_id: run.id, card_id: row.id, fence: row.fence, cmd: 'handover_begin', wait_ms: HANDOVER_WAIT_MS, reason: 'hand_over' });
        }
        continue;
      }
      this.send({ type: 'fenced', run_id: run.id, card_id: row.id, held_fence: r.fence, current_fence: row.fence });
      if (!pending.some((f) => f.type === 'cmd' && f.run_id === run.id && f.cmd === 'stop')) {
        this.send({ type: 'cmd', cmd_id: randomUUID(), run_id: run.id, card_id: row.id, fence: r.fence, cmd: 'stop', reason: run.ended_at ? 'RUN_ENDED' : 'FENCED' });
      }
    }
    for (const run of hub.db.all('SELECT * FROM runs WHERE device_id = ? AND ended_at IS NULL', this.device_id)) {
      for (const f of hub.answerFrames(run)) this.send(f);
      hub.db.run("UPDATE asks SET delivered_at = COALESCE(delivered_at, ?) WHERE run_id = ? AND state = 'answered'", hub.iso(), run.id);
      hub.deliverComments(run.card_id);
    }
    hub.sendOffersForDevice(this.device_id);
  }

  // The runner's outbox and the hub's last_seq_acked can disagree: a hub
  // restored from backup is behind the runner's acked seq (entries past it
  // would wait forever for a gap to fill), and a wiped runner outbox restarts
  // at seq 1 under a new outbox_id (its entries would be dropped as already
  // acked). Settle both from hello, journal every move.
  syncOutbox(msg) {
    const hub = this.hub;
    const dev = hub.device(this.device_id);
    let acked = dev.last_seq_acked;
    let base = dev.seq_base ?? 0;
    const moves = [];
    const newId = typeof msg.outbox_id === 'string' && msg.outbox_id && msg.outbox_id !== dev.outbox_id ? msg.outbox_id : null;
    if (newId && dev.outbox_id != null) {
      const maxEv = hub.db.get('SELECT MAX(seq) AS m FROM events WHERE device_id = ?', this.device_id)?.m ?? 0;
      base = Math.max(base + acked, maxEv);
      moves.push({ reason: 'reset', from: acked, to: 0, outbox_id: newId, outbox_id_before: dev.outbox_id });
      acked = 0;
    }
    if (Number.isSafeInteger(msg.outbox_acked_seq) && msg.outbox_acked_seq > acked) {
      moves.push({ reason: 'runner_acked', from: acked, to: msg.outbox_acked_seq });
      acked = msg.outbox_acked_seq;
    }
    if (newId || moves.length) {
      hub.txn(() => {
        hub.db.run('UPDATE devices SET last_seq_acked = ?, seq_base = ?, outbox_id = COALESCE(?, outbox_id) WHERE id = ?', acked, base, newId, this.device_id);
        for (const payload of moves) this.journalOutbox(payload);
      });
      if (moves.length) hub.log.warn('runner outbox resynced', { device_id: this.device_id, moves });
    }
    this.lastSeqAcked = acked;
    this.seqBase = base;
    this.pendingOut.clear();
  }

  journalOutbox(payload) {
    this.hub.journal({ board_id: null, actor_kind: 'runner', actor_id: this.device_id, kind: 'device.outbox', payload });
  }

  onAdvertise(msg) {
    const hub = this.hub;
    const allowed = new Set(this.allowlist().map((r) => r.repo_id));
    const ids = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
    const next = new Map();
    for (const r of msg.repos) {
      if (!r || !allowed.has(r.repo_id)) continue;  // D14: never beyond the board allowlist
      next.set(r.repo_id, { approvals_from: ids(r.approvals_from), auto_accept_from: ids(r.auto_accept_from) });
    }
    hub.txn(() => {
      hub.db.run('DELETE FROM runner_repos WHERE device_id = ?', this.device_id);
      for (const repoId of next.keys()) hub.db.insert('runner_repos', { device_id: this.device_id, repo_id: repoId, advertised_at: hub.iso() });
    });
    this.repos = next;
    hub.sendOffersForDevice(this.device_id);
  }

  // Frames that name a card must stay inside the device member's org.
  ownCard(cardId) {
    const row = this.hub.card(cardId);
    if (!row) return null;
    const board = this.hub.board(row.board_id);
    return board.org_id === this.member.org_id ? row : null;
  }

  // ── claim / decline ───────────────────────────────────────────────────────
  async onClaim(msg) {
    const hub = this.hub;
    const lost = (code = 'CLAIM_LOST', message = 'claim lost') => this.send({ type: 'claim.result', re: msg.id, ok: false, error: { code, message } });
    const row0 = this.ownCard(msg.card_id);
    if (!row0) return lost();
    await hub.withBoard(row0.board_id, () => {
      const row = hub.card(msg.card_id);
      const prior = hub.db.get('SELECT * FROM dispatches WHERE request_id = ? AND card_id = ?', msg.request_id, row.id);
      if (prior?.state === 'claimed' && prior.run_id) {
        const run = hub.run(prior.run_id);
        if (run && run.device_id === this.device_id && !run.ended_at && row.active_run_id === run.id) return this.claimOk(msg, run);
        return lost();
      }
      const d = hub.pendingDispatch(row.id);
      if (!d || d.request_id !== msg.request_id) return lost();
      if (hub.dispatchTarget(d) !== this.member_id) return lost('POLICY_DENIED', 'this dispatch is for another member');
      const ctx = {
        repo_advertised: !!hub.db.get('SELECT 1 AS x FROM runner_repos WHERE device_id = ? AND repo_id = ?', this.device_id, row.repo_id),
        runner_accepts: true,
        no_active_run: !hub.db.get('SELECT 1 AS x FROM runs WHERE card_id = ? AND ended_at IS NULL', row.id),
      };
      const res = hub.apply(row.id, { type: 'claim', expected_fence: msg.expected_fence }, { ctx, device: hub.device(this.device_id) });
      if (!res.ok) {
        const code = ['FENCED', 'ILLEGAL_TRANSITION', 'CONFLICT', 'CLAIM_LOST'].includes(res.error.code) ? 'CLAIM_LOST' : res.error.code;
        return lost(code, res.error.message);
      }
      return this.claimOk(msg, hub.run(res.run_id));
    });
    return undefined;
  }

  claimOk(msg, run) {
    this.send({
      type: 'claim.result', re: msg.id, ok: true, run_id: run.id, fence: run.fence, branch: run.branch, snapshot_ref: run.snapshot_ref,
      run_token: this.hub.mintRunToken(run), team_context: this.hub.teamContext(run.id),
    });
  }

  async onDecline(msg) {
    const hub = this.hub;
    const row0 = this.ownCard(msg.card_id);
    if (!row0) throw new HubError('NOT_FOUND', 'card not found');
    await hub.withBoard(row0.board_id, () => {
      const d = hub.pendingDispatch(row0.id);
      if (!d || d.request_id !== msg.request_id) return;
      const res = hub.apply(row0.id, { type: 'decline', request_id: msg.request_id, reason: msg.reason ?? null }, {
        ctx: { is_target_member: hub.dispatchTarget(d) === this.member_id },
      });
      if (!res.ok) this.error(res.error.code, res.error.message);
    });
  }

  // ── heartbeats ────────────────────────────────────────────────────────────
  async onHb(msg) {
    const hub = this.hub;
    const rx = hub.mono();
    const entries = [];
    for (const r of msg.runs) {
      if (!r || typeof r.run_id !== 'string' || !Number.isSafeInteger(r.fence)) continue;
      const row = this.ownCard(r.card_id);
      if (!row) {
        entries.push({ run_id: r.run_id, fence: r.fence, current: false, state: null, reason: 'RUN_ENDED' });
        continue;
      }
      entries.push(await hub.withBoard(row.board_id, () => this.hbRun(r, rx)));
    }
    hub.db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', hub.iso(), this.device_id);
    this.lastHbMono = rx;
    this.send({ type: 'hb.ack', seq_hb: msg.seq_hb, hub_epoch: hub.epoch, runs: entries });
  }

  hbRun(r, rx) {
    const hub = this.hub;
    const run = hub.run(r.run_id);
    const row = hub.card(r.card_id);
    const no = (reason) => {
      if (reason === 'FENCED') this.send({ type: 'fenced', run_id: r.run_id, card_id: r.card_id, held_fence: r.fence, current_fence: row.fence });
      return { run_id: r.run_id, fence: r.fence, current_fence: row.fence, current: false, state: row.run_state ?? 'todo', reason };
    };
    if (!run || run.card_id !== row.id || run.device_id !== this.device_id) return no('RUN_ENDED');
    if (row.fence !== r.fence) return no('FENCED');
    if (run.ended_at || row.active_run_id !== run.id) return no('RUN_ENDED');

    hub.noteHeartbeat(run.id, r, rx);
    const t = r.tool_in_flight;
    hub.db.run('UPDATE leases SET last_hb_at = ?, hub_epoch = ?, child_alive = ?, tool_in_flight = ?, tool_bound_ms = ? WHERE card_id = ?',
      hub.iso(), hub.epoch, r.child_alive === true, t ? JSON.stringify({ name: t.name, summary: t.summary ?? null, bash_timeout_ms: t.bash_timeout_ms ?? null }) : null, null, row.id);
    if (Number.isFinite(r.cost_usd)) {
      const cents = Math.round(r.cost_usd * 100);
      if (cents > run.cost_cents) hub.db.run('UPDATE runs SET cost_cents = ? WHERE id = ?', cents, run.id);
    }
    const res = hub.apply(row.id, { type: 'hb', fence: r.fence }, { device: hub.device(this.device_id) });
    if (!res.ok && res.error.code === 'FENCED') return no('FENCED');
    const after = hub.card(row.id);
    return { run_id: run.id, fence: after.fence, current: true, state: after.run_state };
  }

  async onSuspending(msg) {
    for (const r of msg.runs) {
      const row = r && this.ownCard(r.card_id);
      if (!row) continue;
      await this.hub.withBoard(row.board_id, () => {
        const run = this.hub.run(r.run_id);
        if (!run || run.device_id !== this.device_id || run.card_id !== row.id) return;
        const res = this.hub.apply(row.id, { type: 'host_suspending', fence: r.fence });
        if (!res.ok) this.hub.log.info('host_suspending ignored', { card_id: row.id, code: res.error.code });
      });
    }
  }

  // ── outbox ────────────────────────────────────────────────────────────────
  async onOut(msg) {
    if (msg.seq <= this.lastSeqAcked) {
      this.send({ type: 'ack', seq: this.lastSeqAcked });
      return;
    }
    // The runner replays contiguously from its oldest unacked entry, so a gap
    // before the first frame of a connection can never fill (entries the runner
    // lost): skip it, on the record.
    if (!this.outSeen && msg.seq > this.lastSeqAcked + 1 && this.pendingOut.size === 0) {
      const from = this.lastSeqAcked;
      this.hub.txn(() => {
        this.consumeSeq(msg.seq - 1);
        this.journalOutbox({ reason: 'gap', from, to: msg.seq - 1 });
      });
      this.hub.log.warn('runner outbox gap skipped', { device_id: this.device_id, from, to: msg.seq - 1 });
    }
    this.outSeen = true;
    if (msg.seq > this.lastSeqAcked + 1) {
      this.pendingOut.set(msg.seq, msg);
      return;
    }
    await this.applyOut(msg);
    while (this.pendingOut.has(this.lastSeqAcked + 1)) {
      const next = this.pendingOut.get(this.lastSeqAcked + 1);
      this.pendingOut.delete(this.lastSeqAcked + 1);
      await this.applyOut(next);
    }
    const versions = this.ackVersions.splice(0);
    this.send({ type: 'ack', seq: this.lastSeqAcked, ...(versions.length ? { versions } : {}) });
  }

  consumeSeq(seq) {
    this.hub.db.run('UPDATE devices SET last_seq_acked = ? WHERE id = ? AND last_seq_acked < ?', seq, this.device_id, seq);
    this.lastSeqAcked = seq;
  }

  async applyOut({ seq, delayed, msg: m }) {
    const hub = this.hub;
    const run = hub.run(m.run_id);
    const row = this.ownCard(m.card_id);
    if (!run || !row || run.card_id !== row.id || run.device_id !== this.device_id || run.repo_id !== m.repo_id) {
      // Out of scope or not ours: never applied, acked so it is not retried forever.
      hub.txn(() => {
        hub.db.insert('audit', { actor: `device:${this.device_id}`, action: 'outbox.rejected', target: m.card_id, detail: JSON.stringify({ seq, kind: m.kind, reason: run && run.repo_id !== m.repo_id ? 'repo_scope' : 'foreign_run' }), at: hub.iso() });
        this.consumeSeq(seq);
      });
      this.error('FORBIDDEN', `outbox seq ${seq} rejected: not this device's run or repo`, seq);
      return;
    }
    await hub.withBoard(row.board_id, () => {
      hub.txn(() => {
        const cur = hub.card(row.id);
        if (cur.fence !== m.fence) {
          // One visible salvage line per run; later drops are internal rows (they still hold the seq).
          const shown = hub.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND kind = 'salvage' AND json_extract(payload, '$.reason') = 'FENCED'", run.id);
          hub.feed(row.id, shown ? 'outbox_dropped' : 'salvage', { note: 'stale outbox entries dropped', kind: m.kind, reason: 'FENCED', held_fence: m.fence }, { run, device: this.device_id, seq: this.seqBase + seq, delayed });
          this.consumeSeq(seq);
          return;
        }
        try {
          hub.txn(() => this.applyKind(cur, run, m, seq, delayed));
        } catch (e) {
          // A poison entry must never block the outbox: record it, ack it.
          hub.log.warn('outbox entry rejected', { device_id: this.device_id, seq, kind: m.kind, err: e });
          hub.feed(row.id, 'error', { first_line: `runner ${m.kind} rejected: ${clip(e.message, 200)}` }, { run, device: this.device_id, seq: this.seqBase + seq, delayed });
        }
        this.consumeSeq(seq);
      });
    });
  }

  applyKind(row, run, m, seq, delayed) {
    const hub = this.hub;
    const rec = (kind, data = {}) => hub.feed(row.id, kind, data, { run, device: this.device_id, seq: this.seqBase + seq, delayed });
    const stepOr = (event) => {
      const res = hub.apply(row.id, { ...event, fence: m.fence }, { device: hub.device(this.device_id) });
      if (!res.ok) hub.log.info('outbox step rejected', { card_id: row.id, kind: m.kind, code: res.error.code });
      return res;
    };
    switch (m.kind) {
      case 'activity':
        rec('activity', { source: m.source });
        if (!delayed && !run.ended_at) hub.noteActivity(run.id);
        stepOr({ type: 'activity', delayed: !!delayed });
        break;
      case 'facts':
        this.applyFacts(row, run, m.items, rec);
        break;
      case 'run.failed':
        rec('run.failed', { fail_kind: m.fail_kind, ...(Number.isSafeInteger(m.resets_in_ms) && m.resets_in_ms >= 0 ? { resets_in_ms: m.resets_in_ms } : {}) });
        stepOr({ type: 'run_failed', fail_kind: m.fail_kind, reason: m.reason == null ? null : clip(m.reason, 500) });
        break;
      case 'prep.failed':
        rec('prep.failed', { cause: clip(m.cause, 500) });
        stepOr({ type: 'prep_failed', cause: clip(m.cause, 500) });
        break;
      case 'handover.complete':
        rec('handover.complete');
        stepOr({ type: 'handover_complete' });
        break;
      case 'snapshot':
        rec('snapshot', { status: m.status, sha: m.sha ?? null, ref: m.ref ?? null });
        if (['pushed', 'push_failed', 'held'].includes(m.status)) {
          hub.db.run('UPDATE runs SET snapshot_status = ?, last_snapshot_sha = COALESCE(?, last_snapshot_sha), snapshot_ref = COALESCE(?, snapshot_ref), snapshot_reason = ?, snapshot_at = ? WHERE id = ?',
            m.status, m.sha ?? null, m.ref ?? null, m.reason == null ? null : clip(m.reason, 300), hub.iso(), run.id);
          hub.journal({ board_id: row.board_id, card_id: row.id, run_id: run.id, actor_kind: 'runner', actor_id: this.device_id, kind: 'run.snapshot', payload: { status: m.status, sha: m.sha ?? null, ref: m.ref ?? null } });
          hub.later(() => hub.broadcastCard(row.id));
        }
        break;
      case 'handover.write': {
        rec('handover.write');
        const version = hub.writeNarrative(row.id, m.patch, { written_by: 'claude', run });
        this.ackVersions.push({ seq, version });
        break;
      }
      case 'progress.append':
        rec('progress', { text: clip(m.text, 500) });
        break;
      case 'status.update':
        rec('status.update', { summary: clip(m.summary, 140) });
        hub.db.run('UPDATE runs SET status_summary = ? WHERE id = ?', clip(m.summary, 140), run.id);
        hub.later(() => hub.broadcastCard(row.id));
        break;
      case 'comment.create': {
        const id = randomUUID();
        const replyTo = m.reply_to && hub.db.get('SELECT 1 AS x FROM comments WHERE id = ? AND card_id = ?', m.reply_to, row.id) ? m.reply_to : null;
        hub.db.insert('comments', { id, card_id: row.id, author_run_id: run.id, source: 'agent', trusted: 1, body: clip(m.text, 10_000), for_agent: 0, reply_to: replyTo, created_at: hub.iso() });
        hub.journal({ board_id: row.board_id, card_id: row.id, run_id: run.id, actor_kind: 'runner', actor_id: this.device_id, kind: 'comment.create', payload: { comment_id: id, source: 'agent', for_agent: false } });
        rec('comment', { comment_id: id, by_agent: true });
        break;
      }
      case 'comment.delivered': {
        rec('comment.delivered', { comment_ids: m.comment_ids, via: m.via });
        for (const id of m.comment_ids) {
          if (typeof id === 'string') hub.db.run('UPDATE comments SET delivered_at = COALESCE(delivered_at, ?), delivered_run_id = ? WHERE id = ? AND card_id = ?', hub.iso(), run.id, id, row.id);
        }
        break;
      }
      default:
        rec('unknown', { kind: m.kind });
    }
  }

  applyFacts(row, run, items, rec) {
    const hub = this.hub;
    const facts = json(hub.run(run.id).facts, {});
    const touched = new Set(json(hub.run(run.id).touched_paths, []));
    const at = hub.wallMs();
    let pathsChanged = false;
    let first = true;
    const log = (kind, data) => {
      // The first row carries the outbox seq (dedupe); the rest are plain feed rows.
      if (first) { rec(kind, data); first = false; } else hub.feed(row.id, kind, data, { run });
    };
    for (const f of items) {
      switch (f.kind) {
        case 'file': {
          if (!relPath(f.path)) continue;
          const list = facts.files_touched ?? [];
          const i = list.findIndex((x) => x.path === f.path);
          const entry = { path: f.path, op: f.op, at_ms: at };
          if (i === -1) list.push(entry); else list[i] = entry;
          facts.files_touched = list.slice(-200);
          if (f.op !== 'read' && !touched.has(f.path)) { touched.add(f.path); pathsChanged = true; }
          log('file', { path: f.path, op: f.op });
          break;
        }
        case 'git':
          Object.assign(facts, { branch: f.branch ?? facts.branch ?? null, head_sha: f.head_sha ?? facts.head_sha ?? null, commits_ahead: f.commits_ahead ?? facts.commits_ahead ?? null, commits_behind: f.commits_behind ?? facts.commits_behind ?? null });
          log('git', { branch: f.branch ?? null, head_sha: f.head_sha ?? null });
          break;
        case 'command':
          facts.commands = [...(facts.commands ?? []), { cmd: clip(f.cmd, 300), exit: f.exit ?? null, duration_ms: f.duration_ms ?? null, tail: f.tail == null ? null : clip(f.tail, 4000) }].slice(-10);
          log('command', { cmd: clip(f.cmd, 300), exit: f.exit ?? null });
          break;
        case 'plan':
          facts.plan = f.items.slice(0, 50).map((x) => ({ text: clip(x?.text, 300), status: x?.status ?? 'todo' }));
          facts.plan_at_ms = at;
          log('plan', { items: facts.plan.length });
          break;
        case 'tool_start':
          hub.noteTool(run.id, { name: f.name, summary: f.summary == null ? null : clip(f.summary, 200), bash_timeout_ms: f.bash_timeout_ms ?? null });
          log('tool_start', { name: f.name });
          break;
        case 'tool_end':
          hub.noteTool(run.id, null);
          log('tool_end', { name: f.name, ok: f.ok });
          break;
        case 'cost':
          hub.db.run('UPDATE runs SET cost_cents = MAX(cost_cents, ?) WHERE id = ?', Math.round(f.cost_usd * 100), run.id);
          log('cost', { cost_usd: f.cost_usd, num_turns: f.num_turns ?? null });
          break;
        case 'session': {
          const ids = json(hub.run(run.id).session_ids, []);
          if (!ids.includes(f.session_id)) hub.db.run('UPDATE runs SET session_ids = ? WHERE id = ?', JSON.stringify([...ids, f.session_id].slice(-20)), run.id);
          log('session', { event: f.event });
          break;
        }
        case 'error': log('error', { first_line: clip(f.first_line, 300) }); break;
        case 'subagent': log('subagent', { summary: clip(f.summary, 500) }); break;
        case 'message': log('message', { text: clip(f.text, 500) }); break;
        case 'compacted': log('compacted', {}); break;
        case 'degraded': log('degraded', { reason: clip(f.reason, 200) }); break;
        default: log('unknown', { kind: f.kind });
      }
    }
    if (first) rec('facts', { count: 0 });
    facts.at_ms = at;
    hub.db.run('UPDATE runs SET facts = ?, facts_at = ?, touched_paths = ? WHERE id = ?', JSON.stringify(facts), hub.iso(), JSON.stringify([...touched].slice(-500)), run.id);
    if (pathsChanged) hub.scheduleOverlap(run.repo_id);
    hub.later(() => hub.broadcastCard(row.id));
  }

  // ── rpc + salvage ─────────────────────────────────────────────────────────
  async onRpc(msg) {
    try {
      const result = await handleRpc(this.hub, this.hub.device(this.device_id), msg);
      this.send({ type: 'rpc.result', re: msg.id, ok: true, result });
    } catch (e) {
      if (!(e instanceof HubError)) this.hub.log.error('rpc failed', { method: msg.method, err: e });
      const code = e instanceof HubError ? e.code : 'INTERNAL';
      this.send({ type: 'rpc.result', re: msg.id, ok: false, error: { code, message: e instanceof HubError ? e.message : 'internal error', ...(e.extra ?? {}) } });
    }
  }

  // Append-only; accepts stale fences; never changes state (§6.9). D7:
  // promoted to current when it comes from the card's most recent run and
  // no newer run has been claimed.
  async onSalvage(msg) {
    const hub = this.hub;
    const row0 = this.ownCard(msg.card_id);
    const run = hub.run(msg.run_id);
    if (!row0 || !run || run.card_id !== row0.id || run.device_id !== this.device_id) throw new HubError('FORBIDDEN', 'salvage for a run that is not this device\'s');
    if (msg.repo_id !== run.repo_id) throw new HubError('FORBIDDEN', 'salvage repo_id does not match the run (out of scope)');
    if (!['handover', 'snapshot', 'note'].includes(msg.kind)) throw new HubError('VALIDATION', 'kind must be handover|snapshot|note');
    await hub.withBoard(row0.board_id, () => {
      const row = hub.card(row0.id);
      const latest = hub.latestRun(row.id);
      const promote = latest?.id === run.id && (row.active_run_id == null || row.active_run_id === run.id) && msg.kind !== 'note';
      const p = msg.payload;
      hub.txn(() => {
        let promoted = false;
        if (promote && msg.kind === 'handover' && p.patch && typeof p.patch === 'object') {
          try {
            hub.writeNarrative(row.id, p.patch, { written_by: 'claude', run, provenance: 'post_fence' });
            promoted = true;
          } catch (e) {
            if (e.code !== 'VALIDATION') throw e;
          }
        }
        if (promote && msg.kind === 'snapshot' && typeof p.sha === 'string') {
          hub.db.run('UPDATE runs SET last_snapshot_sha = ?, snapshot_ref = COALESCE(?, snapshot_ref), snapshot_status = ?, snapshot_reason = ?, snapshot_at = ? WHERE id = ?',
            p.sha, typeof p.ref === 'string' ? p.ref : null, ['pushed', 'push_failed', 'held'].includes(p.status) ? p.status : 'pushed', 'post_fence', hub.iso(), run.id);
          hub.journal({ board_id: row.board_id, card_id: row.id, run_id: run.id, actor_kind: 'runner', actor_id: this.device_id, kind: 'run.snapshot', payload: { status: p.status ?? 'pushed', sha: p.sha, ref: typeof p.ref === 'string' ? p.ref : null, provenance: 'post_fence' } });
          promoted = true;
        }
        const text = msg.kind === 'note' ? clip(p.text ?? p.note ?? '', 500) : msg.kind === 'handover' ? 'final handover narrative (after fence)' : `snapshot ${String(p.sha ?? '?').slice(0, 7)}`;
        hub.feed(row.id, 'salvage', { kind: msg.kind, text, ref: typeof p.ref === 'string' ? p.ref : null, sha: typeof p.sha === 'string' ? p.sha : null, promoted, held_fence: msg.fence }, { run, device: this.device_id });
        hub.later(() => hub.broadcastCard(row.id));
      });
    });
  }
}
