'use strict';
// Organised views PR 7: the Sessions page's "Where your projects' work goes" strip. main's routing answer is
// replaced with fixed rows worded by the real src/work-routing-view.js (one per state: ask, single, set, read-only,
// unlinked for an admin, unlinked for a member), so the shots need no hub. Picking, linking and asking go back
// through the page's own preload to these stubs.
const { test, expect } = require('@playwright/test');
const { launchApp, embedded, snapToPixels } = require('./app');
const { rowsFor } = require('../src/work-routing-view.js');

const core = { key: 'k-core', team: 'Plexiform', board: 'Core' };
const web = { key: 'k-web', team: 'Plexiform', board: 'Website' };
const admin = [{ key: 't-plexi', name: 'Plexiform', role: 'admin', boards: [{ key: 'b-core', name: 'Core' }, { key: 'b-web', name: 'Website' }] }];
const member = [{ key: 't-plexi', name: 'Plexiform', role: 'member', boards: [{ key: 'b-core', name: 'Core' }] }];
const row = (short, state, extra = {}) => ({ repo: `github.com/acme/${short}`, short, state, destination: { kind: 'local' }, matches: [], ...extra });
const ROWS = [
  ...rowsFor([
    row('claude-traffic-light', 'ask', { matches: [{ ...core, read_only: false }, { ...web, read_only: false }] }),
    row('website', 'single', { destination: { kind: 'team', ...web }, matches: [{ ...web, read_only: false }] }),
    row('notes', 'set', { matches: [{ ...core, read_only: false }] }),
    row('ops-runbooks', 'read_only', { matches: [{ key: 'k-ops', team: 'Ops', board: 'Runbooks', read_only: true }] }),
    row('new-service', 'unlinked'),
  ], { teams: admin }),
  ...rowsFor([row('side-project', 'unlinked')], { teams: member }),
];

async function open(theme) {
  const h = await launchApp();
  await h.app.evaluate(({ ipcMain }, rows) => {
    globalThis.__routing = { rows, calls: [] };
    const on = (ch, fn) => { ipcMain.removeHandler(ch); ipcMain.handle(ch, fn); };
    on('sessions:routing', () => ({ rows: globalThis.__routing.rows }));
    on('sessions:route-choose', (_e, repo, key) => {
      globalThis.__routing.calls.push(['choose', repo, key]);
      globalThis.__routing.rows = globalThis.__routing.rows.map((r) => (r.repo === repo ? { ...r, state: 'set', text: `${r.short} → My board (private)`, goesTo: 'My board (private)', note: null, choices: null } : r));
      return { ok: true };
    });
    on('sessions:route-ask', (_e, repo, team) => { globalThis.__routing.calls.push(['ask', repo, team]); return { ok: true, text: 'Asked Plexiform’s admins to put side-project on a team board. They see your name and “side-project”, nothing else.' }; });
    on('sessions:route-link', (_e, repo, board) => { globalThis.__routing.calls.push(['link', repo, board]); return { ok: false, text: 'Only a team owner or admin can link a repository. Ask one of them, or choose My board.' }; });
  }, ROWS);
  const page = await embedded(h.app, 'sessions', 'sessions.html');
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.locator('#refresh').click();
  const strip = page.locator('#routing');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.routing-row')).toHaveCount(6);
  await page.evaluate(() => document.fonts.ready);
  return { h, page, strip };
}

for (const theme of ['dark', 'light']) {
  test(`routing strip: every state, worded once for Sessions and This Mac (${theme})`, async () => {
    const { h, strip } = await open(theme);
    try {
      await expect(await snapToPixels(strip)).toHaveScreenshot(`routing-strip-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}

test('routing strip: Keep on My board saves and settles the question; Ask an admin and a refused Link say what happened', async () => {
  const { h, page, strip } = await open('dark');
  try {
    const ask = strip.locator('.routing-row').first();
    await expect(ask).toContainText('Where should its new work go?');
    await ask.getByRole('button', { name: 'Keep on My board' }).click();
    await expect(strip.locator('.routing-row').first()).toContainText('claude-traffic-light → My board (private)');
    await expect(strip.locator('.routing-row').first().getByRole('button', { name: 'Change' })).toBeVisible();
    const side = strip.locator('.routing-row', { hasText: 'side-project' });
    await side.getByRole('button', { name: 'Ask an admin' }).click();
    await expect(page.locator('#routing-status')).toContainText('They see your name and “side-project”, nothing else.');
    const fresh = strip.locator('.routing-row', { hasText: 'new-service' });
    await fresh.getByRole('button', { name: 'Link' }).click();
    await expect(page.locator('#routing-status')).toContainText('Only a team owner or admin can link a repository.');
    expect(await h.app.evaluate(() => globalThis.__routing.calls)).toEqual([
      ['choose', 'github.com/acme/claude-traffic-light', 'local'], ['ask', 'github.com/acme/side-project', 't-plexi'], ['link', 'github.com/acme/new-service', 'b-core']]);
  } finally { await h.cleanup(); }
});
