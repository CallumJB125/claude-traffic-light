'use strict';

// A whitelisted Burst snapshot for out-of-process readers (MCP server, board
// runner): main writes ROOT_DIR/burst-snapshot.json (0600, atomic) after each
// poll; readers treat a missing or stale file as "Burst not present".
// buildSnapshot keeps a fixed whitelist; write/read are the transport.

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_FILE = 'burst-snapshot.json';
const STALE_MS = 2 * 60 * 1000;
const snapshotPath = (root) => path.join(root, SNAPSHOT_FILE);

const MAX_REQUESTS = 50;
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const hostOf = (v) => { try { return new URL(String(v)).hostname; } catch { return str(v, 120).replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]; } };

// Metadata only: no paths, prompts, previews or bodies cross into the snapshot.
function requestRow(e) {
  const r = obj(e) || {};
  return {
    time: str(r.time, 40),
    session: str(r.session_id || r.session, 80),
    agent: str(r.agent, 80),
    slot: str(r.slot, 20),
    route: str(r.route || r.provider, 80),
    host: hostOf(r.host || r.url || r.destination),
    model: str(r.model, 120),
    status: Number.isFinite(r.status) ? r.status : null,
    latencyMs: num(r.latency_ms ?? r.latencyMs),
    tokensIn: num(r.tokens_in ?? r.input_tokens ?? r.tokensIn),
    tokensOut: num(r.tokens_out ?? r.output_tokens ?? r.tokensOut),
    usd: num(r.api_equivalent_usd ?? r.usd),
  };
}

function requestRows(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.requests) ? raw.requests : raw && Array.isArray(raw.events) ? raw.events : raw && Array.isArray(raw.recent) ? raw.recent : [];
  return list.slice(0, MAX_REQUESTS).filter(obj).map(requestRow);
}

// detection: burst-client detect(); coordination: normalizeCoordination() or null; requests: scrubbed /api/requests or null.
function buildSnapshot({ detection, coordination, requests, now = Date.now() } = {}) {
  const present = !!detection && detection.kind === 'present' && !!obj(detection.state);
  if (!present) return { v: 1, at: now, present: false };
  const st = detection.state;
  const slot = (x) => ({ provider: str(obj(x) && x.provider, 80), model: str(obj(x) && x.model, 120) });
  const coord = obj(coordination);
  return {
    v: 1,
    at: now,
    present: true,
    version: str(String(st.version || ''), 40),
    route: st.route === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY',
    active: st.active === true,
    overflow: st.overflow === true,
    reason: str(st.reason, 200),
    claim: str(st.claim, 200),
    until: str(st.until, 40),
    secondary_ready: st.secondaryReady === true,
    primary: slot(st.primary),
    secondary: slot(st.secondary),
    primaryFailures: num(st.primaryFailures),
    limits: (Array.isArray(st.rejected) ? st.rejected : []).slice(0, 20).map((r) => ({ model: str(r && r.model, 120), until: str(r && r.until, 40), fallsBackTo: str(r && r.fallsBackTo, 120) })),
    coordination: coord ? {
      sessions: (Array.isArray(coord.sessions) ? coord.sessions : []).slice(0, 100).map((s) => ({ id: str(s.id, 80), name: str(s.name, 120), task: str(s.task, 200), masterOf: (Array.isArray(s.masterOf) ? s.masterOf : []).slice(0, 50).map((p) => str(p, 300)) })),
      files: (Array.isArray(coord.files) ? coord.files : []).slice(0, 200).map((f) => ({ path: str(f.path, 300), master: str(f.master, 120), contributors: (Array.isArray(f.contributors) ? f.contributors : []).slice(0, 10).map((c) => str(c, 120)) })),
    } : null,
    requests: requestRows(requests),
  };
}

// Extra facts merged into the board runner's Burst message (src/burst-ipc.js pushBoardFacts).
function boardFacts(snapshot) {
  if (!snapshot || snapshot.present !== true) return {};
  return {
    limits: snapshot.limits || [],
    primaryFailures: snapshot.primaryFailures || 0,
    coordinationMasters: ((snapshot.coordination && snapshot.coordination.sessions) || []).filter((s) => s.masterOf.length).map((s) => ({ session: s.id, files: s.masterOf.length })),
  };
}

function writeSnapshot(file, snapshot) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function readSnapshot(file, { now = Date.now(), maxAgeMs = STALE_MS } = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && Number.isFinite(s.at) && now - s.at <= maxAgeMs ? s : null;
  } catch { return null; }
}

module.exports = { buildSnapshot, boardFacts, writeSnapshot, readSnapshot, snapshotPath, SNAPSHOT_FILE, STALE_MS };
