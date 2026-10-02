'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchApp, windowByFile } = require('./app');

// Actual Electron renderer acceptance, entirely synthetic. HOME also isolates
// optional read-only probes that do not use the app's per-run data override.
test('ordinary utilities stay in the main app and Widget configuration contains two tabs', async () => {
  const syntheticHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-utility-acceptance-'));
  const h = await launchApp({ extraArgs: ['--lights'], env: { HOME: syntheticHome, USERPROFILE: syntheticHome } });
  const errors = [];
  h.app.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const inspect = (file, script, query = null) => h.app.evaluate(async ({ webContents }, { file, script, query }) => {
    const page = webContents.getAllWebContents().find(w => {
      try { const u = new URL(w.getURL()); return u.pathname.endsWith('/' + file) && (!query || u.searchParams.get('view') === query); } catch { return false; }
    });
    if (!page) return null;
    return page.executeJavaScript(script);
  }, { file, script, query });
  const select = async id => {
    await inspect('sidebar.html', `window.buddy.select(${JSON.stringify(id)}); true`);
  };
  const windowCount = () => h.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().filter(w => !w.isDestroyed()).length);
  const evidence = process.env.PLEXIFORM_UTILITY_EVIDENCE;
  try {
    const widget = await windowByFile(h.app, 'index.html');
    const popup = await windowByFile(h.app, 'lights.html');
    await expect(popup.locator('#rule-count')).not.toHaveText('');
    await expect(popup.locator('.view-seg button:visible')).toHaveText(['Rules', 'Auto-answer']);
    await popup.locator('#view-auto').click();
    await expect(popup.locator('#main')).toHaveAttribute('data-view', 'auto');
    await popup.evaluate(() => window.lightsApi.onShowView); // preload is available
    await popup.evaluate(() => document.querySelector('#view-stats').click());
    await expect(popup.locator('#main')).toHaveAttribute('data-view', 'auto');
    await popup.locator('#view-rules').click();
    await widget.evaluate(() => window.trafficLight.openHelp());
    await expect.poll(() => inspect('help.html', '!!window.helpApi && document.querySelector("#close").hidden')).toBe(true);
    await expect.poll(() => windowCount()).toBe(3); // widget, main, sole utility popup
    for (const [id, file, ready, query] of [
      ['usage', 'lights.html', 'document.querySelector("#main").dataset.view === "mix" && document.querySelector("#usage-history").children.length > 0', 'mix'],
      ['stats', 'lights.html', 'document.querySelector("#main").dataset.view === "stats" && document.querySelector("#days-table tbody").children.length > 0', 'stats'],
      ['settings', 'settings.html', 'document.querySelector("#workingStaleMinutes").value.length > 0'],
      ['hatch', 'hatch.html', 'document.querySelector("#shape").children.length > 0'],
      ['feedback', 'feedback.html', '!!window.feedbackApi && !!document.querySelector("#save")'],
      ['updates', 'updates.html', '!!window.updates && document.body.innerText.includes("1.0.1")'],
      ['sessions', 'sessions.html', '!!window.sessionsApi && !!document.querySelector("#content")'],
    ]) {
      await select(id);
      await expect.poll(() => inspect(file, ready, query), { message: `${id} rendered in the main app` }).toBe(true);
      await expect(windowCount()).resolves.toBe(3);
      if (id === 'feedback') {
        const screenshot = await inspect(file, 'window.feedbackApi.screenshot("main")');
        expect(screenshot.dataUrl).toMatch(/^data:image\/png;base64,/);
      }
      if (id === 'usage' || id === 'stats') {
        expect(await inspect(file, 'getComputedStyle(document.querySelector(".view-seg")).display', query)).toBe('none');
        expect(await inspect(file, 'document.querySelector("#main").dataset.view', query)).toBe(query);
        await inspect(file, 'document.querySelector("#view-rules").click(); true', query);
        expect(await inspect(file, 'document.querySelector("#main").dataset.view', query)).toBe(query);
      }
    }
    await select('settings');
    await inspect('settings.html', 'document.querySelector("#workingStaleMinutes").value = "42"; document.querySelector("#workingStaleMinutes").dispatchEvent(new Event("change")); true');
    // Explicit form save proves settings mutations use the embedded owner.
    await inspect('settings.html', 'document.querySelector("#save").click(); true');
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(h.home, 'config.json'), 'utf8')).workingStaleMinutes).toBe(42);
    expect(errors).toEqual([]);
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      const png = await h.app.evaluate(async ({ webContents }) => {
        const contents = webContents.getAllWebContents().find(w => w.getURL().includes('/settings.html'));
        return (await contents.capturePage()).toPNG().toString('base64');
      });
      fs.writeFileSync(path.join(evidence, 'embedded-preferences.png'), Buffer.from(png, 'base64'));
      fs.writeFileSync(path.join(evidence, 'electron-receipt.json'), JSON.stringify({ synthetic: true, utilities: ['usage', 'stats', 'settings', 'help', 'hatch', 'feedback', 'updates', 'sessions'], ordinaryPopupTabs: ['Rules', 'Auto-answer'], windowCount: await windowCount(), errors }, null, 2));
    }
  } finally { await h.cleanup(); fs.rmSync(syntheticHome, { recursive: true, force: true }); }
});
