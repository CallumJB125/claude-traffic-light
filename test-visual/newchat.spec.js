'use strict';
// Redesign R2b-2: the new-chat screen behind the dev-only preview gate (CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW=1). It opens
// through the real path: the sidebar's New chat → buddy:open-newchat → main's openNewChat → the new-chat view. For the
// pixel shots only, main's newchat:info, :route, :preflight and :create answers are replaced with fixed content (the
// shapes src/newchat-main.js returns), answered to the new-chat document only, so nothing depends on the Tasks engine.
// The authority itself is test/newchat-main.test.js, test/newchat-window-authority.test.js and test/r2b-authority.test.js.
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile, snapToPixels } = require('./app');

const GATE = { CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW: '1' };
const INFO = { hidden: false, connected: true, ais: [{ id: 'claude', label: 'Claude', usable: true }, { id: 'codex', label: 'Codex', usable: true }], folder: { handle: 'h-1', label: 'api' }, recent: [{ handle: 'h-2', label: 'billing' }], shortcut: null, task: null };
const ROUTE = { ok: true, route: { decision: 'run', ai: 'claude', reason: 'Claude: you set Claude for this repo', alternatives: [] } };
const NO_PEERS = { ok: true, preflight: { peers: [], key: 'k0' } };
// R7-1: the new chat's own content (src/newchat-home-main.js shapes). QUIET is a returning person with nothing
// waiting, which looks exactly as the screen did before R7; FIRST and RETURNING are the two §5 states.
const QUIET = { summary: { needs: 0, check: 0 }, rows: [], more: 0, firstEver: false };
const FIRST = { summary: { needs: 0, check: 0 }, rows: [], more: 0, firstEver: true };
const RETURNING = { summary: { needs: 4, check: 3 }, rows: [
  { id: 'a'.repeat(64), title: 'Allow Bash: npm test?', project: 'billing' },
  { id: 'b'.repeat(64), title: 'Claude has a question about the schema', project: 'api' },
  { id: 'c'.repeat(64), title: 'Allow edits to 3 files?', project: 'web' },
], more: 1, firstEver: false };
const STARTERS = { starters: [
  { id: 'explain', label: 'Explain this repo', text: 'Explain this repo: what it does, how it is laid out, and where to start reading.' },
  { id: 'tests', label: 'Add tests for export.js', text: 'Add tests for src/export.js. Follow the project\'s existing test style.' },
  { id: 'build', label: 'Fix the failing build', text: 'The latest CI run on this branch failed. Find out why and fix it.' },
] };
const PEERS = { ok: true, preflight: { peers: [{ id: 'p1', state: 'running', branch: 'fix/upload', paths: [], uncertain: false }, { id: 'p2', state: 'running', branch: 'feat/export', paths: [], uncertain: false }], key: 'k2' } };

async function open({ env = GATE, preflight = NO_PEERS, create = { ok: true, id: 't1' }, home = QUIET, starters = STARTERS } = {}) {
  const h = await launchApp({ env });
  if (env === GATE) {
    await h.app.evaluate(({ ipcMain }, { INFO, ROUTE, preflight, create, home, starters }) => {
      globalThis.__creates = []; globalThis.__opens = []; globalThis.__starters = [];
      const mine = (e) => { try { return new URL(e.sender.getURL()).pathname.endsWith('/newchat.html'); } catch { return false; } };
      const fixed = { 'newchat:info': () => INFO, 'newchat:route': () => ROUTE, 'newchat:preflight': () => preflight, 'newchat:create': (a) => { globalThis.__creates.push(a); return create; },
        'newchat:home': () => home, 'newchat:starters': (a) => { globalThis.__starters.push(a); return starters; }, 'newchat:open-row': (a) => { globalThis.__opens.push(a); return { ok: false }; } };
      for (const [ch, fn] of Object.entries(fixed)) { ipcMain.removeHandler(ch); ipcMain.handle(ch, (e, ...a) => (mine(e) ? fn(a) : null)); }
    }, { INFO, ROUTE, preflight, create, home, starters });
  }
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openHelp());
  const side = await windowByFile(h.app, 'sidebar.html');
  await side.waitForFunction(() => !!window.buddy);
  return { h, side };
}

async function openNewChat(h, side, theme = 'light') {
  await side.locator('.sb-new').click();
  const page = await windowByFile(h.app, 'newchat.html');
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.waitForLoadState('load');
  await expect(page.locator('#nc')).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const shot = async (page, name) => expect(await snapToPixels(page.locator('#nc'))).toHaveScreenshot(name);
const isOpen = (h) => h.app.windows().some((p) => p.url().split('?')[0].endsWith('/newchat.html'));

test('flag off: no new chat, and the sidebar bridge has no new-chat channel', async () => {
  const { h, side } = await open({ env: {} });
  try {
    expect(await side.evaluate(() => typeof window.buddy.openNewChat)).toBe('undefined');
    expect(isOpen(h)).toBe(false);
  } finally { await h.cleanup(); }
});

test('the real path: New chat opens the screen; leaving it destroys the view', async () => {
  const { h, side } = await open();
  try {
    await expect(side.locator('.sb-new')).not.toHaveAttribute('aria-disabled', 'true');
    const page = await openNewChat(h, side);
    await expect(page.locator('#nc-title')).toHaveText('New chat');
    await expect(page.locator('#nc-text')).toBeFocused();
    await side.locator('.sb-foot[data-page="board"]').click();
    await expect.poll(() => isOpen(h)).toBe(false);
  } finally { await h.cleanup(); }
});

for (const theme of ['light', 'dark']) {
  test(`empty (${theme}): the heading, the box, the folder and AI chips, Send`, async () => {
    const { h, side } = await open();
    try {
      const page = await openNewChat(h, side, theme);
      await expect(page.locator('#nc-folder')).toHaveValue('h-1');
      await expect(page.locator('#nc-send')).toBeDisabled();
      expect(await page.locator('.nc-col').evaluate((n) => n.getBoundingClientRect().width)).toBeLessThanOrEqual(760);
      await page.locator('#nc-text').blur();
      await shot(page, `newchat-empty-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}

test('peers: the card above Send, which waits for Start anyway; Enter is a newline and ⌘↩ sends the draft only', async () => {
  const { h, side } = await open({ preflight: PEERS });
  try {
    const page = await openNewChat(h, side);
    await page.locator('#nc-text').fill('Add a retry to the invoice export');
    await expect(page.locator('#nc-route')).toContainText('Claude');
    await expect(page.locator('#nc-peers')).toContainText('2 other tasks are working in this project.');
    await expect(page.locator('#nc-send')).toBeDisabled();
    await page.locator('#nc-text').blur();
    await shot(page, 'newchat-peers.png');
    await page.locator('#nc-ack').click();
    await page.locator('#nc-text').press('Enter');
    expect(await h.app.evaluate(() => globalThis.__creates.length)).toBe(0);
    await page.locator('#nc-text').press('Meta+Enter');
    await expect.poll(() => h.app.evaluate(() => globalThis.__creates.length)).toBe(1);
    const [draft] = (await h.app.evaluate(() => globalThis.__creates))[0];
    expect(Object.keys(draft).sort()).toEqual(['ai', 'expectAi', 'folder', 'peersKey', 'permissionLevel', 'requestId', 'text']);
    expect(draft.folder).toBe('h-1');
    expect(draft.peersKey).toBe('k2');
  } finally { await h.cleanup(); }
});

test('started, not yet listed: Started. and Open in Tasks', async () => {
  const { h, side } = await open();
  try {
    const page = await openNewChat(h, side);
    await page.locator('#nc-text').fill('Add a retry to the invoice export');
    await expect(page.locator('#nc-send')).toBeEnabled();
    await page.locator('#nc-send').click();
    await expect(page.locator('#nc-started')).toBeVisible();
    await expect(page.locator('#nc-started-title')).toHaveText('Started.');
    await expect(page.locator('#nc-open')).toHaveText('Open in Tasks');
    await page.locator('#nc-open').blur();
    await shot(page, 'newchat-started.png');
  } finally { await h.cleanup(); }
});

// R7-1 (plan-r7 §1, plan-redesign §5): the two states the new chat has when it stands in for Home.
for (const theme of ['light', 'dark']) {
  test(`first run (${theme}): the greeting, the box, and starters that only fill the box`, async () => {
    const { h, side } = await open({ home: FIRST });
    try {
      const page = await openNewChat(h, side, theme);
      await expect(page.locator('#nc-title')).toHaveText('What should your AI work on?');
      await expect(page.locator('.nc-starter')).toHaveCount(3);
      expect(await h.app.evaluate(() => globalThis.__starters)).toContainEqual([{ handle: 'h-1' }]);
      await expect(page.locator('#nc-summary')).toBeHidden();
      await expect(page.locator('#nc-needs')).toBeHidden();
      await page.locator('#nc-text').blur();
      await shot(page, `new-chat-first-${theme}.png`);
      if (theme === 'light') {
        await page.locator('.nc-starter[data-starter="explain"]').click();
        await expect(page.locator('#nc-text')).toHaveValue(STARTERS.starters[0].text);
        await expect(page.locator('#nc-starters')).toBeHidden();
        expect(await h.app.evaluate(() => globalThis.__creates.length)).toBe(0);
      }
    } finally { await h.cleanup(); }
  });

  test(`returning (${theme}): one summary line, up to 3 Needs-you rows with Open, then the box; no starters`, async () => {
    const { h, side } = await open({ home: RETURNING });
    try {
      const page = await openNewChat(h, side, theme);
      await expect(page.locator('#nc-title')).toHaveText('New chat');
      await expect(page.locator('#nc-summary')).toHaveText('4 need you · 3 to check');
      await expect(page.locator('.nc-need')).toHaveCount(3);
      await expect(page.locator('#nc-more')).toHaveText('+ 1 more in the sidebar');
      await expect(page.locator('#nc-starters')).toBeHidden();
      await page.locator('#nc-text').blur();
      await shot(page, `new-chat-returning-${theme}.png`);
      if (theme === 'light') {
        await page.locator('.nc-need').first().getByRole('button', { name: /^Open / }).click();
        await expect.poll(() => h.app.evaluate(() => globalThis.__opens)).toEqual([[{ id: 'a'.repeat(64) }]]);
        expect(await h.app.evaluate(() => globalThis.__creates.length)).toBe(0);
      }
    } finally { await h.cleanup(); }
  });
}

