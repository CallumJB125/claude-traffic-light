// Actual bundled client UI, accounts hub, Chrome, fake loopback identities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, startHub, until, tmpDir, rm } from './harness.js';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* optional dependency */ }
const codeFrom = (logFile, email) => [...fs.readFileSync(logFile, 'utf8').matchAll(/To: (\S+)\nSubject: (\d{6}) is your \S+ sign-in code\n/g)].filter((m) => m[1] === email).at(-1)?.[2];
const signin = async (p, hub, email) => {
  await p.fill('#email', email); await p.click('#email-form button[type="submit"]');
  await p.waitForSelector('#code-form:not([hidden])');
  await p.fill('#code', await until(() => codeFrom(hub.logFile, email), { what: 'fake sign-in code' }));
  await p.click('#code-form button[type="submit"]');
};

test('client web: isolated workspace, staff publication, explicit invite sign-in, safe guest status and live revoke round trip', { skip: !chromium && 'playwright not installed' }, async () => {
  const root = tmpDir('bClient-'), dataDir = path.join(root, 'hub'); fs.mkdirSync(dataDir);
  const hub = await startHub({ dataDir, port: await freePort(), env: { BOARD_AUTH: 'accounts', BOARD_SIGNUP: 'open', BOARD_DEV_SEED: '', BOARD_DEV_LOGIN_SECRET: '', BOARD_ACCOUNTS_DEV: '1', BOARD_CONSOLE_MAILER: '1' } });
  let browser;
  const errors = [], guestRequests = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = async () => { const p = await (await browser.newContext({ baseURL: hub.url })).newPage(); p.setDefaultTimeout(10000); p.on('pageerror', (e) => errors.push(e.message)); return p; };
    const A = await page(); await A.goto('/signin'); await signin(A, hub, 'staff@client-e2e.test');
    await A.waitForSelector('.brand-board');
    await A.click('a[href="/clients"]');
    await A.fill('form[data-form="workspace"] input[name="name"]', 'Acme delivery');
    const created = A.waitForResponse((r) => new URL(r.url()).pathname === '/api/client-workspaces' && r.request().method() === 'POST');
    await A.click('form[data-form="workspace"] button[type="submit"]');
    const createdResponse = await created; assert.equal(createdResponse.status(), 200, await createdResponse.text());
    await A.waitForSelector('h2:has-text("Acme delivery")');
    await A.waitForSelector('text=Create an internal task');
    await A.click('a:has-text("Open this project’s Team board")');
    await A.waitForSelector('.brand-board:has-text("Acme delivery")');
    await A.click('[data-action="new-card"]'); await A.fill('#new-title', 'Internal task with private title');
    await A.click('form[data-form="new"] button[type="submit"]');
    await A.waitForSelector('.card:has-text("Internal task with private title")');
    const workspace = new URL(A.url()).searchParams.get('org');
    await A.goto(`/clients?workspace=${workspace}`);
    await A.waitForSelector('form[data-form="publish"]');
    await A.fill('form[data-form="publish"] input[name="title"]', 'Homepage delivery');
    await A.fill('form[data-form="publish"] textarea[name="summary"]', 'The design is ready for your review.');
    await A.selectOption('form[data-form="publish"] select[name="status"]', 'review');
    await A.click('form[data-form="publish"] button[type="submit"]');
    await A.waitForSelector('.client-item:has-text("Homepage delivery")');
    await A.fill('form[data-form="invite"] input[name="email"]', 'client@client-e2e.test');
    await A.check('form[data-form="invite"] input[value="artifacts.read"]');
    await A.check('form[data-form="invite"] input[value="approvals.decide"]');
    await A.click('form[data-form="invite"] button[type="submit"]');
    await A.waitForSelector('[aria-label="Client invitation link"]');
    const link = await A.inputValue('[aria-label="Client invitation link"]');
    assert.match(link, /\/client-invite#clinv_[A-Za-z0-9_-]{43}$/);
    const B = await page(); B.on('request', (r) => guestRequests.push(new URL(r.url()).pathname));
    await B.goto(link); await B.waitForSelector('#client-signin:not([hidden])');
    assert.equal(new URL(B.url()).hash, '');
    await B.click('#client-signin');
    await B.waitForSelector('text=Sign in to accept your client invitation');
    assert.equal(new URL(B.url()).hash, '', 'client token leaves the sign-in address bar');
    await signin(B, hub, 'client@client-e2e.test');
    await B.waitForSelector('.client-item:has-text("Homepage delivery")');
    assert.equal(await B.locator('.client-item:has-text("Ready for review")').count(), 1);
    assert.equal(await B.locator('form[data-form="publish"], form[data-form="workspace"], form[data-form="invite"]').count(), 0);
    assert.equal(await B.locator('text=Internal task with private title').count(), 0);
    const guest = await B.evaluate(() => fetch('/api/account').then((r) => r.json()));
    assert.equal(guest.teams.length, 0, 'guest has no automatic personal or staff team');
    assert.deepEqual(guest.client_workspaces.map((w) => w.id), [workspace]);
    assert.equal(guestRequests.some((p) => p.startsWith('/api/boards/')), false, 'client UI never reads the developer board');
    // Staff uploads real bytes; the assigned client downloads that exact
    // version and decides it. A replacement needs a new approval.
    await A.setInputFiles('form[data-form="artifact"] input[name="file"]', { name: 'homepage.txt', mimeType: 'text/plain', buffer: Buffer.from('Homepage version one') });
    await A.click('form[data-form="artifact"] button[type="submit"]');
    await A.waitForSelector('text=Deliverable · Version 1');
    await B.click('[data-action="refresh"]'); await B.waitForSelector('a:has-text("Download homepage.txt")');
    const contentUrl = await B.getAttribute('a[data-artifact]', 'href');
    const downloaded = B.waitForEvent('download'); await B.click('a[data-artifact]');
    assert.equal(fs.readFileSync(await (await downloaded).path(), 'utf8'), 'Homepage version one');
    assert.equal((await fetch(hub.url + contentUrl)).status, 401, 'forwarded download cannot bypass authentication');
    await A.check('form[data-form="approval"] input[name="guest_id"]'); await A.click('form[data-form="approval"] button[type="submit"]');
    await A.waitForSelector('text=Approval for version 1: Waiting for a decision');
    await B.click('[data-action="refresh"]'); await B.click('button:has-text("Approve version 1")');
    await B.waitForSelector('text=Approval for version 1: Approved');
    await A.setInputFiles('form[data-form="artifact"] input[name="file"]', { name: 'homepage.txt', mimeType: 'text/plain', buffer: Buffer.from('Homepage version two') });
    await A.click('form[data-form="artifact"] button[type="submit"]'); await A.waitForSelector('text=Deliverable · Version 2');
    await B.click('[data-action="refresh"]'); await B.waitForSelector('text=Approval for version 1: Replaced by a newer version');
    assert.equal(await B.locator('button:has-text("Approve version 2")').count(), 0);
    await A.check('form[data-form="approval"] input[name="guest_id"]'); await A.click('form[data-form="approval"] button[type="submit"]');
    await A.waitForSelector('text=Approval for version 2: Waiting for a decision');
    await B.click('[data-action="refresh"]'); await B.fill('form[data-form="decision"] textarea[name="comment"]', 'Please adjust the heading <script>text only</script>.');
    await B.click('button:has-text("Request changes")'); await B.waitForSelector('text=Approval for version 2: Changes requested');
    await B.waitForSelector('text=Please adjust the heading <script>text only</script>.');
    // An invitation arriving after the generic account read still wins over
    // automatic setup and requires consent; the actual setup transaction sees it.
    const C = await page();
    let releaseAccount, accountRead;
    const accountReady = new Promise((resolve) => { accountRead = resolve; });
    const accountGate = new Promise((resolve) => { releaseAccount = resolve; });
    await C.route('**/api/me', async (route) => { const response = await route.fetch(); accountRead(); await accountGate; await route.fulfill({ response }); });
    await C.goto('/signin'); await signin(C, hub, 'pending@client-e2e.test');
    await accountReady;
    await A.fill('form[data-form="invite"] input[name="email"]', 'pending@client-e2e.test');
    await A.uncheck('form[data-form="invite"] input[value="artifacts.read"]');
    await A.uncheck('form[data-form="invite"] input[value="approvals.decide"]');
    await A.click('form[data-form="invite"] button[type="submit"]');
    await A.waitForSelector('.client-person:has-text("pending@client-e2e.test")');
    releaseAccount();
    await C.waitForSelector('h2:has-text("Your invitations")');
    assert.equal((await C.evaluate(() => fetch('/api/account').then((r) => r.json()))).teams.length, 0);
    await C.click('button[data-action="accept"]'); await C.waitForSelector('.client-item:has-text("Homepage delivery")');
    assert.equal(await C.locator('a[data-artifact]').count(), 0, 'status-only guest cannot see artifact metadata');
    // A staff update is explicitly shared; clients fetch the safe projection.
    await A.fill('form[data-form="publish"] input[name="title"]', 'Homepage delivery');
    await A.fill('form[data-form="publish"] textarea[name="summary"]', 'Delivery completed.');
    await A.selectOption('form[data-form="publish"] select[name="status"]', 'done');
    await A.click('form[data-form="publish"] button[type="submit"]');
    await A.waitForSelector('.client-item:has-text("Delivery completed.")');
    await B.click('[data-action="refresh"]'); await B.waitForSelector('.client-item:has-text("Delivery completed.")');
    // Staff revocation removes the rendered projection on the next request.
    await A.click('.client-person:has-text("client@client-e2e.test") button[data-action="revoke"]');
    await A.waitForSelector('.client-person:has-text("client@client-e2e.test"):has-text("Access revoked")');
    await B.click('[data-action="refresh"]'); await B.waitForSelector('text=No client projects are shared with you yet.');
    assert.equal(await B.locator('.client-item').count(), 0);
    assert.equal(await B.evaluate((url) => fetch(url).then((r) => r.status), contentUrl), 404, 'revoked guest cannot reuse the download link');
    await C.click('[data-action="signout"]'); await C.waitForURL('**/signin');
    assert.equal(await C.evaluate(() => fetch('/api/account').then((r) => r.status)), 401);
    assert.deepEqual(errors, [], 'real UI round trip has no browser errors');
  } finally {
    await browser?.close(); hub.proc.kill('SIGTERM');
    await until(() => hub.proc.exitCode != null || hub.proc.signalCode != null, { what: 'hub exit', timeout: 10000 }).catch(() => hub.proc.kill('SIGKILL'));
    rm(root);
  }
});
