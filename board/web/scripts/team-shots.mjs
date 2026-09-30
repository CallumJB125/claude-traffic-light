// Screenshots of the Team page against the mock hub (dark, light, 390 px, and
// the stale state after a socket drop). Fails on any console error, page
// error, CSP violation or sideways scroll.
//
//   node web/scripts/team-shots.mjs [outDir]
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createMockHub } from '../mock/server.js';

const out = path.resolve(process.argv[2] ?? 'board-team-shots');
await mkdir(out, { recursive: true });
const hub = createMockHub();
const base = `http://127.0.0.1:${await hub.listen(0)}`;
const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
let dropping = false; // the refused reconnects are the point of the stale shot

async function page({ width = 1440, height = 900, scheme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (/status of 401/.test(m.text()) || (dropping && /WebSocket/.test(m.text()))) return; if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`[console] ${m.text()}`); });
  p.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await p.goto(`${base}/?view=team`);
  await p.getByRole('button', { name: 'alice' }).click();
  await p.locator('.team-member').first().waitFor();
  await p.locator('.team-session').first().waitFor();
  await p.waitForTimeout(300);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) problems.push(`page scrolls sideways by ${overflow}px at ${width}px`);
  return p;
}

let darkPage;
for (const scheme of ['dark', 'light']) {
  const p = await page({ scheme });
  await p.screenshot({ path: path.join(out, `team-${scheme}.png`) });
  if (scheme === 'dark') {
    const before = await p.locator('.team-session .team-since', { hasText: /^since \d+s ago$/ }).first().textContent();
    await p.waitForTimeout(2100);
    const after = await p.locator('.team-session .team-since', { hasText: /^since \d+s ago$/ }).first().textContent();
    if (before === after) problems.push(`ages did not tick: ${before}`);
    await p.locator('.team-job').first().click();
    await p.locator('dialog[data-dialog="drawer"][open]').waitFor();
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(out, 'team-drawer.png') });
    await p.keyboard.press('Escape');
    darkPage = p;
  }
}
const phone = await page({ width: 390, height: 844 });
await phone.screenshot({ path: path.join(out, 'team-phone.png'), fullPage: false });
await phone.evaluate(() => { document.querySelector('.app').style.height = 'auto'; document.querySelector('.teamview').style.overflow = 'visible'; });
await phone.screenshot({ path: path.join(out, 'team-phone-full.png'), fullPage: true });

// Last: the drop refuses reconnects, which would strand every later page.
dropping = true;
await fetch(`${base}/__mock/drop?ms=60000`, { method: 'POST' });
await darkPage.locator('.teamview-stale').waitFor({ timeout: 15000 });
await darkPage.screenshot({ path: path.join(out, 'team-stale.png') });

await browser.close();
await hub.close?.();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`ok → ${out}`);
process.exit(0);
