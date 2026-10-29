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
  // A working keyring: on Linux an unknown backend is refused by design (the weak-backend test is in agent-install.test.js).
  return { calls, isEncryptionAvailable: () => on, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (s) => { calls.encrypt++; return Buffer.from(`sealed:${s}`); }, decryptString: (b) => { calls.decrypt++; return b.toString().slice(7); } };
}
function frame() { return { id: Math.random() }; }
function contents() { const c = { mainFrame: frame(), destroyed: false, isDestroyed: () => c.destroyed }; return c; }
const ev = (c, f = c.mainFrame) => ({ sender: c, senderFrame: f });

function setup({ safe = fakeSafe(), demoOn = false, catalog = catalogOf(), pick = null, installerWrap = null, fsApi, answer = () => true, dataUnderHome = false } = {}) {
  const home = tmp('af-home-'), data = dataUnderHome ? path.join(home, 'Library', 'Plexiform') : tmp('af-data-');
  if (dataUnderHome) fs.mkdirSync(data, { recursive: true });
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
  const state = { page, now: 1_000_000, answer };
  const confirms = [], shown = [];
  const r = Main.register({
    confirm: async (sender, text) => { confirms.push({ sender, ...text }); return state.answer(text, sender); },
    showItem: (p) => shown.push(p), clock: () => state.now,
    ipcMain, allowed: (e) => fromPage(e, state.page), discoverAllowed: (e) => fromPage(e, discover), pageContents: () => state.page,
    catalog: () => catalog, keyStore: key, installer, planner, tools: () => TOOLS, demo,
    pickFolder: (sender) => { picks.push(sender); return pick ? pick(sender) : Promise.resolve({ canceled: true, filePaths: [] }); },
    home, dataRoot: data, openTools: () => opened.push('aitools'), openFindAgents: () => opened.push('agents-find'), log: (m) => logs.push(m), ...(fsApi ? { fsApi } : {}),
  });
  const call = (ch, ...a) => handlers.get(ch)(ev(page), ...a);
  const responses = [];
  const callLogged = async (ch, ...a) => { const out = await call(ch, ...a); responses.push(out); return out; };
  return { home, data, handlers, page, discover, other, demo, key, safe, call: callLogged, raw: call, picks, logs, opened, r, catalog, state, responses, confirms, shown, setPick: (fn) => { pick = fn; } };
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
  assert.deepEqual([...Main.CHANNELS].sort(), ['agents:add', 'agents:add-to-project', 'agents:detail', 'agents:list', 'agents:open-tools', 'agents:status', 'agents:targets', 'agents:undo', 'agents:undo-project', 'discover:open-find-agents',
    'agents:mine', 'agents:adoptable', 'agents:adopt', 'agents:stop-managing', 'agents:update', 'agents:remove', 'agents:undo-op', 'agents:undo-project-op', 'agents:show-backup', 'agents:backup-plan'].sort());
});

test('every channel refuses another page, a child frame of the right page, and a null frame', async () => {
  const s = setup();
  for (const [ch, fn] of s.handlers) {
    const owner = ch.startsWith('discover:') ? s.discover : s.page;
    const wrong = ch.startsWith('discover:') ? s.page : s.discover;
    for (const e of [ev(s.other), ev(wrong), ev(owner, frame()), ev(owner, null)]) assert.deepEqual(await fn(e, FE.id, sha0, ['claude']), { ok: false, code: 'not-allowed' }, ch);
  }
  assert.deepEqual(s.opened, [], 'nothing opened');
  assert.deepEqual(s.confirms, [], 'no dialog');
  assert.deepEqual(s.shown, [], 'nothing revealed');
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

// ── PR 4: manage what's added (plan §9 PR 4 design + review changes) ──
function withAgents(s, files = { 'frontend-developer.md': FE.raw }) {
  const dir = path.join(s.home, '.claude/agents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
  return dir;
}
const ledgerOps = (s) => JSON.parse(fs.readFileSync(path.join(s.data, 'agent-installs.json'), 'utf8')).ops;

test('PR4 adoptable: names and ~ paths only; reads never make the key', async () => {
  const s = setup();
  withAgents(s, { 'frontend-developer.md': FE.raw, 'mine.md': 'mine\n' });
  const r = await s.call('agents:adoptable');
  assert.deepEqual(r.matches, [{ name: 'frontend-developer.md', path: '~/.claude/agents/frontend-developer.md', agentId: FE.id, agentName: 'Frontend Developer' }]);
  assert.equal(r.userOwned, 1);
  const m = await s.call('agents:mine');
  assert.deepEqual([m.agents, m.ops, m.backups], [[], [], []]);
  assert.equal(fs.existsSync(path.join(s.data, 'agent-installs.key')), false);
  assert.equal(s.safe.calls.encrypt + s.safe.calls.decrypt, 0);
  assertClean(s.responses, bannedFor(s));
});

test('PR4 adopt: native confirm from main\'s own counts, Cancel the default; then adopts and shows a backup id only', async () => {
  const s = setup({ dataUnderHome: true });
  withAgents(s, { 'frontend-developer.md': FE.raw, 'reviewer.md': RO.raw, 'mine.md': 'mine\n' });
  const r = await s.call('agents:adopt', ['frontend-developer.md', 'reviewer.md', 'mine.md', 'not-there.md']);
  assert.equal(s.confirms.length, 1);
  assert.equal(s.confirms[0].sender, s.page);
  assert.equal(s.confirms[0].message, 'Let Plexiform manage 2 agents in ~/.claude/agents?');
  assert.match(s.confirms[0].detail, /backs up the whole ~\/\.claude\/agents folder/);
  assert.equal(s.confirms[0].ok, 'Adopt 2 agents');
  assert.equal(r.ok, true);
  assert.equal(r.adopted, 2);
  assert.equal(r.skipped, 0);
  assert.match(r.backup, /^claude-agents-\d{8}T\d{9}Z-[0-9a-f]{8}$/);
  const tag = r.backup.replace(/^claude-agents-/, '');
  assert.ok(r.restore.includes(`"$HOME/Library/Plexiform/agent-backups/${r.backup}" "$HOME/.claude/agents-restored-${tag}"`), r.restore);
  assert.ok(r.restore.includes(`mv "$HOME/.claude/agents" "$HOME/.claude/agents-old-${tag}"`), r.restore);
  assert.deepEqual(r.paths.sort(), ['~/.claude/agents/frontend-developer.md', '~/.claude/agents/reviewer.md']);
  const m = await s.call('agents:mine');
  assert.deepEqual(m.agents.map((a) => [a.name, a.platforms.map((p) => `${p.how}:${p.state}`).join()]), [['Frontend Developer', 'adopted:current'], ['reviewer', 'adopted:current']]);
  assert.equal(m.ops[0].kind, 'adopt');
  assert.equal(m.ops[0].thisRun, true);
  assert.deepEqual(m.backups.map((b) => b.id), [r.backup]);
  const banned = bannedFor(s).filter((b) => b !== s.home && b !== s.data);
  assertClean(s.responses, [...banned, path.join(s.data, 'agent-backups'), path.join(s.data, 'agent-originals')]);
  for (const x of s.responses) assert.ok(!JSON.stringify(x).includes(s.home), 'no absolute home path');
});

test('PR4 adopt: bad names are refused before any dialog; a name the page invents is never adopted', async () => {
  const s = setup();
  withAgents(s);
  for (const bad of [undefined, 'frontend-developer.md', [], Array(401).fill('a.md'), ['../x.md'], ['a/b.md'], ['.hidden.md'], ['x.txt'], [7], [{ toString: () => 'frontend-developer.md' }], ['a'.repeat(129) + '.md']]) {
    const r = await s.call('agents:adopt', bad);
    assert.equal(r.code, 'invalid', JSON.stringify(bad)?.slice(0, 40));
  }
  assert.equal((await s.call('agents:adopt', ['mine.md'])).code, 'unavailable');
  assert.deepEqual(s.confirms, []);
  assert.equal(fs.existsSync(path.join(s.data, 'agent-backups')), false);
});

test('PR4 confirm: Cancel writes nothing and makes no key; another confirm within 10 s is refused without a dialog', async () => {
  const s = setup({ answer: () => false });
  withAgents(s);
  assert.deepEqual(await s.call('agents:adopt', ['frontend-developer.md']), { ok: false, code: 'cancelled' });
  assert.equal(fs.existsSync(path.join(s.data, 'agent-installs.key')), false, 'no key before a yes');
  assert.equal(fs.existsSync(path.join(s.data, 'agent-backups')), false);
  s.state.answer = () => true;
  s.state.now += 9_999;
  const again = await s.call('agents:adopt', ['frontend-developer.md']);
  assert.equal(again.code, 'cooldown');
  assert.equal(s.confirms.length, 1, 'no second dialog');
  s.state.now += 2;
  assert.equal((await s.call('agents:adopt', ['frontend-developer.md'])).ok, true);
  assert.equal(s.confirms.length, 2);
});

test('PR4 confirm: a file edited while the adopt dialog is open is skipped; the result counts what happened', async () => {
  const s = setup();
  const dir = withAgents(s, { 'frontend-developer.md': FE.raw, 'reviewer.md': RO.raw });
  s.state.answer = () => { fs.appendFileSync(path.join(dir, 'reviewer.md'), 'edit\n'); return true; };
  const r = await s.call('agents:adopt', ['frontend-developer.md', 'reviewer.md']);
  assert.equal(s.confirms[0].ok, 'Adopt 2 agents');
  assert.equal(r.adopted, 1);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.paths, ['~/.claude/agents/frontend-developer.md']);
});

// (A keychain lost mid-run isn't a case: L1 asks safeStorage once per run.)
test('PR4 confirm: demo, a closed or replaced page, or a new catalogue during the dialog write nothing', async () => {
  const cases = {
    demo: (s) => { s.demo.on = true; },
    closed: (s) => { s.page.destroyed = true; },
    replaced: (s) => { s.state.page = contents(); },
  };
  for (const [name, during] of Object.entries(cases)) {
    const s = setup({ safe: fakeSafe() });
    withAgents(s);
    s.state.answer = () => { during(s); return true; };
    const r = await s.call('agents:adopt', ['frontend-developer.md']);
    assert.equal(r.ok, false, name);
    assert.equal(fs.existsSync(path.join(s.data, 'agent-backups')), false, name);
    assert.equal(fs.existsSync(path.join(s.data, 'agent-installs.json')), false, name);
  }
  let cat = catalogOf();
  const s = setup({ catalog: cat });
  withAgents(s);
  s.catalog.sha256 = 'c'.repeat(64);
  s.state.answer = () => { s.catalog.sha256 = 'd'.repeat(64); return true; };
  const r = await s.call('agents:adopt', ['frontend-developer.md']);
  assert.equal(r.code, 'changed');
  assert.equal(fs.existsSync(path.join(s.data, 'agent-installs.json')), false);
});

test('PR4 demo and no keychain: every manage write refuses before any dialog', async () => {
  for (const opts of [{ demoOn: true }, { safe: fakeSafe({ on: false }) }]) {
    const s = setup(opts);
    withAgents(s);
    for (const [ch, ...a] of [['agents:adopt', ['frontend-developer.md']], ['agents:update', FE.id, sha0], ['agents:remove', FE.id], ['agents:stop-managing'], ['agents:undo-op', '00000000-0000-4000-8000-000000000000']]) {
      const r = await s.call(ch, ...a);
      assert.equal(r.ok, false, ch);
    }
    assert.deepEqual(s.confirms, []);
  }
});

test('PR4 stop managing, update and remove from all: confirms for the bulk ones, results with ~ paths only', async () => {
  const s = setup();
  const v2 = { ...FE, raw: `${FE.raw}\nVersion 2.\n` };
  v2.fileSha256 = sha(v2.raw);
  await s.call('agents:add', FE.id, sha0, ['claude', 'codex']);
  withAgents(s, { 'reviewer.md': RO.raw });
  await s.call('agents:adopt', ['reviewer.md']);
  // A newer catalogue: update needs no native confirm (the page asks).
  const cat2 = catalogOf([v2, RO], 'e'.repeat(64));
  Object.assign(s.catalog, { sha256: cat2.sha256, get: cat2.get, catalog: cat2.catalog });
  const n = s.confirms.length;
  const up = await s.call('agents:update', FE.id, cat2.sha256);
  assert.equal(s.confirms.length, n, 'update has no native dialog');
  assert.deepEqual(up.results.map((x) => x.status).sort(), ['updated', 'updated']);
  assert.ok(up.results.every((x) => x.path.startsWith('~/')));
  assert.equal((await s.call('agents:update', FE.id, sha0)).code, 'changed');
  const rm = await s.call('agents:remove', FE.id);
  assert.equal(s.confirms.at(-1).message, 'Remove Frontend Developer from all your AI tools?');
  assert.match(s.confirms.at(-1).detail, /2 files Plexiform added will be deleted/);
  assert.equal(rm.ok, true);
  assert.ok(!fs.existsSync(path.join(s.home, '.claude/agents/frontend-developer.md')));
  const st = await s.call('agents:stop-managing');
  assert.equal(s.confirms.at(-1).message, 'Stop managing 1 agent you installed yourself?');
  assert.equal(st.released, 1);
  assert.equal(fs.readFileSync(path.join(s.home, '.claude/agents/reviewer.md'), 'utf8'), RO.raw);
  assert.equal((await s.call('agents:stop-managing')).code, 'unavailable', 'nothing left: no dialog');
  assert.equal((await s.call('agents:remove', 'agency/nope')).code, 'unavailable');
  assertClean(s.responses, bannedFor(s).filter((b) => b !== s.home).concat([path.join(s.home, '.claude')]));
});

test('PR4 undo-op: an earlier run\'s op from the signed ledger, after a confirm; random, undone and forged ids are refused', async () => {
  const s = setup();
  const add = await s.call('agents:add', FE.id, sha0, ['claude']);
  // A fresh register over the same folders: an earlier run.
  const handlers = new Map();
  const confirms = [];
  Main.register({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, allowed: (e) => fromPage(e, s.page), discoverAllowed: () => false, pageContents: () => s.page,
    catalog: () => s.catalog, keyStore: createLedgerKeyStore({ file: path.join(s.data, 'agent-installs.key'), safeStorage: s.safe }),
    installer: (k) => createAgentInstaller({ home: s.home, dataRoot: s.data, catalog: s.catalog, ledgerKey: k }), planner: () => createAgentInstaller({ home: s.home, dataRoot: s.data, catalog: s.catalog, ledgerKey: Buffer.alloc(32, 1) }),
    tools: () => TOOLS, demo: { active: () => false }, home: s.home, dataRoot: s.data, confirm: async (_s, t) => { confirms.push(t); return true; }, clock: () => 0,
  });
  const call = (ch, ...a) => handlers.get(ch)(ev(s.page), ...a);
  const mine = await call('agents:mine');
  assert.equal(mine.ops[0].opId, add.opId);
  assert.equal(mine.ops[0].thisRun, false);
  assert.equal((await call('agents:undo', add.opId)).code, 'unavailable', 'the quick Undo stays this-run only');
  for (const bad of ['00000000-0000-4000-8000-000000000000', 'x', null, `${add.opId}x`]) assert.equal((await call('agents:undo-op', bad)).code, 'unavailable');
  assert.deepEqual(confirms, []);
  assert.equal((await call('agents:undo-project-op', add.opId)).code, 'unavailable', 'wrong channel for the kind');
  const u = await call('agents:undo-op', add.opId);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].message, /^Undo "Add" for Frontend Developer\?$/);
  assert.equal(u.ok, true);
  assert.ok(!fs.existsSync(path.join(s.home, '.claude/agents/frontend-developer.md')));
  assert.equal((await call('agents:undo-op', add.opId)).code, 'unavailable', 'only once');
  // A forged op added to the ledger file is not signed, so the ledger is refused whole.
  const file = path.join(s.data, 'agent-installs.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.ops.push({ ...j.ops[0], id: '11111111-1111-4111-8111-111111111111', undone: undefined });
  fs.writeFileSync(file, JSON.stringify(j));
  assert.equal((await call('agents:undo-op', '11111111-1111-4111-8111-111111111111')).ok, false);
  assert.equal(confirms.length, 1);
});

test('PR4 undo-op: the op is re-read after the confirm, so one undone meanwhile is not undone twice', async () => {
  const s = setup();
  const add = await s.call('agents:add', FE.id, sha0, ['claude']);
  s.state.answer = () => { createAgentInstaller({ home: s.home, dataRoot: s.data, catalog: s.catalog, ledgerKey: s.key.cached() }).undo(add.opId); return true; };
  const r = await s.call('agents:undo-op', add.opId);
  assert.equal(r.code, 'unavailable');
});

test('PR4 show-backup and backup-plan: listed ids only; the folder is revealed by main, never sent', async () => {
  const s = setup();
  withAgents(s);
  const a = await s.call('agents:adopt', ['frontend-developer.md']);
  const root = path.join(s.data, 'agent-backups');
  for (const bad of ['../x', '', null, 'claude-agents-20000101T000000000Z-deadbeef', `${a.backup}/../..`, a.backup.toUpperCase()]) {
    assert.equal((await s.call('agents:show-backup', bad)).code, 'unavailable', String(bad));
    assert.equal((await s.call('agents:backup-plan', bad)).code, 'unavailable');
  }
  // A planted link with a valid name is never revealed.
  fs.symlinkSync(tmp(), path.join(root, 'claude-agents-20000102T000000000Z-deadbeef'));
  assert.equal((await s.call('agents:show-backup', 'claude-agents-20000102T000000000Z-deadbeef')).code, 'unavailable', 'a link is never revealed');
  assert.deepEqual(s.shown, []);
  assert.deepEqual(await s.call('agents:show-backup', a.backup), { ok: true });
  assert.deepEqual(s.shown, [path.join(root, a.backup)]);
  fs.writeFileSync(path.join(s.home, '.claude/agents/new.md'), 'x');
  const plan = await s.call('agents:backup-plan', a.backup);
  assert.deepEqual(plan.items, [{ path: '~/.claude/agents/frontend-developer.md', state: 'same' }, { path: '~/.claude/agents/new.md', state: 'added-since' }]);
  assertClean(s.responses, bannedFor(s));
});

test('PR4 backup-plan runs under the write lock: busy while another action is open (review #54 L3)', async () => {
  const s = setup();
  withAgents(s);
  const a = await s.call('agents:adopt', ['frontend-developer.md']);
  assert.equal(a.ok, true);
  let release;
  s.state.answer = () => new Promise((res) => { release = () => res(false); });
  const pending = s.call('agents:stop-managing');
  await new Promise((r) => setImmediate(r));
  assert.equal((await s.call('agents:backup-plan', a.backup)).code, 'busy');
  release();
  await pending;
  assert.equal((await s.call('agents:backup-plan', a.backup)).ok, true);
});

test('PR4 Health: the fix opens Find agents on Added by me, once; nothing with no key loaded', async () => {
  const s = setup();
  assert.equal((await s.call('agents:list')).show, null);
  s.r.showMine();
  assert.equal((await s.call('agents:list')).show, 'mine');
  assert.equal((await s.call('agents:list')).show, null, 'only once');
  const { ledgerHealth } = require('../src/agent-install.js');
  assert.equal(ledgerHealth({ home: s.home, dataRoot: s.data, ledgerKey: null }), null);
  await s.call('agents:add', FE.id, sha0, ['claude']);
  fs.appendFileSync(path.join(s.home, '.claude/agents/frontend-developer.md'), 'mine\n');
  const h = ledgerHealth({ home: s.home, dataRoot: s.data, ledgerKey: s.key.cached() });
  assert.equal(h.status, 'warn');
  assert.equal(h.fix, 'agents-review');
  assert.equal(h.fixLabel, 'Review on Find agents');
  fs.writeFileSync(path.join(s.data, 'agent-installs.json'), '{');
  const f = ledgerHealth({ home: s.home, dataRoot: s.data, ledgerKey: s.key.cached() });
  assert.equal(f.status, 'fail');
  assert.equal(f.fix, 'agents-review');
});

test('PR4 main.js: native confirm with Cancel default, reveal in Finder, and the Health fix wired to openMine', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(src.includes("confirm: async (sender, { message, detail, ok }) => (await dialog.showMessageBox(BrowserWindow.fromWebContents(sender) || undefined, { type: 'warning', buttons: [String(ok), 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, message: String(message), detail: String(detail) })).response === 0,"));
  assert.match(src, /showItem: \(dir\) => shell\.showItemInFolder\(dir\)/);
  assert.match(src, /openMine: \(\) => \{ reg\.showMine\(\); openBuddy\('agents-find'\); buddyWin\?\.sendToPage\('agents-find', 'agents:show', 'mine'\); \}/);
  assert.match(src, /else if \(id === 'agents-review'\) AgentsFind\.openMine\(\);/);
  assert.equal(require('../src/health.js').FIXES['agents-review'], 'Review on Find agents');
});

// L1 keeps safeStorage's first answer for the run. If the keychain goes away
// after that, the write itself still fails closed: sealing the new key throws,
// so no key, backup, ledger or agent file is written.
test('PR4 L1: sealing that throws after the cached check refuses every write and leaves nothing behind', async () => {
  const safe = fakeSafe();
  const s = setup({ safe });
  const dir = withAgents(s);
  assert.equal((await s.call('agents:list')).writes.ok, true, 'the cached answer says writes are on');
  safe.encryptString = () => { throw new Error('keychain gone'); };
  const before = fs.readdirSync(dir).map((n) => `${n}:${sha(fs.readFileSync(path.join(dir, n)))}`);
  for (const [ch, ...a] of [['agents:adopt', ['frontend-developer.md']], ['agents:add', RO.id, sha0, ['claude']], ['agents:update', FE.id, sha0], ['agents:remove', FE.id], ['agents:stop-managing'], ['agents:undo-op', '00000000-0000-4000-8000-000000000000']]) {
    s.state.now += COOLDOWN_GAP;
    const r = await s.call(ch, ...a);
    assert.equal(r.ok, false, ch);
  }
  assert.equal((await s.call('agents:adopt', ['frontend-developer.md'])).code, 'no-key', 'refused after the dialog, at the key');
  assert.equal(fs.existsSync(path.join(s.data, 'agent-installs.key')), false);
  assert.deepEqual(fs.readdirSync(s.data).filter((n) => n.startsWith('agent-')), [], 'no key, ledger, backup or originals');
  assert.deepEqual(fs.readdirSync(dir).map((n) => `${n}:${sha(fs.readFileSync(path.join(dir, n)))}`), before);
  assert.equal(fs.existsSync(path.join(s.home, '.codex')), false);
});
const COOLDOWN_GAP = 10_001;
