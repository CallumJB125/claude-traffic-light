// Home's task box (plan-orchestrator O4) against the mock supervisor and its real router: empty, routed, ask-me,
// running and needs-approval in light and dark; nothing starts while the line waits (no auto-run); the box hidden;
// and the widget page's "Used by your widget shortcut" line. The mock's routing knobs are changed mid-run.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { launchApp, embedded, focusMainWindow, snapToPixels } = require('./app');
const { shortTmp } = require('./tasks-mock');

const SHOT = { threshold: 0.05, stylePath: path.join(__dirname, 'no-hover-chrome.css'), maxDiffPixelRatio: 0.02, timeout: 20000 };
const api = (f) => pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', f)).href;
const window = { resetsAt: Date.now() + 3600e3, status: 'allowed' };

// These launches start with the first-run (widget) tour skipped, so Home's own teammate tour is done
// too (A5: one tour at a time, and skipping one skips both): no tour dialog opens at all.
async function skipTour(page) {
  await expect(page.locator('#status')).toContainText('Updated', { timeout: 20000 });
  await expect(page.locator('.tour')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

// The folder chip names a per-run temp folder, so it is masked.
async function shots(page, name, mask = []) {
  mask = ['#compose-folder', ...mask];
  const box = await snapToPixels(page.locator('#compose'));
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await expect(box).toHaveScreenshot(`${name}-${colorScheme}.png`, { ...SHOT, mask: mask.map((m) => page.locator(m)) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test.describe('with a supervisor', () => {
  let opts; let srv; let direct; let h; let page; let work;
  const tasks = async () => (await direct.listTasks({})).length;
  test.beforeAll(async () => {
    const { startMockServer } = await import(api('mock-server.js'));
    // Slow enough that a started task is still running when its card is shot (the work script's sleeps ÷ speed).
    opts = { dir: shortTmp(), speed: 0.2, demo: false, hbMs: 500 };
    srv = await startMockServer(opts);
    direct = await (await import(api('client.js'))).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
    work = shortTmp();
    h = await launchApp({ config: { tourState: { status: 'skipped', step: 0, at: null } }, env: { CLAUDE_TRAFFIC_LIGHT_TASKS_HOME: opts.dir, CLAUDE_TRAFFIC_LIGHT_TASKS_PICK: work } });
    page = await embedded(h.app, 'home', 'home.html');
    await skipTour(page);
  });
  test.afterAll(async () => { direct?.close(); await h?.cleanup(); await srv?.close(); fs.rmSync(opts.dir, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); });

  test('empty: the box, no route line, Run disabled', async () => {
    await expect(page.locator('#compose')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#compose-run')).toBeDisabled();
    await expect(page.locator('#compose-route')).toHaveAttribute('data-kind', /none|offline/);
    await expect(page.locator('#compose-route')).toHaveAttribute('data-kind', 'none', { timeout: 20000 });
    await shots(page, 'empty');
  });

  test('routed: the line names the AI and why; waiting 3.5 s starts nothing; Run starts exactly one', async () => {
    await page.locator('#compose-folder').selectOption('__pick');
    await expect(page.locator('#compose-folder')).toContainText(path.basename(work));
    await page.fill('#compose-text', 'Add a cache to the sync job');
    await expect(page.locator('#compose-route')).toHaveAttribute('data-kind', 'routed', { timeout: 10000 });
    await expect(page.locator('#compose-route')).toContainText('→ Claude');
    await expect(page.locator('#compose-run')).toBeEnabled();
    await shots(page, 'routed');
    // Callum, 2026-10-24: no auto-run. The line can sit there as long as it likes.
    await page.waitForTimeout(3500);
    expect(await tasks()).toBe(0);
    // Plain Enter is a newline, never a submit.
    await page.locator('#compose-text').press('Enter');
    await page.waitForTimeout(600);
    expect(await tasks()).toBe(0);
    await page.fill('#compose-text', 'Add a cache to the sync job');
    await expect(page.locator('#compose-route')).toHaveAttribute('data-kind', 'routed', { timeout: 10000 });
  });

  test('ask me: a tie offers both; Run waits for a pick; the pick runs; the running card', async () => {
    opts.defaultAi = null;
    opts.routeUsage = { claude: { utilization: 0.4, ...window }, codex: { utilization: 0.4, ...window } };
    await page.fill('#compose-text', 'Tidy the readme');
    await expect(page.locator('#compose-route')).toHaveAttribute('data-kind', 'ask', { timeout: 10000 });
    await expect(page.locator('#compose-route .choice')).toHaveCount(2);
    await expect(page.locator('#compose-run')).toBeDisabled();
    await shots(page, 'ask-me');
    await page.locator('#compose-route .choice[data-ai="codex"]').click();
    await expect(page.locator('#compose-run')).toBeEnabled();
    await focusMainWindow(h.app);
    await page.locator('#compose-run').click();
    await expect(page.locator('#compose-card')).toBeVisible({ timeout: 10000 });
    expect(await tasks()).toBe(1);
    const [t] = await direct.listTasks({});
    expect(t.ai.id).toBe('codex');
    await expect(page.locator('#compose-card')).toContainText('Codex', { timeout: 15000 });
    await expect(page.locator('#compose-stop')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#compose-card .title')).toHaveText('Tidy the readme');
    await shots(page, 'running', ['.compose-card-status', '.compose-lines']);
    opts.defaultAi = undefined; opts.routeUsage = undefined;
  });

  test('needs approval: the card points to Tasks; Home answers nothing', async () => {
    await page.locator('#compose-new').click();
    await page.locator('#compose-who').selectOption('claude');
    await page.locator('#compose-perm').selectOption('ask');
    await page.fill('#compose-text', 'Update the changelog');
    await expect(page.locator('#compose-route')).toHaveAttribute('data-kind', 'routed', { timeout: 10000 });
    // The first task is still working in this folder: Run waits until that is acknowledged.
    await expect(page.locator('#compose-peers')).toContainText('1 other task is working in this project.', { timeout: 10000 });
    await expect(page.locator('#compose-run')).toBeDisabled();
    await page.locator('#compose-ack').click();
    await focusMainWindow(h.app);
    await page.locator('#compose-run').click();
    await expect(page.locator('.compose-approval')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#compose-review')).toBeVisible();
    await expect(page.locator('#compose-card .title')).toHaveText('Update the changelog');
    await expect(page.getByRole('button', { name: /Allow|Approve|Deny/ })).toHaveCount(0);
    await shots(page, 'needs-approval', ['.compose-card-status', '.compose-lines', '.compose-approval']);
    expect(await tasks()).toBe(2);
  });
});

test.describe('box hidden and the widget key taken', () => {
  let h;
  test.beforeAll(async () => {
    h = await launchApp({ config: { tourState: { status: 'skipped', step: 0, at: null }, homeComposer: false, widgetShortcut: 'CmdOrCtrl+Shift+Space', composeShortcut: 'Shift+Command+Space' } });
  });
  test.afterAll(async () => { await h?.cleanup(); });

  test('Home without the box; New task… opens the Tasks composer', async () => {
    const home = await embedded(h.app, 'home', 'home.html');
    await skipTour(home);
    await home.waitForTimeout(800);
    await expect(home.locator('#compose')).toBeHidden();
    await home.mouse.move(0, 0);
    await expect(home.locator('.page-head')).toHaveScreenshot('home-hidden-head.png', SHOT);
    await h.app.evaluate(() => global.__plexiformCompose.press());
    const tasks = await embedded(h.app, 'tasks', 'tasks.html', { timeout: 45000 });
    await expect(tasks.locator('.composer h2')).toHaveText('New task', { timeout: 15000 });
  });

  test('the widget page says the widget shortcut has the key', async () => {
    const page = await embedded(h.app, 'widget', 'widget-page.html', { timeout: 45000 });
    await expect(page.locator('#compose-shortcut')).toHaveValue('Shift+Command+Space', { timeout: 15000 });
    await expect(page.locator('#compose-shortcut-note')).toHaveText(/Used by your widget shortcut/);
    await expect(page.locator('#compose-shortcut-hint')).toContainText('Parameter Hints in VS Code and Cursor');
    const row = await snapToPixels(page.locator('#compose-shortcut').locator('xpath=ancestor::section'));
    await page.mouse.move(0, 0);
    await expect(row).toHaveScreenshot('widget-compose-taken.png', { ...SHOT, mask: [page.locator('#stage'), page.locator('.screen')] });
  });
});
