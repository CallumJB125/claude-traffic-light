'use strict';
// Redesign R0b structural gate (plan-redesign §R4.4; labfix-review's steelman). The PRIMARY check for an accent
// flip: R0b changes only colour declarations, and a diff can state that directly. The pixel classifier
// (test-visual/classify.spec.js) is the second layer.
//
// Active when the branch's test-visual/expected/<branch>.txt starts with `# classify`, OR when the diff adds or
// changes any test-visual/expected/*.txt that does (so a renamed branch or a fork PR can't skip it). Same
// wantsClassify as the classifier. The branch is GITHUB_HEAD_REF in a PR job, else the checked-out branch. Against
// the merge-base with origin/<GITHUB_BASE_REF or main>, including uncommitted and untracked files:
//   1. outside test-visual/, only ALLOWED files may change; inside it, only the four classify files, the
//      activating expected file(s) and baseline PNGs;
//   2. in the token stylesheets, with comments stripped on both sides, every changed line must be one
//      declaration of a custom property or a colour property (not the `background` shorthand) whose value is a
//      colour: #hex, rgb()/rgba(), transparent, color-mix() of colours, or var(--x) that resolves, through the
//      HEAD declarations of the four stylesheets, to colours only. A custom property that existed at base must
//      also have resolved to colours there, so a size token can't become a colour slot or the reverse.
//      Anything unresolvable fails.
// Scope note: app.css and phone.css are whole app stylesheets, so "colour tokens only" means "colour declarations
// only" there. A non-accent component colour change is structurally allowed and left to the pixel classifier.
//   3. the terracotta-literal fix (UI accent literals → the accent, at their original alpha) also touches
//      LITERAL_FIX. In those files, and in app.css/phone.css, a changed line may also be a whole rule or a value
//      list, provided it differs from the line it replaces ONLY in colour tokens: replace every colour (#hex,
//      rgb(), transparent, color-mix() of colours, var() resolving to colours, var(--colour, colour)) by a
//      placeholder and the two lines must be identical. Dropping a page-local override of a custom property that
//      the token stylesheets declare as a colour is also allowed (the page falls back to the token). In .html
//      files only <style> content is compared; everything outside <style> must be byte-identical.
//      tokens.css and burst-theme.css keep the strict one-declaration-per-line rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { wantsClassify, expectedFileFor } = require('../test-visual/classify-lib');

const ROOT = path.join(__dirname, '..');
const TOKEN_CSS = ['tokens.css', 'buddy-window/burst-theme.css', 'board/web/app.css', 'board/web/phone.css'];
// Files the terracotta-literal fix touches, beyond the token stylesheets (inventory in the PR body).
const LITERAL_FIX = ['input-bubble.css', 'lights.html', 'optimiser.html', 'widget-page.html', 'feedback.html'];
// Where a colour-only change inside a whole rule line is accepted (rule 3). The two token sheets stay strict.
const RULE_LINES = new Set(['board/web/app.css', 'board/web/phone.css', ...LITERAL_FIX]);
const ALLOWED = new Set([
  ...TOKEN_CSS, ...LITERAL_FIX,
  'test/tokens-contrast.test.js', 'test/burst-theme.test.js', 'test/classify-lib.test.js',
  'test/fixtures/tokens-terracotta-r0a.css', 'test/r0b-structural.test.js',
  'test-visual/classify-lib.js', 'test-visual/classify-controls.js', 'test-visual/classify.spec.js', 'test-visual/classify.config.json',
]);
const SHOT = /^test-visual\/__screenshots__\/.+\.png$/;
const COLOUR_PROPS = new Set(['color', 'background-color', 'border-color', 'border-top-color',
  'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'fill', 'stroke', 'caret-color',
  'accent-color', 'text-decoration-color', 'column-rule-color', 'stop-color', 'flood-color', 'lighting-color']);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Every custom-property declaration in the given stylesheets: name → [values] (one per declaration, any theme).
function tokenMap(texts) {
  const map = new Map();
  for (const t of texts) {
    for (const m of stripComments(t).matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
      if (!map.has(m[1])) map.set(m[1], []);
      map.get(m[1]).push(m[2].trim());
    }
  }
  return map;
}

// Top-level comma split (respects parentheses).
function args(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// True when `value` is a colour, with every var() resolved through `map` (all its declarations must be colours).
function isColour(value, map, seen = new Set()) {
  const v = value.trim().replace(/\s*!important$/, '');
  if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return true;
  if (/^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+%?\s*)?\)$/.test(v)) return true;
  if (v === 'transparent') return true;
  const ref = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (ref) {
    const name = ref[1];
    const defs = map.get(name);
    if (!defs || !defs.length || seen.has(name)) return false;
    const next = new Set(seen).add(name);
    return defs.every((d) => isColour(d, map, next));
  }
  const mix = v.match(/^color-mix\((.*)\)$/s);
  if (mix) {
    const [space, ...parts] = args(mix[1]);
    if (!/^in\s+[\w-]+$/.test(space) || parts.length !== 2) return false;
    return parts.every((p) => {
      const m = p.match(/^(.*?)(?:\s+[\d.]+%)?$/s);
      return m && isColour(m[1], map, seen);
    });
  }
  return false;
}

// N3 (review round 3): a custom property that is NEW at head may only be read as a colour. Every var(--name …)
// use (fallback forms included) in the given files must sit in a declaration of a colour property, or of a
// custom property whose head value is a colour. Otherwise defining it would hijack an existing
// `margin: var(--gutter, 16px)` and reset that declaration at computed time. Returns the offending uses.
function badNewTokenUses(names, files, headMap) {
  const bad = [];
  for (const [file, raw] of files) {
    const text = /\.(css|html|svg)$/.test(file) ? stripComments(raw) : raw;
    for (const name of names) {
      const re = new RegExp(String.raw`var\(\s*${name.replace(/[-]/g, '\\-')}(?![\w-])`, 'g');
      for (const m of text.matchAll(re)) {
        // the declaration this use sits in: back to the nearest ; { } or newline-free start, then `prop:`
        const before = text.slice(Math.max(0, m.index - 400), m.index);
        const start = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}'));
        const decl = before.slice(start + 1).match(/(--[\w-]+|[a-z-]+)\s*:[^:]*$/);
        const prop = decl && decl[1];
        const ok = prop && (COLOUR_PROPS.has(prop) || (prop.startsWith('--') && headMap.has(prop) && isColour(`var(${prop})`, headMap)));
        if (!ok) bad.push(`${file}: ${prop || '(no declaration)'} reads ${headMap.has(name) ? 'new' : 'removed'} ${name}`);
      }
    }
  }
  return bad;
}

// End index (exclusive) of the parenthesised call starting at s[i] === '('; strings inside are skipped.
function closeParen(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k += 1) {
    if (s[k] === '"' || s[k] === "'") { k = closeString(s, k) - 1; continue; }
    if (s[k] === '(') depth += 1;
    else if (s[k] === ')') { depth -= 1; if (depth === 0) return k + 1; }
  }
  return -1;
}
// End index (exclusive) of the string literal starting at s[i] (a quote). A CSS string cannot hold a raw
// newline, so an unclosed quote ends at the line end instead of swallowing the rest of the file.
function closeString(s, i) {
  for (let k = i + 1; k < s.length; k += 1) {
    if (s[k] === '\\') k += 1;
    else if (s[k] === s[i]) return k + 1;
    else if (s[k] === '\n') return k;
  }
  return s.length;
}

// Per character of a stylesheet: 1 inside a declaration value, 2 inside a string or url() (opaque: never a colour
// placeholder), 0 elsewhere (selectors, property names, at-rule preludes). Scanned over the whole file, so a
// continuation line knows whether it is a value (a gradient's next stop) or a selector (`#fade,` before `{`).
function valueMask(text) {
  const mask = new Uint8Array(text.length);
  let state = 'sel'; let depth = 0;
  // from a ':' in a block: a declaration if `;` or `}` comes before `{`, else a nested selector's pseudo-class
  const declColon = (i) => {
    for (let k = i + 1; k < text.length; k += 1) {
      const ch = text[k];
      if (ch === '"' || ch === "'") { k = closeString(text, k) - 1; continue; }
      if (ch === '(') { const e = closeParen(text, k); if (e < 0) return true; k = e - 1; continue; }
      if (ch === ';' || ch === '}') return true;
      if (ch === '{') return false;
    }
    return true;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || /^url\(/i.test(text.slice(i, i + 4))) {
      const end = ch === '"' || ch === "'" ? closeString(text, i) : closeParen(text, i + 3);
      const stop = end < 0 ? text.length : end;
      mask.fill(2, i, stop); i = stop - 1; continue;
    }
    if (state === 'val') {
      if (ch === ';') { state = 'decl'; continue; }
      if (ch === '}') { depth -= 1; state = depth > 0 ? 'decl' : 'sel'; continue; }
      mask[i] = 1;
      continue;
    }
    if (ch === '{') { depth += 1; state = 'decl'; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); state = depth > 0 ? 'decl' : 'sel'; continue; }
    if (state === 'decl' && ch === ':' && declColon(i)) state = 'val';
  }
  return mask;
}

// Each line of `text` with its slice of valueMask(text).
function maskedLines(text) {
  const mask = valueMask(text); const out = []; let at = 0;
  for (const line of text.split('\n')) { out.push({ line, mask: mask.subarray(at, at + line.length) }); at += line.length + 1; }
  return out;
}

// `line` with every colour token in a declaration value replaced by a placeholder. Tokens outside values
// (selectors), inside strings or url(), or not colours stay as written, so any non-colour edit shows up.
function colourSkeleton(line, map, mask) {
  let out = ''; let i = 0;
  const start = /color-mix\(|rgba?\(|var\(|#[0-9a-fA-F]{3,8}(?![\w-])|\btransparent\b/g;
  for (let m = start.exec(line); m; m = start.exec(line)) {
    const end = m[0].endsWith('(') ? closeParen(line, m.index + m[0].length - 1) : m.index + m[0].length;
    if (end < 0) break;
    const tok = line.slice(m.index, end);
    const inValue = mask[m.index] === 1;
    const fb = tok.match(/^var\(\s*(--[\w-]+)\s*,(.*)\)$/s);
    const colour = inValue && (isColour(tok, map) || Boolean(fb && isColour(`var(${fb[1]})`, map) && isColour(fb[2], map)));
    out += line.slice(i, m.index) + (colour ? '\u0000' : tok);
    i = end; start.lastIndex = end;
  }
  return (out + line.slice(i)).replace(/\s+/g, ' ').trim();
}

// Rule 3: `minus` → `plus` changes only colours in values, or drops overrides of token-sheet colour properties
// (a dropped declaration's value must have been a colour placeholder).
function colourOnlyPair(minus, plus, maps) {
  const head = colourSkeleton(plus.line, maps.head, plus.mask);
  const base = colourSkeleton(minus.line, maps.base, minus.mask);
  if (base === head) return true;
  const kept = new Set([...plus.line.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const dropped = base.replace(/(--[\w-]+)\s*:\s*\u0000\s*;\s*/g, (all, name) =>
    (!kept.has(name) && maps.head.has(name) && isColour(`var(${name})`, maps.head) ? '' : all));
  return dropped.replace(/\s+/g, ' ').trim() === head;
}

// <style> content of an HTML file, and the rest (which must not change).
// Splits an HTML file the way the parser does: <style> and <script> hold raw text up to their end tag (a "<!--"
// inside them is just text), markup comments only exist between those elements, and a start tag's attribute values
// are skipped as quoted strings. `styles`: each <style>'s content. `outside`: the file with every <style>'s content
// emptied and markup comments kept (so a changed comment still counts as changed markup).
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
    if (name === 'style' || name === 'script') {
      const close = html.slice(open).search(new RegExp(`</${name}\\b`, 'i'));
      const end = close < 0 ? html.length : open + close;
      if (name === 'style') styles.push(html.slice(open, end)); else outside += html.slice(open, end);
      i = end;
    }
  }
  return { styles, outside };
}
const styleOf = (html) => htmlParts(html).styles.join('\n');
const outsideStyle = (html) => htmlParts(html).outside;

// Changed lines (comments stripped, blank lines ignored) that are not a lone colour declaration.
// `maps` = { head, base }: token maps used to resolve var() (head) and to check a custom property's base value.
// `rules`: also accept a changed line that pairs with the line it replaces under rule 3.
function badCssLines(baseText, headText, maps = { head: tokenMap([headText]), base: tokenMap([baseText]) }, { rules = false } = {}) {
  const baseCss = stripComments(baseText); const headCss = stripComments(headText);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r0b-structural-'));
  const a = path.join(dir, 'base.css'); const b = path.join(dir, 'head.css');
  fs.writeFileSync(a, baseCss); fs.writeFileSync(b, headCss);
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U0', a, b], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index failed: ${r.stderr}`);
  const lines = { '-': maskedLines(baseCss), '+': maskedLines(headCss) };
  const lone = (line) => {
    const m = line.slice(1).match(/^\s*(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+?)\s*;?\s*$/);
    return Boolean(m && (m[1].startsWith('--') || COLOUR_PROPS.has(m[1]))
      // a removed line is judged against the base tokens, an added one against the head tokens
      && isColour(m[2], line[0] === '-' ? maps.base : maps.head)
      && (!m[1].startsWith('--') || !maps.base.has(m[1]) || isColour(`var(${m[1]})`, maps.base)));
  };
  const bad = [];
  // hunk by hunk, with each line's number from the header (so it gets its file context); with `rules`, the i-th
  // removed line pairs with the i-th added one when the counts match
  for (const m of r.stdout.matchAll(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\n]*\n((?:[-+\\][^\n]*\n?)*)/gm)) {
    const at = { '-': Number(m[1]) - 1, '+': Number(m[2]) - 1 };
    const side = { '-': [], '+': [] };
    for (const l of m[3].split('\n')) {
      if (l[0] !== '-' && l[0] !== '+') continue;
      side[l[0]].push({ text: l, ...lines[l[0]][at[l[0]]] });
      at[l[0]] += 1;
    }
    const minus = side['-'].filter((x) => x.text.slice(1).trim()); const plus = side['+'].filter((x) => x.text.slice(1).trim());
    const paired = rules && minus.length === plus.length;
    for (const [list, other] of [[minus, plus], [plus, minus]]) {
      list.forEach((x, k) => {
        if (lone(x.text)) return;
        if (paired && colourOnlyPair(list === minus ? x : other[k], list === minus ? other[k] : x, maps)) return;
        bad.push(x.text);
      });
    }
  }
  return bad;
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function branchName() {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  try { return git('rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { return ''; }
}

function mergeBase() {
  return git('merge-base', 'HEAD', `origin/${process.env.GITHUB_BASE_REF || 'main'}`).trim();
}

function changedFiles(base) {
  return new Set([
    ...git('diff', '--name-only', '--no-renames', base).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean));
}

// Tracked sources that can read a custom property: CSS, HTML and JS, not node_modules and not test/ (node unit
// tests render nothing; test-visual/ is kept, its CSS and mocks are in the shots).
function trackedSources() {
  return git('ls-files', '*.css', '*.html', '*.svg', '*.js', '*.mjs').split('\n')
    .filter((f) => f && !f.includes('node_modules/') && !f.startsWith('test/') && fs.existsSync(path.join(ROOT, f)))
    .map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
}

const readHead = (f) => { const p = path.join(ROOT, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };

// The expected files that switch the gate on: the branch's own, plus any changed one that asks for `# classify`.
function activating(changed) {
  const out = new Set();
  const branch = branchName();
  if (branch && branch !== 'HEAD') { const f = expectedFileFor(branch); if (wantsClassify(readHead(f))) out.add(f); }
  for (const f of changed || []) if (/^test-visual\/expected\/[^/]+\.txt$/.test(f) && wantsClassify(readHead(f))) out.add(f);
  return out;
}

let BASE = null; let CHANGED = null;
try { BASE = mergeBase(); CHANGED = changedFiles(BASE); } catch { /* no origin ref: the branch's own file decides */ }
const ACTIVE = activating(CHANGED);

test('structural checker: colour declarations pass; selectors, layout, sizes and non-colour vars do not', () => {
  const base = ':root {\n  --accent: #a34425; /* old */\n  --gap: 8px;\n  --radius-lg: 12px;\n  --space-4: 16px;\n  --x: var(--gap);\n}\n.btn { color: var(--accent); }\n';
  const ok = (head) => badCssLines(base, head);
  assert.deepEqual(ok(base.replace('#a34425', '#24292f').replace('/* old */', '/* new note */')), []);
  assert.deepEqual(ok(base.replace('  --gap: 8px;\n', '  --gap: 8px;\n  --graphite-light: #24292f;\n').replace('#a34425', 'var(--graphite-light)')), []);
  assert.deepEqual(ok(base.replace('  --gap: 8px;\n', '  --gap: 8px;\n  --graphite-light-soft: rgba(36, 41, 47, 0.14);\n')), []);
  assert.deepEqual(ok(base.replace('#a34425', 'color-mix(in oklab, #24292f 70%, #000)')), []);
  for (const [what, head] of [
    ['a size token', base.replace('8px', '6px')],
    ['a selector', base.replace('.btn {', '.btn, .chip {')],
    ['a rule on one line', base.replace('color: var(--accent)', 'color: #24292f')],
    ['a layout property', base.replace('  --gap: 8px;\n', '  --gap: 8px;\n  padding: 4px;\n')],
    ['a non-colour value in a custom property', base.replace('#a34425', '2px solid #24292f')],
    ['a non-colour property', base.replace('  --gap: 8px;\n', '  --gap: 8px;\n  opacity: 0.8;\n')],
    ['a var() with a fallback', base.replace('#a34425', 'var(--graphite-light, 4px)')],
    // N1 (review round 2): a var() must resolve to colours, through the head tokens
    ['--radius: var(--radius-lg)', base.replace('  --gap: 8px;\n', '  --gap: 8px;\n  --radius: var(--radius-lg);\n')],
    ['--space-2: var(--space-4)', base.replace('  --gap: 8px;\n', '  --gap: 8px;\n  --space-2: var(--space-4);\n')],
    ['a var→var re-point of a size token', base.replace('--x: var(--gap)', '--x: var(--space-4)')],
    ['a colour slot taken over by a size', base.replace('#a34425', 'var(--gap)')],
    ['a size token turned into a colour', base.replace('--gap: 8px', '--gap: #24292f')],
    ['an unresolvable var', base.replace('#a34425', 'var(--nowhere)')],
    ['a color-mix over a size var', base.replace('#a34425', 'color-mix(in srgb, var(--gap) 50%, #fff)')],
    ['the background shorthand', base.replace('.btn { color: var(--accent); }', '.btn {\n  background: #fff;\n}')],
  ]) assert.notDeepEqual(ok(head), [], `${what} must fail`);
  assert.notDeepEqual(ok(base.replace('.btn {', '.btn /* x */ .y {')), []);
  // a var resolves through every stylesheet's head declarations (the maps), not only its own file
  const maps = { head: tokenMap([base, ':root { --graphite-light: #24292f; }']), base: tokenMap([base]) };
  assert.deepEqual(badCssLines(base, base.replace('#a34425', 'var(--graphite-light)'), maps), []);
});

test('structural gate N3: a new custom property may only be read as a colour', () => {
  const head = tokenMap([':root { --graphite: #24292f; --accent: var(--graphite); --gutter: #000; }']);
  const files = [
    ['a.css', '.x { margin: 0 var(--gutter, 16px) 10px; }'],
    ['b.html', '<style>.c { border-radius: var(--radius-md, 8px); }</style>'],
    ['c.css', 'pre { font: 12px/1.4 var(--font-mono, ui-monospace, monospace); }'],
    ['d.css', '.ok { color: var(--graphite); border-color: var(--graphite); } :root { --accent: var(--graphite); }'],
    ['e.js', "el.style.margin = 'var(--gutter)';"],
    ['f.svg', '<svg><rect style="rx: var(--radius-md, 4px)"/></svg>'],
  ];
  assert.deepEqual(badNewTokenUses(['--graphite'], files, head), []);
  assert.deepEqual(badNewTokenUses(['--gutter'], files, head), ['a.css: margin reads new --gutter', 'e.js: (no declaration) reads new --gutter']);
  assert.deepEqual(badNewTokenUses(['--radius-md'], files, head), ['b.html: border-radius reads removed --radius-md', 'f.svg: rx reads removed --radius-md']);
  // a REMOVED colour token read through a fallback by a size declaration also fails
  assert.deepEqual(badNewTokenUses(['--old-gap'], [['g.css', '.y { gap: var(--old-gap, 4px); }']], head), ['g.css: gap reads removed --old-gap']);
  assert.deepEqual(badNewTokenUses(['--font-mono'], files, head), ['c.css: font reads removed --font-mono']);
});

test('structural gate: activation is shared with the classifier and survives a renamed branch', () => {
  assert.equal(wantsClassify('# classify\n'), true);
  assert.equal(wantsClassify('# classify please\n'), false);
  assert.equal(wantsClassify('# classifyx'), false);
  // any changed expected file that asks for `# classify` turns the gate on, whatever the branch is called
  const f = 'test-visual/expected/codex-redesign-r0b-2026-10-27.txt';
  if (wantsClassify(readHead(f))) assert.ok(activating([f]).has(f));
  assert.equal(activating(['test-visual/expected/does-not-exist.txt']).has('test-visual/expected/does-not-exist.txt'), false);
});

test('R0b structural gate: only colour declarations change', { skip: !ACTIVE.size && 'no expected file asks for `# classify`' }, () => {
  assert.ok(BASE, `R0b structural gate: no merge-base with origin/${process.env.GITHUB_BASE_REF || 'main'} (fetch it; CI needs fetch-depth 0)`);
  const outside = [...CHANGED].filter((f) => !ALLOWED.has(f) && !SHOT.test(f) && !ACTIVE.has(f)).sort();
  assert.deepEqual(outside, [], 'files outside the R0b allow-list changed');
  const baseText = (f) => { try { return git('show', `${BASE}:${f}`); } catch { return null; } };
  const maps = {
    head: tokenMap(TOKEN_CSS.map(readHead).filter((t) => t !== null)),
    base: tokenMap(TOKEN_CSS.map(baseText).filter((t) => t !== null)),
  };
  const bad = {};
  for (const f of [...TOKEN_CSS, ...LITERAL_FIX]) {
    if (!CHANGED.has(f)) continue;
    const b = baseText(f); const h = readHead(f);
    if (b === null) { bad[f] = ['(new file: an allowed stylesheet must exist at base)']; continue; }
    if (h === null) { bad[f] = ['(deleted)']; continue; }
    const html = f.endsWith('.html');
    if (html && outsideStyle(b) !== outsideStyle(h)) { bad[f] = ['(changed outside <style>)']; continue; }
    const css = { base: html ? styleOf(b) : b, head: html ? styleOf(h) : h };
    // the file's own custom properties resolve too (a page-local --panel), on top of the token stylesheets
    const fileMaps = TOKEN_CSS.includes(f) ? maps : {
      head: tokenMap([...TOKEN_CSS.map(readHead).filter((t) => t !== null), css.head]),
      base: tokenMap([...TOKEN_CSS.map(baseText).filter((t) => t !== null), css.base]),
    };
    const lines = badCssLines(css.base, css.head, fileMaps, { rules: RULE_LINES.has(f) });
    if (lines.length) bad[f] = lines;
  }
  assert.deepEqual(bad, {}, 'stylesheet lines that are not a colour-only change');
  // new at head, and removed at head (removing a colour declaration flips `var(--old, fallback)` readers to their
  // fallback): both may only be read as a colour
  const fresh = [...maps.head.keys()].filter((n) => !maps.base.has(n));
  const gone = [...maps.base.keys()].filter((n) => !maps.head.has(n));
  assert.deepEqual(badNewTokenUses([...fresh, ...gone], trackedSources(), maps.head), [], 'new or removed custom properties read by a non-colour declaration');
});

test('structural gate rule 3: in a rule line only colours may change; layout, selectors and markup still fail', () => {
  // --bg is a token-sheet colour too: the page keeps its own --bg, so it must not be dropped with the accent pair
  const maps = { head: tokenMap([':root { --bg: #17191d; --accent: #24292f; --accent-ink: #fff; --accent-hover: #3a4048; }']),
    base: tokenMap([':root { --bg: #17191d; --accent: #a34425; --accent-ink: #fff; --accent-hover: #a34425; }']) };
  const base = '.ib-item { padding: 4px; }\n.ib-scope.tone-count { background: rgba(218, 119, 86, 0.18); color: var(--accent); }\n'
    + '.btn.primary:hover { background: #e5866a; border-color: #e5866a; }\n'
    + '.bg { background: radial-gradient(ellipse 60% 80% at 34% 100%, rgba(218, 119, 86, 0.08), transparent 70%); }\n'
    + ':root { --bg: #eceaf0; --accent: #b4532f; --accent-ink: #ffffff; }\n.p { background: var(--accent, #3b82f6); color: #fff; }\n';
  const fixed = base.replace('rgba(218, 119, 86, 0.18)', 'color-mix(in srgb, var(--accent) 18%, transparent)')
    .replace('#e5866a; border-color: #e5866a', 'var(--accent-hover); border-color: var(--accent-hover)')
    .replace('rgba(218, 119, 86, 0.08)', 'color-mix(in srgb, var(--accent) 8%, transparent)')
    .replace(' --accent: #b4532f; --accent-ink: #ffffff; }', ' }')
    .replace('var(--accent, #3b82f6); color: #fff', 'var(--accent); color: var(--accent-ink)');
  assert.deepEqual(badCssLines(base, fixed, maps, { rules: true }), []);
  // without rule 3 (tokens.css, burst-theme.css) the same one-line rules fail
  assert.notDeepEqual(badCssLines(base, fixed, maps), []);
  for (const [what, head] of [
    ['a layout change in the pill rule', fixed.replace('color: var(--accent); }', 'color: var(--accent); padding: 2px; }')],
    ['a layout value inside the rule', fixed.replace('.ib-scope.tone-count { background:', '.ib-scope.tone-count { margin: 1px; background:')],
    ['a changed selector', fixed.replace('.ib-scope.tone-count {', '.ib-scope.tone-count, .ib-row {')],
    ['a gradient geometry change', fixed.replace('ellipse 60% 80%', 'ellipse 70% 80%')],
    ['a colour into a non-colour slot', fixed.replace('at 34% 100%', 'at var(--accent) 100%')],
    ['changing a kept page token while dropping the accent', fixed.replace('--bg: #eceaf0;', '--bg: 4px;')],
    ['a colour-mix over a non-colour', fixed.replace('var(--accent) 18%, transparent', 'var(--nowhere) 18%, transparent')],
    ['a fallback that is not a colour', base.replace('var(--accent, #3b82f6)', 'var(--accent, 4px)')],
  ]) assert.notDeepEqual(badCssLines(base, head, maps, { rules: true }), [], `${what} must fail`);
  // dropping a page-local override is allowed only for a token-sheet colour property, never a size
  const withGap = base.replace(':root { --bg', ':root { --gap: 4px; --bg');
  assert.notDeepEqual(badCssLines(withGap, withGap.replace(' --gap: 4px;', ''), maps, { rules: true }), [], 'dropping a size override must fail');
  // round 8a: a #hex is a colour only inside a declaration value; strings and url() are opaque
  const sheet = '#fade { color: #fff; }\n.q { background: url(#abc); }\n.r::before { content: "#fff"; }\n'
    + '#fade,\n.s { color: #fff; }\n.t {\n  background-image:\n    radial-gradient(circle, #e5866a, transparent 70%);\n}\n';
  const rule3 = (head) => badCssLines(sheet, head, maps, { rules: true });
  assert.deepEqual(rule3(sheet.replace('#fade { color: #fff; }', '#fade { color: #000; }')), [], 'a colour value in a hex-ID rule may change');
  assert.deepEqual(rule3(sheet.replace('circle, #e5866a,', 'circle, var(--accent),')), [], 'a colour stop on a continuation line may change');
  for (const [what, head] of [
    ['a hex-digit ID selector (#fade → #face)', sheet.replace('#fade { color', '#face { color')],
    ['a url() fragment', sheet.replace('url(#abc)', 'url(#abd)')],
    ['a string that looks like a colour', sheet.replace('content: "#fff"', 'content: "#000"')],
    ['a selector continuation line (#fade, → #face,)', sheet.replace('#fade,\n', '#face,\n')],
    ['gradient geometry on a continuation line', sheet.replace('radial-gradient(circle,', 'radial-gradient(ellipse,')],
  ]) assert.notDeepEqual(rule3(head), [], `${what} must fail`);
  // an unclosed apostrophe (in an HTML comment that mentions <style>) must not blind the rest of the sheet
  const page2 = '<!-- the editor\'s inline <style> note -->\n<style>\n.a { padding: 4px; }\n</style>';
  assert.notDeepEqual(badCssLines(styleOf(page2), styleOf(page2.replace('padding: 4px', 'padding: 6px')), maps, { rules: true }), []);
  assert.equal(styleOf(page2).includes('editor'), false);
  // labfix-review: comments are stripped only in markup. Inside <style> a "<!--" is CSS text, and string literals
  // "<!--" / "-->" in scripts on either side of a real <style> must not swallow it.
  const page3 = '<style><!-- .a{padding:4px} --></style>';
  assert.notDeepEqual(badCssLines(styleOf(page3), styleOf(page3.replace('padding:4px', 'padding:6px')), maps, { rules: true }), []);
  const page4 = '<script>const open = "<!--";</script>\n<style>\n.a { padding: 4px; }\n</style>\n<script>const close = "-->";</script>';
  assert.equal(styleOf(page4), '\n.a { padding: 4px; }\n');
  assert.notDeepEqual(badCssLines(styleOf(page4), styleOf(page4.replace('padding: 4px', 'padding: 6px')), maps, { rules: true }), []);
  assert.equal(outsideStyle(page4), outsideStyle(page4.replace('padding: 4px', 'padding: 6px')), 'the style change is judged as CSS, not markup');
  assert.notEqual(outsideStyle(page4), outsideStyle(page4.replace('"-->"', '"--> "')), 'script text is markup');
  assert.equal(styleOf('<p title="<style>x</style>">hi</p>'), '', 'a quoted attribute value is not an element');
  // in HTML only <style> content is compared; markup must not change
  const page = '<style>\n.x { color: #e5866a; }\n</style>\n<div class="a">hi</div>';
  assert.equal(outsideStyle(page), outsideStyle(page.replace('#e5866a', 'var(--accent)')));
  assert.notEqual(outsideStyle(page), outsideStyle(page.replace('class="a"', 'class="b"')));
  assert.equal(styleOf(page).includes('#e5866a'), true);
});

module.exports = { badCssLines, badNewTokenUses, isColour, tokenMap, colourSkeleton, valueMask };
