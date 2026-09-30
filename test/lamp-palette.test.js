// The lamp palette in tokens.css must stay colour-vision safe, and every
// place that needs it as hex must agree with it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../scripts/lamp-palette.js');

const ROOT = path.join(__dirname, '..');
const palette = P.readPalette();

test('lamp palette: tokens.css defines every lamp in OKLCH, in sRGB gamut, with its hex beside it', () => {
  assert.deepEqual(Object.keys(palette).sort(), ['amber', 'green', 'off', 'red']);
  for (const [name, v] of Object.entries(palette)) {
    assert.ok(P.inGamut(v.rgb), `${name} is outside sRGB`);
    assert.equal(P.linearToHex(v.rgb), v.hex, `${name}'s hex comment is stale`);
  }
});

test('lamp palette: lit lamps stay apart under simulated protan, deutan and tritan vision', () => {
  const { deltas } = P.report(palette);
  for (const sim of ['normal', 'protan', 'deutan', 'tritan']) {
    for (const [pair, d] of Object.entries(deltas[sim])) assert.ok(d >= 12, `${sim} ${pair}: ΔE ${d.toFixed(1)} < 12`);
  }
  // Lightness alone (monochrome, dim screens) still separates every pair.
  for (const [pair, d] of Object.entries(deltas.achroma)) assert.ok(d >= 7, `achroma ${pair}: ΔE ${d.toFixed(1)} < 7`);
});

test('lamp palette: every lit lamp clears 3:1 against the unlit lamp (WCAG 1.4.11)', () => {
  for (const [name, c] of Object.entries(P.report(palette).contrastVsOff)) assert.ok(c >= 3, `${name} ${c.toFixed(2)}:1`);
});

test('lamp palette: the Lights editor swatches use the same colours', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lights.html'), 'utf8');
  const m = /const LAMP_COLORS = (\{[^}]+\});/.exec(src);
  assert.ok(m, 'LAMP_COLORS in lights.html');
  const swatches = JSON.parse(m[1].replace(/'/g, '"').replace(/(\w+):/g, '"$1":'));
  for (const k of ['red', 'amber', 'green']) assert.equal(swatches[k], palette[k].hex, k);
});

test('lamp palette: every page that draws the rig loads the tokens before rig.css', () => {
  for (const page of ['index.html', 'lights.html', 'tray.html']) {
    const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const tokens = src.indexOf('href="tokens.css"');
    assert.ok(tokens >= 0 && tokens < src.indexOf('href="rig.css"'), page);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'rig.css'), 'utf8'), /--lamp-(red|amber|green|off):/, 'rig.css must not shadow the tokens');
});
