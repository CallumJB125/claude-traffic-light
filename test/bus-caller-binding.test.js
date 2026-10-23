'use strict';
// Caller binding for the agent bus (plan-agent-awareness step 3; findings §1
// "Binding recipe", §9.1, §9.11): who called /bus comes from the socket's peer
// process, never the request body. A Codex caller binds to a thread only as a
// stdio child of that thread's own server, in the thread's folder, with Codex's
// _meta.threadId; a Claude caller only as a stdio child of a real claude whose
// one live session it is. Negative cases: forged body fields, a model-run shell
// process, a grandchild, a detached process, a fabricated session file, a
// rewritten pid, a second claimant for one thread, /clear, headless runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const A = require('../src/agent-awareness.js');
const PeerPid = require('../src/peer-pid.js');
const { testTempDir } = require('./helpers/tmp');

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
const SERVER_ARGS = `${PLEX} ${ASAR} --profile bus`;
const SERVERS = [{ command: PLEX, args: [ASAR, '--profile', 'bus'] }, { command: PLEX, args: [ASAR] }];

// A fake process table behind /bin/ps, /usr/sbin/lsof and /usr/bin/codesign; git runs for real. It answers the
// call shapes of this branch and of the commit the review looked at (71283064), so the review's proofs of concept
// below run against both.
function world(t, { platform = 'darwin' } = {}) {
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
  const now = Date.now();
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

test('a Claude Code MCP child bound by its parent, its stdio and its own env; a Codex MCP child by its server, its stdio, its folder and Codex\'s thread id', async (t) => {
  const w = world(t);
  const aw = w.make();
  const c = await aw.bindCaller(w.call(101));
  assert.equal(c.bound, true, c.reason);
  assert.equal(c.provider, 'claude');
  assert.equal(c.key, 'claude|X');
  const x = await aw.bindCaller({ ...w.call(201), threadId: w.T });
  assert.equal(x.bound, true, x.reason);
  assert.equal(x.provider, 'codex');
  assert.equal(x.key, `codex|${w.T}`);
  // ps, lsof and codesign only by absolute path; never a PATH lookup.
  assert.ok(w.calls.every(([f]) => f === 'git' || f === '/bin/ps' || f === '/usr/sbin/lsof' || f === '/usr/bin/codesign'));
  // The log has outcomes, never an id or a folder.
  assert.ok(w.logs.some((l) => /\[awareness\] caller codex bound/.test(l)));
  assert.ok(!w.logs.some((l) => l.includes(w.T) || l.includes(w.repoA) || l.includes('X ')));
});

test('AW11: forged body fields are never identity: a detached process naming another session\'s ppid, session_id and thread is unbound', async (t) => {
  const w = world(t);
  const aw = w.make();
  // A detached `nohup` reparented to launchd (ppid 1), carrying a copy of our server's command line.
  w.proc(300, { ppid: 1, exe: '/opt/homebrew/bin/node', cwd: w.repoA, args: 'node /x/mcp-server.js --profile bus', env: 'CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_SESSION_ID=X CLAUDE_PID=100' });
  const r = await aw.bindCaller({ ...w.call(300), threadId: w.T });
  assert.equal(r.bound, false);
  assert.equal(r.reason, 'NO_PARENT');
  // Through the relay: body ppid / session_id / provider change nothing; bus_peers has no self line.
  const seen = [];
  const peers = await aw.relay('peers', { ppid: 100, session_id: 'X', provider: 'claude' }, { provider: 'claude', cwd: w.repoA }, { ...w.call(300), threadId: w.T }, { forward: async (...a) => { seen.push(a); return {}; } });
  assert.equal(peers.you, null);
  assert.equal(peers.bound, false);
  assert.ok(peers.peers.some((p) => p.provider === 'codex'), 'an unbound caller still sees peers (plan §3.1), with no self line');
  assert.ok(peers.peers.every((p) => !('branch' in p)), 'and no branch: it has no repository of its own');
  // Unbound, it is judged by the folder its process really runs in, not the one it names: $HOME is never shown peers.
  w.procs.get(300).cwd = w.home;
  assert.equal((await aw.relay('peers', {}, { provider: 'claude', cwd: w.repoA }, w.call(300), { forward: async () => ({}) })).reason, 'EXCLUDED');
  // A peer that has already gone, and a port no process holds, are unbound too.
  assert.equal((await aw.bindCaller(w.call(424242))).reason, 'NO_PARENT');
  assert.equal((await aw.bindCaller(w.call(null))).reason, 'NO_PEER');
});

test('AW11: a command the model ran through Codex\'s shell tool (a direct child, stdin /dev/null or a pty) is rejected', async (t) => {
  const w = world(t);
  const aw = w.make();
  const server = w.procs.get(200);
  // Worst case: the model runs Plexiform's exact server command line.
  const sh = w.mcpChild(202, 200, w.repoB);
  w.stdio(sh, server, 'PIPE');
  sh.fds['0'] = { type: 'CHR', addr: null, peer: null, name: '/dev/null' };
  const r = await aw.bindCaller({ ...w.call(202), threadId: w.T });
  assert.equal(r.bound, false);
  assert.equal(r.reason, 'NOT_STDIO');
  // tty mode: a pty on stdin and stdout.
  sh.fds['0'] = { type: 'CHR', addr: null, peer: null, name: '/dev/ttys009' };
  sh.fds['1'] = { type: 'CHR', addr: null, peer: null, name: '/dev/ttys009' };
  assert.equal((await aw.bindCaller({ ...w.call(202), threadId: w.T })).reason, 'NOT_STDIO');
  // Claude's Bash tool: stdin /dev/null, stdout a file. Its env still says cli and names the session (inherited).
  const claude = w.procs.get(100);
  const bash = w.mcpChild(102, 100, w.repoA, w.procs.get(101));
  bash.fds = { 0: { type: 'CHR', name: '/dev/null' }, 1: { type: 'REG', name: '/private/tmp/claude-501/tasks/x.output' } };
  assert.equal((await aw.bindCaller(w.call(102))).reason, 'NOT_STDIO');
  // stdio pipes held by some other process, not this parent.
  const other = w.proc(250, { exe: '/bin/cat' });
  const fake = w.mcpChild(203, 100, w.repoA, w.procs.get(101));
  w.stdio(fake, other, 'unix');
  assert.equal((await aw.bindCaller(w.call(203))).reason, 'NOT_STDIO');
  assert.ok(claude);
});

test('AW11: a grandchild (a server an agent started from its shell, under our own server or a shell) is rejected', async (t) => {
  const w = world(t);
  const aw = w.make();
  const parent = w.procs.get(201);
  const g = w.mcpChild(204, 201, w.repoB);
  w.stdio(g, parent, 'PIPE');
  assert.equal((await aw.bindCaller({ ...w.call(204), threadId: w.T })).reason, 'NOT_AI_CHILD');
  const zsh = w.proc(110, { ppid: 100, exe: '/bin/zsh', cwd: w.repoA });
  const g2 = w.mcpChild(111, 110, w.repoA, w.procs.get(101));
  w.stdio(g2, zsh, 'unix');
  assert.equal((await aw.bindCaller(w.call(111))).reason, 'NOT_AI_CHILD');
});

test('AW11: a fabricated session file with a detached `sleep` pid is not listed and cannot bind; a rewritten pid fails the executable check', async (t) => {
  const w = world(t);
  w.proc(400, { ppid: 1, exe: '/bin/sleep', cwd: path.join(w.home, 'Desktop') });
  const kid = w.proc(401, { ppid: 400, exe: PLEX, cwd: w.repoA, args: SERVER_ARGS, env: 'CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_SESSION_ID=fake CLAUDE_PID=400' });
  w.stdio(kid, w.procs.get(400), 'unix');
  w.state.sessions.push(w.claudeSession('fake', { claudePid: 400, cwd: w.repoA }));
  const aw = w.make();
  const roster = await aw.build();
  assert.ok(!roster.peers.some((p) => /fake/.test(JSON.stringify(p))) && roster.self['claude|fake'].verified === false, 'not listed');
  assert.equal((await aw.bindCaller(w.call(401))).reason, 'NOT_AI_CHILD');
  // X's file rewritten to name a node process: X is no longer listed, and the real claude's own child finds no session of its process.
  w.state.sessions = [w.claudeSession('X', { claudePid: 500 }), w.codexSession()];
  w.proc(500, { exe: '/opt/homebrew/bin/node', cwd: w.repoA, args: 'node /x/whatever.js' });
  const aw2 = w.make();
  assert.equal((await aw2.build()).self['claude|X'].verified, false);
  assert.equal((await aw2.bindCaller(w.call(101))).reason, 'NO_SESSION');
});

test('a session file present before this start is not bound until its next hook event', async (t) => {
  const w = world(t);
  const old = new Date(Date.now() - 3600_000).toISOString();
  w.state.sessions = [w.claudeSession('X', { updatedAt: old }), w.codexSession(w.T, { updatedAt: old, codexHookAt: old })];
  const aw = w.make();
  assert.equal((await aw.bindCaller(w.call(101))).reason, 'UNOBSERVED');
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).reason, 'UNOBSERVED');
});

test('AW13: two Codex threads on one server bind individually, each through its own MCP child; a child cannot claim the other thread', async (t) => {
  const w = world(t);
  const T2 = '019a0000-0000-7000-8000-0000000000t2';
  const server = w.procs.get(200);
  server.files.push({ file: w.rollout(T2, w.repoC) });
  const m2 = w.mcpChild(205, 200, w.repoC);
  w.stdio(m2, server, 'PIPE');
  w.state.sessions.push(w.codexSession(T2, { cwd: w.repoC }));
  const aw = w.make();
  const a = await aw.bindCaller({ ...w.call(201), threadId: w.T });
  const b = await aw.bindCaller({ ...w.call(205), threadId: T2 });
  assert.deepEqual([a.bound, a.key, b.bound, b.key], [true, `codex|${w.T}`, true, `codex|${T2}`]);
  // A forged threadId from the other thread's child: its folder is not that thread's.
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: T2 })).reason, 'CWD');
  // Same folder: the child stays pinned to the thread it first proved.
  m2.cwd = w.repoB;
  w.state.sessions = w.state.sessions.map((s) => (s.sessionId === T2 ? { ...s, cwd: w.repoB } : s));
  fs.writeFileSync(server.files[1].file, `${JSON.stringify({ type: 'session_meta', payload: { id: T2, cwd: w.repoB, source: 'vscode', thread_source: 'user', originator: 'codex-tui' } })}\n`);
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: T2 })).reason, 'THREAD_MISMATCH');
  // No thread id at all (a model call without _meta), or a thread of another server: unbound.
  assert.equal((await aw.bindCaller(w.call(201))).reason, 'NO_THREAD');
  w.state.sessions = w.state.sessions.map((s) => (s.sessionId === w.T ? { ...s, codexServerPid: 777 } : s));
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).reason, 'OTHER_SERVER');
});

test('AW13: a second live claimant for one thread leaves both unbound; when one goes, the other binds again', async (t) => {
  const w = world(t);
  const aw = w.make();
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).bound, true);
  // A second genuine MCP child for thread T (an agent's own app-server resuming it, recorded as T's server now):
  // the thread stays with server 200 while it lives (re-review N2).
  const rogue = w.proc(210, { exe: w.CODEX, cwd: w.home, signed: 'codex', files: [{ file: w.procs.get(200).files[0].file }] });
  const p2 = w.mcpChild(211, 210, w.repoB);
  w.stdio(p2, rogue, 'PIPE');
  w.state.sessions = [w.claudeSession(), w.codexSession(w.T, { codexServerPid: 210 })];
  const second = await aw.bindCaller({ ...w.call(211), threadId: w.T });
  assert.equal(second.bound, false);
  assert.equal(second.reason, 'OWNER');
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).bound, false, 'the first claimant is unbound too (the file names another server)');
  // Two children of the same server claiming one thread: both unbound as well.
  w.state.sessions = [w.claudeSession(), w.codexSession()];
  const twin = w.mcpChild(212, 200, w.repoB);
  w.stdio(twin, w.procs.get(200), 'PIPE');
  w.procs.delete(211);
  assert.equal((await aw.bindCaller({ ...w.call(212), threadId: w.T })).reason, 'CONTESTED');
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).reason, 'CONTESTED');
  // The twin exits: the original binds again.
  w.procs.delete(212);
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).bound, true);
});

test('AW13: Claude /clear: with SessionEnd the child binds to the new session; with the old file lingering it is unbound', async (t) => {
  const w = world(t);
  const aw = w.make();
  assert.equal((await aw.bindCaller(w.call(101))).key, 'claude|X', 'main saw X running in claude 100');
  // SessionEnd removed X; the new session X2 runs in the same claude process, and the MCP child still says X.
  w.state.sessions = [w.claudeSession('X2'), w.codexSession()];
  const r = await aw.bindCaller(w.call(101));
  assert.equal(r.bound, true, r.reason);
  assert.equal(r.key, 'claude|X2');
  // No SessionEnd: X lingers beside X2, both naming claude 100.
  w.state.sessions = [w.claudeSession('X'), w.claudeSession('X2'), w.codexSession()];
  assert.equal((await aw.bindCaller(w.call(101))).reason, 'TIE');
  // A child whose own id was never a session of this claude process is not bound to it.
  w.state.sessions = [w.claudeSession('X2'), w.codexSession()];
  w.procs.get(101).env = w.procs.get(101).env.replace('SESSION_ID=X', 'SESSION_ID=Z');
  assert.equal((await aw.bindCaller(w.call(101))).reason, 'ID_MISMATCH');
});

test('headless callers are never bound: claude -p (sdk-cli), a codex exec thread', async (t) => {
  const w = world(t);
  w.procs.get(101).env = w.procs.get(101).env.replace('ENTRYPOINT=cli', 'ENTRYPOINT=sdk-cli');
  w.state.sessions = [w.claudeSession(), w.codexSession(w.T, { codexInteractive: false })];
  const aw = w.make();
  assert.equal((await aw.bindCaller(w.call(101))).reason, 'HEADLESS');
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).reason, 'HEADLESS');
  // An env value with spaces that smuggles a second CLAUDE_CODE_ENTRYPOINT: ambiguous, so not interactive.
  w.procs.get(101).env = w.procs.get(101).env.replace('ENTRYPOINT=sdk-cli', 'ENTRYPOINT=cli FOO=x CLAUDE_CODE_ENTRYPOINT=cli');
  assert.equal((await aw.bindCaller(w.call(101))).reason, 'HEADLESS');
});

test('the declared provider is replaced by the bound caller\'s; an unbound caller keeps what it declared (hand-offs are unchanged)', async (t) => {
  const w = world(t);
  const aw = w.make();
  const seen = [];
  const forward = async (op, args, caller) => { seen.push({ op, caller }); return { ok: true }; };
  await aw.relay('handoff', { title: 'x' }, { provider: 'claude', cwd: w.repoB }, { ...w.call(201), threadId: w.T }, { forward });
  await aw.relay('hello', {}, { provider: 'codex', cwd: w.repoA }, w.call(101), { forward });
  await aw.relay('handoff', { title: 'x' }, { provider: 'codex', cwd: w.repoA }, w.call(424242), { forward });
  await aw.relay('status', {}, { provider: 'gemini', cwd: w.repoA }, w.call(101), { forward });
  assert.deepEqual(seen.map((s) => s.caller.provider), ['codex', 'claude', 'codex', 'gemini']);
});

test('bus_session binds a Codex thread at start and reports it; excluded, off and unbound callers learn nothing', async (t) => {
  const w = world(t);
  const aw = w.make();
  let hooks = 0;
  const opts = { forward: async () => ({}), onCodexSession: async () => { hooks += 1; } };
  const r = await aw.relay('session', {}, {}, { ...w.call(201), threadId: w.T, hook: true }, opts);
  assert.equal(r.bound, true);
  assert.match(r.handle, /^codex-site-[0-9a-f]{4}$/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hooks, 1);
  assert.equal((await aw.relay('session', {}, {}, w.call(101), opts)).bound, true);
  assert.equal(hooks, 1, 'only a Codex session counts as the Codex hook running');
  assert.deepEqual(await aw.relay('session', {}, {}, w.call(424242), opts), { bound: false });
  // Excluded folder: not even "bound".
  w.state.config = { agentBus: { exclude: [w.repoB] } };
  assert.deepEqual(await aw.relay('session', {}, {}, { ...w.call(201), threadId: w.T }, opts), { bound: false });
  // A SessionStart hook can run before Plexiform has the thread's file: retried briefly.
  w.state.config = {};
  w.state.sessions = [w.claudeSession()];
  const later = aw.relay('session', {}, {}, { ...w.call(201), threadId: w.T }, opts);
  setTimeout(() => { w.state.sessions = [w.claudeSession(), w.codexSession()]; }, 2);
  assert.equal((await later).bound, true);
});

test('not macOS: every caller is unbound (Linux and Windows peer lookup are follow-ups)', async (t) => {
  const w = world(t, { platform: 'linux' });
  const aw = w.make();
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).reason, 'UNSUPPORTED');
});

test('peer-pid parsing: exactly one other pid; pipe and socketpair ends matched by kernel address both ways', () => {
  assert.equal(PeerPid.parsePeer(`p12\nf5\np${SELF}\nf9\n`, SELF), 12);
  assert.equal(PeerPid.parsePeer(`p12\np13\np${SELF}\n`, SELF), null, 'two other processes on one socket: ambiguous');
  assert.equal(PeerPid.parsePeer(`p${SELF}\n`, SELF), null);
  // The shape findings §1 recorded for ChatGPT.app's MCP child and its app-server.
  const child = PeerPid.parseFds('p19503\nf0\ntPIPE\nd0x579c\nn->0x86e4\nf1\ntPIPE\nd0x8d17\nn->0x5718\nfcwd\ntDIR\nn/Users/u/code\n');
  const server = PeerPid.parseFds('p1378\nf37\ntPIPE\nd0x86e4\nn->0x579c\nf62\ntPIPE\nd0x5718\nn->0x8d17\nf3\ntREG\nn/x\n');
  assert.equal(PeerPid.stdioPeered(child, server), true);
  assert.equal(child.cwd.name, '/Users/u/code');
  // One end held by someone else, or the ends the wrong way round: not peered.
  assert.equal(PeerPid.stdioPeered(child, PeerPid.parseFds('p1\nf37\ntPIPE\nd0x86e4\nn->0x579c\n')), false);
  assert.equal(PeerPid.stdioPeered(child, PeerPid.parseFds('p1\nf37\ntPIPE\nd0x579c\nn->0x86e4\nf62\ntPIPE\nd0x8d17\nn->0x5718\n')), false);
  assert.equal(PeerPid.stdioPeered(PeerPid.parseFds('p1\nf0\ntCHR\nn/dev/null\nf1\ntPIPE\nd0x8d17\nn->0x5718\n'), server), false);
  assert.deepEqual(PeerPid.parsePs('  45121 Thu Oct 22 20:21:46 2026    \n'), { ppid: 45121, start: 'Thu Oct 22 20:21:46 2026' });
  assert.equal(PeerPid.envValue('node x A=1 CLAUDE_CODE_SESSION_ID=abc B=2', 'CLAUDE_CODE_SESSION_ID', /^\w+$/), 'abc');
  assert.equal(PeerPid.envValue('node x CLAUDE_CODE_SESSION_ID=abc FOO=a CLAUDE_CODE_SESSION_ID=def', 'CLAUDE_CODE_SESSION_ID', /^\w+$/), null);
  assert.equal(PeerPid.envValue('node x XCLAUDE_CODE_SESSION_ID=abc', 'CLAUDE_CODE_SESSION_ID', /^\w+$/), null);
});

// AW1 end to end: the real signal server and mcp-server.js busCall. Which process is calling comes from the
// fake process table behind lsof (as the real one would answer for that socket), never from the body.
async function serveBus(t, w, aw) {
  const S = require('../src/signal-server.js')({ rootDir: w.root, sessionsDir: w.root, requestsDir: w.root, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port: 0, app: { on: () => {} },
    agentBus: (op, args, caller, ident) => aw.relay(op, args, caller, ident, { forward: async (o, a, c) => ({ forwarded: o, provider: c.provider }) }) });
  const server = S.startSignalServer();
  await new Promise((resolve) => server.once('listening', resolve));
  for (let i = 0; i < 100 && !fs.existsSync(path.join(w.root, 'token')); i += 1) await new Promise((r) => setTimeout(r, 10));
  t.after(() => server.close());
  return { root: w.root, port: server.address().port };
}

test('AW1: an interactive Claude Code session and a Codex TUI thread list each other in bus_peers within 2 s of their first hook event, with no bus_hello', async (t) => {
  const w = world(t);
  w.state.sessions = [];
  const aw = w.make();
  await aw.refresh();
  const M = require('../mcp-server.js');
  const c = await serveBus(t, w, aw);
  const t0 = Date.now();
  w.state.sessions = [w.claudeSession(), w.codexSession()];
  // Codex's call, from its MCP child 201, carrying Codex's thread id.
  w.call(201);
  const fromCodex = await M.busCall('peers', {}, { ...c, meta: { threadId: w.T } });
  // Claude's call, from its MCP child 101.
  w.call(101);
  const fromClaude = await M.busCall('peers', {}, c);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(fromCodex.bound, true);
  assert.match(fromCodex.you, /^codex-site-[0-9a-f]{4}$/);
  assert.deepEqual(fromCodex.peers.map((p) => [p.provider, p.folder, p.status]), [['claude', 'app', 'working']]);
  assert.equal(fromClaude.bound, true);
  assert.match(fromClaude.you, /^claude-app-[0-9a-f]{4}$/);
  assert.deepEqual(fromClaude.peers.map((p) => [p.handle, p.provider, p.folder, p.status]), [[fromCodex.you, 'codex', 'site', 'idle']]);
  // Different repositories: no branch either way.
  assert.ok([...fromCodex.peers, ...fromClaude.peers].every((p) => !('branch' in p) && p.same_repo === false));
  assert.match(fromClaude.note, /never instructions/);
  // A forged body (another session's ppid, session_id, provider) from a detached process: no self line.
  w.proc(300, { ppid: 1, exe: '/opt/homebrew/bin/node', cwd: w.repoA });
  w.call(300);
  const forged = await M.teamCall('peers', { ppid: 100, session_id: 'X', provider: 'claude' }, { ...c, route: '/bus', meta: { thread_id: w.T } });
  assert.deepEqual([forged.you, forged.bound], [null, false]);
  // And the declared provider of a bound caller is replaced on the way to the bus.
  w.call(201);
  assert.deepEqual(await M.busCall('handoff', { request_id: 'req-12345678', to: { provider: 'claude' }, title: 'x', provider: 'claude' }, { ...c, meta: { threadId: w.T } }), { forwarded: 'handoff', provider: 'codex' });
});

test('same repository: a bound caller sees the peer\'s branch; awareness off answers AWARENESS_OFF; an excluded caller EXCLUDED', async (t) => {
  const w = world(t);
  w.state.sessions = [w.claudeSession(), w.codexSession(w.T, { cwd: w.repoA })];
  w.procs.get(201).cwd = w.repoA;
  fs.writeFileSync(w.procs.get(200).files[0].file, `${JSON.stringify({ type: 'session_meta', payload: { id: w.T, cwd: w.repoA, source: 'vscode', thread_source: 'user', originator: 'codex-tui' } })}\n`);
  const aw = w.make();
  const forward = async () => ({});
  const r = await aw.relay('peers', {}, {}, w.call(101), { forward });
  assert.deepEqual(r.peers.map((p) => [p.provider, p.branch, p.same_repo]), [['codex', 'main', true]]);
  w.state.config = { agentAwareness: { enabled: false } };
  assert.equal((await aw.relay('peers', {}, {}, w.call(101), { forward })).reason, 'AWARENESS_OFF');
  w.state.config = { agentBus: { exclude: [w.repoA] } };
  assert.equal((await aw.relay('peers', {}, {}, w.call(101), { forward })).reason, 'EXCLUDED');
});

test('roster caps.mcp follows the registered bus tools per provider (the hook\'s Tools line)', async (t) => {
  const w = world(t);
  let caps = { claude: true, codex: false };
  const aw = w.make({ mcpCaps: () => caps });
  let r = await aw.build();
  assert.deepEqual([r.self['claude|X'].caps.mcp, r.self[`codex|${w.T}`].caps.mcp], [true, false]);
  caps = { claude: true, codex: true };
  r = await aw.build();
  assert.equal(r.self[`codex|${w.T}`].caps.mcp, true);
  assert.equal(r.self['claude|X'].caps.notes, false, 'no notes before step 4');
  const broken = w.make({ mcpCaps: () => { throw new Error('x'); } });
  assert.equal((await broken.build()).self['claude|X'].caps.mcp, false);
});

// ── PR #34 security review: each proof of concept as a regression ───────────

// A stream end of `child` on fd whose other end `parent` holds; `same` reuses an end the child already has (a dup).
const end = (child, fd, parent, addr, type = 'PIPE') => {
  child.fds[fd] = { type, addr, peer: `${addr}0` };
  parent.fds[`9${addr.slice(-3)}`] = { type, addr: `${addr}0`, peer: addr };
};

test('review #1 (PoC A): a node process whose command line merely names claude-code\'s cli.js is not Claude: never listed, its child never bound', async (t) => {
  const w = world(t);
  const fake = w.proc(600, { exe: '/opt/homebrew/bin/node', cwd: w.repoA, args: 'node -e spawn() /nope/node_modules/@anthropic-ai/claude-code/cli.js' });
  const kid = w.mcpChild(601, 600, w.repoA, w.procs.get(101));
  kid.env = kid.env.replace('SESSION_ID=X', 'SESSION_ID=forged-claude-1').replace('CLAUDE_PID=100', 'CLAUDE_PID=600');
  w.stdio(kid, fake, 'unix');
  w.state.sessions.push(w.claudeSession('forged-claude-1', { claudePid: 600 }));
  const aw = w.make();
  const r = await aw.bindCaller(w.call(601));
  assert.deepEqual([r.bound, r.reason], [false, 'NOT_AI_CHILD']);
  assert.equal((await aw.build()).self['claude|forged-claude-1'].verified, false);
});

test('review #1 (PoC B): an unsigned binary at an allow-listed path (a clone of node as node_modules/@openai/codex/codex, or under ~/.local/share/claude) is neither Codex nor Claude', async (t) => {
  const w = world(t);
  const T2 = '019a0000-0000-7000-8000-00000000beef';
  const fakeCodex = w.proc(610, { exe: path.join(w.dir, 'x/node_modules/@openai/codex/codex'), cwd: w.home, files: [{ file: w.rollout(T2, w.repoC) }] });
  const kid = w.mcpChild(611, 610, w.repoC);
  w.stdio(kid, fakeCodex, 'PIPE');
  w.state.sessions.push(w.codexSession(T2, { cwd: w.repoC, codexServerPid: 610 }));
  // A node clone at Claude's own install path, with a forged session file naming it.
  const fakeClaude = w.proc(620, { exe: path.join(w.home, '.local/share/claude/versions/9.9.9'), cwd: w.repoC });
  const kid2 = w.mcpChild(621, 620, w.repoC, w.procs.get(101));
  kid2.env = kid2.env.replace('SESSION_ID=X', 'SESSION_ID=forged-2').replace('CLAUDE_PID=100', 'CLAUDE_PID=620');
  w.stdio(kid2, fakeClaude, 'unix');
  w.state.sessions.push(w.claudeSession('forged-2', { claudePid: 620, cwd: w.repoC }));
  const aw = w.make();
  assert.equal((await aw.bindCaller({ ...w.call(611), threadId: T2 })).reason, 'NOT_AI_CHILD');
  assert.equal((await aw.bindCaller(w.call(621))).reason, 'NOT_AI_CHILD');
  const roster = await aw.build();
  assert.deepEqual([roster.self[`codex|${T2}`].verified, roster.self['claude|forged-2'].verified], [false, false]);
  assert.equal(roster.peers.length, 2, 'only the two real sessions are listed');
  // The signature is checked on the running process, by pid, with each maker's requirement.
  const asked = w.calls.filter(([f]) => f === '/usr/bin/codesign');
  assert.ok(asked.some((c) => c.includes('-R=' + PeerPid.REQUIREMENT.codex) && c[c.length - 1] === '200'));
  assert.ok(asked.some((c) => c.includes('-R=' + PeerPid.REQUIREMENT.claude) && c[c.length - 1] === '100'));
  // PRIVACY.md no longer claims more than this proves.
  const privacy = fs.readFileSync(path.join(__dirname, '..', 'PRIVACY.md'), 'utf8');
  assert.ok(!privacy.includes('A program an AI started from its shell fails those checks'));
  assert.ok(!privacy.includes('it cannot make Plexiform list a session no real Claude Code or Codex program is running'));
});

test('review #1: Claude Code\'s signed binary run with BUN_OPTIONS (a preload) is not trusted as Claude', async (t) => {
  const w = world(t);
  w.procs.get(100).env = 'HOME=/x BUN_OPTIONS=--preload=/tmp/evil.js';
  const aw = w.make();
  assert.equal((await aw.bindCaller(w.call(101))).reason, 'NOT_AI_CHILD');
  assert.equal((await aw.build()).self['claude|X'].verified, false);
});

test('review #2: a command the model ran as a direct child of the shared Codex server, claiming another thread, is unbound (stdin a copy of its stdout, a look-alike command line, injected NODE_OPTIONS)', async (t) => {
  const w = world(t);
  const server = w.procs.get(200);
  // Thread B on the same daemon, its rollout held open by that daemon, in repoC. Its id is in file names: not secret.
  const B = '019a0000-0000-7000-8000-0000000000bb';
  server.files.push({ file: w.rollout(B, w.repoC) });
  w.state.sessions.push(w.codexSession(B, { cwd: w.repoC }));
  // From thread A: `cd <B's cwd> && exec 0<&1 node -e '<POST /bus op=session meta.thread_id=B>' mcp-server.js`.
  const atk = w.proc(250, { ppid: 200, exe: '/opt/homebrew/bin/node', cwd: w.repoC, args: '/opt/homebrew/bin/node -e post() mcp-server.js', env: 'PATH=/usr/bin:/bin' });
  end(atk, '1', server, '0xa01');
  end(atk, '2', server, '0xa02');
  atk.fds['0'] = { ...atk.fds['1'] };
  const aw = w.make();
  const r = await aw.bindCaller({ ...w.call(250), threadId: B });
  assert.equal(r.bound, false);
  assert.equal(r.reason, 'NOT_OUR_SERVER');
  // The same with Plexiform's exact command line: fd 0 is the same end as fd 1.
  atk.exe = PLEX;
  atk.args = SERVER_ARGS;
  assert.equal((await aw.bindCaller({ ...w.call(250), threadId: B })).reason, 'NOT_STDIO');
  assert.equal(PeerPid.stdioPeered(atk.fds, server.fds), false);
  // ... or a copy of stderr's end on fd 0 while stderr stays open.
  atk.fds['0'] = { ...atk.fds['2'] };
  assert.equal((await aw.bindCaller({ ...w.call(250), threadId: B })).reason, 'NOT_STDIO');
  // A genuine-looking stdio child whose environment loads other code into our program (--require, --inspect).
  const inj = w.mcpChild(251, 200, w.repoC);
  w.stdio(inj, server, 'PIPE');
  inj.env = `${inj.env} NODE_OPTIONS=--require=/tmp/x.js`;
  assert.equal((await aw.bindCaller({ ...w.call(251), threadId: B })).reason, 'INJECTED');
  inj.env = inj.env.replace('NODE_OPTIONS=--require=/tmp/x.js', 'DYLD_INSERT_LIBRARIES=/tmp/x.dylib');
  assert.equal((await aw.bindCaller({ ...w.call(251), threadId: B })).reason, 'INJECTED');
  // Without any of that, B's own child binds, and the earlier attempts left no pin behind to contest it.
  inj.env = w.procs.get(201).env;
  const ok = await aw.bindCaller({ ...w.call(251), threadId: B });
  assert.equal(ok.bound, true, ok.reason);
  // Codex's children are pipes; a socketpair there (some other channel to the daemon) is not what Codex makes.
  const sock = w.mcpChild(252, 200, w.repoC);
  w.stdio(sock, server, 'unix');
  assert.equal((await aw.bindCaller({ ...w.call(252), threadId: B })).reason, 'NOT_STDIO');
});

test('review #2: the command line must be exactly a registered launch; a dev launch is found on PATH', async (t) => {
  const w = world(t);
  const kid = w.procs.get(201);
  for (const args of [`${SERVER_ARGS} --extra`, `${PLEX} /tmp/mcp-server.js --profile bus`, `${PLEX} -e x ${ASAR} --profile bus`]) {
    kid.args = args;
    assert.equal((await w.make().bindCaller({ ...w.call(201), threadId: w.T })).reason, 'NOT_OUR_SERVER', args);
  }
  kid.args = SERVER_ARGS;
  kid.exe = '/opt/homebrew/bin/node';
  assert.equal((await w.make().bindCaller({ ...w.call(201), threadId: w.T })).reason, 'NOT_OUR_SERVER', 'another executable');
  // Dev: `node <dir>/mcp-server.js --profile bus`, node resolved on main's PATH.
  const bin = path.join(w.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '', { mode: 0o755 });
  kid.exe = path.join(bin, 'node');
  kid.args = 'node /repo/mcp-server.js --profile bus';
  const dev = w.make({ servers: () => [{ command: 'node', args: ['/repo/mcp-server.js', '--profile', 'bus'] }], envPath: `/nonexistent${path.delimiter}${bin}` });
  assert.equal((await dev.bindCaller({ ...w.call(201), threadId: w.T })).bound, true);
  // A registered path with a space in it could be split another way: never matched.
  const spaced = w.make({ servers: () => [{ command: PLEX, args: ['/Users/u/Application Support/mcp-server.js'] }] });
  kid.exe = PLEX;
  kid.args = `${PLEX} /Users/u/Application Support/mcp-server.js`;
  assert.equal((await spaced.bindCaller({ ...w.call(201), threadId: w.T })).reason, 'NOT_OUR_SERVER');
});

test('review #3: a signed claude in ~ (hooks off) cannot claim a repository session; a rewritten session file cannot move a live session; an id with no file is not this session', async (t) => {
  const w = world(t);
  const aw = w.make();
  await aw.build(); // main has seen X running in claude 100
  // A second, genuine claude started in ~ with hooks off, its --mcp-config naming our server.
  const homeClaude = w.proc(700, { exe: w.CLAUDE, cwd: w.home, signed: 'claude', args: 'claude --setting-sources' });
  const kid = w.mcpChild(701, 700, w.home, w.procs.get(101));
  kid.env = kid.env.replace('SESSION_ID=X', 'SESSION_ID=Y').replace('CLAUDE_PID=100', 'CLAUDE_PID=700');
  w.stdio(kid, homeClaude, 'unix');
  // X's session file rewritten to name it.
  w.state.sessions = [w.claudeSession('X', { claudePid: 700 }), w.codexSession()];
  assert.equal((await aw.bindCaller(w.call(701))).reason, 'CWD');
  assert.equal((await aw.build()).self['claude|X'].verified, false);
  // The same from a signed claude inside the repository: X still belongs to claude 100, which lives.
  homeClaude.cwd = w.repoA;
  kid.cwd = w.repoA;
  const aw2 = w.make();
  w.state.sessions = [w.claudeSession('X'), w.codexSession()];
  await aw2.build();
  w.state.sessions = [w.claudeSession('X', { claudePid: 700 }), w.codexSession()];
  assert.equal((await aw2.bindCaller(w.call(701))).reason, 'OWNER');
  assert.equal((await aw2.build()).self['claude|X'].verified, false);
  // Once claude 100 is gone the session may move (a resumed session in a new process).
  w.procs.delete(100);
  kid.env = kid.env.replace('SESSION_ID=Y', 'SESSION_ID=X');
  assert.equal((await aw2.bindCaller(w.call(701))).bound, true);
  // A fabricated session S naming that claude, while its child carries its own id Y, which has no file: not S.
  w.state.sessions = [w.claudeSession('S', { claudePid: 700 }), w.codexSession()];
  kid.env = kid.env.replace('SESSION_ID=X', 'SESSION_ID=Y');
  assert.equal((await w.make().bindCaller(w.call(701))).reason, 'ID_MISMATCH');
});

test('review #6: a caller\'s environment is read only after the parent, program and stdio checks pass, and only three names leave the reader', async (t) => {
  const w = world(t);
  const aw = w.make();
  const envReads = (pid) => w.calls.filter((c) => c[0] === '/bin/ps' && c.includes('eww') && c[c.length - 1] === String(pid)).length;
  w.proc(300, { ppid: 1, exe: '/opt/homebrew/bin/node', cwd: w.repoA, args: 'node x', env: 'SECRET_TOKEN=abc' });
  assert.equal((await aw.bindCaller(w.call(300))).reason, 'NO_PARENT');
  const g = w.mcpChild(204, 201, w.repoB);
  w.stdio(g, w.procs.get(201), 'PIPE');
  assert.equal((await aw.bindCaller(w.call(204))).reason, 'NOT_AI_CHILD');
  const other = w.proc(205, { ppid: 200, exe: '/opt/homebrew/bin/node', cwd: w.repoB, args: 'node other.js', env: 'SECRET_TOKEN=abc' });
  w.stdio(other, w.procs.get(200), 'PIPE');
  assert.equal((await aw.bindCaller(w.call(205))).reason, 'NOT_OUR_SERVER');
  const sh = w.mcpChild(206, 200, w.repoB);
  sh.fds = { 0: { type: 'CHR', name: '/dev/null' } };
  assert.equal((await aw.bindCaller(w.call(206))).reason, 'NOT_STDIO');
  assert.deepEqual([300, 204, 205, 206].map(envReads), [0, 0, 0, 0]);
  // The parser keeps the named variables and a yes/no for injection, nothing else; argv never counts as env.
  const e = PeerPid.parseEnv('node x CLAUDE_CODE_ENTRYPOINT=cli', 'node x CLAUDE_CODE_ENTRYPOINT=cli SECRET_TOKEN=abc CLAUDE_PID=7', ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID']);
  assert.deepEqual(e, { args: 'node x CLAUDE_CODE_ENTRYPOINT=cli', vars: { CLAUDE_CODE_ENTRYPOINT: null, CLAUDE_PID: '7' }, injected: false });
  assert.equal(PeerPid.parseEnv('a', 'b X=1', []), null, 'an environment that does not follow the command line is not read');
});

test('review #7: at most four callers are checked at once, a repeat within 2 s is answered from cache, and the server is listed once per check', async (t) => {
  const w = world(t);
  const aw = w.make({ bindCacheMs: 2000 });
  const before = w.calls.length;
  const rs = await Promise.all(Array.from({ length: 20 }, () => aw.bindCaller({ ...w.call(201), threadId: w.T })));
  assert.ok(rs.every((r) => r.bound));
  const serverLsof = w.calls.slice(before).filter((c) => c[0] === '/usr/sbin/lsof' && c[c.indexOf('-p') + 1] === '200');
  assert.ok(serverLsof.length <= 2, `${serverLsof.length} lsof runs of the server for 20 calls`);
  // One check lists the server once: its stdio ends and its open files come from the same listing.
  const once = w.make();
  const mark = w.calls.length;
  assert.equal((await once.bindCaller({ ...w.call(201), threadId: w.T })).bound, true);
  // (The executable and folder lookup, `-d txt,cwd`, is cached per process; the full listing is the costly one.)
  assert.equal(w.calls.slice(mark).filter((c) => c[0] === '/usr/sbin/lsof' && c[c.indexOf('-p') + 1] === '200' && !c.includes('-d')).length, 1);
  // Ten different children at once: never more than four checked together.
  const w2 = world(t);
  const kids = [];
  for (let i = 0; i < 10; i += 1) { const k = w2.mcpChild(800 + i, 200, w2.repoB); w2.stdio(k, w2.procs.get(200), 'PIPE'); kids.push(800 + i); }
  let inFlight = 0;
  let peak = 0;
  const slow = (file, args, opts, cb) => {
    const p = args.indexOf('-p') >= 0 ? Number(args[args.indexOf('-p') + 1]) : null;
    const hit = file === '/usr/sbin/lsof' && kids.includes(p) && !args.includes('-d');
    if (hit) { inFlight += 1; peak = Math.max(peak, inFlight); }
    setTimeout(() => w2.exec(file, args, opts, (...r) => { if (hit) inFlight -= 1; cb(...r); }), 10);
  };
  const aw2 = w2.make({ execFile: slow });
  await Promise.all(kids.map((pid) => aw2.bindCaller({ ...w2.callAs(pid), threadId: w2.T })));
  assert.ok(peak >= 1 && peak <= 4, `peak ${peak}`);
});

test('review #8: a headless Claude session never binds, whatever its child\'s environment says', async (t) => {
  const w = world(t);
  w.state.sessions = [w.claudeSession('X', { interactive: false }), w.codexSession()];
  assert.equal((await w.make().bindCaller(w.call(101))).reason, 'HEADLESS');
  // An env value with spaces that smuggles a second CLAUDE_CODE_ENTRYPOINT: ambiguous, so not interactive.
  w.state.sessions = [w.claudeSession(), w.codexSession()];
  w.procs.get(101).env = w.procs.get(101).env.replace('CLAUDE_CODE_ENTRYPOINT=cli', 'CLAUDE_CODE_ENTRYPOINT=sdk-cli');
  w.procs.get(101).args = `${SERVER_ARGS} CLAUDE_CODE_ENTRYPOINT=cli`;
  assert.notEqual((await w.make().bindCaller(w.call(101))).bound, true, 'a variable on the command line is not the environment');
});

test('review #9: an unbound caller with no folder of its own (it forked away after connecting) gets EXCLUDED, never the folder it named', async (t) => {
  const w = world(t);
  const aw = w.make();
  const r = await aw.relay('peers', {}, { provider: 'claude', cwd: w.repoA }, w.call(null), { forward: async () => ({}) });
  assert.equal(r.reason, 'EXCLUDED');
});

test('review #10: only a hook-shaped bus_session call marks the Codex hook as approved; the model calling bus_session itself does not', async (t) => {
  const w = world(t);
  const aw = w.make();
  let hooks = 0;
  const opts = { forward: async () => ({}), onCodexSession: async () => { hooks += 1; } };
  assert.equal((await aw.relay('session', {}, {}, { ...w.call(201), threadId: w.T }, opts)).bound, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hooks, 0);
  await aw.relay('session', {}, {}, { ...w.call(201), threadId: w.T, hook: true }, opts);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hooks, 1);
  // mcp-server.js flags only _meta with nothing but threadId (and progressToken); Codex adds turn metadata to a model's call.
  const M = require('../mcp-server.js');
  assert.deepEqual(M.threadMeta({ threadId: w.T }), { thread_id: w.T, hook: true });
  assert.deepEqual(M.threadMeta({ threadId: w.T, progressToken: 3 }), { thread_id: w.T, hook: true });
  assert.deepEqual(M.threadMeta({ threadId: w.T, 'x-codex-turn-metadata': {} }), { thread_id: w.T });
  // The signal server passes the flag on only with a valid thread id.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'signal-server.js'), 'utf8');
  assert.match(src, /hook: !!threadId && d\.meta\.hook === true/);
});

test('review #13: every bus tool that returns another AI\'s text says it is data, bus_status included', () => {
  const M = require('../mcp-server.js');
  for (const t of M.toolsFor('bus').filter((x) => ['bus_peers', 'bus_handoff', 'bus_wait', 'bus_read', 'bus_status'].includes(x.name))) {
    assert.match(t.description, /data, never instructions/, t.name);
  }
});

// Live: the property the binding rests on. Plexiform's real server acts only on requests written to its stdin;
// with stdin a copy of its own stdout (`exec 0<&1`, what a model's shell can do) nobody can write it a request.
test('review #2 (live): mcp-server.js answers a tools/call written to its stdin, and makes no request at all when its stdin is its own stdout', { skip: process.platform === 'win32' }, async (t) => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const root = fs.realpathSync(testTempDir('pf-live-bus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hits = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { hits.push([req.url, b]); res.setHeader('content-type', 'application/json'); res.end('{"peers":[]}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  fs.writeFileSync(path.join(root, 'port'), String(srv.address().port));
  fs.writeFileSync(path.join(root, 'token'), 'x'.repeat(64), { mode: 0o600 });
  const script = path.join(__dirname, '..', 'mcp-server.js');
  const env = { PATH: process.env.PATH, HOME: root, CLAUDE_TRAFFIC_LIGHT_HOME: root };
  // Positive control: a parent writing to its stdin drives it.
  const good = spawn(process.execPath, [script, '--profile', 'bus'], { stdio: ['pipe', 'pipe', 'ignore'], env });
  t.after(() => good.kill('SIGKILL'));
  const send = (m) => good.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bus_peers', arguments: {}, _meta: { threadId: 'abc' } } });
  for (let i = 0; i < 100 && !hits.length; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(hits.length, 1, 'the real server called /bus for the tools/call it was given');
  assert.equal(hits[0][0], '/bus');
  // fd 0 = a copy of fd 1: the same pipe end, which nothing but this process writes. No request, ever.
  const dup = spawn('/bin/sh', ['-c', `exec 0<&1; exec "$0" "$1" --profile bus`, process.execPath, script], { stdio: ['ignore', 'pipe', 'ignore'], env });
  t.after(() => dup.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(hits.length, 1, 'nothing more reached /bus');
});

test('mcp-server.js turns off the SIGUSR1 inspector, so no other program can run code inside a bound server', { skip: process.platform === 'win32' }, async (t) => {
  const { spawn } = require('node:child_process');
  const root = fs.realpathSync(testTempDir('pf-usr1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kid = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'), '--profile', 'bus'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: root, CLAUDE_TRAFFIC_LIGHT_HOME: root } });
  t.after(() => kid.kill('SIGKILL'));
  let err = '';
  kid.stderr.on('data', (d) => { err += d; });
  kid.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
  await new Promise((resolve) => kid.stdout.once('data', resolve));
  kid.kill('SIGUSR1');
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(!/Debugger listening/.test(err), 'no inspector started');
  assert.equal(kid.exitCode, null, 'and the server is still running');
});

// ── Re-review of 03247408 (N1-N5) ────────────────────────────────────────────

test('re-review N1: the server launch Plexiform registers turns SIGUSR1 off, and the exact command line it makes is the one that binds', async (t) => {
  const McpInstall = require('../mcp-install.js');
  const appPath = '/Applications/Plexiform.app/Contents/Resources/app.asar';
  const packaged = { packaged: true, execPath: PLEX, appPath };
  for (const l of [McpInstall.launch({ ...packaged, profile: 'bus' }), McpInstall.launch(packaged), McpInstall.launch({ packaged: false, dir: '/repo', profile: 'bus' }), McpInstall.launch({ packaged: false, dir: '/repo' })]) {
    assert.equal(l.args[0], '--disable-sigusr1', 'a node option, before the script');
    assert.ok(l.args.slice(1).every((a) => a !== '--disable-sigusr1'));
  }
  const w = world(t);
  const launches = [McpInstall.launch({ ...packaged, profile: 'bus' }), McpInstall.launch(packaged)];
  const aw = w.make({ servers: () => launches });
  const line = (l) => [l.command, ...l.args].join(' ');
  w.procs.get(201).args = line(launches[0]);
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).bound, true, 'ps shows the registered launch: bound');
  // A child started the old way, without the option (a stale registration or a model's own command), is not ours.
  w.procs.get(201).args = SERVER_ARGS;
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).reason, 'NOT_OUR_SERVER');
});

test('re-review N1: a server child that listens on a TCP port (an inspector) is refused', async (t) => {
  const w = world(t);
  const aw = w.make();
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).bound, true);
  w.procs.get(201).fds['23'] = { type: 'IPv4', addr: null, peer: null, name: '127.0.0.1:9229' };
  const r = await aw.bindCaller({ ...w.call(201), threadId: w.T });
  assert.equal(r.bound, false);
  assert.equal(r.reason, 'LISTENING');
  // Its own connection out to main (a remote end) is fine.
  w.procs.get(201).fds['23'] = { type: 'IPv4', addr: null, peer: null, name: '127.0.0.1:52011->127.0.0.1:47001' };
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).bound, true);
  assert.equal(PeerPid.listening({ 9: { type: 'IPv6', name: '[::1]:9229' } }), true);
  assert.equal(PeerPid.listening({ 9: { type: 'unix', name: '->0x1' } }), false);
});

test('re-review N1: the packaged app is built with Node\'s inspect options and SIGUSR1 inspector off, and still runs as node', () => {
  const cfg = require('../electron-builder.config.js');
  assert.equal(cfg.electronFuses && cfg.electronFuses.enableNodeCliInspectArguments, false);
  assert.notEqual(cfg.electronFuses.runAsNode, false, 'the hooks and the bus server need ELECTRON_RUN_AS_NODE');
});

test('re-review N1 (live): started as Plexiform registers it, an early SIGUSR1 never starts an inspector', { skip: process.platform === 'win32' }, async (t) => {
  const { spawn } = require('node:child_process');
  const McpInstall = require('../mcp-install.js');
  const root = fs.realpathSync(testTempDir('pf-usr1-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const l = McpInstall.launch({ packaged: false, dir: path.join(__dirname, '..'), profile: 'bus' });
  let hits = 0;
  for (const delay of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 10, 20, 30, 40]) {
    const kid = spawn(process.execPath, l.args, { stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: process.env.PATH, HOME: root, CLAUDE_TRAFFIC_LIGHT_HOME: root } });
    let err = '';
    kid.stderr.on('data', (d) => { err += d; });
    await new Promise((r) => setTimeout(r, delay));
    try { kid.kill('SIGUSR1'); } catch {}
    await new Promise((r) => setTimeout(r, 250));
    kid.kill('SIGKILL');
    if (/Debugger listening/.test(err)) hits += 1;
  }
  assert.equal(hits, 0, `${hits} inspectors started`);
});

test('re-review N2: a Codex thread stays with the first server seen running it; a rewritten file naming another live server is refused', async (t) => {
  const w = world(t);
  const aw = w.make();
  // Main has seen thread T on server 200 (its roster build), before T's own MCP child has bound.
  assert.equal((await aw.build()).self[`codex|${w.T}`].verified, true);
  // Another signed codex app-server that resumed T (so it holds T's rollout open), and T's file rewritten to name it.
  const rogue = w.proc(210, { exe: w.CODEX, cwd: w.home, signed: 'codex', args: `${w.CODEX} app-server`, files: [{ file: w.procs.get(200).files[0].file }] });
  const kid = w.mcpChild(211, 210, w.repoB);
  w.stdio(kid, rogue, 'PIPE');
  w.state.sessions = [w.claudeSession(), w.codexSession(w.T, { codexServerPid: 210 })];
  const r = await aw.bindCaller({ ...w.call(211), threadId: w.T });
  assert.equal(r.bound, false);
  assert.equal(r.reason, 'OWNER');
  const aw2 = w.make();
  w.state.sessions = [w.claudeSession(), w.codexSession()];
  await aw2.build();
  w.state.sessions = [w.claudeSession(), w.codexSession(w.T, { codexServerPid: 210 })];
  assert.equal((await aw2.build()).self[`codex|${w.T}`].verified, false, 'nor is it listed from the other server');
  // Once server 200 is gone the thread may move (resumed in a new server).
  w.procs.delete(200);
  assert.equal((await aw.bindCaller({ ...w.call(211), threadId: w.T })).bound, true);
});

test('re-review N3: who runs each session survives a restart of Plexiform (0600 file); a dead process is dropped', async (t) => {
  const w = world(t);
  await w.make().build(); // X seen running in claude 100; T on server 200
  const file = path.join(w.root, 'awareness', 'owners.json');
  for (let i = 0; i < 100 && !fs.existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!saved.includes(w.repoA) && !saved.includes(w.home), 'ids, pids and start times only: no folder');
  // Plexiform restarts; before its first roster, X's file is rewritten to name another signed claude in the repository.
  const other = w.proc(700, { exe: w.CLAUDE, cwd: w.repoA, signed: 'claude', args: 'claude' });
  const kid = w.mcpChild(701, 700, w.repoA, w.procs.get(101));
  kid.env = kid.env.replace('CLAUDE_PID=100', 'CLAUDE_PID=700');
  w.stdio(kid, other, 'unix');
  w.state.sessions = [w.claudeSession('X', { claudePid: 700 }), w.codexSession()];
  const restarted = w.make();
  assert.equal((await restarted.bindCaller(w.call(701))).reason, 'OWNER');
  assert.equal((await restarted.build()).self['claude|X'].verified, false);
  // claude 100 exits: the next start drops its pin, and X may move.
  w.procs.delete(100);
  const again = w.make();
  assert.equal((await again.bindCaller(w.call(701))).bound, true);
  for (let i = 0; i < 100 && fs.readFileSync(file, 'utf8').includes('"claude|X",100,'); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('"claude|X",100,'), 'the dead owner is gone from the file');
  // A file that is not Plexiform's shape is ignored, never trusted.
  fs.writeFileSync(file, JSON.stringify({ v: 1, owners: [['claude|X', 'nope', 3], ['../x', 5, 'y'], { a: 1 }] }));
  assert.equal((await w.make().bindCaller(w.call(701))).bound, true);
});

test('re-review N5: the four-check cap covers the first lsof and ps of every call too', async (t) => {
  const w = world(t);
  const kids = [];
  for (let i = 0; i < 10; i += 1) { const k = w.mcpChild(800 + i, 200, w.repoB); w.stdio(k, w.procs.get(200), 'PIPE'); kids.push(800 + i); }
  let inFlight = 0;
  let peak = 0;
  const slow = (file, args, opts, cb) => {
    const hit = file === '/usr/sbin/lsof' && args.some((a) => a.startsWith('-iTCP@'));
    if (hit) { inFlight += 1; peak = Math.max(peak, inFlight); }
    setTimeout(() => w.exec(file, args, opts, (...r) => { if (hit) inFlight -= 1; cb(...r); }), 10);
  };
  const aw = w.make({ execFile: slow });
  await Promise.all(kids.map((pid) => aw.bindCaller({ ...w.callAs(pid), threadId: w.T })));
  assert.ok(peak >= 1 && peak <= 4, `peak ${peak} peer lookups at once`);
});

test('re-review N4: PRIVACY.md says signed parents\' environments are read for the injection check with values discarded, and states the shell limit as it is', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'PRIVACY.md'), 'utf8');
  assert.match(text, /signed Claude Code or Codex program's environment[^.]*keeping only whether such a variable is set and discarding every value/);
  assert.ok(!text.includes('acts only on requests its AI program writes to it, so a command an AI runs from its shell is answered as no particular session'));
  assert.match(text, /SIGUSR1/);
  assert.match(text, /awareness\/owners\.json/);
});

test('re-review trade-off: bus_peers counts the sessions Plexiform could not verify, and names none of them', async (t) => {
  const w = world(t);
  // Claude Code installed with npm (plain node, unsigned) in repoC: a session file and a live process, never verifiable.
  w.proc(900, { exe: '/opt/homebrew/bin/node', cwd: w.repoC, args: 'node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js' });
  w.state.sessions.push(w.claudeSession('NPM', { claudePid: 900, cwd: w.repoC }));
  const aw = w.make();
  const r = await aw.relay('peers', {}, {}, { ...w.call(201), threadId: w.T }, { forward: async () => ({}) });
  assert.equal(r.bound, true);
  assert.equal(r.unverified_sessions, 1);
  assert.ok(!JSON.stringify(r.peers).includes('docs'), 'its folder is nowhere');
  assert.match(r.note, /cannot be named or handed work/);
});
