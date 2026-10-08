'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createThemeInjector, CSS_FILE } = require('../buddy-window/burst-theme.js');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(CSS_FILE, 'utf8');
const BURST_HTML = '/Users/callumbaker/Development/other-projects/claude-burst/internal/admin/admin.html';

const rootVars = (text) => {
  const s = new Set();
  for (const m of text.matchAll(/:root(?::root)?\s*\{([^}]*)\}/g)) for (const v of m[1].matchAll(/(--[a-z0-9-]+)\s*:/g)) s.add(v[1]);
  return s;
};
const blockOf = (text, media) => {
  const src = media ? text.slice(text.indexOf('@media (prefers-color-scheme: light)')) : text.slice(0, text.indexOf('@media'));
  const out = {};
  const m = /:root:root\s*\{([^}]*)\}/.exec(src);
  for (const v of m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[v[1]] = v[2].trim();
  return out;
};

// Burst's categorical chart colours are validated as a set in both modes; they stay as Burst drew them.
const KEPT = new Set(['--s-primary', '--s-secondary', '--s-saved']);

test('token map covers every custom property Burst declares on :root (repo list if present, else the bundled fixture)', () => {
  const live = fs.existsSync(BURST_HTML) ? rootVars(fs.readFileSync(BURST_HTML, 'utf8')) : null;
  const fixture = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'burst-css-vars.json'), 'utf8')));
  const burst = live || fixture;
  assert.ok(burst.size > 15);
  const dark = blockOf(CSS, false);
  const missing = [...burst].filter((v) => !(v in dark) && !KEPT.has(v));
  assert.deepEqual(missing, [], `Burst variables with no Plexiform value: ${missing.join(' ')}`);
  for (const k of KEPT) assert.ok(burst.has(k), `${k} is no longer a Burst variable; drop it from KEPT`);
  // the light block overrides only what the dark block defines
  const light = Object.keys(blockOf(CSS, true));
  assert.deepEqual(light.filter((v) => !(v in dark) && v !== 'color-scheme'), []);
  for (const v of ['--bg', '--panel', '--text', '--accent', '--border', '--ok', '--warn', '--bad']) assert.ok(light.includes(v), `light ${v}`);
});

test('Plexiform values mirror tokens.css (dark) and shell.css (light)', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'tokens.css'), 'utf8');
  const shell = fs.readFileSync(path.join(ROOT, 'buddy-window', 'shell.css'), 'utf8');
  const val = (text, name) => new RegExp(`${name}:\\s*([^;]+);`).exec(text)[1].trim();
  const dark = blockOf(CSS, false);
  const light = blockOf(CSS, true);
  const pairs = { '--bg': '--bg', '--panel': '--panel', '--panel-2': '--panel-2', '--border': '--line', '--text': '--text', '--muted': '--muted', '--faint': '--faint', '--accent': '--accent' };
  for (const [b, p] of Object.entries(pairs)) {
    assert.equal(dark[b], val(tokens, p), `dark ${b}`);
    assert.equal(light[b], val(shell, p), `light ${b}`);
  }
  assert.equal(dark['--radius'], val(tokens, '--radius'));
});

test('the stylesheet hides Burst\'s own header and menu, is one file, and carries no network reference', () => {
  assert.match(CSS, /aside\.side[^{]*\{[^}]*display:\s*none/);
  assert.match(CSS, /\.wrap > header/);
  assert.doesNotMatch(CSS, /url\(|@import|https?:\/\//);
  assert.ok(fs.readdirSync(path.join(ROOT, 'buddy-window')).filter((f) => f.endsWith('.css') && /burst/.test(f)).length === 1);
});

function fakeWc({ failInsert = false } = {}) {
  const wc = new EventEmitter();
  wc.destroyed = false;
  wc.inserted = [];
  wc.removed = [];
  wc.n = 0;
  wc.isDestroyed = () => wc.destroyed;
  wc.insertCSS = async (css) => { if (failInsert) throw new Error('nope'); wc.inserted.push(css); return `k${++wc.n}`; };
  wc.removeInsertedCSS = async (k) => { wc.removed.push(k); };
  return wc;
}
const settle = () => new Promise((r) => setImmediate(r));

test('injector: applied on dom-ready, did-navigate and did-navigate-in-page; the previous key is removed after the new sheet is in', async () => {
  const wc = fakeWc();
  const h = createThemeInjector({ css: () => 'x{}' }).attach(wc);
  wc.emit('dom-ready'); await settle();
  assert.deepEqual(wc.inserted, ['x{}']);
  assert.deepEqual(wc.removed, []);
  assert.equal(h.key(), 'k1');
  wc.emit('did-navigate'); await settle();
  assert.deepEqual(wc.removed, ['k1']);
  assert.equal(h.key(), 'k2');
  wc.emit('did-navigate-in-page'); await settle();
  assert.deepEqual(wc.removed, ['k1', 'k2']);
  assert.equal(h.key(), 'k3');
});

test('injector: bursts of events apply in order without piling up sheets', async () => {
  const wc = fakeWc();
  const h = createThemeInjector({ css: () => 'x{}' }).attach(wc);
  wc.emit('dom-ready'); wc.emit('did-navigate'); wc.emit('did-navigate-in-page');
  await settle(); await settle(); await settle();
  assert.equal(wc.inserted.length, 3);
  assert.deepEqual(wc.removed, ['k1', 'k2']);
  assert.equal(h.key(), 'k3');
});

test('injector is tolerant: a failing insert, a missing stylesheet or a destroyed view never throws', async () => {
  const bad = fakeWc({ failInsert: true });
  const h = createThemeInjector({ css: () => 'x{}' }).attach(bad);
  bad.emit('dom-ready'); await settle();
  assert.equal(h.key(), null);
  const noFile = fakeWc();
  createThemeInjector({ css: () => { throw new Error('ENOENT'); } }).attach(noFile);
  noFile.emit('dom-ready'); await settle();
  assert.deepEqual(noFile.inserted, []);
  const gone = fakeWc();
  createThemeInjector({ css: () => 'x{}' }).attach(gone);
  gone.destroyed = true;
  gone.emit('dom-ready'); await settle();
  assert.deepEqual(gone.inserted, []);
});

test('the real stylesheet is what is injected by default', async () => {
  const wc = fakeWc();
  createThemeInjector().attach(wc);
  wc.emit('dom-ready'); await settle();
  assert.equal(wc.inserted[0], CSS);
});
