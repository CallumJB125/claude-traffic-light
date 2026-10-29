'use strict';
// Ledger 46: the bidi, zero-width and similar invisible characters that sanitisers strip are written as \u escapes in
// the source (the app's own js and html), never raw, so a reviewer (and a diff) can see them. Fixtures under test/ may hold them raw on purpose.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TREES = ['src', 'hooks', 'remote/src', 'board', 'adapters', 'scripts', 'buddy-window'];
const SKIP = new Set(['node_modules', 'test', '.git']);
const INVISIBLE = /[\u061c\u00ad\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.((c|m)?js|html)$/.test(e.name)) yield p;
  }
}

test('no raw invisible character in our own js and html source', () => {
  let files = 0;
  const hits = [];
  const rootFiles = fs.readdirSync(ROOT).filter((n) => /\.((c|m)?js|html)$/.test(n)).map((n) => path.join(ROOT, n));
  for (const tree of [...TREES, '.']) {
    const dir = path.join(ROOT, tree);
    if (!fs.existsSync(dir)) continue;
    for (const file of tree === '.' ? rootFiles : sources(dir)) {
      files += 1;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (INVISIBLE.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}`); });
    }
  }
  assert.ok(files > 100, `scanned ${files} files`);
  assert.deepEqual(hits, [], 'write these as \\u escapes');
});
