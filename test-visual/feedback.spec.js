// "Something's off / Idea": opened from Preferences, filled in, a screenshot
// ticked (preview shown), saved into the temp data dir, and the folder checked.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { launchApp, windowByFile } = require('./app');

// Assembled from fragments so no token-shaped literal sits in the source.
const FAKE = ['gh', 'p_', 'a1B2c3D4e5'.repeat(3), 'x1Y2z3'].join('');

let h;
let form;

test.beforeAll(async () => {
  h = await launchApp();
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.evaluate(() => window.lightsApi.openPreferences());
  const settings = await windowByFile(h.app, 'settings.html');
  await settings.waitForLoadState('load');
  await settings.locator('#feedback-open').click();
  form = await windowByFile(h.app, 'feedback.html');
  await form.waitForLoadState('load');
  await form.setViewportSize({ width: 440, height: 720 });
});

test.afterAll(async () => { await h?.cleanup(); });

test('the empty form, then filled in', async () => {
  await expect(form.locator('#save')).toBeVisible();
  await expect(form.locator('#shot-on')).not.toBeChecked();
  await expect(form.locator('#diag-on')).toBeChecked();
  await form.fill('#text', 'The lamp stayed red after I answered.');
  await form.fill('#expected', 'It should have gone green.');
  await form.locator('input[value="idea"]').check();
  await form.locator('input[value="off"]').check();
  await expect(form).toHaveScreenshot('feedback-form.png');
});

test('ticking the screenshot shows a preview and says which window', async () => {
  await form.locator('#shot-on').check();
  await expect(form.locator('#shot')).toBeVisible({ timeout: 10000 });
  await expect(form.locator('#shot-caption')).toContainText('Only Plexiform');
  expect(await form.locator('#shot-which option').count()).toBeGreaterThan(0);
});

test('"See what\'s included" shows the scrubbed text', async () => {
  await form.fill('#text', `It broke with ${FAKE} set.`);
  await form.locator('#see').click();
  await expect(form.locator('#included')).toBeVisible();
  const shown = await form.locator('#included').textContent();
  expect(shown).toContain('diagnostics');
  expect(shown).not.toContain(FAKE);
  expect(shown).toContain('[redacted]');
});

test('saving writes report.md (scrubbed), diagnostics.txt and a real PNG', async () => {
  await form.locator('#save').click();
  await expect(form.locator('#done')).toBeVisible({ timeout: 10000 });
  await expect(form.locator('#github')).toBeHidden();
  const root = path.join(h.home, 'feedback');
  const [name] = fs.readdirSync(root);
  expect(name).toMatch(/-off$/);
  const dir = path.join(root, name);
  expect(fs.readdirSync(dir).sort()).toEqual(['diagnostics.txt', 'report.md', 'screenshot.png']);
  const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  expect(report).toContain('It broke with');
  expect(report).toContain('[redacted]');
  expect(report).not.toContain(FAKE);
  expect(fs.readFileSync(path.join(dir, 'diagnostics.txt'), 'utf8')).not.toContain(FAKE);
  expect(fs.readFileSync(path.join(dir, 'screenshot.png')).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  await form.locator('#copy').click();
  await expect(form.locator('#status')).toHaveText('Copied.');
  const clip = await h.app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clip).toContain('# Something');
  expect(clip).toContain('diagnostics');
});

test('"Send to your team\'s board" with no team says to join one and keeps the report', async () => {
  await form.locator('#board').click();
  await expect(form.locator('#status')).toHaveText('Join a team to send feedback to its board. Your report is saved on this computer.');
  await expect(form.locator('#copy')).toBeVisible();
});
