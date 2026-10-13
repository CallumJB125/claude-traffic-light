// The bundled board UI against a real hub and installed Chrome. Fake users,
// fake connector, loopback only; no provider or account traffic leaves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { freePort, startHub, until, tmpDir, rm, DEV_SECRET } from './harness.js';
import { sign } from '../../hub/integrations/fake/index.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* optional */ }

test('bundled boards: create/switch/rename/archive/restore/remember, team push and integration target round trips', { skip: !chromium && 'playwright not installed' }, async () => {
  const root = tmpDir('bM-');
  const dataDir = path.join(root, 'hub'); fs.mkdirSync(dataDir);
  const hub = await startHub({ dataDir, port: await freePort(), env: { BOARD_ENC_KEY: randomBytes(32).toString('hex') } });
  let browser;
  const browserErrors = [];
  const invalidCardRequests = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = async (login) => {
      const p = await (await browser.newContext({ baseURL: hub.url })).newPage();
      p.setDefaultTimeout(10000);
      p.on('pageerror', (error) => browserErrors.push(error.message));
      p.on('request', (r) => { if (new URL(r.url()).pathname === '/api/cards/undefined') invalidCardRequests.push(r.url()); });
      await p.goto('/');
      await p.evaluate(async ({ login, secret }) => {
        const r = await fetch('/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Board-Dev-Secret': secret }, body: JSON.stringify({ github_login: login }) });
        if (!r.ok) throw new Error(await r.text());
      }, { login, secret: DEV_SECRET });
      await p.reload(); await p.waitForSelector('.brand-board:has-text("dev")');
      return p;
    };
    const A = await page('alice'), B = await page('bob');
    const original = await A.evaluate(() => fetch('/api/me').then((r) => r.json()).then((r) => r.boards[0].id));
    const addCard = async (p, title) => {
      await p.click('[data-action="new-card"]');
      await p.fill('#new-title', title);
      const response = p.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/boards\/[^/]+\/cards$/.test(new URL(r.url()).pathname));
      await p.click('form[data-form="new"] button[type="submit"]');
      const created = await response;
      assert.equal(created.status(), 200, `${await created.text()}\n${created.request().postData()}`);
      await p.waitForSelector(`.card:has-text("${title}")`);
      await p.waitForSelector('[data-dialog="new"]', { state: 'detached' });
    };
    await addCard(A, 'Original task');
    await A.click('[data-action="manage-boards"]');
    await A.click('[data-action="new-board"]');
    await A.fill('#board-name', 'Delivery');
    await A.fill('#board-prefix', 'DEV');
    const conflictResponse = A.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/boards');
    await A.click('form[data-form="new-board"] button[type="submit"]');
    const conflict = await conflictResponse;
    assert.equal(conflict.status(), 409, `${await conflict.text()}\n${conflict.request().postData()}`);
    await A.waitForSelector('[data-dialog="new-board"] [role="alert"]');
    assert.match(await A.textContent('[data-dialog="new-board"] [role="alert"]'), /prefix.*already used/);
    await A.fill('#board-prefix', '');
    await A.click('form[data-form="new-board"] button[type="submit"]');
    await A.waitForSelector('.brand-board:has-text("Delivery")');
    assert.equal(await A.locator('.card').count(), 0, 'switching resets the old cards');
    const delivery = new URL(A.url()).searchParams.get('board');
    assert.ok(delivery && delivery !== original);
    await B.waitForSelector('[aria-label="Switch board"] option:has-text("Delivery")', { state: 'attached' });
    assert.equal(await B.locator('[data-action="manage-boards"]').count(), 0, 'member has no admin controls');
    await B.selectOption('[aria-label="Switch board"]', delivery);
    await B.waitForSelector('.brand-board:has-text("Delivery")');
    await addCard(A, 'Delivery task');
    await B.waitForSelector('.card:has-text("Delivery task")');
    // The server really creates the card, but its HTTP answer arrives after
    // the member changes boards. It must not repopulate or close the new view.
    let releaseReply, fetched;
    const fetchedReply = new Promise((resolve) => { fetched = resolve; });
    const lateReply = new Promise((resolve) => { releaseReply = resolve; });
    const routePattern = `**/api/boards/${delivery}/cards`;
    await A.route(routePattern, async (route) => {
      const response = await route.fetch();
      fetched(); await lateReply;
      await route.fulfill({ response });
    });
    await A.click('[data-action="new-card"]');
    await A.fill('#new-title', 'Late reply');
    await A.click('form[data-form="new"] button[type="submit"]');
    await fetchedReply;
    await A.click('[data-dialog="new"] [aria-label="Close"]');
    await A.selectOption('[aria-label="Switch board"]', original);
    await A.waitForSelector('.brand-board:has-text("dev")');
    const lateResponse = A.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/boards/${delivery}/cards`);
    releaseReply(); await lateResponse;
    await A.unroute(routePattern);
    assert.equal(await A.locator('.card:has-text("Late reply")').count(), 0);
    await A.selectOption('[aria-label="Switch board"]', delivery);
    await A.waitForSelector('.brand-board:has-text("Delivery")');
    await A.goto(`/?board=${delivery}&view=integrations`);
    await A.click('[data-action="integ-connect"][data-provider="fake"]');
    await A.fill('form[data-form="integ-token"] input[name="token"]', 'fake_abcdef123456');
    await A.click('form[data-form="integ-token"] button[type="submit"]');
    await A.waitForSelector('[aria-label="Target board for Fake tracker"]');
    await A.selectOption('[aria-label="Target board for Fake tracker"]', delivery);
    const connection = await until(async () => {
      const list = await A.evaluate(() => fetch('/api/integrations').then((r) => r.json()));
      return list.connections.find((c) => c.provider === 'fake' && c.target_board_id === delivery);
    }, { what: 'saved target board' });
    const issue = async (title) => {
      const body = JSON.stringify({ event: 'issue.opened', issue: { id: randomUUID(), title } });
      const r = await fetch(`${hub.url}/integrations/${connection.id}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fake-Signature': sign('whsec_abcdef123456', body), 'X-Fake-Delivery': randomUUID() }, body });
      assert.equal(r.status, 200, await r.text());
    };
    await issue('Integration intake');
    await B.waitForSelector('.card:has-text("Integration intake")');
    await A.click('[data-action="manage-boards"]');
    await A.click(`[data-action="rename-board"][data-board="${delivery}"]`);
    await A.fill('#board-name', 'Work');
    await A.click('form[data-form="rename-board"] button[type="submit"]');
    await B.waitForSelector('.brand-board:has-text("Work")');
    const snap = await A.evaluate((id) => fetch(`/api/boards/${id}`).then((r) => r.json()), delivery);
    assert.equal(snap.board.key_prefix, 'DEL');
    assert.equal(snap.cards.find((c) => c.title === 'Delivery task').key, 'DEL-1');
    await A.click('[data-action="manage-boards"]');
    await A.click(`[data-action="archive-board"][data-board="${delivery}"]`);
    await A.click('form[data-form="archive-board"] button[type="submit"]');
    await A.waitForSelector('.brand-board:has-text("dev")');
    await B.waitForSelector('.board-archived');
    assert.equal(await B.locator('[data-action="new-card"]').count(), 0);
    await B.keyboard.press('n');
    assert.equal(await B.locator('.quickadd-input, [data-dialog="new"]').count(), 0, 'keyboard respects read-only archives');
    assert.equal(await A.locator('[aria-label="Switch board"] option').count(), 1, 'archive hidden from active switcher');
    await A.goto(`/?board=${original}&view=integrations`);
    await A.waitForSelector('[aria-label="Target board for Fake tracker"] option:has-text("intake paused")', { state: 'attached' });
    await issue('Must stay paused');
    const active = await A.evaluate((id) => fetch(`/api/boards/${id}`).then((r) => r.json()), original);
    assert.deepEqual(active.cards.map((c) => c.title), ['Original task'], 'archived target never reroutes intake');
    await A.click('[data-action="manage-boards"]');
    assert.equal(await A.locator(`[data-action="archive-board"][data-board="${original}"]`).isDisabled(), true);
    await A.click(`[data-action="restore-board"][data-board="${delivery}"]`);
    await A.waitForSelector(`[data-action="rename-board"][data-board="${delivery}"]`);
    await A.click(`[data-action="switch-board"][data-board="${delivery}"]`);
    await A.waitForSelector('.brand-board:has-text("Work")');
    await A.goto('/');
    await A.waitForSelector('.brand-board:has-text("Work")');
    await A.click('[data-view="board"]');
    await A.waitForSelector('.card:has-text("Delivery task")');
    await issue('Restored intake');
    await A.waitForSelector('.card:has-text("Restored intake")');
    assert.deepEqual(browserErrors, [], 'the whole walk renders without browser errors');
    assert.deepEqual(invalidCardRequests, [], 'creating a card never opens or refreshes an undefined drawer');
  } finally {
    await browser?.close(); hub.proc.kill('SIGTERM');
    await until(() => hub.proc.exitCode != null || hub.proc.signalCode != null, { what: 'hub exit', timeout: 10000 }).catch(() => hub.proc.kill('SIGKILL'));
    rm(root);
  }
});
