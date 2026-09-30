const { test, expect } = require('@playwright/test');
const { launchApp, signal, status, windowByFile } = require('./app');

// The motion gate: anything that means nobody can see the widget (hidden,
// minimised, screen locked, asleep) stops its clocks, and they restart only
// once every reason has cleared. Nothing here changes a frame, so there is no
// screenshot: the rendered states are the widget spec's.
let h;
let widget;

test.beforeAll(async () => {
  h = await launchApp();
  widget = await windowByFile(h.app, 'index.html');
  await widget.emulateMedia({ reducedMotion: 'no-preference' });
  await signal(h, { signal: 'tool-use', session: 'pause', source: 'claude', cwd: '/pause', tool: 'Bash' });
  await expect.poll(async () => (await status(h.port)).look.lamp).toBe('green');
  // Past the widget's 1.5 s reveal fallback, which would re-show a hide.
  await widget.waitForTimeout(1600);
});

test.afterAll(async () => { await h?.cleanup(); });

const paused = () => widget.evaluate(() => document.body.classList.contains('motion-paused'));
const main = (fn, arg) => h.app.evaluate(fn, arg);
const hideWidget = ({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).hide();
const showWidget = ({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).showInactive();

// A paused rig holds every loop: the ambient clock stops moving them, so
// their currentTime stays put across a few ambient frames.
async function loopsHeld() {
  return widget.evaluate(async () => {
    const svg = document.querySelector('svg.rig');
    const read = () => svg.getAnimations({ subtree: true }).filter((a) => a.effect.getTiming().iterations === Infinity).map((a) => a.currentTime);
    const before = read();
    await new Promise((r) => setTimeout(r, 700));
    const after = read();
    return before.length > 0 && before.every((t, i) => t === after[i]);
  });
}

test('the working widget runs until something hides it', async () => {
  await expect.poll(paused).toBe(false);
  expect(await loopsHeld()).toBe(false);
});

test('hiding the widget pauses it; showing it resumes', async () => {
  await main(hideWidget);
  await expect.poll(paused).toBe(true);
  expect(await loopsHeld()).toBe(true);
  await main(showWidget);
  await expect.poll(paused).toBe(false);
  expect(await loopsHeld()).toBe(false);
});

test('a locked screen pauses it, and an unlock does not resume a widget that is still hidden', async () => {
  await main(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await expect.poll(paused).toBe(true);
  await main(hideWidget);
  await main(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
  await widget.waitForTimeout(300);
  expect(await paused()).toBe(true);
  await main(showWidget);
  await expect.poll(paused).toBe(false);
});

test('sleep pauses it until resume', async () => {
  await main(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await expect.poll(paused).toBe(true);
  await main(({ powerMonitor }) => powerMonitor.emit('resume'));
  await expect.poll(paused).toBe(false);
});

test('a state that changed while paused is on the widget the moment it resumes', async () => {
  await main(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await expect.poll(paused).toBe(true);
  await signal(h, { signal: 'session-end', session: 'pause', source: 'claude' });
  await signal(h, { signal: 'limit-hit', session: 'pause', source: 'claude', cwd: '/pause' });
  await expect.poll(async () => (await status(h.port)).look.lamp).toBe('red');
  await main(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
  await expect.poll(() => widget.evaluate(() => document.querySelector('svg.rig').classList.contains('pose-sleep'))).toBe(true);
});

// A worn character's own layers (.char-*) are injected after mount; the
// ambient clock must take their loops too (the dog's wag, 0.35 s), and the
// gate must hold them.
test('a non-default character: its layer loops ride the ambient clock and hold while hidden', async () => {
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.waitForLoadState('load');
  await lights.evaluate(() => window.lightsApi.previewOnWidget({ lamp: 'green', eyes: 'default', pose: 'none', body: 'dog' }, 20000));
  await expect.poll(() => widget.evaluate(() => document.querySelector('svg.rig').classList.contains('body-dog'))).toBe(true);
  const charLoops = () => widget.evaluate(() => document.querySelector('svg.rig').getAnimations({ subtree: true })
    .filter((a) => a.effect.getTiming().iterations === Infinity && a.effect.target.closest('[class^="char-"]'))
    .map((a) => a.playState));
  await expect.poll(charLoops).toEqual(['paused']);
  await main(hideWidget);
  await expect.poll(paused).toBe(true);
  expect(await loopsHeld()).toBe(true);
  await main(showWidget);
  await expect.poll(paused).toBe(false);
  expect(await loopsHeld()).toBe(false);
  await main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('lights.html')).close());
});

// The editor mounts a live rig per picker tile (~165); only the few in view
// may animate, and a minimised editor holds everything.
test('the Lights editor animates only what is in view, and holds while minimised', async () => {
  await widget.evaluate(() => window.trafficLight.openLights());
  const lights = await windowByFile(h.app, 'lights.html');
  await lights.waitForLoadState('load');
  await expect.poll(() => lights.evaluate(() => document.querySelectorAll('svg.rig.offscreen').length)).toBeGreaterThan(100);
  const running = () => lights.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect.target.closest('svg.rig.offscreen')).length);
  expect(await running()).toBe(0);
  const lightsPaused = () => lights.evaluate(() => document.body.classList.contains('motion-paused'));
  await main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('lights.html')).minimize());
  await expect.poll(lightsPaused).toBe(true);
  await main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('lights.html')).restore());
  await expect.poll(lightsPaused).toBe(false);
});
