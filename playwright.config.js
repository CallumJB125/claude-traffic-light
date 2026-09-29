const { defineConfig } = require('@playwright/test');

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
