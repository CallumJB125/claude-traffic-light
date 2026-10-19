// User sprite packs: a folder of PNG/SVG frames that stands in for the drawn
// character. Read from ~/.plexiform/sprites/<pack>/pack.json:
//   { name, version, fps, frames: { idle: ['a.png', …], working: […], … } }
// Validation is strict and nothing is ever executed: names and frame paths are
// bare basenames, files are opened without following symlinks and must stay
// inside the pack folder, PNGs must carry the PNG signature, SVGs are refused
// if they hold scripts, event handlers, foreignObject or external references.
// Limits: 512 KB a file, 64 frames a state, 8 MB a pack, 32 packs.
// fs is injected so tests can drive it; it defaults to node's.
const nodeFs = require('fs');
const path = require('path');

const STATES = ['idle', 'working', 'waiting', 'blocked', 'done', 'sleeping'];
const LIMITS = { fileBytes: 512 * 1024, framesPerState: 64, packBytes: 8 * 1024 * 1024, packs: 32, manifestBytes: 64 * 1024 };
const PACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FRAME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(png|svg)$/i;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const fail = (reason) => { const e = new Error(reason); e.reason = reason; throw e; };

// Refuse, never repair: an SVG that needs cleaning is not one we show.
function svgProblem(text) {
  if (!/<svg[\s>]/i.test(text)) return 'not an SVG';
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return 'SVG declares a DTD or entities';
  if (/<\s*script/i.test(text)) return 'SVG contains a script';
  if (/<\s*foreignObject/i.test(text)) return 'SVG contains foreignObject';
  if (/\son[a-z]+\s*=/i.test(text)) return 'SVG contains an event handler';
  if (/javascript:/i.test(text)) return 'SVG contains a javascript: URL';
  for (const m of text.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) if (!m[2].trim().startsWith('#')) return 'SVG references an external file';
  for (const m of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) if (!m[2].trim().startsWith('#')) return 'SVG references an external file';
  if (/@[i]mport/i.test(text)) return 'SVG references an external file'; // a CSS @-rule pulling in another file
  return null;
}

function create({ root, fs = nodeFs } = {}) {
  const base = path.resolve(root);
  const NOFOLLOW = (fs.constants && fs.constants.O_NOFOLLOW) || 0;

  // A regular file inside dir, read through a descriptor opened without following links.
  function readInside(dir, name, max) {
    const file = path.join(dir, name);
    if (path.dirname(file) !== dir) fail(`${name} is not a plain file name`);
    let st;
    try { st = fs.lstatSync(file); } catch { fail(`${name} is missing`); }
    if (st.isSymbolicLink()) fail(`${name} is a symbolic link`);
    if (!st.isFile()) fail(`${name} is not a regular file`);
    if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) fail(`${name} is outside the pack folder`);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW); // privacy-flow: sprite-pack
    try {
      const fst = fs.fstatSync(fd);
      if (!fst.isFile()) fail(`${name} is not a regular file`);
      if (fst.size > max) fail(`${name} is larger than ${Math.round(max / 1024)} KB`);
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  }

  function checkFrame(name, buf) {
    if (/\.png$/i.test(name)) {
      if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) fail(`${name} is not a PNG`);
      return 'image/png';
    }
    const problem = svgProblem(buf.toString('utf8'));
    if (problem) fail(`${name}: ${problem}`);
    return 'image/svg+xml';
  }

  function validManifest(m, dirName) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) fail('pack.json is not an object');
    if (m.name !== dirName) fail('pack.json name must match the folder name');
    if (m.version != null && (typeof m.version !== 'string' || m.version.length > 32)) fail('version must be a short string');
    if (m.fps != null && (!Number.isFinite(m.fps) || m.fps < 1 || m.fps > 24)) fail('fps must be between 1 and 24');
    if (!m.frames || typeof m.frames !== 'object' || Array.isArray(m.frames)) fail('frames must be an object of states');
    for (const [state, list] of Object.entries(m.frames)) {
      if (!STATES.includes(state)) fail(`unknown state "${String(state).slice(0, 32)}"`);
      if (!Array.isArray(list) || !list.length) fail(`${state} needs at least one frame`);
      if (list.length > LIMITS.framesPerState) fail(`${state} has more than ${LIMITS.framesPerState} frames`);
      for (const f of list) {
        if (typeof f !== 'string' || !FRAME_NAME.test(f) || path.basename(f) !== f || f.includes('..')) fail(`frame "${String(f).slice(0, 64)}" must be a PNG or SVG file name in the pack folder`);
      }
    }
    if (!m.frames.idle) fail('frames.idle is required');
  }

  // One pack, fully checked; withData adds a data: URL per frame.
  function loadOne(dirName, { withData = false } = {}) {
    if (!PACK_NAME.test(dirName)) fail('folder name is not allowed');
    const dir = path.join(base, dirName);
    let st;
    try { st = fs.lstatSync(dir); } catch { fail('pack folder is missing'); }
    if (st.isSymbolicLink()) fail('pack folder is a symbolic link');
    if (!st.isDirectory()) fail('not a folder');
    let manifest;
    try { manifest = JSON.parse(readInside(dir, 'pack.json', LIMITS.manifestBytes).toString('utf8')); } catch (e) { fail(e.reason || 'pack.json is not valid JSON'); }
    validManifest(manifest, dirName);
    const files = new Map();
    let total = 0;
    for (const list of Object.values(manifest.frames)) {
      for (const f of list) {
        if (files.has(f)) continue;
        const buf = readInside(dir, f, LIMITS.fileBytes);
        total += buf.length;
        if (total > LIMITS.packBytes) fail(`pack is larger than ${LIMITS.packBytes / 1024 / 1024} MB`);
        const type = checkFrame(f, buf);
        files.set(f, withData ? `data:${type};base64,${buf.toString('base64')}` : type);
      }
    }
    const frames = {};
    for (const [state, list] of Object.entries(manifest.frames)) frames[state] = withData ? list.map((f) => files.get(f)) : list.length;
    return { name: dirName, version: manifest.version || '', fps: manifest.fps || 6, bytes: total, frames };
  }

  function list() {
    const packs = [];
    const errors = [];
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return { packs, errors }; }
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ent.name.startsWith('.')) continue;
      if (packs.length + errors.length >= LIMITS.packs) { errors.push({ pack: ent.name.slice(0, 64), reason: `only ${LIMITS.packs} packs are read` }); break; }
      try { packs.push(loadOne(ent.name)); } catch (e) { errors.push({ pack: ent.name.slice(0, 64), reason: e.reason || 'could not be read' }); }
    }
    return { packs, errors };
  }

  // The frames of one pack as data: URLs, or null with the reason.
  function frames(name) {
    try { return loadOne(String(name || ''), { withData: true }); } catch (e) { return { error: e.reason || 'could not be read' }; }
  }

  return { root: base, list, frames, loadOne };
}

module.exports = { create, svgProblem, STATES, LIMITS };
