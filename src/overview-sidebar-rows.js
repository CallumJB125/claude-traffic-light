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
const { AI, NO_PROJECT, text, pathy } = require('./session-title');
const fallbackTitle = (dto, project) => `${AI[dto.provider?.id] ?? 'AI'} session${project ? ` in ${project}` : ''}`;
const MAX = 200;

function row(dto, origins, threads) {
  if (!dto || typeof dto !== 'object' || typeof dto.id !== 'string' || !/^[0-9a-f]{64}$/.test(dto.id)) return null;
  const title = text(dto.task?.status === 'tracked' ? dto.task.title : '', 200);
  const project = text(dto.project, 100);
  const cleanProject = project && !pathy(project) && !NO_PROJECT.has(project) ? project : '';
  const origin = origins?.get?.(dto.id);
  return {
    id: dto.id,
    bucket: BUCKET_IDS.includes(dto.bucket) ? dto.bucket : 'idle',
    title: title && !pathy(title) ? title : fallbackTitle(dto, cleanProject),
    project: cleanProject,
    origin: ORIGINS.includes(origin) ? origin : null,
    age_ms: Number.isFinite(dto.age_ms) && dto.age_ms >= 0 ? Math.round(dto.age_ms) : null,
    team: dto.board?.kind === 'team',
    // A session reported from this computer's terminals (the origins map covers exactly those).
    terminal: !!origins?.has?.(dto.id),
    // Redesign R2a: a Plexiform chat (a managed task on this computer), for the Chats filter,
    // and whether the row opens a thread (main resolved a target; never a paired device's row).
    chat: dto.label === 'Managed task',
    thread: !!threads?.has?.(dto.id),
  };
}

/** passiveRows() output → the sidebar payload. */
function sidebarRows(out) {
  if (!out || !Array.isArray(out.rows)) return { schema: 1, status: 'unavailable', sessions: [] };
  const sessions = [];
  for (const dto of out.rows) { if (sessions.length >= MAX) break; const r = row(dto, out.origins, out.threads); if (r) sessions.push(r); }
  return { schema: 1, status: out.status === 'complete' ? 'complete' : 'partial', sessions };
}

// The thread header (redesign R2a): the same fixed, path-free shape as a
// sidebar row, plus the AI's name, from the row main resolved. A task the
// latest build hasn't listed yet has no row; its page uses the task detail.
const HEADER_KEYS = Object.freeze(['title', 'project', 'bucket', 'origin', 'ai', 'terminal']);
function headerOf(target, id) {
  if (!target?.row || target.row.id !== id) return null;
  const origins = new Map(target.kind === 'session' ? [[id, target.origin ?? null]] : []);
  const r = row(target.row, origins);
  if (!r) return null;
  return { title: r.title, project: r.project, bucket: r.bucket, origin: r.origin, ai: AI[target.row.provider?.id] ?? 'AI', terminal: r.terminal };
}

module.exports = { sidebarRows, headerOf, KEYS, HEADER_KEYS, NO_PROJECT };
