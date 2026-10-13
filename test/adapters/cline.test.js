// Recorded Cline hook payloads through normalize(), emit.js and /hook/:adapter,
// plus the one-file-per-hook install rules.
const { suite, tmp } = require('./helpers.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Cline = require('../../adapters/cline.js');
const Runtime = require('../../adapters/runtime.js');

suite(Cline);

const rt = () => Runtime.make({ execPath: null, hooksDir: '/hooks', dataDir: '/data' });

test('cline: install writes one executable script per hook, uninstall removes only ours', () => {
  const home = tmp();
  const r = Cline.install({ home, runtime: rt() });
  assert.equal(r.ok, true);
  const dir = Cline.hooksDir(home);
  assert.deepEqual(fs.readdirSync(dir).sort(), Cline.EVENTS.map(([e]) => e).sort());
  const text = fs.readFileSync(path.join(dir, 'PreToolUse'), 'utf8');
  assert.match(text, /^#!\/bin\/sh\n# plexiform-cline-hook/);
  assert.match(text, /emit\.js" --adapter cline PreToolUse\n$/);
  assert.ok(fs.statSync(path.join(dir, 'PreToolUse')).mode & 0o100);
  assert.equal(Cline.isInstalled({ home, runtime: rt() }), true);
  assert.equal(Cline.holdsOurs({ home }), true);
  fs.writeFileSync(path.join(dir, 'TaskStart'), '#!/bin/sh\necho mine\n');
  assert.equal(Cline.isInstalled({ home, runtime: rt() }), false);
  Cline.uninstall({ home });
  assert.deepEqual(fs.readdirSync(dir), ['TaskStart'], 'the person\'s own hook stays');
});

test('cline: a slot taken by someone else\'s hook refuses the whole connection', () => {
  const home = tmp();
  fs.mkdirSync(Cline.hooksDir(home), { recursive: true });
  fs.writeFileSync(path.join(Cline.hooksDir(home), 'PostToolUse'), '#!/bin/sh\nexit 0\n');
  assert.throws(() => Cline.plan({ home, runtime: rt() }), /your own PostToolUse hook/);
  assert.throws(() => Cline.install({ home, runtime: rt() }), /PostToolUse/);
  assert.deepEqual(fs.readdirSync(Cline.hooksDir(home)), ['PostToolUse']);
});

test('cline: Windows is refused (PowerShell hooks are not written)', () => {
  const r = Cline.install({ home: tmp(), runtime: Runtime.make({ execPath: 'C:\\P\\app.exe', platform: 'win32', hooksDir: 'C:\\h', dataDir: 'C:\\d' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /PowerShell/);
});
