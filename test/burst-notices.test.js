const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBurstNotices, normalizeNotices, normalizeAudit, noticesPath } = require('../src/burst-notices.js');
const { gate } = require('../src/burst-events.js');

const NOW = Date.parse('2026-10-07T10:00:00Z');
const ev = (id, o = {}) => ({ id, kind: 'failover', severity: 'warn', title: `T${id}`, detail: `D${id}`, at: new Date(NOW - 1000).toISOString(), ts: Math.floor(NOW / 1000), ...o });

function rig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notices-'));
  const file = path.join(dir, 'notices.json');
  const sent = []; const closed = [];
  const write = (events) => fs.writeFileSync(file, JSON.stringify({ events }));
  const n = createBurstNotices({ file, isMac: true, now: () => NOW, onEvents: (e) => sent.push(...e), onResolve: (k) => closed.push(k), ...o });
  return { n, file, sent, closed, write };
}

test('noticesPath', () => assert.equal(noticesPath('/h'), '/h/.config/claude-burst/notices.json'));

test('three events become three notifications; the same file again adds none', async () => {
  const r = rig();
  r.write([ev('1'), ev('2', { kind: 'network', severity: 'error', session: 's9' }), ev('3', { kind: 'update', severity: 'info' })]);
  await r.n.check();
  assert.deepEqual(r.sent.map((e) => e.key), ['burst:1', 'burst:2', 'burst:3']);
  assert.deepEqual(r.sent[1], { key: 'burst:2', title: 'T2', body: 'D2', severity: 'error', session: 's9' });
  assert.equal(r.n.active(), true);
  r.write([ev('1'), ev('2', { kind: 'network', severity: 'error', session: 's9' }), ev('3', { kind: 'update', severity: 'info' })]);
  await r.n.check();
  assert.equal(r.sent.length, 3);
  r.write([ev('1'), ev('4')]);
  await r.n.check();
  assert.deepEqual(r.sent.map((e) => e.key).slice(3), ['burst:4']);
});

test('an event with resolves closes the earlier key of that kind and is not itself shown', async () => {
  const r = rig();
  r.write([ev('1', { kind: 'bypass', severity: 'error' }), ev('2', { kind: 'failover' })]);
  await r.n.check();
  r.write([ev('1', { kind: 'bypass', severity: 'error' }), ev('2', { kind: 'failover' }), ev('3', { kind: 'bypass', severity: 'ok', resolves: 'bypass' })]);
  await r.n.check();
  assert.deepEqual(r.closed, ['burst:1']);
  assert.equal(r.sent.length, 2);
});

test('audit_only never notifies', async () => {
  const r = rig();
  r.write([ev('1', { audit_only: true })]);
  await r.n.check();
  assert.deepEqual(r.sent, []);
});

test('history already old at first read is not replayed', async () => {
  const r = rig();
  r.write([ev('1', { at: new Date(NOW - 3600000).toISOString() }), ev('2')]);
  await r.n.check();
  assert.deepEqual(r.sent.map((e) => e.key), ['burst:2']);
});

test('absent or unreadable file: not active, no events, no throw', async () => {
  const r = rig();
  await r.n.check();
  assert.equal(r.n.active(), false);
  fs.writeFileSync(r.file, '{not json');
  await r.n.check();
  assert.equal(r.n.active(), false);
  assert.deepEqual(r.sent, []);
});

test('not macOS: never active and never reads', async () => {
  const r = rig({ isMac: false });
  r.write([ev('1')]);
  await r.n.check();
  assert.equal(r.n.active(), false);
  assert.deepEqual(r.sent, []);
});

test('spend kinds are held back once Plexiform has a budget of its own', async () => {
  const r = rig({ config: () => ({ spend: { dailyBudget: 50 } }) });
  r.write([ev('1', { kind: 'spend' }), ev('2')]);
  await r.n.check();
  assert.deepEqual(r.sent.map((e) => e.key), ['burst:2']);
  const r2 = rig({ config: () => ({}) });
  r2.write([ev('1', { kind: 'spend' })]);
  await r2.n.check();
  assert.equal(r2.sent.length, 1);
});

test('session events stand aside only when the band toasts are on and the session is Ghostty', async () => {
  const mk = (modStatus, ghostty) => rig({ burst: () => ({ read: async () => modStatus }), isGhostty: (s) => ghostty.includes(s) });
  const rows = [ev('1', { session: 'g' }), ev('2', { session: 'x' }), ev('3')];
  const on = mk({ installed: true, toasts: true }, ['g']);
  on.write(rows); await on.n.check();
  assert.deepEqual(on.sent.map((e) => e.key), ['burst:2', 'burst:3']);
  const off = mk({ installed: true, toasts: false }, ['g']);
  off.write(rows); await off.n.check();
  assert.equal(off.sent.length, 3);
  const none = rig({ burst: () => ({ read: async () => ({ installed: true, toasts: true }) }) });
  none.write(rows); await none.n.check();
  assert.equal(none.sent.length, 3, 'without a Ghostty lookup nothing is suppressed');
});

test('quiet hours hold these like any other Burst event', () => {
  const events = [{ key: 'burst:1', title: 't', body: 'b', severity: 'warn', session: '' }];
  const cfg = { quietHours: { enabled: true, start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } };
  const g = gate(events, cfg, new Date(2026, 9, 7, 12, 0).getTime());
  assert.equal(g.send.length, 0); assert.equal(g.held.length, 1);
});

test('normalizeNotices: severities, caps, junk dropped; normalizeAudit: newest first, at most 50', () => {
  const n = normalizeNotices({ events: [ev('1', { severity: 'ok', resolves: 'failover' }), { id: 'x' }, null, ev('2', { title: 'x'.repeat(500) })] });
  assert.equal(n.length, 2);
  assert.equal(n[0].severity, 'info'); assert.equal(n[0].resolves, 'failover'); assert.equal(n[0].at, NOW - 1000);
  assert.equal(n[1].title.length, 200);
  assert.deepEqual(normalizeNotices(null), []);
  const a = normalizeAudit({ events: Array.from({ length: 70 }, (_, i) => ev(String(i), { at: new Date(NOW + i).toISOString(), audit_only: i === 69 })) });
  assert.equal(a.length, 50); assert.equal(a[0].source, 'action'); assert.ok(a[0].at > a[1].at);
});
