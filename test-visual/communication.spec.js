// Real accounts hub, enrolled protocol fixtures and the production sandboxed
// Electron board pane. No provider models or user account files are touched.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('desktop task context and messages use the actual authenticated board pane', async () => {
  const { communicationRig } = await import('../board/hub/test/communication-helpers.js');
  const cleanup = [], x = await communicationRig({ after: (fn) => cleanup.push(fn) }, { config: { webDir: path.resolve(__dirname, '../board/web') } });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-communication-app-'));
  let app;
  try {
    const user = x.users.amember;
    app = await electron.launch({ args: [path.join(__dirname, 'clients-fixture-main.js'), `--user-data-dir=${temp}`], env: { ...process.env,
      PLEXIFORM_CLIENT_TEST_HUB: x.h.base, PLEXIFORM_CLIENT_TEST_ACCOUNT: JSON.stringify({ hub: x.h.base, token: user.token, device_id: user.device_id, user: { id: user.id, email: user.email } }) } });
    await expect.poll(() => app.evaluate(() => global.__clientTestInit), { timeout: 15000 }).toMatchObject({ stage: 'connected', result: { ok: true } });
    await app.evaluate(() => global.__clientTestBuddy.open('board'));
    const pane = (code) => app.evaluate(async ({ webContents }, [origin, js]) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(`${origin}/?`));
      return wc ? { found: true, value: await wc.executeJavaScript(js, true) } : { found: false, urls: webContents.getAllWebContents().map((w) => w.getURL()) };
    }, [x.h.base, code]);
    await expect.poll(() => pane(`!!document.querySelector('.card[data-card-id="${x.sender.run.card_id}"] .card-open')`), { timeout: 15000 }).toMatchObject({ found: true, value: true });
    await pane(`document.querySelector('.card[data-card-id="${x.sender.run.card_id}"] .card-open').click()`);
    await expect.poll(() => pane('!!document.querySelector("#tab-packet")')).toMatchObject({ value: true });
    await pane('document.querySelector("#tab-packet").click()');
    await expect.poll(() => pane('!!document.querySelector("[data-form=task-packet]")')).toMatchObject({ value: true });
    await pane('const input = document.querySelector("#packet-brief"); input.value = "Native desktop durable context"; input.dispatchEvent(new Event("input", {bubbles:true})); document.querySelector("[data-form=task-packet]").requestSubmit()');
    await expect.poll(() => x.h.db.get('SELECT version FROM task_packets WHERE card_id = ?', x.sender.run.card_id)?.version).toBe(1);
    await pane('document.querySelector("#tab-messages").click()');
    await expect.poll(() => pane('!!document.querySelector("[data-form=task-message]")')).toMatchObject({ value: true });
    await pane(`const recipient = document.querySelector("#message-peer"); recipient.value = ${JSON.stringify(x.recipient.run.run_id)}; recipient.dispatchEvent(new Event("input", {bubbles:true})); const body = document.querySelector("#message-body"); body.value = "Please review the desktop context"; body.dispatchEvent(new Event("input", {bubbles:true})); document.querySelector("[data-form=task-message]").requestSubmit()`);
    await expect.poll(() => x.h.db.get('SELECT body FROM task_messages WHERE card_id = ?', x.sender.run.card_id)?.body).toBe('Please review the desktop context');
    await expect.poll(() => pane('document.querySelector(".task-messages")?.textContent ?? ""')).toMatchObject({ value: expect.stringContaining('Pending') });
    const preference = await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(`${origin}/?`)).getLastWebPreferences(), x.h.base);
    expect(preference.sandbox).toBe(true); expect(preference.contextIsolation).toBe(true); expect(preference.nodeIntegration).toBe(false); expect(preference.preload ?? '').toBe('');
    const surface = (await pane('({ require: typeof require, credentials: [document.cookie, localStorage.getItem("token"), sessionStorage.getItem("token")].join(" ") })')).value;
    expect(surface.require).toBe('undefined'); expect(surface.credentials).not.toContain(user.token);
    const row = x.h.db.get('SELECT * FROM task_messages WHERE card_id = ?', x.sender.run.card_id);
    expect(row.provider).toBeNull(); expect(row.author_run_id).toBeNull(); expect(x.h.db.get('SELECT for_agent FROM comments WHERE id = ?', row.comment_id).for_agent).toBe(0);
    expect(x.recipient.client.all('comment.deliver')).toHaveLength(0);
  } finally { await app?.close(); for (const fn of cleanup.reverse()) await fn(); fs.rmSync(temp, { recursive: true, force: true }); }
});
