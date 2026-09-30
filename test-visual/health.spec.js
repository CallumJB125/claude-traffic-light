// Preferences → Health, healthy and failing. The reports are built here with
// the real runChecks against a fake machine and served in place of the app's
// own (which would read this machine's hooks and disk), so the shots only
// change when the checks or the panel do.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchApp, windowByFile } = require('./app');
const Health = require('../src/health.js');
const Claude = require('../adapters/claude-code.js');
const Runtime = require('../adapters/runtime.js');

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const GB = 1024 ** 3;

function fakeMachine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-health-'));
  const root = path.join(home, '.claude-traffic-light');
  const contents = path.join(home, 'Applications', 'Claude Buddy.app', 'Contents');
  const hooksDir = path.join(contents, 'Resources', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(path.join(contents, 'MacOS'));
  fs.writeFileSync(path.join(hooksDir, 'set-status.js'), '');
  fs.writeFileSync(path.join(contents, 'MacOS', 'Claude Buddy'), '');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  const project = path.join(home, '.claude', 'projects', '-w-app');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'a.jsonl'), '');
  const runtime = Runtime.make({ execPath: path.join(contents, 'MacOS', 'Claude Buddy'), hooksDir, dataDir: root, platform: 'darwin' });
  const ctx = {
    now: NOW, home, root, runtime, version: '1.0.0',
    mcp: { installed: true, current: true, path: path.join(home, '.claude.json'), error: null },
    signal: { listening: true, port: 47172 },
    statfs: () => ({ bavail: (182.4 * GB) / 4096, bsize: 4096 }),
  };
  return { home, root, runtime, ctx };
}

function healthyReport() {
  const m = fakeMachine();
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(Claude.apply({}, m.runtime)));
  fs.writeFileSync(path.join(m.root, 'sessions', 'a.json'), JSON.stringify({ sessionId: 'a', signal: 'tool-use', updatedAt: new Date(NOW - 3 * 60000).toISOString() }));
  return Health.runChecks(m.ctx);
}

// The app was moved after its hooks were installed, a hook died holding a
// lock, the port is taken, the integration is off and the disk is nearly full.
function failingReport() {
  const m = fakeMachine();
  const moved = Runtime.make({ execPath: '/Volumes/Old/Claude Buddy.app/Contents/MacOS/Claude Buddy', hooksDir: '/Volumes/Old/Claude Buddy.app/Contents/Resources/hooks', dataDir: m.root, platform: 'darwin' });
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(Claude.apply({}, moved)));
  const lock = path.join(m.root, 'sessions', 'a.json.lock');
  fs.writeFileSync(lock, 'x');
  fs.utimesSync(lock, (NOW - 60000) / 1000, (NOW - 60000) / 1000);
  fs.writeFileSync(path.join(m.root, 'last-hook.json'), JSON.stringify({ at: new Date(NOW - 26 * 3600000).toISOString() }));
  return Health.runChecks({
    ...m.ctx,
    mcp: { installed: false, current: false, path: path.join(m.home, '.claude.json'), error: null },
    signal: { listening: false, port: 47172, error: 'EADDRINUSE' },
    statfs: () => ({ bavail: (150 * 1024 * 1024) / 4096, bsize: 4096 }),
  });
}

let h;
let settings;

test.beforeAll(async () => {
  h = await launchApp();
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.evaluate(() => window.lightsApi.openPreferences());
  settings = await windowByFile(h.app, 'settings.html');
  await settings.waitForLoadState('load');
});

test.afterAll(async () => { await h?.cleanup(); });

// What the tray's Health… does to an open Preferences window.
async function showHealth(report) {
  await h.app.evaluate(({ ipcMain, BrowserWindow }, r) => {
    ipcMain.removeHandler('health-report');
    globalThis.healthRuns = 0;
    ipcMain.handle('health-report', () => { globalThis.healthRuns += 1; return r; });
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('settings.html')).webContents.send('show-section', 'health');
  }, report);
  await expect(settings.locator('#health .check')).toHaveCount(8);
  // All the way down, so the sticky Save bar sits below the panel rather
  // than across it (an element shot scrolls only just far enough).
  await settings.evaluate(() => { document.body.scrollTop = 1e6; document.documentElement.scrollTop = 1e6; });
  await settings.waitForTimeout(400);
}

test('health panel: everything fine', async () => {
  const report = healthyReport();
  await showHealth(report);
  await expect(settings.locator('#health-summary')).toHaveText('Everything looks fine');
  await expect(settings.locator('#health-checks button')).toHaveCount(0);
  // Health… reruns once; its scroll into view must not run the checks again.
  expect(await h.app.evaluate(() => globalThis.healthRuns)).toBe(1);
  await expect(settings.locator('#health')).toHaveScreenshot('health-healthy.png');
});

test('health panel: failing checks carry a fix or a next step', async () => {
  const report = failingReport();
  await showHealth(report);
  await expect(settings.locator('#health-summary')).toHaveText('5 things need attention');
  await expect(settings.locator('#health-checks button')).toHaveText(['Reinstall hooks', 'Clear stale lock', 'Enable Claude integration']);
  await expect(settings.locator('[data-check="hooks"] .detail')).toContainText('moved or deleted');
  await expect(settings.locator('#health-fine summary')).toContainText('3 checks fine');
  // Compact: the whole failing panel fits well inside the 820 px window.
  expect((await settings.locator('#health').boundingBox()).height).toBeLessThan(480);
  await expect(settings.locator('#health')).toHaveScreenshot('health-failing.png');
});

test('health panel: Clear stale lock runs against the data folder and rechecks', async () => {
  const lock = path.join(h.home, 'sessions', 'x.json.lock');
  fs.writeFileSync(lock, 'x');
  const t = (Date.now() - 60000) / 1000;
  fs.utimesSync(lock, t, t);
  await showHealth(failingReport());
  await settings.locator('#health-checks button', { hasText: 'Clear stale lock' }).click();
  await expect.poll(() => fs.existsSync(lock)).toBe(false);
  // The recheck is the app's own report now; this spec's override is only the
  // first load's.
  await expect(settings.locator('[data-check="sessions"]')).toHaveAttribute('data-status', 'ok');
});

test('health panel: Copy diagnostics puts a scrubbed report on the clipboard', async () => {
  const saved = await h.app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await settings.locator('#health-copy').click();
    await expect(settings.locator('#health-copy-hint')).toContainText('Copied');
    const text = await h.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(text).toMatch(new RegExp(`^${require('../brand.js').name} diagnostics\n`));
    expect(text).toContain('Checks:');
    expect(text).not.toContain(os.homedir());
    expect(text).not.toContain(h.home);
  } finally {
    await h.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), saved);
  }
});
