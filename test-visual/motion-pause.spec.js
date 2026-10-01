const fs = require('fs');
const path = require('path');
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

// Every loop is back under the ambient clock: held by it (paused as far as
// the page is concerned), and the clock is moving them — a stepped loop may
// not change frame inside the window, but the smooth ones must.
async function ambientOwned() {
  return widget.evaluate(async () => {
    const loops = () => document.querySelector('svg.rig').getAnimations({ subtree: true }).filter((a) => a.effect.getTiming().iterations === Infinity);
    const before = loops().map((a) => [a, a.currentTime]);
    await new Promise((r) => setTimeout(r, 700));
    return before.length > 0 && before.every(([a]) => a.playState === 'paused') && before.some(([a, t]) => a.currentTime !== t);
  });
}

// How often an animation's frame changes, per second: ~60 on the display
// clock, 12 on the fast ambient grid, 6 on the slow one.
async function framesPerSecond(name) {
  return widget.evaluate(async (n) => {
    const a = document.querySelector('svg.rig').getAnimations({ subtree: true }).find((x) => x.animationName === n);
    if (!a) return null;
    const seen = new Set();
    const end = performance.now() + 1000;
    while (performance.now() < end) { seen.add(a.currentTime); await new Promise((r) => requestAnimationFrame(r)); }
    return seen.size;
  }, name);
}

// Try a look on the widget through the editor's preview.
async function preview(look) {
  let lights = h.app.windows().find((p) => !p.isClosed() && p.url().endsWith('lights.html'));
  if (!lights) {
    await widget.evaluate(() => window.trafficLight.openLights());
    lights = await windowByFile(h.app, 'lights.html');
    await lights.waitForLoadState('load');
  }
  await lights.evaluate((l) => window.lightsApi.previewOnWidget(l, 20000), { lamp: 'green', eyes: 'default', pose: 'none', ...look });
  await widget.waitForTimeout(600);
}

const widgetState = ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')); return { visible: w.isVisible(), minimized: w.isMinimized() }; };

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
  expect(await ambientOwned()).toBe(true);
});

test('hidden, then minimised, then restored: paused exactly while it cannot be seen', async () => {
  const step = async (fn) => {
    await main(fn);
    await widget.waitForTimeout(400);
    const w = await main(widgetState);
    expect(await paused()).toBe(!w.visible || w.minimized);
  };
  await step(hideWidget);
  await step(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).minimize());
  await step(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).restore());
  await step(showWidget);
  await expect.poll(paused).toBe(false);
  expect(await ambientOwned()).toBe(true);
});

test('a reload while minimised comes back paused, and resumes on restore', async () => {
  await main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).minimize());
  await expect.poll(paused).toBe(true);
  await widget.reload();
  await widget.waitForLoadState('load');
  await expect.poll(paused).toBe(true);
  await main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).restore());
  await main(showWidget);
  await expect.poll(paused).toBe(false);
  expect(await ambientOwned()).toBe(true);
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
  expect(await ambientOwned()).toBe(true);
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
  expect(await ambientOwned()).toBe(true);
});

test('clocks: the flame and the wag on the fast ambient grid; legs and a knock on the display clock', async () => {
  await preview({ effect: 'fire' });
  // 12 on the grid (a little over under load), against ~60 on the display clock
  const flame = await framesPerSecond('rig-flame');
  expect(flame).toBeGreaterThanOrEqual(9);
  expect(flame).toBeLessThan(25);
  await preview({ body: 'dog' });
  const wag = await framesPerSecond('rig-wag');
  expect(wag).toBeGreaterThanOrEqual(9);
  expect(wag).toBeLessThan(25);
  await preview({ pose: 'run' });
  expect(await framesPerSecond('rig-leg-a')).toBeGreaterThan(30);
  await preview({ pose: 'knock' });
  const knock = await widget.evaluate(() => document.querySelector('svg.rig').getAnimations({ subtree: true }).filter((a) => a.effect.getTiming().iterations === Infinity && a.effect.getTiming().duration < 1000 && !['rig-flame', 'rig-wag'].includes(a.animationName)).map((a) => a.animationName));
  expect(knock.length).toBeGreaterThan(0);
  for (const name of knock) expect(await framesPerSecond(name), name).toBeGreaterThan(30);
});

// The editor's stage runs at full rate while the editor has focus, and on the
// ambient clock when it doesn't — decided by the window's focus, which main
// sends in (the page's own hasFocus() can't be trusted under automation).
test('the editor stage follows its window focus: display clock focused, ambient clock not', async () => {
  let lights = h.app.windows().find((p) => !p.isClosed() && p.url().endsWith('lights.html'));
  if (!lights) {
    await widget.evaluate(() => window.trafficLight.openLights());
    lights = await windowByFile(h.app, 'lights.html');
    await lights.waitForLoadState('load');
  }
  const stageLoops = () => lights.evaluate(() => [...new Set(document.querySelector('#stage-rig svg').getAnimations({ subtree: true }).filter((a) => a.effect.getTiming().iterations === Infinity).map((a) => a.playState))]);
  const emit = (ev) => main(({ BrowserWindow }, e) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('lights.html')).emit(e), ev);
  await emit('focus');
  await expect.poll(stageLoops).toEqual(['running']);
  await emit('blur');
  await expect.poll(stageLoops).toEqual(['paused']);
  await emit('focus');
  await expect.poll(stageLoops).toEqual(['running']);
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

test('a widget that launches hidden (Floating Widget off) starts paused', async () => {
  const hh = await launchApp({ config: { showWidget: false } });
  try {
    const w = await windowByFile(hh.app, 'index.html');
    await w.waitForLoadState('load');
    await expect.poll(() => w.evaluate(() => document.body.classList.contains('motion-paused'))).toBe(true);
    await w.waitForTimeout(1800);
    expect(await w.evaluate(() => document.body.classList.contains('motion-paused'))).toBe(true);
  } finally { await hh.cleanup(); }
});

// Main answers waiting inputs while the widget is hidden (menu-bar mode, a
// snooze); the paused widget must still get them, and lose them once answered.
test('a paused widget still gets its waiting inputs, and they can be answered while hidden', async () => {
  const hh = await launchApp({ config: { askFromWidget: true } });
  try {
    const w = await windowByFile(hh.app, 'index.html');
    await w.waitForTimeout(1800);
    await hh.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).hide());
    await expect.poll(() => w.evaluate(() => document.body.classList.contains('motion-paused'))).toBe(true);
    const dir = path.join(hh.home, 'requests');
    fs.mkdirSync(dir, { recursive: true });
    const req = { id: 'paused-ask', sessionId: 'visual', cwd: '/visual/app', tool: 'Bash', summary: '', toolInput: { command: 'echo paused' }, toolInputHash: 'x', createdAt: new Date().toISOString() };
    req.decisionHash = require('../hooks/answer-file.js').decisionHashOf(req);
    fs.writeFileSync(path.join(dir, `${req.id}.json`), JSON.stringify(req));
    await expect(w.locator('.ib-head')).toContainText('echo paused', { timeout: 10000 });
    expect(await w.evaluate(() => document.body.classList.contains('motion-paused'))).toBe(true);
    const answered = await w.evaluate(async () => {
      const st = await window.trafficLight.getAggregateStatus();
      const input = st.inputs.find((i) => i.id === 'paused-ask');
      return window.trafficLight.answerInput(input.id, input.options[0].id);
    });
    expect(answered).toBeTruthy();
    // The hook takes its answer and removes the request, as the real one does.
    fs.rmSync(path.join(dir, `${req.id}.json`), { force: true });
    await expect.poll(() => w.evaluate(() => document.body.classList.contains('asking')), { timeout: 10000 }).toBe(false);
    expect(await w.evaluate(() => document.body.classList.contains('motion-paused'))).toBe(true);
  } finally { await hh.cleanup(); }
});
