const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SpritePack = require('../src/sprite-pack.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><defs><linearGradient id="g" /></defs><rect width="8" height="8" fill="url(#g)" /><use href="#g" /></svg>';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-pack-')); }
function pack(root, name, manifest, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  return dir;
}
const reasonOf = (r, name) => (r.errors.find((e) => e.pack === name) || {}).reason || '';

test('a valid pack lists with frame counts and loads as data URLs', () => {
  const root = tmp();
  pack(root, 'robo', { name: 'robo', version: '1.0', fps: 8, frames: { idle: ['a.png', 'b.svg'], working: ['a.png'] } }, { 'a.png': PNG, 'b.svg': SVG });
  const store = SpritePack.create({ root });
  const r = store.list();
  assert.deepEqual(r.errors, []);
  assert.equal(r.packs.length, 1);
  assert.deepEqual(r.packs[0].frames, { idle: 2, working: 1 });
  assert.equal(r.packs[0].fps, 8);
  const f = store.frames('robo');
  assert.match(f.frames.idle[0], /^data:image\/png;base64,/);
  assert.match(f.frames.idle[1], /^data:image\/svg\+xml;base64,/);
  assert.equal(f.frames.working[0], f.frames.idle[0]);
});

test('no sprites folder is no packs and no errors', () => {
  assert.deepEqual(SpritePack.create({ root: path.join(tmp(), 'missing') }).list(), { packs: [], errors: [] });
});

test('an oversize frame is refused', () => {
  const root = tmp();
  pack(root, 'big', { name: 'big', frames: { idle: ['huge.png'] } }, { 'huge.png': Buffer.concat([PNG, Buffer.alloc(SpritePack.LIMITS.fileBytes)]) });
  const r = SpritePack.create({ root }).list();
  assert.equal(r.packs.length, 0);
  assert.match(reasonOf(r, 'big'), /larger than 512 KB/);
});

test('a pack over 8 MB in total is refused', () => {
  const root = tmp();
  const files = {};
  const names = [];
  for (let i = 0; i < 17; i++) { const n = `f${i}.png`; names.push(n); files[n] = Buffer.concat([PNG, Buffer.alloc(500 * 1024)]); }
  pack(root, 'fat', { name: 'fat', frames: { idle: names } }, files);
  assert.match(reasonOf(SpritePack.create({ root }).list(), 'fat'), /larger than 8 MB/);
});

test('a symlinked frame escaping the pack folder is refused, and so is a symlinked pack folder', () => {
  const root = tmp();
  const outside = path.join(tmp(), 'secret.png');
  fs.writeFileSync(outside, PNG);
  const dir = pack(root, 'escape', { name: 'escape', frames: { idle: ['a.png'] } });
  fs.symlinkSync(outside, path.join(dir, 'a.png'));
  const real = pack(tmp(), 'linked', { name: 'linked', frames: { idle: ['a.png'] } }, { 'a.png': PNG });
  fs.symlinkSync(real, path.join(root, 'linked'));
  const r = SpritePack.create({ root }).list();
  assert.equal(r.packs.length, 0);
  assert.match(reasonOf(r, 'escape'), /symbolic link/);
  assert.match(reasonOf(r, 'linked'), /symbolic link/);
});

test('an SVG with a script, handler, foreignObject or external href is refused', () => {
  const bad = {
    script: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    handler: '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="x()" /></svg>',
    foreign: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div /></foreignObject></svg>',
    external: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png" /></svg>',
    xlink: '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="other.svg#a" /></svg>',
    cssurl: '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(http://x/y)" /></svg>',
  };
  const root = tmp();
  for (const [name, svg] of Object.entries(bad)) pack(root, name, { name, frames: { idle: ['a.svg'] } }, { 'a.svg': svg });
  const r = SpritePack.create({ root }).list();
  assert.equal(r.packs.length, 0);
  assert.match(reasonOf(r, 'script'), /script/);
  assert.match(reasonOf(r, 'handler'), /event handler/);
  assert.match(reasonOf(r, 'foreign'), /foreignObject/);
  for (const n of ['external', 'xlink', 'cssurl']) assert.match(reasonOf(r, n), /external/, n);
});

test('manifest rules: paths are basenames, PNG/SVG only, known states, idle required, name matches, frame caps', () => {
  const root = tmp();
  const cases = {
    traversal: [{ frames: { idle: ['../x.png'] } }, /file name/],
    nested: [{ frames: { idle: ['sub/x.png'] } }, /file name/],
    gif: [{ frames: { idle: ['x.gif'] } }, /file name/],
    state: [{ frames: { idle: ['a.png'], dancing: ['a.png'] } }, /unknown state/],
    noidle: [{ frames: { working: ['a.png'] } }, /idle is required/],
    many: [{ frames: { idle: Array.from({ length: 65 }, () => 'a.png') } }, /more than 64/],
    fps: [{ fps: 99, frames: { idle: ['a.png'] } }, /fps/],
    fakepng: [{ frames: { idle: ['b.png'] } }, /not a PNG/],
  };
  for (const [name, [m]] of Object.entries(cases)) pack(root, name, { name, ...m }, { 'a.png': PNG, 'b.png': 'not really' });
  pack(root, 'renamed', { name: 'other', frames: { idle: ['a.png'] } }, { 'a.png': PNG });
  const r = SpritePack.create({ root }).list();
  assert.equal(r.packs.length, 0);
  for (const [name, [, re]] of Object.entries(cases)) assert.match(reasonOf(r, name), re, name);
  assert.match(reasonOf(r, 'renamed'), /match the folder name/);
});

test('frames() reports the reason for a pack that does not validate', () => {
  const store = SpritePack.create({ root: tmp() });
  assert.ok(store.frames('nope').error);
  assert.ok(store.frames('../etc').error);
});

test('svgProblem passes internal references only', () => {
  assert.equal(SpritePack.svgProblem(SVG), null);
  assert.ok(SpritePack.svgProblem('<html></html>'));
  assert.match(SpritePack.svgProblem('<svg><style>@import "https://x/y.css";</style></svg>'), /external/);
  assert.ok(SpritePack.svgProblem('<svg><!DOCTYPE x [<!ENTITY a "b">]></svg>'));
});
