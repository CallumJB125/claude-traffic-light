// LOCAL smoke of the phone PWA in headless Chrome at 390 px: an in-process
// accounts hub (loopback, outbox mailer), a "Mac" host on the FAKE codex
// app-server, and the real /phone/ page. Signs in, opens the Mac, starts a
// session, sends, reads the reply, then goes offline and reloads. Fails on
// any console error, page error, CSP violation or horizontal scroll.
//
//   node web/scripts/phone-smoke.mjs <outDir>
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { chromium } from 'playwright';
import { startAccounts } from '../../hub/test/accounts-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createRemoteInteractionHost } = require('../../../src/remote-interaction.js');
const { createCodexAppServer } = require('../../../src/codex-app-server.js');
const FAKE = path.join(here, '..', '..', '..', 'test', 'fixtures', 'fake-codex-app-server.js');

const out = path.resolve(process.argv[2] ?? 'phone-smoke');
await mkdir(out, { recursive: true });
const h = await startAccounts({ config: { webDir: path.join(here, '..') } });
const mac = await h.signIn('alice@dev.local', { device_name: 'Alice Mac' });
const host = createRemoteInteractionHost({ userId: mac.body.user.id, adapters: { codex: createCodexAppServer({ bin: FAKE }) }, boardCurrent: (b) => b === null });
await host.connect({ url: `${h.base.replace('http', 'ws')}/ws/interaction-host`, token: mac.body.device_token, WebSocket });

const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
const shots = [];
let offline = false;
try {
  for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, reducedMotion: 'reduce', deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (offline && /Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) return;
      if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`[${scheme} console ${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`[${scheme} pageerror] ${e.message}`));
    const shot = async (name) => {
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      if (sw > 390) problems.push(`[${scheme}] ${name}: horizontal scroll (${sw}px)`);
      const file = path.join(out, `${scheme}-${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
    };
    await page.goto(`${h.base}/phone/`);
    await page.getByLabel('Email').waitFor();
    await shot('1-signin');
    await page.getByLabel('Email').fill('alice@dev.local');
    await page.getByLabel('Name for this phone').fill(`Alice iPhone ${scheme}`);
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await page.getByLabel('6-digit code').waitFor();
    await shot('2-code');
    await page.getByLabel('6-digit code').fill(h.codeFor('alice@dev.local'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: /MacBook-Pro|Alice Mac/ }).waitFor();
    await shot('3-hosts');
    // Every interactive control is at least 44×44.
    const tiny = await page.evaluate(() => [...document.querySelectorAll('button, input, textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.width < 44 || r.height < 44); }).map((e) => e.textContent || e.id));
    if (tiny.length) problems.push(`[${scheme}] small targets: ${tiny.join(', ')}`);
    await page.getByRole('button', { name: /MacBook-Pro|Alice Mac/ }).click();
    await page.getByRole('button', { name: /Start a Codex/ }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill(`hello from the ${scheme} phone`);
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText(`echo:hello from the ${scheme} phone`).waitFor();
    await page.getByRole('textbox', { name: 'Message' }).fill('APPROVAL please <img src=x onerror=alert(1)>');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText(/Plexiform refused it/).waitFor();
    if (await page.locator('.log img').count()) problems.push(`[${scheme}] provider text became markup`);
    await shot('4-session');
    const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.active?.scriptURL ?? null; });
    if (!/\/phone\/sw\.js$/.test(sw ?? '')) problems.push(`[${scheme}] service worker not active: ${sw}`);
    // Offline: the shell still opens from cache and says it is offline, never "Ready".
    offline = true;
    await ctx.setOffline(true);
    await page.waitForTimeout(400);
    await page.reload();
    await page.getByText(/offline/i).first().waitFor();
    await shot('5-offline-reload');
    await ctx.setOffline(false);
    offline = false;
    // The cache holds only the shell.
    const cached = await page.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
    const bad = cached.filter((p) => p.startsWith('/api/') || p.startsWith('/auth/'));
    if (bad.length) problems.push(`[${scheme}] cached API/auth responses: ${bad.join(', ')}`);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    if (/bdt_/.test(stored)) problems.push(`[${scheme}] token in localStorage`);
    await ctx.close();
  }
} finally {
  await browser.close();
  host.close();
  await h.close();
}
for (const f of shots) console.log(f);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`phone smoke ok: ${shots.length} screenshots`);
