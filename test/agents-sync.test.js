const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const { syncAgentFiles, createAgentsSync } = require('../src/agents-sync.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sync-'));

test('syncAgentFiles merges the scan into each session file and skips unchanged ones', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId: 'a', cwd: '/x' }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ sessionId: 'b', cwd: '/y', agents: [], mode: null, iteration: 0 }));
  fs.writeFileSync(path.join(dir, 'not-a-session.json'), '{}');
  const Agents = {
    readJson: (f) => JSON.parse(fs.readFileSync(f, 'utf8')),
    scanAgents: (s) => (s.sessionId === 'a' ? { mode: 'ralph', iteration: 2, agents: [{ id: 'm1' }] } : { mode: null, iteration: 0, agents: [] }),
    mergeAgents: (existing, found) => [...(existing || []), ...found],
  };
  const writes = [];
  const n = syncAgentFiles({ sessionsDir: dir, Agents, writeMerged: (file, obj, readAt) => { writes.push({ file: path.basename(file), obj, readAt }); return true; } });
  assert.equal(n, 1);
  assert.deepEqual(writes.map((w) => w.file), ['a.json']);
  assert.deepEqual(writes[0].obj, { sessionId: 'a', cwd: '/x', agents: [{ id: 'm1' }], mode: 'ralph', iteration: 2 });
  assert.equal(typeof writes[0].readAt, 'number');
  assert.equal(syncAgentFiles({ sessionsDir: path.join(dir, 'missing'), Agents, writeMerged: () => true }), 0);
});

function fakeWorker() {
  const w = new EventEmitter();
  w.posted = 0;
  w.postMessage = () => { w.posted += 1; };
  w.terminate = () => { w.terminated = true; };
  return w;
}

test('createAgentsSync never queues a pass behind a stuck one, and logs once when stuck', () => {
  let t = 0;
  const logs = [];
  const w = fakeWorker();
  const sync = createAgentsSync({ startWorker: () => w, runInline: () => assert.fail('no inline scan with a worker'), log: (m) => logs.push(m), now: () => t, stuckMs: 10000 });
  sync.tick();
  assert.equal(w.posted, 1);
  t = 4000; sync.tick();
  t = 12000; sync.tick();
  t = 14000; sync.tick();
  assert.equal(w.posted, 1, 'a stuck pass is not stacked on');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /scan stuck for 12 s/);
  t = 15000; w.emit('message', { type: 'scanned' });
  assert.match(logs[1], /scan finished after 15 s/);
  sync.tick();
  assert.equal(w.posted, 2);
  sync.stop();
  assert.equal(w.terminated, true);
});

test('createAgentsSync scans inline when there is no worker, or the worker dies', () => {
  let inline = 0;
  const logs = [];
  const none = createAgentsSync({ startWorker: () => { throw new Error('no workers here'); }, runInline: () => { inline += 1; }, log: (m) => logs.push(m) });
  none.tick(); none.tick();
  assert.equal(inline, 2);
  assert.match(logs[0], /no scan worker/);

  const w = fakeWorker();
  const dies = createAgentsSync({ startWorker: () => w, runInline: () => { inline += 1; }, log: (m) => logs.push(m) });
  dies.tick();
  w.emit('error', new Error('boom'));
  dies.tick();
  assert.equal(inline, 3);
  assert.equal(dies.busy(), false);
});

// The launch stall: a session whose project folder blocks open() (as macOS does
// while a Desktop/Documents privacy prompt is up; a FIFO with no writer blocks
// the same way). The scan must hold up only its worker, never this thread.
test('a blocked project-folder read stalls only the scan worker, not the main thread', { skip: process.platform === 'win32' }, async () => {
  const root = tmp();
  const sessionsDir = path.join(root, 'sessions');
  const stateDir = path.join(root, 'proj', '.omc', 'state');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const fifo = path.join(stateDir, 'subagent-tracking.json');
  execFileSync('mkfifo', [fifo]);
  const session = path.join(sessionsDir, 's1.json');
  fs.writeFileSync(session, JSON.stringify({ sessionId: 's1', cwd: path.join(root, 'proj'), agents: [{ id: 'ag1', kind: 'subagent', source: 'hook' }] }));

  const worker = new Worker(path.join(__dirname, '..', 'src', 'agents-worker.js'), { workerData: { sessionsDir } });
  const done = new Promise((resolve) => worker.once('message', resolve));
  const sync = createAgentsSync({ startWorker: () => worker, runInline: () => assert.fail('inline') });
  try {
    sync.tick();
    worker.ref(); // createAgentsSync unrefs it; the test must wait on it
    // The main thread keeps running timers while the worker sits in open().
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(Date.now() - started < 2000);
    assert.equal(sync.busy(), true);
    // Answer the "prompt": a writer appears with the tracking file's contents.
    fs.writeFileSync(fifo, JSON.stringify({ agents: [{ agent_id: 'ag1', agent_type: 'oh-my-claudecode:executor', parent_mode: 'ultrawork', status: 'running' }] }));
    const msg = await done;
    assert.equal(msg.error, null);
    assert.equal(sync.busy(), false);
    const merged = JSON.parse(fs.readFileSync(session, 'utf8'));
    assert.equal(merged.agents.length, 1);
    assert.equal(merged.agents[0].id, 'ag1');
    assert.equal(merged.agents[0].source, 'hook');
  } finally {
    await worker.terminate();
  }
});
