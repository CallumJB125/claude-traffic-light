'use strict';
const { test, expect, _electron } = require('@playwright/test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('native selected-session scheduling reviews, encrypts, cancels and sends once only when due', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-followup-native-'));
  const app = await _electron.launch({ args: [path.join(__dirname, 'followup-flow-main.js'), '-ApplePersistenceIgnoreState', 'YES'], env: { ...process.env, PLEXIFORM_FOLLOWUP_FIXTURE: fixture } });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await expect(page.getByRole('button', { name: 'Start Synthetic Claude session', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Start Synthetic Claude session', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    // Since the grouped views (#64) a session that has just started sits in the Idle bucket, closed by default.
    const bucket = page.locator('details.bucket', { hasText: 'Synthetic Claude session' });
    if (!(await bucket.evaluate((e) => e.open))) await bucket.locator('summary').first().click();
    await page.getByRole('button', { name: 'Prepare follow-up', exact: true }).click();
    const composer = page.locator('.followup-composer');
    await composer.locator('textarea').fill('Synthetic scheduled follow-up');
    await composer.getByLabel('When to send', { exact: true }).selectOption('at');
    await expect(composer.getByLabel('Earliest send time (your local time)')).toBeVisible();
    await composer.getByLabel('When to send', { exact: true }).selectOption('hour');
    await expect(composer.getByText('Earliest send time (your local time)', { exact: true })).toBeHidden();
    await composer.getByRole('button', { name: 'Review follow-up', exact: true }).click();
    await expect(composer.locator('.followup-review')).toContainText('At or after');
    await expect(composer.locator('.followup-review')).toContainText('Keep Plexiform open and Overview focused');
    expect(await app.evaluate(() => global.followupFixture.sends.length)).toBe(0);
    await composer.getByRole('button', { name: 'Schedule one follow-up', exact: true }).click();
    await expect(page.locator('#session-followups')).toContainText('Synthetic scheduled follow-up');
    expect(fs.readFileSync(path.join(fixture, 'outbox.bin')).includes(Buffer.from('Synthetic scheduled follow-up'))).toBe(false);
    await page.getByRole('button', { name: 'Cancel follow-up', exact: true }).click();
    await expect(page.locator('#session-followups')).toContainText('cancelled');
    await expect(page.locator('#session-followups .delivery-text')).toHaveText('');
    await page.getByRole('button', { name: 'Discard saved copy', exact: true }).click();
    await composer.locator('textarea').fill('Second synthetic scheduled follow-up');
    await composer.getByRole('button', { name: 'Review follow-up', exact: true }).click();
    await composer.getByRole('button', { name: 'Schedule one follow-up', exact: true }).click();
    await expect(page.locator('#session-followups')).toContainText('Second synthetic scheduled follow-up');
    expect(await app.evaluate(() => global.followupFixture.sends.length)).toBe(0);
    if (process.env.PLEXIFORM_FOLLOWUP_EVIDENCE) {
      fs.mkdirSync(process.env.PLEXIFORM_FOLLOWUP_EVIDENCE, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PLEXIFORM_FOLLOWUP_EVIDENCE, 'followup-native-scheduled.png'), fullPage: true });
    }
    await app.evaluate(async () => { global.followupFixture.focus(); await global.followupFixture.advance(); });
    await expect(page.locator('#session-followups')).toContainText('Provider receipt: acknowledged');
    expect(await app.evaluate(() => global.followupFixture.sends.length)).toBe(1);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    expect(await app.evaluate(() => global.followupFixture.sends.length)).toBe(1);
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(fixture, { recursive: true, force: true }); }
});
