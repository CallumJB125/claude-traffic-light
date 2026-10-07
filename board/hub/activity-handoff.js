// Handoff of a WorkRecord (docs/TEAM-CONTEXT-CONTRACT.md, "Handoff"): a person
// hands a record to a teammate (record.handoff_requested on the activity log,
// listed by the teammate's brief until they continue it), and
// continue_with_another_ai seeds a new session from the record plus the
// handover its author shared. Additive: it reaches the activity log only
// through the narrow interface below, never its tables.
//
// log (board/hub/activity/log.js):
//   current(record_id) → { team_id, repo_id, record_id, rev, payload } | null
//   append({ team_id, repo_id, record_id, rev, type, payload }) → { seq }
//   handover?(record_id) → scrubbed shared handover markdown | null
//   events?({ record_id }) → that record's events, oldest first

import { HubError } from './db.js';
import { redactSecrets } from '../shared/secret-patterns.mjs';

export const HANDOFF_REQUESTED = 'record.handoff_requested';
export const HANDOFF_TAKEN = 'record.handoff_taken';
const RECORD_RE = /^[A-Za-z0-9_-]{1,64}:(claude|codex|gemini|hermes|cursor):[^\s]{1,200}$/;
const NOTE_MAX = 500;
const HANDOVER_MAX = 20_000;

const parse = (p) => {
  if (p && typeof p === 'object') return p;
  try { return JSON.parse(p); } catch { return null; }
};

function teamRecord(log, member, recordId) {
  if (!log || typeof log.current !== 'function') throw new HubError('NOT_FOUND', 'team activity is not available on this hub');
  if (typeof recordId !== 'string' || !RECORD_RE.test(recordId)) throw new HubError('VALIDATION', 'record_id is not a work record id');
  const row = log.current(recordId);
  const payload = row ? parse(row.payload) : null;
  // Another team's record reads as missing, not forbidden.
  if (!row || row.team_id !== member.org_id || !payload) throw new HubError('NOT_FOUND', 'record not found');
  return { ...row, payload };
}

function sharedHandover(log, recordId) {
  const h = typeof log.handover === 'function' ? log.handover(recordId) : null;
  return typeof h === 'string' && h.trim() ? h.slice(0, HANDOVER_MAX) : null;
}

// POST …/records/:record_id/handoff {to_member_id, note?}
export function requestHandoff({ hub, log }, member, recordId, body = {}) {
  if (!hub.canWrite(member)) throw new HubError('FORBIDDEN', 'viewers cannot hand work over');
  const row = teamRecord(log, member, recordId);
  const to = hub.activeMember(body?.to_member_id);
  if (!to || to.org_id !== member.org_id) throw new HubError('VALIDATION', 'unknown member');
  if (to.id === member.id) throw new HubError('VALIDATION', 'hand it to someone else');
  if (body.note != null && (typeof body.note !== 'string' || body.note.length > NOTE_MAX)) throw new HubError('VALIDATION', `note must be a string ≤ ${NOTE_MAX}`);
  const note = body.note?.trim() ? redactSecrets(body.note.trim()) : null;
  const handoff = { record_id: recordId, to_member_id: to.id, to_name: to.display_name, by_member_id: member.id, by_name: member.display_name, note, requested_at: hub.iso() };
  const res = log.append({ team_id: row.team_id, repo_id: row.repo_id, record_id: recordId, rev: row.rev, type: HANDOFF_REQUESTED, payload: handoff });
  return { handoff, seq: res?.seq ?? null };
}

// POST …/records/:record_id/continue → the seed for a new session. When the
// record was handed to this member, the handoff is marked taken.
export function continueRecord({ hub, log }, member, recordId, { pending = null } = {}) {
  const row = teamRecord(log, member, recordId);
  const mine = pending?.find((h) => h.record_id === recordId && h.to_member_id === member.id);
  if (mine && hub.canWrite(member)) log.append({ team_id: row.team_id, repo_id: row.repo_id, record_id: recordId, rev: row.rev, type: HANDOFF_TAKEN, payload: { record_id: recordId, by_member_id: member.id, by_name: member.display_name, taken_at: hub.iso() } });
  return { record: row.payload, handover: sharedHandover(log, recordId) };
}

// A card's continue_with_another_ai: the card's shared handover, plus its
// WorkRecord when the caller names one in the card's own repo.
export function cardSeed({ hub, log }, member, row, recordId = null) {
  let record = null;
  if (recordId != null) {
    const r = teamRecord(log, member, recordId);
    if (r.repo_id !== row.repo_id) throw new HubError('VALIDATION', 'that record is from another repo');
    record = r.payload;
  }
  const doc = hub.handoverDoc(row.id);
  const recordHandover = recordId != null ? sharedHandover(log, recordId) : null;
  return { record, handover: recordHandover ?? (typeof doc?.markdown === 'string' && doc.markdown.trim() ? doc.markdown.slice(0, HANDOVER_MAX) : null) };
}

// Open handoffs to one member from feed events (oldest first, as the feed
// pages them). A later handoff of the same record to someone else, or the
// member continuing it, closes it. → newest first.
export function pendingHandoffs(events, memberId) {
  const open = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    const p = e && parse(e.payload);
    if (!p || typeof p.record_id !== 'string') continue;
    if (e.type === HANDOFF_REQUESTED) {
      open.delete(p.record_id);
      if (p.to_member_id === memberId) open.set(p.record_id, { ...p, seq: e.seq ?? null });
    } else if (e.type === HANDOFF_TAKEN) open.delete(p.record_id);
  }
  return [...open.values()].reverse();
}

// Routes are team-scoped so a multi-team sign-in resolves the right member.
// getLog() is read per request: the activity log may attach after startup.
export function registerHandoffRoutes(route, { hub, api, getLog }) {
  const team = (member, params) => { if (member.org_id !== params.team_id) throw new HubError('NOT_FOUND', 'team not found'); };
  route('POST', '/api/teams/:team_id/activity/v1/records/:record_id/handoff', ({ member, params, body }) => {
    team(member, params);
    return requestHandoff({ hub, log: getLog() }, member, params.record_id, body);
  }, { replay: false, maxBody: 2048 });
  route('POST', '/api/teams/:team_id/activity/v1/records/:record_id/continue', ({ member, params }) => {
    team(member, params);
    const log = getLog();
    const pending = typeof log?.events === 'function' ? pendingHandoffs(log.events({ record_id: params.record_id }), member.id) : null;
    return continueRecord({ hub, log }, member, params.record_id, { pending });
  }, { replay: false, maxBody: 256 });
  route('GET', '/api/cards/:card_id/continue-seed', ({ member, params, query }) => api.continueSeed(member, params.card_id, query.get('record_id'), getLog()));
}
