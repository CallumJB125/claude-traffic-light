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
