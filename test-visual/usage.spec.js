// The Usage tab's history charts, drawn from a seeded permanent record with
// the clock pinned (?now=), in dark and light.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');
const History = require('../usage-history.js');

const NOW = new Date('2026-09-30T12:00:00').getTime();
const DAY = 86400000;

// ~5 months of plausible work: heavier Tue/Wed, Opus creeping up, a cache dip
// in the last week, a new Opus version in mid-August, a spike, one unpriced model.
function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-usage-seed-'));
  const store = History.open({ root: dir });
  let s = 20260930;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const projects = ['/work/bondly', '/work/claude-traffic-light', '/work/site', '/work/notes'];
  const turns = [];
  let n = 0;
  for (let d = 150; d >= 1; d -= 1) {
    const dayStart = new Date(NOW - d * DAY);
    dayStart.setHours(0, 0, 0, 0);
    const wd = dayStart.getDay();
    if (wd === 0 && rnd() < 0.7) continue;
    if (wd === 6 && rnd() < 0.5) continue;
    const count = Math.round((wd === 2 || wd === 3 ? 34 : 20) * (0.6 + rnd() * 0.8)) + (d === 9 ? 70 : 0);
    const opusShare = d > 30 ? 0.3 : 0.55;
    for (let k = 0; k < count; k += 1) {
      const hour = 9 + Math.floor(rnd() * 10) + (rnd() < 0.12 ? 7 : 0);
      const r = rnd();
      const opus = r < opusShare;
      const model = r > 0.97 ? 'mystery-9' : opus ? (dayStart.getTime() < new Date('2026-08-15T00:00:00').getTime() ? 'claude-opus-5' : 'claude-opus-5-5') : r < opusShare + 0.25 ? 'claude-sonnet-5-5' : 'claude-haiku-4-5-20251001';
      const recent = d <= 7;
      const routine = rnd() < 0.45;
      turns.push({
        id: `t${(n += 1)}`, ts: dayStart.getTime() + hour * 3600000 + Math.floor(rnd() * 3600000) % 3600000,
        sessionId: `s${d}-${k % 4}`, cwd: projects[Math.floor(rnd() * rnd() * 4)], model,
        input: routine ? 800 : 6000, output: routine ? 120 + Math.floor(rnd() * 200) : 1500 + Math.floor(rnd() * 3000),
        cacheRead: recent ? 4000 : 60000 + Math.floor(rnd() * 30000), cacheWrite: recent ? (routine ? 1500 : 30000) : (routine ? 1500 : 4000), cacheWrite1h: 0,
      });
    }
  }
  History.record(store, turns);
  History.importLegacy(store, { '2026-04-20': { cost: 6.4 }, '2026-04-21': { cost: 11.9 }, '2026-04-22': { cost: 3.2 } });
  History.flush(store);
  const files = { 'usage/.backfilled': 'seed' };
  for (const f of fs.readdirSync(path.join(dir, 'usage', 'daily'))) if (!f.includes('.ids.')) files[`usage/daily/${f}`] = fs.readFileSync(path.join(dir, 'usage', 'daily', f), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return files;
}

let h;
test.beforeAll(async () => { h = await launchApp({ files: seed() }); });
test.afterAll(async () => { await h?.cleanup(); });

async function lightsOf(harness) {
  // the first call opens it (openLights toggles nothing, but a window that is
  // already up is simply reused)
  const up = harness.app.windows().find((p) => p.url().includes('lights.html'));
  if (up) return up;
  const widget = await windowByFile(harness.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openLights());
  return windowByFile(harness.app, 'lights.html');
}

async function open(scheme) {
  const lights = await lightsOf(h);
  await lights.setViewportSize({ width: 1100, height: 2200 }).catch(() => {});
  await lights.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  const base = lights.url().split('?')[0];
  await lights.goto(`${base}?view=mix&now=${NOW}`);
  await lights.waitForSelector('#usage-history .uv-card');
  await lights.waitForTimeout(400);
  return lights;
}

for (const scheme of ['dark', 'light']) {
  test(`usage history renders its charts (${scheme})`, async () => {
    const lights = await open(scheme);
    const errs = await lights.evaluate(() => window.__errs || []);
    expect(errs).toEqual([]);
    await expect(lights.locator('#usage-history .uv-head')).toHaveScreenshot(`usage-head-${scheme}.png`, { threshold: 0.05 });
    await expect(lights.locator('#usage-history .uv-tiles')).toHaveScreenshot(`usage-tiles-${scheme}.png`, { threshold: 0.05 });
    const cards = lights.locator('#usage-history .uv-card');
    const titles = await cards.locator('h3').allTextContents();
    expect(titles).toEqual(['Cost over time', 'Model share over time', 'Where the tokens go', 'Cache hit rate', 'Activity calendar', 'When you work', 'Projects', 'Routine Opus turns']);
    for (let i = 0; i < titles.length; i += 1) await expect(cards.nth(i)).toHaveScreenshot(`usage-${String(i + 1).padStart(2, '0')}-${titles[i].toLowerCase().replace(/[^a-z]+/g, '-')}-${scheme}.png`, { threshold: 0.05 });
  });
}

test('usage history: range, compare, project filter, callouts and tables work', async () => {
  const lights = await open('dark');
  const cost = lights.locator('#usage-history .uv-tile .uv-v').first();
  const before = await cost.textContent();
  await lights.getByRole('button', { name: '7 days', exact: true }).click();
  await expect(cost).not.toHaveText(before);
  await lights.getByRole('button', { name: '90 days', exact: true }).click();
  const callouts = await lights.locator('#usage-history .uv-callouts li').allTextContents();
  expect(callouts.length).toBeLessThanOrEqual(3);
  expect(callouts.join(' ')).toMatch(/Opus share up|Cache hit rate fell|busiest day/);
  // clicking a project filters every chart to it and shows a clearable chip
  await lights.locator('.uv-projects button').first().click();
  await expect(lights.locator('.uv-chip')).toContainText('Project:');
  await lights.locator('.uv-chip').click();
  await expect(lights.locator('.uv-chip')).toHaveCount(0);
  // the table view carries the same data
  const table = lights.locator('.uv-table').first();
  await table.locator('summary').click();
  expect(await table.locator('tbody tr').count()).toBeGreaterThan(20);
  // "All" has nothing to compare against
  await lights.getByRole('button', { name: 'All', exact: true }).click();
  await expect(lights.locator('.uv-check input')).toBeDisabled();
  // hover tooltip
  const hit = lights.locator('.uv-card').first().locator('.uv-hit').nth(10);
  await hit.scrollIntoViewIfNeeded();
  const box = await hit.boundingBox();
  await lights.mouse.move(box.x + box.width / 2, box.y + 20);
  await lights.mouse.move(box.x + box.width / 2 + 1, box.y + 22);
  await expect(lights.locator('.uv-tip')).toBeVisible();
  await expect(lights.locator('.uv-tip')).toContainText('Cost');
  expect(await lights.evaluate(() => window.__errs || [])).toEqual([]);
});

test('usage history: a record with nothing in it says so', async () => {
  const empty = await launchApp();
  try {
    const lights = await lightsOf(empty);
    await lights.goto(`${lights.url().split('?')[0]}?view=mix&now=${NOW}`);
    await expect(lights.locator('#usage-history .uv-empty')).toContainText('Nothing is recorded yet');
  } finally { await empty.cleanup(); }
});
