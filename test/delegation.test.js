const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const D = require('../hooks/delegate.js');
const H = require('../hooks/install.js');
const DI = require('../delegation-install.js');
const U = require('../usage.js');
const R = require('../rules.js');

const DELEGATE = path.join(__dirname, '..', 'hooks', 'delegate.js');
const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const HOST = os.hostname().split('.')[0];

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function home(flag) {
  const h = tmp('ctl-deleg-');
  if (flag) {
    fs.mkdirSync(path.join(h, 'router'), { recursive: true });
    fs.writeFileSync(path.join(h, 'router', 'delegation.json'), JSON.stringify(flag));
  }
  return h;
}
// ~48 bytes a line: 1,000 lines is well over the 12 KB size floor.
function makeFile(dir, lines, name = 'big.js') {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `${Array.from({ length: lines }, (_, i) => `const line${i} = ${i}; // padding padding pad`).join('\n')}\n`);
  return f;
}
function run(h, payload) {
  const r = spawnSync(process.execPath, [DELEGATE], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: h }, input: JSON.stringify(payload) });
  assert.equal(r.status, 0, r.stderr.toString());
  const out = r.stdout.toString();
  return out ? JSON.parse(out) : null;
}
const logOf = (h) => {
  const f = path.join(h, 'router', 'delegations.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const countsOf = (h, sid) => JSON.parse(fs.readFileSync(path.join(h, 'router', 'delegated', `${sid}.json`), 'utf8'));
const readCall = (file, extra = {}, sid = 's1') => ({ session_id: sid, cwd: path.dirname(file), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file, ...extra } });
const bashCall = (cwd, command, sid = 's1') => ({ session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'look' } });

// ── hooks/delegate.js: PreToolUse Read ──────────────────────────────────────
test('delegate: a big whole-file Read is narrowed via updatedInput, with a reason the model sees', () => {
  const h = home({ enabled: true });
  const f = makeFile(h, 1000);
  const out = run(h, readCall(f));
  const hso = out.hookSpecificOutput;
  assert.equal(hso.hookEventName, 'PreToolUse');
  assert.deepEqual(hso.updatedInput, { file_path: f, offset: 1, limit: 120 });
  assert.equal(hso.permissionDecision, undefined, 'narrowing must not auto-approve the call');
  assert.match(hso.additionalContext, /Buddy trimmed this read to the first 120 lines \(file has 1,000\)/);
  assert.ok(hso.additionalContext.includes(`Agent(buddy-reader, 'summarise ${f} for <what you need>')`));
  const [e] = logOf(h);
  assert.equal(e.kind, 'read-narrowed');
  assert.equal(e.sessionId, 's1');
  assert.equal(e.path, f);
  assert.equal(e.linesTotal, 1000);
  assert.equal(e.linesShown, 120);
  assert.equal(e.charsTotal, fs.statSync(f).size);
  assert.equal(e.tokensAvoided, Math.round((e.charsTotal - e.charsShown) / 4));
  assert.ok(e.tokensAvoided > 9000);
  assert.deepEqual({ reads: countsOf(h, 's1').reads, trims: countsOf(h, 's1').trims }, { reads: 1, trims: 0 });
});

test('delegate: small files, explicit ranges, non-text files and allowlisted paths are left alone', () => {
  const h = home({ enabled: true, allow: ['.lock', 'docs/**/*.md'] });
  const small = makeFile(h, 100, 'small.js');
  const big = makeFile(h, 1000);
  assert.equal(run(h, readCall(small)), null);
  assert.equal(run(h, readCall(big, { limit: 2000 })), null, 'limit present');
  assert.equal(run(h, readCall(big, { offset: 1 })), null, 'offset present');
  const pdf = makeFile(h, 1000, 'big.pdf');
  assert.equal(run(h, readCall(pdf)), null);
  fs.mkdirSync(path.join(h, 'docs', 'a'), { recursive: true });
  assert.equal(run(h, readCall(makeFile(h, 1000, 'yarn.lock'))), null, 'extension allowlisted');
  assert.equal(run(h, readCall(makeFile(path.join(h, 'docs', 'a'), 1000, 'guide.md'))), null, 'glob allowlisted');
  assert.equal(run(h, readCall(path.join(h, 'missing.js'))), null);
  assert.deepEqual(logOf(h), []);
});

test('delegate: mode deny blocks with permissionDecision deny and the buddy-reader pointer', () => {
  const h = home({ enabled: true, mode: 'deny', readLines: 500, peekLines: 50 });
  const f = makeFile(h, 800);
  const hso = run(h, readCall(f)).hookSpecificOutput;
  assert.equal(hso.permissionDecision, 'deny');
  assert.match(hso.permissionDecisionReason, /800 lines \(over 500\).*buddy-reader/);
  assert.equal(hso.updatedInput, undefined);
  assert.equal(logOf(h)[0].kind, 'read-denied');
  assert.equal(logOf(h)[0].linesShown, 0);
});

test('delegate: the buddies themselves read whole files', () => {
  const h = home({ enabled: true });
  const f = makeFile(h, 1000);
  assert.equal(run(h, { ...readCall(f), agent_id: 'a1', agent_type: 'buddy-reader' }), null);
  assert.ok(run(h, { ...readCall(f), agent_id: 'a2', agent_type: 'executor' }), 'other subagents are still narrowed');
});

// ── PreToolUse Bash ─────────────────────────────────────────────────────────
test('delegate: cat / head -n big / tail -n big of a big file are rewritten; anything else is not', () => {
  const h = home({ enabled: true });
  makeFile(h, 1000);
  makeFile(h, 100, 'small.js');
  const cmd = (c) => run(h, bashCall(h, c))?.hookSpecificOutput;
  const cat = cmd('cat big.js');
  assert.deepEqual(cat.updatedInput, { command: 'head -n 120 big.js', description: 'look' });
  assert.match(cat.additionalContext, /rewrote `cat big\.js` to `head -n 120 big\.js`.*1,000 lines.*buddy-reader/);
  assert.equal(cmd('cat -n "big.js"').updatedInput.command, 'cat -n "big.js" | head -n 120');
  assert.equal(cmd(`head -n 5000 ${path.join(h, 'big.js')}`).updatedInput.command, `head -n 120 ${path.join(h, 'big.js')}`);
  assert.equal(cmd('head -2000 big.js').updatedInput.command, 'head -n 120 big.js');
  assert.equal(cmd('tail -n 900 big.js').updatedInput.command, 'tail -n 120 big.js');
  for (const c of ['head -n 50 big.js', 'tail big.js', 'cat small.js', 'cat big.js | grep x', 'cat big.js > out', 'cat *.js', 'cat a.js big.js', 'npm test', 'cat big.js; rm -rf x']) assert.equal(cmd(c), undefined, c);
  const kinds = logOf(h).map((e) => e.kind);
  assert.ok(kinds.length === 5 && kinds.every((k) => k === 'bash-narrowed'));
  assert.equal(logOf(h)[0].tool, 'Bash');
});

// ── PostToolUse ─────────────────────────────────────────────────────────────
test('delegate: PostToolUse replaces oversized output with its head, keeping the response shape', () => {
  const h = home({ enabled: true });
  const post = (tool_name, tool_response, tool_input = {}) => run(h, { session_id: 's2', cwd: h, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response });
  const bash = post('Bash', { stdout: 'x'.repeat(30000), stderr: '', interrupted: false, isImage: false }, { command: 'npm test' }).hookSpecificOutput;
  assert.equal(bash.hookEventName, 'PostToolUse');
  const o = bash.updatedToolOutput;
  assert.equal(o.stderr, '');
  assert.equal(o.interrupted, false);
  assert.ok(o.stdout.startsWith('x'.repeat(24000)));
  assert.match(o.stdout, /\n…Buddy trimmed 6,000 of 30,000 chars\. Re-run with a narrower query, or delegate to buddy-reader\.$/);
  assert.equal(bash.additionalContext, undefined, 'the footer is inline');

  const files = Array.from({ length: 2000 }, (_, i) => `/repo/src/some/deep/folder/file-${i}.ts`);
  const glob = post('Glob', { filenames: files, numFiles: 2000, truncated: false, durationMs: 5 }, { pattern: '**/*.ts' }).hookSpecificOutput;
  const g = glob.updatedToolOutput;
  assert.ok(g.filenames.length < files.length && g.filenames.length > 100);
  assert.ok(g.filenames.every((f, i) => f === files[i]), 'paths are never cut mid-name');
  assert.equal(g.truncated, true);
  assert.match(glob.additionalContext, /Buddy trimmed/);

  assert.equal(post('Read', { type: 'text', file: { filePath: '/x', content: 'short' } }), null);
  const kinds = logOf(h).map((e) => [e.kind, e.tool]);
  assert.deepEqual(kinds, [['output-trimmed', 'Bash'], ['output-trimmed', 'Glob']]);
  assert.equal(logOf(h)[0].tokensAvoided, 1500);
  assert.equal(countsOf(h, 's2').trims, 2);
});

// ── UserPromptSubmit ────────────────────────────────────────────────────────
test('delegate: the policy is injected on the first prompt of a session only', () => {
  const h = home({ enabled: true, readLines: 400 });
  const prompt = (sid) => run(h, { session_id: sid, cwd: h, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  const first = prompt('p1').hookSpecificOutput;
  assert.equal(first.hookEventName, 'UserPromptSubmit');
  assert.match(first.additionalContext, /buddy-reader \(haiku\).*buddy-worker \(sonnet\).*over ~400 lines/);
  assert.equal(prompt('p1'), null);
  assert.ok(prompt('p2'));
  assert.deepEqual(logOf(h).map((e) => e.kind), ['policy-injected', 'policy-injected']);
  assert.equal(countsOf(h, 'p1').reads, 0, 'the policy is not a delegated read');
});

test('delegate: with the flag file absent or off it exits at once with no output and writes nothing', () => {
  const f = makeFile(tmp('ctl-deleg-src-'), 1000);
  for (const h of [home(null), home({ enabled: false }), home({ mode: 'deny' })]) {
    const r = spawnSync(process.execPath, [DELEGATE], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: h }, input: JSON.stringify(readCall(f)) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.toString(), '');
    assert.equal(fs.existsSync(path.join(h, 'router', 'delegations.jsonl')), false);
  }
});

// ── set-status.js carries the counter ───────────────────────────────────────
test('set-status: copies the delegate counter onto the session file; session-end clears it', () => {
  const h = home({ enabled: true });
  const f = makeFile(h, 1000);
  const ss = (signal, payload) => spawnSync(process.execPath, [SET_STATUS, signal], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: h }, input: JSON.stringify(payload) });
  ss('prompt-submit', { session_id: 'sd' });
  const before = JSON.parse(fs.readFileSync(path.join(h, 'sessions', `${HOST}-sd.json`), 'utf8'));
  assert.equal(before.delegated, undefined);
  run(h, readCall(f, {}, 'sd'));
  ss('tool-done', { session_id: 'sd', tool_name: 'Read' });
  const s = JSON.parse(fs.readFileSync(path.join(h, 'sessions', `${HOST}-sd.json`), 'utf8'));
  assert.equal(s.delegated.reads, 1);
  assert.equal(s.delegated.trims, 0);
  assert.ok(Date.now() - Date.parse(s.delegated.at) < 10000);
  ss('session-end', { session_id: 'sd' });
  assert.equal(fs.existsSync(path.join(h, 'router', 'delegated', 'sd.json')), false);
});

// ── hooks/install.js ────────────────────────────────────────────────────────
test('installDelegation: idempotent, right matchers and timeout, keeps set-status and foreign hooks', () => {
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] };
  const base = H.install({ hooks: { PreToolUse: [foreign] }, model: 'opus' }, '/app/hooks/set-status.js');
  const once = H.installDelegation(JSON.parse(JSON.stringify(base)), '/app/hooks/delegate.js');
  const twice = H.installDelegation(JSON.parse(JSON.stringify(once)), '/app/hooks/delegate.js');
  assert.deepEqual(once, twice);
  const ours = (ev) => once.hooks[ev].filter((x) => x.hooks.some((hh) => /delegate\.js/.test(hh.command)));
  assert.deepEqual(ours('PreToolUse'), [{ matcher: 'Read|Bash', hooks: [{ type: 'command', command: 'node "/app/hooks/delegate.js"', timeout: 2 }] }]);
  assert.equal(ours('PostToolUse')[0].matcher, 'Read|Grep|Glob|Bash');
  assert.equal(ours('UserPromptSubmit').length, 1);
  assert.equal(H.isDelegationInstalled(once, '/app/hooks/delegate.js'), true);
  assert.equal(H.isDelegationInstalled(base, '/app/hooks/delegate.js'), false);
  assert.equal(H.isInstalled(once, '/app/hooks/set-status.js'), true, 'set-status untouched');
  // Re-installing set-status (the app does it every 10 min) keeps delegation.
  assert.equal(H.isDelegationInstalled(H.install(JSON.parse(JSON.stringify(once)), '/app/hooks/set-status.js'), '/app/hooks/delegate.js'), true);
  // A moved app replaces the old path rather than adding a second entry.
  const moved = H.installDelegation(JSON.parse(JSON.stringify(once)), '/new/hooks/delegate.js');
  assert.equal(moved.hooks.PreToolUse.filter((x) => x.hooks.some((hh) => /delegate\.js/.test(hh.command))).length, 1);
  const off = H.uninstallDelegation(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(off, base);
  assert.deepEqual(H.uninstallDelegation(JSON.parse(JSON.stringify(off))), base);
});

// ── delegation-install.js against a temp HOME ───────────────────────────────
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return Object.fromEntries(m[1].split('\n').filter((l) => /^\w+:/.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
}

test('agent templates use the real subagent frontmatter fields and carry the marker', () => {
  const t = DI.templates();
  assert.deepEqual(t.map((x) => x.name), ['buddy-reader.md', 'buddy-worker.md']);
  const [reader, worker] = t.map((x) => ({ fm: frontmatter(x.text), text: x.text }));
  assert.deepEqual([reader.fm.name, reader.fm.model, reader.fm.tools], ['buddy-reader', 'haiku', 'Read, Grep, Glob']);
  assert.deepEqual([worker.fm.name, worker.fm.model], ['buddy-worker', 'sonnet']);
  assert.ok(!/Bash/.test(worker.fm.tools), 'the worker cannot run commands');
  for (const x of [reader, worker]) { assert.ok(x.fm.description.length > 40); assert.ok(x.text.includes(DI.MARKER)); }
});

test('delegation install/uninstall: agents + hooks + flag, idempotent both ways, foreign files kept', () => {
  const h = tmp('ctl-deleg-home-');
  const opts = { home: h, scriptPath: '/app/hooks/delegate.js', config: { mode: 'deny', readLines: 500, peekLines: 80, outputChars: 9000, allow: ['.md'] } };
  const settingsFile = path.join(h, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const foreign = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done' }] }] } };
  fs.writeFileSync(settingsFile, JSON.stringify(foreign, null, 2));
  const mine = path.join(h, '.claude', 'agents', 'my-agent.md');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, '---\nname: my-agent\n---\nmine');

  const on = DI.install(opts);
  assert.equal(on.installed, true);
  assert.deepEqual(on.conflicts, []);
  assert.equal(on.settingsChanged, true);
  assert.deepEqual(on.flag, { enabled: true, mode: 'deny', readLines: 500, peekLines: 80, outputChars: 9000, allow: ['.md'] });
  const reader = path.join(h, '.claude', 'agents', 'buddy-reader.md');
  assert.equal(fs.readFileSync(reader, 'utf8'), DI.templates()[0].text);
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(s.permissions, foreign.permissions);
  assert.equal(H.isDelegationInstalled(s, '/app/hooks/delegate.js'), true);

  const mtime = fs.statSync(reader).mtimeMs;
  const again = DI.install(opts);
  assert.equal(again.settingsChanged, false, 'second install changes nothing');
  assert.equal(fs.statSync(reader).mtimeMs, mtime);

  const off = DI.uninstall(opts);
  assert.equal(off.installed, false);
  assert.equal(off.settingsChanged, true);
  assert.equal(fs.existsSync(reader), false);
  assert.equal(fs.readFileSync(mine, 'utf8'), '---\nname: my-agent\n---\nmine', "the user's own agent survives");
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), foreign);
  assert.equal(DI.readFlag(opts).enabled, false);
  assert.equal(DI.readFlag(opts).readLines, 500, 'thresholds are kept for next time');
  assert.equal(DI.uninstall(opts).settingsChanged, false, 'second uninstall changes nothing');
});

test('delegation install: never overwrites a same-named agent of yours, never rewrites unparsable settings', () => {
  const h = tmp('ctl-deleg-home-');
  const own = path.join(h, '.claude', 'agents', 'buddy-worker.md');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, 'my own buddy-worker');
  const r = DI.install({ home: h, scriptPath: '/x/delegate.js' });
  assert.deepEqual(r.conflicts, [own]);
  assert.equal(r.installed, false);
  assert.equal(fs.readFileSync(own, 'utf8'), 'my own buddy-worker');
  DI.uninstall({ home: h, scriptPath: '/x/delegate.js' });
  assert.equal(fs.readFileSync(own, 'utf8'), 'my own buddy-worker');

  const bad = tmp('ctl-deleg-home-');
  const sf = path.join(bad, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  fs.writeFileSync(sf, '{ nope');
  assert.throws(() => DI.install({ home: bad, scriptPath: '/x/delegate.js' }), /Could not parse/);
  assert.equal(fs.readFileSync(sf, 'utf8'), '{ nope');
  assert.equal(fs.existsSync(path.join(bad, '.claude', 'agents', 'buddy-reader.md')), false, 'nothing half-installed');
});

// ── usage.js: context diet ──────────────────────────────────────────────────
const NOW = 1789040000000;
const turn = (ts, prompt, extra = {}) => ({ ts: NOW - ts, sessionId: 'c1', modelKey: 'opus', subagent: false, input: 0, output: 100, cacheRead: prompt, cacheWrite: 0, ...extra });

test('contextDiet: low = tokens × cache-write price; high adds cache reads × median turns left before compaction', () => {
  // Prompt grows each turn; the 60k→20k drop at -50s is a compaction.
  const turns = [turn(100000, 10000), turn(90000, 20000), turn(80000, 30000), turn(70000, 40000), turn(60000, 60000), turn(50000, 20000), turn(40000, 25000)];
  const ev = (ago, tokens, sessionId = 'c1') => ({ at: new Date(NOW - ago).toISOString(), sessionId, kind: 'read-narrowed', tokensAvoided: tokens });
  assert.equal(U.turnsRemaining(turns.map((t) => ({ ...t })), NOW - 95000), 4, 'four turns, then the compaction');
  // Events after turn 1 (4 left) and after turn 3 (2 left): median 3.
  const d = U.contextDiet([ev(95000, 1e6), ev(75000, 1e6), ev(10 * 86400000, 5e6)], turns, { days: 7, now: NOW });
  assert.equal(d.events, 2);
  assert.equal(d.tokens, 2e6);
  assert.equal(d.low, 2 * 6.25);
  assert.equal(d.high, 2 * 6.25 + 2 * 0.5 * 3);
  // A session with no transcript yet: priced at the most-used model, no re-reads.
  const lone = U.contextDiet([ev(1000, 1e6, 'zz')], [...turns, turn(5000, 100, { sessionId: 'x', modelKey: 'sonnet' })], { days: 7, now: NOW });
  assert.equal(lone.low, 6.25);
  assert.equal(lone.high, 6.25);
  assert.equal(U.contextDiet([{ at: new Date(NOW).toISOString(), sessionId: 'c1', kind: 'policy-injected', tokensAvoided: 0 }], turns, { now: NOW }).events, 0);
});

// ── rules.js: delegated-read ────────────────────────────────────────────────
test('rules: delegated-read fires for 10 s after a session delegated something', () => {
  assert.ok(R.SIGNALS.some((s) => s.id === 'delegated-read' && s.kind === 'virtual'));
  const now = Date.parse('2026-09-10T10:00:00Z');
  const s = (ago) => ({ sessionId: 'a', signal: 'tool-use', cwd: '/p', updatedAt: new Date(now).toISOString(), delegated: { reads: 2, trims: 0, at: new Date(now - ago).toISOString() } });
  const fired = (ago) => R.virtualSessions([s(ago)], now).some((v) => v.signal === 'delegated-read');
  assert.equal(fired(3000), true);
  assert.equal(fired(R.DELEGATED_MS + 1), false);
  assert.equal(R.virtualSessions([{ sessionId: 'b', signal: 'tool-use', updatedAt: new Date(now).toISOString() }], now).some((v) => v.signal === 'delegated-read'), false);
  const rules = [...R.defaultRules(), { id: 'deleg', name: 'Delegated', enabled: true, when: { signal: ['delegated-read'] }, then: { pose: 'munch' } }];
  rules.unshift(rules.pop());
  assert.equal(R.resolve(rules, [s(1000)], now).look.pose, 'munch');
});
