const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stayOnPage } = require('../src/nav-guard.js');

const DIR = path.join(path.sep, 'app', 'resources');
const blocked = (guard, url) => { let p = false; guard({ preventDefault: () => { p = true; } }, url); return p; };

test('a window stays on its own page: the exact file URL, with any query or fragment', () => {
  const g = stayOnPage(DIR, 'usage-pop.html');
  const own = pathToFileURL(path.join(DIR, 'usage-pop.html')).href;
  for (const url of [own, `${own}?x=1`, `${own}#top`]) assert.equal(blocked(g, url), false, url);
});

test('look-alike URLs are refused', () => {
  const g = stayOnPage(DIR, 'usage-pop.html');
  const own = pathToFileURL(path.join(DIR, 'usage-pop.html')).href;
  for (const url of [
    'file:///tmp/x/usage-pop.html', // the same name in another directory
    `${own}.evil`, `${pathToFileURL(path.join(DIR, 'usage-pop.html.evil')).href}`,
    pathToFileURL(path.join(DIR, 'sub', 'usage-pop.html')).href,
    pathToFileURL(path.join(DIR, 'updates.html')).href, // a sibling page
    'https://example.com/usage-pop.html', 'http://127.0.0.1/usage-pop.html',
    'not a url', '', 'javascript:alert(1)', 'data:text/html,usage-pop.html',
  ]) assert.equal(blocked(g, url), true, url);
});

test('main.js guards its single-page windows with the exact-URL check, not a filename regex', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /const stay = stayOnPage\('updates\.html'\);/);
  assert.match(src, /const stay = stayOnPage\('usage-pop\.html'\);/);
  assert.doesNotMatch(src, /test\(url\)\) e\.preventDefault\(\)/, 'no loose filename regex guards a window');
});
