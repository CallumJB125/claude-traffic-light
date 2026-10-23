// Find agents IPC (src/agents-find-main.js) against a temp home, a temp data
// folder, a fake safeStorage and a fake dialog. Never touches the real
// ~/.claude, ~/.codex, ~/.gemini, ~/.copilot, ~/.config/opencode, ~/.cursor
// or the real keychain. Each test maps to a numbered change in the PR 3
// security review (plan-find-agents.md §9 PR 3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fromPage } = require('../src/utility-pages.js');
const { createAgentInstaller } = require('../src/agent-install.js');
const { createLedgerKeyStore } = require('../src/agent-install-key.js');
const Main = require('../src/agents-find-main.js');

const sha = (t) => createHash('sha256').update(t).digest('hex');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(p = 'af-main-') { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; }

function agentOf(id, name, { tools = null } = {}) {
  const fm = `---\nname: ${name}\ndescription: ${name} helps with things.\n${tools ? `tools: ${tools.join(', ')}\n` : ''}---\n`;
  const raw = `${fm}# ${name}\n\nYou help.\n`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { id, source: id.split('/')[0], sourcePath: `agents/${slug}.md`, sourceSha: 'a'.repeat(40), name, slug, key: slug, description: `${name} helps with things.`, oneLiner: `${name} helps.`, bestWhen: null, category: 'engineering', tags: [], raw, bodyOffset: fm.length, fileSha256: sha(raw), tools: { declared: tools, effective: tools ?? 'all' }, model: null, risk: { level: 'review', flags: [{ level: 'review', rule: 'all-tools', line: 0, excerpt: '(no tools listed)', why: 'x' }] }, icon: 'code', license: 'MIT', attribution: `"${name}" from github.com/o/r. MIT License.`, aliases: [], primary: true };
}
const FE = agentOf('agency/frontend-developer', 'Frontend Developer');
const RO = agentOf('voltagent/reviewer', 'reviewer', { tools: ['Read', 'Grep'] });
function catalogOf(agents = [FE, RO], catSha = 'c'.repeat(64)) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return { ok: true, sha256: catSha, catalog: { agents, categories: { engineering: { label: 'Engineering', icon: 'code' } }, sources: [{ id: 'agency', name: 'A', license: 'MIT', copyright: 'c', url: 'https://github.com/o/a', sha: 'a'.repeat(40) }, { id: 'voltagent', name: 'V', license: 'MIT', copyright: 'c', url: 'https://github.com/o/v', sha: 'b'.repeat(40) }] }, get: (id) => byId.get(id) ?? null, body: (a) => a.raw.slice(a.bodyOffset) };
}
const TOOLS = [
  { id: 'claude', label: 'Claude Code', installed: true, state: 'connected' },
  { id: 'codex', label: 'Codex', installed: true, state: 'connected' },
  { id: 'gemini', label: 'Gemini CLI', installed: true, state: 'ready' },
  { id: 'cursor', label: 'Cursor', installed: true, state: 'connected' },
  { id: 'goose', label: 'Goose', installed: true, state: 'connected' },
];

function fakeSafe({ on = true } = {}) {
  const calls = { encrypt: 0, decrypt: 0 };
  return { calls, isEncryptionAvailable: () => on, encryptString: (s) => { calls.encrypt++; return Buffer.from(`sealed:${s}`); }, decryptString: (b) => { calls.decrypt++; return b.toString().slice(7); } };
}
function frame() { return { id: Math.random() }; }
function contents() { const c = { mainFrame: frame(), destroyed: false, isDestroyed: () => c.destroyed }; return c; }
const ev = (c, f = c.mainFrame) => ({ sender: c, senderFrame: f });

function setup({ safe = fakeSafe(), demoOn = false, catalog = catalogOf(), pick = null, installerWrap = null, fsApi } = {}) {
  const home = tmp('af-home-'), data = tmp('af-data-');
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => { assert.ok(!handlers.has(ch), `registered twice: ${ch}`); handlers.set(ch, fn); } };
  const page = contents(), discover = contents(), other = contents();
  const demo = { on: demoOn, active() { return this.on; } };
  const key = createLedgerKeyStore({ file: path.join(data, 'agent-installs.key'), safeStorage: safe });
  const opts = { home, dataRoot: data, catalog, enableCursorProject: true };
  let inst = null;
  const installer = (k) => { if (!inst || inst.k !== k) inst = { k, it: createAgentInstaller({ ...opts, ledgerKey: k }) }; return installerWrap ? installerWrap(inst.it) : inst.it; };
  let plan = null;
  const planner = () => plan || (plan = createAgentInstaller({ ...opts, ledgerKey: Buffer.alloc(32, 7) }));
  const picks = [];
  const logs = [];
  const opened = [];
  const state = { page };
  const r = Main.register({
    ipcMain, allowed: (e) => fromPage(e, state.page), discoverAllowed: (e) => fromPage(e, discover), pageContents: () => state.page,
    catalog: () => catalog, keyStore: key, installer, planner, tools: () => TOOLS, demo,
    pickFolder: (sender) => { picks.push(sender); return pick ? pick(sender) : Promise.resolve({ canceled: true, filePaths: [] }); },
    home, dataRoot: data, openTools: () => opened.push('aitools'), openFindAgents: () => opened.push('agents-find'), log: (m) => logs.push(m), ...(fsApi ? { fsApi } : {}),
  });
  const call = (ch, ...a) => handlers.get(ch)(ev(page), ...a);
  const responses = [];
  const callLogged = async (ch, ...a) => { const out = await call(ch, ...a); responses.push(out); return out; };
  return { home, data, handlers, page, discover, other, demo, key, safe, call: callLogged, raw: call, picks, logs, opened, r, catalog, state, responses, setPick: (fn) => { pick = fn; } };
}
const sha0 = catalogOf().sha256;

// Deep-walks a response for anything the page must never see (review 3, 9).
function assertClean(value, banned) {
  const walk = (v, where) => {
    assert.ok(!(v instanceof Uint8Array) && !Buffer.isBuffer(v), `binary at ${where}`);
    if (typeof v === 'string') { for (const b of banned) if (b && v.includes(b)) assert.fail(`${where} contains ${b.slice(0, 40)}`); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!['rel', 'text', 'owned', 'raw'].includes(k), `${where}.${k}`); walk(x, `${where}.${k}`); }
  };
  walk(value, 'response');
}
const bannedFor = (s, extra = []) => { const k = s.key.cached(); return [s.home, s.data, ...(k ? [k.toString('hex'), k.toString('base64')] : []), ...extra]; };

// ── review 9: the registry and the gate ──
test('registers exactly the planned channels', () => {
  const s = setup();
  assert.deepEqual([...s.handlers.keys()].sort(), [...Main.CHANNELS].sort());
  assert.deepEqual([...Main.CHANNELS].sort(), ['agents:add', 'agents:add-to-project', 'agents:detail', 'agents:list', 'agents:open-tools', 'agents:status', 'agents:targets', 'agents:undo', 'agents:undo-project', 'discover:open-find-agents'].sort());
});

test('every channel refuses another page, a child frame of the right page, and a null frame', async () => {
  const s = setup();
  for (const [ch, fn] of s.handlers) {
    const owner = ch.startsWith('discover:') ? s.discover : s.page;
    const wrong = ch.startsWith('discover:') ? s.page : s.discover;
    for (const e of [ev(s.other), ev(wrong), ev(owner, frame()), ev(owner, null)]) assert.deepEqual(await fn(e, FE.id, sha0, ['claude']), { ok: false, code: 'not-allowed' }, ch);
  }
  assert.deepEqual(s.opened, [], 'nothing opened');
  assert.equal(fs.existsSync(path.join(s.home, '.claude')), false, 'nothing written');
  assert.deepEqual(await s.handlers.get('discover:open-find-agents')(ev(s.discover)), { ok: true });
  assert.deepEqual(s.opened, ['agents-find']);
});

// ── review 6: reads never make the key ──
test('list, detail, targets and status never create the key or call the keychain', async () => {
  const s = setup();
  const list = await s.call('agents:list');
  assert.equal(list.ok, true);
  assert.equal(list.count, 2);
  assert.equal(list.writes.ok, true);
  assert.equal(list.demo, false);
  assert.ok(list.agents.every((a) => !('raw' in a)));
  assert.equal((await s.call('agents:detail', FE.id)).ok, true);
  const t = await s.call('agents:targets', FE.id);
  assert.equal(t.ok, true);
  assert.deepEqual(t.platforms.map((p) => [p.platform, p.choice]), [['claude', 'default'], ['codex', 'default'], ['gemini', 'offered'], ['copilot', undefined], ['opencode', undefined]].filter(([, c]) => c).concat([['cursor', 'project-only'], ['goose', 'unsupported']]));
  assert.deepEqual(await s.call('agents:status'), { ok: true, demo: false, agents: [], ops: [] });
  assert.equal(fs.existsSync(path.join(s.data, 'agent-installs.key')), false);
  assert.deepEqual(s.safe.calls, { encrypt: 0, decrypt: 0 });
  assert.equal(s.key.cached(), null, 'Health sees no key');
});

test('PR4 Works with: list gives each agent the platforms it renders for, and the tools found here', async () => {
  const s = setup();
  const list = await s.call('agents:list');
  const byId = new Map(list.agents.map((a) => [a.id, a.works]));
  assert.deepEqual(byId.get(FE.id), ['claude', 'codex', 'gemini', 'copilot', 'opencode']);
  assert.ok(!byId.get(RO.id).includes('codex'), 'Codex cannot keep a read-only agent');
  assert.deepEqual(list.tools, [{ platform: 'claude', label: 'Claude Code' }, { platform: 'codex', label: 'Codex' }, { platform: 'gemini', label: 'Gemini CLI' }]);
  assertClean(list, bannedFor(s));
});

test('PR4 Works with: an agent with settings Plexiform refuses works with nothing; worked out once per catalogue', async () => {
  const { worksWith } = require('../src/agent-install.js');
  const bad = agentOf('agency/hooked', 'Hooked');
  bad.raw = bad.raw.replace('---\n#', 'hooks: x\n---\n#');
  assert.deepEqual(worksWith(bad), []);
  let renders = 0;
  const T = require('../src/agent-install/targets/index.js').TARGETS.map((t) => ({ ...t, render: (...a) => { renders++; return t.render(...a); } }));
  assert.equal(worksWith(FE, T).length, 5, 'cursor-project is never a Works with choice');
  renders = 0;
  const handlers = new Map();
  const c = catalogOf();
  Main.register({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, allowed: () => true, discoverAllowed: () => true, pageContents: () => null, catalog: () => c, keyStore: createLedgerKeyStore({ file: path.join(tmp(), 'k'), safeStorage: fakeSafe() }), installer: () => null, planner: () => null, tools: () => [], demo: { active: () => false }, pickFolder: () => null, home: tmp(), dataRoot: tmp(), openTools() {}, openFindAgents() {}, targets: T });
  for (let i = 0; i < 3; i++) assert.equal((await handlers.get('agents:list')({})).ok, true);
  assert.equal(renders, 2 * 5, 'two agents × five platforms, once');
});

test('PR4 Works with over the shipped catalogue costs under 300 ms of CPU', () => {
  const { worksWith } = require('../src/agent-install.js');
  const c = require('../src/agent-catalog.js').shipped();
  const t0 = process.cpuUsage();
  for (const a of c.catalog.agents) worksWith(a);
  const d = process.cpuUsage(t0);
  assert.ok((d.user + d.system) / 1000 < 300, `${(d.user + d.system) / 1000} ms`);
});

test('detail: unknown, overlong and non-string ids are refused; the URL is built in main', async () => {
  const s = setup();
  for (const id of ['nope/x', 'x'.repeat(201), 42, null, { id: FE.id }]) assert.equal((await s.call('agents:detail', id)).ok, false);
  const d = await s.call('agents:detail', FE.id);
  assert.equal(d.upstream, `https://github.com/o/a/blob/${'a'.repeat(40)}/agents/frontend-developer.md`);
  assert.equal(d.body, '# Frontend Developer\n\nYou help.\n');
});

// ── review 9 + 2: add only what + offers ──
test('add refuses platforms + does not offer, bad shapes, duplicates and a stale catalogue', async () => {
  const s = setup();
  const bad = [
    ['cursor'], ['goose'], ['copilot'], ['../x'], [], Array(17).fill('claude'), 'claude', [42], [null],
    [{ platform: 'claude', alt: true, path: '/etc' }], [{ platform: 'claude', alt: 'yes' }], [{ platform: 'claude', extra: 1 }], [['claude']],
    ['claude', 'claude'], ['claude', { platform: 'claude', alt: true }],
  ];
  for (const p of bad) assert.equal((await s.call('agents:add', FE.id, sha0, p)).ok, false, JSON.stringify(p));
  assert.equal((await s.call('agents:add', FE.id, 'd'.repeat(64), ['claude'])).code, 'changed');
  assert.equal((await s.call('agents:add', 'nope/x', sha0, ['claude'])).code, 'unavailable');
  assert.equal(fs.existsSync(path.join(s.home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(s.data, 'agent-installs.key')), false, 'refusals before the write never make the key');
});

test('add writes to the ticked tools, makes the key once, and returns no paths, text or key', async () => {
  const s = setup();
  const r = await s.call('agents:add', FE.id, sha0, ['claude', { platform: 'codex', alt: false }, { platform: 'gemini', alt: false }]);
  assert.equal(r.ok, true);
  assert.match(r.opId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(r.results.map((x) => [x.platform, x.status, x.path]), [['claude', 'added', '~/.claude/agents/frontend-developer.md'], ['codex', 'added', '~/.codex/agents/frontend-developer.toml'], ['gemini', 'added', '~/.gemini/agents/frontend-developer.md']]);
  assert.ok(fs.existsSync(path.join(s.home, '.claude/agents/frontend-developer.md')));
  assert.equal(s.safe.calls.encrypt, 1);
  const st = await s.call('agents:status');
  assert.deepEqual(st.agents, [{ agentId: FE.id, platforms: [{ platform: 'claude', state: 'current' }, { platform: 'codex', state: 'current' }, { platform: 'gemini', state: 'current' }] }]);
  assert.deepEqual(st.ops.map((o) => o.opId), [r.opId]);
  const t = await s.call('agents:targets', FE.id);
  assert.equal(t.platforms.find((p) => p.platform === 'claude').status, 'ours');
  await s.call('agents:list');
  await s.call('agents:detail', FE.id);
  for (const out of s.responses) assertClean(out, bannedFor(s));
});

test('a file the user already has is skipped and left alone; the alt name is an explicit second tick', async () => {
  const s = setup();
  const mine = path.join(s.home, '.claude/agents/frontend-developer.md');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, 'my own\n');
  const t = await s.call('agents:targets', FE.id);
  const c = t.platforms.find((p) => p.platform === 'claude');
  assert.equal(c.status, 'user-file');
  assert.equal(c.altName, 'frontend-developer-plexiform');
  const r = await s.call('agents:add', FE.id, sha0, ['claude']);
  assert.equal(r.results[0].status, 'skipped');
  assert.equal(fs.readFileSync(mine, 'utf8'), 'my own\n');
  const alt = await s.call('agents:add', FE.id, sha0, [{ platform: 'claude', alt: true }]);
  assert.equal(alt.results[0].path, '~/.claude/agents/frontend-developer-plexiform.md');
});

// ── review 1: undo by kind, only for clicks made in this run ──
test('undo: only an add made in this run, by its own channel, and only once', async () => {
  const s = setup();
  assert.equal((await s.call('agents:undo', '00000000-0000-4000-8000-000000000000')).ok, false);
  const r = await s.call('agents:add', FE.id, sha0, ['claude']);
  assert.equal((await s.call('agents:undo-project', r.opId)).ok, false, 'not by undo-project');
  for (const bad of [r.opId.toUpperCase(), ` ${r.opId}`, { id: r.opId }, null]) assert.equal((await s.call('agents:undo', bad)).ok, false);
  const u = await s.call('agents:undo', r.opId);
  assert.equal(u.ok, true);
  assert.deepEqual(u.restored, ['~/.claude/agents/frontend-developer.md']);
  assert.equal(fs.existsSync(path.join(s.home, '.claude/agents/frontend-developer.md')), false);
  assert.equal((await s.call('agents:undo', r.opId)).ok, false, 'once');
});

test('undo refuses an add from an earlier run (a fresh register)', async () => {
  const s = setup();
  const r = await s.call('agents:add', FE.id, sha0, ['claude']);
  const handlers = new Map();
  const later = createLedgerKeyStore({ file: path.join(s.data, 'agent-installs.key'), safeStorage: fakeSafe() });
  const page = contents();
  Main.register({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, allowed: (e) => fromPage(e, page), discoverAllowed: () => false, pageContents: () => page, catalog: () => s.catalog, keyStore: later, installer: (k) => createAgentInstaller({ home: s.home, dataRoot: s.data, catalog: s.catalog, ledgerKey: k }), planner: () => null, tools: () => TOOLS, demo: { active: () => false }, pickFolder: async () => null, home: s.home, dataRoot: s.data, openTools() {}, openFindAgents() {} });
  assert.equal((await handlers.get('agents:undo')(ev(page), r.opId)).ok, false);
  assert.ok(fs.existsSync(path.join(s.home, '.claude/agents/frontend-developer.md')));
});

// ── review 4, 2: the project folder ──
function project(s, name = 'proj') { const p = path.join(tmp('af-proj-'), name); fs.mkdirSync(p); return p; }
const picked = (p) => async () => ({ canceled: false, filePaths: [p] });

test('add-to-project takes the folder only from main\'s picker and ignores anything else the page sends', async () => {
  const s = setup();
  const p = project(s);
  s.setPick(picked(p));
  const r = await s.call('agents:add-to-project', FE.id, sha0, '/etc', { dir: s.home });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'added');
  assert.equal(r.path, 'proj/.cursor/rules/frontend-developer.mdc');
  assert.deepEqual(s.picks, [s.page]);
  assert.ok(fs.existsSync(path.join(p, '.cursor/rules/frontend-developer.mdc')));
  assertClean(r, bannedFor(s, [p, path.dirname(p)]));
  assert.equal((await s.call('agents:undo', r.opId)).ok, false, 'not by agents:undo');
  const u = await s.call('agents:undo-project', r.opId);
  assert.equal(u.ok, true);
  assert.deepEqual(u.restored, ['proj/.cursor/rules/frontend-developer.mdc']);
  assertClean(u, bannedFor(s, [p]));
  assert.equal(fs.existsSync(path.join(p, '.cursor/rules/frontend-developer.mdc')), false);
});

test('a project under home is shown in ~ form', async () => {
  const s = setup();
  const p = path.join(s.home, 'code', 'app');
  fs.mkdirSync(p, { recursive: true });
  s.setPick(picked(p));
  const r = await s.call('agents:add-to-project', FE.id, sha0);
  assert.equal(r.path, '~/code/app/.cursor/rules/frontend-developer.mdc');
});

test('add-to-project refuses cancel, links, home, its ancestors, the disk root and the data folder', async () => {
  const s = setup();
  const real = project(s, 'real');
  const link = path.join(path.dirname(real), 'link');
  fs.symlinkSync(real, link);
  const viaParent = path.join(tmp('af-pl-'), 'parent');
  fs.symlinkSync(path.dirname(real), viaParent);
  const cases = [
    [{ canceled: true, filePaths: [] }, 'cancelled'],
    [{ canceled: false, filePaths: [] }, 'invalid'],
    [{ canceled: false, filePaths: [real, real] }, 'invalid'],
    [{ canceled: false, filePaths: ['relative/dir'] }, 'invalid'],
    [{ canceled: false, filePaths: [link] }, 'invalid'],
    [{ canceled: false, filePaths: [path.join(viaParent, 'real')] }, 'invalid'],
    [{ canceled: false, filePaths: [s.home] }, 'invalid'],
    [{ canceled: false, filePaths: [path.dirname(s.home)] }, 'invalid'],
    [{ canceled: false, filePaths: ['/'] }, 'invalid'],
    [{ canceled: false, filePaths: [s.data] }, 'invalid'],
    [{ canceled: false, filePaths: [`${real}/../real`] }, 'invalid'],
    [null, 'cancelled'],
  ];
  for (const [res, code] of cases) {
    s.setPick(async () => res);
    assert.equal((await s.call('agents:add-to-project', FE.id, sha0)).code, code, JSON.stringify(res));
  }
  assert.equal(fs.existsSync(path.join(real, '.cursor')), false);
});

test('a mount point (another volume, e.g. /Volumes/X) is refused', async () => {
  let mount = null;
  const fsApi = { ...fs, lstatSync: (p, ...a) => { const st = fs.lstatSync(p, ...a); return p === mount ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }) : st; } };
  const s = setup({ fsApi });
  mount = project(s, 'vol');
  s.setPick(picked(mount));
  assert.equal((await s.call('agents:add-to-project', FE.id, sha0)).code, 'invalid');
  assert.equal(fs.existsSync(path.join(mount, '.cursor')), false);
});

test('a planted .cursor or .cursor/rules link is refused and nothing lands in its target', async () => {
  const s = setup();
  const target = path.join(s.home, '.claude', 'agents');
  fs.mkdirSync(target, { recursive: true });
  const a = project(s, 'a');
  fs.symlinkSync(path.join(s.home, '.claude'), path.join(a, '.cursor'));
  s.setPick(picked(a));
  assert.equal((await s.call('agents:add-to-project', FE.id, sha0)).ok, false);
  const b = project(s, 'b');
  fs.mkdirSync(path.join(b, '.cursor'));
  fs.symlinkSync(target, path.join(b, '.cursor', 'rules'));
  s.setPick(picked(b));
  assert.equal((await s.call('agents:add-to-project', FE.id, sha0)).ok, false);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.existsSync(path.join(s.home, '.claude', 'rules')), false);
});

test('an existing rule file in the project is skipped with its bytes unchanged', async () => {
  const s = setup();
  const p = project(s);
  fs.mkdirSync(path.join(p, '.cursor/rules'), { recursive: true });
  fs.writeFileSync(path.join(p, '.cursor/rules/frontend-developer.mdc'), 'mine\n');
  s.setPick(picked(p));
  const r = await s.call('agents:add-to-project', FE.id, sha0);
  assert.equal(r.status, 'skipped');
  assert.equal(r.opId, null);
  assert.equal(fs.readFileSync(path.join(p, '.cursor/rules/frontend-developer.mdc'), 'utf8'), 'mine\n');
});

// ── review 5: one lock, held across the picker; re-checks after it ──
test('a second write while the picker is open is busy; demo or a closed page during it writes nothing', async () => {
  const s = setup();
  const p = project(s);
  let release;
  s.setPick(() => new Promise((res) => { release = () => res({ canceled: false, filePaths: [p] }); }));
  const first = s.call('agents:add-to-project', FE.id, sha0);
  await new Promise((r) => setImmediate(r));
  assert.equal((await s.call('agents:add', FE.id, sha0, ['claude'])).code, 'busy');
  assert.equal((await s.call('agents:add-to-project', FE.id, sha0)).code, 'busy');
  s.demo.on = true;
  release();
  assert.equal((await first).code, 'demo');
  s.demo.on = false;
  assert.equal(fs.existsSync(path.join(p, '.cursor')), false);
  assert.equal(fs.existsSync(path.join(s.home, '.claude')), false);

  const again = s.call('agents:add-to-project', FE.id, sha0);
  await new Promise((r) => setImmediate(r));
  s.page.destroyed = true;
  release();
  assert.equal((await again).code, 'cancelled');
  s.page.destroyed = false;
  const third = s.call('agents:add-to-project', FE.id, sha0);
  await new Promise((r) => setImmediate(r));
  s.state.page = contents();
  release();
  assert.equal((await third).code, 'cancelled', 'the page was replaced while the picker was open');
  assert.equal(fs.existsSync(path.join(p, '.cursor')), false);
  assert.equal((await s.raw('agents:add', FE.id, sha0, ['claude'])).ok, false, 'old page is no longer allowed');
});

// ── review 6/7: no key, demo ──
test('without safeStorage the page browses, and every write says why it is off', async () => {
  const s = setup({ safe: fakeSafe({ on: false }) });
  const list = await s.call('agents:list');
  assert.equal(list.ok, true);
  assert.equal(list.writes.code, 'no-key');
  assert.equal((await s.call('agents:detail', FE.id)).ok, true);
  assert.equal((await s.call('agents:targets', FE.id)).ok, true);
  assert.equal((await s.call('agents:add', FE.id, sha0, ['claude'])).code, 'no-key');
  s.setPick(picked(project(s)));
  assert.equal((await s.call('agents:add-to-project', FE.id, sha0)).code, 'no-key');
  assert.deepEqual(s.picks, [], 'the picker never opens without a key');
  assert.equal(fs.existsSync(path.join(s.home, '.claude')), false);
});

test('demo: list and status say so, and writes refuse', async () => {
  const s = setup({ demoOn: true });
  const list = await s.call('agents:list');
  assert.equal(list.demo, true);
  assert.equal(list.writes.code, 'demo');
  assert.equal((await s.call('agents:status')).demo, true);
  assert.equal((await s.call('agents:add', FE.id, sha0, ['claude'])).code, 'demo');
  assert.equal(fs.existsSync(path.join(s.home, '.claude')), false);
});

test('review 10: demo:exit and demo:start from the Find agents page are refused (main.js allow-list unchanged)', async () => {
  const handlers = new Map();
  const pages = { home: contents(), tasks: contents(), help: contents(), discover: contents(), 'agents-find': contents() };
  const fromUtilityPage = (e, id) => fromPage(e, pages[id]);
  const demo = { on: true, active() { return this.on; }, start() { this.on = true; }, exit() { this.on = false; } };
  require('../src/demo-mode.js').register({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, demo, allowed: (e) => ['home', 'tasks', 'help', 'discover'].some((p) => fromUtilityPage(e, p)) });
  assert.equal(await handlers.get('demo:exit')(ev(pages['agents-find'])), null);
  assert.equal(await handlers.get('demo:start')(ev(pages['agents-find'])), null);
  assert.equal(demo.on, true);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/src\/demo-mode\.js'\)\.register\(\{ ipcMain, demo: Demo, allowed: \(e\) => \['home', 'tasks', 'help', 'discover'\]\.some/);
});

// ── review 3: exception text never reaches the page ──
test('a thrown error carrying a path comes back as a fixed sentence, and only its code is logged', async () => {
  const boom = (it) => ({ ...it, add() { const e = new Error(`EACCES: permission denied, open '${path.join(os.homedir(), '.claude/agents/x.md')}'`); e.code = 'EACCES'; throw e; } });
  const s = setup({ installerWrap: boom });
  const r = await s.call('agents:add', FE.id, sha0, ['claude']);
  assert.equal(r.code, 'failed');
  assert.ok(!r.error.includes('/'));
  assertClean(r, [...bannedFor(s), os.homedir(), 'EACCES']);
  assert.deepEqual(s.logs, ['[agents-find] agents:add failed (EACCES)']);
});

test('a damaged catalogue: every page channel returns its error and nothing else', async () => {
  const s = setup({ catalog: { ok: false, error: 'The agent catalogue is damaged. Reinstall Plexiform.' } });
  for (const ch of ['agents:list', 'agents:detail', 'agents:targets', 'agents:status', 'agents:add', 'agents:undo', 'agents:add-to-project', 'agents:undo-project']) {
    assert.deepEqual(await s.call(ch, FE.id, sha0, ['claude']), { ok: false, code: 'catalogue', error: 'The agent catalogue is damaged. Reinstall Plexiform.' }, ch);
  }
});

// ── review 8: the dev-only overrides ──
test('dev overrides: ignored when packaged; only absolute, existing, non-link folders otherwise', () => {
  const d = tmp('af-dev-');
  const link = path.join(tmp('af-dev-'), 'l');
  fs.symlinkSync(d, link);
  const file = path.join(d, 'f');
  fs.writeFileSync(file, '');
  assert.deepEqual(Main.devOverrides({ isPackaged: true, env: { PLEXIFORM_AGENTS_HOME: d, PLEXIFORM_AGENTS_DATA: d } }), {});
  assert.deepEqual(Main.devOverrides({ isPackaged: false, env: { PLEXIFORM_AGENTS_HOME: d, PLEXIFORM_AGENTS_DATA: d } }), { home: d, data: d });
  const logs = [];
  for (const v of [link, file, 'rel/dir', path.join(d, 'missing')]) assert.deepEqual(Main.devOverrides({ isPackaged: false, env: { PLEXIFORM_AGENTS_HOME: v }, log: (m) => logs.push(m) }), {}, v);
  assert.equal(logs.length, 4);
  assert.ok(logs.every((m) => !m.includes(d)), 'the log names the variable, not the path');
});

test('main.js keeps the key under the dev data folder, gives Health only a cached key, and gates the overrides on isPackaged', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /Main\.devOverrides\(\{ isPackaged: app\.isPackaged, env: process\.env/);
  assert.match(main, /createLedgerKeyStore\(\{ file: path\.join\(dataRoot, 'agent-installs\.key'\)/);
  assert.match(main, /agentLedgerKey: AgentsFind\.cachedKey\(\)/);
  assert.doesNotMatch(main, /PLEXIFORM_AGENTS_FAKE_SEAL/);
  assert.match(main, /allowed: \(e\) => fromUtilityPage\(e, 'agents-find'\), discoverAllowed: \(e\) => fromUtilityPage\(e, 'discover'\)/);
});
