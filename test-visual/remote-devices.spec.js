const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { launchApp, status, windowByFile } = require('./app');
const Protocol = require('../hooks/remote-protocol.js');

// A fixed, already-paired device, so the list renders the same every run.
const DEVICE = { id: 'devbox-0a1b2c', name: 'devbox', token: 'ab'.repeat(32), createdAt: '2026-09-30T09:00:00.000Z', confirmedAt: '2026-09-30T09:01:00.000Z' };
const seeded = () => launchApp({ files: { 'devices.json': JSON.stringify({ v: 1, devices: [DEVICE] }) } });

// Each test launches its own app: none depends on another having run.
let h;
test.afterEach(async () => { await h?.cleanup(); h = null; });

async function postEvent(port) {
  const body = Buffer.from(JSON.stringify(Protocol.envelope('session', DEVICE.id, { events: [{ source: 'claude', sessionId: 'tmux-1', seq: 1, signal: 'tool-use', tool: 'Bash', cwd: '/srv/api' }] })));
  return fetch(`http://127.0.0.1:${port}/remote/event`, { method: 'POST', headers: Protocol.signedHeaders({ device: DEVICE.id, token: DEVICE.token, body }), body });
}

async function openSection(app) {
  const widget = await windowByFile(app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await windowByFile(app, 'lights.html');
  await lights.evaluate(() => window.lightsApi.openPreferences());
  const settings = await windowByFile(app, 'settings.html');
  await settings.waitForLoadState('load');
  const section = settings.locator('#remote-devices');
  await section.scrollIntoViewIfNeeded();
  return { settings, section };
}

// The port is per run (the hermetic launcher picks a free one).
const shot = (section, name, extra = []) => expect(section).toHaveScreenshot(name, { mask: [section.locator('.remote-port'), section.locator('#remote-listener'), ...extra] });

test('a signed remote event shows as a namespaced session', async () => {
  h = await seeded();
  await windowByFile(h.app, 'index.html');
  expect((await postEvent(h.remotePort)).status).toBe(200);
  await expect.poll(async () => (await status(h.port)).sessions).toEqual([expect.objectContaining({ signal: 'tool-use', cwd: '/srv/api' })]);
  expect(fs.readdirSync(path.join(h.home, 'remote', DEVICE.id)).filter((f) => f.endsWith('.json'))).toHaveLength(1);
});

test('settings: remote devices section lists the paired device', async () => {
  h = await seeded();
  await windowByFile(h.app, 'index.html');
  expect((await postEvent(h.remotePort)).status).toBe(200);
  const { settings, section } = await openSection(h.app);
  await expect(section.locator('#remote-list li')).toHaveCount(1);
  await expect(section.locator('#remote-list li')).toContainText('1 live session');
  await settings.waitForTimeout(300);
  await shot(section, 'settings-remote-devices.png');
});

test('settings: a new pairing shows its code once, in its own panel', async () => {
  h = await launchApp();
  const { settings, section } = await openSection(h.app);
  await section.locator('#remote-name').fill('laptop');
  await section.locator('#remote-pair').click();
  await expect(section.locator('#remote-code')).toBeVisible();
  await expect(section.locator('#remote-code-text')).toContainText('buddy-pair-v1.laptop-');
  await expect(section.locator('#remote-list li')).toContainText('Waiting for the device to use its code');
  await settings.waitForTimeout(300);
  // The code is random every run.
  await shot(section, 'settings-remote-pairing-code.png', [section.locator('#remote-code-text')]);
  await section.locator('#remote-done').click();
  await expect(section.locator('#remote-code')).toBeHidden();
  await expect(section.locator('#remote-code-text')).toHaveText('');
});

test('settings: revoke asks once more, in danger colours, and says so aloud', async () => {
  h = await seeded();
  const { settings, section } = await openSection(h.app);
  const revoke = section.locator('#remote-list li button');
  await revoke.click();
  await expect(revoke).toHaveText('Revoke now?');
  await expect(revoke).toHaveClass(/armed/);
  await expect(section.locator('#remote-pair-status')).toHaveText('Click again to revoke devbox. Its key stops working at once.');
  await settings.mouse.move(0, 0);
  await shot(section, 'settings-remote-revoke-armed.png');
  await revoke.click();
  await expect(section.locator('#remote-list li')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(path.join(h.home, 'devices.json'), 'utf8')).devices).toEqual([]);
});
