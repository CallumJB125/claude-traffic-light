'use strict';
// Redesign R0b structural gate (plan-redesign §R4.4; labfix-review's steelman). The PRIMARY check for an accent
// flip: R0b changes only colour tokens, and a diff can state that directly. The pixel classifier
// (test-visual/classify.spec.js) is the second layer.
//
// Active when the branch's test-visual/expected/<branch>.txt starts with `# classify` (the same switch as the
// classifier). The branch is GITHUB_HEAD_REF in a PR job, else the checked-out branch. Against the merge-base
// with origin/<GITHUB_BASE_REF or main>, including uncommitted and untracked files:
//   1. outside test-visual/, only ALLOWED files may change;
//   2. in the token stylesheets, with comments stripped on both sides, every changed line must be one
//      declaration of a custom property or a colour property whose value is a colour (#hex, rgb()/rgba(),
//      var(--x), color-mix(), transparent). No selector, layout or size change can pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN_CSS = ['tokens.css', 'buddy-window/burst-theme.css', 'board/web/app.css', 'board/web/phone.css'];
const ALLOWED = new Set([
  ...TOKEN_CSS,
  'test/tokens-contrast.test.js', 'test/burst-theme.test.js', 'test/classify-lib.test.js',
  'test/fixtures/tokens-terracotta-r0a.css', 'test/r0b-structural.test.js',
]);
const COLOUR_PROPS = new Set(['color', 'background', 'background-color', 'border-color', 'border-top-color',
  'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'fill', 'stroke', 'caret-color',
  'accent-color', 'text-decoration-color', 'column-rule-color', 'stop-color', 'flood-color', 'lighting-color']);

const COLOUR_ATOM = String.raw`(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+%?\s*)?\)|var\(\s*--[\w-]+\s*\)|transparent)`;
const MIX = String.raw`color-mix\(\s*in\s+[\w-]+\s*,\s*${COLOUR_ATOM}(?:\s+[\d.]+%)?\s*,\s*${COLOUR_ATOM}(?:\s+[\d.]+%)?\s*\)`;
const DECL = new RegExp(String.raw`^\s*(--[\w-]+|[a-z-]+)\s*:\s*(?:${COLOUR_ATOM}|${MIX})\s*(?:!important\s*)?;?\s*$`);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Changed lines (comments stripped, blank lines ignored) that are not a lone colour declaration.
function badCssLines(baseText, headText) {
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
    const m = body.match(DECL);
    if (!m || !(m[1].startsWith('--') || COLOUR_PROPS.has(m[1]))) bad.push(line);
  }
  return bad;
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function branchName() {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  try { return git('rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { return ''; }
}

function active() {
  const branch = branchName();
  if (!branch || branch === 'HEAD') return false;
  const file = path.join(ROOT, 'test-visual', 'expected', `${branch.replace(/\//g, '-')}.txt`);
  return fs.existsSync(file) && /^# classify\b/.test(fs.readFileSync(file, 'utf8'));
}

function mergeBase() {
  const ref = `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
  return git('merge-base', 'HEAD', ref).trim();
}

test('structural checker: colour declarations pass; selectors, layout and sizes do not', () => {
  const base = ':root {\n  --accent: #a34425; /* old */\n  --gap: 8px;\n}\n.btn { color: var(--accent); }\n';
  assert.deepEqual(badCssLines(base, base.replace('#a34425', 'var(--graphite-light)').replace('/* old */', '/* new note */')), []);
  assert.deepEqual(badCssLines(base, base.replace('  --gap: 8px;\n', '  --gap: 8px;\n  --graphite-light-soft: rgba(36, 41, 47, 0.14);\n')), []);
  assert.deepEqual(badCssLines(base, base.replace('#a34425', 'color-mix(in oklab, var(--graphite-light) 70%, #000)')), []);
  for (const [what, head] of [
    ['a size token', base.replace('8px', '6px')],
    ['a selector', base.replace('.btn {', '.btn, .chip {')],
    ['a rule on one line', base.replace('color: var(--accent)', 'color: #24292f')],
    ['a layout property', base.replace('  --gap: 8px;\n', '  --gap: 8px;\n  padding: 4px;\n')],
    ['a non-colour value in a custom property', base.replace('#a34425', '2px solid #24292f')],
    ['a non-colour property', base.replace('  --gap: 8px;\n', '  --gap: 8px;\n  opacity: 0.8;\n')],
    ['a var() with a fallback', base.replace('#a34425', 'var(--graphite-light, 4px)')],
  ]) assert.notDeepEqual(badCssLines(base, head), [], `${what} must fail`);
  // a selector change hidden in a comment-looking line still fails; a comment-only edit is free
  assert.notDeepEqual(badCssLines(base, base.replace('.btn {', '.btn /* x */ .y {')), []);
});

test('R0b structural gate: only colour tokens change outside test-visual/', { skip: !active() && 'the branch\'s expected list does not start with `# classify`' }, () => {
  let base;
  try { base = mergeBase(); } catch (e) { assert.fail(`R0b structural gate: no merge-base with origin/${process.env.GITHUB_BASE_REF || 'main'} (fetch it; CI needs fetch-depth 0): ${e.message}`); }
  const changed = new Set([
    ...git('diff', '--name-only', '--no-renames', base).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean));
  const outside = [...changed].filter((f) => !f.startsWith('test-visual/') && !ALLOWED.has(f)).sort();
  assert.deepEqual(outside, [], 'files outside the R0b allow-list changed');
  const bad = {};
  for (const f of TOKEN_CSS) {
    if (!changed.has(f)) continue;
    let baseText;
    try { baseText = git('show', `${base}:${f}`); } catch { bad[f] = ['(new file: a token stylesheet must exist at base)']; continue; }
    const headPath = path.join(ROOT, f);
    if (!fs.existsSync(headPath)) { bad[f] = ['(deleted)']; continue; }
    const lines = badCssLines(baseText, fs.readFileSync(headPath, 'utf8'));
    if (lines.length) bad[f] = lines;
  }
  assert.deepEqual(bad, {}, 'token stylesheet lines that are not a lone colour declaration');
});

module.exports = { badCssLines };
