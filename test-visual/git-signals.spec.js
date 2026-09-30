// The widget showing a Git and CI event. Dev runs never call gh, so the
// event is seeded the way a real poll leaves it: in git-signals.json.
const { test, expect } = require('@playwright/test');
const { launchApp, status, windowByFile } = require('./app');

let h;
let widget;

test.beforeAll(async () => {
  const event = { id: 'run:acme/widget:1001:1:failure', signal: 'ci-failed', repo: 'acme/widget', branch: 'feat/x', title: 'CI', at: new Date().toISOString(), firedAt: Date.now(), source: 'poll', cwd: null };
  h = await launchApp({ files: { 'git-signals.json': JSON.stringify({ state: 'ok', events: [event], seen: { [event.id]: Date.now() } }) } });
  widget = await windowByFile(h.app, 'index.html');
  await widget.emulateMedia({ reducedMotion: 'no-preference' });
});

test.afterAll(async () => { await h?.cleanup(); });

test('widget renders the ci-failed state (lamp off, sign up)', async () => {
  await expect.poll(async () => (await status(h.port)).look.text).toBe('CI FAILED');
  const { look } = await status(h.port);
  expect(look.lamp).toBe('off');
  expect(look.pose).toBe('banner');
  await widget.waitForTimeout(600);
  await expect(widget).toHaveScreenshot('widget-ci-failed.png', { threshold: 0.05 });
});
