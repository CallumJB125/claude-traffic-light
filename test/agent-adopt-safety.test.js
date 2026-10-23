'use strict';
// PR 4: adopt, backup and restore proven safe on a temp HOME shaped like a
// real ~/.claude/agents (test/fixtures/agents-home.js) before any of it runs on
// a real folder. Every step compares the folder's full fingerprint: path,
// kind, mode, size, mtime, sha256 and link targets (scripts/agents-fingerprint.js).
// Never touches the real home folder. The design: .omc/plans/plan-find-agents.md §9 PR 4.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createAgentInstaller } = require('../src/agent-install.js');
const Catalog = require('../src/agent-catalog.js');
const FP = require('../scripts/agents-fingerprint.js');
const { buildAgentsHome } = require('./fixtures/agents-home.js');

const sha = (t) => createHash('sha256').update(t).digest('hex');
const REAL_HOME = os.homedir();
const shipped = Catalog.shipped();
const dirs = [];
test.after(() => { for (const d of dirs) { try { execFileSync('chmod', ['-R', 'u+w', d]); } catch { /* best effort */ } fs.rmSync(d, { recursive: true, force: true }); } });
function tmp(p) { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; }

// A catalogue where some agents have a newer version, for Update.
function newer(cat, ids) {
  const agents = cat.catalog.agents.map((a) => (ids.includes(a.id) ? (() => { const raw = `${a.raw}\nUpdated upstream.\n`; return { ...a, raw, fileSha256: sha(raw) }; })() : a));
  const byId = new Map(agents.map((a) => [a.id, a]));
  return { ...cat, sha256: 'e'.repeat(64), catalog: { ...cat.catalog, agents }, get: (id) => byId.get(id) ?? null };
}

function setup() {
  const home = tmp('af-adopt-home-'), data = tmp('af-adopt-data-');
  assert.ok(!home.startsWith(REAL_HOME + path.sep) || home.startsWith(os.tmpdir()), 'a temp HOME');
  const fx = buildAgentsHome(home, shipped);
  const key = Buffer.alloc(32, 9);
  const inst = (catalog = shipped, extra = {}) => createAgentInstaller({ home, dataRoot: data, catalog, ledgerKey: key, ...extra });
  const fp = (opts) => FP.fingerprint(fx.dir, opts);
  return { home, data, fx, inst, fp, it: inst() };
}
const owned = (s) => JSON.parse(fs.readFileSync(s.it.ledgerPath, 'utf8')).owned;
const ownedCount = (s) => (fs.existsSync(s.it.ledgerPath) ? Object.keys(owned(s)).length : 0);
const backupsOf = (s) => (fs.existsSync(path.join(s.data, 'agent-backups')) ? fs.readdirSync(path.join(s.data, 'agent-backups')).sort() : []);
const diff = (a, b) => { const A = new Set(a), B = new Set(b); return { gone: a.filter((l) => !B.has(l)), added: b.filter((l) => !A.has(l)) }; };

test('a full adopt, update, undo and stop-managing cycle never touches a path in the real home folder', () => {
  const s = setup();
  const seen = [];
  const fsApi = new Proxy(fs, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { for (const x of a) if (typeof x === 'string' && path.isAbsolute(x)) seen.push(x); return t[k](...a); } : t[k]) });
  const it = s.inst(shipped, { fsApi });
  const a = it.adopt();
  const e = s.fx.exact[0];
  const up = s.inst(newer(shipped, [e.agentId]), { fsApi });
  up.undo(up.update(e.agentId).opId);
  up.undo(a.opId);
  up.stopManaging();
  assert.ok(seen.length > 100);
  const realHome = fs.realpathSync(REAL_HOME);
  const tmpRoot = fs.realpathSync(os.tmpdir());
  for (const p of seen) {
    const abs = path.resolve(p);
    if (abs.startsWith(tmpRoot + path.sep)) continue;
    assert.ok(abs !== realHome && !abs.startsWith(realHome + path.sep), `touched ${abs}`);
  }
});

test('the fixture is shaped like a real folder and its fingerprint sees every kind of entry', () => {
  const s = setup();
  const lines = s.fp();
  assert.equal(s.fx.exact.length, 120);
  assert.equal(new Set(s.fx.exact.map((e) => e.agentId.split('/')[0])).size, 4, 'all four sources');
  assert.equal(s.fx.nearMiss.length, 20);
  assert.equal(s.fx.own.length, 30);
  for (const k of ['F', 'D', 'L']) assert.ok(lines.some((l) => l.startsWith(`${k} `)), k);
  assert.ok(lines.some((l) => l.startsWith(`F ${s.fx.readOnly} 0444 `)));
  assert.ok(lines.some((l) => l.startsWith(`F ${s.fx.aged} `) && l.includes(` ${Date.parse('2001-02-03T04:05:06Z')} `)));
  assert.ok(!lines.join('\n').includes(sha(s.fx.secret)), 'the link to the key is listed as a link, never read');
  assert.deepEqual(FP.catalogueMatches(s.fx.dir), { md: 174, exact: 122, notMatching: 52, other: 6 });
});

test('the fingerprint changes for a byte, a mode, an mtime and a link target', () => {
  const s = setup();
  const base = s.fp();
  const f = path.join(s.fx.dir, s.fx.own[0]);
  fs.appendFileSync(f, 'x');
  assert.notDeepEqual(s.fp(), base);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').slice(0, -1));
  fs.utimesSync(f, new Date(0), new Date(0));
  assert.notDeepEqual(s.fp(), base, 'mtime');
  assert.deepEqual(s.fp({ mtime: false }), FP.fingerprint(s.fx.dir, { mtime: false }));
  fs.chmodSync(f, 0o600);
  assert.notDeepEqual(s.fp({ mtime: false }), base.map((l) => l.replace(/ \d+ ([0-9a-f]{64}|-|\S+)$/, ' - $1')));
  const before = s.fp();
  fs.unlinkSync(path.join(s.fx.dir, 'gone.md'));
  fs.symlinkSync('elsewhere.md', path.join(s.fx.dir, 'gone.md'));
  assert.ok(diff(before, s.fp()).added.some((l) => l.startsWith('L gone.md ') && l.endsWith(' elsewhere.md')));
});

test('step 1: the backup is the folder exactly (bytes, modes, mtimes, links kept as links), and an unchanged folder reuses it', () => {
  const s = setup();
  const before = s.fp();
  const r = s.it.adopt([`.claude/agents/${s.fx.exact[0].name}`]);
  assert.equal(r.ok, true);
  const [b] = backupsOf(s);
  const copy = path.join(s.data, 'agent-backups', b);
  assert.deepEqual(FP.fingerprint(copy), before, 'the copy matches entry for entry');
  assert.equal(fs.statSync(copy).mode & 0o777, 0o700);
  assert.deepEqual(s.fp(), before);
  s.it.adopt([`.claude/agents/${s.fx.exact[1].name}`]);
  assert.deepEqual(backupsOf(s), [b], 'an unchanged folder reuses its newest backup');
});

test('step 1b: a backup with one changed byte, an extra entry or a different mode is refused, and nothing is adopted', () => {
  const spoil = {
    byte: (dest) => fs.appendFileSync(path.join(dest, 'README.txt'), '!'),
    extra: (dest) => fs.writeFileSync(path.join(dest, 'planted.md'), 'x'),
    mode: (dest) => fs.chmodSync(path.join(dest, 'README.txt'), 0o666),
  };
  for (const [what, fn] of Object.entries(spoil)) {
    const s = setup();
    const before = s.fp();
    const fsApi = new Proxy(fs, { get: (t, k) => (k === 'cpSync' ? (src, dest, o) => { t.cpSync(src, dest, o); fn(dest); } : t[k]) });
    const r = s.inst(shipped, { fsApi }).adopt();
    assert.equal(r.status, 'backup', what);
    assert.equal(ownedCount(s), 0, what);
    assert.deepEqual(s.fp(), before, what);
  }
});

test('an adopt of more than 64 files survives a reload, so its Undo is still there (the old cap dropped it)', () => {
  const s = setup();
  const r = s.it.adopt();
  assert.ok(r.adopted.length > 64);
  const fresh = s.inst();
  assert.ok(fresh.status().ops.some((o) => o.id === r.opId && o.kind === 'adopt' && o.files === r.adopted.length));
  const st = fresh.stopManaging();
  assert.ok(s.inst().status().ops.some((o) => o.id === st.opId && o.kind === 'release'));
});

test('step 2 and 3: adopt changes nothing on disk, owns exactly the matches, and undo changes nothing either', () => {
  const s = setup();
  const before = s.fp();
  const r = s.it.adopt();
  assert.equal(r.ok, true);
  assert.deepEqual(r.adopted.map((p) => p.split('/').pop()).sort(), s.fx.adoptable);
  assert.deepEqual(s.fp(), before, 'not one byte, mode or mtime changed');
  assert.equal(ownedCount(s), s.fx.adoptable.length);
  assert.ok(Object.values(owned(s)).every((o) => o.how === 'adopted'));
  assert.equal(s.it.adoptable().userOwned, 51 - 0, 'near misses, own files and the empty one stay yours');
  const u = s.it.undo(r.opId);
  assert.equal(u.ok, true);
  assert.deepEqual(s.fp(), before);
  assert.equal(ownedCount(s), 0);
});

test('step 4 and 5: adopt, update, then undo the update or the adopt: the folder is back byte for byte', () => {
  for (const undoWhich of ['update', 'adopt']) {
    const s = setup();
    const before = s.fp({ mtime: false });
    const ids = s.fx.exact.slice(0, 3).map((e) => e.agentId);
    const a = s.it.adopt();
    const up = s.inst(newer(shipped, ids));
    const results = ids.map((id) => up.update(id));
    assert.ok(results.every((r) => r.ok && r.opId), undoWhich);
    const mid = diff(before, s.fp({ mtime: false }));
    assert.deepEqual(mid.gone.map((l) => l.split(' ')[1]).sort(), s.fx.exact.slice(0, 3).map((e) => e.name).sort(), 'only the updated files changed');
    if (undoWhich === 'update') for (const r of results.reverse()) assert.equal(up.undo(r.opId).ok, true);
    else { const u = up.undo(a.opId); assert.equal(u.ok, true, undoWhich); }
    assert.deepEqual(s.fp({ mtime: false }), before, `undo ${undoWhich}`);
  }
});

test('step 6: a file you edit after adopting is never changed by update, remove or undo', () => {
  const s = setup();
  const e = s.fx.exact[0];
  const a = s.it.adopt();
  fs.appendFileSync(path.join(s.fx.dir, e.name), '\nMy own note.\n');
  const mine = s.fp();
  const up = s.inst(newer(shipped, [e.agentId]));
  const r = up.update(e.agentId);
  assert.equal(r.results[0].outcome, 'skipped');
  assert.equal(up.remove(e.agentId).results[0].outcome, 'skipped');
  up.undo(a.opId);
  assert.deepEqual(s.fp(), mine);
});

test('step 7 and 8: stop managing and Remove from all on adopted files leave every file as it is', () => {
  const s = setup();
  const before = s.fp();
  s.it.adopt();
  const e = s.fx.exact[0];
  const rm = s.it.remove(e.agentId);
  assert.equal(rm.results[0].outcome, 'released');
  assert.deepEqual(s.fp(), before);
  const st = s.it.stopManaging();
  assert.equal(st.released.length, s.fx.adoptable.length - 1);
  assert.deepEqual(s.fp(), before);
  assert.equal(ownedCount(s), 0);
  assert.equal(s.it.undo(st.opId).ok, true, 'undo release owns them again');
  assert.deepEqual(s.fp(), before);
  assert.equal(ownedCount(s), s.fx.adoptable.length - 1);
});

test('step 9: a failed write or a failed ledger save during update or remove leaves the folder as it was', () => {
  for (const kind of ['write', 'ledger']) {
    const s = setup();
    s.it.adopt();
    const e = s.fx.exact[0];
    // A file Plexiform added (not adopted), so remove would really delete it.
    const added = s.fx.exact.find((x) => x !== e);
    const before = s.fp({ mtime: false });
    const ownedBefore = owned(s);
    let armed = true;
    const fsApi = kind === 'ledger' ? new Proxy(fs, { get: (t, k) => (k === 'renameSync' ? (from, to) => { if (armed && String(to).endsWith('agent-installs.json')) throw new Error('simulated ledger failure'); return t.renameSync(from, to); } : t[k]) }) : fs;
    const up = s.inst(newer(shipped, [e.agentId]), kind === 'write' ? { failAfterWrites: 0 } : { fsApi });
    const r = up.update(e.agentId);
    assert.equal(r.ok, false, kind);
    assert.deepEqual(s.fp({ mtime: false }), before, `${kind}: update rolled back`);
    armed = false;
    assert.deepEqual(owned(s), ownedBefore, `${kind}: nothing recorded`);
    assert.equal(added.agentId.length > 0, true);
  }
});

test('step 10: a linked agents folder, a link to ~/.ssh/id_rsa and a planted backup link are refused', () => {
  const s = setup();
  const lines = s.fp();
  assert.ok(!s.it.adoptable().matches.some((m) => m.rel.endsWith('/secret.md') || m.rel.endsWith(`/${s.fx.linked}`)));
  s.it.adopt();
  const [b] = backupsOf(s);
  const copied = fs.lstatSync(path.join(s.data, 'agent-backups', b, 'secret.md'));
  assert.ok(copied.isSymbolicLink(), 'the link is copied as a link, never its target');
  assert.deepEqual(s.fp(), lines);

  const t = setup();
  const real = path.join(t.home, 'real-agents');
  fs.renameSync(t.fx.dir, real);
  fs.symlinkSync(real, t.fx.dir);
  const before = FP.fingerprint(real);
  assert.deepEqual(t.it.adoptable().matches, []);
  assert.equal(t.it.adopt().opId, null);
  assert.deepEqual(backupsOf(t), []);
  assert.deepEqual(FP.fingerprint(real), before);

  const u = setup();
  const elsewhere = tmp('af-adopt-planted-');
  fs.symlinkSync(elsewhere, path.join(u.data, 'agent-backups'));
  const r = u.it.adopt();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'backup');
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing copied through the planted link');
  assert.equal(ownedCount(u), 0);
});

test('step 11: the documented manual restore (ditto, or cp -Rp) recreates the folder exactly', { skip: process.platform === 'win32' }, () => {
  const s = setup();
  // ditto and cp -Rp keep every file's and folder's time but not a link's own.
  const before = s.fp({ linkTimes: false });
  s.it.adopt();
  const [b] = backupsOf(s);
  fs.rmSync(s.fx.dir, { recursive: true, force: true });
  if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', [path.join(s.data, 'agent-backups', b), s.fx.dir]);
  else execFileSync('cp', ['-Rp', path.join(s.data, 'agent-backups', b), s.fx.dir]);
  fs.chmodSync(s.fx.dir, fs.statSync(path.join(s.home, '.claude')).mode & 0o777);
  assert.deepEqual(s.fp({ linkTimes: false }), before);
  assert.equal(execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'agents-fingerprint.js'), s.fx.dir, '--restore']).toString().trim(), `digest ${FP.digest(before)} (${before.length} entries)`);
});
