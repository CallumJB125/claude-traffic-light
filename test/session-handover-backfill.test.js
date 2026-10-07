const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Tap = require('../hooks/handover-tap.js');
const H = require('../src/session-handover.js');
const T = require('../src/handover-transcripts.js');
const Main = require('../src/session-handover-main.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-backfill-'));
const noGit = async () => ({ repo: false });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const CLAUDE_ID = '11111111-2222-3333-4444-555555555555';
const CODEX_ID = '01a11252-33fc-7073-9169-5b536bf7b04c';

// A fake home with one Claude Code and one Codex transcript.
function fakeHome({ claude = null, codex = null } = {}) {
  const home = tmp();
  if (claude) { const d = path.join(home, '.claude', 'projects', '-work-app'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${CLAUDE_ID}.jsonl`), claude); }
  if (codex) { const d = path.join(home, '.codex', 'sessions', '2026', '10', '06'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `rollout-2026-10-06T19-45-39-${CODEX_ID}.jsonl`), codex); }
  return home;
}

const claudeTranscript = jsonl([
  { type: 'user', cwd: '/work/app', timestamp: '2026-10-07T08:00:00.000Z', message: { role: 'user', content: 'fix the login bug' } },
  { type: 'user', isMeta: true, cwd: '/work/app', timestamp: '2026-10-07T08:00:00.500Z', message: { role: 'user', content: 'meta, never a prompt' } },
  { type: 'assistant', timestamp: '2026-10-07T08:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/app/login.js' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', timestamp: '2026-10-07T08:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'fail' }] } },
  { type: 'assistant', isSidechain: true, timestamp: '2026-10-07T08:00:03.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Write', input: { file_path: '/work/app/subagent.js' } }] } },
  { type: 'assistant', timestamp: '2026-10-07T08:00:04.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixed the login bug.' }] } },
  { type: 'user', cwd: '/work/app', timestamp: '2026-10-07T08:05:00.000Z', message: { role: 'user', content: 'now deploy it with API_KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
  'not json at all',
]);

const codexTranscript = jsonl([
  { timestamp: '2026-10-06T17:45:42.217Z', type: 'session_meta', payload: { id: CODEX_ID, timestamp: '2026-10-06T17:45:39.600Z', cwd: '/work/voice' } },
  { timestamp: '2026-10-06T17:46:33.205Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/work/voice</cwd>\n</environment_context>' }] } },
  { timestamp: '2026-10-06T17:46:33.206Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'write the memo for James' }] } },
  { timestamp: '2026-10-06T17:46:38.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls -la' }) } },
  { timestamp: '2026-10-06T17:46:39.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'python3 build_memo.py'], cwd: 'file:///work/voice' } } },
  { timestamp: '2026-10-06T17:46:40.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { '/work/voice/build_memo.py': { type: 'add', content: 'x' } } } } },
  { timestamp: '2026-10-06T17:46:41.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /work/voice/memo.md\n@@\n-a\n+b\n*** End Patch' } },
  { timestamp: '2026-10-06T17:50:55.548Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'The memo is ready.' } },
]);

const writerFor = (root, home, rows, over = {}) => H.create({ rootDir: root, git: noGit, debounceMs: 0, home, transcripts: T.createLocator({ home }), rows: () => rows, ...over });
const docOf = (root, key) => fs.readFileSync(path.join(root, 'handovers', `${key}.md`), 'utf8');

test('locator finds Claude Code and Codex transcripts by session id, and nothing for other adapters or bad ids', () => {
  const home = fakeHome({ claude: claudeTranscript, codex: codexTranscript });
  const L = T.createLocator({ home });
  assert.match(L.find('claude-code', CLAUDE_ID), /-work-app/);
  assert.match(L.find('codex', CODEX_ID), /rollout-.*01a11252/);
  assert.equal(L.find('hermes', CLAUDE_ID), null);
  assert.equal(L.find('claude-code', '../../etc/passwd'), null);
  assert.equal(L.find('claude-code', 'missing-id'), null);
  assert.equal(T.createLocator({ home: path.join(home, 'nope') }).find('codex', CODEX_ID), null, 'a home without transcripts is not an error');
});

test('backfill: a Claude Code session with no hook events gets a transcript doc with goal, actions, open items and resume', async () => {
  const root = tmp(), home = fakeHome({ claude: claudeTranscript });
  const w = writerFor(root, home, [{ adapter: 'claude-code', sessionId: CLAUDE_ID, cwd: '/work/app', lastActiveMs: Date.parse('2026-10-07T08:05:00Z'), state: { status: 'Working', waiting: null } }]);
  assert.equal(await w.backfill(), 1);
  const doc = docOf(root, `claude-code-${CLAUDE_ID}`);
  assert.match(doc, /Plexiform-written from the session's own transcript on this computer, not by the AI/);
  assert.match(doc, /source=transcript/);
  assert.match(doc, /## Current goal\nLatest request, in the person's own words \(scrubbed and truncated; not an AI summary\): now deploy it/);
  assert.match(doc, /First prompt: fix the login bug/);
  assert.doesNotMatch(doc, /meta, never a prompt|subagent\.js/, 'meta lines and sidechains are not the session');
  assert.doesNotMatch(doc, /sk-ant-api03/);
  assert.match(doc, /## What was done\n1 file edited, 0 read or opened, 1 recent command, 2 tool calls recorded\./);
  assert.match(doc, /\/work\/app\/login\.js/); assert.match(doc, /npm test/);
  assert.doesNotMatch(doc, /last tool call failed/, 'a later prompt clears a tool failure, as the hook tap does');
  const early = path.join(tmp(), 'early.jsonl'); fs.writeFileSync(early, claudeTranscript.split('\n').slice(0, 4).join('\n'));
  assert.deepEqual(T.factsFrom(early, { adapter: 'claude-code', sessionId: 'x' }).lastToolFailed, { tool: 'Bash', at: '2026-10-07T08:00:02.000Z' });
  assert.match(doc, /latest prompt has no recorded end of turn/);
  assert.match(doc, /Plexiform status: Working/);
  assert.match(doc, /## How to resume\n- Folder: `cd \/work\/app`\n- Resume this session: `claude --resume 11111111-2222-3333-4444-555555555555`/);
  assert.equal(fs.statSync(path.join(root, 'handovers', `claude-code-${CLAUDE_ID}.md`)).mode & 0o777, 0o600);
});

test('backfill: a Codex rollout gives cwd, prompt (not the environment wrapper), commands, edited files, last message and resume', async () => {
  const root = tmp(), home = fakeHome({ codex: codexTranscript });
  const w = writerFor(root, home, [{ adapter: 'codex', sessionId: CODEX_ID, cwd: '', lastActiveMs: 0, state: null }]);
  await w.backfill();
  const doc = docOf(root, `codex-${CODEX_ID}`);
  assert.match(doc, /Working folder: \/work\/voice/);
  assert.match(doc, /Latest request.*: write the memo for James/);
  assert.doesNotMatch(doc, /environment_context/);
  assert.match(doc, /ls -la\npython3 build_memo\.py/);
  assert.match(doc, /\/work\/voice\/build_memo\.py\n\/work\/voice\/memo\.md/);
  assert.match(doc, /## Last assistant status line\nThe memo is ready\./);
  assert.match(doc, /The last turn finished/);
  assert.match(doc, /`codex resume 01a11252-33fc-7073-9169-5b536bf7b04c`/);
  assert.match(doc, /Started: 2026-10-06 17:45:39Z/);
});

test('backfill: no transcript (missing, or an adapter without one) writes a minimal doc from Plexiform state, honestly labelled', async () => {
  const root = tmp(), home = fakeHome();
  const w = writerFor(root, home, [
    { adapter: 'claude-code', sessionId: 'gone-transcript', cwd: '/tmp', lastActiveMs: Date.parse('2026-10-06T17:41:09Z'), state: { status: 'Waiting on you', waiting: 'permission', tool: 'Bash' } },
    { adapter: 'hermes', sessionId: 'h1', cwd: '/work/h', lastActiveMs: 0, state: { status: 'Waiting on you', waiting: 'question' } },
  ]);
  assert.equal(await w.backfill(), 2);
  const a = docOf(root, 'claude-code-gone-transcript'), b = docOf(root, 'hermes-h1');
  assert.match(a, /Plexiform-written from its own session list only/);
  assert.match(a, /Blocked: a permission request \(Bash\) is waiting for the person\./);
  assert.match(a, /Last active: 2026-10-06 17:41:09Z/);
  assert.match(b, /Blocked: the AI asked a question/);
  assert.match(b, /no resume command is known for this adapter/);
  assert.match(b, /Latest request.*: \(not seen\)/);
});

test('throttle: only missing or stale docs are written, a pass is bounded, and a failed attempt is not repeated until something changes', async () => {
  const root = tmp(), home = fakeHome();
  const rows = Array.from({ length: 5 }, (_, i) => ({ adapter: 'hermes', sessionId: `h${i}`, cwd: '/w', lastActiveMs: 1000, state: null }));
  let muted = false;
  const w = writerFor(root, home, rows, { passLimit: 3, isExcluded: () => muted });
  assert.equal(await w.backfill(), 3, 'bounded per pass');
  assert.equal(await w.backfill(), 2, 'the rest next pass');
  assert.equal(await w.backfill(), 0, 'fresh docs are left alone');
  rows[0].lastActiveMs = Date.now() + 60000;
  assert.equal(await w.backfill(), 1, 'a session active after its doc was written is refreshed');
  muted = true; rows.push({ adapter: 'hermes', sessionId: 'muted', cwd: '/w', lastActiveMs: 5, state: null });
  assert.equal(await w.backfill(), 0);
  assert.equal(fs.existsSync(path.join(root, 'handovers', 'hermes-muted.md')), false, 'a muted project gets no doc');
});

test('size cap: a huge transcript is read only at its start and end, and the doc stays under MAX_DOC_BYTES', async () => {
  const filler = { type: 'assistant', timestamp: '2026-10-07T08:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4000) }] } };
  const lines = [{ type: 'user', cwd: '/work/app', timestamp: '2026-10-07T08:00:00.000Z', message: { role: 'user', content: 'the very first ask' } }];
  for (let i = 0; i < 700; i += 1) lines.push(filler);
  for (let i = 0; i < 400; i += 1) lines.push({ type: 'assistant', timestamp: '2026-10-07T09:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: `e${i}`, name: 'Edit', input: { file_path: `/work/app/${'deep/'.repeat(80)}f${i}.js` } }] } });
  lines.push({ type: 'user', cwd: '/work/app', timestamp: '2026-10-07T09:30:00.000Z', message: { role: 'user', content: 'the latest ask' } });
  const home = fakeHome({ claude: jsonl(lines) });
  const file = T.createLocator({ home }).find('claude-code', CLAUDE_ID);
  assert.ok(fs.statSync(file).size > T.HEAD_BYTES + T.TAIL_BYTES);
  const r = T.readBounded(file);
  assert.equal(r.partial, true);
  assert.ok(r.lines.reduce((n, l) => n + l.length + 1, 0) <= T.HEAD_BYTES + T.TAIL_BYTES);
  const root = tmp();
  await writerFor(root, home, [{ adapter: 'claude-code', sessionId: CLAUDE_ID, cwd: '/work/app', lastActiveMs: 0, state: null }]).backfill();
  const doc = docOf(root, `claude-code-${CLAUDE_ID}`);
  assert.ok(Buffer.byteLength(doc) <= H.MAX_DOC_BYTES);
  assert.match(doc, /First prompt: the very first ask/);
  assert.match(doc, /only its start and its latest part were read/);
  assert.match(doc, /Edited \(60\)/, 'the tap caps apply to transcripts too');
  assert.match(doc, /\(truncated: size cap\)\n$/);
});

test('merge: newer transcript facts fill a session whose hook events are older, and keep the true first prompt', async () => {
  const root = tmp(), home = fakeHome({ claude: claudeTranscript });
  Tap.record({ rootDir: root, adapter: 'claude-code', sessionId: CLAUDE_ID, cwd: '/work/app', mutedProjects: [], signal: 'prompt-submit', data: { prompt: 'a later hook prompt' }, now: '2026-10-07T07:00:00.000Z' });
  const w = writerFor(root, home, []);
  await w.tick();
  const doc = docOf(root, `claude-code-${CLAUDE_ID}`);
  assert.match(doc, /source=hooks\+transcript/);
  assert.match(doc, /from hook events and the session's own transcript/);
  assert.match(doc, /First prompt: fix the login bug/);
  assert.match(doc, /Latest prompt: now deploy it/);
  const m = H.mergeFacts({ v: 1, adapter: 'codex', sessionId: 's', cwd: '/hook', lastActive: '2026-10-07T10:00:00Z', lastPrompt: 'hook newest', tools: { a: 1 }, files: {}, commands: [] }, { v: 1, adapter: 'codex', sessionId: 's', cwd: '/tx', startedAt: '2026-10-01T00:00:00Z', lastActive: '2026-10-07T09:00:00Z', firstPrompt: 'tx first', lastPrompt: 'tx older', tools: {}, files: {}, commands: [] });
  assert.deepEqual([m.lastPrompt, m.firstPrompt, m.cwd, m.startedAt, m.tools.a], ['hook newest', 'tx first', '/hook', '2026-10-01T00:00:00Z', 1]);
});

test('Write now: refresh writes one listed session, refuses unknown keys and muted projects', async () => {
  const root = tmp(), home = fakeHome();
  let muted = false;
  const w = writerFor(root, home, [{ adapter: 'hermes', sessionId: 'h1', cwd: '/w', lastActiveMs: 0, state: null }], { isExcluded: () => muted });
  assert.deepEqual(await w.refresh('hermes-h1'), { ok: true });
  assert.equal(w.view({ source: 'hermes', sessionId: 'h1', cwd: '/w' }).ready, true);
  assert.equal(w.view({ source: 'hermes', sessionId: 'h1', cwd: '/w' }).canWrite, true);
  assert.equal((await w.refresh('hermes-nope')).ok, false);
  assert.equal((await w.refresh('../x')).ok, false);
  muted = true;
  assert.equal((await w.refresh('hermes-h1')).ok, false);
  assert.equal(w.view({ source: 'hermes', sessionId: 'h1', cwd: '/w' }).canWrite, false);
});

test('view says when a doc is older than the session\'s last activity', async () => {
  const root = tmp(), home = fakeHome();
  const w = writerFor(root, home, [{ adapter: 'hermes', sessionId: 'h1', cwd: '/w', lastActiveMs: 0, state: null }]);
  await w.backfill();
  const v = w.view({ source: 'hermes', sessionId: 'h1', cwd: '/w', updatedAt: new Date(Date.now() + 120000).toISOString() });
  assert.match(v.updated, /^Handover: updated/); assert.match(v.note, /older than the session’s last activity/);
});

test('rowsFrom: live and Overview capture sessions, background and remote ones left out, Plexiform state attached', () => {
  const now = Date.now();
  const rows = Main.rowsFrom({
    now,
    live: [
      { sessionId: 'a', source: null, cwd: '/w/a', signal: 'permission-ask', tool: 'Bash', updatedAt: new Date(now).toISOString() },
      { sessionId: 'b', source: 'codex', cwd: '/Users/me/.codex/memories', signal: 'stop' },
      { sessionId: 'c', source: 'codex', cwd: '/w/c', signal: 'stop', remote: true },
      { sessionId: 'd', source: 'hermes', cwd: '/w/d', signal: 'stop' },
    ],
    capture: [
      { provider: 'codex', session_id: 'x', title: 'Codex · memories', last_seen: 1 },
      { provider: 'codex', session_id: 'y', title: 'Codex · voice', last_seen: 5 },
      { provider: 'hermes', session_id: 'd', title: 'Hermes · d', last_seen: 1 },
      { provider: 'claude', session_id: 'z', title: 'Claude · z', last_seen: 2 },
    ],
  });
  assert.deepEqual(rows.map((r) => `${r.adapter}:${r.sessionId}`), ['claude-code:a', 'hermes:d', 'codex:y', 'claude-code:z']);
  assert.deepEqual(rows[0].state, { status: 'Waiting on you', waiting: 'permission', tool: 'Bash' });
  assert.equal(rows[1].state.status, 'Turn stopped');
  assert.equal(rows[2].lastActiveMs, 5);
});

test('register: Write now goes through the sender-checked sessions:handover handler', async () => {
  const root = tmp(), handlers = {};
  const reg = Main.register({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, rootDir: root, isExcluded: () => false, burstFor: () => null, home: fakeHome(), sessionsAllowed: (e) => e.ok === true, clipboard: { writeText: () => {} }, shell: {}, sessions: () => ({ live: [{ sessionId: 'h1', source: 'hermes', cwd: '/w', signal: 'stop' }] }), start: false });
  assert.equal(await handlers['sessions:handover']({ ok: false }, 'write', 'hermes-h1'), false);
  assert.deepEqual(await handlers['sessions:handover']({ ok: true }, 'write', 'hermes-h1'), { ok: true });
  assert.equal(reg.view({ source: 'hermes', sessionId: 'h1', cwd: '/w' }).ready, true);
});

test('Hermes activity events feed the handover tap', () => {
  const root = tmp();
  const Bridge = require('../hooks/hermes-activity.js');
  assert.equal(Bridge.apply({ sessionId: 'hx', event: 'start', cwd: '/w/h' }, root), true);
  const f = JSON.parse(fs.readFileSync(path.join(root, 'handovers', '.facts', 'hermes-hx.json'), 'utf8'));
  assert.equal(f.cwd, '/w/h'); assert.equal(f.adapter, 'hermes');
});

test('transcript prompt filter: slash commands are kept, harness wrappers are not', () => {
  assert.equal(T.promptText('<command-name>/review</command-name><command-args>PR 9</command-args>'), '/review PR 9');
  assert.equal(T.promptText('<system-reminder>x</system-reminder>'), null);
  assert.equal(T.promptText('Caveat: the messages below'), null);
  assert.equal(T.promptText('  real ask '), 'real ask');
  assert.equal(T.commandOf(['/bin/bash', '-c', 'make']), 'make');
  assert.equal(T.commandOf(['git', 'status']), 'git status');
});

test('work capture lists its non-background sessions for handovers', async (t) => {
  const { createWorkCapture } = require('../src/work-capture.js');
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wc = createWorkCapture({ startEnabled: true, file: path.join(dir, 'c.json'), host: 'mac', getRoutes: async () => ({ routes: [], complete: true }), resolveRepo: async () => null, sendLocal: async () => ({ ok: true, card: { id: 'k' } }), sendTeam: async () => ({ ok: false }) });
  t.after(() => wc.stop());
  await wc.observe([{ source: 'codex', sessionId: 'thread-1', host: 'mac', cwd: '/working/app', signal: 'stop', updatedAt: new Date().toISOString(), taskTitle: 'Fix it' }]);
  const rows = wc.handoverRows();
  assert.deepEqual(rows.map((r) => [r.provider, r.session_id, r.title]), [['codex', 'thread-1', 'Fix it']]);
});

test('a tail with no request in it is read once more, wider (still bounded)', () => {
  const filler = { type: 'assistant', timestamp: '2026-10-07T08:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(8000) }] } };
  const lines = [{ type: 'user', cwd: '/w', timestamp: '2026-10-07T08:00:00.000Z', message: { role: 'user', content: 'first' } }];
  for (let i = 0; i < 100; i += 1) lines.push(filler);
  lines.push({ type: 'user', cwd: '/w', timestamp: '2026-10-07T08:30:00.000Z', message: { role: 'user', content: 'the request before a long answer' } });
  for (let i = 0; i < 200; i += 1) lines.push(filler);
  const home = fakeHome({ claude: jsonl(lines) });
  const file = T.createLocator({ home }).find('claude-code', CLAUDE_ID);
  assert.ok(fs.statSync(file).size > T.HEAD_BYTES + T.TAIL_BYTES && fs.statSync(file).size < T.WIDE_TAIL_BYTES);
  assert.equal(T.factsFrom(file, { adapter: 'claude-code', sessionId: CLAUDE_ID }).lastPrompt, 'the request before a long answer');
});
