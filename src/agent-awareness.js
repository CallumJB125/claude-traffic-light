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
const CONTEXT_PROVIDERS = new Set(['claude', 'codex', 'gemini']);
// The only session-file fields the roster is built from.
const SESSION_FIELDS = Object.freeze(['source', 'sessionId', 'host', 'remote', 'cwd', 'signal', 'updatedAt', 'codexHookAt', 'claudePid', 'codexServerPid', 'interactive', 'codexInteractive', 'startedAt', 'codexStartedAt', 'signalSince', 'taskId']);
// Plexiform's own bus and task worktrees (main.js folders()): never peers.
const OWN_WORKTREE = /-buddy-[0-9a-f]{12}(?:[\\/]|$)/;

function normalize(cfg) {
  const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  return { enabled: c.enabled !== false, notes: c.notes !== false, midTurnNotices: c.midTurnNotices === true };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const within = RepoScope.within;

// <provider>-<folder≤16>-<4 hex>: a short id, not a secret (plan §3.1).
function handleFor({ provider, folder, host, source, sessionId }, len = 4) {
  const f = String(folder || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 16).replace(/-+$/, '') || 'unnamed';
  return `${provider}-${f}-${sha(`${host}|${source}|${sessionId}`).slice(0, len)}`;
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
  now = () => Date.now(), startedAt = now(), halted = () => 'unknown', platform = process.platform, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
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
        if (info && info.length >= 3) {
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
    try {
      const head = path.join(gitDir, 'HEAD');
      const st = await fsp.stat(head);
      const hit = heads.get(gitDir);
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.branch;
      const text = String(await fsp.readFile(head, 'utf8')).slice(0, 1024);
      const m = /^ref: refs\/heads\/(.+)$/m.exec(text);
      const branch = m ? m[1].trim().slice(0, 200) : null;
      heads.set(gitDir, { mtimeMs: st.mtimeMs, branch });
      return branch;
    } catch { return null; }
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

  // Verified (plan §3.1): an event observed since main started, a real claude
  // or codex binary behind the recorded pid, and (Claude) that process in the
  // recorded folder or one above it. The Codex pid is its app server, whose
  // cwd is not the thread's, so that check is skipped there.
  async function verify(s, provider) {
    const seen = Math.max(Date.parse(s.updatedAt || '') || 0, Date.parse(s.codexHookAt || '') || 0);
    if (seen < startedAt) return false;
    const pid = Number(provider === 'claude' ? s.claudePid : provider === 'codex' ? s.codexServerPid : NaN);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    // A busy turn rebuilds every second: the process checks are repeated at most once a minute per (pid, folder).
    const memo = `${provider}|${pid}|${s.cwd}`;
    const hit = procChecks.get(memo);
    if (hit && now() - hit.at < VERIFY_TTL_MS) return hit.ok;
    const ok = await (async () => {
      const p = await inspect(pid);
      if (!p || !allowedExe(provider, p.exe, { home, codexHome, args: p.args })) return false;
      if (provider === 'codex') return true;
      if (!p.cwd) return false;
      return within(await realOr(s.cwd), p.cwd);
    })();
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
    const { aw, exclude, busEnabled } = settings();
    const list = (sessions() || []).filter((s) => s && !s.remote && (!s.host || s.host === host)).map((s) => Object.fromEntries(SESSION_FIELDS.map((k) => [k, s[k]])));
    const self = {};
    const entries = [];
    const nextVerdicts = new Map();
    const handles = new Map();
    for (const s of list) {
      const provider = String(s.source || 'claude');
      const key = `${provider}|${s.sessionId}`;
      if (!firstSeen.has(key)) firstSeen.set(key, at);
      const cls = await classify(s.cwd, exclude);
      nextVerdicts.set(key, cls.allowed === true);
      if (!CONTEXT_PROVIDERS.has(provider)) continue;
      if (!cls.allowed) { self[key] = { allowed: false }; continue; }
      const interactive = interactiveOf(s, provider);
      const verified = interactive && (provider === 'claude' || provider === 'codex') ? await verify(s, provider).catch(() => false) : false;
      const entry = { allowed: true, interactive, verified, bound: false, caps: { mcp: false, notes: false }, notices: [], repo_key: cls.repoKey || null };
      self[key] = entry;
      if (!verified) continue;
      let handle = handleFor({ provider, folder: cls.folder, host, source: provider, sessionId: s.sessionId });
      if (handles.has(handle) && handles.get(handle) !== key) handle = handleFor({ provider, folder: cls.folder, host, source: provider, sessionId: s.sessionId }, 6);
      handles.set(handle, key);
      entry.handle = handle;
      const since = Date.parse(s.signalSince || s.updatedAt || '');
      const peer = { handle, provider, folder: Hook.folderLabel(cls.folder), repo_key: cls.repoKey || null, branch: cls.repoKey ? Hook.branchLabel(await branchOf(cls.gitDir)) || null : null,
        ...statusOf(s.signal), since_min: Number.isFinite(since) ? Math.max(0, Math.floor((at - since) / 60000)) : null };
      entries.push({ key, peer, entry, updated: Date.parse(s.updatedAt || '') || 0, started: Date.parse(s.startedAt || s.codexStartedAt || '') || firstSeen.get(key) });
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
    await fsp.chmod(rosterDir, 0o700).catch(() => {});
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
        const roster = await build();
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

module.exports = { create, normalize, handleFor, allowedExe, parseLsof, statusOf, interactiveOf, DEFAULTS, SESSION_FIELDS, HEARTBEAT_MS, DEBOUNCE_MS, BURST_WINDOW_MS, GROUP_BUMP_MS };
