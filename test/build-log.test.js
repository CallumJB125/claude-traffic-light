'use strict';
// Build logs, starter kits and the unified catalogue (lane F): the pure parts,
// and the main service with a fake hub, dialogs and consent sheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const BuildLog = require('../src/build-log.js');
const Kit = require('../src/starter-kit.js');
const Catalog = require('../src/discover-catalog.js');
const Main = require('../src/build-log-main.js');

const HOME = '/Users/ana';
const CWD = '/Users/ana/code/todo';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const timeline = (over = {}) => ({
  adapter: 'claude-code', sessionId: 's1', cwd: CWD, project: 'todo', startedAt: '2026-10-19T09:00:00.000Z', lastActive: '2026-10-19T11:00:00.000Z',
  spend: { usd: 1.234 }, files: [{ path: `${CWD}/src/app.js`, edits: 3, add: 10, del: 1 }, { path: '/etc/hosts', edits: 1, add: null, del: null }],
  events: [
    { at: '2026-10-19T09:00:00.000Z', kind: 'prompt', text: `Build a todo app in ${CWD} with key ${TOKEN}` },
    { at: '2026-10-19T09:05:00.000Z', kind: 'command', text: `cd ${HOME}/code/todo && npm test` },
    { at: '2026-10-19T09:06:00.000Z', kind: 'read', paths: ['x'] },
  ],
  ...over,
});
const ctx = { home: HOME, user: 'ana', hostname: 'anas-mac' };

test('a draft carries a timeline, prompts, cost and project-relative files; outside paths are dropped', () => {
  const d = BuildLog.draftFrom([timeline(), timeline({ sessionId: 's2', adapter: 'codex', spend: { usd: 2 }, startedAt: '2026-10-19T10:00:00.000Z' })]);
  assert.equal(d.cost_usd, 3.23);
  assert.deepEqual(d.tools, ['Claude Code', 'Codex']);
  assert.deepEqual(d.items.filter((i) => i.section === 'files').map((i) => [i.path, i.edits, i.add]), [['src/app.js', 6, 20]]);
  assert.equal(d.items.filter((i) => i.section === 'prompts').length, 2);
  assert.equal(d.fields.title, 'Building todo');
});

test('finalize scrubs secrets, the home folder, the project folder and names; leftovers block sharing', () => {
  const d = BuildLog.draftFrom([timeline()]);
  const f = BuildLog.finalize(d, ctx);
  const all = JSON.stringify(f);
  assert.ok(!all.includes(TOKEN), 'token redacted');
  assert.ok(!all.includes(HOME) && !all.includes(CWD), 'paths removed');
  assert.match(f.timeline.find((e) => e.kind === 'command').text, /^cd \. && npm test$/);
  assert.deepEqual(BuildLog.leftovers(f), []);
  // A secret typed into the review is redacted again, never shared raw.
  const r = BuildLog.applyReview(d, { fields: { summary: `my key ${TOKEN}` } });
  assert.ok(!JSON.stringify(BuildLog.finalize(r, ctx)).includes(TOKEN));
});

test('the review removes and edits items by id, and the digest changes with them', () => {
  const d = BuildLog.draftFrom([timeline()]);
  const before = BuildLog.digest(BuildLog.finalize(d, ctx));
  const p = d.items.find((i) => i.section === 'prompts');
  const r = BuildLog.applyReview(d, { fields: { title: 'My todo', deployed_url: 'https://todo.example.com' }, items: [{ id: p.id, include: false }, { id: 'nope', include: false }, { id: d.items.find((i) => i.section === 'timeline').id, text: 'Started' }] });
  const f = BuildLog.finalize(r, ctx);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.title, 'My todo');
  assert.equal(f.deployed_url, 'https://todo.example.com/');
  assert.equal(f.timeline[0].text, 'Started');
  assert.notEqual(BuildLog.digest(f), before);
  assert.equal(BuildLog.finalize(BuildLog.applyReview(d, { fields: { deployed_url: 'javascript:alert(1)' } }), ctx).deployed_url, null);
});

test('the exported page is self-contained, escaped and credits Plexiform', () => {
  const d = BuildLog.applyReview(BuildLog.draftFrom([timeline()]), { fields: { title: '<script>x</script>' } });
  const html = BuildLog.renderHtml(BuildLog.finalize(d, ctx), { author: 'Ana' });
  assert.ok(!/<script/i.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Made with Plexiform — remix this/);
  assert.match(html, /default-src 'none'/);
  assert.ok(!/src=|href="http:/.test(html));
});

test('the desktop log matches the hub\'s shape check', async () => {
  const { validateLog } = await import('../board/hub/build-logs.js');
  const kit = Kit.normalize({ repo: 'https://github.com/ana/todo', claude_md: '# Rules', skills: [{ name: 'tidy', content: 'Tidy.' }], mcp: [{ name: 'fs', command: 'npx', args: ['server-fs'], url: null }], budget_usd: 5 });
  const f = BuildLog.finalize(BuildLog.draftFrom([timeline()], { kit }), ctx);
  assert.deepEqual(validateLog(f), f);
  assert.equal(f.kit.skills[0].name, 'tidy');
  assert.ok(f.kit.permissions.some((p) => /npx server-fs/.test(p)));
});

test('a starter kit from a project reads only its kit files and never MCP env or key-like arguments', (t) => {
  const dir = testTempDir('kit-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# House rules');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'ship-it'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'ship-it', 'SKILL.md'), 'Ship it.');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['gh-mcp', TOKEN], env: { GITHUB_TOKEN: TOKEN } }, docs: { url: 'https://docs.example.com/mcp', headers: { authorization: 'x' } } } }));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:ana/todo.git\n');
  const kit = Kit.fromProject(dir, { budget_usd: 3 });
  assert.equal(kit.repo, 'https://github.com/ana/todo');
  assert.deepEqual(kit.skills.map((s) => s.name), ['ship-it']);
  assert.ok(!JSON.stringify(kit).includes(TOKEN));
  assert.deepEqual(kit.mcp.map((m) => m.name), ['gh', 'docs']);
  const lines = Kit.manifest(kit);
  assert.ok(lines.some((l) => /CLAUDE\.md/.test(l)) && lines.some((l) => /docs\.example\.com/.test(l)) && lines.some((l) => /\$3\.00/.test(l)));
});

test('install never overwrites and credits the author; bad kits are refused', (t) => {
  const dir = testTempDir('kit-install-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
  const kit = { claude_md: '# Rules', skills: [{ name: 'tidy', content: 'Tidy.' }], mcp: [{ name: 'fs', command: 'npx', args: [], url: null }] };
  const out = Kit.install(kit, dir, { credit: { title: 'Todo', author: 'Ana', link: 'https://hub.example.com/b/x' } });
  assert.deepEqual(out, { written: ['CLAUDE.md', path.join('.claude', 'skills', 'tidy', 'SKILL.md')], skipped: ['.mcp.json'] });
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /Remixed from "Todo" by Ana/);
  assert.equal(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'), '{}');
  assert.deepEqual(Kit.install(kit, dir).written, []);
  assert.throws(() => Kit.normalize({ skills: [{ name: '../evil', content: 'x' }] }), /lower-case/);
  assert.throws(() => Kit.normalize({ mcp: [{ name: 'x', url: 'http://plain.example.com' }] }), /https/);
});

test('remix links: https /b/<22-char id> only', () => {
  const id = 'A'.repeat(22);
  assert.equal(Kit.remixLink(`https://hub.example.com/b/${id}`).kit, `https://hub.example.com/b/${id}/kit.json`);
  assert.ok(Kit.remixLink(`http://localhost:8080/b/${id}`));
  for (const bad of [`http://hub.example.com/b/${id}`, `https://u:p@hub.example.com/b/${id}`, 'https://hub.example.com/b/short', 'not a link']) assert.equal(Kit.remixLink(bad), null, bad);
});

test('the catalogue sorts gallery items into Starters, Skills and MCP servers with cost, permissions and a report link', () => {
  const author = { name: 'Ana', github: 'ana' };
  const item = (kind, id, preview, extra = {}) => ({ id: `${kind}/${id}`, kind, title: id, summary: `About ${id}`, author, sha256: 'a'.repeat(64), addable: true, preview, ...extra });
  const view = { ok: true, items: [item('recipe', 'explain', { cost: 'Low.' }), item('setup', 'zsh', { files: [{ path: '.zshrc' }] }), item('setup', 'mcp', { files: [{ path: '.cursor/mcp.json' }] }), item('pack', 'starter', {}), item('character', 'pebble', {})] };
  const c = Catalog.catalog({ view, installed: { recipes: [{ galleryId: 'recipe/explain' }], characters: [] }, logs: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Todo', remix_count: 2, hidden: false, url: 'https://hub.example.com/b/x' }] });
  const tab = (id) => c.tabs.find((t) => t.id === id).items.map((i) => i.id);
  assert.deepEqual(tab('skills'), ['recipe/explain']);
  assert.deepEqual(tab('starters'), ['setup/zsh', 'pack/starter', '11111111-1111-4111-8111-111111111111']);
  assert.deepEqual(tab('mcp'), ['setup/mcp']);
  const skill = c.tabs[1].items[0];
  assert.equal(skill.cost, 'Low.');
  assert.equal(skill.used, 'Installed here');
  assert.match(skill.permissions[0], /plan mode/);
  assert.match(skill.report, /^https:\/\/github\.com\/.+\/issues\/new\?labels=gallery-report/);
  assert.equal(c.tabs[0].items[2].used, '2 remixes');
});

function service(t, over = {}) {
  const calls = { fetch: [], confirm: [], saved: [] };
  const dir = testTempDir('vibe-main-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const responses = over.responses || {};
  const s = Main.create({
    timelines: { list: () => [{ key: 'claude-code.s1', label: 'Claude Code · todo', cwd: CWD }], timelineOf: async (k) => (k === 'claude-code.s1' ? timeline() : null) },
    hub: () => ({ origin: 'https://hub.example.com', userId: 'u1', token: () => 'device-token' }),
    fetch: async (url, opts = {}) => { calls.fetch.push({ url, ...opts }); const r = responses[`${opts.method || 'GET'} ${url}`]; return new Response(JSON.stringify(r?.body ?? {}), { status: r?.status ?? 200 }); },
    confirm: async (info) => { calls.confirm.push(info); return over.yes !== false; },
    pickSave: async () => path.join(dir, 'log.html'), pickFolder: async () => dir,
    ...ctx, ...over.opts,
  });
  return { s, calls, dir };
}

test('publish sends exactly the reviewed log, only after the consent sheet, and only for the digest shown', async (t) => {
  const team = '22222222-2222-4222-8222-222222222222';
  const { s, calls } = service(t, { responses: { 'POST https://hub.example.com/api/build-logs': { body: { log: { id: '33333333-3333-4333-8333-333333333333', path: `/b/${'B'.repeat(22)}` } } } } });
  const d = await s.makeDraft(['claude-code.s1']);
  assert.ok(d.ok);
  assert.equal(calls.fetch.length, 0, 'drafting sends nothing');
  const stale = await s.publish({}, 'f'.repeat(64), team);
  assert.match(stale.error, /changed since you reviewed/);
  const v = s.review({ items: [{ id: d.items.find((i) => i.section === 'prompts').id, include: false }] });
  const r = await s.publish({}, v.digest, team);
  assert.equal(r.url, `https://hub.example.com/b/${'B'.repeat(22)}`);
  assert.equal(calls.confirm.length, 1);
  const sent = calls.fetch[0];
  assert.equal(sent.headers['X-Board-Team'], team);
  assert.equal(sent.headers.authorization, 'Bearer device-token');
  assert.deepEqual(JSON.parse(sent.body).log, v.final);
  assert.ok(!sent.body.includes(TOKEN) && !sent.body.includes(HOME));
});

test('a declined consent sheet sends nothing; export writes the reviewed page locally', async (t) => {
  const { s, calls, dir } = service(t, { yes: false });
  const d = await s.makeDraft(['claude-code.s1']);
  const r = await s.publish({}, d.digest, '22222222-2222-4222-8222-222222222222');
  assert.equal(r.cancelled, true);
  assert.equal(calls.fetch.length, 0);
  const x = await s.exportHtml({}, d.digest);
  assert.equal(x.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'log.html'), 'utf8'), /Made with Plexiform/);
  assert.equal(calls.fetch.length, 0);
});

test('remix: preview fetches the kit without credentials, install asks first, writes and counts once', async (t) => {
  const id = 'C'.repeat(22);
  const { s, calls, dir } = service(t, { responses: { [`GET https://hub.example.com/b/${id}/kit.json`]: { body: { title: 'Todo', author: 'Ana', remix_count: 4, kit: { repo: null, claude_md: '# Rules', skills: [], mcp: [], budget_usd: null, permissions: ['ignored'] } } } } });
  const p = await s.remixPreview(`https://hub.example.com/b/${id}`);
  assert.equal(p.ok, true, p.error);
  assert.equal(calls.fetch[0].credentials, 'omit');
  assert.ok(!calls.fetch[0].headers.authorization);
  assert.ok(p.permissions.some((l) => /CLAUDE\.md/.test(l)));
  const i = await s.remixInstall({});
  assert.deepEqual(i.written, ['CLAUDE.md']);
  assert.match(calls.confirm[0].detail, /CLAUDE\.md/);
  assert.equal(calls.fetch[1].url, `https://hub.example.com/b/${id}/remix`);
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /by Ana/);
  assert.match((await s.remixInstall({})).error, /Open the link again/);
});
