
'use strict';
const { test, expect } = require('@playwright/test'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { launchApp, windowByFile } = require('./app'); const Rules = require('../rules');
test('actual Help and widget report multiple local providers and preserve the saved human rule', async () => {
  const syntheticHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-provider-help-'));
  const rules = [Rules.normalizeRule({ id: 'working', name: 'Claude is working', when: { signal: ['tool-use'] }, then: { lamp: 'green', pose: 'banner', text: 'MY HUMAN SIGN' } })];
  const now = new Date().toISOString(), files = {};
  for (const provider of ['codex', 'claude', 'cursor', 'gemini']) files[`sessions/${provider}.json`] = JSON.stringify({ sessionId: provider, source: provider, host: 'synthetic', cwd: '/synthetic/project', signal: 'tool-use', updatedAt: now, ...(provider === 'codex' ? { codexLifecycle: 1, codexHookAt: now } : {}) });
  const h = await launchApp({ config: { rules, rulesVersion: Rules.RULES_VERSION }, files, env: { HOME: syntheticHome, USERPROFILE: syntheticHome } });
  const inspect = (file, js) => h.app.evaluate(async ({ webContents }, { file, js }) => { const wc = webContents.getAllWebContents().find(w => { try { return new URL(w.getURL()).pathname.endsWith('/' + file); } catch { return false; } }); return wc ? wc.executeJavaScript(js) : null; }, { file, js });
  try {
    const widget = await windowByFile(h.app, 'index.html');
    const configBefore = fs.readFileSync(path.join(h.home, 'config.json'));
    await widget.evaluate(() => window.trafficLight.openHelp());
    await expect.poll(() => inspect('help.html', 'document.querySelector("#headline").textContent')).toBe('Claude: working · Codex: working · Cursor: working · Gemini: working');
    expect(await inspect('help.html', 'document.querySelector("#why").textContent')).toContain('“Claude is working”');
    expect(await inspect('help.html', 'document.querySelector("#why").textContent')).toContain('MY HUMAN SIGN');
    expect(await inspect('help.html', 'document.querySelector("#providers").textContent')).toContain('not a check that work succeeded');
    await expect.poll(() => widget.locator('#tooltip').textContent()).toContain('Codex: working');
    expect(await widget.locator('#tooltip').textContent()).toContain('Rule “Claude is working”');
    expect(fs.readFileSync(path.join(h.home, 'config.json')).equals(configBefore)).toBe(true);
    const codex = JSON.parse(fs.readFileSync(path.join(h.home, 'sessions/codex.json'))); codex.codexHookAt = new Date(Date.now() - 91000).toISOString();
    fs.writeFileSync(path.join(h.home, 'sessions/codex.json'), JSON.stringify(codex));
    await expect.poll(() => inspect('help.html', 'document.querySelector("#headline").textContent')).toContain('Codex: stale');
    await expect.poll(() => widget.locator('#tooltip').textContent()).toContain('Codex: stale');
    expect(fs.readFileSync(path.join(h.home, 'config.json')).equals(configBefore)).toBe(true);
  } finally { await h.cleanup(); fs.rmSync(syntheticHome, { recursive: true, force: true }); }
});
