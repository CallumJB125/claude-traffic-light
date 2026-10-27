const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../src/session-timeline.js');
const R = require('../src/session-replay.js');
const Main = require('../src/session-timeline-main.js');

const HOME = '/Users/janedoe';
const CWD = `${HOME}/work/acme-app`;
const SID = '11111111-2222-3333-4444-555555555555';
const lines = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-timeline-'));

const PROMPT = 'Deploy acme-app to prod; the DB password=Hunter2Secret! and my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD, mail jane.doe@acme.example';
const REPLY = 'Deployed. I used AKIAIOSFODNN7EXAMPL3 from /Users/janedoe/.aws/credentials on janes-macbook.';
const claudeRows = [
  { type: 'user', cwd: CWD, gitBranch: 'fix/login', timestamp: '2026-10-07T08:00:00.000Z', message: { role: 'user', content: PROMPT } },
  { type: 'user', isMeta: true, cwd: CWD, timestamp: '2026-10-07T08:00:00.500Z', message: { role: 'user', content: 'meta, never a prompt' } },
  { type: 'assistant', requestId: 'r1', timestamp: '2026-10-07T08:00:01.000Z', message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 500 }, role: 'assistant', content: [
    { type: 'tool_use', id: 't0', name: 'Read', input: { file_path: `${CWD}/src/login.js` } },
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: `${CWD}/src/login.js` } },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: `export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 && curl -H "Authorization: Bearer abcdef0123456789abcdef0123456789" https://janedoe:pa55word@deploy.acme.example/hook && scp build.tgz janedoe@10.20.30.40:${HOME}/drop` } },
  ] } },
  { type: 'user', timestamp: '2026-10-07T08:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected" }] } },
  { type: 'assistant', isSidechain: true, timestamp: '2026-10-07T08:00:03.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Write', input: { file_path: `${CWD}/subagent.js` } }] } },
  { type: 'assistant', requestId: 'r2', timestamp: '2026-10-07T08:00:04.000Z', message: { id: 'm2', model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 50 }, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: REPLY }] } },
  { type: 'system', subtype: 'turn_duration', timestamp: '2026-10-07T08:00:04.100Z' },
  { type: 'assistant', requestId: 'r3', timestamp: '2026-10-07T08:01:00.000Z', message: { id: 'm3', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 10 }, role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: `${HOME}/notes/outside.md` } }] } },
  'not json at all',
];
const transitions = [
  { at: '2026-10-07T08:00:01.200Z', from: 'pre-tool', to: 'permission-ask' },
  { at: '2026-10-07T08:00:01.900Z', from: 'permission-ask', to: 'post-tool' },
  { at: '2026-10-07T08:00:30.000Z', from: 'stop', to: 'permission-ask' },
  { at: '2026-10-07T08:00:40.000Z', from: 'permission-ask', to: 'stop' },
];
const checkpoints = [{ turn: 1, at: Date.parse('2026-10-07T08:00:05Z'), approx: false, files: [{ path: 'src/login.js', status: 'M', add: 12, del: 3 }, { path: 'README.md', status: 'A', add: 4, del: 0 }] }];

function claudeTimeline(over = {}) {
  const tx = T.claudeEvents(lines(claudeRows));
  return T.build({ adapter: 'claude-code', sessionId: SID, cwd: CWD, branch: 'fix/login', transcript: { ...tx, partial: false }, transitions, checkpoints, ...over });
}

test('a Claude Code transcript becomes ordered events: asked, edited, ran, approvals, turn end with spend, checkpoint counts', () => {
  const tl = claudeTimeline();
  assert.deepEqual(tl.events.map((e) => `${e.kind}${e.answer ? `:${e.answer}` : ''}`),
    ['prompt', 'read', 'edit', 'command', 'approval:asked', 'approval:denied', 'turn-end', 'checkpoint', 'approval:asked', 'approval:unanswered', 'edit']);
  assert.ok(tl.events.every((e, i) => i === 0 || e.at >= tl.events[i - 1].at), 'oldest first');
  assert.equal(tl.events.find((e) => e.kind === 'edit').path, 'src/login.js', 'project paths are relative');
  assert.equal(tl.events.at(-1).path, `${HOME}/notes/outside.md`, 'a path outside the project stays as it was');
  assert.ok(!tl.events.some((e) => e.path === 'subagent.js'), 'sidechain lines are not the session');
  assert.equal(tl.events.filter((e) => e.kind === 'turn-end').length, 1, 'end_turn and turn_duration are one turn end');
  assert.equal(tl.events.find((e) => e.kind === 'approval' && e.answer === 'denied').tool, 'Bash');
  const end = tl.events.find((e) => e.kind === 'turn-end');
  assert.ok(end.spendUsd > 0 && end.spendUsd < tl.spend.usd, 'spend so far at the turn end, total includes the later turn');
  assert.deepEqual(tl.counts, { prompts: 1, files: 3, commands: 1, approvals: 2, answered: 0, denied: 1, failures: 0, turns: 1 });
  const login = tl.files.find((f) => f.path === 'src/login.js');
  assert.deepEqual([login.edits, login.add, login.del], [1, 12, 3]);
  assert.equal(tl.status, 'Working', 'a tool call after the last turn end means it is still going');
  assert.equal(claudeTimeline({ transcript: { ...T.claudeEvents(lines(claudeRows.slice(0, 7))), partial: false } }).status, 'Turn finished');
  assert.equal(tl.project, 'acme-app');
  assert.equal(T.build({ adapter: 'claude-code', sessionId: SID, cwd: CWD, state: { status: 'Waiting on you' }, transcript: { events: [], usage: [] } }).status, 'Waiting on you', 'the live state wins');
});

test('a Codex rollout becomes ordered events, without double prompts or commands', () => {
  const rows = lines([
    { timestamp: '2026-10-06T17:45:42.217Z', type: 'session_meta', payload: { cwd: '/work/voice' } },
    { timestamp: '2026-10-06T17:46:33.205Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/work/voice</cwd>\n</environment_context>' }] } },
    { timestamp: '2026-10-06T17:46:33.206Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'write the memo' }] } },
    { timestamp: '2026-10-06T17:46:33.207Z', type: 'event_msg', payload: { type: 'user_message', message: 'write the memo' } },
    { timestamp: '2026-10-06T17:46:38.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'python3 build_memo.py' }) } },
    { timestamp: '2026-10-06T17:46:39.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'python3 build_memo.py'] } } },
    { timestamp: '2026-10-06T17:46:39.500Z', type: 'event_msg', payload: { type: 'exec_approval_request' } },
    { timestamp: '2026-10-06T17:46:41.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /work/voice/memo.md\n*** Add File: /work/voice/notes.md\n*** End Patch' } },
    { timestamp: '2026-10-06T17:50:55.548Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'The memo is ready.' } },
  ]);
  const tl = T.build({ adapter: 'codex', sessionId: 'x', cwd: '/work/voice', transcript: { ...T.codexEvents(rows), partial: false } });
  assert.deepEqual(tl.events.map((e) => e.kind), ['prompt', 'command', 'approval', 'edit', 'edit', 'turn-end']);
  assert.deepEqual(tl.events.filter((e) => e.kind === 'edit').map((e) => e.path), ['memo.md', 'notes.md']);
  assert.equal(tl.events.at(-1).text, 'The memo is ready.');
  assert.equal(tl.spend, null, 'no spend is invented for Codex');
});

test('hook facts alone still give a timeline with what has times, and the recorded files and commands', () => {
  const facts = { cwd: '/work/app', startedAt: '2026-10-07T08:00:00.000Z', firstPrompt: 'first', lastPrompt: 'second', lastPromptAt: '2026-10-07T09:00:00.000Z', lastStopAt: '2026-10-07T09:05:00.000Z', lastAssistant: 'done', files: { '/work/app/a.js': 'edit', '/work/app/b.js': 'read' }, commands: ['npm test'], endedAt: '2026-10-07T09:06:00.000Z' };
  const tl = T.build({ adapter: 'gemini', sessionId: 'g1', facts });
  assert.equal(tl.source, 'hooks');
  assert.deepEqual(tl.events.map((e) => e.kind), ['start', 'prompt', 'prompt', 'turn-end', 'end']);
  assert.deepEqual(tl.files.map((f) => f.path), ['a.js']);
  assert.deepEqual(tl.commands, ['npm test']);
  assert.equal(tl.counts.commands, 1);
  assert.equal(tl.status, 'Ended');
});

test('the page view redacts secrets and shows the home folder as ~', () => {
  const v = T.forDisplay(claudeTimeline(), { home: HOME });
  const text = JSON.stringify(v);
  assert.doesNotMatch(text, /sk-ant-api03-abcdef|ghp_abcdefghij|Hunter2Secret/);
  assert.doesNotMatch(text, /\/Users\/janedoe/);
  assert.match(text, /~\/notes\/outside\.md/);
  assert.deepEqual(T.describe({ kind: 'turn-end', spendUsd: 1.5 }).spend, '$1.50 so far');
  assert.equal(T.describe({ kind: 'prompt', text: null }).hidden, true);
});

const opts = { home: HOME, user: 'janedoe', hostname: 'janes-macbook.local', now: Date.parse('2026-10-08T10:00:00Z') };
const LEAKS = [/sk-ant-api03-abcdef/, /ghp_abcdefghij/, /Hunter2Secret/, /AKIAIOSFODNN7EXAMPL3/, /abcdef0123456789abcdef0123456789/, /pa55word/, /janedoe/i, /jane\.doe@/, /10\.20\.30\.40/, /janes-macbook/i, /\/Users\/(?!\[user\])/, new RegExp(SID)];

test('Export replay scrubs a realistic transcript: no secrets, user names, home paths, emails, IPs, host name or session id', () => {
  for (const includePrompts of [false, true]) {
    const { html, model } = R.exportReplay(claudeTimeline(), { ...opts, includePrompts });
    for (const re of LEAKS) assert.doesNotMatch(html, re, `includePrompts=${includePrompts} leaked ${re}`);
    for (const re of LEAKS) assert.doesNotMatch(JSON.stringify(model), re, `model leaked ${re}`);
    assert.match(html, /src\/login\.js/, 'project-relative paths stay readable');
    assert.match(html, /~\/notes\/outside\.md/);
    assert.match(html, /\[user\]@/);
    assert.match(html, /\[redacted\]/);
  }
});

test('the export is one self-contained file: no scripts, no src or href, no external URLs it could load', () => {
  const { html } = R.exportReplay(claudeTimeline(), { ...opts, includePrompts: true });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\b(?:src|href|srcset|action|poster|data)\s*=/i);
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /<(?:link|img|iframe|object|embed|base|form|meta http-equiv="refresh")/i);
  assert.doesNotMatch(html, /url\(|@import/i);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/);
  assert.match(html, /^<!doctype html>/);
});

test('prompt text and AI replies are left out by default and in only when ticked', () => {
  const off = R.exportReplay(claudeTimeline(), opts);
  assert.equal(off.model.includePrompts, false);
  assert.doesNotMatch(off.html, /Deploy acme-app to prod/);
  assert.doesNotMatch(off.html, /Deployed\. I used/);
  assert.match(off.html, /Prompt text not included/);
  assert.ok(off.model.events.filter((e) => e.kind === 'prompt' || e.kind === 'turn-end').every((e) => e.text === undefined));
  assert.ok(off.summary.excluded.some((x) => /asked and its replies/.test(x)));
  assert.ok(!off.summary.included.some((x) => /asked and its replies/.test(x)));
  assert.match(off.html, /What this file contains/);
  const on = R.exportReplay(claudeTimeline(), { ...opts, includePrompts: true });
  assert.match(on.html, /Deploy acme-app to prod; the DB password=\[redacted\]/);
  assert.match(on.html, /Deployed\. I used \[redacted\] from ~\/\.aws\/credentials on \[host\]/);
  assert.ok(on.summary.included.some((x) => /1 prompt\b/.test(x)));
});

test('the summary says what is in the file before it is saved, and the file name is never a path', () => {
  const { summary, model } = R.exportReplay(claudeTimeline(), opts);
  assert.ok(summary.included.some((x) => x.startsWith('Files edited: 3')));
  assert.ok(summary.included.some((x) => x.startsWith('Approvals: 2 asked, 0 answered, 1 denied')));
  assert.ok(summary.included.some((x) => /^Spend so far: \$/.test(x)));
  assert.ok(summary.excluded.includes('The session id'));
  assert.equal(R.fileName(model), 'acme-app-replay.html');
  assert.equal(R.fileName({ project: '../../etc/passwd' }), 'etc-passwd-replay.html');
});

test('readTranscript reads a transcript file, bounded, and ignores other adapters', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, lines(claudeRows).join('\n') + '\n');
  const tx = T.readTranscript(file, 'claude-code');
  assert.equal(tx.partial, false);
  assert.equal(tx.events[0].kind, 'prompt');
  assert.equal(tx.usage.length, 3);
  assert.equal(T.readTranscript(file, 'gemini'), null);
  assert.equal(T.readTranscript(path.join(dir, 'missing.jsonl'), 'claude-code'), null);
});

function fakeIpc() {
  const handlers = new Map();
  return { handlers, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, call: (name, e, ...a) => handlers.get(name)(e, ...a) };
}

test('main: only the Sessions page opens a timeline, only the Timeline page reads or exports, and export writes just the chosen file', async (t) => {
  const home = tmp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = path.join(home, '.claude', 'projects', '-work-app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), lines(claudeRows).join('\n') + '\n');
  const { ipcMain, call } = fakeIpc();
  const sessionsPage = { id: 'sessions' }, timelinePage = { id: 'timeline' }, other = { id: 'other' };
  const opened = [], saves = [];
  const out = path.join(home, 'out', 'replay.html');
  fs.mkdirSync(path.dirname(out));
  const api = Main.register({
    ipcMain, rootDir: home, home: HOME, user: 'janedoe', hostname: 'janes-macbook',
    sessions: () => ({ live: [{ sessionId: SID, cwd: CWD, updatedAt: '2026-10-07T08:01:00.000Z', signal: 'stop' }] }),
    sessionsAllowed: (e) => e.sender === sessionsPage, pageAllowed: (e) => e.sender === timelinePage,
    openPage: (id) => opened.push(id), transitions: () => transitions, checkpointTurns: async () => checkpoints,
    dialog: { showSaveDialog: async (win, o) => { saves.push(o); return saves.length === 1 ? { canceled: true } : { canceled: false, filePath: out }; } },
    BrowserWindow: { fromWebContents: () => null }, downloads: () => path.join(home, 'Downloads'),
    locator: { find: (a, id) => (a === 'claude-code' && id === SID ? path.join(proj, `${SID}.jsonl`) : null) },
  });
  const key = `claude-code-${SID}`;
  assert.equal(await call('timeline:open', { sender: other }, key), false);
  assert.equal(await call('timeline:open', { sender: sessionsPage }, '../x'), false);
  assert.equal(await call('timeline:open', { sender: sessionsPage }, key), true);
  assert.deepEqual(opened, ['timeline']);
  assert.equal(await call('timeline:load', { sender: sessionsPage }, key), null);
  const r = await call('timeline:load', { sender: timelinePage }, null);
  assert.equal(r.key, key);
  assert.equal(r.view.status, 'Turn stopped', 'the live session state wins');
  assert.ok(r.view.events.every((e) => typeof e.label === 'string'));
  assert.doesNotMatch(JSON.stringify(r), /sk-ant-api03-abcdef|\/Users\/janedoe/);
  const list = await call('timeline:list', { sender: timelinePage });
  assert.deepEqual(list.sessions.map((s) => s.label), ['Claude Code · acme-app']);
  const preview = await call('timeline:preview', { sender: timelinePage }, key, false);
  assert.ok(preview.excluded.some((x) => /asked and its replies/.test(x)));
  assert.equal(await call('timeline:export', { sender: other }, key, false), null);
  assert.deepEqual(await call('timeline:export', { sender: timelinePage }, key, false), { ok: false, cancelled: true });
  assert.equal(saves[0].defaultPath, path.join(home, 'Downloads', 'acme-app-replay.html'));
  assert.deepEqual(await call('timeline:export', { sender: timelinePage }, key, 'yes'), { ok: true, name: 'replay.html' });
  const html = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(html, /Deploy acme-app to prod/, 'only a real true includes prompts');
  for (const re of LEAKS) assert.doesNotMatch(html, re);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['replay.html']);
  assert.equal(api.openSession({ adapter: 'claude-code', sessionId: '../../x' }), false);
  assert.equal(api.openSession({ adapter: 'codex', sessionId: 'abc' }), true);
  assert.equal(api.current().sessionId, 'abc');
});

test('wiring: Sessions and the board card open the timeline page, which is registered and packaged', () => {
  const root = path.join(__dirname, '..');
  const { pageById } = require('../buddy-window/pages.js');
  const p = pageById('timeline');
  assert.deepEqual([p.kind, p.file, p.preload, p.unlisted], ['local', 'timeline.html', 'timeline-preload.js', true]);
  const files = require('../package.json').build.files;
  for (const f of ['timeline.html', 'timeline.css', 'timeline.js', 'timeline-preload.js']) assert.ok(files.includes(f), f);
  assert.match(fs.readFileSync(path.join(root, 'sessions-preload.js'), 'utf8'), /timeline: key => ipcRenderer\.invoke\('timeline:open', key\)/);
  assert.match(fs.readFileSync(path.join(root, 'board/web/js/render-drawer.js'), 'utf8'), /'data-action': 'open-timeline'/);
  assert.match(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), /pageAllowed: \(e\) => fromUtilityPage\(e, 'timeline'\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'timeline.html'), 'utf8'), /https?:\/\//);
});

// Redesign R2a: the chat-first thread reads one main-resolved local session's
// activity through the Timeline page's own display sanitising.
test('main: threadActivity is sanitised like timeline:load and leaves the page selection alone', async (t) => {
  const home = tmp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = path.join(home, '.claude', 'projects', '-work-app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), lines(claudeRows).join('\n') + '\n');
  const { ipcMain, call } = fakeIpc();
  const timelinePage = { id: 'timeline' };
  const api = Main.register({
    ipcMain, rootDir: home, home: HOME, user: 'janedoe', hostname: 'janes-macbook',
    sessions: () => ({ live: [{ sessionId: SID, cwd: CWD, updatedAt: '2026-10-07T08:01:00.000Z', signal: 'stop' }] }),
    sessionsAllowed: () => false, pageAllowed: (e) => e.sender === timelinePage,
    openPage: () => {}, transitions: () => transitions, checkpointTurns: async () => checkpoints,
    dialog: {}, BrowserWindow: { fromWebContents: () => null }, downloads: () => home,
    locator: { find: (a, id) => (a === 'claude-code' && id === SID ? path.join(proj, `${SID}.jsonl`) : null) },
  });
  const r = await api.threadActivity({ source: 'claude', sessionId: SID });
  assert.equal(api.current(), null, "a thread read doesn't pick the Timeline page's session");
  const page = await call('timeline:load', { sender: timelinePage }, `claude-code-${SID}`);
  assert.deepEqual(r.view, page.view, 'exactly the Timeline page display');
  assert.doesNotMatch(JSON.stringify(r), /sk-ant-api03-abcdef|\/Users\/janedoe/);
  assert.deepEqual(await api.threadActivity({ source: 'claude', sessionId: 'not-listed' }), { empty: 'Nothing to show for this session yet.' });
  assert.equal(await api.threadActivity({ source: 'claude', sessionId: '../x' }), null);
  assert.equal(await api.threadActivity(null), null);
});
