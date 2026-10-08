import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tenancy } from '../board/hub/test/tenancy/fixture.js';
const require = createRequire(import.meta.url);
const { createWorkCapture, repoFor } = require('../src/work-capture.js');
const { createAccountClient } = require('../buddy-window/accounts.js');
const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-independent-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const event = (at, extra = {}) => ({ source: 'codex', sessionId: 'independent-task', host: 'fixture', cwd: '/synthetic/not-read',
  signal: 'tool-use', taskTitle: 'Synthetic reported work', updatedAt: new Date(at).toISOString(), ...extra });

async function actual(t, overrides = {}) {
  const dir = tmp(t), f = await tenancy(); t.after(() => f.h.close()); let share = false;
  const user = f.users.amember, client = createAccountClient({ origin: f.h.base,
    store: { load: () => ({ hub: f.h.base, token: user.token, device_id: user.device_id, user: { id: user.id } }), clear() {} } });
  const setup = { file: path.join(dir, 'capture.json'), host: 'fixture', now: () => f.h.hub.wallMs(), resolveRepo: async () => 'github.com/shared/app',
    getRoutes: async () => { const r = await client.captureRoutes(); assert.equal(r.ok, true); return { ...r,
      routes: r.routes.map((route) => ({ ...route, hub: f.h.base, user_id: user.id, share_summaries: share })) }; },
    sendTeam: (destination, body) => client.captureWork(destination.team_id, destination.board_id, body),
    sendLocal: async () => { throw new Error('unexpected personal destination'); }, ...overrides };
  const router = createWorkCapture(setup); t.after(() => router.stop());
  return { f, router, setup, setShare: (on) => share = on, advance: (ms) => f.h.clock.advance(ms),
    at: () => f.h.hub.wallMs(), send: setup.sendTeam };
}

test('independent actual HTTP: summary preference change cannot renew a stale working observation', async (t) => {
  const r = await actual(t), original = event(r.at(), { taskSummary: 'Explicitly shared synthetic brief' });
  await r.router.observe([original]); const row = r.f.db.get('SELECT * FROM work_capture_cards'); assert.ok(row);
  r.advance(61_001); r.setShare(true);
  await r.router.observe([original]);
  const card = await r.f.as(r.f.users.amember, 'GET', `/api/cards/${row.card_id}`);
  t.diagnostic(`after a61s-old observation with a changed summary preference: fresh=${card.body.card.capture.fresh}, status=${card.body.card.capture.status}`);
  assert.equal(card.body.card.capture.fresh, false, 'a preference change is not a new source observation');
});

test('independent actual HTTP: a lost-response retry after the source expires cannot refresh receipt freshness', async (t) => {
  const r = await actual(t); await r.router.stop(); let attempts = 0;
  const again = createWorkCapture({ ...r.setup, sendTeam: async (destination, body) => {
    const result = await r.send(destination, body); return ++attempts === 1 ? { ok: false } : result;
  } }); t.after(() => again.stop());
  const original = event(r.at()); await again.observe([original]);
  const row = r.f.db.get('SELECT * FROM work_capture_cards'); assert.ok(row); assert.equal(again.snapshot()[0].card_id, null);
  r.advance(61_001); await again.observe([original]);
  const card = await r.f.as(r.f.users.amember, 'GET', `/api/cards/${row.card_id}`);
  t.diagnostic(`lost-response attempts=${attempts},61s-old report fresh=${card.body.card.capture.fresh}`);
  assert.equal(card.body.card.capture.fresh, false, 'retry delivery cannot turn old input into a new activity report');
  assert.equal(r.f.db.get('SELECT COUNT(*) n FROM work_capture_cards').n, 1);
});

test('independent: failed missing-session idle reports must respect a retry budget', async (t) => {
  const dir = tmp(t); let time = 100_000, idleAttempts = 0;
  const route = { hub: 'https://fixture.test', user_id: 'user', team_id: 'team', board_id: 'board', repo_id: 'repo', role: 'member', canonical_url: 'github.com/org/app' };
  const router = createWorkCapture({ file: path.join(dir, 'state.json'), host: 'fixture', now: () => time,
    resolveRepo: async () => route.canonical_url, getRoutes: async () => ({ routes: [route], complete: true }),
    sendLocal: async () => ({ ok: false }), sendTeam: async (_, body) => body.status === 'idle' ? (++idleAttempts, { ok: false }) : ({ ok: true, card: { id: 'card' } }) });
  t.after(() => router.stop()); await router.observe([event(time)]); time += 31_000;
  for (let i = 0; i < 64; i++) await router.observe([]);
  t.diagnostic(`unchanged clock,64 polls: idle attempts=${idleAttempts}`);
  assert.ok(idleAttempts <= 1, 'failed idle synthesis must use the normal15s attempt backoff');
});

test('independent actual Git: query/fragment credentials cannot enter private routing state or renderer projection', async (t) => {
  const dir = tmp(t), repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://user:synthetic-userinfo@github.com/org/app.git?access_token=synthetic-query-secret#synthetic-fragment-secret']);
  const normalized = await repoFor(repo); t.diagnostic(`Git lookup returns query=${normalized?.includes('?')}, fragment=${normalized?.includes('#')}`);
  const router = createWorkCapture({ file: path.join(dir, 'capture.json'), host: 'fixture', now: () => 100_000,
    getRoutes: async () => ({ routes: [], complete: true }), sendLocal: async () => ({ ok: true, card: { id: 'personal' } }), sendTeam: async () => ({ ok: false }) });
  t.after(() => router.stop()); await router.observe([event(100_000, { cwd: repo })]);
  const projected = JSON.stringify(router.snapshot()), stored = fs.readFileSync(path.join(dir, 'capture.json'), 'utf8');
  for (const secret of ['synthetic-userinfo', 'synthetic-query-secret', 'synthetic-fragment-secret']) {
    assert.ok(!projected.includes(secret), 'routing snapshot must not expose Git credentials to the renderer');
    assert.ok(!stored.includes(secret), 'private routing choices must retain only a closed canonical repo identity');
  }
});

test('independent: valid retained task state cannot grow beyond its own restart read ceiling', async (t) => {
  const dir = tmp(t), file = path.join(dir, 'capture.json');
  const route = { hub: 'https://fixture.test', user_id: crypto.randomUUID(), team_id: crypto.randomUUID(), board_id: crypto.randomUUID(), repo_id: crypto.randomUUID(),
    role: 'member', canonical_url: 'github.com/org/app', team_name: 'T'.repeat(60), board_name: 'B'.repeat(60) };
  const state = { v: 1, install_id: crypto.randomUUID(), tasks: {}, choices: {} };
  const entry = { destination: { kind: 'team', ...route }, repo: route.canonical_url, provider: 'codex', session_id: 's'.repeat(120), task_id: 't'.repeat(120),
    title: 'Title'.repeat(40), status: 'working', card_id: crypto.randomUUID(), last_seen: 100_000, attempt_fingerprint: 'a'.repeat(64), attempt_at: 100_000,
    fingerprint: 'b'.repeat(64), sent_at: 100_000, untracked: true, reason: 'stopped' };
  let index = 0;
  while (JSON.stringify(state).length < 2 * 1024 * 1024 - 25_000) {
    const retained = { ...entry, card_id: crypto.randomUUID(), session_id: 's'.repeat(114) + String(index++).padStart(4, '0') };
    const key = crypto.createHash('sha256').update(JSON.stringify([retained.provider, retained.session_id, retained.task_id])).digest('hex');
    state.tasks[key] = retained;
    assert.ok(index < 1900);
  }
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const setup = { file, host: 'fixture', now: () => 100_000, getRoutes: async () => ({ routes: [route], complete: true }), resolveRepo: async () => route.canonical_url,
    sendTeam: async () => ({ ok: true, card: { id: crypto.randomUUID() } }), sendLocal: async () => ({ ok: false }) };
  const router = createWorkCapture(setup); t.after(() => router.stop());
  await router.observe(Array.from({ length: 50 }, (_, i) => event(100_000, { sessionId: `new${i}`, taskTitle: 'Title'.repeat(40) })));
  const size = fs.statSync(file).size; t.diagnostic(`retained=${index}, final=${router.snapshot().length}, saved bytes=${size}, restart ceiling=${2 * 1024 * 1024}`);
  await router.stop(); let restarted, restartError = null;
  try { restarted = createWorkCapture(setup); t.after(() => restarted.stop()); } catch (e) { restartError = e.message; }
  t.diagnostic(`restart error=${restartError}`);
  assert.ok(size <= 2 * 1024 * 1024, 'writer must honor its own persisted-state reader ceiling before committing bytes');
  assert.equal(restartError, null);
  assert.equal(restarted.snapshot().length, router.snapshot().length);
});

test('independent actual HTTP: client preserves human field ownership and accepts a durable tombstone', async (t) => {
  const r = await actual(t), at = r.at(); r.setShare(true);
  await r.router.observe([event(at, { taskSummary: 'Initial synthetic brief' })]);
  const cardId = r.router.snapshot()[0].card_id;
  const first = await r.f.as(r.f.users.ua, 'GET', `/api/cards/${cardId}`);
  const edit = await r.f.as(r.f.users.ua, 'PATCH', `/api/cards/${cardId}`, { request_id: crypto.randomUUID(), version: first.body.card.version,
    title: 'Human title', body: 'Human brief', column: 'todo' }); assert.equal(edit.status, 200, edit.text);
  r.advance(1); await r.router.observe([event(r.at(), { signal: 'stop', taskTitle: 'Reported replacement', taskSummary: 'Reported replacement brief' })]);
  const row = r.f.h.hub.card(cardId); assert.equal(row.title, 'Human title'); assert.equal(row.body, 'Human brief'); assert.equal(row.column_name, 'todo');
  assert.equal((await r.f.as(r.f.users.amember, 'POST', `/api/cards/${cardId}/work-capture/stop`, {})).status, 200);
  r.advance(1); await r.router.observe([event(r.at(), { taskTitle: 'New reported work' })]);
  assert.equal(r.router.snapshot()[0].untracked, true); assert.equal(r.router.snapshot()[0].reason, 'stopped');
  assert.equal(r.f.db.get('SELECT COUNT(*) n FROM work_capture_cards').n, 1);
  assert.equal(r.f.h.hub.card(cardId).run_state, null);
});
