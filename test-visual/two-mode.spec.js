'use strict';
// C4's AC: with chats off ("Show chats" / homeComposer false), Sessions, Overview, the widget and the board behave
// byte for byte as before. One launch per gate state, compared against itself (no baselines; review S1):
//   shoot A (chats on) → flip through the real Settings save → shoot B (chats off) → flip back → shoot A'.
// A === A' first (the harness is stable), then A === B. The main signal is each document's body.outerHTML; the
// PNGs are compared too. Reduced motion, a hidden caret and fixed Sessions rows keep the shots still.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile, embedded, openSettingsPane } = require('./app');

const GATE = { CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW: '1' };
const ROW = { provider: 'Claude Code', project: 'website', group: { key: 'k', heading: 'website', sub: null }, bucket: 'working', status: 'Working', freshness: 'recent', age_ms: 60000 };
const STILL = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';
// The one element left out, with why: Overview's interaction-host line. Every Settings save re-syncs that host (the
// old page names every key, remoteInteractionHost included), and whether the line then reads "unavailable" depends on
// when the host is back, not on this toggle. Its text is blanked and the element hidden in both A and B alike.
const MASK = ['#owned-status'];

async function settle(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: STILL }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.evaluate((sels) => {
    for (const s of sels) for (const n of document.querySelectorAll(s)) { n.textContent = ''; n.style.visibility = 'hidden'; }
    // Wall-clock text ("Checked 22:11:25") moves between shots whatever the toggle does: the same fixed text in the page,
    // so both the HTML and the pixels compare everything else.
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) if (/\b\d{1,2}:\d{2}(:\d{2})?\b/.test(t.data)) t.data = t.data.replace(/\b\d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?\b/g, '00:00:00');
  }, MASK);
}
async function capture(page) {
  await settle(page);
  // Volatile clock text is not part of what the toggle could change; drop only digits-with-colons times.
  const html = await page.evaluate(() => document.body.outerHTML);
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  return { html, png };
}
async function boardPage(app) {
  const side = await windowByFile(app, 'sidebar.html');
  await side.evaluate(() => window.buddy.select('board'));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const w = app.windows().find((p) => /^https?:\/\/(127\.0\.0\.1|localhost)/.test(p.url()));
    if (w) { await w.waitForLoadState('load'); return w; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no board view');
}

async function snapshot(h) {
  const out = {};
  out.widget = await capture(await windowByFile(h.app, 'index.html'));
  out.sessions = await capture(await embedded(h.app, 'sessions', 'sessions.html'));
  out.overview = await capture(await embedded(h.app, 'overview', 'overview.html'));
  out.board = await capture(await boardPage(h.app));
  return out;
}

// The real Settings save. `on` null is a save of the same value (a change event with the box untouched): any save
// has effects of its own (it re-syncs the interaction host, which Overview reports), so A is taken after one too.
async function flip(h, on) {
  const settings = await embedded(h.app, 'settings', 'settings.html');
  const box = settings.locator('#homeComposer');
  // The old page keeps it in its Widget section; the sheet's General pane shows it directly.
  if (!(await box.isVisible())) await openSettingsPane(settings, 'widget');
  await box.waitFor({ state: 'visible' });
  const file = path.join(h.home, 'config.json'), before = fs.statSync(file).mtimeMs;
  if (on === null) await box.dispatchEvent('change');
  else if ((await box.isChecked()) !== on) await box.click();
  await expect.poll(() => fs.statSync(file).mtimeMs, { timeout: 10000 }).toBeGreaterThan(before);
  if (on !== null) expect(JSON.parse(fs.readFileSync(file, 'utf8')).homeComposer !== false).toBe(on);
  await settings.waitForTimeout(1500); // let the save's own effects land before the next shots
  return settings;
}

function same(a, b, label) {
  for (const k of Object.keys(a)) {
    expect(b[k].html, `${label}: ${k} outerHTML`).toBe(a[k].html);
    if (Buffer.compare(a[k].png, b[k].png) !== 0 && process.env.TWO_MODE_DUMP) { fs.writeFileSync(path.join(process.env.TWO_MODE_DUMP, `${k}-a.png`), a[k].png); fs.writeFileSync(path.join(process.env.TWO_MODE_DUMP, `${k}-b.png`), b[k].png); }
    expect(Buffer.compare(a[k].png, b[k].png), `${label}: ${k} pixels`).toBe(0);
  }
}

for (const [name, env] of [['gate off', {}], ['gate on (preview)', GATE]]) {
  test(`C4 (${name}): chats off leaves Sessions, Overview, the widget and the board byte-identical`, async () => {
    test.setTimeout(180000);
    const h = await launchApp({ env });
    try {
      await h.app.evaluate(({ ipcMain }, ROW) => {
        ipcMain.removeHandler('sessions:state');
        ipcMain.handle('sessions:state', () => ({ observed_at: 0, status: 'complete', omitted: 0, activity: { configured: true, observed: true, latest_age_ms: 4000 }, sessions: [ROW] }));
      }, ROW);
      await snapshot(h); // warm-up: a page's first visit leaves marks (an emptied style attribute) that later visits keep
      const settings = await flip(h, null);
      // The same checkbox: "Show chats" in the preview's Settings sheet, the old words on the old page.
      await expect(settings.locator('label:has(#homeComposer)')).toHaveText(env.CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW ? 'Show chats' : 'Show the task box on Home');
      const a = await snapshot(h);
      await flip(h, false);
      const b = await snapshot(h);
      await flip(h, true);
      const a2 = await snapshot(h);
      same(a, a2, 'self-check A === A\'');
      same(a, b, 'chats on === chats off');
    } finally { await h.cleanup(); }
  });
}
