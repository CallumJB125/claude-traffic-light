// Board themes and backgrounds: the option lists, the menu, and WCAG AA for
// the text that sits on each canvas and on the card surface, in both modes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { byAttr, findAll, textOf } from '../js/h.js';
import { BACKGROUNDS, THEMES, normalizeBg, normalizeTheme } from '../js/themes.js';
import { themeMenu, topBar } from '../js/render-board.js';
import { model } from './fixtures.js';

const css = await readFile(new URL('../app.css', import.meta.url), 'utf8');

// ── WCAG 2.x contrast ──
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('contrast helper matches known WCAG values', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.ok(Math.abs(contrast('#777777', '#ffffff') - 4.48) < 0.05);
  assert.equal(contrast('#123456', '#123456'), 1);
});

// Token values out of app.css: the dark set is the first :root block, light the [data-theme="light"] block.
const block = (start) => { const i = css.indexOf(start); return css.slice(i, css.indexOf('\n}', i)); };
const token = (b, name) => b.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))[1];
const dark = block(':root {');
const light = block(':root[data-theme="light"] {');
const TOKENS = { dark: (n) => token(dark, n), light: (n) => token(light, n) };
const TEXTS = ['--text', '--muted', '--faint'];

test('card text (text, muted, faint) meets AA 4.5:1 on the card panels in both modes', () => {
  for (const mode of ['dark', 'light']) {
    for (const surface of ['--panel', '--panel-2', '--bg']) {
      for (const t of TEXTS) {
        const r = contrast(TOKENS[mode](t), TOKENS[mode](surface));
        assert.ok(r >= 4.5, `${mode} ${t} on ${surface}: ${r.toFixed(2)}`);
      }
    }
  }
});

const bgBlocks = [...css.matchAll(/:root\[data-board-bg="(\w+)"\][^{]*\{([^}]*)\}/g)].map((m) => ({ id: m[1], body: m[2] }));

test('every background option has CSS, and only gradients/patterns: no url(), no images, no requests', () => {
  assert.deepEqual(bgBlocks.map((b) => b.id).sort(), BACKGROUNDS.filter((b) => b.id !== 'none').map((b) => b.id).sort());
  assert.equal(BACKGROUNDS.length - 1, 6, 'six backgrounds plus plain');
  for (const b of bgBlocks) assert.doesNotMatch(b.body, /url\(|image-set|@import|http/i, b.id);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i);
});

test('column titles keep AA on every canvas colour, dark and light', () => {
  assert.ok(bgBlocks.length === 6);
  for (const { id, body } of bgBlocks) {
    for (const name of ['--canvas-a', '--canvas-b']) {
      const m = body.match(new RegExp(`${name}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`));
      assert.ok(m, `${id} ${name} is light-dark(#light, #dark)`);
      for (const [mode, hex] of [['light', m[1]], ['dark', m[2]]]) {
        for (const t of TEXTS) {
          const r = contrast(TOKENS[mode](t), hex);
          assert.ok(r >= 4.5, `${id} ${mode} ${name} ${hex} vs ${t}: ${r.toFixed(2)}`);
        }
      }
    }
    // Pattern ink must stay a quiet texture, not compete with text: under 1.6:1 against its canvas.
    for (const name of ['--canvas-line', '--canvas-dot']) {
      const m = body.match(new RegExp(`${name}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`));
      if (!m) continue;
      const a = body.match(/--canvas-a:\s*light-dark\((#[0-9a-fA-F]{6}),\s*(#[0-9a-fA-F]{6})\)/);
      assert.ok(contrast(m[1], a[1]) < 1.6 && contrast(m[2], a[2]) < 1.6, `${id} ${name} is subtle`);
    }
  }
});

test('reduced transparency drops the scrim and pattern for opaque colours', () => {
  const i = css.indexOf('@media (prefers-reduced-transparency: reduce)');
  assert.ok(i > 0);
  const body = css.slice(i, css.indexOf('\n}\n', i));
  assert.match(body, /background: var\(--canvas-a\)/);
  assert.match(body, /\.column \{ background: var\(--bg\)/);
});

test('normalize: unknown values fall back, known ones pass', () => {
  assert.equal(normalizeBg('dusk'), 'dusk');
  assert.equal(normalizeBg('<script>'), 'none');
  assert.equal(normalizeBg(null), 'none');
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('sepia'), 'system');
  assert.deepEqual(THEMES.map((t) => t.id), ['system', 'dark', 'light']);
});

test('menu: closed shows only the trigger; open lists 3 schemes and 7 backgrounds with the current ones checked', () => {
  const closed = themeMenu(model([]));
  assert.equal(findAll(closed, (n) => n.props.role === 'menu').length, 0);
  assert.equal(byAttr(closed, 'data-action', 'theme-menu')[0].props['aria-expanded'], 'false');
  const open = themeMenu(model([], { themeMenu: true, theme: 'dark', bg: 'tide' }));
  assert.equal(byAttr(open, 'data-action', 'theme-menu')[0].props['aria-expanded'], 'true');
  const themes = byAttr(open, 'data-action', 'theme');
  assert.deepEqual(themes.map((t) => [t.props['data-next'], t.props['aria-checked']]), [['system', 'false'], ['dark', 'true'], ['light', 'false']]);
  const bgs = byAttr(open, 'data-action', 'board-bg');
  assert.equal(bgs.length, 7);
  assert.deepEqual(bgs.filter((b) => b.props['aria-checked'] === 'true').map((b) => b.props['data-bg']), ['tide']);
  assert.ok(bgs.every((b) => b.props.role === 'menuitemradio'));
  assert.match(textOf(open), /Board background/);
});

test('the top bar carries the appearance menu instead of the cycle button', () => {
  const bar = topBar(model([]), { red: false, amber: false, green: false });
  assert.equal(byAttr(bar, 'data-action', 'theme-menu').length, 1);
  assert.equal(findAll(bar, (n) => n.props['data-action'] === 'theme').length, 0, 'theme choices only appear inside the open menu');
});
