'use strict';
// AI tools page: connecting Claude Code there is consent to its re-connect;
// Disconnect or Undo withdraws it. Real engine, throwaway home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// No version probe may reach a real claude/codex.
require('node:child_process').execFile = (bin, args, opts, cb) => { cb(new Error('probe disabled in tests')); return undefined; };
const Adapters = require('../adapters/index.js');
const { wire } = require('../src/ai-tools-wire.js');
const { testTempDir } = require('./helpers/tmp');

function rig() {
  const home = testTempDir('plex-wire-');
  const rootDir = path.join(home, 'data');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const runtime = Adapters.Runtime.make({ execPath: null, hooksDir: path.join(__dirname, '..', 'hooks'), dataDir: rootDir });
  const handlers = new Map(), consents = [];
  wire({ ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, shell: {}, clipboard: {}, home, runtime, rootDir, fromPage: () => true, askFromWidget: () => false, ephemeral: false, openPage() {}, onClaudeConsent: (on) => consents.push(on) });
  return { home, consents, call: (n, ...a) => handlers.get(n)({}, ...a) };
}

test('Connect on Claude Code consents to the re-connect; Disconnect withdraws it; other tools leave it alone', async () => {
  const r = rig();
  assert.equal((await r.call('aitools:connect', 'codex')).ok, true);
  assert.deepEqual(r.consents, []);
  assert.equal((await r.call('aitools:connect', 'claude')).ok, true);
  assert.deepEqual(r.consents, [true]);
  assert.equal((await r.call('aitools:disconnect', 'claude')).ok, true);
  assert.deepEqual(r.consents, [true, false]);
});

test('Connect all that includes Claude Code is consent too', async () => {
  const r = rig();
  const out = await r.call('aitools:connect-all');
  assert.ok(out.results.some((x) => x.id === 'claude' && x.ok), JSON.stringify(out));
  assert.deepEqual(r.consents, [true]);
});
