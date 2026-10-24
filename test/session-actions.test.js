'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Actions = require('../src/session-actions.js');
const Links = require('../src/session-links.js');
const { createSessionBoards } = require('../buddy-window/session-boards.js');
const { testTempDir } = require('./helpers/tmp');

const CWD = '/Users/me/work/app';
const row = (over = {}) => ({ source: 'codex', sessionId: 's1', cwd: CWD, ...over });
function rig(over = {}) {
  const dir = testTempDir('sact-');
  const links = Links.create({ file: path.join(dir, 'l.json') });
  const log = { clip: [], pages: [], linked: [], created: [], captured: [] };
  const a = Actions.create({
    sessions: () => [row()], repoOf: async () => 'github.com/org/app', rootOf: async (c) => c,
    boards: { boards: async () => [{ key: 'local', label: 'My board', kind: 'local' }], linkRepo: async (b, c) => { log.linked.push([b, c]); return { ok: true }; },
      captureKey: async (b) => (b === 'unlinked' ? null : b), searchCards: async () => [{ card_id: 'c1', card_key: 'APP-1', title: 'Fix it', board: 'My board', boardKey: 'local' }], destinationOf: () => ({ kind: 'local' }) },
    capture: { captureOnce: async (r, k) => { log.captured.push(k); return { ok: true, card_id: 'x' }; } }, links,
    tasks: () => ({ composerInfo: async () => ({ ais: [{ id: 'claude', label: 'Claude', installed: true, loggedIn: true }, { id: 'codex', label: 'Codex', installed: false, loggedIn: null }] }),
      registerFolder: (p) => ({ handle: `h:${p}` }), create: async (d) => { log.created.push(d); return { ok: true, id: 't' }; } }),
    clipboard: { writeText: (t) => log.clip.push(t) }, pickFolder: async () => '/Users/me/other', openPage: (id) => log.pages.push(id), ...over,
  });
  return { a, log, links };
}

test('SCOPE_RULE equals the board Team page sentence', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'board/web/js/render-team.js'), 'utf8');
  assert.ok(src.includes(`SCOPE_RULE = '${Actions.SCOPE_RULE}'`));
});
test('setup lists boards, seen repos and only ready AIs; the page gets handles, never paths', async () => {
  const { a } = rig(); const s = await a.setup();
  assert.equal(s.repos[0].label, 'app'); assert.equal(s.ais.find((x) => x.id === 'codex').ready, false);
  assert.equal(s.ais.find((x) => x.id === 'claude').ready, true); assert.equal(JSON.stringify(s).includes('/Users/me'), false);
});
test('link repo: a folder handle becomes the canonical repo on the chosen board, with the sharing rule', async () => {
  const { a, log } = rig(); const s = await a.setup();
  const r = await a.linkRepo({ folder: s.repos[0].handle, board: 'local' });
  assert.equal(r.ok, true); assert.deepEqual(log.linked, [['local', 'github.com/org/app']]); assert.ok(r.text.includes(Actions.SCOPE_RULE));
  assert.equal((await a.linkRepo({ folder: 'nope', board: 'local' })).ok, false);
});
test('link repo without a git remote says so and calls nothing', async () => {
  const { a, log } = rig({ repoOf: async () => null }); const s = await a.setup();
  const r = await a.linkRepo({ folder: s.repos[0].handle, board: 'local' }); assert.equal(r.ok, false); assert.equal(log.linked.length, 0);
});
test('start session: prompt launches via the tasks launcher in a terminal tab; no prompt or no launcher copies the command', async () => {
  const { a, log } = rig(); const s = await a.setup(); const f = s.repos[0].handle;
  let r = await a.startSession({ folder: f, ai: 'claude', prompt: 'fix the bug' });
  assert.equal(r.ok, true); assert.equal(log.created[0].surface, 'tab'); assert.equal(log.created[0].text, 'fix the bug'); assert.equal(log.clip.length, 0);
  r = await a.startSession({ folder: f, ai: 'claude', prompt: '' });
  assert.equal(r.copied, true); assert.equal(log.clip[0], `cd '${CWD}' && claude`); assert.match(r.text, /copied/);
  r = await a.startSession({ folder: f, ai: 'cursor', prompt: 'x' }); assert.equal(r.ok, false);
  const down = rig({ tasks: () => ({ composerInfo: async () => ({ ais: [] }), registerFolder: () => ({ handle: 'h' }), create: async () => ({ ok: false }) }) });
  r = await down.a.startSession({ folder: (await down.a.setup()).repos[0].handle, ai: 'codex', prompt: 'x' }); assert.equal(r.copied, true);
});
test('make a card: needs the repo linked to a team board, dedupes against an attachment', async () => {
  const { a, log, links } = rig(); const handle = a.rowInfo(row()).handle;
  assert.equal((await a.makeCard(handle, 'unlinked')).needsLink, true);
  assert.equal((await a.makeCard(handle, 'local')).ok, true); assert.deepEqual(log.captured, ['local']);
  links.attach({ provider: 'codex', session_id: 's1', card_id: 'c1', card_key: 'APP-1', destination: { kind: 'local' } });
  const again = await a.makeCard(handle, 'local'); assert.equal(again.existing, true); assert.equal(log.captured.length, 1);
});
test('attach: search then attach stores the link locally and says it is local only', async () => {
  const { a, links } = rig(); const handle = a.rowInfo(row()).handle;
  const found = await a.searchCards('fix'); const r = a.attach(handle, found[0].ref);
  assert.equal(r.ok, true); assert.match(r.text, /this computer only/); assert.equal(links.forSession('codex', 's1').card_id, 'c1');
  assert.equal(a.rowInfo(row()).card.label, 'APP-1 Fix it'); assert.equal(a.attach(handle, 'bad').ok, false);
});
test('connect opens the AI tools page when it exists, else Preferences', () => {
  let r = rig({ pageExists: (id) => id === Actions.AI_TOOLS_PAGE_ID }); r.a.connect(); assert.deepEqual(r.log.pages, ['aitools']);
  r = rig(); r.a.connect(); assert.deepEqual(r.log.pages, ['settings']);
});
test('share toggle writes the per-repo opt-in', async () => {
  const { a, links } = rig(); const handle = a.rowInfo(row()).handle; await new Promise((r) => setImmediate(r));
  assert.equal(await a.shareHandover(handle, true), true); assert.equal(Object.keys(links.shared()).length, 1);
  assert.equal(a.rowInfo(row()).share.on, true); await a.shareHandover(handle, false); assert.equal(Object.keys(links.shared()).length, 0);
});
test('board broker: a viewer cannot link; an admin-refused hub gives the ask-an-admin text; local board links via fixed routes', async () => {
  const calls = [];
  const local = { localRequest: async (m, p, b) => { calls.push([m, p]); if (p === '/api/me') return { ok: true, boards: [{ id: 'lb', name: 'My board' }] }; if (p === '/api/repos' && m === 'POST') return { ok: false, status: 409 }; if (p === '/api/repos') return { ok: true, repos: [{ id: 'r1', canonical_url: 'github.com/org/app' }] }; return { ok: true }; } };
  const client = { me: async () => ({ ok: true, teams: [{ id: 't1', name: 'Acme', role: 'member', boards: [{ id: 'b1', name: 'Main' }] }, { id: 't2', name: 'Ro', role: 'viewer', boards: [{ id: 'b2', name: 'Ro' }] }] }),
    listRepos: async () => ({ ok: true, repos: [] }), createRepo: async () => ({ ok: false, status: 403, code: 'FORBIDDEN' }), addBoardRepo: async () => ({ ok: true }) };
  const sb = createSessionBoards({ hubs: () => ['https://h.test'], clientFor: () => client, userOf: () => ({ id: 'u' }), local, getRoutes: async () => ({ routes: [], complete: true }), routeKey: () => 'k' });
  const list = await sb.boards(); assert.equal(list.length, 3); assert.match(list[0].label, /My board/);
  const [mine, team, viewer] = list;
  assert.equal((await sb.linkRepo(mine.key, 'github.com/org/app')).ok, true); assert.ok(calls.some(([m, p]) => p === '/api/boards/lb/repos'));
  assert.equal((await sb.linkRepo(team.key, 'github.com/org/app')).needsAdmin, true);
  assert.equal((await sb.linkRepo(viewer.key, 'github.com/org/app')).needsAdmin, true);
  assert.equal(await sb.captureKey(team.key, 'github.com/org/app'), null);
});
test('account client routes and card-id-only local session actions are sender checked', () => {
  const { ROUTES } = require('../buddy-window/accounts.js');
  assert.deepEqual([ROUTES.createRepo, ROUTES.addBoardRepo, ROUTES.salvageHandover], [['POST', '/api/repos'], ['POST', '/api/boards/:board/repos'], ['POST', '/api/cards/:card/handover/salvage']]);
  const pre = fs.readFileSync(path.join(__dirname, '../buddy-window/hub-preload.js'), 'utf8');
  assert.equal((pre.match(/ipcRenderer\.invoke\(/g) || []).length, 4); assert.match(pre, /buddy:local-handover/);
  assert.deepEqual([...pre.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]), ['buddy:local-handover', 'buddy:continue-in', 'buddy:card-session-action', 'buddy:card-session-action']);
  assert.match(pre, /\['refresh', 'copy', 'save'\]\.includes\(action\)/);
  assert.match(pre, /continueIn: \(cardId\) => ipcRenderer\.invoke\('buddy:continue-in', String\(cardId\)\.slice\(0, 100\)\)/, 'the card id is the only thing that crosses; main shows the menu');
  const idx = fs.readFileSync(path.join(__dirname, '../buddy-window/index.js'), 'utf8');
  assert.match(idx, /preload: path\.join\(DIR, 'hub-preload\.js'\)/);
  assert.match(idx, /const fromHubView = \(e\) => !!hubView && e\.sender === hubView\.webContents && !!hubInfo && hubBindingCurrent\(hubBinding\) && e\.senderFrame\?\.origin === hubInfo\.origin;/);
  assert.match(idx, /if \(!fromHubView\(e\)\) return null;\n\s+try \{ return await sessionBridge\.localHandover/);
  assert.match(idx, /ipcMain\.handle\('buddy:continue-in', async \(e, cardId\) => \{\n\s+if \(!fromHubView\(e\) \|\| !continueIn\) return null;/);
});
test('the hub page can only ask to show the Team page or a card\'s timeline: main checks the sender, resolves the card and picks the page', () => {
  const pre = fs.readFileSync(path.join(__dirname, '../buddy-window/hub-preload.js'), 'utf8');
  assert.equal((pre.match(/ipcRenderer\.send\(/g) || []).length, 2);
  assert.match(pre, /openTeam: \(\) => ipcRenderer\.send\('buddy:open-team'\),/);
  assert.match(pre, /openTimeline: \(cardId\) => ipcRenderer\.send\('buddy:open-timeline', String\(cardId\)\.slice\(0, 100\)\),/);
  const idx = fs.readFileSync(path.join(__dirname, '../buddy-window/index.js'), 'utf8');
  assert.match(idx, /ipcMain\.on\('buddy:open-team', \(e\) => \{ if \(fromHubView\(e\)\) select\('team'\); \}\);/);
  assert.match(idx, /ipcMain\.on\('buddy:open-timeline', \(e, cardId\) => \{\n\s+if \(fromHubView\(e\)\) void sessionBridge\.sessionForCard\(cardId\)/);
  const { pageById } = require('../buddy-window/pages.js');
  assert.deepEqual([pageById('team').kind, pageById('team').screen], ['local', 'team']);
});

test('PR 7 routing strip: rows for the live sessions\' projects, words from work-routing-view, actions only on a listed project', async () => {
  const chosen = [], linked = [];
  const teams = [{ key: 't1', name: 'Acme', role: 'admin', boards: [{ key: 'b1', name: 'Main' }] }];
  const routingRows = [{ repo: 'github.com/org/app', short: 'app', state: 'ask', destination: { kind: 'local' }, matches: [{ key: 'k1', team: 'Acme', board: 'Main', read_only: false }, { key: 'k2', team: 'Acme', board: 'Web', read_only: false }] }];
  const asked = [];
  const { a } = rig({
    boards: { boards: async () => [], teams: async () => teams, linkRepo: async (b, c) => { linked.push([b, c]); return { ok: true }; }, captureKey: async () => null, searchCards: async () => [], destinationOf: () => ({ kind: 'local' }) },
    capture: { captureOnce: async () => ({ ok: true }), routing: async (repos) => { asked.push(repos); return routingRows; }, choose: async (r, k) => { chosen.push([r, k]); return true; } },
  });
  const out = await a.routing();
  assert.deepEqual(asked, [['github.com/org/app']], 'the live sessions\' repos, resolved here');
  assert.equal(out.rows.length, 1);
  assert.match(out.rows[0].text, /^app is linked to Acme \/ Main and Acme \/ Web/);
  assert.deepEqual(out.rows[0].choices.map((c) => c.key), ['k1', 'k2', 'local']);
  assert.equal(JSON.stringify(out).includes('/Users/me'), false);
  assert.deepEqual(await a.routeChoose('github.com/org/app', 'k2'), { ok: true });
  assert.deepEqual(chosen, [['github.com/org/app', 'k2']]);
  assert.equal((await a.routeChoose('github.com/org/other', 'k2')).ok, false, 'a project not listed is refused');
  assert.equal((await a.routeLink('github.com/org/app', 'b1')).ok, true);
  assert.deepEqual(linked, [['b1', 'github.com/org/app']]);
  assert.equal((await a.routeLink('github.com/org/other', 'b1')).ok, false);
  assert.equal(linked.length, 1);
});
test('PR 7 routing strip: no team means no strip; a capture without routing gives none', async () => {
  const none = rig({ boards: { boards: async () => [], teams: async () => [], linkRepo: async () => ({ ok: true }) }, capture: { captureOnce: async () => ({ ok: true }), routing: async () => [{ repo: 'github.com/org/app', short: 'app', state: 'unlinked', destination: { kind: 'local' }, matches: [] }] } });
  assert.deepEqual(await none.a.routing(), { rows: [] });
  const old = rig();
  assert.deepEqual(await old.a.routing(), { rows: [] });
});
test('PR 7 board broker: teams() lists each signed-in team with its role and its boards\' keys', async () => {
  const client = { me: async () => ({ ok: true, teams: [{ id: 't1', name: 'Acme', role: 'admin', boards: [{ id: 'b1', name: 'Main' }] }, { id: 't2', name: 'Ro', role: 'viewer', boards: [{ id: 'b2', name: 'Ro' }] }] }) };
  const sb = createSessionBoards({ hubs: () => ['https://h.test'], clientFor: () => client, userOf: () => ({ id: 'u' }), local: { localRequest: async () => ({ ok: false }) }, getRoutes: async () => ({ routes: [], complete: true }), routeKey: () => 'k' });
  const teams = await sb.teams();
  assert.deepEqual(teams.map((t) => [t.name, t.role, t.boards.map((b) => b.name)]), [['Acme', 'admin', ['Main']], ['Ro', 'viewer', ['Ro']]]);
  const boards = await sb.boards();
  assert.equal(teams[0].boards[0].key, boards.find((b) => b.label === 'Acme / Main').key, 'a team board key is the Link form\'s board key');
  assert.ok(!JSON.stringify(teams).match(/h\.test|"t1"|"b1"/), 'opaque keys only');
});
