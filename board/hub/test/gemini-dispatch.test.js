import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startHub } from './helpers.js';
import { migrate, loadMigrations } from '../../shared/migrate.js';

const gemini = () => ({ id: 'gemini', label: 'Gemini', installed: true, version: '0.12.0', signedIn: true, startable: true,
  capabilities: { budget: 'none', budgetUnit: null, resume: true, interrupt: false, structuredEvents: true, permissions: 'none', systemPrompt: true, model: true, maxTurns: false } });

test('gemini: own-machine dispatch is offered with no cap and persists gemini_cli; teammate machine, dollar cap and backend mismatch are refused', async (t) => {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice');
  await h.login('bob');
  const runner = await h.runner(await h.enroll(alice));
  runner.send({ type: 'advertise', repos: [{ repo_id: h.ids.repo }], ai: [gemini()] });
  for (let n = 0; n < 100 && !h.hub.runners.get(runner.dev.device_id)?.ai?.length; n++) await new Promise((r) => setTimeout(r, 10));
  const card = await h.createCard(alice);
  for (const [body, reason] of [
    [{ ai: 'gemini', budget_usd: null, target_member_id: h.ids.bob }, 'OWN_MACHINE_ONLY'],
    [{ ai: 'gemini', budget_usd: 5 }, 'BUDGET_UNSUPPORTED'],
    [{ ai: 'gemini', backend: 'codex_cli', budget_usd: null }, null],
  ]) {
    const r = await h.action(alice, card.id, 'dispatch', body);
    assert.notEqual(r.status, 200, JSON.stringify(body));
    if (reason) assert.equal(r.body.error.reason, reason);
    assert.equal(h.hub.pendingDispatch(card.id), null);
  }
  assert.equal((await h.action(alice, card.id, 'dispatch', { ai: 'gemini', budget_usd: null })).status, 200);
  const offer = await runner.next('offer', (m) => m.card_id === card.id);
  assert.deepEqual([offer.ai, offer.budget_usd, offer.budget_mode], ['gemini', null, 'none']);
  const claim = await runner.claim(offer); assert.equal(claim.ok, true);
  const run = h.hub.run(claim.run_id);
  assert.deepEqual([run.backend, run.ai, run.budget_cents], ['gemini_cli', 'gemini', null]);
  assert.equal((await h.api(alice, 'GET', `/api/cards/${card.id}`)).body.card.run.ai_label, 'Gemini');
});

test('migration 053 widens provider checks on a populated 052 database and applies cleanly on a fresh one', () => {
  const fresh = new DatabaseSync(':memory:');
  try {
    migrate(fresh);
    assert.ok(fresh.prepare('SELECT 1 FROM schema_migrations WHERE version = 53').get());
    assert.equal(fresh.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { fresh.close(); }
  const db = new DatabaseSync(':memory:');
  try {
    const all = loadMigrations();
    migrate(db, { migrations: all.filter((m) => m.version < 53) });
    const objects = () => db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => `${r.type}:${r.name}:${r.tbl_name}`);
    const before = objects();
    db.exec(`INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 'now');
      INSERT INTO members (id, org_id, github_id, github_login, display_name, role, created_at) VALUES ('m', 'o', 1, 'm', 'M', 'owner', 'now');
      INSERT INTO repos (id, org_id, canonical_url, short_name) VALUES ('r', 'o', 'github.com/a/b', 'b');
      INSERT INTO boards (id, org_id, name, key_prefix) VALUES ('b', 'o', 'B', 'K');
      INSERT INTO cards (id, board_id, key, title, repo_id, created_by, created_at, updated_at) VALUES ('c', 'b', 'K-1', 't', 'r', 'm', 'now', 'now');
      INSERT INTO dispatches (request_id, card_id, dispatched_by, backend, ai, created_at) VALUES ('d1', 'c', 'm', 'hermes_cli', 'hermes', 'now');
      INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at, ai) VALUES ('run1', 'c', 1, 'm', 'm', 'd1', 'hermes_cli', 'r', 'main', 'now', 'hermes');`);
    assert.throws(() => db.exec("INSERT INTO dispatches (request_id, card_id, dispatched_by, backend, ai, created_at) VALUES ('x', 'c', 'm', 'gemini_cli', 'gemini', 'now')"), /CHECK/);
    assert.deepEqual(migrate(db, { migrations: all }), [53]);
    assert.deepEqual(objects(), before, 'every table, index and trigger survives the rebuild');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(db.prepare('SELECT id, ai, backend FROM runs').all().map((r) => ({ ...r })), [{ id: 'run1', ai: 'hermes', backend: 'hermes_cli' }]);
    db.exec(`INSERT INTO dispatches (request_id, card_id, dispatched_by, backend, ai, state, created_at) VALUES ('d2', 'c', 'm', 'gemini_cli', 'gemini', 'claimed', 'now');
      UPDATE runs SET ended_at = 'now' WHERE id = 'run1';
      INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at, ai) VALUES ('run2', 'c', 2, 'm', 'm', 'd2', 'gemini_cli', 'r', 'main', 'now', 'gemini');`);
    assert.throws(() => db.exec("INSERT INTO dispatches (request_id, card_id, dispatched_by, backend, ai, created_at) VALUES ('y', 'c', 'm', 'gemini_cli', 'nope', 'now')"), /CHECK/);
    assert.throws(() => db.exec("INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at) VALUES ('run4', 'c', 4, 'x', 'm', 'd2', 'gemini_cli', 'r', 'main', 'now')"), /FOREIGN KEY|cross-team|UNIQUE/, 'constraints still enforced after the rebuild');
  } finally { db.close(); }
});
