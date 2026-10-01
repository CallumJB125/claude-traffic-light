// Card face (design §4.2, §3.12 #1/#2/#10): pill (icon + label · reason),
// tone, primary actions, sponsor line, activity line, overlap chip, budget
// bar, and the per-viewer alerts strip. Pure: the web calls cardFace() every
// second with the CardView from the hub (protocol.js) and the elapsed time
// since that view arrived. Green appears ONLY when liveness.isGreen holds on
// the advanced ages.
//
// Browser-safe, dependency-free.

import { isGreen, advanceView, toolBound, formatAge, TTL_MS, ORPHAN_NOTIFY_MS } from './liveness.js';
import { ACTIVE, columnOf } from './states.js';

export const PILLS = Object.freeze({
  queued: { icon: '⏳', label: 'Queued', tone: 'grey' },
  claimed: { icon: '◌', label: 'Starting', tone: 'grey' },
  running: { icon: '●', label: 'Running', tone: 'green' },
  quiet: { icon: '◐', label: 'Quiet', tone: 'quiet' },
  blocked: { icon: '✋', label: 'Needs you', tone: 'amber' },
  parked: { icon: '⏸', label: 'Parked', tone: 'amber' },
  suspended: { icon: '☾', label: 'Suspended', tone: 'grey' },
  reconnecting: { icon: '↻', label: 'Reconnecting', tone: 'grey' },
  unresponsive: { icon: '◌', label: 'No signal', tone: 'grey' },
  orphaned: { icon: '✖', label: 'Orphaned', tone: 'red' },
  handing_over: { icon: '⇄', label: 'Handing over', tone: 'violet' },
  handed_over: { icon: '⇄', label: 'Handed over', tone: 'violet' },
  failed: { icon: '✖', label: 'Failed', tone: 'red' },
  failed_limit: { icon: '✖', label: 'Stopped', tone: 'red' },
  in_review: { icon: '◆', label: 'In review', tone: 'purple' },
  done: { icon: '✓', label: 'Done', tone: 'done' },
  todo: { icon: '', label: '', tone: 'none' },
});

const BACKEND_LABEL = { claude_cli: 'Claude', codex_cli: 'Codex', interactive: 'Claude', cloud_ma: 'Claude', cloud_gha: 'Claude' };
const BACKEND_CLI = { claude_cli: 'claude', codex_cli: 'codex', interactive: 'claude', cloud_ma: 'claude', cloud_gha: 'claude' };

export const possessive = (name) => `${name}'s`;
const basename = (p) => String(p).split('/').pop();

export function agentName(view) {
  const owner = view.run?.owner?.name ?? view.target?.name ?? 'Unknown';
  return `${possessive(owner)} ${BACKEND_LABEL[view.run?.backend] ?? 'Claude'}`;
}

function toolText(t) {
  if (!t) return null;
  const s = t.summary ? String(t.summary) : '';
  switch (t.name) {
    case 'Bash': return `\`${s || 'bash'}\``;
    case 'Edit': case 'Write': case 'NotebookEdit': return `editing ${s ? basename(s) : 'files'}`;
    case 'Read': return `reading ${s ? basename(s) : 'files'}`;
    case 'Grep': case 'Glob': return 'searching';
    case 'Task': return 'running a subagent';
    default: return t.name;
  }
}

function quietReason(live) {
  const t = live?.tool_in_flight;
  if (t && t.age_ms != null && t.age_ms > toolBound(t)) return `${toolText(t)} ${formatAge(t.age_ms)}, no output`;
  return `no activity ${formatAge(live?.activity_age_ms)}`;
}

function askSuffix(view) {
  return view.resume_to === 'blocked' ? ' · approval still waiting' : '';
}

const ACTIONS = {
  queued: ['cancel'],
  claimed: ['stop'],
  running: ['watch', 'stop'],
  quiet: ['watch', 'stop'],
  parked: ['answer'],
  suspended: ['take_over_confirm'],
  reconnecting: [],
  unresponsive: ['take_over_confirm'],
  orphaned: ['take_over'],
  handing_over: [],
  handed_over: ['take_over_with_claude', 'take_over_myself'],
  in_review: ['open_pr', 'request_changes'],
  done: [],
  todo: ['give_to_claude'],
};
const BLOCKED_ACTIONS = {
  permission: ['allow', 'deny'], question: ['answer'], clarify: ['answer'], decision: ['answer'],
  plan: ['approve_plan'], conflict: ['resolve_conflict'], loop: ['continue', 'stop'],
};

function reasonFor(view, state, live) {
  const who = agentName(view);
  const ask = view.ask ?? {};
  switch (state) {
    case 'queued': {
      if (view.queue && view.queue.runner_online === false && view.queue.offline_age_ms != null) {
        return `no runner online for ${view.repo?.short_name ?? 'this repo'} · ${formatAge(view.queue.offline_age_ms)}`;
      }
      if (view.target?.is_viewer) return `for your ${view.target.ai_label ?? 'Claude'}`;
      const name = view.target?.name ?? 'your';
      return `for ${possessive(name)} ${view.target?.ai_label ?? 'Claude'}${view.target?.awaiting_confirm ? ` · awaiting ${name}` : ''}`;
    }
    case 'claimed': return `${who} · preparing worktree`;
    case 'running': {
      const t = toolText(live?.tool_in_flight);
      const tAge = live?.tool_in_flight?.name === 'Bash' && live.tool_in_flight.age_ms >= 60000 ? ` ${formatAge(live.tool_in_flight.age_ms)}` : '';
      return t ? `${who} · ${t}${tAge}` : who;
    }
    case 'quiet': return quietReason(live);
    case 'blocked': {
      const n = ask.count > 1 ? ` · ${ask.count} req` : '';
      switch (view.blocked_kind) {
        case 'permission': return `approval waiting${ask.summary ? ` · \`${ask.summary}\`` : ''}${n}`;
        case 'plan': return `plan ready to approve${ask.steps ? ` · ${ask.steps} steps` : ''}`;
        case 'conflict': return `merge conflict${ask.summary ? ` ${ask.summary}` : ''}`;
        case 'loop': return `looks stuck${ask.summary ? ` · ${ask.summary}` : ''}`;
        default: return `question from ${BACKEND_LABEL[view.run?.backend] ?? 'Claude'}${ask.summary ? ` · ${ask.summary}` : ''}`;
      }
    }
    case 'parked': return 'waiting for your answer · no agent running';
    case 'suspended': return `${view.device_kind ?? 'laptop'} asleep ${formatAge(view.state_age_ms)}${askSuffix(view)}`;
    case 'reconnecting': return `board restarted · waiting for ${possessive(view.run?.owner?.name ?? 'the')} runner`;
    case 'unresponsive': return `last seen ${formatAge(live?.hb_age_ms ?? view.state_age_ms)} ago${askSuffix(view)}`;
    case 'orphaned': return `take over${view.handover?.synced_age_ms != null ? ` · handover synced ${formatAge(view.handover.synced_age_ms)} ago` : ''}`;
    case 'handing_over': return `waiting for checkpoint · ${formatAge(view.state_age_ms)}`;
    case 'handed_over': return `to ${view.handover_target_name ?? 'the queue'}${view.handover?.version ? ` · handover v${view.handover.version}` : ''}`;
    case 'failed': {
      const owner = view.run?.owner?.name ?? 'the';
      switch (view.fail_kind) {
        case 'limit': return `usage limit on ${possessive(owner)} account${view.limit_resets_in_ms != null ? ` · resets in ${formatAge(view.limit_resets_in_ms)}` : ''}`;
        case 'network': return 'network';
        case 'budget': return `budget${view.budget?.cap_usd != null ? ` $${fmtUsd(view.budget.cap_usd)}` : ''} reached`;
        case 'stopped': return `stopped by ${view.stopped_by_name ?? 'someone'}`;
        case 'released': return `released by ${BACKEND_LABEL[view.run?.backend] ?? 'Claude'}${view.fail_reason ? `: ${view.fail_reason}` : ''}`;
        default: return view.fail_reason ?? 'CLI exited';
      }
    }
    case 'in_review': {
      const parts = [];
      if (view.pr?.number) parts.push(`PR #${view.pr.number}`);
      if (view.evidence?.tests === 'pass') parts.push('tests ✓');
      else if (view.evidence?.tests === 'fail') parts.push('tests ✗');
      else if (view.evidence?.tests === 'none') parts.push('no tests');
      parts.push(view.evidence?.verification === 'hub_verified' ? 'hub-verified' : 'self-reported');
      return parts.join(' · ');
    }
    case 'done': return view.pr?.merged_age_ms != null ? `merged ${formatAge(view.pr.merged_age_ms)} ago${view.pr.merged_by ? ` by ${view.pr.merged_by}` : ''}` : 'done';
    default: return '';
  }
}

function fmtUsd(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * view: CardView (CONTRACT.md §5.3). opts: {elapsed_ms, connection_lost}.
 * Returns {state, column, icon, label, reason, text, tone, green, actions,
 *          sponsor, runner_line, activity_line, overlap_chip, budget}.
 */
export function cardFace(view, { elapsed_ms = 0, connection_lost = false } = {}) {
  const state = view.run_state ?? 'todo';
  const live = view.live ? advanceView(view.live, elapsed_ms) : null;
  const aged = { ...view, state_age_ms: view.state_age_ms == null ? null : view.state_age_ms + elapsed_ms };
  const green = !connection_lost && !!live && isGreen({ ...live, run_state: state });

  let key = state === 'failed' && view.fail_kind === 'limit' ? 'failed_limit' : state;
  let reason;
  let actions = state === 'blocked' ? [...(BLOCKED_ACTIONS[view.blocked_kind] ?? ['answer'])] : [...(ACTIONS[state] ?? [])];
  if (state === 'failed') actions = view.fail_kind === 'limit' ? ['take_over', 'retry'] : ['retry', 'take_over'];

  if (state === 'running' && !green && !connection_lost) {
    // The hub says running but the predicate no longer holds on the aged view.
    if (!live || live.hb_age_ms == null || live.hb_age_ms > TTL_MS) {
      key = 'unresponsive';
      reason = `last seen ${formatAge(live?.hb_age_ms)} ago`;
    } else {
      key = 'quiet';
      reason = quietReason(live);
    }
  }
  if (reason === undefined) reason = reasonFor(aged, state, live);

  const pill = PILLS[key];
  let tone = pill.tone;
  if (state === 'running' && !green) tone = connection_lost ? 'unknown' : pill.tone === 'green' ? 'quiet' : pill.tone;
  if (connection_lost && ACTIVE.has(state)) tone = 'unknown';

  if (state === 'blocked' && view.blocked_kind === 'permission' && view.viewer_can_approve === false) actions = [];

  const owner = view.run?.owner?.name;
  const runnerLine = view.run ? `${BACKEND_CLI[view.run.backend] ?? 'claude'} · ${owner ?? '?'}` : null;
  const activityAge = live?.activity_age_ms;
  const top = view.overlaps?.[0];

  return {
    state,
    column: columnOf(state),
    icon: pill.icon,
    label: pill.label,
    reason,
    text: pill.label ? `${pill.label} · ${reason}` : reason,
    tone,
    green,
    actions,
    sponsor: sponsorLine(view),
    runner_line: runnerLine,
    activity_line: view.run && activityAge != null ? `${agentName(view)} · ${formatAge(activityAge)} ago` : null,
    overlap_chip: top ? `⚠ overlaps ${top.other_key}${top.paths?.[0] ? ` · ${basename(top.paths[0])}` : ''}` : null,
    budget: view.budget && view.budget.cap_usd != null
      ? { text: `$${(view.budget.spent_usd ?? 0).toFixed(2)} / $${fmtUsd(view.budget.cap_usd)}`, ratio: Math.min(1, (view.budget.spent_usd ?? 0) / view.budget.cap_usd) }
      : null,
  };
}

/**
 * Whose machine + whose account (§3.12 #2). Never the auth type.
 * view.run (live run) or view.target (dispatch preview / todo card).
 */
export function sponsorLine(view) {
  const who = view.run?.owner ?? view.target;
  if (!who) return null;
  if (!view.run && who.is_viewer) return 'on your account';
  const device = view.run?.device_name ?? who.device_name;
  const acct = `${possessive(who.name)} ${BACKEND_CLI[view.run?.backend] ?? 'claude'} account`;
  const base = device ? `Runs on ${possessive(who.name)} ${device} · ${acct}` : acct;
  return !view.run && !who.is_viewer ? `${base} · uses ${possessive(who.name)} account — ${who.name} must confirm` : base;
}

/**
 * Alerts strip for one viewer (§4.2), newest first, max 5 + "+N".
 * views: CardView[] where each carries viewer relations:
 *   approvers[], assignee_ids[], run.dispatched_by.member_id, run.owner.member_id
 */
export function alertsFor(viewerId, views, { max = 5 } = {}) {
  const items = [];
  for (const v of views) {
    const age = v.state_age_ms ?? 0;
    const mine = v.run?.dispatched_by?.member_id === viewerId || v.run?.owner?.member_id === viewerId;
    const involved = mine || (v.assignee_ids ?? []).includes(viewerId) || (v.approvers ?? []).includes(viewerId);
    if (v.run_state === 'blocked' && involved) {
      const n = v.ask?.count > 1 ? ` (${v.ask.count} req)` : '';
      const what = v.blocked_kind === 'permission' ? 'approval waiting' : v.blocked_kind === 'plan' ? 'plan to approve' : 'question waiting';
      items.push({ kind: 'blocked', card_id: v.id, age_ms: age, text: `✋ ${v.key} needs you · ${what}${n}` });
    }
    if (mine) {
      for (const o of v.overlaps ?? []) {
        items.push({ kind: 'overlap', card_id: v.id, age_ms: o.age_ms ?? age, text: `⚠ ${v.key} overlaps ${o.other_key}${o.other_owner ? ` (${o.other_owner})` : ''}${o.paths?.[0] ? ` · ${basename(o.paths[0])}` : ''}` });
      }
    }
    if (v.run_state === 'orphaned' && age >= ORPHAN_NOTIFY_MS) {
      items.push({ kind: 'orphaned', card_id: v.id, age_ms: age - ORPHAN_NOTIFY_MS, text: `✖ ${v.key} orphaned · take over` });
    }
    if (v.run_state === 'failed' && v.run?.dispatched_by?.member_id === viewerId) {
      const text = v.fail_kind === 'limit'
        ? `✖ ${v.key} stopped · usage limit on ${v.run?.owner?.member_id === viewerId ? 'your' : possessive(v.run?.owner?.name ?? 'their')} account`
        : `✖ ${v.key} failed · ${reasonFor(v, 'failed', null)}`;
      items.push({ kind: 'failed', card_id: v.id, age_ms: age, text });
    }
  }
  items.sort((a, b) => a.age_ms - b.age_ms);
  return { items: items.slice(0, max), more: Math.max(0, items.length - max) };
}
