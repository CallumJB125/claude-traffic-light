const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WorkRecord = require('../src/work-record');
const { factsFrom } = require('../src/handover-transcripts');
const { createWorkCapture } = require('../src/work-capture');

const INSTALL = '11111111-2222-4333-8444-555555555555';
const HOME = '/Users/someone';
const o = (extra = {}) => ({ provider: 'codex', session_id: 'thread-1', task_id: 'session', status: 'working', cwd: '/Users/someone/dev/app', ...extra });
const facts = (extra = {}) => ({
  cwd: '/Users/someone/dev/app', startedAt: '2026-10-07T10:00:00.000Z', lastActive: '2026-10-07T10:05:00.000Z',
  firstPrompt: 'Add retry to the payment webhook so failed deliveries are replayed', lastPrompt: 'now also cover the timeout case in tests',
  lastAssistant: 'Added exponential backoff in src/webhook.js and a timeout test.', branch: 'feat/retry',
  files: { '/Users/someone/dev/app/src/webhook.js': 'edit', 'test/webhook.test.js': 'edit', '/Users/someone/dev/app/README.md': 'read', '/etc/hosts': 'read', '../other/secret.js': 'edit' },
  ...extra,
});
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'work-record-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('a record is titled by the latest request, never the folder alone, with goal, summary, repo-relative files and branch', () => {
  const r = WorkRecord.build({ install_id: INSTALL, o: o(), raw: { updatedAt: '2026-10-07T10:05:00.000Z' }, facts: facts(), home: HOME });
  assert.equal(r.v, 1);
  assert.equal(r.record_id, `${INSTALL}:codex:thread-1`);
  assert.equal(r.title, 'now also cover the timeout case in tests');
  assert.match(r.goal, /^Add retry to the payment webhook/);
  assert.match(r.summary, /exponential backoff/);
  assert.deepEqual(r.files, { edited: ['src/webhook.js', 'test/webhook.test.js'], read: ['README.md'] });
  assert.equal(r.branch, 'feat/retry');
  assert.equal(r.folder, 'app');
  assert.equal(r.repo_id, null);
  assert.equal(r.status, 'working');
  assert.equal(r.started_at, '2026-10-07T10:00:00.000Z');
  assert.equal(r.cost_usd, null);
  assert.ok(r.title.length <= 120 && r.goal.length <= 400 && r.summary.length <= 1500);
});

test('explicit task title and summary win; limit hit is paused_limit; spend and handover are carried only in their contract shape', () => {
  const r = WorkRecord.build({ install_id: INSTALL, o: o({ status: 'waiting' }), raw: { taskTitle: 'Payment retries', taskSummary: 'Half done', signal: 'limit-hit' }, facts: facts(), home: HOME,
    spend: { cost_usd: 1.234567, route: 'secondary' }, handover: { available: true, written_at: Date.parse('2026-10-07T10:06:00.000Z'), path: '/secret/doc.md' } });
  assert.equal(r.title, 'Payment retries'); assert.equal(r.summary, 'Half done'); assert.equal(r.status, 'paused_limit');
  assert.equal(r.cost_usd, 1.2346); assert.equal(r.route, 'secondary');
  assert.deepEqual(r.handover, { available: true, written_at: '2026-10-07T10:06:00.000Z' });
  const bare = WorkRecord.build({ install_id: INSTALL, o: o(), raw: {}, facts: null });
  assert.equal(bare.title, 'Codex · app'); assert.equal(bare.goal, ''); assert.deepEqual(bare.files, { edited: [], read: [] });
});

test('free text is redacted of secrets and the home folder, and stripped of control characters', () => {
  const token = `ghp_${'A'.repeat(36)}`;
  const r = WorkRecord.build({ install_id: INSTALL, o: o(), raw: {}, home: HOME,
    facts: facts({ lastPrompt: `deploy with ${token}‮ from /Users/someone/dev/app`, lastAssistant: 'password=hunter2hunter2 mail me at a@b.example' }) });
  assert.ok(!r.title.includes(token) && !r.title.includes('‮') && !r.title.includes('/Users/someone'));
  assert.match(r.title, /~\/dev\/app/);
  assert.ok(!r.summary.includes('hunter2hunter2') && !r.summary.includes('a@b.example'));
});

test('rev increments only on a content change and survives a restart', (t) => {
  const dir = tmp(t), file = path.join(dir, 'records.json');
  let s = WorkRecord.createWorkRecords({ file });
  const base = WorkRecord.build({ install_id: INSTALL, o: o(), raw: { updatedAt: '2026-10-07T10:05:00.000Z' }, facts: facts(), home: HOME });
  assert.equal(s.upsert(base).rev, 1);
  assert.equal(s.upsert({ ...base, updated_at: '2026-10-07T10:09:00.000Z' }).rev, 1);
  assert.equal(s.upsert({ ...base, status: 'review' }).rev, 2);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  s = WorkRecord.createWorkRecords({ file });
  assert.equal(s.get(base.record_id).rev, 2);
  assert.equal(s.setStatus(base.record_id, 'idle').rev, 3);
  assert.equal(s.list().length, 1);
});

test('forShare: nothing without share_summaries, no paths without share_files, every text fully scrubbed with a stable salt', () => {
  const rec = { ...WorkRecord.build({ install_id: INSTALL, o: o(), raw: {}, facts: facts({ lastAssistant: 'Changed ~/dev/app/src/webhook.js for acme-payments' }), home: HOME }), rev: 4 };
  assert.equal(WorkRecord.forShare(rec, { share_summaries: false, share_files: true }, { salt: 's' }), null);
  assert.equal(WorkRecord.forShare(rec, { share_files: true }, { salt: 's' }), null);
  const summaries = WorkRecord.forShare(rec, { share_summaries: true, repo_id: 'repo-a' }, { salt: 's' });
  assert.deepEqual(summaries.files, { edited: [], read: [] });
  assert.equal(summaries.repo_id, 'repo-a'); assert.equal(summaries.rev, 4);
  assert.doesNotMatch(summaries.summary, /webhook\.js/);
  assert.deepEqual(WorkRecord.forShare(rec, { share_summaries: true, share_files: true }, { salt: 's' }), WorkRecord.forShare(rec, { share_summaries: true, share_files: true }, { salt: 's' }));
  assert.deepEqual(WorkRecord.forShare(rec, { share_summaries: true, share_files: true }, { salt: 's' }).files.edited, ['src/webhook.js', 'test/webhook.test.js']);
});

test('the card body round-trips through the board renderer and fits the hub limit', async () => {
  const { recordParts } = await import('../board/web/js/render-capture.js');
  const rec = WorkRecord.build({ install_id: INSTALL, o: o(), raw: {}, facts: facts(), home: HOME });
  const parts = recordParts(WorkRecord.cardBody(rec));
  assert.equal(parts.goal, rec.goal); assert.equal(parts.summary, rec.summary); assert.deepEqual(parts.files, rec.files.edited); assert.equal(parts.more, 0);
  const many = { ...rec, summary: 'x'.repeat(1500), goal: 'g'.repeat(400), files: { edited: Array.from({ length: 50 }, (_, i) => `src/file-${i}.js`), read: [] } };
  const body = WorkRecord.cardBody(many);
  assert.ok(body.length <= 2000);
  assert.equal(recordParts(body).more, 42);
  assert.deepEqual(recordParts('just a plain old summary'), { goal: null, summary: 'just a plain old summary', files: [], more: 0 });
});

test('transcript facts carry the branch for the record', (t) => {
  const dir = tmp(t), claude = path.join(dir, 'c.jsonl'), codex = path.join(dir, 'x.jsonl');
  fs.writeFileSync(claude, `${JSON.stringify({ type: 'user', cwd: '/w/app', gitBranch: 'feat/x', timestamp: '2026-10-07T10:00:00Z', message: { role: 'user', content: 'do it' } })}\n`);
  fs.writeFileSync(codex, `${JSON.stringify({ type: 'session_meta', timestamp: '2026-10-07T10:00:00Z', payload: { cwd: '/w/app', git: { branch: 'main' } } })}\n`);
  assert.equal(factsFrom(claude, { adapter: 'claude-code', sessionId: 's' }).branch, 'feat/x');
  assert.equal(factsFrom(codex, { adapter: 'codex', sessionId: 's' }).branch, 'main');
});

// ── work-capture integration ──
const R = { hub: 'https://hub.example.test', user_id: 'user-a', team_id: 'team-a', board_id: 'board-a', repo_id: 'repo-a', canonical_url: 'github.com/org/app', role: 'member' };
const event = (extra = {}) => ({ source: 'codex', sessionId: 'thread-1', host: 'mac', cwd: '/Users/someone/dev/app', signal: 'tool-use', updatedAt: new Date(100000).toISOString(), ...extra });
function rig(t, opts = {}) {
  const dir = tmp(t), calls = [];
  const setup = { startEnabled: true, file: path.join(dir, 'capture.json'), host: 'mac', home: HOME, now: () => 100000,
    getRoutes: async () => ({ routes: [], complete: true }), resolveRepo: async () => R.canonical_url,
    sendLocal: async (body) => { calls.push({ kind: 'local', body }); return { ok: true, card: { id: `local-${calls.length}` } }; },
    sendTeam: async (destination, body) => { calls.push({ kind: 'team', destination, body }); return { ok: true, card: { id: `team-${calls.length}` } }; },
    factsFor: () => facts(), ...opts };
  const router = createWorkCapture(setup); t.after(() => router.stop());
  return { dir, calls, router, setup };
}

test('a local card gets the record title and a goal/summary/files body; the record is stored locally', async (t) => {
  const r = rig(t, { handoverFor: () => ({ available: true, written_at: 99000 }) });
  await r.router.observe([event()]);
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].kind, 'local');
  assert.equal(r.calls[0].body.title, 'now also cover the timeout case in tests');
  assert.match(r.calls[0].body.summary, /^Goal: Add retry/);
  assert.match(r.calls[0].body.summary, /Files: src\/webhook\.js, test\/webhook\.test\.js$/);
  const [rec] = r.router.localRecords();
  assert.equal(rec.rev, 1); assert.equal(rec.handover.available, true);
  assert.ok(fs.existsSync(path.join(r.dir, 'work-records.json')));
  assert.deepEqual(await r.router.shareableRecords(), []);
});

test('team cards: no prompt or body without share_summaries; scrubbed body with share_summaries; paths only with share_files', async (t) => {
  const quiet = rig(t, { getRoutes: async () => ({ routes: [R], complete: true }) });
  await quiet.router.observe([event()]);
  assert.equal(quiet.calls[0].kind, 'team'); assert.equal(quiet.calls[0].body.title, 'Codex · app'); assert.equal(quiet.calls[0].body.summary, undefined);
  assert.ok(!JSON.stringify(quiet.calls).includes('timeout case'));
  assert.deepEqual(await quiet.router.shareableRecords(), []);

  const sharing = rig(t, { getRoutes: async () => ({ routes: [{ ...R, share_summaries: true }], complete: true }) });
  await sharing.router.observe([event()]);
  assert.match(sharing.calls[0].body.summary, /^Goal: /); assert.doesNotMatch(sharing.calls[0].body.summary, /Files:|webhook\.js/);
  const [shared] = await sharing.router.shareableRecords();
  assert.deepEqual(shared.destination, { hub: R.hub, user_id: R.user_id, team_id: R.team_id, board_id: R.board_id, repo_id: R.repo_id });
  assert.equal(shared.record.repo_id, 'repo-a'); assert.deepEqual(shared.record.files, { edited: [], read: [] });
  assert.ok(!JSON.stringify(shared).includes('/Users/someone'));

  const files = rig(t, { getRoutes: async () => ({ routes: [{ ...R, share_summaries: true, share_files: true }], complete: true }) });
  await files.router.observe([event()]);
  assert.match(files.calls[0].body.summary, /Files: src\/webhook\.js/);
  assert.deepEqual((await files.router.shareableRecords())[0].record.files.edited, ['src/webhook.js', 'test/webhook.test.js']);
});

test('background memories runs found through their facts and repeated sessions on one request get no extra card', async (t) => {
  const r = rig(t, { factsFor: (x) => (x.session_id === 'mem' ? facts({ lastPrompt: 'memories', firstPrompt: 'memories' }) : facts()) });
  await r.router.observe([event({ sessionId: 'mem' }), event({ sessionId: 'thread-1', updatedAt: new Date(99000).toISOString() }), event({ sessionId: 'thread-2' })]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.router.snapshot().length, 1);
  assert.equal(r.router.localRecords().length, 1);
  assert.equal(r.router.localRecords()[0].session_id, 'thread-2');
});
