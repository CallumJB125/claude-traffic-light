// Validates a character against the contract and sanitises its SVG. Every
// character that didn't ship with the app (Hatch output, a .buddy package, a
// gallery download, `buddy add`) goes through validateCharacter before it is
// written to disk or reaches a renderer.
//
//   const { validateCharacter, sanitizeSvg } = require('./characters/validate.js');
//   const r = validateCharacter(json, { source: 'import' });
//   r.ok, r.errors, r.warnings   // [{ path, code, message }]
//   r.character                  // a fresh object, only known fields, sanitised markup (null unless ok)
//
// The sanitiser is an allowlist parser, not a filter: markup is tokenised,
// every element and attribute is checked against the tables below, and the
// output is re-serialised from what passed. Nothing from the input is copied
// through as text, so there is no script, style, href, url(), entity, id,
// foreignObject, animation element or event handler to smuggle past it.
const Contract = require('./index.js');

const LIMITS = { layerBytes: 64 * 1024, elements: 1500, depth: 12, coord: 256, pathBytes: 16 * 1024, attrBytes: 512, name: 40, miniParts: 24, scale: 4 };

const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SKIN_PAINT = /^var\(--body-color(,\s*#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}))?\)$/;
const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]*$/;
const POINTS = /^[0-9eE.,\s+-]*$/;
// [^()]* rather than \s*[...]*: overlapping classes backtrack quadratically
// on an unclosed "scale(" followed by whitespace
const TRANSFORM_FN = /^\s*(translate|scale|rotate|skewX|skewY|matrix)\s*\(([^()]*)\)\s*,?/;
// character parts get their own prefix (cp-), so nothing an import draws can
// match a rig hook such as the .char-body slot
const CLASS_TOKEN = /^(skin|cp-[a-z0-9-]{1,24})$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID = /^[a-z][a-z0-9-]{1,31}$/;

const number = (min, max) => (v) => NUM.test(v) && Number(v) >= min && Number(v) <= max;
const coord = number(-LIMITS.coord, LIMITS.coord);
const length = number(0, LIMITS.coord);
const unit = number(0, 1);
const paint = (v) => v === 'none' || v === 'currentColor' || HEX.test(v) || SKIN_PAINT.test(v);
const oneOf = (...xs) => (v) => xs.includes(v);
function numberList(v, max) {
  const nums = v.trim() === '' ? [] : v.trim().split(/[\s,]+/);
  return nums.length <= max && nums.every((n) => coord(n));
}
function transform(v) {
  if (v.length > LIMITS.attrBytes) return false;
  let rest = v;
  let n = 0;
  while (rest.trim()) {
    const m = TRANSFORM_FN.exec(rest);
    if (!m || !numberList(m[2], 6) || (n += 1) > 8) return false;
    rest = rest.slice(m[0].length);
  }
  return true;
}
function pathData(v) {
  if (v.length > LIMITS.pathBytes || !PATH_D.test(v)) return false;
  return (v.match(/[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/g) || []).every((n) => Math.abs(Number(n)) <= LIMITS.coord);
}
function classList(v) {
  if (v.length > LIMITS.attrBytes) return false;
  const tokens = v.trim().split(/\s+/);
  return tokens.length <= 4 && tokens.every((t) => CLASS_TOKEN.test(t));
}

const COMMON = {
  fill: paint, stroke: paint, 'stroke-width': length, opacity: unit, 'fill-opacity': unit, 'stroke-opacity': unit,
  'stroke-linecap': oneOf('butt', 'round', 'square'), 'stroke-linejoin': oneOf('miter', 'round', 'bevel'),
  'fill-rule': oneOf('nonzero', 'evenodd'), transform, class: classList,
};
const ELEMENTS = {
  g: {},
  rect: { x: coord, y: coord, width: length, height: length, rx: length, ry: length },
  circle: { cx: coord, cy: coord, r: length },
  ellipse: { cx: coord, cy: coord, rx: length, ry: length },
  line: { x1: coord, y1: coord, x2: coord, y2: coord },
  path: { d: pathData },
  polygon: { points: (v) => v.length <= LIMITS.pathBytes && POINTS.test(v) && numberList(v, 512) },
  polyline: { points: (v) => v.length <= LIMITS.pathBytes && POINTS.test(v) && numberList(v, 512) },
};

// Tokenise a fragment. Returns { nodes, errors, removed }: nodes is a tree of
// { tag, attrs: [[k, v]], children }, holding only what passed the tables.
function parseFragment(src) {
  const errors = [];
  const removed = [];
  const root = { tag: '#root', attrs: [], children: [] };
  const stack = [{ node: root, keep: true }];
  let count = 0;
  let i = 0;
  const fail = (code, message) => { errors.push({ code, message: `${message} (at ${i})` }); };
  while (i < src.length && !errors.length) {
    const lt = src.indexOf('<', i);
    const text = src.slice(i, lt === -1 ? src.length : lt);
    if (text.trim()) { fail('svg-text', 'text content is not allowed'); break; }
    if (lt === -1) break;
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) { fail('svg-parse', 'unterminated comment'); break; }
      i = end + 3;
      continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') { fail('svg-parse', 'doctype, CDATA and processing instructions are not allowed'); break; }
    const close = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>/.exec(src.slice(i));
    if (close) {
      const top = stack[stack.length - 1];
      if (stack.length === 1 || top.tag !== close[1]) { fail('svg-parse', `unexpected </${close[1]}>`); break; }
      stack.pop();
      i += close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(i));
    if (!open) { fail('svg-parse', 'stray <'); break; }
    const tag = open[1];
    i += open[0].length;
    const attrs = [];
    let selfClosing = false;
    for (;;) {
      const ws = /^\s*/.exec(src.slice(i))[0];
      i += ws.length;
      if (src.startsWith('/>', i)) { selfClosing = true; i += 2; break; }
      if (src[i] === '>') { i += 1; break; }
      const a = /^([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(src.slice(i));
      if (!a || !ws) { fail('svg-parse', `malformed attribute on <${tag}>`); break; }
      attrs.push([a[1], a[3] !== undefined ? a[3] : a[4]]);
      i += a[0].length;
    }
    if (errors.length) break;
    const parent = stack[stack.length - 1];
    const rules = Object.prototype.hasOwnProperty.call(ELEMENTS, tag) ? ELEMENTS[tag] : null;
    const keep = parent.keep && !!rules;
    if (parent.keep && !rules) removed.push(`<${tag}>`);
    let node = null;
    if (keep) {
      if ((count += 1) > LIMITS.elements) { fail('svg-too-big', `more than ${LIMITS.elements} elements`); break; }
      if (stack.length > LIMITS.depth) { fail('svg-too-deep', `nested deeper than ${LIMITS.depth}`); break; }
      node = { tag, attrs: [], children: [] };
      const seen = new Set();
      for (const [k, v] of attrs) {
        if (seen.has(k)) { fail('svg-parse', `duplicate ${k} on <${tag}>`); break; }
        seen.add(k);
        const check = Object.prototype.hasOwnProperty.call(rules, k) ? rules[k] : Object.prototype.hasOwnProperty.call(COMMON, k) ? COMMON[k] : null;
        if (!check) { removed.push(`${tag}@${k}`); continue; }
        if (v.includes('&') || !check(v)) { removed.push(`${tag}@${k}="${v.slice(0, 40)}"`); continue; }
        node.attrs.push([k, v.trim()]);
      }
      if (errors.length) break;
      parent.node.children.push(node);
    }
    if (!selfClosing) stack.push({ tag, node: node || parent.node, keep });
  }
  if (!errors.length && stack.length > 1) errors.push({ code: 'svg-parse', message: `<${stack[stack.length - 1].tag}> is never closed` });
  return { root, errors, removed };
}

function serialise(node) {
  return node.children.map((c) => {
    const attrs = c.attrs.map(([k, v]) => ` ${k}="${v}"`).join('');
    return c.children.length ? `<${c.tag}${attrs}>${serialise(c)}</${c.tag}>` : `<${c.tag}${attrs} />`;
  }).join('');
}

// 2D affine [a b c d e f] for a validated transform attribute.
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ID_M = [1, 0, 0, 1, 0, 0];
function parseTransform(v) {
  let m = ID_M;
  let rest = v || '';
  while (rest.trim()) {
    const t = TRANSFORM_FN.exec(rest);
    if (!t) break;
    rest = rest.slice(t[0].length);
    const n = t[2].trim() ? t[2].trim().split(/[\s,]+/).map(Number) : [];
    const rad = (deg) => (deg * Math.PI) / 180;
    let f = ID_M;
    if (t[1] === 'translate') f = [1, 0, 0, 1, n[0] || 0, n[1] || 0];
    else if (t[1] === 'scale') f = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
    else if (t[1] === 'rotate') {
      const [deg = 0, cx = 0, cy = 0] = n;
      const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
      f = mul(mul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (t[1] === 'skewX') f = [1, 0, Math.tan(rad(n[0] || 0)), 1, 0, 0];
    else if (t[1] === 'skewY') f = [1, Math.tan(rad(n[0] || 0)), 0, 1, 0, 0];
    else if (t[1] === 'matrix' && n.length === 6) f = n;
    m = mul(m, f);
  }
  return m;
}
// how much a matrix can enlarge anything it draws
const stretch = (m) => Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));

// Geometry of sanitised markup: the extent of every coordinate it draws,
// through its transforms (stroke width aside), and the largest scale any
// element is drawn at.
function extent(node, box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, scale: 1 }, ctm = ID_M) {
  for (const c of node.children) {
    const a = Object.fromEntries(c.attrs.map(([k, v]) => [k, v]));
    const m = a.transform ? mul(ctm, parseTransform(a.transform)) : ctm;
    box.scale = Math.max(box.scale, stretch(m));
    const add = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
      box.x0 = Math.min(box.x0, X); box.y0 = Math.min(box.y0, Y); box.x1 = Math.max(box.x1, X); box.y1 = Math.max(box.y1, Y);
    };
    const corners = (x0, y0, x1, y1) => { add(x0, y0); add(x1, y0); add(x0, y1); add(x1, y1); };
    const n = (k) => Number(a[k] || 0);
    if (c.tag === 'rect') corners(n('x'), n('y'), n('x') + n('width'), n('y') + n('height'));
    else if (c.tag === 'circle') corners(n('cx') - n('r'), n('cy') - n('r'), n('cx') + n('r'), n('cy') + n('r'));
    else if (c.tag === 'ellipse') corners(n('cx') - n('rx'), n('cy') - n('ry'), n('cx') + n('rx'), n('cy') + n('ry'));
    else if (c.tag === 'line') { add(n('x1'), n('y1')); add(n('x2'), n('y2')); }
    else if (c.tag === 'polygon' || c.tag === 'polyline') {
      const p = (a.points || '').trim().split(/[\s,]+/).map(Number);
      for (let k = 0; k + 1 < p.length; k += 2) add(p[k], p[k + 1]);
    } else if (c.tag === 'path') pathExtent(a.d || '', add);
    extent(c, box, m);
  }
  return box;
}
// Walks absolute and relative commands for their end and control points.
function pathExtent(d, add) {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/g) || [];
  const ARGS = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
  let x = 0, y = 0, sx = 0, sy = 0, cmd = null, k = 0;
  while (k < toks.length) {
    if (/[a-zA-Z]/.test(toks[k])) { cmd = toks[k]; k += 1; if (cmd.toUpperCase() === 'Z') { x = sx; y = sy; add(x, y); } continue; }
    if (!cmd) return;
    const U = cmd.toUpperCase();
    const rel = cmd !== U;
    const n = ARGS[U];
    if (!n) { k += 1; continue; }
    const v = toks.slice(k, k + n).map(Number);
    if (v.length < n) return;
    k += n;
    if (U === 'H') x = rel ? x + v[0] : v[0];
    else if (U === 'V') y = rel ? y + v[0] : v[0];
    else if (U === 'A') { x = rel ? x + v[5] : v[5]; y = rel ? y + v[6] : v[6]; }
    else {
      for (let p = 0; p + 1 < n - 2; p += 2) add(rel ? x + v[p] : v[p], rel ? y + v[p + 1] : v[p + 1]);
      x = rel ? x + v[n - 2] : v[n - 2];
      y = rel ? y + v[n - 1] : v[n - 1];
    }
    add(x, y);
    if (U === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
  }
}

function sanitizeSvg(markup) {
  if (typeof markup !== 'string') return { ok: false, svg: '', errors: [{ code: 'svg-type', message: 'markup must be a string' }], removed: [] };
  if (Buffer.byteLength(markup, 'utf8') > LIMITS.layerBytes) return { ok: false, svg: '', errors: [{ code: 'svg-too-big', message: `layer is over ${LIMITS.layerBytes} bytes` }], removed: [] };
  const { root, errors, removed } = parseFragment(markup);
  if (errors.length) return { ok: false, svg: '', errors, removed };
  return { ok: true, svg: serialise(root), errors: [], removed, extent: extent(root) };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// source: 'builtin' | 'import' | 'hatch'. Only built-ins may carry css or
// take a built-in id.
function validateCharacter(input, { source = 'import', builtinIds = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, code, message) => errors.push({ path, code, message });
  const warn = (path, code, message) => warnings.push({ path, code, message });
  const V = Contract.VIEWBOX;
  const out = {};
  if (!isObj(input)) { err('', 'type', 'a character is a JSON object'); return { ok: false, errors, warnings, character: null }; }

  if (typeof input.id !== 'string' || !ID.test(input.id)) err('id', 'id', 'id is 2–32 lowercase letters, digits and dashes, starting with a letter');
  else if (source !== 'builtin' && (builtinIds || Contract.ids().filter(Contract.isBuiltin)).includes(input.id)) err('id', 'id-taken', `"${input.id}" is a built-in character`);
  out.id = input.id;
  // no control, format (zero-width, bidi override) or markup characters
  const name = typeof input.name === 'string' ? input.name.replace(/[\p{Cc}\p{Cf}<>&"'`]/gu, '').trim() : '';
  if (!name || name.length > LIMITS.name) err('name', 'name', `name is 1–${LIMITS.name} characters`);
  out.name = name;
  if (input.contract !== Contract.CONTRACT_VERSION) err('contract', 'contract-version', `contract must be ${Contract.CONTRACT_VERSION}`);
  out.contract = Contract.CONTRACT_VERSION;
  if (input.color !== undefined) { if (typeof input.color !== 'string' || !HEX.test(input.color)) err('color', 'color', 'color is a #hex colour'); else out.color = input.color; }
  if (input.legs !== undefined && typeof input.legs !== 'boolean') err('legs', 'type', 'legs is true or false');
  out.legs = input.legs !== false;
  if (input.css !== undefined) {
    if (source !== 'builtin') err('css', 'css-not-allowed', 'only characters that ship with the app may carry CSS');
    else if (typeof input.css === 'string') out.css = input.css;
  }

  // anchors
  const a = isObj(input.anchors) ? input.anchors : null;
  if (!a) err('anchors', 'type', 'anchors is an object');
  const pt = (p, path, { required = true } = {}) => {
    if (!isObj(p) || !finite(p.x) || !finite(p.y)) { if (required) err(path, 'point', `${path} is { x, y }`); return null; }
    if (p.x < V.x || p.x > V.x + V.w || p.y < V.y || p.y > V.y + V.h) err(path, 'outside-viewbox', `${path} is outside the 64×82 grid`);
    return { x: p.x, y: p.y };
  };
  const box = (b, path) => {
    if (!isObj(b) || ![b.x, b.y, b.w, b.h].every(finite) || b.w <= 0 || b.h <= 0) { err(path, 'box', `${path} is { x, y, w, h } with w, h > 0`); return null; }
    if (b.x < V.x || b.y < V.y || b.x + b.w > V.x + V.w || b.y + b.h > V.y + V.h) err(path, 'outside-viewbox', `${path} is outside the 64×82 grid`);
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  };
  const anchors = {};
  if (a) {
    anchors.head = box(a.head, 'anchors.head');
    anchors.faceBox = box(a.faceBox, 'anchors.faceBox');
    if (!finite(a.hatLine)) err('anchors.hatLine', 'number', 'hatLine is a number');
    anchors.hatLine = a.hatLine;
    if (!finite(a.ground) || a.ground < 40 || a.ground > V.h) err('anchors.ground', 'ground', 'ground is between 40 and 82');
    anchors.ground = a.ground;
    if (a.eyes === 'none') anchors.eyes = 'none';
    else if (isObj(a.eyes) && a.eyes.single) anchors.eyes = { single: pt(a.eyes.single, 'anchors.eyes.single') };
    else if (isObj(a.eyes)) {
      anchors.eyes = { left: pt(a.eyes.left, 'anchors.eyes.left'), right: pt(a.eyes.right, 'anchors.eyes.right') };
      if (anchors.eyes.left && anchors.eyes.right && anchors.eyes.right.x - anchors.eyes.left.x < 4) err('anchors.eyes', 'eyes-order', 'the right eye is at least 4 units right of the left');
    } else err('anchors.eyes', 'eyes', "eyes is { left, right }, { single } or 'none'");
    anchors.mouth = a.mouth === null ? null : pt(a.mouth, 'anchors.mouth');
    if (a.hands === null) anchors.hands = null;
    else if (isObj(a.hands)) {
      anchors.hands = { left: pt(a.hands.left, 'anchors.hands.left'), right: pt(a.hands.right, 'anchors.hands.right') };
      if (a.hands.extra !== undefined) {
        if (!Array.isArray(a.hands.extra) || a.hands.extra.length > 8) err('anchors.hands.extra', 'hands', 'extra is a list of up to 8 points');
        else anchors.hands.extra = a.hands.extra.map((p, k) => pt(p, `anchors.hands.extra[${k}]`));
      }
    } else err('anchors.hands', 'hands', 'hands is { left, right } or null');
    const skin = a.skinParts === undefined ? [] : a.skinParts;
    if (!Array.isArray(skin) || !skin.every((l) => Contract.LAYERS.includes(l))) err('anchors.skinParts', 'skin', `skinParts lists layers from ${Contract.LAYERS.join(', ')}`);
    else anchors.skinParts = Array.from(new Set(skin));
  }
  out.anchors = anchors;

  // sprite
  const sprite = isObj(input.sprite) ? input.sprite : null;
  out.sprite = {};
  let ext = null;
  if (!sprite || typeof sprite.body !== 'string' || !sprite.body.trim()) err('sprite.body', 'sprite', 'sprite.body is the SVG markup for the body');
  for (const layer of Contract.LAYERS) {
    if (!sprite || sprite[layer] === undefined) continue;
    const s = sanitizeSvg(sprite[layer]);
    for (const e of s.errors) err(`sprite.${layer}`, e.code, e.message);
    for (const r of s.removed) warn(`sprite.${layer}`, 'svg-removed', `removed ${r}`);
    out.sprite[layer] = s.svg;
    if (s.ok && s.extent && s.extent.scale > LIMITS.scale) err(`sprite.${layer}`, 'svg-scale', `transforms may enlarge a part at most ${LIMITS.scale}×`);
    if (s.ok && s.extent && Number.isFinite(s.extent.x0)) ext = ext ? { x0: Math.min(ext.x0, s.extent.x0), y0: Math.min(ext.y0, s.extent.y0), x1: Math.max(ext.x1, s.extent.x1), y1: Math.max(ext.y1, s.extent.y1) } : { ...s.extent };
  }
  if (sprite) for (const k of Object.keys(sprite)) if (!Contract.LAYERS.includes(k)) warn(`sprite.${k}`, 'unknown-layer', `ignored layer "${k}"`);

  // optional: per-costume nudges, agent-chip sprite
  if (input.offsets !== undefined) {
    if (!isObj(input.offsets)) err('offsets', 'type', 'offsets maps costume → { dx, dy, s }');
    else {
      out.offsets = Object.create(null);
      for (const [k, o] of Object.entries(input.offsets)) {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(k) || RESERVED_KEYS.has(k) || !isObj(o) || ![o.dx ?? 0, o.dy ?? 0, o.s ?? 1].every(finite) || Math.abs(o.dx ?? 0) > 32 || Math.abs(o.dy ?? 0) > 32 || (o.s ?? 1) <= 0 || (o.s ?? 1) > 3) { err(`offsets.${k}`, 'offset', 'an offset is { dx, dy, s } with |dx|,|dy| ≤ 32 and 0 < s ≤ 3'); continue; }
        out.offsets[k] = { dx: o.dx ?? 0, dy: o.dy ?? 0, s: o.s ?? 1 };
      }
    }
  }
  if (input.mini !== undefined && input.mini !== null) {
    if (!Array.isArray(input.mini) || input.mini.length > LIMITS.miniParts) err('mini', 'mini', `mini is a list of up to ${LIMITS.miniParts} [tag, attrs] parts`);
    else {
      const part = (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && p[0] !== 'g' && Object.prototype.hasOwnProperty.call(ELEMENTS, p[0])
        && isObj(p[1]) && Object.keys(p[1]).every((k) => /^[a-z][a-z-]*$/.test(k) && k !== 'transform') && Object.values(p[1]).every((v) => typeof v === 'string' || finite(v));
      const bad = input.mini.findIndex((p) => !part(p));
      if (bad >= 0) err(`mini[${bad}]`, 'mini-part', 'a mini part is [shape, { attribute: value }] with no groups or transforms');
      const markup = bad >= 0 ? '' : input.mini.map(([tag, attrs]) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${String(v)}"`).join('')} />`).join('');
      const s = sanitizeSvg(markup);
      for (const e of s.errors) err('mini', e.code, e.message);
      for (const r of s.removed) err('mini', 'svg-removed', `not allowed in a mini: ${r}`);
      if (s.ok && s.extent && Number.isFinite(s.extent.x0) && (s.extent.x0 < -0.5 || s.extent.y0 < -0.5 || s.extent.x1 > 7.4 || s.extent.y1 > 8)) err('mini', 'mini-size', 'mini sprites fit the 6.9×7.5 chip box');
      if (!errors.some((e) => e.path.startsWith('mini'))) out.mini = parseFragment(markup).root.children.map((c) => [c.tag, Object.fromEntries(c.attrs)]);
    }
  }

  if (!errors.length) for (const g of checkGeometry(out, ext)) (g.severity === 'error' ? errors : warnings).push(g);
  const ok = errors.length === 0;
  return { ok, errors, warnings, character: ok ? out : null };
}

// B3 geometry, on the numbers alone: the rendered checks are in the matrix
// suite. `ext` is the sprite's drawn extent when known.
function checkGeometry(def, ext = null) {
  const out = [];
  const bad = (path, code, message, severity = 'error') => out.push({ path, code, message, severity });
  const a = def.anchors;
  const V = Contract.VIEWBOX;
  const inside = (p, b, pad = 0) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
  // hats sit on the head: the hat line is on or just above the head box
  if (a.hatLine < a.head.y - 6 || a.hatLine > a.head.y + a.head.h) bad('anchors.hatLine', 'hat-off-head', 'the hat line has to be within the head box (or up to 6 above it)');
  const eyes = a.eyes === 'none' ? [] : a.eyes.single ? [a.eyes.single] : [a.eyes.left, a.eyes.right];
  eyes.forEach((e, k) => { if (!inside(e, a.faceBox)) bad(`anchors.eyes${eyes.length > 1 ? `.${k ? 'right' : 'left'}` : ''}`, 'eye-outside-face', 'eyes sit inside the faceBox'); });
  if (a.mouth && !inside(a.mouth, a.faceBox)) bad('anchors.mouth', 'mouth-outside-face', 'the mouth sits inside the faceBox');
  const overlap = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
  if (!overlap(a.head, a.faceBox)) bad('anchors.faceBox', 'face-off-head', 'the faceBox overlaps the head box');
  // the sign hangs across the top 29 units; a head up there is behind it
  if (a.head.y < 29) bad('anchors.head', 'head-under-sign', 'the head reaches up behind the sign (keep it below y 29)', 'warning');
  // Held things ride the hand offsets: Claude's sign hand and prop area,
  // moved by the same amount, must stay on the grid.
  if (a.hands) {
    const R = Contract.REF.hands;
    const moved = (b, h, ref) => ({ x: b.x + h.x - ref.x, y: b.y + h.y - ref.y, w: b.w, h: b.h });
    const within = (b) => b.x >= V.x && b.y >= V.y && b.x + b.w <= V.x + V.w && b.y + b.h <= V.y + V.h;
    // the sign hangs from the left hand and spans the grid's width
    if (!within(moved({ x: 0, y: 0, w: 60, h: 39 }, a.hands.left, R.left))) bad('anchors.hands.left', 'held-outside', 'the sign would leave the grid (it spans the width, so the left hand can only move down, or right by 4)');
    if (!within(moved({ x: 46, y: 40, w: 13, h: 16 }, a.hands.right, R.right))) bad('anchors.hands.right', 'held-outside', 'things held in the right hand would leave the grid');
  }
  if (ext) {
    const over = Math.max(V.x - ext.x0, V.y - ext.y0, ext.x1 - (V.x + V.w), ext.y1 - (V.y + V.h));
    // the widget keeps a little room round the grid; past that it clips
    if (over > 4) bad('sprite', 'sprite-clipped', `the sprite reaches ${over.toFixed(1)} units past the 64×82 grid and would be clipped`);
    else if (over > 0) bad('sprite', 'sprite-edge', `the sprite reaches ${over.toFixed(1)} units past the grid`, 'warning');
    if (ext.y1 > a.ground + 1) bad('anchors.ground', 'below-ground', 'the sprite goes below its ground line', 'warning');
  }
  return out.map(({ severity, ...rest }) => ({ ...rest, severity }));
}

module.exports = { validateCharacter, sanitizeSvg, checkGeometry, LIMITS };
