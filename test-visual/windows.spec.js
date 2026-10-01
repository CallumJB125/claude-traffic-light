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
  await expect(lights).toHaveScreenshot('lights-window.png');
});

test('settings window renders its default state', async () => {
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.evaluate(() => window.lightsApi.openPreferences());
  const settings = await settled(await windowByFile(h.app, 'settings.html'));
  await expect(settings).toHaveScreenshot('settings-window.png');
});

// Each test launch is a fresh app copy; showing it in the Dock left stray icons behind.
test('a test run never shows in the Dock, even with windows open', async () => {
  test.skip(process.platform !== 'darwin', 'the Dock is macOS-only');
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.evaluate(() => window.lightsApi.openPreferences());
  await windowByFile(h.app, 'settings.html');
  expect(await h.app.evaluate(({ app }) => app.dock.isVisible())).toBe(false);
});
