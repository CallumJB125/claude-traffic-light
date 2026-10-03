import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startHub } from './helpers.js';
import { migrate, loadMigrations } from '../../shared/migrate.js';

const hermes = (id = 'hermes') => ({ id, label: id === 'hermes' ? 'Hermes' : 'Hermes · DGX', installed: true, version: '0.21.3', signedIn: true, startable: true,
  capabilities: { budget: 'none', budgetUnit: null, resume: true, interrupt: false, structuredEvents: true, permissions: 'none', systemPrompt: true, model: true, maxTurns: true } });
async function fixture(t, ai) {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice'), bob = await h.login('bob');
  const runner = await h.runner(await h.enroll(alice));
  runner.send({ type: 'advertise', repos: [{ repo_id: h.ids.repo }], ai });
  for (let n = 0; n < 100 && !h.hub.runners.get(runner.dev.device_id)?.ai?.length; n++) await new Promise((r) => setTimeout(r, 10));
  return { h, alice, bob, runner };
}

for (const id of ['hermes', 'hermes-dgx']) {
  test(`${id}: own-machine dispatch is offered with max_turns and no cap, and the run persists hermes_cli`, async (t) => {
    const { h, alice, runner } = await fixture(t, [hermes(id)]);
    h.db.run("UPDATE boards SET settings = json_set(COALESCE(settings, '{}'), '$.default_max_turns', 30)");
    const card = await h.createCard(alice);
    assert.equal((await h.action(alice, card.id, 'dispatch', { ai: id, budget_usd: null })).status, 200);
    const offer = await runner.next('offer', (m) => m.card_id === card.id);
    assert.equal(offer.ai, id); assert.equal(offer.budget_usd, null); assert.equal(offer.budget_mode, 'none'); assert.equal(offer.max_turns, 30);
    const claim = await runner.claim(offer); assert.equal(claim.ok, true);
    const run = h.hub.run(claim.run_id);
    assert.deepEqual([run.backend, run.ai, run.budget_cents], ['hermes_cli', id, null]);
    const detail = await h.api(alice, 'GET', `/api/cards/${card.id}`);
    assert.equal(detail.body.card.run.ai_label, id === 'hermes' ? 'Hermes' : 'Hermes · DGX');
    assert.equal(detail.body.run.cost_source, 'unavailable', 'no dollar telemetry is claimed');
  });
}

test('Hermes is refused on a teammate’s machine (even for an admin), with a dollar cap, or with a mismatched backend', async (t) => {
  const { h, alice, bob } = await fixture(t, [hermes()]);
  const card = await h.createCard(alice);
  for (const [who, body, reason] of [
    [alice, { ai: 'hermes', budget_usd: null, target_member_id: h.ids.bob }, 'OWN_MACHINE_ONLY'],
    [bob, { ai: 'hermes-dgx', budget_usd: null, target_member_id: h.ids.alice }, 'OWN_MACHINE_ONLY'],
    [alice, { ai: 'hermes', budget_usd: 5 }, 'BUDGET_UNSUPPORTED'],
    [alice, { ai: 'hermes', backend: 'codex_cli', budget_usd: null }, null],
  ]) {
    const r = await h.action(who, card.id, 'dispatch', body);
    assert.notEqual(r.status, 200, JSON.stringify(body));
    if (reason) assert.equal(r.body.error.reason, reason);
    assert.equal(h.hub.pendingDispatch(card.id), null);
  }
});

test('migration 052 widens provider checks on a populated 051 database and applies cleanly on a fresh one', () => {
  const fresh = new DatabaseSync(':memory:');
  try {
    migrate(fresh);
    assert.ok(fresh.prepare('SELECT 1 FROM schema_migrations WHERE version = 52').get());
    assert.equal(fresh.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { fresh.close(); }
  const db = new DatabaseSync(':memory:');
  try {
    const all = loadMigrations();
    migrate(db, { migrations: all.filter((m) => m.version < 52) });
    const objects = () => db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => `${r.type}:${r.name}:${r.tbl_name}`);
    const before = objects();
    db.exec(`INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 'now');
      INSERT INTO members (id, org_id, github_id, github_login, display_name, role, created_at) VALUES ('m', 'o', 1, 'm', 'M', 'owner', 'now');
      INSERT INTO repos (id, org_id, canonical_url, short_name) VALUES ('r', 'o', 'github.com/a/b', 'b');
      INSERT INTO boards (id, org_id, name, key_prefix) VALUES ('b', 'o', 'B', 'K');
      INSERT INTO cards (id, board_id, key, title, repo_id, created_by, created_at, updated_at) VALUES ('c', 'b', 'K-1', 't', 'r', 'm', 'now', 'now');
      INSERT INTO dispatches (request_id, card_id, dispatched_by, backend, ai, created_at) VALUES ('d1', 'c', 'm', 'codex_cli', 'codex', 'now');
      INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at, ai) VALUES ('run1', 'c', 1, 'm', 'm', 'd1', 'codex_cli', 'r', 'main', 'now', 'codex');`);
    assert.throws(() => db.exec("INSERT INTO dispatches (request_id, card_id, dispatched_by, backend, ai, created_at) VALUES ('x', 'c', 'm', 'hermes_cli', 'hermes', 'now')"), /CHECK/);
    assert.deepEqual(migrate(db, { migrations: all }), [52]);
    assert.deepEqual(objects(), before, 'every table, index and trigger survives the rebuild');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(db.prepare('SELECT id, ai, backend FROM runs').all().map((r) => ({ ...r })), [{ id: 'run1', ai: 'codex', backend: 'codex_cli' }]);
    db.exec(`INSERT INTO dispatches (request_id, card_id, dispatched_by, backend, ai, state, created_at) VALUES ('d2', 'c', 'm', 'hermes_cli', 'hermes-dgx', 'claimed', 'now');
      UPDATE runs SET ended_at = 'now' WHERE id = 'run1';
      INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at, ai) VALUES ('run2', 'c', 2, 'm', 'm', 'd2', 'hermes_cli', 'r', 'main', 'now', 'hermes-dgx');`);
    assert.throws(() => db.exec("INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at, ai) VALUES ('run3', 'c', 3, 'm', 'm', 'd1', 'gemini_cli', 'r', 'main', 'now', 'gemini')"), /CHECK|UNIQUE/);
    assert.throws(() => db.exec("INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at) VALUES ('run4', 'c', 4, 'x', 'm', 'd2', 'hermes_cli', 'r', 'main', 'now')"), /FOREIGN KEY|cross-team|UNIQUE/, 'constraints still enforced after the rebuild');
  } finally { db.close(); }
});
