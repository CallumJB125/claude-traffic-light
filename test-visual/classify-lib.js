'use strict';
// Redesign snapshot classifier: the pure half (plan-redesign §R2.6, §R3.10, §R4.4). No I/O, no browser, so
// test/classify-lib.test.js can check it with synthetic pixels. test-visual/classify.spec.js decodes the PNGs in
// Chromium and feeds the raw RGBA here.
//
// The question it answers, per changed pixel: is this change only the accent swap? A pixel passes when there is
// one accent-family member k (rest, hover, pressed, ink, focus ring, halo, or the soft tint over a surface) and
// one local neutral N such that
//   1. the old pixel lies within ΔE00 ≤ 3 of segment(old k, N), at blend position t_old,
//   2. the head pixel lies within ΔE00 ≤ 3 of segment(new k, N), at t_new,
//   3. |t_old − t_new| ≤ 0.35 (room for text-gamma differences), and
//   4. N is the same on both sides.
// N is the nearest pixel unchanged between old and new within 5 px, else each surface token in turn. Pixels where
// one accent member is drawn over another (a label on a filled button, a ring over its halo) are matched against
// the segment between the two members instead, with the same rules.
// A changed pixel whose old colour sits on no old-family segment is unexpected, even if the result is grey, unless
// it matches the named exception list for that baseline. Near-N blends: t_old and t_new both < 0.05 count as
// unchanged; t_old < 0.05 with t_new ≤ 0.40 is skipped (no colour information) and counted.

const DE_MAX = 3;
const T_AGREE = 0.35;
const T_NONE = 0.05;
const RADIUS = 5;

// ── Colour ───────────────────────────────────────────────────────────────────────────────────────────────────
function parseColour(value) {
  const v = String(value).trim();
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`not a colour: ${value}`);
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));

const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
function lab(rgb) {
  const r = lin(rgb[0]); const g = lin(rgb[1]); const b = lin(rgb[2]);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// CIEDE2000 (Sharma, Wu, Dalal 2005).
function deltaE00(a, b) {
  const [L1, a1, b1] = a; const [L2, a2, b2] = b;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1); const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1; const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1); const Cp2 = Math.hypot(ap2, b2);
  const hp = (x, y) => { if (x === 0 && y === 0) return 0; const h = Math.atan2(y, x) / rad; return h < 0 ? h + 360 : h; };
  const hp1 = hp(ap1, b1); const hp2 = hp(ap2, b2);
  const dL = L2 - L1; const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) { dh = hp2 - hp1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2; const Cpb = (Cp1 + Cp2) / 2;
  let hb = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) { if (Math.abs(hp1 - hp2) > 180) hb += hp1 + hp2 < 360 ? 360 : -360; hb /= 2; }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb; const Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

// Where p falls on the segment from n (t = 0) to k (t = 1), and how far it is from that point in ΔE00.
// t comes from projecting in gamma-encoded sRGB, the space the compositor blends text and edges in.
function onSegment(p, k, n) {
  const d = [k[0] - n[0], k[1] - n[1], k[2] - n[2]];
  const len = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  let t = len === 0 ? 1 : ((p[0] - n[0]) * d[0] + (p[1] - n[1]) * d[1] + (p[2] - n[2]) * d[2]) / len;
  t = Math.min(1, Math.max(0, t));
  const q = [n[0] + d[0] * t, n[1] + d[1] * t, n[2] + d[2] * t];
  return { t, de: deltaE00(lab(p), lab(q)) };
}

// ── Families ─────────────────────────────────────────────────────────────────────────────────────────────────
const FAMILY_TOKENS = { rest: '--accent', hover: '--accent-hover', pressed: '--accent-pressed', ink: '--accent-ink', ring: '--focus-ring', halo: '--focus-halo' };
const SOFT_TOKEN = '--accent-soft';
const SURFACE_TOKENS = ['--bg', '--panel', '--panel-2'];
// Members drawn over each other: a label on a filled state, the ring against its halo or a filled button.
const PAIRS = [['ink', 'rest'], ['ink', 'hover'], ['ink', 'pressed'], ['ring', 'halo'], ['rest', 'halo'], ['ring', 'rest']];

// Resolves tokens.css text into { dark: {name: value}, light: {name: value} } with var() substituted.
function tokensOf(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (text, head) => {
    const at = text.indexOf(head);
    if (at < 0) return '';
    const open = text.indexOf('{', at);
    let depth = 1; let i = open + 1;
    while (depth && i < text.length) { if (text[i] === '{') depth += 1; else if (text[i] === '}') depth -= 1; i += 1; }
    return text.slice(open + 1, i - 1);
  };
  const decls = (body) => {
    let depth = 0; let flat = '';
    for (const ch of body) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; else if (depth === 0) flat += ch; }
    const out = {};
    for (const m of flat.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };
  const dark = decls(block(src, ':root {'));
  const light = { ...dark, ...decls(block(block(src, '@media (prefers-color-scheme: light)'), ':root:not([data-theme="dark"])')) };
  const resolveAll = (theme) => {
    const get = (name, depth = 0) => {
      if (depth > 20 || theme[name] === undefined) return undefined;
      return theme[name].replace(/var\((--[\w-]+)\)/g, (_, n) => get(n, depth + 1) ?? `var(${n})`);
    };
    return Object.fromEntries(Object.keys(theme).map((k) => [k, get(k)]));
  };
  return { dark: resolveAll(dark), light: resolveAll(light) };
}

// Builds the matchable members for one theme: solid members, soft-over-surface members, and member pairs.
// Each member has an old and a new colour; `pair` members carry their own second end instead of using N.
function membersOf(oldTheme, newTheme) {
  const members = [];
  const solid = {};
  for (const [key, token] of Object.entries(FAMILY_TOKENS)) {
    try {
      solid[key] = { old: parseColour(oldTheme[token]).slice(0, 3), new: parseColour(newTheme[token]).slice(0, 3) };
      members.push({ key, ...solid[key] });
    } catch { /* a token missing on one side isn't part of this flip */ }
  }
  try {
    const os = parseColour(oldTheme[SOFT_TOKEN]); const ns = parseColour(newTheme[SOFT_TOKEN]);
    for (const s of SURFACE_TOKENS) {
      const surface = parseColour(newTheme[s]);
      members.push({ key: `soft/${s}`, old: over(os, surface), new: over(ns, surface) });
    }
  } catch { /* no soft tint */ }
  for (const [a, b] of PAIRS) {
    if (solid[a] && solid[b]) members.push({ key: `${a}~${b}`, old: solid[a].old, new: solid[a].new, pairOld: solid[b].old, pairNew: solid[b].new });
  }
  return members;
}

function familiesOf(oldCss, newCss) {
  const o = tokensOf(oldCss); const n = tokensOf(newCss);
  const surfaces = [];
  for (const theme of ['light', 'dark']) for (const s of SURFACE_TOKENS) { try { surfaces.push(parseColour(n[theme][s]).slice(0, 3)); } catch { /* none */ } }
  return { members: [...membersOf(o.light, n.light), ...membersOf(o.dark, n.dark)], surfaces };
}

// ── Pixels ───────────────────────────────────────────────────────────────────────────────────────────────────
// Tests one member against one neutral. Returns 'pass', 'unchanged', 'skipped' or null (no fit).
function judge(oldPx, newPx, m, n) {
  const oEnd = m.pairOld || n; const nEnd = m.pairNew || n;
  const o = onSegment(oldPx, m.old, oEnd);
  if (o.de > DE_MAX) return null;
  const h = onSegment(newPx, m.new, nEnd);
  if (h.de > DE_MAX) {
    return null;
  }
  if (!m.pairOld && o.t < T_NONE) {
    if (h.t < T_NONE) return 'unchanged';
    return h.t <= T_NONE + T_AGREE ? 'skipped' : null;
  }
  return Math.abs(o.t - h.t) <= T_AGREE ? 'pass' : null;
}

// A pixel that sits at N on any segment carries no colour information, so "unchanged" and "skipped" outrank a
// pass that another member might give it (§R4.4: near-N blends are never counted as passes).
const RANK = { unchanged: 3, skipped: 2, pass: 1 };
function classifyPixel(oldPx, newPx, neutrals, members) {
  let best = null;
  for (const n of neutrals) {
    for (const m of members) {
      const v = judge(oldPx, newPx, m, n);
      if (v && (!best || RANK[v] > RANK[best])) { best = v; if (v === 'unchanged') return v; }
    }
  }
  return best || 'unexpected';
}

// Compares two decoded images ({ width, height, data: RGBA bytes }). Returns counts, the unexpected mask and
// the crop tiles that hold unexpected pixels.
function classifyImage(oldImg, newImg, families, { exceptions = [], tile = 24 } = {}) {
  const total = oldImg.width * oldImg.height;
  if (oldImg.width !== newImg.width || oldImg.height !== newImg.height) {
    return { total, changed: total, pass: 0, unchanged: 0, skipped: 0, exception: 0, unexpected: total, sizeChanged: true, tiles: [] };
  }
  const { width: w, height: h } = oldImg;
  const A = oldImg.data; const B = newImg.data;
  const changed = new Uint8Array(total);
  let nChanged = 0;
  for (let i = 0; i < total; i += 1) {
    const j = i * 4;
    if (A[j + 3] === 0 && B[j + 3] === 0) continue;
    if (A[j] !== B[j] || A[j + 1] !== B[j + 1] || A[j + 2] !== B[j + 2] || A[j + 3] !== B[j + 3]) { changed[i] = 1; nChanged += 1; }
  }
  const out = { total, changed: nChanged, pass: 0, unchanged: 0, skipped: 0, exception: 0, unexpected: 0, sizeChanged: false, tiles: [], samples: [] };
  if (!nChanged) return out;
  const offsets = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy += 1) for (let dx = -RADIUS; dx <= RADIUS; dx += 1) if ((dx || dy) && dx * dx + dy * dy <= RADIUS * RADIUS) offsets.push([dx, dy, dx * dx + dy * dy]);
  offsets.sort((p, q) => p[2] - q[2]);
  const tiles = new Map();
  const cache = new Map();
  for (let i = 0; i < total; i += 1) {
    if (!changed[i]) continue;
    const j = i * 4;
    const x = i % w; const y = (i - x) / w;
    let verdict;
    if (A[j + 3] !== B[j + 3]) verdict = 'unexpected';
    else {
      let local = null;
      for (const [dx, dy] of offsets) {
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (!changed[k] && A[k * 4 + 3] === 255) { local = [A[k * 4], A[k * 4 + 1], A[k * 4 + 2]]; break; }
      }
      const neutrals = local ? [local] : families.surfaces;
      const oldPx = [A[j], A[j + 1], A[j + 2]]; const newPx = [B[j], B[j + 1], B[j + 2]];
      const key = `${oldPx}|${newPx}|${local || 's'}`;
      verdict = cache.get(key);
      if (!verdict) {
        verdict = classifyPixel(oldPx, newPx, neutrals, families.members);
        if (verdict === 'unexpected' && exceptions.length && classifyPixel(oldPx, newPx, neutrals, exceptions) === 'pass') verdict = 'exception';
        cache.set(key, verdict);
      }
    }
    out[verdict] += 1;
    if (verdict === 'unexpected' && out.samples.length < 12) {
      const hx = (k) => `#${[A, B][k].subarray(j, j + 3).reduce((s, v) => s + v.toString(16).padStart(2, '0'), '')}`;
      out.samples.push({ x, y, old: hx(0), new: hx(1) });
    }
    if (verdict === 'unexpected') {
      const t = `${Math.floor(x / tile)},${Math.floor(y / tile)}`;
      tiles.set(t, (tiles.get(t) || 0) + 1);
    }
  }
  out.tiles = [...tiles.entries()].map(([k, count]) => { const [tx, ty] = k.split(',').map(Number); return { x: tx * tile, y: ty * tile, w: Math.min(tile, w - tx * tile), h: Math.min(tile, h - ty * tile), count }; })
    .sort((p, q) => q.count - p.count);
  return out;
}

// Exception entries from classify.config.json → members, for one baseline.
function exceptionsFor(baseline, config) {
  const out = [];
  for (const e of (config && config.exceptions) || []) {
    if (!(e.baselines || []).includes(baseline)) continue;
    for (const o of e.old || []) for (const n of e.new || []) out.push({ key: `exception:${e.name}`, old: parseColour(o).slice(0, 3), new: parseColour(n).slice(0, 3) });
  }
  return out;
}

// The gate: § R3.10 item 6.
const CAPS = { unexpectedRatio: 0.005, crops: 200 };
function verdictOf(results) {
  const failures = [];
  let crops = 0;
  for (const r of results) {
    if (r.added || r.removed) continue;
    crops += r.tiles.length;
    if (/(^|\/)characters\.spec\.js\//.test(r.baseline) && r.changed) failures.push(`${r.baseline}: characters may not change (${r.changed} pixels)`);
    if (r.sizeChanged) failures.push(`${r.baseline}: size changed`);
    else if (r.unexpected / r.total > CAPS.unexpectedRatio) failures.push(`${r.baseline}: ${(100 * r.unexpected / r.total).toFixed(3)} % unexpected (cap 0.5 %)`);
  }
  if (crops > CAPS.crops) failures.push(`${crops} review crops (cap ${CAPS.crops})`);
  return { failures, crops };
}

module.exports = { parseColour, lab, deltaE00, onSegment, tokensOf, familiesOf, classifyPixel, classifyImage, exceptionsFor, verdictOf, CAPS, DE_MAX, T_AGREE };
