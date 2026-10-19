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
  const registry = require('../buddy-window/pages').PAGES.filter(p => p.file);
  const buddy = fs.readFileSync(path.join(ROOT, 'buddy-window/index.js'), 'utf8');
  assert.match(buddy, /loadFile\(path\.join\(DIR, '\.\.', page\.file\)/);
  assert.match(buddy, /preload: path\.join\(DIR, '\.\.', page\.preload\)/);
  const shellPages = [...buddy.matchAll(/loadFile\(path\.join\(DIR, '([^']+\.html)'\)/g)].map(m => `buddy-window/${m[1]}`);
  const shellPreloads = [...buddy.matchAll(/preload: path\.join\(DIR, '([^']+\.js)'\)/g)].map(m => `buddy-window/${m[1]}`);
  assert.deepEqual([...new Set(shellPages)].sort(), ['buddy-window/account.html', 'buddy-window/info.html', 'buddy-window/sidebar.html']);
  assert.deepEqual([...new Set(shellPreloads)].sort(), ['buddy-window/account-preload.js', 'buddy-window/hub-preload.js', 'buddy-window/info-preload.js', 'buddy-window/sidebar-preload.js']);
  for (const id of ['sessions', 'settings', 'usage', 'stats', 'help', 'hatch', 'feedback', 'updates', 'tasks', 'waiting', 'myday', 'setups', 'aitools', 'clients']) assert.ok(registry.some(p => p.id === id && p.file && p.preload), `${id}: registered embedded file and preload`);
  const pages = [...main.matchAll(/loadFile\('([^']+\.html)'/g)].map((m) => m[1]);
  const preloads = [...main.matchAll(/preload: path\.join\(__dirname, '([^']+\.js)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(pages)].sort(), ['index.html', 'lights.html', 'onboarding.html', 'overlay.html', 'tray.html']);
  assert.deepEqual([...new Set(preloads)].sort(), ['lights-preload.js', 'onboarding-preload.js', 'overlay-preload.js', 'preload.js', 'tray-preload.js']);
  pages.push(...registry.map(p => p.file), ...shellPages);
  preloads.push(...registry.map(p => p.preload), ...shellPreloads);
  const assets = pages.flatMap((p) => {
    const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
    return [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^":#?]+)"/g)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(p), m[1])));
  });
  const missing = [...new Set([...pages, ...preloads, ...assets])].filter((f) => !fs.existsSync(path.join(ROOT, f)) || !packaged(f));
  assert.deepEqual(missing, []);
});
