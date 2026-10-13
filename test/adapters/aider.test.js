// Aider: the notifications-command lines in ~/.aider.conf.yml, and the
// ready payload through normalize(), emit.js and /hook/:adapter.
const { suite, tmp } = require('./helpers.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Aider = require('../../adapters/aider.js');
const Generic = require('../../adapters/generic.js');
const Runtime = require('../../adapters/runtime.js');

suite(Aider);

const rt = () => Runtime.make({ execPath: null, hooksDir: '/hooks', dataDir: '/data' });

test('aider: install appends two marked lines, keeps everything else, and uninstall removes exactly those', () => {
  const home = tmp();
  const file = Aider.configPath(home);
  fs.writeFileSync(file, 'model: sonnet\ndark-mode: true\n');
  const r = Aider.install({ home, runtime: rt() });
  assert.equal(r.ok, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^model: sonnet\ndark-mode: true\nnotifications: true # plexiform\nnotifications-command: '.*' # plexiform\n$/s);
  assert.match(text, /\$PLEXIFORM_SESSION.*--adapter generic ready.*--adapter aider ready/);
  assert.equal(Aider.isInstalled({ home, runtime: rt() }), true);
  assert.equal(Aider.holdsOurs({ home }), true);
  Aider.install({ home, runtime: rt() });
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'connecting twice adds nothing');
  Aider.uninstall({ home });
  assert.equal(fs.readFileSync(file, 'utf8'), 'model: sonnet\ndark-mode: true\n');
  assert.equal(Aider.isInstalled({ home, runtime: rt() }), false);
});

test('aider: a config of only our lines is removed on uninstall; a missing one is fine', () => {
  const home = tmp();
  Aider.install({ home, runtime: rt() });
  Aider.uninstall({ home });
  assert.equal(fs.existsSync(Aider.configPath(home)), false);
  assert.equal(Aider.uninstall({ home }).changed, false);
});

test('aider: the person\'s own notifications-command is left alone and the connection refused', () => {
  const home = tmp();
  fs.writeFileSync(Aider.configPath(home), 'notifications-command: say done\n');
  assert.throws(() => Aider.install({ home, runtime: rt() }), /your own notifications-command/);
  assert.equal(fs.readFileSync(Aider.configPath(home), 'utf8'), 'notifications-command: say done\n');
});

test('aider: an existing notifications: true of theirs is reused, only our command line is added', () => {
  const home = tmp();
  fs.writeFileSync(Aider.configPath(home), 'notifications: true\n');
  Aider.install({ home, runtime: rt() });
  const lines = fs.readFileSync(Aider.configPath(home), 'utf8').split('\n');
  assert.equal(lines.filter((l) => /^notifications:/.test(l)).length, 1);
  assert.equal(Aider.isInstalled({ home, runtime: rt() }), true);
});

test('aider: the YAML single-quoted command survives a round trip through a YAML reader', () => {
  const cmd = Aider.notifyCommand(rt());
  const line = Aider.apply('', rt()).split('\n')[1];
  const m = /^notifications-command: '((?:[^']|'')*)' # plexiform$/.exec(line);
  assert.ok(m, line);
  assert.equal(m[1].replace(/''/g, "'"), cmd);
});

test('aider inside plexiform-run: ready joins the wrapper\'s own session as your turn', () => {
  const [e] = Generic.normalize('ready', { tool: 'aider', session: 'aider-99-1', pid: 99 });
  assert.deepEqual([e.signal, e.sessionId, e.tool], ['stop', 'aider-99-1', null]);
});
