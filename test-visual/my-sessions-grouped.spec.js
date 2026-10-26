'use strict';
// Organised views PR 3: Overview → My sessions grouped by project, then status. main's directory answer is replaced
// with entries built by the real src/session-directory.js from fixed rows, so the shots need no sessions or hub.
const { test, expect } = require('@playwright/test');
const { launchApp, embedded, snapToPixels } = require('./app');
const { createSessionDirectory } = require('../src/session-directory.js');

const caps = { open: { enabled: false, label: 'Open', reason: 'No card.' }, message: { enabled: false, label: 'Message', reason: 'A current owned runner with messaging is required.' } };
let n = 0;
const work = (project, status, provider = { id: 'claude', label: 'Claude Code', kind: 'integrated' }) => ({ id: `w-${++n}`, handle: null, label: 'Session', provider, device: { label: 'This device', local: true }, board: { label: 'My board', kind: 'personal' }, project, status, freshness: 'recent', age_ms: 3000, task: { status: 'unknown', title: 'Task not reported', key: null }, children: [], capabilities: caps });
const codex = { id: 'codex', label: 'Codex', kind: 'integrated' };
const entries = (rows) => createSessionDirectory().mine({ work: rows });
const ONE = () => entries([work('claude-traffic-light', 'Working on it'), work('claude-traffic-light', 'Needs you', codex)]);
const MIXED = () => entries([work('claude-traffic-light', 'Working on it'), work('claude-traffic-light', 'Needs you', codex), work('claude-traffic-light', 'Idle'),
  work('website', 'Finished — check it'), work('website', 'Stuck or failed', codex), work(null, 'Working on it')]);

// One fixed instant for main's answer and the page's clock: every age reads "3s ago" and the "Checked" line
// shows the same time on every run, however long the machine takes to draw.
const NOW = Date.parse('2026-10-14T10:30:00Z');
async function open(list, theme = 'dark') {
  // TZ=UTC as in backups.spec.js: the "Checked" time is local time, so the zone is pinned with the clock.
  const h = await launchApp({ env: { TZ: 'UTC' } });
  await h.app.evaluate(({ ipcMain }, { list, now }) => {
    ipcMain.removeHandler('overview:directory');
    ipcMain.handle('overview:directory', (_e, req) => ({ schema: 1, view: req?.view === 'team' ? 'team' : 'mine', status: 'complete', observed_at: now, notice: '', teams: [], team: null, entries: req?.view === 'team' ? [] : list }));
  }, { list, now: NOW });
  const page = await embedded(h.app, 'overview', 'overview.html');
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.evaluate((now) => { Date.now = () => now; }, NOW);
  await page.locator('#refresh').click();
  await page.evaluate(() => document.fonts.ready);
  return { h, page, list: page.locator('#mine-list'), section: page.locator('#mine-section') };
}
const shot = async (locator, name) => expect(await snapToPixels(locator)).toHaveScreenshot(name);

test('My sessions grouped: empty, one project, mixed buckets, a folded Idle (dark), and mixed in light', async () => {
  const empty = await open([]);
  try { await expect(empty.page.locator('#mine-empty')).toBeVisible(); await shot(empty.section, 'my-sessions-grouped-empty.png'); } finally { await empty.h.cleanup(); }
  const one = await open(ONE());
  try { await expect(one.list.locator('.mine-group')).toHaveCount(1); await shot(one.list, 'my-sessions-grouped-one.png'); } finally { await one.h.cleanup(); }
  const mixed = await open(MIXED());
  try {
    await expect(mixed.list.locator('.group-name')).toHaveText(['claude-traffic-light', 'website', 'Other work']);
    await expect(mixed.list.locator('details[data-bucket="idle"]')).not.toHaveAttribute('open', '');
    await shot(mixed.list, 'my-sessions-grouped-mixed-dark.png');
    await mixed.list.locator('details[data-bucket="idle"] > summary').click();
    await expect(mixed.list.locator('details[data-bucket="idle"]')).toHaveAttribute('open', '');
    await mixed.page.locator('#mine-group').selectOption('bucket');
    await expect(mixed.list.locator('.group-name').first()).toHaveText('Needs you');
  } finally { await mixed.h.cleanup(); }
  const light = await open(MIXED(), 'light');
  try { await shot(light.list, 'my-sessions-grouped-mixed-light.png'); } finally { await light.h.cleanup(); }
});
