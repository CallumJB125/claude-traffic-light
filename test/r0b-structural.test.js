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
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { wantsClassify, expectedFileFor } = require('../test-visual/classify-lib');

const ROOT = path.join(__dirname, '..');
const TOKEN_CSS = ['tokens.css', 'buddy-window/burst-theme.css', 'board/web/app.css', 'board/web/phone.css'];
const ALLOWED = new Set([
  ...TOKEN_CSS,
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

// Changed lines (comments stripped, blank lines ignored) that are not a lone colour declaration.
// `maps` = { head, base }: token maps used to resolve var() (head) and to check a custom property's base value.
function badCssLines(baseText, headText, maps = { head: tokenMap([headText]), base: tokenMap([baseText]) }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r0b-structural-'));
  const a = path.join(dir, 'base.css'); const b = path.join(dir, 'head.css');
  fs.writeFileSync(a, stripComments(baseText)); fs.writeFileSync(b, stripComments(headText));
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U0', a, b], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index failed: ${r.stderr}`);
  const bad = [];
  for (const line of r.stdout.split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---) /.test(line)) continue;
    const body = line.slice(1);
    if (!body.trim()) continue;
    const m = body.match(/^\s*(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+?)\s*;?\s*$/);
    const ok = m && (m[1].startsWith('--') || COLOUR_PROPS.has(m[1]))
      // a removed line is judged against the base tokens, an added one against the head tokens
      && isColour(m[2], line[0] === '-' ? maps.base : maps.head)
      && (!m[1].startsWith('--') || !maps.base.has(m[1]) || isColour(`var(${m[1]})`, maps.base));
    if (!ok) bad.push(line);
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
  for (const f of TOKEN_CSS) {
    if (!CHANGED.has(f)) continue;
    const b = baseText(f); const h = readHead(f);
    if (b === null) { bad[f] = ['(new file: a token stylesheet must exist at base)']; continue; }
    if (h === null) { bad[f] = ['(deleted)']; continue; }
    const lines = badCssLines(b, h, maps);
    if (lines.length) bad[f] = lines;
  }
  assert.deepEqual(bad, {}, 'token stylesheet lines that are not a lone colour declaration');
});

module.exports = { badCssLines, isColour, tokenMap };
