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
    const published = await as('POST', `/api/boards/${project.board_id}/client-items`, { card_id: card.card.id, title: 'Published delivery', summary: 'Ready for review', status: 'review' });
    await as('POST', `/api/client-items/${published.item.id}/artifacts`, { request_id: randomUUID(), name: 'desktop.txt', mime: 'text/plain', data_base64: Buffer.from('Exact native client deliverable').toString('base64') });
    await as('PATCH', `/api/boards/${project.board_id}/client-feedback-intake`, { enabled: true });
    await as('POST', `/api/teams/${made.workspace.id}/client-invites`, { email: 'client@gmail.com', grants: [{ project_id: project.id, scopes: ['status.read', 'artifacts.read', 'feedback.create'] }] });
    const guest = await oauth('client@gmail.com', 'fake-client-guest');
    expect((await hub.call('GET', '/api/auth/methods')).body.email).toBe(false);
    const savedArtifact = path.join(temp, 'saved-deliverable.txt');
    app = await electron.launch({ args: [path.join(__dirname, 'clients-fixture-main.js'), `--user-data-dir=${temp}`], env: { ...process.env, PLEXIFORM_CLIENT_TEST_HUB: hub.base, PLEXIFORM_CLIENT_TEST_DOWNLOAD: savedArtifact, PLEXIFORM_CLIENT_TEST_ACCOUNT: JSON.stringify({ hub: hub.base, token: guest.device_token, device_id: guest.device_id, user: guest.user }) } });
    await expect.poll(() => app.evaluate(() => global.__clientTestInit), { timeout: 15000 }).toMatchObject({ stage: 'connected', result: { ok: true }, status: { screen: 'clients' } });
    // BaseWindow's WebContentsViews are not Electron BrowserWindows. Follow
    // the actual production view rather than adding a window just for tests.
    const pane = (match, js) => app.evaluate(async ({ webContents }, [url, code]) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(url));
      return wc ? { found: true, value: await wc.executeJavaScript(code, true) } : { found: false, urls: webContents.getAllWebContents().map((w) => w.getURL()), status: global.__clientTestBuddy.status(), loads: global.__clientTestLoads };
    }, [match, js]);
    await expect.poll(() => pane('account.html?screen=clients', '!![...document.querySelectorAll("button")].find(b => b.textContent === "Open client projects")'), { timeout: 15000 }).toEqual({ found: true, value: true });
    await pane('account.html?screen=clients', '[...document.querySelectorAll("button")].find(b => b.textContent === "Open client projects").click()');
    const portal = (js) => pane(`${hub.base}/clients`, js);
    await expect.poll(() => portal('!!document.querySelector("[data-action=accept]")'), { timeout: 15000 }).toEqual({ found: true, value: true });
    await portal('document.querySelector("[data-action=accept]").click()');
    await expect.poll(async () => (await portal('[...document.querySelectorAll(".client-item")].map(e => e.textContent).join(" ")')).value).toContain('Published delivery');
    expect((await portal('document.querySelectorAll("form[data-form=publish], form[data-form=workspace]").length')).value).toBe(0);
    expect((await portal('document.body.textContent.includes("Internal repository details")')).value).toBe(false);
    expect((await hub.call('GET', '/api/account', { token: guest.device_token })).body.teams).toHaveLength(0);
    expect(hub.db.get('SELECT COUNT(*) n FROM runner_enrollments').n).toBe(0);
    const prefs = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes('/clients')).getLastWebPreferences());
    expect(prefs.sandbox).toBe(true); expect(prefs.contextIsolation).toBe(true); expect(prefs.nodeIntegration).toBe(false); expect(prefs.preload ?? '').toBe('');
    const renderer = (await portal('({ bridge: typeof window.buddyAccount, token: [document.cookie, localStorage.getItem("token"), sessionStorage.getItem("token")].join(" ") })')).value;
    expect(renderer.bridge).toBe('undefined'); expect(renderer.token).not.toContain(guest.device_token);
    await portal('document.querySelector("a[data-artifact]").click()');
    await expect.poll(() => fs.existsSync(savedArtifact)).toBe(true);
    expect(fs.readFileSync(savedArtifact, 'utf8')).toBe('Exact native client deliverable');
    expect(await app.evaluate(() => global.__clientTestSaveDialogs)).toEqual([expect.objectContaining({ title: 'Save shared deliverable', defaultPath: 'deliverable-v1.txt' })]);
    await portal('document.querySelector("form[data-form=feedback] textarea").value = "Native client feedback"; document.querySelector("form[data-form=feedback] button[type=submit]").click()');
    await expect.poll(async () => (await portal('document.body.textContent')).value).toContain('Received for team triage through staff-authorized intake.');
    const feedback = hub.db.get('SELECT * FROM client_feedback');
    expect(feedback.message).toBe('Native client feedback'); expect(feedback.guest_id).toBe(hub.db.get('SELECT id FROM client_guests WHERE user_id = ?', guest.user.id).id);
    const task = hub.hub.card(feedback.card_id);
    expect(task.column_name).toBe('todo'); expect(task.repo_id).toBeNull(); expect(task.run_state).toBeNull(); expect(task.created_by).toBe(feedback.delegate_member_id);
    expect(hub.db.get('SELECT COUNT(*) n FROM dispatches').n).toBe(0);
    await portal('document.querySelector("a[href=\\"/api/account/client-export\\"]").click()');
    const savedExport = path.join(temp, 'client-export.json');
    await expect.poll(() => fs.existsSync(savedExport)).toBe(true);
    const exported = fs.readFileSync(savedExport, 'utf8');
    expect(JSON.parse(exported).projects[0].items[0].artifact.name).toBe('desktop.txt');
    expect(exported).not.toContain(guest.device_token); expect(exported).not.toContain('Internal repository details');
    expect(exported).toContain('Native client feedback'); expect(exported).not.toContain(task.id); expect(exported).not.toContain(feedback.delegate_member_id);
    expect(await app.evaluate(() => global.__clientTestSaveDialogs)).toHaveLength(2);
    await as('PATCH', `/api/boards/${project.board_id}/client-feedback-intake`, { enabled: false });
    await portal('document.querySelector("[data-action=refresh]").click()');
    await expect.poll(async () => (await portal('document.querySelectorAll("form[data-form=feedback]").length')).value).toBe(0);
    await portal('document.querySelector("[data-action=signout]").click()');
    await expect.poll(async () => (await hub.call('GET', `/api/client/projects/${project.id}`, { token: guest.device_token })).status).toBe(401);
    await expect.poll(() => fs.readdirSync(path.join(temp, 'buddy-accounts')).length).toBe(0);
  } finally { await app?.close(); await hub.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
