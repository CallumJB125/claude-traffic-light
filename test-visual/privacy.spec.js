const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');

let h;

test.beforeAll(async () => { h = await launchApp(); });
test.afterAll(async () => { await h?.cleanup(); });

test('settings Privacy section shows the draft notice', async () => {
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.evaluate(() => window.lightsApi.openPreferences());
  const settings = await windowByFile(h.app, 'settings.html');
  await settings.waitForLoadState('load');
  await settings.locator('#privacy-notice summary').click();
  await expect(settings.locator('#privacy-body blockquote')).toContainText('DRAFT');
  await settings.evaluate(() => document.querySelector('#privacy').previousElementSibling.scrollIntoView({ block: 'start' }));
  await settings.waitForTimeout(600);
  await expect(settings).toHaveScreenshot('settings-privacy.png');
});
