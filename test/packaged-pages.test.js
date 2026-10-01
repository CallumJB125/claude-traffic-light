// Every page main.js opens, the preloads it names, and the local scripts and
// styles those pages pull in must be in build.files: a missing entry works in
// dev and fails only in the packaged app (the Usage pop-out once did).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const files = require('../package.json').build.files;
const toRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
const include = files.filter((f) => !f.startsWith('!')).map(toRe);
const exclude = files.filter((f) => f.startsWith('!')).map((f) => toRe(f.slice(1)));
const packaged = (rel) => include.some((r) => r.test(rel)) && !exclude.some((r) => r.test(rel));

test('every page, preload and local asset main.js uses is packaged', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const pages = [...main.matchAll(/loadFile\('([^']+\.html)'/g)].map((m) => m[1]);
  const preloads = [...main.matchAll(/preload: path\.join\(__dirname, '([^']+\.js)'\)/g)].map((m) => m[1]);
  assert.ok(pages.length > 5 && preloads.length > 5, 'found the windows');
  const assets = pages.flatMap((p) => {
    const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
    return [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^":#?]+)"/g)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(p), m[1])));
  });
  const missing = [...new Set([...pages, ...preloads, ...assets])].filter((f) => fs.existsSync(path.join(ROOT, f)) && !packaged(f));
  assert.deepEqual(missing, []);
});
