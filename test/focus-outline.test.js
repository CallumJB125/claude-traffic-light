'use strict';
// Q13: a focus rule that removes the outline must have its outline restored under forced-colors, where the
// browser drops box-shadow. Every tracked .css file and every inline <style> in a tracked .html file is checked:
// a :focus / :focus-visible selector in a rule that sets `outline: none|0` needs, in the same file, an
// `@media (forced-colors: active)` rule for that selector that sets a real outline.
// `:focus:not(:focus-visible)` is exempt: it only clears the ring for pointer focus.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FORCED = /^@media[^{]*\(\s*forced-colors\s*:\s*active\s*\)/;

function rulesOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const walk = (src, forced) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth) { if (src[j] === '{') depth += 1; else if (src[j] === '}') depth -= 1; j += 1; }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith('@')) {
        if (/^@(media|supports|layer)/.test(head)) walk(body, forced || FORCED.test(head));
      } else {
        for (const sel of head.split(',').map((s) => s.trim()).filter(Boolean)) out.push({ sel, body, forced });
      }
      i = j;
    }
  };
  walk(text, false);
  return out;
}

const sources = () => {
  const files = execFileSync('git', ['ls-files', '*.css', '*.html'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const out = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (f.endsWith('.css')) out.push({ file: f, css: text });
    else for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) out.push({ file: f, css: m[1] });
  }
  return out;
};

const NO_OUTLINE = /(?:^|[;\s])outline\s*:\s*(?:none|0)(?![.\w-])/;
const REAL_OUTLINE = /(?:^|[;\s])outline\s*:\s*(?!none\b|0(?![.\w-]))[^;]+/;
const isFocus = (sel) => /:focus(?:-visible|-within)?\b/.test(sel) && !/:focus:not\(:focus-visible\)/.test(sel);

test('Q13: every :focus/:focus-visible rule that sets outline none|0 has a forced-colors outline for that selector in the same file', () => {
  const failures = [];
  const byFile = new Map();
  for (const { file, css } of sources()) byFile.set(file, (byFile.get(file) || []).concat(rulesOf(css)));
  for (const [file, rules] of byFile) {
    const restored = new Set(rules.filter((r) => r.forced && REAL_OUTLINE.test(r.body)).map((r) => r.sel));
    for (const r of rules) {
      if (r.forced || !isFocus(r.sel) || !NO_OUTLINE.test(r.body)) continue;
      if (!restored.has(r.sel)) failures.push(`${file}: ${r.sel}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('Q13: the shared focus ring is an outline with a halo, and forced-colors keeps the outline in Highlight', () => {
  const rules = rulesOf(fs.readFileSync(path.join(ROOT, 'tokens.css'), 'utf8'));
  const base = rules.find((r) => !r.forced && r.sel === ':focus-visible');
  assert.match(base.body, /outline:\s*2px solid var\(--focus-ring\)/);
  assert.match(base.body, /outline-offset:\s*2px/);
  assert.match(base.body, /box-shadow:\s*var\(--focus\)/);
  const forced = rules.find((r) => r.forced && r.sel === ':focus-visible');
  assert.match(forced.body, /outline:\s*2px solid Highlight/);
});

test('Q13: the checker itself flags a focus rule that drops the outline and accepts one that restores it', () => {
  const bad = rulesOf('.a:focus-visible { outline: none; box-shadow: 0 0 0 2px red; }');
  assert.equal(bad.filter((r) => !r.forced && isFocus(r.sel) && NO_OUTLINE.test(r.body)).length, 1);
  const good = rulesOf('.a:focus-visible { outline: 0; }\n@media (forced-colors: active) { .a:focus-visible { outline: 2px solid Highlight; } }');
  assert.equal(good.filter((r) => r.forced && REAL_OUTLINE.test(r.body)).length, 1);
  assert.equal(NO_OUTLINE.test('outline: 0.5px solid red'), false);
  assert.equal(isFocus(':focus:not(:focus-visible)'), false);
});
