const { test, expect, _electron: electron } = require('@playwright/test');
const { windowByFile } = require('./app');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
// The calendar opens on today (week and month view), so plans are dated from this week's Monday and
// every day the test shows or drops on stays inside this week, which is always in the month grid.
const day = (n) => { const t = new Date(); const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7) + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });

async function launchPlannerApp(f, temp) {
  const home = path.join(temp, 'signals'), backups = path.join(temp, 'backups'), projects = path.join(temp, 'projects');
  for (const dir of [home, backups, projects, path.join(home, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.help-shown'), '2000-01-01T00:00:00.000Z');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ lowPower: 'off', roam: false, randomEvents: false, seasonal: false, hints: { teamSeen: true } }));
  const u = f.users.amember;
  const app = await electron.launch({ args: [path.join(__dirname, 'planner-fixture-main.js'), '-ApplePersistenceIgnoreState', 'YES', '--demo', 'visual', '--buddy-mock-accounts', '--buddy', 'account'], env: { ...process.env,
    CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_BACKUPS: backups, CLAUDE_TRAFFIC_LIGHT_PROJECTS: projects,
    CLAUDE_TRAFFIC_LIGHT_PORT: String(await port()), CLAUDE_TRAFFIC_LIGHT_REMOTE_PORT: String(await port()),
    PLEXIFORM_PLANNER_TEST_HUB: f.h.base, PLEXIFORM_PLANNER_TEST_ACCOUNT: JSON.stringify({ hub: f.h.base, token: u.token, device_id: u.device_id, user: { id: u.id, email: u.email } }) } });
  const profile = await app.evaluate(({ app }) => app.getPath('userData'));
  expect(profile).toContain('plexiform-dev-'); expect(profile).not.toContain('/Library/Application Support');
  const account = await windowByFile(app, 'account.html');
  await account.evaluate(() => window.buddyAccount.go('hub'));
  await account.locator('input[name="url"]').fill(f.h.base);
  await account.getByRole('button', { name: 'Continue', exact: true }).click();
  const sidebar = await windowByFile(app, 'sidebar.html');
  await expect(sidebar.locator('body')).toContainText('Alpha', { timeout: 15000 });
  return { app, sidebar, profile };
}

test('actual main My day opens own work and Calendar/Timeline persist real plans with safe current scope', async () => {
  test.setTimeout(90000);
  const { tenancy } = await import('../board/hub/test/tenancy/fixture.js');
  const f = await tenancy({ config: { webDir: path.resolve(__dirname, '../board/web') } });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-planner-ui-'));
  let app;
  try {
    const u = f.users.amember;
    const own = await f.as(u, 'POST', `/api/boards/${f.A.board}/cards`, { title: 'Synthetic own planner work', repo_id: f.A.repo });
    expect(own.status).toBe(200); const id = own.body.card.id;
    const predecessor = await f.as(u, 'POST', `/api/boards/${f.A.board}/cards`, { title: 'Synthetic planner predecessor', repo_id: f.A.repo });
    expect(predecessor.status).toBe(200); const predecessorId = predecessor.body.card.id;
    const predecessorPlan = await f.as(u, 'PATCH', `/api/cards/${predecessorId}/planning`, { request_id: randomUUID(), version: predecessor.body.card.version, start_date: day(-6), due_date: day(-4) });
    expect(predecessorPlan.status).toBe(200);
    const beforeRuns = f.db.get('SELECT COUNT(*) n FROM dispatches').n;
    const launched = await launchPlannerApp(f, temp); app = launched.app;
    const sidebar = launched.sidebar;
    await sidebar.evaluate(() => window.buddy.select('myday'));
    const myday = await windowByFile(app, 'myday.html');
    await expect(myday.getByRole('button', { name: `${own.body.card.key} · Synthetic own planner work` })).toBeVisible();
    await expect(myday.locator('body')).not.toContainText('B-SECRET');
    await expect(myday.locator('body')).not.toContainText('Availability');
    // A real connection failure must remove the previous snapshot, then recover.
    const handlers = f.h.app.server.listeners('request');
    const unavailable = (request, response) => {
      if (request.url === '/api/my-day') { request.destroy(); return; }
      for (const handler of handlers) handler.call(f.h.app.server, request, response);
    };
    f.h.app.server.removeAllListeners('request');
    f.h.app.server.on('request', unavailable);
    try {
      await myday.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(myday.locator('body')).toContainText('Current work is unavailable');
      await expect(myday.locator('body')).not.toContainText('Synthetic own planner work');
    } finally {
      f.h.app.server.removeListener('request', unavailable);
      for (const handler of handlers) f.h.app.server.on('request', handler);
    }
    await myday.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(myday.getByRole('button', { name: `${own.body.card.key} · Synthetic own planner work` })).toBeVisible();
    await myday.getByRole('button', { name: `${own.body.card.key} · Synthetic own planner work` }).click();
    // executeJavaScript on a page that navigates before it answers never settles, and the board pane navigates right here
    // (the card opens, the Calendar loads): a poll that landed on such a call sat out its whole timeout with the
    // right #card hash already showing. Each probe is bounded, so the poll asks again.
    const pane = code => Promise.race([app.evaluate(async ({ webContents }, [origin, js]) => {
      const page = webContents.getAllWebContents().find(w => w.getURL().startsWith(`${origin}/?`));
      return page ? page.executeJavaScript(js, true) : null;
    }, [f.h.base, code]), new Promise(resolve => setTimeout(() => resolve(null), 2500))]);
    await expect.poll(() => pane('location.hash'), { timeout: 15000 }).toBe(`#card=${id}`);
    await sidebar.evaluate(() => window.buddy.select('board:calendar'));
    await expect.poll(() => pane("document.querySelector('.calendar-grid')?.getAttribute('aria-label')"), { timeout: 15000 }).toBe('month calendar');
    await expect.poll(() => pane(`!!document.querySelector('[data-action="planning-edit"][data-card="${id}"]')`)).toBe(true);
    await pane(`document.querySelector('[data-action="planning-edit"][data-card="${id}"]').click()`);
    await expect.poll(() => pane("document.querySelector('.planning-editor h2')?.textContent")).toBe(`Plan ${own.body.card.key}`);
    await pane(`(() => { const form = document.querySelector('[data-form="planning-card"]'); form.elements.start.value = '${day(1)}'; form.elements.due.value = '${day(3)}'; form.elements.dependencies.querySelector('[value="${predecessorId}"]').selected = true; form.requestSubmit(); })()`);
    await expect.poll(() => f.h.hub.card(id).due_date).toBe(day(3));
    expect(f.db.all('SELECT depends_on_card_id FROM card_dependencies WHERE card_id=?', id).map(row => row.depends_on_card_id)).toEqual([predecessorId]);
    await pane(`document.querySelector('[data-change="planning-period"]').value='week'; document.querySelector('[data-change="planning-period"]').dispatchEvent(new Event('change',{bubbles:true}));`);
    await expect.poll(() => pane("document.querySelector('.calendar-grid')?.getAttribute('aria-label')")).toBe('week calendar');
    await pane(`document.querySelector('[data-planning-card="${id}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true}));`);
    await expect.poll(() => f.h.hub.card(id).due_date).toBe(day(4));
    expect(f.h.hub.card(id).start_date).toBe(day(2));
    await pane(`document.querySelector('[data-change="planning-period"]').value='month'; document.querySelector('[data-change="planning-period"]').dispatchEvent(new Event('change',{bubbles:true}));`);
    await expect.poll(() => pane("document.querySelector('.calendar-grid')?.getAttribute('aria-label')")).toBe('month calendar');
    const boardPage = app.windows().find(page => page.url().startsWith(`${f.h.base}/?`));
    expect(boardPage).toBeTruthy();
    // A real mouse drag in steps: dragTo's single jump does not start Chromium's
    // HTML5 drag session inside the embedded board view (no dragstart fires).
    // The real clock puts day(6) on the month's last row late in the month, below the fold: scroll it into view first.
    await boardPage.locator(`[data-planning-day="${day(6)}"]`).scrollIntoViewIfNeeded();
    { const a = await boardPage.locator(`[data-planning-card="${id}"]`).boundingBox(); const b = await boardPage.locator(`[data-planning-day="${day(6)}"]`).boundingBox();
      await boardPage.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await boardPage.mouse.down();
      await boardPage.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 5 }); await boardPage.mouse.move(b.x + b.width / 2, b.y + 30, { steps: 20 }); await boardPage.mouse.up(); }
    await expect.poll(() => f.h.hub.card(id).due_date).toBe(day(6));
    expect(f.h.hub.card(id).start_date).toBe(day(4));
    await boardPage.locator(`[data-action="planning-edit"][data-card="${predecessorId}"]`).click();
    await expect.poll(() => pane("document.querySelector('.planning-editor h2')?.textContent")).toBe(`Plan ${predecessor.body.card.key}`);
    await pane(`(() => { const form = document.querySelector('[data-form="planning-card"]'); form.elements.dependencies.querySelector('[value="${id}"]').selected = true; form.requestSubmit(); })()`);
    await expect.poll(() => pane("document.querySelector('.planning-editor [role=alert]')?.textContent")).toMatch(/cycl/i);
    expect(f.db.all('SELECT depends_on_card_id FROM card_dependencies WHERE card_id=?', predecessorId)).toEqual([]);
    await pane("document.querySelector('[data-action=planning-close]').click()");
    await sidebar.evaluate(() => window.buddy.select('board:timeline'));
    await expect.poll(() => pane("document.querySelector('.timeline-table')?.textContent")).toContain('Synthetic own planner work');
    await expect.poll(() => pane("document.querySelector('.timeline-table')?.textContent")).toContain(`${day(4)} → ${day(6)}`);
    await expect.poll(() => pane("document.querySelector('.planner-path')?.textContent")).toContain('Add a start and due date to every open card');
    const completeInitialPlan = await f.as(u, 'PATCH', `/api/cards/${f.A.card}/planning`, { request_id: randomUUID(), version: f.h.hub.card(f.A.card).version, start_date: day(-4), due_date: day(-4) });
    expect(completeInitialPlan.status).toBe(200);
    await pane('location.reload()');
    await expect.poll(() => pane("document.querySelector('.timeline-table')?.textContent"), { timeout: 15000 }).toContain(`${day(4)} → ${day(6)}`);
    await expect.poll(() => pane("document.querySelector('.planner-path')?.textContent")).toContain(`${predecessor.body.card.key} → ${own.body.card.key}`);
    expect(f.db.get('SELECT COUNT(*) n FROM dispatches').n).toBe(beforeRuns);
    f.db.run("UPDATE members SET role='viewer' WHERE id=?", f.A.member);
    await sidebar.evaluate(() => window.buddy.select('board:calendar'));
    await pane('location.reload()');
    await expect.poll(() => pane(`document.querySelector('[data-action="planning-edit"][data-card="${id}"]')?.disabled`), { timeout: 15000 }).toBe(true);
    f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?', f.h.hub.iso(), u.device_id);
    await sidebar.evaluate(() => window.buddy.select('myday'));
    const current = await windowByFile(app, 'myday.html');
    await current.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(current.locator('body')).toContainText('Current work is unavailable');
    await expect(current.locator('body')).not.toContainText('Synthetic own planner work');
    await expect(current.locator('body')).not.toContainText(u.token);
  } finally { await app?.close(); await f.h.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('actual account sign-out clears My day work and stored account capability', async () => {
  const { tenancy } = await import('../board/hub/test/tenancy/fixture.js');
  const f = await tenancy({ config: { webDir: path.resolve(__dirname, '../board/web') } });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-myday-signout-'));
  let app;
  try {
    const u = f.users.amember;
    const own = await f.as(u, 'POST', `/api/boards/${f.A.board}/cards`, { title: 'Synthetic work before explicit sign-out', repo_id: f.A.repo });
    expect(own.status).toBe(200);
    const launched = await launchPlannerApp(f, temp); app = launched.app;
    await launched.sidebar.evaluate(() => window.buddy.select('myday'));
    const myday = await windowByFile(app, 'myday.html');
    await expect(myday.locator('body')).toContainText('Synthetic work before explicit sign-out');
    await launched.sidebar.evaluate(() => window.buddy.select('account'));
    const account = await windowByFile(app, 'account.html');
    await account.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(account.locator('body')).toContainText('Signed out of');
    await expect.poll(() => f.db.get('SELECT revoked_at FROM user_devices WHERE id=?', u.device_id)?.revoked_at).toBeTruthy();
    const { hubKey } = require('../buddy-window/workspaces');
    expect(fs.existsSync(path.join(launched.profile, 'buddy-accounts', `${hubKey(f.h.base)}.bin`))).toBe(false);
    await launched.sidebar.evaluate(() => window.buddy.select('myday'));
    await myday.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(myday.locator('body')).not.toContainText('Synthetic work before explicit sign-out');
    await expect(myday.locator('body')).not.toContainText(u.token);
  } finally { await app?.close(); await f.h.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
