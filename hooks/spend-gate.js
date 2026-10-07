// Cost guard, hook side: whether a PreToolUse should be refused because the
// app's enforced spend cap (src/spend-enforce.js) says so. The app writes
// spend-gate.json; this only reads it. Fail-open by design: a missing,
// unreadable, malformed, future-dated or stale file (the app quit, its spend
// read stalled) allows the call, so a crash on the app side can never block
// anyone. Dependency-free (fs, path) and never throws.
const fs = require('fs');
const path = require('path');

const GATE_FILE = 'spend-gate.json';
// The app rewrites the file every few seconds while it enforces; older than
// this, nobody is vouching for it.
const MAX_TTL_MS = 5 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
const CLOCK_SKEW_MS = 60 * 1000;
// Asking the person a question costs nothing and is how they'd answer "stop".
const NEVER_GATED = new Set(['AskUserQuestion']);

const reasonText = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);

/** → the gate the app wrote, or null when it can't be trusted to be current. */
function readGate(rootDir, { now = Date.now(), readFileSync = fs.readFileSync } = {}) {
  try {
    const text = readFileSync(path.join(rootDir, GATE_FILE), 'utf8');
    if (typeof text !== 'string' || text.length > MAX_BYTES) return null;
    const g = JSON.parse(text);
    if (!g || typeof g !== 'object' || g.v !== 1 || !Number.isFinite(g.at)) return null;
    const ttl = Number.isFinite(g.ttlMs) ? Math.min(Math.max(g.ttlMs, 0), MAX_TTL_MS) : 0;
    if (g.at > now + CLOCK_SKEW_MS || now - g.at > ttl) return null;
    return g;
  } catch { return null; }
}

/**
 * → null (allow) or the PreToolUse output that denies this call.
 * {rootDir, sessionId, tool, now?, readFileSync?}
 */
function decide({ rootDir, sessionId, tool, now = Date.now(), readFileSync } = {}) {
  try {
    if (!rootDir || NEVER_GATED.has(tool)) return null;
    const g = readGate(rootDir, { now, readFileSync });
    if (!g) return null;
    const perSession = typeof sessionId === 'string' && g.sessions && typeof g.sessions === 'object' && Object.prototype.hasOwnProperty.call(g.sessions, sessionId)
      ? reasonText(g.sessions[sessionId]) : null;
    const reason = reasonText(g.cap) || perSession;
    if (!reason) return null;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  } catch { return null; }
}

module.exports = { decide, readGate, GATE_FILE, MAX_TTL_MS, NEVER_GATED };
