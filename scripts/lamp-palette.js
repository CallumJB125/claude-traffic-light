#!/usr/bin/env node
// Checks the lamp palette (tokens.css, "Lamps" block) for colour-vision
// deficiency safety: every pair of lit lamps must stay apart under simulated
// protanopia, deuteranopia and tritanopia, and every lit lamp must clear 3:1
// against the unlit lamp (WCAG 1.4.11, non-text contrast).
//
//   node scripts/lamp-palette.js        prints the ΔE / contrast tables
//
// Simulation: Viénot, Brettel & Mollon 1999 for protan/deutan and Brettel,
// Viénot & Mollon 1997 for tritan, both in linear sRGB with the matrices
// published by DaltonLens (libDaltonLens). ΔE is Euclidean OKLab × 100
// (≈1 is a just-noticeable difference at this scale; ≥ 15 reads as a
// different colour at a glance).
const fs = require('fs');
const path = require('path');

const TOKENS = path.join(__dirname, '..', 'tokens.css');

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function hexToLinear(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
}
function linearToHex(rgb) {
  return `#${rgb.map((c) => Math.round(clamp01(toGamma(clamp01(c))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

// Ottosson's OKLab.
function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
function oklchToLinear(L, C, h) {
  const r = (h * Math.PI) / 180;
  return oklabToLinear([L, C * Math.cos(r), C * Math.sin(r)]);
}
function inGamut(rgb) {
  return rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
}

const mul = (m, [r, g, b]) => [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
const VIENOT = {
  protan: [0.11238, 0.88762, 0.0, 0.11238, 0.88762, -0.0, 0.00401, -0.00401, 1.0],
  deutan: [0.29275, 0.70725, 0.0, 0.29275, 0.70725, -0.0, -0.02234, 0.02234, 1.0],
};
const BRETTEL_TRITAN = {
  a: [1.01277, 0.13548, -0.14826, -0.01243, 0.86812, 0.14431, 0.07589, 0.805, 0.11911],
  b: [0.93678, 0.18979, -0.12657, 0.06154, 0.81526, 0.1232, -0.37562, 1.12767, 0.24796],
  n: [0.03901, -0.02788, -0.01113],
};
const SIMS = {
  normal: (rgb) => rgb,
  protan: (rgb) => mul(VIENOT.protan, rgb).map(clamp01),
  deutan: (rgb) => mul(VIENOT.deutan, rgb).map(clamp01),
  tritan: (rgb) => {
    const side = rgb[0] * BRETTEL_TRITAN.n[0] + rgb[1] * BRETTEL_TRITAN.n[1] + rgb[2] * BRETTEL_TRITAN.n[2];
    return mul(side >= 0 ? BRETTEL_TRITAN.a : BRETTEL_TRITAN.b, rgb).map(clamp01);
  },
  // Monochrome: lightness only, what's left in the dark or for achromats.
  achroma: (rgb) => {
    const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return [y, y, y];
  },
};

function deltaE(rgb1, rgb2) {
  const a = linearToOklab(rgb1), b = linearToOklab(rgb2);
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function luminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(rgb1, rgb2) {
  const [hi, lo] = [luminance(rgb1), luminance(rgb2)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The "Lamps" block of tokens.css: --lamp-<name>: oklch(L C h); /* #hex */
function readPalette(css = fs.readFileSync(TOKENS, 'utf8')) {
  const out = {};
  const re = /--lamp-(red|amber|green|off):\s*oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*\);\s*\/\*\s*(#[0-9a-f]{6})\s*\*\//gi;
  let m;
  while ((m = re.exec(css))) {
    const L = Number(m[2]) > 1 ? Number(m[2]) / 100 : Number(m[2]);
    out[m[1]] = { oklch: [L, Number(m[3]), Number(m[4])], hex: m[5].toLowerCase(), rgb: oklchToLinear(L, Number(m[3]), Number(m[4])) };
  }
  return out;
}

function report(palette) {
  const lit = ['red', 'amber', 'green'];
  const pairs = [['red', 'amber'], ['red', 'green'], ['amber', 'green']];
  const deltas = {};
  for (const [sim, f] of Object.entries(SIMS)) {
    deltas[sim] = Object.fromEntries(pairs.map(([x, y]) => [`${x}/${y}`, deltaE(f(palette[x].rgb), f(palette[y].rgb))]));
  }
  const contrastVsOff = Object.fromEntries(lit.map((k) => [k, contrast(palette[k].rgb, palette.off.rgb)]));
  return { deltas, contrastVsOff };
}

module.exports = { readPalette, report, deltaE, contrast, oklchToLinear, linearToHex, hexToLinear, inGamut, SIMS };

if (require.main === module) {
  const palette = readPalette();
  const { deltas, contrastVsOff } = report(palette);
  for (const [k, v] of Object.entries(palette)) console.log(`${k.padEnd(6)} oklch(${v.oklch.join(' ')})  ${v.hex}  (computed ${linearToHex(v.rgb)})`);
  console.log('\nΔE (OKLab ×100) between lit lamps');
  console.log(`${'sim'.padEnd(8)}${Object.keys(deltas.normal).map((p) => p.padStart(14)).join('')}`);
  for (const [sim, row] of Object.entries(deltas)) console.log(`${sim.padEnd(8)}${Object.values(row).map((d) => d.toFixed(1).padStart(14)).join('')}`);
  console.log('\nContrast vs unlit lamp:', Object.entries(contrastVsOff).map(([k, c]) => `${k} ${c.toFixed(2)}:1`).join(', '));
}
