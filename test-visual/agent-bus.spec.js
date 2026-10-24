'use strict';
// The agent bus through the actual main.js (board/AGENT-BUS.md): Preferences →
// Advanced → Agent bus saves to config; an AI's /bus handoff into a repository
// on the exclude list is refused and audited on Sessions → Agent bus, where
// the person can stop and resume the bus. Temp home, temp repo, no AI started.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launchApp, embedded, openSettingsPane, snapToPixels } = require('./app');

test('agent bus: Preferences section, refusal on the Sessions panel, stop and resume', async () => {
  test.setTimeout(120000);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-bus-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const h = await launchApp();
  const { app, home, port } = h;
  try {
    await expect.poll(() => fs.existsSync(path.join(home, 'token')), { timeout: 15000 }).toBe(true);
    const bus = async (op, args) => (await fetch(`http://127.0.0.1:${port}/bus`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-buddy-token': fs.readFileSync(path.join(home, 'token'), 'utf8') }, body: JSON.stringify({ op, args }) })).json();

    const settings = await embedded(app, 'settings', 'settings.html');
    await openSettingsPane(settings, 'advanced');
    const section = settings.locator('#agent-bus-settings');
    await expect(settings.locator('#agentBusEnabled')).toBeChecked();
    await expect(settings.locator('#agentBusAutoAccept')).toBeChecked();
    await expect(settings.locator('#agentBusCaps')).not.toBeChecked();
    await expect(settings.locator('#agentBusWallClock')).toHaveValue('20');
    // Since #30 (5e815e02) the section is taller than the window, so the page's sticky footer (.actions) sat over its
    // last lines in the shot. Hidden for the shot only, then put back.
    await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const footer = settings.locator('.actions:has(#feedback-open)');
    await footer.evaluate((el) => { el.style.visibility = 'hidden'; });
    await expect(await snapToPixels(section)).toHaveScreenshot('agent-bus-preferences.png');
    await footer.evaluate((el) => { el.style.visibility = ''; });
    await settings.locator('#agentBusWallClock').fill('15');
    await settings.locator('#agentBusWallClock').dispatchEvent('change');
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).agentBus?.wallClockMin).toBe(15);
    await settings.locator('#agentBusExclude').fill(repo);
    await settings.locator('#agentBusExclude').dispatchEvent('change');
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).agentBus?.exclude).toEqual([repo]);

    // Excluded (automatic mode would otherwise take it): refused, nothing starts, the refusal is audited.
    const r = await bus('handoff', { request_id: 'visual-0001', to: { provider: 'codex' }, title: 'Fix the parser', provider: 'claude', cwd: repo });
    expect(r, JSON.stringify(r)).toMatchObject({ reason: 'NO_ELIGIBLE_AGENT' });
    expect((await bus('halt', {})).reason).toBe('VALIDATION');

    const page = await embedded(app, 'sessions', 'sessions.html');
    const panel = page.locator('#agent-bus');
    await expect(panel).toBeVisible({ timeout: 20000 });
    await expect(panel).toContainText('Refused “Fix the parser”: this repository is not on the agent bus');
    await expect(panel).toContainText('Running: handoffs start on their own');
    await expect(await snapToPixels(panel)).toHaveScreenshot('agent-bus-sessions.png');

    await panel.getByRole('button', { name: 'Stop agent bus' }).click();
    await expect(page.locator('#agent-bus-status')).toContainText('Stopped.');
    await expect(panel).toContainText('You stopped the agent bus');
    expect((await bus('handoff', { request_id: 'visual-0002', to: { provider: 'codex' }, title: 'While stopped', provider: 'claude', cwd: repo })).reason).toBe('HALTED');
    expect((await bus('status', {})).halted).toBe(true);
    await panel.getByRole('button', { name: 'Resume agent bus' }).click();
    await expect(page.locator('#agent-bus-status')).toContainText('Resumed.');
    expect((await bus('status', {})).halted).toBe(false);
  } finally {
    await h.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
