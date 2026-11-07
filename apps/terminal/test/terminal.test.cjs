'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { PassThrough } = require('node:stream');
const { readMetadata } = require('../metadata'); const { KeeperClient, frame } = require('../keeper-client');
test('observed telemetry omits prompt/transcript content and gives no control identity', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-meta-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ source: 'codex', sessionId: 'private-provider-session', cwd: '/private/secret/project', updatedAt: new Date(100000).toISOString(), signal: 'permission-ask', title: 'SECRET', summary: 'SECRET', transcript: 'SECRET', hostApp: 'Terminal', cost: { usd: 999 } }));
  const [row] = readMetadata(dir, 100001); assert.equal(row.project, 'project'); assert.equal(row.bucket, 'needs'); assert.equal(row.cost, null); assert.equal(row.age_ms, 1); assert(!JSON.stringify(row).includes('SECRET')); assert(!JSON.stringify(row).includes('/private')); assert(!JSON.stringify(row).includes('private-provider-session')); assert(!('sessionId' in row)); assert(!('keeperSessionId' in row));
});
test('metadata reader ignores symlinks, oversized files, ended and old sessions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-meta-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const other = path.join(dir, 'outside'); fs.writeFileSync(other, '{"signal":"permission-request"}'); fs.symlinkSync(other, path.join(dir, 'linked.json'));
  fs.writeFileSync(path.join(dir, 'huge.json'), ' '.repeat(128 * 1024 + 1)); fs.writeFileSync(path.join(dir, 'ended.json'), '{"signal":"session-end"}');
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ updatedAt: new Date(0).toISOString() })); assert.deepEqual(readMetadata(dir, 100000000), []);
});
test('frame parser pins attach channel before coalesced screen bytes', async () => {
  // Inbound and outbound are separated; no socket/network needed.
  const socket = new PassThrough(); const outgoing = []; socket.write = d => { outgoing.push(d); return true; };
  const client = new KeeperClient(socket); const order = [];
  client.on('reply', e => order.push(['reply', e.result.channel])); client.on('data', e => order.push(['data', e.channel]));
  const pending = client.call('attach', { sessionId: 'one', cols: 80, rows: 24 });
  const reply = frame(1, Buffer.from(JSON.stringify({ v: 1, re: 1, ok: true, channel: 9 })));
  const channel = Buffer.alloc(4); channel.writeUInt32BE(9); const bytes = frame(2, Buffer.concat([channel, Buffer.from('screen')]));
  socket.emit('data', Buffer.concat([reply, bytes])); await pending; assert.deepEqual(order, [['reply', 9], ['data', 9]]); client.close();
});
test('oversized inbound frame closes connection without parsing its contents', () => {
  const socket = new PassThrough(); socket.on('error', () => {}); const client = new KeeperClient(socket); client.on('notice', () => {});
  const header = Buffer.alloc(4); header.writeUInt32BE(65537); socket.emit('data', header); assert.equal(socket.destroyed, true);
});
test('public build cannot silently fall back to development', () => {
  const { spawnSync } = require('node:child_process'); const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../../scripts/build-terminal.js')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Public Terminal distribution is disabled/);
});
const meta = require('../metadata');
const fixtureDir = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
test('hook buckets match Plexiform work-organise for every signal the Terminal knows', () => {
  const organise = require('../../../src/work-organise.js');
  for (const [bucket, keys] of Object.entries(meta.SIGNALS)) for (const key of keys) assert.equal(organise.bucketOf(key), bucket, key);
  assert.equal(meta.bucketOf('something-new'), 'idle');
});
test('observed rows carry status, waiting-on text and bounded subagents but never prompts', (t) => {
  const dir = fixtureDir(t), now = Date.parse('2026-11-06T12:00:00Z');
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ source: 'claude', cwd: '/x/billing', signal: 'permission-ask', tool: 'Bash', updatedAt: '2026-11-06T11:56:00Z', signalSince: '2026-11-06T11:56:00Z', startedAt: '2026-11-06T11:00:00Z', model: 'claude-opus-5-5', lastPrompt: 'SECRET', agents: [{ name: 'term-ui', kind: 'teammate', status: 'working', since: '2026-11-06T11:50:00Z', description: 'SECRET' }, { name: 'x', status: 'done' }] }));
  const [row] = meta.readMetadata(dir, now, { isAlive: () => true });
  assert.equal(row.bucket, 'needs'); assert.equal(row.waitingOn, 'Approve Bash'); assert.equal(row.since_ms, 4 * 60000); assert.equal(row.model, 'Opus 5.5');
  assert.deepEqual(row.subagents.list.map((a) => [a.name, a.kind, a.status]), [['term-ui', 'teammate', 'working'], ['x', 'subagent', 'done']]);
  assert.equal(row.subagents.running, 1); assert(!JSON.stringify(row).includes('SECRET'));
  assert.equal(Object.keys(row).includes('cwd'), false, 'cwd stays main-process only');
});
test('dead agent processes are dropped', (t) => {
  const dir = fixtureDir(t);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ signal: 'tool-use', claudePid: 99999, updatedAt: new Date().toISOString() }));
  assert.deepEqual(meta.readMetadata(dir, Date.now(), { isAlive: () => false }), []);
});
test('spend today is computed from the usage rollup and is null without one', (t) => {
  const dir = fixtureDir(t), now = new Date(2026, 10, 6, 12).getTime();
  assert.equal(meta.readSpend(dir, now).usd, null);
  fs.mkdirSync(path.join(dir, 'usage/daily'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'usage/daily/2026-11.json'), JSON.stringify({ days: { '2026-11-06': { sources: { claude: { 'claude-opus-5-5': { '/x/a': { turns: 2, input: 1e6, output: 1e5 } }, 'mystery-model': { '/x/a': { turns: 3, input: 5 } } } } } } }));
  const spend = meta.readSpend(dir, now);
  assert.equal(spend.usd, 7.5); assert.equal(spend.unpricedTurns, 3); assert.equal(spend.byCwd.get('/x/a'), 7.5);
});
test('CI keeps the newest signal per branch and extracts only a PR number', (t) => {
  const dir = fixtureDir(t);
  fs.writeFileSync(path.join(dir, 'git-signals.json'), JSON.stringify({ recent: [{ branch: 'b', signal: 'ci-failed', at: '2026-11-06T10:00:00Z', url: 'https://github.com/o/r/pull/12', title: 'CI' }, { branch: 'b', signal: 'ci-passed', at: '2026-11-06T11:00:00Z', url: 'javascript:alert(1)' }] }));
  const ci = meta.readCi(dir).get('b');
  assert.equal(ci.signal, 'ci-passed'); assert.equal(ci.pr, null); assert.equal(ci.label, 'ci passed');
});
test('git status parsing handles branches, renames and fresh repos', () => {
  const out = meta.parseStatus('## feat/x...origin/feat/x [ahead 1]\0 M a.js\0R  new.js\0old.js\0?? b.js\0');
  assert.equal(out.branch, 'feat/x'); assert.equal(out.changed, 3); assert.deepEqual(out.files.map((f) => f.path), ['a.js', 'new.js', 'b.js']);
  assert.equal(meta.parseStatus('## No commits yet on main\0').branch, 'main');
});
test('timeline records transitions once and forgets ended sessions', () => {
  const history = new Map(), row = { id: 'a', bucket: 'working', doing: 'Thinking', since_ms: 0, started_ms: 1000 };
  meta.trackTimeline(history, [row], 10000); meta.trackTimeline(history, [{ ...row }], 11000);
  const next = { ...row, bucket: 'needs', doing: 'Approve Bash' }; meta.trackTimeline(history, [next], 12000);
  assert.deepEqual(next.timeline.map((e) => e.text), ['Session started', 'Thinking', 'Approve Bash']);
  meta.trackTimeline(history, [], 13000); assert.equal(history.size, 0);
});
test('renderer writes telemetry as text only and keeps escape-sequence guards', () => {
  const app = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  for (const osc of [0, 2, 8, 52]) assert.match(app, new RegExp(`\\[0, 1, 2, 4, 8, 10, 11, 12, 52\\]`), String(osc));
  assert.match(app, /linkHandler = \{ activate\(\) \{\}/);
  // External rows open a read-only detail; only keeper tabs reach select/write.
  assert.match(app, /if \(item\.type === 'tab'\) void openTab/);
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /sessions\.some\(\(s\) => s\.sessionId === id\)/);
  assert.match(main, /Only the focused terminal can receive input/);
});
const takeover = require('../takeover');
test('take-over accepts only a user-owned regular .command file', (t) => {
  const dir = fixtureDir(t), file = path.join(dir, 'continue.command');
  fs.writeFileSync(file, '#!/bin/zsh\necho hi\n', { mode: 0o700 });
  assert.equal(takeover.commandFileProblem(file), null);
  assert.match(takeover.commandFileProblem('relative.command'), /Only \.command/);
  assert.match(takeover.commandFileProblem(path.join(dir, 'x.sh')), /Only \.command/);
  assert.match(takeover.commandFileProblem(path.join(dir, 'a\nb.command')), /cannot be run safely/);
  fs.symlinkSync(file, path.join(dir, 'link.command')); assert.match(takeover.commandFileProblem(path.join(dir, 'link.command')), /regular/);
  fs.writeFileSync(path.join(dir, 'big.command'), ' '.repeat(256 * 1024 + 1)); assert.match(takeover.commandFileProblem(path.join(dir, 'big.command')), /too large/);
  assert.match(takeover.commandFileProblem(file, { uid: process.getuid() + 1 }), /another user/);
});
test('take-over recognises only Plexiform hand-off files without asking', () => {
  assert.equal(takeover.isPlexiformHandoff('/tmp/x/plexiform-terminal-Ab12Cd/continue.command', ['/tmp/x']), true);
  assert.equal(takeover.isPlexiformHandoff('/tmp/x/plexiform-terminal-Ab12Cd/other.command', ['/tmp/x']), false);
  assert.equal(takeover.isPlexiformHandoff('/Users/me/Downloads/plexiform-terminal-Ab12Cd/continue.command', ['/tmp/x']), false);
  assert.equal(takeover.isPlexiformHandoff('/tmp/x/plexiform-terminal-../continue.command', ['/tmp/x']), false);
});
test('take-over run line quotes the path so it is one argument', () => {
  assert.equal(takeover.runLine("/tmp/it's $(x);.command"), " exec /bin/zsh -- '/tmp/it'\\''s $(x);.command'\r");
});
test('quarantined files are detected', async (t) => {
  const dir = fixtureDir(t), file = path.join(dir, 'q.command'); fs.writeFileSync(file, 'x');
  assert.equal(await takeover.quarantined(file), false);
  require('node:child_process').execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Test;', file]);
  assert.equal(await takeover.quarantined(file), true);
});
test('packaged app declares take-over and .command handling without claiming the default', () => {
  const config = require('../electron-builder.config.cjs');
  assert.equal(config.mac.extendInfo.PlexiformTakeover, true);
  assert.deepEqual(config.fileAssociations.map((a) => [a.ext, a.rank]), [['command', 'Alternate']]);
  assert(config.files.includes('takeover.js'));
  assert.equal(require('../package.json').version, '0.3.1');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.doesNotMatch(main, /showOpenDialog/, 'new tabs open without a folder picker');
});
test('roster joins by provider|session id, gives board with a fixed reason, counts notes, and is ignored when stale', (t) => {
  const dir = fixtureDir(t), now = Date.parse('2026-11-07T12:00:00Z');
  fs.mkdirSync(path.join(dir, 'awareness'), { mode: 0o700 }); fs.writeFileSync(path.join(dir, 'port'), '47172');
  const write = (generated) => fs.writeFileSync(path.join(dir, 'awareness/roster.json'), JSON.stringify({ v: 1, generated_at: generated, bus: { enabled: true, halted: 'unknown' }, peers: [{}, {}], self: {
    'claude|s1': { allowed: true, handle: 'claude-plexiform-ab12', caps: { notes: true }, notices: [{ note_id: 'note_1', from_handle: 'codex-x-ab12' }, { note_id: 'note_2' }], board: { kind: 'team', name: 'Platform', why: 'linked_repo' } },
    'codex|s2': { allowed: true, handle: 'not a handle <b>', caps: { notes: false }, notices: [{}], board: { kind: 'personal', why: 'something_new' } },
    'claude|s3': { allowed: false, handle: 'claude-hidden-ab12' },
  } }));
  write('2026-11-07T11:58:00Z');
  const r = meta.readRoster(dir, now);
  assert.deepEqual(r.bus, { enabled: true, halted: null }); assert.equal(r.peers, 2);
  assert.deepEqual(r.self.get('claude|s1'), { handle: 'claude-plexiform-ab12', board: { kind: 'team', label: 'On Platform', name: 'Platform', why: 'repo is linked to this team', short: 'repo linked', code: 'linked_repo', pending: false, team: true }, notesWaiting: 2 });
  assert.deepEqual(r.self.get('codex|s2'), { handle: null, board: { kind: 'personal', label: 'My board', name: 'My board', why: null, short: null, code: null, pending: false, team: false }, notesWaiting: null });
  assert.equal(r.self.has('claude|s3'), false, 'excluded sessions never join');
  write('2026-11-07T11:50:00Z'); assert.equal(meta.readRoster(dir, now).self.size, 0, 'a roster older than five minutes is ignored');
  write('2026-11-07T11:58:00Z'); fs.rmSync(path.join(dir, 'port')); assert.equal(meta.readRoster(dir, now).bus, null, 'no running app, no roster');
  assert.equal(meta.boardView({ kind: 'unknown' }), null);
  const untracked = meta.boardView({ kind: 'untracked', why: 'personal_mark' });
  assert.deepEqual([untracked.kind, untracked.label, untracked.why, untracked.team], ['none', 'No board', 'marked personal', false]);
});
test('observed rows carry the roster key privately; claude files without a source default to claude', (t) => {
  const dir = fixtureDir(t), now = Date.parse('2026-11-07T12:00:00Z');
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId: 's1', cwd: '/x/p', signal: 'tool-use', tool: 'Grep', updatedAt: '2026-11-07T11:59:00Z' }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ source: 'hermes', sessionId: 'h-1', signal: 'stop', updatedAt: '2026-11-07T11:59:00Z' }));
  const rows = meta.readMetadata(dir, now, { isAlive: () => true });
  const a = rows.find((r) => r.provider === 'claude'), b = rows.find((r) => r.provider === 'hermes');
  assert.equal(a.key, 'claude|s1'); assert.equal(b.key, 'hermes|h-1');
  assert(!JSON.stringify(rows).includes('s1') && !JSON.stringify(rows).includes('h-1'), 'session ids never leave main');
});
test('hand-offs come from the trace by id, with stages, failure reasons and no text', (t) => {
  const dir = fixtureDir(t), now = 1_800_000_000_000, file = path.join(dir, 'bus-trace.jsonl');
  const line = (o) => JSON.stringify({ trace_id: 'tr_0123456789abcdef', span: 'sp_01234567', repo_key_hash: null, ms: 1, reason: null, ...o });
  fs.writeFileSync(file, [
    line({ t: now - 600000, op: 'handoff', from_handle: 'claude-plexiform-ab12', to: 'any', provider: 'any', result: 'ok', ref: 'hof_aaaaaaaaaaaa' }),
    line({ t: now - 590000, op: 'claim', result: 'ok', ref: 'hof_aaaaaaaaaaaa' }),
    line({ t: now - 580000, op: 'start', provider: 'claude', result: 'ok', ref: 'hof_aaaaaaaaaaaa' }),
    line({ t: now - 300000, op: 'result', provider: 'claude', result: 'ok', ref: 'hof_aaaaaaaaaaaa' }),
    line({ t: now - 200000, op: 'handoff', from_handle: 'claude-plexiform-ab12', to: 'codex', provider: 'codex', result: 'ok', ref: 'hof_bbbbbbbbbbbb' }),
    line({ t: now - 199000, op: 'result', provider: 'codex', result: 'error', reason: 'PROVIDER_UNAVAILABLE', ref: 'hof_bbbbbbbbbbbb' }),
    line({ t: now - 100000, op: 'note', from_handle: 'claude-plexiform-ab12', to: 'codex-x-ab12', result: 'ok', ref: 'note_0123456789abcdef' }),
    '{"t":' + (now - 50000) + ',"op":"handoff","ref":"hof_cccc', // torn final line
    line({ t: now - 9 * 3600000, op: 'handoff', from_handle: 'claude-old-ab12', to: 'claude', result: 'ok', ref: 'hof_dddddddddddd' }),
  ].join('\n'));
  const hs = meta.readTrace([file, path.join(dir, 'missing.jsonl')], now);
  assert.equal(hs.length, 2, 'notes, torn lines and old hand-offs are skipped');
  const [ok, refused] = hs;
  assert.equal(ok.state, 'succeeded'); assert.equal(ok.provider, 'claude'); assert.equal(ok.to, 'any'); assert.equal(ok.from, 'claude-plexiform-ab12');
  assert.deepEqual(ok.steps.map((s) => s.state), ['done', 'done', 'done', 'done']); assert.equal(ok.ago_ms, 600000);
  assert.equal(refused.state, 'failed'); assert.equal(refused.reason, 'provider unavailable'); assert.deepEqual(refused.steps.map((s) => s.state), ['done', 'todo', 'todo', 'bad']);
  assert(!JSON.stringify(hs).includes('hof_'), 'only a hashed id is exposed');
});
test('hand-off outcome comes only from result lines; returned is delivery, blocked and fallback asker', (t) => {
  const dir = fixtureDir(t), now = 1_800_000_000_000, file = path.join(dir, 'bus-trace.jsonl');
  const line = (ref, o) => JSON.stringify({ trace_id: 'tr_0123456789abcdef', span: 'sp_01234567', ms: 1, reason: null, ref: `hof_${ref.repeat(12)}`, ...o });
  const asker = 'claude-plexiform-ab12';
  fs.writeFileSync(file, [
    line('e', { t: now - 50000, op: 'handoff', from_handle: asker, to: 'codex', provider: 'codex', result: 'ok' }),
    line('e', { t: now - 40000, op: 'result', provider: 'codex', result: 'deferred', reason: 'EXPIRED' }),
    line('f', { t: now - 30000, op: 'handoff', from_handle: asker, to: 'claude', provider: 'claude', result: 'ok' }),
    line('f', { t: now - 29000, op: 'claim', result: 'ok' }), line('f', { t: now - 28000, op: 'start', provider: 'claude', result: 'ok' }),
    line('f', { t: now - 27000, op: 'returned', to: asker, result: 'ok', reason: 'BLOCKED' }),
    line('a', { t: now - 20000, op: 'handoff', from_handle: asker, to: 'gemini', provider: 'gemini', result: 'ok' }),
    line('a', { t: now - 19000, op: 'result', provider: 'gemini', result: 'ok' }),
    line('a', { t: now - 18000, op: 'returned', to: asker, result: 'error', reason: 'NO_SESSION' }),
    // A fallback is posted inside the bus: no handoff line.
    line('b', { t: now - 10000, op: 'claim', result: 'ok' }), line('b', { t: now - 9000, op: 'start', provider: 'codex', result: 'ok' }),
    line('b', { t: now - 8000, op: 'result', provider: 'codex', result: 'ok' }), line('b', { t: now - 7000, op: 'returned', to: asker, result: 'ok' }),
  ].join('\n'));
  const [expired, blocked, delivered, fallback] = meta.readTrace(file, now);
  assert.equal(expired.state, 'ended'); assert.equal(expired.reason, 'expired');
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.reason, 'blocked on its person'); assert.equal(blocked.steps[3].state, 'todo', 'Result stage is not done while blocked');
  assert.equal(delivered.state, 'succeeded', 'a failed delivery does not undo a success'); assert.equal(delivered.reason, null);
  assert.equal(fallback.from, asker); assert.equal(fallback.to, 'codex'); assert.equal(fallback.state, 'succeeded');
});
test('subagents: live first, nested only under a listed parent, and a cut agent keeps its remembered start', (t) => {
  const dir = fixtureDir(t), now = Date.parse('2026-11-07T12:00:00Z'), at = (min) => new Date(now - min * 60000).toISOString();
  const agents = [{ id: 'old', name: 'old-live', status: 'working', since: at(50) }, { id: 'kid', name: 'kid', status: 'working', since: at(2), parent: 'p' }];
  for (let i = 0; i < 30; i++) agents.push({ id: `d${i}`, name: `done${i}`, status: 'done', since: at(1) });
  agents.push({ id: 'p', name: 'parent', status: 'working', since: at(5) }, { id: 'orphan', name: 'orphan', status: 'working', since: at(3), parent: 'gone' });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId: 's', signal: 'tool-use', tool: 'Bash', updatedAt: at(0), agents }));
  const [row] = meta.readMetadata(dir, now, { isAlive: () => true });
  const names = row.subagents.list.map((a) => [a.name, a.depth]);
  assert(names.some(([n]) => n === 'old-live'), 'a long-running agent is never cut by newer finished ones');
  const pi = names.findIndex(([n]) => n === 'parent'); assert.deepEqual(names[pi + 1], ['kid', 2], 'a child follows its parent');
  assert.deepEqual(names.find(([n]) => n === 'orphan'), ['orphan', 1], 'a child of an unlisted parent is not indented');
  assert.equal(row.subagents.running, 4); assert.equal(row.subagents.list.length, 24);
  assert(!JSON.stringify(row).includes('"starts"'), 'start list stays main-process only');
  const memory = new Map(); meta.trackAgents(memory, [row], now);
  assert.equal(memory.size, 4, 'every live agent start is remembered; finished ones are never guessed');
});
test('subagent timing: start while working, end once finished, start remembered only if seen', () => {
  const now = 10_000_000, memory = new Map();
  const row = (status, since) => {
    const a = Object.defineProperty({ name: 'executor', status, start_ms: status === 'working' ? now - since : null, end_ms: status === 'working' ? null : now - since }, 'aid', { value: 'a1' });
    return { id: 'r', subagents: Object.defineProperty({ list: [a] }, 'starts', { value: [['a1', a.start_ms]] }) };
  };
  meta.trackAgents(memory, [row('working', 1000)], now);
  const done = row('done', 600000); meta.trackAgents(memory, [done], now + 60000);
  assert.equal(done.subagents.list[0].start_ms, 60000 + now - 1000);
  const unseen = { id: 'q', subagents: Object.defineProperty({ list: [Object.defineProperty({ name: 'x', status: 'done', start_ms: null, end_ms: 5 }, 'aid', { value: 'b' })] }, 'starts', { value: [['b', null]] }) };
  meta.trackAgents(memory, [unseen], now); assert.equal(unseen.subagents.list[0].start_ms, null, 'never guessed');
  assert.equal(memory.size, 0, 'forgotten when the session ends');
});
test('lanes mark time before the window saw a session as unseen and keep an hour', () => {
  const history = new Map(), row = { id: 'a', bucket: 'working', doing: 'Thinking', since_ms: 60000, started_ms: 600000 };
  meta.trackTimeline(history, [row], 1_000_000);
  assert.deepEqual(row.lane.map((s) => [s.bucket, s.start_ms, s.end_ms]), [['unseen', 600000, 60000], ['working', 60000, 0]]);
  const later = { ...row, bucket: 'needs', doing: 'Approve Bash', since_ms: 0 }; meta.trackTimeline(history, [later], 1_030_000);
  assert.deepEqual(later.lane.map((s) => s.bucket), ['unseen', 'working', 'needs']);
});
test('lanes keep a state that began over an hour ago, and a busy session keeps its whole hour', () => {
  const H = 3600000, history = new Map();
  const long = { id: 'l', bucket: 'working', doing: 'Thinking', since_ms: 90 * 60000, started_ms: 3 * H };
  meta.trackTimeline(history, [long], 10 * H);
  assert.deepEqual(long.lane.map((s) => s.bucket), ['working'], 'the current state stays even though it began 90 minutes ago');
  const busy = new Map(); let t = 10 * H, row;
  for (let i = 0; i < 400; i++, t += 15000) { row = { id: 'b', bucket: 'working', doing: `Running T${i % 7}`, since_ms: 0, started_ms: t - 9 * H }; meta.trackTimeline(busy, [row], t); }
  row = { ...row, bucket: 'idle', doing: 'Idle', since_ms: 0 }; meta.trackTimeline(busy, [row], t + 20 * 60000);
  assert(row.lane[0].start_ms >= H, 'the lane still reaches back a full hour');
  assert.deepEqual(row.lane.map((s) => [s.bucket, s.text]), [['working', 'Working'], ['idle', 'Idle']], 'a run of tools is one segment named by its state');
  assert(busy.get('b').length <= 400, 'the history is bounded');
});
test('renderer folds old sessions, keeps hand-off briefs out, and never builds markup from data', () => {
  const app = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  assert.match(app, /Earlier today/); assert.match(app, /EARLIER_MS = 30 \* 60000/);
  assert.match(app, /Brief not shown/);
  assert.doesNotMatch(app, /\.brief\b|\.notices\b|(?<!document)\.body\b/, 'no hand-off or note text is read');
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('board reasons: every bus-contract why has a fixed phrase; solo reasons are not team reasons; pending is flagged', () => {
  // bus-contract.js BOARD_WHY (board-routing); this branch may not carry it yet, so its list is pinned here too.
  const contractFile = path.join(__dirname, '../../../src/bus-contract.js');
  const contract = fs.existsSync(contractFile) && fs.readFileSync(contractFile, 'utf8').match(/const BOARD_WHY = freeze\(\{([\s\S]*?)\}\);/);
  const whys = contract ? [...contract[1].matchAll(/: '([a-z_]+)'/g)].map((m) => m[1]) : ['excluded', 'personal_mark', 'inherited', 'withheld', 'linked_repo', 'repo_default', 'choose', 'no_link_suggested', 'no_link', 'no_repo', 'deferred', 'read_only', 'cards_off'];
  for (const why of [...whys, 'pending_route']) { const v = meta.boardView({ kind: 'personal', why }); assert(v.why && v.short, why); }
  assert.equal(meta.boardView({ kind: 'personal', why: 'no_repo' }).team, false);
  assert.equal(meta.boardView({ kind: 'personal', why: 'withheld' }).team, true, 'a withheld card means a team is involved');
  const pending = meta.boardView({ kind: 'personal', why: 'inherited', pending_route: true });
  assert.equal(pending.pending, true); assert.equal(pending.why, 'started from a hand-off or card');
  assert.equal(meta.boardView({ kind: 'personal', pending_route: true }).short, 'route pending');
  assert.equal(meta.boardView({ kind: 'team', name: '<b>Pay‮ments</b>', why: 'nonsense' }).name, '<b>Payments</b>', 'names are text; unknown reasons are dropped');
  assert.equal(meta.boardView({ kind: 'team', why: 'nonsense' }).why, null);
});
test('card records give a session its board when the roster does not; pointers and bad records are skipped', (t) => {
  const dir = fixtureDir(t), file = path.join(dir, 'work-capture.json');
  assert.equal(meta.readCards(file, 0).size, 0, 'no file, no boards');
  const team = { kind: 'team', hub: 'https://hub.example', user_id: 'u1', team_id: 't1', board_id: 'b1', repo_id: 'r1', board_name: 'Payments' };
  fs.writeFileSync(file, JSON.stringify({ v: 1, tasks: {
    a: { provider: 'claude', session_id: 's1', task_id: null, destination: { kind: 'local' }, why: 'no_link', last_seen: 1, title: 'SECRET' },
    b: { provider: 'claude', session_id: 's1', task_id: 't', destination: team, why: 'linked_repo', last_seen: 5, title: 'SECRET', summary: 'SECRET' },
    c: { provider: 'codex', session_id: 's2', destination: { kind: 'local' }, untracked: true, why: 'excluded', last_seen: 3 },
    d: { provider: 'gemini', session_id: 's3', destination: { kind: 'local' }, pointer: true, why: 'withheld', last_seen: 9 },
    e: { provider: 'codex', session_id: 's4', destination: { kind: 'local', needs_routing: true }, why: 'choose', last_seen: 2 },
    f: { provider: 'claude', session_id: 's5', destination: { kind: 'local' }, why: 'inherited', pending_route: true, last_seen: 2 },
    g: { provider: '../x', session_id: 's6', destination: { kind: 'local' } }, h: null,
  } }));
  const cards = meta.readCards(file, 10000);
  assert.deepEqual([...cards.keys()].sort(), ['claude|s1', 'claude|s5', 'codex|s2', 'codex|s4']);
  assert.deepEqual([cards.get('claude|s1').kind, cards.get('claude|s1').name, cards.get('claude|s1').short], ['team', 'Payments', 'repo linked'], 'the newest task wins');
  assert.equal(cards.get('codex|s2').name, 'No card'); assert.equal(cards.get('codex|s4').label, 'Board not chosen'); assert.equal(cards.get('claude|s5').pending, true);
  assert(!JSON.stringify([...cards.values()]).includes('SECRET'), 'titles and summaries never leave the reader');
  assert.equal(meta.readCards(file, 30000), cards, 'an unchanged file is not parsed again');
  fs.writeFileSync(file, JSON.stringify({ v: 1, tasks: {} }));
  assert.equal(meta.readCards(file, 32000), cards, 'a change within 5 s waits');
  assert.equal(meta.readCards(file, 36000).size, 0, 'and is read after 5 s');
});
test('unchanged hook files, rollups and rosters are served from the stat cache; a change is read again', (t) => {
  const dir = fixtureDir(t), now = Date.parse('2026-11-07T12:00:00Z'), file = path.join(dir, 'a.json');
  meta.clearCache();
  fs.writeFileSync(file, JSON.stringify({ sessionId: 's', signal: 'tool-use', tool: 'Bash', updatedAt: '2026-11-07T11:59:00Z' }));
  meta.readMetadata(dir, now, { isAlive: () => true }); meta.readMetadata(dir, now, { isAlive: () => true }); meta.readMetadata(dir, now + 1000, { isAlive: () => true });
  assert.deepEqual([meta.cacheStats.reads, meta.cacheStats.hits], [1, 2]);
  fs.writeFileSync(file, JSON.stringify({ sessionId: 's', signal: 'permission-ask', tool: 'Edit', updatedAt: '2026-11-07T11:59:30Z' }));
  const [row] = meta.readMetadata(dir, now, { isAlive: () => true });
  assert.equal(row.waitingOn, 'Approve Edit'); assert.equal(meta.cacheStats.reads, 2);
  fs.rmSync(file); assert.deepEqual(meta.readMetadata(dir, now, { isAlive: () => true }), [], 'a removed file is gone at once');
});
test('trace tail reads only appended bytes, survives rotation, torn and malformed lines', (t) => {
  const dir = fixtureDir(t), now = 1_800_000_000_000, file = path.join(dir, 'bus-trace.jsonl');
  const line = (o) => JSON.stringify({ trace_id: 'tr_0123456789abcdef', span: 'sp_01234567', ms: 1, reason: null, ...o }) + '\n';
  meta.clearCache();
  fs.writeFileSync(file, line({ t: now - 60000, op: 'handoff', from_handle: 'claude-a-ab12', to: 'codex', provider: 'codex', result: 'ok', ref: 'hof_aaaaaaaaaaaa' }) + 'not json {"ref":"hof_\n');
  assert.equal(meta.readTrace(file, now)[0].state, 'sent');
  const before = meta.cacheStats.reads; meta.readTrace(file, now); assert.equal(meta.cacheStats.reads, before, 'unchanged: no read');
  // A line arriving in two writes is used only once whole.
  fs.appendFileSync(file, line({ t: now - 50000, op: 'claim', result: 'ok', ref: 'hof_aaaaaaaaaaaa' }).slice(0, 20));
  assert.equal(meta.readTrace(file, now)[0].state, 'sent');
  fs.appendFileSync(file, line({ t: now - 50000, op: 'claim', result: 'ok', ref: 'hof_aaaaaaaaaaaa' }).slice(20));
  assert.equal(meta.readTrace(file, now)[0].state, 'claimed');
  // Rotation: the file moves to .1 and a new one starts.
  fs.renameSync(file, `${file}.1`);
  fs.writeFileSync(file, line({ t: now - 40000, op: 'start', provider: 'codex', result: 'ok', ref: 'hof_aaaaaaaaaaaa' }));
  const [h] = meta.readTrace([`${file}.1`, file], now);
  assert.equal(h.state, 'running', 'both halves of a rotated hand-off are joined');
});
test('fallbacks and follow-ons are linked by trace id; a fallback inherits its asker; notes carry no text', (t) => {
  const dir = fixtureDir(t), now = 1_800_000_000_000, file = path.join(dir, 'bus-trace.jsonl');
  const line = (o) => JSON.stringify({ span: 'sp_01234567', ms: 1, reason: null, ...o });
  const asker = 'claude-plexiform-ab12', A = 'tr_aaaaaaaaaaaaaaaa', B = 'tr_bbbbbbbbbbbbbbbb';
  fs.writeFileSync(file, [
    line({ t: now - 90000, trace_id: A, op: 'handoff', from_handle: asker, to: 'any', provider: 'codex', result: 'ok', ref: 'hof_111111111111' }),
    line({ t: now - 89000, trace_id: A, op: 'result', provider: 'codex', result: 'error', reason: 'QUOTA', ref: 'hof_111111111111' }),
    line({ t: now - 88000, trace_id: A, op: 'claim', result: 'ok', ref: 'hof_222222222222' }),
    line({ t: now - 87000, trace_id: A, op: 'start', provider: 'gemini', result: 'ok', ref: 'hof_222222222222' }),
    line({ t: now - 50000, trace_id: B, op: 'handoff', from_handle: asker, to: 'codex-mobile-ab12', provider: 'codex', result: 'ok', ref: 'hof_333333333333' }),
    line({ t: now - 40000, trace_id: B, op: 'handoff', from_handle: 'codex-mobile-ab12', to: 'gemini', provider: 'gemini', result: 'ok', ref: 'hof_444444444444' }),
    line({ t: now - 30000, trace_id: B, op: 'note', from_handle: 'gemini-docs-ab12', to: asker, result: 'ok', ref: 'note_0123456789abcdef' }),
    line({ t: now - 29000, trace_id: B, op: 'note', from_handle: 'gemini-docs-ab12', to: asker, result: 'refused', ref: 'note_1123456789abcdef' }),
    line({ t: now - 28000, trace_id: B, op: 'note', from_handle: 'gemini-docs-ab12', to: 'not a handle', result: 'ok', ref: 'note_2123456789abcdef' }),
  ].join('\n') + '\n');
  const { handoffs, notes } = meta.readBus(file, now);
  const [first, fallback, ask, onward] = handoffs;
  assert.equal(first.state, 'failed'); assert.equal(first.reason, 'out of quota');
  assert.deepEqual([fallback.after, fallback.fallback, fallback.from, fallback.provider, fallback.chain], [first.id, true, asker, 'gemini', first.chain]);
  assert.deepEqual([onward.after, onward.fallback, onward.from], [ask.id, false, 'codex-mobile-ab12'], 'a follow-on hand-off is linked, not a fallback');
  assert.notEqual(ask.chain, first.chain); assert.equal(ask.after, null);
  assert.deepEqual(notes, [{ id: notes[0].id, from: 'gemini-docs-ab12', to: asker, ago_ms: 30000 }], 'only delivered notes between real handles');
  assert(!JSON.stringify({ handoffs, notes }).match(/tr_|note_|hof_/), 'ids are hashed');
});
test('a waiting subagent reports when it began waiting, not when it started', (t) => {
  const dir = fixtureDir(t), now = Date.parse('2026-11-07T12:00:00Z'), at = (min) => new Date(now - min * 60000).toISOString();
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId: 's', signal: 'tool-use', updatedAt: at(0),
    claudeInputRequests: [{ id: 'toolu_1', agentId: 'ag1', kind: 'request', tool: 'Bash', askedAt: at(2) }, { id: 'toolu_2', agentId: 'ag1', kind: 'request', tool: 'Bash', askedAt: at(1) }],
    agents: [{ id: 'ag1', name: 'executor', status: 'waiting', since: at(10) }, { id: 'ag2', name: 'explore', status: 'waiting', since: at(6) }, { id: 'ag3', name: 'codex-kid', status: 'waiting', since: at(8), codexInputRequests: [{ askedAt: at(3) }] }] }));
  const [row] = meta.readMetadata(dir, now, { isAlive: () => true });
  const by = Object.fromEntries(row.subagents.list.map((a) => [a.name, a]));
  assert.equal(by.executor.start_ms, 10 * 60000, 'start stays the start'); assert.equal(by.executor.wait_ms, 2 * 60000, 'oldest open request');
  assert.equal(by['codex-kid'].wait_ms, 3 * 60000); assert.equal(by.explore.wait_ms, null, 'no request: not guessed');
  // Seen working, then waiting: the wait starts when this window saw the change.
  const memory = new Map(), mk = (status) => { const a = Object.defineProperty({ name: 'x', status, start_ms: 60000, end_ms: null, wait_ms: null }, 'aid', { value: 'w' }); return { id: 'r', subagents: Object.defineProperty({ list: [a] }, 'starts', { value: [['w', 60000]] }) }; };
  meta.trackAgents(memory, [mk('working')], 1_000_000);
  const w1 = mk('waiting'); meta.trackAgents(memory, [w1], 1_030_000); assert.equal(w1.subagents.list[0].wait_ms, 0);
  const w2 = mk('waiting'); meta.trackAgents(memory, [w2], 1_090_000); assert.equal(w2.subagents.list[0].wait_ms, 60000);
  const fresh = new Map(), w3 = mk('waiting'); meta.trackAgents(fresh, [w3], 1_000_000); assert.equal(w3.subagents.list[0].wait_ms, null, 'already waiting when first seen: unknown');
});
test('main watches its sources with a debounce, keeps a slow poll, and skips unchanged pushes', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /fs\.watch\(dir/); assert.match(main, /WATCH_DEBOUNCE_MS = \d+/); assert.match(main, /POLL_MS = 10000/);
  assert.doesNotMatch(main, /setInterval\(refresh, 3000\)/);
  assert.match(main, /if \(json === lastSent\) return;/);
  assert.match(main, /work-capture\.json/);
});
