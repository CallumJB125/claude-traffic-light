// Process identity (pid + lstart) and tree kill (spikes 5b–5e). A Bash tool
// tree runs in its own process group and reparents to 1 when claude dies, so
// descendants are enumerated BEFORE claude is killed and every descendant
// process group is killed separately.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PS = process.platform === 'darwin' ? '/bin/ps' : 'ps';

export function lstartOf(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const s = execFileSync(PS, ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); // privacy-flow: runner-local
    return s || null;
  } catch { return null; }
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Same process as recorded: alive and started at the recorded time.
export function sameProcess(pid, lstart) {
  return !!lstart && isAlive(pid) && lstartOf(pid) === lstart;
}

export function processTable() {
  let out = '';
  try { out = execFileSync(PS, ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return []; } // privacy-flow: runner-local
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) });
  }
  return rows;
}

// Full command lines (for "is that session still open?"); null if ps fails.
export function commandLines() {
  try {
    return execFileSync(PS, ['-axww', '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 }).split('\n'); // privacy-flow: runner-local
  } catch { return null; }
}

export function descendants(pid, table = processTable()) {
  const kids = new Map();
  for (const r of table) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  const out = [];
  const stack = [pid];
  const seen = new Set([pid]);
  while (stack.length) {
    for (const r of kids.get(stack.pop()) ?? []) {
      if (seen.has(r.pid)) continue;
      seen.add(r.pid);
      out.push(r);
      stack.push(r.pid);
    }
  }
  return out;
}

export function pgidOf(pid, table = processTable()) {
  return table.find((r) => r.pid === pid)?.pgid ?? null;
}

// Process groups of pid's tree (incl. its own), never the caller's own group.
export function treeGroups(pid, table = processTable()) {
  const own = pgidOf(process.pid, table);
  const groups = new Set();
  const g = pgidOf(pid, table);
  if (g) groups.add(g);
  for (const d of descendants(pid, table)) groups.add(d.pgid);
  groups.delete(own);
  groups.delete(0);
  groups.delete(1);
  return { groups: [...groups], pids: descendants(pid, table).map((d) => d.pid) };
}

export function killGroups(groups, signal = 'SIGKILL') {
  for (const g of groups) {
    try { process.kill(-g, signal); } catch { /* gone */ }
  }
}

/**
 * SIGKILL pid (only if its lstart still matches) and every descendant process
 * group. Returns the groups/pids it signalled.
 */
export function killTree(pid, lstart) {
  // A recycled pid is someone else's process: touch nothing.
  if (lstart != null && lstartOf(pid) !== lstart) return { groups: [], pids: [] };
  const table = processTable();
  const { groups, pids } = treeGroups(pid, table);
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  killGroups(groups, 'SIGKILL');
  for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  return { groups, pids };
}

// 'laptop' when the machine has a battery, else 'desktop' (CardView.device_kind
// → "laptop asleep"). policy.json form_factor overrides; null when unknown.
export function detectFormFactor(platform = process.platform) {
  try {
    if (platform === 'darwin') return /InternalBattery/.test(execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 2000 })) ? 'laptop' : 'desktop'; // privacy-flow: form-factor
    if (platform === 'linux') return fs.readdirSync('/sys/class/power_supply').some((n) => /^BAT/.test(n)) ? 'laptop' : 'desktop';
  } catch { /* unknown */ }
  return null;
}
