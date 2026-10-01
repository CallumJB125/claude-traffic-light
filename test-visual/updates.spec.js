// The update UI against fixture states, through the real windows. There is no
// updater service here: a dev run with CLAUDE_BUDDY_UPDATER_STUB serves one
// fixture over the same IPC contract (src/update-stub.js), and the tests push
// every other state to the renderers the way the service does.
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');
const states = require('../test/fixtures/updater-states.json').states;

let h;
let widget;
let page;
const log = [];

// "Last checked" is relative to now, so the fixture's fixed date would drift out of a baseline.
const fresh = (k) => k === 'error-expired' ? states[k] : ({ ...states[k], lastCheckedAt: states[k].lastCheckedAt && new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
const push = (state) => h.app.evaluate(({ webContents }, s) => { for (const w of webContents.getAllWebContents()) w.send('updater:state', s); }, state);
const show = async (k) => { await push(fresh(k)); await page.waitForTimeout(150); };

test.beforeAll(async () => {
  h = await launchApp({ env: { CLAUDE_BUDDY_UPDATER_STUB: 'idle-up-to-date', CLAUDE_BUDDY_UPDATER_STUB_DEFER: '1' } });
  h.app.process().stdout.on('data', (d) => log.push(...String(d).split('\n')));
  widget = await windowByFile(h.app, 'index.html');
  await widget.emulateMedia({ reducedMotion: 'no-preference' });
  await widget.evaluate(() => window.trafficLight.openUpdates());
  page = await windowByFile(h.app, 'updates.html');
  await page.waitForLoadState('load');
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test.afterAll(async () => { await h?.cleanup(); });

const PAGE_STATES = [
  'idle-up-to-date', 'idle-with-revert', 'available-manual-download', 'available-beta', 'downloading',
  'ready-restart', 'ready-swap-mac', 'ready-deb-manual', 'ready-deferred-busy', 'required-by-hub',
  'error-offline', 'error-signature', 'error-verify', 'error-downgrade', 'error-translocated',
  'error-not-writable', 'error-disk-full', 'error-server', 'error-unknown-update-failed',
  'ready-install-stalled', 'error-expired', 'idle-auto-download-on', 'ready-revert',
];

for (const k of PAGE_STATES) {
  test(`About & Updates renders ${k}`, async () => {
    await show(k);
    const s = states[k];
    if (s.error && ['signature', 'verify', 'downgrade'].includes(s.error.code)) {
      await expect(page.locator('#buttons button[data-action^="install"], #buttons button[data-action="download"]')).toHaveCount(0);
    }
    await expect(page).toHaveScreenshot(`updates-${k}.png`, { threshold: 0.05 });
  });
}

test('the page loads the state the service holds', async () => {
  await expect(page.locator('#name')).toHaveText('Plexiform');
});

test('release notes are plain text: nothing from the feed becomes markup', async () => {
  const hostile = { ...fresh('available-manual-download'), available: { ...states['available-manual-download'].available, notes: '- **bold** item\n<img src=x onerror="document.title=\'pwned\'">\n<script>document.title="pwned"</script>\n[click](https://evil.example/)' } };
  await push(hostile);
  await page.waitForTimeout(150);
  expect(await page.locator('#notes img, #notes script, #notes a').count()).toBe(0);
  expect(await page.title()).not.toBe('pwned');
  await expect(page.locator('#notes li b')).toHaveText('bold');
  await expect(page.locator('#notes')).toContainText('click');
});

test('buttons send the updater commands', async () => {
  await show('ready-restart');
  await page.locator('[data-action="install-idle"]').click();
  await expect.poll(() => log.some((l) => l.includes('[updater-stub] install {"when":"idle"}'))).toBe(true);
  // it says it is armed, and the button is spent
  await expect(page.locator('#message-text')).toHaveText("Will restart when you're not working with Claude.");
  await expect(page.locator('[data-action="install-idle"]')).toBeDisabled();
  await expect(page).toHaveScreenshot('updates-armed.png', { threshold: 0.05 });
  await show('available-manual-download');
  await page.locator('[data-action="download"]').click();
  await expect.poll(() => log.some((l) => l.includes('[updater-stub] download null'))).toBe(true);
  await page.locator('#auto-download').check();
  await expect.poll(() => log.some((l) => l.includes('[updater-stub] setAutoDownload true'))).toBe(true);
});

test('Beta asks first; Stable does not', async () => {
  await show('idle-up-to-date');
  await page.locator('[data-channel="beta"]').click();
  await expect(page.locator('#confirm-text')).toHaveText('Beta versions may be less stable. Switch to Beta?');
  expect(log.some((l) => l.includes('setChannel "beta"'))).toBe(false);
  await expect(page).toHaveScreenshot('updates-beta-confirm.png', { threshold: 0.05 });
  await page.locator('[data-action="cancel-confirm"]').click();
  await page.locator('[data-channel="beta"]').click();
  await page.locator('[data-action="confirm-beta"]').click();
  await expect.poll(() => log.some((l) => l.includes('[updater-stub] setChannel "beta"'))).toBe(true);
  await show('available-beta');
  await page.locator('[data-channel="stable"]').click();
  await expect.poll(() => log.some((l) => l.includes('[updater-stub] setChannel "stable"'))).toBe(true);
});

test('Revert explains itself and asks first', async () => {
  await show('idle-with-revert');
  await expect(page.locator('#revert-explain')).toHaveText('Installs 1.1.0 again and restarts Plexiform.');
  await page.locator('#revert').click();
  await expect(page.locator('#confirm-text')).toHaveText('Revert to 1.1.0? Plexiform will restart.');
  expect(log.some((l) => l.includes('[updater-stub] revert'))).toBe(false);
  await expect(page).toHaveScreenshot('updates-revert-confirm.png', { threshold: 0.05 });
  await page.locator('[data-action="confirm-revert"]').click();
  await expect.poll(() => log.some((l) => l.includes('[updater-stub] revert null'))).toBe(true);
  await show('downloading');
  await expect(page.locator('#revert-row')).toBeHidden();
  await push({ ...fresh('downloading'), canRevert: true, previousVersion: '1.0.0' });
  await expect(page.locator('#revert')).toBeDisabled();
});

test('restarting while a session is working asks first, and only then forces', async () => {
  await show('ready-deferred-busy');
  await page.locator('[data-action="install-now"]').click();
  await expect(page.locator('#confirm-text')).toHaveText('A session in claude-traffic-light is working. Restart anyway?');
  await expect(page).toHaveScreenshot('updates-restart-confirm.png', { threshold: 0.05 });
  expect(log.some((l) => l.includes('"force":true'))).toBe(false);
  await page.locator('[data-action="cancel-confirm"]').click();
  await expect(page.locator('#confirm')).toBeHidden();
  await page.locator('[data-action="install-now"]').click();
  await page.locator('[data-action="install-force"]').click();
  await expect.poll(() => log.some((l) => l.includes('[updater-stub] install {"when":"now","force":true}'))).toBe(true);
});

test('a deferred answer that arrives before the busy state still asks; "when idle" never does', async () => {
  await show('ready-restart');
  await page.locator('[data-action="install-now"]').click();
  await expect(page.locator('#confirm-text')).toHaveText('A session is working. Restart anyway?');
  await page.locator('[data-action="cancel-confirm"]').click();
  await show('idle-up-to-date');
  await expect(page.locator('#confirm')).toBeHidden();
  await show('ready-restart');
  await page.locator('[data-action="install-idle"]').click();
  await expect(page.locator('#confirm')).toBeHidden();
});

test('a repeated identical state does not repaint the page', async () => {
  await show('ready-restart');
  await page.evaluate(() => { window.__marker = document.querySelector('[data-action="install-now"]'); });
  await push(fresh('ready-restart'));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__marker === document.querySelector('[data-action="install-now"]'))).toBe(true);
});

const bodyH = () => widget.evaluate(() => innerHeight);

test('the widget shows a quiet "Update ready" row only when ready', async () => {
  await push(fresh('available-manual-download'));
  await widget.waitForTimeout(300);
  expect(await bodyH()).toBe(200);
  await push(fresh('ready-restart'));
  await expect.poll(bodyH).toBe(200 + 72);
  await expect(widget.locator('#update-text')).toHaveText('Update ready');
  await expect(widget.locator('#update-sub')).toHaveText("Plexiform won't restart mid-task");
  // a fixed pointer, so the hover-only gear and ? look the same whatever ran before
  await widget.mouse.move(100, 20);
  await widget.waitForTimeout(600);
  await expect(widget).toHaveScreenshot('widget-update-ready.png', { threshold: 0.05 });
  await widget.locator('#update-btn').click();
  await expect.poll(() => log.filter((l) => l.includes('[updater-stub] install {"when":"idle"}')).length).toBeGreaterThan(1);
  await expect(widget.locator('#update-sub')).toHaveText("Will restart when you're not working with Claude");
  await expect(widget.locator('#update-btn')).toBeHidden();
  await widget.waitForTimeout(300);
  await expect(widget).toHaveScreenshot('widget-update-armed.png', { threshold: 0.05 });
  await push(fresh('idle-up-to-date'));
  await expect.poll(bodyH).toBe(200);
});

test('the row is solid to the mouse, so clicks land on it and not the window behind', async () => {
  await push(fresh('ready-restart'));
  await expect.poll(bodyH).toBe(200 + 72);
  const box = await widget.locator('#update').boundingBox();
  const at = (x, y) => widget.evaluate(([px, py]) => solidAt(px, py), [x, y]);
  expect(await at(box.x + box.width / 2, box.y + 6)).toBe(true);
  expect(await at(box.x + 8, box.y + box.height - 8)).toBe(true);
  await push(fresh('idle-up-to-date'));
  await expect.poll(bodyH).toBe(200);
});

// The strip under Claude: the waiting-input bubble first, then the recap,
// then this row. While something waits, the row steps aside; once nothing
// does, it is back and its buttons take clicks.
test('a waiting input takes the strip; the update row comes back after it, solid and clickable', async () => {
  const F = require('./inputs-fixtures');
  await push(fresh('ready-restart'));
  await expect.poll(bodyH).toBe(200 + 72);
  F.hookSync(h, 'notification', { session_id: 'upd-ask', cwd: '/visual/app', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' });
  await expect(widget.locator('#bubble .ib-item')).toHaveCount(1, { timeout: 10000 });
  await expect(widget.locator('#update')).toBeHidden();
  F.clearSessions(h);
  await expect(widget.locator('#bubble .ib-item')).toHaveCount(0, { timeout: 10000 });
  await expect(widget.locator('#update')).toBeVisible();
  await expect.poll(bodyH).toBe(200 + 72);
  const box = await widget.locator('#update-btn').boundingBox();
  expect(await widget.evaluate(([px, py]) => solidAt(px, py), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
  await push(fresh('idle-up-to-date'));
  await expect.poll(bodyH).toBe(200);
});

test('resizing with the update row showing resizes the widget and keeps the row, clickable; saved bounds stay the widget’s own', async () => {
  const fs = require('fs');
  const path = require('path');
  await push(fresh('ready-restart'));
  await expect.poll(bodyH).toBe(200 + 72);
  const w0 = await widget.evaluate(() => innerWidth);
  await widget.evaluate(() => window.trafficLight.resizeWindowBy(1.25));
  await expect.poll(() => widget.evaluate(() => innerWidth)).toBe(Math.round(w0 * 1.25));
  const h1 = await bodyH();
  const w1 = await widget.evaluate(() => innerWidth);
  expect(h1).toBe(Math.round(w1 / (64 / 82)) + 72);
  await expect(widget.locator('#update')).toBeVisible();
  const box = await widget.locator('#update-btn').boundingBox();
  expect(await widget.evaluate(([px, py]) => solidAt(px, py), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(h.home, 'window-bounds.json'), 'utf8')).height).toBe(h1 - 72);
  await widget.evaluate(() => window.trafficLight.resizeWindowBy(0.8));
  await expect.poll(() => widget.evaluate(() => innerWidth)).toBe(w0);
  await push(fresh('idle-up-to-date'));
  // A resize keeps the widget's shape, so it ends at the shape's height, not
  // the fixture's square 200 x 200: put the fixture back for the next test.
  await expect.poll(bodyH).toBe(Math.round(w0 / (64 / 82)));
  await h.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().split('?')[0].endsWith('index.html')); const b = w.getBounds(); w.setAspectRatio(0); w.setBounds({ ...b, width: 200, height: 200 }); });
  await expect.poll(bodyH).toBe(200);
});

test('"Later" hides the row until the state changes', async () => {
  await push(fresh('ready-restart'));
  await expect.poll(bodyH).toBe(200 + 72);
  await widget.locator('#update-later').click();
  await expect.poll(bodyH).toBe(200);
  await push(fresh('ready-restart'));
  await widget.waitForTimeout(300);
  expect(await bodyH()).toBe(200);
  await push(fresh('ready-swap-mac'));
  await expect.poll(bodyH).toBe(200 + 72);
  await push(fresh('idle-up-to-date'));
  await expect.poll(bodyH).toBe(200);
});

test('the widget asks for a one-click update when the team board needs one', async () => {
  await push({ ...fresh('required-by-hub'), status: 'ready', available: states['ready-restart'].available });
  await expect.poll(bodyH).toBe(200 + 72);
  await expect(widget.locator('#update-text')).toHaveText('Update Plexiform to keep using your team board (Acme team needs 1.2.0)');
  await widget.mouse.move(100, 20);
  await widget.waitForTimeout(600);
  await expect(widget).toHaveScreenshot('widget-update-hub.png', { threshold: 0.05 });
  const before = log.filter((l) => l.includes('install {"when":"now"}')).length;
  await widget.locator('#update-btn').click();
  // a session is working (the stub says so): it does not interrupt, it waits for a quiet moment and says so
  await expect.poll(() => log.filter((l) => l.includes('install {"when":"now"}')).length).toBe(before + 1);
  await expect(widget.locator('#update-sub')).toHaveText("Will restart when you're not working with Claude");
  await push(fresh('idle-up-to-date'));
  await expect.poll(bodyH).toBe(200);
});

test('an available update the team board needs opens the page that can download it', async () => {
  await push(fresh('required-by-hub'));
  await expect.poll(bodyH).toBe(200 + 72);
  await expect(widget.locator('#update-btn')).toHaveText('Open updates');
  await push(fresh('idle-up-to-date'));
  await expect.poll(bodyH).toBe(200);
});
