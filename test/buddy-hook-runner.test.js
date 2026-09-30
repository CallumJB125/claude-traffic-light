const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Runner = require('../src/buddy-hook-runner.js');
const Runtime = require('../adapters/runtime.js');
const Codex = require('../adapters/codex.js');

const HOOKS = path.join(__dirname, '..', 'hooks');

test('buddy-hook: only emit.js and set-status.js in a hooks folder can be run', () => {
  const emit = path.join(HOOKS, 'emit.js');
  assert.deepEqual(Runner.parse(['C:\\P.exe', '--buddy-hook', emit, '--adapter', 'codex', '{}']), { script: emit, args: ['--adapter', 'codex', '{}'] });
  assert.equal(Runner.parse(['x', '--buddy-hook', path.join(HOOKS, 'install.js')]), null);
  assert.equal(Runner.parse(['x', '--buddy-hook', '/tmp/evil/emit.js']), null);
  assert.equal(Runner.parse(['x', '--buddy-hook']), null);
  const exits = [];
  Runner.run(['x', '--buddy-hook', '/tmp/evil/emit.js'], { exit: (c) => exits.push(c) });
  assert.deepEqual(exits, [0], 'a refused script still exits');
});

test('buddy-hook: the Windows Codex notify is the exe with --buddy-hook, and needs no wrapper', () => {
  const rt = Runtime.make({ execPath: 'C:\\P\\Plexiform.exe', platform: 'win32', hooksDir: 'C:\\P\\resources\\hooks', dataDir: 'C:\\U\\.ctl' });
  assert.deepEqual(Codex.commandFor('notify', rt), ['C:\\P\\Plexiform.exe', '--buddy-hook', 'C:\\P\\resources\\hooks\\emit.js', '--adapter', 'codex']);
  assert.equal(Runtime.argvNeedsWrapper(rt), false);
  assert.equal(Runtime.wrapperPresent(rt, { argv: true }, { readFileSync() { throw new Error('no wrapper file'); } }), true);
  const mac = Runtime.make({ execPath: '/A/B', platform: 'darwin', hooksDir: '/h', dataDir: '/d' });
  assert.deepEqual(Codex.commandFor('notify', mac), ['/d/bin/buddy-hook', '/h/emit.js', '--adapter', 'codex'], 'macOS unchanged');
});

test('buddy-hook: a Codex payload full of cmd.exe metacharacters arrives intact', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-buddyhook-'));
  const cwd = 'C:\\work\\a "quoted" & b | c ^ d %PATH% ! (e)';
  const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'th-1', cwd });
  const runner = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'buddy-hook-runner.js'))}).run(process.argv)`;
  const r = spawnSync(process.execPath, ['-e', runner, '--', '--buddy-hook', path.join(HOOKS, 'emit.js'), '--adapter', 'codex', payload], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const files = fs.readdirSync(path.join(home, 'sessions'));
  assert.equal(files.length, 1, files.join());
  const s = JSON.parse(fs.readFileSync(path.join(home, 'sessions', files[0]), 'utf8'));
  assert.equal(s.sessionId, 'th-1');
  assert.equal(s.cwd, cwd);
  fs.rmSync(home, { recursive: true, force: true });
});
