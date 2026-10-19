const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SpritePackMain = require('../src/sprite-pack-main.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

function setup({ config = {}, allowed = () => true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-main-'));
  const dir = path.join(home, '.plexiform', 'sprites', 'robo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ name: 'robo', fps: 4, frames: { idle: ['a.png'] } }));
  fs.writeFileSync(path.join(dir, 'a.png'), PNG);
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  let cfg = { ...config };
  let notified = 0;
  SpritePackMain.register({ ipcMain, allowed, home, loadConfig: () => cfg, saveConfig: (p) => { cfg = { ...cfg, ...p }; }, notify: () => { notified++; } });
  return { handlers, home, dir, cfg: () => cfg, notified: () => notified };
}

test('registers both channels and lists packs with no active pack', () => {
  const { handlers } = setup();
  assert.deepEqual(Object.keys(handlers).sort(), ['widget:sprite-packs', 'widget:use-sprite-pack']);
  const r = handlers['widget:sprite-packs']({});
  assert.equal(r.packs.length, 1);
  assert.equal(r.active, null);
  assert.equal(r.current, null);
});

test('use-sprite-pack saves a valid pack, notifies, and the list then carries its frames', () => {
  const s = setup();
  assert.deepEqual(s.handlers['widget:use-sprite-pack']({}, 'robo'), { ok: true, active: 'robo' });
  assert.equal(s.cfg().spritePack, 'robo');
  assert.equal(s.notified(), 1);
  const r = s.handlers['widget:sprite-packs']({});
  assert.equal(r.current.name, 'robo');
  assert.equal(r.current.fps, 4);
  assert.match(r.current.frames.idle[0], /^data:image\/png;base64,/);
  assert.deepEqual(s.handlers['widget:use-sprite-pack']({}, null), { ok: true, active: null });
  assert.equal(s.cfg().spritePack, null);
});

test('an unknown or invalid pack is not saved', () => {
  const s = setup();
  const r = s.handlers['widget:use-sprite-pack']({}, '../../etc');
  assert.equal(r.ok, false);
  assert.equal(s.cfg().spritePack, undefined);
  assert.equal(s.handlers['widget:use-sprite-pack']({}, 42).ok, false);
  assert.equal(s.notified(), 0);
});

test('an active pack that stops validating falls back: no frames, one error', () => {
  const s = setup({ config: { spritePack: 'robo' } });
  fs.writeFileSync(path.join(s.dir, 'a.png'), 'broken');
  const r = s.handlers['widget:sprite-packs']({});
  assert.equal(r.current, null);
  assert.equal(r.active, 'robo');
  assert.ok(r.errors.some((e) => e.pack === 'robo'));
});

test('a sender that is not allowed gets null', () => {
  const s = setup({ allowed: () => false });
  assert.equal(s.handlers['widget:sprite-packs']({}), null);
  assert.equal(s.handlers['widget:use-sprite-pack']({}, 'robo'), null);
  assert.equal(s.cfg().spritePack, undefined);
});

test('main.js and preload.js wire the module in one line each', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  assert.equal(main.split('\n').filter((l) => l.includes("require('./src/sprite-pack-main.js')")).length, 1);
  assert.equal(main.split('\n').filter((l) => l.includes("require('./src/seasonal-main.js')")).length, 1);
  assert.equal(preload.split('\n').filter((l) => l.includes('widget:sprite-packs') && l.includes('widget:use-sprite-pack')).length, 1);
});
