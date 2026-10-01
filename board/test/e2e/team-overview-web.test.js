// Real browser, hub and SQLite. No model calls or personal account data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHub, DEV_SECRET } from '../../hub/test/helpers.js';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* optional */ }

test('team overview covers another board, opens fresh task details and ignores an older refresh after board navigation', { skip: !chromium && 'playwright not installed' }, async () => {
  const h = await startHub({ config: { webDir: fileURLToPath(new URL('../../web', import.meta.url)) } });
  let browser, release;
  try {
    const alice = await h.login('alice');
    await h.createCard(alice, { title: 'Core app task' });
    const board = (await h.api(alice, 'POST', '/api/boards', { request_id: randomUUID(), name: 'Client delivery' })).body.board;
    const card = (await h.api(alice, 'POST', `/api/boards/${board.id}/cards`, { request_id: randomUUID(), title: 'Review client homepage' })).body.card;
    h.db.run('UPDATE cards SET column_name = ? WHERE id = ?', 'in_review', card.id);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ baseURL: h.base, viewport: { width: 1200, height: 950 } }), page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.evaluate(async (secret) => {
      const res = await fetch('/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Board-Dev-Secret': secret }, body: JSON.stringify({ github_login: 'alice' }) });
      if (!res.ok) throw Error(await res.text());
    }, DEV_SECRET);
    await page.goto(`/?board=${h.ids.board}&view=team`);
    await page.waitForSelector('.team-overview-stat');
    assert.match(await page.textContent('.team-overview'), /2 active boards/);
    const review = page.locator('.team-overview-panel', { has: page.locator('h3', { hasText: 'Ready for review' }) });
    assert.match(await review.textContent(), /Client delivery.*No active AI run/);
    await page.screenshot({ path: 'work/team-overview-browser.png', fullPage: true });

    let caught;
    const held = new Promise((resolve) => { caught = resolve; });
    let once = true;
    await page.route('**/api/team-overview', async (route) => {
      if (!once) return route.continue(); once = false;
      const response = await route.fetch(); caught();
      await new Promise((resolve) => { release = resolve; });
      await route.fulfill({ response });
    });
    await page.click('[data-action="team-overview-refresh"]'); await held;
    h.db.run('UPDATE cards SET title = ? WHERE id = ?', 'Current client homepage', card.id);
    await review.locator('[data-action="team-open-card"]').click();
    await page.waitForSelector('[data-dialog="drawer"]');
    assert.equal(new URL(page.url()).searchParams.get('board'), board.id);
    await page.locator('.team-overview-task-title', { hasText: 'Current client homepage' }).first().waitFor();
    const oldResponse = page.waitForResponse((r) => r.url().endsWith('/api/team-overview'));
    release(); release = null; await oldResponse;
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.team-overview-task-title', { hasText: 'Review client homepage' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { release?.(); await browser?.close(); await h.close(); }
});
