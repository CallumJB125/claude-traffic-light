// Actual OAuth guest credential + no-mailer hub, actual Electron client pane.
// No production identities, provider network, CLI or model processes.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

test('OAuth client without a mailer accepts and reads status in the scoped authenticated sandboxed app view', async () => {
  const { startAccounts } = await import('../board/hub/test/accounts-helpers.js');
  const { fakeClock } = await import('../board/hub/test/helpers.js');
  const { fakeClients, fakeProviders, s256 } = await import('../board/hub/test/fake-oauth.js');
  const clock = fakeClock(), clients = fakeClients(), provider = fakeProviders({ clock, clients });
  const hub = await startAccounts({ clock, mailer: null, fetchImpl: provider.fetch, config: { ...clients, webDir: path.resolve(__dirname, '../board/web') } });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-client-app-'));
  let app;
  try {
    const oauth = async (email, sub) => {
      const verifier = randomBytes(32).toString('base64url');
      const started = await hub.call('POST', '/api/auth/oauth/start', { body: { provider: 'google', client: 'buddy_desktop', redirect_uri: 'http://127.0.0.1:53682/callback', code_challenge: s256(verifier) } });
      expect(started.status).toBe(200);
      const auth = provider.authorize(started.body.url, { email, sub, hd: 'dev.local' });
      const answer = await hub.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: started.body.flow_id, code: auth.code, state: auth.state, code_verifier: verifier } });
      expect(answer.status, answer.text).toBe(200); return answer.body;
    };
    const owner = await oauth('alice@dev.local', 'fake-client-staff');
    const as = async (method, url, body) => { const r = await hub.call(method, url, { token: owner.device_token, body }); expect(r.status, r.text).toBe(200); return r.body; };
    const made = await as('POST', '/api/client-workspaces', { name: 'Client app project', request_id: randomUUID() });
    const project = made.projects[0];
    const card = await as('POST', `/api/boards/${project.board_id}/cards`, { title: 'Internal repository details' });
    await as('POST', `/api/boards/${project.board_id}/client-items`, { card_id: card.card.id, title: 'Published delivery', summary: 'Ready for review', status: 'review' });
    await as('POST', `/api/teams/${made.workspace.id}/client-invites`, { email: 'client@gmail.com', grants: [{ project_id: project.id, scopes: ['status.read'] }] });
    const guest = await oauth('client@gmail.com', 'fake-client-guest');
    expect((await hub.call('GET', '/api/auth/methods')).body.email).toBe(false);
    app = await electron.launch({ args: [path.join(__dirname, 'clients-fixture-main.js'), `--user-data-dir=${temp}`], env: { ...process.env, PLEXIFORM_CLIENT_TEST_HUB: hub.base, PLEXIFORM_CLIENT_TEST_ACCOUNT: JSON.stringify({ hub: hub.base, token: guest.device_token, device_id: guest.device_id, user: guest.user }) } });
    await expect.poll(() => app.evaluate(() => global.__clientTestInit), { timeout: 15000 }).toMatchObject({ stage: 'connected', result: { ok: true }, status: { screen: 'clients' } });
    await expect.poll(() => app.windows().some((p) => p.url().includes('account.html?screen=clients')), { timeout: 15000 }).toBe(true);
    const account = app.windows().find((p) => p.url().includes('account.html?screen=clients'));
    await account.locator('button:has-text("Open client projects")').click();
    await expect.poll(() => app.windows().some((p) => p.url().startsWith(`${hub.base}/clients`))).toBe(true);
    const portal = app.windows().find((p) => p.url().startsWith(`${hub.base}/clients`));
    await portal.locator('[data-action="accept"]').click();
    await expect(portal.locator('.client-item')).toContainText('Published delivery');
    expect(await portal.locator('form[data-form="publish"], form[data-form="workspace"]').count()).toBe(0);
    expect(await portal.locator('text=Internal repository details').count()).toBe(0);
    expect((await hub.call('GET', '/api/account', { token: guest.device_token })).body.teams).toHaveLength(0);
    expect(hub.db.get('SELECT COUNT(*) n FROM runner_enrollments').n).toBe(0);
    const prefs = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes('/clients')).getLastWebPreferences());
    expect(prefs.sandbox).toBe(true); expect(prefs.contextIsolation).toBe(true); expect(prefs.nodeIntegration).toBe(false); expect(prefs.preload ?? '').toBe('');
    const renderer = await portal.evaluate(() => ({ bridge: typeof window.buddyAccount, token: [document.cookie, localStorage.getItem('token'), sessionStorage.getItem('token')].join(' ') }));
    expect(renderer.bridge).toBe('undefined'); expect(renderer.token).not.toContain(guest.device_token);
    await portal.locator('[data-action="signout"]').click();
    await expect.poll(async () => (await hub.call('GET', `/api/client/projects/${project.id}`, { token: guest.device_token })).status).toBe(401);
    await expect.poll(() => fs.readdirSync(path.join(temp, 'buddy-accounts')).length).toBe(0);
  } finally { await app?.close(); await hub.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
