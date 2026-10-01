// Read models for browsers: CardView, LeaseView, FeedEvent, Snapshot and
// CardDetail (CONTRACT §5.3, §5.4). Ages are computed at send time on the hub
// clocks; the web advances them itself.

import { createHash } from 'node:crypto';
import { ACTIVE } from '../shared/states.js';
import { isGreen } from '../shared/liveness.js';
import { FEED_KINDS } from '../shared/protocol.js';
import { json, HubError } from './db.js';
import { cleanLinkStatus } from './integrations/connector.js';
import { AI_LABELS, aiOfDispatch } from '../shared/ai.js';
import { workCaptureView } from './work-capture-view.js';
import { commentIdentity } from './remote/attribution.js';

export const EMAIL_ONLY = 'email:';   // github_login placeholder of an email-only (Access OTP) member
export const LOCAL_ONLY = 'local:';   // github_login placeholder of the BOARD_AUTH=local owner (D35)
export const publicLogin = (m) => (m.github_login?.startsWith(EMAIL_ONLY) || m.github_login?.startsWith(LOCAL_ONLY) ? null : m.github_login);
// The NOT NULL github columns of a member added by email only: a private
// placeholder login and a stable negative id (never an avatar).
export const emailOnlyIdentity = (email) => ({
  github_login: `${EMAIL_ONLY}${email.toLowerCase()}`,
  github_id: -Number.parseInt(createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12), 16),
});

export function leaseView(hub, row) {
  if (!ACTIVE.has(row.run_state) || !row.active_run_id) return null;
  const lm = hub.lease(row.active_run_id);
  const now = hub.mono();
  const age = (m) => (m == null ? null : Math.max(0, Math.round(now - m)));
  const wakeMono = Math.max(lm?.wake_mono ?? -Infinity, lm?.runner_wake_mono ?? -Infinity);
  const wake = Number.isFinite(wakeMono) ? wakeMono : null;
  const v = {
    hb_age_ms: age(lm?.hb_mono),
    child_alive: lm?.child_alive ?? false,
    activity_age_ms: age(lm?.activity_mono),
    tool_in_flight: lm?.tool ? { name: lm.tool.name, summary: lm.tool.summary ?? null, age_ms: age(lm.tool.since_mono), ...(lm.tool.bash_timeout_ms ? { bash_timeout_ms: lm.tool.bash_timeout_ms } : {}) } : null,
    wake_age_ms: age(wake),
    post_wake_activity: wake == null ? false : (wake === lm.wake_mono && lm.post_wake === true) || (lm.activity_mono != null && lm.activity_mono > wake),
  };
  v.green = isGreen({ ...v, run_state: row.run_state });
  return v;
}

function person(hub, id) {
  return id ? { member_id: id, name: hub.memberName(id) } : null;
}

function evidenceSummary(hub, cardId, runId) {
  const rows = runId
    ? hub.db.all('SELECT * FROM evidence WHERE card_id = ? AND run_id = ? ORDER BY created_at, rowid', cardId, runId)
    : [];
  if (!rows.length) return null;
  const test = [...rows].reverse().find((e) => e.kind === 'test_run');
  const none = rows.find((e) => e.kind === 'no_tests_reason');
  const verified = rows.some((e) => (e.kind === 'pr' || e.kind === 'commit') && e.verification === 'hub_verified');
  return { tests: test ? test.result ?? null : none ? 'none' : null, verification: verified ? 'hub_verified' : 'self_reported' };
}

function prView(hub, row) {
  const ev = hub.db.get("SELECT * FROM evidence WHERE card_id = ? AND kind = 'pr' ORDER BY created_at DESC, rowid DESC LIMIT 1", row.id);
  if (!ev) return null;
  const st = hub.prStatus.get(row.id);
  const number = Number(/(\d+)\/?$/.exec(ev.ref)?.[1] ?? NaN);
  const merged = hub.db.get("SELECT at_hub, payload FROM events WHERE card_id = ? AND kind = 'merged' ORDER BY id DESC LIMIT 1", row.id);
  return {
    number: Number.isFinite(number) ? number : null,
    url: st?.url ?? (/^https?:\/\//.test(ev.ref) ? ev.ref : null),
    state: merged ? 'merged' : st?.state ?? 'open',
    ...(merged ? { merged_by: json(merged.payload, {}).by ?? st?.merged_by ?? null, merged_age_ms: hub.ageOf(merged.at_hub) } : {}),
  };
}

// The integration's own view of the card's newest PR link (D42), beside
// `pr` (the merge poll's): additive, and only allowlisted values.
function prLinkStatus(hub, row) {
  const l = hub.db.get(`SELECT l.status FROM external_links l JOIN connections c ON c.id = l.connection_id
    WHERE l.card_id = ? AND l.kind = 'pr' AND c.status != 'revoked' ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1`, row.id);
  if (!l?.status) return null;
  const s = cleanLinkStatus(json(l.status, null));
  return Object.keys(s).length ? { state: s.state ?? null, checks: s.checks ?? null, review: s.review ?? null } : null;
}

function askView(hub, row) {
  const asks = hub.openAsks(row.id);
  const perms = hub.openPermissions(row.id);
  if (!asks.length && !perms.length) return null;
  if (row.blocked_kind === 'permission' || (!asks.length && perms.length)) {
    return { kind: 'permission', summary: perms[0]?.input_summary ?? null, count: perms.length, permission_request_id: perms[0]?.id ?? null };
  }
  const a = asks[0];
  const steps = a.kind === 'plan' ? json(a.options, []).length || null : null;
  return { kind: a.kind, summary: a.text.length > 80 ? `${a.text.slice(0, 79)}…` : a.text, count: asks.length + perms.length, ask_id: a.id, ...(steps ? { steps } : {}) };
}

// run.failed{limit} carries resets_in_ms as of when the hub received it.
function limitResetsIn(hub, row) {
  if (row.run_state !== 'failed' || row.fail_kind !== 'limit') return null;
  const ev = hub.db.get("SELECT payload, at_hub FROM events WHERE card_id = ? AND kind = 'run.failed' ORDER BY id DESC LIMIT 1", row.id);
  const ms = ev ? json(ev.payload, {}).resets_in_ms : null;
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms - hub.ageOf(ev.at_hub))) : null;
}

function deviceKind(hub, runRow) {
  const f = runRow ? hub.device(runRow.device_id)?.form_factor : null;
  return f === 'laptop' || f === 'desktop' ? f : null;
}

export function runCost(hub, run) {
  // A database default of zero is not a cost observation. Codex does not
  // expose dollar telemetry through this adapter, including older rows.
  const observed = aiOfDispatch(run) !== 'codex' && (run.cost_cents > 0 ||
    !!hub.db.get("SELECT 1 x FROM events WHERE run_id = ? AND kind = 'cost' LIMIT 1", run.id));
  return { cost_usd: observed ? run.cost_cents / 100 : null,
    cost_source: observed ? 'provider_reported' : 'unavailable' };
}

export function cardView(hub, row, viewerId) {
  const runRow = hub.run(row.active_run_id) ?? (row.run_state ? hub.latestRun(row.id) : null);
  const repo = hub.repo(row.repo_id);
  const perms = hub.openPermissions(row.id);
  const approvers = [...new Set(perms.flatMap((p) => json(p.approvers, [])))];
  const d = hub.pendingDispatch(row.id);
  const labels = hub.labels(row);
  const colors = hub.labelColors(row.board_id);
  let target = null;
  if (d && (row.run_state === 'queued' || row.run_state == null)) {
    const tid = hub.dispatchTarget(d);
    const dev = [...hub.runners.values()].find((c) => c.member_id === tid && c.repos.has(row.repo_id));
    target = { member_id: tid, name: hub.memberName(tid), is_viewer: tid === viewerId, ai: aiOfDispatch(d), ai_label: AI_LABELS[aiOfDispatch(d)], awaiting_confirm: !!d.needs_confirm, ...(dev ? { device_name: dev.device.name } : {}) };
  }
  const h = hub.latestHandover(row.id);
  const doc = h || runRow ? hub.handoverDoc(row.id) : null;
  const synced = doc ? [doc.ages.narrative_ms, doc.ages.facts_ms, doc.ages.snapshot_ms].filter((x) => x != null) : [];
  const ht = json(row.handover_target, null);
  const budgetCap = row.budget_cents;
  const stateAge = hub.ageOf(row.state_since);
  const clientFeedback = hub.clientFeedback?.cardProvenance(row.id);
  const capture = workCaptureView(hub, row.id);
  return {
    id: row.id, board_id: row.board_id, key: row.key, title: row.title, labels, column: row.column_name, version: row.version,
    label_colors: labels.map((l) => colors.get(String(l).toLowerCase()) ?? null),
    cover: row.cover ?? null,
    start_date: row.start_date ?? null, due_date: row.due_date ?? null,
    planning_in_scope: !row.archived_at && !hub.board(row.board_id)?.archived_at && (row.repo_id == null || !!hub.db.get('SELECT 1 x FROM board_repos WHERE board_id = ? AND repo_id = ?', row.board_id, row.repo_id)),
    depends_on: hub.db.all('SELECT depends_on_card_id FROM card_dependencies WHERE card_id = ? ORDER BY depends_on_card_id', row.id).map(d => d.depends_on_card_id),
    archived: row.archived_at ? { at_age_ms: Math.round(hub.ageOf(row.archived_at)), by_name: hub.memberName(row.archived_by) } : null,
    agent_suggested: !!row.created_by_run_id, parent_card_id: row.parent_card_id ?? null,
    ...(clientFeedback ? { client_feedback: clientFeedback } : {}),
    ...(capture ? { capture } : {}),
    run_state: row.run_state ?? 'todo',
    blocked_kind: row.blocked_kind, fail_kind: row.fail_kind, fail_reason: row.fail_reason, resume_to: row.resume_to, fence: row.fence,
    repo: repo ? { id: repo.id, short_name: repo.short_name } : null, base_ref: row.base_ref, branch: runRow?.branch ?? null,
    assignee_ids: hub.assignees(row.id), approvers, viewer_can_approve: approvers.includes(viewerId),
    target,
    queue: row.run_state === 'queued' ? (() => { const online = hub.runnerOnline(row.id); return { runner_online: online, offline_age_ms: online ? null : stateAge }; })() : null,
    run: runRow ? {
      id: runRow.id, backend: runRow.backend, device_name: hub.device(runRow.device_id)?.name ?? null,
      ai: aiOfDispatch(runRow), ai_label: AI_LABELS[aiOfDispatch(runRow)], budget_usd: runRow.budget_cents == null ? null : runRow.budget_cents / 100,
      budget_stop: runRow.terminal_reason === 'budget_device' ? 'device' : runRow.terminal_reason === 'budget' ? 'card' : null,
      owner: person(hub, runRow.on_behalf_of), dispatched_by: person(hub, runRow.dispatched_by),
    } : null,
    live: leaseView(hub, row),
    state_age_ms: stateAge == null ? 0 : Math.round(stateAge),
    ask: ['blocked', 'parked'].includes(row.run_state) || row.resume_to === 'blocked' ? askView(hub, row) : null,
    handover: doc && (h || synced.length) ? { version: h?.version ?? 0, synced_age_ms: synced.length ? Math.min(...synced) : null } : null,
    handover_target_name: ht ? (ht.kind === 'queue' ? 'the queue' : hub.memberName(ht.member_id ?? ht.by)) : null,
    stopped_by_name: row.stopped_by ? hub.memberName(row.stopped_by) : null,
    limit_resets_in_ms: limitResetsIn(hub, row),
    device_kind: deviceKind(hub, runRow),
    overlaps: hub.overlapViews(row),
    budget: budgetCap != null ? { spent_usd: hub.cardSpentCents(row.id) / 100, cap_usd: budgetCap / 100 } : null,
    pr: prView(hub, row),
    pr_link_status: prLinkStatus(hub, row),
    evidence: evidenceSummary(hub, row.id, runRow?.id),
  };
}

// Archived cards (D94) are left out unless asked for (the web's "Show archived").
export function boardSnapshot(hub, boardId, viewerId, { includeArchived = false } = {}) {
  const board = hub.board(boardId);
  const cards = hub.db.all(`SELECT * FROM cards WHERE board_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY created_at, key`, boardId);
  const members = hub.db.all('SELECT * FROM members WHERE org_id = ? AND removed_at IS NULL ORDER BY display_name', board.org_id);
  return {
    board_id: boardId,
    board: { id: board.id, name: board.name, key_prefix: board.key_prefix, archived_at: board.archived_at, settings: json(board.settings, {}), labels: hub.labelRegistry(boardId) },
    cards: cards.map((c) => cardView(hub, c, viewerId)),
    members: members.map((m) => ({ member_id: m.id, name: m.display_name, login: publicLogin(m), avatar_url: m.github_id > 0 ? `https://avatars.githubusercontent.com/u/${m.github_id}` : null })),
  };
}

export const labelDef = (r) => ({ id: r.id, name: r.name, color: r.color, description: r.description ?? null });

// Private desktop selection may only narrow ordinary staff projections.
// Keep ordinary cross-board collaboration intact when there is no selection.
export function selectedContext(hub, result, boardIds) {
  if (boardIds == null) return result;
  if (!Array.isArray(boardIds) || boardIds.length < 1 || boardIds.length > 32 || boardIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(id))) throw new HubError('VALIDATION', 'choose 1–32 boards');
  const project = view => ({ ...view, ...(view.overlaps ? { overlaps: view.overlaps.filter(peer => {
    const card = hub.card(peer.other_card_id), board = card && hub.board(card.board_id);
    return card && board && !card.archived_at && !board.archived_at && boardIds.includes(card.board_id);
  }) } : {}) });
  return { ...project(result), ...(result.card ? { card: project(result.card) } : {}), ...(result.cards ? { cards: result.cards.map(project) } : {}) };
}

export function cardDetail(hub, row, viewerId, feedEventOf) {
  const view = cardView(hub, row, viewerId);
  const runRow = hub.run(row.active_run_id) ?? hub.latestRun(row.id);
  const doc = hub.handoverDoc(row.id);
  // The last 200 FEED events: internal rows (tool_start/_end, activity, facts…)
  // are far more numerous and must not push feed lines out of the window.
  const feed = hub.db.all(`SELECT * FROM events WHERE card_id = ? AND kind IN (${FEED_KINDS.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 200`, row.id, ...FEED_KINDS)
    .map((e) => feedEventOf(e)).filter(Boolean).reverse();
  return {
    card: view,
    body: row.body,
    acceptance: row.acceptance,
    run: runRow ? {
      ...view.run,
      id: runRow.id, fence: runRow.fence, status_summary: runRow.status_summary, ...runCost(hub, runRow),
      planned_paths: json(runRow.planned_paths, []), touched_paths: json(runRow.touched_paths, []),
      snapshot: runRow.snapshot_status ? { sha: runRow.last_snapshot_sha, ref: runRow.snapshot_ref, status: runRow.snapshot_status, reason: runRow.snapshot_reason, age_ms: hub.ageOf(runRow.snapshot_at) } : null,
    } : null,
    handover: doc && (doc.version || runRow) ? { doc: doc.doc, ages: doc.ages, markdown: doc.markdown } : null,
    feed,
    comments: hub.db.all('SELECT * FROM comments WHERE card_id = ? ORDER BY created_at, rowid', row.id).map((c) => commentIdentity(hub, {
      id: c.id, author_name: c.author_member_id ? hub.memberName(c.author_member_id) : `${hub.memberName(hub.run(c.author_run_id)?.on_behalf_of) ?? '?'}'s ${AI_LABELS[aiOfDispatch(hub.run(c.author_run_id))]}`,
      source: c.source, trusted: !!c.trusted, body: c.body, for_agent: !!c.for_agent, reply_to: c.reply_to,
      delivered_age_ms: hub.ageOf(c.delivered_at), created_age_ms: hub.ageOf(c.created_at),
    })),
    permission_requests: hub.db.all('SELECT * FROM permission_requests WHERE card_id = ? ORDER BY created_at, rowid', row.id).map((p) => ({
      id: p.id, tool: p.tool, input_summary: p.input_summary, state: p.state, scope: p.scope, approvers: json(p.approvers, []),
      answered_by_name: p.answered_by ? hub.memberName(p.answered_by) : null, created_age_ms: hub.ageOf(p.created_at),
    })),
    asks: hub.db.all('SELECT * FROM asks WHERE card_id = ? ORDER BY created_at, rowid', row.id).map((a) => ({
      id: a.id, kind: a.kind, text: a.text, options: json(a.options, null), state: a.state, answer: a.answer,
      answered_by_name: a.answered_by ? hub.memberName(a.answered_by) : null, created_age_ms: hub.ageOf(a.created_at),
    })),
    evidence: hub.db.all('SELECT * FROM evidence WHERE card_id = ? ORDER BY created_at, rowid', row.id).map((e) => ({
      id: e.id, run_id: e.run_id, kind: e.kind, ref: e.ref, summary: e.summary, result: e.result, verification: e.verification, created_age_ms: hub.ageOf(e.created_at),
    })),
    overlaps: view.overlaps,
    memories: hub.db.all("SELECT * FROM memories WHERE card_id = ? AND kind = 'handoff' ORDER BY created_at DESC", row.id).map((m) => ({
      id: m.id, kind: m.kind, body: m.body, status: m.status, created_age_ms: hub.ageOf(m.created_at),
    })),
  };
}
