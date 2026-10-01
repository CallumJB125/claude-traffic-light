// The Claude Buddy → Plexiform first-launch migration (src/rename-migration.js),
// against a fixture profile in a temp HOME. Processes, the dialog and the Bin
// are stubs: nothing here looks at the real home, Application Support,
// Keychain or /Applications.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('../src/rename-migration.js');
const Adapters = require('../adapters/index.js');
const McpInstall = require('../mcp-install.js');

const Runtime = Adapters.Runtime;
const Claude = Adapters.get('claude');
const quiet = () => {};

function tmpHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-rename-')));
}

// Every file under dir (symlinks as their target text) → its sha256, plus each entry's mtime.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) { out[`${rel}/`] = st.mtimeMs; walk(p); } else out[rel] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}@${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

// An old install's userData, as Electron and the app left it.
function oldProfile(home) {
  const appData = path.join(home, 'Library', 'Application Support');
  const old = path.join(appData, 'claude-buddy');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(old, rel)), { recursive: true }); fs.writeFileSync(path.join(old, rel), text); };
  put('Preferences', '{"spellcheck":{"dictionaries":[]}}');
  put('Local State', '{"os_crypt":{}}');
  put('Local Storage/leveldb/000003.log', 'ls');
  put('buddy-workspaces.json', '{"active":"local"}');
  put('updater.json', '{"lastIssuedAt":{"stable":"2026-09-01T00:00:00.000Z"}}');
  put('board/hub.db', 'db');
  put('runner/abc-t1/state.json', '{}');
  put('buddy-accounts/abc.bin', 'sealed under the old Keychain item');
  put('buddy-devices/abc-t1.bin', 'sealed too');
  put('updates/staged/x', 'stale');
  put('updates/swap-pending.json', '{}');
  put('Cache/Cache_Data/data_0', 'cache');
  put('Code Cache/js/index', 'cache');
  fs.symlinkSync('old-host-99999', path.join(old, 'SingletonLock'));
  return { appData, old, userData: path.join(appData, 'Plexiform') };
}

test('userData: copied, not moved; the old folder is untouched; the lock, staged updates, caches and sealed blobs stay behind', () => {
  const home = tmpHome();
  const { appData, old, userData } = oldProfile(home);
  const before = snapshot(old);
  const logs = [];
  const r = M.copyUserData({ appData, userData, log: (m) => logs.push(m), now: () => new Date('2026-10-01T09:00:00Z') });
  assert.equal(r.copied, true);
  assert.equal(r.from, old);
  assert.deepEqual(snapshot(old), before, 'the old folder is byte-for-byte and mtime-for-mtime as it was');
  for (const f of ['Preferences', 'Local State', 'Local Storage/leveldb/000003.log', 'buddy-workspaces.json', 'updater.json', 'board/hub.db', 'runner/abc-t1/state.json']) {
    assert.equal(fs.readFileSync(path.join(userData, f), 'utf8'), fs.readFileSync(path.join(old, f), 'utf8'), f);
  }
  for (const f of ['SingletonLock', 'updates', 'Cache', 'Code Cache', 'buddy-accounts', 'buddy-devices']) assert.ok(!fs.existsSync(path.join(userData, f)) && !isLink(path.join(userData, f)), `${f} not copied`);
  assert.deepEqual(r.skipped, ['Cache', 'Code Cache', 'SingletonLock', 'buddy-accounts', 'buddy-devices', 'updates']);
  const state = M.readState(userData);
  assert.deepEqual(state.pending, M.STEPS);
  assert.equal(state.from, old);
  assert.equal(state.copiedAt, '2026-10-01T09:00:00.000Z');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /copied .*claude-buddy to .*Plexiform .*left out: Cache, Code Cache, SingletonLock, buddy-accounts, buddy-devices, updates/);
  assert.deepEqual(fs.readdirSync(appData).sort(), ['Plexiform', 'claude-buddy'], 'no temp folder left behind');
  fs.rmSync(home, { recursive: true, force: true });
});

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

test('userData: an existing new folder is never overwritten, and a second launch copies nothing', () => {
  const home = tmpHome();
  const { appData, old, userData } = oldProfile(home);
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'Preferences'), 'mine');
  const existing = snapshot(userData);
  const logs = [];
  const r = M.copyUserData({ appData, userData, log: (m) => logs.push(m) });
  assert.equal(r.copied, false);
  assert.match(r.reason, /already in use \(Preferences\)/);
  assert.match(logs[0], /not copying .* already in use/);
  assert.deepEqual(snapshot(userData), existing);
  assert.equal(M.readState(userData), null);

  // Idempotent: copy once into a fresh folder, then again.
  fs.rmSync(userData, { recursive: true, force: true });
  assert.equal(M.copyUserData({ appData, userData, log: quiet }).copied, true);
  const once = snapshot(userData);
  const oldOnce = snapshot(old);
  const second = [];
  assert.equal(M.copyUserData({ appData, userData, log: (m) => second.push(m) }).copied, false);
  assert.match(second[0], /not copying .*: already migrated$/, 'the already-migrated branch is logged too');
  assert.deepEqual(snapshot(userData), once);
  assert.deepEqual(snapshot(old), oldOnce);
  fs.rmSync(home, { recursive: true, force: true });
});

// Electron creates the new folder before main.js copies: getPath('userData')
// makes it empty, a crash reporter adds Crashpad. Neither is a used folder.
test('userData: a new folder Electron made (empty, or only Crashpad) is replaced by the copy; the old folder is untouched', () => {
  for (const fresh of [[], ['Crashpad/'], ['Crashpad/settings.dat', 'Crashpad/attachments/', '.DS_Store']]) {
    const home = tmpHome();
    const { appData, old, userData } = oldProfile(home);
    fs.mkdirSync(userData, { recursive: true });
    for (const f of fresh) {
      if (f.endsWith('/')) fs.mkdirSync(path.join(userData, f), { recursive: true });
      else { fs.mkdirSync(path.dirname(path.join(userData, f)), { recursive: true }); fs.writeFileSync(path.join(userData, f), 'x'); }
    }
    const before = snapshot(old);
    const r = M.copyUserData({ appData, userData, log: quiet });
    assert.equal(r.copied, true, JSON.stringify(fresh));
    assert.equal(fs.readFileSync(path.join(userData, 'Preferences'), 'utf8'), fs.readFileSync(path.join(old, 'Preferences'), 'utf8'));
    assert.ok(!fs.existsSync(path.join(userData, 'Crashpad')), 'the fresh folder went, Crashpad with it');
    assert.deepEqual(M.readState(userData).pending, M.STEPS);
    assert.deepEqual(snapshot(old), before);
    assert.deepEqual(fs.readdirSync(appData).sort(), ['Plexiform', 'claude-buddy'], 'no temp or set-aside folder left');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('userData: nothing to copy without an old folder; a dead launch\'s half copy is cleared and the copy redone', () => {
  const home = tmpHome();
  const appData = path.join(home, 'AppData', 'Roaming');
  fs.mkdirSync(appData, { recursive: true });
  const userData = path.join(appData, 'Plexiform');
  assert.deepEqual(M.copyUserData({ appData, userData, log: quiet }), { copied: false, from: path.join(appData, 'claude-buddy'), to: userData, reason: 'no old folder' });
  assert.ok(!fs.existsSync(userData));

  const p = oldProfile(home);
  const half = `${p.userData}.migrating-999999`;
  fs.mkdirSync(half, { recursive: true });
  fs.writeFileSync(path.join(half, 'Preferences'), 'half');
  assert.equal(M.copyUserData({ appData: p.appData, userData: p.userData, log: quiet, pid: 4242 }).copied, true);
  assert.ok(!fs.existsSync(half));
  assert.equal(fs.readFileSync(path.join(p.userData, 'Preferences'), 'utf8'), fs.readFileSync(path.join(p.old, 'Preferences'), 'utf8'));
  fs.rmSync(home, { recursive: true, force: true });
});

// ── hooks and MCP ───────────────────────────────────────────────────────────

const OLD_APP = '/Applications/Claude Buddy.app';
const NEW_APP = '/Applications/Plexiform.app';
const runtimeAt = (app, dataDir) => Runtime.make({ execPath: `${app}/Contents/MacOS/${path.basename(app, '.app')}`, platform: 'darwin', hooksDir: `${app}/Contents/Resources/hooks`, dataDir });
const mcpEntryAt = (app) => McpInstall.launch({ packaged: true, execPath: `${app}/Contents/MacOS/${path.basename(app, '.app')}`, appPath: `${app}/Contents/Resources/app.asar` });

// Agent configs an old install left: Buddy's entries at the old .app path, next to the person's own.
function oldHooksProfile() {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const oldRt = runtimeAt(OLD_APP, dataDir);
  const foreign = { type: 'command', command: 'say done' };
  const settings = Claude.apply({ model: 'opus', env: { FOO: '1' }, permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ matcher: '', hooks: [foreign] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }] } }, oldRt, { askFromWidget: true, home });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'my-own-stop' }] } }));
  Adapters.get('cursor').install({ home, runtime: oldRt });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n');
  assert.equal(Adapters.get('codex').install({ home, runtime: oldRt }).ok, true);
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const geminiText = '{"theme":"dark"}';
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), geminiText);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 7, projects: { '/x': { allowedTools: [] } }, mcpServers: { other: { command: 'node', args: ['other.js'] }, 'claude-buddy': mcpEntryAt(OLD_APP) } }));
  return { home, dataDir, settingsFile, before: fs.readFileSync(settingsFile, 'utf8'), geminiText };
}

const commandsOf = (settings) => Object.values(settings.hooks || {}).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));

test('hooks: Buddy\'s entries at the old .app path now run the new app; foreign hooks, other keys and the deny rule stay; one backup', () => {
  const { home, dataDir, settingsFile, before, geminiText } = oldHooksProfile();
  const newRt = runtimeAt(NEW_APP, dataDir);
  const r = M.rewriteHooks({ home, runtime: newRt, askFromWidget: true, mcpEntry: mcpEntryAt(NEW_APP), log: quiet });
  assert.deepEqual(r.map((x) => [x.id, x.changed, x.error]), [['claude', true, undefined], ['cursor', true, undefined], ['codex', true, undefined], ['mcp', true, undefined]]);

  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.env, { FOO: '1' });
  assert.deepEqual(s.permissions.allow, ['Bash(npm test)']);
  assert.deepEqual(s.permissions.deny, ['Edit(~/.claude-traffic-light/**)']);
  const cmds = commandsOf(s);
  assert.ok(cmds.includes('say done') && cmds.includes('my-guard.sh'), 'foreign hooks kept');
  assert.ok(!cmds.some((c) => c.includes('Claude Buddy.app')), 'no old-path entry left');
  const ours = cmds.filter((c) => Claude.isOurs(c));
  assert.equal(ours.length, Claude.HOOK_EVENTS.length + Claude.OPTIONAL_EVENTS.length);
  assert.ok(ours.every((c) => c.startsWith(`ELECTRON_RUN_AS_NODE=1 "${NEW_APP}/Contents/MacOS/Plexiform" "${NEW_APP}/Contents/Resources/hooks/set-status.js"`)), ours[0]);
  assert.equal(Claude.isInstalled({ home, runtime: newRt, askFromWidget: true }), true);
  assert.equal(fs.readFileSync(`${settingsFile}.buddy-backup`, 'utf8'), before, 'the backup is the file as it was');

  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8'));
  const cursorCmds = Object.values(cursor.hooks).flatMap((l) => l.map((h) => h.command));
  assert.ok(cursorCmds.includes('my-own-stop'));
  assert.ok(cursorCmds.filter((c) => c !== 'my-own-stop').every((c) => c.includes(NEW_APP) && !c.includes('Claude Buddy')), cursorCmds.join('\n'));
  // Codex runs the wrapper, whose path never changes: the wrapper now runs the new binary.
  assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /model = "o3"/);
  assert.match(fs.readFileSync(path.join(dataDir, 'bin', 'buddy-hook'), 'utf8'), /exec '\/Applications\/Plexiform\.app\/Contents\/MacOS\/Plexiform' "\$@"/);
  assert.equal(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'), geminiText, 'an agent with nothing of ours is not touched');
  assert.ok(!fs.existsSync(path.join(home, '.gemini', 'settings.json.buddy-backup')));

  // MCP: the entry follows the app; the rest of ~/.claude.json is as it was.
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(cj.mcpServers['claude-buddy'], mcpEntryAt(NEW_APP));
  assert.deepEqual(cj.mcpServers.other, { command: 'node', args: ['other.js'] });
  assert.equal(cj.numStartups, 7);
  assert.deepEqual(cj.projects, { '/x': { allowedTools: [] } });

  // Again: nothing more to change, and the backup is still the original.
  const settled = fs.readFileSync(settingsFile, 'utf8');
  const again = M.rewriteHooks({ home, runtime: newRt, askFromWidget: true, mcpEntry: mcpEntryAt(NEW_APP), log: quiet });
  assert.deepEqual(again.map((x) => x.id), ['claude', 'cursor', 'codex'], 'MCP already current');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), settled);
  assert.equal(fs.readFileSync(`${settingsFile}.buddy-backup`, 'utf8'), before);
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: a foreign MCP server under the same name, an unparsable settings file and a home with no agents are left alone', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const newRt = runtimeAt(NEW_APP, dataDir);
  assert.deepEqual(M.rewriteHooks({ home, runtime: newRt, mcpEntry: mcpEntryAt(NEW_APP), log: quiet }), []);
  assert.ok(!fs.existsSync(path.join(home, '.claude')) && !fs.existsSync(path.join(home, '.claude.json')));

  const theirs = JSON.stringify({ mcpServers: { 'claude-buddy': { command: 'someone-else', args: ['their.js'] } } });
  fs.writeFileSync(path.join(home, '.claude.json'), theirs);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
  const r = M.rewriteHooks({ home, runtime: newRt, mcpEntry: mcpEntryAt(NEW_APP), log: quiet });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'claude');
  assert.ok(r[0].error);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ not json');
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), theirs);
  fs.rmSync(home, { recursive: true, force: true });
});

// ── the old app ─────────────────────────────────────────────────────────────

test('old instance: the old main process is asked to quit (SIGTERM) and waited for; helpers, this app and other OSes are not', () => {
  const procs = [
    { pid: 111, command: '/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy' },
    { pid: 112, command: '/Applications/Claude Buddy.app/Contents/Frameworks/Claude Buddy Helper.app/Contents/MacOS/Claude Buddy Helper' },
    { pid: 113, command: '/Applications/Plexiform.app/Contents/MacOS/Plexiform' },
    { pid: 114, command: '/Users/me/Downloads/Claude Buddy.app/Contents/MacOS/Claude Buddy' },
  ];
  const kills = [];
  const live = new Set([111, 114]);
  let slept = 0;
  const asked = M.quitOldInstance({
    platform: 'darwin', listProcesses: () => procs, self: 113, log: quiet,
    kill: (pid, sig) => kills.push([pid, sig]),
    isAlive: (pid) => live.has(pid),
    sleep: () => { slept += 1; if (slept === 3) live.clear(); },
  });
  assert.deepEqual(asked, [111, 114]);
  assert.deepEqual(kills, [[111, 'SIGTERM'], [114, 'SIGTERM']]);
  assert.equal(slept, 3);

  const stuck = [];
  M.quitOldInstance({ platform: 'darwin', listProcesses: () => procs.slice(0, 1), kill: () => {}, isAlive: () => true, sleep: () => {}, waitMs: 300, log: (m) => stuck.push(m) });
  assert.match(stuck.at(-1), /still running/);

  const debKills = [];
  M.quitOldInstance({ platform: 'linux', listProcesses: () => [{ pid: 7, command: '/opt/Claude Buddy/plexiform --no-sandbox' }, { pid: 8, command: '/opt/Plexiform/plexiform' }], kill: (pid) => debKills.push(pid), isAlive: () => false, log: quiet });
  assert.deepEqual(debKills, [7]);

  for (const platform of ['win32']) {
    let listed = false;
    assert.deepEqual(M.quitOldInstance({ platform, listProcesses: () => { listed = true; return procs; }, kill: () => assert.fail('no kill'), log: quiet }), []);
    assert.equal(listed, false);
  }
  assert.deepEqual(M.parsePs('  111 /Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy\n 9 /sbin/launchd\n\n'), [{ pid: 111, command: '/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy' }, { pid: 9, command: '/sbin/launchd' }]);
});

test('old app: Keep does nothing; Remove bins exactly that path; never asked off macOS or when it is gone', async () => {
  const home = '/Users/fixture';
  const there = new Set(['/Applications/Claude Buddy.app']);
  const exists = (p) => there.has(p);
  const dialogs = [];
  const binned = [];
  const run = (response, platform = 'darwin') => M.offerRemoveOldApp({ platform, home, name: 'Plexiform', exists, log: quiet, showDialog: async (o) => { dialogs.push(o); return { response }; }, trashItem: async (p) => { binned.push(p); } });

  assert.deepEqual(await run(1), [{ path: '/Applications/Claude Buddy.app', removed: false }]);
  assert.deepEqual(binned, []);
  assert.deepEqual(dialogs[0].buttons, ['Remove', 'Keep']);
  assert.equal(dialogs[0].defaultId, 1);
  assert.equal(dialogs[0].cancelId, 1);
  assert.match(dialogs[0].detail, /\/Applications\/Claude Buddy\.app/);

  assert.deepEqual(await run(0), [{ path: '/Applications/Claude Buddy.app', removed: true }]);
  assert.deepEqual(binned, ['/Applications/Claude Buddy.app']);

  dialogs.length = 0;
  assert.deepEqual(await run(0, 'win32'), []);
  assert.deepEqual(await run(0, 'linux'), []);
  there.clear();
  assert.deepEqual(await run(0), []);
  assert.equal(dialogs.length, 0);
  assert.deepEqual(binned, ['/Applications/Claude Buddy.app']);
  assert.deepEqual(M.oldAppPaths(home), ['/Applications/Claude Buddy.app', '/Users/fixture/Applications/Claude Buddy.app']);

  // A Bin that refuses is reported, not thrown.
  there.add('/Users/fixture/Applications/Claude Buddy.app');
  const r = await M.offerRemoveOldApp({ platform: 'darwin', home, name: 'Plexiform', exists, log: quiet, showDialog: async () => ({ response: 0 }), trashItem: async () => { throw new Error('nope'); } });
  assert.deepEqual(r, [{ path: '/Users/fixture/Applications/Claude Buddy.app', removed: false, error: 'nope' }]);
});

test('login item: turned on for the new app where the old one had set it up; the old Windows entry goes; Linux rewrites its own file', () => {
  const calls = [];
  const loginItem = (on) => ({ get: () => on, set: (v) => calls.push(['set', v]) });
  const app = { setLoginItemSettings: (o) => calls.push(['electron', o]) };
  M.moveLoginItem({ platform: 'darwin', app, loginItem: loginItem(false), autoLaunchConfigured: true });
  assert.deepEqual(calls.splice(0), [['set', true]]);
  M.moveLoginItem({ platform: 'darwin', app, loginItem: loginItem(false), autoLaunchConfigured: false });
  assert.deepEqual(calls.splice(0), []);
  M.moveLoginItem({ platform: 'win32', app, loginItem: loginItem(false), autoLaunchConfigured: true });
  assert.deepEqual(calls.splice(0), [['set', true], ['electron', { openAtLogin: false, name: 'com.callumbaker.claude-buddy' }]]);
  M.moveLoginItem({ platform: 'linux', app, loginItem: loginItem(true), autoLaunchConfigured: true });
  assert.deepEqual(calls.splice(0), [['set', true]]);
  M.moveLoginItem({ platform: 'linux', app, loginItem: loginItem(false), autoLaunchConfigured: true });
  assert.deepEqual(calls.splice(0), []);
});

test('follow-up: each pending step runs once, in order; a step that returns false stays pending; a throw is logged and done', async () => {
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  M.copyUserData({ appData, userData, log: quiet });
  const ran = [];
  const logs = [];
  let hooksReady = false;
  const steps = {
    'quit-old': () => { ran.push('quit-old'); },
    hooks: () => { ran.push('hooks'); if (!hooksReady) return false; return undefined; },
    login: () => { ran.push('login'); throw new Error('boom'); },
    'remove-old-app': async () => { ran.push('remove-old-app'); },
  };
  const p = M.runFollowUp({ userData, steps, log: (m) => logs.push(m) });
  assert.deepEqual(ran.slice(0, 3), ['quit-old', 'hooks', 'login'], 'the synchronous steps are done before it returns');
  await p;
  assert.deepEqual(ran, ['quit-old', 'hooks', 'login', 'remove-old-app']);
  assert.deepEqual(M.pending(userData), ['hooks']);
  assert.match(logs[0], /login failed: boom/);
  ran.length = 0;
  hooksReady = true;
  await M.runFollowUp({ userData, steps, log: quiet });
  assert.deepEqual(ran, ['hooks']);
  assert.deepEqual(M.pending(userData), []);
  await M.runFollowUp({ userData, steps, log: quiet });
  assert.deepEqual(ran, ['hooks']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('main.js copies userData before the instance lock and anything else that opens it, and only for the installed app', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const copy = src.indexOf('RenameMigration.copyUserData(');
  assert.ok(copy > 0);
  for (const later of ['requestSingleInstanceLock()', "app.getPath('userData'));\n  let target", 'clearStaleSingletonLock();', 'Updater.start(', 'createBuddyWindow', 'safeStorage: require']) {
    const at = src.indexOf(later);
    if (at >= 0) assert.ok(at > copy, `${later} comes after the copy`);
  }
  const firstUserData = src.search(/getPath\('userData'\)/);
  assert.ok(firstUserData > src.indexOf('const RENAME_MIGRATES'), 'nothing reads userData before the migration decides');
  assert.match(src, /const RENAME_MIGRATES = app\.isPackaged && !IS_DEV_RUN && !app\.commandLine\.hasSwitch\('user-data-dir'\);/);
  assert.match(src, /copyUserData\(\{ appData: app\.getPath\('appData'\), userData: path\.join\(app\.getPath\('appData'\), app\.getName\(\)\)/, 'the target is worked out, not getPath(userData), which would create it');
  // The follow-up runs before the startup hook check, and never for a smoke run.
  const follow = src.indexOf('if (RENAME_MIGRATES && gotLock) renameFollowUp()');
  assert.ok(follow > src.indexOf('if (smokeReport) {') && follow < src.indexOf('if (AUTO_INSTALL_HOOKS && !areHooksInstalled()) installHooks();'));
});
