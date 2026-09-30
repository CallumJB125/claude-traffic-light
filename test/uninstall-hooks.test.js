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
