// Per-run cgroup v2 sandbox for the hosted runner (docs/CLOUD-RUNNER-RUNBOOK.md).
//
// Why a delegated cgroup and not a container: the Pi has no rootless runtime
// (no podman, no uidmap/newuidmap, the Docker daemon is off and its group is
// root-equivalent), and `systemd-run --user` would need a lingering user
// manager. buddy-runner.service runs with Delegate=yes and
// DelegateSubgroup=supervisor, so this unprivileged process owns its own
// cgroup subtree: it makes one child cgroup per run, sets cpu.max / pids.max
// (memory.max only where the kernel has the memory controller; Raspberry Pi OS
// boots with cgroup_disable=memory, so a resident-memory watchdog stands in),
// starts the agent CLI through a tiny wrapper that moves itself into that
// cgroup before exec, and ends the run with cgroup.kill, which takes every
// descendant however it daemonised.
import fs from 'node:fs';
import path from 'node:path';

export const CGROUP_ROOT = '/sys/fs/cgroup';
const KILL_WAIT_MS = 5000;

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** This process's cgroup v2 path ("/system.slice/buddy-runner.service/supervisor"), or null. */
export function ownCgroup(text = read('/proc/self/cgroup')) {
  const line = String(text ?? '').split('\n').find((l) => l.startsWith('0::'));
  return line ? line.slice(3).trim() || null : null;
}

/**
 * Can this process make per-run cgroups? → {ok, base, controllers, memory, reason}.
 * base = the delegated service cgroup (the parent of our `supervisor` leaf).
 */
export function detectCgroup({ root = CGROUP_ROOT, self = ownCgroup(), pid = process.pid } = {}) {
  if (!self) return { ok: false, reason: 'no cgroup v2 membership (/proc/self/cgroup has no 0:: line)' };
  if (read(path.join(root, 'cgroup.controllers')) == null) return { ok: false, reason: `${root} is not a cgroup v2 mount` };
  let base = path.join(root, self);
  // Without DelegateSubgroup=supervisor, step into our own leaf first: a cgroup
  // with processes in it cannot hand controllers to children.
  if (path.basename(self) !== 'supervisor') {
    try {
      fs.mkdirSync(path.join(base, 'supervisor'), { recursive: true });
      fs.writeFileSync(path.join(base, 'supervisor', 'cgroup.procs'), String(pid));
    } catch (e) { return { ok: false, reason: `cgroup ${self} is not delegated to this user (${e.code ?? e.message}); set Delegate=yes` }; }
  } else base = path.dirname(base);
  try { fs.accessSync(base, fs.constants.W_OK); } catch { return { ok: false, reason: `cgroup ${base} is not writable; set Delegate=yes` }; }
  const words = (f) => String(read(path.join(base, f)) ?? '').split(/\s+/).filter(Boolean);
  const available = words('cgroup.controllers');
  const on = words('cgroup.subtree_control');
  for (const c of ['cpu', 'pids', 'memory'].filter((x) => available.includes(x) && !on.includes(x))) {
    try { fs.writeFileSync(path.join(base, 'cgroup.subtree_control'), `+${c}`); } catch { /* not delegable */ }
  }
  const enabled = words('cgroup.subtree_control');
  if (!enabled.includes('pids')) return { ok: false, reason: 'the pids controller is not delegated to the runner cgroup' };
  return { ok: true, base, controllers: enabled, memory: enabled.includes('memory') };
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export class RunCgroup {
  /** limits: {cpuPercent, tasksMax, memoryBytes}; memory = the controller is on. */
  constructor({ base, runId, limits = {}, memory = false }) {
    this.dir = path.join(base, `run-${safe(runId)}`);
    this.limits = limits;
    this.memoryLimited = false;
    this.memory = memory;
  }

  create() {
    fs.mkdirSync(this.dir, { recursive: true });
    const { cpuPercent, tasksMax, memoryBytes } = this.limits;
    const set = (file, value) => { try { fs.writeFileSync(path.join(this.dir, file), value); return true; } catch { return false; } };
    if (Number.isFinite(cpuPercent) && cpuPercent > 0) set('cpu.max', `${Math.round(cpuPercent * 1000)} 100000`);
    if (Number.isSafeInteger(tasksMax) && tasksMax > 0) set('pids.max', String(tasksMax));
    if (this.memory && Number.isSafeInteger(memoryBytes) && memoryBytes > 0) {
      this.memoryLimited = set('memory.max', String(memoryBytes));
      set('memory.swap.max', '0');
    }
    return this;
  }

  /** A 0700 wrapper in the run dir: join this run's cgroup, then exec the CLI (same pid). */
  wrap(realBin, runDir) {
    const file = path.join(runDir, 'sandbox-exec');
    fs.writeFileSync(file, `#!/bin/sh\necho $$ > ${shq(path.join(this.dir, 'cgroup.procs'))} || exit 125\nexec ${shq(realBin)} "$@"\n`, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
    return file;
  }

  pids() {
    return String(read(path.join(this.dir, 'cgroup.procs')) ?? '').split('\n').map((l) => Number(l.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
  }

  #alive() { return this.pids().filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } }); }

  /** Resident memory of everything in the run, from /proc (page-size independent). */
  rssBytes(readStatus = (p) => read(`/proc/${p}/status`)) {
    let kb = 0;
    for (const p of this.pids()) kb += Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(readStatus(p) ?? '')?.[1] ?? 0);
    return kb * 1024;
  }

  /** Kill everything in the run; → true once nothing in it is alive. */
  async kill() {
    let killed = false;
    const killFile = path.join(this.dir, 'cgroup.kill');
    if (fs.existsSync(killFile)) {
      try { fs.writeFileSync(killFile, '1'); killed = true; } catch { /* signals below */ }
    }
    if (!killed) {
      for (const p of this.pids()) {
        try { process.kill(-p, 'SIGKILL'); } catch { /* not a group leader */ }
        try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    const until = Date.now() + KILL_WAIT_MS;
    while (this.#alive().length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return this.#alive().length === 0;
  }

  remove() {
    try { fs.rmdirSync(this.dir); } catch { /* a real cgroup is removed by rmdir; a test dir may hold files */ }
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
}
