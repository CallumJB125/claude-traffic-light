// Preferences → Backups: the list, "See what's different", restoring part of
// a backup, the damaged state, and the before-restore copy a restore leaves.
// Snapshots are written by src/backups.js itself at fixed times (TZ=UTC) so
// the baseline only changes when the panel does.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchApp, windowByFile } = require('./app');
const Backups = require('../src/backups.js');

const CFG = { roam: false, randomEvents: false, seasonal: false, showTasks: false, showAgents: false };
const SEEDED = ['2026-09-28T09-15-00.000Z', '2026-09-30T18-40-00.000Z', '2026-09-29T10-00-00.000Z'];

let h;
let settings;

function seed(dir) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-bk-seed-'));
  let clock = 0;
  const b = Backups.create({ dataDir: data, backupsDir: dir, now: () => clock, appVersion: '1.0.0' });
  const at = (iso, config, reason) => { clock = Date.parse(iso); fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config)); return b.snapshot(reason, { force: true }); };
  at('2026-09-28T09:15:00.000Z', { ...CFG, soundOnAmber: false, paceTooltip: false, template: 'quiet' }, 'daily');
  at('2026-09-30T18:40:00.000Z', { ...CFG, soundOnAmber: false }, 'save');
  const bad = at('2026-09-29T10:00:00.000Z', { ...CFG, soundOnAmber: false, roam: true }, 'manual');
  fs.writeFileSync(path.join(dir, bad.id, 'files', 'config.json'), '{"cut');
  fs.rmSync(data, { recursive: true, force: true });
}

test.beforeAll(async () => {
  h = await launchApp({ config: { soundOnAmber: true }, env: { TZ: 'UTC' } });
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.evaluate(() => window.lightsApi.openPreferences());
  settings = await windowByFile(h.app, 'settings.html');
  await settings.waitForLoadState('load');
  // the launch-time daily snapshot carries today's real date: drop it, add the fixed ones
  await expect.poll(() => fs.readdirSync(h.backups).length).toBeGreaterThan(0);
  for (const n of fs.readdirSync(h.backups)) fs.rmSync(path.join(h.backups, n), { recursive: true, force: true });
  seed(h.backups);
});

test.afterAll(async () => { await h?.cleanup(); });

const readConfig = () => JSON.parse(fs.readFileSync(path.join(h.home, 'config.json'), 'utf8'));

test('Backups: lists snapshots in plain words, damaged ones flagged and not restorable', async () => {
  await settings.locator('#backups > summary').click();
  const items = settings.locator('#backups-list .bk-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0).locator('.bk-title')).toHaveText('Restore your settings from 30 Sep, 18:40');
  await expect(items.nth(0).locator('.bk-meta')).toContainText('saved automatically');
  await expect(items.nth(2).locator('.bk-title')).toHaveText('Restore your settings from 28 Sep, 09:15');
  const bad = settings.locator('.bk-item[data-damaged="1"]');
  await expect(bad.locator('.bk-title')).toHaveText('Damaged backup from 29 Sep, 10:00');
  await expect(bad.locator('button')).toHaveCount(0);
  await expect(settings.locator('#backups-summary')).toHaveText('2 backups, 1 damaged. Latest: 30 Sep, 18:40.');
  await settings.evaluate(() => document.getElementById('backups').scrollIntoView({ block: 'start' }));
  await settings.waitForTimeout(300);
  await expect(settings.locator('#backups')).toHaveScreenshot('backups-list.png');
});

test('Backups: the diff names what differs, and a subset restores with a before-restore copy', async () => {
  const item = settings.locator('.bk-item[data-id="2026-09-28T09-15-00.000Z"]');
  await item.getByRole('button', { name: "See what's different" }).click();
  const picks = item.locator('.bk-pick');
  await expect(picks).toHaveText(['paceTooltip: gone now, the backup has it', 'soundOnAmber: different from the backup', 'template: gone now, the backup has it']);
  await settings.evaluate(() => document.getElementById('backups').scrollIntoView({ block: 'start' }));
  await settings.waitForTimeout(300);
  // the open diff is taller than the window, so shoot the window, not the element
  await expect(settings).toHaveScreenshot('backups-diff.png');
  await picks.nth(0).locator('input').uncheck();
  await picks.nth(2).locator('input').uncheck();
  await item.getByRole('button', { name: 'Restore selected' }).click();
  await expect(settings.locator('#backups-status')).toContainText('Restored from 28 Sep, 09:15 (1 item)');
  await expect.poll(() => readConfig().soundOnAmber).toBe(false);
  const cfg = readConfig();
  expect(cfg.paceTooltip).toBeUndefined();
  expect(cfg.template).toBeUndefined();
  expect(cfg.roam).toBe(false);
  await expect(settings.locator('#backups-list .bk-meta', { hasText: 'kept before a restore' })).toHaveCount(1);
  const undo = fs.readdirSync(h.backups).filter((n) => !SEEDED.includes(n) && !n.startsWith('.'));
  expect(undo.length).toBeGreaterThan(0);
  const manifests = undo.map((n) => JSON.parse(fs.readFileSync(path.join(h.backups, n, 'manifest.json'), 'utf8')));
  expect(manifests.some((m) => m.reason === 'before-restore')).toBe(true);
});

test('Backups: a damaged snapshot is refused by the main process too', async () => {
  const r = await settings.evaluate(() => window.settingsApi.backupsRestore('2026-09-29T10-00-00.000Z', {}));
  expect(r.error).toMatch(/damaged/);
  expect((await settings.evaluate(() => window.settingsApi.backupsDiff('2026-09-29T10-00-00.000Z'))).error).toMatch(/damaged/);
});
