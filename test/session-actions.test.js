'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Actions = require('../src/session-actions.js');
const Links = require('../src/session-links.js');
const { createSessionBoards } = require('../buddy-window/session-boards.js');

const CWD = '/Users/me/work/app';
const row = (over = {}) => ({ source: 'codex', sessionId: 's1', cwd: CWD, ...over });
function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sact-'));
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
test('account client routes for repo linking and the opt-in salvage send exist, and the hub page bridge is read-only and sender-checked', () => {
  const { ROUTES } = require('../buddy-window/accounts.js');
  assert.deepEqual([ROUTES.createRepo, ROUTES.addBoardRepo, ROUTES.salvageHandover], [['POST', '/api/repos'], ['POST', '/api/boards/:board/repos'], ['POST', '/api/cards/:card/handover/salvage']]);
  const pre = fs.readFileSync(path.join(__dirname, '../buddy-window/hub-preload.js'), 'utf8');
  assert.equal((pre.match(/ipcRenderer\.invoke\(/g) || []).length, 1); assert.match(pre, /buddy:local-handover/);
  const idx = fs.readFileSync(path.join(__dirname, '../buddy-window/index.js'), 'utf8');
  assert.match(idx, /preload: path\.join\(DIR, 'hub-preload\.js'\)/); assert.match(idx, /e\.sender !== hubView\.webContents/);
});
