// Real Chrome/hub/SQLite and ordinary board subscriptions. No external AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHub, DEV_SECRET } from '../../hub/test/helpers.js';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* optional */ }

test('search opens matching comments on another board, escapes text and discards old query/dialog responses', { skip: !chromium && 'playwright not installed' }, async () => {
  const h = await startHub({ config: { webDir: fileURLToPath(new URL('../../web', import.meta.url)) } });
  let browser, release;
  try {
    const alice = await h.login('alice');
    const board = (await h.api(alice, 'POST', '/api/boards', { request_id: randomUUID(), name: 'Client delivery' })).body.board;
    const card = (await h.api(alice, 'POST', `/api/boards/${board.id}/cards`, { request_id: randomUUID(), title: 'Review homepage' })).body.card;
    await h.api(alice, 'POST', `/api/cards/${card.id}/comments`, { request_id: randomUUID(), body: 'needle <script>window.injected = true</script> client feedback' });
    await h.createCard(alice, { title: 'slow old result' });
    await h.createCard(alice, { title: 'late closed result' });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ baseURL: h.base }), page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.evaluate(async (secret) => {
      const r = await fetch('/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Board-Dev-Secret': secret }, body: JSON.stringify({ github_login: 'alice' }) });
      if (!r.ok) throw Error(await r.text());
    }, DEV_SECRET);
    await page.goto(`/?board=${h.ids.board}`); await page.waitForSelector('.card');
    const open = async () => { await page.click('[data-action="palette"]'); await page.locator('.pal-opt', { hasText: 'Search all boards' }).click(); };
    await open(); await page.fill('[data-input="palette-q"]', 'needle');
    await page.locator('.pal-opt[data-kind="search"]', { hasText: 'Client delivery · comment' }).waitFor();
    assert.match(await page.textContent('.pal-snippet'), /<script>window.injected = true<\/script>/);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator('.pal-opt[data-kind="search"]').click();
    await page.waitForSelector('[data-dialog="drawer"]');
    await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'Comments' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('board'), board.id);
    assert.match(await page.textContent('[data-dialog="drawer"]'), /client feedback/);
    await page.keyboard.press('Escape');

    // The old result is real, but its response arrives after a new query.
    await open();
    let caught;
    const held = new Promise((resolve) => { caught = resolve; });
    await page.route('**/api/search?q=slow', async (route) => { const response = await route.fetch(); caught(); await new Promise((resolve) => { release = resolve; }); await route.fulfill({ response }); });
    await page.fill('[data-input="palette-q"]', 'slow'); await held;
    await page.fill('[data-input="palette-q"]', 'needle'); await page.locator('.pal-opt[data-kind="search"]', { hasText: 'Review homepage' }).waitFor();
    const released = page.waitForResponse((r) => new URL(r.url()).searchParams.get('q') === 'slow'); release(); release = null; await released;
    assert.equal(await page.locator('.pal-opt', { hasText: 'slow old result' }).count(), 0);
    await page.keyboard.press('Escape');

    // Closing/reopening a search also invalidates the old response.
    let caughtLate;
    const heldLate = new Promise((resolve) => { caughtLate = resolve; });
    await page.route('**/api/search?q=late', async (route) => { const response = await route.fetch(); caughtLate(); await new Promise((resolve) => { release = resolve; }); await route.fulfill({ response }); });
    await open(); await page.fill('[data-input="palette-q"]', 'late'); await heldLate;
    await page.keyboard.press('Escape'); await open();
    const lateResponse = page.waitForResponse((r) => new URL(r.url()).searchParams.get('q') === 'late'); release(); release = null; await lateResponse;
    assert.equal(await page.inputValue('[data-input="palette-q"]'), '');
    assert.equal(await page.locator('.pal-opt[data-kind="search"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { release?.(); await browser?.close(); await h.close(); }
});
