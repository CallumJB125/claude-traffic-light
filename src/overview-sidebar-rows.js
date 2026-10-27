'use strict';
// The chat-first sidebar's view of the session list (redesign R1). The
// sidebar is a read-only, navigation-only document (plan-redesign authority
// table), so it gets a small fixed shape, never the Overview page's DTO:
// no handles, capabilities, devices, boards, children or anything a later
// field might add. Strings only, and none of them is a path.

const KEYS = Object.freeze(['id', 'bucket', 'title', 'project', 'origin', 'age_ms', 'team', 'terminal']);
const BUCKET_IDS = Object.freeze(['needs', 'working', 'check', 'stuck', 'idle']);
const ORIGINS = Object.freeze(['iTerm', 'Terminal', 'Plexiform Terminal']);
// The title rule's last step (plan-organised-views §2.3 item 7): "<AI> session in <project>".
const AI = Object.freeze({ claude: 'Claude', 'claude-code': 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', copilot: 'Copilot', opencode: 'OpenCode' });
// "We don't know" placeholders from the session DTOs are not project names.
const NO_PROJECT = new Set(['Other work', 'Project not reported', 'Local project', 'Unknown project']);
const fallbackTitle = (dto, project) => `${AI[dto.provider?.id] ?? 'AI'} session${project ? ` in ${project}` : ''}`;
const MAX = 200;

const text = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');
// A label that looks like a filesystem path is dropped, not shortened.
const pathy = (s) => /(^|\s)(~|\/|[A-Za-z]:\\)/.test(s) || s.includes('/Users/') || s.includes('\\');

function row(dto, origins) {
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
  };
}

/** passiveRows() output → the sidebar payload. */
function sidebarRows(out) {
  if (!out || !Array.isArray(out.rows)) return { schema: 1, status: 'unavailable', sessions: [] };
  const sessions = [];
  for (const dto of out.rows) { if (sessions.length >= MAX) break; const r = row(dto, out.origins); if (r) sessions.push(r); }
  return { schema: 1, status: out.status === 'complete' ? 'complete' : 'partial', sessions };
}

module.exports = { sidebarRows, KEYS, NO_PROJECT };
