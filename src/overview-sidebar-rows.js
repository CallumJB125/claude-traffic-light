'use strict';
// The chat-first sidebar's view of the session list (redesign R1). The
// sidebar is a read-only, navigation-only document (plan-redesign authority
// table), so it gets a small fixed shape, never the Overview page's DTO:
// no handles, capabilities, devices, boards, children or anything a later
// field might add. Strings only, and none of them is a path.

const KEYS = Object.freeze(['id', 'bucket', 'title', 'project', 'origin', 'age_ms', 'team', 'terminal', 'chat', 'thread']);
const BUCKET_IDS = Object.freeze(['needs', 'working', 'check', 'stuck', 'idle']);
const ORIGINS = Object.freeze(['iTerm', 'Terminal', 'Plexiform Terminal']);
// The title rules live in session-title.js, shared with the row view model.
// R2b-1: rows are a projection of the session row view model (PR 0s,
// session-row.js), which owns the title rules (session-title.js). The vm's
// ref never leaves main: only the two booleans below are derived from it.
const { AI, NO_PROJECT, text } = require('./session-title');
const MAX = 200;

function row(vm, origins) {
  if (!vm || typeof vm !== 'object' || typeof vm.id !== 'string' || !/^[0-9a-f]{64}$/.test(vm.id)) return null;
  return {
    id: vm.id,
    bucket: BUCKET_IDS.includes(vm.bucket) ? vm.bucket : 'idle',
    title: vm.title,
    project: vm.project,
    // The sidebar's own, narrower label set (the vm also knows Ghostty Dock).
    origin: ORIGINS.includes(vm.hostApp) ? vm.hostApp : null,
    age_ms: vm.age_ms,
    team: vm.team === true,
    // A session reported from this computer's terminals (the origins map covers exactly those).
    terminal: !!origins?.has?.(vm.id),
    // A Plexiform chat (a managed task on this computer), for the Chats filter, and whether the
    // row opens a thread: main holds a ref for it (never a paired device's row).
    chat: vm.ref?.origin === 'chat',
    thread: !!vm.ref,
  };
}

/** passiveRows() output → the sidebar payload. */
function sidebarRows(out) {
  if (!out || !Array.isArray(out.rows) || !(out.vms instanceof Map)) return { schema: 1, status: 'unavailable', sessions: [] };
  const sessions = [];
  for (const dto of out.rows) { if (sessions.length >= MAX) break; const r = row(out.vms.get(dto?.id), out.origins); if (r) sessions.push(r); }
  return { schema: 1, status: out.status === 'complete' ? 'complete' : 'partial', sessions };
}

// The thread header: the same fixed, path-free shape as a sidebar row, plus
// the AI's name, chatState and openInTerminal, from the vm main resolved. A
// task the latest build hasn't listed yet has no vm; its page uses the task detail.
const HEADER_KEYS = Object.freeze(['title', 'project', 'bucket', 'origin', 'ai', 'terminal', 'chatState', 'openInTerminal']);
function headerOf(target, id) {
  const vm = target?.vm;
  if (!vm || vm.id !== id) return null;
  const origins = new Map(target.kind === 'session' ? [[id, target.origin ?? null]] : []);
  const r = row(vm, origins);
  if (!r) return null;
  const o = vm.openInTerminal;
  return {
    title: r.title, project: r.project, bucket: r.bucket, origin: r.origin, ai: AI[vm.ref?.provider] ?? 'AI', terminal: r.terminal,
    chatState: vm.chatState ?? null,
    openInTerminal: o && typeof o === 'object' ? { available: o.available === true, reason: typeof o.reason === 'string' ? o.reason : null } : null,
  };
}

// T1: teammates' shared sessions for the sidebar's Team filter. The same
// fixed-shape rule: names, a title and a few closed words, never deliveries,
// children, capabilities, devices, boards, provenance, refs or entry ids.
const TEAM_KEYS = Object.freeze(['id', 'person', 'initials', 'team', 'title', 'provider', 'bucket', 'freshness', 'age_ms', 'scope', 'inbox']);
const TEAM_MAX = 200, TEAM_SHOWN = 4;
function teamRow(x) {
  const e = x?.entry;
  if (!e || typeof e !== 'object' || typeof x.rowId !== 'string' || !/^[0-9a-f]{64}$/.test(x.rowId) || !['watch', 'interact'].includes(x.scope)) return null;
  const person = text(e.owner?.name, 80) || 'Teammate', provider = text(e.provider?.label, 120) || 'AI';
  const inbox = e.messageContract === 'task-inbox';
  const reported = e.task && e.task.source !== 'unknown' ? text(e.task.title, 200) : '';
  const team = text(x.teamName, 80) || 'Team';
  return {
    id: x.rowId, person, initials: text(e.owner?.initials, 8) || '?',
    team: x.fake === true ? `${team} (test data)` : team,
    title: reported || (inbox ? `${person}'s board run` : `${person}'s ${provider} session`),
    provider, bucket: BUCKET_IDS.includes(e.bucket) ? e.bucket : 'idle',
    freshness: ['recent', 'stale'].includes(e.freshness) ? e.freshness : 'unknown',
    age_ms: Number.isSafeInteger(e.ageMs) && e.ageMs >= 0 ? e.ageMs : null,
    scope: x.scope, inbox,
  };
}
/** passiveTeamRows() output → the sidebar's teammate payload. */
function teamRows(out) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.entries) || !Array.isArray(out.teams)) return { schema: 1, status: 'unavailable', viewer: null, teams: [], teamsTotal: 0, rows: [] };
  const rows = [];
  for (const x of out.entries) { if (rows.length >= TEAM_MAX) break; const r = teamRow(x); if (r) rows.push(r); }
  const teams = out.teams.slice(0, TEAM_SHOWN).map((t) => ({ name: text(t?.name, 80) || 'Team' }));
  return {
    schema: 1, status: out.partial === true ? 'partial' : 'complete',
    viewer: typeof out.viewerScope === 'string' && /^[0-9a-f]{64}$/.test(out.viewerScope) ? out.viewerScope : null,
    teams, teamsTotal: Number.isSafeInteger(out.teamsTotal) && out.teamsTotal >= teams.length ? out.teamsTotal : teams.length, rows,
  };
}

module.exports = { sidebarRows, headerOf, teamRows, KEYS, HEADER_KEYS, TEAM_KEYS, NO_PROJECT };
