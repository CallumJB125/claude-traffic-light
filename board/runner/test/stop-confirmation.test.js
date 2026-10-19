// Owned disposable processes and injected metadata only. No real provider or
// user session is launched or signalled by this stop-receipt regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForStopped, killTree, lstartOf, treeGroups } from '../procs.js';
import { ClaudeBackend } from '../backends/claude.js';
import { CodexBackend } from '../backends/codex.js';
import { HermesBackend } from '../backends/hermes.js';
import { testTempDir } from '../../shared/test-support/tmp.js';

const other = { pid: 10, pgid: 10, stat: 'S' };
const subject = { pid: 100, groups: [100, 200] };
const row = (pid, pgid = pid, stat = 'S') => ({ pid, pgid, stat });
const probe = (rows) => waitForStopped(subject, { timeoutMs: 0, readTable: () => rows });

// Independently observe this fixture's complete owned scope. An unrelated
// runner process can have an unknown STAT during churn; it says nothing about
// these owned identities. Keep the observer as positive evidence of a real read,
// and retain every process in an owned group, including reparented descendants.
function ownedSnapshot({ pids, groups }) {
  const out = execFileSync(process.platform === 'darwin' ? '/bin/ps' : 'ps',
    ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 });
  const rows = out.trim().split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    assert.ok(m, 'process metadata must be readable');
    return { pid: Number(m[1]), pgid: Number(m[2]), stat: m[3] };
  }).filter((r) => r.pid === process.pid || pids.includes(r.pid) || groups.includes(r.pgid));
  assert.ok(rows.some((r) => r.pid === process.pid), 'a successful snapshot includes its observer');
  return rows;
}

test('stop receipt requires root and every remembered tool group to stop', async () => {
  assert.equal(await probe([other, row(100)]), false, 'root still executing');
  assert.equal(await probe([other, row(100, 300)]), false, 'root identity observed in another group is conservatively unconfirmed');
  assert.equal(await probe([other, row(201, 200)]), false, 'reparented tool still executing after root exit');
  assert.equal(await probe([other]), true, 'positively observed owned identities absent');
  assert.equal(await probe([other, row(100, 100, 'Z+'), row(201, 200, 'Z')]), true, 'zombies cannot continue work');
});

test('unknown, denied, empty and malformed stop observations fail closed', async () => {
  for (const rows of [null, undefined, [], [other, { pid: 100 }], [other, row(100, 100, '?')]])
    assert.equal(await probe(rows), false, 'unknown must not be a successful stop');
  assert.equal(await waitForStopped(subject, { timeoutMs: 0, readTable: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }), false);
  assert.equal(await waitForStopped({ pid: 100, groups: [0] }, { timeoutMs: 0, readTable: () => [other] }), false);
});

test('stop verification waits for delayed tool death within its five-second maximum', async () => {
  let at = 0, reads = 0, budgets = [];
  assert.equal(await waitForStopped(subject, { timeoutMs: 1000, now: () => at, delay: async (ms) => { at += ms; },
    readTable: (budget) => { budgets.push(budget); reads++; return at < 40 ? [other, row(201, 200)] : [other]; } }), true);
  assert.equal(at, 40); assert.ok(reads >= 3);
  assert.deepEqual(budgets, [1000, 980, 960], 'each synchronous lookup consumes only its remaining deadline');
  at = 0;
  assert.equal(await waitForStopped(subject, { timeoutMs: 9000, now: () => at, delay: async (ms) => { at += ms; }, readTable: () => [other, row(201, 200)] }), false);
  assert.equal(at, 5000, 'caller cannot widen the stop verification limit beyond five seconds');
});

for (const Backend of [ClaudeBackend, CodexBackend, HermesBackend]) {
  test(`${Backend.name}: stale exited flag cannot confirm an observed live CLI identity`, async () => {
    const b = new Backend({ stopGraceMs: 0, interruptWaitMs: 0 });
    // child=null means the backend will not signal anything. The test observer
    // is intentionally still live: a stale exited flag is insufficient proof.
    b.pid = process.pid; b.pgid = process.pid; b.exited = true;
    assert.equal(await b.stop(), false, 'stop result must reject positive live process metadata');
  });
  test(`${Backend.name}: stop returns a verified receipt for owned CLI and detached tool`, async () => {
    const home = fs.realpathSync(testTempDir('px-stop-confirm-'));
    let child, tool, childStart, toolStart;
    try {
      const code = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},100)'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});c.once('message',m=>{if(m==='ready'){c.disconnect();process.stdout.write(c.pid+'\\n');}});setInterval(()=>{},100);`;
      child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: { HOME: home, PATH: process.env.PATH, CODEX_HOME: path.join(home, '.codex') } });
      childStart = lstartOf(child.pid);
      tool = Number(String((await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }))[0]).trim());
      assert.ok(Number.isSafeInteger(tool) && tool > 1, 'disposable tool started');
      childStart ??= lstartOf(child.pid); toolStart = lstartOf(tool);
      assert.ok(childStart && toolStart, 'disposable identities recorded before stopping');
      const owned = { pid: child.pid, pids: [child.pid, tool], groups: [child.pid, tool] };
      const before = ownedSnapshot(owned);
      assert.ok(before.some((r) => r.pid === child.pid && r.pgid === child.pid), 'owned CLI group is ready');
      assert.ok(before.some((r) => r.pid === tool && r.pgid === tool), 'detached tool group is ready');
      const tree = treeGroups(child.pid);
      assert.ok(tree.pids.includes(tool) && tree.groups.includes(tool), 'the tool is a discoverable owned descendant');
      const b = new Backend({ stopGraceMs: 20, interruptWaitMs: 0 });
      Object.assign(b, { child, pid: child.pid, pgid: child.pid, lstart: childStart, exited: false, turnActive: false });
      child.once('exit', () => { b.exited = true; b.emit('exit', {}); });
      b.refreshTree();
      assert.equal(await b.stop(), true, 'stop must return positive verification itself');
      assert.equal(b.alive(), false);
      const receipt = ownedSnapshot(owned);
      assert.ok(receipt.every((r) => !owned.pids.includes(r.pid) || r.stat.startsWith('Z')),
        `owned identities cannot execute in any group at receipt: ${JSON.stringify(receipt)}`);
      assert.equal(await waitForStopped(owned, { timeoutMs: 0, readTable: () => receipt }), true,
        `owned root and tool are already non-executing at receipt: ${JSON.stringify(receipt)}`);
    } finally {
      if (child?.pid && childStart) killTree(child.pid, childStart);
      if (tool && toolStart) killTree(tool, toolStart);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
