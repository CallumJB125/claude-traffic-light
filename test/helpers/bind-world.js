'use strict';
// A fake process table for caller binding (src/agent-awareness.js bindCaller): /bin/ps, /usr/sbin/lsof and
// /usr/bin/codesign answer from it; git runs for real. One interactive Claude Code session X (claude 100, our MCP
// child 101) and one Codex TUI thread T (server 200, our MCP child 201). Shared by test/bus-caller-binding.test.js
// and test/awareness-notes-e2e.test.js.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const A = require('../../src/agent-awareness.js');
const PeerPid = require('../../src/peer-pid.js');
const { testTempDir } = require('./tmp');

const HOST = 'testhost';
const START = 'Thu Oct 22 10:00:00 2026';
const SELF = 99999;
const gitInit = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: dir });
  return fs.realpathSync(dir);
};

// Plexiform's own server as it registers itself (mcp-install.js launch, packaged): the only command line that binds.
const PLEX = '/Applications/Plexiform.app/Contents/MacOS/Plexiform';
const ASAR = '/Applications/Plexiform.app/Contents/Resources/app.asar/mcp-server.js';
const SERVER_ARGS = `${PLEX} --disable-sigusr1 ${ASAR} --profile bus`;
// The same launch before step 3 added --disable-sigusr1: never ours.
const OLD_SERVER_ARGS = `${PLEX} ${ASAR} --profile bus`;
const SERVERS = [{ command: PLEX, args: ['--disable-sigusr1', ASAR, '--profile', 'bus'] }, { command: PLEX, args: ['--disable-sigusr1', ASAR] }];

// A fake process table behind /bin/ps, /usr/sbin/lsof and /usr/bin/codesign; git runs for real. It answers the
// call shapes of this branch and of the commit the review looked at (71283064), so the review's proofs of concept
// below run against both.
function world(t, { platform = 'darwin', at = Date.now() } = {}) {
  const dir = fs.realpathSync(testTempDir('pf-bind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const root = path.join(home, '.claude-traffic-light');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(root, { recursive: true });
  const repoA = gitInit(path.join(home, 'code', 'app'));
  const repoB = gitInit(path.join(home, 'code', 'site'));
  const repoC = gitInit(path.join(home, 'code', 'docs'));
  const procs = new Map();
  const calls = [];
  let caller = null;
  const ports = new Map(); // remote port → pid, for callers made with callAs()
  const CLAUDE = path.join(home, '.local/share/claude/versions/2.1.308');
  const CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  let nextAddr = 0x1000;
  const addr = () => `0x${(nextAddr++).toString(16)}`;
  // fd 0, 1 and 2 of `child` as stream ends whose other ends `parent` holds (type PIPE for Codex, unix for Claude).
  const stdio = (child, parent, type) => {
    for (const fd of ['0', '1', '2']) {
      const a = addr(); const b = addr();
      child.fds[fd] = { type, addr: a, peer: b };
      parent.fds[String(40 + Object.keys(parent.fds).length)] = { type, addr: b, peer: a };
    }
  };
  // signed: 'claude' | 'codex' | null, the requirement the running process satisfies. args: its command line; env: its environment.
  const proc = (pid, p) => { const v = { ppid: 1, start: START, exe: '/bin/sleep', cwd: home, args: '', env: '', signed: null, fds: {}, files: [], ...p }; procs.set(pid, v); return v; };
  const fdLines = (p, only) => Object.entries(p.fds).filter(([fd]) => !only || only.includes(fd)).map(([fd, f]) => `f${fd}\nt${f.type}\n${f.addr ? `d${f.addr}\n` : ''}n${f.peer ? `->${f.peer}` : f.name || ''}\n`).join('');
  const fileLines = (p) => p.files.map(({ file: f }, i) => { const st = fs.statSync(f); return `f${30 + i}\nD0x${st.dev.toString(16)}\ni${st.ino}\nn${f}\n`; }).join('');
  const argvOf = (p) => p.args || path.basename(p.exe);
  const fakeExec = (file, args, opts, cb) => {
    calls.push([file, ...args]);
    if (file === 'git') return execFile(file, args, opts, cb);
    const none = () => cb(Object.assign(new Error('none'), { code: 1 }), '');
    const tcp = args.find((a) => a.startsWith('-iTCP@127.0.0.1:'));
    if (file === '/usr/sbin/lsof' && tcp) {
      const who = ports.get(Number(tcp.split(':').pop())) ?? caller;
      return who ? cb(null, `p${who}\nf5\np${SELF}\nf9\n`) : none();
    }
    if (file === '/usr/bin/codesign') {
      const q = procs.get(Number(args[args.length - 1]));
      return q && q.signed && args.includes(`-R=${PeerPid.REQUIREMENT[q.signed]}`) ? cb(null, '') : cb(Object.assign(new Error('failed to satisfy'), { code: 3 }), '');
    }
    const pid = Number(args[args.indexOf('-p') + 1]);
    const p = procs.get(pid);
    if (!p) return none();
    if (file === '/bin/ps') {
      if (args.includes('ppid=,lstart=')) return cb(null, `${p.ppid} ${p.start}\n`);
      if (args.includes('lstart=')) return cb(null, `${p.start}\n`);
      if (args.includes('command=')) return cb(null, `${argvOf(p)}${p.env ? ` ${p.env}` : ''}\n`);
      return cb(null, `${argvOf(p)}\n`);
    }
    if (file === '/usr/sbin/lsof') {
      const head = `p${pid}\nfcwd\ntDIR\nn${p.cwd}\nftxt\ntREG\nn${p.exe}\n`;
      if (args.includes('-FDi')) return cb(null, `p${pid}\n${fileLines(p)}`);
      if (args.includes('ftdnDi')) return cb(null, `${head}${fdLines(p)}${fileLines(p)}`);
      const d = args.includes('-d') ? args[args.indexOf('-d') + 1] : null;
      if (d === 'txt,cwd') return cb(null, `p${pid}\nfcwd\nn${p.cwd}\nftxt\nn${p.exe}\n`);
      if (d === '0,1,cwd') return cb(null, `p${pid}\n${fdLines(p, ['0', '1'])}fcwd\ntDIR\nn${p.cwd}\n`);
      return cb(null, `p${pid}\n${fdLines(p)}`);
    }
    return none();
  };
  const now = at;
  const state = { config: {}, sessions: [] };
  const logs = [];
  // A Codex rollout under CODEX_HOME whose first line names the thread, as Codex writes it.
  const rollout = (id, cwd, extra = {}) => {
    const f = path.join(codexHome, 'sessions', '2026', '10', '22', `rollout-${id}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'vscode', thread_source: 'user', originator: 'codex-tui', ...extra } })}\n`);
    return f;
  };
  const make = (opts = {}) => A.create({ rootDir: root, host: HOST, home, codexHome, dataDirs: [root], config: () => state.config, sessions: () => state.sessions, execFile: fakeExec,
    platform, startedAt: now - 60_000, selfPid: SELF, handleKey: Buffer.alloc(32, 7), log: (m) => logs.push(m), bindRetryMs: 5, servers: () => SERVERS, bindCacheMs: 0, ...opts });
  const iso = new Date(now).toISOString();

  // One interactive Claude Code session X in repoA (claude 100, our MCP child 101) and one Codex TUI thread T in
  // repoB on the shared daemon (server 200, our MCP child 201).
  const claude = proc(100, { exe: CLAUDE, cwd: repoA, signed: 'claude', args: 'claude' });
  const claudeMcp = proc(101, { ppid: 100, exe: PLEX, cwd: repoA, args: SERVER_ARGS, env: 'ELECTRON_RUN_AS_NODE=1 PLEXIFORM_MCP=bus-v1:packaged CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_SESSION_ID=X CLAUDE_PID=100' });
  stdio(claudeMcp, claude, 'unix');
  const T = '019a0000-0000-7000-8000-00000000000t';
  const server = proc(200, { exe: CODEX, cwd: home, signed: 'codex', args: `${CODEX} app-server`, files: [{ file: rollout(T, repoB) }] });
  const codexMcp = proc(201, { ppid: 200, exe: PLEX, cwd: repoB, args: SERVER_ARGS, env: 'ELECTRON_RUN_AS_NODE=1 PLEXIFORM_MCP=bus-v1:packaged' });
  stdio(codexMcp, server, 'PIPE');
  const claudeSession = (id = 'X', extra = {}) => ({ source: 'claude', sessionId: id, host: HOST, cwd: repoA, signal: 'prompt-submit', updatedAt: iso, claudePid: 100, interactive: true, ...extra });
  const codexSession = (id = T, extra = {}) => ({ source: 'codex', sessionId: id, host: HOST, cwd: repoB, signal: 'stop', updatedAt: iso, codexHookAt: iso, codexServerPid: 200, codexInteractive: true, codexTranscript: path.join(codexHome, 'sessions', '2026', '10', '22', `rollout-${id}.jsonl`), ...extra });
  state.sessions = [claudeSession(), codexSession()];
  // A copy of our MCP child under another parent: same program, command line and environment.
  const mcpChild = (pid, ppid, cwd, like = codexMcp) => proc(pid, { ppid, exe: like.exe, cwd, args: like.args, env: like.env });
  return { dir, home, root, codexHome, repoA, repoB, repoC, procs, proc, stdio, mcpChild, calls, state, logs, make, rollout, T, CLAUDE, CODEX, claudeSession, codexSession, iso,
    call: (pid) => { caller = pid; return { remotePort: 51234 }; },
    callAs: (pid) => { const port = 52000 + ports.size; ports.set(port, pid); return { remotePort: port }; }, exec: fakeExec };
}

module.exports = { world, gitInit, HOST, START, SELF, PLEX, ASAR, SERVER_ARGS, OLD_SERVER_ARGS, SERVERS };
