// Durable outbox (per-device seq, replay, torn tail) and supervisor-restart
// orphan handling (pid + lstart match → stop recipe → run.failed{supervisor crash}).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Outbox } from '../outbox.js';
import { lstartOf } from '../procs.js';
import { serializeOutbound } from '../../shared/scope.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, waitFor, alive, REPO_ID } from './helpers.js';

const scope = { repo_id: REPO_ID, toplevel: '/x' };
const msg = (i) => serializeOutbound({ kind: 'progress.append', run_id: 'r', card_id: 'c', fence: 1, repo_id: REPO_ID, text: `p${i}` }, scope, { requireRepoId: true });

test('outbox: seq strictly increasing and persisted; acked entries dropped; torn tail ignored; frames carry the exact bytes', () => {
  const dir = tmpDir();
  try {
    const ob = new Outbox(dir, 'dev-1');
    const a = ob.append(msg(1));
    const b = ob.append(msg(2), { offline: true });
    assert.deepEqual([a.seq, b.seq], [1, 2]);
    assert.equal(Outbox.frame(b, true), `{"type":"out","seq":2,"delayed":true,"msg":${msg(2)}}`);
    fs.appendFileSync(ob.file, '{"seq":3,"offline":false,"msg":{"kind":"tor');   // crash mid-append
    const ob2 = new Outbox(dir, 'dev-1');
    assert.equal(ob2.head, 2);
    assert.deepEqual(ob2.pendingAfter(0).map((e) => e.seq), [1, 2]);
    assert.equal(ob2.pendingAfter(0)[1].offline, true);
    ob2.ack(1);
    const c = ob2.append(msg(3));
    assert.equal(c.seq, 3, 'seq never reused');
    const ob3 = new Outbox(dir, 'dev-1');
    assert.deepEqual(ob3.pendingAfter(ob3.acked).map((e) => e.seq), [2, 3]);
    ob3.ack(3);
    const ob4 = new Outbox(dir, 'dev-1');
    assert.equal(ob4.head, 3);
    assert.equal(ob4.entries.length, 0);
    assert.equal(ob4.append(msg(4)).seq, 4);
    assert.throws(() => ob4.append({ kind: 'x' }), /serialized bytes/);
    assert.equal(fs.statSync(ob4.file).mode & 0o777, 0o600);
  } finally { rm(dir); }
});

test('restart: an orphaned CLI (pid + lstart match) and its tool group are killed; run.failed{supervisor crash} is sent; a recycled pid is left alone', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // A "claude" left behind by a crashed supervisor, with a detached tool grandchild.
  const orphan = spawn('/bin/sh', ['-c', `trap '' TERM; '${process.execPath}' -e "require('child_process').spawn('/bin/sleep',['300'],{detached:true,stdio:'ignore'}).unref(); setInterval(()=>{},1000)"`], { detached: true, stdio: 'ignore' });
  orphan.unref();
  const other = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
  other.unref();
  await waitFor(() => lstartOf(orphan.pid) && lstartOf(other.pid), { what: 'lstart' });
  const ledger = { runs: {
    'run-o': { run_id: 'run-o', card_id: 'card-o', key: 'O-1', fence: 7, repo_id: REPO_ID, pid: orphan.pid, lstart: lstartOf(orphan.pid), worktree: repo.checkout, scope: { repo_id: REPO_ID, toplevel: repo.checkout } },
    'run-p': { run_id: 'run-p', card_id: 'card-p', key: 'P-1', fence: 2, repo_id: REPO_ID, pid: other.pid, lstart: 'Thu Jan  1 00:00:00 1970', worktree: null, scope: { repo_id: REPO_ID, toplevel: repo.checkout } },
  } };
  fs.writeFileSync(path.join(home, 'ledger.json'), JSON.stringify(ledger));
  const sup = await startRunner({ hub, home, repo, scenario: null });
  try {
    assert.ok(!alive(orphan.pid), 'orphan killed');
    assert.ok(alive(other.pid), 'a recycled pid is not ours');
    await waitFor(() => hub.outs('run.failed').length === 2, { what: 'two run.failed replayed' });
    const byRun = Object.fromEntries(hub.outs('run.failed').map((m) => [m.run_id, m]));
    assert.equal(byRun['run-o'].reason, 'supervisor crash');
    assert.equal(byRun['run-o'].fence, 7);
    assert.equal(byRun['run-p'].fail_kind, 'error');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'ledger.json'), 'utf8')).runs, {});
    // They were written while disconnected, so they replay as delayed.
    assert.ok(hub.of('out').filter((f) => f.msg.kind === 'run.failed').every((f) => f.delayed === true));
  } finally {
    try { process.kill(other.pid, 'SIGKILL'); } catch { /* gone */ }
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
