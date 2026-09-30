// Screenshots of board slice S1 against the mock hub: a card mid-drag, the
// inline quick-add, the filter bar, the ⌘K palette, multi-select, and the
// board backgrounds (dark + light + 390 px). Fails on any console error, page
// error or CSP violation, and on a few behavioural checks (ghost, drop line,
// optimistic card, no sideways scroll).
//
//   node web/scripts/board-s1-shots.mjs [outDir]
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createMockHub } from '../mock/server.js';

const out = path.resolve(process.argv[2] ?? 'board-s1-shots');
await mkdir(out, { recursive: true });
const hub = createMockHub();
const base = `http://127.0.0.1:${await hub.listen(0)}`;
const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(`check failed: ${what}`); };

async function page({ width = 1440, height = 900, scheme = 'dark', bg = null, touch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2, hasTouch: touch });
  if (bg) await ctx.addInitScript((b) => { try { localStorage.setItem('board-bg', b); } catch { /* storage off */ } }, bg);
  const p = await ctx.newPage();
  p.on('console', (m) => { if (/status of 401/.test(m.text())) return; if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`[console] ${m.text()}`); });
  p.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await p.goto(base);
  await p.getByRole('button', { name: 'alice' }).click();
  await p.locator('.card').first().waitFor();
  await p.waitForTimeout(250);
  return p;
}
const shot = (p, name, opts = {}) => p.screenshot({ path: path.join(out, name), ...opts });
const noSideways = async (p, name) => {
  const w = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(w <= 0, `${name}: page scrolls sideways by ${w}px`);
};

// ── dark desktop: drag, selection, quick-add, filters, palette, menu ──
{
  const p = await page();
  const human = p.locator('.card[data-draggable="true"]').first();
  const id = await human.getAttribute('data-card-id');
  const box = await human.boundingBox();
  const target = await p.locator('.column-in_review .column-body').boundingBox();
  await p.mouse.move(box.x + 40, box.y + 24);
  await p.mouse.down();
  await p.mouse.move(box.x + 70, box.y + 50, { steps: 4 });
  await p.mouse.move(target.x + 120, target.y + 70, { steps: 14 });
  await p.waitForTimeout(350);
  check(await p.locator('.card-ghost').count() === 1, 'drag: one lifted ghost');
  check(await p.locator('.card.is-dragging').count() === 1, 'drag: dashed placeholder in the source slot');
  check(await p.locator('.column-in_review.is-drop').count() === 1, 'drag: target column highlighted');
  check(await p.locator('.column-in_review .drop-line').count() === 1, 'drag: one drop indicator');
  await shot(p, 'drag-dark.png');
  await p.mouse.up();
  await p.waitForTimeout(500);
  check(await p.locator(`.column-in_review [data-card-id="${id}"]`).count() === 1, 'drop: card is in Review');
  check(await p.locator('.card-ghost').count() === 0, 'drop: ghost removed');

  // multi-select
  const cards = p.locator('.card[data-draggable="true"]');
  await cards.nth(0).click({ modifiers: ['Shift'] });
  await cards.nth(1).click({ modifiers: ['Meta'] });
  await p.locator('.card').nth(2).click({ modifiers: ['Shift'] });
  await p.waitForTimeout(300);
  check(await p.locator('.selbar').count() === 1, 'selection: action bar');
  await shot(p, 'selection-dark.png');
  await p.keyboard.press('Escape');

  // quick add
  await p.keyboard.press('n');
  await p.keyboard.type('Retry the failed webhook with backoff');
  await p.waitForTimeout(150);
  check(await p.locator('.quickadd-input').count() === 1, 'quick-add: field open');
  await shot(p, 'quick-add-dark.png');
  const t0 = Date.now();
  await p.keyboard.press('Enter');
  await p.locator('.column-todo .card', { hasText: 'Retry the failed webhook' }).first().waitFor();
  check(Date.now() - t0 < 100, `quick-add: optimistic card in ${Date.now() - t0} ms`);
  await p.waitForTimeout(300);
  check(await p.locator('.card.is-pending').count() === 0, 'quick-add: hub replaced the pending card');

  // filters
  await p.keyboard.press('/');
  await p.keyboard.type('bondly');
  await p.locator('[data-chip="working"]').click();
  await p.waitForTimeout(250);
  check(new URL(p.url()).searchParams.get('q') === 'bondly', 'filters: ?q= in the URL');
  check(new URL(p.url()).searchParams.get('f') === 'working', 'filters: &f= in the URL');
  await shot(p, 'filters-dark.png');
  await p.locator('[data-action="filter-clear"]').click();

  // palette
  await p.keyboard.press('Control+k');
  await p.locator('dialog.palette[open]').waitFor();
  await p.keyboard.type('mig');
  await p.waitForTimeout(150);
  check(await p.locator('.pal-input').getAttribute('aria-activedescendant') === 'pal-opt-0', 'palette: activedescendant follows');
  await shot(p, 'palette-dark.png');
  await p.keyboard.press('Escape');

  // appearance menu
  await p.getByRole('button', { name: 'Appearance' }).click();
  await p.waitForTimeout(250);
  await shot(p, 'theme-menu-dark.png');
  await noSideways(p, 'desktop dark');
}

// ── backgrounds: dark + light desktop, phone ──
for (const [scheme, bg] of [['dark', 'dusk'], ['dark', 'tide'], ['light', 'ember'], ['light', 'moss'], ['dark', 'grid'], ['light', 'dots']]) {
  const p = await page({ scheme, bg });
  check(await p.evaluate(() => document.documentElement.dataset.boardBg) === bg, `bg ${bg} applied`);
  await shot(p, `bg-${bg}-${scheme}.png`);
}
{
  const p = await page({ width: 390, height: 844, scheme: 'dark', bg: 'dusk', touch: true });
  await shot(p, 'phone-dusk-dark.png');
  await p.locator('[data-chip="blocked"]').click();
  await p.waitForTimeout(200);
  await shot(p, 'phone-filter-dark.png');
  await noSideways(p, 'phone');
  await p.locator('[data-action="filter-clear"]').click();
  await p.locator('.palette-open').click().catch(() => {});
}
{
  const p = await page({ width: 390, height: 844, scheme: 'light', bg: 'tide' });
  await shot(p, 'phone-tide-light.png');
  await p.keyboard.press('Control+k');
  await p.locator('dialog.palette[open]').waitFor();
  await shot(p, 'phone-palette-light.png');
}

await browser.close();
await hub.close?.();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`ok → ${out}`);
process.exit(0);
