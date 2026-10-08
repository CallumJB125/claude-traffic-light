// Hosted runner sandbox (hosted/cgroup.js) against a fake cgroup tree: a temp
// directory with the files a delegated cgroup v2 subtree has. The real kernel
// semantics (cgroup.kill, controller delegation) are checked on the Pi by
// `node runner/cli.js hosted-check` (docs/CLOUD-RUNNER-RUNBOOK.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ownCgroup, detectCgroup, RunCgroup } from '../hosted/cgroup.js';
import { tmpDir, rm, waitFor, alive } from './helpers.js';

const posix = process.platform !== 'win32';

function fakeCgroupRoot(root, self = '/system.slice/buddy-runner.service/supervisor', controllers = 'cpuset cpu io pids') {
  const service = path.join(root, path.dirname(self));
  fs.mkdirSync(path.join(root, self), { recursive: true });
  fs.writeFileSync(path.join(root, 'cgroup.controllers'), controllers);
  fs.writeFileSync(path.join(service, 'cgroup.controllers'), controllers);
  // systemd's DelegateSubgroup= leaves the delegated controllers enabled for children.
  fs.writeFileSync(path.join(service, 'cgroup.subtree_control'), 'cpu io pids');
  return service;
}

test('ownCgroup reads the unified (0::) line', () => {
  assert.equal(ownCgroup('0::/system.slice/buddy-runner.service/supervisor\n'), '/system.slice/buddy-runner.service/supervisor');
  assert.equal(ownCgroup('12:pids:/x\n'), null);
  assert.equal(ownCgroup(''), null);
});

test('detectCgroup: a delegated service cgroup with pids is usable; memory only when the kernel has it', () => {
  const root = tmpDir('cgr-');
  try {
    const service = fakeCgroupRoot(root);
    const d = detectCgroup({ root, self: '/system.slice/buddy-runner.service/supervisor' });
    assert.equal(d.ok, true, d.reason);
    assert.equal(d.base, service);
    assert.equal(d.memory, false, 'Raspberry Pi OS boots with cgroup_disable=memory');
    assert.ok(d.controllers.includes('pids') && d.controllers.includes('cpu'));
  } finally { rm(root); }
  const none = tmpDir('cgr-');
  try {
    assert.equal(detectCgroup({ root: none, self: '/x/supervisor' }).ok, false, 'not a cgroup v2 mount');
    assert.match(detectCgroup({ root: none, self: null }).reason, /no cgroup v2 membership/);
  } finally { rm(none); }
});

test('RunCgroup: limits are written, the wrapper joins the run cgroup and keeps the pid, kill takes the process group', { skip: !posix }, async () => {
  const root = tmpDir('cgr-');
  const runDir = tmpDir('cgd-');
  try {
    const service = fakeCgroupRoot(root);
    const cg = new RunCgroup({ base: service, runId: 'run/../1', limits: { cpuPercent: 150, tasksMax: 256, memoryBytes: 1 << 30 }, memory: false }).create();
    assert.equal(path.dirname(cg.dir), service, 'the run id cannot leave the service cgroup');
    assert.equal(fs.readFileSync(path.join(cg.dir, 'cpu.max'), 'utf8'), '150000 100000');
    assert.equal(fs.readFileSync(path.join(cg.dir, 'pids.max'), 'utf8'), '256');
    assert.equal(fs.existsSync(path.join(cg.dir, 'memory.max')), false, 'no memory controller: the watchdog applies instead');
    assert.equal(cg.memoryLimited, false);
    const script = path.join(runDir, 'cli.sh');
    fs.writeFileSync(script, `#!/bin/sh\n'${process.execPath}' -e 'setTimeout(()=>{},60000)' &\nexec '${process.execPath}' -e 'setTimeout(()=>{},60000)'\n`, { mode: 0o755 });
    const bin = cg.wrap(script, runDir);
    assert.equal(fs.statSync(bin).mode & 0o777, 0o700);
    const child = spawn(bin, [], { detached: true, stdio: 'ignore' });
    await waitFor(() => cg.pids().length === 1, { what: 'wrapper joined the cgroup' });
    assert.deepEqual(cg.pids(), [child.pid], 'exec keeps the pid the supervisor tracks');
    assert.ok(cg.rssBytes((p) => (p === child.pid ? 'Name:\tnode\nVmRSS:\t  2048 kB\n' : null)) === 2048 * 1024);
    assert.equal(await cg.kill(), true);
    await waitFor(() => !alive(child.pid), { what: 'cli killed' });
    cg.remove();
    assert.equal(fs.existsSync(cg.dir), false);
  } finally { rm(root); rm(runDir); }
});

test('RunCgroup: a memory controller gets memory.max and no swap', () => {
  const root = tmpDir('cgr-');
  try {
    const service = fakeCgroupRoot(root);
    const cg = new RunCgroup({ base: service, runId: 'r2', limits: { memoryBytes: 512 * 1048576 }, memory: true }).create();
    assert.equal(fs.readFileSync(path.join(cg.dir, 'memory.max'), 'utf8'), String(512 * 1048576));
    assert.equal(fs.readFileSync(path.join(cg.dir, 'memory.swap.max'), 'utf8'), '0');
    assert.equal(cg.memoryLimited, true);
  } finally { rm(root); }
});
