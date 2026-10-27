'use strict';
// Redesign R2a: the read-only thread behind the dev-only preview gate
// (CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW=1; launchApp's --demo visual makes it a dev
// run). One local session is seeded as a hook file, so a thread opens through
// the real path: the sidebar row → buddy:open-thread → main's threadTarget →
// the thread view → guard T. For the pixel shots only, main's thread:open and
// thread:state answers are replaced with fixed content (the shape
// src/thread-main.js returns), so nothing depends on a transcript, a clock or
// the Tasks engine. The authority itself is test/thread-authority.test.js.
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile, snapToPixels } = require('./app');

const GATE = { CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW: '1' };
const session = () => JSON.stringify({ sessionId: 'thread-fixture', source: 'claude', host: 'synthetic', cwd: '/synthetic/billing', signal: 'tool-use', updatedAt: new Date().toISOString(), hostApp: 'iTerm2' });

const at = (n) => ({ seq: n });
const CHAT = {
  kind: 'task',
  header: { title: 'Fix the flaky upload test', project: 'api', bucket: 'working', origin: null, ai: 'Claude', terminal: false },
  detail: {
    id: 'fixture', title: 'Fix the flaky upload test', state: 'running', ai: { id: 'claude' }, repo: { name: 'api' }, branch: 'fix/flaky-upload', where: '~/work/api',
    text: 'The upload test fails about one run in five. Find out why and fix it.', openApprovals: [], openAsk: null, messages: [], actions: [],
  },
  replay: [
    { type: 'transcript', role: 'assistant', turn: 1, text: "I'll start by reading the test and the upload handler.", ...at(1) },
    { type: 'tool', phase: 'start', toolUseId: 'r1', name: 'Read', summary: 'test/upload.test.js', ...at(2) },
    { type: 'tool', phase: 'end', toolUseId: 'r1', name: 'Read', ok: true, durationMs: 400, ...at(3) },
    { type: 'tool', phase: 'start', toolUseId: 'r2', name: 'Read', summary: 'src/upload.js', ...at(4) },
    { type: 'tool', phase: 'end', toolUseId: 'r2', name: 'Read', ok: true, durationMs: 300, ...at(5) },
    { type: 'tool', phase: 'start', toolUseId: 'r3', name: 'Read', summary: 'src/storage.js', ...at(6) },
    { type: 'tool', phase: 'end', toolUseId: 'r3', name: 'Read', ok: true, durationMs: 300, ...at(7) },
    { type: 'transcript', role: 'assistant', turn: 1, text: "Found it. The test doesn't wait for the file to finish writing:\n\n- `saveUpload()` returns before the stream closes\n- the assertion reads the file straight away\n\nThe fix is to await the stream's `finish` event:\n\n```js\nawait once(stream, 'finish');\n```", ...at(8) },
    { type: 'tool', phase: 'start', toolUseId: 'e1', name: 'Edit', summary: 'src/upload.js', ...at(9) },
    { type: 'tool', phase: 'end', toolUseId: 'e1', name: 'Edit', ok: true, durationMs: 1200, ...at(10) },
    { type: 'tool', phase: 'start', toolUseId: 'b1', name: 'Bash', summary: 'npm test', ...at(11) },
    { type: 'tool', phase: 'end', toolUseId: 'b1', name: 'Bash', ok: true, durationMs: 9000, ...at(12) },
    { type: 'transcript', role: 'assistant', turn: 1, text: 'The test passed 50 runs in a row. Next I\'ll check the [stream docs](https://nodejs.org/api/stream.html) for the same pattern elsewhere.', partial: true, ...at(13) },
  ],
};
const WAITING = {
  ...CHAT,
  header: { ...CHAT.header, bucket: 'needs' },
  detail: { ...CHAT.detail, openApprovals: [{ approvalId: 'a1', tool: 'Bash', inputSummary: 'npm run migrate -- --env staging' }] },
  replay: CHAT.replay.slice(0, 8),
};
const NATIVE = {
  kind: 'session', origin: 'iTerm',
  header: { title: 'Claude session in billing', project: 'billing', bucket: 'working', origin: 'iTerm', ai: 'Claude', terminal: true },
  activity: { title: 'Claude Code · billing', view: { status: 'Working', events: [
    { at: 1, kind: 'start', label: 'Started', text: null },
    { at: 2, kind: 'prompt', label: 'Asked', text: 'Add a retry to the invoice export' },
    { at: 3, kind: 'read', label: 'Read', text: 'src/export.js, src/http.js' },
    { at: 4, kind: 'edit', label: 'Edited', text: 'src/export.js' },
    { at: 5, kind: 'command', label: 'Ran', text: 'npm test -- export' },
    { at: 6, kind: 'turn-end', label: 'Turn finished', text: 'Added three retries with backoff to `exportInvoices()`. The export tests pass.' },
    { at: 7, kind: 'prompt', label: 'Asked', text: 'Now log each retry' },
  ] } },
};

// R2b-1: a chat that takes replies, and one that has ended.
const REPLY = {
  ...CHAT,
  header: { ...CHAT.header, chatState: 'working', openInTerminal: { available: false, reason: 'in-place' } },
  detail: { ...CHAT.detail, actions: ['message', 'stop'] },
};
const ENDED = {
  ...CHAT,
  header: { ...CHAT.header, bucket: 'check', chatState: 'ended', openInTerminal: { available: true, reason: null } },
  detail: { ...CHAT.detail, state: 'done', actions: [] },
  replay: CHAT.replay.slice(0, 12),
};

async function open({ fixture = null, theme = 'light', env = GATE } = {}) {
  const h = await launchApp({ env, files: { 'sessions/thread-fixture.json': session() } });
  if (fixture) {
    // Answers the thread document only, as main does.
    await h.app.evaluate(({ ipcMain }, fixture) => {
      const mine = (e) => { try { return new URL(e.sender.getURL()).pathname.endsWith('/thread.html'); } catch { return false; } };
      for (const ch of ['thread:open', 'thread:state']) { ipcMain.removeHandler(ch); ipcMain.handle(ch, (e) => (mine(e) ? fixture : null)); }
    }, fixture);
  }
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openHelp());
  const side = await windowByFile(h.app, 'sidebar.html');
  await side.waitForFunction(() => !!window.buddy);
  return { h, side };
}

async function openThread(h, side, theme = 'light') {
  const row = side.locator('.sidebar-row').first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  const page = await windowByFile(h.app, 'thread.html');
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.waitForLoadState('load');
  await expect(page.locator('#th')).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const frame = (page) => page.frameLocator('#th-tx');
const shot = async (page, name) => expect(await snapToPixels(page.locator('#th'))).toHaveScreenshot(name);

test('flag off: no thread, and the sidebar bridge has no thread channel', async () => {
  const { h, side } = await open({ env: {} });
  try {
    expect(await side.evaluate(() => [typeof window.buddy.openThread, typeof window.buddy.sessions])).toEqual(['undefined', 'undefined']);
    expect(h.app.windows().some((p) => p.url().split('?')[0].endsWith('/thread.html'))).toBe(false);
  } finally { await h.cleanup(); }
});

test('the real path: a local session row opens its thread, the row is selected, and leaving it destroys the view (S2)', async () => {
  const { h, side } = await open();
  try {
    const page = await openThread(h, side);
    await expect(page.locator('#th-banner')).toContainText('Running in iTerm');
    await expect(page.locator('#th-primary')).toHaveText('Go to it');
    await expect(side.locator('.sidebar-row[aria-selected="true"]')).toHaveCount(1);
    // Board from the footer: the thread document is gone, not kept alive in the background.
    await side.locator('.sb-foot[data-page="board"]').click();
    await expect.poll(() => h.app.windows().some((p) => p.url().split('?')[0].endsWith('/thread.html'))).toBe(false);
    await expect(side.locator('.sidebar-row[aria-selected="true"]')).toHaveCount(0);
  } finally { await h.cleanup(); }
});

test('the transcript frame in Electron: same-origin srcdoc, no script runs, linked styles only (S4b repeat)', async () => {
  const { h, side } = await open({ fixture: CHAT });
  try {
    const page = await openThread(h, side);
    const r = await page.evaluate(() => new Promise((resolve) => {
      const f = document.getElementById('th-tx'), d = f.contentDocument;
      const s = d.createElement('script'); s.textContent = 'window.parent.__ran = 1'; d.body.append(s);
      const img = d.createElement('img'); img.setAttribute('onerror', 'window.parent.__img = 1'); img.src = 'x:y'; d.body.append(img);
      const st = d.createElement('style'); st.textContent = '.tx { outline: 3px solid rgb(1, 2, 3); }'; d.head.append(st);
      setTimeout(() => resolve({
        origin: f.contentWindow.location.href, ran: window.__ran === 1, img: window.__img === 1,
        inline: getComputedStyle(d.querySelector('.tx')).outlineColor,
        linked: getComputedStyle(d.querySelector('.tx')).display,
        anchors: d.querySelectorAll('a').length, sandbox: f.getAttribute('sandbox'),
      }), 300);
    }));
    expect(r).toEqual({ origin: 'about:srcdoc', ran: false, img: false, inline: expect.not.stringContaining('1, 2, 3'), linked: 'flex', anchors: 0, sandbox: 'allow-same-origin' });
  } finally { await h.cleanup(); }
});

for (const theme of ['light', 'dark']) {
  test(`chat (${theme}): header, the 760 px column, markdown, one line per group of steps`, async () => {
    const { h, side } = await open({ fixture: CHAT, theme });
    try {
      const page = await openThread(h, side, theme);
      await expect(page.locator('#th-title')).toHaveText('Fix the flaky upload test');
      await expect(page.locator('#th-meta')).toHaveText('api · fix/flaky-upload · Claude');
      await expect(page.locator('#th-bucket')).toHaveText('Working on it');
      await expect(page.locator('#th-primary')).toBeHidden();
      const tx = frame(page);
      await expect(tx.locator('.tx-steps-text')).toHaveText(['Read 3 files', 'Edited src/upload.js · Ran npm test']);
      await expect(tx.locator('.tx-link')).toHaveText('stream docs (https://nodejs.org/api/stream.html)');
      expect(await page.locator('.th-body-in').evaluate((n) => n.getBoundingClientRect().width)).toBeLessThanOrEqual(760);
      await shot(page, `thread-chat-${theme}.png`);
    } finally { await h.cleanup(); }
  });

  test(`terminal session (${theme}): Running in iTerm, Go to it, its activity`, async () => {
    const { h, side } = await open({ fixture: NATIVE, theme });
    try {
      const page = await openThread(h, side, theme);
      await expect(page.locator('#th-banner')).toHaveText('Running in iTerm');
      await expect(page.locator('#th-primary')).toHaveText('Go to it');
      await expect(frame(page).locator('.tx-user')).toHaveText(['Add a retry to the invoice export', 'Now log each retry']);
      await shot(page, `thread-native-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}

test('waiting: the read-only card and one Open to answer button', async () => {
  const { h, side } = await open({ fixture: WAITING });
  try {
    const page = await openThread(h, side);
    await expect(page.locator('#th-waiting-title')).toHaveText('Claude is waiting for you');
    await expect(page.locator('#th-waiting-what')).toHaveText('Bash: npm run migrate -- --env staging');
    await expect(page.locator('button:visible', { hasText: 'Open to answer' })).toHaveCount(1);
    await expect(page.locator('#th-waiting button')).toHaveText(['Open to answer']);
    await expect(page.locator('#th-bucket')).toHaveText('Needs you');
    await shot(page, 'thread-waiting.png');
  } finally { await h.cleanup(); }
});

test('200% zoom: nothing scrolls sideways, header or transcript', async () => {
  const { h, side } = await open({ fixture: CHAT });
  try {
    const page = await openThread(h, side);
    await h.app.evaluate(({ webContents }) => { const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('/thread.html')); wc.setZoomFactor(2); });
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBeGreaterThanOrEqual(2);
    const overflow = await page.evaluate(() => {
      const d = document.getElementById('th-tx').contentDocument;
      return [document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth, d.scrollingElement.scrollWidth - d.scrollingElement.clientWidth];
    });
    expect(overflow[0]).toBeLessThanOrEqual(0);
    expect(overflow[1]).toBeLessThanOrEqual(0);
  } finally { await h.cleanup(); }
});

// ── R2b-1: the reply box ─────────────────────────────────────────────────
for (const theme of ['light', 'dark']) {
  test(`reply (${theme}): the box under the chat, a draft, ⌘↩ sends the row and the text only`, async () => {
    const { h, side } = await open({ fixture: REPLY, theme });
    try {
      // Main's thread:message is replaced with a recorder that answers the thread document only.
      await h.app.evaluate(({ ipcMain }) => {
        globalThis.__replies = [];
        ipcMain.removeHandler('thread:message');
        ipcMain.handle('thread:message', (e, ...a) => { if (!new URL(e.sender.getURL()).pathname.endsWith('/thread.html')) return null; globalThis.__replies.push(a); return { ok: true }; });
      });
      const page = await openThread(h, side, theme);
      await expect(page.locator('#th-reply')).toBeVisible();
      await expect(page.locator('#th-reply-text')).toHaveAttribute('placeholder', 'Reply to Claude…');
      await expect(page.locator('#th-send')).toBeDisabled();
      await page.locator('#th-reply-text').fill('Use the staging database for the upload test, not a temp folder.');
      await expect(page.locator('#th-send')).toBeEnabled();
      await page.locator('#th-reply-text').blur();
      await shot(page, `thread-reply-${theme}.png`);
      if (theme === 'light') {
        await page.locator('#th-reply-text').press('Enter');
        expect(await h.app.evaluate(() => globalThis.__replies.length)).toBe(0);
        await page.locator('#th-reply-text').press('Meta+Enter');
        await expect(page.locator('#th-reply-text')).toHaveValue('');
        const sent = await h.app.evaluate(() => globalThis.__replies);
        expect(sent.length).toBe(1);
        expect(Object.keys(sent[0][0]).sort()).toEqual(['body', 'id']);
        expect(sent[0][0].body).toBe('Use the staging database for the upload test, not a temp folder.\n');
        expect(sent[0][0].id).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally { await h.cleanup(); }
  });
}

test('ended: no reply box, Resume in Tasks', async () => {
  const { h, side } = await open({ fixture: ENDED });
  try {
    const page = await openThread(h, side);
    await expect(page.locator('#th-reply')).toBeHidden();
    await expect(page.locator('#th-ended-title')).toHaveText('This chat has ended');
    await expect(page.locator('#th-resume')).toHaveText('Resume in Tasks');
    await shot(page, 'thread-ended.png');
  } finally { await h.cleanup(); }
});

// ── R4-1a: requests answered in the chat, stacked (plan-r4 §4, §11) ──────
const ACTS = ['approve', 'deny', 'answer', 'stop', 'resume', 'message'];
const STACKED = {
  ...CHAT,
  header: { ...CHAT.header, bucket: 'needs', chatState: 'working' },
  detail: { ...CHAT.detail, actions: ACTS, confirm: [],
    openApprovals: [{ approvalId: 'a1', tool: 'Bash', inputSummary: 'npm run migrate -- --env staging' }, { approvalId: 'a2', tool: 'Edit', inputSummary: 'config/staging.json' }],
    openAsk: { askId: 'q1', text: 'Should the retry also cover the S3 upload, or only local files?', options: ['Both', 'Only local files'], choices: null } },
  replay: CHAT.replay.slice(0, 8),
};
const QUESTION = { ...STACKED, detail: { ...STACKED.detail, openApprovals: [] } };
const CHOICES = {
  ...STACKED,
  header: { ...STACKED.header, chatState: null },
  detail: { ...STACKED.detail, state: 'parked', actions: ['resume', 'stop'], openApprovals: [],
    openAsk: { askId: 'q2', text: 'Claude hit its usage limit. The handover is saved.', options: null, choices: [{ id: 'wait_reset', label: 'Wait for the reset', action: 'resume', payload: { when: 'reset' } }] } },
};
// Main's thread:act is replaced with a recorder that answers the thread document only.
const recordActs = (h) => h.app.evaluate(({ ipcMain }) => {
  globalThis.__acts = [];
  ipcMain.removeHandler('thread:act');
  ipcMain.handle('thread:act', (e, ...a) => { if (!new URL(e.sender.getURL()).pathname.endsWith('/thread.html')) return null; globalThis.__acts.push(a); return { ok: true }; });
});

for (const theme of ['light', 'dark']) {
  test(`stacked (${theme}): two approvals and a question, each its own card; Allow once sends that request only`, async () => {
    const { h, side } = await open({ fixture: STACKED, theme });
    try {
      await recordActs(h);
      const page = await openThread(h, side, theme);
      const cards = page.locator('#th-cards .th-card');
      await expect(cards).toHaveCount(3);
      await expect(cards.nth(0).locator('.th-card-title')).toHaveText('Claude wants to use Bash');
      await expect(cards.nth(2).locator('.th-card-title')).toHaveText('Claude has a question');
      await expect(page.locator('#th-reply-text')).toHaveAttribute('placeholder', 'Type your answer to the question above');
      // Armed for 600 ms, then every button works.
      await expect(cards.nth(0).getByRole('button', { name: 'Allow once' })).toBeEnabled({ timeout: 3000 });
      await shot(page, `thread-approval-stacked-${theme}.png`);
      if (theme === 'light') {
        await cards.nth(1).getByRole('button', { name: 'Allow once' }).click();
        await expect(cards.nth(1).locator('.th-card-receipt')).toHaveText('Allowed once');
        const sent = await h.app.evaluate(() => globalThis.__acts);
        expect(sent.length).toBe(1);
        expect(sent[0].length).toBe(1);
        expect(Object.keys(sent[0][0]).sort()).toEqual(['action', 'approvalId', 'id', 'scope']);
        expect(sent[0][0]).toMatchObject({ action: 'approve', approvalId: 'a2', scope: 'once' });
        expect(sent[0][0].id).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally { await h.cleanup(); }
  });
}

test('question: options and the box as its answer', async () => {
  const { h, side } = await open({ fixture: QUESTION });
  try {
    const page = await openThread(h, side);
    await expect(page.locator('#th-cards .th-card')).toHaveCount(1);
    await expect(page.locator('#th-reply-text')).toHaveAttribute('placeholder', 'Pick an option above, or type an answer');
    await expect(page.getByRole('button', { name: 'Both' })).toBeEnabled({ timeout: 3000 });
    await shot(page, 'thread-question.png');
  } finally { await h.cleanup(); }
});

test('choices: the supervisor\'s own words, one click each', async () => {
  const { h, side } = await open({ fixture: CHOICES });
  try {
    await recordActs(h);
    const page = await openThread(h, side);
    await expect(page.locator('#th-cards .th-card-title')).toHaveText('Claude needs you to choose');
    const wait = page.getByRole('button', { name: 'Wait for the reset' });
    await expect(wait).toBeEnabled({ timeout: 3000 });
    await shot(page, 'thread-choices.png');
    await wait.click();
    await expect(page.locator('#th-cards .th-card-receipt')).toHaveText('Sent');
    const sent = await h.app.evaluate(() => globalThis.__acts);
    expect(Object.keys(sent[0][0]).sort()).toEqual(['action', 'askId', 'choiceId', 'id']);
    expect(sent[0][0]).toMatchObject({ action: 'choose', askId: 'q2', choiceId: 'wait_reset' });
  } finally { await h.cleanup(); }
});

test('stop: two steps in the open chat', async () => {
  const { h, side } = await open({ fixture: REPLY });
  try {
    await recordActs(h);
    const page = await openThread(h, side);
    await page.locator('#th-stop-btn').click();
    await expect(page.locator('#th-stop-q')).toHaveText('Stop this chat?');
    await expect(page.locator('#th-stop-yes')).toBeEnabled({ timeout: 3000 });
    await shot(page, 'thread-stop-confirm.png');
    await page.locator('#th-stop-yes').click();
    await expect(page.locator('#th-stop-note')).toHaveText('Stopping…');
    const sent = await h.app.evaluate(() => globalThis.__acts);
    expect(sent[0][0]).toMatchObject({ action: 'stop', confirmed: true });
    expect(Object.keys(sent[0][0]).sort()).toEqual(['action', 'confirmed', 'id']);
  } finally { await h.cleanup(); }
});

// R4-1b (plan-r4 §4, §5 R4-1b): the dialog kinds. The native dialog itself is main's (test/thread-act-service.test.js);
// these pin the cards that lead to it.
const START = {
  ...STACKED,
  detail: { ...STACKED.detail, permissionLevel: 'auto-edits', source: 'board', openAsk: null,
    openApprovals: [{ approvalId: 'st1', tool: 'StartTask', inputSummary: 'Add retry with backoff to the S3 upload and cover it with a test.' }] },
};
const SWITCHING = {
  ...CHOICES,
  detail: { ...CHOICES.detail, actions: ['resume', 'stop', 'switchAi'] },
};

test('starttask: Plexiform\'s facts above the untrusted summary; Accept and start… sends that approval once', async () => {
  const { h, side } = await open({ fixture: START });
  try {
    await recordActs(h);
    const page = await openThread(h, side);
    const card = page.locator('#th-cards .th-card');
    await expect(card.locator('.th-card-title')).toHaveText('Waiting for you to accept this task');
    await expect(card.locator('.th-facts')).toContainText('a teammate');
    const accept = card.getByRole('button', { name: 'Accept and start…' });
    await expect(accept).toBeEnabled({ timeout: 3000 });
    await shot(page, 'thread-starttask.png');
    await accept.click();
    await expect(page.locator('#th-cards .th-card-receipt')).toHaveText('Accepted');
    const sent = await h.app.evaluate(() => globalThis.__acts);
    expect(sent[0][0]).toMatchObject({ action: 'approve', approvalId: 'st1', scope: 'once' });
  } finally { await h.cleanup(); }
});

test('switch review: Continue with Codex shows what is handed over, as text, before anything starts', async () => {
  const { h, side } = await open({ fixture: SWITCHING });
  try {
    await h.app.evaluate(({ ipcMain }) => {
      globalThis.__acts = [];
      ipcMain.removeHandler('thread:act');
      ipcMain.handle('thread:act', (e, ...a) => {
        if (!new URL(e.sender.getURL()).pathname.endsWith('/thread.html')) return null;
        globalThis.__acts.push(a);
        if (a[0].ai) return { ok: true, review: { review: '11111111-2222-4333-8444-555555555555', from: 'claude', to: 'codex', permissionLevel: 'auto-edits', planFirst: false, budgetUsd: 10, spentUsd: 2.4, contextVersion: 4,
          branch: 'fix/flaky-upload', handover: 'Goal: fix the flaky upload test.\nDone: saveUpload() now awaits the stream.\nNext: check the other stream writers.', messagesText: '', files: [{ path: 'src/upload.js', status: 'M' }],
          patch: '--- a/src/upload.js\n+++ b/src/upload.js\n@@\n-  stream.end();\n+  await finished(stream.end());', expiresAt: Date.now() + 120000 } };
        return { ok: true };
      });
    });
    const page = await openThread(h, side);
    const go = page.locator('#th-cards').getByRole('button', { name: 'Continue with Codex' });
    await expect(go).toBeEnabled({ timeout: 3000 });
    await go.click();
    const review = page.locator('#th-cards .th-review');
    await expect(review.locator('.th-card-title')).toHaveText('Claude → Codex');
    await expect(review.getByRole('button', { name: 'Start reviewed Codex session…' })).toBeEnabled({ timeout: 3000 });
    await shot(page, 'thread-switch-review.png');
    const sent = await h.app.evaluate(() => globalThis.__acts);
    expect(sent[0][0]).toMatchObject({ action: 'switchAi', ai: 'codex' });
    expect(Object.keys(sent[0][0]).sort()).toEqual(['action', 'ai', 'id']);
  } finally { await h.cleanup(); }
});
