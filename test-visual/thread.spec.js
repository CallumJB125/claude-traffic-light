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

async function open({ fixture = null, theme = 'light', env = GATE, shared = null, sharedReview = null, sharedProposals = null, owned = null, owner = null } = {}) {
  const h = await launchApp({ env, files: { 'sessions/thread-fixture.json': session() } });
  if (fixture) {
    // Answers the thread document only, as main does.
    await h.app.evaluate(({ ipcMain }, fixture) => {
      const mine = (e) => { try { return new URL(e.sender.getURL()).pathname.endsWith('/thread.html'); } catch { return false; } };
      for (const ch of ['thread:open', 'thread:state']) { ipcMain.removeHandler(ch); ipcMain.handle(ch, (e) => (mine(e) ? fixture : null)); }
    }, fixture);
  }
  if (shared) {
    // T2: a teammate's share. The projection is the shape src/shared-thread-view.js returns; main's own bind and read are test/shared-thread.test.js.
    await h.app.evaluate(({ ipcMain }, shared) => {
      const mine = (e) => { try { return new URL(e.sender.getURL()).pathname.endsWith('/thread.html'); } catch { return false; } };
      ipcMain.removeHandler('thread:shared-state'); ipcMain.handle('thread:shared-state', (e) => (mine(e) ? shared : null));
    }, shared);
    // T3: main's review card and my proposals, as src/thread-shared-main.js returns them (main's checks: test/shared-thread-t3.test.js).
    await h.app.evaluate(({ ipcMain }, { review, proposals }) => {
      const mine = (e) => { try { return new URL(e.sender.getURL()).pathname.endsWith('/thread.html'); } catch { return false; } };
      ipcMain.removeHandler('thread:shared-review'); ipcMain.handle('thread:shared-review', (e, id, req) => (mine(e) && review ? { ok: true, status: 'review', selection: '11111111-1111-4111-8111-111111111111', card: { ...review, op: req.op, text: req.op === 'stop' ? '' : req.text } } : null));
      ipcMain.removeHandler('thread:shared-proposals'); ipcMain.handle('thread:shared-proposals', (e) => (mine(e) ? proposals ?? { ok: true, status: 'ready', proposals: [] } : null));
    }, { review: sharedReview, proposals: sharedProposals });
  }
  if (owned) {
    // T4a: one of my own Plexiform-held sessions. The projection is the shape src/owned-thread-view.js returns; main's rows and reads are test/owned-thread-t4a.test.js.
    await h.app.evaluate(({ ipcMain }, owned) => {
      const mine = (e) => { try { return new URL(e.sender.getURL()).pathname.endsWith('/thread.html'); } catch { return false; } };
      ipcMain.removeHandler('thread:owned-state'); ipcMain.handle('thread:owned-state', (e) => (mine(e) ? owned : null));
    }, owned);
  }
  if (owner) {
    // T4: owner controls. The state and review card are the shapes src/thread-owner-main.js returns; main's checks are test/owner-thread-t4.test.js.
    await h.app.evaluate(({ ipcMain }, owner) => {
      const mine = (e) => { try { return new URL(e.sender.getURL()).pathname.endsWith('/thread.html'); } catch { return false; } };
      ipcMain.removeHandler('thread:owner-state'); ipcMain.handle('thread:owner-state', (e) => (mine(e) ? owner.state : null));
      ipcMain.removeHandler('thread:owner-review'); ipcMain.handle('thread:owner-review', (e) => (mine(e) && owner.review ? { ok: true, status: 'review', selection: '11111111-1111-4111-8111-111111111111', card: owner.review } : null));
    }, owner);
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

// ── R4-2: a terminal session's hook requests, stacked (plan-r4-2.md §4) ──
const soon = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();
const PERMISSION = () => ({ id: 'req-perm', session: 'thread-fixture', host: 'synthetic', kind: 'permission', source: 'hook', tool: 'Bash', answerable: true, actions: ['answer', 'open'],
  title: 'Allow Bash?', headline: 'npm run migrate -- --env staging', text: 'npm run migrate -- --env staging', created_at: new Date().toISOString(), expires_at: soon(),
  options: [{ id: 'allow', label: 'Allow once' }, { id: 'allow-session-0', label: 'Allow npm run migrate for this session' }, { id: 'deny', label: 'Deny' }] });
const FLAGGED_INPUT = () => ({ ...PERMISSION(), id: 'req-flag', headline: 'rm -rf build/ && git push --force', text: 'rm -rf build/ && git push --force', danger: 'it force-pushes' });
const QUESTION_INPUT = () => ({ id: 'req-q', session: 'thread-fixture', host: 'synthetic', kind: 'question', source: 'hook', tool: 'AskUserQuestion', answerable: true, actions: ['answer', 'open'],
  title: 'Retry scope', text: 'Should the retry also cover the S3 upload, or only local files?', created_at: new Date().toISOString(), expires_at: soon(), freeText: true,
  questions: [{ id: 'q0', question: 'Should the retry also cover the S3 upload, or only local files?', header: 'Retry scope', multiSelect: false, options: [{ id: 'o0', label: 'Both' }, { id: 'o1', label: 'Only local files' }] }],
  options: [{ id: 'o0', label: 'Both' }, { id: 'o1', label: 'Only local files' }, { id: 'deny', label: 'Decline to answer' }] });
// Main's thread:inputs and thread:answer-input are replaced with a fixture and a recorder, for the thread document only.
// `flagged` answers FLAGGED until an answer carries more.anyway, as main's token does.
const hookFixture = (h, inputs, { answering = true, flagged = false } = {}) => h.app.evaluate(({ ipcMain }, { inputs, answering, flagged }) => {
  globalThis.__answers = [];
  const mine = (e) => new URL(e.sender.getURL()).pathname.endsWith('/thread.html');
  for (const ch of ['thread:inputs', 'thread:answer-input']) ipcMain.removeHandler(ch);
  ipcMain.handle('thread:inputs', (e) => (mine(e) ? { inputs, answering } : null));
  ipcMain.handle('thread:answer-input', (e, ...a) => {
    if (!mine(e)) return null;
    globalThis.__answers.push(a);
    if (flagged && !(a[0].more && a[0].more.anyway === true)) return { ok: false, code: 'FLAGGED', text: 'Needs a careful look. Press Allow anyway if you mean it.' };
    return { ok: true };
  });
}, { inputs, answering, flagged });

for (const theme of ['light', 'dark']) {
  test(`hook request (${theme}): a terminal session's permission, answered in its thread`, async () => {
    const { h, side } = await open({ fixture: NATIVE, theme });
    try {
      await hookFixture(h, [PERMISSION()]);
      const page = await openThread(h, side, theme);
      const card = page.locator('#th-hooks .th-card');
      await expect(card).toHaveCount(1);
      await expect(card.locator('.th-card-title')).toHaveText('Allow Bash?');
      await expect(card.getByRole('button', { name: 'Allow once' })).toBeEnabled({ timeout: 3000 });
      await shot(page, `thread-hook-permission-${theme}.png`);
      if (theme === 'light') {
        await card.getByRole('button', { name: 'Allow once' }).click();
        await expect(card.locator('.th-card-receipt')).toHaveText('Allowed once');
        const sent = await h.app.evaluate(() => globalThis.__answers);
        expect(sent.length).toBe(1);
        expect(sent[0].length).toBe(1);
        expect(Object.keys(sent[0][0]).sort()).toEqual(['id', 'inputId', 'optionId']);
        expect(sent[0][0]).toMatchObject({ inputId: 'req-perm', optionId: 'allow' });
        expect(sent[0][0].id).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally { await h.cleanup(); }
  });
}

test('hook request flagged: main says FLAGGED, the button becomes Allow anyway, and the second click carries anyway', async () => {
  const { h, side } = await open({ fixture: NATIVE });
  try {
    await hookFixture(h, [FLAGGED_INPUT()], { flagged: true });
    const page = await openThread(h, side);
    const card = page.locator('#th-hooks .th-card');
    await expect(card.locator('.th-card-warn')).toHaveText('Needs a careful look: it force-pushes.');
    await card.getByRole('button', { name: 'Allow once' }).click({ timeout: 3000 });
    const again = card.getByRole('button', { name: 'Allow anyway' });
    await expect(again).toBeVisible();
    await expect(again).toBeEnabled({ timeout: 3000 });
    await shot(page, 'thread-hook-flagged.png');
    await again.click();
    await expect(card.locator('.th-card-receipt')).toHaveText('Allowed once');
    const sent = await h.app.evaluate(() => globalThis.__answers);
    expect(sent.map((a) => a[0].more ?? null)).toEqual([null, { anyway: true }]);
  } finally { await h.cleanup(); }
});

test('hook request question: its options, and a typed answer sent with ⌘↩', async () => {
  const { h, side } = await open({ fixture: NATIVE });
  try {
    await hookFixture(h, [QUESTION_INPUT()]);
    const page = await openThread(h, side);
    const card = page.locator('#th-hooks .th-card');
    await expect(card.getByRole('button', { name: 'Both' })).toBeEnabled({ timeout: 3000 });
    await shot(page, 'thread-hook-question.png');
    const box = card.locator('textarea');
    await expect(card.getByRole('button', { name: 'Send answer' })).toBeDisabled();
    await box.fill('Only local files for now');
    await expect(card.getByRole('button', { name: 'Send answer' })).toBeEnabled();
    await box.press('Enter');
    expect(await h.app.evaluate(() => globalThis.__answers.length)).toBe(0);
    await box.press('Meta+Enter');
    await expect(card.locator('.th-card-receipt')).toHaveText('Answer sent');
    const sent = await h.app.evaluate(() => globalThis.__answers);
    expect(sent[0][0]).toMatchObject({ inputId: 'req-q', optionId: 'answers', more: { answers: { 'Should the retry also cover the S3 upload, or only local files?': 'Only local files for now' } } });
  } finally { await h.cleanup(); }
});

test('hook request read-only: answering off shows where to answer, and Go to it', async () => {
  const { h, side } = await open({ fixture: NATIVE });
  try {
    await hookFixture(h, [PERMISSION()], { answering: false });
    const page = await openThread(h, side);
    const card = page.locator('#th-hooks .th-card');
    await expect(card.locator('.th-card-sub')).toHaveText('Answering from Plexiform is off. Use Go to it to answer in the terminal.');
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(page.locator('#th-primary')).toHaveText('Go to it');
    await shot(page, 'thread-hook-readonly.png');
  } finally { await h.cleanup(); }
});

// T2: a teammate's shared session as a read-only thread.
const SHARED_BASE = {
  header: { title: 'Fix login redirect', owner: 'Bob', initials: 'B', provider: 'Claude Code', scope: 'watch', expiresAt: null, fake: false },
  banner: true, activity: { category: 'Editing files', ageMs: 4000, stale: false }, status: 'working', generation: 3, canSendLater: false,
  deliveries: [
    { id: 'a', by: 'Alice', text: 'Can you also cover the logout path?', state: 'replied', response: 'Yes. I will add the logout case to the same test and run it again.', at: 1 },
    { id: 'b', by: 'Alice', text: 'Thanks. Ping me when it passes.', state: 'acknowledged', response: '', at: 2 },
  ],
};
const sharedOpen = (theme, shared) => open({ fixture: { kind: 'shared', header: null }, theme, shared });
for (const theme of ['light', 'dark']) {
  test(`shared thread, watch (${theme}): header line, the privacy banner first, activity, messages with receipts, a watch-only footer`, async () => {
    const { h, side } = await sharedOpen(theme, SHARED_BASE);
    try {
      const page = await openThread(h, side, theme);
      await expect(page.locator('#th-banner')).toHaveText('You see messages sent since it was shared, and its current activity. Earlier history stays private.');
      await expect(page.locator('#th-meta')).toHaveText("Bob's Claude Code session · Shared with you to watch");
      await expect(page.locator('#th-reply')).toBeHidden();
      await expect(page.locator('.th-shared-foot')).toHaveText('Shared with you to watch only. The owner can choose Allow sending.');
      await expect(page.locator('#th-sh-form')).toHaveCount(0);
      await shot(page, `thread-shared-watch-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}
// T3: an interact share. Controls are the projection's booleans and fixed reasons (src/shared-thread-view.js controlsOf).
const yes = { available: true, reason: '' }, no = (reason) => ({ available: false, reason });
const BUSY_SEND = no('A turn is running. Steer it where supported, or wait for it to finish.'), BUSY_PROPOSE = no("Bob's session is busy. Propose when it's idle.");
const interact = (provider, status, controls) => ({ ...SHARED_BASE, header: { ...SHARED_BASE.header, provider, scope: 'interact' }, status, canSendLater: true, controls });
const IDLE = interact('Codex', 'ready', { send: yes, steer: no('No current turn is available to steer.'), interrupt: no('No current turn is available to interrupt.'), propose: yes });
const BUSY_CODEX = interact('Codex', 'working', { send: BUSY_SEND, steer: yes, interrupt: yes, propose: BUSY_PROPOSE });
const BUSY_CLAUDE = interact('Claude Code', 'working', { send: BUSY_SEND, steer: no('This provider does not support steering a running turn.'), interrupt: yes, propose: BUSY_PROPOSE });
for (const theme of ['dark', 'light']) {
  test(`shared thread, interact idle (${theme}): the composer with Send as the default, the quota line, no Stop`, async () => {
    const { h, side } = await sharedOpen(theme, IDLE);
    try {
      const page = await openThread(h, side, theme);
      await expect(page.locator('#th-reply')).toBeHidden();
      await expect(page.locator('#th-sh-chip')).toHaveText('Send ▾');
      await expect(page.locator('#th-sh-text')).toHaveAttribute('placeholder', "Message Bob's session");
      await expect(page.locator('#th-sh-quota')).toHaveText("Runs on Bob's Codex account and quota.");
      await expect(page.locator('#th-sh-stop')).toBeHidden();
      await shot(page, `thread-shared-interact-idle-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}
test('shared thread, busy Codex (dark): Steer is the default, Stop is offered, the chip menu shows why the rest are off', async () => {
  const { h, side } = await sharedOpen('dark', BUSY_CODEX);
  try {
    const page = await openThread(h, side, 'dark');
    await expect(page.locator('#th-sh-chip')).toHaveText('Steer this turn ▾');
    await expect(page.locator('#th-sh-stop')).toBeVisible();
    await page.locator('#th-sh-chip').click();
    await expect(page.locator('#th-sh-menu')).toContainText("Bob's session is busy. Propose when it's idle.");
    await shot(page, 'thread-shared-interact-busy-codex-dark.png');
  } finally { await h.cleanup(); }
});
test('shared thread, busy Claude (dark): no steering, so no default; the box is off with the reason and Stop stays', async () => {
  const { h, side } = await sharedOpen('dark', BUSY_CLAUDE);
  try {
    const page = await openThread(h, side, 'dark');
    await expect(page.locator('#th-sh-text')).toBeDisabled();
    await expect(page.locator('#th-sh-note')).toHaveText('A turn is running. Steer it where supported, or wait for it to finish.');
    await expect(page.locator('#th-sh-stop')).toBeVisible();
    await shot(page, 'thread-shared-interact-busy-claude-dark.png');
  } finally { await h.cleanup(); }
});
test('shared thread, review card (dark): main\'s card for the exact text, armed before Send', async () => {
  const { h, side } = await open({ fixture: { kind: 'shared', header: null }, theme: 'dark', shared: IDLE,
    sharedReview: { title: "Send to Bob's session", target: "Bob's Codex session", notes: [], confirm: 'Send', armMs: 600 } });
  try {
    const page = await openThread(h, side, 'dark');
    await page.locator('#th-sh-text').fill('Please also run the logout test before you push.');
    await page.locator('#th-sh-go').click();
    await expect(page.locator('#th-sh-card .th-card-title')).toHaveText("Send to Bob's session");
    await expect(page.locator('#th-sh-yes')).toBeEnabled();
    await shot(page, 'thread-shared-review-card-dark.png');
  } finally { await h.cleanup(); }
});
test('shared thread, stop card (dark): this current turn only, no text', async () => {
  const { h, side } = await open({ fixture: { kind: 'shared', header: null }, theme: 'dark', shared: BUSY_CODEX,
    sharedReview: { title: "Stop Bob's current turn", target: "Bob's Codex session · this current turn only", notes: ['Asks the provider to stop the current turn. Work already done stays.'], confirm: 'Stop turn', armMs: 600 } });
  try {
    const page = await openThread(h, side, 'dark');
    await page.locator('#th-sh-stop').click();
    await expect(page.locator('#th-sh-card .th-card-title')).toHaveText("Stop Bob's current turn");
    await expect(page.locator('#th-sh-yes')).toBeEnabled();
    await shot(page, 'thread-shared-stop-card-dark.png');
  } finally { await h.cleanup(); }
});
test('shared thread, approved proposal (dark): my proposal\'s chip and [Send approved message]', async () => {
  const card = { op: 'send-approved', title: "Send Bob's approved message", text: 'Run the migration on staging.', target: "Bob's Codex session", notes: [], confirm: 'Send approved message', armMs: 600 };
  const { h, side } = await open({ fixture: { kind: 'shared', header: null }, theme: 'dark', shared: IDLE, sharedProposals: { ok: true, status: 'ready', proposals: [
    { status: 'approved', title: 'From Alice', text: 'Run the migration on staging.', expiresAt: null, receipt: null, action: { selection: '22222222-2222-4222-8222-222222222222', card } }] } });
  try {
    const page = await openThread(h, side, 'dark');
    await expect(page.locator('#th-sh-proposals .th-chip')).toHaveText('Approved, one send');
    await expect(page.getByRole('button', { name: 'Send approved message' })).toBeEnabled();
    await shot(page, 'thread-shared-proposal-approved-dark.png');
  } finally { await h.cleanup(); }
});
test('shared thread, gone (dark): the body is dropped and the way back is offered', async () => {
  const { h, side } = await sharedOpen('dark', { gone: true, reason: 'removed' });
  try {
    const page = await openThread(h, side, 'dark');
    await expect(page.locator('#th-title')).toHaveText('This session is no longer shared with you.');
    await expect(page.locator('.th-msg')).toHaveCount(0);
    await shot(page, 'thread-shared-gone-dark.png');
  } finally { await h.cleanup(); }
});

// T4a: my own Plexiform-held sessions (plan-t4a §3): T2's layout, no prompt box, the way to Overview.
const OWNED_CODEX = {
  header: { title: 'Add retries to the invoice export', provider: 'Codex', channel: false },
  activity: { category: 'Running a command', ageMs: 6000, stale: false }, status: 'working',
  deliveries: [
    { id: 'a', by: null, text: 'Add a retry with backoff to the invoice export.', state: 'replied', response: 'Added three retries with backoff to exportInvoices(). The export tests pass.', at: 1 },
    { id: 'b', by: null, text: 'Now log each retry.', state: 'acknowledged', response: '', at: 2 },
  ],
};
const OWNED_CHANNEL = {
  header: { title: 'Plexiform channel', provider: 'Claude Code', channel: true },
  activity: { category: null, ageMs: null, stale: false }, status: 'ready', deliveries: [],
};
const ownedOpen = (theme, owned) => open({ fixture: { kind: 'owned', header: null }, theme, owned });
test('owned thread, Codex (dark): Started from Overview, activity, messages with receipts, no prompt box', async () => {
  const { h, side } = await ownedOpen('dark', OWNED_CODEX);
  try {
    const page = await openThread(h, side, 'dark');
    await expect(page.locator('#th-meta')).toHaveText('Codex session · Started from Overview');
    await expect(page.locator('.th-shared-foot .th-shared-note')).toHaveText('Started from Overview. To message it, use Overview.');
    await expect(page.locator('#th-ow-overview')).toHaveText('Open in Overview');
    await expect(page.locator('#th-reply')).toBeHidden();
    await expect(page.locator('textarea:visible')).toHaveCount(0);
    await shot(page, 'thread-owned-codex-dark.png');
  } finally { await h.cleanup(); }
});
test('owned thread, Plexiform channel (light): its own title, nothing sent yet', async () => {
  const { h, side } = await ownedOpen('light', OWNED_CHANNEL);
  try {
    const page = await openThread(h, side, 'light');
    await expect(page.locator('#th-title')).toHaveText('Plexiform channel');
    await expect(page.locator('#th-meta')).toHaveText('Claude Code in your terminal · Connected from Overview');
    await expect(page.locator('.th-shared-empty')).toHaveText('No messages have been sent to it yet.');
    await expect(page.locator('.th-shared-foot .th-shared-note')).toHaveText('Connected from Overview. To message it, use Overview.');
    await shot(page, 'thread-owned-claude-light.png');
  } finally { await h.cleanup(); }
});
test('owned thread, gone (dark): ended when Overview reloaded, nothing kept', async () => {
  const { h, side } = await ownedOpen('dark', { gone: true, reason: 'overview' });
  try {
    const page = await openThread(h, side, 'dark');
    await expect(page.locator('#th-empty-title')).toHaveText('This session ended when Overview reloaded.');
    await expect(page.locator('.th-msg')).toHaveCount(0);
    await shot(page, 'thread-owned-gone-dark.png');
  } finally { await h.cleanup(); }
});

// T4: owner controls on my own thread (plan-t4 Rev 3 §3, Rev 4 grouping).
const K = (c) => c.repeat(32);
const OWNER_WATCH = { shareable: true, available: true, provider: 'Codex', reason: '', teams: [{ key: K('1'), name: 'Design team' }, { key: K('2'), name: 'Platform' }],
  shares: [{ key: K('3'), team: 'Design team', scope: 'watch', expiresAt: null, automatic: false, members: 4 }], groups: [], others: [] };
const OWNER_PROPOSAL = { ...OWNER_WATCH, shares: [{ ...OWNER_WATCH.shares[0], scope: 'interact' }],
  groups: [{ requester: 'Alex', latest: { key: K('5'), text: 'Run the export tests again with the retry logging on, and paste the failures.', version: 3, status: 'awaiting' },
    earlier: [{ key: K('6'), text: 'Run the export tests.', version: 1 }, { key: K('7'), text: 'Add logging to each retry.', version: 2 }], more: 0, rejectAll: K('8') }], others: [] };
const OWNER_APPROVED = { ...OWNER_PROPOSAL, groups: [], others: [{ key: K('9'), requester: 'Alex', status: 'approved', expiresAt: Date.UTC(2026, 10, 2, 15, 40) }] };
const ownerOpen = (theme, state, review = null) => open({ fixture: { kind: 'owned', header: null }, theme, owned: OWNED_CODEX, owner: { state, review } });
for (const theme of ['dark', 'light']) {
  test(`owner: shared with a team, watch only (${theme})`, async () => {
    const { h, side } = await ownerOpen(theme, OWNER_WATCH);
    try {
      const page = await openThread(h, side, theme);
      await expect(page.locator('#th-owner-line .th-own-share-text')).toHaveText('Shared with Design team · Watch only · until you stop it · 4 members');
      await expect(page.getByRole('button', { name: 'Allow sending' })).toBeVisible();
      await expect(page.locator('#th-more')).toBeVisible();
      await shot(page, `thread-owner-shared-watch-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}
test('owner: Share with team… then the review card (dark)', async () => {
  const { h, side } = await ownerOpen('dark', OWNER_WATCH, { op: 'share', title: 'Share this session with Platform', text: '', scope: 'Watch only',
    notes: ['Platform members can read this session and its replies until you stop sharing.', 'They cannot send to it.'], confirm: 'Share', armMs: 600 });
  try {
    const page = await openThread(h, side, 'dark');
    await page.locator('#th-more').click();
    await page.locator('#th-share').click();
    await expect(page.locator('#th-own-scope')).toHaveValue('watch');
    await page.locator('#th-own-team').selectOption({ label: 'Platform' });
    await page.locator('#th-own-continue').click();
    await expect(page.locator('#th-own-yes')).toHaveText('Share');
    await expect(page.locator('#th-own-yes')).toBeEnabled();
    await shot(page, 'thread-owner-share-review-dark.png');
  } finally { await h.cleanup(); }
});
test('owner: one card for a teammate, earlier ones folded, Reject all (dark)', async () => {
  const { h, side } = await ownerOpen('dark', OWNER_PROPOSAL);
  try {
    const page = await openThread(h, side, 'dark');
    await expect(page.locator('.th-own-proposal .th-card-title')).toHaveText('Alex proposes a message');
    await expect(page.locator('.th-own-earlier summary')).toHaveText('2 earlier from Alex');
    await page.locator('.th-own-earlier summary').click();
    await expect(page.getByRole('button', { name: 'Reject all 3 from Alex' })).toBeVisible();
    await shot(page, 'thread-owner-proposal-dark.png');
  } finally { await h.cleanup(); }
});
test('owner: approved for one send, with Revoke (dark)', async () => {
  const { h, side } = await ownerOpen('dark', OWNER_APPROVED);
  try {
    const page = await openThread(h, side, 'dark');
    await expect(page.locator('.th-own-done')).toContainText('Alex: approved for one send until');
    await expect(page.getByRole('button', { name: 'Revoke' })).toBeVisible();
    await shot(page, 'thread-owner-proposal-approved-dark.png');
  } finally { await h.cleanup(); }
});
