const { test, expect } = require('@playwright/test');
const { launchApp, signal, status, windowByFile } = require('./app');

let h;
let widget;

test.beforeAll(async () => {
  h = await launchApp();
  widget = await windowByFile(h.app, 'index.html');
  await widget.emulateMedia({ reducedMotion: 'no-preference' });
});

test.afterAll(async () => { await h?.cleanup(); });

async function setState(sig, lamp) {
  await signal(h.port, { signal: 'session-end', session: 'visual', source: 'claude' });
  if (sig) await signal(h.port, { signal: sig, session: 'visual', source: 'claude', cwd: '/visual', tool: 'Bash' });
  await expect.poll(async () => (await status(h.port)).look.lamp).toBe(lamp);
  // The widget repaints on the status push; let the rig settle.
  await widget.waitForTimeout(600);
}

const STATES = [
  ['idle-off', null, 'off'],
  ['working-green', 'tool-use', 'green'],
  ['your-turn-amber', 'idle-nudge', 'amber'],
  ['blocked-red', 'limit-hit', 'red'],
];

for (const [name, sig, lamp] of STATES) {
  test(`widget renders the ${name} state`, async () => {
    await setState(sig, lamp);
    await expect(widget).toHaveScreenshot(`widget-${name}.png`);
  });
}

test('widget renders the working state under reduced motion', async () => {
  await widget.emulateMedia({ reducedMotion: 'reduce' });
  await setState('tool-use', 'green');
  await expect(widget).toHaveScreenshot('widget-working-green-reduced-motion.png');
  await widget.emulateMedia({ reducedMotion: 'no-preference' });
});
