'use strict';
// Classifier controls (plan-redesign §R4.4, lead conditions for R0b). Synthetic old/new image pairs, run through
// the real classifier by test/classify-lib.test.js (raw pixels) and classify.spec.js (encoded as PNGs and decoded
// in Electron, like the baselines). Every `fail` control must fail the gate in both themes; the `pass` controls
// prove the gate still accepts the swap it exists for. The base is the frozen terracotta tokens
// (test/fixtures/tokens-terracotta-r0a.css), the head is Graphite.
const lib = require('./classify-lib');

const W = 64; const H = 48;
const hex = (h) => lib.parseColour(h).slice(0, 3);
const shift = (c, d) => c.map((v) => Math.max(0, Math.min(255, v + d)));
const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));
const image = (fill) => {
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) data.set([...fill(i % W, Math.floor(i / W)), 255], i * 4);
  return { width: W, height: H, data };
};
const box = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
 // An anti-aliased stroke profile, period 20 px: 4 px soft edges around a 4 px core. `ramp2` is the same glyph
// one pixel bolder; `rampSub` is a sub-pixel bolder variant (edges moved 0.25 px).
const ramp = (x, off = 0) => { const u = (x + off) % 20; return u < 6 ? 0 : u < 10 ? (u - 6) / 4 : u < 14 ? 1 : u < 18 ? (18 - u) / 4 : 0; };
const ramp2 = (x) => { const u = x % 20; return u < 5 ? 0 : u < 9 ? (u - 5) / 4 : u < 15 ? 1 : u < 19 ? (19 - u) / 4 : 0; };
const rampSub = (x) => { const u = x % 20; return u < 5.75 ? 0 : u < 9.75 ? (u - 5.75) / 4 : u < 14.25 ? 1 : u < 18.25 ? (18.25 - u) / 4 : 0; };
const glyphA = (x, y) => (x * 7 + y * 3) % 11 < 4 && box(x, y, 10, 18, 54, 30);
const glyphB = (x, y) => (x * 5 + y * 9) % 13 < 5 && box(x, y, 10, 18, 54, 30);

const THEMES = {
  light: { bg: '#eef0f3', text: '#20252d', grey: '#8792a0', accentOld: '#a34425', accentNew: '#24292f', stuck: '#c2352b', other: '#945c12', softOld: [163, 68, 37, 0.08], softNew: [36, 41, 47, 0.14] },
  dark: { bg: '#292d34', text: '#f0f1f3', grey: '#8792a0', accentOld: '#e49a78', accentNew: '#e6e8eb', stuck: '#ff9187', other: '#e4b566', softOld: [228, 154, 120, 0.14], softNew: [230, 232, 235, 0.14] },
};
const over = (c, bg) => [0, 1, 2].map((i) => Math.round(c[i] * c[3] + bg[i] * (1 - c[3])));

function controls() {
  const out = [];
  for (const [theme, t] of Object.entries(THEMES)) {
    const BG = hex(t.bg); const FG = hex(t.text); const AO = hex(t.accentOld); const AN = hex(t.accentNew);
    const add = (name, expect, oldFill, newFill, extra = {}) => out.push({ name: `${theme}: ${name}`, theme, expect, old: image(oldFill), new: image(newFill), ...extra });
    // (a) a neutral grey shifted by ΔE ≥ 2, no accent involved: a surface, a grey box, and a surface beside a real swap
    const S = shift(BG, theme === 'light' ? -10 : -12);
    add('(a) surface region shifted ΔE ≥ 2', 'fail', () => BG, (x, y) => (box(x, y, 10, 10, 40, 30) ? S : BG));
    add('(a) grey box shifted ΔE ≥ 2', 'fail', (x, y) => (box(x, y, 10, 10, 40, 30) ? hex(t.grey) : BG), (x, y) => (box(x, y, 10, 10, 40, 30) ? shift(hex(t.grey), 8) : BG));
    add('(a) surface shifted next to a correct accent swap', 'fail',
      (x, y) => (box(x, y, 4, 4, 12, 12) ? AO : BG),
      (x, y) => (box(x, y, 4, 4, 12, 12) ? AN : box(x, y, 12, 4, 60, 44) ? shift(BG, -10) : BG));
    // (b) an element moved 1 px: a text bar, and an accent button that also changed colour
    add('(b) text bar moved 1 px', 'fail', (x, y) => (box(x, y, 10, 20, 50, 23) ? FG : BG), (x, y) => (box(x, y, 10, 21, 50, 24) ? FG : BG));
    add('(b) accent button moved 1 px', 'fail', (x, y) => (box(x, y, 10, 10, 50, 30) ? AO : BG), (x, y) => (box(x, y, 11, 10, 51, 30) ? AN : BG));
    // (c) a non-accent colour changed: the Stuck status colour
    add('(c) --st-stuck recoloured', 'fail', (x, y) => (box(x, y, 20, 15, 30, 25) ? hex(t.stuck) : BG), (x, y) => (box(x, y, 20, 15, 30, 25) ? hex(t.other) : BG));
    // (d) text content changed, in text colour and in accent colour
    add('(d) text content changed', 'fail', (x, y) => (glyphA(x, y) ? FG : BG), (x, y) => (glyphB(x, y) ? FG : BG));
    add('(d) accent text content changed', 'fail', (x, y) => (glyphA(x, y) ? AO : BG), (x, y) => (glyphB(x, y) ? AN : BG));
    // ── S4 (review): subtler and boundary cases ──
    // (e) an element in a grey that is no surface token, shifted ΔE 3–5, no accent anywhere
    const G1 = theme === 'dark' ? [33, 34, 36] : [215, 214, 213]; const G2 = theme === 'dark' ? [21, 22, 24] : [193, 192, 191];
    add('(e) non-token grey element shifted', 'fail', (x, y) => (box(x, y, 8, 8, 56, 40) ? G1 : BG), (x, y) => (box(x, y, 8, 8, 56, 40) ? G2 : BG));
    // (f) the whole surface shifted by under ΔE 1, densely (M2)
    add('(f) dense surface shift under ΔE 1', 'fail', () => BG, () => shift(BG, theme === 'dark' ? 1 : -1));
    // (g1) an accent button swapped while its shadow shrinks from 6 px to 3 px
    const shade = (y, len) => (y >= 24 && y < 24 + len ? 0.25 * (1 - (y - 24) / len) : 0);
    add('(g1) accent button + its shadow 6 px → 3 px', 'fail',
      (x, y) => (box(x, y, 12, 10, 52, 24) ? AO : box(x, y, 12, 24, 52, 34) ? mix([0, 0, 0], BG, shade(y, 6)) : BG),
      (x, y) => (box(x, y, 12, 10, 52, 24) ? AN : box(x, y, 12, 24, 52, 34) ? mix([0, 0, 0], BG, shade(y, 3)) : BG));
    // (g2) an accent button swapped while a 4 px panel band around it shifts by 8
    const P2 = hex(theme === 'dark' ? '#292d34' : '#eef0f3'); const SURF = hex(theme === 'dark' ? '#17191d' : '#f4f5f7');
    add('(g2) accent button + a 4 px band around it shifted', 'fail',
      (x, y) => (box(x, y, 14, 12, 50, 36) ? AO : box(x, y, 10, 8, 54, 40) ? P2 : SURF),
      (x, y) => (box(x, y, 14, 12, 50, 36) ? AN : box(x, y, 10, 8, 54, 40) ? shift(P2, -8) : SURF));
    // (h) accent text swapped AND one pixel bolder (S2): the core changed, so it must fail
    const strip = (x, y) => box(x, y, 2, 16, 62, 32);
    add('(h) accent text swapped and 1 px bolder', 'fail', (x, y) => (strip(x, y) ? mix(AO, BG, ramp(x)) : BG), (x, y) => (strip(x, y) ? mix(AN, BG, ramp2(x)) : BG));
    // (h′) KNOWN LIMIT, recorded: a sub-pixel bolder accent glyph (edges 0.25 px) passes; a per-pixel colour test
    // can't tell it from gamma. The structural gate (no layout/size property may change) is what covers it.
    add('(h′) KNOWN LIMIT: accent text swapped and 0.25 px bolder passes', 'pass', (x, y) => (strip(x, y) ? mix(AO, BG, ramp(x)) : BG), (x, y) => (strip(x, y) ? mix(AN, BG, rampSub(x)) : BG));
    // (i1) a grey border 1 px → 2 px; (i2) neutral text opacity 1 → 0.8
    const LINE = theme === 'dark' ? [60, 64, 72] : [214, 218, 224];
    add('(i1) grey border 1 px → 2 px', 'fail', (x, y) => (box(x, y, 6, 6, 58, 42) && !box(x, y, 7, 7, 57, 41) ? LINE : BG), (x, y) => (box(x, y, 6, 6, 58, 42) && !box(x, y, 8, 8, 56, 40) ? LINE : BG));
    add('(i2) neutral text opacity 1 → 0.8', 'fail', (x, y) => (strip(x, y) ? mix(FG, BG, ramp(x)) : BG), (x, y) => (strip(x, y) ? mix(FG, BG, 0.8 * ramp(x)) : BG));
    // (j) a change of ~0.3 % of the image (9 of 3,072 px): under the cap, so the gate passes, but it must produce
    // crops (the reviewer sign-off list is never silently empty)
    add('(j) 0.3 % non-accent change passes the gate with crops', 'pass', (x, y) => (box(x, y, 30, 20, 33, 23) ? hex(t.stuck) : BG), (x, y) => (box(x, y, 30, 20, 33, 23) ? hex(t.other) : BG), { crops: true });
    // (k) neutral text, same coverage, different glyph shapes (a font change)
    add('(k) neutral glyph shapes changed at the same coverage', 'fail', (x, y) => (glyphA(x, y) ? FG : BG), (x, y) => (glyphA(63 - x, y) ? FG : BG));
    // positive controls: the swap itself, anti-aliased accent text, and text on a selected (soft) row
    add('accent button swapped in place', 'pass', (x, y) => (box(x, y, 10, 10, 50, 30) ? AO : BG), (x, y) => (box(x, y, 10, 10, 50, 30) ? AN : BG));
    add('anti-aliased accent text swapped', 'pass',
      (x, y) => (glyphA(x, y) ? AO : box(x, y, 10, 18, 54, 30) && (x + y) % 3 === 0 ? mix(AO, BG, 0.5) : BG),
      (x, y) => (glyphA(x, y) ? AN : box(x, y, 10, 18, 54, 30) && (x + y) % 3 === 0 ? mix(AN, BG, 0.5) : BG));
    const TO = over(t.softOld, BG); const TN = over(t.softNew, BG);
    add('text on the selected tint', 'pass',
      (x, y) => (!box(x, y, 4, 12, 60, 36) ? BG : glyphA(x, y) ? FG : (x + y) % 4 === 0 && box(x, y, 10, 18, 54, 30) ? mix(FG, TO, 0.5) : TO),
      (x, y) => (!box(x, y, 4, 12, 60, 36) ? BG : glyphA(x, y) ? FG : (x + y) % 4 === 0 && box(x, y, 10, 18, 54, 30) ? mix(FG, TN, 0.5) : TN));
  }
  // (c′) a light window whose only change is the old DARK accent turning into the new dark accent, with no theme
  // in its name: only dark members could explain it, the image is light, so it must fail
  const L = hex(THEMES.light.bg); const DO = hex(THEMES.dark.accentOld); const DN = hex(THEMES.dark.accentNew);
  out.push({ name: 'unthemed light image that only dark members explain', theme: 'infer', baseline: 'controls/unthemed-darwin.png', expect: 'fail',
    old: image((x, y) => (box(x, y, 10, 10, 50, 30) ? DO : L)), new: image((x, y) => (box(x, y, 10, 10, 50, 30) ? DN : L)) });
  out.push({ name: 'unthemed light image with a light accent swap', theme: 'infer', baseline: 'controls/unthemed-darwin.png', expect: 'pass',
    old: image((x, y) => (box(x, y, 10, 10, 50, 30) ? hex(THEMES.light.accentOld) : L)), new: image((x, y) => (box(x, y, 10, 10, 50, 30) ? hex(THEMES.light.accentNew) : L)) });
  // (c′) the name says light but the image is dark: even a correct dark swap must fail (disagreement fails closed)
  const DB = hex(THEMES.dark.bg);
  out.push({ name: 'name says light, image is dark', theme: 'infer', baseline: 'controls/menu-light-darwin.png', expect: 'fail',
    old: image((x, y) => (box(x, y, 10, 10, 50, 30) ? DO : DB)), new: image((x, y) => (box(x, y, 10, 10, 50, 30) ? DN : DB)) });
  // a mixed image (light page, dark panel, about half each) is ambiguous and fails closed
  out.push({ name: 'mixed light and dark image', theme: 'infer', baseline: 'controls/mixed-darwin.png', expect: 'fail',
    old: image((x, y) => (box(x, y, 20, 18, 28, 26) ? DO : x < 32 ? DB : L)), new: image((x, y) => (box(x, y, 20, 18, 28, 26) ? DN : x < 32 ? DB : L)) });
  // N2 (review round 2): with the dark idle exception loaded, a grey element shifted along the idle direction
  // (no Idle dot anywhere) must fail; the Idle dot itself, solid and anti-aliased, must pass.
  const IDLE = [{ key: 'exception:idle', old: hex('#726c62'), new: hex('#7c766b') }];
  const PANEL = hex('#202329');
  const el = (x, y) => box(x, y, 4, 4, 60, 44);
  for (const [o, n] of [[[30, 30, 30], [39, 39, 39]], [[60, 58, 55], [67, 65, 62]], [[90, 86, 80], [99, 95, 89]]]) {
    out.push({ name: `dark: grey ${o.join(',')} shifted along the idle direction, exception loaded`, theme: 'dark', expect: 'fail', exceptions: IDLE,
      old: image((x, y) => (el(x, y) ? o : PANEL)), new: image((x, y) => (el(x, y) ? n : PANEL)) });
  }
  // one anti-aliased ring at half coverage (a softer ring is mostly sub-ΔE1 noise, over the 0.25 % cap on a 64×48 image)
  const dot = (x, y, c) => { const d = Math.hypot(x - 32, y - 24); return d <= 5 ? c : d < 6 ? mix(c, PANEL, 0.5) : PANEL; };
  out.push({ name: 'dark: the Idle dot (solid + anti-aliased) passes as the idle exception', theme: 'dark', expect: 'pass', exceptions: IDLE,
    old: image((x, y) => dot(x, y, hex('#726c62'))), new: image((x, y) => dot(x, y, hex('#7c766b'))) });
  return out;
}

// Runs one control through the classifier and the gate. Returns { failed, result }.
function judgeControl(c, families) {
  const fam = c.theme === 'infer' ? lib.familiesFor(families, c.baseline, c.old, c.new) : families[c.theme];
  const result = lib.classifyImage(c.old, c.new, fam, { exceptions: c.exceptions || [] });
  const verdict = lib.verdictOf([{ baseline: `controls/${c.name}.png`, ...result }]);
  return { failed: verdict.failures.length > 0, result, crops: verdict.crops };
}

module.exports = { controls, judgeControl, W, H };
