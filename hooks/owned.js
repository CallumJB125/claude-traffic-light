// Buddy-OWNED sessions: a session counts as Buddy's only if Buddy launched
// it. The launcher writes a record into <root>/owned/<launchId>.json (0600 in
// a 0700 dir) and starts the CLI with BUDDY_OWNED=<launchId>; the SessionStart
// hook (set-status.js) checks the env var against that record and claims it.
// An env var alone proves nothing (any shell can set one), so an id without a
// record Buddy wrote is never owned.
//
// Record  <launchId>.json  {v:1, launchId, launcher, cwd, tmux?:{pane,socket,serverPid}, createdAt, expiresAt}
// Claim   <launchId>.claim {v:1, sessionId, claudePid, at}   created once (link, EEXIST = taken)
//
// The claim window (expiresAt) only bounds the first SessionStart. After that
// the same Claude process (a /clear starts a new session id) or the same
// session id (a --resume in a new process) keeps ownership; anyone else is
// refused. Ownership gates the send-keys answer path, which is not built yet
// (docs/waiting-inputs.md); this module only detects it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createExclusive } = require('./answer-file.js');

const LAUNCH_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CLAIM_WINDOW_MS = 10 * 60 * 1000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const dirOf = (root) => path.join(root, 'owned');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

// Only this user's own files, not writable by anyone else, count. Windows has
// no uid and reports every file as 0666, so there the per-user profile ACLs
// stand in and only the regular-file check applies.
function ownFile(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) return false;
  if (process.platform === 'win32') return true;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
  return (st.mode & 0o022) === 0;
}

function readJson(file) {
  try { return ownFile(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}

// tmux: the pane the launcher started the CLI in, when it did (lets the
// widget look at a startup dialog before any hook has fired).
function recordLaunch(root, { launcher, cwd, tmux = null, claimWindowMs = CLAIM_WINDOW_MS, now = Date.now() } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('recordLaunch: cwd must be absolute');
  const dir = dirOf(root);
  ensureDir(dir);
  sweep(root, { now });
  const launchId = crypto.randomBytes(18).toString('base64url');
  const record = {
    v: 1, launchId, launcher: String(launcher || 'buddy').slice(0, 40), cwd,
    ...(tmux && /^%\d{1,9}$/.test(String(tmux.pane || '')) ? { tmux: { pane: tmux.pane, socket: tmux.socket || null, serverPid: tmux.serverPid || null } } : {}),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + claimWindowMs).toISOString(),
  };
  if (!createExclusive(path.join(dir, `${launchId}.json`), JSON.stringify(record))) throw new Error('launch id collision'); // privacy-flow: launch-record
  return { launchId, record, env: { BUDDY_OWNED: launchId } };
}

const under = (child, parent) => {
  if (!path.isAbsolute(child)) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

// { owned: true, launchId, launcher, since } | { owned: false, reason }.
// Claims the record on first use, so the check has a side effect.
function checkOwned(root, launchId, { sessionId, claudePid = null, cwd, now = Date.now() } = {}) {
  if (typeof launchId !== 'string' || !LAUNCH_ID_RE.test(launchId)) return { owned: false, reason: 'bad launch id' };
  const dir = dirOf(root);
  const rec = readJson(path.join(dir, `${launchId}.json`));
  if (!rec || rec.v !== 1 || rec.launchId !== launchId) return { owned: false, reason: 'no launch record' };
  if (typeof cwd !== 'string' || !under(cwd, rec.cwd)) return { owned: false, reason: 'cwd outside the launch folder' };
  if (typeof sessionId !== 'string' || !sessionId) return { owned: false, reason: 'no session id' };
  const claimFile = path.join(dir, `${launchId}.claim`);
  const ok = { owned: true, launchId, launcher: rec.launcher, since: rec.createdAt };
  const prior = readJson(claimFile);
  if (prior) {
    if (prior.sessionId === sessionId || (claudePid && prior.claudePid === claudePid)) return ok;
    return { owned: false, reason: 'claimed by another session' };
  }
  if (now > Date.parse(rec.expiresAt)) return { owned: false, reason: 'launch record expired' };
  try {
    if (createExclusive(claimFile, JSON.stringify({ v: 1, sessionId, claudePid, at: new Date(now).toISOString() }))) return ok;
  } catch { return { owned: false, reason: 'claim failed' }; }
  const winner = readJson(claimFile);
  return winner && winner.sessionId === sessionId ? ok : { owned: false, reason: 'claimed by another session' };
}

// Launches nobody has claimed yet: a CLI stuck on a startup dialog (trust
// folder, new MCP servers) runs no hook, so these are the only way to find it.
function unclaimedLaunches(root, { now = Date.now() } = {}) {
  const dir = dirOf(root);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const rec = readJson(path.join(dir, f));
    if (!rec || rec.v !== 1 || !LAUNCH_ID_RE.test(String(rec.launchId)) || f !== `${rec.launchId}.json`) continue;
    if (fs.existsSync(path.join(dir, `${rec.launchId}.claim`))) continue;
    if (now > Date.parse(rec.expiresAt)) continue;
    out.push(rec);
  }
  return out;
}

function sweep(root, { now = Date.now() } = {}) {
  const dir = dirOf(root);
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const st = fs.statSync(file);
      const claimed = f.endsWith('.claim') || fs.existsSync(file.replace(/\.json$/, '.claim'));
      if (now - st.mtimeMs > (claimed ? KEEP_MS : CLAIM_WINDOW_MS * 6)) fs.unlinkSync(file);
    } catch {}
  }
}

module.exports = { LAUNCH_ID_RE, CLAIM_WINDOW_MS, dirOf, recordLaunch, checkOwned, unclaimedLaunches, sweep };
