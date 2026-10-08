const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Health = require('../src/health');
const Codex = require('../adapters/codex');
const Runtime = require('../adapters/runtime');
const NOW = Date.parse('2026-10-02T05:00:00Z');

function fixture(t, configured = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-codex-health-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'data');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'));
  const runtime = Runtime.make({ execPath: null, hooksDir: path.join(home, 'hooks'), dataDir: root });
  if (configured) assert.equal(Codex.installActivity({ home, runtime }).ok, true);
  const event = value => fs.writeFileSync(path.join(root, 'sessions', 'codex.json'), JSON.stringify(value));
  const check = () => Health.checkCodexHooks({ home, root, runtime, now: NOW, fs });
  return { home, root, runtime, check, event };
}

test('Codex health distinguishes configuration from received lifecycle activity', t => {
  const f = fixture(t);
  const c = f.check();
  assert.equal(c.status, 'info');
  assert.match(c.detail, /No lifecycle event/);
  assert.match(c.next, /Review and trust/);
  assert.equal(c.trusted, undefined);
  assert.equal(c.fix, undefined);
});

test('legacy notify or generic Codex events cannot establish lifecycle observation', t => {
  const f = fixture(t, false);
  assert.equal(Codex.install({ home: f.home, runtime: f.runtime }).ok, true);
  f.event({ source: 'codex', updatedAt: new Date(NOW).toISOString(), signal: 'stop' });
  assert.equal(f.check().status, 'warn');
  assert.equal(f.check().fix, 'connect-codex');
  assert.equal(Codex.installActivity({ home: f.home, runtime: f.runtime }).ok, true);
  assert.match(f.check().detail, /No lifecycle event/);
});

test('Codex health reports observed age without inventing current work or trusting future stamps', t => {
  const f = fixture(t);
  const event = offset => f.event({ source: 'codex', codexLifecycle: 1, codexHookAt: new Date(NOW + offset).toISOString(), signal: 'stop' });
  event(-1000);
  assert.equal(f.check().status, 'ok');
  assert.match(f.check().detail, /Last lifecycle event: just now/);
  assert.doesNotMatch(f.check().detail, /working|trusted|active session/);
  event(-600000);
  assert.equal(f.check().status, 'info');
  assert.match(f.check().detail, /10 min ago/);
  event(1000);
  assert.match(f.check().detail, /No lifecycle event/);
});

test('Codex health detects moved configuration despite an old recent event', t => {
  const f = fixture(t);
  f.event({ source: 'codex', codexLifecycle: 1, codexHookAt: new Date(NOW).toISOString() });
  fs.writeFileSync(Codex.lifecycleConfigPath(f.home), '{}');
  assert.equal(f.check().status, 'warn');
  assert.equal(f.check().at, undefined);
});

function connectHandler({ allow = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('connect-agent',");
  const end = source.indexOf("ipcMain.handle('git-status',", start);
  assert.ok(start > 0 && end > start);
  let handler;
  const opened = [];
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    fromNativeBoardSettings: e => allow && e === 'settings-main',
    aiToolsOpen: (destination) => { opened.push(destination); return true; },
  });
  return { run: (sender = 'settings-main', id = 'codex') => handler(sender, id), opened };
}

test('Settings connect buttons open the AI tools page on that tool and write nothing themselves', async () => {
  for (const id of ['codex', 'cursor', 'gemini', 'hermes']) {
    const f = connectHandler();
    assert.equal(JSON.stringify(await f.run('settings-main', id)), '{"ok":true,"opened":true}');
    assert.deepEqual(f.opened, [`aitools:${id}`]);
  }
});

test('an untrusted sender, a subframe or a boxed or unknown agent id opens nothing', async () => {
  const f = connectHandler({ allow: false });
  assert.equal((await f.run()).ok, false);
  const g = connectHandler();
  assert.equal((await g.run('settings-subframe')).ok, false);
  for (const id of [structuredClone(new String('codex')), ['codex'], { id: 'codex' }, null, 1, 'aitools:all', 'claude']) {
    assert.equal((await g.run('settings-main', id)).ok, false);
  }
  assert.deepEqual([...f.opened, ...g.opened], []);
});

test('Codex health fix requires current Settings and an installed app, and preserves refusal', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('health-fix',");
  const end = source.indexOf('// Preferences → Backups.', start);
  assert.ok(start > 0 && end > start);
  for (const [sender, installed, packaged, succeeds, expected] of [
    ['other', true, true, true, 'Not allowed.'],
    ['settings', false, true, true, 'Open the installed app to connect Codex.'],
    ['settings', true, false, true, 'Open the installed app to connect Codex.'],
    ['settings', true, true, false, 'fixture refusal'],
    ['settings', true, true, true, null],
  ]) {
    let handler; let calls = 0;
    vm.runInNewContext(source.slice(start, end), {
      ipcMain: { handle: (_name, fn) => { handler = fn; } },
      fromNativeBoardSettings: e => e === 'settings', AUTO_INSTALL_HOOKS: installed,
      app: { isPackaged: packaged },
      Adapters: { get: () => ({ installActivity: () => { calls++; return { ok: succeeds, error: 'fixture refusal' }; } }) },
      os: { homedir: () => '/synthetic' }, HOOK_RUNTIME: {}, healthReport: () => ({ checks: [] }), console: { log() {} },
    });
    assert.equal(handler(sender, 'connect-codex').error, expected);
    assert.equal(calls, sender === 'settings' && installed && packaged ? 1 : 0);
  }
});

test('Settings no longer carries connect buttons: AI tools is the one place to connect a tool', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  assert.doesNotMatch(html, /data-agent=/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8'), /connectAgent/);
});
