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
  const log = { clip: [], pages: [], linked: [], created: [], captured: [], offered: [] };
  const a = Actions.create({
    sessions: () => [row()], repoOf: async () => 'github.com/org/app', rootOf: async (c) => c,
    boards: { boards: async () => [{ key: 'local', label: 'My board', kind: 'local' }], linkRepo: async (b, c) => { log.linked.push([b, c]); return { ok: true }; },
      captureKey: async (b) => (b === 'unlinked' ? null : b), searchCards: async () => [{ card_id: 'c1', card_key: 'APP-1', title: 'Fix it', board: 'My board', boardKey: 'local' }], destinationOf: () => ({ kind: 'local' }) },
    capture: { captureOnce: async (r, k) => { log.captured.push(k); return { ok: true, card_id: 'x' }; } }, links,
    tasks: () => ({ composerInfo: async () => ({ ais: [{ id: 'claude', label: 'Claude', installed: true, loggedIn: true, capabilities: { background: true } }, { id: 'codex', label: 'Codex', installed: false, loggedIn: null, capabilities: { background: false } }, { id: 'gemini', label: 'Gemini', installed: true, loggedIn: null, capabilities: { background: false } }] }),
      registerFolder: (p) => ({ handle: `h:${p}` }), create: async (d) => { log.created.push(d); throw new Error('Sessions must never create a task'); } }),
    offerDraft: (d) => { log.offered.push(d); return { ok: true }; },
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
test('start session: a prompt goes to Home\u2019s box for the person to Run; nothing is created, nothing is copied', async () => {
  const { a, log } = rig(); const s = await a.setup(); const f = s.repos[0].handle;
  const r = await a.startSession({ folder: f, ai: 'claude', prompt: '  fix the bug ' });
  assert.equal(r.ok, true); assert.equal(r.copied, undefined);
  assert.deepEqual(log.offered, [{ dir: CWD, ai: 'claude', text: 'fix the bug' }]);
  assert.deepEqual(log.pages, ['home']); assert.equal(log.clip.length, 0); assert.equal(log.created.length, 0);
  assert.match(r.text, /Press Run/); assert.match(r.text, /background task/);
});
test('start session: the command is copied only when nothing can be handed over, always before anything is attempted', async () => {
  const cases = [
    ['no prompt', {}, { ai: 'claude', prompt: '' }, /first prompt/],
    ['AI that Tasks cannot run', {}, { ai: 'gemini', prompt: 'x' }, /can’t run gemini as a task/],
    ['AI not installed', {}, { ai: 'codex', prompt: 'x' }, /can’t run codex as a task/],
    ['task runner down', { tasks: () => ({ composerInfo: async () => { throw new Error('down'); } }) }, { ai: 'claude', prompt: 'x' }, /can’t run claude as a task/],
    ['task runner not connected', { tasks: () => ({ composerInfo: async () => ({ ais: [] }) }) }, { ai: 'claude', prompt: 'x' }, /can’t run claude as a task/],
    ['Home busy', { offerDraft: () => ({ ok: false, why: 'busy' }) }, { ai: 'claude', prompt: 'x' }, /already showing a task/],
    ['chat-first view', { offerDraft: () => ({ ok: false, why: 'gate' }) }, { ai: 'claude', prompt: 'x' }, /not in this view/],
    ['Home box off', { offerDraft: () => ({ ok: false, why: 'off' }) }, { ai: 'claude', prompt: 'x' }, /not available/],
  ];
  for (const [name, over, req, re] of cases) {
    const { a, log } = rig({ wait: 0, ...over }); const f = (await a.setup()).repos[0].handle;
    const r = await a.startSession({ folder: f, ...req });
    assert.equal(r.copied, true, name); assert.match(r.text, re, name);
    assert.deepEqual(log.clip, [`cd '${CWD}' && ${req.ai}`], name); assert.equal(log.pages.length, 0, name); assert.equal(log.created.length, 0, name);
  }
  const { a, log } = rig(); const f = (await a.setup()).repos[0].handle;
  const r = await a.startSession({ folder: f, ai: 'cursor', prompt: 'x' }); assert.equal(r.ok, false); assert.equal(log.clip.length, 0);
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
  const chosen = [], linked = [], cleared = [];
  let linkOk = true;
  const teams = [{ key: 't1', name: 'Acme', role: 'admin', boards: [{ key: 'b1', name: 'Main' }] }];
  const routingRows = [{ repo: 'github.com/org/app', short: 'app', state: 'ask', destination: { kind: 'local' }, matches: [{ key: 'k1', team: 'Acme', board: 'Main', read_only: false }, { key: 'k2', team: 'Acme', board: 'Web', read_only: false }] }];
  const asked = [];
  const { a } = rig({
    boards: { boards: async () => [], teams: async () => teams, linkRepo: async (b, c) => { linked.push([b, c]); return linkOk ? { ok: true } : { ok: false, error: 'No.' }; }, captureKey: async () => null, searchCards: async () => [], destinationOf: (k) => ({ kind: k === 'b1' ? 'team' : 'local' }) },
    capture: { captureOnce: async () => ({ ok: true }), routing: async (repos) => { asked.push(repos); return routingRows; }, choose: async (r, k) => { chosen.push([r, k]); return true; }, clearLocal: async (r) => { cleared.push(r); return true; } },
  });
  const out = await a.routing();
  assert.deepEqual(asked, [['github.com/org/app']], 'the live sessions\' repos, resolved here');
  assert.equal(out.rows.length, 1);
  assert.match(out.rows[0].text, /^app is linked to Acme \/ Main and Acme \/ Web/);
  assert.deepEqual(out.rows[0].choices.map((c) => c.key), ['k1', 'k2', 'local']);
  assert.equal(JSON.stringify(out).includes('/Users/me'), false);
  // Organised views PR 3 (review C5): main keys the row with the same function the snapshot's groups use.
  const Organise = require('../src/work-organise.js');
  assert.equal(out.rows[0].key, Organise.projectOf({ repoName: 'github.com/org/app' }).key);
  assert.equal(out.rows[0].key, Organise.projectOf({ repoName: 'github.com/org/app', commonDir: '/Users/me/app/.git', toplevel: '/Users/me/app-wt', cwd: '/Users/me/app-wt/src' }).key, 'a worktree session of the repo shares the key');
  assert.deepEqual(await a.routeChoose('github.com/org/app', 'k2'), { ok: true });
  assert.deepEqual(chosen, [['github.com/org/app', 'k2']]);
  assert.equal((await a.routeChoose('github.com/org/other', 'k2')).ok, false, 'a project not listed is refused');
  assert.equal((await a.routeLink('github.com/org/app', 'b1')).ok, true);
  assert.deepEqual(linked, [['b1', 'github.com/org/app']]);
  assert.deepEqual(cleared, ['github.com/org/app'], 'a successful Link clears "Keep on My board" so the new board takes the work (#62 review B1)');
  assert.equal((await a.routeLink('github.com/org/other', 'b1')).ok, false);
  assert.equal(linked.length, 1);
  linkOk = false;
  assert.equal((await a.routeLink('github.com/org/app', 'b1')).ok, false);
  assert.deepEqual(cleared, ['github.com/org/app'], 'a failed Link keeps the pin');
});
test('PR 7 routing strip: no team means no strip; a capture without routing gives none', async () => {
  const none = rig({ boards: { boards: async () => [], teams: async () => [], linkRepo: async () => ({ ok: true }) }, capture: { captureOnce: async () => ({ ok: true }), routing: async () => [{ repo: 'github.com/org/app', short: 'app', state: 'unlinked', destination: { kind: 'local' }, matches: [] }] } });
  assert.deepEqual(await none.a.routing(), { rows: [], reason: 'no_teams' });
  const old = rig();
  assert.deepEqual(await old.a.routing(), { rows: [], reason: 'unavailable' });
  // Organised views PR 3 (review C5): a failed fetch says so, so the page keeps the lines it has.
  const unit = { repo: 'github.com/org/app', short: 'app', state: 'unlinked', destination: { kind: 'local' }, matches: [] };
  const teams = async () => [{ key: 't1', name: 'Acme', role: 'admin', boards: [{ key: 'b1', name: 'Main' }] }];
  const down = rig({ boards: { boards: async () => [], teams: async () => { throw new Error('offline'); }, linkRepo: async () => ({ ok: true }) }, capture: { captureOnce: async () => ({ ok: true }), routing: async () => [unit] } });
  assert.deepEqual(await down.a.routing(), { rows: [], reason: 'error' });
  const broken = rig({ boards: { boards: async () => [], teams, linkRepo: async () => ({ ok: true }) }, capture: { captureOnce: async () => ({ ok: true }), routing: async () => { throw new Error('catalog'); } } });
  assert.deepEqual(await broken.a.routing(), { rows: [], reason: 'error' });
  const empty = rig({ boards: { boards: async () => [], teams, linkRepo: async () => ({ ok: true }) }, capture: { captureOnce: async () => ({ ok: true }), routing: async () => [] } });
  assert.deepEqual(await empty.a.routing(), { rows: [], reason: 'none' });
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
test('PR 7 Ask an admin: only a listed project, the short name only, and the answer in words', async () => {
  const asked = [];
  const answers = [{ ok: true, sent: 2 }, { ok: true, sent: 0, duplicate: true }, { ok: true, sent: 0 }, { ok: false, error: 'Too many requests. Try again later.' }];
  const { a } = rig({
    boards: { boards: async () => [], teams: async () => [{ key: 't1', name: 'Acme', role: 'member', boards: [] }], askAdmin: async (t, s) => { asked.push([t, s]); return answers.shift(); }, linkRepo: async () => ({ ok: true }) },
    capture: { captureOnce: async () => ({ ok: true }), routing: async () => [{ repo: 'github.com/org/app', short: 'app', state: 'unlinked', destination: { kind: 'local' }, matches: [] }] },
  });
  const out = await a.routing();
  assert.deepEqual(out.rows[0].ask, [{ key: 't1', label: 'Acme' }]);
  const first = await a.routeAsk('github.com/org/app', 't1');
  assert.equal(first.ok, true); assert.match(first.text, /Asked Acme’s admins to put app on a team board\. They see your name and “app”, nothing else\./);
  assert.deepEqual(asked, [['t1', 'app']], 'the short name only');
  assert.match((await a.routeAsk('github.com/org/app', 't1')).text, /already asked/);
  assert.match((await a.routeAsk('github.com/org/app', 't1')).text, /no other owner or admin/);
  assert.deepEqual(await a.routeAsk('github.com/org/app', 't1'), { ok: false, text: 'Too many requests. Try again later.' });
  assert.equal((await a.routeAsk('github.com/org/other', 't1')).ok, false);
  assert.equal(asked.length, 4);
});
test('PR 7 board broker: askAdmin sends the short name to a team the person is a member of, and nothing for an admin, viewer or unknown team', async () => {
  const sent = [];
  const client = { me: async () => ({ ok: true, teams: [{ id: 't1', name: 'Acme', role: 'member', boards: [] }, { id: 't2', name: 'Own', role: 'admin', boards: [] }, { id: 't3', name: 'Ro', role: 'viewer', boards: [] }] }),
    linkRequest: async (team, short) => { sent.push([team, short]); return { ok: true, sent: 1 }; } };
  const sb = createSessionBoards({ hubs: () => ['https://h.test'], clientFor: () => client, userOf: () => ({ id: 'u' }), local: { localRequest: async () => ({ ok: false }) }, getRoutes: async () => ({ routes: [], complete: true }), routeKey: () => 'k' });
  const [member, admin, viewer] = await sb.teams();
  assert.deepEqual(await sb.askAdmin(member.key, 'app'), { ok: true, sent: 1 });
  assert.deepEqual(sent, [['t1', 'app']]);
  for (const k of [admin.key, viewer.key, 'nope']) assert.equal((await sb.askAdmin(k, 'app')).ok, false);
  assert.equal((await sb.askAdmin(member.key, 'org/app')).ok, false, 'a short name only');
  assert.equal(sent.length, 1);
});
test('PR 7 routing, as wired in the app: Keep on My board, then Link through sessions:route-link clears the pin (#62 review, round 2)', async (t) => {
  // The buddy window's capture surface, line for line as buddy-window/index.js gives it to register().
  const idx = fs.readFileSync(path.join(__dirname, '../buddy-window/index.js'), 'utf8');
  assert.match(idx, /captureRouting: \(repos\) => \(captureEnabled \? workCapture\.routing\(repos\) : \[\]\),/);
  assert.match(idx, /captureChoose: \(repo, key\) => captureEnabled && workCapture\.choose\(repo, key\),/);
  assert.match(idx, /captureClearLocal: \(repo\) => captureEnabled && workCapture\.clearLocal\(repo\),/);
  const { createWorkCapture } = require('../src/work-capture.js');
  const WC = require('../src/work-capture.js'), repoFor = WC.repoFor;
  WC.repoFor = async () => 'github.com/org/none'; t.after(() => { WC.repoFor = repoFor; });
  const dir = testTempDir('sact-wired-'), file = path.join(dir, 'capture.json');
  const L = { hub: 'https://hub.example.test', user_id: 'u', team_id: 'team', board_id: 'board-l', repo_id: 'r', canonical_url: 'github.com/org/none', role: 'admin', team_name: 'T', board_name: 'Later' };
  let routes = [];
  const workCapture = createWorkCapture({ file, host: 'mac', startEnabled: true, getRoutes: async () => ({ routes, complete: true }), resolveRepo: async () => L.canonical_url, sendLocal: async () => ({ ok: true, card: { id: 'l' } }), sendTeam: async () => ({ ok: true, card: { id: 't' } }) });
  t.after(() => workCapture.stop());
  const captureEnabled = true;
  const buddy = {
    captureOnce: async () => ({ ok: true }),
    captureRouting: (repos) => (captureEnabled ? workCapture.routing(repos) : []),
    captureChoose: (repo, key) => captureEnabled && workCapture.choose(repo, key),
    captureClearLocal: (repo) => captureEnabled && workCapture.clearLocal(repo),
  };
  const handlers = {};
  const bridge = { gitRoot: async (c) => c, boards: { boards: async () => [], teams: async () => [{ key: 't', name: 'T', role: 'admin', boards: [{ key: 'b', name: 'Later' }] }], linkRepo: async (b) => { if (b === 'b') routes = [L]; return { ok: true, kind: b === 'mine' ? 'local' : 'team' }; } }, links: {}, rows: () => [] };
  require('../src/session-actions-main.js').register({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, sessionsAllowed: () => true, sessions: () => [{ cwd: '/w/none', host: 'local', source: 'claude', sessionId: 's1' }],
    bridge: () => bridge, capture: () => buddy, tasks: {}, clipboard: {}, pickFolder: async () => '/w/none', openPage: () => {}, pageExists: () => true });
  const e = {};
  const first = await handlers['sessions:routing'](e);
  assert.deepEqual(first.rows.map((r) => [r.short, r.state]), [['none', 'unlinked']]);
  assert.deepEqual(await handlers['sessions:route-choose'](e, 'github.com/org/none', 'local'), { ok: true });
  assert.equal((await handlers['sessions:routing'](e)).rows[0].state, 'set');
  assert.equal((await handlers['sessions:route-link'](e, 'github.com/org/none', 'b')).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).local_choices, undefined, 'the pin is gone');
  const [after] = (await handlers['sessions:routing'](e)).rows;
  assert.deepEqual([after.state, after.goesTo], ['single', 'T / Later']);
  // The Add/Link panel's path (sessions:link-repo) clears it too (#62 review, round 3, B1b); linking to My board
  // itself leaves the pin alone.
  assert.deepEqual(await handlers['sessions:route-choose'](e, 'github.com/org/none', 'local'), { ok: true });
  const picked = await handlers['sessions:pick-folder'](e);
  assert.equal(picked.remote, 'github.com/org/none');
  const toMine = await handlers['sessions:link-repo'](e, { folder: picked.handle, board: 'mine' });
  assert.equal(toMine.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).local_choices, { 'github.com/org/none': true }, 'linked to My board: still kept there');
  const toTeam = await handlers['sessions:link-repo'](e, { folder: picked.handle, board: 'b' });
  assert.equal(toTeam.ok, true); assert.doesNotMatch(toTeam.text, /still kept/);
  assert.equal(JSON.parse(fs.readFileSync(file)).local_choices, undefined, 'linked from the Add/Link panel: the pin is gone');
  assert.equal((await handlers['sessions:routing'](e)).rows[0].state, 'single');
});
test('PR 7 routing: a Link that cannot clear "Keep on My board" says so instead of reporting plain success', async () => {
  const warned = [];
  const teams = [{ key: 't1', name: 'Acme', role: 'admin', boards: [{ key: 'b1', name: 'Main' }] }];
  const row1 = { repo: 'github.com/org/app', short: 'app', state: 'set', destination: { kind: 'local' }, matches: [] };
  const mk = (clear) => rig({ boards: { boards: async () => [], teams: async () => teams, linkRepo: async () => ({ ok: true }) },
    capture: { captureOnce: async () => ({ ok: true }), routing: async () => [row1], ...(clear ? { clearLocal: clear } : {}) } });
  const orig = console.warn; console.warn = (...a) => warned.push(a.join(' '));
  try {
    for (const clear of [null, async () => false, async () => { throw new Error('x'); }]) {
      const { a } = mk(clear); await a.routing();
      const r = await a.routeLink('github.com/org/app', 'b1');
      assert.equal(r.ok, true, 'the link itself was made');
      assert.match(r.text, /still kept on My board/);
    }
    assert.equal(warned.length, 3);
    // The Add/Link panel's linkRepo says the same, after its own sentence.
    const { a } = mk(async () => false); const f = await a.chooseFolder();
    const r = await a.linkRepo({ folder: f.handle, board: 'b1' });
    assert.equal(r.ok, true); assert.match(r.text, /^Linked github\.com\/org\/app\. .*still kept on My board/s);
    assert.equal(warned.length, 4);
  } finally { console.warn = orig; }
});
test('PR 7 routing: a team link made while the board list is refreshing still clears Keep on My board (#62 review, round 4, B1c)', async () => {
  const HUB = 'https://hub.example.test';
  let slow = null;
  const local = { localRequest: async (m, p) => { if (p === '/api/me') { if (slow) await slow; return { ok: true, boards: [{ id: 'b0000000-0000-4000-8000-000000000000', name: 'My board' }] }; } return { ok: true, repo: { id: 'r-local' } }; } };
  const team = { id: 't0000000-0000-4000-8000-000000000001', name: 'Plexiform', role: 'admin', boards: [{ id: 'b0000000-0000-4000-8000-000000000002', name: 'Core' }] };
  const client = { me: async () => ({ ok: true, teams: [team] }), listRepos: async () => ({ ok: true, repos: [{ id: 'r0000000-0000-4000-8000-000000000003', canonical_url: 'github.com/org/app' }] }),
    addBoardRepo: async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true }; } };
  const sb = createSessionBoards({ hubs: () => [HUB], clientFor: () => client, userOf: () => ({ id: 'u' }), local, getRoutes: async () => ({ routes: [], complete: true }), routeKey: () => 'x' });
  const cleared = [];
  const row1 = { repo: 'github.com/org/app', short: 'app', state: 'set', destination: { kind: 'local' }, matches: [] };
  const { a } = rig({ boards: sb, capture: { captureOnce: async () => ({ ok: true }), routing: async () => [row1], clearLocal: async (r) => { cleared.push(r); return true; } } });
  const list = await sb.boards();
  const teamKey = list.find((b) => b.kind === 'team').key, mineKey = list.find((b) => b.kind === 'local').key;
  assert.equal((await a.routing()).rows.length, 1);
  // A refresh starts while the link is on its way: the key is briefly unknown, which must not read as "My board".
  let release; slow = new Promise((r) => { release = r; });
  const link = a.routeLink('github.com/org/app', teamKey);
  await new Promise((r) => setTimeout(r, 5)); const refresh = sb.boards();
  const r = await link;
  assert.equal(sb.destinationOf(teamKey).kind, 'local', 'the window the review found is real');
  assert.deepEqual([r.ok, cleared], [true, ['github.com/org/app']], JSON.stringify(r));
  release(); await refresh; slow = null;
  // The same through the Add/Link panel; and a link to My board itself leaves the pin.
  cleared.length = 0;
  const f = await a.chooseFolder();
  assert.equal((await a.linkRepo({ folder: f.handle, board: mineKey })).ok, true);
  assert.deepEqual(cleared, [], 'linked to My board: kept');
  slow = new Promise((res) => { release = res; });
  const viaPanel = a.linkRepo({ folder: f.handle, board: teamKey });
  await new Promise((res) => setTimeout(res, 5)); const again = sb.boards();
  assert.equal((await viaPanel).ok, true); assert.deepEqual(cleared, ['github.com/org/app']);
  release(); await again;
});
