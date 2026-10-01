// Hatch in the real app: Lights → Body → "+ Hatch" opens the window, a character
// is made from choices, saved to the data dir, and shows up as a Body option;
// it can be deleted again. The window is strict-CSP and sandboxed, and the
// page can only send choices, never art.
const fs = require('fs');
const path = require('path');
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
});
test.afterAll(async () => { await h?.cleanup(); });

const charDir = (id) => path.join(h.home, 'characters', id);

test('Hatch: choices in, a saved character out, picked in Lights, deleted again', async () => {
  await expect(lights.locator('#bodies .posebtn').first()).toBeVisible({ timeout: 15000 });
  await lights.locator('#bodies .addhatch').click();
  const hatch = await windowByFile(h.app, 'hatch.html');
  await hatch.waitForLoadState('load');

  // no AI yet: the description box says so instead of pretending
  await expect(hatch.locator('#desc')).toBeDisabled();
  await expect(hatch.locator('#desc-hint')).toContainText('needs an AI');

  // the page cannot reach the network or run inline script
  const csp = await hatch.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
  expect(csp).toMatch(/default-src 'none'/);
  expect(csp).toMatch(/script-src 'self'/);
  expect(csp).toMatch(/connect-src 'none'/);

  await hatch.fill('#name', 'Otter');
  await hatch.locator('.seg[id=shape] label', { hasText: 'animal' }).click();
  await hatch.locator('.seg[id=accessory] label', { hasText: 'bow' }).click();
  await hatch.evaluate(() => { const c = document.getElementById('color'); c.value = '#4f9be0'; c.dispatchEvent(new Event('input', { bubbles: true })); });
  // the preview is the real rig wearing the new character
  await expect(hatch.locator('#stage svg.rig')).toBeVisible();
  await expect.poll(() => hatch.evaluate(() => document.querySelector('#stage svg.rig')?.className.baseVal), { timeout: 10000 }).toContain('body-u-otter');

  await hatch.click('#save');
  await expect(hatch.locator('#status')).toContainText('Saved as Otter', { timeout: 10000 });
  expect(fs.existsSync(path.join(charDir('u-otter'), 'character.json'))).toBe(true);
  const saved = JSON.parse(fs.readFileSync(path.join(charDir('u-otter'), 'character.json'), 'utf8'));
  expect(saved).toMatchObject({ id: 'u-otter', name: 'Otter', contract: 1 });
  expect(JSON.stringify(saved)).not.toMatch(/script|onload|href/);
  if (process.platform !== 'win32') expect(fs.statSync(path.join(charDir('u-otter'), 'character.json')).mode & 0o777).toBe(0o600);

  // saving again gives a second character with a free id, never an overwrite
  await hatch.click('#save');
  await expect(hatch.locator('#status')).toContainText('Saved as Otter', { timeout: 10000 });
  expect(fs.existsSync(path.join(charDir('u-otter-2'), 'character.json'))).toBe(true);

  // Lights learns about both without a restart
  await expect(lights.locator('#bodies .posebtn[title="u-otter"]')).toBeVisible({ timeout: 10000 });
  await expect(lights.locator('#bodies .posebtn[title="u-otter-2"]')).toBeVisible();
  await expect(lights.locator('#bodies .posebtn[title="u-otter"] span')).toHaveText('Otter');

  // it can be chosen as the body of a rule
  await lights.locator('#bodies .posebtn[title="u-otter"]').click();
  await expect(lights.locator('#bodies .posebtn[title="u-otter"]')).toHaveClass(/\bon\b/);

  await hatch.click('#close');
  await expect.poll(() => h.app.windows().some((p) => !p.isClosed() && p.url().includes('hatch.html'))).toBe(false);

  // delete the second one: two clicks (arm, then confirm), then it is gone from the picker and the disk
  const cell = lights.locator('#bodies .posecell', { has: lights.locator('.posebtn[title="u-otter-2"]') });
  await cell.hover();
  await cell.locator('.face-x').click();
  await expect(cell.locator('.face-x')).toHaveText('delete?');
  await cell.locator('.face-x').click();
  await expect(lights.locator('#bodies .posebtn[title="u-otter-2"]')).toHaveCount(0, { timeout: 10000 });
  expect(fs.existsSync(charDir('u-otter-2'))).toBe(false);
  expect(fs.existsSync(charDir('u-otter'))).toBe(true);
});

test('Hatch: only Lights can open it, and a planted character file is validated, not trusted', async () => {
  // a file dropped in the folder is parsed as data and sanitised like a fresh Hatch
  const dir = charDir('u-planted');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ id: 'u-planted', name: 'Planted', contract: 1, anchors: {}, sprite: { body: '<script>alert(1)</script>' } }));
  const listed = await lights.evaluate(() => window.userCharacters.list());
  expect(listed.map((c) => c.id)).not.toContain('u-planted');
  expect(listed.map((c) => c.id)).toContain('u-otter');
  // the widget window has no way to open it
  const widget = await windowByFile(h.app, 'index.html');
  expect(await widget.evaluate(() => typeof (window.trafficLight.openHatch))).toBe('undefined');
});
