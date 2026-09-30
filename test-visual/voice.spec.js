// Push-to-talk widget states. The voice states are pushed straight to the
// widget the way main does after the helper reports, so no microphone, speech
// permission or `say` is ever involved.
const { test, expect } = require('@playwright/test');
const { launchApp, signal, status, windowByFile } = require('./app');

let h;
let widget;

test.beforeAll(async () => {
  h = await launchApp();
  widget = await windowByFile(h.app, 'index.html');
  await widget.emulateMedia({ reducedMotion: 'no-preference' });
  await signal(h, { signal: 'tool-use', session: 'visual', source: 'claude', cwd: '/visual', tool: 'Bash' });
  await expect.poll(async () => (await status(h.port)).look.lamp).toBe('green');
  await widget.waitForTimeout(600);
});

test.afterAll(async () => { await h?.cleanup(); });

async function voice(st) {
  await h.app.evaluate(({ BrowserWindow }, s) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().endsWith('index.html')) w.webContents.send('voice-state', s);
  }, st);
  await widget.waitForTimeout(400);
}

const SHOT = { threshold: 0.05 };

test('widget shows the mic badge while listening', async () => {
  await voice({ state: 'listening', partial: "what's blocked" });
  await expect(widget.locator('#mic')).toBeVisible();
  await expect(widget).toHaveScreenshot('widget-voice-listening.png', SHOT);
});

test('widget opens its mouth while talking, with the badge gone', async () => {
  await voice({ state: 'talking', heard: "what's blocked", text: 'Nothing is blocked.' });
  await expect(widget.locator('#mic')).toBeHidden();
  expect(await widget.evaluate(() => document.querySelector('svg.rig').classList.contains('talking'))).toBe(true);
  await expect(widget).toHaveScreenshot('widget-voice-talking.png', SHOT);
});

test('idle clears both', async () => {
  await voice({ state: 'idle' });
  await expect(widget.locator('#mic')).toBeHidden();
  expect(await widget.evaluate(() => document.querySelector('svg.rig').classList.contains('talking'))).toBe(false);
});
