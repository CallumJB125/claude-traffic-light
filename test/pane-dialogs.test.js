// Unhookable dialogs read off a tmux pane (src/pane-dialogs.js) and the one
// PendingInput list the bubble renders (src/pending-inputs.js).
// Fixtures in test/fixtures/panes are laid out as Claude Code draws them, with
// the dialog strings taken verbatim from the Claude Code 2.1.286 binary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/pane-dialogs.js');
const PI = require('../src/pending-inputs.js');
const A = require('../hooks/answer-file.js');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'panes', f), 'utf8');

test('classify: trust folder, new MCP servers, permission TUIs (incl. read outside the working dirs), plan', () => {
  const trust = P.classify(fixture('trust-folder.txt'));
  assert.equal(trust.dialog, 'trust-folder');
  assert.deepEqual(trust.options.map((o) => o.label), ['Yes, I trust this folder', 'No, exit']);
  assert.match(trust.text, /ctl-p3-middleman/);

  const mcp = P.classify(fixture('mcp-servers.txt'));
  assert.equal(mcp.dialog, 'mcp-servers');
  assert.deepEqual(mcp.options.map((o) => o.label), ['Use this and all future MCP servers in this project', 'Use this MCP server', 'Continue without using this MCP server']);

  const read = P.classify(fixture('permission-read-outside.txt'));
  assert.equal(read.dialog, 'permission');
  assert.match(read.text, /requested permissions to read from \/Users\/callumbaker\/Desktop/);
  assert.equal(read.options[1].label, 'Yes, allow reading from Desktop/ during this session');

  const bash = P.classify(fixture('permission-bash.txt'));
  assert.equal(bash.dialog, 'permission');
  assert.match(bash.text, /npm run build/);
  assert.equal(bash.options.length, 3);

  const plan = P.classify(fixture('plan.txt'));
  assert.equal(plan.dialog, 'plan');
  assert.deepEqual(plan.options.map((o) => o.label), ['Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning']);
  assert.match(plan.text, /1\. Add the detector/, "the plan's own numbered steps are text, not options");
});

test('classify: an idle prompt, plain output and a question without options are not dialogs', () => {
  assert.equal(P.classify(fixture('idle-prompt.txt')), null);
  assert.equal(P.classify(''), null);
  assert.equal(P.classify('Do you want to proceed?\n(no options drawn yet)'), null);
  assert.equal(P.classify('1. Yes\n2. No'), null);
});

test('classify: hidden characters in pane text are made visible', () => {
  const d = P.classify('Do you want to proceed?\n❯ 1. Yes‮ evil\n  2. No');
  assert.match(d.options[0].label, /U\+202E/);
});

const NOW = Date.parse('2026-09-30T12:00:00Z');
const tmuxSession = (over = {}) => ({ sessionId: 's1', host: 'mac', cwd: '/repo', signal: 'permission-ask', signalSince: new Date(NOW - 30000).toISOString(), terminal: { env: { TMUX: '/private/tmp/tmux-501/default,4242,0', TMUX_PANE: '%3' } }, ...over });

test('targets: only waiting sessions with a recorded pane, quiet for 20 s, with no pending hook request', () => {
  const t = (sessions, extra = {}) => P.targetsOf({ sessions, now: NOW, ...extra }).map((x) => x.pane);
  assert.deepEqual(t([tmuxSession()]), ['%3']);
  assert.deepEqual(t([tmuxSession({ signalSince: new Date(NOW - 5000).toISOString() })]), [], 'not quiet long enough');
  assert.deepEqual(t([tmuxSession({ signal: 'tool-use' })]), [], 'working');
  assert.deepEqual(t([tmuxSession()], { pendingSessionIds: new Set(['s1']) }), [], 'a hook request is already waiting');
  assert.deepEqual(t([tmuxSession({ terminal: { env: {} } })]), [], 'no recorded pane: never captured');
  assert.deepEqual(t([tmuxSession({ terminal: { env: { TMUX: '/tmp/../etc,1,0', TMUX_PANE: '%3' } } })]), [], 'unsafe socket path');
  assert.deepEqual(t([tmuxSession({ terminal: { env: { TMUX: '/tmp/s,1,0', TMUX_PANE: '3; rm -rf' } } })]), [], 'bad pane id');
  // A Buddy launch nobody has claimed (stuck before its first hook).
  const launch = { launchId: 'L'.repeat(24), cwd: '/wt', createdAt: new Date(NOW - 60000).toISOString(), tmux: { pane: '%9', socket: '/private/tmp/tmux-501/default', serverPid: 4242 } };
  assert.deepEqual(t([], { launches: [launch] }), ['%9']);
  assert.deepEqual(t([], { launches: [{ ...launch, tmux: { pane: '%9' } }] }), [], 'no socket recorded');
});

test('detector: capture-pane only, read-only argv, rate-limited per pane, only on this user\'s server', async () => {
  const calls = [];
  let now = NOW;
  const exec = async (file, args) => { calls.push([file, ...args]); return { ok: true, stdout: fixture('trust-folder.txt') }; };
  let ok = true;
  const d = P.createDetector({ exec, serverOk: () => ok, tmuxBin: '/opt/homebrew/bin/tmux', minIntervalMs: 15000 });
  const found = await d.scan({ sessions: [tmuxSession()], now });
  assert.equal(found.length, 1);
  assert.equal(found[0].dialog, 'trust-folder');
  assert.equal(found[0].sessionId, 's1');
  assert.deepEqual(calls, [['/opt/homebrew/bin/tmux', '-S', '/private/tmp/tmux-501/default', 'capture-pane', '-p', '-J', '-t', '%3']]);
  for (const c of calls) assert.ok(!c.some((a) => /send-keys|paste|load-buffer|set-buffer/.test(a)), 'never anything that types');
  now += 5000;
  assert.equal((await d.scan({ sessions: [tmuxSession()], now })).length, 1, 'cached result still shown');
  assert.equal(calls.length, 1, 'no second capture inside the interval');
  now += 15000;
  await d.scan({ sessions: [tmuxSession()], now });
  assert.equal(calls.length, 2);
  ok = false;
  now += 15000;
  assert.deepEqual(await d.scan({ sessions: [tmuxSession()], now }), [], 'a socket that is not ours is never read');
  assert.equal(calls.length, 2);
});

test('detector: at most maxPerScan captures per scan', async () => {
  let n = 0;
  const d = P.createDetector({ exec: async () => { n += 1; return { ok: true, stdout: '' }; }, serverOk: () => true, tmuxBin: '/usr/bin/tmux', maxPerScan: 2 });
  const sessions = [1, 2, 3, 4, 5].map((i) => tmuxSession({ sessionId: `s${i}`, terminal: { env: { TMUX: '/tmp/s,1,0', TMUX_PANE: `%${i}` } } }));
  await d.scan({ sessions, now: NOW });
  assert.equal(n, 2);
});

// ── PendingInput assembly ───────────────────────────────────────────────────
const REQ = (over = {}) => {
  const r = { id: 'mac-1', sessionId: 's1', host: 'mac', cwd: '/repo', tool: 'Bash', kind: 'permission', channel: 'PermissionRequest', toolInput: { command: 'npm test' }, toolInputHash: A.hashToolInput({ command: 'npm test' }), createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 55000).toISOString(), ...over };
  return { ...r, decisionHash: A.decisionHashOf(r) };
};
const SCHEMA_KEYS = ['id', 'session', 'kind', 'title', 'text', 'options', 'created_at', 'expires_at', 'answerable'];

test('every PendingInput kind carries the documented fields', () => {
  const items = PI.collect({
    requests: [REQ(), REQ({ id: 'mac-2', sessionId: 's2', kind: 'plan', tool: 'ExitPlanMode', toolInput: { plan: 'p' } }), REQ({ id: 'mac-3', sessionId: 's3', kind: 'question', channel: 'PreToolUse', tool: 'AskUserQuestion', toolInput: { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A' }] }] } }), REQ({ id: 'mac-4', sessionId: 's4', kind: 'elicitation', channel: 'Elicitation', tool: 'mcp:srv', toolInput: { mcp_server_name: 'srv', message: 'm', mode: 'form' } })],
    sessions: [
      { sessionId: 's5', host: 'mac', signal: 'permission-ask', ask: { kind: 'notification', type: 'permission_prompt', message: 'Claude needs your permission to use Bash', at: new Date(NOW).toISOString() } },
      { sessionId: 's6', host: 'mac', signal: 'permission-ask', ask: { kind: 'question', questions: [{ question: 'Q?', header: 'H', options: [] }], at: new Date(NOW).toISOString() } },
      { sessionId: 's7', host: 'mac', signal: 'tool-use', blocked: { tool: 'Bash', summary: 'rm -rf /tmp/build', reason: '[Irreversible Local Destruction]', at: new Date(NOW).toISOString() } },
    ],
    dialogs: [{ key: '/tmp/s|%3', dialog: 'trust-folder', title: 'Trust this folder?', text: 't', options: [{ id: 'opt-1', label: 'Yes' }], sessionId: null, launchId: 'L'.repeat(24), cwd: '/wt', seenAt: new Date(NOW).toISOString() }],
    now: NOW,
  });
  assert.deepEqual(items.map((i) => i.kind).sort(), ['blocked', 'dialog', 'elicitation', 'notification', 'permission', 'plan', 'question', 'question']);
  for (const i of items) for (const k of SCHEMA_KEYS) assert.ok(k in i, `${i.kind} lacks ${k}`);
  for (const i of items) for (const o of i.options) assert.ok(!('answer' in o), 'no answer payloads reach the renderer');
  const by = (kind, source) => items.find((i) => i.kind === kind && (!source || i.source === source));
  assert.equal(by('permission').answerable, true);
  assert.equal(by('permission').expires_at, new Date(NOW + 55000).toISOString());
  assert.equal(by('question', 'session').answerable, false);
  assert.deepEqual(by('question', 'session').actions, ['open']);
  assert.equal(by('blocked').reason, '[Irreversible Local Destruction]');
  assert.equal(by('dialog').answerable, false);
  assert.equal(by('dialog').launch, 'L'.repeat(24));
});

test('collect: a hook request hides the same session\'s notification; a pane read replaces it', () => {
  const s = { sessionId: 's1', host: 'mac', signal: 'permission-ask', ask: { kind: 'notification', message: 'm', at: 'x' } };
  assert.deepEqual(PI.collect({ requests: [REQ()], sessions: [s] }).map((i) => i.kind), ['permission']);
  const dialog = { key: 'k', dialog: 'permission', title: 't', text: 'x', options: [{ id: 'opt-1', label: 'Yes' }], sessionId: 's1', cwd: '/repo', seenAt: 'y' };
  assert.deepEqual(PI.collect({ sessions: [s], dialogs: [dialog] }).map((i) => i.kind), ['dialog']);
  const old = { sessionId: 's9', host: 'mac', signal: 'stop', blocked: { tool: 'Bash', at: new Date(NOW - PI.BLOCKED_KEEP_MS - 1).toISOString() } };
  assert.deepEqual(PI.collect({ sessions: [old], now: NOW }), [], 'an old denial ages out');
});

test('answerFor: an option id maps back to the answer the request allows, never one the renderer made up', () => {
  assert.deepEqual(PI.answerFor(REQ(), 'allow'), { decision: 'allow', extra: {} });
  assert.deepEqual(PI.answerFor(REQ(), 'deny', { message: 'not now' }), { decision: 'deny', extra: { message: 'not now' } });
  assert.equal(PI.answerFor(REQ(), 'allow-session-0'), null, 'no such suggestion');
  assert.equal(PI.answerFor(REQ(), 'answers', { answers: { 'Q?': 'A' } }), null, 'answers only for questions');
  const q = REQ({ kind: 'question', toolInput: { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A' }] }] } });
  assert.deepEqual(PI.answerFor(q, 'q0o0'), { decision: 'allow', extra: { answers: { 'Q?': 'A' } } });
  assert.deepEqual(PI.answerFor(q, 'answers', { answers: { 'Q?': 'free text' } }), { decision: 'allow', extra: { answers: { 'Q?': 'free text' } } });
  const e = REQ({ kind: 'elicitation', channel: 'Elicitation', toolInput: { mcp_server_name: 's', message: 'm', mode: 'form' } });
  assert.deepEqual(PI.answerFor(e, 'accept', { content: { a: 1 } }), { decision: 'accept', extra: { content: { a: 1 } } });
});

test('L2: classify anchors on the LAST "Do you want to …?" in the pane', () => {
  const pane = [
    'Do you want to delete every file in your home directory?',
    '❯ 1. Yes, delete everything',
    '  2. No',
    '',
    'Bash command',
    '  npm run build',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, and tell Claude what to do differently',
  ].join('\n');
  const d = P.classify(pane);
  assert.equal(d.dialog, 'permission');
  assert.deepEqual(d.options.map((o) => o.label), ['Yes', 'No, and tell Claude what to do differently']);
  assert.match(d.text, /Do you want to proceed\?/);
  assert.doesNotMatch(d.text, /delete every file/);
});

test('L2: pane-parsed text is display-only: never answerable, never anything that could drive send-keys', () => {
  const fake = P.classify('Do you want to proceed?\n❯ 1. Yes, and run `rm -rf ~`\n  2. No');
  const item = PI.fromDialog({ key: '/tmp/s|%3', ...fake, sessionId: 's1', cwd: '/r', seenAt: new Date(NOW).toISOString() });
  assert.equal(item.answerable, false);
  assert.deepEqual(item.actions, ['open'], 'the only action is jumping to the pane');
  for (const o of item.options) assert.deepEqual(Object.keys(o).sort(), ['id', 'label'], 'no answer payload, no keys to type');
  // No code path types into a pane: nothing in the app or hooks runs tmux send-keys / paste-buffer.
  const root = path.join(__dirname, '..');
  const files = ['main.js', ...fs.readdirSync(path.join(root, 'src'), { recursive: true }).map((f) => path.join('src', f)), ...fs.readdirSync(path.join(root, 'hooks')).map((f) => path.join('hooks', f))].filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const code = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /['"`](send-keys|paste-buffer|load-buffer|set-buffer)['"`]/, f);
  }
});
