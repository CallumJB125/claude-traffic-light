// Process identity (pid + lstart) and tree kill (spikes 5b–5e). A Bash tool
// tree runs in its own process group and reparents to 1 when claude dies, so
// descendants are enumerated BEFORE claude is killed and every descendant
// process group is killed separately.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { windowsIdentity } from './windows-job.js';

const PS = process.platform === 'darwin' ? '/bin/ps' : 'ps';

export function lstartOf(pid) {
  if (process.platform === 'win32') return windowsIdentity(pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // The supervisor, hook and restart reader can have different narrow
    // environments. A local timezone/locale must not change the identity of
    // the same PID; missing or mismatched start times still fail closed.
    const env = { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' };
    const s = execFileSync(PS, ['-o', 'lstart=', '-p', String(pid)], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); // privacy-flow: runner-local
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

// Stop receipts need positive metadata evidence: ps failure is unknown, not
// an empty tree. No command lines or provider content are read by this probe.
function processStatusTable(timeoutMs = 1000) {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync(PS, ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs }); // privacy-flow: runner-local
    const rows = [];
    for (const line of out.trim().split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+([A-Za-z+<>=NsLl0-9]+)\s*$/.exec(line);
      if (!m) return null;
      rows.push({ pid: Number(m[1]), pgid: Number(m[2]), stat: m[3] });
    }
    // A successful complete process table always includes this observer.
    return rows.some((r) => r.pid === process.pid) ? rows : null;
  } catch { return null; }
}

// Verification only: kill scope remains with the existing identity-safe stop
// recipe. A recycled pid/group is conservatively unconfirmed. Zombies cannot
// perform work; missing/unreadable observations must never authorize a start.
// Backends confirm with STOP_VERIFY_MS so the observation outlasts their own
// post-SIGKILL exit wait (2 s); a slow-dying tool tree is then not reported
// unconfirmed (and quarantined) while the kernel is still reaping it.
export const STOP_VERIFY_MS = 3000;
const STOP_VERIFY_MAX_MS = 5000;
export async function waitForStopped({ pid, groups = [] }, { timeoutMs = 1000, readTable = processStatusTable,
  now = Date.now, delay = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!Array.isArray(groups)) return false;
  if (pid == null && groups.length === 0) return true; // Nothing was spawned.
  if (!Number.isSafeInteger(pid) || pid <= 1
    || groups.some((g) => !Number.isSafeInteger(g) || g <= 1)) return false;
  const owned = new Set(groups), end = now() + Math.min(STOP_VERIFY_MAX_MS, Math.max(0, timeoutMs));
  for (;;) {
    // A synchronous probe uses only the remaining deadline. timeoutMs:0
    // requests a single bounded observation without a poll wait.
    const probeMs = timeoutMs === 0 ? 1000 : Math.max(1, end - now());
    let rows; try { rows = readTable(probeMs); } catch { rows = null; }
    if (Array.isArray(rows) && rows.length && rows.every((r) => r && Number.isSafeInteger(r.pid)
      && Number.isSafeInteger(r.pgid) && typeof r.stat === 'string' && /^[A-Za-z]/.test(r.stat))
      && rows.every((r) => (r.pid !== pid && !owned.has(r.pgid)) || r.stat.startsWith('Z'))) return true;
    const left = end - now();
    if (left <= 0) return false;
    await delay(Math.min(20, left));
  }
}

export function processTable() {
  if (process.platform === 'win32') return [];
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
  if (process.platform === 'win32') return null;
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
  if (process.platform === 'win32') return;
  for (const g of groups) {
    try { process.kill(-g, signal); } catch { /* gone */ }
  }
}

/**
 * SIGKILL pid (only if its lstart still matches) and every descendant process
 * group. Returns the groups/pids it signalled.
 */
export function killTree(pid, lstart) {
  // Only a retained WindowsJob can terminate a Windows tree. Historical PIDs
  // carry no ownership handle, even if the root's creation time still matches.
  if (process.platform === 'win32') return { groups: [], pids: [] };
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
