import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TaskStore } from '../store.js';
import { tmpDir, rm } from './helpers.js';

const task = (id, state = 'queued') => ({ id, state, spec: { text: 'x', cwd: '/tmp' } });
const ev = (seq, taskId = 'tsk_000000000001', type = 'state') => ({ type, seq, taskId, state: 'queued' });

test('store: 0700 dir, 0600 files; tasks last-write-wins; events in seq order across reloads', () => {
  const dir = tmpDir();
  try {
    const s = new TaskStore(path.join(dir, 'store'));
    s.load();
    s.saveTask(task('tsk_000000000001'));
    s.saveTask(task('tsk_000000000001', 'running'));
    s.saveTask(task('tsk_000000000002'));
    for (let i = 1; i <= 5; i++) s.appendEvent(ev(i), 1000 + i);
    s.close();
    assert.equal(fs.statSync(path.join(dir, 'store')).mode & 0o777, 0o700);
    for (const f of ['tasks.jsonl', 'events.jsonl']) assert.equal(fs.statSync(path.join(dir, 'store', f)).mode & 0o777, 0o600);
    const s2 = new TaskStore(path.join(dir, 'store'));
    const { tasks, events, lastSeq } = s2.load();
    assert.equal(tasks.get('tsk_000000000001').state, 'running');
    assert.equal(tasks.size, 2);
    assert.deepEqual(events.map((x) => x.e.seq), [1, 2, 3, 4, 5]);
    assert.equal(lastSeq, 5);
    s2.close();
  } finally { rm(dir); }
});

test('store: a torn last line, garbage lines and out-of-order seqs are skipped; the next append is clean', () => {
  const dir = tmpDir();
  try {
    const s = new TaskStore(dir);
    s.load();
    s.appendEvent(ev(1), 1);
    s.appendEvent(ev(2), 2);
    s.saveTask(task('tsk_000000000001'));
    s.close();
    fs.appendFileSync(path.join(dir, 'events.jsonl'), 'not json\n{"at":3,"e":{"type":"state","seq":1,"taskId":"tsk_000000000001"}}\n{"at":4,"e":{"type":"evil","seq":9,"taskId":"t"}}\n{"at":5,"e":{"type":"state","se');
    fs.appendFileSync(path.join(dir, 'tasks.jsonl'), '{"task":{"id":"../../etc","state":"queued","spec":{}}}\n{"task":{"id":"tsk_000000000003","state":"bogus","spec":{}}}\n{"task":{"id":"tsk_00');
    const s2 = new TaskStore(dir);
    const { tasks, events, lastSeq } = s2.load();
    assert.deepEqual([...tasks.keys()], ['tsk_000000000001']);
    assert.deepEqual(events.map((x) => x.e.seq), [1, 2]);
    assert.equal(lastSeq, 2);
    s2.appendEvent(ev(3), 6);
    s2.saveTask(task('tsk_000000000004'));
    s2.close();
    const s3 = new TaskStore(dir);
    const r = s3.load();
    assert.deepEqual(r.events.map((x) => x.e.seq), [1, 2, 3]);
    assert.ok(r.tasks.has('tsk_000000000004'));
    s3.close();
  } finally { rm(dir); }
});

test('store: the event log is compacted to the ring size; tasks to one line each', () => {
  const dir = tmpDir();
  try {
    const s = new TaskStore(dir, { ringEvents: 10 });
    s.load();
    const ring = [];
    for (let i = 1; i <= 25; i++) {
      const rec = { at: i, e: ev(i) };
      ring.push(rec);
      s.appendEvent(rec.e, rec.at, ring);
    }
    const live = new Map([['tsk_000000000001', task('tsk_000000000001')]]);
    for (let i = 0; i < 300; i++) s.saveTask(live.get('tsk_000000000001'), live);
    s.close();
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.ok(lines.length <= 20, `events compacted (${lines.length})`);
    assert.ok(fs.readFileSync(path.join(dir, 'tasks.jsonl'), 'utf8').trim().split('\n').length < 300);
    const s2 = new TaskStore(dir, { ringEvents: 10 });
    const r = s2.load();
    assert.equal(r.lastSeq, 25);
    assert.deepEqual(r.events.map((x) => x.e.seq), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    s2.close();
  } finally { rm(dir); }
});
