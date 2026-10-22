'use strict';
// Agent awareness, main's side (plan-agent-awareness §3.1-§3.3): turns the
// interactive sessions Plexiform already tracks into a roster file the hooks
// read (hooks/awareness.js), so every AI session here learns about its peers
// without calling anything.
//
// Main must never block: only fs.promises and async execFile here
// (test/bus-main-thread.test.js). Git, ps and lsof run per new folder or
// process and are cached.
//
// What goes into roster.json is Plexiform's own: handles it computes, closed
// enums, folder and branch names cut to short labels, hashes. Never a prompt,
// title, summary, transcript or note text: the builder reads only the fields
// in SESSION_FIELDS (test/agent-awareness.test.js checks that statically).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RepoScope = require('../hooks/repo-scope.js');
const Hook = require('../hooks/awareness.js');

const DEFAULTS = Object.freeze({ enabled: true, notes: true, midTurnNotices: false });
const DEBOUNCE_MS = 1000;
const HEARTBEAT_MS = 2 * 60 * 1000;
const CLASSIFY_TTL_MS = 10 * 60 * 1000;
const BURST_WINDOW_MS = 60 * 1000;
const BURST_MIN = 3;
const GROUP_BUMP_MS = 5 * 60 * 1000;
const EXEC_TIMEOUT_MS = 3000;
const VERIFY_TTL_MS = 60 * 1000;
// One hung step (a FIFO, a stuck mount) must not hold every later rebuild.
const BUILD_TIMEOUT_MS = 15 * 1000;
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
const CONTEXT_PROVIDERS = new Set(['claude', 'codex', 'gemini']);
// The only session-file fields the roster is built from.
const SESSION_FIELDS = Object.freeze(['source', 'sessionId', 'host', 'remote', 'cwd', 'signal', 'updatedAt', 'codexHookAt', 'claudePid', 'codexServerPid', 'codexTranscript', 'interactive', 'codexInteractive', 'startedAt', 'codexStartedAt', 'signalSince', 'taskId']);
// Plexiform's own bus and task worktrees (main.js folders()): never peers.
const OWN_WORKTREE = /-buddy-[0-9a-f]{12}(?:[\\/]|$)/;

function normalize(cfg) {
  const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  return { enabled: c.enabled !== false, notes: c.notes !== false, midTurnNotices: c.midTurnNotices === true };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const within = RepoScope.within;

// <provider>-<folder≤16>-<4 hex>: a short id, not a secret (plan §3.1). The hex
// is keyed with a secret only main holds, so no session id can be ground offline
// to land on another session's handle.
function handleFor({ provider, folder, host, source, sessionId }, len = 4, key = null) {
  const f = String(folder || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 16).replace(/-+$/, '') || 'unnamed';
  const id = `${host}|${source}|${sessionId}`;
  const hex = key ? crypto.createHmac('sha256', key).update(id).digest('hex') : sha(id);
  return `${provider}-${f}-${hex.slice(0, len)}`;
}

// A bounded regular file, opened without following a symlink and without
// blocking on a FIFO, or null.
async function readHead(fsp, file, max) {
  let fh;
  try {
    fh = await fsp.open(file, OPEN_FLAGS);
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(max, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { text: buf.toString('utf8', 0, bytesRead), size: st.size, mtimeMs: st.mtimeMs };
  } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}

// Real claude and codex binaries only (findings §7).
function allowedExe(provider, exe, { home, codexHome, args = '' } = {}) {
  if (typeof exe !== 'string' || !path.isAbsolute(exe)) return false;
  const h = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (provider === 'claude') {
    if (new RegExp(`^${h}/\\.local/share/claude/versions/[0-9][\\w.+-]*$`).test(exe)) return true;
    if (/^\/(?:opt\/homebrew|usr\/local)\/Caskroom\/claude-code\/[\w.+-]+\/claude$/.test(exe)) return true;
    return /(?:^|\/)node$/.test(exe) && /\/node_modules\/@anthropic-ai\/claude-code\/cli\.js(?:\s|$)/.test(args);
  }
  if (provider === 'codex') {
    if (exe === '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex') return true;
    const ch = codexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^${ch}/packages/app-server-daemon/releases/[\\w.-]+/CodexCLI\\.app/Contents/MacOS/codex$`).test(exe)) return true;
    if (/^\/(?:opt\/homebrew|usr\/local)\/(?:Caskroom|Cellar)\/codex\/[\w.+-]+\/(?:[\w.+/-]+\/)?codex(?:-[\w-]+)?$/.test(exe)) return true;
    return /\/node_modules\/@openai\/codex\/(?:[\w.+-]+\/)*codex(?:-[\w-]+)?$/.test(exe);
  }
  return false;
}

// `lsof -F` output: "p<pid>", "f<fd>", "n<name>" lines.
// Every open file in `lsof -FDi` output, as "<dev>:<inode>" (D is the device in hex, as fstat's dev).
function lsofFiles(text) {
  const out = new Set();
  let dev = null;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'f') dev = null;
    else if (line[0] === 'D') dev = Number.parseInt(line.slice(1), 16);
    else if (line[0] === 'i' && Number.isFinite(dev) && /^\d+$/.test(line.slice(1))) out.add(`${dev}:${line.slice(1)}`);
  }
  return out;
}

function parseLsof(text) {
  const out = {};
  let fd = null;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'f') fd = line.slice(1);
    else if (line[0] === 'n' && fd && !(fd in out)) out[fd] = line.slice(1);
  }
  return out;
}

function statusOf(signal) {
  if (signal === 'permission-ask') return { status: 'idle', waiting_on: 'person' };
  if (signal === 'limit-hit') return { status: 'idle', waiting_on: 'limit' };
  if (signal === 'turn-failed') return { status: 'failed', waiting_on: null };
  if (['stop', 'idle-nudge', 'session-start'].includes(signal)) return { status: 'idle', waiting_on: null };
  return { status: 'working', waiting_on: null };
}

function interactiveOf(s, provider) {
  if (s.taskId || (typeof s.cwd === 'string' && OWN_WORKTREE.test(s.cwd))) return false;
  if (provider === 'claude') return s.interactive === true;
  if (provider === 'codex') return s.codexInteractive === true;
  return provider === 'gemini';
}

/**
 * sessions(): the live sessions main shows (aggregateState().sessions), local only.
 * execFile(file, args, opts, cb) and fsp (fs.promises) are injected for tests.
 */
function create({ rootDir, host, home, codexHome = path.join(home, '.codex'), dataDirs = [], config, sessions, execFile = require('child_process').execFile, fsp = require('fs').promises,
  now = () => Date.now(), startedAt = now(), halted = () => 'unknown', platform = process.platform, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
  handleKey = crypto.randomBytes(32), buildTimeoutMs = BUILD_TIMEOUT_MS }) {
  const rosterDir = path.join(rootDir, 'awareness');
  const rosterFile = path.join(rosterDir, 'roster.json');
  const run = (file, args, timeout = EXEC_TIMEOUT_MS) => new Promise((resolve, reject) => {
    try { execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))); } catch (e) { reject(e); }
  });
  const git = (dir, args) => run('git', ['-C', dir, ...args]);
  const realpath = (p) => fsp.realpath(p);
  const realOr = (p) => fsp.realpath(p).catch(() => p);

  const classified = new Map(); // cwd → { at, key, value: Promise }
  const procs = new Map();      // `${pid}` → { start, value }
  const heads = new Map();      // gitDir → { mtimeMs, branch }
  const firstSeen = new Map();  // session key → ms
  const groupState = new Map(); // group id → { countV, at }
  const verdicts = new Map();   // session key → true (allowed) | false
  const procChecks = new Map(); // provider|pid|cwd → { ok, at }
  let rootsCache = null;        // { at, key, value: Promise<string[]> }
  let lastVersion = null;

  const settings = () => {
    const c = config() || {};
    const exclude = (c.agentBus && Array.isArray(c.agentBus.exclude) ? c.agentBus.exclude : []).filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim().slice(0, 1024)).slice(0, 100);
    return { aw: normalize(c.agentAwareness), exclude, busEnabled: !(c.agentBus && c.agentBus.enabled === false) };
  };

  // Where a folder sits: its git top, git dirs and repo key, and the shared verdict.
  // Unresolved (git could not answer) is excluded.
  function classify(cwd, exclude) {
    const key = JSON.stringify(exclude);
    const hit = classified.get(cwd);
    if (hit && hit.key === key && now() - hit.at < CLASSIFY_TTL_MS) return hit.value;
    const value = (async () => {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { allowed: false, reason: 'UNRESOLVED' };
      let broken = false;
      const gitTracked = (dir, args) => git(dir, args).catch((e) => { if (typeof e?.code !== 'number' || e.killed || e.signal) broken = true; throw e; });
      const info = await gitTracked(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']).then((out) => out.trim().split('\n'), () => null);
      if (broken) return { allowed: false, reason: 'UNRESOLVED' };
      let top; let gitDir = null; let commonDir = null;
      try {
        // A path with a newline in it shifts every line after it: anything but three answers is unresolved.
        if (info && info.length !== 3) return { allowed: false, reason: 'UNRESOLVED' };
        if (info) {
          top = await realpath(info[0]);
          gitDir = await realOr(info[1]);
          commonDir = await realOr(path.resolve(cwd, info[2]));
        } else {
          top = await realpath(cwd);
          // git said "not a checkout" while one is plainly there: git could not answer.
          for (let p = top; ; p = path.dirname(p)) {
            if (await fsp.access(path.join(p, '.git')).then(() => true, () => false)) return { allowed: false, reason: 'UNRESOLVED' };
            if (path.dirname(p) === p) break;
          }
        }
      } catch { return { allowed: false, reason: 'UNRESOLVED' }; }
      const h = await realOr(home);
      const reason = await RepoScope.neverReason(top, { home: h, dataDirs, exclude, git: gitTracked, realpath }) || RepoScope.protectedReason(top, h);
      if (broken) return { allowed: false, reason: 'UNRESOLVED' };
      return { allowed: reason === null, reason, top, gitDir, repoKey: commonDir ? sha(commonDir).slice(0, 16) : null, folder: path.basename(top) };
    })().catch(() => ({ allowed: false, reason: 'UNRESOLVED' }));
    classified.set(cwd, { at: now(), key, value });
    return value;
  }

  async function branchOf(gitDir) {
    if (!gitDir) return null;
    const head = await readHead(fsp, path.join(gitDir, 'HEAD'), 1024);
    if (!head || head.size > 1024) return null;
    const hit = heads.get(gitDir);
    if (hit && hit.mtimeMs === head.mtimeMs) return hit.branch;
    const m = /^ref: refs\/heads\/(.+)$/m.exec(head.text);
    const branch = m ? m[1].trim().slice(0, 200) : null;
    heads.set(gitDir, { mtimeMs: head.mtimeMs, branch });
    return branch;
  }

  // The executable and cwd of a pid, cached per (pid, start time).
  async function inspect(pid) {
    if (platform === 'darwin') {
      const start = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]).then((out) => out.trim(), () => null);
      if (!start) return null;
      const hit = procs.get(String(pid));
      if (hit && hit.start === start) return hit.value;
      const value = await (async () => {
        const f = parseLsof(await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'txt,cwd', '-Fn'])); // privacy-flow: agent-awareness-local
        if (!f.txt) return null;
        const exe = await realOr(f.txt);
        const args = /(?:^|\/)node$/.test(exe) ? await run('/bin/ps', ['-o', 'args=', '-p', String(pid)]).catch(() => '') : '';
        return { exe, cwd: f.cwd ? await realOr(f.cwd) : null, args };
      })().catch(() => null);
      procs.set(String(pid), { start, value });
      return value;
    }
    if (platform === 'linux') {
      try {
        const stat = String(await fsp.readFile(`/proc/${pid}/stat`, 'utf8'));
        const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        const hit = procs.get(String(pid));
        if (hit && hit.start === start) return hit.value;
        const exe = await fsp.readlink(`/proc/${pid}/exe`);
        const cwd = await fsp.readlink(`/proc/${pid}/cwd`).catch(() => null);
        const args = /(?:^|\/)node$/.test(exe) ? String(await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' ') : '';
        const value = { exe, cwd, args };
        procs.set(String(pid), { start, value });
        return value;
      } catch { return null; }
    }
    return null; // Windows: not verifiable in v1, so never a peer.
  }

  // A server's open files, one lsof per server per rebuild.
  let serverFiles = new Map();
  const openFilesOf = (pid) => {
    if (!serverFiles.has(pid)) serverFiles.set(pid, run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-FDi']).then(lsofFiles, () => new Set())); // privacy-flow: agent-awareness-local
    return serverFiles.get(pid);
  };

  // Codex: the server behind the recorded pid holds this very file open (by
  // device and inode, so no path can be swapped in between), and the rollout
  // (Codex's file, not ours) names this thread, as a person's, in exactly the
  // recorded folder: a thread's folder is fixed, and a folder inside it could
  // be any repo an agent made there.
  async function codexThread(s, pid) {
    if (typeof s.codexTranscript !== 'string' || !path.isAbsolute(s.codexTranscript) || !s.codexTranscript.endsWith('.jsonl')) return false;
    const t = await realpath(s.codexTranscript).catch(() => null);
    if (!t || !within(t, await realOr(codexHome))) return false;
    const open = await openFilesOf(pid);
    let fh;
    let text;
    try {
      fh = await fsp.open(t, OPEN_FLAGS);
      const st = await fh.stat();
      if (!st.isFile() || !open.has(`${st.dev}:${st.ino}`)) return false;
      const buf = Buffer.alloc(Math.min(Hook.META_MAX_BYTES, st.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      text = buf.toString('utf8', 0, bytesRead);
    } catch { return false; } finally { if (fh) await fh.close().catch(() => {}); }
    const meta = Hook.sessionMetaOf(text);
    if (!meta || meta.interactive !== true || meta.id !== s.sessionId || !meta.cwd || !path.isAbsolute(meta.cwd)) return false;
    return (await realOr(s.cwd)) === (await realOr(meta.cwd));
  }

  // Verified (plan §3.1): a recent event, a real claude or codex binary behind
  // the recorded pid, and (Claude) that process in the recorded folder or one
  // above it, (Codex) the thread bound to that server by its own rollout. The
  // event time comes from the session file, which any program running as the
  // person can write: the process checks are what a forged file cannot pass.
  async function verify(s, provider, pidCount) {
    const seen = Math.max(Date.parse(s.updatedAt || '') || 0, Date.parse(s.codexHookAt || '') || 0);
    if (seen < startedAt) return false;
    const pid = Number(provider === 'claude' ? s.claudePid : provider === 'codex' ? s.codexServerPid : NaN);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    // One Claude process is one session: a second file naming the same pid makes neither a peer.
    if (provider === 'claude' && pidCount.get(pid) > 1) return false;
    // A busy turn rebuilds every second: the process checks are repeated at most once a minute per (pid, folder, thread).
    const memo = `${provider}|${pid}|${s.cwd}|${provider === 'codex' ? `${s.sessionId}|${s.codexTranscript}` : ''}`;
    const hit = procChecks.get(memo);
    if (hit && now() - hit.at < VERIFY_TTL_MS) return hit.ok;
    const ok = await (async () => {
      const p = await inspect(pid);
      if (!p || !allowedExe(provider, p.exe, { home, codexHome, args: p.args })) return false;
      if (provider === 'codex') return codexThread(s, pid);
      if (!p.cwd) return false;
      return within(await realOr(s.cwd), p.cwd);
    })().catch(() => false);
    procChecks.set(memo, { ok, at: now() });
    return ok;
  }

  // Excluded folders, every linked worktree of an excluded repo, deny and data roots: hashed, never the paths.
  function excludedRoots(exclude) {
    const key = JSON.stringify(exclude);
    if (rootsCache && rootsCache.key === key && now() - rootsCache.at < CLASSIFY_TTL_MS) return rootsCache.value;
    const value = (async () => {
      const h = await realOr(home);
      const roots = new Set([...RepoScope.DENY_READ.map((p) => path.join(h, p.replace(/^~\//, ''))), ...(await Promise.all(dataDirs.map(realOr)))]);
      for (const e of exclude.filter((x) => path.isAbsolute(x))) {
        const r = await realOr(e);
        roots.add(r);
        const list = await git(r, ['worktree', 'list', '--porcelain']).catch(() => '');
        for (const m of list.matchAll(/^worktree (.+)$/gm)) roots.add(await realOr(m[1]));
      }
      return [...roots].map((p) => sha(p).slice(0, 32)).sort();
    })().catch(() => []);
    rootsCache = { at: now(), key, value };
    return value;
  }

  // Three or more of one provider started in one repo within a minute: one
  // unaddressable line for everyone outside the group (plan §3.1, AW14).
  function groupsOf(entries, at) {
    const buckets = new Map();
    for (const e of entries) {
      const k = `${e.peer.provider}|${e.peer.repo_key || `f:${e.peer.folder}`}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(e);
    }
    const groups = [];
    for (const list of buckets.values()) {
      list.sort((a, b) => a.started - b.started || (a.key < b.key ? -1 : 1));
      for (let i = 0; i < list.length;) {
        let j = i + 1;
        while (j < list.length && list[j].started - list[i].started <= BURST_WINDOW_MS) j += 1;
        if (j - i >= BURST_MIN) {
          const members = list.slice(i, j);
          const id = `g${sha(`${members[0].peer.provider}|${members[0].peer.repo_key || members[0].peer.folder}|${members[0].key}`).slice(0, 12)}`;
          const st = groupState.get(id);
          if (!st) groupState.set(id, { countV: members.length, at });
          else if (st.countV !== members.length && at - st.at >= GROUP_BUMP_MS) groupState.set(id, { countV: members.length, at });
          for (const m of members) m.peer.group = id;
          groups.push({ id, provider: members[0].peer.provider, folder: members[0].peer.folder, repo_key: members[0].peer.repo_key, count: members.length, count_v: groupState.get(id).countV });
        }
        i = j;
      }
    }
    const live = new Set(groups.map((g) => g.id));
    for (const id of groupState.keys()) if (!live.has(id)) groupState.delete(id);
    return groups;
  }

  async function build() {
    const at = now();
    serverFiles = new Map();
    const { aw, exclude, busEnabled } = settings();
    const list = (sessions() || []).filter((s) => s && !s.remote && (!s.host || s.host === host)).map((s) => Object.fromEntries(SESSION_FIELDS.map((k) => [k, s[k]])));
    const self = {};
    const entries = [];
    const nextVerdicts = new Map();
    // Ties fail closed for every claimant: two files with one session id (a
    // copy could borrow an excluded session's verdict or hide an allowed one),
    // or two Claude sessions naming one process.
    const keyCount = new Map();
    const pidCount = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const s of list) {
      const provider = String(s.source || 'claude');
      bump(keyCount, `${provider}|${s.sessionId}`);
      if (provider === 'claude' && Number.isInteger(Number(s.claudePid)) && s.claudePid != null) bump(pidCount, Number(s.claudePid));
    }
    for (const s of list) {
      const provider = String(s.source || 'claude');
      const key = `${provider}|${s.sessionId}`;
      if (!firstSeen.has(key)) firstSeen.set(key, at);
      if (keyCount.get(key) > 1) { nextVerdicts.set(key, false); self[key] = { allowed: false }; continue; }
      const cls = await classify(s.cwd, exclude);
      nextVerdicts.set(key, cls.allowed === true);
      // Every excluded session, whatever its tool, is only {allowed:false}: AI-facing views drop it.
      if (!cls.allowed) { self[key] = { allowed: false }; continue; }
      if (!CONTEXT_PROVIDERS.has(provider)) continue;
      const interactive = interactiveOf(s, provider);
      const verified = interactive && (provider === 'claude' || provider === 'codex') ? await verify(s, provider, pidCount).catch(() => false) : false;
      const entry = { allowed: true, interactive, verified, bound: false, caps: { mcp: false, notes: false }, notices: [], repo_key: cls.repoKey || null };
      self[key] = entry;
      if (!verified) continue;
      const handle = handleFor({ provider, folder: cls.folder, host, source: provider, sessionId: s.sessionId }, 4, handleKey);
      const since = Date.parse(s.signalSince || s.updatedAt || '');
      const peer = { handle, provider, folder: Hook.folderLabel(cls.folder), repo_key: cls.repoKey || null, branch: cls.repoKey ? Hook.branchLabel(await branchOf(cls.gitDir)) || null : null,
        ...statusOf(s.signal), since_min: Number.isFinite(since) ? Math.max(0, Math.floor((at - since) / 60000)) : null };
      entries.push({ key, peer, entry, long: handleFor({ provider, folder: cls.folder, host, source: provider, sessionId: s.sessionId }, 6, handleKey), updated: Date.parse(s.updatedAt || '') || 0, started: Date.parse(s.startedAt || s.codexStartedAt || '') || firstSeen.get(key) });
    }
    // A 4-hex collision lengthens every colliding handle, so no session keeps the short one by being read first.
    const shortCount = new Map();
    for (const e of entries) bump(shortCount, e.peer.handle);
    for (const e of entries) if (shortCount.get(e.peer.handle) > 1) e.peer.handle = e.long;
    const longCount = new Map();
    for (const e of entries) bump(longCount, e.peer.handle);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      if (longCount.get(e.peer.handle) > 1) { e.entry.verified = false; entries.splice(i, 1); } else e.entry.handle = e.peer.handle;
    }
    for (const k of firstSeen.keys()) if (!nextVerdicts.has(k)) firstSeen.delete(k);
    for (const [k, v] of procChecks) if (at - v.at >= VERIFY_TTL_MS) procChecks.delete(k);
    verdicts.clear();
    for (const [k, v] of nextVerdicts) verdicts.set(k, v);
    const groups = groupsOf(entries, at);
    for (const e of entries) if (e.peer.group) e.entry.group = e.peer.group;
    const peers = entries.sort((a, b) => b.updated - a.updated).map((e) => e.peer);
    const version = sha(JSON.stringify([
      ...peers.filter((p) => !p.group).map((p) => ['p', p.handle, p.provider, p.folder, p.repo_key, p.branch]),
      ...groups.map((g) => ['g', g.id, g.provider, g.folder, g.repo_key, g.count_v]),
    ].map((x) => JSON.stringify(x)).sort()));
    const h = halted();
    return {
      v: 1, version, generated_at: new Date(at).toISOString(),
      bus: { enabled: busEnabled, halted: h === true || h === false ? h : 'unknown' },
      excluded_roots: await excludedRoots(exclude), has_remote_excludes: exclude.some((x) => !path.isAbsolute(x)),
      peers, groups, self, notes: aw.notes,
    };
  }

  async function write(roster) {
    await fsp.mkdir(rosterDir, { recursive: true, mode: 0o700 });
    // The folder itself, never a symlink planted in its place: chmod goes through the open handle.
    const dir = await fsp.open(rosterDir, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_DIRECTORY || 0));
    try {
      const st = await dir.stat();
      if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw Object.assign(new Error('roster folder'), { code: 'EUNSAFE' });
      await dir.chmod(0o700).catch(() => {});
    } finally { await dir.close().catch(() => {}); }
    const tmp = `${rosterFile}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(roster), { flag: 'wx', mode: 0o600 });
      await fsp.rename(tmp, rosterFile);
    } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  }

  let timer = null; let running = null; let again = false; let heartbeat = null; let stopped = false;
  async function refresh() {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        const { aw } = settings();
        let hung;
        const roster = await Promise.race([build(), new Promise((_, reject) => { hung = setTimeout(() => reject(Object.assign(new Error('build'), { code: 'ETIMEDOUT' })), buildTimeoutMs); if (hung.unref) hung.unref(); })])
          .finally(() => clearTimeout(hung));
        if (stopped) return;
        if (!aw.enabled) { await fsp.rm(rosterFile, { force: true }).catch(() => {}); lastVersion = null; return; }
        await write(roster);
        if (roster.version !== lastVersion) {
          lastVersion = roster.version;
          log(`[awareness] roster peers=${roster.peers.length} groups=${roster.groups.length} sessions=${Object.keys(roster.self).length}`);
        }
      } catch (e) { log(`[awareness] roster not written: ${e && e.code ? e.code : 'error'}`); }
    })().finally(() => { running = null; if (again && !stopped) { again = false; schedule(); } });
    return running;
  }
  function schedule() {
    if (timer || stopped) return;
    timer = setTimer(() => { timer = null; refresh(); }, DEBOUNCE_MS);
  }
  function start() {
    stopped = false;
    if (!heartbeat) heartbeat = setInterval(schedule, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();
    schedule();
  }
  function stop() {
    stopped = true;
    if (timer) { clearTimer(timer); timer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }
  // The exclude list changed: drop every cached verdict and rebuild.
  function invalidate() { classified.clear(); rootsCache = null; schedule(); }
  // GET /status and other AI-facing listings: is this session's folder shown? Unresolved is not.
  const visible = (s) => !!s && verdicts.get(`${String(s.source || 'claude')}|${s.sessionId}`) === true;

  return { build, refresh, schedule, start, stop, invalidate, visible, rosterFile, classify };
}

module.exports = { create, normalize, handleFor, allowedExe, parseLsof, lsofFiles, statusOf, interactiveOf, DEFAULTS, SESSION_FIELDS, HEARTBEAT_MS, DEBOUNCE_MS, BUILD_TIMEOUT_MS, BURST_WINDOW_MS, GROUP_BUMP_MS };
