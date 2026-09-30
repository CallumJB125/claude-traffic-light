// A process's parent and name, per OS, for the hook's "which process is this
// session?" walk (set-status.js). Dependency-free: it runs inside the hook.
//
//   macOS:   /bin/ps -o ppid=,comm= -p <pid>   (as it always has)
//   Linux:   /proc/<pid>/stat, no subprocess (/bin/ps is not on every distro)
//   Windows: one Get-CimInstance Win32_Process snapshot of every process,
//            since a PowerShell start costs too much to pay per step
//
// `run(file, args, timeoutMs)` returns stdout or throws, and `readFile(path)`
// returns text or throws; both injected so tests never shell out.
const fs = require('fs');

// /proc/<pid>/stat: "pid (comm) state ppid …"; comm may hold spaces and ")".
function parseStat(text) {
  const t = String(text || '');
  const open = t.indexOf('(');
  const close = t.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const fields = t.slice(close + 2).split(' ');
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? { ppid, comm: t.slice(open + 1, close) } : null;
}

// Lines "pid ppid name" → Map(pid → { ppid, comm }).
function parseSnapshot(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
  }
  return map;
}

const WIN_SNAPSHOT = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }';

// → (pid, timeoutMs) => { ppid, comm } | null
function parentLookup({ platform = process.platform, run, readFile = (f) => fs.readFileSync(f, 'utf8') }) {
  if (platform === 'darwin') {
    return (pid, timeout) => {
      const line = String(run('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], timeout)).trim();
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      return m ? { ppid: Number(m[1]), comm: m[2] } : null;
    };
  }
  if (platform === 'linux') {
    return (pid) => { try { return parseStat(readFile(`/proc/${pid}/stat`)); } catch { return null; } };
  }
  if (platform === 'win32') {
    let snapshot = null;
    return (pid, timeout) => {
      if (!snapshot) snapshot = parseSnapshot(run('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_SNAPSHOT], timeout));
      return snapshot.get(pid) || null;
    };
  }
  return () => null;
}

module.exports = { parentLookup, parseStat, parseSnapshot, WIN_SNAPSHOT };
