// The runner supervisor (CONTRACT §6): one outbound WSS to the hub, the
// durable outbox, the device heartbeat, gate G, offers/claims, runs, the
// ledger + orphan recovery, and the local control socket for Buddy.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, validate, MCP_TOOLS, WS_CLOSE } from '../shared/protocol.js';
import { serializeOutbound, assertNoForeignBytes, scopeOf } from '../shared/scope.js';
import { HB_MS, SLEEP_TICK_MS, STOP_GRACE_MS, INTERRUPT_WAIT_MS, TIME_SCALE, reconnectDelay, sleptEstimate } from '../shared/liveness.js';
import { branchName, snapshotRef } from '../shared/fence.js';
import { initHome, readDevice, readPolicy, readLedger, writeLedger, writePolicy, hubWsUrl } from './config.js';
import { Outbox } from './outbox.js';
import { Run } from './run.js';
import { ClaudeBackend } from './backends/claude.js';
import { startIpcServer } from './ipc.js';
import { buildSettings, buildMcpConfig, buildEnv, boardBrief, firstPrompt, trustedInstructions, MCP_SERVER, HOOK_TOKEN_FILE, API_KEY_FILE } from './launch.js';
import { createWorktree, sessionOf, snapshot as gitSnapshot, git } from './git.js';
import { decideOffer, advertisable } from './policy.js';
import { lstartOf, sameProcess, treeGroups, processTable, killGroups, killTree, detectFormFactor } from './procs.js';
import { makeLogger, realClock, ensureDir, writeJsonAtomic, writeFileAtomic, RUNNER_VERSION, lineReader } from './util.js';

// Device-level frames carry no repo_id; they still pass the serializer guard
// (no local paths, no credential shapes).
const DEVICE_SCOPE = Object.freeze({ repo_id: '__device__', toplevel: null });
const SEEN_CMDS_MAX = 1000;   // cmd_id dedupe window (the hub re-sends a cmd at most on reconnect)

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

// The card's budget, capped by this machine's policy budget_per_run (policy.json is authoritative).
const minDefined = (...xs) => { const v = xs.filter((x) => Number.isFinite(x) && x > 0); return v.length ? Math.min(...v) : undefined; };

export function findOnPath(bin, envPath = process.env.PATH ?? '') {
  if (bin.includes('/')) return bin;
  for (const d of envPath.split(':')) {
    if (!d) continue;
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

export class Supervisor extends EventEmitter {
  /**
   * opts: home, env (parent env for the CLI allowlist), clock {mono,wall}, log,
   * autoTick (default true), WebSocketImpl, confirm(offerSummary) → Promise<bool>,
   * powerMonitor {on(event, fn)}, claudeBin, mcpServer, controlSocket (default true),
   * interruptWaitMs, stopGraceMs, claimBudgetMs, limitBackoffMs, gitleaks, rand, hubUrl
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.clock = opts.clock ?? realClock;
    this.log = opts.log ?? makeLogger();
    this.l = initHome(opts.home);
    this.device = opts.device ?? readDevice(this.l);
    if (!this.device?.device_id || !this.device?.device_token) throw new Error(`not enrolled: run \`board-runner enroll\` (no ${this.l.device})`);
    this.policy = readPolicy(this.l);
    this.outbox = new Outbox(this.l.outboxDir, this.device.device_id);
    this.runs = new Map();
    this.ws = null;
    this.connected = false;
    this.originDown = false;
    this.attempt = 0;
    this.stopped = false;
    this.memberId = this.device.member_id ?? null;
    this.allowlist = [];
    this.hubEpoch = null;
    this.hbSeq = 0;
    this.hbSent = new Map();
    this.lastHbMono = -Infinity;
    this.sleptSinceHb = 0;
    this.lastTick = null;
    this.pendingClaims = new Map();
    this.pendingRpc = new Map();
    this.ackWaiters = [];
    this.salvageQueue = [];
    this.seenCmds = new Set();
    this.deferred = new Map();
    this.inFlightOffers = new Set();
    this.confirms = new Map();
    this.subscribers = new Set();
    this.mcpTools = [...MCP_TOOLS];
    this.claudeBin = opts.claudeBin ?? this.policy.backends?.claude ?? findOnPath('claude', this.env.PATH);
    this.mcpServer = opts.mcpServer ?? this.env.BOARD_MCP_SERVER ?? MCP_SERVER;
    this.supervisorLstart = lstartOf(process.pid);
    this.formFactor = opts.formFactor ?? this.policy.form_factor ?? detectFormFactor();
    this.confirm = opts.confirm ?? ((o) => this.#confirmViaControl(o));
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  async start() {
    if (TIME_SCALE !== 1) this.log.warn('BOARD_TEST_TIME_SCALE is set: every liveness timer is compressed (tests only)', { scale: TIME_SCALE });
    await this.recoverOrphans();
    if (this.opts.controlSocket !== false) await this.#startControl();
    if (this.opts.powerMonitor) this.attachPowerMonitor(this.opts.powerMonitor);
    this.connect();
    if (this.opts.autoTick !== false) {
      this.tickTimer = setInterval(() => this.tick(), SLEEP_TICK_MS);
    }
    return this;
  }

  async shutdown({ stopRuns = true } = {}) {
    this.stopped = true;
    clearInterval(this.tickTimer);
    clearTimeout(this.reconnectTimer);
    const runs = [...this.runs.values()];
    if (stopRuns) {
      await Promise.all(runs.map((r) => r.command({ cmd: 'stop' }).catch(() => {})));
      await Promise.race([Promise.all(runs.map((r) => r.done)), new Promise((r) => setTimeout(r, 15000).unref?.())]);
    }
    try { this.ws?.close(1000); } catch { /* closed */ }
    this.ws = null;
    this.connected = false;
    await new Promise((r) => (this.control ? this.control.close(() => r()) : r()));
    try { fs.unlinkSync(this.l.controlSock); } catch { /* gone */ }
  }

  // ── hub connection ────────────────────────────────────────────────────────
  connect() {
    if (this.stopped) return;
    const url = this.opts.hubUrl ?? hubWsUrl(this.device.hub);
    const headers = { Authorization: `Bearer ${this.device.device_token}` };
    if (this.device.cf_client_id) {
      headers['CF-Access-Client-Id'] = this.device.cf_client_id;
      headers['CF-Access-Client-Secret'] = this.device.cf_client_secret;
    }
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new WS(url, { headers, handshakeTimeout: 15000 });
    this.ws = ws;
    ws.on('open', () => { if (this.ws === ws) this.#sendHello(); });
    ws.on('message', (data) => { if (this.ws === ws) this.#onFrame(String(data)); });
    ws.on('unexpected-response', (req, res) => {
      // The edge says the origin is unreachable (530 / 1033 / 5xx). Informational
      // only: it never reopens gate G, it only lets an open gate stay open.
      this.originDown = res.statusCode >= 500;
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 4096) body = body.slice(0, 4096); });
      res.on('end', () => {
        if (/\b1033\b/.test(body)) this.originDown = true;
        this.emit('origin', { status: res.statusCode, down: this.originDown });
      });
      try { req.destroy(); } catch { /* done */ }
      if (this.ws === ws) this.#onClose(null);
    });
    ws.on('error', (e) => { this.log.debug('ws error', { err: e.message }); });
    ws.on('close', (code) => { if (this.ws === ws) this.#onClose(code); });
  }

  #onClose(code) {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    for (const [, p] of this.pendingRpc) p.reject(err('HUB_UNREACHABLE', 'hub connection lost'));
    this.pendingRpc.clear();
    if (wasConnected) this.emit('disconnected', { code });
    if (this.stopped) return;
    this.emit('hub_closed', { code });   // every failed or dropped connection (the app's runner.status, D37a)
    if (code === WS_CLOSE.PROTOCOL_UNSUPPORTED || code === WS_CLOSE.REVOKED || code === WS_CLOSE.UNAUTHENTICATED) {
      this.log.error('hub refused this runner; not reconnecting', { code });
      this.notifyLocal({ event: 'hub_refused', code });
      return;
    }
    if (this.reconnectTimer) return;
    const delay = (this.opts.reconnectDelayFn ?? reconnectDelay)(this.attempt++, this.opts.rand?.());
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    this.reconnectTimer.unref?.();
  }

  sendRaw(bytes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(bytes);
    return true;
  }

  #sendDevice(frame) {
    return this.sendRaw(serializeOutbound(frame, DEVICE_SCOPE));
  }

  #sendHello() {
    this.#sendDevice({
      type: 'hello', protocol: PROTOCOL_VERSION, device_id: this.device.device_id, runner_version: RUNNER_VERSION,
      outbox_head_seq: this.outbox.head, outbox_id: this.outbox.id, outbox_acked_seq: this.outbox.acked,
      ...(this.formFactor ? { form_factor: this.formFactor } : {}),
      runs: [...this.runs.values()].map((r) => ({ run_id: r.run_id, card_id: r.card_id, fence: r.fence, local_state: r.ending ? 'ending' : r.localState })),
    });
  }

  #onFrame(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    const bad = validate('hub→runner', m);
    if (bad) { this.log.warn('bad hub frame', { type: m?.type, err: bad.message }); return; }
    switch (m.type) {
      case 'welcome': return this.#onWelcome(m);
      case 'ack': return this.#onAck(m.seq, m.versions);
      case 'offer': return this.handleOffer(m).catch((e) => this.log.error('offer failed', { err: e.message }));
      case 'offer.withdrawn': {
        this.deferred.delete(m.card_id);
        const c = this.confirms.get(m.request_id);
        if (c) c.resolve(false);
        return;
      }
      case 'claim.result': { const p = this.pendingClaims.get(m.re); if (p) { this.pendingClaims.delete(m.re); p.resolve(m); } return; }
      case 'hb.ack': return this.#onHbAck(m);
      case 'cmd': {
        if (this.seenCmds.has(m.cmd_id)) return;
        this.seenCmds.add(m.cmd_id);
        if (this.seenCmds.size > SEEN_CMDS_MAX) this.seenCmds.delete(this.seenCmds.values().next().value);
        const r = this.runs.get(m.run_id);
        if (r && r.fence === m.fence) r.command(m).catch((e) => this.log.error('cmd failed', { err: e.message }));
        return;
      }
      case 'answer': { const r = this.#runFor(m); if (r) r.onAnswer(m); return; }
      case 'comment.deliver': { const r = this.#runFor(m); if (r) r.onComments(m.comments); return; }
      case 'context.update': { const r = this.#runFor(m); if (r) r.onContextUpdate(m); return; }
      case 'fenced': { const r = this.runs.get(m.run_id); if (r) r.onFenced('fenced'); return; }
      case 'rpc.result': { const p = this.pendingRpc.get(m.re); if (p) { this.pendingRpc.delete(m.re); p.resolve(m); } return; }
      case 'error': this.log.warn('hub error', { code: m.code, message: m.message }); return;
      default: return;
    }
  }

  #runFor(m) {
    const r = this.runs.get(m.run_id);
    return r && r.fence === m.fence ? r : null;
  }

  #onWelcome(m) {
    this.hubEpoch = m.hub_epoch;
    this.memberId = m.member_id;
    this.allowlist = m.allowlist ?? [];
    this.attempt = 0;
    this.originDown = false;
    this.outbox.ack(m.last_seq_acked);
    // Delayed = written while offline, by an earlier supervisor, or older than
    // one heartbeat: only those never move a card (D3).
    const now = this.clock.mono();
    for (const e of this.outbox.pendingAfter(m.last_seq_acked)) this.sendRaw(Outbox.frame(e, e.offline || e.at == null || now - e.at > HB_MS));
    this.#sendDevice({ type: 'advertise', repos: advertisable(this.policy, this.allowlist) });
    this.connected = true;
    this.sendHbNow();
    for (const s of this.salvageQueue.splice(0)) this.sendRaw(s);
    for (const r of this.runs.values()) r.onReconnect();
    this.emit('connected', m);
  }

  // versions: [{seq, version}] — the hub's handover version for handover.write entries.
  #onAck(seq, versions) {
    this.outbox.ack(seq);
    const byseq = new Map((Array.isArray(versions) ? versions : []).map((v) => [v?.seq, v?.version]));
    this.ackWaiters = this.ackWaiters.filter((w) => {
      if (w.seq <= this.outbox.acked) { w.resolve({ acked: true, version: Number.isSafeInteger(byseq.get(w.seq)) ? byseq.get(w.seq) : null }); return false; }
      return true;
    });
  }

  /** → {acked, version} (version = the hub's, when the ack carried one). */
  waitAck(seq, ms) {
    if (seq <= this.outbox.acked) return Promise.resolve({ acked: true, version: null });
    return new Promise((resolve) => {
      const w = { seq, resolve };
      this.ackWaiters.push(w);
      setTimeout(() => { this.ackWaiters = this.ackWaiters.filter((x) => x !== w); resolve({ acked: false, version: null }); }, ms).unref?.();
    });
  }

  #onHbAck(m) {
    const sent = this.hbSent.get(m.seq_hb);
    if (m.hub_epoch) this.hubEpoch = m.hub_epoch;
    for (const a of m.runs ?? []) {
      const r = this.runs.get(a.run_id);
      if (!r || r.fence !== a.fence) continue;
      if (a.current === true) {
        if (sent) r.onCurrentAck(sent.mono, sent.wall);
      } else {
        r.onFenced(a.reason ?? 'FENCED');
      }
    }
  }

  // ── outbound ──────────────────────────────────────────────────────────────
  /** THE path for run messages: serializeOutbound under the run scope → outbox → wire. */
  emitOut(run, msg) {
    let bytes;
    try {
      bytes = serializeOutbound(msg, run.scope, { requireRepoId: true });
    } catch (e) {
      this.log.warn('dropped message at the serializer', { kind: msg.kind, reason: e.reason ?? e.message });
      return null;
    }
    const shapeErr = validate('runner→hub', { type: 'out', seq: 1, delayed: false, msg });
    if (shapeErr) { this.log.error('dropped malformed outbox message', { kind: msg.kind, err: shapeErr.message }); return null; }
    const e = this.outbox.append(bytes, { offline: !this.connected });
    e.at = this.clock.mono();
    if (this.connected) this.sendRaw(Outbox.frame(e, e.offline));
    return e;
  }

  salvage(run, kind, payload) {
    let bytes;
    try {
      bytes = serializeOutbound({ type: 'salvage', run_id: run.run_id, card_id: run.card_id, fence: run.fence, repo_id: run.repo_id, kind, payload }, run.scope, { requireRepoId: true });
    } catch (e) {
      this.log.warn('dropped salvage at the serializer', { reason: e.reason ?? e.message });
      return;
    }
    if (!this.connected || !this.sendRaw(bytes)) this.salvageQueue.push(bytes);
  }

  async rpc(run, method, params, { timeoutMs = 30000 } = {}) {
    if (!this.connected) throw err('HUB_UNREACHABLE', 'the board hub is unreachable; try again later');
    const id = crypto.randomUUID();
    const bytes = serializeOutbound({ type: 'rpc', id, method, run_id: run.run_id, card_id: run.card_id, fence: run.fence, repo_id: run.repo_id, run_token: run.run_token, params }, run.scope, { requireRepoId: true });
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pendingRpc.delete(id); reject(err('HUB_UNREACHABLE', 'the board hub did not answer')); }, timeoutMs);
      this.pendingRpc.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      if (!this.sendRaw(bytes)) { this.pendingRpc.delete(id); clearTimeout(t); reject(err('HUB_UNREACHABLE', 'the board hub is unreachable')); }
    });
    if (!res.ok) {
      const code = res.error?.code ?? 'INTERNAL';
      if (code === 'FENCED' || code === 'RUN_ENDED') run.onFenced(code);
      throw err(code, res.error?.message ?? code);
    }
    return res.result ?? {};
  }

  // ── heartbeat, sleep, gate ────────────────────────────────────────────────
  sendHbNow() {
    if (!this.connected) return;
    const seq = ++this.hbSeq;
    const mono = this.clock.mono();
    const wall = this.clock.wall();
    this.hbSent.set(seq, { mono, wall });
    if (this.hbSent.size > 64) this.hbSent.delete(this.hbSent.keys().next().value);
    const runs = [];
    for (const r of this.runs.values()) {
      const h = r.hb();
      try { assertNoForeignBytes(h, r.scope); } catch {
        if (h.tool_in_flight) h.tool_in_flight.summary = h.tool_in_flight.name;
        try { assertNoForeignBytes(h, r.scope); } catch { continue; }
      }
      runs.push(h);
    }
    this.lastHbMono = mono;
    const slept = this.sleptSinceHb;
    this.sleptSinceHb = 0;
    this.#sendDevice({ type: 'hb', seq_hb: seq, mono_ms: Math.round(mono), wall_ms: Math.round(wall), slept_ms: Math.round(slept), runs });
  }

  tick() {
    const m = this.clock.mono();
    const w = this.clock.wall();
    if (this.lastTick) {
      const slept = sleptEstimate({ mono_delta_ms: m - this.lastTick.m, wall_delta_ms: w - this.lastTick.w, interval_ms: SLEEP_TICK_MS });
      if (slept > 0) this.onWake(slept, 'tick_gap');
    }
    this.lastTick = { m, w };
    for (const r of this.runs.values()) r.tick();
    if (this.connected && m - this.lastHbMono >= HB_MS) this.sendHbNow();
  }

  onWake(sleptMs, source) {
    this.log.info('host woke', { slept_ms: Math.round(sleptMs), source });
    this.sleptSinceHb += sleptMs;
    for (const r of this.runs.values()) r.onWake(sleptMs);
    this.sendHbNow();
  }

  hostSuspending() {
    this.suspendedAtWall = this.clock.wall();
    const runs = [...this.runs.values()].map((r) => ({ run_id: r.run_id, card_id: r.card_id, fence: r.fence }));
    if (this.connected) this.#sendDevice({ type: 'host.suspending', runs });
  }

  hostResumed() {
    const slept = this.suspendedAtWall != null ? Math.max(0, this.clock.wall() - this.suspendedAtWall) : 0;
    this.suspendedAtWall = null;
    // A resume without a known duration still demands a round trip before tools (rule 5).
    this.onWake(Math.max(slept, 1), 'power_monitor');
  }

  attachPowerMonitor(pm) {
    pm.on('suspend', () => this.hostSuspending());
    pm.on('resume', () => this.hostResumed());
  }

  // ── offers and claims ─────────────────────────────────────────────────────
  async #scopeForRepo(repoId) {
    const repo = this.policy.repos?.[repoId];
    if (!repo?.local_path) return null;
    const s = await sessionOf(repo.local_path);
    return scopeOf(s, { allowlist: this.allowlist, opted_in: Object.keys(this.policy.repos).filter((k) => this.policy.repos[k]?.opt_in) });
  }

  activeCount(repoId) {
    return [...this.runs.values()].filter((r) => r.repo_id === repoId && !r.ended).length;
  }

  async handleOffer(offer) {
    if ([...this.runs.values()].some((r) => r.card_id === offer.card_id && !r.ended)) return;
    // The hub re-sends pending offers on every hello: one decision per request_id at a time.
    if (this.inFlightOffers.has(offer.request_id)) return;
    this.inFlightOffers.add(offer.request_id);
    try { return await this.#handleOffer(offer); } finally { this.inFlightOffers.delete(offer.request_id); }
  }

  async #handleOffer(offer) {
    this.policy = readPolicy(this.l);
    // Default deny: a repo that doesn't scope produces zero bytes (exit f).
    const scope = await this.#scopeForRepo(offer.repo_id);
    if (!scope || scope.repo_id !== offer.repo_id) {
      this.log.warn('offer for a repo that does not scope on this machine; ignored', { card_id: offer.card_id });
      return;
    }
    const d = decideOffer(offer, { policy: this.policy, ownerId: this.memberId, activeCount: this.activeCount(offer.repo_id) });
    if (d.action === 'defer') { this.deferred.set(offer.card_id, offer); return; }
    if (d.action === 'decline') return this.#decline(offer, d.reason);
    if (d.action === 'confirm') {
      let ok = false;
      try { ok = await this.confirm(this.#offerSummary(offer)); } catch { ok = false; }
      if (!ok) return this.#decline(offer, 'owner declined');
    }
    return this.claim(offer, scope);
  }

  #offerSummary(o) {
    return { card_id: o.card_id, key: o.key, title: o.title, body: o.body, repo_id: o.repo_id, dispatched_by: o.dispatched_by, request_id: o.request_id, labels: o.labels };
  }

  #decline(offer, reason) {
    if (this.connected) this.#sendDevice({ type: 'decline', card_id: offer.card_id, request_id: offer.request_id, reason });
  }

  async claim(offer, scope) {
    const id = crypto.randomUUID();
    const frame = { type: 'claim', id, card_id: offer.card_id, request_id: offer.request_id, expected_fence: offer.fence };
    const sentMono = this.clock.mono();
    const sentWall = this.clock.wall();
    const res = await new Promise((resolve) => {
      const t = setTimeout(() => { this.pendingClaims.delete(id); resolve(null); }, 30000);
      this.pendingClaims.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); } });
      if (!this.#sendDevice(frame)) { clearTimeout(t); this.pendingClaims.delete(id); resolve(null); }
    });
    if (!res?.ok) { this.log.info('claim not won', { card_id: offer.card_id, code: res?.error?.code ?? 'timeout' }); return null; }
    return this.startRun(offer, res, scope, { sentMono, sentWall });
  }

  async startRun(offer, res, scope, { sentMono, sentWall } = {}) {
    const repo = this.policy.repos[offer.repo_id];
    const fence = res.fence;
    const key = offer.key;
    const wt = this.l.worktree(offer.repo_id, key, fence);
    const runDir = this.l.runDir(res.run_id);
    ensureDir(runDir);
    ensureDir(path.join(runDir, 'shell'));
    const run = new Run(this, {
      run_id: res.run_id, card_id: offer.card_id, key, fence, repo_id: offer.repo_id, run_token: res.run_token,
      branch: res.branch ?? branchName(key, fence), worktree: wt, runDir, socketPath: path.join(runDir, 'ipc.sock'),
      sessionId: crypto.randomUUID(), offer, scope: { repo_id: scope.repo_id, toplevel: wt }, team_context: res.team_context ?? null,
      claimAckMono: sentMono, claimAckWall: sentWall,
    });
    this.runs.set(run.run_id, run);
    // T_claim (Run.tick) may end the run while prep is still awaiting (a slow
    // fetch): after every await, an ended run spawns nothing.
    const over = () => run.ending || run.ended;
    try {
      const w = await (this.opts.createWorktree ?? createWorktree)({ localPath: repo.local_path, wt, key, fence, baseRef: offer.base_ref, fromSnapshot: offer.seed?.from_snapshot });
      run.worktree = w.worktree;
      run.scope = { repo_id: scope.repo_id, toplevel: w.worktree };
      if (over()) { this.cleanupRun(run); return run; }
      const s2 = scopeOf(await sessionOf(w.worktree), { allowlist: this.allowlist, opted_in: [offer.repo_id] });
      if (!s2 || s2.repo_id !== offer.repo_id) throw new Error('worktree does not scope to the offered repo');
    } catch (e) {
      this.log.error('prep failed', { card_id: offer.card_id, err: e.message });
      await run.prepFailed(`worktree: ${String(e.stderr || e.message).split('\n')[0]}`);
      return run;
    }
    if (over()) { this.cleanupRun(run); return run; }
    try {
      // The socket must be up before the CLI's first hook fires.
      run.ipc = await startIpcServer({
        socketPath: run.socketPath, token: run.run_token, log: this.log,
        handler: { hello: () => run.hello(), tool: (n, a, ctx) => run.tool(n, a, ctx), hook: (e, p) => run.hook(e, p), cancel: (re, ctx) => run.cancel(ctx.connId, re) },
      });
      if (over()) { run.ipc.close(); this.cleanupRun(run); return run; }
      this.#spawn(run, { resume: false });
      this.sendHbNow();   // the hub learns child_alive now, not at the next 15 s tick
    } catch (e) {
      this.log.error('spawn failed', { err: e.message });
      await run.prepFailed(`spawn: ${e.message}`);
    }
    this.notifyLocal({ event: 'run_started', run_id: run.run_id, key });
    return run;
  }

  #spawn(run, { resume }) {
    if (run.ending || run.ended) return null;
    const repo = this.policy.repos[run.repo_id] ?? {};
    const apiKeyFile = this.env.ANTHROPIC_API_KEY ? path.join(run.runDir, API_KEY_FILE) : null;
    if (apiKeyFile) writeFileAtomic(apiKeyFile, this.env.ANTHROPIC_API_KEY);
    const home = path.resolve(this.l.home);
    const boardHome = home === path.join(this.env.HOME ?? '', '.board') ? null : home;
    const settings = buildSettings({ worktree: run.worktree, tmpdir: this.env.TMPDIR || '/tmp', repo, apiKeyFile, boardHome });
    writeJsonAtomic(path.join(run.runDir, 'settings.json'), settings);
    writeJsonAtomic(path.join(run.runDir, 'mcp.json'), buildMcpConfig({ socket: run.socketPath, token: run.run_token, server: this.mcpServer }));
    writeFileAtomic(path.join(run.runDir, HOOK_TOKEN_FILE), run.run_token);
    const env = buildEnv(this.env, { runDir: run.runDir, socket: run.socketPath, supervisorPid: process.pid, supervisorLstart: this.supervisorLstart });
    const systemPrompt = boardBrief({ key: run.key, fence: run.fence, trusted: trustedInstructions(repo.local_path) });
    const Backend = this.opts.Backend ?? ClaudeBackend;
    const backend = new Backend({
      bin: this.claudeBin, cwd: run.worktree, env, runDir: run.runDir, sessionId: run.sessionId, resume,
      budgetUsd: minDefined(run.offer.budget_usd, repo.budget_per_run), maxTurns: run.offer.max_turns, systemPrompt, model: repo.model,
      log: this.log, boardHome, interruptWaitMs: this.opts.interruptWaitMs ?? INTERRUPT_WAIT_MS, stopGraceMs: this.opts.stopGraceMs ?? STOP_GRACE_MS,
    });
    run.attach(backend);
    backend.start(resume ? 'Board connection restored and your run is still current. Continue where you left off.' : firstPrompt({ key: run.key, title: run.offer.title }));
    this.saveLedger(run);
    return backend;
  }

  // Same-machine resume: --resume <session_id> with the same isolation flags.
  resumeRun(run) {
    if (run.ending || run.fenced) return;
    this.log.info('resuming run', { run_id: run.run_id });
    this.#spawn(run, { resume: true });
  }

  runEnded(run) {
    this.runs.delete(run.run_id);
    run.ipc?.close();
    const ledger = readLedger(this.l);
    delete ledger.runs[run.run_id];
    writeLedger(this.l, ledger);
    this.notifyLocal({ event: 'run_ended', run_id: run.run_id, key: run.key, reason: run.endReason });
    this.cleanupRun(run);
    this.emit('run_ended', run);
    for (const [cardId, offer] of this.deferred) {
      this.deferred.delete(cardId);
      this.handleOffer(offer).catch(() => {});
      break;
    }
  }

  // An ended run's worktree and run dir go; its branch and snapshot/salvage refs
  // stay in the member's repo (refs are shared by every worktree). A final
  // snapshot that never got pushed keeps the worktree for a manual salvage.
  cleanupRun(run) {
    if (this.opts.keepRunFiles ?? this.env.BOARD_KEEP_RUN_FILES === '1') return;
    try { fs.rmSync(run.runDir, { recursive: true, force: true }); } catch { /* gone */ }
    const localPath = this.policy.repos?.[run.repo_id]?.local_path;
    if (!localPath || !run.worktree || !fs.existsSync(run.worktree)) return;
    if (run.unpushed) { this.log.warn('keeping the worktree: its last snapshot was never pushed', { run_id: run.run_id, worktree: run.worktree }); return; }
    git(localPath, ['worktree', 'remove', '--force', run.worktree])
      .then(() => git(localPath, ['worktree', 'prune']))
      .catch((e) => this.log.warn('worktree cleanup failed', { run_id: run.run_id, err: String(e.stderr || e.message).split('\n')[0] }));
  }

  saveLedger(run) {
    if (run.ended || this.runs.get(run.run_id) !== run) return;   // never re-add an ended run
    const ledger = readLedger(this.l);
    const b = run.backend;
    ledger.runs[run.run_id] = {
      run_id: run.run_id, card_id: run.card_id, key: run.key, fence: run.fence, repo_id: run.repo_id,
      pid: b?.pid ?? null, lstart: b?.lstart ?? null, pgid: b?.pgid ?? null, worktree: run.worktree,
      session_id: run.sessionId, run_dir: run.runDir, scope: run.scope,
    };
    writeLedger(this.l, ledger);
  }

  // Supervisor restart: every recorded CLI whose pid + lstart match is an orphan.
  async recoverOrphans() {
    const ledger = readLedger(this.l);
    const entries = Object.values(ledger.runs ?? {});
    for (const e of entries) {
      if (e.pid && sameProcess(e.pid, e.lstart)) {
        this.log.warn('killing orphaned CLI from a previous supervisor', { run_id: e.run_id, pid: e.pid });
        const before = treeGroups(e.pid, processTable());
        try { process.kill(e.pid, 'SIGTERM'); } catch { /* gone */ }
        const until = Date.now() + (this.opts.stopGraceMs ?? STOP_GRACE_MS);
        while (Date.now() < until && sameProcess(e.pid, e.lstart)) await new Promise((r) => setTimeout(r, 100));
        if (sameProcess(e.pid, e.lstart)) killTree(e.pid, e.lstart);
        killGroups(before.groups.filter((g) => { try { process.kill(-g, 0); return true; } catch { return false; } }));
      }
      const fake = { run_id: e.run_id, card_id: e.card_id, fence: e.fence, repo_id: e.repo_id, scope: e.scope };
      if (e.worktree && fs.existsSync(e.worktree)) {
        try {
          const snap = await gitSnapshot({ wt: e.worktree, ref: snapshotRef(e.key, e.fence), push: false, message: `board snapshot ${e.key} r${e.fence} supervisor crash`, gitleaks: this.opts.gitleaks });
          if (snap?.sha) this.emitOut(fake, { kind: 'snapshot', run_id: e.run_id, card_id: e.card_id, fence: e.fence, repo_id: e.repo_id, status: 'push_failed', sha: snap.sha, ref: snap.ref, reason: snap.reason ?? 'supervisor crash: kept locally' });
        } catch (x) { this.log.warn('orphan snapshot failed', { err: x.message }); }
      }
      this.emitOut(fake, { kind: 'run.failed', run_id: e.run_id, card_id: e.card_id, fence: e.fence, repo_id: e.repo_id, fail_kind: 'error', reason: 'supervisor crash' });
      delete ledger.runs[e.run_id];
    }
    writeLedger(this.l, ledger);
    return entries.length;
  }

  // ── local control socket (Buddy) ──────────────────────────────────────────
  notifyLocal(evt) {
    this.emit('local', evt);
    const line = `${JSON.stringify(evt)}\n`;
    for (const s of this.subscribers) { try { s.write(line); } catch { /* gone */ } }
  }

  #confirmViaControl(offer) {
    if (!this.subscribers.size) return Promise.resolve(false);   // headless: default deny
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.confirms.delete(offer.request_id); resolve(false); }, 10 * 60 * 1000);
      this.confirms.set(offer.request_id, { resolve: (v) => { clearTimeout(t); this.confirms.delete(offer.request_id); resolve(v); } });
      this.notifyLocal({ event: 'confirm_offer', offer });
    });
  }

  status() {
    return {
      connected: this.connected, origin_down: this.originDown, device_id: this.device.device_id, outbox_head: this.outbox.head, outbox_acked: this.outbox.acked,
      runs: [...this.runs.values()].map((r) => ({ run_id: r.run_id, key: r.key, fence: r.fence, local_state: r.localState, gate: r.gateOpen ? 'open' : 'closed', cost_usd: r.costUsd })),
    };
  }

  async #startControl() {
    const sock = this.l.controlSock;
    try { fs.unlinkSync(sock); } catch { /* none */ }
    this.control = net.createServer((c) => {
      c.setEncoding('utf8');
      c.on('error', () => {});
      c.on('close', () => this.subscribers.delete(c));
      c.on('data', lineReader(async (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        const reply = (o) => { try { c.write(`${JSON.stringify({ id: m.id ?? null, ...o })}\n`); } catch { /* gone */ } };
        try {
          switch (m.type) {
            case 'status': return reply({ ok: true, result: this.status() });
            case 'subscribe': this.subscribers.add(c); return reply({ ok: true });
            case 'opt_in': {
              const p = readPolicy(this.l);
              p.repos[m.repo_id] = { ...(p.repos[m.repo_id] ?? {}), opt_in: m.opt_in !== false, ...(m.local_path ? { local_path: m.local_path } : {}) };
              writePolicy(this.l, p);
              this.policy = p;
              if (this.connected) this.#sendDevice({ type: 'advertise', repos: advertisable(this.policy, this.allowlist) });
              return reply({ ok: true });
            }
            case 'confirm_offer': { const p = this.confirms.get(m.request_id); if (p) p.resolve(!!m.accept); return reply({ ok: !!p }); }
            case 'stop_all':
              await Promise.all([...this.runs.values()].map((r) => r.command({ cmd: 'stop' })));
              return reply({ ok: true });
            case 'host_suspending': this.hostSuspending(); return reply({ ok: true });
            case 'host_resumed': this.hostResumed(); return reply({ ok: true });
            default: return reply({ ok: false, error: { code: 'VALIDATION', message: `unknown ${m.type}` } });
          }
        } catch (e) { return reply({ ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message } }); }
      }));
    });
    await new Promise((resolve, reject) => { this.control.once('error', reject); this.control.listen(sock, resolve); });
    fs.chmodSync(sock, 0o600);
  }
}
