import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Api } from '../api.js';
import { tenancy } from './tenancy/fixture.js';

const operations = {
  create: ({ A }) => ['POST', `/api/boards/${A.board}/cards`, { request_id: randomUUID(), title: 'Queued card', repo_id: A.repo }],
  patch: ({ A, h }) => ['PATCH', `/api/cards/${A.card}`, { request_id: randomUUID(), version: h.hub.card(A.card).version, title: 'Queued edit' }],
  comment: ({ A }) => ['POST', `/api/cards/${A.card}/comments`, { request_id: randomUUID(), body: 'Queued comment' }],
};
const content = ({ db }) => JSON.stringify(['cards', 'comments', 'journal'].map((table) => db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
const losses = {
  device: [401, ({ db, users, h }) => db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), users.amember.device_id)],
  session: [401, ({ db, users }) => db.run('DELETE FROM sessions WHERE user_id = ?', users.amember.id)],
  epoch: [401, ({ db }) => db.setMeta('session_epoch', Number(db.meta('session_epoch')) + 1)],
  role: [403, ({ db, A }) => db.run("UPDATE members SET role = 'viewer' WHERE id = ?", A.member)],
  membership: [403, ({ db, A, h }) => db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), A.member)],
  user: [401, ({ db, users, h }) => db.run('UPDATE users SET deleted_at = ? WHERE id = ?', h.hub.iso(), users.amember.id)],
  team: [403, ({ db, A, h }) => db.run('UPDATE orgs SET deleted_at = ? WHERE id = ?', h.hub.iso(), A.team)],
  board: [409, ({ db, A, h }) => db.run('UPDATE boards SET archived_at = ? WHERE id = ?', h.hub.iso(), A.board)],
};

// Hold the actual hub queue until authentication and initial scope validation
// have finished. Invalidation then races a real HTTP write, not a mock check.
async function queued(fx, call, invalidate) {
  const original = fx.h.hub.withBoard.bind(fx.h.hub);
  let release;
  let entered;
  let queued;
  const ready = new Promise((resolve) => { entered = resolve; });
  const observed = new Promise((resolve) => { queued = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const held = original(fx.A.board, () => { entered(); return gate; });
  await ready;
  fx.h.hub.withBoard = (id, fn) => { if (id === fx.A.board) queued(); return original(id, fn); };
  let deadline;
  try {
    const pending = call();
    await Promise.race([observed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('request did not reach board queue')), 5000); })]);
    invalidate(fx);
    const before = content(fx);
    release();
    await held;
    const result = await pending;
    assert.equal(content(fx), before, 'denied queued write has no card/comment/journal side effects');
    return result;
  } finally {
    clearTimeout(deadline);
    release();
    await held;
    fx.h.hub.withBoard = original;
  }
}

for (const [name, operation] of Object.entries(operations)) {
  for (const [loss, [status, invalidate]] of Object.entries(losses)) {
    test(`${name}: queued ${loss} invalidation prevents a write`, async () => {
      const fx = await tenancy();
      try {
        const [method, path, body] = operation(fx);
        let call = () => fx.as(fx.users.amember, method, path, body);
        if (loss === 'session') {
          const web = await fx.h.webSignIn(fx.users.amember.email);
          assert.equal(web.res.status, 200);
          call = () => fx.h.call(method, path, { body, cookie: web.cookie, headers: { origin: fx.h.base, 'x-csrf-token': web.csrf } });
        }
        const result = await queued(fx, call, invalidate);
        assert.equal(result.status, status, result.text);
      } finally { await fx.h.close(); }
    });
  }

  test(`${name}: exact retries are bound to payload and current authority`, async () => {
    const fx = await tenancy();
    try {
      const [method, path, body] = operation(fx);
      const first = await fx.as(fx.users.amember, method, path, body);
      assert.equal(first.status, 200, first.text);
      const before = content(fx);
      const reordered = Object.fromEntries(Object.entries(body).reverse());
      const retry = await fx.as(fx.users.amember, method, path, reordered);
      assert.equal(retry.status, 200, retry.text);
      assert.equal(retry.headers.get('board-replayed'), '1');
      assert.deepEqual(retry.body, first.body);
      const different = await fx.as(fx.users.amember, method, path, { ...body, [name === 'comment' ? 'body' : 'title']: 'Different request' });
      assert.equal(different.status, 409, different.text);
      assert.equal(different.body.error.code, 'CONFLICT');
      fx.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", fx.A.member);
      const denied = await fx.as(fx.users.amember, method, path, body);
      assert.equal(denied.status, 403, denied.text);
      assert.equal(denied.headers.get('board-replayed'), null);
      assert.equal(content(fx), before);
    } finally { await fx.h.close(); }
  });

  test(`${name}: direct server credential is bound to its account`, async () => {
    const fx = await tenancy();
    try {
      const api = new Api(fx.h.hub);
      const member = fx.h.hub.member(fx.A.member);
      const body = operation(fx)[2];
      const before = content(fx);
      const cred = { kind: 'device', id: fx.users.ub.device_id };
      const promise = name === 'create' ? api.createCard(member, fx.A.board, body, { cred })
        : name === 'patch' ? api.patchCard(member, fx.A.card, body, { cred })
          : api.comment(member, fx.A.card, body, { cred });
      await assert.rejects(promise, { code: 'UNAUTHENTICATED' });
      assert.equal(content(fx), before);
    } finally { await fx.h.close(); }
  });

  test(`${name}: concurrent exact retries produce one effect`, async () => {
    const fx = await tenancy();
    try {
      const [method, path, body] = operation(fx);
      let release;
      let entered;
      const ready = new Promise((resolve) => { entered = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const held = fx.h.hub.withBoard(fx.A.board, () => { entered(); return gate; });
      await ready;
      const originalScope = fx.h.app.api.collaborationScope.bind(fx.h.app.api);
      let scopes = 0;
      let bothEntered;
      let deadline;
      const observed = new Promise((resolve) => { bothEntered = resolve; });
      fx.h.app.api.collaborationScope = (...args) => {
        const result = originalScope(...args);
        if (++scopes === 3) bothEntered(); // First body + execution, then second body.
        return result;
      };
      const before = ['cards', 'comments', 'journal'].map((table) => fx.db.get(`SELECT count(*) AS n FROM ${table}`).n);
      const pending = [fx.as(fx.users.amember, method, path, body), fx.as(fx.users.amember, method, path, body)];
      try {
        await Promise.race([observed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('concurrent requests did not both enter')), 5000); })]);
      } finally {
        clearTimeout(deadline);
        release();
        fx.h.app.api.collaborationScope = originalScope;
      }
      await held;
      const results = await Promise.all(pending);
      for (const result of results) assert.equal(result.status, 200, result.text);
      assert.deepEqual(results[0].body, results[1].body);
      assert.equal(results.filter((r) => r.headers.get('board-replayed') === '1').length, 1);
      const after = ['cards', 'comments', 'journal'].map((table) => fx.db.get(`SELECT count(*) AS n FROM ${table}`).n);
      assert.deepEqual(after.map((n, i) => n - before[i]), name === 'create' ? [1, 0, 1] : name === 'comment' ? [0, 1, 1] : [0, 0, 1]);
    } finally { await fx.h.close(); }
  });
}

for (const name of ['patch', 'comment']) {
  test(`${name}: card archived while queued prevents a write`, async () => {
    const fx = await tenancy();
    try {
      const [method, path, body] = operations[name](fx);
      const result = await queued(fx, () => fx.as(fx.users.amember, method, path, body), ({ db, A, h }) => db.run('UPDATE cards SET archived_at = ? WHERE id = ?', h.hub.iso(), A.card));
      assert.equal(result.status, 409, result.text);
    } finally { await fx.h.close(); }
  });
}

test('cached collaboration response cannot satisfy another card/route or a newly archived target', async () => {
  const fx = await tenancy();
  try {
    const body = { request_id: randomUUID(), title: 'First card' };
    const path = `/api/boards/${fx.A.board}/cards`;
    const first = await fx.as(fx.users.amember, 'POST', path, body);
    assert.equal(first.status, 200, first.text);
    const before = content(fx);
    const collision = await fx.as(fx.users.amember, 'POST', `/api/cards/${fx.A.card}/comments`, { request_id: body.request_id, body: 'Not the same operation' });
    assert.equal(collision.status, 409, collision.text);
    const otherRoute = await fx.as(fx.users.amember, 'POST', `/api/cards/${fx.A.card}/archive`, { request_id: body.request_id, version: fx.h.hub.card(fx.A.card).version });
    assert.equal(otherRoute.status, 409, otherRoute.text);
    assert.equal(content(fx), before);
    fx.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', fx.h.hub.iso(), fx.A.board);
    const denied = await fx.as(fx.users.amember, 'POST', path, body);
    assert.equal(denied.status, 409, denied.text);
    assert.equal(denied.headers.get('board-replayed'), null);
    assert.equal(content(fx), before);
  } finally { await fx.h.close(); }
});

for (const kind of ['repo', 'assignee']) {
  test(`create: queued ${kind} removal is rechecked`, async () => {
    const fx = await tenancy();
    try {
      const [method, path, body] = operations.create(fx);
      body.assignees = [fx.A.admin];
      const result = await queued(fx, () => fx.as(fx.users.amember, method, path, body), ({ db, A, h }) => {
        if (kind === 'repo') db.run('DELETE FROM board_repos WHERE board_id = ? AND repo_id = ?', A.board, A.repo);
        else db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), A.admin);
      });
      assert.equal(result.status, kind === 'repo' ? 404 : 400, result.text);
    } finally { await fx.h.close(); }
  });
}
