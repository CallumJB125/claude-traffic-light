'use strict';

// Defensive normalisers for Burst's /api/codex, /api/coordination and the
// per-session context in /api/state. Their shapes are not verified against a
// released Burst, so anything unrecognised yields null and the UI leaves the
// section out. Pure; no I/O.

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return undefined; };
const MAX_GROUPS = 20;

function codexGroup(g) {
  return {
    key: str(pick(g, 'key', 'model', 'name', 'session', 'session_id'), 120),
    requests: num(pick(g, 'requests', 'count', 'turns')),
    tokens: num(pick(g, 'tokens', 'total_tokens')),
    usd: num(pick(g, 'usd', 'api_equivalent_usd', 'cost_usd')),
  };
}

function normalizeCodex(raw) {
  const r = obj(raw);
  if (!r) return null;
  const t = obj(r.totals) || r;
  const list = [r.by_model, r.models, r.sessions, r.by_session].find(Array.isArray) || [];
  const groups = list.slice(0, MAX_GROUPS).filter(obj).map(codexGroup).filter((g) => g.key);
  const out = {
    requests: num(pick(t, 'requests', 'count', 'turns')),
    tokens: num(pick(t, 'tokens', 'total_tokens')),
    usd: num(pick(t, 'usd', 'api_equivalent_usd', 'cost_usd')),
    groups,
  };
  return out.requests || out.tokens || out.usd || groups.length ? out : null;
}

function codexView(codex) {
  if (!codex) return null;
  return {
    source: 'Claude Burst gateway, Codex traffic, API-equivalent prices',
    requests: codex.requests,
    tokens: codex.tokens,
    usd: codex.usd,
    groups: codex.groups,
    note: 'Codex usage through Burst. It is not part of the Claude figures on this page.',
  };
}

const shortId = (id) => str(id, 80).slice(0, 8);

function normalizeCoordination(raw) {
  const r = obj(raw);
  const st = r && obj(r.status);
  if (!st || r.error) return null;
  const sessions = (Array.isArray(st.sessions) ? st.sessions : []).slice(0, 100).filter(obj).map((s) => ({
    id: str(s.id, 80),
    name: str(s.name || s.label, 120),
    task: str(s.task, 200),
    masterOf: (Array.isArray(s.master_of) ? s.master_of : []).slice(0, 50).map((p) => str(p, 300)).filter(Boolean),
  })).filter((s) => s.id);
  const files = (Array.isArray(st.files) ? st.files : []).slice(0, 200).filter(obj).map((f) => ({
    path: str(f.path, 300), master: str(f.master_name || f.master_label, 120),
    contributors: (Array.isArray(f.contributor_names) ? f.contributor_names : Array.isArray(f.contributors) ? f.contributors : []).slice(0, 10).map((c) => str(c, 120)).filter(Boolean),
  })).filter((f) => f.path);
  return r.config && obj(r.config) && r.config.enabled === false ? null : { sessions, files };
}

// What one Sessions row shows: the files this session is master of, or null.
function coordinationFor(coord, sessionId) {
  if (!coord || typeof sessionId !== 'string' || !sessionId) return null;
  const s = coord.sessions.find((x) => x.id === sessionId || shortId(x.id) === shortId(sessionId));
  if (!s || !s.masterOf.length) return null;
  const shared = coord.files.filter((f) => s.masterOf.includes(f.path) && f.contributors.length).length;
  return { masterOf: s.masterOf.slice(0, 5), more: Math.max(0, s.masterOf.length - 5), shared };
}

// Per-session context fill from /api/state context.sessions: tokens in context over
// the compaction limit, or tokens alone when there is no limit. Empty when absent.
function normalizeContextFill(state) {
  const c = state && obj(state.context);
  const list = c && Array.isArray(c.sessions) ? c.sessions : [];
  return list.slice(0, 100).filter((s) => obj(s) && typeof s.session === 'string' && Number.isFinite(s.context) && s.context > 0).map((s) => ({
    session: s.session.slice(0, 80), tokens: s.context, limit: num(s.compact_at),
  }));
}

function contextFor(fills, sessionId) {
  const f = (fills || []).find((x) => x.session === sessionId);
  if (!f) return null;
  return { tokens: f.tokens, limit: f.limit, pct: f.limit ? Math.min(100, Math.round((f.tokens / f.limit) * 100)) : null };
}

module.exports = { normalizeCodex, codexView, normalizeCoordination, coordinationFor, normalizeContextFill, contextFor };
