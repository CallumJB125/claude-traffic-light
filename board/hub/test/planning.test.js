import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { startHub } from './helpers.js';
const body = (fx, fields = {}) => ({ request_id: randomUUID(), version: fx.db.get('SELECT version FROM cards WHERE id = ?', fx.A.card).version, ...fields });
const patch = (fx, data, user = fx.users.amember) => fx.as(user, 'PATCH', `/api/cards/${fx.A.card}/planning`, data);
const contents = fx => JSON.stringify(['cards', 'card_dependencies', 'planning_requests', 'journal'].map(table => fx.db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
async function queued(fx, data, invalidate, call = () => patch(fx, data)) {
  const original = fx.h.hub.withBoard.bind(fx.h.hub); let release, entered;
  const gate = new Promise(r => { release = r; }), reached = new Promise(r => { entered = r; });
  const held = original(fx.A.board, () => gate);
  fx.h.hub.withBoard = (id, fn) => { if (id === fx.A.board) entered(); return original(id, fn); };
  let timer;
  try {
    const pending = call();
    await Promise.race([reached, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP request did not reach held board queue')), 3000); })]);
    invalidate(fx); const before = contents(fx); release(); await held;
    const result = await pending; assert.equal(contents(fx), before, 'denied queued edit is atomic'); return result;
  } finally { clearTimeout(timer); release(); await held; fx.h.hub.withBoard = original; }
}
test('planning HTTP persists days, broadcasts WS and makes choice-bound retries without dispatching', async () => {
  const h = await startHub();
  try {
    const cookie = await h.login('alice'), card = await h.createCard(cookie), browser = await h.browser(cookie);
    const payload = { request_id: randomUUID(), version: card.version, start_date: '2028-02-28', due_date: '2028-02-29', depends_on: [] };
    const first = await h.api(cookie, 'PATCH', `/api/cards/${card.id}/planning`, payload); assert.equal(first.status, 200, first.text);
    const pushed = await browser.next('card.upsert', m => m.card?.id === card.id); assert.equal(pushed.card.due_date, '2028-02-29');
    const replay = await h.api(cookie, 'PATCH', `/api/cards/${card.id}/planning`, { due_date: '2028-02-29', start_date: '2028-02-28', version: card.version, depends_on: [], request_id: payload.request_id });
    assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.replayed, true); assert.equal(h.card(card.id).version, card.version + 1);
    assert.equal((await h.api(cookie, 'PATCH', `/api/cards/${card.id}/planning`, { ...payload, due_date: '2028-03-01' })).status, 409);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM dispatches').n, 0); assert.equal(h.db.get('SELECT COUNT(*) n FROM runs').n, 0);
    assert.equal(h.db.get("SELECT COUNT(*) n FROM journal WHERE card_id = ? AND kind = 'card.update'", card.id).n, 1);
    assert.equal((await h.api(cookie, 'PATCH', `/api/cards/${card.id}/planning`, { ...payload, request_id: randomUUID() })).status, 409);
  } finally { await h.destroy(); }
});
test('invalid dates/ranges and database invalid date checks leave no scheduling state', async () => {
  const fx = await tenancy();
  try {
    for (const fields of [{ due_date: '2026-02-30' }, { due_date: '2026-99-99' }, { due_date: '1900-02-29' }, { start_date: '2026-10-02', due_date: '2026-10-01' }, { start_date: '2000-01-01', due_date: '2026-10-01' }, { start_date: 123 }, { estimate: 3 }]) {
      const before = contents(fx), result = await patch(fx, body(fx, fields)); assert.equal(result.status, 400, result.text); assert.equal(contents(fx), before);
    }
    assert.throws(() => fx.db.run('UPDATE cards SET due_date = ? WHERE id = ?', '2026-99-99', fx.A.card), /CHECK/);
  } finally { await fx.h.close(); }
});
test('dependencies deny self, cycle, cross-team, archived and excess predecessors; removal is explicit', async () => {
  const fx = await tenancy();
  try {
    const second = await fx.as(fx.users.ua, 'POST', `/api/boards/${fx.A.board}/cards`, { title: 'Second', repo_id: fx.A.repo });
    const secondId = second.body.card.id;
    for (const [fields, status] of [[{ depends_on: [fx.A.card] }, 400], [{ depends_on: [fx.B.card] }, 404], [{ depends_on: Array(21).fill(secondId) }, 400]]) {
      const before = contents(fx), result = await patch(fx, body(fx, fields)); assert.equal(result.status, status, result.text); assert.equal(contents(fx), before);
    }
    assert.equal((await patch(fx, body(fx, { depends_on: [secondId, secondId] }))).status, 200);
    const cycle = await fx.as(fx.users.amember, 'PATCH', `/api/cards/${secondId}/planning`, { request_id: randomUUID(), version: second.body.card.version, depends_on: [fx.A.card] }); assert.equal(cycle.status, 400, cycle.text);
    fx.db.run('UPDATE cards SET archived_at = ? WHERE id = ?', fx.h.hub.iso(), secondId);
    assert.equal((await patch(fx, body(fx, { due_date: '2026-10-01' }))).status, 404);
    assert.equal((await patch(fx, body(fx, { depends_on: [] }))).status, 200);
  } finally { await fx.h.close(); }
});
const losses = {
  device: [401, fx => fx.db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', fx.h.hub.iso(), fx.users.amember.device_id)],
  epoch: [401, fx => fx.db.setMeta('session_epoch', Number(fx.db.meta('session_epoch')) + 1)],
  role: [403, fx => fx.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", fx.A.member)],
  membership: [403, fx => fx.db.run('UPDATE members SET removed_at = ? WHERE id = ?', fx.h.hub.iso(), fx.A.member)],
  user: [401, fx => fx.db.run('UPDATE users SET deleted_at = ? WHERE id = ?', fx.h.hub.iso(), fx.users.amember.id)],
  team: [403, fx => fx.db.run('UPDATE orgs SET deleted_at = ? WHERE id = ?', fx.h.hub.iso(), fx.A.team)],
  board: [409, fx => fx.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', fx.h.hub.iso(), fx.A.board)],
  repo: [409, fx => fx.db.run('DELETE FROM board_repos WHERE board_id = ? AND repo_id = ?', fx.A.board, fx.A.repo)],
};
for (const [name, [status, invalidate]] of Object.entries(losses)) {
  test(`planning held HTTP queue rechecks ${name} authority atomically`, async () => {
    const fx = await tenancy(); try { const result = await queued(fx, body(fx, { due_date: '2026-10-01' }), invalidate); assert.equal(result.status, status, result.text); } finally { await fx.h.close(); }
  });
  test(`planning durable retry rechecks current ${name} authority`, async () => {
    const fx = await tenancy(); try { const data = body(fx, { due_date: '2026-10-01' }); assert.equal((await patch(fx, data)).status, 200); invalidate(fx); const before = contents(fx), result = await patch(fx, data); assert.equal(result.status, ['membership', 'team'].includes(name) ? 404 : status, result.text); assert.equal(contents(fx), before); } finally { await fx.h.close(); }
  });
}
test('planning queue rechecks current dependency archive and repository linkage', async () => {
  for (const loss of ['archive', 'repo']) {
    const fx = await tenancy();
    try {
      const repo = randomUUID(); fx.db.insert('repos', { id: repo, org_id: fx.A.team, canonical_url: `github.com/acme/${repo}`, short_name: 'other' }); fx.db.run('INSERT INTO board_repos VALUES (?, ?)', fx.A.board, repo);
      const second = await fx.as(fx.users.ua, 'POST', `/api/boards/${fx.A.board}/cards`, { title: 'Dependency', repo_id: repo });
      const result = await queued(fx, body(fx, { depends_on: [second.body.card.id] }), () => loss === 'archive' ? fx.db.run('UPDATE cards SET archived_at = ? WHERE id = ?', fx.h.hub.iso(), second.body.card.id) : fx.db.run('DELETE FROM board_repos WHERE board_id = ? AND repo_id = ?', fx.A.board, repo));
      assert.equal(result.status, 404, result.text);
    } finally { await fx.h.close(); }
  }
});
test('planning queued and replayed cookie session revocation cannot finish a write', async () => {
  for (const retry of [false, true]) {
    const fx = await tenancy();
    try {
      const web = await fx.h.webSignIn(fx.users.amember.email), data = body(fx, { due_date: '2026-10-01' });
      const call = () => fx.h.call('PATCH', `/api/cards/${fx.A.card}/planning`, { body: data, cookie: web.cookie, headers: { origin: fx.h.base, 'x-csrf-token': web.csrf } });
      const revoke = () => fx.db.run('DELETE FROM sessions WHERE user_id = ?', fx.users.amember.id);
      if (retry) { assert.equal((await call()).status, 200); revoke(); const before = contents(fx); assert.equal((await call()).status, 401); assert.equal(contents(fx), before); }
      else assert.equal((await queued(fx, data, revoke, call)).status, 401);
    } finally { await fx.h.close(); }
  }
});
test('planning survives a real database reopen and exact retry does not append another journal row', async () => {
  let h = await startHub(); const directory = h.dataDir;
  try {
    const cookie = await h.login('alice'), card = await h.createCard(cookie), data = { request_id: randomUUID(), version: card.version, due_date: '2026-10-01' };
    assert.equal((await h.api(cookie, 'PATCH', `/api/cards/${card.id}/planning`, data)).status, 200); await h.close();
    h = await startHub({ dataDir: directory }); const newCookie = await h.login('alice');
    const result = await h.api(newCookie, 'PATCH', `/api/cards/${card.id}/planning`, data); assert.equal(result.status, 200, result.text); assert.equal(result.body.replayed, true); assert.equal(result.body.card.due_date, '2026-10-01');
    assert.equal(h.db.get("SELECT COUNT(*) n FROM journal WHERE card_id = ? AND kind = 'card.update'", card.id).n, 1);
  } finally { await h.destroy(); }
});
test('two concurrent planning versions permit one atomic winner', async () => {
  const fx = await tenancy();
  try {
    const a = body(fx, { due_date: '2026-10-01' }), b = body(fx, { due_date: '2026-10-02' });
    const results = await Promise.all([patch(fx, a), patch(fx, b)]); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(fx.db.get('SELECT COUNT(*) n FROM planning_requests').n, 1); assert.equal(fx.db.get("SELECT COUNT(*) n FROM journal WHERE card_id = ? AND kind = 'card.update'", fx.A.card).n, 1);
  } finally { await fx.h.close(); }
});
test('planning bounds board traversal and durable retry history without duplicating work', async () => {
  const fx = await tenancy();
  try {
    const template = fx.h.hub.card(fx.A.card);
    fx.h.hub.txn(() => { for (let i = 0; i < 2000; i++) fx.db.insert('planning_requests', { member_id: fx.A.member, request_id: randomUUID(), card_id: fx.A.card, binding: 'old', created_at: fx.h.hub.iso() }); });
    const data = body(fx, { due_date: '2026-10-01' }); assert.equal((await patch(fx, data)).status, 200); assert.equal(fx.db.get('SELECT COUNT(*) n FROM planning_requests WHERE member_id = ?', fx.A.member).n, 2000);
    fx.h.hub.txn(() => { for (let i = 0; i < 2000; i++) fx.db.insert('cards', { ...template, id: `bounded-${i}`, key: `BOUND-${i}` }); });
    const before = contents(fx), denied = await patch(fx, body(fx, { due_date: '2026-10-02' })); assert.equal(denied.status, 400, denied.text); assert.match(denied.text, /large/); assert.equal(contents(fx), before);
  } finally { await fx.h.close(); }
});
test('planning retry rechecks current predecessor scope while a fresh removal can repair stale links', async () => {
  const fx = await tenancy();
  try {
    const first = body(fx, { due_date: '2026-10-01', depends_on: [] }); assert.equal((await patch(fx, first)).status, 200);
    const second = await fx.as(fx.users.ua, 'POST', `/api/boards/${fx.A.board}/cards`, { title: 'Dependency', repo_id: fx.A.repo });
    assert.equal((await patch(fx, body(fx, { depends_on: [second.body.card.id] }))).status, 200);
    fx.db.run('UPDATE cards SET archived_at = ? WHERE id = ?', fx.h.hub.iso(), second.body.card.id);
    const before = contents(fx), replay = await patch(fx, first); assert.equal(replay.status, 404, replay.text); assert.equal(contents(fx), before);
    assert.equal((await patch(fx, body(fx, { depends_on: [] }))).status, 200);
  } finally { await fx.h.close(); }
});
