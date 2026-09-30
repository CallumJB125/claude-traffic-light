// The real web, served by the real hub, driven in installed Chrome (Playwright
// channel 'chrome'): a dispatched card turns green on the board, and a
// permission request answered from two browsers at once is first-wins.
// Skipped when Playwright or Chrome is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stack, until, sleep } from './harness.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* optional */ }
const SHOTS = process.env.BOARD_E2E_SHOTS ?? null;

const SCENARIO = {
  steps: [
    { mcp: 'board_get_card' },
    ...Array.from({ length: 30 }, (_, i) => ({ tool: 'Bash', input: { command: `echo warm ${i}` }, ms: 200 })),
    { tool: 'Bash', input: { command: 'make deploy-preview' }, approval: true },
    ...Array.from({ length: 300 }, (_, i) => ({ tool: 'Bash', input: { command: `echo after ${i}` }, ms: 200 })),
  ],
};

async function browserFor(browser, hubUrl, login) {
  const ctx = await browser.newContext({ baseURL: hubUrl, viewport: { width: 1280, height: 860 } });
  const r = await ctx.request.post('/api/dev/login', { data: { github_login: login } });
  assert.equal(r.status(), 200);
  const page = await ctx.newPage();
  await page.goto('/');
  return { ctx, page };
}

test('web: dispatched card goes green; two approvers click Allow on the card at once → first wins', { skip: !chromium && 'playwright not installed' }, async () => {
  const s = await stack();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    await s.runner('rA', s.alice, SCENARIO, { repo: { approvals_from: [s.bob.id] } });
    const card = await s.card(s.alice, { title: 'Ship the preview deploy' });
    const A = await browserFor(browser, s.hub.url, 'alice');
    const B = await browserFor(browser, s.hub.url, 'bob');
    const cardSel = `[data-card-id="${card.id}"]`;
    await A.page.waitForSelector(cardSel);

    const d = await s.alice.call('POST', `/api/cards/${card.id}/actions/dispatch`, {});
    assert.equal(d.status, 200);
    await A.page.waitForSelector(`${cardSel} .pill[data-green]`, { timeout: 15000 });
    assert.match(await A.page.textContent(`${cardSel} .pill-label`), /Running/);
    if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, 'ui-green.png') });

    const allow = `${cardSel} [data-action="permission"][data-decision="allow"]`;
    await Promise.all([A.page.waitForSelector(allow, { timeout: 20000 }), B.page.waitForSelector(allow, { timeout: 20000 })]);
    if (SHOTS) await B.page.screenshot({ path: path.join(SHOTS, 'ui-approval.png') });
    // Both approvers press Allow in the same instant (both buttons are on screen).
    const at = Date.now() + 400;   // one wall-clock instant for both pages, before any answer lands
    const clicked = await Promise.all([A.page, B.page].map((p) => p.evaluate(([sel, when]) => new Promise((resolve) => {
      setTimeout(() => { const b = document.querySelector(sel); if (b) b.click(); resolve(!!b); }, Math.max(0, when - Date.now()));
    }), [allow, at])));
    assert.deepEqual(clicked, [true, true]);
    const seen = new Set();
    await until(async () => {
      for (const p of [A.page, B.page]) for (const t of await p.$$eval('.toast', (els) => els.map((e) => e.textContent))) seen.add(t);
      return seen.size >= 2;
    }, { what: 'both toasts', every: 50 });
    const all = [...seen];
    assert.equal(all.filter((t) => /Allowed/.test(t)).length, 1, `one winner: ${all}`);
    assert.equal(all.filter((t) => /Already answered by (Alice|Bob)/.test(t)).length, 1, `one loser told who won: ${all}`);
    await A.page.waitForSelector(`${cardSel} .pill[data-green]`, { timeout: 15000 });
    const detail = await s.view(s.alice, card.id);
    assert.equal(detail.permission_requests.length, 1);
    assert.equal(detail.permission_requests[0].state, 'allowed');
    await sleep(100);
  } finally {
    await browser?.close();
    await s.close();
  }
});

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
