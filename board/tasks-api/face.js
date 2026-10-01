// Task face: what the supervisor computes for every TaskView and `state`
// event (TASKS-CONTRACT.md §6): green, label, tone, reason copy and the
// actions allowed right now. The UI renders these as given and never infers
// liveness itself. Board states reuse shared/cardface.js copy; the local-only
// cases (paused reasons, review/outcome copy, the AI's name instead of
// "<owner>'s Claude") are overridden here.
//
// Browser-safe, dependency-free.

import { cardFace, agentName } from '../shared/cardface.js';
import { isGreen, formatAge } from '../shared/liveness.js';

export const AI_LABEL = Object.freeze({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini' });
const BOARD_BACKEND = { claude: 'claude_cli', codex: 'codex_cli' };

// Allowed act() actions per state (TASKS-CONTRACT.md §5.3). blocked depends
// on blocked_kind; parked on whether an ask is open.
export const ACTIONS_BY_STATE = Object.freeze({
  queued: ['stop'],
  claimed: ['stop'],
  running: ['message', 'pause', 'takeover', 'stop'],
  quiet: ['message', 'pause', 'takeover', 'stop'],
  parked: ['resume', 'switchAi', 'takeover', 'discard', 'stop'],
  suspended: ['takeover', 'stop'],
  unresponsive: ['takeover', 'stop'],
  orphaned: ['takeover', 'retry', 'discard', 'stop'],
  handing_over: [],
  handed_over: ['handback', 'discard'],
  in_review: ['merge', 'openPr', 'message', 'discard'],
  done: [],
  failed: ['retry', 'takeover', 'discard'],
});
const BLOCKED_ACTIONS = Object.freeze({
  permission: ['approve', 'deny', 'pause', 'takeover', 'stop'],
  loop: ['message', 'pause', 'stop'],
});
const BLOCKED_DEFAULT = ['answer', 'message', 'pause', 'takeover', 'stop'];
// A board card (task.hub != null): these go through the board's own flows (HUB_OWNED, §12).
export const HUB_EXCLUDED = new Set(['pause', 'resume', 'merge', 'openPr', 'discard', 'switchAi']);

export function actionsFor(task) {
  let a = task.state === 'blocked'
    ? (BLOCKED_ACTIONS[task.blockedKind] ?? BLOCKED_DEFAULT)
    : (ACTIONS_BY_STATE[task.state] ?? []);
  if (task.state === 'parked' && task.ask && !['limit', 'auth'].includes(task.ask.kind)) a = ['answer', ...a];
  if (task.state === 'queued' && task.awaitingConfirm) a = ['approve', 'deny', 'stop'];
  if (task.state === 'failed' && task.failKind === 'limit') a = ['retry', 'switchAi', 'takeover', 'discard'];
  if (task.hub) a = a.filter((x) => !HUB_EXCLUDED.has(x));
  return [...a];
}

export function confirmFor(task) {
  const c = [];
  if (task.state === 'suspended' || task.state === 'unresponsive') c.push('takeover');
  if (actionsFor(task).includes('discard')) c.push('discard');
  return c;
}

function boardView(task) {
  return {
    id: task.id, key: task.id, title: task.title ?? '',
    run_state: task.state, blocked_kind: task.blockedKind ?? null, fail_kind: task.failKind ?? null,
    fail_reason: task.failReason ?? null, resume_to: task.resumeTo ?? null,
    run: { backend: BOARD_BACKEND[task.ai?.id] ?? 'claude_cli', owner: { name: 'You' }, device_name: 'this Mac' },
    live: task.live ?? null, state_age_ms: task.stateAgeMs ?? 0,
    ask: task.ask ? { kind: task.ask.kind, summary: task.ask.summary ?? null, count: task.ask.count ?? 1 } : null,
    handover: task.handover ? { version: task.handover.version, synced_age_ms: task.handover.syncedAgeMs ?? null } : null,
    handover_target_name: 'your terminal', stopped_by_name: task.stoppedBy ?? 'you',
    limit_resets_in_ms: task.limitResetsInMs ?? null, device_kind: 'laptop',
    budget: task.cost?.budgetUsd != null ? { spent_usd: task.cost.usd ?? 0, cap_usd: task.cost.budgetUsd } : null,
    viewer_can_approve: true, overlaps: [],
  };
}

function usd(n) { return `$${(n ?? 0).toFixed(2)}`; }

function localReason(task, ai) {
  const hv = task.handover?.version ? ` · handover v${task.handover.version}` : '';
  switch (task.state) {
    case 'queued':
      return task.awaitingConfirm ? `from ${task.source} · waiting for you to accept`
        : task.queueReason ?? `waiting for a free slot for ${ai}`;
    case 'claimed': return `${ai} · preparing worktree`;
    case 'parked':
      switch (task.parkReason) {
        case 'user': return `paused by you${hv}`;
        case 'limit': return `usage limit on your ${ai} account${task.limitResetsInMs != null ? ` · resets in ${formatAge(task.limitResetsInMs)}` : ''}${task.resumeAtReset ? ' · resumes then' : ''}`;
        case 'auth': return `${ai} is logged out · log in again to continue${hv}`;
        case 'approval_timeout': return `approval waited too long · nothing running${hv}`;
        case 'message_loop': return `paused · going back and forth with ${task.loopWith ?? 'another task'} without doing any work`;
        default: return `waiting for your answer · nothing running${hv}`;
      }
    case 'handed_over': return `in your terminal${hv}`;
    case 'in_review': {
      const e = task.evidence ?? {};
      const parts = [];
      if (e.tests === 'pass') parts.push('tests ✓'); else if (e.tests === 'fail') parts.push('tests ✗'); else if (e.tests === 'none') parts.push('no tests');
      if (e.diffStat) parts.push(`${e.diffStat.files} file${e.diffStat.files === 1 ? '' : 's'} +${e.diffStat.added} −${e.diffStat.removed}`);
      if (task.pr?.url) parts.push(`PR #${task.pr.number}`);
      parts.push(usd(task.cost?.usd));
      return parts.join(' · ');
    }
    case 'done':
      switch (task.outcome) {
        case 'merged': return `merged into ${task.baseBranch ?? 'base'}`;
        case 'pr_merged': return `PR #${task.pr?.number ?? '?'} merged`;
        case 'pr_opened': return `PR #${task.pr?.number ?? '?'} opened`;
        case 'discarded': return 'discarded · worktree removed';
        default: return 'done';
      }
    default: return null;
  }
}

const LOCAL_LABEL = { parked: 'Paused', handed_over: 'In your terminal', in_review: 'Ready to review' };

/**
 * task: the supervisor's task record (camelCase; `live` is a board LeaseView
 * in snake_case, ages at send time). Returns {green, label, tone, reason, actions, confirm}.
 */
export function taskFace(task) {
  const f = cardFace(boardView(task));
  const ai = AI_LABEL[task.ai?.id] ?? 'the AI';
  const green = !!task.live && isGreen({ ...task.live, run_state: task.state }) && f.green;
  let reason = localReason(task, ai);
  if (reason == null) {
    reason = f.reason;
    const who = agentName(boardView(task));
    if (reason.startsWith(who)) reason = ai + reason.slice(who.length);
    if (task.state === 'failed' && task.failKind === 'limit') reason = reason.replace("You's", 'your');
  }
  return {
    green,
    label: task.hub ? f.label : (LOCAL_LABEL[task.state] ?? f.label),
    tone: f.tone,
    reason,
    actions: actionsFor(task),
    confirm: confirmFor(task),
  };
}
