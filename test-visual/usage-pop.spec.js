// The Usage pop-out: a small read-only glance opened from the tray / widget
// menu's "Open Usage…". Figures come from seeded transcripts, so they are the
// real pipeline's, not a mock. Esc and click-away close it; the footer link
// opens the full view (the Lights editor's Model mix).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');

const SHOT = { threshold: 0.05, stylePath: path.join(__dirname, 'no-hover-chrome.css') };

// 100k Opus output ($2.50) and 300k Sonnet output ($3.00), seconds ago: today
// is $5.50 · 400k tokens and Sonnet leads. Nothing on disk says how much of
// the plan limit is used, so no limit row.
function seedTranscript(projects) {
  const dir = path.join(projects, '-work-demo');
  fs.mkdirSync(dir, { recursive: true });
  const line = (n, model, output) => JSON.stringify({
    type: 'assistant', uuid: `u${n}`, requestId: `r${n}`, sessionId: 's1', cwd: '/work/demo', timestamp: new Date(Date.now() - n * 1000).toISOString(),
    message: { id: `m${n}`, model, usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), `${line(1, 'claude-opus-5-5', 100000)}\n${line(2, 'claude-sonnet-5-5', 300000)}\n`);
}

let h;
test.beforeAll(async () => { h = await launchApp(); seedTranscript(h.projects); });
test.afterAll(async () => { await h?.cleanup(); });

const trayClick = (label) => h.app.evaluate((_e, l) => global.__buddyTrayMenu.items.find((i) => i.label === l).click(), label);
async function openPop() {
  await expect.poll(() => h.app.evaluate(() => !!global.__buddyTrayMenu).catch(() => false), { timeout: 15000 }).toBe(true);
  await trayClick('Open Usage…');
  const pop = await windowByFile(h.app, 'usage-pop.html');
  await pop.waitForLoadState('load');
  return pop;
}
const popOpen = () => h.app.windows().some((p) => !p.isClosed() && p.url().includes('usage-pop.html'));

test('opens from the menu with the figures from the transcripts, and nothing for the limit', async () => {
  const pop = await openPop();
  await expect(pop.locator('.row')).toHaveCount(3, { timeout: 15000 });
  await expect(pop.locator('.row').nth(0)).toContainText('$5.50 · 400k tokens');
  await expect(pop.locator('.row').nth(1)).toContainText('This week');
  await expect(pop.locator('.row').nth(2)).toContainText('Sonnet · 55% of spend');
  await expect(pop.locator('#note')).toHaveText('Estimated at API list prices.');
  await expect(pop.locator('body')).not.toContainText(/unknown|\b0%|limit/i);
  await expect(pop.locator('main')).toHaveScreenshot('usage-pop.png', SHOT);
  const b = await h.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Usage'); return { ...w.getBounds(), top: w.isAlwaysOnTop() }; });
  expect(b).toMatchObject({ width: 300, height: 260, top: true });
});

test('Esc closes it', async () => {
  const pop = h.app.windows().find((p) => p.url().includes('usage-pop.html')) || await openPop();
  await pop.keyboard.press('Escape').catch(() => {}); // the window is gone before the press resolves
  await expect.poll(popOpen).toBe(false);
});

test('clicking away closes it, but a blur before it ever had focus does not', async () => {
  await openPop();
  // A headless run never gives the window real focus, so drive the events it would see.
  const emit = (name) => h.app.evaluate(({ BrowserWindow }, n) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Usage')?.emit(n), name);
  await emit('blur');
  await h.app.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  expect(popOpen()).toBe(true);
  await emit('focus');
  await emit('blur');
  await expect.poll(popOpen).toBe(false);
});

test('"Open full usage…" opens the Model mix view and closes the pop-out', async () => {
  const pop = await openPop();
  await pop.locator('#full').click();
  const lights = await windowByFile(h.app, 'lights.html');
  await expect(lights.locator('#main')).toHaveAttribute('data-view', 'mix', { timeout: 15000 });
  await expect.poll(popOpen).toBe(false);
});
