// "Start from a template" in the Lights presets menu: picking one stages its
// rules unsaved, and Revert brings the saved set back.
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');

let h;
let lights;

test.beforeAll(async () => {
  h = await launchApp();
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openLights());
  lights = await windowByFile(h.app, 'lights.html');
  await lights.waitForLoadState('load');
  await lights.waitForTimeout(1200);
});

test.afterAll(async () => { await h?.cleanup(); });

test('the template picker lists the five roles', async () => {
  await lights.click('#presets-btn');
  await expect(lights.locator('#templates button')).toHaveText([/Solo dev/, /Team lead/, /Pair with Claude all day/, /Minimal/, /Show-off/]);
  await expect(lights).toHaveScreenshot('lights-templates-menu.png');
});

test('a template loads unsaved and Revert undoes it', async () => {
  const names = () => lights.locator('#rule-list li').allTextContents();
  await lights.keyboard.press('Escape');
  const before = await names();
  await lights.click('#presets-btn');
  await lights.click('#templates [data-template=minimal]');
  await expect(lights.locator('#save-state')).toContainText('Revert to undo');
  expect(await names()).not.toEqual(before);
  await lights.waitForTimeout(2500);
  await expect(lights).toHaveScreenshot('lights-template-minimal.png');
  await lights.click('#revert-btn');
  expect(await names()).toEqual(before);
});
