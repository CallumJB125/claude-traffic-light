// F5: a busy spell (a fake source: dev runs never touch the real calendar or
// Focus) with things happening in it, then the "While you were away" recap.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, signal, windowByFile } = require('./app');
const Spend = require('../spend.js');
const Usage = require('../usage.js');

let h;
let widget;
let fake;
const appLog = [];
const setBusy = (busy) => fs.writeFileSync(fake, JSON.stringify({ busy, reason: 'Standup' }));
const aggregate = () => widget.evaluate(() => window.trafficLight.getAggregateStatus());

test.beforeAll(async () => {
  fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-busy-')), 'busy.json');
  setBusy(true);
  h = await launchApp({ env: { CLAUDE_BUDDY_FAKE_BUSY: fake, CLAUDE_BUDDY_BUSY_TICK_MS: '250' } });
  widget = await windowByFile(h.app, 'index.html');
  h.app.process().stdout.on('data', (d) => appLog.push(...String(d).split('\n')));
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
  // Notifications go out on the next status broadcast: let both land (the
  // failure held, the ask through) before the spell ends.
  await expect.poll(() => appLog.some((l) => l.includes('[notify] held while busy: turn-failed:'))).toBe(true);
  await expect.poll(() => appLog.some((l) => l.includes('[notify] permission-ask:'))).toBe(true);
  setBusy(false);
  await expect.poll(async () => (await aggregate()).away?.headline, { timeout: 5000 }).toBe('1 done · 1 needs you (permission for Bash on api) · 1 failure · 1 ping held');
  const recap = (await aggregate()).away;
  expect(recap.items.map((x) => [x.kind, x.folder, x.open])).toEqual([['needs-you', 'api', true], ['failed', 'docs', false], ['done', 'web', false]]);
  // The "Turn failed" notification is amber, so it waited; the red ask did not.
  expect(recap.heldPings).toEqual([{ rule: 'Turn failed', signal: 'turn-failed', count: 1 }]);
  // The same record is on disk for other readers (the phone, later).
  expect(JSON.parse(fs.readFileSync(path.join(h.home, 'away.json'), 'utf8')).headline).toBe(recap.headline);
  // The window grows by the strip's 64 px (main.js AWAY_PX) to make room for
  // the card; shoot only once it has, not the squashed frame before.
  await expect.poll(() => widget.evaluate(() => innerHeight)).toBe(200 + 64);
  await widget.waitForTimeout(600);
  await expect(widget).toHaveScreenshot('widget-away-recap.png', { threshold: 0.05 });
  await widget.evaluate(() => window.trafficLight.awayDismiss());
  await expect.poll(async () => (await aggregate()).away).toBeNull();
});

// F1 spend's budget-warning notification is amber, so it waits for the recap
// like any other amber ping. The snapshot is priced by the app's own reader
// ($45 of a $50 day) and handed in, as in the runaway visual test.
test('a budget warning during a busy spell is held and listed in the recap', async () => {
  const NOW = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-away-spend-'));
  fs.mkdirSync(path.join(dir, 'p'));
  fs.writeFileSync(path.join(dir, 'p', 'b.jsonl'), `${JSON.stringify({
    type: 'assistant', sessionId: 'b', cwd: '/work/budget', timestamp: new Date(NOW - 60000).toISOString(), requestId: 'r0',
    message: { id: 'm0', model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: 1800000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })}\n`);
  const { turns } = await Usage.readTurns({ since: NOW - 86400000, root: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  const snap = Spend.snapshot(turns, { dailyBudget: 50, runawayDollars: 0 }, NOW);
  expect(snap.budget.level).toBe('warning');
  for (const session of ['api', 'web', 'docs']) await signal(h, { signal: 'session-end', session, source: 'claude' });
  setBusy(true);
  await expect.poll(async () => (await aggregate()).busy).toBe(true);
  fs.writeFileSync(path.join(h.home, 'spend-snapshot.json'), JSON.stringify(snap));
  try {
    // A finished turn, so the budget rule (above "Task finished") owns the lamp.
    await signal(h, { signal: 'stop', session: 'budget', source: 'claude', cwd: '/work/budget' });
    await expect.poll(async () => (await aggregate()).fired).toContain('budget-warning');
    // The notification goes out on the next status broadcast; wait for it to
    // be held before the spell ends.
    await expect.poll(() => appLog.some((l) => l.includes('[notify] held while busy: budget-warning'))).toBe(true);
    setBusy(false);
    await expect.poll(async () => (await aggregate()).away?.heldPings, { timeout: 5000 }).toContainEqual({ rule: 'Nearing budget', signal: 'budget-warning', count: 1 });
  } finally {
    fs.rmSync(path.join(h.home, 'spend-snapshot.json'), { force: true });
    await signal(h, { signal: 'session-end', session: 'budget', source: 'claude' });
  }
});
