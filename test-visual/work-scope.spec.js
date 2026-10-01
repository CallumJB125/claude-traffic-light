// Work scope on the bubble rows and in the tray (accounts contract §C2),
// against the test-only mock of the core's module (work-scope-mock.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');
const F = require('./inputs-fixtures');

const SHOT = { threshold: 0.05, stylePath: path.join(__dirname, 'no-hover-chrome.css') };
const REPO = { short: 'acme/api', canonicalUrl: 'https://github.com/acme/api' };
let h;
let widget;
let mockDir;
const fixture = (f) => fs.writeFileSync(path.join(mockDir, 'fixture.json'), JSON.stringify(f));
const calls = () => { try { return JSON.parse(fs.readFileSync(path.join(mockDir, 'calls.json'), 'utf8')); } catch { return []; } };
const trayItems = () => h.app.evaluate(() => global.__buddyTrayMenu.items.map((i) => ({ label: i.label, enabled: i.enabled, checked: i.checked })));
// One waiting input for the session: the bubble opens it.
const waiting = (id, cwd = '/visual/api') => F.hookSync(h, 'notification', { session_id: id, cwd, notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' });

test.beforeAll(async () => {
  mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-scope-'));
  fixture({});
  h = await launchApp({ env: { CLAUDE_TRAFFIC_LIGHT_WORK_SCOPE_MOCK: mockDir } });
  widget = await windowByFile(h.app, 'index.html');
  await widget.emulateMedia({ reducedMotion: 'reduce' });
});
test.afterAll(async () => { await h?.cleanup(); fs.rmSync(mockDir, { recursive: true, force: true }); });
test.beforeEach(async () => {
  F.clearSessions(h);
  await expect(widget.locator('.ib-item')).toHaveCount(0, { timeout: 10000 });
});

test('tray: disabled with no session at all', async () => {
  await expect.poll(trayItems).toEqual(expect.arrayContaining([{ label: 'This session is personal — don’t track', enabled: false, checked: false }]));
});

for (const [state, label] of [['watching', 'watching locally'], ['counting', 'counting for Platform'], ['personal', 'personal']]) {
  test(`badge: ${state}`, async () => {
    const id = `ws-${state}`;
    fixture({ [id]: { state, board: { id: 'b1', name: 'Platform' }, repo: REPO } });
    waiting(id);
    await expect(widget.locator('.ib-body .ib-scope')).toHaveText(label, { timeout: 10000 });
    await widget.waitForTimeout(900);
    await expect(widget).toHaveScreenshot(`scope-${state}.png`, SHOT);
  });
}

test('outside, or a session the core gives no scope: no badge, and the tray item hides', async () => {
  fixture({ 'ws-out': { state: 'outside', board: null, repo: null } });
  waiting('ws-out');
  await expect(widget.locator('.ib-item')).toHaveCount(1, { timeout: 10000 });
  await expect(widget.locator('.ib-scope')).toHaveCount(0);
  F.clearSessions(h);
  fixture({});
  waiting('ws-none');
  await expect(widget.locator('.ib-item')).toHaveCount(1, { timeout: 10000 });
  await expect(widget.locator('.ib-scope, .ib-scope-line')).toHaveCount(0);
  await expect.poll(async () => (await trayItems()).some((i) => /personal — don’t track/.test(i.label))).toBe(false);
});

test('Not team work → personal → Undo, and the repo-wide choice behind ⋯', async () => {
  fixture({ 'ws-flow': { state: 'counting', board: { id: 'b1', name: 'Platform' }, repo: REPO } });
  waiting('ws-flow');
  await expect(widget.locator('.ib-body .ib-scope')).toHaveText('counting for Platform', { timeout: 10000 });
  const before = calls().length;
  await widget.getByRole('button', { name: /^Not team work/ }).click();
  await expect(widget.locator('.ib-body .ib-scope')).toHaveText('personal', { timeout: 10000 });
  await widget.getByRole('button', { name: /^Undo personal/ }).click();
  await expect(widget.locator('.ib-body .ib-scope')).toHaveText('counting for Platform', { timeout: 10000 });
  await widget.getByRole('button', { name: 'More work-scope choices' }).click();
  await widget.getByRole('button', { name: /^Always treat/ }).click();
  await expect(widget.locator('.ib-body .ib-scope')).toHaveText('personal', { timeout: 10000 });
  expect(calls().slice(before)).toEqual([
    { fn: 'setSessionScope', args: ['ws-flow', 'personal'] },
    { fn: 'setSessionScope', args: ['ws-flow', 'auto'] },
    { fn: 'setRepoScope', args: ['https://github.com/acme/api', 'personal'] },
  ]);
  // main checks what it is given: nothing reaches the core for a bad call.
  const bad = await widget.evaluate(async () => [
    await window.trafficLight.setSessionScope('x'.repeat(129), 'personal'),
    await window.trafficLight.setSessionScope('ws-flow', 'pause-everything'),
    await window.trafficLight.setRepoScope(42, 'personal'),
  ]);
  expect(bad.map((r) => r.ok)).toEqual([false, false, false]);
  expect(calls().length).toBe(before + 3);
  await h.app.evaluate(() => global.__buddyTrayMenu); // menu exists
});

test('tray: the most recently active session, with its folder; a click marks it personal', async () => {
  // Another repo: the flow test above marked acme/api personal for good.
  const repo = { short: 'acme/web', canonicalUrl: 'https://github.com/acme/web' };
  fixture({ 'ws-old': { state: 'counting', board: { id: 'b1', name: 'Platform' }, repo }, 'ws-new': { state: 'watching', board: { id: 'b1', name: 'Platform' }, repo } });
  waiting('ws-old', '/visual/older-app');
  await new Promise((r) => setTimeout(r, 1100));
  waiting('ws-new', '/visual/newest-app');
  await expect.poll(async () => (await trayItems())[0]).toEqual({ label: 'This session is personal — don’t track (newest-app)', enabled: true, checked: false });
  const before = calls().length;
  await h.app.evaluate(() => global.__buddyTrayMenu.items[0].click());
  expect(calls().slice(before)).toEqual([{ fn: 'setSessionScope', args: ['ws-new', 'personal'] }]);
  await expect.poll(async () => (await trayItems())[0].checked).toBe(true);
});

// Its own app: no core module and no mock, as on main today.
test('no work-scope module: nothing shown, no tray item, no IPC', async () => {
  const hh = await launchApp({});
  try {
    const w = await windowByFile(hh.app, 'index.html');
    F.hookSync(hh, 'notification', { session_id: 'ws-plain', cwd: '/visual/api', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' });
    await expect(w.locator('.ib-item')).toHaveCount(1, { timeout: 10000 });
    await expect(w.locator('.ib-scope, .ib-scope-line')).toHaveCount(0);
    const items = await hh.app.evaluate(() => global.__buddyTrayMenu.items.map((i) => i.label));
    expect(items.some((l) => /don’t track/.test(l))).toBe(false);
    const r = await w.evaluate(() => window.trafficLight.setSessionScope('ws-plain', 'personal').then(() => 'answered', (e) => String(e.message)));
    expect(r).toMatch(/No handler registered/);
  } finally { await hh.cleanup(); }
});
