'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Git = require('../src/checkpoint-git');
const { createCheckpoints } = require('../src/checkpoints');
const bin = Git.findGit();
const skip = bin ? false : 'Git unavailable';
function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'undo-acceptance-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const top = path.join(base, 'project'), home = path.join(base, 'home'); fs.mkdirSync(top); fs.mkdirSync(home);
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const gitCmd = (...args) => execFileSync(bin, ['-C', top, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const write = (p, body) => { fs.mkdirSync(path.dirname(path.join(top, p)), { recursive: true }); fs.writeFileSync(path.join(top, p), body); };
  const read = p => fs.existsSync(path.join(top, p)) ? fs.readFileSync(path.join(top, p)) : null;
  write('first.txt', 'original\n'); write('second.txt', 'second\n'); write('.gitignore', 'private.env\n');
  gitCmd('init', '-q', '-b', 'main'); gitCmd('add', '-A'); gitCmd('commit', '-qm', 'Initial');
  const git = Git.createGit({ env, tmpdir: base });
  const cps = createCheckpoints({ rootDir: path.join(base, 'settings'), entitlements: { has: () => true, limits: () => ({ 'checkpoints.turns': 20, 'checkpoints.days': 7 }) }, git, ...options });
  cps.setConfig({ enabled: true });
  const start = (id = 'agent-a') => cps.turnStart({ sessionId: id, cwd: top });
  const end = (id = 'agent-a') => cps.turnEnd({ sessionId: id, cwd: top });
  return { base, top, git, cps, gitCmd, write, read, start, end };
}

test('Undo one agent preserves a later agent’s same-file and unrelated changes, staged index and HEAD', { skip }, async t => {
  const f = fixture(t);
  f.write('first.txt', 'staged by user\n'); f.gitCmd('add', 'first.txt');
  const index = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(f.top, '.git/index'))).digest('hex');
  const initialIndex = index(), head = f.gitCmd('rev-parse', 'HEAD');
  await f.start(); f.write('first.txt', 'agent A\n'); f.write('second.txt', 'agent A second\n'); f.write('added.txt', 'new by A\n'); await f.end();
  await f.start('agent-b'); f.write('first.txt', 'later work by B\n'); f.write('third.txt', 'B owns this\n'); await f.end('agent-b');
  f.write('private.env', 'private retained\n');
  const review = await f.cps.previewUndo('agent-a', 1);
  assert.equal(review.ok, true); assert.equal(review.eligible, 2); assert.equal(review.skipped, 1);
  assert.equal(review.files.find(x => x.path === 'first.txt').reason, 'later-change');
  const result = await f.cps.undo('agent-a', review.token);
  assert.equal(result.ok, true); assert.equal(result.written, 1); assert.equal(result.removed, 1);
  assert.equal(f.read('first.txt').toString(), 'later work by B\n'); assert.equal(f.read('second.txt').toString(), 'second\n');
  assert.equal(f.read('third.txt').toString(), 'B owns this\n'); assert.equal(f.read('added.txt'), null);
  assert.equal(f.read('private.env').toString(), 'private retained\n'); assert.equal(index(), initialIndex); assert.equal(f.gitCmd('rev-parse', 'HEAD'), head);
  assert.ok(result.safety); assert.equal(f.gitCmd('show', `refs/plexiform/cp/agent-a/safety-${result.safety}:second.txt`), 'agent A second\n');
  assert.equal((await f.cps.undo('agent-a', review.token)).reason, 'stale');
});

test('deleted-file recreation is refused without filesystem metadata; later replacements are kept', { skip }, async t => {
  const f = fixture(t); f.write('deleted.txt', 'restore me\n'); f.gitCmd('add', '-A'); f.gitCmd('commit', '-qm', 'More');
  await f.start(); fs.unlinkSync(path.join(f.top, 'deleted.txt')); fs.unlinkSync(path.join(f.top, 'second.txt')); f.write('new.txt', 'A'); await f.end();
  f.write('second.txt', 'recreated by B'); f.write('new.txt', 'modified by B');
  const p = await f.cps.previewUndo('agent-a', 1); assert.equal(p.eligible, 0); assert.equal(p.skipped, 3);
  assert.equal(p.files.find(x => x.path === 'deleted.txt').reason, 'metadata');
  assert.equal((await f.cps.undo('agent-a', p.token)).ok, true);
  assert.equal(f.read('deleted.txt'), null); assert.equal(f.read('second.txt').toString(), 'recreated by B'); assert.equal(f.read('new.txt').toString(), 'modified by B');
});

test('binary contents restore exactly while permission changes are kept', { skip }, async t => {
  const f = fixture(t), original = Buffer.from([0, 255, 128, 13, 10, 1]);
  f.write('binary.dat', original); f.gitCmd('add', '-A'); f.gitCmd('commit', '-qm', 'Binary');
  await f.start(); f.write('binary.dat', Buffer.from([0, 253, 14])); fs.chmodSync(path.join(f.top, 'first.txt'), 0o755); await f.end();
  const p = await f.cps.previewUndo('agent-a', 1); assert.equal(p.eligible, 1); assert.equal(p.files.find(x => x.path === 'first.txt').reason, 'metadata');
  assert.equal((await f.cps.undo('agent-a', p.token)).ok, true); assert.deepEqual(f.read('binary.dat'), original);
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(f.top, 'first.txt')).mode & 0o111);
});

test('restoring private content preserves mode0600 and the existing inode', { skip: skip || process.platform === 'win32' }, async t => {
  const f = fixture(t); fs.chmodSync(path.join(f.top, 'first.txt'), 0o600);
  await f.start(); f.write('first.txt', 'A'); await f.end(); const before = fs.statSync(path.join(f.top, 'first.txt'));
  const p = await f.cps.previewUndo('agent-a', 1); assert.equal(p.eligible, 1); assert.equal((await f.cps.undo('agent-a', p.token)).ok, true);
  const after = fs.statSync(path.join(f.top, 'first.txt')); assert.equal(after.mode & 0o777, 0o600); assert.equal(after.ino, before.ino); assert.equal(f.read('first.txt').toString(), 'original\n');
});

test('macOS extended metadata survives content Undo', { skip: skip || process.platform !== 'darwin' }, async t => {
  const f = fixture(t), file = path.join(f.top, 'first.txt');
  execFileSync('/usr/bin/xattr', ['-w', 'com.plexiform.undo-test', 'keep-metadata', file]);
  await f.start(); f.write('first.txt', 'A'); await f.end(); const p = await f.cps.previewUndo('agent-a', 1);
  assert.equal((await f.cps.undo('agent-a', p.token)).ok, true);
  assert.equal(execFileSync('/usr/bin/xattr', ['-p', 'com.plexiform.undo-test', file], { encoding: 'utf8' }).trim(), 'keep-metadata');
});

test('expiry during asynchronous checks refuses before the first effect', { skip }, async t => {
  let time = Date.now(), expire = false;
  const f = fixture(t, { now: () => time, isBusy: async () => { if (expire) { time += 45001; expire = false; } return false; } });
  await f.start(); f.write('first.txt', 'A'); await f.end(); const p = await f.cps.previewUndo('agent-a', 1); expire = true;
  assert.equal((await f.cps.undo('agent-a', p.token)).reason, 'stale'); assert.equal(f.read('first.txt').toString(), 'A');
});

test('expiry at the final busy check cannot pass through to the file write', { skip }, async t => {
  let time = Date.now(), checks = 0, gate = false;
  const f = fixture(t, { now: () => time, isBusy: async () => { if (gate && ++checks === 5) time += 45001; return false; } });
  await f.start(); f.write('first.txt', 'A'); await f.end(); const p = await f.cps.previewUndo('agent-a', 1); gate = true;
  const r = await f.cps.undo('agent-a', p.token); assert.equal(r.ok, false); assert.equal(f.read('first.txt').toString(), 'A'); assert.ok(checks >= 5);
});

test('explicit cancellation consumes the review and prevents replay', { skip }, async t => {
  const f = fixture(t); await f.start(); f.write('first.txt', 'A'); await f.end(); const p = await f.cps.previewUndo('agent-a', 1);
  assert.equal(f.cps.cancelUndo('agent-b', p.token), false); assert.equal(f.cps.cancelUndo('agent-a', p.token), true);
  assert.equal((await f.cps.undo('agent-a', p.token)).reason, 'stale'); assert.equal(f.read('first.txt').toString(), 'A');
});

test('production checkpoint IPC binds review to exact document and revokes on navigation', { skip }, async t => {
  const f = fixture(t); await f.start(); f.write('first.txt', 'A'); await f.end();
  const { EventEmitter } = require('node:events'), Module = require('node:module');
  const wc = new EventEmitter(); wc.mainFrame = {}; wc.isDestroyed = () => false; wc.send = () => {};
  const calls = new Map(), closers = [], original = Module._load;
  const electron = { dialog: {}, BrowserWindow: {} };
  try {
    Module._load = function (id, ...args) { return id === 'electron' ? electron : original.call(this, id, ...args); };
    require('../src/checkpoints').register({ rootDir: path.join(f.base, 'settings'), entitlements: { has: () => true, limits: () => ({}) }, ipcMain: { handle: (name, fn) => calls.set(name, fn) }, fromPage: (e, p) => p === 'checkpoints' && e.sender === wc && e.senderFrame === wc.mainFrame, buddy: () => ({ pageWebContents: () => wc }), onQuit: fn => closers.push(fn), log: () => {} });
  } finally { Module._load = original; }
  t.after(() => closers.forEach(fn => fn()));
  const e = { sender: wc, senderFrame: wc.mainFrame };
  const p = await calls.get('checkpoints:undo-preview')(e, 'agent-a', 1); assert.equal(p.ok, true);
  assert.equal(await calls.get('checkpoints:undo')({ ...e, senderFrame: {} }, 'agent-a', p.token), null);
  wc.emit('did-start-navigation');
  assert.equal((await calls.get('checkpoints:undo')(e, 'agent-a', p.token)).reason, 'stale'); assert.equal(f.read('first.txt').toString(), 'A');
  const again = await calls.get('checkpoints:undo-preview')(e, 'agent-a', 1); assert.equal(again.ok, true);
  assert.equal(await calls.get('checkpoints:undo-cancel')(e, 'agent-a', again.token), true);
  assert.equal((await calls.get('checkpoints:undo')(e, 'agent-a', again.token)).reason, 'stale');
});

test('a file edit after the safety snapshot is preserved and no files are undone', { skip }, async t => {
  const f = fixture(t); await f.start(); f.write('first.txt', 'A'); f.write('second.txt', 'A second'); await f.end();
  const p = await f.cps.previewUndo('agent-a', 1), original = f.git.updateRef;
  f.git.updateRef = async (...args) => { const r = await original(...args); if (args[1].includes('/safety-')) f.write('first.txt', 'B raced'); return r; };
  const r = await f.cps.undo('agent-a', p.token); assert.equal(r.ok, false); assert.equal(f.read('first.txt').toString(), 'B raced'); assert.equal(f.read('second.txt').toString(), 'A second'); assert.ok(r.safety);
});

test('changed review refuses all effects even when the change is outside the selected turn', { skip }, async t => {
  const f = fixture(t); await f.start(); f.write('first.txt', 'A'); await f.end();
  const p = await f.cps.previewUndo('agent-a', 1); f.write('second.txt', 'B after review');
  assert.equal((await f.cps.undo('agent-a', p.token)).reason, 'stale'); assert.equal(f.read('first.txt').toString(), 'A');
});

test('stage-only change or branch switch invalidates the review', { skip }, async t => {
  const f = fixture(t); await f.start(); f.write('first.txt', 'A'); await f.end();
  let p = await f.cps.previewUndo('agent-a', 1); f.gitCmd('add', 'first.txt');
  assert.equal((await f.cps.undo('agent-a', p.token)).reason, 'stale');
  p = await f.cps.previewUndo('agent-a', 1); f.gitCmd('switch', '-qc', 'other');
  assert.equal((await f.cps.undo('agent-a', p.token)).reason, 'stale'); assert.equal(f.read('first.txt').toString(), 'A');
});

test('old turns and missed starts cannot be attributed to a safe Undo', { skip }, async t => {
  const f = fixture(t); f.write('first.txt', 'A'); await f.end();
  assert.equal((await f.cps.previewUndo('agent-a', 1)).reason, 'unattributed');
  await f.start(); f.write('second.txt', 'B'); await f.end();
  const proof = path.join(f.base, 'settings/checkpoints/turns/agent-a-t2.json'); fs.unlinkSync(proof);
  assert.equal((await f.cps.previewUndo('agent-a', 2)).reason, 'unattributed');
});

test('observed overlapping turns cannot undo each other even after both finish', { skip }, async t => {
  const f = fixture(t); await f.start(); await f.start('agent-b'); f.write('first.txt', 'shared'); await f.end(); await f.end('agent-b');
  assert.equal((await f.cps.previewUndo('agent-a', 1)).reason, 'overlap'); assert.equal((await f.cps.previewUndo('agent-b', 1)).reason, 'overlap');
  assert.equal((await f.cps.turns('agent-a')).turns[0].undoAvailable, false);
});

test('a later active turn blocks a previously reviewed Undo', { skip }, async t => {
  const f = fixture(t); await f.start(); f.write('first.txt', 'A'); await f.end(); const p = await f.cps.previewUndo('agent-a', 1);
  await f.start('agent-b'); assert.equal((await f.cps.undo('agent-a', p.token)).reason, 'busy'); assert.equal(f.read('first.txt').toString(), 'A');
});

test('expired reviews, wrong session and retired documents never write', { skip }, async t => {
  let time = Date.now(); const f = fixture(t, { now: () => time }); await f.start(); f.write('first.txt', 'A'); await f.end();
  let p = await f.cps.previewUndo('agent-a', 1); time += 45001;
  assert.equal((await f.cps.undo('agent-a', p.token)).reason, 'stale');
  p = await f.cps.previewUndo('agent-a', 1); assert.equal((await f.cps.undo('agent-b', p.token)).reason, 'stale');
  p = await f.cps.previewUndo('agent-a', 1); assert.equal((await f.cps.undo('agent-a', p.token, { current: () => false })).reason, 'unavailable');
  assert.equal(f.read('first.txt').toString(), 'A');
});

test('symlink and directory replacements are preserved; external contents stay untouched', { skip: skip || process.platform === 'win32' }, async t => {
  const f = fixture(t); await f.start(); f.write('first.txt', 'A'); fs.unlinkSync(path.join(f.top, 'second.txt')); await f.end();
  const outside = path.join(f.base, 'outside'); fs.writeFileSync(outside, 'outside'); fs.unlinkSync(path.join(f.top, 'first.txt')); fs.symlinkSync(outside, path.join(f.top, 'first.txt'));
  fs.mkdirSync(path.join(f.top, 'second.txt')); fs.writeFileSync(path.join(f.top, 'second.txt/untracked'), 'keep');
  const p = await f.cps.previewUndo('agent-a', 1); assert.equal(p.eligible, 0); assert.equal(p.skipped, 2);
  assert.equal((await f.cps.undo('agent-a', p.token)).ok, true); assert.equal(fs.readFileSync(outside, 'utf8'), 'outside'); assert.equal(fs.readFileSync(path.join(f.top, 'second.txt/untracked'), 'utf8'), 'keep');
});

test('attributes, autocrlf and private info attributes are conservatively refused', { skip }, async t => {
  const f = fixture(t); f.write('.gitattributes', '*.txt text\n'); f.gitCmd('add', '-A'); f.gitCmd('commit', '-qm', 'Attributes');
  await f.start(); f.write('first.txt', 'A'); await f.end(); let p = await f.cps.previewUndo('agent-a', 1);
  assert.equal(p.eligible, 0); assert.equal(p.files[0].reason, 'attributes');
  f.gitCmd('config', 'core.autocrlf', 'true'); assert.equal((await f.cps.previewUndo('agent-a', 1)).reason, 'attributes');
  f.gitCmd('config', 'core.autocrlf', 'false'); fs.writeFileSync(path.join(f.top, '.git/info/attributes'), '*.txt text\n');
  assert.equal((await f.cps.previewUndo('agent-a', 1)).reason, 'attributes');
});

test('unchanged files whose parent became a symlink are skipped', { skip: skip || process.platform === 'win32' }, async t => {
  const f = fixture(t); f.write('folder/file', 'original'); f.gitCmd('add', '-A'); f.gitCmd('commit', '-qm', 'Folder');
  await f.start(); f.write('folder/file', 'A'); await f.end();
  const outside = path.join(f.base, 'external'); fs.renameSync(path.join(f.top, 'folder'), outside); fs.symlinkSync(outside, path.join(f.top, 'folder'));
  const p = await f.cps.previewUndo('agent-a', 1); assert.equal(p.eligible, 0); assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'A');
});

test('Undo history survives service restart without silently treating old snapshots as exact', { skip }, async t => {
  const f = fixture(t); await f.start(); f.write('first.txt', 'A'); await f.end();
  const reopened = createCheckpoints({ rootDir: path.join(f.base, 'settings'), git: f.git, entitlements: { has: () => true, limits: () => ({}) } });
  const p = await reopened.previewUndo('agent-a', 1); assert.equal(p.ok, true); assert.equal((await reopened.undo('agent-a', p.token)).ok, true); assert.equal(f.read('first.txt').toString(), 'original\n');
});
