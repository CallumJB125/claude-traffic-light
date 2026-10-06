// G3: the Tackle-with-AI overlap check names who/what overlaps, says
// 'unknown' when nothing can be compared, and never reads another team's runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, runMsg } from './helpers.js';
import { hintPaths } from '../../shared/overlap.js';
import { tenancy, MARK } from './tenancy/fixture.js';

const preview = (h, cookie, cardId, q = '') => h.api(cookie, 'GET', `/api/cards/${cardId}/overlap-preview${q}`);

test('hintPaths reads repo-relative file paths from card text only', () => {
  assert.deepEqual(hintPaths('Fix `src/api/submit.ts` and see https://x.com/a/b.js, ../etc/passwd.txt, README.md'), ['src/api/submit.ts']);
});

test('no live work on the repo is a clear check', async (t) => {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice');
  const card = await h.createCard(alice);
  const r = await preview(h, alice, card.id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.overlaps, []);
  assert.equal(r.body.check.status, 'clear');
});

test('a card that names a file another live run edits overlaps, naming card, owner and file', async (t) => {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice'), bob = await h.login('bob');
  const rb = await h.runner(await h.enroll(bob));
  const run = await h.startRun(bob, rb, { title: 'Validation errors' });
  await rb.out({ kind: 'facts', ...runMsg(run), items: [{ kind: 'file', path: 'src/api/submit.ts', op: 'edit' }] });
  const card = await h.createCard(alice, { title: 'Submit payload', body: 'Rework src/api/submit.ts' });
  const r = await preview(h, alice, card.id);
  assert.equal(r.body.check.status, 'overlap');
  assert.equal(r.body.overlaps.length, 1);
  assert.equal(r.body.overlaps[0].other_key, run.key);
  assert.equal(r.body.overlaps[0].other_owner, 'Bob');
  assert.deepEqual(r.body.overlaps[0].paths, ['src/api/submit.ts']);
  const unrelated = await h.createCard(alice, { title: 'Docs', body: 'Touch docs/readme.md' });
  assert.equal((await preview(h, alice, unrelated.id)).body.check.status, 'clear');
});

test('live work with no path data, or a card with no file hints, is unknown rather than clear', async (t) => {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice'), bob = await h.login('bob');
  const rb = await h.runner(await h.enroll(bob));
  const run = await h.startRun(bob, rb, { title: 'Quiet run' });
  const hinted = await h.createCard(alice, { title: 'Named', body: 'Edit src/a.ts' });
  const r = await preview(h, alice, hinted.id);
  assert.equal(r.body.check.status, 'unknown');
  assert.deepEqual(r.body.check.unknown_runs, [{ card_key: run.key, owner: 'Bob' }]);
  await rb.out({ kind: 'facts', ...runMsg(run), items: [{ kind: 'file', path: 'src/zzz.ts', op: 'edit' }] });
  assert.equal((await preview(h, alice, hinted.id)).body.check.status, 'clear', 'both sides known and disjoint');
  const bare = await h.createCard(alice, { title: 'No hints' });
  const b = await preview(h, alice, bare.id);
  assert.equal(b.body.check.status, 'unknown');
  assert.equal(b.body.check.self_known, false);
});

test('another team never appears in the check, even through a foreign repo_id', async (t) => {
  const fx = await tenancy();
  t.after(() => fx.h.destroy?.() ?? fx.h.close?.());
  const { h, db, users, A, B, as } = fx;
  db.run('UPDATE cards SET active_run_id = ? WHERE id = ?', B.run, B.card);
  const own = await as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: 'a-own', title: 'Own', body: 'x/y.ts', repo_id: A.repo });
  assert.equal(own.status, 200, own.text);
  const id = own.body.card.id;
  const plain = await as(users.ua, 'GET', `/api/cards/${id}/overlap-preview`);
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.body.overlaps, []);
  assert.equal(plain.body.check.status, 'clear');
  assert.equal((await as(users.ua, 'GET', `/api/cards/${id}/overlap-preview?repo_id=${B.repo}`)).status, 404);
  assert.ok(!plain.text.includes(MARK));
  assert.equal((await as(users.ua, 'GET', `/api/cards/${B.card}/overlap-preview`)).status, 404);
});
