'use strict';

// WorkRecord v1 (docs/TEAM-CONTEXT-CONTRACT.md): one record per observed AI
// session, built on this machine from Plexiform's own hook state and the same
// facts as the local handover (src/handover-transcripts.js). Records are kept
// in a private file and never leave the Mac by themselves: forShare() is the
// only shape that may, and only for a route with share_summaries.
//
// Local records keep readable text (secrets and PII redacted, home folder as
// ~); forShare() runs the full src/scrub.js pass, which also hashes paths and
// names, with a salt fixed per install so a shared record's text is stable.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scrub, redactSecretsPass } = require('./scrub.js');

const ADAPTERS = new Set(['claude', 'codex', 'gemini', 'hermes', 'cursor']);
const STATUSES = new Set(['working', 'waiting', 'review', 'ended', 'idle', 'paused_limit']);
const CAP = { title: 120, goal: 400, summary: 1500, files: 50, branch: 200, body: 2000 };
const MAX_RECORDS = 500;
const MAX_BYTES = 2 * 1024 * 1024;
const ENDED_TTL_MS = 7 * 24 * 3600 * 1000;
const FACTS_TTL_MS = 30 * 1000;
const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes', cursor: 'Cursor' };

const flat = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '') || s.slice(0, max - 1)}…` : s);
const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const isoOf = (v) => { const t = typeof v === 'string' ? Date.parse(v) : Number.isFinite(v) ? v : NaN; return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function localText(value, max, home) {
  let s = redactSecretsPass(String(value ?? '').slice(0, max * 4));
  const h = typeof home === 'string' ? home.replace(/[\\/]+$/, '') : '';
  if (h.length > 1) s = s.replace(new RegExp(`(?:file://)?${escapeRe(h)}(?![\\w.-])`, 'g'), '~');
  return clip(flat(s), max);
}

// Paths relative to the session's folder; anything outside it is left out.
function filesOf(files, cwd) {
  const out = { edited: [], read: [] };
  if (!files || typeof files !== 'object') return out;
  const root = typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd) : null;
  for (const [raw, kind] of Object.entries(files)) {
    if (typeof raw !== 'string' || !raw || raw.length > 1000 || raw.includes('\0')) continue;
    let rel;
    if (path.isAbsolute(raw)) { if (!root) continue; rel = path.relative(root, raw); } else rel = path.normalize(raw);
    if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const list = kind === 'edit' ? out.edited : out.read;
    rel = rel.split(path.sep).join('/');
    if (list.length < CAP.files && !list.includes(rel)) list.push(rel);
  }
  return out;
}

// Everything known about one observed session → a WorkRecord (no rev yet).
// o: work-capture observation; raw: the session row; facts: merged hook +
// transcript facts (src/session-handover.js writer.facts) or null.
function build({ install_id, o, raw = {}, facts = null, repo_id = null, handover = null, spend = null, home = null }) {
  if (!o || !ADAPTERS.has(o.provider)) return null;
  const f = facts && typeof facts === 'object' ? facts : {};
  const cwd = str(o.cwd) || str(f.cwd) || '';
  const folder = cwd ? path.basename(cwd) : '';
  const prompt = str(f.lastPrompt) || str(f.firstPrompt);
  const title = str(raw.taskTitle) ? localText(raw.taskTitle, CAP.title, home)
    : prompt ? localText(prompt, CAP.title, home)
      : `${PROVIDER_LABEL[o.provider]} · ${folder || 'Work'}`;
  const status = raw.signal === 'limit-hit' ? 'paused_limit' : STATUSES.has(o.status) ? o.status : 'working';
  const branch = str(raw.branch) || str(f.branch);
  const cost = Number(spend?.cost_usd);
  return {
    v: 1, record_id: `${install_id}:${o.provider}:${o.session_id}`, adapter: o.provider, session_id: o.session_id, install_id,
    repo_id: typeof repo_id === 'string' && repo_id ? repo_id : null,
    folder: localText(folder, 120, null), title,
    goal: str(f.firstPrompt) ? localText(f.firstPrompt, CAP.goal, home) : '',
    summary: str(raw.taskSummary) ? localText(raw.taskSummary, CAP.summary, home) : str(f.lastAssistant) ? localText(f.lastAssistant, CAP.summary, home) : '',
    status, files: filesOf(f.files, cwd),
    branch: branch ? localText(branch, CAP.branch, null) : null,
    started_at: isoOf(f.startedAt), updated_at: isoOf(raw.updatedAt) || isoOf(f.lastActive),
    cost_usd: Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e4) / 1e4 : null,
    route: spend?.route === 'primary' || spend?.route === 'secondary' ? spend.route : null,
    handover: handover && typeof handover.available === 'boolean' ? { available: handover.available, written_at: isoOf(handover.written_at) } : null,
  };
}

// The card body a record becomes. render-capture.js recordParts() reads it back.
function cardBody(rec) {
  if (!rec) return '';
  const edited = rec.files?.edited ?? [];
  let shown = edited.slice(0, 8);
  while (shown.length > 1 && shown.join(', ').length > 300) shown = shown.slice(0, -1);
  const files = edited.length ? `Files: ${shown.join(', ').slice(0, 300)}${edited.length > shown.length ? ` (+${edited.length - shown.length} more)` : ''}` : '';
  const goal = rec.goal ? `Goal: ${rec.goal}` : '';
  // The summary gives way so the goal and files line always fit the hub's limit.
  const room = CAP.body - [goal, files].filter(Boolean).reduce((n, p) => n + p.length + 2, 0);
  const summary = rec.summary && room > 1 ? clip(rec.summary, room) : '';
  return [goal, summary, files].filter(Boolean).join('\n\n');
}

// The one shape that may leave the Mac: only for a route with share_summaries,
// paths only with share_files, every free text through the full scrub.
function forShare(rec, route, { salt, home = null, user = null } = {}) {
  if (!rec || route?.share_summaries !== true || typeof salt !== 'string' || !salt) return null;
  const s = (v, max) => clip(flat(scrub(String(v ?? ''), { home, user, salt })), max);
  const files = route.share_files === true ? { edited: rec.files.edited.slice(0, CAP.files), read: rec.files.read.slice(0, CAP.files) } : { edited: [], read: [] };
  return { ...rec, repo_id: route.repo_id ?? rec.repo_id, folder: s(rec.folder, 120), title: s(rec.title, CAP.title), goal: s(rec.goal, CAP.goal), summary: s(rec.summary, CAP.summary),
    branch: rec.branch ? s(rec.branch, CAP.branch) : null, files };
}

const contentOf = (r) => JSON.stringify({ ...r, rev: undefined, updated_at: undefined });

// Private store: rev increments on every content change and survives restarts,
// so record_id+rev stays an idempotent upsert key for the hub.
function createWorkRecords({ file, now = Date.now, log = () => {} }) {
  let state = { v: 1, records: {} };
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES) throw new Error('work records unavailable');
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v?.v === 1 && v.records && typeof v.records === 'object' && !Array.isArray(v.records)) state = v;
  } catch (e) { if (e.code !== 'ENOENT') log('work records reset: unreadable store'); }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } catch { log('work records not saved'); }
  };
  const prune = () => {
    const list = Object.values(state.records);
    for (const r of list) if ((r.status === 'ended' || r.status === 'idle') && now() - (Date.parse(r.updated_at) || 0) > ENDED_TTL_MS) delete state.records[r.record_id];
    const left = Object.values(state.records);
    if (left.length > MAX_RECORDS) for (const r of left.sort((a, b) => (Date.parse(a.updated_at) || 0) - (Date.parse(b.updated_at) || 0)).slice(0, left.length - MAX_RECORDS)) delete state.records[r.record_id];
  };
  return {
    upsert(rec) {
      if (!rec?.record_id) return null;
      const prev = state.records[rec.record_id];
      if (prev && contentOf({ ...rec, rev: prev.rev }) === contentOf(prev)) return prev;
      const next = { ...rec, rev: (prev?.rev ?? 0) + 1, updated_at: rec.updated_at || new Date(now()).toISOString() };
      state.records[rec.record_id] = next;
      prune(); save();
      return next;
    },
    setStatus(recordId, status) {
      const prev = state.records[recordId];
      if (!prev || prev.status === status || !STATUSES.has(status)) return prev ?? null;
      return this.upsert({ ...prev, status, updated_at: new Date(now()).toISOString() });
    },
    get: (recordId) => state.records[recordId] ?? null,
    list: () => Object.values(state.records),
  };
}

// Facts per session, read at most every FACTS_TTL_MS: an active transcript
// changes constantly and each read is up to a few MB.
function factsCache(factsFor, now = Date.now) {
  const cache = new Map();
  return (o) => {
    if (typeof factsFor !== 'function') return null;
    const key = `${o.provider}:${o.session_id}`, hit = cache.get(key);
    if (hit && now() - hit.at < FACTS_TTL_MS) return hit.facts;
    let facts = null; try { facts = factsFor(o) ?? null; } catch { facts = null; }
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: now(), facts });
    return facts;
  };
}

module.exports = { build, cardBody, forShare, filesOf, createWorkRecords, factsCache, localText, CAP, STATUSES };
