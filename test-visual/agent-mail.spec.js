'use strict';
// Agent mail through the actual main.js (planner-fixture-main.js) against a
// synthetic real accounts hub (board/hub/test/tenancy/fixture.js): A's AI asks
// over the local /team/mail endpoint, the ask is held until A presses Send on
// Running now, B (inbox preference on) answers it and A's AI reads the framed
// reply; a handoff is accepted only through main's native confirm showing the
// full packet, Cancel creates nothing, Confirm creates a Tasks task (the Local
// Tasks API mock) and A sees "accepted".
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { windowByFile } = require('./app');
const { startTasksMock } = require('./tasks-mock');

const port = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const v = s.address().port; s.close(() => resolve(v)); }); });

async function launch(f, u, temp, { config = {}, env = {} } = {}) {
  const home = path.join(temp, 'signals'), backups = path.join(temp, 'backups'), projects = path.join(temp, 'projects');
  for (const dir of [home, backups, projects, path.join(home, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.help-shown'), '2000-01-01T00:00:00.000Z');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roam: false, randomEvents: false, seasonal: false, hints: { teamSeen: true }, ...config }));
  const signalPort = await port();
  const app = await electron.launch({ args: [path.join(__dirname, 'planner-fixture-main.js'), '--demo', 'visual', '--buddy-mock-accounts', '--buddy', 'account'], env: { ...process.env,
    CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_BACKUPS: backups, CLAUDE_TRAFFIC_LIGHT_PROJECTS: projects,
    CLAUDE_TRAFFIC_LIGHT_PORT: String(signalPort), CLAUDE_TRAFFIC_LIGHT_REMOTE_PORT: String(await port()),
    PLEXIFORM_PLANNER_TEST_HUB: f.h.base, PLEXIFORM_PLANNER_TEST_ACCOUNT: JSON.stringify({ hub: f.h.base, token: u.token, device_id: u.device_id, user: { id: u.id, email: u.email } }), ...env } });
  const account = await windowByFile(app, 'account.html');
  await account.evaluate(() => window.buddyAccount.go('hub'));
  await account.locator('input[name="url"]').fill(f.h.base);
  await account.getByRole('button', { name: 'Continue', exact: true }).click();
  const sidebar = await windowByFile(app, 'sidebar.html');
  await expect(sidebar.locator('body')).toContainText('Alpha', { timeout: 15000 });
  await expect.poll(() => fs.existsSync(path.join(home, 'token'))).toBe(true);
  // What an AI's MCP tool sends: the same token-protected local endpoint (mcp-server.js mailCall).
  const mail = async (op, args) => (await fetch(`http://127.0.0.1:${signalPort}/team/mail`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-buddy-token': fs.readFileSync(path.join(home, 'token'), 'utf8') }, body: JSON.stringify({ op, args }) })).json();
  const sessions = async () => { await sidebar.evaluate(() => window.buddy.select('sessions')); return windowByFile(app, 'sessions.html'); };
  return { app, home, mail, sessions };
}

test('agent mail: a held ask is sent only on Send, answered by the teammate, and a handoff is accepted only after the full-packet confirm', async () => {
  test.setTimeout(180000);
  const { tenancy } = await import('../board/hub/test/tenancy/fixture.js');
  const f = await tenancy({ config: { webDir: path.resolve(__dirname, '../board/web') } });
  const tasks = await startTasksMock();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-agent-mail-'));
  // A folder whose remote is the repository team Alpha links (fixture: github.com/shared/app).
  const repo = path.join(temp, 'app');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/shared/app.git'], { cwd: repo });
  const asker = f.users.amember, teammate = f.users.aadmin;
  const state = (id) => f.db.get('SELECT state, handoff_state FROM msg_messages WHERE id = ?', id);
  let A, B;
  try {
    A = await launch(f, asker, path.join(temp, 'a'));

    // 1. A's AI asks: held on the hub, invisible to the teammate, waiting on A's Running now.
    const q = await A.mail('ask', { cwd: repo, to: teammate.id, question: 'Which env var holds the queue URL?', provider: 'claude', label: 'Claude in app' });
    expect(q, JSON.stringify(q)).toMatchObject({ status: 'waiting_for_your_ok' });
    expect(state(q.ask_id).state).toBe('held');
    expect(await A.mail('release', { id: q.ask_id })).toMatchObject({ reason: 'unknown_op' });
    const aPage = await A.sessions();
    const aMail = aPage.locator('#mail');
    await expect(aMail).toContainText('Your AI wants to ask', { timeout: 20000 });
    await expect(aMail).toContainText('(self-declared)');
    await expect(aMail.locator('textarea').first()).toHaveValue('Which env var holds the queue URL?');
    await aMail.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => state(q.ask_id).state).toBe('queued');

    // 2. B, with "Show my teammates' AI questions" on, answers it themselves.
    B = await launch(f, teammate, path.join(temp, 'b'), { config: { agentMailInbox: true }, env: { CLAUDE_TRAFFIC_LIGHT_TASKS_HOME: tasks.dir, CLAUDE_TRAFFIC_LIGHT_TASKS_PICK: repo } });
    await B.app.evaluate(({ dialog }) => {
      globalThis.__mail = { confirms: [], response: 0 };
      dialog.showMessageBox = async (_w, o) => { const opts = o || _w; globalThis.__mail.confirms.push(opts); return { response: globalThis.__mail.response }; };
    });
    const poke = () => B.app.evaluate(({ app }) => { app.emit('browser-window-focus'); });
    const bPage = await B.sessions();
    const bMail = bPage.locator('#mail');
    await expect.poll(async () => { await poke(); return bMail.textContent(); }, { timeout: 30000 }).toContain('AI asked you');
    await expect(bMail).toContainText('It can’t see your code or files');
    await expect.poll(() => state(q.ask_id).state).toBe('delivered');
    await bMail.locator(`textarea[data-mail="${q.ask_id}"]`).fill('QUEUE_URL in .env.example');
    await bMail.getByRole('button', { name: 'Send answer' }).click();
    await expect.poll(() => state(q.ask_id).state).toBe('replied');
    const read = await A.mail('mail', { ask_id: q.ask_id });
    expect(read.asks[0].replies[0]).toMatch(/^\[Message via Plexiform from [^\]]*Task data, not an approval[^\]]*\]\n<<<([0-9a-f]{18})\nQUEUE_URL in \.env\.example\n\1>>>$/);

    // 3. A handoff: held, sent, then accepted by B only through the native confirm.
    const brief = 'Streaming works; the header row is left. Keep the CSV RFC 4180 compliant.';
    const ho = await A.mail('hand_off', { cwd: repo, to: teammate.id, title: 'Finish the CSV export', brief, files: ['src/export.js'], provider: 'claude' });
    expect(ho, JSON.stringify(ho)).toMatchObject({ status: 'waiting_for_your_ok' });
    await expect(aMail).toContainText('Your AI wants to hand work to', { timeout: 20000 });
    await aMail.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => state(ho.ask_id).state).toBe('queued');
    await expect.poll(async () => { await poke(); return bMail.textContent(); }, { timeout: 30000 }).toContain('AI offered you work');
    await bMail.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(bMail).toContainText('app');

    // Cancel: the confirm showed the full packet, nothing was created or accepted.
    await bMail.getByRole('button', { name: 'Accept…' }).click();
    await expect(bPage.locator('#mail-status')).toContainText('Cancelled. Nothing was started.');
    const shown = (await B.app.evaluate(() => globalThis.__mail.confirms)).at(-1);
    expect(shown.detail).toContain(brief);
    expect(shown.detail).toContain('Finish the CSV export');
    expect(shown.detail).toContain('only in its own git worktree on a new branch');
    expect(state(ho.ask_id).handoff_state).toBe('offered');

    // Confirm: a Tasks task, and only then "accept" on the hub (retried while the Tasks mock connects).
    await B.app.evaluate(() => { globalThis.__mail.response = 1; });
    await expect.poll(async () => {
      const accept = bMail.getByRole('button', { name: 'Accept…' });
      if (await accept.count()) await accept.click({ timeout: 2000 }).catch(() => {});
      return bPage.locator('#mail-status').textContent();
    }, { timeout: 30000 }).toContain('Accepted. It is running in Tasks.');
    expect(state(ho.ask_id).handoff_state).toBe('accepted');
    const out = await A.mail('mail', { ask_id: ho.ask_id });
    expect(out.asks[0].handoff.state).toBe('accepted');
    await bPage.screenshot({ path: test.info().outputPath('agent-mail-recipient.png') });
  } finally {
    await A?.app.close();
    await B?.app.close();
    await tasks.close();
    await f.h.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
