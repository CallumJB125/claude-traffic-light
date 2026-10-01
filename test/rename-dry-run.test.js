// `--rename-dry-run` (src/rename-dry-run.js → planRename/formatPlan in
// src/rename-migration.js), against a fixture HOME with an old install in
// it. The process list and /Applications are stubs: nothing here looks at
// the real home, Application Support or /Applications.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('../src/rename-migration.js');
const DryRun = require('../src/rename-dry-run.js');
const Adapters = require('../adapters/index.js');
const McpInstall = require('../mcp-install.js');

const Runtime = Adapters.Runtime;
const Claude = Adapters.get('claude');
const OLD_APP = '/Applications/Claude Buddy.app';
const NEW_APP = '/Applications/Plexiform.app';
const runtimeAt = (app, dataDir) => Runtime.make({ execPath: `${app}/Contents/MacOS/${path.basename(app, '.app')}`, platform: 'darwin', hooksDir: `${app}/Contents/Resources/hooks`, dataDir });
const MINE = 'node "/Users/me/scripts/set-status.js" stop';
const DEV = 'node "/Users/me/dev/ctl/hooks/set-status.js" tool-use';

// Every file and folder under dir → content hash and mtime (folders: mtime; links: target).
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}@${st.mtimeMs}`;
      else if (e.isDirectory()) { out[`${rel}/`] = `${st.mtimeMs}:${st.mode}`; walk(p); } else out[rel] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}@${st.mtimeMs}:${st.mode}`;
    }
  };
  walk(dir);
  return out;
}

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-dryrun-')));
  const appData = path.join(home, 'Library', 'Application Support');
  const old = path.join(appData, 'claude-buddy');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(old, rel)), { recursive: true }); fs.writeFileSync(path.join(old, rel), text); };
  put('Preferences', '{}');
  put('Local State', '{"os_crypt":{}}');
  put('board/hub.db', 'x'.repeat(5000));
  put('Cache/Cache_Data/data_0', 'c'.repeat(3000));
  put('buddy-accounts/a.bin', 'sealed');
  fs.symlinkSync('old-host-99999', path.join(old, 'SingletonLock'));
  const dataDir = path.join(home, '.claude-traffic-light');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'approval-secret.json'), JSON.stringify({ v: 1, sealed: true, data: 'b2xk' }));
  fs.writeFileSync(path.join(dataDir, '.auto-launch-configured'), '2026-01-01');
  const oldRt = runtimeAt(OLD_APP, dataDir);
  const settings = Claude.apply({ model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done' }] }] } }, oldRt, { home });
  settings.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: MINE }] });
  settings.hooks.PreToolUse.push({ matcher: '', hooks: [{ type: 'command', command: DEV }] });
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n');
  Adapters.get('codex').install({ home, runtime: oldRt });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { 'claude-buddy': McpInstall.launch({ packaged: true, execPath: oldRt.execPath, appPath: `${OLD_APP}/Contents/Resources/app.asar` }) } }));
  return { home, appData, old, dataDir };
}

const fakeApp = (appData, asked) => ({
  isPackaged: true,
  getName: () => 'Plexiform',
  getVersion: () => '2.0.0',
  getAppPath: () => `${NEW_APP}/Contents/Resources/app.asar`,
  getPath: (n) => { asked.push(n); if (n !== 'appData') throw new Error(`the dry run asked Electron for ${n}`); return appData; },
});
const run = (f, asked = []) => {
  let text = '';
  const plan = DryRun.main({
    app: fakeApp(f.appData, asked), home: f.home, env: {}, platform: 'darwin',
    execPath: `${NEW_APP}/Contents/MacOS/Plexiform`, resourcesPath: `${NEW_APP}/Contents/Resources`,
    listProcesses: () => [{ pid: 4242, command: `${OLD_APP}/Contents/MacOS/Claude Buddy` }, { pid: 4300, command: '/sbin/launchd' }],
    exists: (p) => p === OLD_APP,
    out: (s) => { text += s; },
  });
  return { plan, text };
};

test('dry run: every file and folder is left byte- and mtime-identical, the new userData folder is never created, and Electron is asked only for appData', () => {
  const f = fixture();
  const before = snapshot(f.home);
  const asked = [];
  const { text } = run(f, asked);
  assert.deepEqual(snapshot(f.home), before);
  assert.ok(!fs.existsSync(path.join(f.appData, 'Plexiform')));
  assert.deepEqual([...new Set(asked)], ['appData']);
  for (const want of [
    /dry run: nothing was written/,
    /new folder: ~\/Library\/Application Support\/Plexiform {2}state: absent/,
    /copied \(3, /, /board +4\.9 KB/, /Cache +2\.9 KB +left out by name/, /SingletonLock .*left out by name/,
    /would get SIGTERM: pid 4242 \/Applications\/Claude Buddy\.app\/Contents\/MacOS\/Claude Buddy/,
    /left alone:\n(?:.*\n)*? {7}Stop: node "\/Users\/me\/scripts\/set-status\.js" stop\n {9}\(runs a Plexiform script name from somewhere other than the old app/,
    /PreToolUse: node "\/Users\/me\/dev\/ctl\/hooks\/set-status\.js" tool-use/,
    /Stop: say done\n {9}\(not Plexiform's\)/,
    /backup first: ~\/\.claude\/settings\.json\.pre-plexiform/,
    /--- ~\/\.claude\/settings\.json\n +\+\+\+ ~\/\.claude\/settings\.json \(after\)/,
    /\+ +"command": "ELECTRON_RUN_AS_NODE=1 \\"\/Applications\/Plexiform\.app\/Contents\/MacOS\/Plexiform\\" \\"\/Applications\/Plexiform\.app\/Contents\/Resources\/hooks\/set-status\.js\\" stop"/,
    /\+ELECTRON_RUN_AS_NODE=1 exec '\/Applications\/Plexiform\.app\/Contents\/MacOS\/Plexiform' "\$@"/,
    /-.*"\/Applications\/Claude Buddy\.app\/Contents\/MacOS\/Claude Buddy"/,
    /~\/\.codex\/config\.toml\.pre-plexiform/, /~\/\.claude\.json\.pre-plexiform/,
    /turned ON for Plexiform/,
    /approval-secret\.json is sealed under the old app's Keychain item: renamed to approval-secret\.json\.pre-rename/,
    /9\. Files that would still name the old app \(binning it would break them\)\n {3}none/,
    /would not run: the hooks are current afterwards/,
    /would ask about \/Applications\/Claude Buddy\.app/,
  ]) assert.match(text, want);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('dry run: the plan is exactly what the real run then does', () => {
  const f = fixture();
  const { plan } = run(f);
  const to = path.join(f.appData, 'Plexiform');
  const c = M.copyUserData({ appData: f.appData, userData: to, quitOld: () => true, log: () => {} });
  assert.equal(c.copied, plan.userData.wouldCopy);
  assert.deepEqual(c.entries, plan.userData.copy.map((e) => e.name).sort());
  assert.deepEqual(c.skipped, plan.userData.skip.map((e) => e.name).sort());
  const r = M.rewriteHooks({ home: f.home, runtime: plan.runtime, askFromWidget: false, mcpEntry: plan.hooks.mcp.after, log: () => {} });
  const changed = plan.hooks.configs.filter((x) => x.after != null);
  assert.ok(changed.length >= 2);
  for (const x of changed) assert.equal(fs.readFileSync(x.file, 'utf8'), x.after, x.file);
  assert.equal(fs.readFileSync(plan.hooks.wrapper.file, 'utf8'), plan.hooks.wrapper.after);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, '.claude.json'), 'utf8')).mcpServers['claude-buddy'], plan.hooks.mcp.after);
  assert.deepEqual(r.filter((x) => x.backup).map((x) => x.backup).sort(), plan.backups.slice().sort());
  assert.deepEqual(M.findOldReferences({ home: f.home, runtime: plan.runtime }), plan.stillNaming);
  assert.equal(Claude.isInstalled({ home: f.home, runtime: plan.runtime }), !plan.startup.runs);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('dry run: a folder already in use, a broken config and a failed process list are reported, not acted on', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.appData, 'Plexiform'));
  fs.writeFileSync(path.join(f.appData, 'Plexiform', 'Preferences'), 'mine');
  fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), '{ broken');
  const before = snapshot(f.home);
  let text = '';
  DryRun.main({ app: fakeApp(f.appData, []), home: f.home, env: {}, platform: 'darwin', execPath: `${NEW_APP}/Contents/MacOS/Plexiform`, resourcesPath: `${NEW_APP}/Contents/Resources`, listProcesses: () => { throw new Error('ps failed'); }, exists: () => true, out: (s) => { text += s; } });
  assert.deepEqual(snapshot(f.home), before);
  assert.match(text, /no copy: the new folder is already in use \(Preferences\)/);
  assert.match(text, /steps that would run after it: none/);
  assert.match(text, /can't be read: .*JSON.*hooks step stays pending/);
  assert.match(text, /none found \(the process list failed; no live SingletonLock in the old folder\)/);
  assert.match(text, /not offered this launch/);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('dry run: when the hooks step would not run, it warns that the start-up install strips the person\'s look-alike and dev entries', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.appData, 'Plexiform'));
  fs.writeFileSync(path.join(f.appData, 'Plexiform', 'Preferences'), 'mine');
  const { text } = run(f);
  assert.match(text, /3\. Agent configs \(the hooks step: would NOT run this launch/);
  assert.match(text, /WOULD run on ~\/\.claude\/settings\.json, and it removes every entry that runs a script called set-status\.js or delegate\.js:\n(?:.*\n)*? {5}- Stop: node "\/Users\/me\/scripts\/set-status\.js" stop/);
  assert.match(text, /- PreToolUse: node "\/Users\/me\/dev\/ctl\/hooks\/set-status\.js" tool-use/);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('dry run: unifiedDiff gives hunks with context', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
  const b = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n');
  assert.equal(M.unifiedDiff(a, b, { from: 'x', to: 'y' }), ['--- x', '+++ y', '@@ -1,7 +1,7 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', '@@ -8,3 +8,4 @@', ' h', ' i', ' j', '+k'].join('\n'));
  assert.equal(M.unifiedDiff('same', 'same'), '');
});

test('main.js handles --rename-dry-run first, before anything makes the userData folder', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = src.indexOf("if (process.argv.includes('--rename-dry-run')) {\n  require('./src/rename-dry-run.js').main();\n  process.exit(0);\n}");
  assert.ok(at > 0 && at > src.indexOf("if (process.argv.includes('--uninstall-hooks'))"));
  for (const later of ["} = require('electron');", 'installFileLogging(', "getPath('userData')", 'requestSingleInstanceLock()', 'RenameMigration.copyUserData(', 'crashReporter']) {
    const i = src.indexOf(later);
    if (i >= 0) assert.ok(i > at, `${later} comes after the dry run`);
  }
  const glue = fs.readFileSync(path.join(__dirname, '..', 'src', 'rename-dry-run.js'), 'utf8');
  assert.doesNotMatch(glue, /getPath\('userData'\)|crashReporter|requestSingleInstanceLock|writeFileSync|mkdirSync|HookPaths\.forApp|HookPaths\.resolve/);
});

test('dry run: the settings.json diff shows only the swapped command lines', () => {
  const f = fixture();
  const { plan, text } = run(f);
  const c = plan.hooks.configs.find((x) => x.id === 'claude');
  const diff = M.unifiedDiff(c.before, c.after).split('\n');
  const minus = diff.filter((l) => /^-(?!--)/.test(l));
  const plus = diff.filter((l) => /^\+(?!\+\+)/.test(l));
  assert.equal(minus.length, Claude.HOOK_EVENTS.length);
  assert.equal(plus.length, minus.length);
  assert.ok(minus.every((l) => /^-\s+"command": ".*Claude Buddy\.app/.test(l)), minus[0]);
  assert.ok(plus.every((l) => /^\+\s+"command": ".*Plexiform\.app/.test(l)), plus[0]);
  assert.doesNotMatch(text, /no final newline/);
  fs.rmSync(f.home, { recursive: true, force: true });
});
