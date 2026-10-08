const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { PAGES } = require('../buddy-window/pages');
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
  assert.match(src, /const stay = stayOnPage\('lights\.html'\);[\s\S]*?lightsWin\.webContents\.on\('will-navigate', stay\);[\s\S]*?lightsWin\.webContents\.on\('will-redirect', stay\);/);
  assert.match(src, /lightsWin\.webContents\.setWindowOpenHandler\(\(\) => \({ action: 'deny' }\)\)/);
  assert.doesNotMatch(src, /test\(url\)\) e\.preventDefault\(\)/, 'no loose filename regex guards a window');
});

// Execute the production embedded-view guard and allow-list, including both
// navigation events. Queries/fragments do not change a packaged page's owner.
test('embedded utility pages stay within the exact packaged page allow-list', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window/index.js'), 'utf8');
  const list = src.slice(src.indexOf('const LOCAL_PAGES ='), src.indexOf('\nfunction devLogin(')).replace('const fileKey = hubKey;', '');
  const guard = src.slice(src.indexOf('  function lockLocal(view)'), src.indexOf('\n  // ── account pages'));
  const context = { DIR: path.join(DIR, 'buddy-window'), path, pathToFileURL, URL, PAGES, shell: { openExternal() {} } };
  vm.createContext(context); vm.runInContext(`${list}\n${guard}\nthis.bind = lockLocal;`, context);
  const handlers = new Map(); let open;
  context.bind({ webContents: { on: (name, fn) => handlers.set(name, fn), setWindowOpenHandler: fn => { open = fn; } } });
  for (const event of ['will-navigate', 'will-redirect']) {
    const g = handlers.get(event); assert.equal(typeof g, 'function');
    for (const page of PAGES.filter(p => p.file)) {
      const own = pathToFileURL(path.join(DIR, page.file)).href;
      assert.equal(blocked(g, `${own}?embedded=1#top`), false, `${event}: ${page.id}`);
      assert.equal(blocked(g, `${own}.evil`), true);
      assert.equal(blocked(g, pathToFileURL(path.join('/tmp', page.file)).href), true);
    }
    for (const target of ['https://example.com', 'javascript:alert(1)', 'data:text/html,x', '', 'not a URL']) assert.equal(blocked(g, target), true);
  }
  assert.equal(open({ url: 'https://example.com' }).action, 'deny');
});
