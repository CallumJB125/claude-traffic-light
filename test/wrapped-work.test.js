'use strict';
// O3: the person's wrapped tasks (local/cli) that did real work get automatic cards through work-capture's own
// session path (src/wrapped-work.js → workCapture.observe(sessions, { wrapped })): same routing, same team send
// function, same toggle and personal override. Native-only capture is byte-for-byte unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WorkCapture = require('../src/work-capture');
const { createWorkCapture, observation } = WorkCapture;
const { recordsFor, wrappedRecords, SIGNAL } = require('../src/wrapped-work');
const { testTempDir } = require('./helpers/tmp');

const T = 100000;
const R = { hub: 'https://hub.example.test', user_id: 'user-a', team_id: 'team-a', board_id: 'board-a', repo_id: 'repo-a', canonical_url: 'github.com/org/app', role: 'member' };
const row = (extra = {}) => ({ taskId: 'tsk_abc123', ai: 'claude', title: 'Fix the login test', state: 'running', blockedKind: null, root: '/working/app', changedAt: T, ...extra });
const native = (extra = {}) => ({ source: 'codex', sessionId: 'thread-1', host: 'mac', cwd: '/working/app', signal: 'tool-use', updatedAt: new Date(T).toISOString(), ...extra });

function rig(t, opts = {}) {
  const dir = testTempDir('wrapped-work-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  let time = T;
  // Where each send came from: the frame inside work-capture that called sendLocal/sendTeam.
  const site = () => new Error().stack.split('\n').find((l) => l.includes(`src${path.sep}work-capture.js`));
  const setup = { startEnabled: true, file: path.join(dir, 'capture.json'), host: 'mac', getRoutes: async () => ({ routes: [R], complete: true }), resolveRepo: async () => R.canonical_url,
    sendLocal: async (body) => { calls.push({ kind: 'local', body, site: site() }); return { ok: true, card: { id: `local-${calls.length}` } }; },
    sendTeam: async (destination, body) => { calls.push({ kind: 'team', destination, body, site: site() }); return { ok: true, card: { id: `team-${calls.length}` } }; },
    now: () => time, ...opts };
  const router = createWorkCapture(setup);
  t.after(() => router.stop());
  return { dir, calls, router, setup, advance: (n) => { time += n; } };
}
const wrapped = (rows) => recordsFor(rows, { host: 'mac' });

test('records: task state → the status work-capture already uses; failed waits on the person, parked is idle', () => {
  const want = { claimed: 'working', running: 'working', quiet: 'working', handing_over: 'working', blocked: 'waiting', suspended: 'waiting', unresponsive: 'waiting',
    orphaned: 'waiting', failed: 'waiting', in_review: 'review', done: 'ended', parked: 'idle', queued: 'idle' };
  assert.deepEqual(Object.keys(SIGNAL).sort(), Object.keys(want).sort());
  for (const [state, status] of Object.entries(want)) {
    const [rec] = wrapped([row({ state })]);
    assert.equal(observation(rec, { host: 'mac' }).status, status, state);
  }
  assert.deepEqual(wrapped([row({ state: 'handed_over' }), row({ state: 'constructor' }), row({ state: 'toString' })]), []);
});

test('records: only title, state and folder cross; malformed rows are dropped; at most 20', () => {
  const [rec] = wrapped([row({ text: 'SECRET TASK TEXT', lastAssistant: 'AI WORDS', failReason: 'FAIL TEXT', outcome: 'OUTCOME' })]);
  assert.deepEqual(Object.keys(rec).sort(), ['cwd', 'host', 'sessionId', 'signal', 'source', 'taskId', 'taskTitle', 'updatedAt']);
  assert.ok(!/SECRET|AI WORDS|FAIL TEXT|OUTCOME/.test(JSON.stringify(rec)));
  assert.equal(rec.sessionId, 'tsk_abc123');
  assert.equal(rec.taskId, 'tsk_abc123');
  for (const bad of [null, row({ taskId: '../x' }), row({ ai: 'gemini' }), row({ root: 'relative' }), row({ root: null }), row({ changedAt: 'now' })]) assert.deepEqual(wrapped([bad]), []);
  assert.equal(wrapped(Array.from({ length: 30 }, (_, i) => row({ taskId: `tsk_n${i}` }))).length, 20);
  assert.equal(wrapped([row({ title: '' })])[0].taskTitle, undefined);
});

test('a wrapped card goes out through the very same team send call as a native session\'s, with the same title handling', async (t) => {
  const r = rig(t);
  await r.router.observe([native({ taskTitle: 'Fix the login test' })], { wrapped: wrapped([row()]) });
  const team = r.calls.filter((c) => c.kind === 'team');
  assert.equal(team.length, 2);
  const [n, w] = [team.find((c) => c.body.provider === 'codex'), team.find((c) => c.body.provider === 'claude')];
  assert.ok(n.site && w.site);
  assert.equal(w.site, n.site, 'one send site in work-capture, not a copy');
  assert.equal(w.body.title, n.body.title, 'same title for the same reported title');
  assert.equal(w.body.task_id, 'tsk_abc123');
  assert.equal(w.body.session_id, 'tsk_abc123');
  assert.equal(w.body.status, 'working');
  assert.equal(w.body.summary, undefined, 'no summary');
  assert.ok(!JSON.stringify(r.calls).includes('/working'));
});

test('two wrapped tasks with the same title in one repo are two cards; a native session with that title is a third', async (t) => {
  const r = rig(t);
  await r.router.observe([native({ taskTitle: 'Fix it' })], { wrapped: wrapped([row({ title: 'Fix it' }), row({ taskId: 'tsk_def456', title: 'Fix it' })]) });
  // (The settings list groups same-titled rows for display; the cards themselves are three.)
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(r.setup.file)).tasks).length, 3);
  assert.equal(new Set(r.calls.map((c) => `${c.body.provider}|${c.body.session_id}`)).size, 3);
});

test('states move one card: working → waiting → ended; a repeated poll sends nothing new', async (t) => {
  const r = rig(t);
  await r.router.observe([], { wrapped: wrapped([row()]) });
  await r.router.observe([], { wrapped: wrapped([row()]) });
  assert.equal(r.calls.length, 1);
  r.advance(1000);
  await r.router.observe([], { wrapped: wrapped([row({ state: 'blocked', changedAt: T + 1000 })]) });
  r.advance(1000);
  await r.router.observe([], { wrapped: wrapped([row({ state: 'done', changedAt: T + 2000 })]) });
  assert.deepEqual(r.calls.map((c) => c.body.status), ['working', 'waiting', 'ended']);
  assert.equal(r.router.snapshot().length, 1);
});

test('personal folder → My board; ambiguous → local needing routing; viewer → local, team read only', async (t) => {
  const r = rig(t);
  await r.router.observe([], { wrapped: wrapped([row()]).map((x) => ({ ...x, scope: { state: 'personal' } })) });
  assert.equal(r.calls[0].kind, 'local');
  assert.equal(r.calls[0].body.title, 'Fix the login test');
  assert.ok(!r.calls[0].body.summary, 'My board card: title and status only');
  const B = { ...R, team_id: 'team-b', board_id: 'board-b', repo_id: 'repo-b' };
  const amb = rig(t, { getRoutes: async () => ({ routes: [R, B], complete: true }) });
  await amb.router.observe([], { wrapped: wrapped([row()]) });
  assert.deepEqual(amb.router.snapshot()[0].destination, { kind: 'local', needs_routing: true });
  const view = rig(t, { getRoutes: async () => ({ routes: [{ ...R, role: 'viewer' }], complete: true }) });
  await view.router.observe([], { wrapped: wrapped([row()]) });
  assert.equal(view.router.snapshot()[0].destination.reason, 'team_read_only');
});

test('automatic cards off: no card for wrapped work either', async (t) => {
  const r = rig(t);
  r.router.setEnabled(false);
  await r.router.observe([native()], { wrapped: wrapped([row()]) });
  assert.equal(r.calls.length, 0);
});

test('hub down: the card is retried later and nothing waits on it', async (t) => {
  let up = false;
  const r = rig(t);
  const flaky = rig(t, { sendTeam: async (d, body) => (up ? r.setup.sendTeam(d, body) : { ok: false }) });
  await flaky.router.observe([], { wrapped: wrapped([row()]) });
  assert.equal(flaky.router.snapshot()[0].card_id, null);
  up = true;
  flaky.advance(61_000);
  await flaky.router.observe([], { wrapped: wrapped([row({ changedAt: T + 61_000 })]) });
  assert.ok(flaky.router.snapshot()[0].card_id);
});

test('a hostile title is cleaned like a session\'s: no paths, secrets or control characters', async (t) => {
  const r = rig(t);
  const title = 'Fix /Users/me/secret‮ ghp_0123456789abcdefghijABCDEFGHIJ0123456789 https://u:p@example.com/x?token=1';
  await r.router.observe([native({ taskTitle: title })], { wrapped: wrapped([row({ title })]) });
  const [a, b] = r.calls.map((c) => c.body.title);
  assert.equal(a, b);
  assert.ok(!/\/Users|‮|ghp_0123|u:p@|token=1/.test(b));
});

test('caps: at most 50 sessions and then at most 20 wrapped tasks per pass', async (t) => {
  const r = rig(t, { getRoutes: async () => ({ routes: [], complete: true }) });
  const sessions = Array.from({ length: 55 }, (_, i) => native({ sessionId: `s-${i}`, cwd: `/working/s${i}`, taskTitle: `Session ${i}` }));
  const rows = Array.from({ length: 25 }, (_, i) => ({ source: 'claude', sessionId: `tsk_w${i}`, taskId: `tsk_w${i}`, host: 'mac', cwd: `/working/w${i}`, taskTitle: `Task ${i}`, signal: 'tool-use', updatedAt: new Date(T).toISOString() }));
  await r.router.observe(sessions, { wrapped: rows });
  const ids = r.calls.map((c) => c.body.session_id);
  assert.equal(ids.filter((id) => id.startsWith('s-')).length, 50);
  assert.equal(ids.filter((id) => id.startsWith('tsk_w')).length, 20);
});

test('native only: with no wrapped records, the capture file bytes and every send are exactly as before', async (t) => {
  const seed = rig(t);
  await seed.router.stop();
  const start = fs.readFileSync(seed.setup.file);
  const run = async (observe) => {
    const r = rig(t);
    await r.router.stop();
    fs.writeFileSync(r.setup.file, start);
    const router = createWorkCapture(r.setup);
    t.after(() => router.stop());
    const sessions = [native({ taskTitle: 'Fix route' }), native({ sessionId: 'thread-2', cwd: '/working/other', signal: 'stop' })];
    await observe(router, sessions);
    r.advance(31_000);
    await observe(router, []);
    await router.stop();
    return { bytes: fs.readFileSync(r.setup.file), calls: JSON.stringify(r.calls.map(({ site, ...c }) => c)) };
  };
  const before = await run((router, s) => router.observe(s));
  const empty = await run((router, s) => router.observe(s, { wrapped: [] }));
  const none = await run((router, s) => router.observe(s, {}));
  assert.ok(JSON.parse(before.calls).length >= 3, 'cards were really sent (not a paused capture)');
  assert.ok(before.bytes.equals(empty.bytes), 'byte-identical capture file');
  assert.ok(before.bytes.equals(none.bytes));
  assert.equal(empty.calls, before.calls);
});

test('an untitled task: its prompt\'s first line never reaches a team, even with summaries shared; My board shows it', async (t) => {
  const PROMPT = 'Tell Dana her review score is 2/5 before the layoffs list';
  const untitled = row({ title: null, localTitle: PROMPT });
  for (const share of [false, true]) {
    const r = rig(t, { getRoutes: async () => ({ routes: [{ ...R, share_summaries: share }], complete: true }) });
    await r.router.observe([], { wrapped: wrapped([untitled]) });
    r.advance(1000);
    await r.router.observe([], { wrapped: wrapped([{ ...untitled, state: 'in_review', changedAt: T + 1000 }]) });
    assert.ok(r.calls.length >= 1 && r.calls.every((c) => c.kind === 'team'));
    assert.match(r.calls[0].body.title, /^Claude(?: Code)? · app$/, 'the AI and folder, like a native session');
    assert.ok(!JSON.stringify(r.calls).includes('Dana'), `share_summaries=${share}: the prompt stays on this Mac`);
    assert.ok(!JSON.stringify(await r.router.shareableRecords()).includes('Dana'));
  }
  const mine = rig(t);
  await mine.router.observe([], { wrapped: wrapped([untitled]).map((x) => ({ ...x, scope: { state: 'personal' } })) });
  assert.equal(mine.calls[0].kind, 'local');
  assert.equal(mine.calls[0].body.title, PROMPT);
});

test('main\'s records: wrappedRecords applies scopeFor, so a personal folder\'s task goes to My board', async (t) => {
  const scopeFor = (recs) => recs.map((x) => ({ ...x, scope: x.cwd === '/personal/notes' ? { state: 'personal' } : null }));
  const recs = wrappedRecords([row({ taskId: 'tsk_mine', root: '/personal/notes' }), row({ taskId: 'tsk_team' })], { host: 'mac', scopeFor });
  const r = rig(t);
  await r.router.observe([], { wrapped: recs });
  const byTask = Object.fromEntries(r.calls.map((c) => [c.body.session_id, c.kind]));
  assert.deepEqual(byTask, { tsk_mine: 'local', tsk_team: 'team' });
});

test('a wrapped task\'s title is scrubbed by hubTitle on the team send, exactly as a session\'s (#52)', async (t) => {
  const title = 'Fix login for dana@corp.example on 10.1.2.3';
  const r = rig(t);
  await r.router.observe([native({ sessionId: 'n1', taskTitle: title, cwd: '/working/other' })], { wrapped: wrapped([row({ title })]) });
  const team = r.calls.filter((c) => c.kind === 'team');
  assert.equal(team.length, 2);
  assert.equal(team[0].body.title, team[1].body.title, 'the same scrubbed title for both');
  assert.ok(!/dana@|10\.1\.2\.3/.test(JSON.stringify(team)), 'no email or IP reaches the hub');
  assert.equal(team[1].body.title, WorkCapture.hubTitle(title, R.hub));
});
