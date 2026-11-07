// D2: a helper stuck behind a prompt answers a hello after main has already told the caller it failed. That late
// answer used to be traced as "ok"; main passes how long it waits (caller.timeout_ms) and the helper traces a later
// answer as an error with reason TIMEOUT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createAgentBus } from '../bus/dispatcher.js';
import { tmpDir, rm, makeRepo } from './helpers.js';

test('a hello answered after main stopped waiting is traced as a TIMEOUT error; one in time is ok', async () => {
  const dir = tmpDir('pxtt-');
  const root = fs.realpathSync(makeRepo(dir).checkout);
  const engine = new EventEmitter();
  engine.tasks = new Map();
  engine.git = async () => `${root}\n`;
  engine.busPolicy = () => ({ bus: null, repos: { [root]: { bus_auto: true } } });
  engine.busRepoAllowed = async () => true;
  // Every read of the clock moves it 1 s: an op spans at least that.
  let t = Date.parse('2026-11-07T10:00:00Z');
  const bus = createAgentBus({ engine, dataDir: dir, now: () => (t += 1000) });
  try {
    await bus.op('busSetContext', {});
    await bus.op('hello', { provider: 'claude' }, { provider: 'claude', cwd: root, timeout_ms: 500 });
    await bus.op('hello', { provider: 'claude' }, { provider: 'claude', cwd: root, timeout_ms: 600_000 });
    await bus.trace.flush();
    const hellos = fs.readFileSync(`${dir}/bus-trace.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.op === 'hello');
    assert.deepEqual(hellos.map((l) => [l.result, l.reason]), [['error', 'TIMEOUT'], ['ok', null]]);
  } finally { bus.close(); rm(dir); }
});

test('a hand-off answered after main stopped waiting is deferred, not a failure: it was posted and runs', async () => {
  const dir = tmpDir('pxtt-');
  const root = fs.realpathSync(makeRepo(dir).checkout);
  const engine = new EventEmitter();
  engine.tasks = new Map();
  engine.git = async () => `${root}\n`;
  engine.busPolicy = () => ({ bus: null, repos: { [root]: { bus_auto: true } } });
  engine.busRepoAllowed = async () => true;
  let t = Date.parse('2026-11-07T10:00:00Z');
  const bus = createAgentBus({ engine, dataDir: dir, now: () => (t += 1000) });
  try {
    await bus.op('busSetContext', {});
    const r = await bus.op('handoff', { request_id: 'req-00000001', title: 'Check the tests', brief: 'Run them.', to: { provider: 'codex' } },
      { provider: 'claude', cwd: root, timeout_ms: 500 }).then((x) => x, (e) => ({ thrown: e.code }));
    await bus.trace.flush();
    const lines = fs.readFileSync(`${dir}/bus-trace.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.op === 'handoff');
    assert.ok(r.handoff_id, `posted: ${JSON.stringify(r)}`);
    assert.deepEqual(lines.map((l) => [l.result, l.reason]), [['deferred', 'TIMEOUT']]);
  } finally { bus.close(); rm(dir); }
});
