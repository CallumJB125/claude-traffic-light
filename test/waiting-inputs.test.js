// Every hookable waiting input (docs/waiting-inputs.md): what the blocking
// hook records for each kind, how a widget answer becomes the hook's output,
// the fall-back to the terminal when nothing (or nothing valid) arrives, and
// the ask/blocked/owned fields the session file carries for the widget.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const A = require('../hooks/answer-file.js');
const I = require('../hooks/pending-input.js');
const Owned = require('../hooks/owned.js');
const { fakeApp } = require('./fake-app.js');
const KEY = require('crypto').randomBytes(32);

const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-inputs-'));
const HOST = os.hostname().split('.')[0];

const QUESTION_INPUT = { questions: [{ question: 'Which framework?', header: 'Framework', options: [{ label: 'React', description: 'hooks' }, { label: 'Vue' }], multiSelect: false }] };

function hook(signal, home, port, payload, { askMs = 5000, env = {} } = {}) {
  const child = spawn(process.execPath, [SET_STATUS, signal], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ASK_MS: String(askMs), CLAUDE_TRAFFIC_LIGHT_PORT: String(port), ...env } });
  child.stdin.end(JSON.stringify(payload));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.done = new Promise((res) => child.on('exit', (code) => res({ out, code })));
  return child;
}
function runSync(signal, home, payload, env = {}) {
  const r = spawnSync(process.execPath, [SET_STATUS, signal], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, ...env } });
  assert.equal(r.status, 0);
  return r.stdout.toString();
}
async function oneRequest(dir) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.endsWith('.json'));
    if (f) return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Date.now() > deadline) throw new Error('no request');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const session = (home, id = 's') => JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${HOST}-${id}.json`), 'utf8'));

// ── pure: answers → hook output ─────────────────────────────────────────────
test('permission: allow once, deny with a message, and a suggestion only ever for this session', () => {
  const req = { kind: 'permission', channel: 'PermissionRequest', tool: 'Read', toolInput: { file_path: '/elsewhere/x' },
    permissionSuggestions: I.cleanSuggestions([{ type: 'addDirectories', directories: ['/elsewhere'], destination: 'localSettings' }, { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Read', ruleContent: '/elsewhere/**' }], destination: 'userSettings' }]) };
  assert.deepEqual(I.answerOutput(req, { decision: 'allow' }), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(I.answerOutput(req, { decision: 'deny', extra: { message: 'use the repo copy' } }).hookSpecificOutput.decision, { behavior: 'deny', message: 'use the repo copy' });
  const sh = (i) => A.hashToolInput(req.permissionSuggestions[i]);
  assert.deepEqual(I.answerOutput(req, { decision: 'allow', extra: { permissionIndex: 0, suggestionHash: sh(0) } }).hookSpecificOutput.decision,
    { behavior: 'allow', updatedPermissions: [{ type: 'addDirectories', directories: ['/elsewhere'], destination: 'session' }] });
  assert.equal(I.answerOutput(req, { decision: 'allow', extra: { permissionIndex: 1, suggestionHash: sh(1) } }).hookSpecificOutput.decision.updatedPermissions[0].destination, 'session');
  assert.equal(I.answerOutput(req, { decision: 'allow', extra: { permissionIndex: 5, suggestionHash: sh(0) } }), null, 'no such suggestion');
  assert.equal(I.answerOutput(req, { decision: 'allow', extra: { permissionIndex: 0 } }), null, 'unbound index');
  assert.equal(I.answerOutput(req, { decision: 'allow', extra: { permissionIndex: 1, suggestionHash: sh(0) } }), null, 'the label clicked is not the rule at that index');
  assert.equal(I.answerOutput(req, { decision: 'accept' }), null, 'wrong decision for the kind');
  const view = I.viewOf(req);
  assert.deepEqual(view.options.map((o) => o.id), ['allow', 'allow-session-0', 'allow-session-1', 'deny']);
  assert.ok(I.answerOutput(req, view.options[2].answer), 'each option carries its own suggestion hash');
  assert.match(view.options[1].label, /Allow access to \/elsewhere for this session/);
});

test('permission suggestions: bypass/auto modes and deny rules are never offered', () => {
  const s = I.cleanSuggestions([{ type: 'setMode', mode: 'bypassPermissions' }, { type: 'setMode', mode: 'auto' }, { type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash' }] }, { type: 'removeRules', rules: [] }, { type: 'setMode', mode: 'acceptEdits' }]);
  assert.deepEqual(s, [{ type: 'setMode', mode: 'acceptEdits' }]);
});

test('plan: approve, approve with auto-accept edits, keep planning', () => {
  const req = { kind: 'plan', channel: 'PermissionRequest', tool: 'ExitPlanMode', toolInput: { plan: '## Plan\n1. do it' } };
  const view = I.viewOf(req);
  assert.equal(view.text, '## Plan\n1. do it');
  assert.deepEqual(I.answerOutput(req, view.options[0].answer).hookSpecificOutput.decision, { behavior: 'allow' });
  assert.deepEqual(I.answerOutput(req, view.options[1].answer).hookSpecificOutput.decision, { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  assert.equal(I.answerOutput(req, view.options[2].answer).hookSpecificOutput.decision.behavior, 'deny');
});

test('question: the answer must cover every question; PreToolUse echoes the questions with answers', () => {
  const req = { kind: 'question', channel: 'PreToolUse', tool: 'AskUserQuestion', toolInput: QUESTION_INPUT };
  const view = I.viewOf(req);
  assert.deepEqual(view.options.map((o) => o.label), ['React', 'Vue', 'Decline to answer']);
  assert.equal(view.title, 'Framework');
  assert.deepEqual(I.answerOutput(req, view.options[0].answer), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...QUESTION_INPUT, answers: { 'Which framework?': 'React' } } } });
  // Free text is fine (the terminal offers "Other" too); a missing or foreign question is not.
  assert.ok(I.answerOutput(req, { decision: 'allow', extra: { answers: { 'Which framework?': 'Svelte' } } }));
  assert.equal(I.answerOutput(req, { decision: 'allow' }), null);
  assert.equal(I.answerOutput(req, { decision: 'allow', extra: { answers: { 'Other?': 'x' } } }), null);
  assert.equal(I.answerOutput(req, { decision: 'allow', extra: { answers: { 'Which framework?': 'React', extra: 'x' } } }), null);
  assert.deepEqual(I.answerOutput(req, { decision: 'deny' }).hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: I.DENY_MESSAGE });
  const multi = I.viewOf({ ...req, toolInput: { questions: [QUESTION_INPUT.questions[0], { question: 'Tests?', header: 'Tests', options: [{ label: 'Yes' }], multiSelect: true }] } });
  assert.equal(multi.questions.length, 2);
  assert.deepEqual(multi.options.map((o) => o.id), ['deny'], 'several questions: answers are built from `questions`');
});

test('elicitation: accept with content, decline, cancel; allow/deny are refused', () => {
  const req = { kind: 'elicitation', channel: 'Elicitation', tool: 'mcp:srv', toolInput: { mcp_server_name: 'srv', message: 'Your name?', mode: 'form', requested_schema: { type: 'object', properties: { name: { type: 'string' } } } } };
  assert.deepEqual(I.answerOutput(req, { decision: 'accept', extra: { content: { name: 'Callum' } } }), { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { name: 'Callum' } } });
  assert.deepEqual(I.answerOutput(req, { decision: 'decline' }), { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' } });
  assert.equal(I.answerOutput(req, { decision: 'allow' }), null);
  assert.equal(I.viewOf(req).options[0].needsContent, true);
});

test('answer files: extras are shape-checked before they are written', () => {
  const dir = tmp();
  const input = { command: 'ls' };
  const r = { id: 'r', kind: 'permission', channel: 'PermissionRequest', tool: 'Bash', toolInput: input, toolInputHash: A.hashToolInput(input), permissionSuggestions: [{ type: 'setMode', mode: 'acceptEdits' }] };
  r.decisionHash = A.decisionHashOf(r);
  fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(r));
  for (const extra of [{ answers: 'React' }, { permissionIndex: -1 }, { mode: 'bypassPermissions' }, { sneaky: 1 }, { suggestionHash: 'x' }]) assert.equal(A.writeAnswer(dir, 'r', 'allow', { key: KEY, extra }).ok, false, JSON.stringify(extra));
  assert.equal(A.writeAnswer(dir, 'r', 'allow', { key: KEY, extra: { permissionIndex: 0 } }).ok, true);
  assert.deepEqual(A.consumeAnswerDetail(dir, 'r', r.decisionHash, KEY), { decision: 'allow', extra: { permissionIndex: 0, suggestionHash: A.hashToolInput(r.permissionSuggestions[0]) } });
});

// ── the real hook ───────────────────────────────────────────────────────────
test('hook: ExitPlanMode is recorded as a plan with its text and answered through PermissionRequest', async () => {
  const home = tmp();
  const app = await fakeApp(home);
  try {
    const h = hook('permission-request', home, app.port, { session_id: 's', cwd: '/x', tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan', planFilePath: '/p.md' } });
    const req = await oneRequest(path.join(home, 'requests'));
    assert.equal(req.kind, 'plan');
    assert.equal(req.channel, 'PermissionRequest');
    assert.ok(Date.parse(req.expiresAt) > Date.parse(req.createdAt));
    assert.equal(session(home).ask.kind, 'plan');
    assert.equal(A.writeAnswer(path.join(home, 'requests'), req.id, 'allow', { key: app.keyFor(req.id), extra: { mode: 'acceptEdits' } }).ok, true);
    const { out, code } = await h.done;
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  } finally { app.close(); }
});

test('hook: a "read outside the working directories" request carries its suggestions; the session option works', async () => {
  const home = tmp();
  const app = await fakeApp(home);
  try {
    const h = hook('permission-request', home, app.port, { session_id: 's', cwd: '/repo', tool_name: 'Read', tool_input: { file_path: '/other/notes.md' }, permission_suggestions: [{ type: 'addDirectories', directories: ['/other'], destination: 'session' }] });
    const req = await oneRequest(path.join(home, 'requests'));
    assert.equal(req.kind, 'permission');
    assert.deepEqual(req.permissionSuggestions, [{ type: 'addDirectories', directories: ['/other'] }]);
    const opt = I.viewOf(req).options.find((o) => o.id === 'allow-session-0');
    assert.equal(A.writeAnswer(path.join(home, 'requests'), req.id, opt.answer.decision, { key: app.keyFor(req.id), extra: opt.answer.extra }).ok, true);
    assert.deepEqual(JSON.parse((await h.done).out).hookSpecificOutput.decision, { behavior: 'allow', updatedPermissions: [{ type: 'addDirectories', directories: ['/other'], destination: 'session' }] });
  } finally { app.close(); }
});

test('hook: an answer that does not fit the kind is refused and the terminal keeps the prompt', async () => {
  const home = tmp();
  const app = await fakeApp(home);
  try {
    const dir = path.join(home, 'requests');
    const h = hook('permission-request', home, app.port, { session_id: 's', cwd: '/x', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const req = await oneRequest(dir);
    const w = A.writeAnswer(dir, req.id, 'accept', { ack: true, key: app.keyFor(req.id) });
    assert.equal(await A.awaitTaken(dir, req.id, w.nonce, { timeoutMs: 3000 }), 'refused');
    assert.equal((await h.done).out, '');
  } finally { app.close(); }
});

test('hook: AskUserQuestion waits in PreToolUse only with askFromWidget on, and answers with updatedInput', async () => {
  const home = tmp();
  const app = await fakeApp(home);
  try {
    const payload = { session_id: 's', cwd: '/x', tool_name: 'AskUserQuestion', tool_input: QUESTION_INPUT };
    // Off: no wait, no request, but the session shows the real question.
    assert.equal(runSync('tool-use', home, payload, { CLAUDE_TRAFFIC_LIGHT_PORT: String(app.port) }), '');
    assert.equal(fs.existsSync(path.join(home, 'requests')), false);
    const s = session(home);
    assert.equal(s.signal, 'permission-ask');
    assert.deepEqual(s.ask.questions[0].options.map((o) => o.label), ['React', 'Vue']);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ askFromWidget: true }));
    const h = hook('tool-use', home, app.port, { ...payload, session_id: 's2' });
    const req = await oneRequest(path.join(home, 'requests'));
    assert.equal(req.kind, 'question');
    assert.equal(req.channel, 'PreToolUse');
    const opt = I.viewOf(req).options[1];
    assert.equal(A.writeAnswer(path.join(home, 'requests'), req.id, opt.answer.decision, { key: app.keyFor(req.id), extra: opt.answer.extra }).ok, true);
    const out = JSON.parse((await h.done).out).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'allow');
    assert.deepEqual(out.updatedInput.answers, { 'Which framework?': 'Vue' });
  } finally { app.close(); }
});

test('hook: a PermissionRequest for AskUserQuestion passes straight through (no second wait)', async () => {
  const home = tmp();
  const app = await fakeApp(home);
  try {
    const t0 = Date.now();
    const out = runSync('permission-request', home, { session_id: 's', cwd: '/x', tool_name: 'AskUserQuestion', tool_input: QUESTION_INPUT }, { CLAUDE_TRAFFIC_LIGHT_PORT: String(app.port), CLAUDE_TRAFFIC_LIGHT_ASK_MS: '5000' });
    assert.equal(out, '');
    assert.ok(Date.now() - t0 < 3000);
  } finally { app.close(); }
});

test('hook: Elicitation is recorded and answered with an action', async () => {
  const home = tmp();
  const app = await fakeApp(home);
  try {
    const h = hook('elicitation', home, app.port, { session_id: 's', cwd: '/x', hook_event_name: 'Elicitation', mcp_server_name: 'srv', message: 'Pick a branch', mode: 'form', requested_schema: { type: 'object', properties: { branch: { type: 'string' } } } });
    const req = await oneRequest(path.join(home, 'requests'));
    assert.equal(req.kind, 'elicitation');
    assert.equal(session(home).signal, 'permission-ask');
    assert.equal(A.writeAnswer(path.join(home, 'requests'), req.id, 'accept', { key: app.keyFor(req.id), extra: { content: { branch: 'main' } } }).ok, true);
    assert.deepEqual(JSON.parse((await h.done).out), { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { branch: 'main' } } });
  } finally { app.close(); }
});

test('hook: no answer in time → no output (the terminal prompt), never an automatic allow or deny', async () => {
  const home = tmp();
  const app = await fakeApp(home);
  try {
    for (const [signal, payload] of [
      ['permission-request', { session_id: 's', cwd: '/x', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } }],
      ['elicitation', { session_id: 's', cwd: '/x', mcp_server_name: 'srv', message: 'm' }],
    ]) {
      const { out, code } = await hook(signal, home, app.port, payload, { askMs: 300 }).done;
      assert.equal(code, 0);
      assert.equal(out, '', signal);
    }
    assert.deepEqual(fs.readdirSync(path.join(home, 'requests')), []);
  } finally { app.close(); }
});

test('session: a notification ask keeps its words; a classifier denial is "blocked" until the next prompt', () => {
  const home = tmp();
  runSync('notification', home, { session_id: 's', cwd: '/x', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' });
  assert.deepEqual({ ...session(home).ask, at: undefined }, { kind: 'notification', type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash', at: undefined });
  runSync('permission-denied', home, { session_id: 's', cwd: '/x', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/build' }, reason: '[Irreversible Local Destruction]' });
  let s = session(home);
  assert.equal(s.ask, undefined, 'the ask is over');
  assert.equal(s.blocked.reason, '[Irreversible Local Destruction]');
  assert.equal(s.blocked.summary, 'rm -rf /tmp/build');
  runSync('tool-done', home, { session_id: 's', cwd: '/x', tool_name: 'Read' });
  assert.ok(session(home).blocked, 'kept while the turn goes on');
  runSync('prompt-submit', home, { session_id: 's', cwd: '/x' });
  s = session(home);
  assert.equal(s.blocked, undefined);
});

test('session: SessionStart records the tmux pane and socket, and ownership only with a matching launch record', () => {
  const home = tmp();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-owned-cwd-'));
  const tmuxEnv = { TMUX: '/private/tmp/tmux-501/default,123,0', TMUX_PANE: '%7' };
  // A made-up id: not owned.
  runSync('session-start', home, { session_id: 'a', cwd, source: 'startup' }, { ...tmuxEnv, BUDDY_OWNED: 'x'.repeat(24) });
  let s = session(home, 'a');
  assert.equal(s.owned, undefined);
  assert.equal(s.terminal.env.TMUX_PANE, '%7');
  assert.equal(s.terminal.env.TMUX, tmuxEnv.TMUX);
  // A real launch record: owned, and stays owned through later hooks.
  const { launchId } = Owned.recordLaunch(home, { launcher: 'test', cwd });
  runSync('session-start', home, { session_id: 'b', cwd, source: 'startup' }, { BUDDY_OWNED: launchId });
  runSync('prompt-submit', home, { session_id: 'b', cwd });
  s = session(home, 'b');
  assert.equal(s.owned.launchId, launchId);
  assert.equal(s.owned.launcher, 'test');
  // Another session (another process) presenting the same id, as a copied env would, is refused.
  const other = spawnSync(process.execPath, ['-e', `require('child_process').spawnSync(process.execPath, [${JSON.stringify(SET_STATUS)}, 'session-start'], { stdio: 'inherit' })`],
    { input: JSON.stringify({ session_id: 'c', cwd, source: 'startup' }), env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, BUDDY_OWNED: launchId } });
  assert.equal(other.status, 0);
  assert.equal(session(home, 'c').owned, undefined);
});

test('M2: broad suggestions are never offered — whole-tool Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch, wildcard rules, root/home/ancestor/relative/.. directories', () => {
  const home = os.homedir();
  const rule = (toolName, ruleContent) => ({ type: 'addRules', behavior: 'allow', rules: [ruleContent === undefined ? { toolName } : { toolName, ruleContent }] });
  const dirs = (...d) => ({ type: 'addDirectories', directories: d });
  const broad = [
    ...['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch'].map((t) => rule(t)),
    rule('Bash', '*'), rule('Bash', ':*'), rule('Bash', ''), rule('Bash', '  '), rule('Read', '*'), rule('WebFetch', ':*'),
    { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }, { toolName: 'Bash' }] },
    dirs('/'), dirs(home), dirs(`${home}/`), dirs(path.dirname(home)), dirs('/Users'), dirs('relative/dir'), dirs('~/work'), dirs(`${home}/work/../..`), dirs('/work', '/'),
  ];
  for (const s of broad) assert.deepEqual(I.cleanSuggestions([s]), [], JSON.stringify(s));
  const ok = [rule('Bash', 'npm test:*'), rule('Read'), rule('Edit', '/repo/src/**'), rule('WebFetch', 'domain:example.com'), dirs('/work'), dirs(path.join(home, 'code', 'proj')), { type: 'setMode', mode: 'acceptEdits' }];
  assert.equal(I.cleanSuggestions(ok).length, ok.length);
  // The PoC's suggestions: nothing survives.
  assert.deepEqual(I.describeHookInput('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x' }, permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash' }] }, { type: 'addDirectories', directories: ['/'], destination: 'userSettings' }] }).permissionSuggestions, []);
});

test('M2: answerOutput re-checks the suggestion before building updatedPermissions', () => {
  // A request whose suggestions were not cleaned (as if written by something other than this hook).
  const sugg = [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] }, { type: 'addDirectories', directories: ['/'] }, { type: 'addDirectories', directories: ['/work'] }];
  const req = { kind: 'permission', channel: 'PermissionRequest', tool: 'Bash', toolInput: { command: 'x' }, permissionSuggestions: sugg };
  for (const i of [0, 1]) assert.equal(I.answerOutput(req, { decision: 'allow', extra: { permissionIndex: i, suggestionHash: A.hashToolInput(sugg[i]) } }), null, `index ${i}`);
  assert.deepEqual(I.answerOutput(req, { decision: 'allow', extra: { permissionIndex: 2, suggestionHash: A.hashToolInput(sugg[2]) } }).hookSpecificOutput.decision.updatedPermissions, [{ type: 'addDirectories', directories: ['/work'], destination: 'session' }]);
});

test('L3: with askFromWidget on, AskUserQuestion waits in PreToolUse for 20 s at most', async () => {
  const home = tmp();
  const app = await fakeApp(home);
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ askFromWidget: true }));
    const h = hook('tool-use', home, app.port, { session_id: 'q', cwd: '/x', tool_name: 'AskUserQuestion', tool_input: QUESTION_INPUT }, { askMs: 55000 });
    const req = await oneRequest(path.join(home, 'requests'));
    const window = Date.parse(req.expiresAt) - Date.parse(req.createdAt);
    assert.ok(window <= 20000 && window > 15000, `waits ${window} ms`);
    assert.equal(A.writeAnswer(path.join(home, 'requests'), req.id, 'deny', { key: app.keyFor(req.id) }).ok, true);
    assert.equal(JSON.parse((await h.done).out).hookSpecificOutput.permissionDecision, 'deny');
  } finally { app.close(); }
});
