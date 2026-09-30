// Screenshots of the Integrations page on a real dev hub (fake connector,
// signed webhooks). Fails on console/CSP errors.  node web/scripts/integrations-shots.mjs <outDir>
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { sign } from '../../hub/integrations/fake/index.js';

const out = process.argv[2];
const port = 18000 + Math.floor(Math.random() * 1000);
const env = { ...process.env, BOARD_AUTH: 'dev', BOARD_DEV_SEED: '1', BOARD_DEV_LOGIN_SECRET: 'devsecret-devsecret-123', BOARD_PORT: String(port), BOARD_BIND: '127.0.0.1', BOARD_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'integ-')), BOARD_ENC_KEY: randomBytes(32).toString('hex') };
const hub = spawn(process.execPath, ['hub/server.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const login = await fetch(`${base}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'board-dev-secret': env.BOARD_DEV_LOGIN_SECRET }, body: JSON.stringify({ github_login: 'alice' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const j = (m, p, b) => fetch(`${base}${p}`, { method: m, headers: { cookie, 'content-type': 'application/json', origin: base }, body: b ? JSON.stringify({ request_id: randomUUID(), ...b }) : undefined }).then((r) => r.json());
const { connection } = await j('POST', '/api/integrations/fake/token', { token: 'fake_abcdef123456' });
for (const [id, title] of [['ISS-41', 'Checkout button does nothing on Safari'], ['ISS-42', 'CSV export drops the last row']]) {
  const raw = JSON.stringify({ event: 'issue.opened', issue: { id, title } });
  await fetch(`${base}/integrations/${connection.id}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-signature': sign('whsec_abcdef123456', Buffer.from(raw)), 'x-fake-delivery': randomUUID() }, body: raw });
}
const problems = [];
const browser = await chromium.launch({ channel: 'chrome' });
for (const [scheme, w, name] of [['dark', 1280, 'integ-dark'], ['light', 1280, 'integ-light'], ['dark', 390, 'integ-phone']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 860 }, colorScheme: scheme, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base }]);
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/.test(m.text())) problems.push(m.text()); });
  p.on('pageerror', (e) => problems.push(e.message));
  await p.goto(`${base}/?view=integrations`);
  await p.locator('.integ-card').first().waitFor();
  await p.getByRole('button', { name: 'Activity' }).click();
  await p.locator('.integ-activity li').first().waitFor();
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
}
await browser.close();
hub.kill();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('ok');
process.exit(0);
