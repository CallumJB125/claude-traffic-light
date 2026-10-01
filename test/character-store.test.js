const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Store = require('../src/character-store.js');
const Hatch = require('../characters/hatch.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chars-'));
const make = (over = {}) => { const dir = tmp(); const logs = []; return { dir, logs, store: Store.create({ dir: path.join(dir, 'characters'), log: (m) => logs.push(m), ...over }) }; };
const otter = () => Hatch.templateCharacter({ name: 'Otter', shape: 'animal', color: '#4f9be0' });

test('store: save then list round-trips the validated character and how it was made', () => {
  const { store } = make();
  const saved = store.save(otter(), { params: Hatch.normalizeParams({ name: 'Otter' }) });
  assert.equal(saved.id, 'u-otter');
  const [one] = store.list();
  assert.equal(one.character.id, 'u-otter'); assert.equal(one.character.name, 'Otter');
  assert.equal(one.meta.source, 'hatch'); assert.equal(one.meta.params.name, 'Otter'); assert.ok(one.meta.createdAt > 0);
});

test('store: files are private (0600 in 0700 folders) on POSIX', { skip: process.platform === 'win32' }, () => {
  const { store, dir } = make();
  store.save(otter());
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(path.join(dir, 'characters')), 0o700);
  assert.equal(mode(path.join(dir, 'characters', 'u-otter')), 0o700);
  assert.equal(mode(path.join(dir, 'characters', 'u-otter', 'character.json')), 0o600);
});

test('store: what is written is the validator\'s output, never the input: a handler and extra fields are gone from disk', () => {
  const { store, dir } = make();
  store.save({ ...otter(), extra: { secret: 'x' }, sprite: { body: '<rect width="2" height="2" fill="#fff" onclick="stealThis()"/>' } });
  const disk = fs.readFileSync(path.join(dir, 'characters', 'u-otter', 'character.json'), 'utf8');
  for (const bad of ['onclick', 'stealThis', 'extra', 'secret']) assert.ok(!disk.includes(bad), bad);
});

test('store: art with a script element is refused outright, and nothing is written', () => {
  const { store, dir } = make();
  assert.throws(() => store.save({ ...otter(), sprite: { body: '<rect width="2" height="2" fill="#fff"/><script>steal()</script>' } }), /not valid/);
  assert.ok(!fs.existsSync(path.join(dir, 'characters', 'u-otter')));
});

test('store: an invalid character is refused with the validator\'s errors, and nothing is written', () => {
  const { store, dir } = make();
  assert.throws(() => store.save({ id: 'x' }), (e) => /not valid/.test(e.message) && Array.isArray(e.errors) && e.errors.length > 0);
  assert.ok(!fs.existsSync(path.join(dir, 'characters')) || fs.readdirSync(path.join(dir, 'characters')).length === 0);
});

test('store: an existing id is not overwritten unless asked; freeId finds the next free one', () => {
  const { store } = make();
  store.save(otter());
  assert.throws(() => store.save(otter()), /already exists/);
  assert.equal(store.freeId('Otter'), 'u-otter-2');
  store.save({ ...otter(), id: 'otter-2' });
  assert.equal(store.freeId('otter'), 'u-otter-3');
  store.save({ ...otter(), name: 'Renamed' }, { overwrite: true });
  assert.equal(store.list().find((c) => c.character.id === 'u-otter').character.name, 'Renamed');
  for (const odd of ['', '../..', '9lives', 'U-Bad Name!', 'x'.repeat(80)]) assert.match(store.freeId(odd), /^u-[a-z][a-z0-9-]{1,31}$/, odd);
});

test('store: remove deletes a character; ids that are not ids never reach a path', () => {
  const { store, dir } = make();
  store.save(otter());
  assert.equal(store.remove('u-otter'), true);
  assert.equal(store.remove('u-otter'), false);
  fs.mkdirSync(path.join(dir, 'keep-me'));
  for (const bad of ['../keep-me', '..', '.', 'u-../x', '/etc', 'u-otter/../..', '', null, undefined, 7, 'u-' + 'x'.repeat(40)]) assert.throws(() => store.remove(bad), /not a character id/, String(bad));
  assert.ok(fs.existsSync(path.join(dir, 'keep-me')));
});

test('store: list skips what it should not trust: bad JSON, invalid characters, a folder whose id differs, huge files, symlinks', { skip: process.platform === 'win32' }, () => {
  const { store, dir, logs } = make();
  store.save(otter());
  const root = path.join(dir, 'characters');
  const plant = (name, body) => { fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'character.json'), body); };
  plant('u-badjson', '{not json');
  plant('u-invalid', JSON.stringify({ id: 'u-invalid', name: 'x' }));
  plant('u-mismatch', JSON.stringify(otter()));
  plant('u-huge', ' '.repeat(Store.LIMITS.fileBytes + 10));
  fs.mkdirSync(path.join(dir, 'outside')); fs.writeFileSync(path.join(dir, 'outside', 'character.json'), JSON.stringify({ ...otter(), id: 'u-linked' }));
  fs.symlinkSync(path.join(dir, 'outside'), path.join(root, 'u-linked'));
  fs.writeFileSync(path.join(root, 'u-afile'), 'x');
  fs.mkdirSync(path.join(root, 'not an id'));
  fs.mkdirSync(path.join(root, 'u-nofile'));
  const ids = store.list().map((c) => c.character.id);
  assert.deepEqual(ids, ['u-otter']);
  assert.ok(logs.length >= 5, logs.join('\n'));
  // a symlinked folder is not removable through the store, and the target survives
  assert.equal(store.remove('u-linked'), false);
  assert.ok(fs.existsSync(path.join(dir, 'outside', 'character.json')));
});

test('store: a character file that is itself a symlink is not followed', { skip: process.platform === 'win32' }, () => {
  const { store, dir } = make();
  store.save(otter());
  const f = path.join(dir, 'characters', 'u-otter', 'character.json');
  fs.writeFileSync(path.join(dir, 'secret.json'), JSON.stringify(otter()));
  fs.rmSync(f); fs.symlinkSync(path.join(dir, 'secret.json'), f);
  assert.deepEqual(store.list(), []);
});

test('store: the count is capped', () => {
  const { store } = make();
  for (let i = 0; i < Store.LIMITS.count; i += 1) store.save({ ...otter(), id: `pet-${i}` });
  assert.throws(() => store.save({ ...otter(), id: 'one-too-many' }), /at most/);
  assert.equal(store.list().length, Store.LIMITS.count);
});

test('store: a symlink planted where the temp file goes is not written through', { skip: process.platform === 'win32' }, () => {
  const { store, dir } = make();
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'untouched');
  const folder = path.join(dir, 'characters', 'u-otter');
  fs.mkdirSync(folder, { recursive: true });
  fs.symlinkSync(victim, path.join(folder, `character.json.tmp-${process.pid}`));
  store.save(otter(), { overwrite: true });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'character.json'), 'utf8')).id, 'u-otter');
});

test('store: list scans a bounded number of entries, so thousands of planted folders cannot stall it', () => {
  const { store, dir } = make();
  const root = path.join(dir, 'characters');
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < Store.LIMITS.count * 4 + 50; i += 1) fs.mkdirSync(path.join(root, `u-plant-${String(i).padStart(4, '0')}`));
  const t0 = Date.now();
  assert.deepEqual(store.list(), []);
  assert.ok(Date.now() - t0 < 2000);
  for (let i = 0; i < 70; i += 1) store.list();
});
