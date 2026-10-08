// Handoff of a WorkRecord against a fake activity log (the real one is
// board/hub/activity/log.js; only its narrow interface is used).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from './helpers.js';
import { pendingHandoffs, HANDOFF_REQUESTED, HANDOFF_TAKEN } from '../activity-handoff.js';

const RID = 'inst-a:claude:sess-1';
function fakeLog(current) {
  const events = [];
  return {
    events: ({ record_id } = {}) => events.filter((e) => !record_id || e.record_id === record_id),
    all: events,
    current: (id) => current.get(id) ?? null,
    append(e) { events.push({ ...e, seq: events.length + 1 }); return { seq: events.length }; },
    handover: (id) => (id === RID ? '## Next\nWrite the redirect test.' : null),
  };
}
const record = (h, over = {}) => ({ team_id: h.ids.org, repo_id: h.ids.repo, record_id: RID, rev: 3,
  payload: JSON.stringify({ v: 1, record_id: RID, adapter: 'claude', title: 'Fix login', status: 'paused_limit', files: { edited: ['src/auth.js'], read: [] } }), ...over });

async function rig(fn, rows = (h) => [record(h)]) {
  const h = await startHub();
  try {
    const log = fakeLog(new Map(rows(h).map((r) => [r.record_id, r])));
    h.hub.activityLog = log;
    await fn({ h, log, alice: await h.login('alice'), bob: await h.login('bob') });
  } finally { await h.destroy(); }
}
const handoffPath = (h, id = RID) => `/api/teams/${h.ids.org}/activity/v1/records/${encodeURIComponent(id)}/handoff`;
const continuePath = (h, id = RID) => `/api/teams/${h.ids.org}/activity/v1/records/${encodeURIComponent(id)}/continue`;

test('Hand to teammate marks handoff_requested on the log; the teammate sees it pending until they continue it', () => rig(async ({ h, log, alice, bob }) => {
  const r = await h.api(alice, 'POST', handoffPath(h), { to_member_id: h.ids.bob, note: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 is in .env' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.handoff.to_member_id, h.ids.bob);
  assert.doesNotMatch(r.body.handoff.note, /ghp_/, 'notes are scrubbed');
  const [ev] = log.all;
  assert.equal(ev.type, HANDOFF_REQUESTED); assert.equal(ev.rev, 3); assert.equal(ev.team_id, h.ids.org);
  assert.deepEqual(pendingHandoffs(log.all, h.ids.bob).map((p) => p.record_id), [RID]);
  assert.deepEqual(pendingHandoffs(log.all, h.ids.alice), []);

  const c = await h.api(bob, 'POST', continuePath(h), {});
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.record.record_id, RID);
  assert.match(c.body.handover, /redirect test/);
  assert.equal(log.all.at(-1).type, HANDOFF_TAKEN);
  assert.deepEqual(pendingHandoffs(log.all, h.ids.bob), [], 'continuing closes it');
}));

test('handoff refuses self, unknown members, bad ids and other teams\' records', () => rig(async ({ h, alice }) => {
  assert.equal((await h.api(alice, 'POST', handoffPath(h), { to_member_id: h.ids.alice })).status, 400);
  assert.equal((await h.api(alice, 'POST', handoffPath(h), { to_member_id: 'nobody' })).status, 400);
  assert.equal((await h.api(alice, 'POST', handoffPath(h, 'not-a-record'), { to_member_id: h.ids.bob })).status, 400);
  assert.equal((await h.api(alice, 'POST', handoffPath(h, 'inst-z:claude:other'), { to_member_id: h.ids.bob })).status, 404, 'other team reads as missing');
  assert.equal((await h.api(alice, 'POST', handoffPath(h), { to_member_id: h.ids.bob, note: 'x'.repeat(501) })).status, 400);
}, (h) => [record(h), record(h, { record_id: 'inst-z:claude:other', team_id: 'another-team' })]));

test('continue_with_another_ai on a card returns the card\'s record and shared handover', () => rig(async ({ h, alice }) => {
  const card = await h.createCard(alice);
  const r = await h.api(alice, 'GET', `/api/cards/${card.id}/continue-seed?record_id=${encodeURIComponent(RID)}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.record.title, 'Fix login');
  assert.match(r.body.handover, /redirect test/);
  const plain = await h.api(alice, 'GET', `/api/cards/${card.id}/continue-seed`);
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.body.record, null);
}));

test('a card cannot borrow a record from another repo', () => rig(async ({ h, alice }) => {
  const card = await h.createCard(alice);
  const r = await h.api(alice, 'GET', `/api/cards/${card.id}/continue-seed?record_id=${encodeURIComponent(RID)}`);
  assert.equal(r.status, 400);
}, (h) => [record(h, { repo_id: 'some-other-repo' })]));

test('without an activity log the routes answer not found', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    assert.equal((await h.api(alice, 'POST', handoffPath(h), { to_member_id: h.ids.bob })).status, 404);
  } finally { await h.destroy(); }
});

test('pendingHandoffs: a later handoff to someone else replaces the earlier one', () => {
  const ev = (seq, type, to) => ({ seq, type, payload: { record_id: RID, to_member_id: to } });
  assert.deepEqual(pendingHandoffs([ev(1, HANDOFF_REQUESTED, 'b'), ev(2, HANDOFF_REQUESTED, 'c')], 'b'), []);
  assert.equal(pendingHandoffs([ev(1, HANDOFF_REQUESTED, 'c'), ev(2, HANDOFF_REQUESTED, 'b')], 'b')[0].seq, 2);
  assert.deepEqual(pendingHandoffs(null, 'b'), []);
});
