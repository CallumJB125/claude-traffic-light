'use strict';
// Redesign R7-2: Usage › Today and the Usage tab strip, behind the dev-only preview gate. It opens through the real
// path: the sidebar's Usage row → usage:today, with the strip over it. For the pixel shots only, main's
// usage-today:state and usage-today:digest-get answers are replaced with fixed content (the shapes
// src/usage-today-main.js and src/digest-main.js return), answered to the Today document only. The authority itself is
// test/usage-today.test.js and test/usage-tabs.test.js.
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile, snapToPixels } = require('./app');

const GATE = { CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW: '1' };
const STATE = {
  today: { spend: { spent: 3.42, budget: 10, level: 'ok', unpriced: 0, equivalent: false }, longestWaitMs: 7 * 60000, running: 2 },
  costs: { receipt: { month: 'October', headline: 'Plexiform saved you about $12 this month.' }, enforce: { on: true, status: 'Your limit is enforced. Nothing is being refused right now.' }, waste: { count: 2, top: 'The same 3 files were re-read 40 times in one session.' } },
  myDay: { decisions: 1, cards: 4, unavailable: false },
  empty: false,
};
const DIGEST = { digest: { period: 'day', title: 'Your day: Tuesday', sections: [
  { heading: 'Done', summary: '3 chats finished.', items: ['Fix the flaky upload test', 'Add retry to the invoice export', 'Explain the billing module'] },
  { heading: 'Spend', summary: '$3.42 of $10.00.', items: [] },
], team: null }, delivery: null };

async function open(theme) {
  const h = await launchApp({ env: GATE });
  await h.app.evaluate(({ ipcMain }, { STATE, DIGEST }) => {
    const mine = (e) => { try { return new URL(e.sender.getURL()).pathname.endsWith('/usage-today.html'); } catch { return false; } };
    for (const [ch, v] of [['usage-today:state', STATE], ['usage-today:digest-get', DIGEST]]) { ipcMain.removeHandler(ch); ipcMain.handle(ch, (e) => (mine(e) ? v : null)); }
  }, { STATE, DIGEST });
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openHelp());
  const side = await windowByFile(h.app, 'sidebar.html');
  await side.waitForFunction(() => !!window.buddy);
  await side.locator('.sb-foot[data-page="usage:today"]').click();
  const page = await windowByFile(h.app, 'usage-today.html');
  const strip = await windowByFile(h.app, 'usage-tabs.html');
  for (const p of [page, strip]) { await p.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' }); await p.waitForLoadState('load'); await p.evaluate(() => document.fonts.ready); }
  await expect(page.locator('#td')).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
  await expect(page.locator('.td-digest-title')).toHaveText('Your day: Tuesday');
  return { h, side, page, strip };
}

for (const theme of ['light', 'dark']) {
  test(`Today (${theme}): the tiles, savings, your team today and the digest`, async () => {
    const { h, page, strip } = await open(theme);
    try {
      await expect(page.locator('.td-tile strong').first()).toHaveText('$3.42');
      await expect(page.locator('#td-empty')).toBeHidden();
      await expect(strip.locator('.ut-tab[aria-selected="true"]')).toHaveText('Today');
      await expect(await snapToPixels(page.locator('#td'))).toHaveScreenshot(`usage-today-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}

test('the strip (dark): five tabs; Spend opens the Usage page under it, the sidebar row stays current', async () => {
  const { h, side, strip } = await open('dark');
  try {
    await expect(strip.locator('.ut-tab')).toHaveText(['Today', 'Spend', 'Stats', 'Burst', 'Client billing']);
    await strip.locator('.ut-tab[data-id="usage"]').click();
    await expect(strip.locator('.ut-tab[aria-selected="true"]')).toHaveText('Spend');
    const lights = await windowByFile(h.app, 'lights.html');
    await lights.waitForLoadState('load');
    await expect(side.locator('.sb-foot[data-page="usage:today"]')).toHaveAttribute('aria-current', 'page');
    await strip.locator('.ut-tab[data-id="usage"]').focus();
    await strip.keyboard.press('ArrowRight');
    await expect(strip.locator('.ut-tab[aria-selected="true"]')).toHaveText('Stats');
    await strip.locator('.ut-tab[data-id="stats"]').blur();
    await strip.mouse.move(1000, 20); // no tab under the pointer: no hover colour in the shot
    await expect(await snapToPixels(strip.locator('.ut'))).toHaveScreenshot('usage-tabs-strip-dark.png');
  } finally { await h.cleanup(); }
});
