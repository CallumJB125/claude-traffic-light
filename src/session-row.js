'use strict';
// The one session row view model (plan-agent-terminal §R2.13 PR 0s, condition 1):
// what the chat sidebar, the Terminal's overview and its tab labels all read.
// It is a projection of an overview-service DTO, the row the Sessions & agents
// page draws, so its bucket and status are that page's (plan-pr0s §6 ruling 1).
// Strings only where a string is shown, and never a path. Nothing in the app
// builds these yet: R2 and T2/T4 adopt it, and R2 makes the chat-first
// sidebar's rows (overview-sidebar-rows.js) a projection of it. The title rules
// live in session-title.js, so that projection creates no require cycle.
const { AI, NO_PROJECT, text, pathy } = require('./session-title');
const Surface = require('./session-surface');

const BUCKETS = Object.freeze(['needs', 'working', 'check', 'stuck', 'idle']);
const usd = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

function approvalsOf(a) {
  if (!a || typeof a !== 'object' || !Number.isSafeInteger(a.count) || a.count < 1 || !['permission', 'question'].includes(a.kind)) return null;
  return { count: a.count, kind: a.kind };
}

/**
 * dto: one overview-service row (snapshot() or passiveRows()).
 * ctx: what main knows beside it, all optional: origin (the focus/ids label for
 * this row), task (the managed task the row is), diffFiles, approvals,
 * quickChat, ref (a SessionRef input).
 */
function sessionRow(dto, { origin = null, task = null, diffFiles = null, approvals = null, quickChat = false, ref = null } = {}) {
  if (!dto || typeof dto !== 'object' || typeof dto.id !== 'string' || !/^[0-9a-f]{64}$/.test(dto.id)) return null;
  const tracked = text(dto.task?.status === 'tracked' ? dto.task.title : '', 200);
  const rawProject = text(dto.project, 100);
  const project = rawProject && !pathy(rawProject) && !NO_PROJECT.has(rawProject) ? rawProject : '';
  const title = tracked && !pathy(tracked) ? tracked : `${AI[dto.provider?.id] ?? 'AI'} session${project ? ` in ${project}` : ''}`;
  const t = task && typeof task === 'object' ? task : null;
  return Object.freeze({
    id: dto.id,
    ref: ref ? Surface.sessionRef(ref) : null,
    bucket: BUCKETS.includes(dto.bucket) ? dto.bucket : 'idle',
    chatState: t ? Surface.chatStateOf(t, { diffFiles }) : null,
    status: text(dto.status, 80),
    title,
    project,
    hostApp: Surface.HOST_APPS.includes(origin) ? origin : null,
    cost: t && t.cost ? { usd: usd(t.cost.usd), budgetUsd: usd(t.cost.budgetUsd) } : null,
    approvals: approvalsOf(approvals),
    branch: t && typeof t.branch === 'string' && t.branch && !t.branch.includes('\0') ? t.branch.slice(0, 200) : null,
    openInTerminal: t ? Surface.openInTerminalOf(t, { quickChat }) : { available: false, code: 'CANT_OPEN', reason: 'no-task' },
    age_ms: Number.isFinite(dto.age_ms) && dto.age_ms >= 0 ? Math.round(dto.age_ms) : null,
    team: dto.board?.kind === 'team',
  });
}

const KEYS = Object.freeze(['id', 'ref', 'bucket', 'chatState', 'status', 'title', 'project', 'hostApp', 'cost', 'approvals', 'branch', 'openInTerminal', 'age_ms', 'team']);

module.exports = { sessionRow, KEYS };
