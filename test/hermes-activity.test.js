'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Hermes = require('../adapters/hermes-activity');
const Bridge = require('../hooks/hermes-activity');
const Overview = require('../src/session-overview');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-hermes-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runtime = { platform: 'darwin', execPath: null, hooksDir: path.resolve(__dirname, '../hooks'), dataDir: path.join(home, 'activity') };
  fs.mkdirSync(path.join(home, '.hermes'));
  fs.writeFileSync(path.join(home, '.hermes/config.yaml'), '# unrelated settings\nmodel: private-model\n');
  return { home, runtime };
}
const rows = root => fs.existsSync(path.join(root, 'sessions')) ? fs.readdirSync(path.join(root, 'sessions')).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(root, 'sessions', n)))) : [];

test('Hermes install/uninstall preserves profile configuration and unrelated plugin files', t => {
  const f = fixture(t), config = path.join(f.home, '.hermes/config.yaml'), before = fs.readFileSync(config, 'utf8');
  const a = Hermes.install(f), b = Hermes.install(f);
  assert.deepEqual(a, b);
  const dir = path.dirname(a.file);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'user data');
  assert.equal(Hermes.uninstall(f).changed, true);
  assert.deepEqual(fs.readdirSync(dir), ['keep.txt']);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  assert.throws(() => Hermes.install(f), /left unchanged/);
});

test('Hermes installer refuses existing foreign plugin and symlink', t => {
  const f = fixture(t), dir = path.dirname(Hermes.configPath(f.home));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '__init__.py'), 'foreign');
  assert.throws(() => Hermes.install(f), /left unchanged/);
  fs.rmSync(dir, { recursive: true });
  fs.symlinkSync(path.join(f.home, '.hermes'), dir);
  assert.throws(() => Hermes.install(f), /symlink/);
});

test('edited owned configuration is preserved on reconnect and uninstall', t => {
  const f = fixture(t), installed = Hermes.install(f);
  const modified = JSON.parse(fs.readFileSync(installed.file, 'utf8'));
  modified.command = ['/custom/program'];
  modified.custom = 'preserve';
  const text = JSON.stringify(modified);
  fs.writeFileSync(installed.file, text);
  assert.throws(() => Hermes.install(f), /left unchanged/);
  assert.throws(() => Hermes.uninstall(f), /left unchanged/);
  assert.equal(fs.readFileSync(installed.file, 'utf8'), text);
});

test('profile and dangling owned-file symlinks are left untouched', t => {
  const f = fixture(t), profile = path.join(f.home, '.hermes');
  fs.renameSync(profile, `${profile}-target`);
  fs.symlinkSync(`${profile}-target`, profile);
  assert.throws(() => Hermes.install(f), /symlink/);
  fs.unlinkSync(profile);
  fs.renameSync(`${profile}-target`, profile);
  const installed = Hermes.install(f);
  fs.unlinkSync(installed.file);
  fs.symlinkSync(path.join(f.home, 'missing'), installed.file);
  assert.throws(() => Hermes.install(f), /symlink/);
  assert.equal(fs.lstatSync(installed.file).isSymbolicLink(), true);
});

test('activation-affecting plugin extras prevent normal enable from spawning', async t => {
  const f = fixture(t), installed = Hermes.install(f), dir = path.dirname(installed.file);
  for (const name of ['pyproject.toml', 'mcp.json', 'plugin.yml', 'plugin.json']) {
    fs.writeFileSync(path.join(dir, name), 'synthetic additional configuration');
    let spawned = false;
    await assert.rejects(Hermes.connect({ ...f, bin: '/installed/hermes', run() { spawned = true; return {}; } }), /Additional files/);
    assert.equal(spawned, false);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'synthetic additional configuration');
    fs.unlinkSync(path.join(dir, name));
  }
});

test('Connect uses supported Hermes enable with explicit default profile and no privileged grant', async t => {
  const f = fixture(t);
  let called;
  const result = await Hermes.connect({ ...f, bin: '/installed/hermes', run(bin, args, opts, cb) {
    called = { bin, args, opts };
    queueMicrotask(() => cb(null));
    return { stdin: { end() {} } };
  } });
  assert.equal(result.hermesActivity, true);
  assert.deepEqual(called.args, ['--profile', 'default', 'plugins', 'enable', 'plexiform-activity', '--no-allow-tool-override']);
  assert.equal(called.opts.timeout, 10000);
  assert.equal(called.opts.env.HERMES_HOME, path.join(f.home, '.hermes'));
  assert.deepEqual(Object.keys(called.opts.env).sort(), ['HERMES_HOME', 'HOME', 'LANG', 'PATH']);
  const failure = await Hermes.connect({ ...f, bin: '/installed/hermes', run(_b, _a, _o, cb) { queueMicrotask(() => cb(new Error('private error'))); return {}; } });
  assert.equal(failure.ok, false);
  assert.doesNotMatch(JSON.stringify(failure), /private error/);
});

test('metadata lifecycle projects Hermes accurately and refuses stale turn reopening', t => {
  const { runtime: { dataDir } } = fixture(t);
  const apply = data => Bridge.apply({ sessionId: 'external-session', ...data }, dataDir);
  assert.equal(apply({ event: 'start', user_message: 'PRIVATE-PROMPT' }), true);
  assert.equal(Overview.snapshot({ sessions: rows(dataDir) }).sessions[0].status, 'Ready');
  assert.equal(apply({ event: 'working', turnId: 'session:task:turn1' }), true);
  assert.equal(Overview.snapshot({ sessions: rows(dataDir) }).sessions[0].status, 'Working');
  assert.equal(apply({ event: 'stop', turnId: 'session:task:turn1', failed: false }), true);
  assert.equal(apply({ event: 'working', turnId: 'session:task:turn1' }), false);
  assert.equal(apply({ event: 'start' }), false);
  assert.equal(apply({ event: 'stop', turnId: 'session:task:nonstreaming', failed: false }), true);
  assert.equal(rows(dataDir)[0].hermesTurnId, 'session:task:nonstreaming');
  assert.equal(apply({ event: 'working', turnId: 'session:task:turn2' }), true);
  assert.equal(apply({ event: 'stop', turnId: 'session:task:turn1', failed: false }), false);
  assert.equal(apply({ event: 'stop', turnId: 'session:task:turn2', failed: true }), true);
  const view = Overview.snapshot({ sessions: rows(dataDir), now: Date.now() + 100000 });
  assert.equal(view.sessions[0].provider, 'Hermes');
  assert.equal(view.sessions[0].status, 'Turn failed');
  assert.equal(view.sessions[0].freshness, 'stale');
  assert.doesNotMatch(JSON.stringify(rows(dataDir)), /PRIVATE-PROMPT/);
  assert.equal(apply({ event: 'working', turnId: '../bad' }), false);
  assert.equal(apply({ event: 'end' }), true);
  assert.deepEqual(rows(dataDir), []);
});

test('real Python plugin callbacks emit only metadata and suppress queued events after finalization', t => {
  const f = fixture(t);
  Hermes.install(f);
  const script = `import importlib.util, json, pathlib, sys
p = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('plexiform_activity_test', p / '__init__.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
hooks = {}
class Context:
    def register_hook(self, name, callback): hooks[name] = callback
m.register(Context())
assert set(hooks) == {'on_session_start','on_stream_start','on_session_end','on_session_finalize'}
extra = {'session_id': 'python-session', 'turn_id': 'session:task:turn', 'user_message': 'PRIVATE-PROMPT', 'conversation_history': ['PRIVATE-HISTORY'], 'tool_args': {'secret': 'PRIVATE-KEY'}}
assert hooks['on_session_start'](**extra) is None
hooks['on_stream_start'](**extra)
hooks['on_session_end'](**extra, completed=True)
hooks['on_stream_start'](**extra)
root = pathlib.Path(sys.argv[2]) / 'sessions'
row = json.loads(next(root.glob('*.json')).read_text())
assert row['signal'] == 'stop'
assert 'PRIVATE-' not in json.dumps(row)
hooks['on_session_finalize'](**extra)
hooks['on_stream_start'](**extra)
assert list(root.glob('*.json')) == []
print('observer callback lifecycle passed')
`;
  const result = spawnSync('python3', ['-c', script, path.dirname(Hermes.configPath(f.home)), f.runtime.dataDir], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lifecycle passed/);
  assert.equal(Hermes.uninstall(f).changed, true);
  assert.equal(Hermes.install(f).ok, true, 'reconnect works after a real Python import created bytecode cache');
});

test('bridge keeps a bounded absolute cwd and drops relative, oversized or control-character paths; an unknown plugin body stays foreign', t => {
  const f = fixture(t);
  const apply = data => Bridge.apply({ sessionId: 'cwd-session', ...data }, f.runtime.dataDir);
  assert.equal(apply({ event: 'start', cwd: '/Users/me/project' }), true);
  assert.equal(rows(f.runtime.dataDir)[0].cwd, '/Users/me/project');
  for (const cwd of ['relative/dir', `/${'a'.repeat(1100)}`, '/tmp/x\nforged', 42]) {
    assert.equal(apply({ event: 'working', turnId: `t${String(cwd).length}`, cwd }), true);
    assert.equal(rows(f.runtime.dataDir)[0].cwd, '/Users/me/project', 'an invalid cwd never replaces the known one');
  }
  Hermes.install(f);
  const init = path.join(path.dirname(Hermes.configPath(f.home)), '__init__.py');
  const original = fs.readFileSync(init, 'utf8');
  fs.writeFileSync(init, 'previous body');
  assert.throws(() => Hermes.install(f), /occupies/, 'an unknown body is foreign');
  fs.writeFileSync(init, original);
  assert.equal(Hermes.isInstalled({ home: f.home }), true);
});
