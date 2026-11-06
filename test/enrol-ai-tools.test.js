'use strict';
// The AI tools page's side of enrolment: connections() per tool for the Connections view (Lane 3), Fix through the
// bus sync, and a tool found while Plexiform runs triggers that sync. Throwaway home, no real CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('node:child_process').execFile = (bin, args, opts, cb) => { cb(new Error('probe disabled in tests')); return undefined; };
const Adapters = require('../adapters/index.js');
const AiTools = require('../src/ai-tools.js');
const Registry = require('../src/enrol/registry.js');
const McpInstall = require('../mcp-install.js');
const { wire } = require('../src/ai-tools-wire.js');
const { testTempDir } = require('./helpers/tmp');

const PACKAGED = { packaged: true, execPath: '/Applications/Plexiform.app/Contents/MacOS/Plexiform', appPath: '/Applications/Plexiform.app/Contents/Resources/app.asar', dir: '/repo' };

function rig(t) {
  const home = testTempDir('plex-enrol-ai-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rootDir = path.join(home, 'data');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const runtime = Adapters.Runtime.make({ execPath: null, hooksDir: path.join(__dirname, '..', 'hooks'), dataDir: rootDir });
  const registry = Registry.create({ home, rootDir, launch: () => McpInstall.launch({ ...PACKAGED, profile: 'bus' }) });
  const syncs = [];
  const bus = { registry, sync: async () => { syncs.push(1); registry.enrolAll(); } };
  const handlers = new Map();
  const w = wire({ ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, shell: {}, clipboard: {}, home, runtime, rootDir, fromPage: () => true, askFromWidget: () => false, ephemeral: false, openPage() {}, bus });
  return { home, rootDir, runtime, registry, syncs, w, call: (n, ...a) => handlers.get(n)({}, ...a) };
}

test('connections() lists every tool with its MCP, hooks, instructions and tier; Fix enrols and reads back', async (t) => {
  const r = rig(t);
  fs.mkdirSync(path.join(r.home, '.cursor'), { recursive: true });
  let rows = r.w.connections();
  const cursor = rows.find((c) => c.id === 'cursor');
  assert.deepEqual([cursor.installed, cursor.mcp, cursor.hooks, cursor.tier], [true, 'missing', 'not-connected', 'unverified_client']);
  assert.match(cursor.reason, /Not connected yet/);
  assert.equal(rows.find((c) => c.id === 'vscode').mcp, 'not-installed');
  const fixed = await r.w.fixConnection('cursor');
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(fixed.row.mcp, 'ours');
  rows = r.w.connections();
  assert.equal(rows.find((c) => c.id === 'cursor').mcp, 'ours');
});

test('a tool installed while Plexiform runs is enrolled at the next scan', async (t) => {
  const r = rig(t);
  await r.call('aitools:scan');
  assert.equal(r.syncs.length, 0, 'the first scan only learns what is there');
  fs.mkdirSync(path.join(r.home, '.gemini'), { recursive: true });
  await r.call('aitools:scan');
  await new Promise((res) => setImmediate(res));
  assert.equal(r.syncs.length, 1);
  assert.equal(r.w.connections().find((c) => c.id === 'gemini').mcp, 'ours');
});

test('without the bus (a plain engine) connections() still reads, and the preview diff writes nothing', (t) => {
  const r = rig(t);
  fs.mkdirSync(path.join(r.home, '.gemini'), { recursive: true });
  const engine = AiTools.create({ home: r.home, runtime: r.runtime, dataDir: r.rootDir, enrolment: r.registry });
  const p = engine.connectionPreview('gemini');
  assert.equal(p.ok, true);
  assert.equal(p.files[0].file, '~/.gemini/settings.json');
  assert.ok(p.files[0].lines.some((l) => l.kind === 'add' && l.text.includes('plexiform-bus')));
  assert.ok(!fs.existsSync(path.join(r.home, '.gemini', 'settings.json')));
  const plain = AiTools.create({ home: r.home, runtime: r.runtime, dataDir: r.rootDir });
  assert.equal(plain.connections().find((c) => c.id === 'gemini').mcp, 'missing');
});
