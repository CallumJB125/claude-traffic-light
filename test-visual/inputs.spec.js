// The widget as the middleman (P3+): every kind of waiting input in the
// bubble with its real text and options, answered through the real hook, and
// the "Waiting on you" page. Fixtures: test-visual/inputs-fixtures.js.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');
const F = require('./inputs-fixtures');

let h;
let widget;
const SHOT = { threshold: 0.05, stylePath: path.join(__dirname, 'no-hover-chrome.css') };
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();


test.beforeAll(async () => {
  h = await launchApp({ config: { askFromWidget: true } });
  widget = await windowByFile(h.app, 'index.html');
  await widget.emulateMedia({ reducedMotion: 'reduce' });
});

test.afterAll(async () => { await h?.cleanup(); });

test.beforeEach(async () => {
  F.clearRequests(h);
  F.clearSessions(h);
  await expect(widget.locator('.ib-item')).toHaveCount(0, { timeout: 10000 });
});

const bubbleShot = async (name) => { await widget.waitForTimeout(900); // past the 600 ms settle: answer buttons enabled
  await expect(widget).toHaveScreenshot(name, SHOT); };

test('permission: the real command, answered from the bubble; the hook gets it and the row is gone', async () => {
  const hook = F.blockingHook(h, 'permission-request', { session_id: 'vis-perm', cwd: '/visual/app', tool_name: 'Bash', tool_input: { command: 'npm run build -- --prod', description: 'Build for production' } });
  await expect(widget.locator('.ib-item.kind-permission.open')).toBeVisible({ timeout: 10000 });
  await expect(widget.locator('.ib-head')).toHaveText('Bash: npm run build -- --prod');
  await expect(widget.locator('[data-option="allow"]')).toHaveAttribute('aria-label', /Allow once \(Permission in app\)/);
  await bubbleShot('bubble-permission.png');
  await widget.locator('[data-option="allow"]').click();
  await widget.locator('[data-option="allow"]').click({ timeout: 500 }).catch(() => {});
  const { out } = await hook.done;
  expect(JSON.parse(out).hookSpecificOutput.decision.behavior).toBe('allow');
  await expect(widget.locator('.ib-item')).toHaveCount(0, { timeout: 10000 });
  expect(await widget.evaluate(() => document.body.classList.contains('asking'))).toBe(false);
});

test('keyboard: Enter allows an allow-listed command once it has settled', async () => {
  const hook = F.blockingHook(h, 'permission-request', { session_id: 'vis-kbd-ok', cwd: '/visual/app', tool_name: 'Bash', tool_input: { command: 'git status' } });
  await expect(widget.locator('.ib-head')).toHaveText('Bash: git status', { timeout: 10000 });
  await widget.locator('.ib-title').click();
  await widget.waitForTimeout(700);
  await widget.keyboard.press('Enter');
  const { out } = await hook.done;
  expect(JSON.parse(out).hookSpecificOutput.decision.behavior).toBe('allow');
});

test('keyboard: Enter never allows a deny-listed or off-list command; ⌘. denies it', async () => {
  const hook = F.blockingHook(h, 'permission-request', { session_id: 'vis-kbd', cwd: '/visual/app', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await expect(widget.locator('.ib-warn')).toContainText('recursive delete', { timeout: 10000 });
  await widget.locator('.ib-title').click();
  await widget.waitForTimeout(700);
  await widget.keyboard.press('Enter');
  await expect(widget.locator('.ib-err')).toContainText('Enter only allows');
  await widget.keyboard.press('Meta+Period');
  const { out } = await hook.done;
  expect(JSON.parse(out).hookSpecificOutput.decision.behavior).toBe('deny');
  await expect(widget.locator('.ib-item')).toHaveCount(0, { timeout: 10000 });
});

test('plan: the plan text, Enter approves (not auto-accept edits)', async () => {
  const plan = '# Add dark mode\n\n1. Add tokens for the dark palette\n2. Switch on prefers-color-scheme\n3. Update the three visual baselines\n4. Run the full suite';
  const hook = F.blockingHook(h, 'permission-request', { session_id: 'vis-plan', cwd: '/visual/app', tool_name: 'ExitPlanMode', tool_input: { plan } });
  await expect(widget.locator('.ib-item.kind-plan .ib-text')).toContainText('Switch on prefers-color-scheme', { timeout: 10000 });
  await bubbleShot('bubble-plan.png');
  await widget.locator('.ib-title').click();
  await widget.keyboard.press('Enter');
  const { out } = await hook.done;
  const d = JSON.parse(out).hookSpecificOutput.decision;
  expect(d.behavior).toBe('allow');
  expect(d.updatedPermissions).toBeUndefined();
});

test('question: options as buttons, one click answers it', async () => {
  const hook = F.blockingHook(h, 'tool-use', { session_id: 'vis-q', cwd: '/visual/app', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which test runner should the new package use?', header: 'Runner', multiSelect: false, options: [{ label: 'node:test', description: 'built in' }, { label: 'vitest' }] }] } });
  await expect(widget.locator('.ib-item.kind-question [data-option="q0o0"]')).toBeVisible({ timeout: 10000 });
  await bubbleShot('bubble-question.png');
  await widget.locator('[data-option="q0o1"]').click();
  const { out } = await hook.done;
  expect(JSON.parse(out).hookSpecificOutput.updatedInput.answers).toEqual({ 'Which test runner should the new package use?': 'vitest' });
});

test('several waiting: answerable first, then the oldest (escalated); "+N more" opens the Waiting page', async () => {
  // A hook request lives at most 90 s; what waits for minutes is a prompt
  // left in the terminal, known from the session's notification.
  F.hookSync(h, 'notification', { session_id: 'vis-old', cwd: '/visual/api', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' });
  F.ageSession(h, 'vis-old', 6.5 * 60000);
  F.hookSync(h, 'notification', { session_id: 'vis-new', cwd: '/visual/docs', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use WebFetch' });
  F.ageSession(h, 'vis-new', 2.5 * 60000);
  const far = new Date(Date.now() + 40000).toISOString();
  F.staleRequest(h, { id: 'vis-b', sessionId: 'b', cwd: '/visual/web', tool: 'Edit', toolInput: { file_path: '/visual/web/src/theme.ts', old_string: 'dark: false', new_string: 'dark: true' }, createdAt: minsAgo(0.4), expiresAt: far });
  await expect(widget.locator('.ib-more')).toHaveText('+1 more waiting', { timeout: 10000 });
  await expect(widget.locator('.ib-item')).toHaveCount(2);
  await expect(widget.locator('.ib-item').first()).toHaveAttribute('data-id', 'vis-b');
  await expect(widget.locator('.ib-item.late .ib-age')).toHaveText('waiting 6 min');
  // The fixtures land one by one; whichever was briefly alone may have opened.
  if (await widget.locator('.ib-body').count()) await widget.keyboard.press('Escape');
  await expect(widget.locator('.ib-body')).toHaveCount(0);
  await bubbleShot('bubble-collapsed.png');
  await widget.locator('.ib-item[data-id="vis-b"] .ib-row').click();
  await expect(widget.locator('.ib-item[data-id="vis-b"] .ib-body')).toBeVisible();
  await bubbleShot('bubble-expanded.png');
  await widget.keyboard.press('Escape');
  await expect(widget.locator('.ib-body')).toHaveCount(0);

  await widget.locator('.ib-more').click();
  const page = await windowByFile(h.app, 'waiting.html');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.ib-item')).toHaveCount(3, { timeout: 10000 });
  await expect(page.locator('#sub')).toHaveText('3 waiting · 1 for 5 min or more');
  await page.waitForTimeout(800);
  await expect(page).toHaveScreenshot('waiting-page.png', SHOT);
  await page.close();
});

test('expired: the hook stopped waiting, so the bubble says "answer in terminal"', async () => {
  F.staleRequest(h, { id: 'vis-exp', tool: 'Bash', toolInput: { command: 'make release' }, createdAt: minsAgo(1), expiresAt: minsAgo(0.1) });
  await expect(widget.locator('.ib-age')).toHaveText('answer in terminal', { timeout: 10000 });
  await expect(widget.locator('.ib-expired')).toContainText('answer in terminal');
  await expect(widget.locator('.ib-body [data-option="allow"]')).toHaveCount(0);
  await expect(widget.locator('.ib-open')).toHaveText('Open the terminal');
});

test('blocked: "needs your decision" with the reason; "Add a rule" opens the rules prefilled and says why it can’t', async () => {
  F.hookSync(h, 'permission-denied', { session_id: 'vis-blocked', cwd: '/visual/app', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, reason: '[Irreversible Local Destruction]' });
  await expect(widget.locator('.ib-item.kind-blocked .ib-head')).toHaveText('Needs your decision', { timeout: 10000 });
  await expect(widget.locator('[data-option="run-yourself"]')).toHaveText('Open the terminal');
  await expect(widget.locator('[data-option="switch-mode"]')).toHaveText('How to allow it');
  await expect(widget.locator('.ib-text')).toContainText('Reason: [Irreversible Local Destruction]');
  await expect(widget.locator('.ib-reason-text')).toHaveCount(0);
  await widget.locator('[data-option="switch-mode"]').click();
  await expect(widget.locator('.ib-note')).toContainText('Shift+Tab');
  await bubbleShot('bubble-blocked.png');
  await widget.locator('[data-option="add-rule"]').click();
  const lights = await windowByFile(h.app, 'lights.html');
  await expect(lights.locator('#auto')).toBeVisible({ timeout: 10000 });
  await expect(lights.locator('#auto-command')).toHaveValue('rm -rf dist');
  await expect(lights.locator('#auto-why')).toContainText('Can’t save: rm can delete');
  await expect(lights.locator('#auto-save')).toBeDisabled();
  await lights.close();
});

test('dialog: read off a real tmux pane, shown with its choices and "Open it" only', async () => {
  const t = F.tmuxDialog('trust-folder.txt');
  try {
    F.hookSync(h, 'session-start', { session_id: 'vis-dialog', cwd: '/visual/app', source: 'startup' }, t.env);
    F.ageSession(h, 'vis-dialog', 60000);
    await expect(widget.locator('.ib-item.kind-dialog')).toBeVisible({ timeout: 30000 });
    await expect(widget.locator('.ib-dialog-opts li')).toHaveText(['Yes, I trust this folder', 'No, exit']);
    await expect(widget.locator('.ib-open')).toHaveText('Open it');
    await expect(widget.locator('.ib-body [data-option]')).toHaveCount(0);
    await bubbleShot('bubble-dialog.png');
  } finally { t.kill(); }
});

test('the "make it a rule?" nudge stays hidden while auto-answer is off', async () => {
  const hook = F.blockingHook(h, 'permission-request', { session_id: 'vis-nudge', cwd: '/visual/app', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  await expect(widget.locator('[data-option="allow"]')).toBeVisible({ timeout: 10000 });
  await widget.locator('[data-option="allow"]').click();
  await hook.done;
  await expect(widget.locator('.ib-item')).toHaveCount(0, { timeout: 10000 });
  await widget.waitForTimeout(500);
  await expect(widget.locator('.ib-nudge')).toHaveCount(0);
  // The rules page still saves only what main allows.
  await widget.evaluate(() => window.trafficLight.openAutoRule({}));
  const lights = await windowByFile(h.app, 'lights.html');
  const saved = await lights.evaluate(() => window.lightsApi.saveConfig({ autoAnswer: { v: 1, rules: [{ tools: ['Bash'], command: 'rm *' }, { tools: ['Bash'], command: 'npm test' }] } }));
  expect(saved.autoAnswer.rules.map((r) => r.command)).toEqual(['npm test']);
  expect(saved.autoAnswer.sealed).toBeNull();
  await lights.evaluate(() => window.lightsApi.saveConfig({ autoAnswer: { v: 1, rules: [] } }));
  await lights.close();
});

// Its own app: no other window of this file can bring the widget back.
test('a paused widget still updates when a waiting input changes text under the same id', async () => {
  const hh = await launchApp({ config: { askFromWidget: true } });
  try {
    const w = await windowByFile(hh.app, 'index.html');
    await w.waitForTimeout(1800);
    await hh.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).hide());
    const paused = () => w.evaluate(() => document.body.classList.contains('motion-paused'));
    await expect.poll(paused).toBe(true);
    F.hookSync(hh, 'notification', { session_id: 'vis-note', cwd: '/visual/app', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' });
    await expect(w.locator('.ib-item.kind-notification .ib-text')).toHaveText('Claude needs your permission to use Bash', { timeout: 10000 });
    F.hookSync(hh, 'notification', { session_id: 'vis-note', cwd: '/visual/app', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use WebFetch' });
    await expect(w.locator('.ib-item.kind-notification .ib-text')).toHaveText('Claude needs your permission to use WebFetch', { timeout: 10000 });
    expect(await paused()).toBe(true);
  } finally { await hh.cleanup(); }
});

test('the Lights auto-answer rules view', async () => {
  const cfg = path.join(h.home, 'config.json');
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  c.autoAnswer = { v: 1, rules: [
    { id: 'r1', action: 'allow', tools: ['Bash'], command: 'npm test *', cwd: '~/Development/app/**', enabled: true },
    { id: 'r2', action: 'allow', tools: ['Read', 'Grep'], path: '~/Development/**', enabled: true },
    { id: 'r3', action: 'deny', tools: ['WebFetch'], enabled: false },
  ] };
  fs.writeFileSync(cfg, JSON.stringify(c));
  await widget.evaluate(() => window.trafficLight.openAutoRule({}));
  const lights = await windowByFile(h.app, 'lights.html');
  await expect(lights.locator('#auto-list li')).toHaveCount(3, { timeout: 10000 });
  await lights.locator('#auto-tools input[value="Bash"]').check();
  await lights.locator('#auto-command').fill('git *');
  await expect(lights.locator('#auto-why')).toContainText('name the git subcommand');
  await lights.waitForTimeout(500);
  await expect(lights).toHaveScreenshot('lights-auto-rules.png', SHOT);
  await lights.close();
});

// Its own app: the Plexiform window opened on the page (`--buddy waiting`).
test('the Waiting page sits in the Plexiform window as a local page', async () => {
  const hh = await launchApp({ config: { askFromWidget: true }, extraArgs: ['--buddy', 'waiting'] });
  try {
    F.staleRequest(hh, { id: 'vis-emb', sessionId: 'emb', cwd: '/visual/app', tool: 'Bash', toolInput: { command: 'npm run lint -- --fix' }, createdAt: minsAgo(0.2), expiresAt: new Date(Date.now() + 40000).toISOString() });
    const page = await windowByFile(hh.app, 'waiting.html');
    await expect(page.locator('.ib-item[data-id="vis-emb"] .ib-head')).toHaveText('Bash: npm run lint -- --fix', { timeout: 10000 });
    await expect(page.locator('[data-option="allow"]')).toBeVisible();
    expect(await page.evaluate(() => document.body.classList.contains('standalone'))).toBe(false);
    const sidebar = await windowByFile(hh.app, 'sidebar.html');
    await expect(sidebar.locator('[aria-current="page"]')).toContainText('Waiting on you', { timeout: 10000 });
    await page.waitForTimeout(900);
    await expect(page).toHaveScreenshot('waiting-embedded.png', SHOT);
  } finally { await hh.cleanup(); }
});
