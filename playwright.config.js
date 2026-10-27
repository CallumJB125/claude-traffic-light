const { defineConfig } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Playwright's transform cache lives in $TMPDIR/playwright-transform-cache-<uid>, shared by every run of this user.
// Two runs at once (several sessions, several worktrees) race on it and a spec can load a half-written CJS copy of
// an .mjs ("does not provide an export named ..."). One private cache per run; workers inherit the variable.
if (!process.env.PWTEST_CACHE_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cache-'));
  process.env.PWTEST_CACHE_DIR = dir;
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
}

module.exports = defineConfig({
  testDir: './test-visual',
  testMatch: '*.spec.js',
  // One Electron app per file; the specs are cheap, and serial keeps windows
  // from competing for focus and GPU.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  reporter: 'list',
  // Baselines are rendered by macOS Chromium; the platform suffix keeps other
  // OSes from being compared against them.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}-{platform}{ext}',
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0 },
  },
});
