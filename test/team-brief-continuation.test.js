'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { createTeamActivity, briefText, record } = require('../src/team-activity');
const Brief = require('../hooks/team-brief');
const Receipt = require('../hooks/team-brief-receipt');

function fixture() {
  const state = { on: true, sharing: true, user: 'u1', reads: 0, afterRead: null, rows: [
    { record_id: 'peer', session_id: 'peer-session', author: { name: 'Alex' }, adapter: 'claude', title: 'Authentication', summary: 'Use the shared callback.', status: 'working', files: { edited: ['src/auth.js'], read: [] }, rev: 1 },
    { record_id: 'other', session_id: 'other-session', author: { name: 'Sam' }, adapter: 'codex', title: 'Documentation', status: 'working', files: { edited: ['README.md'], read: [] }, rev: 1 },
    { record_id: 'self', session_id: 's-me', author: { name: 'Me' }, adapter: 'claude', title: 'Private self context', status: 'working', files: { edited: [], read: [] }, rev: 1 },
  ] };
  const create = () => createTeamActivity({ enabled: () => state.on,
    resolve: async () => ({ repo: 'acme/app', route: { hub: 'http://127.0.0.1:1', team_id: 't1', repo_id: 'r1', user_id: state.user, share_summaries: state.sharing }, token: () => 'synthetic-token' }),
    fetch: async () => { state.reads++; const body = JSON.stringify({ records: state.rows }); state.afterRead?.(); return { status: 200, headers: { get: () => null }, text: async () => body }; },
  });
  return { state, create, svc: create() };
}

test('bounded version deltas report only changed shared records; snapshots recover after app restart', async () => {
  const { state, svc, create } = fixture();
  const args = { cwd: '/repo', session: 's-me' };
  const first = await svc.brief(args);
  assert.equal(first.mode, 'snapshot');
  assert.match(first.brief, /Use the shared callback/);
  assert.doesNotMatch(first.brief, /Private self context/);
  assert.equal(first.agent_acknowledgement, 'not_observed');
  assert.equal(first.authority, 'advisory_only');
  assert.ok((briefText('a'.repeat(80), state.rows.map(record), { max: 200 }) || '').length <= 200);
  assert.equal((await svc.brief({ ...args, since_version: first.version })).brief, null);
  assert.equal((await create().brief({ ...args, since_version: first.version })).mode, 'snapshot', 'restart refreshes even an unchanged version');
  state.rows[0].summary = 'Changed decision: use a separate callback.';
  state.rows[0].rev++;
  const delta = await svc.brief({ ...args, since_version: first.version });
  assert.equal(delta.mode, 'changes');
  assert.match(delta.brief, /Changed decision: use a separate callback/);
  assert.doesNotMatch(delta.brief, /Documentation/);
  assert.ok(delta.brief.length <= 1500);
  const restart = await create().brief({ ...args, since_version: first.version });
  assert.equal(restart.mode, 'snapshot');
  assert.match(restart.brief, /Documentation/);
  state.rows = state.rows.filter((r) => r.record_id !== 'peer');
  assert.match((await svc.brief({ ...args, since_version: delta.version })).brief, /no longer appear.*does not establish completion/);
});

test('cached brief versions do not survive revoked sharing, setting changes or account changes during fetch', async () => {
  for (const change of [(s) => { s.sharing = false; }, (s) => { s.on = false; }, (s) => { s.user = 'u2'; }]) {
    const { state, svc } = fixture();
    const first = await svc.brief({ cwd: '/repo' });
    state.afterRead = () => change(state);
    const next = await svc.brief({ cwd: '/repo', since_version: first.version });
    assert.equal(next.available, false);
    assert.equal(next.brief, undefined);
  }
});

async function app(t, svc) {
  const root = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'px-brief-'));
  const token = 'a'.repeat(64);
  const server = http.createServer(async (req, res) => {
    if (req.headers['x-buddy-token'] !== token) { res.writeHead(401); res.end(); return; }
    let input = ''; for await (const c of req) input += c;
    const body = JSON.parse(input);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await svc.call(body.op, body.args)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ teamBrief: true }));
  fs.writeFileSync(path.join(root, 'port'), String(server.address().port));
  fs.writeFileSync(path.join(root, 'token'), token);
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('prepared context is not a delivery receipt; reset restores unchanged context and unsupported turns stay silent', async (t) => {
  const { svc } = fixture();
  const root = await app(t, svc);
  const opts = { root, adapter: 'claude', payload: { cwd: '/repo', session_id: 's-me' } };
  const file = Receipt.fileFor(root, 'claude', 's-me', '/repo');
  const out = await Brief.run(opts);
  assert.equal(Receipt.read(file), null);
  assert.equal(Brief.recordDelivered(out), true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.status, 'hook_output_written');
  assert.equal(saved.agent_acknowledgement, 'not_observed');
  assert.doesNotMatch(JSON.stringify(saved), /callback|Authentication|synthetic-token/);
  assert.equal(await Brief.run({ ...opts, event: 'UserPromptSubmit' }), null);
  assert.ok(await Brief.run({ ...opts, payload: { ...opts.payload, source: 'compact' } }));
  assert.ok(await Brief.run({ ...opts, payload: { ...opts.payload, source: 'resume' } }));
  for (const adapter of ['codex', 'gemini', 'cursor']) assert.equal(await Brief.run({ ...opts, adapter, event: 'UserPromptSubmit' }), null);
  assert.equal(await Brief.run({ ...opts, event: 'PreCompact' }), null);
});

test('real Claude hook writes changed turn context despite fast-hook and restores post-compaction context', async (t) => {
  const { state, svc } = fixture();
  const root = await app(t, svc);
  let forwarded = 0;
  const socket = require('../src/hook-socket').create({ rootDir: root, handle: () => { forwarded++; return true; } });
  assert.equal(await socket.start(), true);
  t.after(() => socket.stop());
  const run = (signal, extra = {}) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(__dirname, '../hooks/set-status.js'), signal], { timeout: 10000,
      env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: root, HOME: root } }, (err, stdout) => err ? reject(err) : resolve(stdout));
    child.stdin.end(JSON.stringify({ session_id: 's-me', cwd: '/repo', source: 'startup', ...extra }));
  });
  const started = JSON.parse(await run('session-start'));
  assert.equal(started.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(await run('prompt-submit'), '');
  state.rows[0].rev++;
  state.rows[0].summary = 'New shared decision.';
  const turn = JSON.parse(await run('prompt-submit'));
  assert.equal(turn.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(turn.hookSpecificOutput.additionalContext, /New shared decision/);
  assert.equal(forwarded, 0, 'status-only fast path must not swallow context');
  const compact = JSON.parse(await run('session-start', { hook_event_name: 'SessionStart', source: 'compact' }));
  assert.equal(compact.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(compact.hookSpecificOutput.additionalContext, /Documentation/);
});
