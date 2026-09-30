// Screenshots of the key board states against the mock hub, with installed
// Chrome. Fails on any console error, page error or CSP violation.
//
//   node web/scripts/shots.mjs [outDir]
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createMockHub } from '../mock/server.js';

const out = path.resolve(process.argv[2] ?? 'board-web-shots');
await mkdir(out, { recursive: true });

const hub = createMockHub();
const port = await hub.listen(0);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
let dropping = false;
const shots = [];

async function newPage({ width = 1440, height = 900, scheme = 'dark', reduced = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: reduced, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (/status of 401/.test(m.text())) return; // the signed-out /api/me probe
    if (dropping && /WebSocket connection .* 503/.test(m.text())) return; // refused reconnects during the scripted drop
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`[console ${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  return page;
}
const settle = (page, ms = 450) => page.waitForTimeout(ms);
async function shot(page, name, opts = {}) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  shots.push(file);
}
async function login(page) {
  await page.goto(base);
  await page.getByRole('button', { name: 'alice' }).click();
  await page.locator('.card').first().waitFor();
  await settle(page);
}

try {
  // 1. sign-in
  let page = await newPage();
  await page.goto(base);
  await page.getByRole('heading', { name: 'Sign in to the board' }).waitFor();
  await shot(page, '01-signin-dark');

  // 2. board, dark
  await login(page);
  await shot(page, '02-board-dark');

  // 3. drawer on the blocked card (permission requests, first answer wins)
  await page.locator('[data-card-id="c-142"] .card-open').click();
  await page.locator('.drawer .ask').first().waitFor();
  await settle(page, 600);
  await shot(page, '03-drawer-blocked-approvals');

  // 4. handover tab
  await page.getByRole('tab', { name: 'Handover' }).click();
  await settle(page);
  await shot(page, '04-drawer-handover');
  await page.keyboard.press('Escape');
  await settle(page);

  // 5. Give to Claude with an overlap warning (BDL-150 names applications.js, which BDL-142 is editing)
  await page.locator('[data-card-id="c-150"] [data-action="give_to_claude"]').click();
  await page.locator('.callout-warn').waitFor();
  await settle(page);
  await shot(page, '05-give-to-claude-overlap');
  await page.getByLabel(/James's Claude/).check();
  await page.locator('.sponsor-line', { hasText: 'James' }).waitFor();
  await settle(page);
  await shot(page, '06-give-to-teammate');
  await page.keyboard.press('Escape');
  await settle(page);

  // 6. scripted story on BDL-152: queued → running → blocked → orphaned → handed over → done
  const card = page.locator('[data-card-id="c-152"]');
  const story = [];
  for (let i = 0; i < 12; i++) {
    const r = await (await fetch(`${base}/__mock/step`, { method: 'POST' })).json();
    await settle(page, 500);
    if (['running', 'blocked', 'orphaned', 'handed_over', 'in_review', 'done'].includes(r.state) && !story.includes(r.state)) {
      story.push(r.state);
      await card.scrollIntoViewIfNeeded();
      await shot(page, `07-story-${String(story.length).padStart(2, '0')}-${r.state}`, { clip: await card.boundingBox().then((b) => ({ x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 })) });
    }
  }
  // 7. connection drop → one banner, cards not marked unresponsive
  dropping = true;
  await fetch(`${base}/__mock/step`, { method: 'POST' });
  await page.locator('.banner-lost').waitFor();
  await settle(page, 600);
  await shot(page, '08-connection-lost');
  await page.locator('.banner-lost').waitFor({ state: 'detached', timeout: 20000 });
  dropping = false;
  await settle(page);
  await shot(page, '09-reconnected');
  await page.context().close();

  // 8. light theme board + drawer
  page = await newPage({ scheme: 'light' });
  await login(page);
  await shot(page, '10-board-light');
  await page.locator('[data-card-id="c-137"] .card-open').click();
  await page.locator('.drawer .tabs').waitFor();
  await settle(page, 600);
  await shot(page, '11-drawer-orphaned-light');
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  await page.keyboard.press('n');
  await page.locator('dialog[data-dialog="new"]').waitFor();
  await settle(page);
  await shot(page, '12-new-card-light');
  await page.keyboard.press('Escape');
  await page.locator('[data-card-id="c-141"] [data-action="take_over_confirm"]').click();
  await page.locator('dialog[data-dialog="confirm"]').waitFor();
  await settle(page);
  await shot(page, '13-confirm-take-over-light');
  await page.context().close();

  // 9. mobile
  page = await newPage({ width: 390, height: 844, reduced: 'reduce' });
  await login(page);
  await shot(page, '14-mobile-board');
  await page.locator('.alert').first().click();
  await page.locator('.drawer .tabs').waitFor();
  await settle(page, 600);
  await shot(page, '15-mobile-drawer');
  await page.context().close();
} finally {
  await browser.close();
  await hub.close();
}

process.stdout.write(`${shots.length} screenshots in ${out}\n`);
if (problems.length) {
  process.stdout.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
}
