// B3 compatibility matrix: every character against every costume, cameo, eye
// mood, mouth item, pose, sign and routine. The first grid for a new character
// is reviewed by eye; after that it is a regression baseline. A static page in
// one bare Electron window (no app, no data dir), navigated grid to grid.
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron: electron, test, expect } = require('@playwright/test');

const PAGE = pathToFileURL(path.join(__dirname, 'matrix', 'matrix.html')).href;
const AXES = ['costume', 'cameo', 'eyes', 'pose', 'mouth', 'sign', 'routine'];
const BODIES = ['claude', 'dog', 'cat', 'frog', 'robot', 'ghost', 'duck', 'octopus', 'crt', 'blob', 'capybara', 'cactus', 'owl', 'penguin', 'fox', 'bee', 'axolotl', 'mushroom', 'egg', 'toaster', 'cloud', 'astronaut', 'sloth', 'trex', 'cyclops'];
// test-only shapes (matrix/probes.js) that push the contract's edges
const PROBES = ['u-probe-tall', 'u-probe-blob', 'u-probe-wide', 'u-probe-screen'];

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

for (const body of [...BODIES, ...PROBES]) {
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

// B3 geometry, measured on the rendered rig in rig units.
const within = (b, x0, y0, x1, y1, pad = 0) => b.x0 >= x0 - pad && b.y0 >= y0 - pad && b.x1 <= x1 + pad && b.y1 <= y1 + pad;
for (const body of [...BODIES, ...PROBES]) {
  test(`geometry: ${body}`, async () => {
    errors.length = 0;
    await page.goto(`${PAGE}?body=${body}&axis=geometry`);
    await page.waitForSelector('body[data-ready="1"]');
    expect(errors).toEqual([]);
    const g = await page.evaluate(() => window.__geometry);
    const A = g.anchors;
    const head = { x0: A.head.x, y0: A.head.y, x1: A.head.x + A.head.w, y1: A.head.y + A.head.h };
    // every hat touches the head box: its bottom reaches the hat line, and
    // it overlaps the head horizontally
    for (const [hat, b] of Object.entries(g.hats)) {
      expect(b, `${hat} is drawn`).not.toBeNull();
      // the halo hovers a little above by design
      expect(b.y1, `${hat} reaches down to the head`).toBeGreaterThanOrEqual(A.hatLine - (hat === 'halo' ? 6 : 1.5) * (A.head.w / 30));
      expect(b.y0, `${hat} starts above the head's bottom`).toBeLessThanOrEqual(head.y1);
      expect(Math.min(b.x1, head.x1) - Math.max(b.x0, head.x0), `${hat} overlaps the head`).toBeGreaterThan(0);
    }
    // the eyes sit in the face box: both, one, or none drawn
    const want = { pair: 2, single: 2, none: 0 }[g.eyeMode];
    expect(g.eyes.length).toBe(want);
    const eyes = g.eyeMode === 'single' ? g.eyes.slice(0, 1) : g.eyes;
    for (const e of eyes) {
      expect(e.x).toBeGreaterThanOrEqual(A.faceBox.x - 0.5);
      expect(e.x).toBeLessThanOrEqual(A.faceBox.x + A.faceBox.w + 0.5);
      expect(e.y).toBeGreaterThanOrEqual(A.faceBox.y - 0.5);
      expect(e.y).toBeLessThanOrEqual(A.faceBox.y + A.faceBox.h + 0.5);
    }
    // held things stay on the grid (or aren't drawn at all without hands)
    for (const [pose, b] of Object.entries(g.held)) {
      if (b === 'hidden') { expect(A.hands, `${pose} is only hidden for a handless character`).toBeNull(); continue; }
      expect(within(b, 0, 0, 64, 82, 1), `${pose}: ${JSON.stringify(b)}`).toBe(true);
    }
    // the body isn't clipped (the widget keeps a few units round the grid)
    expect(within(g.body, 0, 0, 64, 82, 4), JSON.stringify(g.body)).toBe(true);
    // click-through: the face is solid, empty corners are not
    expect(g.hit.face).toBe(true);
    expect(g.hit.corner).toBe(false);
    // invisible parts (unworn costumes, props at rest) never catch the mouse
    expect(g.hit.arm).toBe(['claude', 'dog', 'cat', 'frog', 'robot', 'octopus', 'crt', 'blob', 'capybara', 'fox', 'toaster', 'cloud', 'astronaut', 'sloth', 'u-probe-wide'].includes(body));
  });
}
