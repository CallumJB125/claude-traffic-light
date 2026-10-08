import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startHub, DEV_SECRET } from '../../hub/test/helpers.js';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* optional */ }

test('actual browser publishes versions, previews an older version, creates real tasks and restores an archived recipe', { skip: !chromium && 'playwright not installed' }, async () => {
  const h = await startHub({ config: { webDir: fileURLToPath(new URL('../../web', import.meta.url)) } }); let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ baseURL: h.base, viewport: { width: 1150, height: 1000 } }), page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/'); await page.evaluate(async (secret) => { const r = await fetch('/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Board-Dev-Secret': secret }, body: JSON.stringify({ github_login: 'alice' }) }); if (!r.ok) throw Error(await r.text()); }, DEV_SECRET); await page.reload(); await page.waitForSelector('[data-action="palette"]');
    const open = async () => { await page.click('[data-action="palette"]'); await page.locator('.pal-opt', { hasText: 'Reusable workflows' }).click(); await page.waitForSelector('[data-dialog="workflows"] [data-action="workflow-new"]'); };
    await open(); await page.click('[data-action="workflow-new"]');
    await page.fill('input[name="name"]', 'Client website delivery');
    await page.fill('input[name="title-0"]', 'Clarify client request');
    await page.click('[data-action="workflow-add-step"]'); assert.equal(await page.inputValue('input[name="title-0"]'), 'Clarify client request', 'adding a step retains typed fields');
    await page.fill('input[name="title-3"]', 'Extra step'); await page.click('[data-action="workflow-remove-step"][data-position="3"]');
    await page.click('[data-form="workflow-publish"] button[type="submit"]'); await page.waitForSelector('[data-action="workflow-edit"]');
    assert.match(await page.textContent('[data-dialog="workflows"]'), /Version 1 · 3 steps/);
    await page.click('[data-action="workflow-edit"]'); await page.fill('input[name="title-0"]', 'Clarify revised request'); await page.click('[data-form="workflow-publish"] button[type="submit"]'); await page.waitForSelector('[data-action="workflow-preview"]');
    assert.match(await page.textContent('[data-dialog="workflows"]'), /Version 2 · 3 steps/);
    await page.click('[data-action="workflow-preview"]'); await page.selectOption('[data-change="workflow-version"]', '1');
    assert.match(await page.textContent('.workflow-preview'), /Clarify client request/); assert.doesNotMatch(await page.textContent('.workflow-preview'), /Clarify revised request/);
    await page.fill('input[name="title_prefix"]', 'Acme'); await page.fill('textarea[name="context"]', 'Keyboard navigation is required.');
    const response = page.waitForResponse((r) => r.request().method() === 'POST' && /\/workflows\/[^/]+\/apply$/.test(new URL(r.url()).pathname));
    await page.click('[data-form="workflow-apply"] button[type="submit"]'); const applied = await response; assert.equal(applied.status(), 200, await applied.text()); const instance = (await applied.json()).instance;
    await page.waitForSelector('[data-dialog="workflows"]', { state: 'detached' });
    assert.equal(instance.version, 1); assert.equal(instance.steps.length, 3);
    await page.locator('.card', { hasText: 'Acme: Clarify client request' }).waitFor();
    for (const s of instance.steps) { const c = h.hub.card(s.id); assert.equal(c.run_state, null); assert.equal(c.repo_id, null); assert.match(c.body, /Keyboard navigation is required/); }
    assert.equal(h.db.get('SELECT COUNT(*) n FROM dispatches').n, 0);
    await open(); await page.click('[data-action="workflow-select"]'); await page.waitForSelector('.workflow-instance');
    assert.match(await page.textContent('.workflow-instance'), /Version 1 · 0\/3 tasks done/);
    await page.click('[data-action="workflow-archive"]'); await page.locator('[data-action="workflow-archive"]', { hasText: 'Restore workflow' }).waitFor();
    await page.click('[data-action="workflow-library"]'); assert.equal(await page.locator('[data-action="workflow-select"]').count(), 0);
    await page.click('[data-action="workflow-show-archived"]'); await page.waitForSelector('[data-action="workflow-select"]'); await page.click('[data-action="workflow-select"]');
    await page.locator('[data-action="workflow-archive"]', { hasText: 'Restore workflow' }).click(); await page.waitForSelector('[data-action="workflow-preview"]');
    if (process.env.WORKFLOW_SCREENSHOT) await page.screenshot({ path: process.env.WORKFLOW_SCREENSHOT, fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await h.close(); }
});
