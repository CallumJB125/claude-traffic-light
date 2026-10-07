const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Tap = require('../hooks/handover-tap.js');
const H = require('../src/session-handover.js');
const Quiet = require('../src/quiet.js');
const Overview = require('../src/session-overview.js');
const BurstHandover = require('../src/burst-handover.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-handover-'));
const NOW = '2026-10-07T10:00:00.000Z';
const ev = (root, over) => Tap.record({ rootDir: root, adapter: 'claude-code', sessionId: 's1', cwd: '/work/app', mutedProjects: [], now: NOW, ...over });
const facts = (root, key = 'claude-code-s1') => JSON.parse(fs.readFileSync(path.join(root, 'handovers', '.facts', `${key}.json`), 'utf8'));
const noGit = async () => ({ repo: false });
const writer = (root, over = {}) => H.create({ rootDir: root, git: noGit, debounceMs: 0, ...over });

test('tap: prompts, files, commands, tool counts, failure and turn end are kept, truncated', () => {
  const root = tmp();
  ev(root, { signal: 'prompt-submit', data: { prompt: 'fix the login bug '.repeat(40) } });
  ev(root, { signal: 'prompt-submit', data: { prompt: 'now the logout bug' } });
  ev(root, { signal: 'tool-use', data: { tool_name: 'Edit', tool_input: { file_path: '/work/app/a.js' } } });
  ev(root, { signal: 'tool-use', data: { tool_name: 'Read', tool_input: { file_path: '/work/app/a.js' } } });
  ev(root, { signal: 'tool-use', data: { tool_name: 'Bash', tool_input: { command: 'npm test '.repeat(50) } } });
  ev(root, { signal: 'tool-failed', data: { tool_name: 'Bash' } });
  let f = facts(root);
  assert.equal(f.firstPrompt.length, 401); assert.equal(f.lastPrompt, 'now the logout bug');
  assert.deepEqual(f.files, { '/work/app/a.js': 'edit' }, 'an edit is not downgraded by a later read');
  assert.equal(f.commands[0].length, 201);
  assert.deepEqual(f.tools, { Edit: 1, Read: 1, Bash: 1 });
  assert.equal(f.lastToolFailed.tool, 'Bash'); assert.equal(f.awaitingReply, true);
  ev(root, { signal: 'stop', data: { last_assistant_message: 'Fixed.' } });
  f = facts(root);
  assert.equal(f.awaitingReply, false); assert.equal(f.lastAssistant, 'Fixed.');
  assert.equal((fs.statSync(path.join(root, 'handovers', '.facts', 'claude-code-s1.json')).mode & 0o777), 0o600);
});

test('tap: other adapters (Codex notify, Cursor shell, Gemini tool) feed the same facts', () => {
  const root = tmp();
  ev(root, { adapter: 'codex', sessionId: 't1', signal: 'stop', data: { type: 'agent-turn-complete', 'last-assistant-message': 'Done.', 'input-messages': ['hello'] } });
  ev(root, { adapter: 'cursor', sessionId: 'c1', signal: 'tool-use', data: { command: 'ls -la', file_path: '/w/x.ts' } });
  ev(root, { adapter: 'gemini', sessionId: 'g1', signal: 'tool-use', data: { tool_name: 'run_shell_command', tool_input: { command: 'ls' } } });
  assert.equal(facts(root, 'codex-t1').lastAssistant, 'Done.');
  assert.deepEqual(facts(root, 'cursor-c1').commands, ['ls -la']);
  assert.deepEqual(facts(root, 'gemini-g1').tools, { run_shell_command: 1 });
});

test('tap: a muted project is never recorded, and the exclusion rule equals src/quiet.js', () => {
  const root = tmp();
  assert.equal(ev(root, { signal: 'prompt-submit', data: { prompt: 'secret plan' }, mutedProjects: ['app'] }), false);
  assert.equal(fs.existsSync(path.join(root, 'handovers')), false);
  const lists = [['app'], ['/work/app'], ['/work'], ['other'], [''], ['/work/application']];
  for (const l of lists) for (const cwd of ['/work/app', '/work/app/sub', '/work/other/app', '/elsewhere']) assert.equal(Tap.excluded(l, cwd), Quiet.projectMuted(l, cwd), `${l} ${cwd}`);
});

test('writer: doc is labelled facts-only, scrubbed, 0600, and has the required sections', async () => {
  const root = tmp();
  ev(root, { signal: 'prompt-submit', data: { prompt: 'deploy with API_KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  ev(root, { signal: 'tool-use', data: { tool_name: 'Write', tool_input: { file_path: '/work/app/b.js' } } });
  ev(root, { signal: 'tool-failed', data: { tool_name: 'Bash' } });
  const w = writer(root);
  await w.tick();
  const file = path.join(root, 'handovers', 'claude-code-s1.md');
  const doc = fs.readFileSync(file, 'utf8');
  assert.match(doc, /Plexiform-written from hook events, not by the AI/);
  assert.doesNotMatch(doc, /sk-ant/);
  for (const h of ['## Session', '## What was asked', '## Files touched', '## Commands run', '## Tools used', '## Git state', '## Last assistant status line', '## Open questions / next step']) assert.ok(doc.includes(h), h);
  assert.match(doc, /\/work\/app\/b\.js/);
  assert.match(doc, /latest prompt has no recorded end of turn/);
  assert.match(doc, /last tool call failed \(Bash\)/);
  assert.match(doc, /not a git repository/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(Buffer.byteLength(doc) <= H.MAX_DOC_BYTES);
});

test('writer: real git facts for a repository, and facts limited outside one', async () => {
  const root = tmp(), repo = tmp();
  const git = (...a) => require('node:child_process').execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'n');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'two\n'); fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
  ev(root, { signal: 'prompt-submit', cwd: repo, data: { prompt: 'edit' } });
  await H.create({ rootDir: root, debounceMs: 0 }).tick();
  const doc = fs.readFileSync(path.join(root, 'handovers', 'claude-code-s1.md'), 'utf8');
  assert.match(doc, / M f\.txt/); assert.match(doc, /\?\? new\.txt/); assert.match(doc, /f\.txt \| 2/); assert.match(doc, /2 uncommitted changes/);
  const g = await H.gitFacts(os.tmpdir() + '/definitely-not-here-' + Date.now());
  assert.equal(g.repo, false);
});

test('writer: debounce, final render on session end, and no rewrite when nothing changed', async () => {
  const root = tmp();
  let t = 1000; const w = writer(root, { debounceMs: 5000, now: () => t });
  ev(root, { signal: 'prompt-submit', data: { prompt: 'one' } });
  await w.tick();
  const file = path.join(root, 'handovers', 'claude-code-s1.md');
  const first = fs.readFileSync(file, 'utf8');
  ev(root, { signal: 'prompt-submit', data: { prompt: 'two' }, now: '2026-10-07T10:00:01.000Z' });
  fs.utimesSync(path.join(root, 'handovers', '.facts', 'claude-code-s1.json'), new Date(), new Date(Date.now() + 5000));
  t = 2000; await w.tick();
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'inside the debounce window');
  t = 7000; await w.tick();
  assert.match(fs.readFileSync(file, 'utf8'), /Latest prompt: two/);
  ev(root, { signal: 'session-end', data: {} });
  fs.utimesSync(path.join(root, 'handovers', '.facts', 'claude-code-s1.json'), new Date(), new Date(Date.now() + 9000));
  t = 7100; await w.tick();
  assert.match(fs.readFileSync(file, 'utf8'), /The session ended at/, 'a finished session renders at once');
});

test('writer: excluding a project deletes its handover and facts; ring keeps the newest 200 and only deletes its own files', async () => {
  const root = tmp(); let muted = false;
  ev(root, { signal: 'prompt-submit', data: { prompt: 'x' } });
  const w = writer(root, { isExcluded: () => muted });
  await w.tick();
  const file = path.join(root, 'handovers', 'claude-code-s1.md');
  assert.ok(fs.existsSync(file));
  assert.equal(w.view({ sessionId: 's1', cwd: '/work/app' }).ready, true);
  muted = true; await w.tick();
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(root, 'handovers', '.facts', 'claude-code-s1.json')), false);
  assert.equal(w.view({ sessionId: 's1', cwd: '/work/app' }).note, 'session excluded');

  muted = false;
  const dir = path.join(root, 'handovers');
  fs.writeFileSync(path.join(dir, 'mine-not.md'), 'a user file, no marker');
  for (let i = 0; i < 205; i += 1) { const f = path.join(dir, `claude-code-n${i}.md`); fs.writeFileSync(f, `${H.MARKER}\nx`); const at = new Date(Date.now() - (300 - i) * 1000); fs.utimesSync(f, at, at); }
  await w.tick();
  const left = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  assert.equal(left.filter((n) => n.startsWith('claude-code-')).length, 200);
  assert.ok(left.includes('mine-not.md'), 'a file this module did not write is never removed');
  assert.ok(left.includes('claude-code-n204.md') && !left.includes('claude-code-n0.md'));
});

test('view: specific reasons when absent, and age + limited note when present', async () => {
  const root = tmp(); const w = writer(root);
  assert.deepEqual([w.view({ sessionId: 'zz', cwd: '/w' }).note, w.view({ sessionId: 'zz', cwd: '/w' }).ready], ['no events yet', false]);
  ev(root, { signal: 'prompt-submit', data: { prompt: 'x' } });
  assert.equal(w.view({ sessionId: 's1', cwd: '/work/app' }).note, 'handover is being written');
  await w.tick();
  const v = w.view({ sessionId: 's1', cwd: '/work/app' });
  assert.equal(v.ready, true); assert.match(v.updated, /^Handover updated (just now|\d+m ago)$/); assert.equal(v.note, 'cwd not a git repo — facts limited');
});

test('copy as prompt wraps the doc for any AI; only keys of files this module wrote resolve', async () => {
  const root = tmp(); const w = writer(root);
  ev(root, { signal: 'prompt-submit', data: { prompt: 'x' } });
  await w.tick();
  const p = w.promptOf('claude-code-s1');
  assert.match(p, /^Continue the work described below/); assert.match(p, /# Session handover/);
  assert.equal(w.pathOf('../../etc/passwd'), null); assert.equal(w.pathOf('nope'), null); assert.equal(w.promptOf(5), null);
});

test('Burst handover section is appended when Burst has one for the repository', async () => {
  const root = tmp();
  ev(root, { signal: 'prompt-submit', data: { prompt: 'x' } });
  await writer(root, { burstFor: () => '## 2026-10-06 handover\nPick up at step 3' }).tick();
  assert.match(fs.readFileSync(path.join(root, 'handovers', 'claude-code-s1.md'), 'utf8'), /## Burst handover\n## 2026-10-06 handover\nPick up at step 3/);
});

test('session overview carries the handover view without leaking the row', () => {
  const snap = Overview.snapshot({ sessions: [{ sessionId: 's1', cwd: '/work/app', source: null, signal: 'stop', updatedAt: new Date().toISOString() }], handover: (row) => ({ key: row.sessionId, ready: false, updated: 'No handover yet', note: 'no events yet' }) });
  assert.deepEqual(snap.sessions[0].handover, { key: 's1', ready: false, updated: 'No handover yet', note: 'no events yet' });
  assert.equal(Overview.snapshot({ sessions: [{ sessionId: 's1', cwd: '/w', signal: 'stop', updatedAt: new Date().toISOString() }], handover: () => { throw new Error('x'); } }).sessions[0].handover, undefined);
});

test('hub share is opt-in per repository and fully scrubbed', () => {
  const doc = `${H.MARKER}\n<!-- plexiform-meta git=none -->\n# Session handover\nedited /Users/me/work/app/a.js token=abcdef0123456789abcdef0123456789\n`;
  assert.equal(H.salvagePayload(doc, { root: '/Users/me/work/app', shared: {} }), null);
  const p = H.salvagePayload(doc, { root: '/Users/me/work/app', shared: { [BurstHandover.repoKey('/Users/me/work/app')]: true }, home: '/Users/me', date: '2026-10-07' });
  assert.equal(p.date, '2026-10-07');
  assert.doesNotMatch(p.text, /abcdef0123|plexiform-session-handover|\/work\/app/);
});

test('forCard finds the local handover of the session a card was captured from', async () => {
  const root = tmp(); const w = writer(root);
  ev(root, { adapter: 'codex', sessionId: 'thr1', signal: 'prompt-submit', data: { prompt: 'x' } });
  await w.tick();
  const lh = H.forCard(w, 'card-9', [{ provider: 'codex', session_id: 'thr1', card_id: 'card-9' }]);
  assert.match(lh.markdown, /^# Session handover: codex thr1/);
  assert.equal(H.forCard(w, 'card-other', [{ provider: 'codex', session_id: 'thr1', card_id: 'card-9' }]), null);
});

test('the real hook scripts feed the tap: set-status.js (Claude), emit.js --adapter (Gemini) and emit.js bare signals', () => {
  const { spawnSync } = require('node:child_process');
  const root = tmp();
  const env = { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: root, PLEXIFORM_NO_FAST: '1', CLAUDE_TRAFFIC_LIGHT_LOOKUP_MS: '300' };
  const run = (script, args, input) => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', script), ...args], { env, input: JSON.stringify(input), timeout: 15000 });
  run('set-status.js', ['prompt-submit'], { session_id: 'cl1', cwd: '/work/app', hook_event_name: 'UserPromptSubmit', prompt: 'hello claude' });
  run('set-status.js', ['tool-use'], { session_id: 'cl1', cwd: '/work/app', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/work/app/z.js' } });
  const c = facts(root, 'claude-code-cl1');
  assert.equal(c.lastPrompt, 'hello claude'); assert.deepEqual(c.files, { '/work/app/z.js': 'edit' });
  run('emit.js', ['--adapter', 'gemini', 'BeforeTool'], { session_id: 'g9', cwd: '/w/g', hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'ls' } });
  assert.deepEqual(facts(root, 'gemini-g9').commands, ['ls']);
  run('emit.js', ['tool-use', '--source', 'aider', '--session', 'a1', '--cwd', '/w/a'], {});
  assert.equal(facts(root, 'aider-a1').cwd, '/w/a');
});

test('the in-app /hook/:adapter route feeds the tap too', async () => {
  const root = tmp(); fs.mkdirSync(path.join(root, 'sessions'));
  const net = require('node:net'); const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; await new Promise((r) => srv.close(r));
  const S = require('../src/signal-server.js')({ rootDir: root, sessionsDir: path.join(root, 'sessions'), requestsDir: root, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port, app: { on: () => {} } });
  const server = S.startSignalServer();
  await new Promise((r) => server.once('listening', r));
  const token = fs.readFileSync(path.join(root, 'token'), 'utf8');
  const res = await fetch(`http://127.0.0.1:${port}/hook/gemini?event=BeforeTool`, { method: 'POST', headers: { 'x-buddy-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'gx', cwd: '/w/g', hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'pwd' } }) });
  assert.equal(res.status, 200);
  server.close();
  assert.deepEqual(facts(root, 'gemini-gx').commands, ['pwd']);
});
