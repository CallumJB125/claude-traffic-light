// bus.db (AGENT-BUS.md §3): append with one monotonic offset, consumer offsets,
// the claim CAS with a fence, (source, request_id) and content dedupe, retention.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openBusLog, RETENTION_MS } from '../bus/local-log.js';
import { tmpDir, rm } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const ev = (topic, kind, extra = {}) => ({ v: 1, topic, kind, handoff_id: 'hof_aaaaaaaaaaaaaaaa', source: { agent_id: 'claude:local:x' }, card_id: null, repo: { root: '/r' }, hop: 1, visited: [], created_at: extra.at ?? Date.now(), expires_at: (extra.at ?? Date.now()) + DAY, ...extra });

function open(now = Date.now) {
  const dir = tmpDir('pxbl-');
  const file = path.join(dir, 'bus.db');
  return { dir, file, log: openBusLog(file, { now }) };
}

test('append: offsets are monotonic, events read back in order by topic and card, file is 0600', () => {
  const { dir, file, log } = open();
  try {
    const a = log.append(ev('handoff', 'handoff.offer'));
    const b = log.append(ev('claim', 'claim.granted'));
    const c = log.append(ev('result', 'result.done', { card_id: 'card-1' }));
    assert.deepEqual([a.offset, b.offset, c.offset], [1, 2, 3]);
    assert.match(a.id, /^evt_[a-f0-9]{20}$/);
    assert.deepEqual(log.read({ topics: ['handoff', 'result'] }).map((e) => e.offset), [1, 3]);
    assert.deepEqual(log.read({ topics: ['result'], cardId: 'card-1' }).map((e) => e.kind), ['result.done']);
    assert.deepEqual(log.read({ topics: ['handoff', 'claim', 'result'], after: 1, limit: 1 }).map((e) => e.offset), [2]);
    assert.deepEqual(log.chain('hof_aaaaaaaaaaaaaaaa').map((e) => e.kind), ['handoff.offer', 'claim.granted', 'result.done']);
    assert.equal(log.result('hof_aaaaaaaaaaaaaaaa').kind, 'result.done');
    assert.equal(log.head(), 3);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { log.close(); rm(dir); }
});

test('dedupe: (source, request_id) is unique; the same content within the window is found', () => {
  const { dir, log } = open();
  try {
    log.append(ev('handoff', 'handoff.offer'), { requestKey: 'claude:local:x|req-0001', dedupeKey: 'd1' });
    assert.throws(() => log.append(ev('handoff', 'handoff.offer'), { requestKey: 'claude:local:x|req-0001' }), /UNIQUE/);
    assert.equal(log.byRequest('claude:local:x|req-0001').handoff_id, 'hof_aaaaaaaaaaaaaaaa');
    assert.ok(log.byDedupe('d1', Date.now() - 1000));
    assert.equal(log.byDedupe('d1', Date.now() + 1000), null, 'outside the window');
  } finally { log.close(); rm(dir); }
});

test('claim CAS: one fence per handoff; a reopened claim gets fence + 1; a stale fence changes nothing', () => {
  const { dir, log } = open();
  try {
    assert.deepEqual(log.claim('hof_1', 'dev', 120000), { fence: 1 });
    assert.equal(log.claim('hof_1', 'dev', 120000), null, 'exactly one start');
    assert.equal(log.setClaim('hof_1', 2, { state: 'started' }), false, 'stale fence');
    assert.equal(log.setClaim('hof_1', 1, { state: 'reopened' }), true);
    assert.deepEqual(log.claim('hof_1', 'dev', 120000), { fence: 2 });
    assert.equal(log.claimOf('hof_1').state, 'granted');
    assert.deepEqual(log.openClaims().map((c) => c.handoff_id), ['hof_1']);
  } finally { log.close(); rm(dir); }
});

test('consumer offsets start at the head (or 0 when asked) and only move forward; dead letters are kept', () => {
  const { dir, log } = open();
  try {
    log.append(ev('handoff', 'handoff.offer'));
    log.append(ev('handoff', 'handoff.offer', { handoff_id: 'hof_b' }));
    assert.equal(log.offsetOf('ui', 'handoff'), 2);
    assert.equal(log.offsetOf('dispatcher', 'handoff', { fromHead: false }), 0);
    log.advance('dispatcher', 'handoff', 2);
    log.advance('dispatcher', 'handoff', 1);
    assert.equal(log.offsetOf('dispatcher', 'handoff'), 2);
    log.deadLetter(1, 'dispatcher', 'boom');
  } finally { log.close(); rm(dir); }
});

test('retention: 30 days for handoff/claim/result, 90 for control; spend and hops by day', () => {
  let t = Date.now();
  const { dir, log } = open(() => t);
  try {
    const old = t - 31 * DAY;
    log.append(ev('handoff', 'handoff.offer', { at: old }));
    log.append(ev('result', 'result.done', { at: old }));
    log.append(ev('control', 'control.halt', { at: old }));
    log.append(ev('control', 'control.resume', { at: t - 91 * DAY }));
    log.append(ev('handoff', 'handoff.offer', { handoff_id: 'hof_new' }));
    log.sweep();
    assert.deepEqual(log.recent(10).map((e) => e.kind).sort(), ['control.halt', 'handoff.offer']);
    assert.equal(RETENTION_MS.control, 90 * DAY);
    log.reserve('2026-10-22', 5);
    log.settle('2026-10-22', 5, 1.25);
    assert.deepEqual({ ...log.spend('2026-10-22') }, { reserved: 0, spent: 1.25 });
    log.consumed('claude:local:x', 2, t - 3600_000);
    log.consumed('claude:local:x', 1, t - 3600_000);
    assert.equal(log.hopOf('claude:local:x', t - 3600_000), 2, 'only the highest hop is kept');
    t += 2 * 3600_000;
    assert.equal(log.hopOf('claude:local:x', t - 3600_000), 0, 'an hour later it no longer counts');
  } finally { log.close(); rm(dir); }
});
