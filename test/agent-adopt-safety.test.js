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
  assert.deepEqual(FP.catalogueMatches(s.fx.dir), { md: 174, exact: 122, notMatching: 52, other: 8 });
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

test('step 11: the documented restore (into a new folder, then swap by hand) gets the folder back, and changes nothing until the swap', { skip: process.platform !== 'darwin' }, () => {
  const s = setup();
  // The data folder under home, as in the app, so a command is offered.
  s.it = createAgentInstaller({ home: s.home, dataRoot: path.join(s.home, 'Library', 'Plexiform'), catalog: shipped, ledgerKey: Buffer.alloc(32, 9) });
  // ditto keeps every file's and folder's time but not a link's own.
  const before = s.fp({ linkTimes: false });
  const a = s.it.adopt();
  // Later the person adds and edits files, then wants the old folder back.
  fs.writeFileSync(path.join(s.fx.dir, 'added-later.md'), 'new\n');
  fs.appendFileSync(path.join(s.fx.dir, s.fx.own[0]), 'edit\n');
  const live = s.fp();
  const cmd = s.it.restoreCommand(a.backup);
  const tag = a.backup.replace(/^claude-agents-/, '');
  const R = path.join(s.home, '.claude', `agents-restored-${tag}`), O = path.join(s.home, '.claude', `agents-old-${tag}`);
  // Two lines, named with the backup's stamp (review #54 L2): copy, check, swap.
  const [copy, swap, ...more] = cmd.split('\n');
  assert.deepEqual(more, []);
  assert.equal(copy, `if [ -e "$HOME/.claude/agents-restored-${tag}" ]; then echo "~/.claude/agents-restored-${tag} already exists, so nothing was copied."; else ditto "$HOME/Library/Plexiform/agent-backups/${a.backup}" "$HOME/.claude/agents-restored-${tag}"; fi`);
  assert.equal(swap, `if [ -e "$HOME/.claude/agents-old-${tag}" ] || [ ! -d "$HOME/.claude/agents-restored-${tag}" ]; then echo "~/.claude/agents-old-${tag} already exists or there's nothing to swap in, so nothing was moved."; else mv "$HOME/.claude/agents" "$HOME/.claude/agents-old-${tag}" && mv "$HOME/.claude/agents-restored-${tag}" "$HOME/.claude/agents"; fi`);
  const sh = (line) => execFileSync('/bin/sh', ['-c', line], { env: { ...process.env, HOME: s.home } }).toString();
  // The swap before a copy moves nothing.
  assert.match(sh(swap), /nothing was moved/);
  assert.deepEqual(s.fp(), live);
  assert.equal(sh(copy), '');
  assert.deepEqual(s.fp(), live, 'restoring into a new folder leaves the live one alone');
  assert.deepEqual(FP.fingerprint(R, { linkTimes: false }), before);
  // A second copy never merges into the first.
  fs.writeFileSync(path.join(R, 'checked.txt'), 'looked at it\n');
  const restored = FP.fingerprint(R);
  assert.match(sh(copy), /already exists, so nothing was copied/);
  assert.deepEqual(FP.fingerprint(R), restored);
  fs.rmSync(path.join(R, 'checked.txt'));
  // An agents-old-<stamp> already there: the swap stops rather than nest inside it.
  fs.mkdirSync(O);
  assert.match(sh(swap), /nothing was moved/);
  assert.deepEqual(s.fp(), live);
  assert.deepEqual(fs.readdirSync(O), []);
  fs.rmdirSync(O);
  assert.equal(sh(swap), '');
  assert.deepEqual(FP.fingerprint(O), live, 'the folder you had is kept as agents-old-<stamp>');
  fs.utimesSync(s.fx.dir, fs.statSync(O).atime, fs.statSync(O).mtime);
  assert.deepEqual(s.fp({ linkTimes: false }), before);
  assert.equal(execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'agents-fingerprint.js'), s.fx.dir, '--restore']).toString().trim(), `digest ${FP.digest(before)} (${before.length} entries)`);
});

test('step 11b: why Help never says "ditto puts it back": ditto into the live folder merges and keeps files added since', { skip: process.platform !== 'darwin' }, () => {
  const s = setup();
  const before = s.fp({ linkTimes: false });
  const a = s.it.adopt();
  fs.writeFileSync(path.join(s.fx.dir, 'added-later.md'), 'new\n');
  // It merges, and over a 0555 folder it fails part way: neither is a restore.
  let failed = false;
  try { execFileSync('/usr/bin/ditto', [s.it.backupPath(a.backup), s.fx.dir], { stdio: 'ignore' }); } catch { failed = true; }
  assert.ok(failed || JSON.stringify(s.fp({ linkTimes: false })) !== JSON.stringify(before));
  assert.ok(fs.existsSync(path.join(s.fx.dir, 'added-later.md')));
});

test('change 4: no restore command when the data folder is outside home; ids only, checked against the listed backups', () => {
  const s = setup();
  const a = s.it.adopt();
  assert.equal(s.it.restoreCommand(a.backup), null, 'the temp data folder is not under the temp home');
  assert.deepEqual(s.it.backups().map((b) => b.id), [a.backup]);
  for (const bad of ['../x', `${a.backup}/..`, a.backup.replace(/-[0-9a-f]{8}$/, '-zzzzzzzz'), 'claude-agents-20261023T000000000Z-00000000', null, 7]) {
    assert.equal(s.it.backupPath(bad), null, String(bad));
    assert.equal(s.it.restoreBackupPlan(bad).ok, false);
  }
  const home = s.home, data = path.join(home, 'Library', 'Plexiform');
  const t = createAgentInstaller({ home, dataRoot: data, catalog: shipped, ledgerKey: Buffer.alloc(32, 9) });
  const b = t.adopt([`.claude/agents/${s.fx.exact[0].name}`]);
  const tag = b.backup.replace(/^claude-agents-/, '');
  const mac = t.restoreCommand(b.backup);
  assert.ok(mac.includes(`ditto "$HOME/Library/Plexiform/agent-backups/${b.backup}" "$HOME/.claude/agents-restored-${tag}"`), mac);
  // ditto is macOS only: Linux gets cp -Rp, anything else only Show backup (L2).
  const on = (platform) => createAgentInstaller({ home, dataRoot: data, catalog: shipped, ledgerKey: Buffer.alloc(32, 9), platform }).restoreCommand(b.backup);
  assert.equal(on('linux'), mac.replace(`ditto "$HOME`, `cp -Rp "$HOME`));
  assert.ok(!on('linux').includes('ditto'));
  assert.equal(on('win32'), null);
});

test('change 9: restoreBackupPlan gives names and states only, never bytes, and reads no link', () => {
  const s = setup();
  const a = s.it.adopt();
  fs.writeFileSync(path.join(s.fx.dir, 'added-later.md'), 'new\n');
  fs.appendFileSync(path.join(s.fx.dir, s.fx.own[0]), 'edit\n');
  fs.rmSync(path.join(s.fx.dir, s.fx.own[1]));
  const plan = s.it.restoreBackupPlan(a.backup);
  const by = new Map(plan.items.map((i) => [i.path.split('/').pop(), i.state]));
  assert.equal(by.get('added-later.md'), 'added-since');
  assert.equal(by.get(s.fx.own[0]), 'differs');
  assert.equal(by.get(s.fx.own[1]), 'gone-now');
  assert.equal(by.get(s.fx.exact[0].name), 'same');
  assert.equal(by.get('secret.md'), 'differs', 'a link is never read, so never "same"');
  assert.ok(plan.items.every((i) => Object.keys(i).join() === 'path,state' && i.path.startsWith('~/.claude/agents/')));
  assert.ok(!JSON.stringify(plan).includes(s.fx.secret.slice(0, 20)));
});

// Folders outside ~/.claude/agents that the fixture has: none may change.
const outside = (s, extra = []) => [path.join(s.home, 'elsewhere'), path.join(s.home, '.ssh'), ...extra].map((d) => `${(fs.statSync(d).mode & 0o7777).toString(8)} ${FP.fingerprint(d).join('|')}`).concat([s.home, path.join(s.home, '.claude')].map((d) => (fs.lstatSync(d).mode & 0o7777).toString(8)));
const throwingLedger = (armed) => new Proxy(fs, { get: (t, k) => (k === 'renameSync' ? (from, to) => { if (armed.on && String(to).endsWith('agent-installs.json')) throw new Error('simulated ledger failure'); return t.renameSync(from, to); } : t[k]) });

test('change 8: hostile folders and files: swaps, links, planted backups, a linked data folder, hard links, a FIFO and oversize', { skip: process.platform === 'win32' }, () => {
  // agents swapped for a link between adoptable() and the copy (P2).
  {
    const s = setup();
    const victim = tmp('af-adopt-victim-');
    fs.writeFileSync(path.join(victim, 'x.md'), 'x');
    fs.chmodSync(victim, 0o755);
    const was = outside(s, [victim]);
    let swapped = false;
    const fsApi = new Proxy(fs, { get: (t, k) => (k === 'cpSync' ? (...a) => { if (!swapped) { swapped = true; t.renameSync(s.fx.dir, `${s.fx.dir}.real`); t.symlinkSync(victim, s.fx.dir); } return t.cpSync(...a); } : t[k]) });
    const r = s.inst(shipped, { fsApi }).adopt();
    assert.equal(r.status, 'backup');
    assert.deepEqual(outside(s, [victim]), was, 'no outside folder changed, modes included');
    assert.deepEqual(backupsOf(s), []);
    assert.equal(ownedCount(s), 0);
  }
  // ~/.claude itself a link.
  {
    const s = setup();
    const real = path.join(s.home, 'real-claude');
    fs.renameSync(path.join(s.home, '.claude'), real);
    fs.symlinkSync(real, path.join(s.home, '.claude'));
    const was = FP.fingerprint(real);
    assert.equal(s.it.adopt().opId, null);
    assert.deepEqual(FP.fingerprint(real), was);
    assert.deepEqual(backupsOf(s), []);
  }
  // A planted, newer, real backup folder with a valid name is not relied on.
  {
    const s = setup();
    const root = path.join(s.data, 'agent-backups');
    fs.mkdirSync(root, { recursive: true });
    const planted = 'claude-agents-20000101T000000000Z-deadbeef';
    fs.mkdirSync(path.join(root, planted));
    fs.writeFileSync(path.join(root, planted, s.fx.exact[0].name), 'not it');
    const r = s.it.adopt();
    assert.equal(r.ok, true);
    assert.notEqual(r.backup, planted);
    assert.deepEqual(FP.fingerprint(s.it.backupPath(r.backup)), s.fp());
  }
  // The data folder as a link.
  {
    const s = setup();
    const target = tmp('af-adopt-datalink-');
    fs.rmSync(s.data, { recursive: true });
    fs.symlinkSync(target, s.data);
    const r = s.it.adopt();
    assert.equal(r.ok, false);
    assert.deepEqual(fs.readdirSync(target), [], 'nothing written through the link');
  }
  // A hard link to a file outside, a FIFO, and oversize.
  {
    const s = setup();
    const out = path.join(s.home, 'elsewhere', 'outside.md');
    fs.writeFileSync(out, shipped.get(s.fx.exact[0].agentId).raw);
    fs.linkSync(out, path.join(s.fx.dir, 'hardlinked.md'));
    const was = outside(s);
    assert.ok(!s.it.adoptable().matches.some((m) => m.rel.endsWith('/hardlinked.md')), 'nlink 2 is never adopted');
    const r = s.it.adopt();
    assert.equal(r.ok, true);
    assert.deepEqual(outside(s), was);
    assert.equal(fs.lstatSync(path.join(s.it.backupPath(r.backup), 'hardlinked.md')).nlink, 1, 'copied as bytes into the 0700 backup');
  }
  {
    const s = setup();
    execFileSync('mkfifo', [path.join(s.fx.dir, 'pipe.md')]);
    const before = s.fp();
    const r = s.it.adopt();
    assert.equal(r.status, 'backup');
    assert.match(r.error, /isn't a file, folder or link/);
    assert.deepEqual(s.fp(), before);
    assert.equal(ownedCount(s), 0);
  }
  {
    const s = setup();
    const big = path.join(s.fx.dir, 'huge.bin');
    fs.closeSync(fs.openSync(big, 'w'));
    fs.truncateSync(big, 65 * 1024 * 1024);
    const r = s.it.adopt();
    assert.equal(r.status, 'backup');
    assert.match(r.error, /64 MB/);
    assert.deepEqual(backupsOf(s), []);
  }
  {
    const s = setup();
    fs.mkdirSync(path.join(s.fx.dir, 'many'));
    for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(s.fx.dir, 'many', `f${i}`), '');
    const r = s.it.adopt();
    assert.equal(r.status, 'backup');
    assert.match(r.error, /more than 5000 entries/);
  }
});

test('change 3: a file whose backup copy is not its exact bytes is not adopted', () => {
  const s = setup();
  const name = s.fx.exact[0].name;
  let reads = 0;
  const fsApi = new Proxy(fs, { get: (t, k) => (k === 'readFileSync' ? (p, ...a) => { const out = t.readFileSync(p, ...a); if (String(p).includes('agent-backups') && String(p).endsWith(`/${name}`) && ++reads === 2) return Buffer.from('tampered'); return out; } : t[k]) });
  const r = s.inst(shipped, { fsApi }).adopt();
  assert.equal(r.ok, true);
  assert.ok(!r.adopted.some((p) => p.endsWith(`/${name}`)));
  assert.equal(r.adopted.length, s.fx.adoptable.length - 1);
});

test('change 5: a file matching a catalogue agent only once decoded (invalid UTF-8) is yours, not adoptable', () => {
  const s = setup();
  const a = shipped.get('voltagent/embedded-systems');
  const at = Buffer.from(a.raw.slice(0, a.raw.indexOf('�')), 'utf8').length;
  const good = Buffer.from(a.raw, 'utf8');
  const bad = Buffer.concat([good.subarray(0, at), Buffer.from([0xff]), good.subarray(at + 3)]);
  assert.equal(bad.toString('utf8'), a.raw, 'decodes to the catalogue text');
  fs.writeFileSync(path.join(s.fx.dir, 'embedded-lookalike.md'), bad);
  fs.writeFileSync(path.join(s.fx.dir, 'embedded-systems-real.md'), good);
  const m = s.it.adoptable().matches.map((x) => x.rel.split('/').pop());
  assert.ok(!m.includes('embedded-lookalike.md'));
  assert.ok(m.includes('embedded-systems-real.md'), 'the real bytes, U+FFFD and all, still match');
});

test('change 6: a failed ledger save during undo (each kind) or stop managing puts the files back', () => {
  for (const kind of ['add', 'adopt', 'update', 'remove', 'release']) {
    const s = setup();
    const e = s.fx.exact[0];
    const armed = { on: false };
    const cat = newer(shipped, [e.agentId]);
    let opId;
    const it = s.inst(cat, { fsApi: throwingLedger(armed) });
    if (kind === 'adopt') { s.it.adopt(); it.update(e.agentId); opId = JSON.parse(fs.readFileSync(s.it.ledgerPath, 'utf8')).ops[0].id; }
    else if (kind === 'update') { s.it.adopt(); opId = it.update(e.agentId).opId; }
    else if (kind === 'release') { s.it.adopt(); opId = it.stopManaging().opId; }
    else {
      const fresh = s.fx.own[0].replace('.md', '');
      const extra = shipped.catalog.agents.find((a) => !s.fx.adoptable.includes(`${a.slug}.md`) && !fs.existsSync(path.join(s.fx.dir, `${a.slug}.md`)) && a.id !== fresh);
      opId = it.add(extra.id, ['claude'], { catalogSha: cat.sha256 }).installId;
      if (kind === 'remove') opId = it.remove(extra.id).opId;
    }
    assert.ok(opId, kind);
    const before = s.fp({ mtime: false });
    const ledger = fs.readFileSync(s.it.ledgerPath, 'utf8');
    armed.on = true;
    const r = it.undo(opId);
    assert.equal(r.ok, false, kind);
    assert.equal(r.status, 'ledger', kind);
    assert.deepEqual(s.fp({ mtime: false }), before, `${kind}: files put back`);
    assert.equal(fs.readFileSync(s.it.ledgerPath, 'utf8'), ledger, `${kind}: ledger unchanged`);
    armed.on = false;
    assert.equal(it.undo(opId).ok, true, `${kind}: still undoable`);
  }
  const s = setup();
  s.it.adopt();
  const armed = { on: true };
  const before = s.fp();
  const ledger = fs.readFileSync(s.it.ledgerPath, 'utf8');
  assert.throws(() => s.inst(shipped, { fsApi: throwingLedger(armed) }).stopManaging());
  assert.deepEqual(s.fp(), before);
  assert.equal(fs.readFileSync(s.it.ledgerPath, 'utf8'), ledger);
});

test('change 6: after a hard kill (file written, ledger not), the file shows as yours and nothing touches it', () => {
  const s = setup();
  const e = s.fx.exact[0];
  const a = s.it.adopt();
  const cat = newer(shipped, [e.agentId]);
  const f = path.join(s.fx.dir, e.name);
  fs.writeFileSync(f, cat.get(e.agentId).raw);
  const killed = s.fp();
  const it = s.inst(cat);
  assert.equal(it.status().items.find((i) => i.path.endsWith(`/${e.name}`)).state, 'modified');
  assert.equal(it.update(e.agentId).results[0].outcome, 'skipped');
  assert.equal(it.remove(e.agentId).results[0].outcome, 'skipped');
  it.undo(a.opId);
  assert.deepEqual(s.fp(), killed);
});


// Review #54 M1: Node 22's cpSync makes every copied folder 755, so the mode
// check refused any folder with a 700, 750, 555 or 500 subfolder.
test('M1: subfolders that are 0700 and 0555 are backed up with their modes, and adopt succeeds', () => {
  const s = setup();
  const before = s.fp();
  const r = s.it.adopt();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.adopted.length, s.fx.adoptable.length);
  const b = s.it.backupPath(r.backup);
  for (const [d, mode] of Object.entries(s.fx.modeDirs)) assert.equal((fs.lstatSync(path.join(b, d)).mode & 0o7777).toString(8), mode.toString(8), d);
  assert.equal((fs.lstatSync(b).mode & 0o777).toString(8), '700', 'the backup folder itself stays 0700');
  assert.deepEqual(FP.fingerprint(b), before, 'the backup is the folder exactly, modes included');
  assert.deepEqual(s.fp(), before, 'the agents folder is untouched');
  for (const [d, mode] of Object.entries(s.fx.modeDirs)) assert.equal(fs.lstatSync(path.join(s.fx.dir, d)).mode & 0o7777, mode, `${d} in ~/.claude/agents unchanged`);
});

test('M1: a backup holding a 0555 folder can still be pruned, and a prune that fails never fails the adopt', () => {
  let t = Date.parse('2026-01-01T08:00:00Z');
  const s = setup();
  const it = s.inst(shipped, { now: () => (t += 60_000) });
  const first = it.adopt([`.claude/agents/${s.fx.exact[0].name}`]);
  assert.equal(first.ok, true, first.error);
  // Seven more backups of a changing folder, each adopt undone, so the old ones can go.
  let prev = it.adopt([`.claude/agents/${s.fx.exact[1].name}`]);
  for (let i = 0; i < 7; i++) {
    it.undo(prev.opId);
    fs.writeFileSync(path.join(s.fx.dir, `extra-${i}.md`), `x${i}`);
    prev = it.adopt([`.claude/agents/${s.fx.exact[1].name}`]);
    assert.equal(prev.ok, true, prev.error);
  }
  assert.ok(backupsOf(s).length <= 5, `${backupsOf(s).length} kept`);
  for (const b of backupsOf(s)) assert.equal(fs.lstatSync(path.join(s.data, 'agent-backups', b, 'locked')).mode & 0o7777, 0o555);
  // rmSync throwing during prune: the adopt still succeeds with its backup.
  it.undo(prev.opId);
  fs.writeFileSync(path.join(s.fx.dir, 'extra-last.md'), 'y');
  const fsApi = new Proxy(fs, { get: (tg, k) => (k === 'rmSync' ? () => { throw new Error('EPERM'); } : tg[k]) });
  const r = s.inst(shipped, { fsApi, now: () => (t += 60_000) }).adopt([`.claude/agents/${s.fx.exact[1].name}`]);
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.existsSync(s.it.backupPath(r.backup)));
});

test('M1: restoring folder modes never follows a link and never touches anything outside the backup', () => {
  const s = setup();
  const victim = path.join(s.home, 'elsewhere');
  fs.chmodSync(victim, 0o755);
  // Swap a copied folder for a link as soon as cpSync puts it in the backup.
  const fsApi = new Proxy(fs, { get: (tg, k) => (k === 'cpSync' ? (from, to, o) => { const out = tg.cpSync(from, to, o); if (String(to).endsWith('/private')) { tg.rmSync(to, { recursive: true }); tg.symlinkSync(victim, to); } return out; } : tg[k]) });
  const r = s.inst(shipped, { fsApi }).adopt();
  assert.equal(r.ok, false);
  assert.equal(fs.statSync(victim).mode & 0o7777, 0o755, 'the link target\'s mode is unchanged');
  assert.deepEqual(backupsOf(s), []);
});

// Review #54 M2 (poc10): a subfolder swapped for a link while it's copied,
// then put back. Setting modes from the source side went through the copied
// link and chmod'ed the folder it pointed to, outside the backup.
test('M2: a subfolder swapped for a link and back during the copy never changes a mode outside the backup', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.fx.dir, 'sub', 'inner'), { recursive: true });
  fs.chmodSync(path.join(s.fx.dir, 'sub', 'inner'), 0o700);
  const victim = path.join(s.home, 'victim');
  fs.mkdirSync(path.join(victim, 'inner'), { recursive: true });
  fs.chmodSync(path.join(victim, 'inner'), 0o755);
  fs.chmodSync(victim, 0o755);
  const S = path.join(s.fx.dir, 'sub'), HOLD = path.join(s.home, 'hold');
  let swapped = false, restored = false;
  const fsApi = new Proxy(fs, { get: (tg, k) => {
    if (k === 'mkdirSync') return (p, o) => { const r = tg.mkdirSync(p, o); if (/claude-agents-\d/.test(String(p)) && !swapped) { swapped = true; tg.renameSync(S, HOLD); tg.symlinkSync(victim, S); } return r; };
    if (k === 'symlinkSync') return (t, p, ty) => { const r = tg.symlinkSync(t, p, ty); if (swapped && !restored && String(p).includes('agent-backups') && path.basename(String(p)) === 'sub') { restored = true; tg.unlinkSync(S); tg.renameSync(HOLD, S); } return r; };
    return tg[k];
  } });
  const r = s.inst(shipped, { fsApi }).adopt();
  assert.ok(swapped && restored, 'the race ran');
  assert.equal(r.ok, false);
  assert.equal(fs.lstatSync(path.join(victim, 'inner')).mode & 0o7777, 0o755, 'victim/inner unchanged');
  assert.equal(fs.lstatSync(victim).mode & 0o7777, 0o755, 'victim unchanged');
  assert.deepEqual(backupsOf(s), [], 'no backup left');
  assert.equal(ownedCount(s), 0, 'nothing adopted');
  assert.deepEqual(s.it.status().ops ?? [], [], 'no op');
});

// Review #54 L2 nit: [ -e ] is false for a dangling link, so a planted one
// would be written through. Both checks also test -L.
test('L2: a dangling link where a restore folder would go counts as there, so nothing is copied or moved', { skip: process.platform !== 'darwin' }, () => {
  const s = setup();
  s.it = createAgentInstaller({ home: s.home, dataRoot: path.join(s.home, 'Library', 'Plexiform'), catalog: shipped, ledgerKey: Buffer.alloc(32, 9) });
  const a = s.it.adopt();
  assert.equal(a.ok, true, a.error);
  const tag = a.backup.replace(/^claude-agents-/, '');
  const [copy, swap] = s.it.restoreCommand(a.backup).split('\n');
  assert.ok(copy.includes(`[ -L "$HOME/.claude/agents-restored-${tag}" ]`) && swap.includes(`[ -L "$HOME/.claude/agents-old-${tag}" ]`));
  const sh = (line) => execFileSync('/bin/sh', ['-c', line], { env: { ...process.env, HOME: s.home } }).toString();
  const live = s.fp();
  const elsewhere = path.join(s.home, 'not-here');
  const R = path.join(s.home, '.claude', `agents-restored-${tag}`), O = path.join(s.home, '.claude', `agents-old-${tag}`);
  fs.symlinkSync(elsewhere, R);
  assert.match(sh(copy), /nothing was copied/);
  assert.equal(fs.existsSync(elsewhere), false, 'nothing written through the link');
  fs.unlinkSync(R);
  assert.equal(sh(copy), '');
  fs.symlinkSync(elsewhere, O);
  assert.match(sh(swap), /nothing was moved/);
  assert.equal(fs.existsSync(elsewhere), false);
  assert.deepEqual(s.fp(), live, 'the live folder is where it was');
});
