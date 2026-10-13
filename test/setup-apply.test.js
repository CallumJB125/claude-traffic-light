const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { plan, apply, undo, LIMITS } = require('../src/setup-apply.js');
const { testTempDir } = require('./helpers/tmp');

const dirOf = (t) => fs.realpathSync(testTempDir('plx-setupapply-', t));
const code = (c) => (e) => e.code === c;

test('plan is a dry run: reports create/update/unchanged and writes nothing', (t) => {
  const d = dirOf(t);
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(d, 'same.txt'), 'x');
  const p = plan({ files: [
    { path: 'a.txt', content: 'one\nthree\n' },
    { path: 'sub/new.txt', content: 'hi' },
    { path: 'same.txt', content: 'x' },
  ] }, d);
  assert.deepEqual(p.entries.map(e => e.action), ['update', 'create', 'unchanged']);
  assert.match(p.entries[0].diff, /-two\n\+three/);
  assert.equal(p.changes, 2);
  assert.equal(fs.existsSync(path.join(d, 'sub')), false);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'one\ntwo\n');
});

test('apply requires the matching confirm token', (t) => {
  const d = dirOf(t);
  const setup = { files: [{ path: 'a.txt', content: 'A' }] };
  assert.throws(() => apply(setup, d, undefined), code('NOT_CONFIRMED'));
  assert.throws(() => apply(setup, d, 'nope'), code('NOT_CONFIRMED'));
  assert.equal(fs.existsSync(path.join(d, 'a.txt')), false);
  const stale = plan(setup, d).token;
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed since review');
  assert.throws(() => apply(setup, d, stale), code('NOT_CONFIRMED'));
});

test('apply writes files and undo restores prior state', (t) => {
  const d = dirOf(t);
  fs.writeFileSync(path.join(d, 'a.txt'), 'old');
  const setup = { files: [{ path: 'a.txt', content: 'new' }, { path: 'x/y/b.txt', content: 'B' }] };
  const r = apply(setup, d, plan(setup, d).token);
  assert.deepEqual(r.written, ['a.txt', 'x/y/b.txt']);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(d, 'x/y/b.txt'), 'utf8'), 'B');
  const u = undo(d, r.id);
  assert.deepEqual(u.skipped, []);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(d, 'x')), false);
  assert.throws(() => undo(d, r.id), code('NO_UNDO'));
});

test('undo leaves files the user edited after apply', (t) => {
  const d = dirOf(t);
  const setup = { files: [{ path: 'a.txt', content: 'A' }] };
  const r = apply(setup, d, plan(setup, d).token);
  fs.writeFileSync(path.join(d, 'a.txt'), 'user edit');
  assert.deepEqual(undo(d, r.id), { restored: [], skipped: ['a.txt'] });
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'user edit');
});

test('rejects traversal, absolute, backslash, NUL and reserved paths', (t) => {
  const d = dirOf(t);
  for (const [p, c] of [['../out.txt', 'TRAVERSAL'], ['a/../../out', 'TRAVERSAL'], ['a//b', 'TRAVERSAL'], ['/etc/x', 'ABSOLUTE_PATH'],
    ['C:/x', 'ABSOLUTE_PATH'], ['a\\b', 'BAD_PATH'], ['a\0b', 'BAD_PATH'], ['.plexiform-undo/x.json', 'BAD_PATH'], ['', 'BAD_PATH']]) {
    assert.throws(() => plan({ files: [{ path: p, content: 'x' }] }, d), code(c), p);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(d)).filter(n => n === 'out.txt'), []);
});

test('rejects symlinked components, symlink targets and a symlinked folder', (t) => {
  const d = dirOf(t);
  const outside = dirOf(t);
  fs.symlinkSync(outside, path.join(d, 'link'));
  fs.symlinkSync(path.join(outside, 'f'), path.join(d, 'file-link'));
  assert.throws(() => plan({ files: [{ path: 'link/x.txt', content: 'x' }] }, d), code('SYMLINK'));
  assert.throws(() => plan({ files: [{ path: 'file-link', content: 'x' }] }, d), code('SYMLINK'));
  const top = path.join(dirOf(t), 'top');
  fs.symlinkSync(outside, top);
  assert.throws(() => plan({ files: [{ path: 'x', content: 'x' }] }, top), code('BAD_FOLDER'));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('rejects relative folders, bad setups and size overruns', (t) => {
  const d = dirOf(t);
  assert.throws(() => plan({ files: [{ path: 'a', content: 'x' }] }, 'rel/dir'), code('BAD_FOLDER'));
  assert.throws(() => plan({ files: [{ path: 'a', content: 'x' }] }, path.join(d, 'missing')), code('BAD_FOLDER'));
  assert.throws(() => plan({ files: [] }, d), code('BAD_SETUP'));
  assert.throws(() => plan({ files: [{ path: 'a', content: 5 }] }, d), code('BAD_SETUP'));
  assert.throws(() => plan({ files: [{ path: 'a', content: 'x' }, { path: 'a', content: 'y' }] }, d), code('BAD_PATH'));
  assert.throws(() => plan({ files: [{ path: 'a', content: 'x'.repeat(LIMITS.fileBytes + 1) }] }, d), code('TOO_LARGE'));
  const many = Array.from({ length: LIMITS.files + 1 }, (_, i) => ({ path: `f${i}`, content: '' }));
  assert.throws(() => plan({ files: many }, d), code('TOO_LARGE'));
  const big = Array.from({ length: 5 }, (_, i) => ({ path: `b${i}`, content: 'x'.repeat(LIMITS.fileBytes) }));
  assert.throws(() => plan({ files: big }, d), code('TOO_LARGE'));
});

test('a directory in place of a file is rejected', (t) => {
  const d = dirOf(t);
  fs.mkdirSync(path.join(d, 'a'));
  assert.throws(() => plan({ files: [{ path: 'a', content: 'x' }] }, d), code('BAD_PATH'));
});
