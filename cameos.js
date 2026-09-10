// Photo cameos: the user's own faces, cut out in Lights and kept under
// ~/.claude-traffic-light/cameos as <id>.png (256×256, transparent outside the
// head) plus index.json { <id>: { name, eyes, mouth, shape, addedAt } }.
// Anchors are fractions of the square (0..1). Built-in slots ship a photo in
// assets/cameos/built (same layout; scripts/build-cameos.py) — alfred stays
// drawn — and a user photo saved under a built-in id replaces it.
const fs = require('fs');
const path = require('path');

const BUILTINS = ['neo', 'alfred', 'mcafee', 'spagni', 'powell', 'baker', 'ellison', 'saylor'];
const ID_RE = /^[a-z0-9-]{1,32}$/;
// Saved with full photographic detail; it's cut at WORK first, where edges
// have room.
const SIZE = 256;
const WORK = 512;
const SHAPES = ['oval', 'rounded'];
const DEFAULT_EYES = { x: 0.5, y: 0.4 };
const DEFAULT_MOUTH = { x: 0.5, y: 0.75 };
// The oval is face-shaped: 84% as wide as it is tall. rig.js draws the outline
// from the same numbers.
const OVAL_RX = 0.42;
const ROUND_R = 0.18;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
}

const titleCase = (id) => id.charAt(0).toUpperCase() + id.slice(1);

function point(p, def) {
  const x = Number(p && p.x);
  const y = Number(p && p.y);
  return { x: Number.isFinite(x) ? clamp(x, 0, 1) : def.x, y: Number.isFinite(y) ? clamp(y, 0, 1) : def.y };
}

function normalizeEntry(id, e) {
  if (!ID_RE.test(id) || !e || typeof e !== 'object') return null;
  return {
    name: String(e.name || '').trim().slice(0, 40) || (BUILTINS.includes(id) ? titleCase(id) : id),
    eyes: point(e.eyes, DEFAULT_EYES),
    mouth: point(e.mouth, DEFAULT_MOUTH),
    shape: SHAPES.includes(e.shape) ? e.shape : 'oval',
    addedAt: Number.isFinite(e.addedAt) ? e.addedAt : 0,
  };
}

function parseIndex(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, e] of Object.entries(raw)) {
    const n = normalizeEntry(id, e);
    if (n) out[id] = n;
  }
  return out;
}

// Where a new photo goes: a built-in slot only when the user chose to replace
// it; otherwise the name's slug, suffixed until it is free, so adding a
// second "Dad" never overwrites the first.
function resolveId(index, { name, replace } = {}) {
  if (replace) {
    if (!BUILTINS.includes(replace)) return { error: `There is no built-in "${replace}" to replace.` };
    return { id: replace };
  }
  const base = slugify(name);
  if (!base) return { error: 'Give the face a name.' };
  if (base === 'none' || BUILTINS.includes(base)) return { error: `"${titleCase(base)}" is a built-in face — choose "replace ${titleCase(base)}" to swap it.` };
  let id = base;
  for (let n = 2; index[id]; n += 1) id = `${base.slice(0, 31 - String(n).length).replace(/-+$/, '')}-${n}`;
  return { id };
}

const withEntry = (index, id, entry) => ({ ...index, [id]: normalizeEntry(id, entry) });
function without(index, id) {
  const next = { ...index };
  delete next[id];
  return next;
}

// The picker's order: every built-in (drawn or photo), then the user's faces
// oldest first. `user` marks a photo the user saved, the only kind that can be
// removed (a built-in slot then falls back to its shipped photo or drawing).
function listing(index, shipped = {}) {
  const built = BUILTINS.map((id) => ({ id, builtin: true, photo: !!(index[id] || shipped[id]), user: !!index[id], ...(index[id] || shipped[id] || { name: titleCase(id) }) }));
  const users = Object.keys(index).filter((id) => !BUILTINS.includes(id))
    .sort((a, b) => index[a].addedAt - index[b].addedAt || a.localeCompare(b))
    .map((id) => ({ id, builtin: false, photo: true, user: true, ...index[id] }));
  return [...built, ...users];
}

// Coverage of a pixel centre by the mask, anti-aliased over one pixel.
function coverage(px, py, size, shape) {
  const c = size / 2;
  let sd;
  if (shape === 'rounded') {
    const r = size * ROUND_R;
    const qx = Math.abs(px - c) - (c - r);
    const qy = Math.abs(py - c) - (c - r);
    sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  } else {
    const rx = size * OVAL_RX;
    const ry = c;
    sd = (Math.hypot((px - c) / rx, (py - c) / ry) - 1) * Math.min(rx, ry);
  }
  return clamp(0.5 - sd, 0, 1);
}

// Cuts the mask into a 4-byte-per-pixel bitmap in place. Every channel is
// scaled, so it is right for premultiplied bitmaps (what nativeImage hands out).
function applyMask(buf, width, height, shape) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const k = coverage(x + 0.5, y + 0.5, width, shape);
      if (k >= 1) continue;
      const i = (y * width + x) * 4;
      buf[i] = Math.round(buf[i] * k);
      buf[i + 1] = Math.round(buf[i + 1] * k);
      buf[i + 2] = Math.round(buf[i + 2] * k);
      buf[i + 3] = Math.round(buf[i + 3] * k);
    }
  }
  return buf;
}

// The crop square, in source pixels, forced inside the image.
function squareRect(rect, w, h) {
  const side = Math.round(clamp(Number(rect && rect.size) || Math.min(w, h) * 0.6, 8, Math.min(w, h)));
  return {
    x: Math.round(clamp(Number(rect && rect.x) || 0, 0, w - side)),
    y: Math.round(clamp(Number(rect && rect.y) || 0, 0, h - side)),
    width: side,
    height: side,
  };
}

// A cut-out (a PNG with its backdrop removed) is cut along its own silhouette;
// a camera photo or screenshot is opaque everywhere and gets the oval. One
// pass over the crop: under 1% see-through pixels means there's no cut-out.
function hasAlpha(buf) {
  let clear = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] < 250) clear += 1;
  return clear >= (buf.length / 4) * 0.01;
}

// Every channel of a premultiplied pixel scaled to a new alpha.
function setAlpha(buf, i, a) {
  const k = buf[i + 3] ? a / buf[i + 3] : 0;
  for (let c = 0; c < 3; c += 1) buf[i + c] = Math.min(255, Math.round(buf[i + c] * k));
  buf[i + 3] = a;
}

// The silhouette at working size, as scripts/build-cameos.py does it: drop the
// faint fringe, pull the edge in a pixel (past any leftover backdrop) and
// soften. Rows from `jawRow` down are trimmed to the oval, which clears
// collars and shoulders but sits wider than any jaw. Never raises alpha, so
// there's always colour under it.
function shapeAlpha(buf, w, h, jawRow) {
  const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) a[i] = buf[i * 4 + 3] < 48 ? 0 : buf[i * 4 + 3];
  const at = (src, x, y) => src[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
  const eroded = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    let m = 255;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) m = Math.min(m, at(a, x + dx, y + dy));
    eroded[y * w + x] = m;
  }
  // gaussian, sigma 0.6, as a separable 3-tap kernel
  const side = Math.exp(-1 / (2 * 0.6 * 0.6));
  const wk = [side / (1 + 2 * side), 1 / (1 + 2 * side)];
  const across = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) across[y * w + x] = wk[1] * at(eroded, x, y) + wk[0] * (at(eroded, x - 1, y) + at(eroded, x + 1, y));
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const v = wk[1] * at(across, x, y) + wk[0] * (at(across, x, y - 1) + at(across, x, y + 1));
    const jaw = y >= jawRow ? coverage(x + 0.5, y + 0.5, w, 'oval') : 1;
    const i = (y * w + x) * 4;
    setAlpha(buf, i, Math.min(buf[i + 3], Math.round(v * jaw)));
  }
  return buf;
}

// At output size, for a silhouette: opened (erode, then dilate, over a 5×5
// window) so strands under 5 px, like a mic wire or a stray lock, don't read
// as scratches, with the soft edge kept; and the last few rows fade so a neck
// cut by the crop doesn't end in a hard line. Resampling leaves the inside a
// shade under opaque, so 250 and up counts as opaque.
const OPEN_R = 2;
const NECK_FADE = 0.04;
function finishAlpha(buf, w, h) {
  const at = (src, x, y) => src[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
  for (let i = 3; i < buf.length; i += 4) if (buf[i] >= 250) setAlpha(buf, i - 3, 255);
  let a = Float32Array.from({ length: w * h }, (_, i) => buf[i * 4 + 3]);
  for (const pick of [Math.min, Math.max]) {
    const next = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      let m = a[y * w + x];
      for (let dy = -OPEN_R; dy <= OPEN_R; dy += 1) for (let dx = -OPEN_R; dx <= OPEN_R; dx += 1) m = pick(m, at(a, x + dx, y + dy));
      next[y * w + x] = m;
    }
    a = next;
  }
  for (let y = 0; y < h; y += 1) {
    const k = clamp((h - y - 0.5) / (NECK_FADE * h), 0, 1);
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      setAlpha(buf, i, Math.min(buf[i + 3], Math.round(a[y * w + x] * k)));
    }
  }
  return buf;
}

// source (a data: URL) → cropped, cut out and shrunk SIZE×SIZE PNG buffer.
function cutOut(nativeImage, source, rect, shape, mouth = DEFAULT_MOUTH) {
  const src = nativeImage.createFromDataURL(source);
  if (src.isEmpty()) throw new Error('That image could not be read.');
  const { width, height } = src.getSize();
  const img = src.crop(squareRect(rect, width, height)).resize({ width: WORK, height: WORK, quality: 'best' });
  const bmp = Buffer.from(img.toBitmap());
  if (bmp.length !== WORK * WORK * 4) throw new Error('The crop came out the wrong size.');
  const silhouette = hasAlpha(bmp);
  if (silhouette) shapeAlpha(bmp, WORK, WORK, Math.round(point(mouth, DEFAULT_MOUTH).y * WORK));
  else applyMask(bmp, WORK, WORK, SHAPES.includes(shape) ? shape : 'oval');
  const small = Buffer.from(nativeImage.createFromBitmap(bmp, { width: WORK, height: WORK }).resize({ width: SIZE, height: SIZE, quality: 'best' }).toBitmap());
  if (silhouette) finishAlpha(small, SIZE, SIZE);
  return nativeImage.createFromBitmap(small, { width: SIZE, height: SIZE }).toPNG();
}

// ── Files ──────────────────────────────────────────────────────────────────
const pngPath = (dir, id) => path.join(dir, `${id}.png`);

// Entries whose PNG has gone missing are dropped, so a built-in never claims a
// photo it doesn't have.
function loadIndex(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'index.json'), 'utf8'); } catch { return {}; }
  const index = parseIndex(text);
  for (const id of Object.keys(index)) if (!fs.existsSync(pngPath(dir, id))) delete index[id];
  return index;
}

function writeIndex(dir, index) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(index, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function addPhoto({ dir, nativeImage, source, rect, shape, name, replace, eyes, mouth, now = Date.now() }) {
  if (typeof source !== 'string' || !/^data:image\/[a-z+.-]+;base64,/i.test(source)) return { error: 'No image to save.' };
  const index = loadIndex(dir);
  const at = resolveId(index, { name, replace });
  if (at.error) return at;
  let png;
  try { png = cutOut(nativeImage, source, rect, shape, mouth); } catch (err) { return { error: err.message }; }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pngPath(dir, at.id), png);
  const entry = { name: (name || '').trim() || titleCase(at.id), eyes, mouth, shape, addedAt: now };
  const next = withEntry(index, at.id, entry);
  writeIndex(dir, next);
  return { id: at.id, entry: next[at.id] };
}

function removePhoto(dir, id) {
  const index = loadIndex(dir);
  if (!index[id]) return false;
  fs.rmSync(pngPath(dir, id), { force: true });
  writeIndex(dir, without(index, id));
  return true;
}

const photoDataUrl = (dir, id) => `data:image/png;base64,${fs.readFileSync(pngPath(dir, id)).toString('base64')}`;

// A chosen file, as a data: URL the Lights window can decode. Formats Chromium
// reads go through as-is (it honours EXIF rotation); anything else (HEIC) is
// decoded by the OS via nativeImage.
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };
function readSource(nativeImage, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const name = path.basename(file, path.extname(file));
  if (fs.statSync(file).size > MAX_SOURCE_BYTES) return { error: 'That image is over 40 MB.' };
  if (MIME[ext]) return { name, dataUrl: `data:${MIME[ext]};base64,${fs.readFileSync(file).toString('base64')}` };
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return { error: 'That image format could not be read.' };
  return { name, dataUrl: img.toDataURL() };
}

module.exports = {
  BUILTINS, ID_RE, SIZE, SHAPES, DEFAULT_EYES, DEFAULT_MOUTH, OVAL_RX, ROUND_R,
  slugify, normalizeEntry, parseIndex, resolveId, withEntry, without, listing,
  coverage, applyMask, hasAlpha, shapeAlpha, finishAlpha, squareRect, cutOut, loadIndex, writeIndex, addPhoto, removePhoto, photoDataUrl, readSource,
};
