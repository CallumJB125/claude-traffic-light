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
const { htmlParts } = require('../test-visual/classify-lib');

const ROOT = path.join(__dirname, '..');
const FORCED = /^@media(?![^{]*\bnot\b)[^{]*\(\s*forced-colors\s*:\s*active\s*\)/;

// Splits a rule body into its own declarations and its nested blocks (native CSS nesting).
function splitBody(body) {
  const decls = [];
  const nested = [];
  let start = 0;
  let i = 0;
  while (i < body.length) {
    if (body[i] === ';') { decls.push(body.slice(start, i)); start = i + 1; i += 1; } else if (body[i] === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < body.length && depth) { if (body[j] === '{') depth += 1; else if (body[j] === '}') depth -= 1; j += 1; }
      nested.push({ head: body.slice(start, i).trim(), inner: body.slice(i + 1, j - 1) });
      start = j;
      i = j;
    } else i += 1;
  }
  decls.push(body.slice(start));
  return { decls: decls.join(';'), nested };
}

function rulesOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const resolve = (head, parents) => {
    const sels = head.split(',').map((x) => x.trim()).filter(Boolean);
    if (!parents.length) return sels;
    return sels.flatMap((x) => parents.map((p) => (x.includes('&') ? x.replace(/&/g, p) : `${p} ${x}`)));
  };
  const walk = (src, forced, parents) => {
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
        if (/^@(media|supports|layer|container|scope)/.test(head)) {
          const f = forced || FORCED.test(head);
          // Inside a rule, an at-rule holds declarations for that rule; at top level it holds rules.
          if (parents.length && !body.includes('{')) { for (const sel of parents) out.push({ sel, body, forced: f }); } else walk(body, f, parents);
        }
      } else {
        const sels = resolve(head, parents);
        const { decls, nested } = splitBody(body);
        for (const sel of sels) out.push({ sel, body: decls, forced });
        for (const n of nested) walk(`${n.head}{${n.inner}}`, forced, sels);
      }
      i = j;
    }
  };
  walk(text, false, []);
  return out;
}

const sources = () => {
  const files = execFileSync('git', ['ls-files', '*.css', '*.html'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const out = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (f.endsWith('.css')) out.push({ file: f, css: text });
    else for (const css of htmlParts(text).styles) out.push({ file: f, css });
  }
  return out;
};

const NO_OUTLINE = /(?:^|[;\s])outline(?:-style)?\s*:\s*(?:none|0)(?![.\w-])|(?:^|[;\s])outline-width\s*:\s*0(?![.\w-])/;
// The lookahead sits before any whitespace so `outline: none` can't backtrack past it.
const REAL_OUTLINE = /(?:^|[;\s])outline\s*:(?!\s*(?:none\b|0(?![.\w-])))(?![^;]*transparent)[^;]+/;
// A base rule that wipes the outline: the global :focus-visible ring is then gone for that element.
const RESETS_OUTLINE = (body) => NO_OUTLINE.test(body) || /(?:^|[;\s])all\s*:\s*(?:unset|revert)\b/.test(body) || /(?:^|[;\s])outline\s*:[^;]*transparent/.test(body);
const baseOf = (sel) => sel.replace(/:focus(?:-visible|-within)?\b/g, '').trim();
// Focus selectors whose own (non-forced) base rule resets the outline but whose focus rules set none.
function resetWithoutRing(rules) {
  const out = [];
  const nonForced = rules.filter((r) => !r.forced);
  for (const r of nonForced) {
    if (!isFocus(r.sel)) continue;
    const base = baseOf(r.sel);
    if (!base || base === '*') continue;
    if (!nonForced.some((b) => b.sel === base && RESETS_OUTLINE(b.body))) continue;
    if (!nonForced.some((f) => f.sel === r.sel && REAL_OUTLINE.test(f.body))) out.push(r.sel);
  }
  return [...new Set(out)];
}
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

test('Q13: an element whose base rule resets the outline (all: unset etc.) sets a real outline in its focus rule', () => {
  const failures = [];
  const byFile = new Map();
  for (const { file, css } of sources()) byFile.set(file, (byFile.get(file) || []).concat(rulesOf(css)));
  for (const [file, rules] of byFile) for (const sel of resetWithoutRing(rules)) failures.push(`${file}: ${sel}`);
  // The card's ring is drawn on its parent (`.card:has(.card-open:focus-visible)`, `tr:has(...)`), with a forced-colors Highlight restore.
  const RING_ON_PARENT = ['board/web/app.css: .card-open:focus-visible'];
  assert.deepEqual(failures.filter((f) => !RING_ON_PARENT.includes(f)), []);
  // An allowlist entry that no longer shows up as a failure is stale: the exemption would then hide the next real one.
  assert.deepEqual(staleEntries(RING_ON_PARENT, failures), [], 'allowlist entries that are no longer failures');
});

const staleEntries = (allow, failures) => allow.filter((e) => !failures.includes(e));

test('Q13 checker: a stale allowlist entry is reported, a live one is not', () => {
  assert.deepEqual(staleEntries(['a.css: .x:focus-visible'], ['a.css: .x:focus-visible', 'b.css: .y:focus']), []);
  assert.deepEqual(staleEntries(['a.css: .x:focus-visible', 'c.css: .z:focus'], ['a.css: .x:focus-visible']), ['c.css: .z:focus']);
  assert.deepEqual(staleEntries(['a.css: .x:focus-visible'], []), ['a.css: .x:focus-visible']);
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

const flagged = (css) => {
  const rules = rulesOf(css);
  const restored = new Set(rules.filter((r) => r.forced && REAL_OUTLINE.test(r.body)).map((r) => r.sel));
  return rules.filter((r) => !r.forced && isFocus(r.sel) && NO_OUTLINE.test(r.body) && !restored.has(r.sel)).map((r) => r.sel);
};

test('Q13 checker negatives: base resets, longhands, transparent, nesting, @container/@scope, not-forced', () => {
  // all: unset / revert on the base, focus rule only has a shadow (the M1 case)
  assert.deepEqual(resetWithoutRing(rulesOf('.a { all: unset; }\n.a:focus-visible { box-shadow: var(--focus); }')), ['.a:focus-visible']);
  assert.deepEqual(resetWithoutRing(rulesOf('.a { all: revert; }\n.a:focus { box-shadow: 0 0 0 2px red; }')), ['.a:focus']);
  assert.deepEqual(resetWithoutRing(rulesOf('.a { outline: none; }\n.a:focus-visible { box-shadow: 0 0 0 2px red; }')), ['.a:focus-visible']);
  assert.deepEqual(resetWithoutRing(rulesOf('.a { outline: 2px solid transparent; }\n.a:focus-visible { box-shadow: 0 0 0 2px red; }')), ['.a:focus-visible']);
  // ...and a transparent outline in the focus rule is not a real outline
  assert.deepEqual(resetWithoutRing(rulesOf('.a { all: unset; }\n.a:focus-visible { outline: 2px solid transparent; }')), ['.a:focus-visible']);
  // `outline: none` / `outline: 0` with a space is still no outline, in a focus rule or a forced block
  assert.deepEqual(resetWithoutRing(rulesOf('.a { all: unset; }\n.a:focus-visible { outline: none; }')), ['.a:focus-visible']);
  assert.deepEqual(flagged('.a:focus-visible { outline: none; }\n@media (forced-colors: active) { .a:focus-visible { outline: none; } }'), ['.a:focus-visible']);
  assert.equal(REAL_OUTLINE.test('outline: 0;'), false);
  // positive: a real outline passes
  assert.deepEqual(resetWithoutRing(rulesOf('.a { all: unset; }\n.a:focus-visible { outline: 2px solid var(--focus-ring); }')), []);
  // longhands
  assert.deepEqual(flagged('.a:focus-visible { outline-style: none; }'), ['.a:focus-visible']);
  assert.deepEqual(flagged('.a:focus-visible { outline-width: 0; }'), ['.a:focus-visible']);
  assert.deepEqual(resetWithoutRing(rulesOf('.a { outline-style: none; }\n.a:focus-visible { box-shadow: 0 0 0 2px red; }')), ['.a:focus-visible']);
  // native nesting
  assert.deepEqual(flagged('.a { &:focus-visible { outline: none; } }'), ['.a:focus-visible']);
  assert.deepEqual(flagged('.a { .b:focus-visible { outline: none; } }'), ['.a .b:focus-visible']);
  assert.deepEqual(flagged('.a { color: red; @media (width > 1px) { &:focus-visible { outline: none; } } }'), ['.a:focus-visible']);
  assert.deepEqual(resetWithoutRing(rulesOf('.a { all: unset; &:focus-visible { box-shadow: 0 0 0 2px red; } }')), ['.a:focus-visible']);
  // @container and @scope are walked
  assert.deepEqual(flagged('@container (width > 1px) { .a:focus-visible { outline: none; } }'), ['.a:focus-visible']);
  assert.deepEqual(flagged('@scope (.s) { .a:focus-visible { outline: none; } }'), ['.a:focus-visible']);
  // `not all and (forced-colors: active)` is not a restore
  assert.deepEqual(flagged('.a:focus-visible { outline: none; }\n@media not all and (forced-colors: active) { .a:focus-visible { outline: 2px solid red; } }'), ['.a:focus-visible']);
  assert.deepEqual(flagged('.a:focus-visible { outline: none; }\n@media (forced-colors: active) { .a:focus-visible { outline: 2px solid Highlight; } }'), []);
});

// The inline <style> of an HTML file comes from htmlParts: a commented-out or quoted block is not CSS, a real block
// after a script's "<!--" / "-->" strings is.
test('Q13 inline-style extraction: comments and strings are not CSS, a real block is', () => {
  const bad = '.a:focus-visible { outline: none; }';
  const flaggedIn = (html) => htmlParts(html).styles.flatMap((css) => flagged(css));
  assert.deepEqual(flaggedIn(`<!-- inline <style> -->\n<style>${bad}</style>`), ['.a:focus-visible']);
  assert.deepEqual(flaggedIn(`<!-- <style>${bad}</style> -->`), []);
  assert.deepEqual(flaggedIn(`<script>const s = "<style>${bad}</style>";</script>`), []);
  assert.deepEqual(flaggedIn(`<script>const o = "<!--";</script><style>${bad}</style><script>const c = "-->";</script>`), ['.a:focus-visible']);
});
