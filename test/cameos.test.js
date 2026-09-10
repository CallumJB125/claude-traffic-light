const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../cameos');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cameos-'));

test('slugify makes safe ids from names', () => {
  assert.equal(C.slugify('Dad'), 'dad');
  assert.equal(C.slugify('  Zoë  Smith!! '), 'zoe-smith');
  assert.equal(C.slugify('---'), '');
  assert.equal(C.slugify('x'.repeat(50)).length, 32);
  assert.match(C.slugify('A really long name that keeps going on-and-on'), C.ID_RE);
});

test('resolveId: slugs, never a built-in unless replacing, suffixed when taken', () => {
  assert.deepEqual(C.resolveId({}, { name: 'Dad' }), { id: 'dad' });
  assert.ok(C.resolveId({}, { name: 'Neo' }).error, 'a name that slugs to a built-in is refused');
  assert.ok(C.resolveId({}, { name: 'none' }).error);
  assert.ok(C.resolveId({}, { name: '  ' }).error, 'a name is required');
  assert.deepEqual(C.resolveId({}, { name: 'Neo', replace: 'neo' }), { id: 'neo' });
  assert.deepEqual(C.resolveId({}, { name: 'anything', replace: 'powell' }), { id: 'powell' });
  assert.ok(C.resolveId({}, { name: 'x', replace: 'dad' }).error, 'only built-ins can be replaced');
  const idx = { dad: {}, 'dad-2': {} };
  assert.deepEqual(C.resolveId(idx, { name: 'Dad' }), { id: 'dad-3' });
  const long = 'y'.repeat(32);
  assert.match(C.resolveId({ [long]: {} }, { name: long }).id, /^y{30}-2$/);
});

test('parseIndex is tolerant and fills anchor defaults', () => {
  assert.deepEqual(C.parseIndex('not json'), {});
  assert.deepEqual(C.parseIndex('[1,2]'), {});
  const idx = C.parseIndex(JSON.stringify({
    dad: { name: 'Dad', shape: 'rounded', addedAt: 5, eyes: { x: 0.3, y: 2 } },
    'Bad Id': { name: 'x' },
    neo: { mouth: { x: 'a' } },
    ghost: null,
  }));
  assert.deepEqual(Object.keys(idx).sort(), ['dad', 'neo']);
  assert.deepEqual(idx.dad, { name: 'Dad', eyes: { x: 0.3, y: 1 }, mouth: C.DEFAULT_MOUTH, shape: 'rounded', addedAt: 5 });
  assert.deepEqual(idx.neo, { name: 'Neo', eyes: C.DEFAULT_EYES, mouth: C.DEFAULT_MOUTH, shape: 'oval', addedAt: 0 });
  assert.deepEqual(C.DEFAULT_EYES, { x: 0.5, y: 0.4 });
  assert.deepEqual(C.DEFAULT_MOUTH, { x: 0.5, y: 0.75 });
});

test('withEntry / without merge and drop entries immutably', () => {
  const a = { dad: C.normalizeEntry('dad', { name: 'Dad' }) };
  const b = C.withEntry(a, 'mum', { name: 'Mum', shape: 'weird' });
  assert.equal(b.mum.shape, 'oval');
  assert.deepEqual(Object.keys(a), ['dad']);
  assert.deepEqual(Object.keys(C.without(b, 'dad')), ['mum']);
});

test('listing: built-ins first (drawn or photo), then user faces oldest first', () => {
  const idx = C.parseIndex(JSON.stringify({ zed: { name: 'Zed', addedAt: 2 }, amy: { name: 'Amy', addedAt: 9 }, powell: { name: 'Jay', addedAt: 1 } }));
  const l = C.listing(idx);
  assert.deepEqual(l.map((c) => c.id), [...C.BUILTINS, 'zed', 'amy']);
  assert.equal(l.find((c) => c.id === 'powell').photo, true);
  assert.equal(l.find((c) => c.id === 'powell').name, 'Jay');
  assert.equal(l.find((c) => c.id === 'neo').photo, false);
  assert.equal(l.find((c) => c.id === 'neo').name, 'Neo');
});

test('listing: a user photo beats a shipped one; only user photos are removable', () => {
  const shipped = C.parseIndex(JSON.stringify({ neo: { name: 'Neo', addedAt: 0 }, saylor: { name: 'Saylor', addedAt: 0 } }));
  const mine = C.parseIndex(JSON.stringify({ neo: { name: 'My Neo', addedAt: 5 }, dad: { name: 'Dad', addedAt: 6 } }));
  const l = C.listing(mine, shipped);
  const by = (id) => l.find((c) => c.id === id);
  assert.deepEqual([by('neo').name, by('neo').photo, by('neo').user], ['My Neo', true, true]);
  assert.deepEqual([by('saylor').name, by('saylor').photo, by('saylor').user], ['Saylor', true, false]);
  assert.deepEqual([by('alfred').photo, by('alfred').user], [false, false], 'alfred stays drawn');
  assert.deepEqual([by('dad').builtin, by('dad').user], [false, true]);
});

test('the shipped built-in photos: seven 256×256 faces with sane anchors, alfred drawn', () => {
  const dir = path.join(__dirname, '..', 'assets', 'cameos', 'built');
  const idx = C.loadIndex(dir);
  assert.deepEqual(Object.keys(idx).sort(), ['baker', 'ellison', 'mcafee', 'neo', 'powell', 'saylor', 'spagni']);
  for (const [id, e] of Object.entries(idx)) {
    const png = fs.readFileSync(path.join(dir, `${id}.png`));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', id);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256], id);
    assert.ok(e.mouth.y - e.eyes.y > 0.15 && e.eyes.y > 0.2 && e.mouth.y < 0.95, `${id} anchors`);
    assert.ok(C.BUILTINS.includes(id));
  }
});

test('applyMask: oval clears the corners and sides, rounded keeps the edge middles', () => {
  const n = 64;
  const full = () => Buffer.alloc(n * n * 4, 255);
  const a = (buf, x, y) => buf[(y * n + x) * 4 + 3];
  const oval = C.applyMask(full(), n, n, 'oval');
  assert.equal(a(oval, 0, 0), 0);
  assert.equal(a(oval, 1, 32), 0, 'the oval is narrower than the square');
  assert.equal(a(oval, 32, 32), 255);
  assert.equal(a(oval, 32, 1), 255, 'but reaches the top');
  const r = C.applyMask(full(), n, n, 'rounded');
  assert.equal(a(r, 0, 0), 0);
  assert.equal(a(r, 0, 32), 255);
  const mid = a(C.applyMask(full(), n, n, 'oval'), Math.round(32 - n * C.OVAL_RX), 32);
  assert.ok(mid > 0 && mid < 255, 'edges are anti-aliased');
});

test('squareRect keeps the crop square and inside the image', () => {
  assert.deepEqual(C.squareRect({ x: 390, y: -5, size: 999 }, 400, 300), { x: 100, y: 0, width: 300, height: 300 });
  assert.deepEqual(C.squareRect({ x: 10, y: 20, size: 100 }, 400, 300), { x: 10, y: 20, width: 100, height: 100 });
  assert.deepEqual(C.squareRect(null, 400, 300), { x: 0, y: 0, width: 180, height: 180 });
});

test('loadIndex drops entries whose photo is gone; removePhoto deletes both', () => {
  const dir = tmp();
  C.writeIndex(dir, { dad: { name: 'Dad' }, neo: { name: 'Neo' } });
  fs.writeFileSync(path.join(dir, 'dad.png'), 'x');
  assert.deepEqual(Object.keys(C.loadIndex(dir)), ['dad']);
  assert.equal(C.removePhoto(dir, 'neo'), false);
  assert.equal(C.removePhoto(dir, 'dad'), true);
  assert.equal(fs.existsSync(path.join(dir, 'dad.png')), false);
  assert.deepEqual(C.loadIndex(dir), {});
  assert.deepEqual(C.loadIndex(path.join(dir, 'missing')), {});
});

test('addPhoto refuses without an image or a usable name, before touching disk', () => {
  const dir = tmp();
  assert.ok(C.addPhoto({ dir, source: 'nope', name: 'Dad' }).error);
  assert.ok(C.addPhoto({ dir, source: 'data:image/png;base64,AAAA', name: 'Neo' }).error);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// The real crop → resize → mask → PNG path, in Electron (nativeImage).
let electronBin = null;
try { electronBin = require('electron'); } catch { /* not installed */ }
for (const shape of ['oval', 'rounded']) {
  test(`addPhoto (${shape}) cuts a 400×300 image to a 256×256 masked PNG`, { skip: typeof electronBin !== 'string' && 'electron not installed', timeout: 60000 }, () => {
    const dir = tmp();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electronBin, [path.join(__dirname, 'fixtures', 'cameo-cut.js'), dir, shape], { encoding: 'utf8', timeout: 45000, env });
    const line = (run.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `no result from electron: ${run.stderr}`);
    const out = JSON.parse(line.slice(7));
    assert.equal(out.res.id, 'test-face');
    assert.equal(out.signature, '89504e470d0a1a0a');
    assert.deepEqual([out.width, out.height], [256, 256]);
    assert.deepEqual(out.corners, [0, 0, 0, 0]);
    assert.equal(out.centre, 255);
    assert.equal(out.midLeft, shape === 'oval' ? 0 : 255);
    assert.equal(out.index['test-face'].shape, shape);
    assert.deepEqual(out.index['test-face'].eyes, { x: 0.5, y: 0.42 });
  });
}
