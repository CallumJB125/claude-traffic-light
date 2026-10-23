'use strict';
// Find agents in the real app: browse, search, the detail sheet with the full
// prompt, the + confirmation (opened, never confirmed), and the no-key state,
// in light and dark. Adding and Undo are covered by test/agents-find-main.test.js
// with a fake safeStorage; this spec never adds, so it never makes a ledger key
// or touches the keychain. PLEXIFORM_AGENTS_HOME / _DATA point at temp folders
// (honoured only by an unpackaged build), so the real ~/.claude is never read.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchApp, embedded } = require('./app');

// A native checkbox is tinted only while its window is key; the shared style pins it.
const SHOT = { stylePath: path.join(__dirname, 'no-hover-chrome.css') };

// The detail sheet and the + popover list the AI tools this computer has,
// which differ per machine, so the spec answers agents:targets itself. The
// real handler is covered by test/agents-find-main.test.js.
const TARGETS = {
  ok: true, everyTool: true, toolsSummary: 'Every tool your AI tool has. The author didn\'t limit it.', flagCount: 0,
  platforms: [
    { platform: 'claude', label: 'Claude Code', choice: 'default', status: 'new', path: '~/.claude/agents/frontend-developer.md', reason: null, canAlt: false, altName: null, projectEnabled: false },
    { platform: 'codex', label: 'Codex', choice: 'default', status: 'user-file', path: '~/.codex/agents/frontend-developer.toml', reason: 'You have your own frontend-developer.toml here; Plexiform left it alone.', canAlt: true, altName: 'frontend-developer-plexiform', projectEnabled: false },
    { platform: 'gemini', label: 'Gemini CLI', choice: 'offered', status: 'new', path: '~/.gemini/agents/frontend-developer.md', reason: null, canAlt: false, altName: null, projectEnabled: false },
    { platform: 'cursor', label: 'Cursor', choice: 'project-only', status: null, path: null, reason: 'Cursor rules live in a project. Use "Add to a project…".', canAlt: false, altName: null, projectEnabled: true },
  ],
};

// "Added by me" with an adopted agent, an update available, a changed copy,
// earlier clicks and a backup; and three agents adoptable. Answered by the
// spec, so it never adopts or makes a key; the real handlers are in
// test/agents-find-main.test.js and test/agent-adopt-safety.test.js.
const MINE = {
  ok: true, demo: false,
  agents: [
    { agentId: 'agency/frontend-developer', name: 'Frontend Developer', inCatalogue: true, platforms: [{ platform: 'claude', state: 'update-available', how: 'added', path: '~/.claude/agents/frontend-developer.md' }, { platform: 'codex', state: 'current', how: 'added', path: '~/.codex/agents/frontend-developer.toml' }] },
    { agentId: 'voltagent/code-reviewer', name: 'code-reviewer', inCatalogue: true, platforms: [{ platform: 'claude', state: 'current', how: 'adopted', path: '~/.claude/agents/code-reviewer.md' }] },
    { agentId: 'wshobson/security-auditor', name: 'security-auditor', inCatalogue: true, platforms: [{ platform: 'claude', state: 'modified', how: 'added', path: '~/.claude/agents/security-auditor.md' }] },
  ],
  ops: [
    { opId: '11111111-1111-4111-8111-111111111111', kind: 'adopt', agentId: null, name: null, at: '2026-10-22T09:15:00.000Z', files: 1, thisRun: false },
    { opId: '22222222-2222-4222-8222-222222222222', kind: 'add', agentId: 'agency/frontend-developer', name: 'Frontend Developer', at: '2026-10-21T16:40:00.000Z', files: 2, thisRun: false },
  ],
  backups: [{ id: 'claude-agents-20261022T091500000Z-0a1b2c3d', at: '2026-10-22T09:15:00.000Z', files: 171, restore: 'ditto "$HOME/Library/Application Support/Plexiform/agent-backups/claude-agents-20261022T091500000Z-0a1b2c3d" "$HOME/.claude/agents-restored"' }],
};
const ADOPTABLE = { ok: true, demo: false, userOwned: 40, reason: null, matches: ['ai-engineer.md', 'backend-architect.md', 'devops-automator.md'].map((n) => ({ name: n, path: `~/.claude/agents/${n}`, agentId: 'x/y', agentName: n.replace('.md', '') })) };

async function open(theme, { noKey = false } = {}) {
  const agentsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-visual-home-'));
  const agentsData = fs.mkdtempSync(path.join(os.tmpdir(), 'af-visual-data-'));
  const h = await launchApp({ env: { PLEXIFORM_AGENTS_HOME: fs.realpathSync(agentsHome), PLEXIFORM_AGENTS_DATA: fs.realpathSync(agentsData) } });
  await h.app.evaluate(({ ipcMain, safeStorage }, { noKey, targets }) => {
    // Stubbed both ways so no automated run asks the real safeStorage (L1).
    safeStorage.isEncryptionAvailable = () => !noKey;
    ipcMain.removeHandler('agents:targets');
    ipcMain.handle('agents:targets', () => ({ ...targets, catalogSha: null }));
    ipcMain.removeHandler('agents:mine');
    ipcMain.handle('agents:mine', () => mine);
    ipcMain.removeHandler('agents:adoptable');
    ipcMain.handle('agents:adoptable', () => adoptable);
  }, { noKey, targets: TARGETS, mine: MINE, adoptable: ADOPTABLE });
  const page = await embedded(h.app, 'agents-find', 'agents-find.html');
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.waitForSelector('.af-card');
  await page.evaluate(() => document.fonts.ready);
  const done = async () => {
    // The spec never adds, so no key was made.
    expect(fs.existsSync(path.join(agentsData, 'agent-installs.key'))).toBe(false);
    expect(fs.readdirSync(agentsHome)).toEqual([]);
    await h.cleanup();
    fs.rmSync(agentsHome, { recursive: true, force: true });
    fs.rmSync(agentsData, { recursive: true, force: true });
  };
  return { h, page, done };
}

for (const theme of ['light', 'dark']) {
  test(`Find agents: browse, search, detail and the + confirmation (${theme})`, async () => {
    const { h, page, done } = await open(theme);
    try {
      expect(await page.textContent('#af-title')).toBe('Find agents');
      expect(await page.textContent('.af-count')).toBe('647 agents.');
      // No link and no href anywhere: the window opens any http(s) link outside.
      expect(await page.evaluate(() => document.querySelectorAll('a, [href]:not(link)').length)).toBe(0);
      await expect(page).toHaveScreenshot(`find-agents-grid-${theme}.png`, SHOT);

      await page.fill('#af-search', 'frontend developer');
      await expect(page.locator('.af-card')).toHaveCount(4);
      expect(await page.locator('.af-card-name strong').first().textContent()).toBe('frontend-developer');
      await expect(page).toHaveScreenshot(`find-agents-search-${theme}.png`, SHOT);

      await page.click('.af-card-open');
      await page.waitForSelector('.af-drawer:not([hidden]) .af-prompt');
      expect(await page.textContent('#af-drawer-title')).toBe('frontend-developer');
      expect(await page.locator('.af-prompt .af-ph').count()).toBeGreaterThan(3);
      expect(await page.evaluate(() => document.querySelectorAll('a, [href]:not(link)').length)).toBe(0);
      await expect(page).toHaveScreenshot(`find-agents-detail-${theme}.png`, SHOT);
      await page.keyboard.press('Escape');
      await expect(page.locator('.af-drawer')).toBeHidden();

      await page.click('.af-plus');
      await page.waitForSelector('.af-pop:not([hidden]) .af-pick');
      // One step: focus is on the confirm button, which names the ticked tools.
      expect(await page.evaluate(() => document.activeElement.textContent)).toBe('Add to 1 tool');
      expect(await page.textContent('.af-pop .af-warn')).toBe('It gets every tool your AI tool has. The author didn\'t limit it.');
      await expect(page).toHaveScreenshot(`find-agents-confirm-${theme}.png`, SHOT);
      await page.keyboard.press('Escape');
      await expect(page.locator('.af-pop')).toBeHidden();

      // Works with: the tools found differ per machine, so pick the first offered.
      await page.fill('#af-search', '');
      const works = await page.$$eval('#af-works option', (o) => o.map((x) => x.value).filter(Boolean));
      if (works.length) {
        await page.selectOption('#af-works', works[0]);
        expect(Number((await page.textContent('.af-count')).match(/^(\d+)/)[1])).toBeLessThanOrEqual(647);
        await page.selectOption('#af-works', '');
      }

      // Added by me (stubbed answers): rows, states, Update, Undo, backups.
      await page.click('#af-tab-mine');
      await page.waitForSelector('.af-mine-row');
      expect(await page.textContent('#af-tab-mine')).toMatch(/^Added by me/);
      expect(await page.locator('.af-mine-bar .af-btn').allTextContents()).toEqual(['Adopt existing agents (3)', 'Stop managing adopted (1)']);
      expect(await page.locator('.af-states li').allTextContents()).toEqual(['Claude Code · Update available', 'Codex · Current', 'Claude Code · Current · Adopted', 'Claude Code · Changed by you']);
      expect(await page.locator('.af-ops .af-btn').count()).toBe(2);
      expect(await page.evaluate(() => document.querySelectorAll('a, [href]:not(link)').length)).toBe(0);
      await page.click('.af-restore summary');
      expect(await page.textContent('.af-restore code')).toContain('"$HOME/.claude/agents-restored"');
      await expect(page).toHaveScreenshot(`find-agents-mine-${theme}.png`, { ...SHOT, fullPage: true });
    } finally { await done(); }
  });
}

test('Find agents without the system keychain: browse only, + off with the reason', async () => {
  const { page, done } = await open('light', { noKey: true });
  try {
    await expect(page.locator('.af-notice')).toContainText('can\'t keep a safe record');
    expect(await page.locator('.af-plus:disabled').count()).toBe(await page.locator('.af-plus').count());
    await expect(page).toHaveScreenshot('find-agents-no-key.png', SHOT);
  } finally { await done(); }
});
