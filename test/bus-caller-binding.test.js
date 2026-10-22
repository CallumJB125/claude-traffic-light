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

// A fake process table behind /bin/ps and /usr/sbin/lsof; git runs for real.
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
  const CLAUDE = path.join(home, '.local/share/claude/versions/2.1.308');
  const CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  let nextAddr = 0x1000;
  const addr = () => `0x${(nextAddr++).toString(16)}`;
  // fd 0 and 1 of `child` as stream ends whose other ends `parent` holds (type PIPE for Codex, unix for Claude).
  const stdio = (child, parent, type) => {
    for (const fd of ['0', '1']) {
      const a = addr(); const b = addr();
      child.fds[fd] = { type, addr: a, peer: b };
      parent.fds[String(40 + Object.keys(parent.fds).length)] = { type, addr: b, peer: a };
    }
  };
  const proc = (pid, p) => { const v = { ppid: 1, start: START, exe: '/bin/sleep', cwd: home, command: '', args: '', fds: {}, files: [], ...p }; procs.set(pid, v); return v; };
  const fdLines = (p, only) => Object.entries(p.fds).filter(([fd]) => !only || only.includes(fd)).map(([fd, f]) => `f${fd}\nt${f.type}\n${f.addr ? `d${f.addr}\n` : ''}n${f.peer ? `->${f.peer}` : f.name || ''}\n`).join('');
  const fakeExec = (file, args, opts, cb) => {
    calls.push([file, ...args]);
    if (file === 'git') return execFile(file, args, opts, cb);
    const none = () => cb(Object.assign(new Error('none'), { code: 1 }), '');
    if (file === '/usr/sbin/lsof' && args.some((a) => a.startsWith('-iTCP@127.0.0.1:'))) return caller ? cb(null, `p${caller}\nf5\np${SELF}\nf9\n`) : none();
    const pid = Number(args[args.indexOf('-p') + 1]);
    const p = procs.get(pid);
    if (!p) return none();
    if (file === '/bin/ps') {
      if (args.includes('ppid=,lstart=')) return cb(null, `${p.ppid} ${p.start}\n`);
      if (args.includes('lstart=')) return cb(null, `${p.start}\n`);
      if (args.includes('command=')) return cb(null, `${p.command}\n`);
      return cb(null, `${p.args}\n`);
    }
    if (file === '/usr/sbin/lsof') {
      if (args.includes('-FDi')) return cb(null, `p${pid}\n${p.files.map(({ file: f }, i) => { const st = fs.statSync(f); return `f${30 + i}\nD0x${st.dev.toString(16)}\ni${st.ino}\nn${f}\n`; }).join('')}`);
      const d = args[args.indexOf('-d') + 1];
      if (args.includes('-d') && d === 'txt,cwd') return cb(null, `p${pid}\nfcwd\nn${p.cwd}\nftxt\nn${p.exe}\n`);
      if (args.includes('-d') && d === '0,1,cwd') return cb(null, `p${pid}\n${fdLines(p, ['0', '1'])}fcwd\ntDIR\nn${p.cwd}\n`);
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
    platform, startedAt: now - 60_000, selfPid: SELF, handleKey: Buffer.alloc(32, 7), log: (m) => logs.push(m), bindRetryMs: 5, ...opts });
  const iso = new Date(now).toISOString();

  // One interactive Claude Code session X in repoA (claude 100, our MCP child 101) and one Codex TUI thread T in
  // repoB on the shared daemon (server 200, our MCP child 201).
  const claude = proc(100, { exe: CLAUDE, cwd: repoA });
  const claudeMcp = proc(101, { ppid: 100, exe: '/opt/homebrew/bin/node', cwd: repoA, command: `node ${repoA}/mcp-server.js --profile bus PLEXIFORM_MCP=bus-v1:packaged CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_SESSION_ID=X CLAUDE_PID=100` });
  stdio(claudeMcp, claude, 'unix');
  const T = '019a0000-0000-7000-8000-00000000000t';
  const server = proc(200, { exe: CODEX, cwd: home, files: [{ file: rollout(T, repoB) }] });
  const codexMcp = proc(201, { ppid: 200, exe: '/Applications/Plexiform.app/Contents/MacOS/Plexiform', cwd: repoB, command: '/Applications/Plexiform.app/Contents/MacOS/Plexiform /Applications/Plexiform.app/Contents/Resources/app.asar/mcp-server.js --profile bus ELECTRON_RUN_AS_NODE=1 PLEXIFORM_MCP=bus-v1:packaged' });
  stdio(codexMcp, server, 'PIPE');
  const claudeSession = (id = 'X', extra = {}) => ({ source: 'claude', sessionId: id, host: HOST, cwd: repoA, signal: 'prompt-submit', updatedAt: iso, claudePid: 100, interactive: true, ...extra });
  const codexSession = (id = T, extra = {}) => ({ source: 'codex', sessionId: id, host: HOST, cwd: repoB, signal: 'stop', updatedAt: iso, codexHookAt: iso, codexServerPid: 200, codexInteractive: true, codexTranscript: path.join(codexHome, 'sessions', '2026', '10', '22', `rollout-${id}.jsonl`), ...extra });
  state.sessions = [claudeSession(), codexSession()];
  return { dir, home, root, codexHome, repoA, repoB, repoC, procs, proc, stdio, calls, state, logs, make, rollout, T, CLAUDE, CODEX, claudeSession, codexSession, iso,
    call: (pid) => { caller = pid; return { remotePort: 51234 }; } };
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
  // ps and lsof only by absolute path; never a PATH lookup.
  assert.ok(w.calls.every(([f]) => f === 'git' || f === '/bin/ps' || f === '/usr/sbin/lsof'));
  // The log has outcomes, never an id or a folder.
  assert.ok(w.logs.some((l) => /\[awareness\] caller codex bound/.test(l)));
  assert.ok(!w.logs.some((l) => l.includes(w.T) || l.includes(w.repoA) || l.includes('X ')));
});

test('AW11: forged body fields are never identity: a detached process naming another session\'s ppid, session_id and thread is unbound', async (t) => {
  const w = world(t);
  const aw = w.make();
  // A detached `nohup` reparented to launchd (ppid 1), carrying a copy of our server's command line.
  w.proc(300, { ppid: 1, exe: '/opt/homebrew/bin/node', cwd: w.repoA, command: 'node /x/mcp-server.js --profile bus CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_SESSION_ID=X CLAUDE_PID=100' });
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
  const sh = w.proc(202, { ppid: 200, exe: '/opt/homebrew/bin/node', cwd: w.repoB, command: '/opt/homebrew/bin/node /tmp/mcp-server.js --profile bus' });
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
  const bash = w.proc(102, { ppid: 100, exe: '/opt/homebrew/bin/node', cwd: w.repoA, command: 'node /tmp/mcp-server.js CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_SESSION_ID=X CLAUDE_PID=100' });
  bash.fds = { 0: { type: 'CHR', name: '/dev/null' }, 1: { type: 'REG', name: '/private/tmp/claude-501/tasks/x.output' } };
  assert.equal((await aw.bindCaller(w.call(102))).reason, 'NOT_STDIO');
  // stdio pipes held by some other process, not this parent.
  const other = w.proc(250, { exe: '/bin/cat' });
  const fake = w.proc(203, { ppid: 100, exe: '/opt/homebrew/bin/node', cwd: w.repoA, command: 'node /tmp/mcp-server.js CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_SESSION_ID=X' });
  w.stdio(fake, other, 'unix');
  assert.equal((await aw.bindCaller(w.call(203))).reason, 'NOT_STDIO');
  assert.ok(claude);
});

test('AW11: a grandchild (a server an agent started from its shell, under our own server or a shell) is rejected', async (t) => {
  const w = world(t);
  const aw = w.make();
  const parent = w.procs.get(201);
  const g = w.proc(204, { ppid: 201, exe: '/opt/homebrew/bin/node', cwd: w.repoB, command: 'node /x/mcp-server.js --profile bus' });
  w.stdio(g, parent, 'PIPE');
  assert.equal((await aw.bindCaller({ ...w.call(204), threadId: w.T })).reason, 'NOT_AI_CHILD');
  const zsh = w.proc(110, { ppid: 100, exe: '/bin/zsh', cwd: w.repoA });
  const g2 = w.proc(111, { ppid: 110, exe: '/opt/homebrew/bin/node', cwd: w.repoA, command: 'node /x/mcp-server.js CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_SESSION_ID=X CLAUDE_PID=100' });
  w.stdio(g2, zsh, 'unix');
  assert.equal((await aw.bindCaller(w.call(111))).reason, 'NOT_AI_CHILD');
});

test('AW11: a fabricated session file with a detached `sleep` pid is not listed and cannot bind; a rewritten pid fails the executable check', async (t) => {
  const w = world(t);
  w.proc(400, { ppid: 1, exe: '/bin/sleep', cwd: path.join(w.home, 'Desktop') });
  const kid = w.proc(401, { ppid: 400, exe: '/opt/homebrew/bin/node', cwd: w.repoA, command: 'node /x/mcp-server.js CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_SESSION_ID=fake CLAUDE_PID=400' });
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
  const m2 = w.proc(205, { ppid: 200, exe: w.procs.get(201).exe, cwd: w.repoC, command: w.procs.get(201).command });
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
  // A second genuine MCP child for thread T (an agent's own app-server resuming it, recorded as T's server now).
  const rogue = w.proc(210, { exe: w.CODEX, cwd: w.home, files: [{ file: w.procs.get(200).files[0].file }] });
  const p2 = w.proc(211, { ppid: 210, exe: w.procs.get(201).exe, cwd: w.repoB, command: w.procs.get(201).command });
  w.stdio(p2, rogue, 'PIPE');
  w.state.sessions = [w.claudeSession(), w.codexSession(w.T, { codexServerPid: 210 })];
  const second = await aw.bindCaller({ ...w.call(211), threadId: w.T });
  assert.equal(second.bound, false);
  assert.equal(second.reason, 'CONTESTED');
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).bound, false, 'the first claimant is unbound too');
  // Two children of the same server claiming one thread: both unbound as well.
  w.state.sessions = [w.claudeSession(), w.codexSession()];
  const twin = w.proc(212, { ppid: 200, exe: w.procs.get(201).exe, cwd: w.repoB, command: w.procs.get(201).command });
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
  // SessionEnd removed X; the new session X2 runs in the same claude process, and the MCP child still says X.
  w.state.sessions = [w.claudeSession('X2'), w.codexSession()];
  const aw = w.make();
  const r = await aw.bindCaller(w.call(101));
  assert.equal(r.bound, true, r.reason);
  assert.equal(r.key, 'claude|X2');
  // No SessionEnd: X lingers beside X2, both naming claude 100.
  w.state.sessions = [w.claudeSession('X'), w.claudeSession('X2'), w.codexSession()];
  assert.equal((await aw.bindCaller(w.call(101))).reason, 'TIE');
  // A child whose own id names a different, live session of another process is not bound to this one.
  w.state.sessions = [w.claudeSession('X2'), w.claudeSession('X', { claudePid: 900 }), w.codexSession()];
  assert.equal((await aw.bindCaller(w.call(101))).reason, 'ID_MISMATCH');
});

test('headless callers are never bound: claude -p (sdk-cli), a codex exec thread', async (t) => {
  const w = world(t);
  w.procs.get(101).command = w.procs.get(101).command.replace('ENTRYPOINT=cli', 'ENTRYPOINT=sdk-cli');
  w.state.sessions = [w.claudeSession(), w.codexSession(w.T, { codexInteractive: false })];
  const aw = w.make();
  assert.equal((await aw.bindCaller(w.call(101))).reason, 'HEADLESS');
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).reason, 'HEADLESS');
  // An env value with spaces that smuggles a second CLAUDE_CODE_ENTRYPOINT: ambiguous, so not interactive.
  w.procs.get(101).command = w.procs.get(101).command.replace('ENTRYPOINT=sdk-cli', 'ENTRYPOINT=cli FOO=x CLAUDE_CODE_ENTRYPOINT=cli');
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
  const r = await aw.relay('session', {}, {}, { ...w.call(201), threadId: w.T }, opts);
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
