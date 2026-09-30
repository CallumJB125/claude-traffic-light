const fs = require('fs');
const path = require('path');
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
  await signal(h, { signal: 'session-end', session: 'visual', source: 'claude' });
  if (sig) await signal(h, { signal: sig, session: 'visual', source: 'claude', cwd: '/visual', tool: 'Bash' });
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

test('signal server: no CORS, browsers refused, POST needs the install token', async () => {
  const url = `http://127.0.0.1:${h.port}`;
  const body = JSON.stringify({ signal: 'tool-use', session: 'intruder', source: 'web' });
  const noToken = await fetch(`${url}/signal`, { method: 'POST', body });
  expect(noToken.status).toBe(401);
  const wrong = await fetch(`${url}/signal`, { method: 'POST', headers: { 'x-buddy-token': 'nope' }, body });
  expect(wrong.status).toBe(401);
  const fromPage = await fetch(`${url}/status`, { headers: { origin: 'https://evil.example' } });
  expect(fromPage.status).toBe(403);
  expect(fromPage.headers.get('access-control-allow-origin')).toBeNull();
  expect((await fetch(`${url}/status`, { method: 'OPTIONS' })).headers.get('access-control-allow-origin')).toBeNull();
  const ok = await fetch(`${url}/status`);
  expect(ok.status).toBe(200);
  expect(ok.headers.get('access-control-allow-origin')).toBeNull();
  expect((await status(h.port)).sessions.some((s) => s.source === 'web')).toBe(false);
  expect(fs.statSync(path.join(h.home, 'token')).mode & 0o777).toBe(0o600);
});

// Tighter than the config's per-pixel default (0.2): at 0.2 a lamp hue
// change passes as anti-aliasing noise. Any pixel past 0.05 still fails
// (maxDiffPixelRatio 0).
const SHOT = { threshold: 0.05 };

for (const [name, sig, lamp] of STATES) {
  test(`widget renders the ${name} state`, async () => {
    await setState(sig, lamp);
    await expect(widget).toHaveScreenshot(`widget-${name}.png`, SHOT);
  });
}

test('widget renders the working state under reduced motion', async () => {
  await widget.emulateMedia({ reducedMotion: 'reduce' });
  await setState('tool-use', 'green');
  await expect(widget).toHaveScreenshot('widget-working-green-reduced-motion.png', SHOT);
  await widget.emulateMedia({ reducedMotion: 'no-preference' });
});

// F1 spend: a session burning past the runaway threshold ($40 in 20 min by
// default) turns the lamp pulsing red with wide eyes; the tooltip carries the
// burn rate. The fixture transcript is priced by the app's own reader; its
// first turn sits 17.5 min back so the rate reads "18 min" for the next minute.
test('widget renders the runaway-red state', async () => {
  const now = Date.now();
  const line = (min, i, out) => JSON.stringify({
    type: 'assistant', sessionId: 'visual-burn', cwd: '/visual', timestamp: new Date(now - min * 60000).toISOString(), requestId: `r${i}`,
    message: { id: `m${i}`, model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  fs.mkdirSync(path.join(h.projects, 'visual'), { recursive: true });
  // 1,888,000 output tokens at $25/M = $47.20.
  fs.writeFileSync(path.join(h.projects, 'visual', 'visual-burn.jsonl'), `${[line(17.5, 0, 1000000), line(1, 1, 888000)].join('\n')}\n`);
  await signal(h, { signal: 'session-end', session: 'visual', source: 'claude' });
  await signal(h, { signal: 'tool-use', session: 'visual-burn', source: 'claude', cwd: '/visual', tool: 'Bash' });
  await expect.poll(async () => (await status(h.port)).look.ruleId, { timeout: 30000 }).toBe('runaway');
  expect((await status(h.port)).spend).toEqual({ level: null, runaway: 1 });
  expect((await status(h.port)).look.lamp).toBe('red');
  await expect.poll(() => widget.locator('#tooltip').textContent()).toContain('Runaway session ($47.20 in 18 min in visual)');
  await widget.waitForTimeout(600);
  await expect(widget).toHaveScreenshot('widget-runaway-red.png', SHOT);
  await signal(h, { signal: 'session-end', session: 'visual-burn', source: 'claude' });
});
