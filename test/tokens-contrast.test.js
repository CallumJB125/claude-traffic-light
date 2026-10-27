'use strict';
// Redesign R0a/R0b (plan-redesign §R2.2, §R3.9, §R3.12, §R3.13.11). Checks tokens.css as resolved in each theme:
// text and focus contrast, the Graphite accent and its states, the 14 % soft tint, bucket contrast, and inline
// links keep their underline. The contrast tests assert thresholds, not hexes, so a later palette (Callum still
// confirms hover, pressed and soft) passes or fails on contrast alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Custom properties declared directly in a block body (nested blocks skipped).
function declsOf(body) {
  const out = {};
  let depth = 0;
  let flat = '';
  for (const ch of body) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0) flat += ch;
  }
  for (const m of flat.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function blockAfter(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `tokens.css has ${head}`);
  const open = src.indexOf('{', at);
  let depth = 1;
  let i = open + 1;
  while (depth) { if (src[i] === '{') depth += 1; else if (src[i] === '}') depth -= 1; i += 1; }
  return src.slice(open + 1, i - 1);
}

const DARK = declsOf(blockAfter(CSS, ':root {'));
const LIGHT = { ...DARK, ...declsOf(blockAfter(blockAfter(CSS, '@media (prefers-color-scheme: light)'), ':root:not([data-theme="dark"])')) };
const THEMES = { dark: DARK, light: LIGHT };

function resolve(theme, name, seen = new Set()) {
  assert.ok(!seen.has(name), `var cycle at ${name}`);
  seen.add(name);
  const raw = theme[name];
  assert.ok(raw !== undefined, `${name} is defined`);
  return raw.replace(/var\((--[\w-]+)\)/g, (_, n) => resolve(theme, n, seen));
}

// '#rgb', '#rrggbb' or 'rgba(r, g, b, a)' → { r, g, b, a } with r/g/b 0–255.
function parse(value) {
  const v = value.trim();
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error(`not a colour: ${value}`);
}

const color = (theme, name) => parse(resolve(THEMES[theme], name));
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const SURFACES = ['--bg', '--panel', '--panel-2'];

test('tokens: body, secondary and faint text are at least 4.5:1 on every surface, in both themes', () => {
  for (const theme of Object.keys(THEMES)) {
    for (const fg of ['--text', '--muted', '--faint']) {
      for (const bg of SURFACES) {
        const r = ratio(color(theme, fg), color(theme, bg));
        assert.ok(r >= 4.5, `${theme} ${fg} on ${bg} is ${r.toFixed(2)}:1`);
      }
    }
  }
});

test('tokens: the accent reads as text on the window and panel, and its label reads on it', () => {
  for (const theme of Object.keys(THEMES)) {
    for (const bg of ['--bg', '--panel']) {
      const r = ratio(color(theme, '--accent'), color(theme, bg));
      assert.ok(r >= 4.5, `${theme} --accent on ${bg} is ${r.toFixed(2)}:1`);
    }
    const label = ratio(color(theme, '--accent-ink'), color(theme, '--accent'));
    assert.ok(label >= 4.5, `${theme} --accent-ink on --accent is ${label.toFixed(2)}:1`);
  }
});

test('tokens: the focus ring is at least 3:1 on every surface and against its halo', () => {
  for (const theme of Object.keys(THEMES)) {
    const ring = color(theme, '--focus-ring');
    for (const bg of SURFACES) {
      const r = ratio(ring, color(theme, bg));
      assert.ok(r >= 3, `${theme} --focus-ring on ${bg} is ${r.toFixed(2)}:1`);
    }
    const halo = ratio(ring, color(theme, '--focus-halo'));
    assert.ok(halo >= 3, `${theme} --focus-ring against --focus-halo is ${halo.toFixed(2)}:1`);
  }
});

test('tokens: Paused is styled as Idle', () => {
  for (const theme of Object.keys(THEMES)) {
    assert.equal(resolve(THEMES[theme], '--st-paused'), resolve(THEMES[theme], '--st-idle'), `${theme} Paused = Idle`);
  }
});

test('tokens: the accent is Graphite, every accent value comes from the one Graphite block, and the ring is the accent', () => {
  // R0b replaces R0a's "aliases equal today's values" gate. Rest and ink are decided (§R2.2); hover, pressed and
  // soft wait on Callum, so they are only required to come from the block, where they are changed in one place.
  const want = { dark: { '--accent': '#e6e8eb', '--accent-ink': '#17191d', '--focus-halo': '#17191d' },
    light: { '--accent': '#24292f', '--accent-ink': '#ffffff', '--focus-halo': '#ffffff' } };
  const LIGHT_BLOCK = declsOf(blockAfter(blockAfter(CSS, '@media (prefers-color-scheme: light)'), ':root:not([data-theme="dark"])'));
  const own = { dark: DARK, light: LIGHT_BLOCK };
  for (const theme of Object.keys(THEMES)) {
    for (const [name, value] of Object.entries(want[theme])) assert.equal(resolve(THEMES[theme], name), value, `${theme} ${name}`);
    for (const name of ['--accent', '--accent-ink', '--accent-soft', '--accent-hover', '--accent-pressed']) {
      assert.equal(own[theme][name], `var(--graphite-${theme}${name.slice('--accent'.length)})`, `${theme} ${name} points at the Graphite block`);
    }
    assert.equal(resolve(THEMES[theme], '--focus-ring'), resolve(THEMES[theme], '--accent'), `${theme} --focus-ring`);
  }
});

test('tokens: every type token is at least 12px', () => {
  for (const name of ['--t-caption', '--t-small', '--t-body', '--t-body-strong', '--t-title', '--t-display']) {
    const m = resolve(DARK, name).match(/(\d+)px\s*\//);
    assert.ok(m && Number(m[1]) >= 12, `${name} is ${resolve(DARK, name)}`);
  }
});

// §R3.13.11: an `a` selector may not remove the underline unless it is a nav, sidebar, tab or chip link, where
// position and shape identify it. The marketing site (site/) has its own stylesheet and isn't an app window.
const LINK_ALLOW = ['.nav-link', '.sidebar-row', '.tab', '.chip'];
const A_SELECTOR = /(^|[\s>+~(])a(?=$|[\s.:#[>+~)])/;

function stylesOf(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const css = file.endsWith('.html') ? [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n') : src;
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('tokens: inline links keep their underline outside nav, sidebar, tab and chip links', () => {
  const files = execFileSync('git', ['ls-files', '*.css', '*.html'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => f && !f.startsWith('site/') && !f.includes('node_modules/'));
  assert.ok(files.length > 20, 'found the app stylesheets');
  const bad = [];
  for (const file of files) {
    for (const m of stylesOf(file).matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
      if (!/text-decoration(?:-line)?\s*:\s*none\b/.test(m[2])) continue;
      for (const sel of m[1].split(',').map((s) => s.trim())) {
        if (A_SELECTOR.test(sel) && !LINK_ALLOW.some((c) => sel.includes(c))) bad.push(`${file}: ${sel}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'links that drop their underline');
});

test('tokens: the link check catches a bare link rule and spares an allowlisted one', () => {
  const caught = (sel, body) => /text-decoration(?:-line)?\s*:\s*none\b/.test(body) && A_SELECTOR.test(sel) && !LINK_ALLOW.some((c) => sel.includes(c));
  assert.equal(caught('.help a', 'text-decoration: none'), true);
  assert.equal(caught('a:hover', 'text-decoration-line: none'), true);
  assert.equal(caught('.sidebar-row a', 'text-decoration: none'), false);
  assert.equal(caught('.cta', 'text-decoration: none'), false);
});

// ── Accent states, soft tint and buckets (enabled by R0b) ───────────────────────────────────────────────────
// §R3.12: hover ≥ 1.30 and pressed ≥ 1.60 against rest, hover ≥ 1.20 against pressed, and the label ≥ 7.0 on
// every state, in both themes.
test('tokens: accent hover and pressed differ enough from rest and from each other', () => {
  for (const theme of Object.keys(THEMES)) {
    const rest = color(theme, '--accent');
    const hover = color(theme, '--accent-hover');
    const pressed = color(theme, '--accent-pressed');
    assert.ok(ratio(hover, rest) >= 1.3, `${theme} hover vs rest ${ratio(hover, rest).toFixed(2)}`);
    assert.ok(ratio(pressed, rest) >= 1.6, `${theme} pressed vs rest ${ratio(pressed, rest).toFixed(2)}`);
    assert.ok(ratio(hover, pressed) >= 1.2, `${theme} hover vs pressed ${ratio(hover, pressed).toFixed(2)}`);
    for (const state of [rest, hover, pressed]) {
      assert.ok(ratio(color(theme, '--accent-ink'), state) >= 7, `${theme} label on a state ${ratio(color(theme, '--accent-ink'), state).toFixed(2)}`);
    }
  }
});

test('tokens: the selected tint is the accent at 14 %', () => {
  for (const theme of Object.keys(THEMES)) {
    const soft = color(theme, '--accent-soft');
    const accent = color(theme, '--accent');
    assert.equal(soft.a, 0.14, `${theme} --accent-soft alpha`);
    assert.deepEqual([soft.r, soft.g, soft.b], [accent.r, accent.g, accent.b], `${theme} --accent-soft is the accent`);
    // Selected must still read against the sidebar it sits on (§R2.2: the bar and weight carry the rest).
    assert.ok(ratio(over(soft, color(theme, '--panel-2')), color(theme, '--panel-2')) >= 1.25, `${theme} selected vs sidebar`);
  }
});

// R0b lifted dark `--idle` from #726c62 (2.66:1 on `--panel-2`) to #7c766b, same warm grey.
test('tokens: status buckets are at least 3:1 on every surface', () => {
  for (const theme of Object.keys(THEMES)) {
    for (const st of ['--st-needs', '--st-working', '--st-check', '--st-stuck', '--st-idle']) {
      for (const bg of SURFACES) {
        const r = ratio(color(theme, st), color(theme, bg));
        assert.ok(r >= 3, `${theme} ${st} on ${bg} is ${r.toFixed(2)}:1`);
      }
    }
  }
});
