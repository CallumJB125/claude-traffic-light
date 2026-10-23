const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');

let h;
let widget;

test.beforeAll(async () => {
  h = await launchApp();
  widget = await windowByFile(h.app, 'index.html');
});

test.afterAll(async () => { await h?.cleanup(); });

async function settled(page) {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1200);
  return page;
}

test('help window renders its default state', async () => {
  await widget.evaluate(() => window.trafficLight.openHelp());
  const help = await settled(await windowByFile(h.app, 'help.html'));
  await expect(help).toHaveScreenshot('help-window.png');
});

test('lights window renders its default state', async () => {
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await settled(await windowByFile(h.app, 'lights.html'));
  await visibleRigsMounted(lights);
  await expect(lights).toHaveScreenshot('lights-window.png');
});

// The rule editor's picker tiles are each a whole rig. Built eagerly they made Lights
// open with ~199k elements; only tiles on screen are built now, and this keeps it that way.
const LIGHTS_BOOT_ELEMENT_CEILING = 40000;
test('lights window opens with a bounded DOM', async () => {
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await settled(await windowByFile(h.app, 'lights.html'));
  await visibleRigsMounted(lights);
  const m = await lights.evaluate(() => ({
    elements: document.getElementsByTagName('*').length,
    loadMs: Math.round(performance.getEntriesByType('navigation')[0].loadEventEnd),
  }));
  console.log(`lights boot: ${m.elements} elements, load event at ${m.loadMs} ms`);
  expect(m.elements).toBeLessThan(LIGHTS_BOOT_ELEMENT_CEILING);
  const last = lights.locator('.mini').last();
  await expect(last).toHaveAttribute('data-rig', 'pending');
  await last.scrollIntoViewIfNeeded();
  await expect(last).toHaveAttribute('data-rig', 'mounted');
  await expect(last.locator('svg')).toHaveCount(1);
  await lights.evaluate(() => window.scrollTo(0, 0));
});

// Tiles mount on first sight (lights-view.js lazyRig); wait until every tile in the
// viewport has its rig, so a shot never catches an empty tile.
async function visibleRigsMounted(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.mini[data-rig="pending"]')].every((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth;
  }));
}

test('settings window renders its default state', async () => {
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.evaluate(() => window.lightsApi.openPreferences());
  const settings = await settled(await windowByFile(h.app, 'settings.html'));
  await expect(settings).toHaveScreenshot('settings-window.png');
});

// Each test launch is a fresh app copy; showing it in the Dock left stray icons behind.
test('a test run never shows in the Dock, even with windows open', async () => {
  test.skip(process.platform !== 'darwin', 'the Dock is macOS-only');
  // Opens its own windows: Playwright restarts the worker after any failed test, which
  // relaunches the app with only the widget, so this must not lean on earlier tests.
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.evaluate(() => window.lightsApi.openPreferences());
  await windowByFile(h.app, 'settings.html');
  expect(await h.app.evaluate(({ app }) => app.dock.isVisible())).toBe(false);
});
