// A Give-to-Claude run stopped at its budget: the widget row, the tray item,
// the fallback when the Plexiform window can't open the board card, dismiss,
// dedupe, and the ask bubble outranking it. The runner event is injected
// through main's dev hook (the runner path isn't available headless).
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, signal, windowByFile } = require('./app');
const F = require('./inputs-fixtures');

const SHOT = { threshold: 0.05, stylePath: path.join(__dirname, 'no-hover-chrome.css') };
const EVENT = { type: 'run.budget_reached', run_id: 'run_1', card_id: 'card-9', card_key: 'PLX-123', spent_usd: 4.8, budget_usd: 5 };
const TEXT = 'Your run on PLX-123 reached its budget ($4.80 of $5.00)';

let h;
let widget;
const inject = (ev) => h.app.evaluate((_e, x) => global.__budgetInject(x), ev);
const trayLabels = () => h.app.evaluate(() => global.__buddyTrayMenu.items.map((i) => i.label));

test.beforeAll(async () => {
  h = await launchApp({ config: { askFromWidget: true }, env: { CLAUDE_BUDDY_BUDGET_HOOK: '1' } });
  widget = await windowByFile(h.app, 'index.html');
  await widget.emulateMedia({ reducedMotion: 'reduce' });
});
test.afterAll(async () => { await h?.cleanup(); });

test('the event shows a row with the text and both buttons; a duplicate adds nothing; the tray lists it', async () => {
  await inject(EVENT);
  await expect(widget.locator('#budget')).toBeVisible({ timeout: 10000 });
  await expect(widget.locator('#budget-text')).toHaveText(TEXT);
  await expect(widget.locator('#budget-acts button')).toHaveText(['Increase budget & continue…', 'Stop run…']);
  await inject(EVENT);
  await inject({ ...EVENT, run_id: 'bad id' });
  await widget.waitForTimeout(300);
  await expect(widget.locator('#budget-text')).toHaveText(TEXT);
  expect(await trayLabels()).toContain('Your run on PLX-123 reached its budget…');
  expect((await trayLabels()).filter((l) => l.includes('reached its budget'))).toHaveLength(1);
  await expect.poll(() => widget.evaluate(() => innerHeight)).toBe(200 + 64);
  await widget.waitForTimeout(600);
  await expect(widget).toHaveScreenshot('widget-budget-notice.png', SHOT);
});

test('a status broadcast with the same data keeps the buttons (a click is not lost)', async () => {
  await widget.evaluate(() => { document.querySelector('#budget-acts button').dataset.same = '1'; });
  await signal(h, { signal: 'tool-use', session: 'bc', source: 'claude', cwd: '/work/bc', tool: 'Bash' });
  await expect.poll(async () => (await widget.evaluate(() => window.trafficLight.getAggregateStatus())).sessions.length).toBeGreaterThan(0);
  await widget.waitForTimeout(500);
  expect(await widget.evaluate(() => document.querySelector('#budget-acts button').dataset.same)).toBe('1');
  await signal(h, { signal: 'session-end', session: 'bc', source: 'claude' });
});

test('with no way to open the card, a button says where to go and offers the board', async () => {
  await widget.locator('#budget-acts button', { hasText: 'Stop run…' }).click();
  await expect(widget.locator('#budget-text')).toHaveText('Open the card on your board to raise the budget or stop the run.');
  await expect(widget.locator('#budget-acts button')).toHaveText(['Open board']);
});

test('a button opens the board with the fragment main builds, when the window offers it', async () => {
  await h.app.evaluate(() => { global.__budgetCalls = []; global.__budgetOpenWithFragment = async (...a) => { global.__budgetCalls.push(a); return { ok: true }; }; });
  await inject({ ...EVENT, run_id: 'run_2', card_id: 'card-2' });
  await widget.locator('#budget-acts button').first().click();
  await expect.poll(() => h.app.evaluate(() => global.__budgetCalls.length)).toBe(1);
  const [page, fragment] = await h.app.evaluate(() => global.__budgetCalls[0]);
  expect(page).toBe('board');
  expect(fragment).toMatch(/^plexiform-budget=[A-Za-z0-9_-]+$/);
  expect(JSON.parse(Buffer.from(fragment.split('=')[1], 'base64url').toString())).toEqual({ v: 1, card_id: 'card-2' });
  await h.app.evaluate(() => { global.__budgetOpenWithFragment = undefined; });
});

test('x dismisses, run.ended clears, and the next notice shows', async () => {
  await widget.locator('#budget-x').click();
  await expect(widget.locator('#budget-text')).toContainText('PLX-123'); // run_1 is next
  await inject({ type: 'run.ended', run_id: 'run_1' });
  await expect(widget.locator('#budget')).toBeHidden();
  expect(await trayLabels()).not.toContain('Your run on PLX-123 reached its budget…');
  expect(await widget.evaluate(() => innerHeight)).toBe(200);
});

test('the ask bubble wins while it is up', async () => {
  await inject({ ...EVENT, card_key: undefined, run_id: 'run_3' });
  await expect(widget.locator('#budget-text')).toHaveText('Your Give to Claude run reached its budget ($4.80 of $5.00)');
  const hook = F.blockingHook(h, 'permission-request', { session_id: 'vis-budget', cwd: '/visual/app', tool_name: 'Bash', tool_input: { command: 'git status' } });
  await expect(widget.locator('.ib-item.kind-permission.open')).toBeVisible({ timeout: 10000 });
  await expect(widget.locator('#budget')).toBeHidden();
  await widget.waitForTimeout(900);
  await widget.locator('[data-option="allow"]').click();
  await hook.done;
  await expect(widget.locator('#budget')).toBeVisible({ timeout: 10000 });
});
