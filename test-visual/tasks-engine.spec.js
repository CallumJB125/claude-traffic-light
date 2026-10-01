// Real desktop utilityProcess + Tasks socket + Codex adapter. Only the AI CLI
// is a hermetic fake; this spec never invokes Claude or a paid model.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

test('Tasks desktop starts its real helper, creates isolated Codex work, resumes review feedback and uses the sidebar', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/pxt-ui-')); const repo = path.join(dir, 'repo'); const bins = path.join(dir, 'bin'); const auth = path.join(dir, 'auth');
  for (const d of [repo, bins, auth]) fs.mkdirSync(d, { mode: 0o700 });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('config', 'commit.gpgsign', 'false'); fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n'); git('add', '-A'); git('commit', '-qm', 'init');
  const scenario = path.join(dir, 'scenario.json'); const log = path.join(dir, 'codex.log'); fs.writeFileSync(scenario, JSON.stringify({ write: true, text: 'Fixture completed' }));
  const fixture = path.join(__dirname, '..', 'board', 'runner', 'test', 'fixtures', 'fake-codex.js');
  fs.writeFileSync(path.join(bins, 'codex'), `#!/bin/sh\nexport PLEXIFORM_FAKE_CODEX_SCENARIO=${quote(scenario)}\nexport PLEXIFORM_FAKE_CODEX_LOG=${quote(log)}\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 });
  let h;
  try {
    h = await launchApp({ env: { PATH: `${bins}:${process.env.PATH}`, CODEX_HOME: auth, CLAUDE_TRAFFIC_LIGHT_TASKS_PICK: repo } });
    await expect.poll(() => h.app.evaluate(() => !!global.__buddyTrayMenu)).toBe(true);
    await h.app.evaluate(() => global.__buddyTrayMenu.items.find((i) => i.label === 'Open Tasks…').click());
    const page = await windowByFile(h.app, 'tasks.html'); await page.waitForLoadState('load');
    await expect(page.locator('#main h2')).toHaveText('No tasks yet', { timeout: 20000 });
    await page.locator('#new-task').click();
    await expect(page.locator('#c-ai option[value="codex"]')).toBeEnabled({ timeout: 10000 });
    await expect(page.locator('#c-ai')).not.toContainText('Claude');
    await expect(page.locator('#c-perm')).not.toContainText('Ask me');
    await page.fill('#c-text', 'Build the isolated fixture'); await page.locator('#c-folder-btn').click(); await page.locator('#c-go').click();
    await expect(page.locator('#d-head .d-state')).toContainText('Ready to review', { timeout: 20000 });
    await expect(page.locator('#d-head')).toContainText('Codex');
    await expect(page.locator('#tx')).toContainText('Fixture completed');
    expect(fs.existsSync(path.join(repo, 'codex-result.txt'))).toBe(false);
    const starts = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((x) => x.kind === 'start');
    expect(starts()).toHaveLength(1); expect(fs.existsSync(path.join(starts()[0].cwd, 'codex-result.txt'))).toBe(true);
    await page.locator('#tab-messages').click(); await page.fill('#send-text', 'Add this review feedback'); await page.locator('#send-btn').click();
    await expect.poll(() => starts().length).toBe(2); expect(starts()[1].argv).toContain('resume');
    await expect(page.locator('#d-head .d-state')).toContainText('Ready to review');
    // Open the same real engine from the ordinary main window/sidebar.
    await h.app.evaluate(() => global.__buddyTrayMenu.items.find((i) => /Open Plexiform/.test(i.label)).click());
    const shell = await windowByFile(h.app, 'buddy-window/sidebar.html'); await shell.waitForLoadState('load');
    await shell.locator('[data-page="tasks"]').click();
    await expect.poll(() => h.app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => w.getURL().includes('tasks.html?embedded=1')))).toBe(true);
    const noSecret = await page.evaluate(() => !/btk_|btr_/.test(document.body.innerText)); expect(noSecret).toBe(true);
  } finally { await h?.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});
