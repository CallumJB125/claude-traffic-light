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
  // One-key approval is opt-in (Preferences); main rereads config.json on change.
  const configFile = path.join(h.home, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(before), oneKeyApprove: true }));
  try {
    // Enter needs a real session folder (it resolves relative paths against it).
    const proj = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ctl-vis-proj-'));
    const hook = F.blockingHook(h, 'permission-request', { session_id: 'vis-kbd-ok', cwd: proj, tool_name: 'Bash', tool_input: { command: 'git status' } });
    await expect(widget.locator('.ib-head')).toHaveText('Bash: git status', { timeout: 10000 });
    await widget.locator('.ib-title').click();
    await widget.waitForTimeout(700);
    await widget.keyboard.press('Enter');
    const { out } = await hook.done;
    expect(JSON.parse(out).hookSpecificOutput.decision.behavior).toBe('allow');
  } finally { fs.writeFileSync(configFile, before); }
});

test('keyboard: Enter never allows a deny-listed or off-list command; ⌘. denies it', async () => {
  const hook = F.blockingHook(h, 'permission-request', { session_id: 'vis-kbd', cwd: '/visual/app', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await expect(widget.locator('.ib-warn')).toContainText('recursive delete', { timeout: 10000 });
  await widget.locator('.ib-title').click();
  await widget.waitForTimeout(700);
  await widget.keyboard.press('Enter');
  await expect(widget.locator('.ib-err')).toContainText('Enter only allows');
  await widget.waitForTimeout(900); // the message made the bubble taller: it settles again
  await widget.keyboard.press('Meta+Period');
  const { out } = await hook.done;
  expect(JSON.parse(out).hookSpecificOutput.decision.behavior).toBe('deny');
  await expect(widget.locator('.ib-item')).toHaveCount(0, { timeout: 10000 });
});

test('plan: the plan text; Enter never approves it, a click does (not auto-accept edits)', async () => {
  const plan = '# Add dark mode\n\n1. Add tokens for the dark palette\n2. Switch on prefers-color-scheme\n3. Update the three visual baselines\n4. Run the full suite';
  const hook = F.blockingHook(h, 'permission-request', { session_id: 'vis-plan', cwd: '/visual/app', tool_name: 'ExitPlanMode', tool_input: { plan } });
  await expect(widget.locator('.ib-item.kind-plan .ib-text')).toContainText('Switch on prefers-color-scheme', { timeout: 10000 });
  await bubbleShot('bubble-plan.png');
  await widget.locator('.ib-title').click();
  await widget.waitForTimeout(900);
  await widget.keyboard.press('Enter');
  await expect(widget.locator('.ib-err')).toHaveText('Pick an option.');
  await widget.waitForTimeout(900); // the message made the bubble taller: it settles again
  await widget.locator('.ib-item.kind-plan [data-option="allow"]').click();
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
  await expect(widget.locator('.ib-open')).toHaveText('Open in terminal');
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
    await expect(widget.locator('.ib-open')).toHaveText('Open in terminal');
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
  // Nothing counted, so the keychain-held secret is never read on an answer.
  expect(fs.existsSync(path.join(h.home, 'approval-counts.json'))).toBe(false);
  expect(fs.existsSync(path.join(h.home, 'approval-secret.json'))).toBe(false);
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
  // Filling the command focuses it, which scrolls the form into view when the page is taller than the popup.
  await lights.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; });
  await lights.mouse.move(0, 0);
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
    // Waiting lives in the Inbox section since 9921f259.
    await expect(sidebar.locator('.nav-section[data-active]')).toContainText('Inbox', { timeout: 10000 });
    await page.waitForTimeout(900);
    await expect(page).toHaveScreenshot('waiting-embedded.png', SHOT);
  } finally { await hh.cleanup(); }
});

// Its own app: answering from the widget turned off.
test('with "answer from the widget" off, a request file still on disk cannot be answered', async () => {
  const hh = await launchApp({ config: { askFromWidget: false } });
  try {
    const w = await windowByFile(hh.app, 'index.html');
    F.staleRequest(hh, { id: 'vis-off', tool: 'Bash', toolInput: { command: 'ls' }, createdAt: minsAgo(0.1), expiresAt: new Date(Date.now() + 40000).toISOString() });
    const r = await w.evaluate(() => window.trafficLight.answerInput('vis-off', 'allow', {}));
    expect(r).toEqual({ ok: false, error: 'off' });
  } finally { await hh.cleanup(); }
});

// PR 5 (Q1): answering is off, so a permission wait is one honest sentence and Open in terminal, never chips.
test('permission, answering off: says so in words, offers Open in terminal and a Turn it on link', async () => {
  const hh = await launchApp({ config: { askFromWidget: false } });
  try {
    const w = await windowByFile(hh.app, 'index.html');
    await w.emulateMedia({ reducedMotion: 'reduce' });
    F.hookSync(hh, 'notification', { session_id: 'vis-off', cwd: '/visual/app', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' });
    F.ageSession(hh, 'vis-off', 60000);
    await expect(w.locator('.ib-item')).toBeVisible({ timeout: 15000 });
    await expect(w.locator('.ib-body [data-option]')).toHaveCount(0);
    await expect(w.locator('.ib-body')).toBeVisible();
    await expect(w.locator('.ib-open')).toHaveText('Open in terminal');
    await expect(w.locator('.ib-body .ib-hint')).toContainText('Answering here is off');
    await expect(w.locator('.ib-body .ib-link')).toHaveText('Turn it on');
    await w.waitForTimeout(900);
    await expect(w).toHaveScreenshot('bubble-permission-off.png', SHOT);
  } finally { await hh.cleanup(); }
});

// PR 5b: answering is on for a new install, so the cards that become the default have to read right.
const far = () => new Date(Date.now() + 40000).toISOString();

test('stacked same-folder cards carry distinct tags on the bubble and on the Waiting page, light and dark', async () => {
  F.hookSync(h, 'tool-use', { session_id: 'stk-aaaa1111', cwd: '/visual/notes-app', tool_name: 'Bash', tool_input: { command: 'ls' } });
  F.hookSync(h, 'tool-use', { session_id: 'stk-bbbb2222', cwd: '/visual/notes-app', tool_name: 'Bash', tool_input: { command: 'ls' } });
  F.staleRequest(h, { id: 'vis-stk-1', sessionId: 'stk-aaaa1111', cwd: '/visual/notes-app', tool: 'Bash', toolInput: { command: 'npm test' }, createdAt: minsAgo(0.5), expiresAt: far() });
  F.staleRequest(h, { id: 'vis-stk-2', sessionId: 'stk-bbbb2222', cwd: '/visual/notes-app', tool: 'Bash', toolInput: { command: 'npm run lint' }, createdAt: minsAgo(0.3), expiresAt: far() });
  await expect(widget.locator('.ib-item')).toHaveCount(2, { timeout: 10000 });
  if (await widget.locator('.ib-body').count()) await widget.keyboard.press('Escape');
  await expect(widget.locator('.ib-proj')).toHaveText(['notes-app (1111)', 'notes-app (2222)']);
  await bubbleShot('bubble-stacked-tags.png');
});

test('the Waiting page shows the same distinct tags, light and dark', async () => {
  const hh = await launchApp({ config: { askFromWidget: true }, extraArgs: ['--buddy', 'waiting'] });
  try {
    F.hookSync(hh, 'tool-use', { session_id: 'stk-aaaa1111', cwd: '/visual/notes-app', tool_name: 'Bash', tool_input: { command: 'ls' } });
    F.hookSync(hh, 'tool-use', { session_id: 'stk-bbbb2222', cwd: '/visual/notes-app', tool_name: 'Bash', tool_input: { command: 'ls' } });
    F.staleRequest(hh, { id: 'vis-stk-1', sessionId: 'stk-aaaa1111', cwd: '/visual/notes-app', tool: 'Bash', toolInput: { command: 'npm test' }, createdAt: minsAgo(0.5), expiresAt: far() });
    F.staleRequest(hh, { id: 'vis-stk-2', sessionId: 'stk-bbbb2222', cwd: '/visual/notes-app', tool: 'Bash', toolInput: { command: 'npm run lint' }, createdAt: minsAgo(0.3), expiresAt: far() });
    const page = await windowByFile(hh.app, 'waiting.html');
    await expect(page.locator('.ib-item')).toHaveCount(2, { timeout: 10000 });
    await expect(page.locator('.ib-proj')).toHaveText(['notes-app (1111)', 'notes-app (2222)']);
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.waitForTimeout(900);
      await expect(page).toHaveScreenshot(`waiting-stacked-tags-${colorScheme}.png`, SHOT);
    }
  } finally { await hh.cleanup(); }
});

test('a flagged request: the first click arms "Allow anyway" and nothing is sent until the second', async () => {
  F.staleRequest(h, { id: 'vis-flag', sessionId: 'flag', cwd: '/visual/app', tool: 'Bash', toolInput: { command: 'rm -rf build' }, createdAt: minsAgo(0.2), expiresAt: far() });
  await expect(widget.locator('.ib-item.open')).toBeVisible({ timeout: 10000 });
  await expect(widget.locator('.ib-warn')).toContainText('Needs a careful look');
  await widget.waitForTimeout(900);
  await widget.locator('[data-option="allow"]').click();
  await expect(widget.locator('[data-option="allow"]')).toHaveText('Allow anyway');
  await bubbleShot('bubble-allow-anyway.png');
});

test('a Codex ask is read-only: one sentence and Open, no buttons', async () => {
  const f = path.join(h.home, 'sessions', `${F.HOST}-vis-codex.json`);
  const at = new Date(Date.now() - 30000).toISOString();
  fs.writeFileSync(f, JSON.stringify({ sessionId: 'vis-codex', host: F.HOST, source: 'codex', cwd: '/visual/api', signal: 'permission-ask', askKind: 'request', tool: 'Bash', signalSince: at, updatedAt: at, startedAt: at }));
  await expect(widget.locator('.ib-item')).toBeVisible({ timeout: 15000 });
  await expect(widget.locator('.ib-body [data-option]')).toHaveCount(0);
  await bubbleShot('bubble-codex-ask.png');
});

test('the first-use notice shows once on a new install and Got it keeps it away', async () => {
  const hh = await launchApp({ config: { askFromWidget: true, askNotice: 'pending' } });
  try {
    const w = await windowByFile(hh.app, 'index.html');
    await w.emulateMedia({ reducedMotion: 'reduce' });
    F.staleRequest(hh, { id: 'vis-notice', sessionId: 'notice', cwd: '/visual/app', tool: 'Bash', toolInput: { command: 'ls' }, createdAt: minsAgo(0.2), expiresAt: far() });
    await expect(w.locator('.ib-notice')).toBeVisible({ timeout: 15000 });
    await expect(w.locator('.ib-notice')).toContainText('answer Claude’s permission prompts here or in the terminal');
    await w.waitForTimeout(900);
    await expect(w).toHaveScreenshot('bubble-first-use-notice.png', SHOT);
    await w.locator('.ib-notice button', { hasText: 'Got it' }).click();
    await expect(w.locator('.ib-notice')).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(path.join(hh.home, 'config.json'), 'utf8')).askNotice).toBe('seen');
  } finally { await hh.cleanup(); }
});

test('a session that started before the permission hook went in says to restart it, with no buttons', async () => {
  const hh = await launchApp({ config: { askFromWidget: true, askHooksAt: Date.now() + 3600000 } });
  try {
    const w = await windowByFile(hh.app, 'index.html');
    await w.emulateMedia({ reducedMotion: 'reduce' });
    F.hookSync(hh, 'session-start', { session_id: 'vis-pre', cwd: '/visual/app' });
    F.hookSync(hh, 'notification', { session_id: 'vis-pre', cwd: '/visual/app', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' });
    F.ageSession(hh, 'vis-pre', 60000);
    await expect(w.locator('.ib-item')).toBeVisible({ timeout: 15000 });
    await expect(w.locator('.ib-body [data-option]')).toHaveCount(0);
    await expect(w.locator('.ib-body .ib-hint')).toContainText('restart this session to answer here');
    await w.waitForTimeout(900);
    await expect(w).toHaveScreenshot('bubble-pre-hook.png', SHOT);
  } finally { await hh.cleanup(); }
});
