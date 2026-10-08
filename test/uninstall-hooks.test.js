// --uninstall-hooks against a temp HOME: only Buddy's entries go, files with
// none of them are left byte-for-byte, and missing configs are not created.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Adapters = require('../adapters/index.js');
const McpInstall = require('../mcp-install.js');
const UninstallAll = require('../adapters/uninstall-all.js');
const vm = require('node:vm');

const Runtime = Adapters.Runtime;

function seededHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-uninstall-'));
  const rt = Runtime.make({ execPath: '/opt/Plexiform/plexiform', platform: 'linux', hooksDir: '/opt/Plexiform/resources/hooks', dataDir: path.join(home, '.claude-traffic-light') });
  const foreignClaude = { type: 'command', command: 'echo mine' };
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [foreignClaude] }] } }));
  Adapters.get('claude').install({ home, runtime: rt, askFromWidget: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'my-own-stop' }] } }));
  Adapters.get('cursor').install({ home, runtime: rt });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n\n[profiles.x]\nmodel = "y"\n');
  assert.equal(Adapters.get('codex').install({ home, runtime: rt }).ok, true);
  // Gemini: a settings file with no Buddy entries at all, formatted its own way.
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const geminiText = '{"theme":"dark","hooks":{"BeforeTool":[{"matcher":"","hooks":[{"type":"command","command":"x"}]}]}}';
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), geminiText);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x', args: ['y.js'] } } }));
  McpInstall.install({ home, entry: McpInstall.launch({ packaged: true, execPath: '/opt/Plexiform/plexiform', appPath: '/opt/Plexiform/resources/app.asar' }) });
  return { home, geminiText };
}

function assertClean(home, geminiText) {
  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.model, 'opus');
  assert.deepEqual(claude.hooks, { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] });
  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8'));
  assert.deepEqual(cursor.hooks, { stop: [{ command: 'my-own-stop' }] });
  const codex = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(!/notify/.test(codex), codex);
  assert.match(codex, /model = "o3"/);
  assert.match(codex, /\[profiles\.x\]/);
  assert.equal(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'), geminiText, 'a file with nothing of ours is not rewritten');
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(cj.numStartups, 3);
  assert.deepEqual(Object.keys(cj.mcpServers), ['other']);
}

test('uninstall-hooks: removes only Buddy entries from every agent config and ~/.claude.json', () => {
  const { home, geminiText } = seededHome();
  const results = UninstallAll.run({ home, mcp: McpInstall });
  assert.deepEqual(Object.fromEntries(results.map((r) => [r.id, r.changed])), { claude: true, cursor: true, codex: true, gemini: false, mcp: true });
  assert.ok(results.every((r) => !r.error), JSON.stringify(results));
  assertClean(home, geminiText);
  // Running again changes nothing.
  assert.ok(UninstallAll.run({ home, mcp: McpInstall }).every((r) => !r.changed));
  fs.rmSync(home, { recursive: true, force: true });
});

test('uninstall-hooks: an empty home stays empty', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-uninstall-'));
  const results = UninstallAll.run({ home, mcp: McpInstall });
  assert.ok(results.every((r) => !r.changed && !r.error));
  assert.deepEqual(fs.readdirSync(home), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('uninstall-hooks: an unparsable config is reported and left alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-uninstall-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
  const r = UninstallAll.run({ home }).find((x) => x.id === 'claude');
  assert.ok(r.error);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ not json');
  fs.rmSync(home, { recursive: true, force: true });
});

test('uninstall-hooks: the plain-Node entry the .deb prerm runs works against HOME', { skip: process.platform === 'win32' && 'HOME is not the home on Windows' }, () => {
  const { home, geminiText } = seededHome();
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'uninstall-hooks.js')], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude: removed/);
  assert.match(r.stdout, /mcp: removed/);
  assertClean(home, geminiText);
  fs.rmSync(home, { recursive: true, force: true });
});

// L3 (code review): one uninstall entry, run by main.js before anything else starts.
test('uninstall: main.js --uninstall-hooks runs hooks/uninstall-hooks.js main() before Electron loads', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = main.indexOf("process.argv.includes('--uninstall-hooks')");
  assert.ok(at > 0 && at < main.indexOf("require('electron')"), 'handled before electron is required');
  assert.match(main.slice(at, at + 300), /require\('\.\/hooks\/uninstall-hooks\.js'\)\.main\(/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-uninst-main-'));
  const lines = [];
  const results = require('../hooks/uninstall-hooks.js').main({ home, mcp: McpInstall, log: (l) => lines.push(l) });
  assert.equal(lines.length, results.length);
  assert.ok(lines.every((l) => l.startsWith('[uninstall-hooks] ')));
  fs.rmSync(home, { recursive: true, force: true });
});

function earlyMain(home, mcp = McpInstall) {
  const actual = require('../hooks/uninstall-hooks.js'), calls = [], lines = [], stopped = {};
  const hooks = { ...actual, main: options => actual.main({ ...options, home, log: line => lines.push(line) }) };
  const process = { argv: ['fixture', '--uninstall-hooks'], exit(code) { calls.push(['exit', code]); throw stopped; } };
  const fixtureRequire = id => {
    calls.push(['require', id]);
    if (id === './hooks/uninstall-hooks.js') return hooks;
    if (id === './mcp-install.js') return mcp;
    throw new Error(`Unexpected startup module ${id}`);
  };
  try { vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), { process, require: fixtureRequire }); }
  catch (error) { assert.equal(error, stopped); }
  assert.ok(!calls.some(call => call[1] === 'electron'));
  return { code: calls.find(call => call[0] === 'exit')?.[1], lines };
}

test('early uninstall exits nonzero for an actual malformed config and preserves its exact bytes before Electron', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-uninstall-status-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.claude', 'settings.json'), bytes = Buffer.from('{ unparseable foreign data\r\n');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, bytes);
  const result = earlyMain(home); assert.equal(result.code, 1); assert.ok(result.lines.some(line => line.includes('claude: left alone'))); assert.deepEqual(fs.readFileSync(file), bytes);
});

test('early uninstall exits zero for an empty home and creates no agent configuration', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-uninstall-status-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(earlyMain(home).code, 0); assert.deepEqual(fs.readdirSync(home), []);
});

test('an actual adapter error with an empty message still exits nonzero and is reported left alone', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-uninstall-status-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'synthetic-mcp.json'); fs.writeFileSync(file, 'Foreign retained config');
  const mcp = { configPath: () => file, uninstall() { throw new Error(''); } };
  const result = earlyMain(home, mcp); assert.equal(result.code, 1); assert.ok(result.lines.some(line => line.includes('mcp: left alone'))); assert.equal(fs.readFileSync(file, 'utf8'), 'Foreign retained config');
});

test('unavailable MCP helper reports incomplete removal without changing an empty home', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-uninstall-status-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const lines = [], results = require('../hooks/uninstall-hooks.js').main({ home, mcp: null, log: line => lines.push(line) });
  assert.ok(results.some(row => row.id === 'mcp' && Object.hasOwn(row, 'error'))); assert.ok(lines.some(line => line.includes('MCP uninstall helper unavailable'))); assert.deepEqual(fs.readdirSync(home), []);
});

test('plain Node uninstall CLI returns nonzero for malformed synthetic-home data without changing it', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-uninstall-status-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const observed = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8', timeout: 2000, maxBuffer: 4096 });
  assert.equal(observed.status, 0); assert.equal(observed.stdout, home, 'refuse before helper if synthetic HOME is not the actual child home');
  const file = path.join(home, '.claude', 'settings.json'), bytes = Buffer.from('{ malformed foreign config\r\n'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, bytes);
  const result = spawnSync(process.execPath, [path.join(__dirname, '../hooks/uninstall-hooks.js')], { env, encoding: 'utf8', timeout: 2000, maxBuffer: 4096 });
  assert.equal(result.status, 1); assert.ok(!result.signal); assert.deepEqual(fs.readFileSync(file), bytes);
});
