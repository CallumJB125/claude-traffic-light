// The update UI against the REAL updater service and its per-page sender
// allowlist (no stub): the page embedded in the Plexiform window, the
// standalone window and the widget must each be let in, and only as far as
// their page is trusted. Nothing here touches the network: no check is run.
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');

let h;

test.beforeAll(async () => { h = await launchApp(); });

// Open the Plexiform window the way a second launch does, then click "About & Updates" in its sidebar.
async function openEmbedded() {
  await h.app.evaluate(({ app }) => { app.emit('second-instance', {}, ['--buddy']); });
  await poll('sidebar.html', false, "window.buddy.select('updates'), true");
}
test.afterAll(async () => { await h?.cleanup(); });

// Run code inside the page whose URL ends in `file` and which is (or is not) a standalone window.
const inWebContents = (file, standalone, js) => h.app.evaluate(async ({ webContents, BrowserWindow }, [f, alone, code]) => {
  const owned = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id));
  const wc = webContents.getAllWebContents().find((c) => c.getURL().split('?')[0].endsWith(f) && owned.has(c.id) === alone);
  if (!wc) return { missing: true };
  return wc.executeJavaScript(code);
}, [file, standalone, js]);

const poll = async (file, standalone, js) => {
  let r;
  await expect.poll(async () => { r = await inWebContents(file, standalone, js); return !r?.missing; }, { timeout: 15000 }).toBe(true);
  return r;
};

test('the Updates page embedded in the Plexiform window gets real state and may run commands', async () => {
  await openEmbedded();
  const state = await poll('updates.html', false, 'window.updates.getState()');
  expect(state.status).toBe('idle');
  expect(state.currentVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(state.installKind).toBeTruthy();
  // not "forbidden": the full command set is open to this page (a setting, so no network)
  expect(await poll('updates.html', false, 'window.updates.setAutoDownload(false)')).toEqual({ ok: true });
  expect(await poll('updates.html', false, 'document.getElementById("headline").textContent')).toBeTruthy();
  // moving to another local page and back (lockLocal and the navigation guard must not fight)
  await poll('sidebar.html', false, "window.buddy.select('thismac'), true");
  await poll('account.html', false, 'document.title');
  await poll('sidebar.html', false, "window.buddy.select('updates'), true");
  expect((await poll('updates.html', false, 'window.updates.getState()')).status).toBe('idle');
});

test('the standalone window and the widget are let in too, the widget only as far as it is trusted', async () => {
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openUpdates());
  await windowByFile(h.app, 'updates.html');
  const state = await poll('updates.html', true, 'window.updates.getState()');
  expect(state.status).toBe('idle');
  expect(await poll('updates.html', true, 'window.updates.setAutoDownload(false)')).toEqual({ ok: true });
  expect((await widget.evaluate(() => window.trafficLight.getUpdaterState())).status).toBe('idle');
});

test('no page of ours loads the updater page in a frame', async () => {
  const frames = await h.app.evaluate(({ webContents }) => webContents.getAllWebContents().flatMap((c) => c.mainFrame.framesInSubtree.filter((f) => f !== c.mainFrame).map((f) => f.url)));
  expect(frames.filter((u) => u.includes('updates.html'))).toEqual([]);
});
