// The Tasks page against the mock supervisor (board/tasks-api/mock-server.js):
// the list, a task's transcript and thread, a message, an action, the
// composer, and the empty state when nothing is running. The page is opened
// the way a person does: the tray's "Open Tasks…".
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');
const { startTasksMock, shortTmp } = require('./tasks-mock');

const SHOT = { threshold: 0.05, stylePath: path.join(__dirname, 'no-hover-chrome.css') };
const openTasks = async (app) => {
  await expect.poll(() => app.evaluate(() => !!global.__buddyTrayMenu).catch(() => false), { timeout: 15000 }).toBe(true);
  await app.evaluate(() => global.__buddyTrayMenu.items.find((i) => i.label === 'Open Tasks…').click());
  const page = await windowByFile(app, 'tasks.html');
  await page.waitForLoadState('load');
  return page;
};
const row = (page, text) => page.locator('#list .row', { hasText: text });

test.describe('with a supervisor', () => {
  let mock; let h; let page; let work;
  test.beforeAll(async () => {
    mock = await startTasksMock();
    work = shortTmp();
    h = await launchApp({ env: { CLAUDE_TRAFFIC_LIGHT_TASKS_HOME: mock.dir, CLAUDE_TRAFFIC_LIGHT_TASKS_PICK: work } });
    page = await openTasks(h.app);
  });
  test.afterAll(async () => { await h?.cleanup(); await mock?.close(); fs.rmSync(work, { recursive: true, force: true }); });

  test('the list shows every task with its state, AI and folder, and nothing dead looks alive', async () => {
    await expect(page.locator('#list .row')).toHaveCount(5, { timeout: 15000 });
    // let the scripted demo reach its resting states
    await expect(row(page, 'Add a dark mode toggle')).toContainText('Needs you', { timeout: 20000 });
    await expect(row(page, 'Refactor the payment parser')).toContainText('Paused', { timeout: 20000 });
    await expect(row(page, 'Migrate the test fixtures')).toContainText('Orphaned', { timeout: 20000 });
    await expect(row(page, 'Add a dark mode toggle')).toContainText('Claude');
    await expect(row(page, 'Add a dark mode toggle')).toContainText('acme-web');
    for (const t of ['Refactor the payment parser', 'Migrate the test fixtures']) await expect(row(page, t).locator('.dot')).not.toHaveClass(/green/);
    await expect(page.locator('#list .row').first()).toContainText(/Needs you|Orphaned/, { timeout: 5000 });
    await page.waitForTimeout(2500);
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('list-empty-detail.png', { ...SHOT, mask: [page.locator('.age')], maxDiffPixelRatio: 0.02 });
  });

  test('open a task: the transcript appears and the approval is answerable; an action round-trips', async () => {
    await row(page, 'Add a dark mode toggle').click();
    await expect(page.locator('#d-head .d-title')).toHaveText(/dark mode/i);
    await expect(page.locator('#tx .msg').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tx .tool').first()).toBeVisible();
    await expect(page.locator('#d-banners .ask')).toContainText('Wants to use Bash');
    expect(await page.evaluate(() => document.body.innerHTML.includes('btk_'))).toBe(false);
    await page.waitForTimeout(500);
    await expect(page.locator('#main')).toHaveScreenshot('detail-needs-you.png', { ...SHOT, mask: [page.locator('.age'), page.locator('.d-meta')], maxDiffPixelRatio: 0.03 });
    await page.getByRole('button', { name: 'Allow once' }).click();
    await expect(page.locator('#d-head .d-state')).not.toContainText('Needs you', { timeout: 15000 });
    await expect(page.locator('#d-head .d-state')).toContainText(/Running|Ready to review|Quiet/, { timeout: 15000 });
  });

  test('a destructive action asks first, and cancelling does nothing', async () => {
    await row(page, 'Migrate the test fixtures').click();
    await expect(page.locator('#d-head .d-state')).toContainText('Orphaned');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.confirm')).toContainText('Stop this task?');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.confirm')).toHaveCount(0);
    await expect(page.locator('#d-head .d-state')).toContainText('Orphaned');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, stop' }).click();
    await expect(page.locator('#d-head .d-state')).toContainText('Failed', { timeout: 15000 });
  });

  test('the paused-for-limit task offers the supervisor’s own ways forward', async () => {
    await row(page, 'Refactor the payment parser').click();
    await expect(page.locator('#d-head .d-state')).toContainText('Paused');
    await expect(page.locator('#d-banners .ask')).toContainText(/limit/i);
    await expect(page.getByRole('button', { name: /Continue with Codex/ }).first()).toBeVisible();
  });

  test('composer: ⌥⌘T opens it, it validates, and a new task starts, shows up and takes a message', async () => {
    await page.keyboard.press('Alt+Meta+T');
    await expect(page.locator('.composer h2')).toHaveText('New task');
    await page.locator('#c-go').click();
    await expect(page.locator('#c-err')).toHaveText('Say what you want done first.');
    await page.fill('#c-text', 'Add a cache to the sync job');
    await page.locator('#c-go').click();
    await expect(page.locator('#c-err')).toHaveText('Choose the folder it should work in.');
    await page.locator('#c-folder-btn').click();
    await expect(page.locator('#c-folder')).toContainText(path.basename(work));
    await expect(page.locator('#c-ai option')).not.toHaveCount(1, { timeout: 10000 });
    await page.mouse.move(0, 0);
    await expect(page.locator('#main')).toHaveScreenshot('composer.png', { ...SHOT, maxDiffPixelRatio: 0.03 });
    await page.locator('#c-go').click();
    await expect(page.locator('#d-head .d-title')).toContainText('Add a cache', { timeout: 15000 });
    await expect(row(page, 'Add a cache')).toHaveCount(1);
    await page.locator('#tab-messages').click();
    await expect(page.locator('#send-text')).toBeEnabled({ timeout: 20000 });
    await page.fill('#send-text', 'please keep the public API unchanged');
    await page.locator('#send-btn').click();
    await expect(page.locator('#thread .bubble.out .body')).toHaveText('please keep the public API unchanged', { timeout: 10000 });
    await expect(page.locator('#thread .bubble.out .who')).toHaveText('You');
    await expect(page.locator('#send-text')).toHaveValue('');
  });

  test('messages between tasks: an unread badge, the thread, and a flagged message is marked untrusted', async () => {
    // D and E exchange messages in the mock; one of them ends up with an inbound peer message.
    await expect(page.locator('#list .badge').first()).toBeVisible({ timeout: 20000 });
    await row(page, 'Update the API client').click();
    await page.locator('#tab-messages').click();
    const peer = page.locator('#thread .bubble.in', { hasText: 'From' });
    await expect(peer.first()).toBeVisible({ timeout: 10000 });
    await expect(peer.first().locator('.who')).toContainText('untrusted');
    const flagged = page.locator('#thread .bubble.flagged');
    await expect(flagged).toHaveCount(1);
    await expect(flagged.locator('.st')).toContainText('suspicious');
    await expect(row(page, 'Update the API client').locator('.badge')).toHaveCount(0, { timeout: 5000 });
    await page.mouse.move(0, 0);
    await expect(page.locator('#main')).toHaveScreenshot('thread-flagged.png', { ...SHOT, mask: [page.locator('.d-meta')], maxDiffPixelRatio: 0.03 });
  });

  test('markup in a message is shown as text, never run', async () => {
    const e = [...mock.srv.tasks.values()].find((t) => t.text.startsWith('Update the API client'));
    mock.srv.receiveExternal(e.id, { kind: 'member', id: 'mallory', label: '<b>Mallory</b>' }, '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script> hello');
    await row(page, 'Update the API client').click();
    await page.locator('#tab-messages').click();
    const bubble = page.locator('#thread .bubble', { hasText: 'hello' });
    await expect(bubble.locator('.body')).toContainText('<img src=x onerror=');
    await expect(bubble.locator('.who')).toContainText('<b>Mallory</b>');
    expect(await page.locator('#main img, #main script, #main b').count()).toBe(0);
    expect(await page.evaluate(() => window.__pwn)).toBeUndefined();
  });
});

test.describe('no supervisor', () => {
  test('a plain empty state with a next step, then it connects by itself once the helper is up', async () => {
    const dir = shortTmp();
    const absent = path.join(dir, 'board');
    let h; let mock;
    try {
      h = await launchApp({ env: { CLAUDE_TRAFFIC_LIGHT_TASKS_HOME: absent } });
      const page = await openTasks(h.app);
      await expect(page.locator('#main h2')).toHaveText("Tasks run in the background helper, which isn't running yet.", { timeout: 15000 });
      await expect(page.locator('#main')).toContainText('connects by itself');
      await expect(page.getByRole('button', { name: 'Try again now' })).toBeVisible();
      await expect(page.locator('#list-empty')).toHaveText('');
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot('no-supervisor.png', { ...SHOT, maxDiffPixelRatio: 0.02 });
      // the page cannot start a task without it, and says so in words
      await page.keyboard.press('Alt+Meta+T');
      await expect(page.locator('.composer .err').first()).toContainText('not running');
      await expect(page.locator('#c-go')).toBeDisabled();
      mock = await startTasksMock({ dir: absent, speed: 40 });
      await expect(page.locator('#list .row')).toHaveCount(5, { timeout: 40000 });
    } finally {
      await h?.cleanup();
      await mock?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('when the supervisor goes away, every live task says "Connection lost" and none is green', async () => {
    // Real time and no demo tasks, so one task we start stays running (green) long enough to watch it go.
    const mock = await startTasksMock({ speed: 1, demo: false });
    const h = await launchApp({ env: { CLAUDE_TRAFFIC_LIGHT_TASKS_HOME: mock.dir } });
    try {
      const page = await openTasks(h.app);
      const { connect } = await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href);
      const c = await connect({ socketPath: mock.srv.socketPath, tokenPath: mock.srv.tokenPath });
      await c.createTask({ text: 'Keep running for a while', cwd: '/Users/demo/Development/acme-web', ai: 'claude', source: 'cli' });
      c.close();
      await expect(page.locator('#list .row')).toHaveCount(1, { timeout: 15000 });
      await expect(page.locator('#list .dot.green')).toHaveCount(1, { timeout: 25000 });
      await mock.srv.close();
      await expect(page.locator('#conn-note')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('#list .dot.green')).toHaveCount(0);
      await expect(page.locator('#list .row', { hasText: 'Connection lost' }).first()).toBeVisible();
    } finally {
      await h.cleanup();
      fs.rmSync(mock.dir, { recursive: true, force: true });
    }
  });
});
