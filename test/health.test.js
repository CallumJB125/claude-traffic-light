const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Health = require('../src/health.js');
const Claude = require('../adapters/claude-code.js');
const Runtime = require('../adapters/runtime.js');

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();
const GB = 1024 ** 3;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A fake machine: home with ~/.claude, an app binary and its hooks dir, and
// Buddy's data dir. Everything the checks read lives under one temp folder.
function machine({ hooks = 'current', sessions = {}, locks = {}, transcripts = true, lastHook = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-health-'));
  const root = path.join(home, '.claude-traffic-light');
  const app = path.join(home, 'Applications', 'Claude Buddy.app', 'Contents');
  const hooksDir = path.join(app, 'Resources', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'set-status.js'), '');
  fs.writeFileSync(path.join(app, 'MacOS', 'Claude Buddy'), '');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const runtime = Runtime.make({ execPath: path.join(app, 'MacOS', 'Claude Buddy'), hooksDir, dataDir: root, platform: 'darwin' });
  if (hooks === 'current') fs.writeFileSync(Claude.configPath(home), JSON.stringify(Claude.apply({}, runtime)));
  else if (hooks && typeof hooks === 'object') fs.writeFileSync(Claude.configPath(home), JSON.stringify(Claude.apply({}, hooks)));
  else if (typeof hooks === 'string' && hooks !== 'none') fs.writeFileSync(Claude.configPath(home), hooks);
  for (const [name, data] of Object.entries(sessions)) fs.writeFileSync(path.join(root, 'sessions', `${name}.json`), typeof data === 'string' ? data : JSON.stringify(data));
  for (const [name, ageMs] of Object.entries(locks)) {
    const f = path.join(root, 'sessions', `${name}.json.lock`);
    fs.writeFileSync(f, 'token');
    const t = (NOW - ageMs) / 1000;
    fs.utimesSync(f, t, t);
  }
  if (transcripts) {
    const p = path.join(home, '.claude', 'projects', '-Users-x-proj');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'abc.jsonl'), '{"type":"user","message":"a secret prompt"}\n');
  }
  if (lastHook) fs.writeFileSync(path.join(root, 'last-hook.json'), JSON.stringify(lastHook));
  const ctx = {
    now: NOW, home, root, runtime, version: '1.2.3',
    mcp: { installed: true, current: true, path: path.join(home, '.claude.json'), error: null },
    signal: { listening: true, port: 47172 },
    statfs: () => ({ bavail: 50 * GB / 4096, bsize: 4096 }),
  };
  return { home, root, runtime, hooksDir, ctx };
}
const byId = (report, id) => report.checks.find((c) => c.id === id);

test('a healthy machine: every check ok but the update check, which is not configured', () => {
  const m = machine({ sessions: { a: { sessionId: 'a', signal: 'tool-use', updatedAt: iso(3 * 60000) } } });
  const r = Health.runChecks(m.ctx);
  assert.equal(r.ok, true);
  assert.equal(r.problems, 0);
  for (const c of r.checks.filter((x) => x.id !== 'version')) assert.equal(c.status, 'ok', `${c.id}: ${c.detail}`);
  assert.deepEqual(byId(r, 'version'), { id: 'version', label: 'App version', status: 'info', detail: 'Version 1.2.3. Updates: not set up yet.' });
  assert.equal(byId(r, 'last-hook').detail, '3 min ago.');
  assert.equal(byId(r, 'disk').detail, '50.0 GB free.');
  assert.deepEqual(r.checks.map((c) => c.id), ['hooks', 'sessions', 'last-hook', 'signal', 'mcp', 'transcripts', 'disk', 'version']);
});

test('hooks: missing, or settings.json unparsable', () => {
  const none = Health.runChecks(machine({ hooks: 'none' }).ctx);
  assert.equal(byId(none, 'hooks').status, 'fail');
  assert.equal(byId(none, 'hooks').fix, 'reinstall-hooks');
  assert.equal(byId(none, 'hooks').fixLabel, 'Reinstall hooks');
  assert.match(byId(none, 'hooks').next, /restart your Claude sessions/);
  assert.equal(none.ok, false);
  const broken = Health.runChecks(machine({ hooks: '{ nope' }).ctx);
  assert.equal(byId(broken, 'hooks').status, 'fail');
  assert.equal(byId(broken, 'hooks').fix, undefined, 'no one-click fix: reinstalling would refuse to write over it');
  assert.match(byId(broken, 'hooks').detail, new RegExp(`^${escapeRegex(path.join('~', '.claude', 'settings.json'))} can't be read`));
});

test('hooks: pointing at an app that was moved away is a failure', () => {
  const m = machine();
  const old = Runtime.make({ execPath: '/Volumes/Old/Claude Buddy.app/Contents/MacOS/Claude Buddy', hooksDir: '/Volumes/Old/Claude Buddy.app/Contents/Resources/hooks', dataDir: m.root, platform: 'darwin' });
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(Claude.apply({}, old)));
  const c = byId(Health.runChecks(m.ctx), 'hooks');
  assert.equal(c.status, 'fail');
  assert.equal(c.detail, 'Points at a copy of Buddy that was moved or deleted (/Volumes/Old/Claude Buddy.app/Contents/Resources/hooks/set-status.js).');
  assert.equal(c.fix, 'reinstall-hooks');
});

test('hooks: registered from a checkout that still exists is a warning naming it', () => {
  const m = machine();
  const checkout = path.join(m.home, 'dev', 'claude-traffic-light', 'hooks');
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'set-status.js'), '');
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(Claude.apply({}, Runtime.make({ execPath: null, hooksDir: checkout, dataDir: m.root }))));
  const c = byId(Health.runChecks(m.ctx), 'hooks');
  assert.equal(c.status, 'warn');
  assert.equal(c.detail, `Pointing at a different copy of Buddy (${path.join('~', 'dev', 'claude-traffic-light', 'hooks', 'set-status.js')}), not this one.`);
});

test('hooks: this copy, but missing an event or out of step with askFromWidget', () => {
  const m = machine();
  const settings = Claude.apply({}, m.runtime);
  delete settings.hooks.TaskCompleted;
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(settings));
  const c = byId(Health.runChecks(m.ctx), 'hooks');
  assert.equal(c.status, 'warn');
  assert.equal(c.detail, 'Out of date: no hook for TaskCompleted.');
  const ask = byId(Health.runChecks({ ...machine().ctx, askFromWidget: true }), 'hooks');
  assert.equal(ask.status, 'warn');
  assert.match(ask.detail, /permission-prompt hook/);
});

test('hookPaths reads every command form the installer writes', () => {
  assert.deepEqual(Health.hookPaths('ELECTRON_RUN_AS_NODE=1 "/A/Claude Buddy" "/A/hooks/set-status.js" stop'), { exe: '/A/Claude Buddy', script: '/A/hooks/set-status.js' });
  assert.deepEqual(Health.hookPaths('node "/src/hooks/set-status.js" stop'), { exe: 'node', script: '/src/hooks/set-status.js' });
  assert.deepEqual(Health.hookPaths('"C:\\d\\bin\\buddy-hook.cmd" "C:\\r\\hooks\\set-status.js" stop'), { exe: 'C:\\d\\bin\\buddy-hook.cmd', script: 'C:\\r\\hooks\\set-status.js' });
});

test('sessions: a stale lock is flagged with a fix; a fresh one is left alone', () => {
  const m = machine({ sessions: { a: { sessionId: 'a', updatedAt: iso(1000) } }, locks: { a: 60000, b: 1000 } });
  const c = byId(Health.runChecks(m.ctx), 'sessions');
  assert.equal(c.status, 'warn');
  assert.equal(c.detail, '1 stale lock left by a hook that stopped mid-write.');
  assert.equal(c.fix, 'clear-stale-locks');
  assert.deepEqual(Health.clearStaleLocks({ root: m.root, now: NOW }), ['a.json.lock']);
  assert.deepEqual(fs.readdirSync(path.join(m.root, 'sessions')).sort(), ['a.json', 'b.json.lock']);
  assert.equal(byId(Health.runChecks(m.ctx), 'sessions').status, 'ok');
});

test('sessions: unreadable files are reported; a missing folder fails', () => {
  const m = machine({ sessions: { a: '{"half', b: { sessionId: 'b' } } });
  const c = byId(Health.runChecks(m.ctx), 'sessions');
  assert.equal(c.status, 'warn');
  assert.equal(c.detail, '1 unreadable session file.');
  fs.rmSync(path.join(m.root, 'sessions'), { recursive: true });
  const gone = byId(Health.runChecks(m.ctx), 'sessions');
  assert.equal(gone.status, 'fail');
  assert.match(gone.next, /reopen Buddy/);
});

test('last hook: newest of the live session files and the saved stamp', () => {
  const m = machine({ sessions: { a: { updatedAt: iso(600000), agentsAt: iso(120000), source: 'cursor' } }, lastHook: { at: iso(3600000) } });
  assert.deepEqual(Health.lastHookEvent(m.ctx), { at: NOW - 120000, source: 'cursor' });
  assert.equal(byId(Health.runChecks(m.ctx), 'last-hook').detail, '2 min ago (cursor).');
  // Every session ended (SessionEnd deletes the file): the saved stamp remains.
  fs.rmSync(path.join(m.root, 'sessions', 'a.json'));
  assert.equal(byId(Health.runChecks(m.ctx), 'last-hook').detail, '60 min ago.');
});

test('last hook: none yet is a warning; with a window (onboarding) it fails with a likely cause', () => {
  const m = machine();
  const r = Health.runChecks(m.ctx);
  assert.equal(byId(r, 'last-hook').status, 'warn');
  assert.match(byId(r, 'last-hook').next, /restart one opened before the hooks were installed/);
  const within = Health.runChecks({ ...m.ctx, hookWithinMs: 60000 });
  assert.equal(byId(within, 'last-hook').status, 'fail');
  assert.match(byId(within, 'last-hook').next, /restart it \(\/exit, then claude\)/);
  // Broken hooks are the likelier story, and say how.
  const noHooks = machine({ hooks: 'none' });
  const r2 = Health.runChecks({ ...noHooks.ctx, hookWithinMs: 60000 });
  assert.equal(byId(r2, 'last-hook').next, "Hooks: Not installed, so Claude Code can't change the light.");
  assert.equal(Health.likelyCause(r2.checks), byId(r2, 'last-hook').next);
  // An old event outside the window fails too.
  const old = machine({ lastHook: { at: iso(5 * 60000) } });
  assert.equal(byId(Health.runChecks({ ...old.ctx, hookWithinMs: 60000 }), 'last-hook').status, 'fail');
});

test('transcripts: missing folder warns, present folder opens a file without reading it', () => {
  assert.equal(byId(Health.runChecks(machine({ transcripts: false }).ctx), 'transcripts').status, 'warn');
  const m = machine();
  const opened = [];
  const spy = { ...fs, openSync: (f, flag) => { opened.push([path.basename(f), flag]); return fs.openSync(f, flag); }, readFileSync: (f, ...a) => { assert.doesNotMatch(String(f), /\.jsonl$/); return fs.readFileSync(f, ...a); } };
  const c = byId(Health.runChecks({ ...m.ctx, fs: spy }), 'transcripts');
  assert.equal(c.status, 'ok');
  assert.equal(c.detail, '1 project folder, readable.');
  assert.deepEqual(opened, [['abc.jsonl', 'r']]);
  const denied = { ...fs, readdirSync: (d, o) => { if (String(d).endsWith('projects')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.readdirSync(d, o); } };
  const f = byId(Health.runChecks({ ...m.ctx, fs: denied }), 'transcripts');
  assert.equal(f.status, 'fail');
  assert.equal(f.detail, `${path.join('~', '.claude', 'projects')} can't be read (EACCES).`);
});

test('mcp, signal server, disk and update states', () => {
  const { ctx } = machine();
  const run = (extra, id) => byId(Health.runChecks({ ...ctx, ...extra }), id);
  assert.equal(run({ mcp: { installed: false, path: '/x' } }, 'mcp').fix, 'enable-mcp');
  assert.equal(run({ mcp: { installed: true, current: false, path: '/x' } }, 'mcp').detail, 'Registered, but pointing at an older copy of Buddy.');
  assert.equal(run({ mcp: { installed: false, path: '/x', error: 'Unexpected token' } }, 'mcp').status, 'fail');
  assert.equal(run({ mcpConnected: true }, 'mcp').detail, 'Registered, and this answer came through it.');
  const busy = run({ signal: { listening: false, port: 47172, error: 'EADDRINUSE' } }, 'signal');
  assert.equal(busy.status, 'warn');
  assert.equal(busy.detail, "Another program is using its port (47172), so other tools can't reach Buddy.");
  assert.equal(run({ signal: { running: false, port: 47172 } }, 'signal').status, 'fail');
  assert.equal(run({ statfs: () => ({ bavail: 100, bsize: 1024 * 1024 }) }, 'disk').status, 'fail');
  assert.equal(run({ statfs: () => ({ bavail: 500, bsize: 1024 * 1024 }) }, 'disk').status, 'warn');
  assert.equal(run({ statfs: () => { throw Object.assign(new Error('x'), { code: 'ENOSYS' }); } }, 'disk').status, 'info');
  assert.equal(run({ updateStatus: () => ({ state: 'available', version: '1.3.0' }) }, 'version').detail, 'Version 1.2.3; 1.3.0 is available.');
  assert.equal(run({ updateStatus: () => ({ state: 'current' }) }, 'version').status, 'ok');
});

test('a check that throws becomes "couldn\'t check" rather than breaking the report', () => {
  const { ctx } = machine();
  const r = Health.runChecks({ ...ctx, updateStatus: () => { throw new Error('boom'); } });
  assert.equal(byId(r, 'version').status, 'info');
  assert.equal(byId(r, 'version').detail, "Couldn't check (boom).");
  assert.equal(r.checks.length, 8);
});

test('logExcerpt keeps startup, warnings and errors with their stacks, never [state] lines', () => {
  const log = [
    '2026-09-30T10:00:00.000Z [error] [startup] {"demo":null,"gotLock":true}',
    '2026-09-30T10:00:01.000Z [log] [state] 1234abcd work/secret tool-use → stop (hook signal)',
    '2026-09-30T10:00:02.000Z [error] [uncaught] Error: boom',
    '    at f (/Users/jane/work/secret/x.js:1:1)',
    '2026-09-30T10:00:03.000Z [log] [sweep] removed 1 stale session file(s)',
    '2026-09-30T10:00:04.000Z [warn] [hooks] /Users/jane/.claude/settings.json not updated: Unexpected token',
  ].join('\n');
  const out = Health.logExcerpt(log);
  assert.equal(out.length, 4);
  assert.ok(out.every((l) => !/\[state\]|\[sweep\]/.test(l)));
  assert.match(out[2], /^\s+at f/);
});

test('diagnostics: checks, versions, OS and log, with no home path, project name, token or transcript text', () => {
  const m = machine({ hooks: 'none', sessions: { a: { cwd: '/w/secret-project', updatedAt: iso(1000) } } });
  const report = Health.runChecks(m.ctx);
  const logText = [
    `2026-09-30T10:00:00.000Z [error] [startup] {"userData":"${m.home}/Library/Application Support/Claude Buddy"}`,
    `2026-09-30T10:00:02.000Z [error] [uncaught] Error: ENOENT ${m.home}/work/secret-project/x.js token=${'a'.repeat(64)}`,
    '2026-09-30T10:00:03.000Z [log] [state] 1234abcd work/secret-project tool-use → stop (hook signal)',
  ].join('\n');
  const text = Health.diagnostics({
    report,
    versions: { electron: '44.3.0', chrome: '140', node: '24' },
    platform: { os: 'darwin', release: '25.4.0', arch: 'arm64', packaged: true },
    logText,
    scrubWith: { home: m.home, salt: 's' },
  });
  assert.match(text, new RegExp(`^${require('../brand.js').name} diagnostics\\n`));
  assert.match(text, new RegExp(`\\nGenerated 2026-09-30T12:00:00.000Z\\n${require('../brand.js').name} 1\\.2\\.3 · Electron 44\\.3\\.0`));
  assert.match(text, /OS darwin 25\.4\.0 arm64/);
  assert.match(text, /\[FAIL\] Claude Code hooks: Not installed/);
  assert.match(text, /next: Then restart your Claude sessions/);
  assert.match(text, /\[startup\].*~\/Library\/Application Support\/Claude Buddy/);
  assert.ok(!text.includes(m.home), 'no home path');
  assert.doesNotMatch(text, /secret-project|a{64}|a secret prompt|\[state\]/);
});

test('hooks: current, but also registered from another copy, or in an older form of this one', () => {
  const m = machine();
  const checkout = path.join(m.home, 'dev', 'buddy', 'hooks');
  const twice = Claude.apply({}, m.runtime);
  twice.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: `node "${path.join(checkout, 'set-status.js')}" stop` }] });
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(twice));
  const c = byId(Health.runChecks(m.ctx), 'hooks');
  assert.equal(c.status, 'warn');
  assert.equal(c.detail, `Installed, but also registered from a copy that isn't there any more (${path.join('~', 'dev', 'buddy', 'hooks', 'set-status.js')}).`);
  assert.equal(c.fix, 'reinstall-hooks');
  // The same script run by plain node: this app, an older command form.
  const old = Claude.apply({}, Runtime.make({ execPath: null, hooksDir: m.hooksDir, dataDir: m.root }));
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(old));
  const o = byId(Health.runChecks(m.ctx), 'hooks');
  assert.equal(o.status, 'warn');
  assert.equal(o.detail, 'Installed in an older form.');
});

test('hooks: a translocated app fails with no fix and says to move it', () => {
  const m = machine();
  const rt = Runtime.make({ execPath: '/private/var/folders/x/AppTranslocation/ABC/d/Claude Buddy.app/Contents/MacOS/Claude Buddy', hooksDir: m.hooksDir, dataDir: m.root, platform: 'darwin' });
  const c = byId(Health.runChecks({ ...m.ctx, runtime: rt }), 'hooks');
  assert.equal(c.status, 'fail');
  assert.equal(c.fix, undefined);
  assert.equal(c.next, `Move ${require('../brand.js').name} to Applications (drag it out of Downloads), then open it from there.`);
});

test('last hook: not green when the hooks are broken or it is over a day old', () => {
  const broken = machine({ hooks: 'none', lastHook: { at: iso(60000) } });
  assert.equal(byId(Health.runChecks(broken.ctx), 'last-hook').status, 'info');
  const old = machine({ lastHook: { at: iso(26 * 3600000) } });
  const c = byId(Health.runChecks(old.ctx), 'last-hook');
  assert.equal(c.status, 'warn');
  assert.equal(c.detail, '26 h ago.');
});

test('update available always says what to do', () => {
  const { ctx } = machine();
  assert.equal(byId(Health.runChecks({ ...ctx, updateStatus: () => ({ state: 'available' }) }), 'version').next, 'Quit Buddy and install the update from the tray.');
});

test('stale-lock clearing also removes old aside files and pluralises', () => {
  const m = machine({ locks: { a: 60000, b: 60000 } });
  const aside = path.join(m.root, 'sessions', 'c.json.lock.123-abc.stale');
  fs.writeFileSync(aside, 'x');
  fs.utimesSync(aside, (NOW - 60000) / 1000, (NOW - 60000) / 1000);
  const c = byId(Health.runChecks(m.ctx), 'sessions');
  assert.equal(c.fixLabel, 'Clear stale locks');
  assert.equal(c.detail, '3 stale locks left by a hook that stopped mid-write.');
  assert.deepEqual(Health.clearStaleLocks({ root: m.root, now: NOW }).sort(), ['a.json.lock', 'b.json.lock', 'c.json.lock.123-abc.stale']);
  assert.deepEqual(fs.readdirSync(path.join(m.root, 'sessions')), []);
});

test('settings.json parse errors never quote the file', () => {
  const m = machine({ hooks: '{"hooks": "my secret prompt' });
  const c = byId(Health.runChecks(m.ctx), 'hooks');
  assert.doesNotMatch(c.detail, /secret prompt/);
  assert.doesNotMatch(Health.logExcerpt(`2026-09-30T10:00:00.000Z [warn] [hooks] x not updated: Unexpected token 'm', "my secret prompt" is not valid JSON`).join('\n'), /secret prompt/);
});

test('logExcerpt drops what a voice line says, and every line after it until the next entry', () => {
  const TS = '2026-09-30T10:00:00.000Z';
  const out = Health.logExcerpt([
    `${TS} [warn] [voice] couldn't ask claude: "move globex payroll to friday"`,
    'continuation: my password is hunter2 and ship the globex deal',
    `${TS} [error] [voice] boom: pay alice 500`,
    '    at flow.question (/Users/alice/x.js:1:1) text="book dentist"',
    `${TS} [warn]  [voice] double-space: secret words here`,
    `${TS} [error] Error: [voice] wrapped: tell bob about layoffs`,
    `${TS} [warn] voice: tell bob about layoffs2`,
    `${TS} [error] [startup] still here`,
  ].join('\n'));
  assert.deepEqual(out, [
    `${TS} [warn] [voice] (message omitted)`,
    `${TS} [error] [voice] (message omitted)`,
    `${TS} [warn] [voice] (message omitted)`,
    `${TS} [error] [voice] (message omitted)`,
    `${TS} [warn] [voice] (message omitted)`,
    `${TS} [error] [startup] still here`,
  ]);
});

test('hooks: P3\'s deny rule — present is fine, missing is a warning, a foreign deny list is left alone', () => {
  const m = machine();
  const settings = JSON.parse(fs.readFileSync(Claude.configPath(m.home), 'utf8'));
  assert.deepEqual(settings.permissions.deny, Claude.denyRulesFor(m.home, m.runtime));
  assert.equal(byId(Health.runChecks(m.ctx), 'hooks').status, 'ok');
  // The person's own deny rules beside Buddy's change nothing.
  settings.permissions.deny.unshift('Read(~/.ssh/**)');
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(settings));
  assert.equal(byId(Health.runChecks(m.ctx), 'hooks').status, 'ok');
  // Buddy's rule removed by hand.
  settings.permissions.deny = ['Read(~/.ssh/**)'];
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(settings));
  const c = byId(Health.runChecks(m.ctx), 'hooks');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /without the rule that keeps Claude's file tools out/);
  assert.equal(c.fix, 'reinstall-hooks');
  // A deny list that isn't a list is the person's to fix: the installer adds
  // nothing, so the check doesn't ask for it.
  settings.permissions.deny = 'oops';
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify(settings));
  assert.equal(byId(Health.runChecks(m.ctx), 'hooks').status, 'ok');
});

test('hooks: a settings.json the real installer wrote (P3 deny rule, .buddy-backup beside it) reads as installed', () => {
  const m = machine({ hooks: 'none' });
  // An existing settings file, as a person would have: the installer backs it up once.
  fs.writeFileSync(Claude.configPath(m.home), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }));
  Claude.install({ home: m.home, runtime: m.runtime });
  const written = JSON.parse(fs.readFileSync(Claude.configPath(m.home), 'utf8'));
  assert.ok(written.permissions.deny.includes('Edit(~/.claude-traffic-light/**)'));
  assert.ok(fs.readdirSync(path.join(m.home, '.claude')).some((f) => f.includes('buddy-backup')), 'installer left its backup');
  const c = byId(Health.runChecks(m.ctx), 'hooks');
  assert.equal(c.status, 'ok', c.detail);
  assert.equal(c.detail, 'Installed, and pointing at this copy of Buddy.');
  // Installing twice changes nothing the check cares about.
  Claude.install({ home: m.home, runtime: m.runtime });
  assert.equal(byId(Health.runChecks(m.ctx), 'hooks').status, 'ok');
});
