'use strict';
// Who is on the other end of a loopback connection, from the process table
// (plan-agent-awareness §3.1, findings §1 and §6). Never from the request.
//
// macOS only in v1: `/usr/sbin/lsof`, `/bin/ps` and `/usr/bin/codesign` by
// absolute path, never a PATH lookup. Anywhere else every answer is null (and
// no signature passes), so the caller stays unbound.
// `run(file, args)` is an async execFile → stdout, injected so tests can fake
// the process table. Nothing here blocks: main calls it.

const ID = /^\d{1,9}$/;

// `lsof -F p` lines → the pids, without our own. Exactly one other, or null.
function parsePeer(text, selfPid) {
  const pids = new Set();
  for (const line of String(text || '').split('\n')) if (line[0] === 'p' && ID.test(line.slice(1))) pids.add(Number(line.slice(1)));
  pids.delete(selfPid);
  return pids.size === 1 ? [...pids][0] : null;
}

// `lsof -F ftdn` → { fd: { type, addr, peer, name } }. A pipe or socketpair end
// shows its own kernel address as `d0x…` and its peer's as `n->0x…`.
function parseFds(text) {
  const out = {};
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const k = line[0];
    const v = line.slice(1);
    if (k === 'p') cur = null;
    else if (k === 'f') { cur = { type: null, addr: null, peer: null, name: null }; if (!(v in out)) out[v] = cur; }
    else if (!cur) continue;
    else if (k === 't') cur.type = v;
    else if (k === 'd') cur.addr = /^0x[0-9a-f]+$/.test(v) ? v : null;
    else if (k === 'n') { cur.name = v; const m = /^->(0x[0-9a-f]+)$/.exec(v); cur.peer = m ? m[1] : null; }
  }
  return out;
}

const STREAM = new Set(['PIPE', 'unix']);
const endOf = (f) => (f && STREAM.has(f.type) && f.addr && f.peer ? f : null);

// fd 0 and fd 1 of the child are distinct stream ends of the type its parent
// uses (Codex: PIPE, Claude Code: unix socketpair) whose other ends the parent
// holds: what a server that spawned it over stdio looks like. A shell the model
// ran has /dev/null, a pty or a file there; one that moved its stdout or stderr
// onto fd 0 (`exec 0<&1`) shows the same end twice and is refused. macOS lsof
// does not show which way a pipe end points, so this alone cannot tell a moved
// write end from a read end: the caller also requires the child to be
// Plexiform's own server program, unmodified, which acts only on requests
// arriving on its stdin (src/agent-awareness.js bindOnce).
function stdioPeered(childFds, parentFds, type = null) {
  const held = new Set();
  for (const f of Object.values(parentFds)) { const e = endOf(f); if (e) held.add(`${e.addr}>${e.peer}`); }
  const ends = ['0', '1'].map((fd) => endOf(childFds[fd]));
  if (ends.some((e) => !e || (type && e.type !== type))) return false;
  for (const [fd, f] of Object.entries(childFds)) {
    if (fd !== '0' && f && f.addr === ends[0].addr) return false;
    if (fd !== '1' && f && f.addr === ends[1].addr) return false;
  }
  return ends.every((e) => held.has(`${e.peer}>${e.addr}`));
}

// An internet socket with no remote end in parseFds() output: one listening (an inspector, a debug port)
// or not connected. Plexiform's server only ever connects out, to main.
const listening = (fds) => Object.values(fds).some((f) => f && /^IPv[46]$/.test(f.type || '') && !String(f.name || '').includes('->'));

// `ps -o ppid=,lstart=` → { ppid, start }.
function parsePs(text) {
  const m = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(String(text || '').split('\n')[0] || '');
  return m ? { ppid: Number(m[1]), start: m[2] } : null;
}

// One value of `name` in an environment string (`ps eww` output with the
// command line cut off), or null when it is absent or appears more than once
// (a value with spaces could fake another).
function envValue(text, name, pattern) {
  const re = new RegExp(`(?:^|\\s)${name}=(\\S*)(?=\\s|$)`, 'g');
  const hits = [...String(text || '').matchAll(re)].map((m) => m[1]);
  return hits.length === 1 && pattern.test(hits[0]) ? hits[0] : null;
}

// Environment that loads other code into a signed claude (BUN_OPTIONS
// --preload works on it), into Plexiform's own server (NODE_OPTIONS --require
// or --inspect) or into any binary without the hardened runtime (DYLD_*).
const INJECT = /^(?:NODE_OPTIONS|NODE_REPL_EXTERNAL_MODULE|BUN_OPTIONS|BUN_BE_BUN|BUN_INSPECT\w*|DYLD_\w+|LD_PRELOAD)$/;

// `ps -ww -o args=` (the command line) and `ps eww -o command=` (the command
// line, then the environment) → { args, vars, injected }: only the named
// variables and whether any injecting one is set. The rest of the environment
// (API keys, tokens) is dropped here, never kept or logged. Null when the
// second does not start with the first.
function parseEnv(argsText, commandText, names = []) {
  const args = String(argsText || '').replace(/\n+$/, '');
  const cmd = String(commandText || '').replace(/\n+$/, '');
  if (!args || !cmd.startsWith(args)) return null;
  const rest = cmd.slice(args.length);
  const vars = {};
  for (const n of names) vars[n] = envValue(rest, n, /^[\w.:/-]{1,200}$/);
  const injected = [...rest.matchAll(/(?:^|\s)([A-Za-z_]\w*)=/g)].some((m) => INJECT.test(m[1]));
  return { args, vars, injected };
}

// The code-signing requirement of each provider's real binary, checked on the
// running process (codesign by pid), so neither a copy of node at an
// allow-listed path nor a binary swapped after launch passes. Anthropic and
// OpenAI team ids, as both sign their CLIs on this Mac. One source with the
// session keeper's codesign gate (plan-agent-terminal §R3.6): its Swift
// constant is generated from the same file.
const { claude: CLAUDE_REQUIREMENT, codex: CODEX_REQUIREMENT } = require('./provider-requirements.json');
const REQUIREMENT = Object.freeze({ claude: CLAUDE_REQUIREMENT, codex: CODEX_REQUIREMENT });
// target: a pid (the running process) or an absolute path (a file about to be run). → boolean.
async function signedAs(run, target, provider, platform = process.platform) {
  if (platform !== 'darwin' || !REQUIREMENT[provider]) return false;
  const t = String(target);
  if (!/^\d{1,9}$/.test(t) && !t.startsWith('/')) return false;
  return run('/usr/bin/codesign', ['--verify', '--strict', `-R=${REQUIREMENT[provider]}`, t]).then(() => true, () => false);
}

function create({ run, platform = process.platform, selfPid = process.pid }) {
  const mac = platform === 'darwin';
  const lsof = (args) => run('/usr/sbin/lsof', ['-nP', ...args]); // privacy-flow: agent-awareness-local
  const ps = (args) => run('/bin/ps', args);
  return {
    supported: mac,
    // The pid holding the client end of 127.0.0.1:<remotePort> → our server.
    async peerOf(remotePort) {
      if (!mac || !Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) return null;
      return parsePeer(await lsof(['-a', `-iTCP@127.0.0.1:${remotePort}`, '-sTCP:ESTABLISHED', '-Fp']).catch(() => ''), selfPid);
    },
    async proc(pid) {
      if (!mac || !Number.isInteger(pid) || pid <= 1) return null;
      return parsePs(await ps(['-o', 'ppid=,lstart=', '-p', String(pid)]).catch(() => ''));
    },
    // Every open file of a process as raw `lsof -F ftdnDi` text: parseFds() reads the stream ends,
    // agent-awareness's lsofFiles() the device and inode of each file, from one listing.
    async lsof(pid) {
      if (!mac || !Number.isInteger(pid) || pid <= 1) return '';
      return lsof(['-a', '-p', String(pid), '-F', 'ftdnDi']).catch(() => '');
    },
    async args(pid) {
      if (!mac || !Number.isInteger(pid) || pid <= 1) return '';
      return ps(['-ww', '-o', 'args=', '-p', String(pid)]).then((o) => String(o).replace(/\n+$/, ''), () => '');
    },
    // parseEnv() of a process: only `names` and whether an injecting variable is set leave this function.
    async env(pid, names = []) {
      if (!mac || !Number.isInteger(pid) || pid <= 1) return null;
      const [args, cmd] = await Promise.all([ps(['-ww', '-o', 'args=', '-p', String(pid)]), ps(['eww', '-o', 'command=', '-p', String(pid)])]).catch(() => [null, null]);
      return args === null ? null : parseEnv(args, cmd, names);
    },
    signedAs: (target, provider) => signedAs(run, target, provider, platform),
  };
}

module.exports = { create, parsePeer, parseFds, parsePs, stdioPeered, listening, envValue, parseEnv, signedAs, REQUIREMENT, INJECT };
