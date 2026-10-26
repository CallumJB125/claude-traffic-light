'use strict';
// Organised views PR 3: the Sessions page grouped by project, then status. main's state and routing answers are
// replaced with fixed rows (the routing rows worded by the real src/work-routing-view.js and keyed by the real
// projectOf), so the shots need no hooks, git or hub.
const { test, expect } = require('@playwright/test');
const { launchApp, embedded, snapToPixels } = require('./app');
const { rowsFor } = require('../src/work-routing-view.js');
const O = require('../src/work-organise.js');

const repo = (name) => `github.com/acme/${name}`;
const key = (name) => (name === 'other' ? 'other' : O.projectOf({ repoName: repo(name) }).key);
const group = (name, sub = null) => ({ key: key(name), heading: name === 'other' ? O.FALLBACK : name, sub });
const row = (name, bucket, extra = {}) => ({ provider: 'Claude Code', project: name === 'other' ? 'scratch' : name, group: group(name, extra.sub ?? null), bucket, status: O.headingOf(bucket), freshness: 'recent', age_ms: 4000, lifecycle: false, children: [], ...extra });
const ONE = [row('claude-traffic-light', 'working'), row('claude-traffic-light', 'needs', { provider: 'Codex' })];
const MIXED = [
  ...ONE, row('claude-traffic-light', 'idle', { freshness: 'stale', age_ms: 3_600_000 }),
  row('website', 'check', { sub: 'views › header' }), row('website', 'working', { provider: 'Codex', sub: 'views › header' }),
  row('other', 'stuck', { stuck: { tool: 'Bash', since_ms: 600_000 } }),
];
const core = { key: 'k-core', team: 'Plexiform', board: 'Core' }, web = { key: 'k-web', team: 'Plexiform', board: 'Website' };
const admin = [{ key: 't-plexi', name: 'Plexiform', role: 'admin', boards: [{ key: 'b-core', name: 'Core' }, { key: 'b-web', name: 'Website' }] }];
const ROUTES = rowsFor([
  { repo: repo('claude-traffic-light'), short: 'claude-traffic-light', state: 'ask', destination: { kind: 'local' }, matches: [{ ...core, read_only: false }, { ...web, read_only: false }] },
  { repo: repo('website'), short: 'website', state: 'single', destination: { kind: 'team', ...web }, matches: [{ ...web, read_only: false }] },
], { teams: admin }).map((r) => ({ ...r, key: O.projectOf({ repoName: r.repo }).key }));
// Two canonical names that differ only in case on a self-hosted host share a key: one header, two lines.
const TWIN = { ...rowsFor([{ repo: 'git.acme.dev/Acme/Website', short: 'Website', state: 'set', destination: { kind: 'local' }, matches: [{ ...core, read_only: false }] }], { teams: admin })[0], key: key('website') };

async function open({ theme = 'dark', sessions = MIXED, routes = [] } = {}) {
  const h = await launchApp();
  await h.app.evaluate(({ ipcMain }, { sessions, routes }) => {
    globalThis.__grouped = { sessions, routes, routingCalls: 0 };
    const on = (ch, fn) => { ipcMain.removeHandler(ch); ipcMain.handle(ch, fn); };
    on('sessions:state', () => ({ observed_at: Date.now(), status: 'complete', omitted: 0, activity: { configured: true, observed: true, latest_age_ms: 4000 }, sessions: globalThis.__grouped.sessions }));
    on('sessions:routing', () => { globalThis.__grouped.routingCalls++; return { rows: globalThis.__grouped.routes }; });
    on('sessions:route-choose', () => ({ ok: true }));
  }, { sessions, routes });
  const page = await embedded(h.app, 'sessions', 'sessions.html');
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.locator('#refresh').click();
  await page.evaluate(() => document.fonts.ready);
  return { h, page, content: page.locator('#content') };
}
const shot = async (locator, name) => expect(await snapToPixels(locator)).toHaveScreenshot(name);

for (const theme of ['dark', 'light']) {
  test(`grouped sessions: mixed buckets across projects, a branch sub-label, Other work last, Idle folded (${theme})`, async () => {
    const { h, content } = await open({ theme });
    try {
      await expect(content.locator('.group')).toHaveCount(3);
      await expect(content.locator('.group-name')).toHaveText(['claude-traffic-light', 'website', 'Other work']);
      await expect(content.locator('details[data-bucket="idle"]')).not.toHaveAttribute('open', '');
      await shot(content, `sessions-grouped-mixed-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}

test('grouped sessions: empty, one project, a folded project, Group by Status', async () => {
  const empty = await open({ sessions: [] });
  try { await expect(empty.content).toContainText('How sessions get in'); await shot(empty.content, 'sessions-grouped-empty.png'); } finally { await empty.h.cleanup(); }
  const { h, page, content } = await open({ sessions: ONE });
  try {
    await expect(content.locator('.group')).toHaveCount(1);
    await shot(content, 'sessions-grouped-one.png');
    await content.locator('.group-toggle').click();
    await expect(content.locator('.group-toggle')).toHaveAttribute('aria-expanded', 'false');
    await shot(content, 'sessions-grouped-folded.png');
    await page.locator('#session-group').selectOption('bucket');
    await expect(content.locator('.group-name')).toHaveText(['Needs you', 'Working on it']);
    await shot(content, 'sessions-grouped-status.png');
  } finally { await h.cleanup(); }
});

test('grouped sessions: routing lines in their project headers, two lines under one header', async () => {
  const { h, page, content } = await open({ routes: [...ROUTES, TWIN] });
  try {
    await expect(content.locator('.group-routing .routing-row')).toHaveCount(3);
    await expect(page.locator('#routing')).toBeHidden();
    await shot(content.locator('.group').first(), 'sessions-grouped-routing-ask.png');
    await shot(content.locator('.group').nth(1), 'sessions-grouped-routing-two.png');
  } finally { await h.cleanup(); }
});

test('grouped sessions: a fold survives a reload; focus in a header picker survives the 5 s refresh; a new project is fetched for', async () => {
  const { h, page, content } = await open({ sessions: ONE, routes: ROUTES.slice(0, 1) });
  try {
    const head = content.locator('.group').first();
    await head.locator('details[data-bucket="needs"] > summary').click();
    await page.reload();
    await page.locator('#refresh').click();
    await expect(content.locator('details[data-bucket="needs"]')).not.toHaveAttribute('open', '');
    await expect(content.locator('details[data-bucket="working"]')).toHaveAttribute('open', '');
    // Focus on a question button in the header, then let the 5 s refresh run.
    const button = head.locator('.routing-row button', { hasText: 'Core' });
    await button.focus();
    await page.waitForTimeout(6500);
    expect(await button.evaluate((b) => document.activeElement === b)).toBe(true);
    // A second project's first session: its routing line is fetched for without a reload.
    await button.blur();
    const before = await h.app.evaluate(() => globalThis.__grouped.routingCalls);
    await h.app.evaluate((_e, { more, routes }) => { globalThis.__grouped.sessions = [...globalThis.__grouped.sessions, ...more]; globalThis.__grouped.routes = routes; }, { more: [row('website', 'check')], routes: ROUTES });
    await expect(content.locator('.group')).toHaveCount(2, { timeout: 8000 });
    await expect(content.locator('.group').nth(1).locator('.routing-row')).toHaveCount(1, { timeout: 8000 });
    expect(await h.app.evaluate(() => globalThis.__grouped.routingCalls)).toBeGreaterThan(before);
  } finally { await h.cleanup(); }
});
