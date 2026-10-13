'use strict';
// The AI tools page engine with the round-3 adapters: own-file (Copilot,
// Goose), own-plugin (OpenCode), one-script-per-hook (Cline) and marked
// YAML lines (Aider): preview, connect with backup, read-back, disconnect,
// undo, and uninstall-all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AiTools = require('../src/ai-tools.js');
const Adapters = require('../adapters/index.js');
const { testTempDir } = require('./helpers/tmp');

const HOOKS = path.join(__dirname, '..', 'hooks');
const rig = () => {
  const h = testTempDir('ctl-aitools-x-');
  const dataDir = path.join(h, 'data');
  for (const d of ['.copilot', '.config/goose', '.config/opencode', 'Documents/Cline', '.aider']) fs.mkdirSync(path.join(h, d), { recursive: true });
  const runtime = Adapters.Runtime.make({ execPath: null, hooksDir: HOOKS, dataDir });
  const tools = AiTools.create({ home: h, runtime, dataDir, pathDirs: () => [], extraBinDirs: [], now: () => 1_700_000_000_000, run: (_b, _a, _o, cb) => { cb(null, '1.0.0\n'); return {}; } });
  return { h, tools, runtime };
};
const row = async (tools, id) => (await tools.scan()).rows.find((r) => r.id === id);

for (const id of ['copilot', 'goose', 'opencode', 'cline', 'aider']) {
  test(`${id}: detected → preview shows only additions → connect → connected → disconnect leaves nothing of ours`, async () => {
    const { h, tools } = rig();
    assert.equal((await row(tools, id)).state, 'ready', id);
    const p = tools.preview(id);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.ok(p.files.length >= 1);
    assert.ok(p.files.every((f) => f.lines.every((l) => l.kind === 'add')), 'a fresh home only gains lines');
    const c = await tools.connect(id);
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal((await row(tools, id)).state, 'connected');
    assert.equal(tools.preview(id).already, true);
    const d = tools.disconnect(id);
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal((await row(tools, id)).state, 'ready');
    const a = Adapters.get(id);
    assert.equal(a.holdsOurs({ home: h }), false, 'nothing of ours left');
  });
}

test('aider: connect keeps the person\'s lines, undo restores the file byte for byte', async () => {
  const { h, tools } = rig();
  const file = path.join(h, '.aider.conf.yml');
  fs.writeFileSync(file, 'model: sonnet\n');
  assert.equal((await tools.connect('aider')).ok, true);
  assert.match(fs.readFileSync(file, 'utf8'), /^model: sonnet\nnotifications: true # plexiform\n/);
  assert.equal(tools.undo('aider').ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model: sonnet\n');
});

test('cline: a hook the person wrote makes the row a Fix with the reason, and connect refuses', async () => {
  const { h, tools } = rig();
  fs.mkdirSync(path.join(h, 'Documents', 'Cline', 'Hooks'), { recursive: true });
  fs.writeFileSync(path.join(h, 'Documents', 'Cline', 'Hooks', 'PreToolUse'), '#!/bin/sh\nexit 0\n');
  const r = await row(tools, 'cline');
  assert.equal(r.state, 'fix');
  assert.match(r.detail, /your own PreToolUse hook/);
  assert.equal((await tools.connect('cline')).ok, false);
});

test('opencode: a plugin file that is not ours is left alone', async () => {
  const { h, tools } = rig();
  const file = path.join(h, '.config', 'opencode', 'plugins', 'plexiform.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export const Mine = async () => ({})\n');
  assert.equal(tools.preview('opencode').ok, false);
  assert.equal((await tools.connect('opencode')).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const Mine = async () => ({})\n');
});

test('the plugin OpenCode loads is valid ES module syntax and spawns emit.js with the hook name', () => {
  const { runtime } = rig();
  const text = Adapters.get('opencode').pluginText(runtime);
  const file = path.join(testTempDir('ctl-oc-plugin-'), 'plexiform.mjs');
  fs.writeFileSync(file, text);
  const r = require('node:child_process').spawnSync(process.execPath, ['--check', file]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(text, /import \{ spawn \} from "node:child_process"/);
  assert.match(text, /"--adapter","opencode"\]/);
  assert.match(text, /export const PlexiformPlugin = async/);
});

test('uninstall-all removes every round-3 connection and nothing else', async () => {
  const { h, tools } = rig();
  for (const id of ['copilot', 'goose', 'opencode', 'cline', 'aider']) assert.equal((await tools.connect(id)).ok, true, id);
  fs.writeFileSync(path.join(h, 'Documents', 'Cline', 'Hooks', 'Mine'), '#!/bin/sh\n');
  const out = require('../adapters/uninstall-all.js').run({ home: h });
  for (const id of ['copilot', 'goose', 'opencode', 'cline', 'aider']) {
    const r = out.find((x) => x.id === id);
    assert.equal(r.changed, true, id);
    assert.equal(Adapters.get(id).holdsOurs({ home: h }), false, id);
  }
  assert.deepEqual(fs.readdirSync(path.join(h, 'Documents', 'Cline', 'Hooks')), ['Mine']);
  assert.equal(fs.existsSync(path.join(h, '.agents', 'plugins', 'plexiform')), false, 'empty goose plugin dir removed');
});
