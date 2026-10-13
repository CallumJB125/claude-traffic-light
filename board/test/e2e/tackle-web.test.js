// Actual Chrome + hub/WS authority, with protocol-only fake AI devices.
// No provider CLI/model is invoked and no traffic leaves loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startHub, DEV_SECRET, runMsg } from '../../hub/test/helpers.js';
import { until } from './harness.js';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* optional */ }
const webDir = fileURLToPath(new URL('../../web', import.meta.url));
const ai = (id, budget, over = {}) => ({ id, label: id === 'codex' ? 'Codex' : 'Claude Code', installed: true, version: '0.159.2', signedIn: true, startable: true, capabilities: { budget, resume: true }, ...over });

test('Tackle uses ready AI, explicit real budget choices, member preferences and rejects a stale modal continuation', { skip: !chromium && 'playwright not installed' }, async () => {
  const h = await startHub({ config: { webDir } });
  let browser, release;
  try {
    const alice = await h.login('alice'), runner = await h.runner(await h.enroll(alice));
    const advertise = async (providers) => {
      runner.send({ type: 'advertise', repos: [{ repo_id: h.ids.repo }], ai: providers });
      await until(() => h.hub.runners.get(runner.dev.device_id)?.ai?.[0]?.signedIn === providers[0]?.signedIn && h.hub.runners.get(runner.dev.device_id)?.ai?.length === providers.length);
    };
    await advertise([ai('codex', 'none'), ai('claude', 'native')]);
    const one = await h.createCard(alice, { title: 'Codex real dispatch' }), two = await h.createCard(alice, { title: 'Budget preference' }), three = await h.createCard(alice, { title: 'Stale continuation' });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ baseURL: h.base }), page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], paid = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (r.method() === 'POST' && /\/actions\/(dispatch|retry)$/.test(new URL(r.url()).pathname)) paid.push({ card: new URL(r.url()).pathname, body: r.postDataJSON() }); });
    const login = async (name) => {
      await page.goto('/');
      await page.evaluate(async ({ name, secret }) => {
        const r = await fetch('/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Board-Dev-Secret': secret }, body: JSON.stringify({ github_login: name }) });
        if (!r.ok) throw Error(await r.text());
      }, { name, secret: DEV_SECRET });
      await page.reload();
      try { await page.waitForSelector('.card'); } catch (error) { throw new Error(`${error.message}\nPage: ${await page.textContent('body')}\nErrors: ${errors.join('; ')}`); }
    };
    const open = async (card) => {
      await page.locator(`.card[data-card-id="${card.id}"] [data-action="give_to_claude"]`).click();
      await page.waitForSelector('#give-ai:not([disabled])');
    };
    const close = async () => { await page.click('[data-dialog="give"] [data-action="close-dialog"]'); await page.waitForSelector('[data-dialog="give"]', { state: 'detached' }); };
    const send = async (id, action = 'dispatch') => {
      const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/cards/${id}/actions/${action}`);
      await page.click('form[data-form="give"] button[type="submit"]');
      const result = await response; assert.equal(result.status(), 200, await result.text());
      await page.waitForSelector('[data-dialog="give"]', { state: 'detached' });
    };
    await login('alice'); await open(one);
    assert.equal(await page.inputValue('#give-ai'), 'codex');
    assert.match(await page.textContent('[data-dialog="give"]'), /Dollar and turn caps are unavailable for Codex/);
    assert.equal(await page.locator('#give-budget').count(), 0);
    await send(one.id);
    const offer = await runner.next('offer', (o) => o.card_id === one.id);
    assert.equal(offer.ai, 'codex'); assert.equal(offer.budget_usd, null);
    assert.deepEqual([paid[0].body.ai, paid[0].body.budget_usd], ['codex', null]);
    assert.equal((await runner.claim(offer)).ok, true);
    assert.equal((await h.api(alice, 'GET', `/api/cards/${one.id}`)).body.run.cost_usd, null);

    // A second provider is a protocol fixture only; validate real cap
    // submission and that this choice is remembered for this member.
    await open(two); await page.selectOption('#give-ai', 'claude');
    await page.check('input[name="budget_mode"][value="cap"]'); await page.fill('#give-budget', '7.5');
    await send(two.id);
    const capped = await runner.next('offer', (o) => o.card_id === two.id);
    assert.equal(capped.budget_usd, 7.5);
    await open(three); assert.equal(await page.inputValue('#give-ai'), 'claude'); assert.equal(await page.inputValue('#give-budget'), '7.5'); await close();
    await login('bob'); await open(three); assert.equal(await page.inputValue('#give-ai'), 'codex', 'preferences do not cross member identity'); await close();
    await login('alice');
    const claim = await runner.claim(capped), cappedRun = { ...claim, card_id: two.id, repo_id: h.ids.repo };
    await runner.out({ ...runMsg(cappedRun), kind: 'facts', items: [{ kind: 'cost', cost_usd: 7.5 }] });
    await runner.out({ ...runMsg(cappedRun), kind: 'run.failed', fail_kind: 'budget', budget_scope: 'card' });
    await page.locator(`.card[data-card-id="${two.id}"] [data-action="retry"]`).click();
    await page.waitForSelector('#give-ai:not([disabled])');
    assert.equal(await page.inputValue('#give-ai'), 'claude'); assert.equal(await page.inputValue('#give-budget'), '8');
    await page.fill('#give-budget', '7.5');
    const deniedResponse = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/cards/${two.id}/actions/retry`);
    await page.click('form[data-form="give"] button[type="submit"]');
    assert.equal((await (await deniedResponse).json()).error.reason, 'BUDGET_TOO_LOW');
    await page.waitForSelector('[data-dialog="give"] [role="alert"]');
    await page.fill('#give-budget', '8'); await send(two.id, 'retry');
    const retry = await runner.next('offer', (o) => o.card_id === two.id && o.fence !== cappedRun.fence);
    assert.equal(retry.budget_usd, 0.5);
    const next = await runner.claim(retry);
    await runner.out({ ...runMsg({ ...next, card_id: two.id, repo_id: h.ids.repo }), kind: 'run.failed', fail_kind: 'budget', budget_scope: 'device' });
    await page.locator(`.card[data-card-id="${two.id}"] [data-action="retry"]`).click();
    await page.waitForSelector('#give-ai:not([disabled])');
    assert.match(await page.textContent('[data-dialog="give"]'), /machine owner must change their local limit/);
    assert.equal(await page.isDisabled('form[data-form="give"] button[type="submit"]'), true); await close();
    await open(three);

    // The patch really commits, then its response waits while the user
    // closes/reopens the dialog. The old continuation must not spend money.
    let observed; const patched = new Promise((resolve) => { observed = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**/api/cards/${three.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      const result = await route.fetch(); observed(); await held; await route.fulfill({ response: result });
    });
    await page.fill('#give-ref', 'another-base');
    await page.click('form[data-form="give"] button[type="submit"]'); await patched;
    await close(); await open(three); release(); release = null;
    await until(() => h.card(three.id).base_ref === 'another-base');
    await page.waitForTimeout(250);
    assert.equal(paid.some((r) => r.card.includes(three.id)), false);
    assert.equal(h.hub.pendingDispatch(three.id), null); assert.equal(h.card(three.id).run_state, null);
    assert.equal(await page.locator('[data-dialog="give"]').count(), 1, 'stale success cannot close the new dialog');
    await close();
    await advertise([ai('codex', 'none', { signedIn: false }), ai('claude', 'native')]);
    await open(three);
    assert.equal(await page.locator('#give-ai option[value="codex"]').isDisabled(), true);
    assert.match(await page.locator('#give-ai option[value="codex"]').textContent(), /sign in first/); await close();
    assert.deepEqual(errors, []);
  } finally { release?.(); await browser?.close(); await h.destroy(); }
});
