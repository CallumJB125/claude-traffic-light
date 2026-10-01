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
  put('board-dev/worktrees/x/README', 'big');
  put('buddy-accounts/abc.bin', 'sealed under the old Keychain item');
  put('buddy-devices/abc-t1.bin', 'sealed too');
  put('updates/staged/x', 'stale');
  put('updates/swap-pending.json', '{}');
  put('Cache/Cache_Data/data_0', 'cache');
  put('Code Cache/js/index', 'cache');
  fs.symlinkSync('old-host-99999', path.join(old, 'SingletonLock'));
  return { appData, old, userData: path.join(appData, 'Plexiform') };
}

test('userData: copied, not moved; the old folder is untouched; the lock, staged updates, caches, sealed blobs and the runner stay behind', () => {
  const home = tmpHome();
  const { appData, old, userData } = oldProfile(home);
  const before = snapshot(old);
  const logs = [];
  const r = M.copyUserData({ appData, userData, log: (m) => logs.push(m), now: () => new Date('2026-10-01T09:00:00Z') });
  assert.equal(r.copied, true);
  assert.equal(r.from, old);
  assert.deepEqual(snapshot(old), before, 'the old folder is byte-for-byte and mtime-for-mtime as it was');
  for (const f of ['Preferences', 'Local State', 'Local Storage/leveldb/000003.log', 'buddy-workspaces.json', 'updater.json', 'board/hub.db']) {
    assert.equal(fs.readFileSync(path.join(userData, f), 'utf8'), fs.readFileSync(path.join(old, f), 'utf8'), f);
  }
  for (const f of ['SingletonLock', 'updates', 'Cache', 'Code Cache', 'buddy-accounts', 'buddy-devices', 'runner', 'board-dev']) assert.ok(!fs.existsSync(path.join(userData, f)) && !isLink(path.join(userData, f)), `${f} not copied`);
  assert.deepEqual(r.skipped, ['Cache', 'Code Cache', 'SingletonLock', 'board-dev', 'buddy-accounts', 'buddy-devices', 'runner', 'updates']);
  const state = M.readState(userData);
  assert.deepEqual(state.pending, M.STEPS);
  assert.equal(state.from, old);
  assert.equal(state.copiedAt, '2026-10-01T09:00:00.000Z');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /copied .*claude-buddy to .*Plexiform .*left out: Cache, Code Cache, SingletonLock, board-dev, buddy-accounts, buddy-devices, runner, updates/);
  assert.deepEqual(fs.readdirSync(appData).sort(), ['Plexiform', 'claude-buddy'], 'no temp folder left behind');
  fs.rmSync(home, { recursive: true, force: true });
});

const aside = (appData) => fs.readdirSync(appData).filter((n) => n.startsWith('Plexiform.pre-migration-')).sort();

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
test('userData: a new folder Electron made (empty, or only Crashpad) gives way to the copy and is kept aside unless empty; the old folder is untouched', () => {
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
    assert.ok(!fs.existsSync(path.join(userData, 'Crashpad')), 'the fresh folder gave way, Crashpad with it');
    assert.deepEqual(M.readState(userData).pending, M.STEPS);
    assert.deepEqual(snapshot(old), before);
    const kept = aside(appData);
    if (!fresh.length) assert.deepEqual(kept, [], 'an empty one is removed');
    else { assert.equal(kept.length, 1, 'one with anything in it is kept'); assert.ok(fs.existsSync(path.join(appData, kept[0], 'Crashpad'))); assert.equal(r.keptAside, path.join(appData, kept[0])); }
    assert.ok(!fs.readdirSync(appData).some((n) => n.includes('.migrating-')), 'no temp folder left');
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

test('userData: the old app still running at copy time → nothing copied, a retry marker; the next launch copies, keeping the folder this one used aside', () => {
  const home = tmpHome();
  const { appData, old, userData } = oldProfile(home);
  const before = snapshot(old);
  const procs = [{ pid: 111, command: '/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy' }];
  const kills = [];
  let live = true;
  const quitOld = () => M.quitOldInstance({ platform: 'darwin', listProcesses: () => procs, kill: (pid, sig) => kills.push([pid, sig]), isAlive: () => live, sleep: () => {}, waitMs: 500, log: quiet }).running.length === 0;
  const logs = [];
  const r = M.copyUserData({ appData, userData, quitOld, log: (m) => logs.push(m) });
  assert.deepEqual([r.copied, r.retry, r.reason], [false, true, 'the old app is still running']);
  assert.deepEqual(kills, [[111, 'SIGTERM']], 'SIGTERM only, never SIGKILL');
  assert.equal(M.readState(userData).status, 'retry');
  assert.deepEqual(M.pending(userData), [], 'no follow-up runs on a folder that was not copied');
  assert.match(logs.at(-1), /trying again next launch/);
  assert.deepEqual(snapshot(old), before);
  // This launch carries on with the folder: Chromium fills it.
  fs.writeFileSync(path.join(userData, 'Local State'), '{"new":1}');
  fs.mkdirSync(path.join(userData, 'Crashpad'));

  live = false;
  const r2 = M.copyUserData({ appData, userData, quitOld, log: quiet });
  assert.equal(r2.copied, true);
  assert.equal(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'), fs.readFileSync(path.join(old, 'Local State'), 'utf8'));
  assert.deepEqual(M.readState(userData).pending, M.STEPS);
  const kept = aside(appData);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(appData, kept[0], 'Local State'), 'utf8'), '{"new":1}', 'what the retry launch wrote is kept');
  assert.deepEqual(snapshot(old), before);

  // The old app is asked only when a copy is about to happen.
  let asked = 0;
  M.copyUserData({ appData, userData, quitOld: () => { asked += 1; return true; }, log: quiet });
  fs.rmSync(old, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  M.copyUserData({ appData, userData, quitOld: () => { asked += 1; return true; }, log: quiet });
  assert.equal(asked, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('userData: unreadable files, unreadable folders and FIFOs are left out one by one; a copy that fails as a whole is retried next launch', () => {
  const home = tmpHome();
  const { appData, old, userData } = oldProfile(home);
  fs.writeFileSync(path.join(old, 'locked.json'), 'x');
  fs.chmodSync(path.join(old, 'locked.json'), 0);
  fs.mkdirSync(path.join(old, 'board', 'private'));
  fs.chmodSync(path.join(old, 'board', 'private'), 0);
  require('node:child_process').execFileSync('/usr/bin/mkfifo', [path.join(old, 'pipe')]);
  const r = M.copyUserData({ appData, userData, log: quiet });
  assert.equal(r.copied, true);
  for (const f of ['locked.json', 'pipe', path.join('board', 'private')]) assert.ok(r.skipped.includes(f), `${f} recorded in skipped: ${r.skipped}`);
  assert.deepEqual(M.readState(userData).skipped, r.skipped);
  assert.equal(fs.readFileSync(path.join(userData, 'board', 'hub.db'), 'utf8'), 'db', 'the rest of board/ came across');
  fs.chmodSync(path.join(old, 'locked.json'), 0o600);
  fs.chmodSync(path.join(old, 'board', 'private'), 0o700);

  // ENOSPC halfway: no copy, a retry marker; the next launch copies.
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(path.join(old, 'pipe'));
  const full = { ...fs, cpSync: () => { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } };
  const failed = M.copyUserData({ appData, userData, fsImpl: full, log: quiet });
  assert.deepEqual([failed.copied, failed.retry], [false, true]);
  assert.match(failed.reason, /ENOSPC/);
  assert.equal(M.readState(userData).status, 'retry');
  assert.deepEqual(fs.readdirSync(appData).sort(), ['Plexiform', 'claude-buddy'], 'the half copy went');
  const again = M.copyUserData({ appData, userData, log: quiet });
  assert.equal(again.copied, true);
  assert.equal(fs.readFileSync(path.join(userData, 'locked.json'), 'utf8'), 'x');
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

test('hooks: Buddy\'s entries at the old .app path now run the new app; foreign hooks, other keys and the deny rule stay; a .pre-plexiform copy of each', () => {
  const { home, dataDir, settingsFile, before, geminiText } = oldHooksProfile();
  const newRt = runtimeAt(NEW_APP, dataDir);
  const r = M.rewriteHooks({ home, runtime: newRt, askFromWidget: true, mcpEntry: mcpEntryAt(NEW_APP), log: quiet });
  assert.deepEqual(r.map((x) => [x.id, x.changed, x.error]), [['wrapper', true, undefined], ['claude', true, undefined], ['cursor', true, undefined], ['codex', true, undefined], ['mcp', true, undefined]]);

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
  assert.equal(fs.readFileSync(`${settingsFile}.pre-plexiform`, 'utf8'), before, 'the backup is the file as it was');

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
  assert.deepEqual(again, [], 'nothing names the old app any more');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), settled);
  assert.equal(fs.readFileSync(`${settingsFile}.pre-plexiform`, 'utf8'), before);
  assert.ok(!fs.readdirSync(path.dirname(settingsFile)).some((n) => n.startsWith('settings.json.pre-plexiform-')), 'no second copy when nothing changes');
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

test('hooks: entries and an MCP entry that run a dev checkout (not the old app) are left alone; only the old app\'s are re-pointed', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const devRt = Runtime.make({ execPath: '/usr/local/bin/node', platform: 'darwin', hooksDir: '/Users/me/dev/ctl/hooks', dataDir });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(Claude.apply({ model: 'opus' }, devRt, { home }), null, 2));
  const devMcp = { command: 'node', args: ['/Users/me/dev/ctl/mcp-server.js'] };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'claude-buddy': devMcp } }));
  const before = { s: fs.readFileSync(settingsFile, 'utf8'), m: fs.readFileSync(path.join(home, '.claude.json'), 'utf8') };
  assert.ok(commandsOf(JSON.parse(before.s)).some((c) => Claude.isOurs(c)), 'the fixture holds Buddy entries');
  const logs = [];
  const r = M.rewriteHooks({ home, runtime: runtimeAt(NEW_APP, dataDir), mcpEntry: mcpEntryAt(NEW_APP), log: (m) => logs.push(m) });
  assert.deepEqual(r, []);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), before.s);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), before.m);
  assert.ok(!fs.existsSync(`${settingsFile}.buddy-backup`) && !fs.existsSync(`${settingsFile}.pre-plexiform`));
  assert.ok(logs.some((m) => /claude: left alone .*set-status\.js.* \(runs a Plexiform script name from somewhere other than the old app/.test(m)));

  // The old Windows exe counts as the old app, in the MCP entry as in hooks.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'claude-buddy': { command: 'C:\\Users\\me\\AppData\\Local\\Programs\\claude-buddy\\Claude Buddy.exe', args: ['C:/Users/me/AppData/Local/Programs/claude-buddy/resources/app.asar/mcp-server.js'] } } }));
  assert.deepEqual(M.rewriteHooks({ home, runtime: runtimeAt(NEW_APP, dataDir), mcpEntry: mcpEntryAt(NEW_APP), log: quiet }).map((x) => [x.id, x.changed]), [['mcp', true]]);
  fs.rmSync(home, { recursive: true, force: true });
});

// ── the old app ─────────────────────────────────────────────────────────────

test('old instance: the old main process is asked to quit (SIGTERM) and waited for; helpers, this app, a copy outside Applications and other OSes are not', () => {
  const procs = [
    { pid: 111, command: '/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy' },
    { pid: 112, command: '/Applications/Claude Buddy.app/Contents/Frameworks/Claude Buddy Helper.app/Contents/MacOS/Claude Buddy Helper' },
    { pid: 113, command: '/Applications/Plexiform.app/Contents/MacOS/Plexiform' },
    { pid: 114, command: '/Users/me/Downloads/Claude Buddy.app/Contents/MacOS/Claude Buddy' },
  ];
  const kills = [];
  const live = new Set([111, 114]);
  let slept = 0;
  const { asked, running } = M.quitOldInstance({
    platform: 'darwin', home: '/Users/me', listProcesses: () => procs, self: 113, log: quiet,
    kill: (pid, sig) => kills.push([pid, sig]),
    isAlive: (pid) => live.has(pid),
    sleep: () => { slept += 1; if (slept === 3) live.clear(); },
  });
  assert.deepEqual(asked, [111]);
  assert.deepEqual(running, []);
  assert.deepEqual(kills, [[111, 'SIGTERM']]);
  assert.equal(slept, 3);

  const stuck = [];
  const r = M.quitOldInstance({ platform: 'darwin', listProcesses: () => procs.slice(0, 1), kill: () => {}, isAlive: () => true, sleep: () => {}, waitMs: 300, log: (m) => stuck.push(m) });
  assert.match(stuck.at(-1), /still running/);
  assert.deepEqual(r, { asked: [111], running: [111] }, 'never SIGKILLed: it is reported as still running');

  const debKills = [];
  M.quitOldInstance({ platform: 'linux', listProcesses: () => [{ pid: 7, command: '/opt/Claude Buddy/plexiform --no-sandbox' }, { pid: 8, command: '/opt/Plexiform/plexiform' }, { pid: 9, command: '/opt/Claude Buddy/plexiform --type=renderer --enable-sandbox' }, { pid: 10, command: '/opt/Claude Buddy/plexiform --type=zygote' }], kill: (pid) => debKills.push(pid), isAlive: () => false, log: quiet });
  assert.deepEqual(debKills, [7]);

  for (const platform of ['freebsd']) {
    let listed = false;
    assert.deepEqual(M.quitOldInstance({ platform, listProcesses: () => { listed = true; return procs; }, kill: () => assert.fail('no kill'), log: quiet }), { asked: [], running: [] });
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

  // Configs that still name the old app are named in the dialog and the log.
  dialogs.length = 0;
  there.add('/Applications/Claude Buddy.app');
  const logs = [];
  await M.offerRemoveOldApp({ platform: 'darwin', home, name: 'Plexiform', stillUsedBy: ['/Users/fixture/.claude/settings.json'], exists: (p) => p === '/Applications/Claude Buddy.app', log: (m) => logs.push(m), showDialog: async (o) => { dialogs.push(o); return { response: 1 }; }, trashItem: async () => {} });
  assert.match(dialogs[0].detail, /would stop working if it goes: \/Users\/fixture\/\.claude\/settings\.json\./);
  assert.match(logs[0], /still naming the old app: \/Users\/fixture\/\.claude\/settings\.json/);
  assert.doesNotMatch((await (async () => { dialogs.length = 0; await run(1); return dialogs[0].detail; })()), /would stop working/);
  there.delete('/Applications/Claude Buddy.app');

  // A Bin that refuses is reported, not thrown.
  there.add('/Users/fixture/Applications/Claude Buddy.app');
  const r = await M.offerRemoveOldApp({ platform: 'darwin', home, name: 'Plexiform', exists, log: quiet, showDialog: async () => ({ response: 0 }), trashItem: async () => { throw new Error('nope'); } });
  assert.deepEqual(r, [{ path: '/Users/fixture/Applications/Claude Buddy.app', removed: false, error: 'nope' }]);
});

test('old app: agent configs that still name the old .app are found (foreign entries this app does not re-point)', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '"/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy" --lights' }] }] } }));
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), '{"theme":"dark"}');
  assert.deepEqual(M.findOldReferences({ home }), [path.join(home, '.claude', 'settings.json')]);
  // Re-pointing leaves it: it is not Buddy's entry.
  M.rewriteHooks({ home, runtime: runtimeAt(NEW_APP, dataDir), log: quiet });
  assert.deepEqual(M.findOldReferences({ home }), [path.join(home, '.claude', 'settings.json')]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('login item: turned on for the new app where the old one had set it up; the old Windows entry goes; Linux rewrites its own file', () => {
  const calls = [];
  const loginItem = (on) => ({ get: () => on, set: (v) => calls.push(['set', v]) });
  let oldItems = [];
  const app = { setLoginItemSettings: (o) => calls.push(['electron', o]), getLoginItemSettings: (o) => { calls.push(['read', o]); return { openAtLogin: false, launchItems: oldItems }; } };
  M.moveLoginItem({ platform: 'darwin', app, loginItem: loginItem(false), autoLaunchConfigured: true });
  assert.deepEqual(calls.splice(0), [['set', true]]);
  M.moveLoginItem({ platform: 'darwin', app, loginItem: loginItem(false), autoLaunchConfigured: false });
  assert.deepEqual(calls.splice(0), []);
  // Windows: the old Run entry decides, not the first-run marker.
  const execPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\claude-buddy\\Plexiform.exe';
  const read = ['read', { path: 'C:\\Users\\me\\AppData\\Local\\Programs\\claude-buddy\\Claude Buddy.exe' }];
  const removeOld = ['electron', { openAtLogin: false, name: 'com.callumbaker.claude-buddy' }];
  M.moveLoginItem({ platform: 'win32', app, loginItem: loginItem(false), autoLaunchConfigured: true, execPath });
  assert.deepEqual(calls.splice(0), [read, removeOld], 'marker set but no old Run entry: not turned on');
  oldItems = [{ name: 'com.callumbaker.claude-buddy', path: read[1].path, args: [], scope: 'user', enabled: true }];
  M.moveLoginItem({ platform: 'win32', app, loginItem: loginItem(false), autoLaunchConfigured: false, execPath });
  assert.deepEqual(calls.splice(0), [read, ['set', true], removeOld]);
  oldItems = [{ name: 'com.callumbaker.claude-buddy', path: read[1].path, args: [], scope: 'user', enabled: false }, { name: 'something-else', enabled: true }];
  M.moveLoginItem({ platform: 'win32', app, loginItem: loginItem(false), autoLaunchConfigured: true, execPath });
  assert.deepEqual(calls.splice(0), [read, removeOld], 'turned off in Task Manager stays off');
  M.moveLoginItem({ platform: 'linux', app, loginItem: loginItem(true), autoLaunchConfigured: true });
  assert.deepEqual(calls.splice(0), [['set', true]]);
  M.moveLoginItem({ platform: 'linux', app, loginItem: loginItem(false), autoLaunchConfigured: true });
  assert.deepEqual(calls.splice(0), []);
});

test('approval secret: one sealed under the old app\'s key is set aside as .pre-rename so a new one is made; an unsealed one stays', () => {
  const home = tmpHome();
  const file = path.join(home, 'approval-secret.json');
  const logs = [];
  assert.equal(M.setAsideSealedSecret({ file, log: quiet }), false, 'none there');
  fs.writeFileSync(file, JSON.stringify({ v: 1, sealed: true, data: 'b2xk' }));
  assert.equal(M.setAsideSealedSecret({ file, log: (m) => logs.push(m) }), true);
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.pre-rename`, 'utf8')), { v: 1, sealed: true, data: 'b2xk' });
  assert.match(logs[0], /set aside/);
  // nudge-secret makes a new one where there is none.
  const make = require('../src/nudge-secret.js').createSecretStore({ file, safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal(make().length, 32);
  assert.equal(M.setAsideSealedSecret({ file, log: quiet }), false, 'an unsealed secret opens anywhere: left');
  assert.ok(fs.existsSync(file));
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /if \(copied\) RenameMigration\.setAsideSealedSecret\(\{ file: path\.join\(ROOT_DIR, 'approval-secret\.json'\) \}\);/);
  assert.ok(src.indexOf('setAsideSealedSecret(') < src.indexOf("createSecretStore({"), 'before the store is made');
  fs.rmSync(home, { recursive: true, force: true });
});

test('follow-up: each pending step runs once, in order; a step that returns false or throws stays pending', async () => {
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  M.copyUserData({ appData, userData, log: quiet });
  const ran = [];
  const logs = [];
  let loginWorks = false;
  const steps = {
    hooks: () => { ran.push('hooks'); },
    login: () => { ran.push('login'); if (!loginWorks) throw new Error('boom'); },
    'remove-old-app': async () => { ran.push('remove-old-app'); },
  };
  const p = M.runFollowUp({ userData, steps, log: (m) => logs.push(m) });
  assert.deepEqual(ran.slice(0, 2), ['hooks', 'login'], 'the synchronous steps are done before it returns');
  await p;
  assert.deepEqual(ran, ['hooks', 'login', 'remove-old-app']);
  assert.deepEqual(M.pending(userData), ['login'], 'a step that threw is not marked done');
  assert.match(logs[0], /login failed, trying again next launch: boom/);
  ran.length = 0;
  loginWorks = true;
  await M.runFollowUp({ userData, steps, log: quiet });
  assert.deepEqual(ran, ['login']);
  assert.deepEqual(M.pending(userData), []);
  await M.runFollowUp({ userData, steps, log: quiet });
  assert.deepEqual(ran, ['login']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('follow-up: a translocated launch (hooks stay pending) is never offered Remove; the next proper launch is', async () => {
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  M.copyUserData({ appData, userData, log: quiet });
  let translocated = true;
  const dialogs = [];
  const logs = [];
  const steps = {
    hooks: () => (translocated ? false : undefined),
    login: () => {},
    // as main.js: Remove is never offered from a translocated copy
    'remove-old-app': () => !translocated && M.offerRemoveOldApp({ platform: 'darwin', home, name: 'Plexiform', exists: () => true, log: quiet, showDialog: async (o) => { dialogs.push(o); return { response: 0 }; }, trashItem: async () => {} }),
  };
  await M.runFollowUp({ userData, steps, log: (m) => logs.push(m) });
  assert.deepEqual(dialogs, []);
  assert.deepEqual(M.pending(userData), ['hooks', 'remove-old-app']);
  assert.ok(logs.some((m) => /not offering to remove the old app while the hooks still point at it/.test(m)));
  // Even were hooks done, a translocated launch keeps remove-old-app pending.
  M.markDone(userData, 'hooks');
  await M.runFollowUp({ userData, steps, log: quiet });
  assert.deepEqual(dialogs, []);
  assert.deepEqual(M.pending(userData), ['remove-old-app']);
  translocated = false;
  await M.runFollowUp({ userData, steps, log: quiet });
  assert.equal(dialogs.length, 2, 'both old app paths offered');
  assert.deepEqual(M.pending(userData), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('old app: still installed (so its Open at Login can start it) is checked per platform; main.js asks it to quit on every launch while it is', () => {
  const there = new Set(['/Users/fixture/Applications/Claude Buddy.app']);
  const exists = (p) => there.has(p);
  assert.equal(M.oldAppInstalled({ platform: 'darwin', home: '/Users/fixture', exists }), true);
  assert.equal(M.oldAppInstalled({ platform: 'darwin', home: '/Users/other', exists }), false);
  assert.equal(M.oldAppInstalled({ platform: 'linux', home: '/home/x', exists: (p) => p === '/opt/Claude Buddy' }), true);
  assert.equal(M.oldAppInstalled({ platform: 'linux', home: '/home/x', exists }), false);
  assert.equal(M.oldAppInstalled({ platform: 'win32', home: 'C:/Users/x', exists: () => true }), false);
  assert.ok(!M.STEPS.includes('quit-old'), 'quitting the old app is not a once-only step');

  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const quit = src.slice(src.indexOf('function quitOldAppIfInstalled()'), src.indexOf('function renameFollowUp()'));
  assert.match(quit, /if \(!RenameMigration\.oldAppInstalled\(\{ platform: process\.platform, home: os\.homedir\(\) \}\)\) return;\s+const \{ asked \} = RenameMigration\.quitOldInstance\(/);
  assert.match(quit, /if \(asked\.length && Notification\.isSupported\(\)\) new Notification\(/, 'and says why');
  const fn = src.slice(src.indexOf('function renameFollowUp()'), src.indexOf('return RenameMigration.runFollowUp('));
  assert.match(fn, /quitOldAppIfInstalled\(\);/);
  assert.match(src, /'remove-old-app': \(\) => !EPHEMERAL && RenameMigration\.offerRemoveOldApp\(/);
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
  assert.match(src, /copyUserData\(\{\s+appData: app\.getPath\('appData'\),\s+userData: path\.join\(app\.getPath\('appData'\), app\.getName\(\)\),\s+quitOld: \(\) => RenameMigration\.quitOldInstance\(/, 'the target is worked out, not getPath(userData), which would create it; the old app is asked to quit before the copy');
  // The follow-up runs before the startup hook check, and never for a smoke run.
  const follow = src.indexOf('if (RENAME_MIGRATES && gotLock) {\n    renameFollowUp()');
  assert.ok(follow > 0);
  assert.ok(follow > src.indexOf('if (smokeReport) {') && follow < src.indexOf('if (AUTO_INSTALL_HOOKS && !areHooksInstalled()) installHooks();'));
});

// ── round 2: races, retries, never deleting ────────────────────────────────


test('userData: a second launch that migrates and starts running during this one\'s slow copy is left alone (H1)', () => {
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  let other = null;
  const slow = { ...fs, cpSync: (a, b, o) => {
    fs.cpSync(a, b, o);
    other = M.copyUserData({ appData, userData, pid: process.ppid, log: quiet });
    fs.writeFileSync(path.join(userData, 'live-data'), 'written by the running instance');
    fs.symlinkSync(`host-${process.ppid}`, path.join(userData, 'SingletonLock'));
  } };
  const logs = [];
  const r = M.copyUserData({ appData, userData, fsImpl: slow, log: (m) => logs.push(m) });
  assert.equal(other.copied, true);
  assert.equal(r.copied, false);
  assert.match(r.reason, /already migrated/);
  assert.equal(fs.readFileSync(path.join(userData, 'live-data'), 'utf8'), 'written by the running instance');
  assert.ok(isLink(path.join(userData, 'SingletonLock')), 'its lock is untouched');
  assert.deepEqual(fs.readdirSync(appData).sort(), ['Plexiform', 'claude-buddy'], 'no temp copy left, nothing moved aside');
  fs.rmSync(home, { recursive: true, force: true });
});

test('userData: a new folder a live instance holds (SingletonLock names a running pid) is never moved, before or after the copy', () => {
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  fs.mkdirSync(userData, { recursive: true });
  fs.symlinkSync(`host-${process.pid}`, path.join(userData, 'SingletonLock'));
  const r = M.copyUserData({ appData, userData, log: quiet });
  assert.equal(r.copied, false);
  assert.match(r.reason, /already running on it \(pid \d+\)/);
  assert.ok(isLink(path.join(userData, 'SingletonLock')));

  // Fresh when the copy starts, taken by another launch before the swap.
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData);
  const slow = { ...fs, cpSync: (a, b, o) => { fs.cpSync(a, b, o); fs.symlinkSync(`host-${process.pid}`, path.join(userData, 'SingletonLock')); fs.writeFileSync(path.join(userData, 'Local State'), 'theirs'); } };
  const r2 = M.copyUserData({ appData, userData, fsImpl: slow, log: quiet });
  assert.equal(r2.copied, false);
  assert.equal(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'), 'theirs');
  assert.deepEqual(fs.readdirSync(appData).sort(), ['Plexiform', 'claude-buddy']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('userData: a retry folder holding data from the launches that ran on it is kept as Plexiform.pre-migration-<time>, never deleted (M-1, 70 #6)', () => {
  const home = tmpHome();
  const { appData, old, userData } = oldProfile(home);
  const r1 = M.copyUserData({ appData, userData, quitOld: () => false, log: quiet, now: () => new Date('2026-10-01T09:00:00Z') });
  assert.equal(r1.retry, true);
  assert.equal(M.readState(userData).attempts, 1);
  fs.writeFileSync(path.join(userData, 'weeks-of-board-data'), 'x');
  const logs = [];
  const r2 = M.copyUserData({ appData, userData, log: (m) => logs.push(m), now: () => new Date('2026-10-02T10:11:12.345Z') });
  assert.equal(r2.copied, true);
  assert.equal(fs.readFileSync(path.join(userData, 'Preferences'), 'utf8'), fs.readFileSync(path.join(old, 'Preferences'), 'utf8'));
  const kept = aside(appData);
  assert.deepEqual(kept, ['Plexiform.pre-migration-2026-10-02T10-11-12-345Z']);
  assert.equal(fs.readFileSync(path.join(appData, kept[0], 'weeks-of-board-data'), 'utf8'), 'x');
  assert.equal(r2.keptAside, path.join(appData, kept[0]));
  assert.ok(logs.some((m) => /kept .*Plexiform\.pre-migration-/.test(m)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('userData: retries stop after three tries; the folder is kept as it is and the log says why (M-1)', () => {
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  const logs = [];
  const tryOnce = () => M.copyUserData({ appData, userData, quitOld: () => false, log: (m) => logs.push(m) });
  assert.equal(tryOnce().retry, true);
  assert.equal(tryOnce().retry, true);
  assert.equal(M.readState(userData).attempts, 2);
  const third = tryOnce();
  assert.deepEqual([third.copied, third.retry, third.gaveUp], [false, false, true]);
  assert.equal(M.readState(userData).status, 'kept');
  assert.match(logs.at(-1), /stopped trying after 3 tries/);
  let asked = 0;
  const fourth = M.copyUserData({ appData, userData, quitOld: () => { asked += 1; return true; }, log: (m) => logs.push(m) });
  assert.equal(fourth.copied, false);
  assert.equal(asked, 0, 'no more tries');
  assert.match(fourth.reason, /stopped trying/);
  assert.deepEqual(M.pending(userData), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('userData: the folder moved aside comes back when the copy cannot take its place', () => {
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  M.copyUserData({ appData, userData, quitOld: () => false, log: quiet });
  fs.writeFileSync(path.join(userData, 'mine'), 'keep me');
  const failing = { ...fs, renameSync: (a, b) => { if (b === userData && a.includes('.migrating-')) { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; } return fs.renameSync(a, b); } };
  const r = M.copyUserData({ appData, userData, fsImpl: failing, log: quiet });
  assert.deepEqual([r.copied, r.retry], [false, true]);
  assert.equal(fs.readFileSync(path.join(userData, 'mine'), 'utf8'), 'keep me', 'back in place');
  assert.equal(M.readState(userData).status, 'retry');
  assert.deepEqual(fs.readdirSync(appData).sort(), ['Plexiform', 'claude-buddy'], 'no temp or aside folder left');
  fs.rmSync(home, { recursive: true, force: true });
});

test('userData: a failed tidy after the swap is only logged; the copy still counts (L-4)', () => {
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  fs.mkdirSync(userData);
  const noTidy = { ...fs, rmdirSync: () => { throw new Error('EBUSY'); } };
  const logs = [];
  const r = M.copyUserData({ appData, userData, fsImpl: noTidy, log: (m) => logs.push(m) });
  assert.equal(r.copied, true);
  assert.deepEqual(M.readState(userData).pending, M.STEPS);
  fs.rmSync(home, { recursive: true, force: true });
});

test('old instance: macOS matches only /Applications and ~/Applications, never a dev build (70 #8)', () => {
  const home = '/Users/me';
  const procs = [
    { pid: 1, command: '/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy' },
    { pid: 2, command: '/Users/me/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy' },
    { pid: 3, command: '/Users/me/dev/ctl/dist/mac-arm64/Claude Buddy.app/Contents/MacOS/Claude Buddy' },
    { pid: 4, command: '/Users/other/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy' },
  ];
  const kills = [];
  M.quitOldInstance({ platform: 'darwin', home, listProcesses: () => procs, kill: (pid) => kills.push(pid), isAlive: () => false, log: quiet });
  assert.deepEqual(kills, [1, 2]);
});

test('old instance: Windows lists with tasklist and asks Claude Buddy.exe to quit; one that would not is still running (M-2)', () => {
  const csv = '"Claude Buddy.exe","4242","Console","1","120,000 K"\r\n"Claude Buddy.exe","4243","Console","1","40,000 K"\r\n"Plexiform.exe","77","Console","1","1 K"\r\n';
  assert.deepEqual(M.parseTasklist(csv), [{ pid: 4242, command: 'Claude Buddy.exe' }, { pid: 4243, command: 'Claude Buddy.exe' }, { pid: 77, command: 'Plexiform.exe' }]);
  assert.deepEqual(M.parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n'), []);
  const asked = [];
  const live = new Set([4242, 4243]);
  const r = M.quitOldInstance({ platform: 'win32', home: 'C:\\Users\\me', listProcesses: () => M.parseTasklist(csv), kill: (pid) => { asked.push(pid); if (pid === 4243) throw new Error('could only be terminated forcefully'); live.delete(pid); }, isAlive: (p) => live.has(p), sleep: () => {}, waitMs: 200, log: quiet });
  assert.deepEqual(asked, [4242, 4243]);
  assert.deepEqual(r.running, [4243], 'one that refused counts as running, so nothing is copied mid-write');
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  const c = M.copyUserData({ appData, userData, quitOld: () => r.running.length === 0, log: quiet });
  assert.equal(c.retry, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('old instance: when ps fails, a live SingletonLock in the old folder counts as running; a stale one does not (L-1)', () => {
  const home = tmpHome();
  const { old } = oldProfile(home);
  const broken = () => { throw new Error('ps: not found'); };
  const kills = [];
  const stale = M.quitOldInstance({ platform: 'darwin', home, listProcesses: broken, oldUserData: old, kill: (p) => kills.push(p), isAlive: () => false, log: quiet });
  assert.deepEqual(stale.running, []);
  fs.rmSync(path.join(old, 'SingletonLock'));
  fs.symlinkSync(`host-${process.pid}`, path.join(old, 'SingletonLock'));
  const logs = [];
  const r = M.quitOldInstance({ platform: 'darwin', home, listProcesses: broken, oldUserData: old, kill: (p) => kills.push(p), log: (m) => logs.push(m) });
  assert.deepEqual(r.running, [process.pid]);
  assert.deepEqual(kills, [], 'a pid from a lock file is never signalled');
  assert.ok(logs.some((m) => /SingletonLock/.test(m)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: only the old app\'s entries are re-pointed; a look-alike set-status.js of the person\'s own and a dev checkout\'s entries stay (70 #5)', () => {
  const { home, dataDir, settingsFile } = oldHooksProfile();
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const mine = 'node "/Users/me/scripts/set-status.js" stop';
  const dev = 'node "/Users/me/dev/ctl/hooks/set-status.js" tool-use';
  s.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: mine }] });
  s.hooks.PreToolUse.push({ matcher: '', hooks: [{ type: 'command', command: dev }] });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  const cursorFile = path.join(home, '.cursor', 'hooks.json');
  const c = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
  const devCursor = 'node "/Users/me/dev/ctl/hooks/emit.js" --adapter cursor stop';
  c.hooks.stop.push({ command: devCursor });
  fs.writeFileSync(cursorFile, JSON.stringify(c));
  const r = M.rewriteHooks({ home, runtime: runtimeAt(NEW_APP, dataDir), askFromWidget: true, log: quiet });
  assert.ok(r.every((x) => !x.error), JSON.stringify(r));
  const cmds = commandsOf(JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
  assert.ok(cmds.includes(mine), 'the person\'s own set-status.js stays');
  assert.ok(cmds.includes(dev), 'the dev checkout\'s entry stays');
  assert.ok(!cmds.some((x) => x.includes('Claude Buddy.app')));
  assert.equal(cmds.filter((x) => x.includes(NEW_APP)).length, Claude.HOOK_EVENTS.length + Claude.OPTIONAL_EVENTS.length, 'one current set');
  const cursorCmds = Object.values(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).hooks).flatMap((l) => l.map((h) => h.command));
  assert.ok(cursorCmds.includes(devCursor));
  assert.equal(Claude.isInstalled({ home, runtime: runtimeAt(NEW_APP, dataDir), askFromWidget: true }), true, 'so the startup install never runs its broad strip');
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: a dev checkout\'s Codex notify is left alone; an AppImage\'s hooks-<old version> entries are re-pointed, the current version\'s are not (L-6)', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const devLine = 'notify = ["node", "/Users/me/dev/ctl/hooks/emit.js", "--adapter", "codex"]';
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `${devLine}\nmodel = "o3"\n`);
  const linuxRt = (ver) => Runtime.make({ execPath: '/home/me/Apps/Plexiform.AppImage', platform: 'linux', hooksDir: path.join(dataDir, `hooks-${ver}`, 'hooks'), dataDir });
  assert.deepEqual(M.rewriteHooks({ home, runtime: linuxRt('2.0.0'), log: quiet }), []);
  assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /\/Users\/me\/dev\/ctl/);

  const oldAppImage = Runtime.make({ execPath: '/home/me/Apps/Claude-Buddy-1.9.0.AppImage', platform: 'linux', hooksDir: path.join(dataDir, 'hooks-1.9.0', 'hooks'), dataDir });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(Claude.apply({}, oldAppImage, { home }), null, 2));
  const r = M.rewriteHooks({ home, runtime: linuxRt('2.0.0'), log: quiet });
  assert.deepEqual(r.map((x) => [x.id, x.changed]), [['claude', true]]);
  const cmds = commandsOf(JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
  assert.ok(cmds.every((x) => x.includes('hooks-2.0.0')), cmds[0]);
  assert.deepEqual(M.rewriteHooks({ home, runtime: linuxRt('2.0.0'), log: quiet }), [], 'the current version\'s entries are not old');
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: a fresh .pre-plexiform copy of every file about to change, even when a .buddy-backup exists; never overwritten (70 #3)', () => {
  const { home, dataDir, settingsFile, before } = oldHooksProfile();
  fs.writeFileSync(`${settingsFile}.buddy-backup`, 'an old backup');
  const files = { settings: settingsFile, cursor: path.join(home, '.cursor', 'hooks.json'), codex: path.join(home, '.codex', 'config.toml'), mcp: path.join(home, '.claude.json') };
  const was = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
  assert.equal(was.settings, before);
  const r = M.rewriteHooks({ home, runtime: runtimeAt(NEW_APP, dataDir), askFromWidget: true, mcpEntry: mcpEntryAt(NEW_APP), log: quiet, now: () => new Date('2026-10-01T09:00:00Z') });
  for (const [k, f] of Object.entries(files)) {
    assert.equal(fs.readFileSync(`${f}.pre-plexiform`, 'utf8'), was[k], `${k} backed up as it was`);
    assert.equal(r.find((x) => x.file === f).backup, `${f}.pre-plexiform`);
  }
  assert.equal(fs.readFileSync(`${settingsFile}.buddy-backup`, 'utf8'), 'an old backup', 'the one-time backup is not touched');
  assert.ok(!fs.existsSync(path.join(home, '.gemini', 'settings.json.pre-plexiform')), 'nothing changed there, no copy');
  // A second migration (an old entry put back) keeps the first copy and makes a new one.
  fs.writeFileSync(settingsFile, before);
  M.rewriteHooks({ home, runtime: runtimeAt(NEW_APP, dataDir), askFromWidget: true, log: quiet, now: () => new Date('2026-10-02T09:00:00Z') });
  assert.equal(fs.readFileSync(`${settingsFile}.pre-plexiform`, 'utf8'), was.settings);
  assert.equal(fs.readFileSync(`${settingsFile}.pre-plexiform-2026-10-02T09-00-00-000Z`, 'utf8'), before);
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: Codex\'s config.toml is written atomically through a symlink, keeping its mode (70 #3)', () => {
  const { home, dataDir } = oldHooksProfile();
  const real = path.join(home, 'dotfiles', 'codex.toml');
  const link = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.renameSync(link, real);
  fs.chmodSync(real, 0o640);
  fs.symlinkSync(real, link);
  const inode = fs.statSync(real).ino;
  M.rewriteHooks({ home, runtime: runtimeAt(NEW_APP, dataDir), log: quiet });
  assert.ok(isLink(link), 'still a symlink');
  assert.equal(fs.statSync(real).mode & 0o777, 0o640);
  assert.notEqual(fs.statSync(real).ino, inode, 'replaced by rename, not written in place');
  assert.match(fs.readFileSync(real, 'utf8'), /Plexiform\.app\/Contents\/Resources\/hooks\/emit\.js/);
  assert.deepEqual(fs.readdirSync(path.dirname(real)).filter((n) => n.includes('tmp')), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: a settings file another program writes mid-rewrite is read again and both changes kept (70 #3)', () => {
  const { home, dataDir, settingsFile } = oldHooksProfile();
  let raced = false;
  // Claude Code writes its settings after this read them, before the swap.
  const racing = { ...fs, writeFileSync: (f, ...rest) => {
    if (!raced && String(f).startsWith(`${settingsFile}.buddy-tmp.`)) {
      raced = true;
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      fs.writeFileSync(settingsFile, JSON.stringify({ ...s, theirs: true }, null, 2));
      const t = new Date(Date.now() + 5000);
      fs.utimesSync(settingsFile, t, t);
    }
    return fs.writeFileSync(f, ...rest);
  } };
  M.rewriteHooks({ home, runtime: runtimeAt(NEW_APP, dataDir), askFromWidget: true, fsImpl: racing, log: quiet });
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(s.theirs, true, 'their write survived');
  assert.ok(!commandsOf(s).some((c) => c.includes('Claude Buddy.app')), 'and ours went in on the retry');
  const f = path.join(home, 'x.json');
  fs.writeFileSync(f, '{}');
  const readAt = fs.statSync(f).mtimeMs;
  const t = new Date(Date.now() + 9000);
  fs.utimesSync(f, t, t);
  assert.equal(Runtime.writeJsonConfig(f, { a: 1 }, fs, readAt), false, 'changed since it was read: not written');
  assert.equal(fs.readFileSync(f, 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.includes('buddy-tmp')), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('follow-up: a hook rewrite that reports an error keeps hooks pending, so Remove is not offered; the next launch retries (70 #1)', async () => {
  const home = tmpHome();
  const { appData, userData } = oldProfile(home);
  M.copyUserData({ appData, userData, log: quiet });
  const hooksHome = oldHooksProfile();
  fs.writeFileSync(hooksHome.settingsFile, '{ broken');
  const dialogs = [];
  const steps = {
    // as main.js
    hooks: () => M.rewriteHooks({ home: hooksHome.home, runtime: runtimeAt(NEW_APP, hooksHome.dataDir), log: quiet }).every((r) => !r.error),
    login: () => {},
    'remove-old-app': () => M.offerRemoveOldApp({ platform: 'darwin', home, name: 'Plexiform', exists: () => true, log: quiet, showDialog: async (o) => { dialogs.push(o); return { response: 1 }; }, trashItem: async () => {} }),
  };
  await M.runFollowUp({ userData, steps, log: quiet });
  assert.deepEqual(M.pending(userData), ['hooks', 'remove-old-app']);
  assert.deepEqual(dialogs, [], 'Remove is not offered');
  fs.writeFileSync(hooksHome.settingsFile, hooksHome.before);
  await M.runFollowUp({ userData, steps, log: quiet });
  assert.deepEqual(M.pending(userData), []);
  assert.equal(dialogs.length, 2, 'offered once hooks are done (both old app paths)');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /hooks: \(\) => \(AUTO_INSTALL_HOOKS \? RenameMigration\.rewriteHooks\(\{[^}]*\}\)\.every\(\(r\) => !r\.error\) : false\)/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(hooksHome.home, { recursive: true, force: true });
});

test('main.js: an app run from a disk image (/Volumes) or a translocated copy installs no hooks and offers no Remove (70 #2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /const EPHEMERAL = RenameMigration\.EPHEMERAL_PATH\.test\(process\.execPath\);/, 'EPHEMERAL is defined from the exec path');
  const re = M.EPHEMERAL_PATH;
  for (const p of ['/Volumes/Plexiform/Plexiform.app/Contents/MacOS/Plexiform', '/private/var/folders/x/T/AppTranslocation/ABC/d/Plexiform.app/Contents/MacOS/Plexiform']) assert.ok(re.test(p), p);
  for (const p of ['/Applications/Plexiform.app/Contents/MacOS/Plexiform', '/Users/me/Applications/Plexiform.app/Contents/MacOS/Plexiform', '/Users/me/Volumes/Plexiform.app/x']) assert.ok(!re.test(p), p);
  assert.match(src, /const AUTO_INSTALL_HOOKS = !IS_DEV_RUN && !EPHEMERAL;/);
  assert.match(src, /'remove-old-app': \(\) => !EPHEMERAL && RenameMigration\.offerRemoveOldApp\(/);
  assert.doesNotMatch(src, /TRANSLOCATED/);
});

test('old app: findOldReferences looks at hook commands, mcpServers and the hook wrapper, not at unrelated text (70 #4, L-7)', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const rt = runtimeAt(NEW_APP, dataDir);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { '/Users/me/Claude Buddy.app notes': {} }, mcpServers: {} }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { NOTE: 'moved from /Applications/Claude Buddy.app/' } }));
  assert.deepEqual(M.findOldReferences({ home, runtime: rt }), []);
  fs.mkdirSync(path.join(dataDir, 'bin'), { recursive: true });
  fs.writeFileSync(Runtime.wrapperPath(rt), Runtime.wrapperText(runtimeAt(OLD_APP, dataDir)));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { mine: { command: '/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy', args: [] } } }));
  assert.deepEqual(M.findOldReferences({ home, runtime: rt }), [path.join(home, '.claude.json'), Runtime.wrapperPath(rt)]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('login item: moveLoginItem says whether it turned Open at Login on, so the app can say so (70 #7)', () => {
  const loginItem = (on) => ({ get: () => on, set: () => {} });
  assert.equal(M.moveLoginItem({ platform: 'darwin', app: {}, loginItem: loginItem(false), autoLaunchConfigured: true }), true);
  assert.equal(M.moveLoginItem({ platform: 'darwin', app: {}, loginItem: loginItem(false), autoLaunchConfigured: false }), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /if \(RenameMigration\.moveLoginItem\(\{[^}]*\}\) && Notification\.isSupported\(\)\) new Notification\(/);
});

test('main.js: the quit check on later launches does not wait for the old app, and runs again after start-up and on wake (L-2, L-3)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('function quitOldAppIfInstalled()'), src.indexOf('function renameFollowUp()'));
  assert.match(fn, /waitMs: 0/);
  assert.match(src, /setTimeout\(quitOldAppIfInstalled, 30 \* 1000\)/);
  assert.match(src, /powerMonitor\.on\('resume', quitOldAppIfInstalled\)/);
  assert.match(src, /powerMonitor\.on\('unlock-screen', quitOldAppIfInstalled\)/);
});

// The rename's rewrite is a swap in place: diffing the file before and after
// shows only the changed command lines, whatever the file's own formatting.
const isOldApp = (c) => String(c || '').includes(OLD_APP);
const rewriteCtx = (dataDir, extra = {}) => ({ runtime: runtimeAt(NEW_APP, dataDir), askFromWidget: true, home: path.dirname(dataDir), isOld: isOldApp, ...extra });
const changedLines = (a, b) => {
  const A = a.split('\n');
  const B = b.split('\n');
  assert.equal(A.length, B.length, 'same number of lines');
  return A.map((l, i) => (l === B[i] ? null : [l, B[i]])).filter(Boolean);
};
const isCommandSwap = ([was, now]) => was.includes(OLD_APP) && now.includes(NEW_APP) && was.replace(/^\s*/, '').startsWith('"command": ') && was.match(/^\s*/)[0] === now.match(/^\s*/)[0];

// Old hooks, with a foreign hook before AND after ours in the same events, other events and top-level keys around them.
function interleavedSettings(dataDir) {
  const s = Claude.apply({ model: 'opus', permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say before' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard-before.sh' }] }] } }, runtimeAt(OLD_APP, dataDir), { askFromWidget: true, home: path.dirname(dataDir) });
  s.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: 'say after' }] });
  s.hooks.PreToolUse.push({ matcher: 'Edit', hooks: [{ type: 'command', command: 'guard-after.sh' }] });
  s.hooks = { CustomEvent: [{ matcher: '', hooks: [{ type: 'command', command: 'mine.sh' }] }], ...s.hooks };
  return { statusLine: { type: 'command', command: 'line.sh' }, ...s, zLast: true };
}

test('hooks: a re-point swaps each old entry in place; key, event and group order stay, and only the command lines differ', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const text = `${JSON.stringify(interleavedSettings(dataDir), null, 2)}\n`;
  const r = M.rewriteConfigText(Claude, text, rewriteCtx(dataDir));
  const diff = changedLines(text, r.after);
  assert.equal(diff.length, Claude.HOOK_EVENTS.length + Claude.OPTIONAL_EVENTS.length);
  assert.ok(diff.every(isCommandSwap), JSON.stringify(diff[0]));
  const a = JSON.parse(text);
  const b = JSON.parse(r.after);
  assert.deepEqual(Object.keys(b), Object.keys(a));
  assert.deepEqual(Object.keys(b.hooks), Object.keys(a.hooks));
  assert.deepEqual(b.hooks.Stop.map((g) => g.hooks[0].command.includes('Plexiform') ? 'ours' : g.hooks[0].command), ['say before', 'ours', 'say after']);
  assert.deepEqual(b.hooks.PreToolUse.map((g) => g.matcher), ['Bash', '', 'Edit']);
  assert.ok(r.after.endsWith('}\n'));
  assert.equal(M.rewriteConfigText(Claude, r.after, rewriteCtx(dataDir)).after, null, 'a second run changes nothing');
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: the final newline is kept when there was one and not added when there was none', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const body = JSON.stringify(interleavedSettings(dataDir), null, 2);
  for (const ctx of [rewriteCtx(dataDir), rewriteCtx(dataDir, { askFromWidget: false })]) {
    assert.ok(!M.rewriteConfigText(Claude, body, ctx).after.endsWith('\n'));
    assert.ok(/}\n$/.test(M.rewriteConfigText(Claude, `${body}\n`, ctx).after));
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: a CRLF file stays CRLF with only the command lines changed; tabs, 4 spaces and a BOM are kept', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const s = interleavedSettings(dataDir);
  const crlf = `${JSON.stringify(s, null, 2).replace(/\n/g, '\r\n')}\r\n`;
  const r = M.rewriteConfigText(Claude, crlf, rewriteCtx(dataDir));
  assert.equal(r.after.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
  assert.ok(r.after.endsWith('}\r\n'));
  assert.ok(changedLines(crlf, r.after).every(isCommandSwap));
  for (const indent of ['\t', 4]) {
    const text = `${JSON.stringify(s, null, indent)}\n`;
    const swap = M.rewriteConfigText(Claude, text, rewriteCtx(dataDir));
    assert.ok(changedLines(text, swap.after).every(isCommandSwap), `indent ${JSON.stringify(indent)}`);
    // Dropping the opt-in events (askFromWidget now off) rewrites the file in its own style.
    const drop = M.rewriteConfigText(Claude, text, rewriteCtx(dataDir, { askFromWidget: false })).after;
    assert.equal(drop, `${JSON.stringify(JSON.parse(drop), null, indent)}\n`, `indent ${JSON.stringify(indent)}`);
    const dropCrlf = M.rewriteConfigText(Claude, text.replace(/\n/g, '\r\n'), rewriteCtx(dataDir, { askFromWidget: false })).after;
    assert.equal(dropCrlf, drop.replace(/\n/g, '\r\n'));
  }
  const bom = `﻿${JSON.stringify(s, null, 2)}\n`;
  for (const ctx of [rewriteCtx(dataDir), rewriteCtx(dataDir, { askFromWidget: false })]) {
    const after = M.rewriteConfigText(Claude, bom, ctx).after;
    assert.ok(after.startsWith('﻿{'), 'the BOM stays');
    assert.equal(after.indexOf('﻿', 1), -1);
  }
  assert.ok(changedLines(bom, M.rewriteConfigText(Claude, bom, rewriteCtx(dataDir)).after).every(isCommandSwap));
  assert.deepEqual(Runtime.parseJsonConfig(bom, 'x'), s, 'a BOM file parses');
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: a hand-formatted file keeps every byte but the swapped commands', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const s = interleavedSettings(dataDir);
  const text = JSON.stringify(s, null, 2).replace('"allow": [\n      "Bash(npm test)"\n    ]', '"allow": ["Bash(npm test)"]').replace('"model": "opus"', '"model":   "opus"');
  assert.notEqual(text, JSON.stringify(s, null, 2));
  const after = M.rewriteConfigText(Claude, text, rewriteCtx(dataDir)).after;
  assert.ok(changedLines(text, after).every(isCommandSwap));
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: Cursor and Gemini entries are swapped in place too', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const oldRt = runtimeAt(OLD_APP, dataDir);
  const Cursor = Adapters.get('cursor');
  const Gemini = Adapters.get('gemini');
  const c = Cursor.apply({ version: 1, hooks: { stop: [{ command: 'before-stop' }] } }, oldRt);
  c.hooks.stop.push({ command: 'after-stop' });
  c.hooks = { afterShellExecution: [{ command: 'x' }], ...c.hooks };
  const cText = JSON.stringify(c, null, 2);
  const cAfter = M.rewriteConfigText(Cursor, cText, rewriteCtx(dataDir)).after;
  assert.equal(changedLines(cText, cAfter).length, Cursor.EVENTS.length);
  assert.ok(changedLines(cText, cAfter).every(isCommandSwap));
  assert.deepEqual(JSON.parse(cAfter).hooks.stop.map((h) => (h.command.includes(NEW_APP) ? 'ours' : h.command)), ['before-stop', 'ours', 'after-stop']);
  const g = Gemini.apply({ theme: 'dark', hooks: { AfterAgent: [{ matcher: '', hooks: [{ type: 'command', command: 'before' }] }] } }, oldRt);
  g.hooks.AfterAgent.push({ matcher: '', hooks: [{ type: 'command', command: 'after' }] });
  const gText = `${JSON.stringify(g, null, '\t')}\n`;
  const gAfter = M.rewriteConfigText(Gemini, gText, rewriteCtx(dataDir)).after;
  assert.equal(changedLines(gText, gAfter).length, Gemini.EVENTS.length);
  assert.ok(changedLines(gText, gAfter).every(isCommandSwap));
  fs.rmSync(home, { recursive: true, force: true });
});

test('hooks: Codex\'s notify swap touches only that line, keeping CRLF and the final newline (or its absence)', () => {
  const home = tmpHome();
  const dataDir = path.join(home, '.claude-traffic-light');
  const Codex = Adapters.get('codex');
  const old = Codex.notifyLine(runtimeAt(OLD_APP, dataDir));
  const now = Codex.notifyLine(runtimeAt(NEW_APP, dataDir));
  for (const eol of ['\n', '\r\n']) {
    for (const end of [eol, '']) {
      const text = ['model = "o3"', old, '', '[mcp_servers.x]', 'command = "npx"'].join(eol) + end;
      const after = M.rewriteConfigText(Codex, text, rewriteCtx(dataDir)).after;
      assert.equal(after, ['model = "o3"', now, '', '[mcp_servers.x]', 'command = "npx"'].join(eol) + end, JSON.stringify({ eol, end }));
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});
