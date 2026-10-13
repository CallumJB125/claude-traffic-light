import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub } from './helpers.js';
import { tenancy, MARK } from './tenancy/fixture.js';
import { searchWork } from '../search.js';

test('staff search covers literal card/comment/latest handover and current artifact metadata in the selected team', async () => {
  const f = await tenancy();
  try {
    const { h, db, B, users, as } = f;
    for (const [version, text] of [[1, 'superseded narrative'], [2, `${MARK} handoff next step`]]) db.insert('handovers', { card_id: B.card, version, sections: JSON.stringify({ next: text }), written_by: 'human', created_at: h.hub.iso() });
    const own = await as(users.ub, 'GET', `/api/search?q=${MARK.toLowerCase()}&team=${B.team}`);
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(own.body.results.map((x) => x.kind), ['card', 'comment', 'handover', 'artifact']);
    for (const hit of own.body.results) assert.deepEqual([hit.board.id, hit.card.id], [B.board, B.card]);
    assert.equal((await as(users.ub, 'GET', '/api/search?q=superseded')).body.results.length, 0);
    assert.equal((await as(users.ua, 'GET', `/api/search?q=${MARK}`)).body.results.length, 0);
    assert.equal((await as(users.s, 'GET', `/api/search?q=${MARK}&team=${f.A.team}`)).body.results.length, 0);
    assert.equal((await as(users.s, 'GET', `/api/search?q=${MARK}&team=${B.team}`)).body.results.length, 4);
    assert.equal((await as(users.bguest, 'GET', `/api/search?q=${MARK}&team=${B.team}`)).status, 404);
    assert.equal((await as(users.ua, 'GET', `/api/search?q=${MARK}&board_id=${B.board}`)).status, 404);
    const text = JSON.stringify(own.body);
    for (const secret of ['token_hash', 'primary_email', 'data_base64', 'sha256', 'runner_token', 'cost_usd', 'input_summary']) assert.ok(!text.includes(secret));
    assert.equal((await as(users.ub, 'GET', `/api/search?q=${MARK}&limit=1`)).body.truncated, true);
    db.run('UPDATE client_items SET unpublished_at = ? WHERE id = ?', h.hub.iso(), B.clientItem);
    assert.equal((await as(users.ub, 'GET', `/api/search?q=${MARK}`)).body.results.some((x) => x.kind === 'artifact'), false);
    db.run('UPDATE cards SET archived_at = ? WHERE id = ?', h.hub.iso(), B.card);
    assert.equal((await as(users.ub, 'GET', `/api/search?q=${MARK}`)).body.results.length, 0);
    db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), B.s);
    assert.throws(() => searchWork(h.hub, { id: B.s, org_id: B.team }, new URLSearchParams({ q: MARK })), /team not found/);
  } finally { await f.h.close(); }
});

test('search query boundaries are closed, escaped literally, finite, and refuse archived boards', async () => {
  const h = await startHub();
  try {
    const cookie = await h.login('alice');
    const card = await h.createCard(cookie, { title: 'Percent 100% and underscore a_b', body: `${'lead '.repeat(100)}<script>literal needle here</script>${' tail'.repeat(100)}` });
    for (const literal of ['100%', 'a_b', 'needle']) {
      const r = await h.api(cookie, 'GET', `/api/search?${new URLSearchParams({ q: literal })}`);
      assert.equal(r.status, 200, r.text); assert.equal(r.body.results[0].card.id, card.id);
      assert.ok(r.body.results[0].snippet.length <= 182);
    }
    assert.equal((await h.api(cookie, 'GET', '/api/search?q=%25%25')).body.results.length, 0);
    assert.equal((await h.api(cookie, 'GET', '/api/search?q=%27%20OR%201%3D1')).body.results.length, 0);
    for (const suffix of ['q=x', `q=${'x'.repeat(121)}`, 'q=one+two+three+four+five+six+seven', 'q=ok&limit=41', 'q=ok&limit=Infinity', 'q=ok&q=no', 'q=ok&include_archived=1', 'q=ok&member_id=alice', 'q=ok%00']) assert.equal((await h.api(cookie, 'GET', `/api/search?${suffix}`)).status, 400, suffix);
    const other = await h.api(cookie, 'POST', '/api/boards', { request_id: randomUUID(), name: 'Archived search' });
    await h.api(cookie, 'POST', `/api/boards/${other.body.board.id}/archive`, { request_id: randomUUID() });
    assert.equal((await h.api(cookie, 'GET', `/api/search?q=needle&board_id=${other.body.board.id}`)).status, 404);
    assert.equal((await h.api(null, 'GET', '/api/search?q=needle')).status, 401);
  } finally { await h.close(); }
});

test('search rate limit is per current member and also bounds invalid queries', async () => {
  const h = await startHub({ config: { rateLimits: { search_member: { capacity: 1, per_ms: 60_000 } } } });
  try {
    const alice = await h.login('alice'), bob = await h.login('bob');
    assert.equal((await h.api(alice, 'GET', '/api/search?q=x')).status, 400);
    assert.equal((await h.api(alice, 'GET', '/api/search?q=valid')).status, 429);
    assert.equal((await h.api(bob, 'GET', '/api/search?q=valid')).status, 200);
  } finally { await h.close(); }
});
