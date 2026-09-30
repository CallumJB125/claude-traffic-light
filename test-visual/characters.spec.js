// B3 compatibility matrix: every character against every costume, cameo, eye
// mood, mouth item, pose, sign and routine. The first grid for a new character
// is reviewed by eye; after that it is a regression baseline. A static page in
// one bare Electron window (no app, no data dir), navigated grid to grid.
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron: electron, test, expect } = require('@playwright/test');

const PAGE = pathToFileURL(path.join(__dirname, 'matrix', 'matrix.html')).href;
const AXES = ['costume', 'cameo', 'eyes', 'pose', 'mouth', 'sign', 'routine'];
const BODIES = ['claude', 'dog', 'cat', 'frog', 'robot', 'ghost'];

let app;
let page;
const errors = [];

test.beforeAll(async () => {
  app = await electron.launch({ args: [path.join(__dirname, 'matrix', 'main.js')] });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test.afterAll(async () => { await app?.close(); });

for (const body of BODIES) {
  for (const axis of AXES) {
    test(`matrix: ${body} × ${axis}`, async () => {
      errors.length = 0;
      await page.goto(`${PAGE}?body=${body}&axis=${axis}`);
      await page.waitForSelector('body[data-ready="1"]');
      expect(errors).toEqual([]);
      await expect(page.locator('#grid')).toHaveScreenshot(`${body}-${axis}.png`, { animations: 'allow', threshold: 0.05 });
    });
  }
}
