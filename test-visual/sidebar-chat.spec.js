'use strict';
// Redesign R1: the chat-first sidebar behind the dev-only preview gate
// (CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW=1; launchApp's --demo visual makes it a
// dev run). Session rows are fixed: main's overview:state answer is replaced
// with a fixed projection (the shape src/overview-sidebar-rows.js returns), so
// the shots need no sessions, hooks or hub, and every age is pinned.
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile, snapToPixels } = require('./app');

const id = (n) => n.toString(16).padStart(64, '0');
const ROWS = [
  { id: id(1), bucket: 'needs', title: 'Answer the migration question', project: 'billing', origin: 'iTerm', age_ms: 120000, team: false, terminal: true },
  { id: id(2), bucket: 'needs', title: 'Approve the deploy to staging', project: 'website', origin: 'Terminal', age_ms: 45000, team: true, terminal: true },
  { id: id(3), bucket: 'working', title: 'Refactor the invoice importer', project: 'billing', origin: 'Terminal', age_ms: 8000, team: false, terminal: true },
  { id: id(4), bucket: 'working', title: 'Claude session in api', project: 'api', origin: null, age_ms: 30000, team: false, terminal: true },
  { id: id(5), bucket: 'check', title: 'Fix the flaky upload test', project: 'api', origin: 'iTerm', age_ms: 900000, team: false, terminal: true },
  { id: id(6), bucket: 'stuck', title: 'Codex session in website', project: 'website', origin: 'iTerm', age_ms: 600000, team: false, terminal: true },
  { id: id(7), bucket: 'idle', title: 'Write the release notes', project: 'docs', origin: null, age_ms: 7200000, team: false, terminal: true },
];

// One app per test: the gate is read once at boot, and each test needs its own rows.
async function open({ rows = ROWS, theme = 'dark', env = { CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW: '1' }, config = {}, team = null, reads = null } = {}) {
  const h = await launchApp({ env, config });
  if (reads) {
    // T4a: one payload per read (the last repeats), so a later read can end an owned row.
    await h.app.evaluate(({ ipcMain }, reads) => {
      let n = 0;
      ipcMain.removeHandler('overview:state');
      ipcMain.handle('overview:state', (e) => (/\/buddy-window\/sidebar\.html$/.test(e.sender.getURL()) ? reads[Math.min(n++, reads.length - 1)] : null));
    }, reads);
  } else if (rows) {
    // Answers the sidebar document only, as main does; nothing else in these shots reads it.
    await h.app.evaluate(({ ipcMain }, rows) => {
      ipcMain.removeHandler('overview:state');
      ipcMain.handle('overview:state', (e) => (/\/buddy-window\/sidebar\.html$/.test(e.sender.getURL()) ? { schema: 1, status: 'complete', sessions: rows } : null));
    }, rows);
  }
  if (team) {
    // T1: teammates' rows, the fixed shape src/overview-sidebar-rows.js teamRows returns; one payload per read, the last repeats.
    await h.app.evaluate(({ ipcMain }, team) => {
      let n = 0;
      ipcMain.removeHandler('sidebar:team-rows');
      ipcMain.handle('sidebar:team-rows', (e) => (/\/buddy-window\/sidebar\.html$/.test(e.sender.getURL()) ? team[Math.min(n++, team.length - 1)] : null));
    }, team);
  }
  const widget = await windowByFile(h.app, 'index.html');
  await widget.evaluate(() => window.trafficLight.openHelp());
  h.widget = widget;
  const side = await windowByFile(h.app, 'sidebar.html');
  await side.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await side.waitForFunction(() => !!window.buddy);
  await side.evaluate(() => document.fonts.ready);
  // openHelp() leaves Help in the content area, which no footer row stands for: wait until the
  // footer says so (the sidebar starts from 'board' until it learns the page) before any shot.
  // Board isn't selected on purpose: its hub status line changes as the hub starts.
  if (env.CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW) {
    await expect(side.locator('#nav-foot .sb-foot')).toHaveCount(3); // built (it starts empty), so the next check isn't vacuous
    await expect(side.locator('#nav-foot [aria-current]')).toHaveCount(0);
  }
  return { h, side };
}
const shot = async (locator, name) => expect(await snapToPixels(locator)).toHaveScreenshot(name);

test('flag off: the ordinary sidebar, no tree, no chat-first rules', async () => {
  const { h, side } = await open({ rows: null, env: {} });
  try {
    await expect(side.locator('#nav .nav-section').first()).toBeVisible();
    await expect(side.locator('[role="tree"]')).toHaveCount(0);
    await expect(side.locator('.sidebar[data-chat-first]')).toHaveCount(0);
    expect(await side.evaluate(() => [...document.scripts].map((s) => s.getAttribute('src')))).toEqual(['sidebar.js']);
  } finally { await h.cleanup(); }
});

for (const theme of ['light', 'dark']) {
  test(`buckets (${theme}): groups in order, Idle folded, Needs you open`, async () => {
    const { h, side } = await open({ theme });
    try {
      const tree = side.locator('[role="tree"]');
      await expect(tree.locator('.sb-group')).toHaveCount(5);
      await expect(tree.locator('.sb-group-label')).toHaveText(['Needs you', 'Working on it', 'Check it', 'Stuck or failed', 'Idle']);
      await expect(tree.locator('[data-key="g:idle"]')).toHaveAttribute('aria-expanded', 'false');
      await shot(side.locator('.sidebar'), `sidebar-buckets-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}

test('C4 chats off (dark): no New chat and no Chats filter; the rows are the same', async () => {
  const { h, side } = await open({ config: { homeComposer: false } });
  try {
    await expect(side.locator('.sb-new')).toBeHidden();
    await expect(side.locator('.sb-filter-opt:visible')).toHaveText(['All', 'In terminals', 'Team']);
    await expect(side.locator('[role="tree"] .sb-group')).toHaveCount(5);
    await shot(side.locator('.sidebar'), 'sidebar-chats-off-dark.png');
  } finally { await h.cleanup(); }
});

test('empty: one sentence and How to connect a tool', async () => {
  const { h, side } = await open({ rows: [] });
  try {
    await expect(side.locator('#sb-empty')).toHaveText('No chats or sessions yet. Run claude or codex in any terminal and it shows up here.');
    await expect(side.locator('#sb-connect')).toBeVisible();
    await expect(side.locator('.sb-group')).toHaveCount(0);
    await shot(side.locator('.sidebar'), 'sidebar-empty.png');
  } finally { await h.cleanup(); }
});

for (const theme of ['light', 'dark']) {
  test(`a focused, selected row shows the inset ring, unclipped (${theme})`, async () => {
    const { h, side } = await open({ theme });
    try {
      const row = side.locator(`[data-key="r:${id(1)}"]`);
      await row.click(); // selects it; Overview opens in the content area and takes focus
      // Back to the sidebar, as a person tabbing or clicking back would.
      await h.app.evaluate(({ webContents }) => { webContents.getAllWebContents().find((w) => w.getURL().endsWith('/buddy-window/sidebar.html'))?.focus(); });
      await side.locator(`[data-key="g:needs"]`).focus();
      await side.keyboard.press('ArrowDown'); // keyboard focus → :focus-visible
      await expect(row).toBeFocused();
      await expect(row).toHaveAttribute('aria-selected', 'true');
      const ring = await row.evaluate((n) => { const s = getComputedStyle(n); return [s.outlineOffset, s.outlineStyle, s.boxShadow.includes('inset')]; });
      expect(ring).toEqual(['-4px', 'solid', true]);
      await shot(side.locator('.sb-group[data-bucket="needs"]'), `sidebar-row-focused-selected-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}

test('keyboard and structure: the tree is one tab stop, arrows move, the aria tree reads right', async () => {
  const { h, side } = await open();
  try {
    const tree = side.locator('[role="tree"]');
    await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
    await tree.locator('[tabindex="0"]').focus();
    await side.keyboard.press('ArrowRight');
    await expect(side.locator(`[data-key="r:${id(1)}"]`)).toBeFocused();
    await side.keyboard.press('End');
    await expect(side.locator('[data-key="g:idle"]')).toBeFocused();
    await side.keyboard.press('ArrowRight');
    await expect(side.locator('[data-key="g:idle"]')).toHaveAttribute('aria-expanded', 'true');
    await side.keyboard.press('ArrowLeft');
    await expect(side.locator('[data-key="g:idle"]')).toHaveAttribute('aria-expanded', 'false');
    // Ages show on hover or selection only, so they are not in the names.
    await expect(tree).toMatchAriaSnapshot(`
      - tree "Sessions":
        - treeitem "Needs you, 2" [expanded] [level=1]:
          - text: Needs you
          - group:
            - treeitem "Answer the migration question billing · iTerm" [level=2]
            - treeitem "Approve the deploy to staging website · Terminal" [level=2]
        - treeitem "Working on it, 2" [expanded] [level=1]:
          - text: Working on it
          - group:
            - treeitem "Refactor the invoice importer billing · Terminal" [level=2]
            - treeitem "Claude session in api api" [level=2]
        - treeitem "Check it, 1" [expanded] [level=1]:
          - text: Check it
          - group:
            - treeitem "Fix the flaky upload test api · iTerm" [level=2]
        - treeitem "Stuck or failed, 1" [expanded] [level=1]:
          - text: Stuck or failed
          - group:
            - treeitem "Codex session in website website · iTerm" [level=2]
        - treeitem "Idle, 1" [level=1]: Idle
    `);
    // A redirect from outside the sidebar: the widget's mail button opens 'sessions', which lands on In terminals.
    await side.locator('[data-filter="team"]').click();
    await h.widget.evaluate(() => window.trafficLight.openMail());
    await expect(side.locator('.sb-filter-opt[aria-checked="true"]')).toHaveAttribute('data-filter', 'terminals');
  } finally { await h.cleanup(); }
});

test('640 px: the window at its narrowest has no horizontal scroll in the sidebar', async () => {
  const { h, side } = await open();
  try {
    await h.app.evaluate(({ BaseWindow }) => { for (const w of BaseWindow.getAllWindows()) if (w.getMinimumSize()[0] === 760) w.setSize(760, 640); });
    await expect.poll(() => side.evaluate(() => { const n = document.querySelector('.sidebar'); return n.scrollWidth <= n.clientWidth; })).toBe(true);
    // Every filter label is whole: none clipped or squeezed.
    expect(await side.evaluate(() => [...document.querySelectorAll('.sb-filter-opt')].filter((n) => n.scrollWidth > n.clientWidth).map((n) => n.textContent))).toEqual([]);
    expect(await side.evaluate(() => { const f = document.querySelector('.sb-filter'); return f.scrollWidth <= f.clientWidth; })).toBe(true);
    const over = await side.evaluate(() => [...document.querySelectorAll('.sidebar *')].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === 'visible' && n.clientWidth > 0).map((n) => n.className));
    expect(over).toEqual([]);
  } finally { await h.cleanup(); }
});

// ── T1: teammates' shared sessions under the Team filter ───────────────────
const VIEWER = 'a'.repeat(64);
const mate = (n, over) => ({ id: `${'c'.repeat(62)}${n.toString(16).padStart(2, '0')}`, person: 'Bob Stone', initials: 'BS', team: 'Dev team', title: 'Review the billing migration', provider: 'Claude Code', bucket: 'working', freshness: 'recent', age_ms: 60000, scope: 'watch', inbox: false, ...over });
const SHARED = [
  mate(1, { bucket: 'needs', title: 'Pick the retry policy', scope: 'interact' }),
  mate(2, { freshness: 'stale', bucket: 'idle', title: 'Draft the changelog' }),
  mate(3, { person: 'Ann Lee', initials: 'AL', provider: 'Codex', title: 'Port the CSV exporter' }),
  mate(4, { person: 'Ann Lee', initials: 'AL', provider: 'Codex', title: 'Benchmark the parser', bucket: 'check' }),
];
const teamPayload = (rows, over = {}) => ({ schema: 1, status: 'complete', viewer: VIEWER, teams: [{ name: 'Dev team' }], teamsTotal: 1, rows, ...over });
async function teamFilter(side) {
  await side.locator('.sb-filter-opt[data-filter="team"]').click();
}
for (const theme of ['dark', 'light']) {
  test(`T1 team (${theme}): my team work, then Shared with you by person; watch and send, stale and a tombstone`, async () => {
    // The second read drops Ann's exporter: it becomes a tombstone (no title).
    const { h, side } = await open({ theme, team: [teamPayload(SHARED), teamPayload(SHARED.filter((r) => r.title !== 'Port the CSV exporter'))] });
    try {
      await teamFilter(side);
      await expect(side.locator('.sb-shared')).toHaveCount(4);
      await side.locator('.sb-filter-opt[data-filter="all"]').click();
      await teamFilter(side);
      await expect(side.locator('.sb-gone')).toHaveCount(1);
      await expect(side.locator('.sb-gone .sb-title')).toHaveText("Ann Lee's Codex session");
      await expect(side.locator('.sb-group[aria-level="1"] > .sb-group-head .sb-group-label')).toHaveText(['Your team work', 'Shared with you']);
      await expect(side.locator('.sb-group[aria-level="2"] .sb-person')).toHaveText(['Bob Stone', 'Ann Lee']);
      await side.locator('.sb-filter-opt[data-filter="team"]').blur();
      await shot(side.locator('.sidebar'), `sidebar-team-shared-${theme}.png`);
    } finally { await h.cleanup(); }
  });
}

test('T1 team empty (dark): no team yet, one sentence and Account & team', async () => {
  const { h, side } = await open({ rows: [], team: [teamPayload([], { teams: [], teamsTotal: 0 })] });
  try {
    await teamFilter(side);
    await expect(side.locator('#sb-empty')).toHaveText("Join a team to see teammates' shared sessions.");
    await expect(side.locator('#sb-team-join')).toBeVisible();
    await side.locator('.sb-filter-opt[data-filter="team"]').blur();
    await shot(side.locator('.sidebar'), 'sidebar-team-empty-dark.png');
  } finally { await h.cleanup(); }
});

// T4a: my own Plexiform-held sessions sit with the other rows; an owned row main ended stays in place as a tombstone.
test('owned rows (dark): a Plexiform channel row, and one that ended when Overview reloaded', async () => {
  const owned = (n, title, bucket) => ({ id: id(n), bucket, title, project: n === 21 ? 'billing' : '', origin: null, age_ms: 20000, team: false, terminal: false, chat: false, thread: true });
  const first = [...ROWS.slice(0, 4), owned(20, 'Plexiform channel', 'working'), owned(21, 'Codex session in billing', 'working')];
  const reads = [{ schema: 1, status: 'complete', sessions: first, ended: [] },
    { schema: 1, status: 'complete', sessions: first.filter((r) => r.id !== id(21)), ended: [{ id: id(21), reason: 'overview' }] }];
  const { h, side } = await open({ reads });
  try {
    await expect(side.locator('.sb-gone')).toHaveCount(1, { timeout: 15000 });
    await expect(side.locator('.sb-gone .sb-meta')).toHaveText('Ended when Overview reloaded');
    await expect(side.locator('.sb-group[data-bucket="working"] .sb-title')).toHaveText(['Refactor the invoice importer', 'Claude session in api', 'Plexiform channel', 'Codex session in billing']);
    await shot(side.locator('.sidebar'), 'sidebar-owned-row-dark.png');
  } finally { await h.cleanup(); }
});
