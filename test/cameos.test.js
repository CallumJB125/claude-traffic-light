const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
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

// 8-bit RGBA PNGs (what Pillow writes for the built faces), alpha only.
function pngAlpha(buf) {
  let pos = 8;
  let w; let h; let type;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = `${data[8]}/${data[9]}/${data[12]}`; }
    if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  assert.equal(type, '8/6/0', 'an 8-bit, non-interlaced RGBA png');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const r = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      px[y * stride + x] = (r + [0, a, b, (a + b) >> 1, paeth][f]) & 255;
    }
  }
  return { width: w, height: h, alpha: (x, y) => px[(y * w + x) * 4 + 3] };
}

test('the shipped built-in photos: seven 60×60 faces cut along the head, not an oval', () => {
  const dir = path.join(__dirname, '..', 'assets', 'cameos', 'built');
  const idx = C.loadIndex(dir);
  assert.deepEqual(Object.keys(idx).sort(), ['baker', 'ellison', 'mcafee', 'neo', 'powell', 'saylor', 'spagni']);
  let beyondOval = 0;
  for (const [id, e] of Object.entries(idx)) {
    const png = fs.readFileSync(path.join(dir, `${id}.png`));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', id);
    const img = pngAlpha(png);
    assert.deepEqual([img.width, img.height], [C.SIZE, C.SIZE], id);
    assert.ok(e.mouth.y - e.eyes.y > 0.15 && e.eyes.y > 0.2 && e.mouth.y < 0.95, `${id} anchors`);
    assert.ok(C.BUILTINS.includes(id));
    // the anchors still land on the face at 60px
    const at = (p) => img.alpha(Math.floor(p.x * C.SIZE), Math.floor(p.y * C.SIZE));
    assert.equal(at(e.eyes), 255, `${id} eyes on the face`);
    assert.equal(at(e.mouth), 255, `${id} mouth on the face`);
    // above the neck fade the edge is hard: every pixel is in or out
    const body = Math.floor(C.SIZE * 0.85);
    const levels = new Set();
    for (let y = 0; y < body; y += 1) for (let x = 0; x < C.SIZE; x += 1) {
      const a = img.alpha(x, y);
      levels.add(a);
      if (a && C.coverage(x + 0.5, y + 0.5, C.SIZE, 'oval') === 0) beyondOval += 1;
    }
    assert.deepEqual([...levels].sort((a, b) => a - b), [0, 255], `${id} edge levels`);
    assert.ok(img.alpha(C.SIZE / 2, C.SIZE - 1) < 128, `${id} neck fades out`);
  }
  // hair and ears outside where the old oval would have cut them
  assert.ok(beyondOval > 100, `only ${beyondOval} face pixels outside the oval`);
});

test('hasAlpha: a cut-out has see-through pixels, a photo or screenshot does not', () => {
  const n = 100;
  const opaque = Buffer.alloc(n * n * 4, 255);
  assert.equal(C.hasAlpha(opaque), false);
  const speck = Buffer.from(opaque);
  for (let i = 0; i < n * n * 0.005; i += 1) speck[i * 4 + 3] = 0;
  assert.equal(C.hasAlpha(speck), false, 'a few stray pixels are not a cut-out');
  const cut = Buffer.from(opaque);
  for (let i = 0; i < n * n * 0.3; i += 1) cut[i * 4 + 3] = 0;
  assert.equal(C.hasAlpha(cut), true);
});

test('shapeAlpha pulls the edge in and never adds alpha; finishAlpha makes it hard and fades the neck', () => {
  const n = 20;
  const buf = Buffer.alloc(n * n * 4, 0);
  const put = (x, y, v) => buf.fill(v, (y * n + x) * 4, (y * n + x) * 4 + 4);
  for (let y = 5; y < 15; y += 1) for (let x = 5; x < 15; x += 1) put(x, y, 200);
  C.shapeAlpha(buf, n, n, n);
  const a = (b, x, y) => b[(y * n + x) * 4 + 3];
  assert.ok(a(buf, 5, 5) < 20 && a(buf, 5, 10) < 60, 'the outer ring is eroded, softened');
  assert.equal(a(buf, 10, 10), 200, 'the middle keeps its alpha');
  assert.equal(a(buf, 2, 2), 0, 'outside stays clear');
  assert.equal(buf[(10 * n + 10) * 4], 200, 'premultiplied colour follows the alpha');
  const hard = C.finishAlpha(Buffer.from(buf), n, n, false);
  assert.equal(a(hard, 10, 10), 255);
  assert.equal(hard[(10 * n + 10) * 4], 255, 'colour scales up with it');
  assert.deepEqual(new Set(Array.from({ length: n * n }, (_, i) => hard[i * 4 + 3])), new Set([0, 255]));
  // under the mouth row the silhouette is trimmed to the oval (no collars)
  const jaw = C.shapeAlpha(Buffer.alloc(n * n * 4, 255), n, n, n / 2);
  assert.equal(a(jaw, 0, 0), 255, 'hair out at the top corner is kept');
  assert.equal(a(jaw, 0, n - 1), 0, 'a shoulder at the bottom corner is not');
  assert.equal(a(jaw, n / 2, n - 3), 255, 'the chin, inside the oval, is kept');
  const full = Buffer.alloc(n * n * 4, 255);
  C.finishAlpha(full, n, n, true);
  assert.equal(a(full, 3, 0), 255);
  assert.ok(a(full, 3, n - 1) < 80 && a(full, 3, n - 2) > a(full, 3, n - 1) && a(full, 3, n - 2) < 255, 'the bottom rows fade');
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
for (const mode of ['oval', 'rounded', 'cutout']) {
  test(`addPhoto (${mode}) cuts a 400×300 image to a 60×60 PNG`, { skip: typeof electronBin !== 'string' && 'electron not installed', timeout: 60000 }, () => {
    const dir = tmp();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electronBin, [path.join(__dirname, 'fixtures', 'cameo-cut.js'), dir, mode], { encoding: 'utf8', timeout: 45000, env });
    const line = (run.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `no result from electron: ${run.stderr}`);
    const out = JSON.parse(line.slice(7));
    assert.equal(out.res.id, 'test-face');
    assert.equal(out.signature, '89504e470d0a1a0a');
    assert.deepEqual([out.width, out.height], [60, 60]);
    assert.equal(out.centre, 255);
    assert.deepEqual(out.edgeLevels, [0, 255], 'a hard pixel edge');
    if (mode === 'cutout') {
      // an opaque photo gets the oval; one with its own transparency is cut
      // along it: here square top corners, and clear below the shape
      assert.deepEqual(out.corners, [255, 255, 0, 0]);
      assert.equal(out.midLeft, 255);
      assert.equal(out.lowCentre, 0);
    } else {
      assert.deepEqual(out.corners, [0, 0, 0, 0]);
      assert.equal(out.midLeft, mode === 'oval' ? 0 : 255);
      assert.equal(out.lowCentre, 255);
    }
    assert.equal(out.index['test-face'].shape, mode === 'rounded' ? 'rounded' : 'oval');
    assert.deepEqual(out.index['test-face'].eyes, { x: 0.5, y: 0.42 });
  });
}
