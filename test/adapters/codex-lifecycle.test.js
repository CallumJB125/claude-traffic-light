const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const Codex = require('../../adapters/codex.js');
const Runtime = require('../../adapters/runtime.js');
const State = require('../../hooks/session-state.js');
const Machine = require('../../hooks/session-machine.js');
const Uninstall = require('../../adapters/uninstall-all.js');
const EMIT = path.resolve(__dirname, '../../hooks/emit.js');
const HOST = os.hostname().split('.')[0];
const SECRET = 'PRIVATE-PROMPT-RESPONSE-CONTENTS';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-codex-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runtime = Runtime.make({ hooksDir: path.dirname(EMIT), dataDir: home });
  return { home, runtime, file: path.join(home, '.codex', 'hooks.json') };
}
const payload = (event, fields = {}) => ({ hook_event_name: event, session_id: 'session-1', cwd: '/synthetic/project', turn_id: 'turn-1', source: 'startup', ...fields });
function emit(home, event, fields = {}, input) {
  const r = spawnSync(process.execPath, [EMIT, '--adapter', 'codex', '--lifecycle', event], { input: input ?? JSON.stringify(payload(event, fields)), encoding: 'utf8', timeout: 4000, env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home } });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const sessionFile = (home) => State.sessionFileFor(path.join(home, 'sessions'), HOST, 'codex', 'session-1');
const read = (home) => JSON.parse(fs.readFileSync(sessionFile(home), 'utf8'));

test('Codex lifecycle emitter: receives stdin identity and excludes private payload text', (t) => {
  const { home } = fixture(t);
  const r = emit(home, 'UserPromptSubmit', { prompt: SECRET, transcript_path: SECRET, last_assistant_message: SECRET, tool_input: { command: SECRET }, tool_response: SECRET });
  assert.equal(r.stdout, '');
  assert.ok(fs.existsSync(sessionFile(home)), 'the actual session identity must be recorded');
  const s = read(home);
  assert.deepEqual([s.signal, s.sessionId, s.source, s.codexLifecycle, s.codexTurnId], ['prompt-submit', 'session-1', 'codex', 1, 'turn-1']);
  assert.ok(Date.parse(s.codexHookAt));
  assert.equal(fs.readFileSync(sessionFile(home), 'utf8').includes(SECRET), false);
  assert.equal(s.claudePid, undefined, 'a hook child is not the Codex session process');
});

test('Codex lifecycle emitter: neutral Stop JSON cannot approve, block or continue', (t) => {
  const { home } = fixture(t);
  emit(home, 'UserPromptSubmit');
  const r = emit(home, 'Stop', { decision: 'block', continue: false, last_assistant_message: SECRET });
  assert.equal(r.stdout, '{}');
  assert.equal(read(home).signal, 'stop');
  assert.equal(read(home).codexClosedTurn, true);
  assert.equal(fs.readFileSync(sessionFile(home), 'utf8').includes(SECRET), false);
});

test('Codex activity install preserves foreign notify, handlers, JSON style and idempotent bytes', (t) => {
  const { home, runtime, file } = fixture(t);
  fs.mkdirSync(path.dirname(file));
  const toml = 'notify = ["foreign", "keep-me"]\n[profiles.work]\nmodel = "example"\n';
  fs.writeFileSync(Codex.configPath(home), toml);
  const foreign = { matcher: 'Bash', custom: 7, hooks: [{ type: 'command', command: 'foreign-observer', timeout: 9 }] };
  fs.writeFileSync(file, '\ufeff' + JSON.stringify({ description: 'keep', hooks: { PreToolUse: [foreign], FutureEvent: [] } }, null, '\t').replace(/\n/g, '\r\n') + '\r\n', { mode: 0o640 });
  assert.deepEqual(Codex.installActivity({ home, runtime }), { ok: true, file, changed: true });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('\ufeff')); assert.ok(text.includes('\r\n\t'));
  assert.deepEqual(Runtime.readJsonConfig(file).hooks.PreToolUse[0], foreign);
  assert.deepEqual(Runtime.readJsonConfig(file).hooks.FutureEvent, []);
  assert.equal(fs.readFileSync(Codex.configPath(home), 'utf8'), toml);
  assert.equal(Codex.isActivityInstalled({ home, runtime }), true);
  assert.deepEqual(Codex.installActivity({ home, runtime }), { ok: true, file, changed: false });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test('Codex activity strict malformed-group refusal leaves every existing byte', (t) => {
  const { home, runtime, file } = fixture(t);
  fs.mkdirSync(path.dirname(file));
  for (const data of [{ hooks: [] }, { hooks: { Stop: {} } }, { hooks: { Stop: [{ hooks: 'invalid' }] } }, { hooks: { Stop: [{ hooks: [null] }] } }]) {
    const text = JSON.stringify(data); fs.writeFileSync(file, text);
    const r = Codex.installActivity({ home, runtime });
    assert.equal(r.ok, false); assert.equal(r.changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(Codex.isActivityInstalled({ home, runtime }), false);
  }
});

test('Codex activity config preserves unknown own properties including __proto__', (t) => {
  const { runtime } = fixture(t);
  const before = JSON.parse('{"hooks":{"__proto__":[{"hooks":[{"type":"command","command":"keep"}]}]}}');
  const after = Codex.applyActivity(before, runtime);
  assert.deepEqual(after.hooks.__proto__, before.hooks.__proto__);
  assert.equal(Object.prototype.hasOwnProperty.call(after.hooks, '__proto__'), true);
  assert.equal(Codex.checkActivity(after, runtime), true);
});

test('Codex activity exact ownership keeps lookalikes and handler extensions on uninstall', (t) => {
  const { home, runtime, file } = fixture(t);
  assert.equal(Codex.installActivity({ home, runtime }).ok, true);
  const data = Runtime.readJsonConfig(file);
  const own = data.hooks.Stop[0].hooks[0];
  const lookalikes = [{ ...own, statusMessage: 'My observer' }, { ...own, custom: true }, { ...own, command: own.command + ' ; echo foreign' }, { type: 'command', command: 'node "/tmp/emit.js" --adapter codex --lifecycle Stop' }];
  data.hooks.Stop.push({ hooks: lookalikes });
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(Codex.uninstallActivity({ home }).changed, true);
  assert.deepEqual(Runtime.readJsonConfig(file).hooks.Stop, [{ hooks: lookalikes }]);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(Codex.uninstallActivity({ home }).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('Codex activity malformed install and notify-only state are never full lifecycle installs', (t) => {
  const { home, runtime, file } = fixture(t);
  assert.equal(Codex.install({ home, runtime }).ok, true);
  assert.equal(Codex.isInstalled({ home, runtime }), true);
  assert.equal(Codex.isActivityInstalled({ home, runtime }), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(Codex.uninstallActivity({ home }).changed, false);
  assert.equal(fs.existsSync(file), false);
});

test('Codex activity symlink install retains the link, target mode and read-only refusals', (t) => {
  const { home, runtime, file } = fixture(t);
  fs.mkdirSync(path.dirname(file));
  const target = path.join(home, 'dotfiles-hooks.json'); fs.writeFileSync(target, '{"description":"dotfiles"}\n', { mode: 0o640 });
  fs.symlinkSync(target, file);
  assert.equal(Codex.installActivity({ home, runtime }).ok, true);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(Runtime.readJsonConfig(target).description, 'dotfiles');
  assert.equal(Codex.uninstallActivity({ home }).ok, true);
  const text = fs.readFileSync(target, 'utf8');
  fs.chmodSync(target, 0o440);
  assert.equal(Codex.installActivity({ home, runtime }).ok, false);
  assert.equal(fs.readFileSync(target, 'utf8'), text);
  fs.unlinkSync(target);
  assert.equal(Codex.installActivity({ home, runtime }).ok, false);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test('Codex activity current snapshot refusal preserves a concurrent real config edit', (t) => {
  const { home, runtime, file } = fixture(t);
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '{}');
  let reads = 0;
  const actual = fs.realpathSync(file);
  const injected = Object.create(fs);
  injected.openSync = (...args) => {
    if (args[0] === actual && ++reads === 2) fs.writeFileSync(file, '{"foreign":"concurrent"}');
    return fs.openSync(...args);
  };
  const r = Codex.installActivity({ home, runtime, fs: injected });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"foreign":"concurrent"}');
});

test('Codex activity packaged shell commands safely quote POSIX runtime paths and reject Windows expansion', (t) => {
  const { home } = fixture(t);
  const rt = Runtime.make({ execPath: "/opt/Plexi form'$x/plexiform", platform: 'darwin', dataDir: home, hooksDir: "/opt/Plexi form'$x/hooks" });
  const command = Codex.lifecycleCommandFor('Stop', rt);
  assert.ok(command.includes("'\\''"));
  assert.equal(Codex.isActivityOurs({ type: 'command', command, timeout: 3, statusMessage: 'Plexiform Codex activity v1' }, 'Stop'), true);
  const win = Runtime.make({ execPath: 'C:\\Program Files\\Plexiform\\Plexiform.exe', platform: 'win32', dataDir: 'C:\\Users\\tester\\Plexiform', hooksDir: 'C:\\Program Files\\Plexiform\\resources\\hooks' });
  const wanted = Codex.applyActivity({}, win);
  assert.equal(Codex.checkActivity(wanted, win), true);
  assert.equal(Codex.checkActivity(Codex.applyActivity({}, { ...win, dataDir: '\\\\server\\share\\Plexiform', hooksDir: '\\\\server\\share\\Plexiform\\hooks' }), { ...win, dataDir: '\\\\server\\share\\Plexiform', hooksDir: '\\\\server\\share\\Plexiform\\hooks' }), true);
  assert.throws(() => Codex.lifecycleCommandFor('Stop', { ...win, execPath: 'C:\\bad%PATH%\\app.exe' }), /Unsupported/);
});

test('Codex activity uninstall-all removes lifecycle separately and leaves foreign TOML intact', (t) => {
  const { home, runtime, file } = fixture(t);
  assert.equal(Codex.installActivity({ home, runtime }).ok, true);
  fs.writeFileSync(Codex.configPath(home), 'notify = ["foreign"]\n');
  const results = Uninstall.run({ home });
  assert.equal(results.find((r) => r.id === 'codex').changed, false);
  assert.equal(results.find((r) => r.id === 'codex-activity').changed, true);
  assert.equal(fs.readFileSync(Codex.configPath(home), 'utf8'), 'notify = ["foreign"]\n');
  assert.deepEqual(Runtime.readJsonConfig(file).hooks, {});
});

test('Codex lifecycle normalize rejects malformed identities/mismatched events and retains only fixed labels', () => {
  for (const fields of [{ session_id: null }, { session_id: ['session-1'] }, { session_id: '../escape' }, { turn_id: [] }, { hook_event_name: 'PermissionRequest' }, { cwd: 'x\nPRIVATE' }]) assert.deepEqual(Codex.normalize('PreToolUse', payload('PreToolUse', fields)), []);
  const e = Codex.normalize('PreToolUse', payload('PreToolUse', { tool_name: SECRET, tool_input: SECRET, permission_mode: SECRET, transcript_path: SECRET }))[0];
  assert.equal(e.tool, 'Tool'); assert.equal(JSON.stringify(e).includes(SECRET), false);
  assert.equal(Codex.normalize('PreToolUse', payload('PreToolUse', { tool_name: '__proto__' }))[0].tool, 'Tool');
  assert.deepEqual(Codex.normalize('SessionStart', payload('SessionStart', { source: 'unknown' })), []);
});

test('Codex lifecycle parent turn and child roster remain coherent through stop and late child completion', (t) => {
  const { home } = fixture(t);
  emit(home, 'UserPromptSubmit');
  emit(home, 'SubagentStart', { agent_id: 'child-1', agent_type: SECRET, cwd: '/child/other-repo' });
  emit(home, 'Stop');
  const stopped = read(home);
  assert.equal(stopped.cwd, '/synthetic/project');
  assert.equal(stopped.signal, 'stop');
  assert.equal(Machine.effectiveSignal(stopped).signal, 'tool-use');
  assert.equal(stopped.agents[0].status, 'working');
  const r = emit(home, 'SubagentStop', { agent_id: 'child-1', last_assistant_message: SECRET, agent_transcript_path: SECRET });
  assert.equal(r.stdout, '{}');
  const done = read(home);
  assert.equal(done.signal, 'stop'); assert.equal(done.updatedAt, stopped.updatedAt);
  assert.equal(done.agents[0].status, 'done'); assert.equal(Machine.effectiveSignal(done).signal, 'stop');
  assert.equal(JSON.stringify(done).includes(SECRET), false);
});

test('Codex lifecycle new turn retires old tools/stops and closed turns cannot reopen from late tools', (t) => {
  const { home } = fixture(t);
  emit(home, 'UserPromptSubmit'); emit(home, 'Stop');
  const closed = fs.readFileSync(sessionFile(home), 'utf8');
  emit(home, 'PostToolUse'); assert.equal(fs.readFileSync(sessionFile(home), 'utf8'), closed);
  emit(home, 'UserPromptSubmit', { turn_id: 'turn-2' });
  const current = fs.readFileSync(sessionFile(home), 'utf8');
  emit(home, 'Stop'); emit(home, 'PreToolUse'); emit(home, 'UserPromptSubmit');
  assert.equal(fs.readFileSync(sessionFile(home), 'utf8'), current);
  emit(home, 'PermissionRequest', { turn_id: 'turn-2' });
  assert.equal(read(home).signal, 'permission-ask'); assert.equal(read(home).askKind, 'request');
  emit(home, 'PreToolUse', { turn_id: 'turn-2' }); assert.equal(read(home).signal, 'tool-use');
  emit(home, 'Interrupt', { turn_id: 'turn-2' }); assert.equal(read(home).signal, 'idle-nudge');
});

test('Codex lifecycle SessionEnd removes under lock and late tools cannot recreate an absent session', (t) => {
  const { home } = fixture(t);
  emit(home, 'UserPromptSubmit'); emit(home, 'SessionEnd');
  assert.equal(fs.existsSync(sessionFile(home)), false);
  emit(home, 'PostToolUse'); emit(home, 'Stop'); emit(home, 'SubagentStop', { agent_id: 'child-1' });
  assert.equal(fs.existsSync(sessionFile(home)), false);
  emit(home, 'SessionStart'); assert.equal(read(home).signal, 'session-start');
});

test('Codex lifecycle child prompt needs an observed parent before establishing activity', (t) => {
  const { home } = fixture(t);
  const child = { agent_id: 'child-1', turn_id: 'child-turn', cwd: '/child/project' };
  assert.equal(emit(home, 'UserPromptSubmit', child).stdout, '');
  assert.equal(fs.existsSync(sessionFile(home)), false);
  emit(home, 'UserPromptSubmit');
  emit(home, 'UserPromptSubmit', child);
  assert.deepEqual([read(home).codexTurnId, read(home).cwd, read(home).agents[0].status], ['turn-1', '/synthetic/project', 'working']);
});

test('Codex lifecycle child prompt cannot resurrect an ended parent before a fresh parent start', (t) => {
  const { home } = fixture(t);
  emit(home, 'UserPromptSubmit');
  emit(home, 'SubagentStart', { agent_id: 'child-1', turn_id: 'child-turn' });
  emit(home, 'SessionEnd');
  assert.equal(fs.existsSync(sessionFile(home)), false);
  emit(home, 'UserPromptSubmit', { agent_id: 'child-1', turn_id: 'child-next', cwd: '/child/project' });
  assert.equal(fs.existsSync(sessionFile(home)), false);
  emit(home, 'SessionStart', { source: 'resume' });
  emit(home, 'UserPromptSubmit', { agent_id: 'child-1', turn_id: 'child-next', cwd: '/child/project' });
  assert.deepEqual([read(home).codexTurnId, read(home).cwd, read(home).agents[0].status], [null, '/synthetic/project', 'working']);
});

test('Codex lifecycle child prompt preserves a legacy file until a parent observation', (t) => {
  const { home } = fixture(t);
  fs.mkdirSync(path.join(home, 'sessions'));
  const legacy = '{"sessionId":"session-1","source":"codex","signal":"stop","cwd":"/legacy/project"}\n';
  fs.writeFileSync(sessionFile(home), legacy);
  emit(home, 'UserPromptSubmit', { agent_id: 'child-1', turn_id: 'child-turn', cwd: '/child/project' });
  assert.equal(fs.readFileSync(sessionFile(home), 'utf8'), legacy);
  emit(home, 'UserPromptSubmit');
  assert.deepEqual([read(home).codexLifecycle, read(home).codexTurnId, read(home).cwd, read(home).agents.length], [1, 'turn-1', '/synthetic/project', 0]);
});

test('Codex lifecycle compact preserves active roster but a real session start resets it', (t) => {
  const { home } = fixture(t);
  emit(home, 'UserPromptSubmit'); emit(home, 'SubagentStart', { agent_id: 'child-1' });
  emit(home, 'SessionStart', { source: 'compact' }); assert.equal(read(home).agents[0].status, 'working');
  emit(home, 'SessionStart', { source: 'resume' }); assert.deepEqual(read(home).agents, []);
});

test('Codex lifecycle input overflow/mismatch/malformed payloads are bounded neutral refusals', (t) => {
  const { home } = fixture(t);
  for (const input of ['{ invalid', JSON.stringify(payload('PreToolUse')), 'x'.repeat(1024 * 1024 + 1)]) {
    const r = emit(home, 'Stop', {}, input); assert.equal(r.stdout, '{}');
    assert.equal(fs.existsSync(sessionFile(home)), false);
  }
  const r = emit(home, 'UnknownEvent'); assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(home, 'sessions')), false);
});

test('Codex lifecycle idle stdin exits inside hook deadline without storing a fake session', async (t) => {
  const { home } = fixture(t);
  const start = Date.now();
  const child = spawn(process.execPath, [EMIT, '--adapter', 'codex', '--lifecycle', 'Stop'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  let stdout = ''; child.stdout.on('data', (b) => { stdout += b; });
  const result = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); child.stdin.destroy();
  assert.deepEqual(result, { code: 0, signal: null }); assert.equal(stdout, '{}');
  assert.ok(Date.now() - start < 2500);
  assert.equal(fs.existsSync(sessionFile(home)), false);
});

test('Codex lifecycle held fresh lock refuses writes rather than falling back to an unlocked mutation', (t) => {
  const { home } = fixture(t);
  emit(home, 'UserPromptSubmit');
  const file = sessionFile(home); const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file + '.lock', 'foreign-holder');
  emit(home, 'Stop'); assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'foreign-holder');
});

test('Codex lifecycle bounded roster prevents stop-before-start resurrection and preserves active children', () => {
  const event = (name, extra = {}) => Codex.normalize(name, payload(name, extra))[0];
  let s = State.reduceCodexLifecycle(null, event('UserPromptSubmit'), '2026-10-02T00:00:00.000Z');
  s = State.reduceCodexLifecycle(s, event('SubagentStop', { agent_id: 'out-of-order' }), '2026-10-02T00:00:01.000Z');
  assert.equal(State.reduceCodexLifecycle(s, event('SubagentStart', { agent_id: 'out-of-order' })), undefined);
  for (let i = 0; i < 63; i++) s = State.reduceCodexLifecycle(s, event('SubagentStart', { agent_id: `child-${i}` }));
  assert.equal(s.agents.length, 64);
  assert.equal(State.reduceCodexLifecycle(s, event('SubagentStart', { agent_id: 'overflow' })), undefined);
  assert.equal(s.agents.filter((a) => a.status === 'working').length, 63);
});

test('Codex lifecycle actual concurrent child hooks retain every start and stop', async (t) => {
  const { home } = fixture(t);
  emit(home, 'UserPromptSubmit');
  const ids = Array.from({ length: 6 }, (_, i) => `parallel-${i}`);
  async function run(event, id) {
    const child = spawn(process.execPath, [EMIT, '--adapter', 'codex', '--lifecycle', event], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(JSON.stringify(payload(event, { agent_id: id })));
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    const result = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    clearTimeout(timer); assert.deepEqual(result, { code: 0, signal: null });
  }
  await Promise.all(ids.map((id) => run('SubagentStart', id)));
  assert.deepEqual(read(home).agents.map((a) => a.id).sort(), ids);
  emit(home, 'Stop');
  await Promise.all(ids.map((id) => run('SubagentStop', id)));
  const s = read(home);
  assert.equal(s.signal, 'stop'); assert.equal(s.agents.length, 6);
  assert.equal(s.agents.filter((a) => a.status === 'working').length, 0);
});

test('Codex lifecycle distinct child turns and child prompts never replace or finish the parent turn', (t) => {
  const { home } = fixture(t);
  emit(home, 'UserPromptSubmit');
  emit(home, 'SubagentStart', { agent_id: 'child-1', turn_id: 'child-turn-1', cwd: '/child/repo' });
  assert.equal(read(home).codexTurnId, 'turn-1');
  emit(home, 'UserPromptSubmit', { agent_id: 'child-1', turn_id: 'child-turn-2', prompt: SECRET });
  emit(home, 'PermissionRequest', { agent_id: 'child-1', turn_id: 'child-turn-2' });
  assert.equal(read(home).codexAgents[0].status, 'waiting');
  assert.equal(read(home).signal, 'subagent-start');
  assert.notEqual(read(home).askKind, 'request', 'a child permission hook is not a parent permission request');
  emit(home, 'PreToolUse', { agent_id: 'child-1', turn_id: 'child-turn-2' });
  emit(home, 'Stop');
  const stopped = read(home); assert.equal(stopped.signal, 'stop');
  const before = fs.readFileSync(sessionFile(home), 'utf8');
  emit(home, 'SubagentStop', { agent_id: 'child-1', turn_id: 'child-turn-1' });
  assert.equal(fs.readFileSync(sessionFile(home), 'utf8'), before, 'retired child stop is ignored');
  emit(home, 'SubagentStop', { agent_id: 'child-1', turn_id: 'child-turn-2' });
  assert.deepEqual([read(home).codexTurnId, read(home).signal, read(home).cwd, read(home).agents[0].status], ['turn-1', 'stop', '/synthetic/project', 'done']);
  emit(home, 'UserPromptSubmit', { agent_id: 'child-1', turn_id: 'child-turn-3' });
  assert.equal(read(home).signal, 'stop'); assert.equal(read(home).agents[0].status, 'working');
  emit(home, 'UserPromptSubmit', { turn_id: 'turn-2' });
  assert.equal(read(home).codexTurnId, 'turn-2'); assert.equal(read(home).agents[0].status, 'working');
});

test('Codex activity opened-type refusal precedes reads after a real file-to-directory replacement', (t) => {
  const { home, runtime, file } = fixture(t);
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '{}');
  const actual = fs.realpathSync(file); const saved = actual + '.saved';
  let reads = 0; const injected = Object.create(fs);
  injected.openSync = (...args) => {
    fs.renameSync(actual, saved); fs.mkdirSync(actual);
    return fs.openSync(...args);
  };
  injected.readSync = (...args) => { reads++; return fs.readSync(...args); };
  assert.equal(Codex.installActivity({ home, runtime, fs: injected }).ok, false);
  assert.equal(reads, 0); assert.equal(fs.statSync(file).isDirectory(), true);
  assert.equal(fs.readFileSync(saved, 'utf8'), '{}');
});
