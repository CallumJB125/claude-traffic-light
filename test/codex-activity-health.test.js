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

function connectHandler({ allow = true, installed = true, fails = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('connect-agent',");
  const end = source.indexOf("ipcMain.handle('git-status',", start);
  assert.ok(start > 0 && end > start);
  let handler;
  const calls = [];
  const adapter = {
    install: () => { calls.push('notify'); return { ok: true, file: 'config.toml' }; },
    installActivity: () => { calls.push('lifecycle'); if (fails) throw new Error('fixture refusal'); return { ok: true, file: 'hooks.json' }; },
    configPath: () => 'config.toml', lifecycleConfigPath: () => 'hooks.json',
  };
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    fromNativeBoardSettings: e => allow && e === 'settings-main',
    Adapters: { get: id => ['codex', 'cursor'].includes(id) ? adapter : null },
    AUTO_INSTALL_HOOKS: installed, os: { homedir: () => '/synthetic' }, HOOK_RUNTIME: {},
  });
  return { run: (sender = 'settings-main', id = 'codex') => handler(sender, id), calls };
}

test('current Settings connect stages lifecycle hooks and explicitly requires Codex review', () => {
  const f = connectHandler();
  const r = f.run();
  assert.equal(r.ok, true);
  assert.equal(r.reviewRequired, true);
  assert.equal(r.file, 'hooks.json');
  assert.deepEqual(f.calls, ['lifecycle']);
});

test('untrusted sender and dev/temporary app never write agent configuration', () => {
  for (const f of [connectHandler({ allow: false }), connectHandler({ installed: false })]) {
    assert.equal(f.run().ok, false);
    assert.deepEqual(f.calls, []);
  }
  const f = connectHandler();
  assert.equal(f.run('settings-subframe').ok, false);
  assert.deepEqual(f.calls, []);
});

test('Codex install refusal points to lifecycle config and other agents retain their installer', () => {
  const f = connectHandler({ fails: true });
  assert.equal(f.run().file, 'hooks.json');
  assert.equal(f.run().ok, false);
  const other = connectHandler();
  assert.equal(other.run('settings-main', 'cursor').reviewRequired, undefined);
  assert.deepEqual(other.calls, ['notify']);
});

test('Codex health fix requires current Settings and an installed app, and preserves refusal', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('health-fix',");
  const end = source.indexOf('// Preferences → Backups.', start);
  assert.ok(start > 0 && end > start);
  for (const [sender, installed, succeeds, expected] of [
    ['other', true, true, 'Not allowed.'],
    ['settings', false, true, 'Open the installed app to connect Codex.'],
    ['settings', true, false, 'fixture refusal'],
    ['settings', true, true, null],
  ]) {
    let handler; let calls = 0;
    vm.runInNewContext(source.slice(start, end), {
      ipcMain: { handle: (_name, fn) => { handler = fn; } },
      fromNativeBoardSettings: e => e === 'settings', AUTO_INSTALL_HOOKS: installed,
      Adapters: { get: () => ({ installActivity: () => { calls++; return { ok: succeeds, error: 'fixture refusal' }; } }) },
      os: { homedir: () => '/synthetic' }, HOOK_RUNTIME: {}, healthReport: () => ({ checks: [] }), console: { log() {} },
    });
    assert.equal(handler(sender, 'connect-codex').error, expected);
    assert.equal(calls, sender === 'settings' && installed ? 1 : 0);
  }
});

test('Settings waits for configuration and asks for review without claiming live activity', async t => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<button data-agent="codex">Codex desktop and CLI</button><div id="connect-hint"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  let resolve;
  let calls = 0;
  dom.window.settingsApi = { connectAgent: () => { calls++; return new Promise(r => { resolve = r; }); } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
  const start = source.indexOf("document.querySelectorAll('[data-agent]')");
  const end = source.indexOf("const mcpToggle =", start);
  assert.ok(start > 0 && end > start);
  dom.window.eval(source.slice(start, end));
  const button = dom.window.document.querySelector('button');
  const hint = dom.window.document.getElementById('connect-hint');
  button.click(); button.click();
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(hint.textContent, '');
  resolve({ ok: true, file: 'hooks.json', reviewRequired: true });
  await new Promise(r => setImmediate(r));
  assert.equal(button.disabled, false);
  assert.match(hint.textContent, /^Configured/);
  assert.match(hint.textContent, /Review and trust/);
  assert.match(hint.textContent, /start a new turn/);
  assert.doesNotMatch(hint.textContent, /^Connected|working now|active session/);
  dom.window.settingsApi.connectAgent = async () => { throw new Error('fixture transport failure'); };
  button.click();
  await new Promise(r => setImmediate(r));
  assert.equal(button.disabled, false);
  assert.equal(hint.textContent, 'Could not connect. Try again from the installed app.');
});
