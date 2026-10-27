'use strict';
// Redesign R0a: the snapshot classifier's rules (plan-redesign §R3.10, §R4.4), checked on synthetic pixels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../test-visual/classify-lib');

const TOKENS = fs.readFileSync(path.join(__dirname, '..', 'tokens.css'), 'utf8');
// Today's tokens flipped to Graphite (§R2.2, §R3.12): the same flip R0b makes.
const GRAPHITE = TOKENS
  .replace('--accent: #e49a78;', '--accent: #e6e8eb;').replace('--accent-ink: #251c18;', '--accent-ink: #17191d;')
  .replace('--accent-soft: rgba(228, 154, 120, 0.14);', '--accent-soft: rgba(230, 232, 235, 0.14);')
  .replace('--accent-hover: var(--accent);', '--accent-hover: #c4c9cf;').replace('--accent-pressed: var(--accent);', '--accent-pressed: #a8afb7;')
  .replace('--accent: #a34425;', '--accent: #24292f;\n    --accent-hover: #3a4048;\n    --accent-pressed: #4b525b;\n    --focus-halo: #ffffff;')
  .replace('--accent-soft: rgba(163, 68, 37, 0.08);', '--accent-soft: rgba(36, 41, 47, 0.14);');
const FAM = lib.familiesOf(TOKENS, GRAPHITE);

const hex = (h) => lib.parseColour(h).slice(0, 3);
const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));
const PANEL_D = hex('#202329');
const PANEL_L = hex('#ffffff');

test('classifier: ΔE00 matches the Sharma reference pairs', () => {
  // Sharma, Wu & Dalal (2005), table 1, pairs 1 and 17.
  assert.ok(Math.abs(lib.deltaE00([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425) < 1e-3);
  assert.ok(Math.abs(lib.deltaE00([50, 2.5, 0], [73, 25, -18]) - 27.1492) < 1e-3);
});

test('classifier: the families are read from tokens.css at the base and the head', () => {
  const rest = FAM.members.filter((m) => m.key === 'rest').map((m) => [m.old.join(), m.new.join()]);
  assert.deepEqual(rest.sort(), [[hex('#a34425').join(), hex('#24292f').join()], [hex('#e49a78').join(), hex('#e6e8eb').join()]].sort());
  assert.ok(FAM.members.some((m) => m.key === 'soft/--panel-2'));
  assert.ok(FAM.members.some((m) => m.key === 'ink~rest' && m.pairOld));
});

test('classifier: solid and anti-aliased accent pixels pass, at matching blend positions', () => {
  assert.equal(lib.classifyPixel(hex('#e49a78'), hex('#e6e8eb'), [PANEL_D], FAM.members), 'pass');
  const t = 0.6;
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, t), mix(hex('#e6e8eb'), PANEL_D, t + 0.2), [PANEL_D], FAM.members), 'pass');
  assert.equal(lib.classifyPixel(mix(hex('#a34425'), PANEL_L, 0.5), mix(hex('#24292f'), PANEL_L, 0.5), [PANEL_L], FAM.members), 'pass');
});

test('classifier: a label anti-aliased over a filled button passes as a member pair', () => {
  const old = mix(hex('#ffffff'), hex('#a34425'), 0.5);
  const head = mix(hex('#ffffff'), hex('#24292f'), 0.5);
  assert.equal(lib.classifyPixel(old, head, [hex('#a34425')], FAM.members), 'pass');
});

test('classifier: blend positions that disagree by more than 0.35 are unexpected', () => {
  const old = mix(hex('#e49a78'), PANEL_D, 0.9);
  const head = mix(hex('#e6e8eb'), PANEL_D, 0.3);
  assert.equal(lib.classifyPixel(old, head, [PANEL_D], FAM.members), 'unexpected');
});

test('classifier: a neutral pixel that changed is unexpected, even when the result is grey', () => {
  // Grey body text moving (layout change): the old colour sits on no accent segment.
  assert.equal(lib.classifyPixel(hex('#b0b7c2'), hex('#e6e8eb'), [PANEL_D], FAM.members), 'unexpected');
  assert.equal(lib.classifyPixel(hex('#f0f1f3'), hex('#9aa3b0'), [PANEL_D], FAM.members), 'unexpected');
});

test('classifier: the neutral must be the same on both sides', () => {
  // Old accent over the panel, head accent over a different (coloured) neutral: no single N fits. A grey
  // neutral can't be told apart here, since Graphite is itself grey; that's accepted and covered by rule 1.
  const old = mix(hex('#e49a78'), PANEL_D, 0.5);
  const head = mix(hex('#e6e8eb'), hex('#e4b566'), 0.5);
  assert.equal(lib.classifyPixel(old, head, [PANEL_D], FAM.members), 'unexpected');
});

test('classifier: near-neutral blends are counted as unchanged or skipped, not passed', () => {
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, 0.02), mix(hex('#e6e8eb'), PANEL_D, 0.03), [PANEL_D], FAM.members), 'unchanged');
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, 0.02), mix(hex('#e6e8eb'), PANEL_D, 0.25), [PANEL_D], FAM.members), 'skipped');
});

test('classifier: the soft tint is checked against its per-surface value', () => {
  const surface = hex('#292d34');
  const old = lib.parseColour('rgba(228, 154, 120, 0.14)');
  const neu = lib.parseColour('rgba(230, 232, 235, 0.14)');
  const o = old.slice(0, 3).map((v, i) => Math.round(v * 0.14 + surface[i] * 0.86));
  const n = neu.slice(0, 3).map((v, i) => Math.round(v * 0.14 + surface[i] * 0.86));
  assert.equal(lib.classifyPixel(o, n, [surface], FAM.members), 'pass');
});

function image(w, h, fill) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { const c = fill(i % w, Math.floor(i / w)); data.set([...c, 255], i * 4); }
  return { width: w, height: h, data };
}

test('classifier: an image flip finds the local neutral and buckets unexpected pixels into tiles', () => {
  const oldImg = image(48, 48, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? hex('#e49a78') : x >= 30 && y >= 30 && x < 34 && y < 34 ? hex('#b0b7c2') : PANEL_D));
  const newImg = image(48, 48, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? hex('#e6e8eb') : x >= 30 && y >= 30 && x < 34 && y < 34 ? hex('#f0f1f3') : PANEL_D));
  const r = lib.classifyImage(oldImg, newImg, FAM);
  assert.equal(r.changed, 116);
  assert.equal(r.pass, 100);
  assert.equal(r.unexpected, 16);
  assert.deepEqual(r.tiles.map((t) => [t.x, t.y, t.count]), [[24, 24, 16]]);
});

test('classifier: named exceptions apply only to their baseline', () => {
  const config = { exceptions: [{ name: 'paused', baselines: ['a.png'], old: ['#e4b566'], new: ['#9aa3b0'] }] };
  assert.equal(lib.exceptionsFor('a.png', config).length, 1);
  assert.equal(lib.exceptionsFor('b.png', config).length, 0);
  const oldImg = image(4, 4, () => hex('#e4b566'));
  const newImg = image(4, 4, () => hex('#9aa3b0'));
  assert.equal(lib.classifyImage(oldImg, newImg, FAM, { exceptions: lib.exceptionsFor('a.png', config) }).exception, 16);
  assert.equal(lib.classifyImage(oldImg, newImg, FAM, { exceptions: lib.exceptionsFor('b.png', config) }).unexpected, 16);
});

test('classifier: the gate fails on characters, on more than 0.5 % unexpected and on more than 200 crops', () => {
  const row = (baseline, unexpected, tiles = 0, changed = unexpected) => ({ baseline, total: 10000, changed, unexpected, sizeChanged: false, tiles: Array(tiles).fill({}) });
  assert.deepEqual(lib.verdictOf([row('x/usage.spec.js/a.png', 50, 3)]).failures, []);
  assert.equal(lib.verdictOf([row('x/usage.spec.js/a.png', 51, 3)]).failures.length, 1);
  assert.equal(lib.verdictOf([row('test-visual/__screenshots__/characters.spec.js/a.png', 0, 0, 1)]).failures.length, 1);
  assert.equal(lib.verdictOf([row('x/a.png', 0, 120), row('x/b.png', 0, 81)]).failures.length, 1);
});
