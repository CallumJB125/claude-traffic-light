// Screenshots of the board views (table, …) against the mock hub. Fails on
// any console error, page error or CSP violation.
//
//   node web/scripts/views-shots.mjs [outDir]
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createMockHub } from '../mock/server.js';

const out = path.resolve(process.argv[2] ?? 'board-views-shots');
await mkdir(out, { recursive: true });
const hub = createMockHub();
const port = await hub.listen(0);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];

async function page({ width = 1440, height = 900, scheme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (/status of 401/.test(m.text())) return; if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`[console] ${m.text()}`); });
  p.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await p.goto(base);
  await p.getByRole('button', { name: 'alice' }).click();
  await p.locator('.card').first().waitFor();
  return p;
}

for (const scheme of ['dark', 'light']) {
  const p = await page({ scheme });
  await p.getByRole('button', { name: 'Table' }).click();
  await p.locator('.cardtable tbody tr').first().waitFor();
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(out, `table-${scheme}.png`) });
  if (scheme === 'dark') {
    await p.getByRole('button', { name: 'Cost' }).click();
    await p.keyboard.press('/');
    await p.keyboard.type('bondly');
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(out, 'table-sorted-filtered.png') });
    const url = new URL(p.url());
    if (url.searchParams.get('view') !== 'table') problems.push(`view not in URL: ${p.url()}`);
    await p.locator('.cardtable tbody tr').first().locator('.card-open').click();
    await p.locator('dialog[data-dialog="drawer"][open]').waitFor();
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(out, 'table-drawer.png') });
    // Reload keeps the view (?view=table).
    await p.reload();
    await p.locator('.cardtable').waitFor();
  }
}
const phone = await page({ width: 390, height: 844 });
await phone.getByRole('button', { name: 'Table' }).click();
await phone.locator('.cardtable').waitFor();
await phone.waitForTimeout(300);
await phone.screenshot({ path: path.join(out, 'table-phone.png') });

await browser.close();
await hub.close?.();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`ok → ${out}`);
process.exit(0);
