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

// The old terracotta literals became accent washes at their original alpha. `color-mix(in srgb, var(--accent) N%,
// transparent)` is the accent at alpha N %. The percentages are read from the files, so a change there is re-checked.
const washPct = (file, re) => {
  const m = fs.readFileSync(path.join(ROOT, file), 'utf8').match(re);
  assert.ok(m, `${file}: wash rule not found`);
  return Number(m[1]) / 100;
};
const wash = (theme, a) => ({ ...color(theme, '--accent'), a });

test('tokens: accent text on the counting pill wash is at least 4.5:1 on every surface, in both themes', () => {
  const a = washPct('input-bubble.css', /\.ib-scope\.tone-count \{ background: color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\)/);
  for (const theme of Object.keys(THEMES)) {
    // The widget's bubble card (.ib-item, rgba(20, 20, 22, 0.94)) exists only in dark: index.html pins
    // data-theme="dark". The Waiting page swaps the card for --panel (.ib-page .ib-item), so it sits on token surfaces.
    const surfaces = ['--bg', '--panel', '--panel-2'].map((s) => [s, color(theme, s)]);
    if (theme === 'dark') surfaces.unshift(['bubble card', over({ r: 20, g: 20, b: 22, a: 0.94 }, color(theme, '--bg'))]);
    for (const [name, surface] of surfaces) {
      const r = ratio(color(theme, '--accent'), over(wash(theme, a), surface));
      assert.ok(r >= 4.5, `${theme} pill text on its wash over ${name} is ${r.toFixed(2)}:1`);
    }
  }
});

test('tokens: text on the Lights selection wash, and the primary label on hover, are at least 4.5:1 in both themes', () => {
  const a = washPct('lights.html', /::selection \{ background: color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\)/);
  for (const theme of Object.keys(THEMES)) {
    for (const bg of ['--bg', '--panel']) {
      const surface = color(theme, bg);
      for (const fg of ['--text', '--muted']) {
        const r = ratio(color(theme, fg), over(wash(theme, a), surface));
        assert.ok(r >= 4.5, `${theme} selected ${fg} over ${bg} is ${r.toFixed(2)}:1`);
      }
      // --faint misses 4.5 on any accent wash above ~6 %. It is held to "no worse than the terracotta selection it
      // replaced" (rgba(218, 119, 86, 0.35) at base: 3.57-3.93:1); at 12 % it is 4.14-5.05:1.
      const faint = ratio(color(theme, '--faint'), over(wash(theme, a), surface));
      const old = ratio(color(theme, '--faint'), over({ r: 218, g: 119, b: 86, a: 0.35 }, surface));
      assert.ok(faint >= old, `${theme} selected --faint over ${bg} is ${faint.toFixed(2)}:1, below terracotta's ${old.toFixed(2)}:1`);
    }
    const hover = ratio(color(theme, '--accent-ink'), color(theme, '--accent-hover'));
    assert.ok(hover >= 4.5, `${theme} --accent-ink on --accent-hover is ${hover.toFixed(2)}:1`);
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

// ── The last terracotta literals (follow-up to R0b) ──────────────────────────────────────────────────────────
// The Lights stage wash is the accent at a percentage read from lights.html; the stage text must stay ≥ 4.5:1 at
// its peak. Graphite at 8 % on light --bg gives --faint 4.47:1, so it is 6 %.
test('tokens: the Lights stage wash keeps the stage text at least 4.5:1 at its peak', () => {
  const a = washPct('lights.html', /#stage \{[^}]*radial-gradient\([^)]*?color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\)/s);
  for (const theme of Object.keys(THEMES)) {
    const peak = over(wash(theme, a), color(theme, '--bg'));
    for (const fg of ['--text', '--muted', '--faint']) {
      const r = ratio(color(theme, fg), peak);
      assert.ok(r >= 4.5, `${theme} ${fg} on the stage wash at ${a * 100}% is ${r.toFixed(2)}:1`);
    }
  }
});

// The commands an imported file will run are shown in caution colour (--danger-text), not the accent. They sit on
// --panel-2 (#setup-summary) and on --accent-soft over --panel (#rules-summary, inside #rules-choice).
test('tokens: the "clicks run" command text is --danger-text and reads on the surfaces it sits on', () => {
  const html = fs.readFileSync(path.join(ROOT, 'lights.html'), 'utf8');
  assert.match(html, /#setup-summary code, #rules-summary code \{[^}]*color: var\(--danger-text\)/);
  assert.ok(!/ffb4a8/i.test(html), 'lights.html no longer has #ffb4a8');
  for (const theme of Object.keys(THEMES)) {
    const fg = color(theme, '--danger-text');
    const surfaces = { '--bg': color(theme, '--bg'), '--panel': color(theme, '--panel'), '--panel-2': color(theme, '--panel-2'),
      'accent-soft over --panel': over(color(theme, '--accent-soft'), color(theme, '--panel')) };
    for (const [name, bg] of Object.entries(surfaces)) {
      const r = ratio(fg, bg);
      assert.ok(r >= 4.5, `${theme} --danger-text on ${name} is ${r.toFixed(2)}:1`);
    }
  }
});

// The exported replay page is standalone (no tokens.css): its accent is the Graphite value of each scheme.
test('tokens: the exported replay page uses the Graphite accent and it reads on the page', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/session-replay.js'), 'utf8');
  const css = src.match(/const CSS = `([\s\S]*?)`;/)[1];
  const light = css.match(/^:root\{([^}]*)\}/)[1];
  const dark = css.match(/@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}/)[1];
  const read = (block, name) => block.match(new RegExp(`${name}:(#[0-9a-f]{3,6})`, 'i'))[1];
  assert.ok(!/b4532e|da7756/i.test(css), 'no terracotta in the replay page');
  for (const [theme, own] of [['light', light], ['dark', dark]]) {
    assert.equal(read(own, '--accent').toLowerCase(), resolve(THEMES[theme], `--graphite-${theme}`), `${theme} replay --accent is Graphite`);
    for (const bg of ['--bg', '--panel']) {
      const r = ratio(parse(read(own, '--accent')), parse(read(own, bg)));
      assert.ok(r >= 4.5, `${theme} replay --accent on ${bg} is ${r.toFixed(2)}:1`);
    }
  }
});

test('tokens: the Lights window and the replay export have no terracotta literals left', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const f of ['lights.html', 'lights-view.js']) assert.ok(!/218,\s*119,\s*86|b4532e|ffb4a8/i.test(read(f)), `${f} has a terracotta literal`);
  // lights-view.js keeps '#da7756' as the mascot body-colour default (character art stays by plan).
  assert.ok(!/da7756/i.test(read('lights.html')), 'lights.html has #da7756');
  assert.ok(!/b4532e|da7756|218,\s*119,\s*86/i.test(read('src/session-replay.js')), 'session-replay.js has terracotta');
});
