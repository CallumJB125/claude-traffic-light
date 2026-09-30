// The generated command forms, run for real: the Electron binary from
// node_modules stands in for the packaged app and must act as Node under
// ELECTRON_RUN_AS_NODE, both inline (shell-string hooks) and through the
// wrapper script (Codex's argv notify).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Runtime = require('../../adapters/runtime.js');
const Cursor = require('../../adapters/cursor.js');
const Codex = require('../../adapters/codex.js');
const { tmp } = require('./helpers.js');

let electron = null;
try { electron = require('electron'); } catch { /* not installed */ }
const skip = (typeof electron !== 'string' || !fs.existsSync(electron) || process.platform === 'win32') && 'needs the electron binary on macOS/Linux';
const HOOKS = path.join(__dirname, '..', '..', 'hooks');
const HOST = os.hostname().split('.')[0];

test('runtime: a Cursor shell-string hook runs the app binary as Node', { skip, timeout: 60000 }, () => {
  const home = tmp();
  const rt = Runtime.make({ execPath: electron, hooksDir: HOOKS, dataDir: path.join(home, 'data') });
  const cmd = Cursor.commandFor('beforeShellExecution', rt);
  assert.match(cmd, /^ELECTRON_RUN_AS_NODE=1 "/);
  const env = { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync('/bin/sh', ['-c', cmd], { env, input: JSON.stringify({ conversation_id: 'real1', workspace_roots: ['/w/r'] }) });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.deepEqual(JSON.parse(r.stdout.toString()), { permission: 'allow', continue: true });
  const d = JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${HOST}-cursor-real1.json`), 'utf8'));
  assert.deepEqual([d.signal, d.tool, d.cwd], ['tool-use', 'Bash', '/w/r']);
});

test('runtime: the Codex argv notify runs through the generated wrapper', { skip, timeout: 60000 }, () => {
  const home = tmp();
  const rt = Runtime.make({ execPath: electron, hooksDir: HOOKS, dataDir: path.join(home, 'data') });
  assert.equal(Codex.install({ home, runtime: rt }).ok, true);
  const [exe, ...args] = Codex.commandFor('notify', rt);
  assert.equal(exe, path.join(home, 'data', 'bin', 'buddy-hook'));
  const env = { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(exe, [...args, JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'real2', cwd: '/w/c' })], { env });
  assert.equal(r.status, 0, r.stderr.toString());
  const d = JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${HOST}-codex-real2.json`), 'utf8'));
  assert.deepEqual([d.signal, d.cwd], ['stop', '/w/c']);
});

test('runtime: the dev fallback is plain node, and needs no wrapper', () => {
  const rt = Runtime.make({ execPath: null, hooksDir: '/h', dataDir: '/d' });
  assert.equal(rt.node, true);
  assert.equal(Runtime.ensureWrapper(rt), null);
  assert.equal(Runtime.shellCommand(rt, '/h/emit.js', ['x']), 'node "/h/emit.js" x');
  assert.deepEqual(Runtime.argvCommand(rt, '/h/emit.js', ['x']), ['node', '/h/emit.js', 'x']);
});

test('isInstalled is false when the wrapper an installed command runs through is gone', () => {
  const Gemini = require('../../adapters/gemini.js');
  const wrapped = (platform, adapter) => {
    const home = tmp();
    const rt = Runtime.make({ execPath: '/App/Buddy', platform, hooksDir: '/h', dataDir: path.join(home, 'data') });
    assert.equal(adapter.install({ home, runtime: rt }).ok, true);
    return { home, rt };
  };
  // Codex: argv notify always runs through the wrapper.
  let { home, rt } = wrapped('linux', Codex);
  assert.equal(Codex.isInstalled({ home, runtime: rt }), true);
  fs.rmSync(Runtime.wrapperPath(rt));
  assert.equal(Codex.isInstalled({ home, runtime: rt }), false);
  // Windows shell strings (Cursor, Gemini) too; macOS/Linux shell strings need none.
  for (const adapter of [Cursor, Gemini]) {
    ({ home, rt } = wrapped('win32', adapter));
    assert.equal(adapter.isInstalled({ home, runtime: rt }), true);
    fs.rmSync(Runtime.wrapperPath(rt));
    assert.equal(adapter.isInstalled({ home, runtime: rt }), false, adapter.id);
    ({ home, rt } = wrapped('linux', adapter));
    assert.equal(adapter.isInstalled({ home, runtime: rt }), true);
  }
});
