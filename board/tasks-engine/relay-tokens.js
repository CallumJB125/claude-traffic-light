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
export function addRelayToken({ dataDir, source, label = null }) {
  if (!RELAY_SOURCES.includes(source)) throw new Error('a relay token needs a relay source');
  const token = `btr_${crypto.randomBytes(32).toString('base64url')}`;
  const tokens = readRelayFile(dataDir);
  tokens.push({ hash: hashOf(token), source, label: typeof label === 'string' ? label.slice(0, 80) : null, createdAt: Date.now() });
  writeFileAtomic(path.join(dataDir, RELAY_FILE), `${JSON.stringify({ v: 1, tokens }, null, 2)}\n`, 0o600);
  return token;
}

/** Revokes every token of a source (e.g. when the UI disconnects a relay). */
export function revokeRelayTokens({ dataDir, source }) {
  const tokens = readRelayFile(dataDir).filter((t) => t.source !== source);
  writeFileAtomic(path.join(dataDir, RELAY_FILE), `${JSON.stringify({ v: 1, tokens }, null, 2)}\n`, 0o600);
}

/** → (token) → {kind:'relay', source} | null; re-reads the file when it changes. */
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
      map = new Map(readRelayFile(dataDir).map((t) => [t.hash, t.source]));
    }
    const source = map.get(hashOf(token));
    return source ? { kind: 'relay', source } : null;
  };
}
