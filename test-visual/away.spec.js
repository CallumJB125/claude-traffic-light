// F5: a busy spell (a fake source: dev runs never touch the real calendar or
// Focus) with things happening in it, then the "While you were away" recap.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, signal, windowByFile } = require('./app');

let h;
let widget;
let fake;
const setBusy = (busy) => fs.writeFileSync(fake, JSON.stringify({ busy, reason: 'Standup' }));
const aggregate = () => widget.evaluate(() => window.trafficLight.getAggregateStatus());

test.beforeAll(async () => {
  fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-busy-')), 'busy.json');
  setBusy(true);
  h = await launchApp({ env: { CLAUDE_BUDDY_FAKE_BUSY: fake, CLAUDE_BUDDY_BUSY_TICK_MS: '250' } });
  widget = await windowByFile(h.app, 'index.html');
  await widget.emulateMedia({ reducedMotion: 'no-preference' });
});

test.afterAll(async () => {
  await h?.cleanup();
  fs.rmSync(path.dirname(fake), { recursive: true, force: true });
});

test('a busy spell ends in a recap of what happened, and the widget shows it', async () => {
  await expect.poll(async () => (await aggregate()).busy).toBe(true);
  const send = (session, sig, extra = {}) => signal(h, { signal: sig, session, source: 'claude', cwd: `/work/${session}`, tool: 'Bash', ...extra });
  await send('api', 'tool-use');
  await send('web', 'tool-use');
  await send('docs', 'tool-use');
  await widget.waitForTimeout(400);
  await send('api', 'permission-ask');
  await send('web', 'stop');
  await send('docs', 'turn-failed');
  // A notification ask shows only once it has held past TRANSIENT_ASK_MS.
  await expect.poll(async () => (await aggregate()).sessions.find((s) => s.cwd === '/work/api')?.signal).toBe('permission-ask');
  expect((await aggregate()).away).toBeNull();
  setBusy(false);
  await expect.poll(async () => (await aggregate()).away?.headline, { timeout: 5000 }).toBe('1 done · 1 needs you (permission for Bash on api) · 1 failure');
  const recap = (await aggregate()).away;
  expect(recap.items.map((x) => [x.kind, x.folder, x.open])).toEqual([['needs-you', 'api', true], ['failed', 'docs', false], ['done', 'web', false]]);
  // The same record is on disk for other readers (the phone, later).
  expect(JSON.parse(fs.readFileSync(path.join(h.home, 'away.json'), 'utf8')).headline).toBe(recap.headline);
  await widget.waitForTimeout(600);
  await expect(widget).toHaveScreenshot('widget-away-recap.png', { threshold: 0.05 });
  await widget.evaluate(() => window.trafficLight.awayDismiss());
  await expect.poll(async () => (await aggregate()).away).toBeNull();
});
