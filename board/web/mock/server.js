// Mock board hub for developing and testing the web app standalone.
//
//   node web/mock/server.js [--port 8788] [--login alice] [--script] [--interval 4000]
//
// Implements the browser-facing half of CONTRACT.md §5 (static files with the
// hub's CSP, the §5.2 HTTP routes, and /ws/board push) over in-memory
// fixtures. State changes go through the real shared step(), handover pages
// through mergeHandover/renderMarkdown, and every frame is checked with
// protocol.validate before it is sent. A small runner simulator claims
// dispatched cards and keeps live ones heartbeating.
//
// Control endpoints (never on the real hub):
//   POST /__mock/step            advance the scripted BDL-152 story one step
//   POST /__mock/script?interval run the whole story on a timer
//   POST /__mock/drop?ms=8000    drop every board socket and refuse reconnects
//   POST /__mock/reset           reload fixtures
//   POST /__mock/login?as=alice  set the dev cookie without the form (tests)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { step, ACTIVE, DARK, columnOf, PLAN_APPROVAL_LABEL } from '../../shared/states.js';
import { isGreen } from '../../shared/liveness.js';
import { mergeHandover, syncAges, renderMarkdown as handoverMarkdown } from '../../shared/handover.js';
import { PROTOCOL_VERSION, PROTOCOL_HEADER, WS_CLOSE, validate, compatible, httpStatus } from '../../shared/protocol.js';
import { BOARD, ORG, MEMBERS, REPOS, ONLINE, buildCards } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const SHARED = path.resolve(HERE, '../../shared');
const SHARED_OK = new Set(['states', 'liveness', 'fence', 'scope', 'overlap', 'cardface', 'handover', 'protocol']);
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' https://avatars.githubusercontent.com; style-src 'self'; script-src 'self'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PLAN_LABEL = PLAN_APPROVAL_LABEL;

class HttpError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}

export function createMockHub({ login = null, clock = () => Date.now() } = {}) {
  const epoch = randomUUID();
  const bootAt = clock();
  let cards = new Map();
  const idem = new Map();
  const sockets = new Set();
  let refuseUntil = 0;
  let scriptStep = 0;
  let scriptTimer = null;
  const timers = new Set();
  let seq = 0;

  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const member = (id) => MEMBERS.find((m) => m.member_id === id);
  const nameOf = (id) => member(id)?.name ?? 'Someone';
  const pub = (m) => ({ member_id: m.member_id, name: m.name, login: m.login, avatar_url: m.avatar_url });
  const who = (id) => (id ? { member_id: id, name: nameOf(id) } : null);

  function reset() {
    cards = new Map(buildCards(clock()).map((c) => [c.id, c]));
    scriptStep = 0;
  }
  reset();

  // ── views ──────────────────────────────────────────────────────────────

  function leaseView(c, now) {
    const l = c.live;
    if (!l || !ACTIVE.has(c.run_state)) return null;
    const v = {
      hb_age_ms: l.hb_at == null ? null : now - l.hb_at,
      child_alive: l.child_alive,
      activity_age_ms: l.activity_at == null ? null : now - l.activity_at,
      tool_in_flight: l.tool ? { name: l.tool.name, summary: l.tool.summary ?? null, age_ms: now - l.tool.started_at, ...(l.tool.bash_timeout_ms ? { bash_timeout_ms: l.tool.bash_timeout_ms } : {}) } : null,
      wake_age_ms: l.wake_at == null ? null : now - l.wake_at,
      post_wake_activity: !!l.post_wake_activity,
    };
    return { ...v, green: isGreen({ ...v, run_state: c.run_state }) };
  }

  function openPermission(c) {
    return (c.detail.permission_requests ?? []).filter((p) => p.state === 'open');
  }

  function handoverOf(c, now) {
    const d = c.detail;
    if (!d.narrative && !d.facts && !d.snapshot) return null;
    const doc = mergeHandover({
      card: { key: c.key, title: c.title, goal: c.title, done_means: c.acceptance || null, repo_id: REPOS.find((r) => r.id === c.repo_id)?.canonical_url ?? null },
      run: c.run ? { n: c.fence, fence: c.fence, run_state: c.run_state, agent_label: `${nameOf(c.run.owner_id)}'s Claude`, base_ref: c.base_ref } : null,
      facts: d.facts ?? null,
      narrative: d.narrative ?? null,
      snapshot: d.snapshot ?? null,
      salvage: d.salvage ?? [],
    });
    return { doc, ages: syncAges(doc, now), markdown: handoverMarkdown(doc, { now_ms: now }) };
  }

  function toView(c, viewerId, now = clock()) {
    const repo = REPOS.find((r) => r.id === c.repo_id);
    const approvers = [...new Set(openPermission(c).flatMap((p) => p.approvers))];
    const queued = c.run_state === 'queued';
    const online = queued && repo ? (ONLINE[repo.id] ?? []).includes(c.target?.member_id ?? viewerId) : true;
    const narrative = c.detail.narrative;
    return {
      id: c.id, key: c.key, title: c.title, labels: c.labels, column: c.column ?? columnOf(c.run_state), version: c.version,
      run_state: c.run_state,
      blocked_kind: c.blocked_kind ?? null, fail_kind: c.fail_kind ?? null, fail_reason: c.fail_reason ?? null, resume_to: c.resume_to ?? null, fence: c.fence,
      repo: repo ? { id: repo.id, short_name: repo.short_name } : null, base_ref: c.base_ref ?? null, branch: c.branch ?? null,
      assignee_ids: c.assignee_ids, approvers, viewer_can_approve: approvers.includes(viewerId),
      target: c.target && (queued || c.run_state === 'todo') ? { member_id: c.target.member_id, name: nameOf(c.target.member_id), is_viewer: c.target.member_id === viewerId, awaiting_confirm: !!c.target.awaiting_confirm, device_name: member(c.target.member_id)?.device } : null,
      queue: queued ? { runner_online: online, offline_age_ms: online ? null : now - (c.queue_offline_since ?? c.state_since) } : null,
      run: c.run ? { id: c.run.id, backend: c.run.backend, device_name: c.run.device_name ?? member(c.run.owner_id)?.device ?? null, owner: who(c.run.owner_id), dispatched_by: who(c.run.dispatched_by_id) } : null,
      live: leaseView(c, now),
      state_age_ms: Math.max(0, now - c.state_since),
      ask: c.run_state === 'blocked' || c.resume_to === 'blocked' ? (c.ask ?? null) : null,
      handover: c.handover_version ? { version: c.handover_version, synced_age_ms: c.handover_synced_at ? now - c.handover_synced_at : null }
        : narrative?.at_ms ? { version: narrative.version, synced_age_ms: now - narrative.at_ms } : null,
      handover_target_name: c.handover_target_name ?? null,
      stopped_by_name: c.stopped_by_name ?? null,
      limit_resets_in_ms: c.limit_resets_at ? Math.max(0, c.limit_resets_at - now) : null,
      device_kind: c.device_kind ?? null,
      overlaps: (c.overlaps ?? []).map((o) => {
        const other = cards.get(o.other_card_id);
        return { other_card_id: o.other_card_id, other_key: other?.key ?? '?', other_owner: other?.run ? nameOf(other.run.owner_id) : null, level: o.level, kind: o.kind, reasons: o.reasons, paths: o.paths, age_ms: now - o.since };
      }),
      budget: c.budget ?? null,
      pr: c.pr ? { number: c.pr.number, url: c.pr.url, state: c.pr.state, ...(c.pr.merged_by ? { merged_by: c.pr.merged_by } : {}), ...(c.pr.merged_at ? { merged_age_ms: now - c.pr.merged_at } : {}) } : null,
      evidence: c.evidence ?? null,
    };
  }

  function feedEvent(ev, now) {
    return { id: ev.id, kind: ev.kind, at_age_ms: Math.max(0, now - ev.at), ...(ev.actor_name ? { actor_name: ev.actor_name } : {}), ...(ev.run_n != null ? { run_n: ev.run_n } : {}), ...(ev.text ? { text: ev.text } : {}), data: ev.data ?? {} };
  }

  function toDetail(c, viewerId) {
    const now = clock();
    const d = c.detail;
    return {
      card: toView(c, viewerId, now),
      body: c.body ?? '', acceptance: c.acceptance ?? '',
      run: c.run ? { id: c.run.id, backend: c.run.backend, planned_paths: d.planned_paths ?? [], touched_paths: (d.facts?.files_touched ?? []).map((f) => f.path), snapshot: d.snapshot ? { sha: d.snapshot.sha, ref: d.snapshot.ref, status: d.snapshot.status, reason: d.snapshot.reason ?? null, age_ms: now - d.snapshot.at_ms } : null } : null,
      handover: handoverOf(c, now),
      feed: (d.feed ?? []).slice(-200).map((ev) => feedEvent(ev, now)),
      comments: (d.comments ?? []).map((cm) => ({ id: cm.id, author_name: cm.author_name, source: cm.source, trusted: cm.trusted, body: cm.body, for_agent: !!cm.for_agent, delivered_age_ms: cm.delivered_at ? now - cm.delivered_at : null, created_age_ms: now - cm.created_at })),
      permission_requests: (d.permission_requests ?? []).map((p) => ({ id: p.id, tool: p.tool, input_summary: p.input_summary, state: p.state, approvers: p.approvers, answered_by_name: p.answered_by_name ?? null })),
      asks: d.asks ?? [],
      evidence: d.evidence ?? [],
      overlaps: toView(c, viewerId, now).overlaps,
      memories: d.memories ?? [],
    };
  }

  // ── push ───────────────────────────────────────────────────────────────

  function send(ws, msg) {
    const err = validate('hub→browser', msg);
    if (err) throw new Error(`mock hub built an invalid ${msg.type} frame: ${err.message}`);
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  const subscribed = () => [...sockets].filter((s) => s.boardId === BOARD.id);
  const upsert = (c) => { for (const s of subscribed()) send(s, { type: 'card.upsert', board_id: BOARD.id, card: toView(c, s.memberId) }); };
  function feed(c, kind, extra = {}) {
    const ev = { id: `ev-${++seq}-${randomUUID().slice(0, 8)}`, kind, at: clock(), run_n: c.run ? c.fence : undefined, ...extra };
    (c.detail.feed ??= []).push(ev);
    for (const s of subscribed()) send(s, { type: 'event.append', card_id: c.id, event: feedEvent(ev, clock()) });
  }
  function snapshotFor(memberId) {
    return { type: 'snapshot', board_id: BOARD.id, board: BOARD, cards: [...cards.values()].map((c) => toView(c, memberId)), members: MEMBERS.map(pub) };
  }

  // ── state machine glue ─────────────────────────────────────────────────

  const machine = (c) => ({ run_state: c.run_state, blocked_kind: c.blocked_kind ?? null, fail_kind: c.fail_kind ?? null, resume_to: c.resume_to ?? null, pre_reconnect_state: c.pre_reconnect_state ?? null, fence: c.fence, handover_target: c.handover_target ?? null, handover_provenance: c.handover_provenance ?? null });

  function ctxFor(c, extra = {}) {
    const openAsks = (c.detail.asks ?? []).filter((a) => a.state === 'open').length + openPermission(c).length;
    return {
      has_repo: !!c.repo_id, can_write: true, policy_ok: true, can_cancel: true, is_target_member: true, repo_advertised: true, runner_accepts: true,
      no_active_run: true, can_answer: true, open_asks_remaining: openAsks, require_plan_approval: (c.labels ?? []).includes(PLAN_LABEL),
      can_stop: true, policy_allows_requeue: true, can_hand_over: true, evidence_ok: true, hub_uptime_ms: clock() - bootAt + 3_600_000, tunnel_ok: true,
      ...extra,
    };
  }

  function apply(c, event, ctx = {}, meta = {}) {
    const r = step(machine(c), event, ctxFor(c, ctx));
    if (!r.ok) throw new HttpError(r.error.code, r.error.message);
    Object.assign(c, r.card);
    const changed = r.from !== r.to;
    if (changed) c.state_since = clock();
    c.version += 1;
    if (r.to !== 'todo') c.column = null;
    if (!ACTIVE.has(r.to)) c.live = null;
    for (const eff of r.effects) {
      if (eff.type === 'dispatch_create') {
        const target = eff.target_member_id ?? meta.by ?? 'm-alice';
        c.target = { member_id: target, awaiting_confirm: eff.needs_confirm };
        c.dispatched_by_id = meta.by;
        c.queue_offline_since = clock();
        later(700, () => simulateClaim(c.id));
      }
      if (eff.type === 'offer_to_runners' && !r.effects.some((e) => e.type === 'dispatch_create')) later(700, () => simulateClaim(c.id));
      if (eff.type === 'feed') feed(c, eff.kind, { actor_name: meta.by ? nameOf(meta.by) : undefined, data: Object.fromEntries(Object.entries(eff).filter(([k]) => !['type', 'kind', 'by'].includes(k))) });
      if (eff.type === 'handover_freeze' && c.detail.narrative) c.handover_synced_at = c.detail.narrative.at_ms;
      if (eff.type === 'follow_up') later(400, () => { try { apply(c, { ...eff.event, request_id: randomUUID(), by: meta.by }, {}, meta); upsert(c); } catch { /* card moved on */ } });
      if (eff.type === 'assign' && eff.member_id && !c.assignee_ids.includes(eff.member_id)) c.assignee_ids = [...c.assignee_ids, eff.member_id];
    }
    if (r.to === 'todo') { c.run = null; c.target = null; c.column = c.column ?? 'todo'; c.branch = null; }
    if (r.to !== 'queued' && r.to !== 'todo') c.target = null;
    return r;
  }

  function simulateClaim(id) {
    const c = cards.get(id);
    if (!c || c.run_state !== 'queued' || c.scripted) return;
    const target = c.target?.member_id ?? 'm-alice';
    if (!(ONLINE[c.repo_id] ?? []).includes(target)) return; // no runner: stays queued, "no runner online"
    if (c.target?.awaiting_confirm) {
      later(4000, () => { if (c.run_state === 'queued' && c.target) { c.target.awaiting_confirm = false; c.version += 1; upsert(c); later(600, () => simulateClaim(id)); } });
      return;
    }
    apply(c, { type: 'claim', expected_fence: c.fence });
    const owner = target;
    c.run = { id: `run-${randomUUID().slice(0, 8)}`, backend: 'claude_cli', owner_id: owner, dispatched_by_id: c.dispatched_by_id ?? owner, device_name: member(owner)?.device };
    c.branch = `board/${c.key}-r${c.fence}`;
    c.live = { hb_at: clock(), child_alive: true, activity_at: null, tool: null, wake_at: null, post_wake_activity: false, pulse: false };
    upsert(c);
    later(1500, () => {
      if (c.run_state !== 'claimed') return;
      apply(c, { type: 'activity', fence: c.fence, delayed: false });
      c.live = { ...c.live, activity_at: clock(), pulse: true, tool: { name: 'Read', summary: 'README.md', started_at: clock() } };
      upsert(c);
    });
  }

  // Heartbeats and activity for live cards; lease.tick at most every 5 s.
  const TOOLS = [
    { name: 'Read', summary: 'backend/routes/auth.js' }, { name: 'Grep', summary: 'magic-link' },
    { name: 'Edit', summary: 'backend/routes/auth.js' }, { name: 'Bash', summary: 'npm test -- auth', bash_timeout_ms: 120000 },
  ];
  let toolIx = 0;
  function pulse() {
    const now = clock();
    for (const c of cards.values()) {
      if (!ACTIVE.has(c.run_state) || !c.live || DARK.has(c.run_state)) continue;
      c.live.hb_at = now - 1000;
      if (c.live.pulse) {
        c.live.activity_at = now - 2000;
        if (c.id === 'c-152' && c.run_state === 'running') c.live.tool = { ...TOOLS[toolIx++ % TOOLS.length], started_at: now - 1500 };
      }
      for (const s of subscribed()) {
        const lv = leaseView(c, now);
        if (lv) send(s, { type: 'lease.tick', card_id: c.id, live: lv, state_age_ms: Math.max(0, now - c.state_since) });
      }
    }
  }
  const pulseTimer = setInterval(pulse, 5000);

  // ── the scripted story (BDL-152) ───────────────────────────────────────

  const SCRIPT = [
    () => { const c = cards.get('c-152'); c.scripted = true; apply(c, { type: 'dispatch', request_id: randomUUID(), target_member_id: null }, {}, { by: 'm-alice' }); return c; },
    () => { const c = cards.get('c-152'); simulateClaimNow(c); return c; },
    () => { const c = cards.get('c-152'); apply(c, { type: 'activity', fence: c.fence }); c.live = { ...c.live, activity_at: clock(), pulse: true, tool: { name: 'Edit', summary: 'backend/routes/auth.js', started_at: clock() } }; return c; },
    () => {
      const c = cards.get('c-152');
      c.detail.narrative = { plan: [{ text: 'Find the magic-link route', status: 'done' }, { text: 'Add per-email + per-IP limiter', status: 'doing' }, { text: 'Test + PR', status: 'todo' }], done: ['Found POST /api/auth/magic-link in backend/routes/auth.js'], hypothesis: 'A sliding window in Redis keyed by email and by IP covers both abuse paths.', dead_ends: null, next: 'Pick the limit, then write the 429 test.', questions: null, at_ms: clock(), version: 1, written_by: 'claude' };
      c.detail.asks = [{ id: 'ask-152', kind: 'question', text: 'Per-email limit: 5 or 10 requests a minute?', options: ['5 a minute', '10 a minute'], state: 'open' }];
      c.ask = { kind: 'question', summary: '5 or 10 a minute?', count: 1 };
      apply(c, { type: 'block', fence: c.fence, kind: 'question' });
      return c;
    },
    () => {
      const c = cards.get('c-152');
      const a = c.detail.asks[0];
      Object.assign(a, { state: 'answered', answer: '5 a minute', answered_by_name: 'Sam' });
      apply(c, { type: 'answer', by: 'm-sam' }, { open_asks_remaining: 0 }, { by: 'm-sam' });
      c.ask = null;
      c.live = { ...c.live, activity_at: clock(), pulse: true };
      return c;
    },
    () => { const c = cards.get('c-152'); c.live = { ...c.live, pulse: false, hb_at: clock() - 50_000, activity_at: clock() - 52_000 }; apply(c, { type: 'hb_timeout' }); return c; },
    () => { const c = cards.get('c-152'); apply(c, { type: 'orphan_timeout' }); c.state_since = clock() - 11 * 60_000; c.handover_synced_at = c.detail.narrative?.at_ms ?? clock(); return c; },
    () => { const c = cards.get('c-152'); apply(c, { type: 'take_over', by: 'm-sam' }, {}, { by: 'm-sam' }); c.handover_target_name = 'Sam'; c.handover_version = (c.detail.narrative?.version ?? 0) + 1; return c; },
    () => { const c = cards.get('c-152'); apply(c, { type: 'redispatch', request_id: randomUUID(), target_member_id: 'm-alice', by: 'm-sam' }, {}, { by: 'm-sam' }); return c; },
    () => { const c = cards.get('c-152'); if (c.run_state === 'queued') simulateClaimNow(c); if (c.run_state === 'claimed') { apply(c, { type: 'activity', fence: c.fence }); c.live = { ...c.live, activity_at: clock(), pulse: true }; } return c; },
    () => {
      const c = cards.get('c-152');
      apply(c, { type: 'complete', fence: c.fence });
      c.pr = { number: 1057, url: 'https://github.com/pistorventures/bondly/pull/1057', state: 'open' };
      c.evidence = { tests: 'pass', verification: 'hub_verified' };
      c.budget = { spent_usd: 1.62, cap_usd: 4 };
      return c;
    },
    () => { const c = cards.get('c-152'); apply(c, { type: 'pr_merged', pr: 1057, by: 'James' }); c.pr = { ...c.pr, state: 'merged', merged_by: 'James', merged_at: clock() }; return c; },
    () => { drop(8000); return null; },
  ];

  function simulateClaimNow(c) {
    apply(c, { type: 'claim', expected_fence: c.fence });
    c.run = { id: `run-${randomUUID().slice(0, 8)}`, backend: 'claude_cli', owner_id: c.target?.member_id ?? 'm-alice', dispatched_by_id: c.dispatched_by_id ?? 'm-alice', device_name: 'MacBook Pro' };
    c.run.owner_id ??= 'm-alice';
    c.branch = `board/${c.key}-r${c.fence}`;
    c.live = { hb_at: clock(), child_alive: true, activity_at: null, tool: null, wake_at: null, post_wake_activity: false, pulse: false };
  }

  function stepScript() {
    if (scriptStep >= SCRIPT.length) return { done: true, step: scriptStep };
    const c = SCRIPT[scriptStep++]();
    if (c) upsert(c);
    return { done: scriptStep >= SCRIPT.length, step: scriptStep, state: c?.run_state ?? 'dropped' };
  }

  function drop(ms) {
    refuseUntil = clock() + ms;
    for (const s of sockets) s.terminate();
    sockets.clear();
  }

  // ── HTTP ───────────────────────────────────────────────────────────────

  function cookieMember(req) {
    const m = /(?:^|;\s*)board_dev=([^;]+)/.exec(req.headers.cookie ?? '');
    const id = m ? decodeURIComponent(m[1]) : null;
    return MEMBERS.find((x) => x.member_id === id) ?? (login ? MEMBERS.find((x) => x.login === login) : null);
  }

  function headers(extra = {}) {
    return { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...extra };
  }
  function json(res, status, body, extra = {}) {
    res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', ...extra }));
    res.end(JSON.stringify(body));
  }
  function fail(res, err) {
    if (err instanceof HttpError) return json(res, httpStatus(err.code), { error: { code: err.code, message: err.message, ...err.extra } });
    console.error(err);
    return json(res, 500, { error: { code: 'INTERNAL', message: String(err.message ?? err) } });
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const ch of req) { size += ch.length; if (size > 1 << 20) throw new HttpError('PAYLOAD_TOO_LARGE', 'body over 1 MiB'); chunks.push(ch); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError('VALIDATION', 'body is not JSON'); }
  }

  async function serveFile(req, res, file) {
    let buf;
    try { buf = await readFile(file); } catch { return json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } }); }
    const etag = `"${createHash('sha1').update(buf).digest('hex').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers({ ETag: etag })); return res.end(); }
    res.writeHead(200, headers({ 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', ETag: etag }));
    return res.end(buf);
  }

  function card(id) {
    const c = cards.get(id);
    if (!c) throw new HttpError('NOT_FOUND', 'no such card');
    return c;
  }

  const ACTION_EVENT = { dispatch: 'dispatch', cancel: 'cancel', stop: 'stop', retry: 'retry', take_over: 'take_over', hand_over: 'hand_over', take_over_with_claude: 'redispatch', take_over_myself: 'take_myself', request_changes: 'request_changes', approve_done: 'approve_done', answer: 'answer' };

  function runAction(c, action, body, me) {
    const type = ACTION_EVENT[action];
    if (!type) throw new HttpError('NOT_FOUND', `unknown action ${action}`);
    const ev = { type, request_id: body.request_id, by: me.member_id };
    const ctx = {};
    if (type === 'dispatch' || type === 'redispatch' || type === 'retry') {
      ev.target_member_id = body.target_member_id ?? null;
      ctx.needs_confirm = !!body.target_member_id && body.target_member_id !== me.member_id;
      if (body.backend && body.backend !== 'claude_cli') throw new HttpError('VALIDATION', 'Phase 1 dispatches claude_cli only');
      if (Number.isFinite(body.budget_usd) && body.budget_usd > 0) c.budget = { spent_usd: 0, cap_usd: body.budget_usd };
    }
    if (type === 'take_over') ctx.confirmed = body.confirm === true;
    if (type === 'hand_over') ev.target = body.target;
    if (type === 'answer') {
      const ask = (c.detail.asks ?? []).find((a) => a.id === body.ask_id);
      if (!ask) throw new HttpError('NOT_FOUND', 'no such ask');
      if (ask.state !== 'open') throw new HttpError('ALREADY_ANSWERED', `already answered by ${ask.answered_by_name}`, { answered_by: { name: ask.answered_by_name } });
      Object.assign(ask, { state: 'answered', answer: String(body.answer ?? ''), answered_by_name: me.name });
    }
    const r = apply(c, ev, ctx, { by: me.member_id });
    if (type === 'stop') c.stopped_by_name = me.name;
    if (type === 'take_over') { c.handover_target_name = me.name; c.handover_version = (c.detail.narrative?.version ?? 0) + 1; }
    if (type === 'answer' && r.to !== 'blocked') { c.ask = null; if (c.live) c.live.activity_at = clock(); }
    if (type === 'hand_over') later(2500, () => { if (c.run_state !== 'handing_over') return; try { apply(c, { type: 'handover_complete', fence: c.fence }); c.handover_target_name = body.target?.kind === 'member' ? nameOf(body.target.member_id) : body.target?.kind === 'self' ? me.name : 'the queue'; c.handover_version = (c.detail.narrative?.version ?? 0) + 1; upsert(c); } catch { /* moved */ } });
    if (type === 'request_changes' && body.comment) (c.detail.comments ??= []).push({ id: `cm-${randomUUID().slice(0, 8)}`, author_name: me.name, source: 'human', trusted: true, body: body.comment, for_agent: true, created_at: clock() });
    upsert(c);
    return r;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    const method = req.method;

    if (method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(req, res, path.join(WEB, 'index.html'));
    if (method === 'GET' && p.startsWith('/web/')) {
      const f = path.normalize(path.join(WEB, p.slice(5)));
      if (!f.startsWith(WEB + path.sep) || f.includes(`${path.sep}mock${path.sep}`) || f.includes(`${path.sep}test${path.sep}`)) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      return serveFile(req, res, f);
    }
    if (method === 'GET' && p.startsWith('/shared/')) {
      const m = /^\/shared\/([a-z]+)\.js$/.exec(p);
      if (!m || !SHARED_OK.has(m[1])) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      return serveFile(req, res, path.join(SHARED, `${m[1]}.js`));
    }

    if (p.startsWith('/__mock/') && method === 'POST') {
      if (p === '/__mock/step') return json(res, 200, stepScript());
      if (p === '/__mock/script') { runScript(Number(url.searchParams.get('interval')) || 4000); return json(res, 200, { ok: true }); }
      if (p === '/__mock/drop') { drop(Number(url.searchParams.get('ms')) || 8000); return json(res, 200, { ok: true }); }
      if (p === '/__mock/reset') { reset(); for (const s of subscribed()) send(s, snapshotFor(s.memberId)); return json(res, 200, { ok: true }); }
      if (p === '/__mock/login') {
        const m = MEMBERS.find((x) => x.login === url.searchParams.get('as'));
        if (!m) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'no such member' } });
        return json(res, 200, { member: pub(m) }, { 'Set-Cookie': `board_dev=${encodeURIComponent(m.member_id)}; Path=/; HttpOnly; SameSite=Strict` });
      }
    }

    if (!p.startsWith('/api/')) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    if (p === '/api/health') return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, hub_epoch: epoch, uptime_ms: clock() - bootAt, auth: 'dev' });

    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating) {
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError('VALIDATION', 'Content-Type must be application/json');
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new HttpError('FORBIDDEN', 'cross-origin request');
    }

    if (p === '/api/dev/login' && method === 'POST') {
      const body = await readJson(req);
      const m = MEMBERS.find((x) => x.login === String(body.github_login ?? '').toLowerCase());
      if (!m) throw new HttpError('FORBIDDEN', 'not a member of this board');
      return json(res, 200, { member: pub(m) }, { 'Set-Cookie': `board_dev=${encodeURIComponent(m.member_id)}; Path=/; HttpOnly; SameSite=Strict` });
    }

    const me = cookieMember(req);
    if (!me) throw new HttpError('UNAUTHENTICATED', 'sign in first');

    if (p === '/api/me') return json(res, 200, { member: { id: me.member_id, login: me.login, name: me.name, email: me.email, avatar_url: me.avatar_url, role: me.role }, org: ORG, boards: [{ id: BOARD.id, name: BOARD.name, key_prefix: BOARD.key_prefix }] });
    if (p === '/api/repos' && method === 'GET') return json(res, 200, { repos: REPOS });

    let m;
    if ((m = /^\/api\/boards\/([^/]+)$/.exec(p)) && method === 'GET') {
      if (m[1] !== BOARD.id) throw new HttpError('NOT_FOUND', 'no such board');
      const { type, ...snap } = snapshotFor(me.member_id);
      return json(res, 200, snap);
    }
    if ((m = /^\/api\/cards\/([^/]+)$/.exec(p)) && method === 'GET') return json(res, 200, toDetail(card(decodeURIComponent(m[1])), me.member_id));
    if ((m = /^\/api\/cards\/([^/]+)\/handover$/.exec(p)) && method === 'GET') {
      const ho = handoverOf(card(decodeURIComponent(m[1])), clock());
      if (!ho) throw new HttpError('NOT_FOUND', 'no handover yet');
      if (url.searchParams.get('format') === 'md') { res.writeHead(200, headers({ 'Content-Type': 'text/markdown; charset=utf-8' })); return res.end(ho.markdown); }
      return json(res, 200, ho);
    }
    if ((m = /^\/api\/cards\/([^/]+)\/overlap-preview$/.exec(p)) && method === 'GET') {
      const c = card(decodeURIComponent(m[1]));
      const targetId = url.searchParams.get('target_member_id') || me.member_id;
      const t = member(targetId);
      const text = `${c.title}\n${c.body ?? ''}`;
      const overlaps = [];
      for (const o of cards.values()) {
        if (o.id === c.id || o.repo_id !== c.repo_id || !ACTIVE.has(o.run_state)) continue;
        const paths = (o.detail.facts?.files_touched ?? []).filter((f) => f.op !== 'read' && text.includes(f.path)).map((f) => f.path);
        if (paths.length) overlaps.push({ other_card_id: o.id, other_key: o.key, other_owner: o.run ? nameOf(o.run.owner_id) : null, level: 'high', kind: 'overlapping', reasons: ['named in this card'], paths, age_ms: 0 });
      }
      const sponsor = targetId === me.member_id
        ? `Runs on your ${t.device} · your claude account`
        : `Runs on ${t.name}'s ${t.device} · ${t.name}'s claude account · ${t.name} must confirm`;
      return json(res, 200, { overlaps, sponsor });
    }

    if (!mutating) throw new HttpError('NOT_FOUND', 'not found');
    const body = await readJson(req);
    if (!body.request_id) throw new HttpError('VALIDATION', 'request_id required');
    const idemKey = `${me.member_id}:${body.request_id}`;
    if (idem.has(idemKey)) { const r = idem.get(idemKey); return json(res, r.status, r.body); }
    const remember = (status, out) => { idem.set(idemKey, { status, body: out }); later(10 * 60_000, () => idem.delete(idemKey)); return json(res, status, out); };

    if ((m = /^\/api\/boards\/([^/]+)\/cards$/.exec(p)) && method === 'POST') {
      if (!String(body.title ?? '').trim()) throw new HttpError('VALIDATION', 'A title is required.');
      const n = Math.max(...[...cards.values()].map((c) => Number(c.key.split('-')[1]))) + 1;
      const c = {
        id: `c-${n}`, key: `${BOARD.key_prefix}-${n}`, title: String(body.title).trim(), body: body.body ?? '', acceptance: body.acceptance ?? '',
        labels: body.labels ?? [], column: 'todo', version: 1, run_state: 'todo', fence: 0, repo_id: body.repo_id ?? null,
        base_ref: body.base_ref ?? REPOS.find((r) => r.id === body.repo_id)?.default_branch ?? null, assignee_ids: body.assignees ?? [me.member_id], run: null, live: null, overlaps: [],
        state_since: clock(), budget: body.budget_usd ? { spent_usd: 0, cap_usd: body.budget_usd } : null, detail: { feed: [] },
      };
      cards.set(c.id, c);
      upsert(c);
      return remember(200, { card: toView(c, me.member_id) });
    }
    if ((m = /^\/api\/cards\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      const c = card(decodeURIComponent(m[1]));
      if (body.version !== c.version) throw new HttpError('VERSION_CONFLICT', 'card changed');
      if (body.column != null && c.run_state !== 'todo') throw new HttpError('CONFLICT', 'column follows the run while a run exists');
      for (const k of ['title', 'body', 'acceptance', 'labels', 'repo_id', 'base_ref', 'column']) if (k in body) c[k] = body[k];
      if ('assignees' in body) c.assignee_ids = body.assignees;
      c.version += 1;
      upsert(c);
      return remember(200, { card: toView(c, me.member_id) });
    }
    if ((m = /^\/api\/cards\/([^/]+)\/actions\/([a-z_]+)$/.exec(p)) && method === 'POST') {
      const c = card(decodeURIComponent(m[1]));
      runAction(c, m[2], body, me);
      return remember(200, { card: toView(c, me.member_id), ...(c.run ? { run_id: c.run.id } : {}) });
    }
    if ((m = /^\/api\/permission-requests\/([^/]+)\/answer$/.exec(p)) && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const c = [...cards.values()].find((x) => (x.detail.permission_requests ?? []).some((pr) => pr.id === id));
      if (!c) throw new HttpError('NOT_FOUND', 'no such request');
      const pr = c.detail.permission_requests.find((x) => x.id === id);
      if (!pr.approvers.includes(me.member_id)) throw new HttpError('FORBIDDEN', 'You are not an approver on this run.');
      if (pr.state !== 'open') throw new HttpError('ALREADY_ANSWERED', `already answered by ${pr.answered_by_name}`, { answered_by: { name: pr.answered_by_name } });
      if (!['allow', 'deny'].includes(body.decision)) throw new HttpError('VALIDATION', 'decision must be allow or deny');
      Object.assign(pr, { state: body.decision === 'allow' ? 'allowed' : 'denied', answered_by_name: me.name, scope: body.scope ?? 'once' });
      const remaining = openPermission(c).length;
      c.ask = remaining ? { ...c.ask, count: remaining, summary: openPermission(c)[0].input_summary } : null;
      apply(c, { type: 'answer', by: me.member_id }, { open_asks_remaining: remaining }, { by: me.member_id });
      if (!remaining && c.live) { c.live.activity_at = clock(); c.live.pulse = true; }
      upsert(c);
      return remember(200, { permission_request: { id: pr.id, state: pr.state, answered_by_name: pr.answered_by_name }, card: toView(c, me.member_id) });
    }
    if ((m = /^\/api\/cards\/([^/]+)\/comments$/.exec(p)) && method === 'POST') {
      const c = card(decodeURIComponent(m[1]));
      const text = String(body.body ?? '').trim();
      if (!text) throw new HttpError('VALIDATION', 'A comment needs some text.');
      const cm = { id: `cm-${randomUUID().slice(0, 8)}`, author_name: me.name, source: 'human', trusted: true, body: text, for_agent: !!body.for_agent, created_at: clock() };
      (c.detail.comments ??= []).push(cm);
      if (cm.for_agent && c.run_state === 'running') later(3000, () => { cm.delivered_at = clock(); feed(c, 'comment', { text: 'Claude saw a comment' }); });
      feed(c, 'comment', { actor_name: me.name, text: text.slice(0, 140) });
      return remember(200, { comment: { id: cm.id, author_name: cm.author_name, source: cm.source, trusted: true, body: cm.body, for_agent: cm.for_agent, delivered_age_ms: null, created_age_ms: 0 } });
    }
    throw new HttpError('NOT_FOUND', 'not found');
  }

  function runScript(interval) {
    clearInterval(scriptTimer);
    scriptTimer = setInterval(() => { if (stepScript().done) clearInterval(scriptTimer); }, interval);
  }

  // ── server ─────────────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => fail(res, err));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname !== '/ws/board' || clock() < refuseUntil) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    const me = cookieMember(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!me) { ws.close(WS_CLOSE.UNAUTHENTICATED, 'sign in first'); return; }
      ws.memberId = me.member_id;
      ws.boardId = null;
      ws.hello = false;
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        const err = validate('browser→hub', msg);
        if (err) return send(ws, { type: 'error', code: 'VALIDATION', message: err.message });
        if (msg.type === 'hello') {
          if (!compatible(msg.protocol)) { send(ws, { type: 'error', code: 'PROTOCOL_UNSUPPORTED', message: `hub speaks protocol ${PROTOCOL_VERSION}` }); ws.close(WS_CLOSE.PROTOCOL_UNSUPPORTED); return; }
          ws.hello = true;
          send(ws, { type: 'welcome', protocol: PROTOCOL_VERSION, hub_epoch: epoch, member: { id: me.member_id, name: me.name, login: me.login } });
          return;
        }
        if (!ws.hello) return send(ws, { type: 'error', code: 'VALIDATION', message: 'hello first' });
        if (msg.type === 'subscribe') {
          if (msg.board_id !== BOARD.id) return send(ws, { type: 'error', code: 'NOT_FOUND', message: 'no such board' });
          ws.boardId = msg.board_id;
          send(ws, snapshotFor(me.member_id));
        }
        if (msg.type === 'unsubscribe') ws.boardId = null;
        if (msg.type === 'ping') send(ws, { type: 'pong' });
      });
    });
  });

  return {
    server,
    listen(port = 8788, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    async close() {
      clearInterval(pulseTimer);
      clearInterval(scriptTimer);
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.terminate();
      await new Promise((r) => wss.close(() => r()));
      await new Promise((r) => server.close(() => r()));
    },
    stepScript,
    drop,
    reset,
    cards: () => cards,
    toView,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? (process.argv[i + 1] ?? true) : dflt; };
  const hub = createMockHub({ login: arg('login', null) });
  const port = await hub.listen(Number(arg('port', 8788)));
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'mock board hub listening', url: `http://127.0.0.1:${port}/` })}\n`);
  if (process.argv.includes('--script')) {
    const every = Number(arg('interval', 4000));
    const t = setInterval(() => { if (hub.stepScript().done) clearInterval(t); }, every);
  }
}
