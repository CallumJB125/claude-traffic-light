// Exercise the real account flow, Settings IPC, secure local broker and
// Codex's configuration commands. All accounts and config files are isolated;
// no AI model is invoked and no installed user's app configuration is touched.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');
const { request } = require('../native-board/client');

test('a signed-in person connects only selected boards and Undo revokes the live connection', async () => {
  const h = await launchApp({ extraArgs: ['--buddy-mock-accounts', '--buddy', 'team'] });
  try {
    let output = '';
    h.app.process().stdout.on('data', (chunk) => { output += chunk.toString(); });
    const log = () => {
      try { return output + fs.readFileSync(path.join(h.home, 'app.log'), 'utf8'); } catch { return output; }
    };
    await expect.poll(() => /mock accounts hub at http:\/\/127\.0\.0\.1:\d+/.test(log())).toBe(true);
    const hub = /mock accounts hub at (http:\/\/127\.0\.0\.1:\d+)/.exec(log())[1];
    const account = await windowByFile(h.app, 'account.html');
    await account.evaluate(() => window.buddyAccount.go('hub'));
    const hubPage = await windowByFile(h.app, 'account.html');
    await hubPage.locator('input[name="url"]').fill(hub);
    await hubPage.getByRole('button', { name: 'Continue', exact: true }).click();
    const emailPage = await windowByFile(h.app, 'account.html');
    await expect(emailPage.getByRole('button', { name: 'Use an email code instead' })).toBeVisible();
    await emailPage.getByRole('button', { name: 'Use an email code instead' }).click();
    const email = 'native-settings-fixture@example.com';
    await emailPage.locator('input[name="email"]').fill(email);
    await emailPage.getByRole('button', { name: 'Email me a code' }).click();
    // This is the dev-only mock mailer's synthetic code, never a live OTP.
    await expect.poll(() => log().includes(`sign-in code for ${email}: `)).toBe(true);
    const code = new RegExp(`sign-in code for ${email.replaceAll('.', '\\.')}: (\\d{6})`).exec(log())[1];
    const codePage = await windowByFile(h.app, 'account.html');
    await codePage.getByRole('textbox', { name: '6-digit code' }).fill(code);

    const widget = await windowByFile(h.app, 'index.html');
    await widget.evaluate(() => window.trafficLight.openLights());
    await (await windowByFile(h.app, 'lights.html')).evaluate(() => window.lightsApi.openPreferences());
    const settings = await windowByFile(h.app, 'settings.html');
    const teams = settings.locator('#native-board-workspace option[value]:not([value=""])');
    await expect(teams).toHaveCount(1);
    await settings.locator('#native-board-workspace').selectOption(await teams.first().getAttribute('value'));
    const board = settings.getByRole('group', { name: 'Boards to connect' }).getByRole('checkbox');
    await expect(board).toHaveCount(1);
    await expect(board).not.toBeChecked();
    await expect(settings.getByRole('button', { name: 'Connect boards' })).toBeDisabled();
    await board.check();
    const boardId = await board.getAttribute('value');
    await settings.getByRole('button', { name: 'Connect boards' }).click();
    await expect(settings.locator('#native-board-hint')).toContainText('Connected. Open a new session');
    await expect(board).toBeChecked();
    const userData = await h.app.evaluate(({ app }) => app.getPath('userData'));
    const grant = path.join(userData, 'native-board', 'codex.json');
    const boards = await request(grant, 'plexiform_list_boards', {});
    expect(boards.ok).toBe(true);
    expect(boards.boards.map((b) => b.id)).toEqual([boardId]);
    const config = path.join(userData, 'native-board-dev-home', '.codex', 'config.toml');
    expect(fs.readFileSync(config, 'utf8')).toContain('[mcp_servers.plexiform-board]');
    expect(await widget.evaluate(() => typeof window.settingsApi)).toBe('undefined');

    await settings.getByRole('button', { name: 'Remove connection' }).click();
    await expect(settings.locator('#native-board-hint')).toContainText('Connection removed');
    expect((await request(grant, 'plexiform_list_boards', {})).code).toBe('UNAVAILABLE');
    expect(fs.readFileSync(config, 'utf8')).not.toContain('[mcp_servers.plexiform-board]');
    await expect(board).not.toBeChecked();
  } finally { await h.cleanup(); }
});
