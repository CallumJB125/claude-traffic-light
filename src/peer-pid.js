'use strict';
// Who is on the other end of a loopback connection, from the process table
// (plan-agent-awareness §3.1, findings §1 and §6). Never from the request.
//
// macOS only in v1: `/usr/sbin/lsof` and `/bin/ps` by absolute path, never a
// PATH lookup. Anywhere else every answer is null, so the caller stays unbound.
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

// fd 0 and fd 1 of the child are pipe or socketpair ends whose other ends the
// parent holds: what a server that spawned it over stdio looks like. A shell
// the model ran has /dev/null, a pty or a file there instead.
function stdioPeered(childFds, parentFds) {
  const held = new Set();
  for (const f of Object.values(parentFds)) { const e = endOf(f); if (e) held.add(`${e.addr}>${e.peer}`); }
  return ['0', '1'].every((fd) => { const e = endOf(childFds[fd]); return !!e && held.has(`${e.peer}>${e.addr}`); });
}

// `ps -o ppid=,lstart=` → { ppid, start }.
function parsePs(text) {
  const m = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(String(text || '').split('\n')[0] || '');
  return m ? { ppid: Number(m[1]), start: m[2] } : null;
}

// One value of `name` in `ps eww -o command=` output, or null when it is
// absent or appears more than once (a value with spaces could fake another).
function envValue(text, name, pattern) {
  const re = new RegExp(`(?:^|\\s)${name}=(\\S*)(?=\\s|$)`, 'g');
  const hits = [...String(text || '').matchAll(re)].map((m) => m[1]);
  return hits.length === 1 && pattern.test(hits[0]) ? hits[0] : null;
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
    async fds(pid, which = null) {
      if (!mac || !Number.isInteger(pid) || pid <= 1) return {};
      return parseFds(await lsof(['-a', '-p', String(pid), ...(which ? ['-d', which] : []), '-F', 'ftdn']).catch(() => ''));
    },
    async command(pid) {
      if (!mac || !Number.isInteger(pid) || pid <= 1) return '';
      return ps(['eww', '-o', 'command=', '-p', String(pid)]).catch(() => '');
    },
  };
}

module.exports = { create, parsePeer, parseFds, parsePs, stdioPeered, envValue };
