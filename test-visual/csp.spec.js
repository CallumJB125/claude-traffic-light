// The widget and the Lights editor run under a Content-Security-Policy
// <meta>. Every state below must render without one violation: a blocked
// image, style or script would otherwise fail silently.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, signal, windowByFile } = require('./app');
const states = require('../test/fixtures/updater-states.json').states;

const GARDEN_RULE = { id: 'csp-garden', name: 'Garden', when: { signal: ['tool-use'] }, then: { lamp: 'green', effect: 'garden' } };

const violations = [];
const appLog = [];

// Both channels: the DOM event (with the blocked URI) and the console line.
async function watch(page, label) {
  await page.context().addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} @${(e.sourceFile || '').split('/').pop()}:${e.lineNumber}`));
  });
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(`${label} console: ${m.text().slice(0, 200)}`); });
  await page.reload();
  await page.waitForLoadState('load');
}
const collect = async (page, label) => { for (const v of await page.evaluate(() => window.__csp || [])) violations.push(`${label}: ${v}`); };

let h;
let widget;
let lights;

test.beforeAll(async () => {
  h = await launchApp({ config: { askFromWidget: true } });
  h.app.process().stdout.on('data', (d) => appLog.push(...String(d).split('\n')));
  widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openLights());
  lights = await windowByFile(h.app, 'lights.html');
  await lights.waitForLoadState('load');
  await watch(widget, 'widget');
  await watch(lights, 'lights');
});

test.afterAll(async () => { await h?.cleanup(); });

test('the policy is really enforced: an inline handler and a fetch are both refused', async () => {
  const marker = [];
  const page = widget;
  page.on('console', (m) => marker.push(m.text()));
  await page.evaluate(() => { const b = document.createElement('b'); b.setAttribute('onclick', 'window.__x = 1'); document.body.append(b); b.click(); fetch('https://example.invalid/').catch(() => {}); });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__x)).toBeUndefined();
  const seen = await page.evaluate(() => window.__csp);
  expect(seen.some((s) => s.startsWith('script-src'))).toBe(true);
  expect(seen.some((s) => s.startsWith('connect-src'))).toBe(true);
  await page.evaluate(() => { window.__csp.length = 0; });
  violations.length = 0;
});

test('widget: idle, working, asking, away recap, update row, costume, cameo photo', async () => {
  const send = (sig, extra = {}) => signal(h, { signal: sig, session: 'csp', source: 'claude', cwd: '/work/csp', tool: 'Bash', ...extra });
  await widget.waitForTimeout(500);
  await send('tool-use');
  await widget.waitForTimeout(500);
  await send('stop');

  // asking: the bubble
  const dir = path.join(h.home, 'requests');
  fs.mkdirSync(dir, { recursive: true });
  const req = { id: 'csp-ask', sessionId: 'csp', cwd: '/work/csp', tool: 'Bash', summary: '', toolInput: { command: 'ls -la' }, toolInputHash: 'x', createdAt: new Date().toISOString() };
  req.decisionHash = require('../hooks/answer-file.js').decisionHashOf(req);
  fs.writeFileSync(path.join(dir, 'csp-ask.json'), JSON.stringify(req));
  await expect(widget.locator('#bubble')).toBeVisible({ timeout: 10000 });
  await widget.waitForTimeout(600);
  fs.rmSync(path.join(dir, 'csp-ask.json'));
  await widget.waitForTimeout(600);

  // update row
  await h.app.evaluate(({ webContents }, s) => { for (const w of webContents.getAllWebContents()) w.send('updater:state', s); }, states['ready-restart']);
  await expect(widget.locator('#update')).not.toHaveClass('', { timeout: 5000 });

  // away recap: the renderer's own function, fed a recap (the real one needs a busy spell)
  await widget.evaluate(() => renderAway({ headline: '1 done', items: [{ kind: 'done', folder: 'web', open: false }], heldPings: [] }));
  await expect(widget.locator('#away')).toBeVisible();
  await widget.waitForTimeout(500);

  // costume and a cameo photo, both through the rig the widget uses
  const photo = await widget.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = '#c96'; g.fillRect(0, 0, 32, 32);
    return c.toDataURL('image/png');
  });
  await widget.evaluate((src) => rig.setLook({ lamp: 'green', eyes: 'default', pose: 'none', costume: 'crown', cameo: 'csp-photo', cameoPhoto: { id: 'csp-photo', rev: 1, src, shape: 'oval', eyes: { x: 0.5, y: 0.4 }, mouth: { x: 0.5, y: 0.75 } } }), photo);
  await widget.waitForTimeout(600);
  expect(await widget.locator('image').count()).toBeGreaterThan(0);
  await collect(widget, 'widget');
  expect(violations).toEqual([]);
});

test('widget: the shipped cameo photos load through the real status path', async () => {
  const cameo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'cameos', 'built', 'index.json'), 'utf8'));
  const id = Object.keys(cameo.cameos || cameo)[0];
  await lights.evaluate((i) => window.lightsApi.previewOnWidget({ lamp: 'green', eyes: 'default', pose: 'none', costume: 'none', cameo: i }, 3000), id);
  await widget.waitForTimeout(800);
  expect(await widget.locator('image').count()).toBeGreaterThan(0);
  await collect(widget, 'widget');
  expect(violations).toEqual([]);
});

test('widget: garden', async () => {
  test.setTimeout(60000);
  await lights.evaluate((r) => window.lightsApi.saveConfig({ rules: [r] }), GARDEN_RULE);
  await signal(h, { signal: 'tool-use', session: 'garden', source: 'claude', cwd: '/work/garden', tool: 'Bash' });
  await expect.poll(() => appLog.some((l) => l.includes('[garden] start')), { timeout: 15000 }).toBe(true);
  await widget.waitForTimeout(3000);
  await collect(widget, 'widget');
  expect(violations).toEqual([]);
});

test('lights: every tab, sounds, export, a photo cameo', async () => {
  test.setTimeout(120000);
  for (const t of ['view-stats', 'view-mix', 'view-auto', 'view-rules']) {
    await lights.click(`#${t}`);
    await lights.waitForTimeout(500);
  }
  await lights.click('#view-mix');
  await lights.waitForTimeout(800);
  await lights.click('#view-stats');
  for (const d of ['7', '30', '60']) { await lights.click(`[data-days="${d}"]`, { timeout: 5000 }); await lights.waitForTimeout(200); }
  await lights.click('#view-rules');

  // sounds: the file-less preview goes to main; select a sound and play it
  await lights.locator('#rule-list li').first().click();
  const opts = await lights.locator('#sound option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
  if (opts.length) { await lights.selectOption('#sound', opts[0]); await lights.click('#sound-play'); }
  await lights.evaluate(() => window.lightsApi.previewSound('Glass'));

  // share / import / export menu
  await lights.click('#presets-btn');
  await lights.click('#share-copy', { timeout: 5000 });

  // a photo cameo: drop a real image on the face editor
  await lights.locator('.addface').click({ timeout: 20000 });
  await expect(lights.locator('#face-modal')).toBeVisible({ timeout: 20000 });
  // Under load the modal's drop handler can bind after the first drop: drop again until the frame is there.
  const drop = () => lights.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#6a9'; g.fillRect(0, 0, 200, 200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'face.png', { type: 'image/png' }));
    document.getElementById('face-modal').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(async () => { await drop(); await expect(lights.locator('#face-frame')).toBeVisible({ timeout: 5000 }); }).toPass({ timeout: 40000 });
  await lights.waitForTimeout(800);
  await lights.fill('#face-name', 'CSP test');
  await lights.click('#face-save');
  await lights.waitForTimeout(1000);
  await collect(lights, 'lights');
  expect(await lights.evaluate(() => window.__errs)).toEqual([]);
  expect(violations).toEqual([]);
});

test('settings: Preferences, Health and Backups run under the policy', async () => {
  await lights.evaluate(() => window.lightsApi.openPreferences());
  const settings = await windowByFile(h.app, 'settings.html');
  await settings.waitForLoadState('load');
  await watch(settings, 'settings');
  await settings.locator('#health').scrollIntoViewIfNeeded();
  await expect(settings.locator('#health-summary')).not.toHaveText('', { timeout: 10000 });
  await settings.locator('#backups > summary').click();
  await settings.locator('#backups-now').click();
  await expect(settings.locator('#backups-status')).not.toHaveText('', { timeout: 5000 });
  await settings.locator('#health-recheck').click();
  await settings.waitForTimeout(500);
  // enforced here too: an inline handler never runs
  await settings.evaluate(() => { const b = document.createElement('b'); b.setAttribute('onclick', 'window.__x = 1'); document.body.append(b); b.click(); });
  await settings.waitForTimeout(200);
  expect(await settings.evaluate(() => window.__x)).toBeUndefined();
  const seen = await settings.evaluate(() => window.__csp);
  expect(seen.some((s) => s.startsWith('script-src'))).toBe(true);
  await settings.evaluate(() => { window.__csp.length = 0; });
  violations.length = 0;
  await settings.locator('#backups > summary').click();
  await collect(settings, 'settings');
  expect(violations).toEqual([]);
});

test('usage pop-out: renders under the policy, and an inline handler and a fetch are refused', async () => {
  await h.app.evaluate(() => global.__buddyTrayMenu.items.find((i) => i.label === 'Open Usage…').click());
  const pop = await windowByFile(h.app, 'usage-pop.html');
  await pop.waitForLoadState('load');
  await watch(pop, 'usage-pop');
  await expect(pop.locator('#note')).not.toHaveText('', { timeout: 10000 });
  await pop.evaluate(() => { const b = document.createElement('b'); b.setAttribute('onclick', 'window.__x = 1'); document.body.append(b); b.click(); fetch('https://example.invalid/').catch(() => {}); });
  await pop.waitForTimeout(300);
  expect(await pop.evaluate(() => window.__x)).toBeUndefined();
  const seen = await pop.evaluate(() => window.__csp);
  expect(seen.some((s) => s.startsWith('script-src'))).toBe(true);
  expect(seen.some((s) => s.startsWith('connect-src'))).toBe(true);
  await pop.evaluate(() => { window.__csp.length = 0; });
  violations.length = 0;
  await pop.waitForTimeout(200);
  await collect(pop, 'usage-pop');
  expect(violations).toEqual([]);
});
