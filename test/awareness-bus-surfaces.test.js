'use strict';
// Step 3's visible surfaces (plan-agent-awareness §3.4, §3.9; findings §9.6-§9.7):
// the roster's Tools line names only what the viewer can call; Home shows what
// Plexiform registered (with Undo) and the Codex approvals it cannot give;
// Health has a row for each registration and the Codex hook.
const test = require('node:test');
const assert = require('node:assert/strict');
const Hook = require('../hooks/awareness.js');
const Health = require('../src/health.js');
const { createHomeAlerts } = require('../src/home-alerts.js');
const Inbox = require('../src/attention-inbox.js');

const peer = (i, extra = {}) => ({ handle: `codex-site${i}-${(0x1000 + i).toString(16)}`, provider: 'codex', folder: `site${i}`, repo_key: null, branch: null, status: 'working', waiting_on: null, ...extra });
const self = (caps) => ({ handle: 'claude-app-a1e0', allowed: true, interactive: true, caps, repo_key: null });

test('the Tools line appears only when this viewer\'s provider has the bus tools, and never bus_note before notes ship', () => {
  const roster = { peers: [peer(1)], groups: [] };
  const off = Hook.render(Hook.viewOf(roster, self({ mcp: false, notes: false })));
  assert.ok(!/Tools:/.test(off));
  assert.match(off, /You are claude-app-a1e0\.$/);
  const on = Hook.render(Hook.viewOf(roster, self({ mcp: true, notes: true })));
  assert.match(on, /\nYou are claude-app-a1e0\. Tools: bus_peers, bus_handoff\.$/);
  assert.ok(!/bus_note/.test(on));
  // No handle (a miss in self) still names the tools; a forged caps value that is not `true` does not.
  assert.match(Hook.render(Hook.viewOf(roster, { caps: { mcp: true } })), /\nTools: bus_peers, bus_handoff\.$/);
  assert.ok(!/Tools:/.test(Hook.render(Hook.viewOf(roster, self({ mcp: 'yes' })))));
  // Turning the tools on is a roster change for this viewer (it is told once), not on every turn.
  assert.notEqual(Hook.versionOf(Hook.viewOf(roster, self({ mcp: true }))), Hook.versionOf(Hook.viewOf(roster, self({ mcp: false }))));
  // Only the header is bracketed.
  assert.deepEqual(on.split('\n').filter((l) => l.startsWith('[')), [Hook.HEADER]);
});

test('AW5 with the Tools line: at most 8 peer lines and 1000 characters, then "and N more (bus_peers)"', () => {
  const roster = { peers: Array.from({ length: 30 }, (_, i) => peer(i, { folder: `a-very-long-folder${i}` })), groups: [] };
  const text = Hook.render(Hook.viewOf(roster, self({ mcp: true })));
  assert.ok(text.length <= Hook.BLOCK_MAX, String(text.length));
  assert.ok(text.split('\n').filter((l) => l.startsWith('- codex-')).length <= Hook.MAX_LINES);
  assert.match(text, /\n- and \d+ more \(bus_peers\)\n/);
  assert.match(Hook.render(Hook.viewOf(roster, self({ mcp: false }))), /\n- and \d+ more\n/);
});

test('Home: the bus notices are cards with exactly their own action; Undo goes to main, a stale card is refused', async () => {
  const acted = [];
  let notices = [
    { handle: 'bus-added', action: 'undo', title: 'Plexiform added its agent bus tools to Claude Code and Codex', meta: 'So your AI sessions can see each other.' },
    { handle: 'bus-codex-hook', action: 'dismiss', title: "Approve Plexiform's Codex hook in Codex (/hooks)", meta: 'Codex runs a new hook only after you approve it.' },
    { handle: 'evil', action: 'run', title: 'x' },
  ];
  const alerts = createHomeAlerts({ busNotices: () => notices, busAct: async (h, a) => { acted.push([h, a]); return { ok: true }; } });
  const snap = alerts.snapshot();
  assert.deepEqual(snap.bus.map((c) => [c.handle, c.action]), [['bus-added', 'undo'], ['bus-codex-hook', 'dismiss']]);
  assert.deepEqual(await alerts.act('bus', 'undo', 'bus-added'), { ok: true });
  assert.deepEqual(await alerts.act('bus', 'dismiss', 'bus-codex-hook'), { ok: true });
  assert.equal((await alerts.act('bus', 'undo', 'bus-codex-hook')).ok, false, 'not that card\'s action');
  assert.equal((await alerts.act('bus', 'run', 'evil')).ok, false);
  notices = [];
  assert.equal((await alerts.act('bus', 'undo', 'bus-added')).ok, false, 'gone');
  assert.deepEqual(acted, [['bus-added', 'undo'], ['bus-codex-hook', 'dismiss']]);
  // The Inbox row carries the one action.
  const rows = Inbox.compose({ alerts: snap }).items.filter((r) => r.kind === 'setup');
  assert.deepEqual(rows.map((r) => [r.title, r.action.alert, r.action.op, r.action.label]), [
    ['Plexiform added its agent bus tools to Claude Code and Codex', 'bus', 'undo', 'Undo'],
    ["Approve Plexiform's Codex hook in Codex (/hooks)", 'bus', 'dismiss', 'Dismiss'],
  ]);
  assert.equal(Inbox.LABEL.setup, 'Plexiform');
  // The preload lets exactly these through.
  const preload = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'home-preload.js'), 'utf8');
  assert.match(preload, /'burst', 'bus'\]\.includes\(kind\)/);
  assert.match(preload, /'act', 'undo'\]\.includes\(action\)/);
});

test('Health: one row per bus registration and one for the Codex hook; none from the MCP server\'s own health', () => {
  const rows = (busMcp) => Health.runChecks({ busMcp }).checks.filter((c) => c.id.startsWith('bus-')).map((c) => [c.id, c.status, c.detail]);
  const ok = rows({ claude: { state: 'ours' }, codex: { state: 'ours' }, codexHook: { state: 'needs-approval' } });
  assert.deepEqual(ok.map((r) => r.slice(0, 2)), [['bus-mcp-claude', 'ok'], ['bus-mcp-codex', 'ok'], ['bus-codex-hook', 'warn']]);
  assert.match(ok[1][2], /Codex asks you before each bus_handoff/);
  assert.equal(ok[2][2], "Approve Plexiform's Codex hook in Codex (/hooks).");
  const bad = rows({ claude: { state: 'foreign' }, codex: { state: 'mismatch' }, codexHook: { state: 'off' } });
  assert.deepEqual(bad.map((r) => r.slice(0, 2)), [['bus-mcp-claude', 'warn'], ['bus-mcp-codex', 'warn']]);
  assert.deepEqual(rows(null), []);
  assert.deepEqual(rows({ claude: { state: 'unknown' }, codex: { state: 'unknown' }, codexHook: { state: 'unknown' } }), []);
  assert.deepEqual(rows({ claude: { state: 'full' }, codex: { state: 'missing' }, codexHook: { state: 'approved' } }).map((r) => r.slice(0, 2)), [['bus-mcp-claude', 'ok'], ['bus-mcp-codex', 'info'], ['bus-codex-hook', 'ok']]);
});
