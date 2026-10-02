const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Backups = require('../src/backups.js');
const Rules = require('../rules.js');

const DAY = 86400000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (...tail) => Buffer.concat([PNG, Buffer.from(tail)]);
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
  fs.writeFileSync(path.join(dataDir, 'cameos', 'dad.png'), png(1, 2, 3, 4));
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
  assert.equal(m.files.find((x) => x.name === 'cameos/dad.png').size, 12);
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
  fs.writeFileSync(path.join(f.dataDir, 'cameos', 'big.png'), Buffer.concat([PNG, Buffer.alloc(992)]));
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
  fs.writeFileSync(path.join(f.dataDir, 'cameos', 'dad.png'), png(9, 9));
  const r = b.restore(snap.id, { files: ['cameos/dad.png'] });
  assert.deepEqual(r.restored, ['cameos/dad.png']);
  assert.deepEqual([...fs.readFileSync(path.join(f.dataDir, 'cameos', 'dad.png')).subarray(8)], [1, 2, 3, 4]);
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
  assert.deepEqual(r.configKeys, ['rules'], 'a key the backup lacks is not touched');
  assert.deepEqual(f.config(), { rules: [{ id: 'old' }], presets: [], roam: false, extra: 1 }, 'rules come back; extra and the others stay');
  const r2 = b.restore(snap.id, { configKeys: ['extra'], removeAbsent: true });
  assert.deepEqual(r2.configKeys, ['extra']);
  assert.equal('extra' in f.config(), false, 'only an explicit removeAbsent deletes');
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
  fs.writeFileSync(path.join(f.dataDir, 'cameos', 'mum.png'), png(7));
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
    const at = main.indexOf(`utilityHandle('${channel}', widgetConfigSender,`);
    assert.ok(at > 0, channel);
    const body = main.slice(at, main.indexOf('\n});', at) + 4);
    assert.match(body, /backupFirst\(\)/, `${channel} must take a backup first`);
    const effect = channel === 'reset-rules' ? 'saveConfig(' : channel === 'cameos-remove' ? 'Cameos.removePhoto(' : 'Setup.planImport(';
    assert.ok(body.indexOf('backupFirst()') < body.indexOf(effect), `${channel}: backup precedes its first destructive effect`);
  }
  const at = main.indexOf('function commitConfig(');
  assert.match(main.slice(at, at + 1200), /__backupReason[\s\S]*Backups\.needsBackup\([\s\S]*backupFirst\(\)[\s\S]*saveConfig\(partial\)/, 'a replaced rules list must back up before saving');
  const bf = main.indexOf('function backupFirst(');
  assert.match(main.slice(bf, bf + 300), /snapshotSafe\('manual'\)/, 'backupFirst must use the non-throwing call');
  assert.doesNotMatch(main.slice(bf, bf + 300), /\.snapshot\(/);
  assert.match(main, /const safeId = Backups\.isSnapshotId/);
  const rh = main.indexOf("ipcMain.handle('backups-restore'");
  const restoreHandler = main.slice(rh, main.indexOf("ipcMain.handle('backups-open-folder'"));
  assert.match(restoreHandler, /applyConfigEffects\(prevConfig, loadConfig\(\)\)/, 'a restore applies the same side effects as a save');
  assert.match(restoreHandler, /JSON\.stringify\(r\.restored\)[\s\S]*JSON\.stringify\(r\.configKeys\)/, 'snapshot-supplied names are logged escaped');
  assert.match(main.slice(main.indexOf("ipcMain.handle('backups-open-folder'"), main.indexOf("ipcMain.handle('backups-open-folder'") + 400), /chmodSync\(backups\.dir, 0o700\)/);
  const ce = main.indexOf('function commitConfig(');
  assert.match(main.slice(ce, ce + 1500), /applyConfigEffects\(prev, next/, 'a save uses the shared side effects');
  const handlers = [...main.matchAll(/ipcMain\.handle\('(backups-[a-z-]+)'[^\n]*\n([^\n]*\n){0,2}/g)];
  assert.equal(handlers.length, 5);
  for (const m of handlers) assert.match(m[0], /backupsSenderOk\(e\)/, `${m[1]} must check its sender`);
});

const fakeSecret = () => ['not', 'a', 'real', 'secret'].join('-');

test('H1: a backup that cannot be written never throws out of the safe path', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.base, 'afile'), 'x');
  const b = Backups.create({ dataDir: f.dataDir, backupsDir: path.join(f.base, 'afile', 'sub'), now: () => T0 });
  let r;
  assert.doesNotThrow(() => { r = b.snapshotSafe('manual'); });
  assert.deepEqual([r.taken, r.why], [false, 'error']);
  assert.doesNotThrow(() => b.dailyCheck());
  assert.doesNotThrow(() => b.onSave());
  assert.throws(() => b.snapshot('manual'), 'the raw call still throws, which is why callers use the safe one');
});

test('M1: only an exact snapshot id is accepted', () => {
  const f = fixture();
  const b = f.make();
  const s = b.snapshot('save');
  fs.mkdirSync(path.join(f.base, 'x'));
  fs.writeFileSync(path.join(f.base, 'x', 'manifest.json'), '{}');
  for (const bad of ['..', '../x', 'a/b', '.', '', `${s.id}/..`, `${s.id}/../${s.id}`, null, 5]) {
    assert.equal(Backups.isSnapshotId(bad), false, String(bad));
    assert.equal(b.verify(bad).ok, false);
    assert.ok(b.diff(bad).error);
    assert.ok(b.restore(bad).error);
  }
  assert.equal(Backups.isSnapshotId(s.id), true);
  assert.equal(Backups.isSnapshotId(`${s.id}-2`), true);
});

test('M2: a symlinked file, folder or snapshot is damaged and is never read', () => {
  const f = fixture({ rules: [{ id: 'v1' }] });
  const b = f.make();
  const secret = path.join(f.base, 'secret.txt');
  fs.writeFileSync(secret, fakeSecret());
  const linkedFile = b.snapshot('save');
  f.tick(1000); f.setConfig({ rules: [{ id: 'v2' }] });
  const linkedDir = b.snapshot('save');
  f.tick(1000); f.setConfig({ rules: [{ id: 'v3' }] });
  const real = b.snapshot('save');
  // config.json inside the snapshot becomes a link to a file with the same size and hash? no: any link is refused
  const cfg = path.join(snapDir(f, linkedFile.id), 'files', 'config.json');
  fs.rmSync(cfg);
  fs.symlinkSync(secret, cfg);
  fs.renameSync(path.join(snapDir(f, linkedDir.id), 'files', 'cameos'), path.join(f.base, 'elsewhere'));
  fs.symlinkSync(path.join(f.base, 'elsewhere'), path.join(snapDir(f, linkedDir.id), 'files', 'cameos'));
  const byId = Object.fromEntries(b.list().map((x) => [x.id, x]));
  assert.equal(byId[linkedFile.id].damaged, true);
  assert.match(byId[linkedFile.id].problems.join(), /link/);
  assert.equal(byId[linkedDir.id].damaged, true);
  assert.match(byId[linkedDir.id].problems.join(), /not a plain folder/);
  assert.equal(byId[real.id].damaged, false);
  const before = fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8');
  assert.match(b.restore(linkedFile.id).error, /damaged/);
  assert.match(b.restore(linkedDir.id).error, /damaged/);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8'), before);
  // a whole snapshot that is itself a link is not even listed
  fs.symlinkSync(snapDir(f, real.id), path.join(f.backupsDir, '2026-01-01T00-00-00.000Z'));
  assert.ok(!b.list().some((x) => x.id === '2026-01-01T00-00-00.000Z'));
  assert.ok(b.restore('2026-01-01T00-00-00.000Z').error);
});

test('M2: a file bigger than the manifest says, or than 50 MB, is refused', () => {
  const f = fixture();
  const b = f.make();
  const s = b.snapshot('save');
  fs.appendFileSync(path.join(snapDir(f, s.id), 'files', 'config.json'), ' '.repeat(5000));
  assert.match(b.verify(s.id).problems.join(), /larger than the backup says/);
  const f2 = fixture();
  const b2 = f2.make();
  const s2 = b2.snapshot('save');
  const mp = path.join(snapDir(f2, s2.id), 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.files[0].size = 60 * 1024 * 1024;
  fs.writeFileSync(mp, JSON.stringify(m));
  assert.match(b2.verify(s2.id).problems.join(), /larger than a backup file should be/);
});

test('M2: restore replaces a stale temp file instead of writing through it', () => {
  const f = fixture({ rules: [{ id: 'old' }] });
  const b = f.make();
  const s = b.snapshot('save');
  f.setConfig({ rules: [{ id: 'new' }] });
  const stale = path.join(f.dataDir, 'config.json.restore-tmp');
  const target = path.join(f.base, 'victim.txt');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, stale);
  assert.equal(b.restore(s.id).error, undefined);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep', 'the planted link was not written through');
  assert.deepEqual(f.config().rules, [{ id: 'old' }]);
});

test('M3: keys added since the backup are a note, not a choice, and survive a partial restore', () => {
  const f = fixture({ rules: [{ id: 'a' }], roam: true });
  const b = f.make();
  const s = b.snapshot('save');
  f.setConfig({ rules: [{ id: 'b' }], roam: true, voice: { on: true } });
  const d = b.diff(s.id);
  const added = d.configKeys.find((k) => k.key === 'voice');
  assert.equal(added.status, 'only-now');
  assert.match(added.say, /added since this backup, kept as it is/);
  const r = b.restore(s.id, { configKeys: ['rules', 'voice'] });
  assert.deepEqual(r.configKeys, ['rules']);
  assert.deepEqual(f.config().voice, { on: true });
});

test('M5: damaged snapshots do not count toward the keep-newest floor and go first', () => {
  const f = fixture();
  const lax = f.make({ keepNewest: 50, maxAgeMs: 1000 * DAY });
  const b = f.make({ keepNewest: 5 });
  f.setConfig({ n: 'good' });
  const good = lax.snapshot('save');
  f.tick(40 * DAY);
  const bad = [];
  for (let i = 0; i < 5; i++) { f.setConfig({ n: i }); bad.push(lax.snapshot('save').id); f.tick(1000); }
  for (const id of bad) fs.writeFileSync(path.join(snapDir(f, id), 'manifest.json'), '{broken');
  b.dailyCheck();
  assert.ok(b.list().some((s) => s.id === good.id && !s.damaged), 'the old good backup survives five newer damaged ones');
  const f2 = fixture();
  const c = f2.make({ keepNewest: 1, maxBytes: 100 });
  f2.setConfig({ n: 1 });
  const keep = c.snapshot('save');
  f2.tick(1000);
  f2.setConfig({ n: 2 });
  const junk = c.snapshot('save');
  fs.writeFileSync(path.join(snapDir(f2, junk.id), 'manifest.json'), '{broken');
  f2.tick(1000);
  f2.setConfig({ n: 3 });
  const newest = c.snapshot('save');
  assert.deepEqual(c.list().map((s) => s.id), [newest.id], 'under size pressure the damaged one went before the older good one, then the floor held');
  void keep;
});

test('M6: files that would break the app when put back are refused', () => {
  const f = fixture();
  const b = f.make();
  const s = b.snapshot('save');
  const dir = path.join(snapDir(f, s.id), 'files');
  const rewrite = (name, text) => {
    fs.writeFileSync(path.join(dir, name), text);
    const mp = path.join(snapDir(f, s.id), 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const e = m.files.find((x) => x.name === name);
    e.size = Buffer.byteLength(text);
    e.sha256 = require('crypto').createHash('sha256').update(text).digest('hex');
    fs.writeFileSync(mp, JSON.stringify(m));
  };
  rewrite('config.json', '{not json');
  assert.match(b.verify(s.id).problems.join(), /config\.json is not valid settings data/);
  rewrite('config.json', '{}');
  rewrite('cameos/dad.png', 'definitely not a png');
  assert.match(b.verify(s.id).problems.join(), /dad\.png is not a valid image/);
  assert.match(b.restore(s.id).error, /damaged/);
  assert.equal(b.list()[0].damaged, true);
});

test('L4: an existing backups folder is tightened to 0700', () => {
  const f = fixture();
  fs.mkdirSync(f.backupsDir, { mode: 0o755 });
  fs.chmodSync(f.backupsDir, 0o755);
  f.make().snapshot('save');
  assert.equal(fs.statSync(f.backupsDir).mode & 0o777, 0o700);
});

test('L6: a restore that fails part-way names the before-restore backup', () => {
  const f = fixture({ rules: [{ id: 'old' }] });
  const good = f.make();
  const s = good.snapshot('save');
  f.setConfig({ rules: [{ id: 'new' }] });
  const flaky = { ...fs, renameSync: (a, b) => { if (String(b).startsWith(f.dataDir)) throw new Error('disk full'); return fs.renameSync(a, b); } };
  const r = f.make({ fs: flaky }).restore(s.id);
  assert.match(r.error, /disk full/);
  assert.match(r.error, new RegExp(r.beforeRestoreId));
  assert.ok(good.list().some((x) => x.id === r.beforeRestoreId && x.reason === 'before-restore'));
});

test('L2: config keys read in plain words, unknown ones by name', () => {
  const f = fixture({ soundOnAmber: true, mystery: 1 });
  const b = f.make();
  const s = b.snapshot('save');
  f.setConfig({ soundOnAmber: false, mystery: 2 });
  const say = b.diff(s.id).configKeys.map((k) => k.say);
  assert.ok(say.includes('Sound when a session needs you: different from the backup'));
  assert.ok(say.includes('mystery: different from the backup'));
});

test('M4: which saves count as replacing the rules', () => {
  const r = (id, n = 0) => ({ id, name: `rule ${id}`, n });
  const prev = [r('a'), r('b'), r('c'), r('d'), r('e')];
  const need = (o) => Backups.needsBackup({ prevRules: prev, ...o });
  assert.equal(need({ nextRules: prev.map((x) => ({ ...x })) }), null, 'identical');
  assert.equal(need({ nextRules: [{ ...prev[0], n: 9 }, ...prev.slice(1)] }), null, 'a single edit is the ordinary debounced save');
  assert.equal(need({ nextRules: [...prev, r('f')] }), null, 'adding one rule is an edit');
  assert.equal(need({ nextRules: prev.slice(0, 4) }), 'rules-replaced', 'fewer rules');
  assert.equal(need({ nextRules: prev.map((x, i) => (i < 4 ? { ...x, n: 1 } : x)) }), 'rules-replaced', 'more than three changed');
  assert.equal(need({ nextRules: prev.map((x) => ({ ...x })), marker: 'reset' }), 'reset', 'a reset to defaults with the same ids still counts');
  assert.equal(need({ nextRules: prev, marker: 'preset' }), 'preset');
  assert.equal(need({ nextRules: prev, marker: 'template' }), 'template');
  assert.equal(need({ nextRules: prev, marker: 'bogus' }), null, 'an unknown marker is ignored');
  assert.equal(need({ nextPresets: [], prevPresets: [{ id: 'p' }] }), 'preset-removed');
  assert.equal(need({}), null, 'a save with no rules in it');
});

// ── Opus pass on 5c4ebcf ──
const rewrite = (f, id, name, text) => {
  fs.mkdirSync(path.dirname(path.join(snapDir(f, id), 'files', name)), { recursive: true });
  fs.writeFileSync(path.join(snapDir(f, id), 'files', name), text);
  const mp = path.join(snapDir(f, id), 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const e = m.files.find((x) => x.name === name);
  e.size = Buffer.byteLength(text);
  e.sha256 = require('crypto').createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(mp, JSON.stringify(m));
};

test('1: a damaged newest snapshot never counts as "unchanged": a new backup is taken', () => {
  const f = fixture({ rules: [{ id: 'v0' }] });
  const b = f.make();
  b.snapshot('save');
  f.tick(1000);
  f.setConfig({ rules: [{ id: 'v1' }] });
  const newest = b.snapshot('manual');
  fs.appendFileSync(path.join(snapDir(f, newest.id), 'files', 'config.json'), ' ');
  f.tick(1000);
  const r = b.snapshotSafe('manual');
  assert.equal(r.taken, true, `got ${JSON.stringify(r)}`);
  assert.equal(b.list()[0].damaged, false);
});

test('2: a config that is not an object is damaged, so it can never be restored', () => {
  for (const bad of ['null', '[]', '5', '"text"', 'true']) {
    const f = fixture();
    const b = f.make();
    const s = b.snapshot('save');
    rewrite(f, s.id, 'config.json', bad);
    assert.equal(b.verify(s.id).ok, false, bad);
    assert.match(b.restore(s.id).error, /damaged/, bad);
  }
  const f = fixture();
  const b = f.make();
  const s = b.snapshot('save');
  rewrite(f, s.id, 'cameos/index.json', '[]');
  assert.equal(b.verify(s.id).ok, false, 'cameo index');
  const s2 = b.snapshot('manual', { force: true });
  rewrite(f, s2.id, 'usage/daily/2026-09.json', 'null');
  assert.equal(b.verify(s2.id).ok, false, 'usage month');
});

test('4: the diff lists click commands the backup would add', () => {
  const planted = { id: 'x', name: 'x', enabled: true, when: { signal: ['tool-use'] }, then: { clicks: { click: { type: 'shell', arg: 'echo planted-command' } } } };
  assert.deepEqual(Rules.clickCommands([planted]), ['echo planted-command'], 'the helper sees it');
  const f = fixture({ rules: [planted] });
  const b = f.make({ clickCommands: Rules.clickCommands });
  const s = b.snapshot('save');
  f.setConfig({ rules: [] });
  assert.deepEqual(b.diff(s.id).commands, ['echo planted-command']);
  f.setConfig({ rules: [planted] });
  assert.deepEqual(b.diff(s.id).commands, [], 'one the current rules already run is not news');
  const same = f.make({ clickCommands: Rules.clickCommands });
  f.setConfig({ rules: [] });
  assert.deepEqual(same.diff(s.id).commands, ['echo planted-command']);
});

test('5: restoring everything keeps keys added since the backup', () => {
  const f = fixture({ rules: [{ id: 'old' }], roam: true });
  const b = f.make();
  const s = b.snapshot('save');
  f.setConfig({ rules: [{ id: 'new' }], roam: false, voice: { on: true } });
  b.restore(s.id);
  assert.deepEqual(f.config(), { rules: [{ id: 'old' }], roam: true, voice: { on: true } });
});

test('6: a symlinked or oversized data file is not backed up; a symlinked data folder is not restored through', () => {
  const f = fixture();
  const secret = path.join(f.base, 'secret.txt');
  fs.writeFileSync(secret, fakeSecret());
  fs.rmSync(path.join(f.dataDir, 'config.json'));
  fs.symlinkSync(secret, path.join(f.dataDir, 'config.json'));
  const b = f.make();
  const s = b.snapshot('save');
  assert.ok(!b.list()[0] || !fs.existsSync(path.join(snapDir(f, s.id), 'files', 'config.json')), 'the linked config was not copied');
  fs.rmSync(path.join(f.dataDir, 'config.json'));
  fs.writeFileSync(path.join(f.dataDir, 'config.json'), '{"a":1}');
  const good = b.snapshot('manual');
  const elsewhere = path.join(f.base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.rmSync(path.join(f.dataDir, 'cameos'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(f.dataDir, 'cameos'));
  const r = b.restore(good.id, { files: ['cameos/dad.png'] });
  assert.ok(r.error, 'refused');
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was written through the link');
});

test('7: the keep-newest floor counts only snapshots whose hashes check out, and a planted future date cannot pin a snapshot', () => {
  const f = fixture();
  const lax = f.make({ keepNewest: 50, maxAgeMs: 1000 * DAY });
  f.setConfig({ n: 'good' });
  const good = lax.snapshot('save');
  f.tick(40 * DAY);
  const bad = [];
  for (let i = 0; i < 5; i++) { f.setConfig({ n: i }); bad.push(lax.snapshot('save').id); f.tick(1000); }
  for (const id of bad) { const p = path.join(snapDir(f, id), 'files', 'config.json'); const t = fs.readFileSync(p, 'utf8'); fs.writeFileSync(p, t.replace(/[0-9a-z]/, 'Z')); }
  f.make({ keepNewest: 5 }).prune();
  assert.ok(f.make().list().some((s) => s.id === good.id), 'same-size corruption still pushed the good one out');
  const g = fixture();
  const c = g.make({ keepNewest: 1, maxAgeMs: 20 * DAY });
  g.setConfig({ n: 0 });
  const pinned = c.snapshot('before-restore', { force: true });
  const mp = path.join(snapDir(g, pinned.id), 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.createdAt = '2099-01-01T00:00:00.000Z';
  fs.writeFileSync(mp, JSON.stringify(m));
  g.tick(30 * DAY);
  g.setConfig({ n: 1 }); c.snapshot('save');
  g.tick(DAY);
  g.setConfig({ n: 2 }); c.snapshot('save');
  assert.ok(!c.list().some((s) => s.id === pinned.id), 'a before-restore snapshot older than 7 days by its id is pruned whatever its manifest claims');
});

// ── verification cache ──
function countingFs(backupsDir) {
  const counter = { reads: 0 };
  const spy = { ...fs, readFileSync: (p, ...a) => { if (String(p).startsWith(path.join(backupsDir, '2')) && String(p).includes(`${path.sep}files${path.sep}`)) counter.reads++; return fs.readFileSync(p, ...a); } };
  return { spy, counter };
}

test('cache (a): a second prune does not re-read the snapshot files', () => {
  const f = fixture();
  const { spy, counter } = countingFs(f.backupsDir);
  const b = f.make({ fs: spy });
  b.snapshot('save');
  f.tick(1000); f.setConfig({ n: 1 }); b.snapshot('save');
  b.prune();
  counter.reads = 0;
  b.prune();
  b.prune();
  assert.equal(counter.reads, 0);
  assert.equal(b.list().length, 2);
  assert.equal(counter.reads, 0, 'the list shown to the user uses the cache too');
});

test('cache (b): a snapshot file changed after it was cached is caught on the next prune', () => {
  const f = fixture();
  const b = f.make({ keepNewest: 1 });
  const first = b.snapshot('save');
  f.tick(1000); f.setConfig({ n: 1 }); b.snapshot('save');
  b.prune();
  const p = path.join(snapDir(f, first.id), 'files', 'config.json');
  const t = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, t.replace(/[0-9a-z]/, 'Z'));
  assert.equal(b.list().find((s) => s.id === first.id).damaged, true, 'the list sees it');
  const good = b.list().filter((s) => !s.damaged).length;
  assert.equal(good, 1);
});

test('cache (c): a restore verifies for real even with a warm cache', () => {
  const f = fixture({ rules: [{ id: 'old' }] });
  const { spy, counter } = countingFs(f.backupsDir);
  const b = f.make({ fs: spy });
  const s = b.snapshot('save');
  b.prune(); b.list();
  counter.reads = 0;
  f.setConfig({ rules: [{ id: 'new' }] });
  assert.equal(b.restore(s.id).error, undefined);
  assert.ok(counter.reads >= 4, `restore read ${counter.reads} snapshot files`);
});

test('production destructive utility handlers reject foreign senders and back up before effects', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const wrapperAt = main.indexOf('function utilityHandle(');
  const wrapper = main.slice(wrapperAt, main.indexOf('\n}', wrapperAt) + 2);
  const handlers = new Map(), owned = {}, effects = [];
  const context = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, widgetConfigSender: e => e.sender === owned,
    backupFirst: () => effects.push('backup'), saveConfig: () => effects.push('save'), broadcastStatus() {},
    Rules: { defaultRules: () => [] }, Cameos: { removePhoto: () => effects.push('remove'), loadIndex: () => [] }, CAMEO_DIR: '/fixture', cameosChanged() {},
    pendingSetup: {}, Setup: { planImport: () => { effects.push('import'); return { remove: [], add: [], partial: {} }; } },
    loadConfig: () => ({}), readCameoPng() {}, commitConfig() {} };
  const vm = require('node:vm'); vm.createContext(context); vm.runInContext(wrapper, context);
  for (const [channel, effect] of [['reset-rules', 'save'], ['cameos-remove', 'remove'], ['setup-import-apply', 'import']]) {
    const at = main.indexOf(`utilityHandle('${channel}', widgetConfigSender,`);
    assert.ok(at > 0, channel);
    vm.runInContext(main.slice(at, main.indexOf('\n});', at) + 4), context);
    assert.equal(handlers.get(channel)({ sender: {} }, 'replace'), null);
    assert.deepEqual(effects, [], `${channel}: no effects for foreign renderer`);
    handlers.get(channel)({ sender: owned }, 'replace');
    assert.deepEqual(effects, ['backup', effect], `${channel}: backup before its effect`);
    effects.length = 0;
  }
});
