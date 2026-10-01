// Actual browser navigation/cookies/UI against the real local accounts hub.
// Only provider consent/token endpoints are synthetic; no real OAuth app,
// account, mailer or Electron process is used.
const { test, expect, chromium } = require('@playwright/test');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');

test('browser Google/GitHub sign-in, team/client invitations and provider-only status are real round trips', async () => {
  const { startAccounts } = await import('../board/hub/test/accounts-helpers.js');
  const { fakeClients, fakeProviders, s256 } = await import('../board/hub/test/fake-oauth.js');
  const { fakeClock } = await import('../board/hub/test/helpers.js');
  const desktop = fakeClients(), web = fakeClients();
  const clients = { ...desktop, googleWebClientId: web.googleClientId, googleWebClientSecret: web.googleClientSecret, githubWebClientId: web.githubClientId, githubWebClientSecret: web.githubClientSecret };
  const clock = fakeClock(); const providers = fakeProviders({ clock, clients });
  const hub = await startAccounts({ clock, mailer: null, fetchImpl: providers.fetch, config: { ...clients, publicUrl: 'http://127.0.0.1', webDir: path.resolve(__dirname, '../board/web') } });
  // Assigned loopback port is a fixture's trusted configured callback origin.
  hub.hub.config.publicUrl = hub.base;
  let browser;
  try {
    const verifier = randomBytes(32).toString('base64url');
    const begin = await hub.call('POST', '/api/auth/oauth/start', { body: { provider: 'google', client: 'buddy_desktop', code_challenge: s256(verifier), redirect_uri: 'http://127.0.0.1:5555/callback' } });
    const a = providers.authorize(begin.body.url, { sub: 'browser-owner', email: 'alice@dev.local', hd: 'dev.local', name: 'Staff' });
    const owner = await hub.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: begin.body.flow_id, code: a.code, state: a.state, code_verifier: verifier } });
    expect(owner.status, owner.text).toBe(200);
    const staff = async (method, url, body) => { const r = await hub.call(method, url, { token: owner.body.device_token, body }); expect(r.status, r.text).toBe(200); return r.body; };
    const ordinary = await staff('POST', `/api/teams/${hub.ids.org}/invites`, { email: 'member@gmail.com', role: 'member', request_id: randomUUID() });
    const made = await staff('POST', '/api/client-workspaces', { name: 'Browser client', request_id: randomUUID() });
    const project = made.projects[0];
    const card = await staff('POST', `/api/boards/${project.board_id}/cards`, { title: 'Private staff repository details' });
    await staff('POST', `/api/boards/${project.board_id}/client-items`, { card_id: card.card.id, title: 'Browser delivery', summary: 'Ready for review', status: 'review' });
    const invite = await staff('POST', `/api/teams/${made.workspace.id}/client-invites`, { email: 'client@gmail.com', grants: [{ project_id: project.id, scopes: ['status.read'] }], request_id: randomUUID() });
    const deviceCount = hub.db.get('SELECT COUNT(*) n FROM user_devices').n;
    browser = await chromium.launch({ channel: 'chrome' });
    const signin = async (provider, who, fragment = '') => {
      const context = await browser.newContext(); const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('https://accounts.google.com/o/oauth2/v2/auth**', async route => {
        const authorization = providers.authorize(route.request().url(), who);
        const callback = new URL(new URL(route.request().url()).searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({ state: authorization.state, code: authorization.code }).toString();
        await route.fulfill({ status: 302, headers: { location: callback.href } });
      });
      await page.route('https://github.com/login/oauth/authorize**', async route => {
        const authorization = providers.authorize(route.request().url(), who);
        const callback = new URL(new URL(route.request().url()).searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({ state: authorization.state, code: authorization.code }).toString();
        await route.fulfill({ status: 302, headers: { location: callback.href } });
      });
      await page.goto(`${hub.base}/signin${fragment}`);
      await expect(page.locator('#email-form')).toBeHidden();
      await expect(page.getByRole('button', { name: provider === 'google' ? 'Sign in with Google' : 'Continue with GitHub' })).toBeVisible();
      await page.getByRole('button', { name: provider === 'google' ? 'Sign in with Google' : 'Continue with GitHub' }).click();
      await expect.poll(() => page.url().startsWith(hub.base + '/') && !page.url().includes('/signin')).toBe(true);
      expect(errors).toEqual([]);
      const account = await page.evaluate(async () => (await fetch('/api/account')).json());
      const cookies = await context.cookies();
      expect(cookies.find(c => c.name === '__Host-buddy_session')).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
      expect(cookies.some(c => c.name === '__Host-plexiform_oauth')).toBe(false);
      expect(await page.evaluate(() => document.cookie)).not.toMatch(/__Host-(buddy_session|plexiform_oauth)/);
      expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toMatchObject({ session: [] });
      return { context, page, account };
    };
    const member = await signin('google', { sub: 'browser-member', email: 'member@gmail.com', name: 'Member' }, `#invite=${ordinary.link.split('#')[1]}`);
    expect(member.account.teams.map(t => t.id)).toContain(hub.ids.org);
    expect(new URL(member.page.url()).searchParams.get('org')).toBe(hub.ids.org);
    await member.context.close();
    const guest = await signin('google', { sub: 'browser-guest', email: 'client@gmail.com', name: 'Client' }, `#client_invite=${invite.link.split('#')[1]}`);
    await expect(guest.page).toHaveURL(new RegExp(`/clients\\?workspace=${made.workspace.id}`));
    await expect(guest.page.locator('.client-item')).toContainText('Browser delivery');
    await expect(guest.page.locator('body')).not.toContainText('Private staff repository details');
    expect(guest.account.teams).toHaveLength(0);
    expect(hub.db.get('SELECT COUNT(*) n FROM members WHERE user_id = ?', guest.account.user.id).n).toBe(0);
    await guest.context.close();
    const returning = await signin('google', { sub: 'browser-guest', email: 'client@gmail.com', name: 'Client' });
    await expect(returning.page).toHaveURL(new RegExp(`/clients\\?workspace=${made.workspace.id}`));
    await expect(returning.page.locator('.client-item')).toContainText('Browser delivery');
    await returning.context.close();
    const octo = await signin('github', { id: 96543, login: 'web-octo', email: 'octo@example.test', name: 'Octo' });
    expect(octo.account.identities).toContainEqual({ provider: 'github' });
    await octo.context.close();
    const wrong = await staff('POST', `/api/teams/${made.workspace.id}/client-invites`, { email: 'wrong-target@gmail.com', grants: [{ project_id: project.id, scopes: ['status.read'] }], request_id: randomUUID() });
    const beforeWrong = hub.db.get('SELECT COUNT(*) n FROM orgs').n;
    const recovery = await signin('google', { sub: 'browser-wrong', email: 'other-client@gmail.com', name: 'Other client' }, `#client_invite=${wrong.link.split('#')[1]}`);
    await expect(recovery.page).toHaveURL(`${hub.base}/client-invite`);
    await expect(recovery.page.getByRole('heading')).toHaveText('Join Browser client');
    await recovery.page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(recovery.page.locator('#client-invite-lead')).toContainText('sign in with the invited address');
    expect(hub.db.get('SELECT accepted_at FROM client_invites WHERE id = ?', wrong.invite.id).accepted_at).toBeNull();
    expect(recovery.account.teams).toHaveLength(0);
    expect(hub.db.get('SELECT COUNT(*) n FROM orgs').n).toBe(beforeWrong);
    await recovery.context.close();
    // With one web client absent, its button remains hidden even though the
    // shared .btn rule assigns display and native credentials still exist.
    hub.hub.config.githubWebClientSecret = null;
    const availability = await browser.newContext(); const availablePage = await availability.newPage();
    await availablePage.goto(`${hub.base}/signin`);
    await expect(availablePage.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await expect(availablePage.locator('#github-signin')).toBeHidden();
    await expect(availablePage.locator('#email-form')).toBeHidden();
    await availability.close();
    expect(hub.db.get('SELECT COUNT(*) n FROM user_devices').n).toBe(deviceCount);
    expect(hub.db.get('SELECT COUNT(*) n FROM runner_enrollments').n).toBe(0);
  } finally { if (browser) await browser.close(); await hub.close(); }
});

test('a slow real methods response cannot reopen provider/email controls after requesting a code', async () => {
  const { startAccounts } = await import('../board/hub/test/accounts-helpers.js');
  const { fakeClients } = await import('../board/hub/test/fake-oauth.js');
  const clients = fakeClients();
  const hub = await startAccounts({ config: { googleWebClientId: clients.googleClientId, googleWebClientSecret: clients.googleClientSecret,
    githubWebClientId: clients.githubClientId, githubWebClientSecret: clients.githubClientSecret, publicUrl: 'http://127.0.0.1', webDir: path.resolve(__dirname, '../board/web') } });
  hub.hub.config.publicUrl = hub.base;
  let browser, release;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
    const context = await browser.newContext(), page = await context.newPage();
    let methodReady;
    const ready = new Promise(resolve => { methodReady = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/auth/methods', async route => {
      const response = await route.fetch(); methodReady(); await gate; await route.fulfill({ response });
    });
    await page.goto(`${hub.base}/signin`); await ready;
    await page.locator('#email').fill('slow-methods@example.test');
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(page.locator('#code-form')).toBeVisible();
    const lead = await page.locator('#signin-lead').textContent();
    const answered = page.waitForResponse(r => r.url().endsWith('/api/auth/methods'));
    release(); await answered;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#email-form')).toBeHidden();
    await expect(page.locator('#oauth-options')).toBeHidden();
    await expect(page.locator('#code-form')).toBeVisible();
    await expect(page.locator('#signin-lead')).toHaveText(lead);
    expect(hub.db.get('SELECT COUNT(*) n FROM login_flows').n).toBe(1);
  } finally { release?.(); if (browser) await browser.close(); await hub.close(); }
});
