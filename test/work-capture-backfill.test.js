'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWorkCapture } = require('../src/work-capture');

const keyOf = (provider, session, task = 'session') => crypto.createHash('sha256').update(JSON.stringify([provider, session, task])).digest('hex');
const entry = (session, over = {}) => ({ destination: { kind: 'local' }, repo: null, provider: 'codex', session_id: session, task_id: 'session', title: 'Codex · app', status: 'idle', card_id: `card-${session}`, last_seen: 100000, sent_at: 100000, ...over });

// A capture state written before work records: cards with folder-name titles and no body.
function rig(t, { tasks, facts = {}, docFacts = {}, send = null, enabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-backfill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'capture.json');
  const state = { v: 1, install_id: crypto.randomUUID(), tasks: {}, choices: {}, enabled };
  for (const e of tasks) state.tasks[keyOf(e.provider, e.session_id, e.task_id)] = e;
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const calls = [];
  const setup = {
    file, host: 'mac', now: () => 100000 + 60000, home: '/Users/someone',
    getRoutes: async () => ({ routes: [], complete: true }),
    sendLocal: async (body) => { calls.push(body); return send ? send(body) : { ok: true, card: { id: `card-${body.session_id}` }, capture: { tracking: 'active' } }; },
    sendTeam: async () => { throw new Error('a backfill never reaches a team'); },
    factsFor: (o) => facts[o.session_id] ?? null,
    docFactsFor: (o) => docFacts[o.session_id] ?? null,
  };
  let capture = createWorkCapture(setup);
  t.after(() => capture.stop());
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
  return { calls, setup, saved, capture: () => capture, restart: async () => { await capture.stop(); capture = createWorkCapture(setup); return capture; } };
}

test('backfill rebuilds title and body for an old local card in place: update_only, its own status, once', async (t) => {
  const r = rig(t, {
    tasks: [entry('s1')],
    facts: { s1: { cwd: '/Users/someone/work/app', firstPrompt: 'Fix the login redirect loop', lastPrompt: 'Fix the login redirect loop', lastAssistant: 'Fixed it; the cookie path was wrong.', files: { '/Users/someone/work/app/src/login.js': 'edit' } } },
  });
  const out = await r.capture().backfill();
  assert.deepEqual(out, { updated: 1, pending: 0 });
  assert.equal(r.calls.length, 1);
  const b = r.calls[0];
  assert.equal(b.update_only, true);
  assert.equal(b.status, 'idle', 'an Idle card stays Idle');
  assert.equal(b.title, 'Fix the login redirect loop');
  assert.match(b.summary, /^Goal: Fix the login redirect loop/);
  assert.match(b.summary, /cookie path was wrong/);
  assert.match(b.summary, /Files: src\/login\.js/);
  assert.ok(!JSON.stringify(b).includes('/Users/someone'));
  const e = r.saved()[keyOf('codex', 's1')];
  assert.equal(e.backfilled, 1);
  assert.equal(e.title, 'Fix the login redirect loop');
  assert.equal(e.status, 'idle');
  assert.equal(e.card_id, 'card-s1');

  await r.capture().backfill();
  await (await r.restart()).backfill();
  assert.equal(r.calls.length, 1, 'once per card, across restarts');
});

test('only local cards with a card and no live record; the document is the fallback; nothing to say marks done unsent', async (t) => {
  const team = entry('team', { destination: { kind: 'team', hub: 'https://hub.example.test', user_id: 'u', team_id: 't', board_id: 'b', repo_id: 'r' } });
  const r = rig(t, {
    tasks: [entry('doc'), entry('empty'), entry('nocard', { card_id: null, status: null }), entry('untracked', { untracked: true, reason: 'deleted' }), team, entry('reported', { title: 'Ship the release notes', status: 'review' })],
    docFacts: { doc: { cwd: '~/work/app', firstPrompt: 'Add dark mode', lastPrompt: 'Add dark mode', lastAssistant: null, files: {} }, reported: { firstPrompt: 'something else', files: {} } },
  });
  const out = await r.capture().backfill();
  assert.equal(out.pending, 0);
  assert.deepEqual(r.calls.map((c) => c.session_id).sort(), ['doc', 'reported']);
  assert.equal(r.calls.find((c) => c.session_id === 'doc').title, 'Add dark mode');
  const kept = r.calls.find((c) => c.session_id === 'reported');
  assert.equal(kept.title, 'Ship the release notes', 'a reported task title is kept');
  assert.equal(kept.status, 'review');
  const s = r.saved();
  assert.equal(s[keyOf('codex', 'empty')].backfilled, 1);
  assert.equal(s[keyOf('codex', 'empty')].title, 'Codex · app');
  for (const id of ['nocard', 'untracked', 'team']) assert.equal(s[keyOf('codex', id)].backfilled, undefined, id);
});

test('a board that does not answer leaves the card for a later pass; a card the hub no longer has is not recreated', async (t) => {
  let answer = { ok: false };
  const r = rig(t, { tasks: [entry('s1')], facts: { s1: { firstPrompt: 'Write the tests', files: {} } }, send: () => answer });
  assert.deepEqual(await r.capture().backfill(), { updated: 0, pending: 1 });
  assert.equal(r.saved()[keyOf('codex', 's1')].backfilled, undefined);
  answer = { ok: true, card: null, capture: null };
  assert.deepEqual(await r.capture().backfill(), { updated: 0, pending: 0 });
  const e = r.saved()[keyOf('codex', 's1')];
  assert.equal(e.backfilled, 1);
  assert.equal(e.title, 'Codex · app', 'nothing was updated, so nothing changes here');
});

test('paused automatic cards and the per-pass bound are honoured', async (t) => {
  const tasks = Array.from({ length: 30 }, (_, i) => entry(`s${i}`));
  const facts = Object.fromEntries(tasks.map((e) => [e.session_id, { firstPrompt: `Task ${e.session_id}`, files: {} }]));
  const off = rig(t, { tasks, facts, enabled: false });
  assert.equal((await off.capture().backfill()).updated, 0);
  assert.equal(off.calls.length, 0);
  const on = rig(t, { tasks, facts });
  const first = await on.capture().backfill({ limit: 10 });
  assert.deepEqual(first, { updated: 10, pending: 20 });
  assert.equal((await on.capture().backfill()).pending, 0);
  assert.equal(on.calls.length, 30);
});
