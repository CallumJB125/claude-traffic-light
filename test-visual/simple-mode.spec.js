const { test, expect } = require('@playwright/test');
const path = require('path');
const { launchApp, windowByFile, embedded } = require('./app');

// Simple mode ("Just me, building an app"): Home trimmed, rule wishes before
// the field editor, no Team in the sidebar, and setup's persona fork.
let h;
test.beforeAll(async () => { h = await launchApp({ config: { persona: 'simple', simpleMode: true } }); });
test.afterAll(async () => { await h?.cleanup(); });

const shot = (name) => (process.env.PLEXIFORM_VIEW_DIR ? { path: path.join(process.env.PLEXIFORM_VIEW_DIR, name) } : {});

test('Home shows only what needs you, what is running and today', async () => {
  const home = await embedded(h.app, 'home', 'home.html');
  await expect(home.locator('body')).toHaveClass(/simple/);
  await expect(home.locator('#needs')).toBeVisible();
  await expect(home.locator('#running')).toBeVisible();
  await expect(home.locator('#today')).toBeVisible();
  for (const id of ['#digest', '#teamwork', '#cards', '#costs', '#open-tasks']) await expect(home.locator(id)).toBeHidden();
  await home.screenshot(shot('home-simple.png'));
});

test('the sidebar has no Team or Integrations, and keeps Account', async () => {
  const sidebar = await windowByFile(h.app, 'sidebar.html');
  await expect(sidebar.locator('[data-section="team"] .nav-label')).toHaveText('Account');
  await expect(sidebar.locator('[data-page="team"], [data-page="integrations"]')).toHaveCount(0);
});

test('Widget rules: wishes first, the field editor behind Customise', async () => {
  const lights = await embedded(h.app, 'lights', 'lights.html');
  await expect(lights.locator('#wishes')).toBeVisible();
  await expect(lights.locator('#editor')).toBeHidden();
  await expect(lights.locator('#wish-chime-done')).toContainText('Chime when it’s done');
  await expect(lights.locator('#wish-ping-phone')).toContainText('Ping my phone when Claude needs me');
  await lights.evaluate(() => document.fonts.ready);
  await expect(lights.locator('#wishes')).toHaveScreenshot('rule-wishes.png');
  await lights.locator('#wish-chime-done').click();
  await expect(lights.locator('#wish-status')).toContainText('Added “Chime when it’s done”');
  await lights.locator('#customise-btn').click();
  await expect(lights.locator('#editor')).toBeVisible();
  await expect(lights.locator('#name')).toHaveValue('Chime when done');
  await lights.screenshot(shot('lights-simple.png'));
});

test('setup asks who it is for, then gives a test prompt and says why nothing showed', async () => {
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openHelp());
  const help = await windowByFile(h.app, 'help.html');
  await help.waitForLoadState('load');
  await help.evaluate(() => window.helpApi.navigate('onboarding'));
  const setup = await windowByFile(h.app, 'onboarding.html');
  await setup.waitForLoadState('load');
  await expect(setup.locator('#step-persona')).toBeVisible();
  await setup.evaluate(() => document.fonts.ready);
  await expect(setup).toHaveScreenshot('setup-persona.png');
  await setup.locator('#persona-simple').click();
  await expect(setup.locator('#step-connect')).toBeVisible();
  await expect(setup.locator('#connect-body')).toContainText('note-taker');
  await setup.screenshot(shot('setup-connect.png'));
  await setup.locator('#skip-connect').click();
  await expect(setup.locator('#step-signal')).toBeVisible();
  await expect(setup.locator('#test-prompt')).toHaveValue(/Do not change any files/);
  await expect(setup.locator('#not-showing')).toBeVisible();
  await setup.screenshot(shot('setup-signal.png'));
});

// Q13 M1: the sidebar and account controls whose base rule is `all: unset` must still draw an outline when
// reached by keyboard, in normal and forced colours. shell.css is shared by sidebar.html and account.html, so
// the account controls (.acct-link, .switch) and the sign-out link are probed as buttons added to the sidebar.
for (const forcedColors of ['none', 'active']) {
  test(`keyboard focus on sidebar and account controls is outlined (forced colours: ${forcedColors})`, async () => {
    const sidebar = await windowByFile(h.app, 'sidebar.html');
    await sidebar.emulateMedia({ forcedColors });
    try {
      await sidebar.evaluate(() => {
        const box = document.createElement('div');
        box.id = 'q13-probes';
        for (const cls of ['ws-signout', 'acct-link', 'switch']) {
          const b = document.createElement('button');
          b.type = 'button'; b.className = cls; b.textContent = cls; b.dataset.probe = cls;
          if (cls === 'switch') { b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', 'false'); }
          box.append(b);
        }
        document.body.append(box);
        document.activeElement?.blur?.();
      });
      const seen = [];
      for (let i = 0; i < 40; i += 1) {
        await sidebar.keyboard.press('Tab');
        const f = await sidebar.evaluate(() => {
          const e = document.activeElement;
          if (!e || e === document.body) return null;
          const cs = getComputedStyle(e);
          return { key: e.dataset.probe || (e.classList.contains('nav-item') ? `nav:${e.dataset.section || e.dataset.page || e.textContent.trim()}` : null),
            style: cs.outlineStyle, width: cs.outlineWidth, focusVisible: e.matches(':focus-visible') };
        });
        if (!f || !f.key) continue;
        expect(f.focusVisible).toBe(true);
        expect(f.style, `${f.key} outline-style`).not.toBe('none');
        expect(parseFloat(f.width), `${f.key} outline-width`).toBeGreaterThan(0);
        seen.push(f.key);
      }
      for (const p of ['ws-signout', 'acct-link', 'switch']) expect(seen).toContain(p);
      expect(seen.filter((k) => k.startsWith('nav:')).length).toBeGreaterThan(2);
    } finally {
      await sidebar.evaluate(() => document.getElementById('q13-probes')?.remove());
      await sidebar.emulateMedia({ forcedColors: 'none' });
    }
  });
}
