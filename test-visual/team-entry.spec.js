// Team and Integrations findable without signing in: the tray items, the
// Settings "Account & team" section and the widget's one-time hint. Which page
// opened is read from the Plexiform window's own sidebar and account screen.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');
const F = require('./inputs-fixtures');

const SHOT = { threshold: 0.05, stylePath: path.join(__dirname, 'no-hover-chrome.css') };
const trayClick = (app, label) => app.evaluate((_e, l) => global.__buddyTrayMenu.items.find((i) => i.label === l).click(), label);
const trayLabels = (app) => app.evaluate(() => global.__buddyTrayMenu.items.map((i) => i.label));
const shownPage = async (app, label) => expect((await windowByFile(app, 'sidebar.html')).locator('[aria-current="page"]')).toContainText(label, { timeout: 15000 });
const accountScreen = async (app, screen) => {
  await expect.poll(() => app.windows().filter((p) => p.url().includes('account.html')).map((p) => new URL(p.url()).searchParams.get('screen')), { timeout: 15000 }).toContain(screen);
};

test.describe('tray and Settings', () => {
  let h;
  test.beforeAll(async () => { h = await launchApp(); });
  test.afterAll(async () => { await h?.cleanup(); });

  test('the tray has Team and Integrations, and they open those pages', async () => {
    await expect.poll(() => trayLabels(h.app).catch(() => []), { timeout: 15000 }).toContain('Team…');
    const labels = await trayLabels(h.app);
    expect(labels).toContain('Team…');
    expect(labels).toContain('Integrations…');
    expect(labels.indexOf('Team…')).toBe(labels.indexOf('Waiting on you…') + 1);
    await trayClick(h.app, 'Integrations…');
    await shownPage(h.app, 'Integrations');
    await trayClick(h.app, 'Team…');
    await shownPage(h.app, 'Team');
    await accountScreen(h.app, 'team');
  });

  test('Settings → Account & team renders neutrally and its buttons open the right pages', async () => {
    const widget = await windowByFile(h.app, 'index.html');
    await widget.evaluate(() => window.trafficLight.openLights());
    const lights = await windowByFile(h.app, 'lights.html');
    await lights.evaluate(() => window.lightsApi.openPreferences());
    const settings = await windowByFile(h.app, 'settings.html');
    await settings.waitForLoadState('load');
    const line = settings.locator('#account-line');
    await expect(line).toHaveText(/Teams, the shared board and integrations live on Plexiform's team hub \(.+\)\./);
    await expect(line).not.toContainText(/signed in/i);
    await settings.locator('#account-section').scrollIntoViewIfNeeded();
    await settings.waitForTimeout(300);
    await expect(settings.locator('#account-section')).toHaveScreenshot('settings-account-team.png', SHOT);
    await settings.locator('#account-team').click();
    await shownPage(h.app, 'Team');
    await settings.locator('#account-open').click();
    await shownPage(h.app, 'Account');
    await accountScreen(h.app, 'account');
  });

  // The Plexiform window starts the sign-in flow only where its open() routes
  // the 'signin' id; until then this checks the button reaches the window, not the screen.
  test('Sign in… opens the Plexiform window', async () => {
    const hh = await launchApp();
    try {
      const widget = await windowByFile(hh.app, 'index.html');
      await widget.evaluate(() => window.trafficLight.openLights());
      await (await windowByFile(hh.app, 'lights.html')).evaluate(() => window.lightsApi.openPreferences());
      const settings = await windowByFile(hh.app, 'settings.html');
      await settings.locator('#account-signin').click();
      await windowByFile(hh.app, 'sidebar.html');
    } finally { await hh.cleanup(); }
  });

  test('only the Settings window may use the account IPC', async () => {
    const widget = await windowByFile(h.app, 'index.html');
    expect(await widget.evaluate(() => typeof window.settingsApi)).toBe('undefined');
  });
});

test.describe('widget hint', () => {
  test('shows once on an idle widget, dismiss persists across a relaunch, never over a bubble', async () => {
    const h1 = await launchApp({ config: { hints: { teamSeen: false } } });
    let h2;
    try {
      const w = await windowByFile(h1.app, 'index.html');
      const row = w.locator('#update');
      await expect(row).toBeVisible({ timeout: 15000 });
      await expect(w.locator('#update-text')).toHaveText('Working with others? Plexiform has a shared team board.');
      await expect(w.locator('#update-btn')).toHaveText('Open Team');
      await expect(w.locator('#update-text')).not.toContainText(/signed in/i);
      await w.mouse.move(100, 20);
      await w.waitForTimeout(600);
      await expect(w).toHaveScreenshot('widget-team-hint.png', SHOT);
      await w.locator('#update-later').click();
      await expect(row).toBeHidden();
      await w.waitForTimeout(1500);
      await expect(row).toBeHidden();
      await h1.app.close();
      h2 = await launchApp({ config: { hints: { teamSeen: false } }, env: { CLAUDE_TRAFFIC_LIGHT_HOME: h1.home } });
      const w2 = await windowByFile(h2.app, 'index.html');
      await w2.waitForTimeout(3000);
      await expect(w2.locator('#update')).toBeHidden();
    } finally { await h2?.cleanup(); await h1.cleanup(); }
  });

  test('"Open Team" opens the Team page and counts as seen', async () => {
    const h1 = await launchApp({ config: { hints: { teamSeen: false } } });
    try {
      const w = await windowByFile(h1.app, 'index.html');
      await w.locator('#update-btn').click({ timeout: 15000 });
      await shownPage(h1.app, 'Team');
      await expect(w.locator('#update')).toBeHidden();
    } finally { await h1.cleanup(); }
  });

  test('a waiting-input bubble keeps the hint away', async () => {
    const h1 = await launchApp({ config: { hints: { teamSeen: false }, askFromWidget: true } });
    try {
      const w = await windowByFile(h1.app, 'index.html');
      F.staleRequest(h1, { id: 'vis-hint', sessionId: 'hint', cwd: '/visual/app', tool: 'Bash', toolInput: { command: 'ls' }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
      await expect(w.locator('.ib-item[data-id="vis-hint"]')).toBeVisible({ timeout: 15000 });
      await w.waitForTimeout(1500);
      await expect(w.locator('#update')).toBeHidden();
    } finally { await h1.cleanup(); }
  });
});
