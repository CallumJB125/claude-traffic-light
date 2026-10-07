'use strict';
// My setup: main-process wiring (fake electron dialogs, throwaway HOME), the
// preload's bounded bridge, and the page's review/confirm/Apply flow in JSDOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
const schema = require('../src/borrow/payload.js');

const tick = () => new Promise((r) => setImmediate(r));
const J = (v) => JSON.stringify(v, null, 2);
function envelope(files) {
  const checked = schema.validatePayload({ schema: 1, files, items: [], note: '' });
  return JSON.stringify({ kind: 'plexiform.setup', schema: 1, exported_at: new Date().toISOString(), content_hash: checked.content_hash, payload: checked.payload });
}
const mcpFile = (servers) => ({ id: randomUUID(), source_id: 'claude-code', relative_path: '.claude.json#mcpServers', format: 'json', content: J({ mcpServers: servers }), note: '' });

function wired(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plx-wiring-')));
  const home = path.join(root, 'home', 'casey');
  fs.mkdirSync(home, { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = oldHome; fs.rmSync(root, { recursive: true, force: true }); });
  const dialogs = { save: null, open: null, box: [], answer: 1 };
  const electron = require.resolve('electron');
  const cached = require.cache[electron];
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { dialog: {
    showSaveDialog: async () => (dialogs.save ? { canceled: false, filePath: dialogs.save } : { canceled: true }),
    showOpenDialog: async () => (dialogs.open ? { canceled: false, filePaths: [dialogs.open] } : { canceled: true }),
    showMessageBox: async (opts) => { dialogs.box.push(opts); return { response: dialogs.answer }; },
  } } };
  t.after(() => { if (cached) require.cache[electron] = cached; else delete require.cache[electron]; });
  const handlers = new Map(), page = {};
  const { register } = require('../src/setups-personal.js');
  register({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, rootDir: path.join(root, 'data'), entitlements: { has: (f) => f === 'setups.personal' }, fromPage: (e, id) => id === 'setups' && e.sender === page, onQuit: () => {} });
  const call = (ch, ...args) => handlers.get(ch)({ sender: page }, ...args);
  return { root, home, dialogs, handlers, call, page };
}

test('wiring registers only for the free personal entitlement and checks the sender on every channel', async (t) => {
  const w = wired(t);
  assert.deepEqual([...w.handlers.keys()].sort(), ['setups:personal-apply', 'setups:personal-backups', 'setups:personal-collect', 'setups:personal-export', 'setups:personal-import', 'setups:personal-undo', 'setups:team-plan']);
  for (const [ch, fn] of w.handlers) assert.equal(await fn({ sender: {} }), null, ch);
  const none = new Map();
  require('../src/setups-personal.js').register({ ipcMain: { handle: (c, f) => none.set(c, f) }, rootDir: w.root, entitlements: { has: () => false }, fromPage: () => true });
  assert.equal(none.size, 0);
  assert.equal((await w.call('setups:team-plan', randomUUID())).ok, false, 'no team service: unavailable');
});

test('export writes only to the file main chose, never over an existing file or link', async (t) => {
  const w = wired(t);
  fs.mkdirSync(path.join(w.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(w.home, '.claude', 'CLAUDE.md'), 'Keep diffs small.\n');
  const draft = await w.call('setups:personal-collect');
  assert.equal(draft.ok, true, draft.error);
  w.dialogs.save = path.join(w.root, 'out.json');
  assert.equal((await w.call('setups:personal-export', draft.handle, [])).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(w.dialogs.save, 'utf8')).kind, 'plexiform.setup');
  assert.equal(fs.statSync(w.dialogs.save).mode & 0o777, 0o600);
  assert.equal((await w.call('setups:personal-export', draft.handle, [])).ok, false, 'existing file kept');
  const victim = path.join(w.root, 'victim.txt');
  fs.writeFileSync(victim, 'keep');
  w.dialogs.save = path.join(w.root, 'link.json');
  fs.symlinkSync(victim, w.dialogs.save);
  assert.equal((await w.call('setups:personal-export', draft.handle, [])).ok, false);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('import refuses links and oversized files; Apply needs the native confirmation that lists commands verbatim', async (t) => {
  const w = wired(t);
  const file = path.join(w.root, 'in.json');
  fs.writeFileSync(file, envelope([mcpFile({ notes: { command: 'node', args: ['server.js', '; rm -rf ~'] } })]));
  const link = path.join(w.root, 'link.json');
  fs.symlinkSync(file, link);
  w.dialogs.open = link;
  assert.equal((await w.call('setups:personal-import')).ok, false);
  const huge = path.join(w.root, 'huge.json');
  fs.writeFileSync(huge, ' '.repeat(schema.SETUP_BODY_MAX + 1));
  w.dialogs.open = huge;
  assert.equal((await w.call('setups:personal-import')).ok, false);
  w.dialogs.open = file;
  const plan = await w.call('setups:personal-import');
  assert.equal(plan.ok, true, plan.error);
  w.dialogs.answer = 0;
  const cancelled = await w.call('setups:personal-apply', plan.handle, { selected: ['mcp:notes'], confirmed: ['mcp:notes'], values: {} });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(fs.existsSync(path.join(w.home, '.claude.json')), false);
  assert.match(w.dialogs.box[0].detail, /node server\.js ; rm -rf ~/);
  assert.equal(w.dialogs.box[0].defaultId, 0, 'Cancel is the default');
  w.dialogs.answer = 1;
  const done = await w.call('setups:personal-apply', plan.handle, { selected: ['mcp:notes'], confirmed: ['mcp:notes'], values: {} });
  assert.equal(done.ok, true, done.error);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, '.claude.json'), 'utf8')).mcpServers.notes.args[1], '; rm -rf ~');
  assert.equal((await w.call('setups:personal-apply', plan.handle, { selected: ['mcp:notes'], extra: 1 })).ok, false, 'closed input');
  const list = await w.call('setups:personal-backups');
  assert.equal(list.backups.length, 1);
  assert.equal((await w.call('setups:personal-undo', '../../x')).ok, false);
  const undone = await w.call('setups:personal-undo', done.backup_id);
  assert.equal(undone.ok, true);
  assert.equal(fs.existsSync(path.join(w.home, '.claude.json')), false);
});

test('preload: personal bridge bounds and copies arguments before IPC', async () => {
  const calls = [];
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../setups-preload.js'), 'utf8'), { TextEncoder, require: () => ({ contextBridge: { exposeInMainWorld: (_n, v) => { bridge = v; } }, ipcRenderer: { invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); }, on() {} } }) });
  const p = bridge.personal, H = randomUUID();
  for (const bad of [() => p.apply('x', { selected: ['a'], confirmed: [], values: {} }), () => p.apply(H, { selected: [], confirmed: [], values: {} }), () => p.apply(H, { selected: ['a'], confirmed: [], values: {}, path: '/etc' }), () => p.apply(H, { selected: ['a'], confirmed: [], values: { K: 'x'.repeat(4097) } }), () => p.exportFile(H, ['../x']), () => p.teamPlan('../../profile'), () => p.undo('x')]) assert.equal((await bad()).ok, false);
  assert.equal(calls.length, 0);
  const input = { selected: ['mcp:a'], confirmed: ['mcp:a'], values: { NAME: 'x' } };
  await p.apply(H, input);
  input.selected.push('mcp:b');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2].selected)), ['mcp:a']);
  assert.equal(calls[0][0], 'setups:personal-apply');
});

function page(t, personal) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../setups.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [];
  const wrap = Object.fromEntries(Object.entries(personal).map(([k, fn]) => [k, (...a) => { calls.push({ name: k, args: a }); return fn(...a); }]));
  dom.window.setupsApi = { personal: wrap, state: async () => ({ status: 'unavailable', teams: [], sources: [] }), changed() {} };
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../setups-personal.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../setups.js'), 'utf8'));
  const button = (text) => [...dom.window.document.querySelectorAll('button')].find((n) => n.textContent === text);
  const personalEl = dom.window.document.getElementById('personal');
  return { dom, calls, button, personalEl, local: dom.window.document.getElementById('local') };
}
const H = '12345678-1234-4234-8234-123456789abc';
const plan = () => ({ ok: true, handle: H, origin: 'file', content_hash: 'a'.repeat(64), expires_at: Date.now() + 60000, dropped: [{ target: '.claude/settings.json', key: 'hooks', reason: 'hooks run commands and are never imported' }], units: [
  { id: 'mcp:x', kind: 'mcp', label: 'MCP server: x', target: '.claude.json#mcpServers', status: 'ready', requires_confirm: true, reason: 'starts a command', command: 'sh -c "<img src=x onerror=window.pwned=1>"', placeholders: ['SECRET:TOKEN'], before: null, after: '{}', diff: [{ op: '+', text: '<b>new</b>' }] },
  { id: 'file:1', kind: 'rules', label: '.claude/CLAUDE.md', target: '.claude/CLAUDE.md', status: 'ready', requires_confirm: false, reason: null, command: null, placeholders: [], before: 'a', after: 'b', diff: [{ op: '-', text: 'a' }, { op: '+', text: 'b' }] },
] });

test('page: the native helper panel stays hidden; imported MCP commands render as text and need their own tick and value', async (t) => {
  const f = page(t, { importFile: async () => plan(), apply: async () => ({ ok: true, backup_id: H, applied: 2, files: 2 }), undo: async () => ({ ok: true, restored: ['x'], conflicts: [] }), collect: async () => ({ ok: false }), backups: async () => ({ ok: true, backups: [] }) });
  await tick();
  assert.equal(f.local.hidden, true);
  f.button('Import a setup file…').click();
  await tick();
  assert.equal(f.dom.window.pwned, undefined);
  assert.ok(f.personalEl.querySelector('.personal-command').textContent.includes('<img src=x'));
  assert.ok(f.personalEl.textContent.includes('Never imported: hooks'));
  const apply = f.button('Apply selected changes…');
  assert.equal(apply.disabled, true);
  const boxes = [...f.personalEl.querySelectorAll('.personal-unit input[type=checkbox]')];
  const tick1 = (b) => { b.checked = true; b.dispatchEvent(new f.dom.window.Event('change')); };
  tick1(boxes[0]);
  assert.equal(apply.disabled, true, 'MCP needs its own confirmation');
  tick1(boxes[1]);
  assert.equal(apply.disabled, true, 'its placeholder needs a value');
  const secret = f.personalEl.querySelector('input[type=password]');
  secret.value = 'mine';
  secret.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(apply.disabled, false);
  apply.click();
  await tick();
  const sent = f.calls.find((c) => c.name === 'apply').args;
  assert.equal(sent[0], H);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1])), { selected: ['mcp:x'], confirmed: ['mcp:x'], values: { 'SECRET:TOKEN': 'mine' } });
  assert.equal(secret.value, '', 'typed secrets are cleared from the page');
  assert.ok(f.personalEl.textContent.includes('A backup was saved first'));
  f.button('Undo this Apply…').click();
  await tick();
  assert.deepEqual(f.calls.find((c) => c.name === 'undo').args, [H]);
});

test('page: export needs a review tick and sends only the files left out', async (t) => {
  const A = randomUUID(), B = randomUUID();
  const f = page(t, { collect: async () => ({ ok: true, handle: H, files: [{ id: A, relative_path: '.claude/CLAUDE.md', kind: 'rules', code: false, content: 'rules' }, { id: B, relative_path: '.claude/skills/x/run.sh', kind: 'skill', code: true, content: 'echo' }], withheld: [{ path: '.claude/hooks/a.sh', reason: 'hooks run commands and are never exported' }], dropped_settings: ['hooks'] }), exportFile: async () => ({ ok: true, files: 1 }) });
  await tick();
  f.button('Export my setup…').click();
  await tick();
  const save = f.button('Save export file…');
  assert.equal(save.disabled, true);
  const labels = [...f.personalEl.querySelectorAll('label')];
  const skill = labels.find((l) => l.textContent.includes('run.sh')).querySelector('input');
  skill.checked = false;
  skill.dispatchEvent(new f.dom.window.Event('change'));
  const reviewed = labels.find((l) => l.textContent.includes('I reviewed')).querySelector('input');
  reviewed.checked = true;
  reviewed.dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(save.disabled, false);
  save.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find((c) => c.name === 'exportFile').args)), [H, [B]]);
  assert.ok(f.personalEl.textContent.includes('Exported 1 file'));
});

test('page: a team setup offers the same preview through its opaque handle', async (t) => {
  const P = randomUUID();
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../setups.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const seen = [];
  dom.window.setupsApi = { changed() {}, personal: { teamPlan: async (h) => { seen.push(h); return { ...plan(), origin: 'team' }; } },
    state: async () => ({ status: 'complete', sources: [], teams: [{ name: 'Team', handle: randomUUID(), role: 'member', status: 'complete', profiles: [{ handle: P, own: false, version: 1, files: 1, items: 0 }] }] }),
    read: async () => ({ ok: true, version: 1, versions: [], own: false, payload: { files: [], items: [], note: '' } }), action: async () => ({ ok: true }) };
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../setups-personal.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../setups.js'), 'utf8'));
  await tick();
  const button = (text) => [...dom.window.document.querySelectorAll('button')].find((n) => n.textContent === text);
  button('Review').click();
  await tick();
  button('Preview applying this setup here').click();
  await tick();
  assert.deepEqual(seen, [P]);
  assert.ok(dom.window.document.getElementById('review').textContent.includes('Apply this team setup on this computer'));
  assert.equal(button('Create masked local plan'), undefined, 'native helper plan stays hidden');
});
