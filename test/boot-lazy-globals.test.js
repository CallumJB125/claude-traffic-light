// main.js must read Node's lazy web globals before any other statement: a first read
// inside the startup whenReady microtask can crash main with a V8 SIGTRAP
// (outputs/boot-sigtrap-diag-report.md). Guards against a refactor moving the read down.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GLOBALS = ['AbortSignal', 'AbortController', 'TextEncoder', 'TextDecoder', 'structuredClone', 'atob', 'btoa'];

function firstStatement(src) {
  const code = src.replace(/^(\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*\n)*/, '');
  const end = code.indexOf(';');
  return { stmt: code.slice(0, end + 1), rest: code.slice(end + 1) };
}

test('main.js reads the lazy web globals as its first statement, without calling them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const { stmt } = firstStatement(src);
  assert.match(stmt, /^void \[[^\]]*\];$/);
  assert.doesNotMatch(stmt, /\(/, 'plain reads only, no calls');
  assert.doesNotMatch(stmt, /\b(require|if)\b/);
  for (const g of GLOBALS) assert.ok(stmt.includes(`globalThis.${g}`), `reads globalThis.${g}`);
  assert.ok(!stmt.includes('globalThis.fetch'), 'fetch is not lazy and is not read here');
});

test('nothing executable precedes the read', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const before = src.slice(0, src.indexOf('void [globalThis.AbortSignal'));
  assert.equal(before.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length, 0);
});
