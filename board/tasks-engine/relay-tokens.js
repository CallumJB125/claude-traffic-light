// Scoped relay tokens (TASKS-CONTRACT §3, §9.2). tasks.token is the UI/CLI's
// full token; every relay (the MCP spin-off tool, the phone bridge, Slack,
// voice, a teammate's board) gets its own `btr_` token, created by the UI with
// addRelayToken(). A relay token FORCES its source on every task it creates
// and can't approve, answer, take over or accept a start. Tokens are stored
// only as sha256 hashes in relay-tokens.json (0600); a file anyone else could
// have written is ignored.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../runner/util.js';

export const RELAY_FILE = 'relay-tokens.json';
export const RELAY_SOURCES = Object.freeze(['mcp', 'board', 'phone', 'slack', 'voice']);
export const RELAY_TOKEN_RE = /^btr_[A-Za-z0-9_-]{43}$/;

const hashOf = (t) => crypto.createHash('sha256').update(t).digest('hex');
const identity = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
const taskId = (v) => typeof v === 'string' && /^tsk_[0-9a-f]{12}$/.test(v);
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const session = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : null;

/** The file's entries, or [] if it is missing, malformed, a symlink, someone else's, or writable by others. */
export function readRelayFile(dataDir) {
  const f = path.join(dataDir, RELAY_FILE);
  try {
    const st = fs.lstatSync(f);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) return [];
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(j?.tokens) ? j.tokens.filter((t) => typeof t?.hash === 'string' && /^[0-9a-f]{64}$/.test(t.hash) && RELAY_SOURCES.includes(t.source)) : [];
  } catch { return []; }
}

/** Creates a relay token for `source` and returns it once (only its hash is kept). */
export function addRelayToken({ dataDir, source, label = null, userId = null, parentSessionId = null, taskIds = [], allowCreate = false, repoRoots = [], ttlMs = 24 * 60 * 60 * 1000 }) {
  if (!RELAY_SOURCES.includes(source)) throw new Error('a relay token needs a relay source');
  if (userId != null && !identity(userId)) throw new Error('a relay userId must be a bounded identity');
  if (parentSessionId != null && !session(parentSessionId)) throw new Error('a relay parentSessionId must be a session UUID');
  if (source === 'mcp' && !session(parentSessionId)) throw new Error('an MCP relay token needs its parent session');
  if (!Array.isArray(taskIds) || taskIds.length > 128 || !taskIds.every(taskId)) throw new Error('relay task scope must contain bounded task ids');
  if (!Array.isArray(repoRoots) || repoRoots.length > 128 || !repoRoots.every((r) => typeof r === 'string' && path.isAbsolute(r))) throw new Error('relay repo scope must contain absolute folders');
  const roots = [...new Set(repoRoots.map((r) => fs.realpathSync(r)))];
  if (source !== 'mcp' && (!identity(userId) || (!taskIds.length && !allowCreate) || (allowCreate && !roots.length))) throw new Error('a relay needs a verified owner and explicit task or creation repo scope');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new Error('relay expiry must be within 30 days');
  const token = `btr_${crypto.randomBytes(32).toString('base64url')}`;
  const tokens = readRelayFile(dataDir);
  tokens.push({ hash: hashOf(token), source, userId: identity(userId), parentSessionId: session(parentSessionId), taskIds: [...new Set(taskIds)], allowCreate: source === 'mcp' || allowCreate === true, repoRoots: roots,
    label: typeof label === 'string' ? label.slice(0, 80) : null, createdAt: Date.now(), expiresAt: Date.now() + ttlMs });
  writeFileAtomic(path.join(dataDir, RELAY_FILE), `${JSON.stringify({ v: 1, tokens }, null, 2)}\n`, 0o600);
  return token;
}

/** Revokes every token of a source (e.g. when the UI disconnects a relay). */
export function revokeRelayTokens({ dataDir, source }) {
  const tokens = readRelayFile(dataDir).filter((t) => t.source !== source);
  writeFileAtomic(path.join(dataDir, RELAY_FILE), `${JSON.stringify({ v: 1, tokens }, null, 2)}\n`, 0o600);
}

/** Trusted issuer revokes one actor/grant without disconnecting every relay of that source. */
export function revokeRelayToken({ dataDir, token }) {
  const tokens = readRelayFile(dataDir).filter((t) => t.hash !== hashOf(token));
  writeFileAtomic(path.join(dataDir, RELAY_FILE), `${JSON.stringify({ v: 1, tokens }, null, 2)}\n`, 0o600);
}

/** → (token) → scoped principal | null; re-reads the file when it changes. */
export function relayLookup(dataDir) {
  let stamp = null;
  let map = new Map();
  return (token) => {
    if (typeof token !== 'string' || !RELAY_TOKEN_RE.test(token)) return null;
    let st = null;
    try { st = fs.statSync(path.join(dataDir, RELAY_FILE)); } catch { /* none */ }
    const now = st ? `${st.mtimeMs}:${st.size}:${st.mode}:${st.ino}` : 'none';
    if (now !== stamp) {
      stamp = now;
      map = new Map(readRelayFile(dataDir).map((t) => [t.hash, t]));
    }
    const hash = hashOf(token);
    const record = map.get(hash);
    if (!record || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= Date.now()) return null;
    const taskIds = Array.isArray(record.taskIds) && record.taskIds.length <= 128 && record.taskIds.every(taskId) ? record.taskIds : [];
    const repoRoots = Array.isArray(record.repoRoots) && record.repoRoots.length <= 128 && record.repoRoots.every((r) => typeof r === 'string' && path.isAbsolute(r)) ? record.repoRoots : [];
    if (record.source === 'mcp' ? !session(record.parentSessionId) : !identity(record.userId) || (!taskIds.length && record.allowCreate !== true) || (record.allowCreate === true && !repoRoots.length)) return null;
    return { kind: 'relay', id: hash, source: record.source, userId: identity(record.userId), parentSessionId: session(record.parentSessionId), taskIds, repoRoots, allowCreate: record.allowCreate === true, expiresAt: record.expiresAt };
  };
}
