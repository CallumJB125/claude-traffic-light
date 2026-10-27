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
//   3. |t_old − t_new| ≤ T_AGREE (0.15 since R0b review S5; 0.35 in R0a), and
//   4. N is the same on both sides.
// N is the nearest pixel unchanged between old and new within 5 px and also each surface token (R0b, i). Pixels where
// one accent member is drawn over another (a label on a filled button, a ring over its halo) are matched against
// the segment between the two members instead, with the same rules.
// A changed pixel whose old colour sits on no old-family segment is unexpected, even if the result is grey, unless
// it matches the named exception list for that baseline. Near-N blends: t_old and t_new both < 0.05 count as
// unchanged; t_old < 0.05 with t_new ≤ 0.40 is skipped (no colour information) and counted.
//
// R0b additions (§R4.4):
//   (a) Pre-filter: a changed pixel with ΔE00(old, new) ≤ 1 is render noise (sub-pixel AA, P3 rounding), not a
//       colour change. It is counted on its own as `noise`, never as a pass, so the report shows how much it
//       absorbed and a low-contrast change can't hide in it unseen.
//   (b) A baseline that exists on only one side (added or removed) fails the gate: an accent flip renames nothing.
//   (c) The surface fallback and the families are picked by theme from the file name (-dark- / -light-); a name
//       with neither is themed from the base image (c′, themeFor); a name is checked against the image. Never
//       pooled; a mixed image or a disagreement fails closed.
//   (d) classify.spec.js runs on its own when the branch's test-visual/expected/<branch>.txt starts `# classify`.
// R0b extensions and tightening (lead conditions; §R4.4): (i) surfaces as neutrals as well as the local N;
// (ii) text over the soft tint; (iii) accent color-mix() rules parsed from the stylesheets; members that don't
// change are dropped; an old pixel that IS a neutral is never a pass; near-N verdicts and weak passes need a
// strong pass within 2 px (the evidence rule, see classifyImage). Review fixes: M1 (a pass whose old pixel already
// fits the new segment is weak), S1 (evidence radius 2), S3 (zero-length segments explain nothing), S5 (T_AGREE
// 0.15), M2 (noise caps, see noiseCheck). Negative controls: classify-controls.js.

const DE_MAX = 3;
// S5 (review): 0.35 → 0.15. Every audited correct pass had Δt ≤ 0.06; 0.35 let a bolder accent glyph through.
const T_AGREE = 0.15;
const T_NONE = 0.05;
const RADIUS = 5;
// S1 (review): near-N and weak verdicts need strong evidence within 2 px (anti-aliasing and a ring's halo spread
// 1–2 px); RADIUS 5 is only for finding the local N.
const EVIDENCE_RADIUS = 2;
const DE_NOISE = 1;

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
  // S3 (review): a zero-length segment (a member equal to its N, e.g. dark ink's new #17191d = --bg) is a point,
  // not "fully on the member": it explains nothing.
  if (len === 0) return { t: 0, de: Infinity };
  let t = ((p[0] - n[0]) * d[0] + (p[1] - n[1]) * d[1] + (p[2] - n[2]) * d[2]) / len;
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

// Round 5: a stylesheet that declares its own tokens (buddy-window/burst-theme.css: `:root:root { --border … }`
// and `@media (prefers-color-scheme: light) { :root:root { … } }`) is resolved against them, so a mix such as
// color-mix(in srgb, var(--accent) 45%, var(--border)) uses that sheet's --accent and --border. Only top-level
// :root blocks (default = dark) and :root blocks directly inside a light media query count; values are kept
// as written and resolved later over tokens.css.
function sheetTokensOf(text) {
  const src = String(text).replace(/\/\*[\s\S]*?\*\//g, '');
  const dark = {}; const light = {};
  const blocks = (body, cb) => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf('{', i); if (open < 0) break;
      const sel = body.slice(i, open).replace(/^[\s\S]*[;}]/, '').trim();
      let depth = 1; let j = open + 1;
      while (depth && j < body.length) { if (body[j] === '{') depth += 1; else if (body[j] === '}') depth -= 1; j += 1; }
      cb(sel, body.slice(open + 1, j - 1)); i = j;
    }
  };
  const decls = (b, into) => { if (b.includes('{')) return; for (const m of b.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) into[m[1]] = m[2].trim(); };
  const lightOnly = {};
  let hasLight = false;
  const LIGHT_IN_MEDIA = /^:root(:root|:not\(\[data-theme(="dark")?\]\))?$/;
  blocks(src, (sel, body) => {
    if (/^:root(:root)?$/.test(sel)) decls(body, dark);
    else if (sel === ':root[data-theme="light"]') { decls(body, lightOnly); hasLight = true; }
    else if (/^@media\s*\(prefers-color-scheme:\s*light\)$/.test(sel)) blocks(body, (s2, b2) => { if (LIGHT_IN_MEDIA.test(s2)) { decls(b2, lightOnly); hasLight = true; } });
  });
  Object.assign(light, dark, lightOnly);
  // local tokens with no light block: the light theme of that sheet is unknown, so its mixes fail closed there
  return Object.keys(dark).length || Object.keys(lightOnly).length ? { dark, light: hasLight ? light : undefined } : null;
}
// A theme map with a sheet's own tokens laid over tokens.css, var() resolved through the result.
function withLocal(theme, local) {
  if (!local) return theme;
  const merged = { ...theme, ...local };
  const get = (name, depth = 0) => (depth > 20 || merged[name] === undefined ? undefined
    : String(merged[name]).replace(/var\((--[\w-]+)\)/g, (_, n) => get(n, depth + 1) ?? `var(${n})`));
  return Object.fromEntries(Object.keys(merged).map((k) => [k, get(k)]));
}

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

// ── color-mix members (R0b extension iii) ─────────────────────────────────────────────────────────────────────
// Components mix the accent into other colours (color-mix(in oklab, var(--accent) 30%, var(--panel)) and the
// like). Those mixes are read from the stylesheets themselves at the base and at the head, never hand-listed:
// colourMixesOf() parses every color-mix() whose arguments include an accent-family var, and mixMembers() turns
// each into a member by computing the mix with the old tokens and with the new ones.
const ACCENT_VARS = new Set([...Object.values(FAMILY_TOKENS), SOFT_TOKEN]);
const KEYWORDS = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1], currentcolor: null };
const MIX_SPACES = new Set(['srgb', 'srgb-linear', 'oklab']);

function splitTop(text) {
  const parts = []; let depth = 0; let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}
function mixArg(part) {
  let m = part.match(/^(\d+(?:\.\d+)?)%\s+(.+)$/s);
  if (m) return { colour: m[2].trim(), pct: +m[1] };
  m = part.match(/^(.+?)\s+(\d+(?:\.\d+)?)%$/s);
  if (m) return { colour: m[1].trim(), pct: +m[2] };
  return { colour: part.trim(), pct: null };
}
// Custom properties declared as an alias of an accent var (--x: var(--accent)), in any of the given texts.
function aliasesOf(texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t).matchAll(/(--[\w-]+)\s*:\s*var\((--[\w-]+)\)\s*[;}]/g)) if (ACCENT_VARS.has(m[2]) && !ACCENT_VARS.has(m[1])) out.add(m[1]);
  return out;
}
// The accent color-mixes the classifier does NOT model, so the report can list them (review): a var() with a
// fallback, a nested color-mix (an alias token is modelled since round 5; see familiesOf), and any mix in JS (styles set from script). They build no member,
// so their pixels fail closed; this only makes them visible.
function skippedMixesOf(text, { js = false, aliases = new Set() } = {}) {
  const out = [];
  const src = String(text).replace(/\/\*[\s\S]*?\*\//g, '');
  const accentish = (x) => /var\(\s*--(accent|focus-ring)/.test(x) || [...aliases].some((a) => x.includes(`var(${a})`));
  let at = 0;
  while ((at = src.indexOf('color-mix(', at)) >= 0) {
    let depth = 0; let i = at + 'color-mix'.length;
    for (; i < src.length; i += 1) { if (src[i] === '(') depth += 1; else if (src[i] === ')') { depth -= 1; if (!depth) break; } }
    const raw = src.slice(at, i + 1).replace(/\s+/g, ' ');
    const inner = src.slice(at + 'color-mix('.length, i);
    at += 1; // visit nested mixes too
    if (!accentish(inner)) continue;
    let why = null;
    if (js) why = 'js';
    else if (inner.includes('color-mix(')) why = 'nested';
    else if (/var\(\s*--(accent|focus-ring)[\w-]*\s*,/.test(inner)) why = 'fallback';
    if (why) out.push({ raw, why });
  }
  return out;
}

// Every color-mix() in a stylesheet (or HTML/JS text) that mixes an accent-family var. Returns normalised specs.
function colourMixesOf(text) {
  const out = [];
  const src = String(text).replace(/\/\*[\s\S]*?\*\//g, '');
  let at = 0;
  while ((at = src.indexOf('color-mix(', at)) >= 0) {
    let depth = 0; let i = at + 'color-mix'.length;
    for (; i < src.length; i += 1) { if (src[i] === '(') depth += 1; else if (src[i] === ')') { depth -= 1; if (!depth) break; } }
    const inner = src.slice(at + 'color-mix('.length, i);
    at = i;
    const parts = splitTop(inner);
    if (parts.length !== 3) continue;
    const space = (parts[0].match(/^in\s+([a-z-]+)/i) || [])[1];
    const args = [mixArg(parts[1]), mixArg(parts[2])];
    const refs = args.map((x) => (x.colour.match(/^var\((--[\w-]+)\)$/) || [])[1]);
    if (!refs.some((r) => r && ACCENT_VARS.has(r))) continue;
    out.push({ space: space ? space.toLowerCase() : '', args, raw: `color-mix(${parts.map((x) => x.replace(/\s+/g, ' ')).join(', ')})` });
  }
  return out;
}

const toLin = (c) => lin(c);
const fromLin = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function toOklab([r, g, b]) {
  const R = toLin(r); const G = toLin(g); const B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map((v) => Math.min(255, Math.max(0, fromLin(v))));
}
const ENC = { srgb: [(c) => c, (c) => c], 'srgb-linear': [(c) => c.map(toLin), (c) => c.map((v) => Math.min(255, Math.max(0, fromLin(v))))], oklab: [toOklab, fromOklab] };

// CSS Color 5 color-mix(): premultiplied interpolation, percentages normalised, a sum under 100 % scales alpha.
// Returns [r, g, b, a] or null when the space or an argument can't be resolved.
function computeMix(spec, theme) {
  if (!MIX_SPACES.has(spec.space)) return null;
  const cols = spec.args.map(({ colour }) => {
    const ref = colour.match(/^var\((--[\w-]+)\)$/);
    const v = ref ? theme[ref[1]] : colour;
    if (v === undefined) return null;
    const kw = String(v).trim().toLowerCase();
    if (kw in KEYWORDS) return KEYWORDS[kw];
    try { return parseColour(v); } catch { return null; }
  });
  if (cols.some((c) => !c)) return null;
  let [p1, p2] = spec.args.map((x) => x.pct);
  if (p1 === null && p2 === null) { p1 = 50; p2 = 50; } else if (p1 === null) p1 = 100 - p2; else if (p2 === null) p2 = 100 - p1;
  const sum = p1 + p2;
  if (sum <= 0) return null;
  const w1 = p1 / sum; const w2 = p2 / sum;
  const alpha = cols[0][3] * w1 + cols[1][3] * w2;
  if (alpha <= 0) return null;
  const [enc, dec] = ENC[spec.space];
  const e1 = enc(cols[0].slice(0, 3)); const e2 = enc(cols[1].slice(0, 3));
  const mixed = [0, 1, 2].map((i) => (e1[i] * cols[0][3] * w1 + e2[i] * cols[1][3] * w2) / alpha);
  return [...dec(mixed), alpha * Math.min(1, sum / 100)];
}

// ── literal → mix (R0b round 8b) ─────────────────────────────────────────────────────────────────────────────
// R0b replaced a few hard-coded terracotta washes with the accent at the same alpha:
// `.ib-scope.tone-count { background: rgba(218, 119, 86, 0.18) }` → `color-mix(in srgb, var(--accent) 18%,
// transparent)`. The base side is not the base accent, so no token mix explains it. A pair is modelled only when
// all of these hold, otherwise it builds nothing (fail closed) and is listed with the reason:
//   - the same file, the same rule context (at-rule and selector chain) and the same property at base and head,
//     each declared exactly once there (a selector or property new at head has no base partner);
//   - the head value holds one `color-mix(in srgb, var(<accent family>) N%, transparent)` (either order), and the
//     base value is the same text with an rgba() or #rrggbbaa literal in its place;
//   - the literal's alpha is exactly N / 100;
//   - neither the literal nor the mix sits inside a var() (a fallback is never rendered when the var is set);
//   - the head file does not redeclare the accent var (the mix then reads a sheet-local value).
// The member is the literal at base and the mix with the head tokens, each over a surface, per theme.
const isHtml = (file) => file.endsWith('.html');
// Elements whose content is text, not markup (RCDATA: textarea, title; RAWTEXT: xmp, iframe, noembed, noframes, and
// noscript when scripting is on, as in Chromium): no tags, comments, <style> or <script> inside, up to the end tag.
// <template> is not here: its content is ordinary markup. <plaintext> runs to the end of the file.
const RAW_TEXT = new Set(['textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes']);
// Splits an HTML file the way the parser does: <style> and <script> hold raw text up to their end tag (a "<!--"
// inside them is just text), markup comments only exist between those elements, and a start tag's attribute values
// are skipped as quoted strings. `styles`: each <style>'s content. `outside`: the file with every <style>'s content
// emptied and markup comments kept (so a changed comment still counts as changed markup). Foreign content (an inline
// <svg>'s <style>) is read as raw text too, as before: no tracked file has one.
function htmlParts(html) {
  const styles = []; let outside = ''; let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { outside += html.slice(i); break; }
    outside += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4); const stop = end < 0 ? html.length : end + 3;
      outside += html.slice(lt, stop); i = stop; continue;
    }
    const tag = html.slice(lt).match(/^<([a-zA-Z][\w-]*)/);
    if (!tag) { outside += '<'; i = lt + 1; continue; }
    let k = lt + tag[0].length; // to the start tag's '>', skipping quoted attribute values
    while (k < html.length && html[k] !== '>') {
      if (html[k] === '"' || html[k] === "'") { const q = html.indexOf(html[k], k + 1); k = q < 0 ? html.length : q + 1; } else k += 1;
    }
    const open = Math.min(k + 1, html.length);
    outside += html.slice(lt, open); i = open;
    const name = tag[1].toLowerCase();
    if (name === 'style' || name === 'script' || RAW_TEXT.has(name)) {
      const close = html.slice(open).search(new RegExp(`</${name}\\b`, 'i'));
      const end = close < 0 ? html.length : open + close;
      if (name === 'style') styles.push(html.slice(open, end)); else outside += html.slice(open, end);
      i = end;
    } else if (name === 'plaintext') { outside += html.slice(open); i = html.length; }
  }
  return { styles, outside };
}
// CSS of a file: a stylesheet as is, an HTML file's <style> contents (htmlParts: comments only in markup).
function cssOfFile(file, text) {
  const t = String(text);
  return isHtml(file) ? htmlParts(t).styles.join('\n') : t;
}
// The retired terracotta accent the hard-coded washes used (tokens.css before R0a: --accent #da7756 =
// rgb(218, 119, 86); lights.html, input-bubble.css). A literal of any other colour is never paired (review 8b S1).
const RETIRED_ACCENT_RGB = [[218, 119, 86]];
// Every declaration with its rule context: [{ ctx: 'sel' or '@media … > sel', prop, value }].
function declarationsOf(css) {
  const src = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = []; const stack = []; let buf = '';
  const flush = () => {
    const d = buf.match(/^\s*([-\w]+)\s*:\s*([\s\S]*?)\s*$/);
    if (d && stack.length) out.push({ ctx: stack.join(' > '), prop: d[1].toLowerCase(), value: d[2].replace(/\s+/g, ' ').replace(/\s*!important$/i, ' !important') });
    buf = '';
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'") { const e = src.indexOf(ch, i + 1); const stop = e < 0 ? src.length : e + 1; buf += src.slice(i, stop); i = stop - 1; continue; }
    if (ch === '(') { let depth = 0; let k = i; for (; k < src.length; k += 1) { if (src[k] === '(') depth += 1; else if (src[k] === ')') { depth -= 1; if (!depth) break; } } buf += src.slice(i, k + 1); i = k; continue; }
    if (ch === '{') { stack.push(buf.replace(/\s+/g, ' ').trim()); buf = ''; continue; }
    if (ch === ';') { flush(); continue; }
    if (ch === '}') { flush(); stack.pop(); continue; }
    buf += ch;
  }
  return out;
}
// Ranges [start, end) of every var( … ) call in a value.
function varRanges(value) {
  const out = []; let at = 0;
  while ((at = value.indexOf('var(', at)) >= 0) {
    let depth = 0; let k = at + 3;
    for (; k < value.length; k += 1) { if (value[k] === '(') depth += 1; else if (value[k] === ')') { depth -= 1; if (!depth) break; } }
    out.push([at, k + 1]); at += 4;
  }
  return out;
}
const insideVar = (value, i) => varRanges(value).some(([a, b]) => i > a && i < b);
// The one accent-at-alpha mix in a head value: { start, end, spec, pct } or a reason it isn't one.
function accentAlphaMixIn(value) {
  const at = value.indexOf('color-mix(');
  if (at < 0) return { why: 'no color-mix' };
  if (value.indexOf('color-mix(', at + 1) >= 0) return { why: 'more than one color-mix' };
  let depth = 0; let k = at + 'color-mix'.length;
  for (; k < value.length; k += 1) { if (value[k] === '(') depth += 1; else if (value[k] === ')') { depth -= 1; if (!depth) break; } }
  const raw = value.slice(at, k + 1);
  const spec = colourMixesOf(raw)[0];
  if (!spec || spec.space !== 'srgb') return { why: 'not an srgb accent mix' };
  const accent = spec.args.find((x) => /^var\((--[\w-]+)\)$/.test(x.colour) && ACCENT_VARS.has(x.colour.slice(4, -1).trim()));
  const other = spec.args.find((x) => x !== accent);
  if (!accent || accent.pct === null || !other || other.colour.toLowerCase() !== 'transparent' || other.pct !== null) return { why: 'not var(--accent) N% with transparent' };
  if (insideVar(value, at)) return { why: 'mix inside a var() fallback' };
  return { start: at, end: k + 1, spec, pct: accent.pct, token: accent.colour.slice(4, -1).trim() };
}
// The one rgba()/#rrggbbaa literal in a base value: { start, end, rgba } or a reason.
function alphaLiteralIn(value) {
  const found = [...value.matchAll(/rgba?\([^()]*\)|#[0-9a-fA-F]{8}(?![\w-])|#[0-9a-fA-F]{6}(?![\w-])|#[0-9a-fA-F]{3}(?![\w-])/g)];
  if (found.length !== 1) return { why: found.length ? 'more than one literal' : 'no rgba()/hex literal' };
  const m = found[0];
  let rgba;
  const h8 = m[0].match(/^#([0-9a-f]{8})$/i);
  try { rgba = h8 ? [0, 2, 4, 6].map((i) => parseInt(h8[1].slice(i, i + 2), 16)).map((v, i) => (i === 3 ? v / 255 : v)) : parseColour(m[0]); } catch { return { why: 'not a colour literal' }; }
  if (insideVar(value, m.index)) return { why: 'literal inside a var() fallback' };
  if (!RETIRED_ACCENT_RGB.some((c) => c.every((v, i) => v === rgba[i]))) return { why: `rgb(${rgba.slice(0, 3).join(', ')}) is not the retired accent` };
  return { start: m.index, end: m.index + m[0].length, rgba, raw: m[0] };
}
// files: { old: { path: text }, new: { path: text } }. Returns { specs, refused }.
function literalMixPairsOf(files = {}) {
  const specs = []; const refused = [];
  const oldFiles = files.old || {}; const newFiles = files.new || {};
  for (const [file, headText] of Object.entries(newFiles)) {
    if (!String(headText).includes('color-mix(')) continue;
    const headDecls = declarationsOf(cssOfFile(file, headText));
    const baseDecls = oldFiles[file] === undefined ? [] : declarationsOf(cssOfFile(file, oldFiles[file]));
    const key = (d) => `${d.ctx}\u0001${d.prop}`;
    const count = (list, k) => list.filter((d) => key(d) === k).length;
    const local = sheetTokensOf(cssOfFile(file, headText));
    for (const d of headDecls) {
      if (!d.value.includes('color-mix(')) continue;
      const mix = accentAlphaMixIn(d.value);
      const where = `${file}: ${d.ctx} { ${d.prop} }`;
      if (mix.why === 'mix inside a var() fallback') { refused.push({ where, why: mix.why }); continue; }
      if (mix.why) continue; // not this shape: the ordinary mix rules (or none) handle it
      // members are built for both themes, so a theme-scoped rule would be modelled in the theme it never renders in
      if (/prefers-color-scheme|data-theme/.test(d.ctx)) { refused.push({ where, why: 'theme-scoped rule' }); continue; }
      // a gradient's stops interpolate: a flat member can't model them (see the radial wash, afda1ac1)
      if (/gradient\(/i.test(d.value)) { refused.push({ where, why: 'gradient' }); continue; }
      const k = key(d);
      const refuse = (why) => refused.push({ where, why });
      if (count(headDecls, k) !== 1) { refuse('declared more than once at head'); continue; }
      const partners = baseDecls.filter((b) => key(b) === k);
      if (partners.length !== 1) { refuse(partners.length ? 'declared more than once at base' : 'no base partner (new selector or property)'); continue; }
      const base = partners[0].value;
      if (base.includes('color-mix(')) continue; // a mix at base too: the ordinary mix pairing applies
      const lit = alphaLiteralIn(base);
      if (lit.why) { refuse(lit.why); continue; }
      if (Math.abs(lit.rgba[3] - mix.pct / 100) > 1e-9) { refuse(`alpha ${lit.rgba[3]} is not ${mix.pct} %`); continue; }
      const tmpl = (v, a, b) => `${v.slice(0, a)}\u0000${v.slice(b)}`.replace(/\s+/g, ' ').trim();
      if (tmpl(base, lit.start, lit.end) !== tmpl(d.value, mix.start, mix.end)) { refuse('the rest of the value differs'); continue; }
      // any declaration of the accent var in the head file (not only :root): the mix may read that value
      if (headDecls.some((x) => x.prop === mix.token) || (local && (mix.token in (local.dark || {}) || (local.light && mix.token in local.light)))) { refuse(`${mix.token} redeclared in the sheet`); continue; }
      specs.push({ ...mix.spec, raw: `${mix.spec.raw} from ${lit.raw} [${where}]`, baseLiteral: lit.rgba });
    }
  }
  return { specs, refused };
}

// Members for one theme from the parsed mixes. An opaque mix is a solid member; a translucent one is matched
// over each surface, like the soft tint.
function mixMembers(specs, oldTheme, newTheme, surfaces, themeName) {
  const members = []; const unresolved = [];
  for (const spec of specs) {
    const lo = spec.baseLocal && themeName ? spec.baseLocal[themeName] : null;
    const ln = spec.local && themeName ? spec.local[themeName] : null;
    if ((spec.baseLocal && !lo) || (spec.local && !ln)) { unresolved.push(`${spec.raw} (${themeName}: no theme block in its sheet)`); continue; }
    // a literal → mix pair (literalMixPairsOf): the base side is the literal itself, the same in both themes
    const o = spec.baseLiteral ? spec.baseLiteral.slice() : computeMix(spec, withLocal(oldTheme, lo)); const n = computeMix(spec, withLocal(newTheme, ln));
    if (!o || !n) { unresolved.push(spec.raw); continue; }
    if (o[3] >= 0.999 && n[3] >= 0.999) members.push({ key: `mix ${spec.raw}`, old: o.slice(0, 3), new: n.slice(0, 3) });
    else for (const s of surfaces) members.push({ key: `mix ${spec.raw}/${s.name}`, old: over(o, s.rgb), new: over(n, s.rgb) });
  }
  return { members, unresolved };
}

// ── Members ─────────────────────────────────────────────────────────────────────────────────────────────────
// Text tokens that sit on the soft tint (R0b extension ii): body, secondary and faint text on a selected row.
const TEXT_TOKENS = ['--text', '--muted', '--faint'];
// The tint is only a few ΔE from the surface, so text-over-tint is nearly text-over-surface: any anti-aliased
// grey would slide along it. Two limits keep it honest: the same glyph has the same coverage on both sides, so
// the blend positions must agree within 0.05 (not T_AGREE); and these members are weak (they need strong evidence,
// the tint itself, within EVIDENCE_RADIUS).
const TEXT_ON_TINT = { tAgree: 0.05, forceWeak: true };
// A member whose own old→new change is under ΔE00 4 (only the light halo, #f4f5f7 → #ffffff, today) carries no
// hue evidence of the swap: grey→grey. Its passes are "weak" and need strong evidence nearby (see classifyImage).
const WEAK_DE = 4;
const same = (p, q) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
const deOf = (p, q) => deltaE00(lab(p), lab(q));

// Builds the matchable members for one theme: solid members, soft-over-surface members, member pairs, text on the
// soft tint, and the accent color-mixes. Each member has an old and a new colour; `pair` members carry their own
// second end instead of using N; `n` members carry a fixed neutral (the text colour) that the near-N rule uses.
// A member that does not change at all can't explain a changed pixel, so it is dropped.
function membersOf(oldTheme, newTheme, mixSpecs = [], themeName = null) {
  const members = [];
  const solid = {};
  for (const [key, token] of Object.entries(FAMILY_TOKENS)) {
    try {
      solid[key] = { old: parseColour(oldTheme[token]).slice(0, 3), new: parseColour(newTheme[token]).slice(0, 3) };
      members.push({ key, ...solid[key] });
    } catch { /* a token missing on one side isn't part of this flip */ }
  }
  const surfaces = [];
  for (const s of SURFACE_TOKENS) { try { surfaces.push({ name: s, rgb: parseColour(newTheme[s]).slice(0, 3) }); } catch { /* none */ } }
  try {
    const os = parseColour(oldTheme[SOFT_TOKEN]); const ns = parseColour(newTheme[SOFT_TOKEN]);
    for (const s of surfaces) {
      const soft = { old: over(os, s.rgb), new: over(ns, s.rgb) };
      members.push({ key: `soft/${s.name}`, ...soft });
      // (ii) text anti-aliased over the tint: the text colour is the neutral end, the tint is the changing end
      for (const t of TEXT_TOKENS) {
        try {
          const to = parseColour(oldTheme[t]).slice(0, 3); const tn = parseColour(newTheme[t]).slice(0, 3);
          if (same(to, tn)) members.push({ key: `${t}~soft/${s.name}`, ...soft, n: to, ...TEXT_ON_TINT });
          else members.push({ key: `${t}~soft/${s.name}`, ...soft, pairOld: to, pairNew: tn, ...TEXT_ON_TINT });
        } catch { /* no such text token */ }
      }
      if (solid.ink) {
        if (same(solid.ink.old, solid.ink.new)) members.push({ key: `ink~soft/${s.name}`, ...soft, n: solid.ink.old, ...TEXT_ON_TINT });
        else members.push({ key: `ink~soft/${s.name}`, ...soft, pairOld: solid.ink.old, pairNew: solid.ink.new, ...TEXT_ON_TINT });
      }
    }
  } catch { /* no soft tint */ }
  for (const [a, b] of PAIRS) {
    if (solid[a] && solid[b]) members.push({ key: `${a}~${b}`, old: solid[a].old, new: solid[a].new, pairOld: solid[b].old, pairNew: solid[b].new });
  }
  const mixes = mixMembers(mixSpecs, oldTheme, newTheme, surfaces, themeName);
  members.push(...mixes.members);
  const kept = members.filter((m) => !same(m.old, m.new) || (m.pairOld && !same(m.pairOld, m.pairNew)));
  for (const m of kept) {
    const change = Math.max(deOf(m.old, m.new), m.pairOld ? deOf(m.pairOld, m.pairNew) : 0);
    m.weak = !!m.forceWeak || change < WEAK_DE;
  }
  return { members: kept, unresolved: mixes.unresolved };
}

// Families per theme, plus `both` (the pooled R0a families) for a baseline whose name gives no theme.
// `mixTexts` (optional) is { old: [stylesheet text], new: [stylesheet text] }: the CSS at the base and the head,
// from which the accent color-mixes are parsed. Specs from both sides are pooled; each is computed with the old
// tokens for its old colour and the new tokens for its new one.
function familiesOf(oldCss, newCss, mixTexts = { old: [], new: [] }) {
  const o = tokensOf(oldCss); const n = tokensOf(newCss);
  // Review: base mixes come from the base CSS and head mixes from the head CSS, never pooled. A mix that exists
  // on only one side was never rendered on the other, so it builds no member (fail closed) and is listed.
  // Round 5: a mix that reads an alias of an accent var (`.cat-x { --tint: var(--accent) }` with
  // `color-mix(in oklab, var(--tint) 70%, var(--text))`) is modelled by substituting the alias's accent target(s),
  // one spec per target that side assigns. Where the alias holds a non-accent value, that mix doesn't change.
  const side = (texts) => {
    const m = new Map(); const all = texts || [];
    // Review round 5: an alias's targets are scoped to the sheet that declares it. A var(--tint) mix in another
    // sheet (where --tint may be green) gets nothing from this sheet's `--tint: var(--accent)`.
    const targetsIn = (t) => {
      const targets = new Map();
      for (const d of String(t).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*var\((--[\w-]+)\)\s*[;}]/g)) {
        if (ACCENT_VARS.has(d[2]) && !ACCENT_VARS.has(d[1])) { if (!targets.has(d[1])) targets.set(d[1], new Set()); targets.get(d[1]).add(d[2]); }
      }
      return targets;
    };
    const put = (spec, local) => {
      const reads = local ? [...spec.raw.matchAll(/var\((--[\w-]+)\)/g)].map((x) => x[1]).filter((v) => v in local.dark || (local.light && v in local.light)) : [];
      const key = reads.length ? `${spec.raw} [sheet ${reads.join(' ')}]` : spec.raw;
      if (!m.has(key)) m.set(key, reads.length ? { ...spec, raw: key, local } : spec);
    };
    for (const t of all) {
      const local = sheetTokensOf(t);
      for (const spec of colourMixesOf(t)) put(spec, local);
      for (const [alias, tos] of targetsIn(t)) {
        if (!String(t).includes(`var(${alias})`)) continue;
        for (const to of tos) {
          const sub = String(t).split(`var(${alias})`).join(`var(${to})`);
          const before = new Set(colourMixesOf(String(t).split(`var(${alias})`).join('var(--x-none)')).map((x) => x.raw));
          for (const spec of colourMixesOf(sub)) if (!before.has(spec.raw)) put({ ...spec, raw: `${spec.raw} via ${alias}` }, local);
        }
      }
    }
    return m;
  };
  const base = side(mixTexts.old); const head = side(mixTexts.new);
  const specs = new Map([...head].filter(([raw]) => base.has(raw)).map(([raw, spec]) => [raw, base.get(raw).local ? { ...spec, baseLocal: base.get(raw).local } : spec]));
  const literal = literalMixPairsOf(mixTexts.files);
  for (const spec of literal.specs) specs.set(spec.raw, spec);
  const skipped = [];
  for (const t of [...(mixTexts.old || []), ...(mixTexts.new || []), ...(mixTexts.js || []).map((x) => ({ js: x }))]) {
    for (const sk of skippedMixesOf(typeof t === 'string' ? t : t.js, { js: typeof t !== 'string', aliases: aliasesOf([...(mixTexts.old || []), ...(mixTexts.new || [])]) })) {
      if (!skipped.some((x) => x.raw === sk.raw && x.why === sk.why)) skipped.push(sk);
    }
  }
  const out = { mixes: { parsed: specs.size, base: base.size, head: head.size,
    onlyBase: [...base.keys()].filter((r) => !head.has(r)), onlyHead: [...head.keys()].filter((r) => !base.has(r)), unresolved: [], skipped,
    literal: literal.specs.map((x) => x.raw), literalRefused: literal.refused } };
  for (const theme of ['light', 'dark']) {
    const surfaces = [];
    for (const s of SURFACE_TOKENS) { try { surfaces.push(parseColour(n[theme][s]).slice(0, 3)); } catch { /* none */ } }
    const built = membersOf(o[theme], n[theme], [...specs.values()], theme);
    out[theme] = { members: built.members, surfaces };
    for (const u of built.unresolved) if (!out.mixes.unresolved.includes(u)) out.mixes.unresolved.push(u);
  }
  // `both` pools the themes; only the unit tests of single-pixel rules use it. familiesFor() never returns it.
  out.both = { members: [...out.light.members, ...out.dark.members], surfaces: [...out.light.surfaces, ...out.dark.surfaces] };
  // Fail closed: no member explains anything, so every changed pixel that isn't noise is unexpected.
  out.none = { members: [], surfaces: [] };
  return out;
}

// (c) 'dark', 'light' or 'both', from a baseline path's file name.
function themeOf(baseline) {
  const name = String(baseline).split('/').pop();
  const dark = /(^|-)dark(-|\.png$)/.test(name); const light = /(^|-)light(-|\.png$)/.test(name);
  return dark === light ? 'both' : dark ? 'dark' : 'light';
}
// (c′) Which theme a baseline was rendered in, from the image itself (review refinements):
//   - the pixels that did NOT change between base and head (opaque) vote by lightness: L* ≥ 60 light,
//     L* ≤ 40 dark, the middle abstains. Native chrome (#c3c3c3 menus, scrollbars) votes too, which exact
//     surface-token hits would miss;
//   - the winner needs ≥ 70 % of the votes. Otherwise the image is mixed (a light page with a dark widget, a dark
//     tooltip in a light shot) and fails closed: no members (`none`), never pooled;
//   - a -dark-/-light- file name is checked against the image, and a disagreement fails closed too.
// The head image uses the same theme.
const THEME_DOMINANCE = 0.7;
const L_LIGHT = 60; const L_DARK = 40;
const VOTE_CHROMA = 8;
function lightnessVotes(baseImg, headImg) {
  const votes = { light: 0, dark: 0 };
  const cache = new Map();
  const A = baseImg.data; const B = headImg && headImg.data.length === A.length ? headImg.data : null;
  const w = baseImg.width; const h = A.length / 4 / w;
  // Only flat surface votes: the pixel and its 8 neighbours are identical at base. Glyph strokes (the dark
  // theme's --text #f0f1f3 is near-neutral and light) are never 3×3 flat at UI text sizes.
  const flat = (p) => {
    const x = p % w; const y = (p - x) / w;
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return false;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const q = (p + dy * w + dx) * 4; const j = p * 4;
      if (A[q] !== A[j] || A[q + 1] !== A[j + 1] || A[q + 2] !== A[j + 2] || A[q + 3] !== A[j + 3]) return false;
    }
    return true;
  };
  for (let j = 0; j < A.length; j += 4) {
    if (A[j + 3] !== 255) continue;
    if (!flat(j / 4)) continue;
    if (B && (A[j] !== B[j] || A[j + 1] !== B[j + 1] || A[j + 2] !== B[j + 2] || B[j + 3] !== 255)) continue;
    const key = (A[j] << 16) | (A[j + 1] << 8) | A[j + 2];
    let v = cache.get(key);
    if (v === undefined) {
      // Review round 5: only near-neutral pixels vote (C* ≤ 8). Saturated art (the mascot's #cd7c5d, #7fc2a8,
      // #f0978b, #ddb772) says nothing about the surface the page is drawn on.
      const [L, a2, b2] = lab([A[j], A[j + 1], A[j + 2]]);
      v = Math.hypot(a2, b2) > VOTE_CHROMA ? '' : L >= L_LIGHT ? 'light' : L <= L_DARK ? 'dark' : '';
      cache.set(key, v);
    }
    if (v) votes[v] += 1;
  }
  return votes;
}
// A theme known from source (classify.config.json `themes`: { theme, source, reason, baselines }) replaces the
// vote for exactly the listed baselines, e.g. the widget window, which index.html pins to data-theme="dark"; its
// transparent window composites light and dark mascot pixels, so the vote is always ambiguous. Unlisted
// baselines still vote and still fail closed.
function themeFromConfig(baseline, config) {
  const hit = ((config && config.themes) || []).find((t) => Array.isArray(t.baselines) && t.baselines.includes(baseline));
  return hit && (hit.theme === 'light' || hit.theme === 'dark') ? hit : null;
}
// Review round 6: a vote counts only when the flat near-neutral pixels cover ≥ 2 % of the image or ≥ 500 px;
// otherwise 10 flat px could decide a theme. Too few votes: an inferred theme is 'none', and a pinned theme
// keeps its source citation (the mismatch backstop needs enough votes to contradict it).
const VOTE_MIN_PX = 500; const VOTE_MIN_SHARE = 0.02;
const enoughVotes = (sum, img) => sum >= VOTE_MIN_PX || sum >= VOTE_MIN_SHARE * img.width * img.height;
function themeFor(families, baseline, baseImg, headImg, config) {
  const pinned = themeFromConfig(baseline, config);
  if (pinned) {
    // sanity check (review round 3): a mapping that contradicts a clear vote fails closed instead of lending
    // one theme's members to the other's image
    const votes = baseImg ? lightnessVotes(baseImg, headImg) : { light: 0, dark: 0 };
    const sum = votes.light + votes.dark;
    const other = pinned.theme === 'dark' ? 'light' : 'dark';
    const share = sum ? +(votes[pinned.theme] / sum).toFixed(3) : 0;
    if (sum && baseImg && enoughVotes(sum, baseImg) && votes[other] / sum >= THEME_DOMINANCE) return { theme: 'none', source: `mismatch (config ${pinned.theme}, image ${other})`, coverage: votes, share, families: families.none };
    return { theme: pinned.theme, source: `config (${pinned.source})`, coverage: votes, share, families: families[pinned.theme] };
  }
  const named = themeOf(baseline);
  if (!baseImg) return { theme: 'none', source: 'no image', coverage: null, share: 0, families: families.none };
  const votes = lightnessVotes(baseImg, headImg);
  const sum = votes.light + votes.dark;
  const share = sum ? +(Math.max(votes.light, votes.dark) / sum).toFixed(3) : 0;
  if (!enoughVotes(sum, baseImg)) return { theme: 'none', source: `too few votes (${sum} px)`, coverage: votes, share, families: families.none };
  const inferred = !sum ? null : votes.light / sum >= THEME_DOMINANCE ? 'light' : votes.dark / sum >= THEME_DOMINANCE ? 'dark' : null;
  if (!inferred) return { theme: 'none', source: 'ambiguous', coverage: votes, share, families: families.none };
  if (named !== 'both' && named !== inferred) return { theme: 'none', source: `mismatch (name ${named}, image ${inferred})`, coverage: votes, share, families: families.none };
  return { theme: inferred, source: named === 'both' ? 'image' : 'name+image', coverage: votes, share, families: families[inferred] };
}
const familiesFor = (families, baseline, baseImg, headImg, config) => themeFor(families, baseline, baseImg, headImg, config).families;

// (d) The expected-list file for a branch, and whether it asks for the classifier (first line `# classify`).
const expectedFileFor = (branch) => `test-visual/expected/${String(branch).trim().replace(/\//g, '-')}.txt`;
const wantsClassify = (text) => typeof text === 'string' && text.split(/\r?\n/, 1)[0].trim() === '# classify';

// ── Pixels ───────────────────────────────────────────────────────────────────────────────────────────────────
// Tests one member against one neutral. Returns { v, tOld, tNew } with v 'pass', 'unchanged' or 'skipped', or null
// (no fit). A member with a fixed neutral (`n`, text on the tint) uses it instead of the pixel's N.
function judge(oldPx, newPx, m, n) {
  const N = m.n || n;
  const oEnd = m.pairOld || N; const nEnd = m.pairNew || N;
  const o = onSegment(oldPx, m.old, oEnd);
  if (o.de > DE_MAX) return null;
  const h = onSegment(newPx, m.new, nEnd);
  if (h.de > DE_MAX) return null;
  const at = { tOld: o.t, tNew: h.t };
  if (!m.pairOld && o.t < T_NONE) {
    if (h.t < T_NONE) return { v: 'unchanged', ...at };
    return h.t <= T_NONE + T_AGREE ? { v: 'skipped', ...at } : null;
  }
  if (Math.abs(o.t - h.t) > (m.tAgree ?? T_AGREE)) return null;
  // M1 (review): if the OLD pixel already lies on the NEW member's segment, the fit shows nothing of the old
  // accent (a grey that sits on a Graphite segment either way), so the pass is weak: it needs evidence nearby.
  const blind = onSegment(oldPx, m.new, nEnd).de <= DE_MAX;
  return { v: 'pass', blind, ...at };
}

// A pixel that sits at N on any segment carries no colour information, so "unchanged" and "skipped" outrank a
// pass that another member might give it (§R4.4: near-N blends are never counted as passes). Among passes, a
// strong member outranks a weak one.
const RANK = { unchanged: 4, skipped: 3, pass: 2, weak: 1 };
// Returns the best explanation: { verdict, weak, key, n, tOld, tNew }, verdict 'unexpected' when nothing fits.
// An old pixel within ΔE00 1 of a neutral IS that neutral: it holds no accent, so it can only be near-N
// ("unchanged" or "skipped", which then need evidence), never a pass.
function explainPixel(oldPx, newPx, neutrals, members) {
  let best = null; let bestRank = 0;
  const atN = neutrals.find((n) => deOf(oldPx, n) <= DE_NOISE);
  if (atN) {
    for (const m of members) {
      if (m.pairOld || m.n) continue;
      const r = judge(oldPx, newPx, m, atN);
      if (r && r.v !== 'pass' && RANK[r.v] > bestRank) { best = { verdict: r.v, weak: false, key: m.key, n: atN, tOld: r.tOld, tNew: r.tNew }; bestRank = RANK[r.v]; }
    }
    return best || { verdict: 'unexpected' };
  }
  for (const n of neutrals) {
    for (const m of members) {
      const r = judge(oldPx, newPx, m, n);
      if (!r) continue;
      const wk = r.v === 'pass' && (!!m.weak || !!r.blind);
      const rank = wk ? RANK.weak : RANK[r.v];
      if (rank > bestRank) { best = { verdict: r.v, weak: wk, key: m.key, n: m.n || n, tOld: r.tOld, tNew: r.tNew }; bestRank = rank; }
      if (rank === RANK.unchanged) return best;
    }
  }
  return best || { verdict: 'unexpected' };
}
const classifyPixel = (oldPx, newPx, neutrals, members) => explainPixel(oldPx, newPx, neutrals, members).verdict;

// Compares two decoded images ({ width, height, data: RGBA bytes }). Returns counts, the unexpected samples and
// the crop tiles that hold unexpected pixels.
//
// Per changed pixel, in order:
//   1. alpha changed → unexpected;  ΔE00(old, new) ≤ 1 → noise (pre-filter a).
//   2. Neutrals: the nearest unchanged pixel within 5 px, AND the theme's surface tokens (extension i: the nearest
//      unchanged pixel is often a different element, text or a border, not the background the pixel blends with).
//   3. Best explanation over every member × neutral (explainPixel).
//   4. Evidence rule: "unchanged", "skipped" and passes through a weak member carry no hue evidence of the swap
//      (Graphite is itself a grey, so a grey surface that shifts sits on the near-N end of every accent segment).
//      They are accepted only within 2 px (EVIDENCE_RADIUS) of a strong pass or a named exception; otherwise they are unexpected.
// `onPixel(x, y, oldHex, newHex, explanation)` (optional) sees every non-noise changed pixel's final explanation.
// Round 5 (team-lead decision): `alphaEdge` is set only for windows that are transparent by construction (the
// index.html widget list in classify.config.json `themes`). There, an anti-aliased edge pixel (0 < α < 255 on
// both sides) whose alpha moved by 1 or 2 is classified on its colour (the decode is straight, not premultiplied)
// but is never strong and never evidence: it must be a member pass or an exception, and a weak one still needs a
// strong pixel within 2 px. Any other alpha change, and any alpha change in an opaque shot, is unexpected.
const ALPHA_EDGE_MAX = 2;
// Review round 6: the gate decodes through a 2D canvas, which stores premultiplied pixels, so a translucent
// pixel's straight RGB is quantised to about 255/α levels. Below α 64 that error exceeds the classifier's
// tolerances, so those pixels get no Δα allowance (they fail as before).
const ALPHA_EDGE_MIN = 64;
function classifyImage(oldImg, newImg, families, { exceptions = [], tile = 24, onPixel = null, alphaEdge = false } = {}) {
  const total = oldImg.width * oldImg.height;
  if (oldImg.width !== newImg.width || oldImg.height !== newImg.height) {
    return { total, changed: total, noise: 0, pass: 0, unchanged: 0, skipped: 0, exception: 0, unexpected: total, sizeChanged: true, tiles: [], samples: [], noiseTiles: 0, maxNoiseTileShare: 0 };
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
  const out = { total, changed: nChanged, noise: 0, pass: 0, unchanged: 0, skipped: 0, exception: 0, unexpected: 0, sizeChanged: false, tiles: [], samples: [], noiseTiles: 0, maxNoiseTileShare: 0 };
  if (!nChanged) return out;
  const offsets = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy += 1) for (let dx = -RADIUS; dx <= RADIUS; dx += 1) if ((dx || dy) && dx * dx + dy * dy <= RADIUS * RADIUS) offsets.push([dx, dy, dx * dx + dy * dy]);
  offsets.sort((p, q) => p[2] - q[2]);
  const cache = new Map();
  const expl = new Array(total);
  const strong = new Uint8Array(total);
  const exCore = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (!changed[i]) continue;
    const j = i * 4;
    const x = i % w; const y = (i - x) / w;
    let alphaMoved = false;
    if (A[j + 3] !== B[j + 3]) {
      const ok = alphaEdge && A[j + 3] >= ALPHA_EDGE_MIN && A[j + 3] < 255 && B[j + 3] >= ALPHA_EDGE_MIN && B[j + 3] < 255 && Math.abs(A[j + 3] - B[j + 3]) <= ALPHA_EDGE_MAX;
      if (!ok) { expl[i] = { verdict: 'unexpected', reason: 'alpha changed' }; continue; }
      alphaMoved = true;
    }
    const oldPx = [A[j], A[j + 1], A[j + 2]]; const newPx = [B[j], B[j + 1], B[j + 2]];
    let local = null;
    for (const [dx, dy] of offsets) {
      const xx = x + dx; const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const k = yy * w + xx;
      if (!changed[k] && A[k * 4 + 3] === 255) { local = [A[k * 4], A[k * 4 + 1], A[k * 4 + 2]]; break; }
    }
    const key = `${oldPx}|${newPx}|${local || 's'}|${alphaMoved ? 'a' : ''}`;
    let e = cache.get(key);
    if (!e) {
      if (deltaE00(lab(oldPx), lab(newPx)) <= DE_NOISE) e = { verdict: 'noise' };
      else {
        const neutrals = local ? [local, ...families.surfaces] : families.surfaces;
        e = explainPixel(oldPx, newPx, neutrals, families.members);
        // An exception is tried whenever the members give no strong pass: unexpected, or a verdict that would
        // still need evidence (a weak pass, unchanged, skipped). Its core is strong; anything else keeps the
        // member's verdict unless that was unexpected.
        const needsEvidence = e.verdict === 'unchanged' || e.verdict === 'skipped' || (e.verdict === 'pass' && e.weak);
        if ((e.verdict === 'unexpected' || needsEvidence) && exceptions.length) {
          // N2 (review round 2): an exception is its exact colour pair. Only the core (old within ΔE 1 of the
          // exception's old colour AND new within ΔE 1 of its paired new colour) is strong. A blend along the
          // exception's segment is accepted only within EVIDENCE_RADIUS of a core pixel and is never evidence for
          // anything else, so a grey shifted along the same direction can't pass on its own.
          const oL = lab(oldPx); const nL = lab(newPx);
          const core = exceptions.find((x) => deltaE00(oL, lab(x.old)) <= DE_NOISE && deltaE00(nL, lab(x.new)) <= DE_NOISE);
          if (core) e = { verdict: 'exception', core: true, key: core.key };
          else if (e.verdict === 'unexpected') {
            const x2 = explainPixel(oldPx, newPx, neutrals, exceptions);
            if (x2.verdict === 'pass') e = { ...x2, verdict: 'exception', core: false };
          }
        }
      }
      if (alphaMoved) {
        // never strong, never evidence: a pass becomes weak, an exception core a non-core exception; anything
        // that isn't a pass or an exception (noise, unchanged, skipped, unexpected) fails
        if (e.verdict === 'pass') e = { ...e, weak: true, alphaEdge: true };
        else if (e.verdict === 'exception') e = { ...e, core: false, alphaEdge: true };
        else e = { verdict: 'unexpected', reason: 'alpha moved and the colour is not a member or exception' };
      }
      cache.set(key, e);
    }
    expl[i] = e;
    if (e.verdict === 'pass' && !e.weak) strong[i] = 1;
    else if (e.verdict === 'exception' && e.core) { strong[i] = 1; exCore[i] = 1; }
  }
  const near = (i, grid = strong) => {
    const x = i % w; const y = (i - x) / w;
    for (const [dx, dy, d2] of offsets) {
      if (d2 > EVIDENCE_RADIUS * EVIDENCE_RADIUS) break;
      const xx = x + dx; const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && grid[yy * w + xx]) return true;
    }
    return false;
  };
  const tiles = new Map();
  const noiseTiles = new Map();
  const hx = (buf, j) => `#${buf.subarray(j, j + 3).reduce((s, v) => s + v.toString(16).padStart(2, '0'), '')}`;
  for (let i = 0; i < total; i += 1) {
    if (!changed[i]) continue;
    let e = expl[i];
    const needsEvidence = e.verdict === 'unchanged' || e.verdict === 'skipped' || (e.verdict === 'pass' && e.weak);
    if (needsEvidence && !near(i)) e = { ...e, verdict: 'unexpected', reason: e.alphaEdge ? 'alpha edge with no strong evidence within 2 px' : 'no strong evidence within 2 px' };
    else if (e.verdict === 'exception' && !e.core && !near(i, exCore)) e = { ...e, verdict: 'unexpected', reason: 'exception blend with no exception core within 2 px' };
    out[e.verdict] += 1;
    if (e.verdict === 'noise') {
      const xn = i % w; const yn = (i - xn) / w; const tn = `${Math.floor(xn / tile)},${Math.floor(yn / tile)}`;
      noiseTiles.set(tn, (noiseTiles.get(tn) || 0) + 1);
      continue;
    }
    const j = i * 4; const x = i % w; const y = (i - x) / w;
    if (onPixel) onPixel(x, y, hx(A, j), hx(B, j), e);
    if (e.verdict !== 'unexpected') continue;
    if (out.samples.length < 12) out.samples.push({ x, y, old: hx(A, j), new: hx(B, j) });
    const t = `${Math.floor(x / tile)},${Math.floor(y / tile)}`;
    tiles.set(t, (tiles.get(t) || 0) + 1);
  }
  const tileOf = (k, count, kind) => { const [tx, ty] = k.split(',').map(Number); return { x: tx * tile, y: ty * tile, w: Math.min(tile, w - tx * tile), h: Math.min(tile, h - ty * tile), count, kind }; };
  out.tiles = [...tiles.entries()].map(([k, count]) => tileOf(k, count, 'unexpected')).sort((p, q) => q.count - p.count);
  // M2 (review): noise is real render noise only when it is sparse. A tile that is mostly noise is a dense shift
  // under ΔE 1 (a token nudged one step): it fails the gate and goes in the crops, marked as noise.
  const dense = [...noiseTiles.entries()].map(([k, count]) => tileOf(k, count, 'noise')).filter((t) => t.count >= NOISE_TILE_SHARE * t.w * t.h);
  out.noiseTiles = dense.length;
  out.maxNoiseTileShare = +Math.max(0, ...[...noiseTiles.entries()].map(([k, c]) => { const t = tileOf(k, c); return c / (t.w * t.h); })).toFixed(3);
  out.tiles.push(...dense.sort((p, q) => q.count - p.count));
  return out;
}

// Exception entries from classify.config.json → members, for one baseline.
// A named exception applies only to the baselines it lists (N2, review round 2: no wildcard). An optional "theme"
// ('light' | 'dark') also requires the baseline to be classified in that theme (themeFor's result). In
// classifyImage only the exact pair (± ΔE 1) is strong; blends along it need a core pixel within 2 px.
// The base the gate compares against: CLASSIFY_BASE, else the merge-base with origin/main. Never a fallback to
// HEAD (review round 6): with no origin/main the old PNGs would equal the new ones and the gate would pass
// vacuously, so an active gate fails with a clear message, like the structural gate.
function resolveBase(envBase, mergeBase) {
  if (envBase) return envBase;
  let ref = '';
  try { ref = String(mergeBase() || '').trim(); } catch { ref = ''; }
  if (!ref) throw new Error('classify: no merge-base with origin/main (fetch it; CI needs fetch-depth 0), or set CLASSIFY_BASE');
  return ref;
}

function exceptionsFor(baseline, config, theme) {
  const out = [];
  for (const e of (config && config.exceptions) || []) {
    if (!(Array.isArray(e.baselines) && e.baselines.includes(baseline))) continue;
    if (e.theme && e.theme !== theme) continue;
    // `pairs` ([[old, new], …]) keeps each old colour with its own new one; `old`/`new` lists are crossed.
    const pairs = e.pairs || (e.old || []).flatMap((o) => (e.new || []).map((n) => [o, n]));
    for (const [o, n] of pairs) out.push({ key: `exception:${e.name}`, old: parseColour(o).slice(0, 3), new: parseColour(n).slice(0, 3) });
  }
  return out;
}

// The gate: § R3.10 item 6.
// M2 (review): noise caps. A tile counts as dense noise at ≥ 50 % of its pixels. The total cap is recalibrated
// (review round 2) on the R0b run over the 65 changed baselines (base 47ad8ac1): routed-light 0.693 %, then
// 0.134 % (lights-template-minimal), 0.130 %, 0.062 %, all others ≤ 0.024 %. The cap is 0.25 % (about twice
// the second highest). routed-light has a named cause and a scoped allowance in classify.config.json `noise`.
const NOISE_TILE_SHARE = 0.5;
// crops is a review-load cap, set just above the load that was hand-reviewed: 185 crops across the R0b set, plus
// the 27 from the work-scope shots (accent text and the pill/avatar edges anti-aliased in the widget's translucent
// stack: text over the 18 % pill wash over the 0.94 card in a transparent window), reviewed by hand in round 8b.
// 212 + a margin of 3. Raise it only after reviewing the new crops.
const CAPS = { unexpectedRatio: 0.005, crops: 215, noiseRatio: 0.0025 };
// A per-baseline noise allowance from classify.config.json: { baseline, maxRatio, reason }. Exact path only.
const noiseCapFor = (baseline, config) => {
  const hit = ((config && config.noise) || []).find((n) => n.baseline === baseline);
  return hit ? hit.maxRatio : CAPS.noiseRatio;
};
function verdictOf(results, config) {
  const failures = [];
  let crops = 0;
  for (const r of results) {
    if (r.added || r.removed) { failures.push(`${r.baseline}: ${r.added ? 'added' : 'removed'} (an accent flip adds and removes no baseline)`); continue; }
    crops += r.tiles.length;
    if (/(^|\/)characters\.spec\.js\//.test(r.baseline) && r.changed) failures.push(`${r.baseline}: characters may not change (${r.changed} pixels)`);
    if (r.sizeChanged) failures.push(`${r.baseline}: size changed`);
    else if (r.unexpected / r.total > CAPS.unexpectedRatio) failures.push(`${r.baseline}: ${(100 * r.unexpected / r.total).toFixed(3)} % unexpected (cap 0.5 %)`);
    const noiseCap = noiseCapFor(r.baseline, config);
    if (!r.sizeChanged && r.noise / r.total > noiseCap) failures.push(`${r.baseline}: ${(100 * r.noise / r.total).toFixed(3)} % noise (cap ${+(100 * noiseCap).toFixed(3)} %)`);
    if (r.noiseTiles) failures.push(`${r.baseline}: ${r.noiseTiles} tile(s) at least ${100 * NOISE_TILE_SHARE} % noise (a dense shift under ΔE 1)`);
  }
  if (crops > CAPS.crops) failures.push(`${crops} review crops (cap ${CAPS.crops})`);
  return { failures, crops };
}

module.exports = { htmlParts, RETIRED_ACCENT_RGB, literalMixPairsOf, declarationsOf, ALPHA_EDGE_MIN, VOTE_MIN_PX, VOTE_MIN_SHARE, resolveBase, ALPHA_EDGE_MAX, VOTE_CHROMA, sheetTokensOf, aliasesOf, skippedMixesOf, NOISE_TILE_SHARE, EVIDENCE_RADIUS, T_NONE, parseColour, lab, deltaE00, onSegment, tokensOf, familiesOf, themeOf, themeFor, themeFromConfig, lightnessVotes, THEME_DOMINANCE, familiesFor, expectedFileFor, wantsClassify, colourMixesOf, computeMix, explainPixel, classifyPixel, classifyImage, WEAK_DE, exceptionsFor, noiseCapFor, verdictOf, CAPS, DE_MAX, DE_NOISE, T_AGREE };
