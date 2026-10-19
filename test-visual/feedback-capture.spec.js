
'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { launchApp, windowByFile } = require('./app');
test('newly selected own main view captures after paint repeatedly without additional app windows', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-feedback-capture-'));
  const h = await launchApp({ env: { HOME: home, USERPROFILE: home } });
  const inspect = (file, js) => h.app.evaluate(async ({ webContents }, { file, js }) => {
    const page = webContents.getAllWebContents().find(w => { try { return new URL(w.getURL()).pathname.endsWith('/' + file); } catch { return false; } });
    return page ? page.executeJavaScript(js) : null;
  }, { file, js });
  const select = id => inspect('sidebar.html', `window.buddy.select(${JSON.stringify(id)}); true`);
  try {
    await windowByFile(h.app, 'index.html');
    // The widget's authorized menu route opens the main shell in dev profile.
    await inspect('index.html', 'window.trafficLight.openHelp(); true');
    await expect.poll(() => inspect('sidebar.html', '!!window.buddy')).toBe(true);
    const count = () => h.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().filter(w => !w.isDestroyed()).length);
    const before = await count();
    for (const id of ['settings', 'usage', 'stats', 'hatch', 'settings', 'usage']) {
      await select(id);
      await select('feedback');
      await expect.poll(() => inspect('feedback.html', '!!window.feedbackApi')).toBe(true);
      const result = await inspect('feedback.html', 'window.feedbackApi.screenshot("main")');
      expect(result.error).toBeUndefined(); expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
      expect(Buffer.from(result.dataUrl.split(',')[1], 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      await inspect('feedback.html', 'window.feedbackApi.clearScreenshot(); true');
    }
    expect(await count()).toBe(before);
  } finally { await h.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});
