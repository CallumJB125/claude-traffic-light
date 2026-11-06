'use strict';
// src/enrol/registry.js (BACKBONE-AUDIT-AND-PLAN §4 Lane 1, acceptance 1-4): every AI tool's MCP entry and
// instruction block, added once, a no-op the second time, never over a foreign entry, comments kept, and undone byte
// for byte. Scratch homes only: nothing here reads or writes the person's own configs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const Registry = require('../src/enrol/registry.js');
const Jsonc = require('../src/enrol/jsonc.js');
const Instr = require('../src/enrol/instructions.js');
const McpInstall = require('../mcp-install.js');
const { TIERS } = require('../src/bus-contract.js');
const { testTempDir } = require('./helpers/tmp');

const PACKAGED = { packaged: true, execPath: '/Applications/Plexiform.app/Contents/MacOS/Plexiform', appPath: '/Applications/Plexiform.app/Contents/Resources/app.asar', dir: '/repo' };
const DEV = { packaged: false, execPath: '/x/electron', appPath: '/repo', dir: '/repo' };
const AS = path.join('Library', 'Application Support');
const FILES = {
  codexAgents: '.codex/AGENTS.md',
  gemini: '.gemini/settings.json',
  geminiMd: '.gemini/GEMINI.md',
  cursor: '.cursor/mcp.json',
  vscode: `${AS}/Code/User/mcp.json`,
  desktop: `${AS}/Claude/claude_desktop_config.json`,
  hermes: '.hermes/config.yaml',
};
const ORIGINAL = {
  codexAgents: '# Global Codex notes\n\nAlways run the tests.\n',
  gemini: '{\n  "theme": "GitHub",\n  "mcpServers": {\n    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }\n  }\n}\n',
  geminiMd: '# Mine\nPrefer small diffs.',
  cursor: '{\n    "mcpServers": {}\n}\n',
  vscode: '{\n\t// Servers I use at work\n\t"servers": {\n\t\t"github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" }, // keep this one\n\t},\n\t/* inputs */\n\t"inputs": []\n}',
  desktop: '{"coworkUserFilesPath":"/Users/me/Claude","preferences":{"quickEntryShortcut":"off"}}',
  hermes: 'model:\n  default: anthropic/claude-sonnet\n# MCP servers\nmcp_servers:\n  qmd:\n    command: "qmd"\n    args: ["mcp"]\nplugins:\n  enabled:\n  - plexiform-activity\n',
};

function world(t, { files = ORIGINAL, launch = PACKAGED } = {}) {
  const dir = testTempDir('pf-enrol-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const root = path.join(home, '.claude-traffic-light');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  for (const [k, rel] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    if (files[k] !== undefined && files[k] !== null) fs.writeFileSync(path.join(home, rel), files[k]);
  }
  const state = { launch };
  const make = (o = {}) => Registry.create({ home, rootDir: root, launch: () => (state.launch ? McpInstall.launch({ ...state.launch, profile: 'bus' }) : null), ...o });
  const read = (k) => { try { return fs.readFileSync(path.join(home, FILES[k]), 'utf8'); } catch { return null; } };
  const snap = () => Object.fromEntries(Object.keys(FILES).map((k) => [k, read(k)]));
  return { dir, home, root, state, make, read, snap, write: (k, text) => fs.writeFileSync(path.join(home, FILES[k]), text) };
}
const entryIn = (w, k, key) => Jsonc.get(w.read(k), key, 'plexiform-bus');

test('acceptance 1: one enrolAll adds one marker-tagged entry per tool, a second run is byte-identical, unenrolAll restores every original', (t) => {
  const w = world(t);
  const before = w.snap();
  const reg = w.make();
  const r = reg.enrolAll({ mcpOurs: { codex: true } });
  assert.deepEqual(Object.fromEntries(Object.entries(r.results).filter(([, v]) => v.installed).map(([id, v]) => [id, v.mcp.state])),
    { codex: 'external', gemini: 'ours', cursor: 'ours', vscode: 'ours', 'claude-desktop': 'ours', hermes: 'ours' });

  for (const [k, key, client] of [['gemini', ['mcpServers'], 'gemini'], ['cursor', ['mcpServers'], 'cursor'], ['vscode', ['servers'], 'vscode'], ['desktop', ['mcpServers'], 'claude-desktop']]) {
    const e = entryIn(w, k, key);
    assert.equal(e.env.PLEXIFORM_MCP, 'bus-v1:packaged', `${k} carries our marker`);
    assert.equal(e.env.PLEXIFORM_CLIENT, client, `${k} says which tool it is`);
    assert.deepEqual(e.args.slice(-2), ['--profile', 'bus'], `${k} runs the bus profile`);
    assert.equal(w.read(k).split('"plexiform-bus"').length, 2, `${k}: exactly one entry`);
  }
  assert.equal(entryIn(w, 'vscode', ['servers']).type, 'stdio');
  const h = yaml.load(w.read('hermes'));
  assert.equal(h.mcp_servers['plexiform-bus'].env.PLEXIFORM_CLIENT, 'hermes');
  assert.deepEqual(h.mcp_servers.qmd, { command: 'qmd', args: ['mcp'] }, 'the person\'s Hermes server is untouched');
  assert.deepEqual(h.plugins, { enabled: ['plexiform-activity'] });
  assert.ok(Instr.has(w.read('codexAgents')) && Instr.has(w.read('geminiMd')), 'Codex and Gemini get the block');
  assert.ok(w.read('codexAgents').startsWith(ORIGINAL.codexAgents) && w.read('geminiMd').startsWith(ORIGINAL.geminiMd), 'text before the block untouched');

  const after = w.snap();
  const again = reg.enrolAll({ mcpOurs: { codex: true } });
  assert.equal(again.changed, false);
  assert.deepEqual(w.snap(), after, 'second run writes nothing');
  assert.deepEqual(w.make().enrolAll({ mcpOurs: { codex: true } }).changed, false, 'and so does a fresh instance over the same record');

  reg.unenrolAll();
  assert.deepEqual(w.snap(), before, 'byte-identical originals');
  assert.deepEqual(fs.readdirSync(path.join(w.root, 'enrol-backups')), [], 'byte-identical undo drops its backups');
  const rec = JSON.parse(fs.readFileSync(reg.recordFile, 'utf8'));
  assert.deepEqual(rec.tools, {});
  if (process.platform !== 'win32') assert.equal(fs.statSync(reg.recordFile).mode & 0o777, 0o600);
});

test('acceptance 1: missing config files are created, and removed again on undo', (t) => {
  const w = world(t, { files: { hermes: 'model:\n  default: x' } });
  const reg = w.make();
  reg.enrolAll({ mcpOurs: { codex: true } });
  assert.deepEqual(entryIn(w, 'gemini', ['mcpServers']).env.PLEXIFORM_CLIENT, 'gemini');
  assert.deepEqual(entryIn(w, 'vscode', ['servers']).env.PLEXIFORM_CLIENT, 'vscode');
  assert.ok(yaml.load(w.read('hermes')).mcp_servers['plexiform-bus'], 'a new mcp_servers section, after a file with no final newline');
  assert.equal(yaml.load(w.read('hermes')).model.default, 'x');
  assert.equal(w.read('codexAgents').startsWith('<!-- BEGIN PLEXIFORM'), true);
  reg.unenrolAll();
  for (const k of ['gemini', 'geminiMd', 'cursor', 'vscode', 'desktop', 'codexAgents']) assert.equal(w.read(k), null, `${k} is gone again`);
  assert.equal(w.read('hermes'), 'model:\n  default: x');
});

test('a tool that is not installed is left alone; Codex gets its block only while its MCP entry is ours', (t) => {
  const w = world(t);
  fs.rmSync(path.join(w.home, '.cursor'), { recursive: true });
  const reg = w.make();
  const r = reg.enrolAll({ mcpOurs: { codex: false } });
  assert.equal(r.results.cursor.installed, false);
  assert.ok(!fs.existsSync(path.join(w.home, FILES.cursor)), 'no ~/.cursor made');
  assert.equal(w.read('codexAgents'), ORIGINAL.codexAgents, 'no block for tools Codex does not have');
  reg.enrolAll({ mcpOurs: { codex: true } });
  assert.ok(Instr.has(w.read('codexAgents')));
  reg.enrolAll({ mcpOurs: { codex: false } });
  assert.equal(w.read('codexAgents'), ORIGINAL.codexAgents, 'and it goes when the tools go');
});

test('acceptance 2: a foreign same-named entry is a conflict, untouched, and unenrol leaves it', (t) => {
  const foreign = '{\n  "mcpServers": {\n    "plexiform-bus": { "command": "my-own-thing" }\n  }\n}\n';
  const w = world(t, { files: { ...ORIGINAL, cursor: foreign, hermes: 'mcp_servers:\n  plexiform-bus:\n    command: "mine"\n' } });
  const reg = w.make();
  const r = reg.enrolAll();
  assert.equal(r.results.cursor.mcp.state, 'conflict');
  assert.equal(r.results.hermes.mcp.state, 'conflict');
  assert.equal(w.read('cursor'), foreign);
  const caps = reg.caps();
  const c = caps.find((x) => x.id === 'cursor');
  assert.equal(c.mcp, 'conflict');
  assert.match(c.reason, /not Plexiform's/);
  reg.unenrolAll();
  assert.equal(w.read('cursor'), foreign);
  assert.equal(w.read('hermes'), 'mcp_servers:\n  plexiform-bus:\n    command: "mine"\n');
});

test('acceptance 2: another copy of Plexiform\'s entry (dev vs installed) is left to that copy', (t) => {
  const w = world(t);
  w.make().enrolAll();
  const installed = w.snap();
  w.state.launch = DEV;
  const dev = w.make();
  const r = dev.enrolAll();
  assert.equal(r.results.gemini.mcp.state, 'other-channel');
  assert.equal(r.results.hermes.mcp.state, 'other-channel');
  assert.deepEqual(w.snap().gemini, installed.gemini);
});

test('acceptance 2: JSONC comments and trailing commas survive add and remove; the person\'s later edits survive undo', (t) => {
  const w = world(t);
  const reg = w.make();
  reg.enrolAll();
  const text = w.read('vscode');
  for (const c of ['// Servers I use at work', '// keep this one', '/* inputs */']) assert.ok(text.includes(c), `kept: ${c}`);
  assert.match(text, /"github": \{[^\n]*\}, \/\/ keep this one\n/, 'the comment stays on its own member\'s line');
  assert.deepEqual(Object.keys(Jsonc.parse(text).servers), ['github', 'plexiform-bus']);
  // The person adds a server after ours, then turns the bus off.
  w.write('vscode', text.replace('\t\t},\n\t},', '\t\t},\n\t\t"mine": { "command": "x" },\n\t},'));
  reg.unenrolAll();
  const left = w.read('vscode');
  assert.deepEqual(Object.keys(Jsonc.parse(left).servers), ['github', 'mine'], 'theirs stays, ours goes');
  assert.ok(left.includes('// keep this one'));
});

test('an unreadable config is reported and never written', (t) => {
  const w = world(t, { files: { ...ORIGINAL, gemini: '{ "theme": ' } });
  const r = w.make().enrolAll();
  assert.equal(r.results.gemini.mcp.state, 'error');
  assert.equal(w.read('gemini'), '{ "theme": ');
  assert.equal(r.results.gemini.instructions.state, 'none', 'no block telling Gemini about tools it does not have');
  assert.equal(w.read('geminiMd'), ORIGINAL.geminiMd);
});

test('a moved app (same copy, new path) rewrites our entry in place, and undo still restores the original', (t) => {
  const w = world(t);
  const before = w.snap();
  const reg = w.make();
  reg.enrolAll();
  w.state.launch = { ...PACKAGED, execPath: '/Applications/Other/Plexiform.app/Contents/MacOS/Plexiform' };
  const r = reg.enrolAll();
  assert.equal(r.results.gemini.mcp.changed, true);
  assert.equal(entryIn(w, 'gemini', ['mcpServers']).command, '/Applications/Other/Plexiform.app/Contents/MacOS/Plexiform');
  assert.equal(yaml.load(w.read('hermes')).mcp_servers['plexiform-bus'].command, '/Applications/Other/Plexiform.app/Contents/MacOS/Plexiform');
  assert.equal(reg.enrolAll().changed, false);
  reg.unenrolAll();
  assert.deepEqual(w.snap(), before);
});

test('acceptance 3: the block is updated in place on a version bump; text around it never changes', (t) => {
  const w = world(t);
  const reg = w.make();
  reg.enrolAll({ mcpOurs: { codex: true } });
  const cur = w.read('codexAgents');
  const old = cur.replace(/<!-- BEGIN PLEXIFORM v[^ ]+/, '<!-- BEGIN PLEXIFORM v1-00000000').replace(/Plexiform connects[^\n]*/, 'An older text.');
  w.write('codexAgents', `${old}\n## After\nMy later notes.\n`);
  const r = reg.enrolAll({ mcpOurs: { codex: true } });
  assert.equal(r.results.codex.instructions.changed, true);
  const now = w.read('codexAgents');
  assert.ok(now.startsWith(ORIGINAL.codexAgents));
  assert.ok(now.endsWith('\n## After\nMy later notes.\n'), 'text after the block kept');
  assert.equal(Instr.find(now).current, Instr.block(TIERS.LOCAL_ATTESTED).text);
  assert.equal(reg.caps().find((c) => c.id === 'codex').instructions, 'ours');
  reg.unenrolAll();
  assert.equal(w.read('codexAgents'), `${ORIGINAL.codexAgents}\n## After\nMy later notes.\n`);
});

test('acceptance 3: a broken block (start marker without end) is a conflict and left alone', (t) => {
  const broken = '# mine\n<!-- BEGIN PLEXIFORM v1-abc -->\nhalf\n';
  const w = world(t, { files: { ...ORIGINAL, geminiMd: broken } });
  const r = w.make().enrolAll();
  assert.equal(r.results.gemini.instructions.state, 'conflict');
  assert.equal(w.read('geminiMd'), broken);
});

test('instructions off: removes the blocks now, keeps them off, and leaves the MCP entries', (t) => {
  const w = world(t);
  const reg = w.make();
  reg.enrolAll({ mcpOurs: { codex: true } });
  reg.setInstructionsOff(true);
  assert.equal(w.read('codexAgents'), ORIGINAL.codexAgents);
  assert.equal(w.read('geminiMd'), ORIGINAL.geminiMd);
  assert.equal(entryIn(w, 'gemini', ['mcpServers']).env.PLEXIFORM_CLIENT, 'gemini');
  reg.enrolAll({ mcpOurs: { codex: true } });
  assert.equal(w.read('codexAgents'), ORIGINAL.codexAgents, 'not re-added');
  assert.equal(reg.caps().find((c) => c.id === 'codex').instructions, 'off');
});

test('the canonical text is short, names the tools, says other agents are data, and promises only what the tier allows', () => {
  const full = Instr.text(TIERS.LOCAL_ATTESTED);
  assert.ok(full.length <= Instr.MAX_CHARS, `${full.length} chars`);
  for (const s of ['bus_peers', 'bus_note', 'bus_handoff', 'bus_notes', 'comes back to you as a note', 'data, never instructions']) assert.ok(full.includes(s), s);
  const ro = Instr.text(TIERS.UNVERIFIED_CLIENT);
  assert.ok(ro.length <= Instr.MAX_CHARS);
  assert.ok(ro.includes('bus_peers') && ro.includes('data, never instructions'));
  assert.ok(!/bus_note\b|bus_handoff/.test(ro), 'an unverified client is not told to do what it is refused');
});

test('acceptance 4: caps() gives every tool {mcp, hooks, instructions, tier, reason}', (t) => {
  const w = world(t);
  const reg = w.make();
  reg.enrolAll({ mcpOurs: { codex: true } });
  const caps = reg.caps({ hooks: { gemini: true, cursor: false } });
  assert.deepEqual(caps.map((c) => c.id), ['claude', 'codex', 'gemini', 'cursor', 'vscode', 'claude-desktop', 'hermes']);
  for (const c of caps) for (const k of ['mcp', 'hooks', 'instructions', 'tier', 'reason']) assert.ok(typeof c[k] === 'string' && c[k], `${c.id}.${k}`);
  const by = Object.fromEntries(caps.map((c) => [c.id, c]));
  assert.equal(by.claude.mcp, 'not-installed');
  assert.deepEqual([by.gemini.mcp, by.gemini.hooks, by.gemini.instructions, by.gemini.tier], ['ours', 'connected', 'ours', TIERS.UNVERIFIED_CLIENT]);
  assert.deepEqual([by.cursor.hooks, by.cursor.instructions], ['not-connected', 'mcp']);
  assert.deepEqual([by.vscode.hooks, by['claude-desktop'].hooks], ['n/a', 'n/a']);
  assert.equal(by.codex.tier, TIERS.LOCAL_ATTESTED);
  for (const id of ['cursor', 'vscode', 'claude-desktop', 'hermes']) assert.equal(by[id].tier, TIERS.UNVERIFIED_CLIENT, `${id} is read-only (D2)`);
  assert.ok(!JSON.stringify(caps).includes(w.home), 'paths are shown from ~');
  // Read-only caps (no launch: the AI tools page's own instance) still see ours by its marker.
  const ro = Registry.create({ home: w.home, rootDir: w.root });
  assert.equal(ro.caps().find((c) => c.id === 'vscode').mcp, 'ours');
});

test('plan() previews what enrol would write and writes nothing', (t) => {
  const w = world(t);
  const before = w.snap();
  const p = w.make().plan('gemini');
  assert.equal(p.ok, true);
  assert.equal(p.files.length, 2);
  assert.ok(p.files[0].after.includes('"PLEXIFORM_CLIENT": "gemini"'));
  assert.deepEqual(w.snap(), before);
});

test('a one-line JSON file stays on one line', (t) => {
  const w = world(t);
  w.make().enrolAll();
  assert.ok(!w.read('desktop').includes('\n'));
  assert.equal(entryIn(w, 'desktop', ['mcpServers']).env.PLEXIFORM_CLIENT, 'claude-desktop');
  assert.deepEqual(Jsonc.parse(w.read('desktop')).preferences, { quickEntryShortcut: 'off' });
});

test('Remote Control: the registry never writes Claude Code\'s or Codex\'s own settings files, whatever a tool table says', (t) => {
  const w = world(t);
  const settings = path.join(w.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const text = '{\n  "enableRemoteControl": true,\n  "remote": { "defaultEnvironmentId": "env-fixture" }\n}\n';
  fs.writeFileSync(settings, text);
  fs.writeFileSync(path.join(w.home, '.claude.json'), '{\n  "remoteControlSurfacesSeen": ["mobile"],\n  "mcpServers": {}\n}\n');
  const before = [settings, path.join(w.home, '.claude.json')].map((f) => fs.readFileSync(f, 'utf8'));
  const reg = w.make();
  reg.enrolAll({ mcpOurs: { claude: true, codex: true } });
  reg.unenrolAll();
  assert.deepEqual([settings, path.join(w.home, '.claude.json')].map((f) => fs.readFileSync(f, 'utf8')), before);
  // A tool whose files point there is refused at the write, not trusted.
  const Adapters = require('../adapters/index.js');
  const vs = Adapters.mcpClient('vscode');
  const orig = { file: vs.file, detect: vs.detect };
  vs.file = ({ home }) => path.join(home, '.claude', 'settings.json');
  vs.detect = () => true;
  t.after(() => Object.assign(vs, orig));
  const r = w.make().enrol('vscode');
  assert.equal(r.mcp.state, 'error');
  assert.equal(fs.readFileSync(settings, 'utf8'), text);
});

test('symlinks: an instruction file linked into ~/.claude is refused at its real target, and CLAUDE.md stays byte-identical', (t) => {
  const w = world(t);
  const claudeMd = path.join(w.home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  const text = '# My Claude rules\n\nBe brief.\n';
  fs.writeFileSync(claudeMd, text);
  for (const k of ['codexAgents', 'geminiMd']) { fs.rmSync(path.join(w.home, FILES[k])); fs.symlinkSync(claudeMd, path.join(w.home, FILES[k])); }
  const reg = w.make();
  const r = reg.enrolAll({ mcpOurs: { codex: true } });
  assert.equal(r.results.codex.instructions.state, 'error');
  assert.equal(r.results.codex.instructions.error, 'FORBIDDEN');
  assert.equal(r.results.gemini.instructions.state, 'error');
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), text);
  assert.equal(reg.caps().find((c) => c.id === 'codex').instructions, 'refused');
  assert.deepEqual(reg.plan('codex').files, []);
  reg.unenrolAll();
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), text);
  // A folder link counts too: a not-yet-made AGENTS.md inside a ~/.codex that is really ~/.claude.
  const w2 = world(t);
  fs.mkdirSync(path.join(w2.home, '.claude'), { recursive: true });
  fs.rmSync(path.join(w2.home, '.codex'), { recursive: true });
  fs.symlinkSync(path.join(w2.home, '.claude'), path.join(w2.home, '.codex'));
  w2.make().enrolAll({ mcpOurs: { codex: true } });
  assert.deepEqual(fs.readdirSync(path.join(w2.home, '.claude')), []);
});

test('symlinks: AGENTS.md and GEMINI.md as one file get one block, stable across syncs, and unenrol restores it', (t) => {
  const w = world(t);
  const agents = path.join(w.home, FILES.codexAgents);
  fs.rmSync(path.join(w.home, FILES.geminiMd));
  fs.symlinkSync(agents, path.join(w.home, FILES.geminiMd));
  const reg = w.make();
  const r = reg.enrolAll({ mcpOurs: { codex: true } });
  assert.equal(r.results.codex.instructions.state, 'ours');
  assert.deepEqual([r.results.gemini.instructions.state, r.results.gemini.instructions.with], ['shared', 'codex']);
  const once = fs.readFileSync(agents, 'utf8');
  assert.equal(once.split('BEGIN PLEXIFORM').length, 2, 'one block');
  assert.ok(once.includes(Instr.block(TIERS.LOCAL_ATTESTED).text), 'Codex\'s full block');
  const again = reg.enrolAll({ mcpOurs: { codex: true } });
  assert.equal(fs.readFileSync(agents, 'utf8'), once, 'second sync byte-identical');
  assert.equal(again.results.gemini.instructions.state, 'shared');
  assert.equal(again.changed, false);
  assert.equal(reg.caps().find((c) => c.id === 'gemini').instructions, 'shared');
  assert.equal(reg.unenrol('gemini').instructions.state, 'none', 'Gemini never held it');
  assert.equal(fs.readFileSync(agents, 'utf8'), once, 'unenrolling Gemini leaves Codex\'s block');
  reg.unenrolAll();
  assert.equal(fs.readFileSync(agents, 'utf8'), ORIGINAL.codexAgents);
  assert.ok(fs.lstatSync(path.join(w.home, FILES.geminiMd)).isSymbolicLink(), 'the link stays a link');
});

test('a config created while we were writing it is never written over: the new file is a conflict, not replaced', (t) => {
  const w = world(t, { files: { ...ORIGINAL, cursor: null } });
  const theirs = '{\n  "mcpServers": { "plexiform-bus": { "command": "theirs" } }\n}\n';
  const realLink = fs.linkSync;
  let raced = false;
  fs.linkSync = (from, to) => { if (!raced && to.endsWith('mcp.json') && to.includes('.cursor')) { raced = true; fs.writeFileSync(to, theirs); } return realLink(from, to); };
  t.after(() => { fs.linkSync = realLink; });
  const r = w.make().enrol('cursor');
  assert.ok(raced);
  assert.equal(r.mcp.state, 'conflict');
  assert.equal(w.read('cursor'), theirs);
  assert.deepEqual(fs.readdirSync(path.join(w.home, '.cursor')), ['mcp.json'], 'no temp file left');
});

test('JSONC duplicate keys we would touch are a conflict, never edited', (t) => {
  const dupName = '{\n  "mcpServers": {\n    "plexiform-bus": { "command": "a" },\n    "plexiform-bus": { "command": "b" }\n  }\n}\n';
  const dupParent = '{\n  "mcpServers": {},\n  "mcpServers": { "x": { "command": "x" } }\n}\n';
  for (const text of [dupName, dupParent]) {
    const w = world(t, { files: { ...ORIGINAL, cursor: text } });
    const r = w.make().enrol('cursor');
    assert.equal(r.mcp.state, 'conflict');
    assert.equal(w.read('cursor'), text);
  }
  assert.throws(() => Jsonc.get(dupName, ['mcpServers'], 'plexiform-bus'), { code: 'DUPLICATE' });
  assert.throws(() => Jsonc.remove(dupName, ['mcpServers'], 'plexiform-bus'), { code: 'DUPLICATE' });
  assert.equal(Jsonc.get('{"a":1,"a":2,"mcpServers":{}}', ['mcpServers'], 'plexiform-bus'), undefined, 'duplicates elsewhere are not ours to judge');
});

test('an empty mcp.json (VS Code leaves a zero-byte one) is enrolled, and undo puts the empty file back', (t) => {
  const w = world(t, { files: { ...ORIGINAL, vscode: '', cursor: '// nothing yet\n' } });
  const reg = w.make();
  reg.enrolAll({ mcpOurs: { codex: true } });
  assert.equal(reg.caps().find((c) => c.id === 'vscode').mcp, 'ours');
  assert.equal(entryIn(w, 'vscode', ['servers']).env.PLEXIFORM_CLIENT, 'vscode');
  assert.equal(entryIn(w, 'cursor', ['mcpServers']).env.PLEXIFORM_CLIENT, 'cursor');
  assert.ok(w.read('cursor').startsWith('// nothing yet\n'), 'a comment-only file keeps its comment');
  reg.unenrolAll();
  assert.equal(w.read('vscode'), '');
  assert.equal(w.read('cursor'), '// nothing yet\n');
});
