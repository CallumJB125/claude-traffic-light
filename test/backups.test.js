const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Backups = require('../src/backups.js');

const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00.000Z');

// A data folder that holds both what is backed up and what must never be.
function fixture(config = { rules: [{ id: 'a' }], presets: [], roam: true }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-test-'));
  const dataDir = path.join(base, 'data');
  const backupsDir = path.join(base, 'Backups');
  fs.mkdirSync(path.join(dataDir, 'cameos'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'usage', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dataDir, 'cameos', 'index.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'cameos', 'dad.png'), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(dataDir, 'usage', 'daily', '2026-09.json'), '{"v":1,"days":{}}');
  // fake secrets, built from fragments so no token-shaped literal is in the file
  const fake = ['not', 'a', 'real', 'secret'].join('-');
  fs.writeFileSync(path.join(dataDir, 'token'), fake);
  fs.writeFileSync(path.join(dataDir, 'approval-secret.json'), `{"k":"${fake}"}`);
  fs.writeFileSync(path.join(dataDir, 'devices.json'), `{"d":"${fake}"}`);
  fs.writeFileSync(path.join(dataDir, 'window-bounds.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'app.log'), 'log');
  fs.writeFileSync(path.join(dataDir, 'usage', 'daily', 'notes.txt'), 'stray');
  for (const d of ['requests', 'sessions', 'owned']) { fs.mkdirSync(path.join(dataDir, d)); fs.writeFileSync(path.join(dataDir, d, 'x.json'), fake); }
  let clock = T0;
  const make = (extra = {}) => Backups.create({ dataDir, backupsDir, now: () => clock, appVersion: '9.9.9', ...extra });
  return { base, dataDir, backupsDir, make, tick: (ms) => { clock += ms; return clock; }, setClock: (t) => { clock = t; },
    setConfig: (c) => fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(c)),
    config: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) };
}
const snapDir = (f, id) => path.join(f.backupsDir, id);

test('a snapshot copies the allow-listed files with a manifest of hashes', () => {
  const f = fixture();
  const r = f.make().snapshot('manual');
  assert.equal(r.taken, true);
  const m = JSON.parse(fs.readFileSync(path.join(snapDir(f, r.id), 'manifest.json'), 'utf8'));
  assert.equal(m.v, 1);
  assert.equal(m.reason, 'manual');
  assert.equal(m.appVersion, '9.9.9');
  assert.equal(m.createdAt, new Date(T0).toISOString());
  assert.deepEqual(m.files.map((x) => x.name), ['config.json', 'cameos/dad.png', 'cameos/index.json', 'usage/daily/2026-09.json']);
  for (const x of m.files) assert.match(x.sha256, /^[0-9a-f]{64}$/);
  assert.equal(m.files.find((x) => x.name === 'cameos/dad.png').size, 4);
});

test('secrets and live state are never copied', () => {
  const f = fixture();
  const r = f.make().snapshot('save');
  const copied = [];
  const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, `${rel}${e.name}/`); else copied.push(`${rel}${e.name}`); } };
  walk(path.join(snapDir(f, r.id), 'files'));
  assert.deepEqual(copied.sort(), ['cameos/dad.png', 'cameos/index.json', 'config.json', 'usage/daily/2026-09.json']);
  const all = fs.readFileSync(path.join(snapDir(f, r.id), 'manifest.json'), 'utf8');
  for (const bad of ['token', 'approval-secret', 'devices', 'requests', 'sessions', 'owned', 'app.log', 'window-bounds', 'notes.txt']) assert.ok(!all.includes(bad), bad);
  assert.equal(Backups.allowed('token'), false);
  assert.equal(Backups.allowed('approval-secret.json'), false);
  assert.equal(Backups.allowed('../config.json'), false);
  assert.equal(Backups.allowed('cameos/../token'), false);
});

test('backup folder 0700, snapshot dirs 0700, files 0600', () => {
  const f = fixture();
  const r = f.make().snapshot('save');
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(f.backupsDir), 0o700);
  assert.equal(mode(snapDir(f, r.id)), 0o700);
  assert.equal(mode(path.join(snapDir(f, r.id), 'files')), 0o700);
  assert.equal(mode(path.join(snapDir(f, r.id), 'manifest.json')), 0o600);
  assert.equal(mode(path.join(snapDir(f, r.id), 'files', 'config.json')), 0o600);
  assert.equal(mode(path.join(snapDir(f, r.id), 'files', 'cameos', 'dad.png')), 0o600);
});

test('no duplicate snapshot when nothing changed, and one when it did', () => {
  const f = fixture();
  const b = f.make();
  assert.equal(b.snapshot('save').taken, true);
  f.tick(1000);
  const again = b.snapshot('save');
  assert.deepEqual([again.taken, again.why], [false, 'unchanged']);
  f.setConfig({ rules: [], roam: false });
  f.tick(1000);
  assert.equal(b.snapshot('save').taken, true);
  assert.equal(b.list().length, 2);
});

test('an empty data folder is not backed up', () => {
  const f = fixture();
  fs.rmSync(f.dataDir, { recursive: true });
  assert.equal(f.make().snapshot('daily').why, 'nothing-to-back-up');
});

test('saves are debounced to one snapshot a minute, and the last one is covered', () => {
  const f = fixture();
  const timers = [];
  const b = f.make({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  assert.equal(b.onSave().taken, true);
  f.setConfig({ rules: [{ id: 'b' }] });
  f.tick(10 * 1000);
  assert.equal(b.onSave().why, 'deferred');
  f.setConfig({ rules: [{ id: 'c' }] });
  f.tick(10 * 1000);
  assert.equal(b.onSave().why, 'deferred');
  assert.equal(timers.length, 1, 'one trailing snapshot is scheduled, not one per save');
  assert.equal(timers[0].ms, 60 * 1000 - 10 * 1000);
  assert.equal(b.list().length, 1);
  f.tick(50 * 1000);
  timers[0].fn();
  const snaps = b.list();
  assert.equal(snaps.length, 2);
  const last = JSON.parse(fs.readFileSync(path.join(snapDir(f, snaps[0].id), 'files', 'config.json'), 'utf8'));
  assert.deepEqual(last.rules, [{ id: 'c' }]);
  f.tick(61 * 1000);
  f.setConfig({ rules: [] });
  assert.equal(b.onSave().taken, true, 'after the window a save is immediate again');
});

test('launch check: snapshots only when the last one is over a day old', () => {
  const f = fixture();
  const b = f.make();
  assert.equal(b.dailyCheck().taken, true);
  f.tick(DAY - 1000);
  assert.equal(b.dailyCheck().why, 'recent');
  f.setConfig({ rules: [{ id: 'z' }] });
  f.tick(2000);
  const r = b.dailyCheck();
  assert.equal(r.taken, true);
  assert.equal(b.list()[0].reason, 'daily');
});

test('retention by age: snapshots over 30 days old go, younger ones stay', () => {
  const f = fixture();
  const b = f.make({ keepNewest: 1 });
  const snaps = [];
  for (let i = 0; i < 4; i++) { f.setConfig({ n: i }); snaps.push(b.snapshot('save').id); f.tick(12 * DAY); }
  // ages now: 48, 36, 24, 12 days
  b.prune();
  assert.deepEqual(b.list().map((s) => s.id), [snaps[3], snaps[2]]);
});

test('keep-five floor holds even when every snapshot is older than 30 days', () => {
  const f = fixture();
  const b = f.make();
  for (let i = 0; i < 7; i++) { f.setConfig({ n: i }); b.snapshot('save'); f.tick(1000); }
  f.tick(90 * DAY);
  b.prune();
  assert.equal(b.list().length, 5);
  assert.deepEqual(b.list().map((s) => JSON.parse(fs.readFileSync(path.join(snapDir(f, s.id), 'files', 'config.json'), 'utf8')).n), [6, 5, 4, 3, 2]);
});

test('retention by size: oldest go first, the newest five stay whatever they weigh', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.dataDir, 'cameos', 'big.png'), Buffer.alloc(1000));
  const b = f.make({ maxBytes: 3500 });
  for (let i = 0; i < 6; i++) { f.setConfig({ n: i }); b.snapshot('save'); f.tick(1000); }
  const left = b.list();
  assert.equal(left.length, 5, 'over the cap, but five are always kept');
  assert.ok(left.every((s) => s.size > 1000));
  assert.equal(JSON.parse(fs.readFileSync(path.join(snapDir(f, left[4].id), 'files', 'config.json'), 'utf8')).n, 1, 'the oldest (n=0) was pruned');
  const one = left[0].size;
  const b2 = f.make({ maxBytes: one * 3 + 10, keepNewest: 2 });
  b2.prune();
  assert.equal(b2.list().length, 3, 'with the floor at two, the cap decides');
});

test('a before-restore snapshot under 7 days old survives age pruning; once older it is pruned like any other', () => {
  const f = fixture();
  const b = f.make({ keepNewest: 1, maxAgeMs: 2 * DAY });
  f.setConfig({ n: 0 });
  const undo = b.snapshot('before-restore', { force: true });
  f.tick(3 * DAY);
  f.setConfig({ n: 1 });
  const plain = b.snapshot('manual');
  f.tick(3 * DAY);
  f.setConfig({ n: 2 });
  b.snapshot('save');
  const ids = b.list().map((s) => s.id);
  assert.ok(ids.includes(undo.id), 'older than max age but under 7 days');
  assert.ok(!ids.includes(plain.id), 'an ordinary snapshot that old is gone');
  f.tick(5 * DAY);
  b.prune();
  assert.ok(!b.list().some((s) => s.id === undo.id), 'over 7 days');
});

test('pruning never deletes the snapshot being restored', () => {
  const f = fixture();
  const b = f.make({ keepNewest: 1, maxAgeMs: DAY });
  f.setConfig({ rules: [{ id: 'keep-me' }] });
  const target = b.snapshot('save');
  f.tick(100 * DAY);
  f.setConfig({ rules: [] });
  const r = b.restore(target.id);
  assert.equal(r.error, undefined);
  assert.deepEqual(f.config().rules, [{ id: 'keep-me' }]);
  assert.ok(b.list().some((s) => s.id === target.id), 'the source outlives the pruning its own before-restore snapshot triggers');
});

test('restore a subset of files', () => {
  const f = fixture({ rules: [{ id: 'old' }] });
  const b = f.make();
  const snap = b.snapshot('save');
  f.tick(1000);
  f.setConfig({ rules: [{ id: 'new' }] });
  fs.writeFileSync(path.join(f.dataDir, 'cameos', 'dad.png'), Buffer.from([9, 9]));
  const r = b.restore(snap.id, { files: ['cameos/dad.png'] });
  assert.deepEqual(r.restored, ['cameos/dad.png']);
  assert.deepEqual([...fs.readFileSync(path.join(f.dataDir, 'cameos', 'dad.png'))], [1, 2, 3, 4]);
  assert.deepEqual(f.config().rules, [{ id: 'new' }], 'the unselected file is untouched');
  assert.equal(r.usage, false);
});

test('restore a subset of config keys keeps the rest of the current config', () => {
  const f = fixture({ rules: [{ id: 'old' }], presets: [{ id: 'p' }], roam: true });
  const b = f.make();
  const snap = b.snapshot('save');
  f.tick(1000);
  f.setConfig({ rules: [{ id: 'new' }], presets: [], roam: false, extra: 1 });
  const r = b.restore(snap.id, { configKeys: ['rules', 'extra'] });
  assert.deepEqual(r.configKeys, ['rules', 'extra']);
  assert.deepEqual(f.config(), { rules: [{ id: 'old' }], presets: [], roam: false }, 'rules come back, extra (absent then) is removed, the others stay');
});

test('restore everything replaces config and files, and takes a before-restore snapshot first', () => {
  const f = fixture({ rules: [{ id: 'old' }] });
  const b = f.make();
  const snap = b.snapshot('save');
  f.tick(1000);
  f.setConfig({ rules: [{ id: 'new' }] });
  const r = b.restore(snap.id);
  assert.deepEqual(f.config().rules, [{ id: 'old' }]);
  const undo = b.list().find((s) => s.id === r.beforeRestoreId);
  assert.equal(undo.reason, 'before-restore');
  const was = JSON.parse(fs.readFileSync(path.join(snapDir(f, undo.id), 'files', 'config.json'), 'utf8'));
  assert.deepEqual(was.rules, [{ id: 'new' }], 'the restore can be undone');
  b.restore(undo.id);
  assert.deepEqual(f.config().rules, [{ id: 'new' }]);
});

test('restore works after the whole data folder was deleted', () => {
  const f = fixture({ rules: [{ id: 'precious' }], router: { on: true } });
  const b = f.make();
  const snap = b.snapshot('save');
  fs.rmSync(f.dataDir, { recursive: true });
  const r = b.restore(snap.id);
  assert.equal(r.error, undefined);
  assert.deepEqual(f.config(), { rules: [{ id: 'precious' }], router: { on: true } });
  assert.ok(fs.existsSync(path.join(f.dataDir, 'cameos', 'dad.png')));
  assert.equal(fs.statSync(path.join(f.dataDir, 'config.json')).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(f.dataDir, 'usage', 'daily', '2026-09.json')));
  assert.equal(r.usage, true);
  assert.equal(b.list().find((s) => s.id === r.beforeRestoreId).files, 0, 'the undo snapshot of an empty folder is empty, not missing');
  assert.ok(!fs.existsSync(path.join(f.dataDir, 'token')), 'secrets are not resurrected');
});

test('diff names which files and which config keys differ, in words', () => {
  const f = fixture({ rules: [{ id: 'a' }], presets: [], roam: true });
  const b = f.make();
  const snap = b.snapshot('save');
  assert.equal(b.diff(snap.id).same, true);
  f.setConfig({ rules: [{ id: 'b' }], presets: [], roam: true, brandNew: 1 });
  fs.rmSync(path.join(f.dataDir, 'cameos', 'dad.png'));
  fs.writeFileSync(path.join(f.dataDir, 'cameos', 'mum.png'), 'x');
  const d = b.diff(snap.id);
  assert.deepEqual(d.configKeys.map((k) => [k.key, k.status]), [['brandNew', 'only-now'], ['rules', 'changed']]);
  assert.ok(d.files.some((x) => x.name === 'config.json' && x.status === 'changed' && /Your settings and rules/.test(x.say)));
  assert.ok(d.files.some((x) => x.name === 'cameos/dad.png' && x.status === 'missing-now' && /Face photo dad/.test(x.say)));
  assert.ok(d.files.some((x) => x.name === 'cameos/mum.png' && x.status === 'only-now'));
  assert.equal(d.same, false);
});

test('corrupt snapshots are listed as damaged and never restored; the rest still work', () => {
  const f = fixture({ rules: [{ id: 'v1' }] });
  const b = f.make();
  const good = b.snapshot('save');
  f.tick(1000); f.setConfig({ rules: [{ id: 'v2' }] });
  const badHash = b.snapshot('save');
  f.tick(1000); f.setConfig({ rules: [{ id: 'v3' }] });
  const trunc = b.snapshot('save');
  f.tick(1000); f.setConfig({ rules: [{ id: 'v4' }] });
  const missing = b.snapshot('save');
  f.tick(1000); f.setConfig({ rules: [{ id: 'v5' }] });
  const badManifest = b.snapshot('save');
  f.tick(1000); f.setConfig({ rules: [{ id: 'v6' }] });
  const healthy = b.snapshot('save');

  fs.writeFileSync(path.join(snapDir(f, badHash.id), 'files', 'config.json'), fs.readFileSync(path.join(snapDir(f, badHash.id), 'files', 'config.json'), 'utf8').replace('v2', 'xx'));
  fs.writeFileSync(path.join(snapDir(f, trunc.id), 'files', 'config.json'), '{"rul');
  fs.rmSync(path.join(snapDir(f, missing.id), 'files', 'cameos', 'dad.png'));
  fs.writeFileSync(path.join(snapDir(f, badManifest.id), 'manifest.json'), '{not json');

  const byId = Object.fromEntries(b.list().map((s) => [s.id, s]));
  for (const s of [badHash, trunc, missing, badManifest]) assert.equal(byId[s.id].damaged, true, s.id);
  assert.match(byId[trunc.id].problems.join(), /cut short/);
  assert.match(byId[missing.id].problems.join(), /missing/);
  assert.match(byId[badHash.id].problems.join(), /changed or corrupted/);
  assert.equal(byId[good.id].damaged, false);
  assert.equal(byId[healthy.id].damaged, false);

  const before = fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8');
  const nBefore = b.list().length;
  for (const s of [badHash, trunc, missing, badManifest]) {
    const r = b.restore(s.id);
    assert.match(r.error, /damaged/);
    assert.equal(b.diff(s.id).error !== undefined, true);
  }
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8'), before, 'a damaged restore changes nothing');
  assert.equal(b.list().length, nBefore, 'and takes no before-restore snapshot');
  assert.equal(b.restore(good.id).error, undefined);
  assert.deepEqual(f.config().rules, [{ id: 'v1' }]);
});

test('a manifest naming a path outside the allow-list is treated as damaged', () => {
  const f = fixture();
  const b = f.make();
  const s = b.snapshot('save');
  const mp = path.join(snapDir(f, s.id), 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.files.push({ name: '../../escape.json', sha256: 'a'.repeat(64), size: 1 });
  fs.writeFileSync(mp, JSON.stringify(m));
  assert.equal(b.list()[0].damaged, true);
  assert.match(b.restore(s.id).error, /damaged/);
});

test('atomic write: a crash mid-snapshot leaves nothing that looks complete', () => {
  const f = fixture();
  const crashing = { ...fs, renameSync: () => { throw new Error('simulated crash'); } };
  const b = f.make({ fs: crashing });
  assert.equal(b.dailyCheck().why, 'error');
  assert.deepEqual(f.make().list(), [], 'no snapshot is listed');
  const leftovers = fs.readdirSync(f.backupsDir);
  assert.ok(leftovers.every((n) => n.startsWith('.tmp-')), `only a tmp dir remains: ${leftovers}`);
  assert.ok(!fs.existsSync(path.join(f.backupsDir, leftovers[0], 'nonexistent')));
  const ok = f.make();
  assert.equal(ok.snapshot('save').taken, true, 'the next run succeeds');
  assert.ok(fs.readdirSync(f.backupsDir).every((n) => !n.startsWith('.tmp-')), 'and sweeps the leftover');
});

test('a half-written snapshot directory (no manifest) shows as damaged, not as a good backup', () => {
  const f = fixture();
  const b = f.make();
  fs.mkdirSync(path.join(f.backupsDir, '2026-10-01T11-00-00.000Z', 'files'), { recursive: true });
  const [s] = b.list();
  assert.equal(s.damaged, true);
  assert.equal(s.reason, null);
});

test('the same millisecond twice gets two snapshots', () => {
  const f = fixture();
  const b = f.make();
  b.snapshot('save');
  f.setConfig({ rules: [{ id: 'q' }] });
  const r = b.snapshot('manual');
  assert.equal(r.taken, true);
  assert.equal(b.list().length, 2);
});

test('main wiring: every destructive action snapshots first, every backups IPC checks its sender', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const channel of ['reset-rules', 'cameos-remove', 'setup-import-apply']) {
    const at = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at > 0, channel);
    assert.match(main.slice(at, at + 400), /backupFirst\(\)/, `${channel} must take a backup first`);
  }
  const handlers = [...main.matchAll(/ipcMain\.handle\('(backups-[a-z-]+)'[^\n]*\n([^\n]*\n){0,2}/g)];
  assert.equal(handlers.length, 5);
  for (const m of handlers) assert.match(m[0], /backupsSenderOk\(e\)/, `${m[1]} must check its sender`);
});
