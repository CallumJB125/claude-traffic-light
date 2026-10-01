// Accounts mode in a real browser (installed Chrome through Playwright;
// skipped without either), against the real hub process as a loopback
// try-out with the console mailer: codes are read from the hub's log.
// A new person signs in with an email code (one wrong code first: the page
// says how many tries are left), gets "Create or join a team", creates one,
// lands on its board and makes an invite from the Team view. A second person
// opens that invite link signed out, signs in by code from the invite page
// and joins, ending on the same team's board. The owner, signing in again
// elsewhere, goes straight to the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, startHub, until, tmpDir, rm } from './harness.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* optional */ }

function codeFrom(logFile, email, after = 0) {
  const text = fs.readFileSync(logFile, 'utf8');
  const all = [...text.matchAll(/To: (\S+)\nSubject: (\d{6}) is your \S+ sign-in code\n/g)].filter((m) => m[1] === email);
  return all.length > after ? all[all.length - 1][2] : null;
}

async function signInByCode(page, hub, email) {
  await page.fill('#email', email);
  await page.click('#email-form button[type="submit"]');
  await page.waitForSelector('#code-form:not([hidden])');
  return until(() => codeFrom(hub.logFile, email), { what: `code for ${email}` });
}

test('web, accounts mode: email code → create a team → its board → invite; a second person joins from the link', { skip: !chromium && 'playwright not installed' }, async () => {
  const root = tmpDir('bW-');
  const dataDir = path.join(root, 'hub');
  fs.mkdirSync(dataDir);
  const port = await freePort();
  const hub = await startHub({ dataDir, port, env: { BOARD_AUTH: 'accounts', BOARD_SIGNUP: 'open', BOARD_DEV_SEED: '', BOARD_DEV_LOGIN_SECRET: '', BOARD_ACCOUNTS_DEV: '1', BOARD_CONSOLE_MAILER: '1' } });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const A = await (await browser.newContext({ baseURL: hub.url })).newPage();
    await A.goto('/');
    await A.click('a[href="/signin"]');
    const code = await signInByCode(A, hub, 'owner@e2e.test');
    assert.equal(await A.textContent('#signin-lead'), 'We’ve asked for a 6-digit code to be sent to owner@e2e.test. It works for 10 minutes.');
    await A.fill('#code', code === '000000' ? '000001' : '000000');
    await A.click('#code-form button[type="submit"]');
    await A.waitForSelector('#signin-error:not([hidden])');
    assert.equal(await A.textContent('#signin-error'), 'That code isn’t right. 4 tries left.');
    await A.fill('#code', code);
    await A.click('#code-form button[type="submit"]');
    await A.waitForSelector('text=Create or join a team');
    assert.equal(await A.locator('text=isn\'t a member').count(), 0);

    await A.fill('#team-name', 'Rocket Crew');
    await A.click('form[data-form="create-team"] button[type="submit"]');
    await A.waitForSelector('.brand-board:has-text("Rocket Crew")');
    await A.waitForSelector('.column-empty');
    await A.click('.topbar [data-view="team"]');
    await A.fill('#invite-email', 'joiner@e2e.test');
    await A.click('form[data-form="team-invite"] button[type="submit"]');
    await A.waitForSelector('.team-invite-made');
    const link = await A.inputValue('[aria-label="Invite link"]');
    assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/invite#inv_[A-Za-z0-9_-]{43}$/);
    assert.match(await A.textContent('.team-invite-code'), /^[A-Z]{4}-[A-Z]{4}$/);

    const ctxB = await browser.newContext({ baseURL: hub.url });
    let B = await ctxB.newPage();
    // The page tries plexiform:// first; with no app to take it Chrome aborts that navigation.
    const triedApp = B.waitForEvent('requestfailed', { predicate: (r) => r.url().startsWith('plexiform://'), timeout: 15000 });
    await B.goto(link);
    await B.waitForSelector('#join-web:not([hidden])');
    await triedApp;
    assert.equal(await B.textContent('#join-web'), 'Join in your browser');
    // Headless Chrome keeps an invisible "open this app?" prompt over the tab after the plexiform://
    // attempt, which swallows mouse and keyboard input there: click with the DOM, then carry on in a
    // fresh tab at the address that click went to (the token rides in its fragment).
    await B.$eval('#join-web', (b) => b.click());
    await B.waitForURL((u) => u.pathname === '/signin');
    const to = `/signin#invite=${link.split('#')[1]}`;
    await B.close();
    B = await ctxB.newPage();
    await B.goto(to);
    await B.waitForSelector('text=Sign in to accept your invite');
    assert.equal(new URL(B.url()).hash, '', 'the token left the address bar');
    const code2 = await signInByCode(B, hub, 'joiner@e2e.test');
    await B.fill('#code', code2);
    await B.click('#code-form button[type="submit"]');
    await B.waitForSelector('#join-web:has-text("Join Rocket Crew")');
    await B.click('#join-web');
    await B.waitForSelector('.brand-board:has-text("Rocket Crew")');
    assert.match(B.url(), /\/\?org=/);

    // Returning: the owner signs in on another browser and goes straight to the board.
    const C = await (await browser.newContext({ baseURL: hub.url })).newPage();
    await C.goto('/signin');
    await C.fill('#email', 'owner@e2e.test');
    await C.click('#email-form button[type="submit"]');
    await C.waitForSelector('#code-form:not([hidden])');
    await C.fill('#code', await until(() => codeFrom(hub.logFile, 'owner@e2e.test', 1), { what: 'second code' }));
    await C.click('#code-form button[type="submit"]');
    await C.waitForSelector('.brand-board:has-text("Rocket Crew")');
    assert.equal(await C.locator('text=Create or join a team').count(), 0);
  } finally {
    await browser?.close();
    hub.proc.kill('SIGTERM');
    await until(() => hub.proc.exitCode != null || hub.proc.signalCode != null, { what: 'hub exit', timeout: 10000 }).catch(() => hub.proc.kill('SIGKILL'));
    rm(root);
  }
});
