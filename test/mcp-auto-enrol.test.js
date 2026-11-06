'use strict';
// src/mcp-auto.js over src/enrol/registry.js: the start-up sync plugs every AI tool found here into the bus, says so
// once on Home with Undo, and turning the bus off (or that Undo) takes everything back. Scratch homes and the fake
// codex CLI only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const McpAuto = require('../src/mcp-auto.js');
const Jsonc = require('../src/enrol/jsonc.js');
const Instr = require('../src/enrol/instructions.js');
const Fake = require('./helpers/fake-codex.js');
const { testTempDir } = require('./helpers/tmp');

const PACKAGED = { packaged: true, execPath: '/Applications/Plexiform.app/Contents/MacOS/Plexiform', appPath: '/Applications/Plexiform.app/Contents/Resources/app.asar', dir: '/repo' };
const ON = { agentAwareness: { enabled: true }, agentBus: { enabled: true }, mcpBusUserOff: false };
const VSCODE = path.join('Library', 'Application Support', 'Code', 'User', 'mcp.json');
const VSCODE_TEXT = '{\n  // mine\n  "servers": {}\n}\n';

function world(t, { gemini = true } = {}) {
  const dir = testTempDir('pf-mcpauto-enrol-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const root = path.join(home, '.claude-traffic-light');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(home, VSCODE)), { recursive: true });
  fs.writeFileSync(path.join(home, VSCODE), VSCODE_TEXT);
  if (gemini) fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const bin = Fake.write(path.join(dir, 'bin'));
  const state = { config: { ...ON } };
  const make = () => McpAuto.create({ rootDir: root, home, config: () => state.config, launch: PACKAGED, platform: 'darwin', codexBin: () => bin,
    codexEnv: { PATH: '/usr/bin:/bin', CODEX_HOME: codexHome, FAKE_CODEX_MODE: '' }, log: () => {}, trustCodexBin: async (b) => b });
  const read = (rel) => { try { return fs.readFileSync(path.join(home, rel), 'utf8'); } catch { return null; } };
  return { home, root, codexHome, state, make, read };
}

test('the start-up sync enrols every tool found, once, and Home says so with one Undo', async (t) => {
  const w = world(t);
  const auto = w.make();
  const s = await auto.sync();
  assert.equal(s.tools.vscode.mcp, 'ours');
  assert.equal(s.tools.gemini.mcp, 'ours');
  assert.equal(s.tools.codex.instructions, 'ours');
  assert.equal(Jsonc.get(w.read(VSCODE), ['servers'], 'plexiform-bus').env.PLEXIFORM_CLIENT, 'vscode');
  assert.ok(w.read(VSCODE).includes('// mine'));
  assert.ok(Instr.has(w.read('.codex/AGENTS.md')) && Instr.has(w.read('.gemini/GEMINI.md')));
  const [added] = auto.notices();
  assert.equal(added.handle, 'bus-added');
  assert.match(added.title, /Claude Code, Codex, Gemini CLI and VS Code/);
  assert.match(added.meta, /~\/\.codex\/AGENTS\.md and ~\/\.gemini\/GEMINI\.md/);
  const caps = auto.toolCaps();
  assert.equal(caps.find((c) => c.id === 'claude').mcp, 'ours', 'Claude Code from mcp-auto\'s own state');
  assert.equal(caps.find((c) => c.id === 'codex').mcp, 'ours');
  assert.deepEqual(auto.caps(), { claude: true, codex: true }, 'the roster\'s caps are unchanged');

  const files = [VSCODE, '.codex/AGENTS.md', '.gemini/GEMINI.md', '.gemini/settings.json'].map(w.read);
  await w.make().sync();
  assert.deepEqual([VSCODE, '.codex/AGENTS.md', '.gemini/GEMINI.md', '.gemini/settings.json'].map(w.read), files, 'a restart writes nothing');
});

test('Undo (the bus turned off) takes every tool\'s entry and block back out, byte for byte', async (t) => {
  const w = world(t);
  const auto = w.make();
  await auto.sync();
  const r = await auto.act('bus-added', 'undo', { undo: async () => { w.state.config = { ...w.state.config, mcpBusUserOff: true }; } });
  assert.equal(r.ok, true);
  const s = await auto.sync();
  assert.equal(s.claude.state, 'off');
  assert.equal(w.read(VSCODE), VSCODE_TEXT);
  assert.equal(w.read('.codex/AGENTS.md'), null);
  assert.equal(w.read('.gemini/GEMINI.md'), null);
  assert.equal(w.read('.gemini/settings.json'), null);
});

test('a block first written after the bus notice gets its own notice, and its Undo removes only the blocks, for good', async (t) => {
  const w = world(t, { gemini: false });
  const auto = w.make();
  await auto.sync();
  await auto.act('bus-added', 'dismiss');
  fs.mkdirSync(path.join(w.home, '.gemini'), { recursive: true });
  await auto.sync();
  const n = auto.notices().find((x) => x.handle === 'bus-instructions');
  assert.ok(n, 'Gemini installed later: its block is announced');
  assert.equal(n.action, 'undo');
  assert.match(n.title, /~\/\.codex\/AGENTS\.md and ~\/\.gemini\/GEMINI\.md/);
  const r = await auto.act('bus-instructions', 'undo');
  assert.equal(r.ok, true);
  assert.equal(w.read('.gemini/GEMINI.md'), null);
  assert.equal(w.read('.codex/AGENTS.md'), null);
  assert.equal(Jsonc.get(w.read('.gemini/settings.json'), ['mcpServers'], 'plexiform-bus').env.PLEXIFORM_CLIENT, 'gemini', 'the bus tools stay');
  await auto.sync();
  assert.equal(w.read('.codex/AGENTS.md'), null, 'not re-added on the next start');
  assert.equal(auto.notices().some((x) => x.handle === 'bus-instructions'), false);
});

test('off this Mac platform nothing is enrolled', async (t) => {
  const w = world(t);
  const auto = McpAuto.create({ rootDir: w.root, home: w.home, config: () => w.state.config, launch: PACKAGED, platform: 'linux', codexBin: () => null, log: () => {} });
  await auto.sync();
  assert.equal(w.read(VSCODE), VSCODE_TEXT);
  assert.equal(w.read('.codex/AGENTS.md'), null);
});

// Owner requirement: enrolment never changes Claude Code Remote Control or Plexiform's own remote/relay set-up. The
// only change to ~/.claude.json is the one plexiform-bus key; Claude Code's settings, hooks and remote keys, Codex's
// config.toml, and Plexiform's remote files are never written. Undo gives every file back byte for byte.
test('Remote Control: enrol and undo leave Claude Code\'s and Plexiform\'s remote settings byte-identical apart from the managed entries', async (t) => {
  const w = world(t);
  const claudeJson = {
    numStartups: 412, remoteControlSurfacesSeen: ['desktop', 'mobile'], remoteControlReadyPushCount: 3, remoteControlReadyPushKey: 'rc-push-fixture',
    remoteControlUpsellSeenCount: 1, remoteDialogSeen: true,
    mcpServers: { context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: {} } },
    projects: { '/Users/me/work': { allowedTools: [], remoteEnabled: true } },
  };
  const files = {
    '.claude.json': `${JSON.stringify(claudeJson, null, 2)}\n`,
    '.claude/settings.json': `${JSON.stringify({ remote: { defaultEnvironmentId: 'env-fixture' }, enableRemoteControl: true,
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }] } }, null, 2)}\n`,
    '.codex/config.toml': 'model = "gpt-5"\n\n[features]\nremote_control = true\n\n[mcp_servers.mine]\ncommand = "x"\n',
    '.claude-traffic-light/config.json': '{"remoteApprovals":{"enabled":true},"remoteControl":{"relay":"wss://relay.example"}}',
    '.claude-traffic-light/remote/settings.json': '{"enabled":true}',
    '.claude-traffic-light/remote/devices.json': '{"devices":[{"id":"phone"}]}',
    '.claude-traffic-light/remote/identity.json': '{"publicKey":"fixture"}',
  };
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(w.home, rel)), { recursive: true }); fs.writeFileSync(path.join(w.home, rel), text); }
  const untouched = Object.keys(files).filter((rel) => rel !== '.claude.json');
  const same = () => untouched.filter((rel) => w.read(rel) !== files[rel]);

  const auto = w.make();
  const s = await auto.sync();
  assert.equal(s.claude.state, 'ours');
  assert.deepEqual(same(), [], 'Claude Code settings and hooks, Codex config.toml and Plexiform\'s remote files never written');
  const now = JSON.parse(w.read('.claude.json'));
  assert.equal(now.mcpServers['plexiform-bus'].env.PLEXIFORM_MCP, 'bus-v1:packaged');
  delete now.mcpServers['plexiform-bus'];
  assert.deepEqual(now, claudeJson, 'every other key of ~/.claude.json, the Remote Control ones included, is as it was');

  await w.make().sync();
  assert.deepEqual(same(), []);

  w.state.config = { ...w.state.config, mcpBusUserOff: true };
  await auto.sync();
  assert.deepEqual(same(), []);
  assert.equal(w.read('.claude.json'), files['.claude.json'], '~/.claude.json byte-identical after undo');
});
