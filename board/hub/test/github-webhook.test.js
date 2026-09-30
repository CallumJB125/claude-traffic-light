// GitHub webhook signature, replay key and fact mapping (the pure half of
// the GitHub connector), with fixtures shaped like GitHub's payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, sign, dedupeKey, factsOf } from '../integrations/github/webhook.js';

const SECRET = ['whsec', 'test-0123456789abcdef'].join('-');
const repo = { id: 501, full_name: 'acme/app', default_branch: 'main' };
const fork = { id: 777, full_name: 'mallory/app', default_branch: 'main' };
const pr = (over = {}) => ({
  id: 991, number: 42, html_url: 'https://github.com/acme/app/pull/42', draft: false, merged: false, updated_at: '2026-10-01T10:00:00Z',
  head: { ref: 'board/BDL-12-r3', sha: 'a'.repeat(40), repo }, base: { ref: 'main', repo }, requested_reviewers: [], merged_by: null, ...over,
});
const suitePr = (over = {}) => ({ id: 991, number: 42, head: { ref: 'board/BDL-12-r3', sha: 'a'.repeat(40), repo: { id: 501 } }, base: { ref: 'main', sha: 'f'.repeat(40), repo: { id: 501 } }, ...over });
const suite = (over = {}, action = 'completed', repository = repo) => ({ action, repository, check_suite: { id: 7, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', pull_requests: [suitePr()], updated_at: 't', ...over } });
const review = (over = {}, action = 'submitted') => ({ action, review: { id: 1, state: 'approved', user: { login: 'tonde' }, author_association: 'MEMBER', submitted_at: '2026-10-01T11:00:00Z', ...over }, pull_request: pr(), repository: repo });
const deliver = (event, payload, secret = SECRET) => {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return verify({ headers: { 'x-hub-signature-256': sign(secret, rawBody), 'x-github-event': event, 'x-github-delivery': 'd-1' }, rawBody, secrets: { webhook_secret: SECRET } });
};

test('a correctly signed delivery verifies and yields a replay key', () => {
  const r = deliver('pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  assert.equal(r.ok, true);
  assert.match(r.dedupe_key, /^pull_request:[0-9a-f]{32}$/);
});

test('forged, missing or wrong-secret signatures are refused', () => {
  const body = Buffer.from(JSON.stringify({ action: 'opened', pull_request: pr(), repository: repo }));
  assert.equal(verify({ headers: { 'x-github-event': 'pull_request' }, rawBody: body, secrets: { webhook_secret: SECRET } }).ok, false);
  assert.equal(verify({ headers: { 'x-hub-signature-256': sign('another-secret-0123456789', body), 'x-github-event': 'pull_request' }, rawBody: body, secrets: { webhook_secret: SECRET } }).ok, false);
  assert.equal(verify({ headers: { 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'pull_request' }, rawBody: body, secrets: { webhook_secret: SECRET } }).ok, false);
  // One changed byte after signing.
  const sig = sign(SECRET, body);
  const tampered = Buffer.from(body); tampered[5] ^= 1;
  assert.equal(verify({ headers: { 'x-hub-signature-256': sig, 'x-github-event': 'pull_request' }, rawBody: tampered, secrets: { webhook_secret: SECRET } }).ok, false);
  assert.equal(verify({ headers: { 'x-hub-signature-256': sig, 'x-github-event': 'pull_request' }, rawBody: body, secrets: {} }).reason, 'no webhook secret');
});

test('the replay key covers signed content, not the unsigned delivery header', () => {
  const p = { action: 'synchronize', pull_request: pr(), repository: repo };
  assert.equal(dedupeKey('pull_request', p), dedupeKey('pull_request', JSON.parse(JSON.stringify(p))));
  assert.notEqual(dedupeKey('pull_request', p), dedupeKey('pull_request', { ...p, pull_request: pr({ head: { ...pr().head, sha: 'b'.repeat(40) } }) }));
  assert.notEqual(dedupeKey('pull_request', p), dedupeKey('pull_request', { ...p, action: 'closed' }));
});

test('L1: a signed event the connector does not act on still verifies, keyed by its body', () => {
  const a = deliver('installation', { action: 'created', installation: { id: 1 } });
  const b = deliver('installation', { action: 'created', installation: { id: 2 } });
  assert.equal(a.ok, true);
  assert.notEqual(a.dedupe_key, b.dedupe_key);
  assert.equal(deliver('push', { ref: 'x', repository: repo }).ok, true);
  assert.deepEqual(factsOf('installation', { action: 'created', repository: repo }), []);
});

test('merged, closed-unmerged, opened and updated PRs map to facts', () => {
  assert.equal(factsOf('pull_request', { action: 'closed', pull_request: pr({ merged: true, merged_by: { login: 'tonde' } }), repository: repo })[0].kind, 'pr.merged');
  const closed = factsOf('pull_request', { action: 'closed', pull_request: pr(), repository: repo, sender: { login: 'callum' } })[0];
  assert.deepEqual([closed.kind, closed.by], ['pr.closed', 'callum']);
  const opened = factsOf('pull_request', { action: 'opened', pull_request: pr(), repository: repo })[0];
  assert.deepEqual([opened.kind, opened.branch, opened.number, opened.pr_id], ['pr.opened', 'board/BDL-12-r3', 42, '991']);
  assert.equal(factsOf('pull_request', { action: 'ready_for_review', pull_request: pr(), repository: repo })[0].kind, 'pr.updated');
  assert.deepEqual(factsOf('pull_request', { action: 'labeled', pull_request: pr(), repository: repo }), []);
});

test('a PR from a fork never carries a branch to link by', () => {
  const fromFork = pr({ head: { ref: 'board/BDL-12-r3', sha: 'c'.repeat(40), repo: fork } });
  const f = factsOf('pull_request', { action: 'opened', pull_request: fromFork, repository: repo })[0];
  assert.equal(f.branch, null);
  const merged = factsOf('pull_request', { action: 'closed', pull_request: { ...fromFork, merged: true }, repository: repo })[0];
  assert.equal(merged.branch, null);
});

test('L3: same repo means the same repo id, whatever the names say', () => {
  const branchOf = (head, repository = repo) => factsOf('pull_request', { action: 'opened', pull_request: pr({ head: { ref: 'board/BDL-12-r3', sha: 'c'.repeat(40), repo: head } }), repository })[0].branch;
  assert.equal(branchOf(repo), 'board/BDL-12-r3');
  assert.equal(branchOf({ id: 777, full_name: 'ACME/APP' }), null, 'same name, other repo');
  assert.equal(branchOf({ full_name: 'acme/app' }), null, 'no id');
  assert.equal(branchOf(null), null, 'deleted head repo');
  assert.equal(branchOf({ id: '501', full_name: 'acme/app' }), null, 'string id');
  assert.equal(branchOf(repo, { ...repo, id: 502 }), null, 'delivered for another repo');
});

test('reviews and check suites map to status facts', () => {
  const r = factsOf('pull_request_review', { action: 'submitted', review: { id: 1, state: 'CHANGES_REQUESTED', user: { login: 'tonde' }, author_association: 'MEMBER', submitted_at: 't' }, pull_request: pr(), repository: repo })[0];
  assert.deepEqual([r.kind, r.review, r.by], ['pr.review', 'changes_requested', 'tonde']);
  const c = factsOf('check_suite', suite({ conclusion: 'failure' }))[0];
  assert.deepEqual([c.kind, c.checks, c.prs], ['pr.checks', 'failure', [{ pr_id: '991', number: 42 }]]);
});

test('hostile field values are clipped or dropped', () => {
  const f = factsOf('pull_request', { action: 'closed', pull_request: pr({ merged: true, merged_by: { login: 'x; rm -rf /' }, html_url: 'javascript:alert(1)', number: -3 }), repository: repo })[0];
  assert.equal(f.by, null);
  assert.equal(f.url, null);
  assert.equal(f.number, null);
  assert.deepEqual(factsOf('pull_request', { action: 'opened', pull_request: pr() }), [], 'no repository → nothing');
});

test('M1: two reviews on one PR in the same second are two deliveries', () => {
  assert.notEqual(dedupeKey('pull_request_review', review({ id: 1 })), dedupeKey('pull_request_review', review({ id: 2, state: 'changes_requested' })));
  assert.equal(dedupeKey('pull_request_review', review({ id: 1 })), dedupeKey('pull_request_review', review({ id: 1 })));
});

test('M1: only OWNER, MEMBER or COLLABORATOR reviews count', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(factsOf('pull_request_review', review({ author_association: a }))[0].review, 'approved', a);
  for (const a of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', undefined, 'owner']) assert.deepEqual(factsOf('pull_request_review', review({ author_association: a })), [], String(a));
});

test('M1: a dismissed review is a dismissal; synchronize and edited never mean review requested', () => {
  assert.equal(factsOf('pull_request_review', review({ state: 'dismissed' }, 'dismissed'))[0].review, 'dismissed');
  const withReviewer = pr({ requested_reviewers: [{ login: 'other' }] });
  for (const action of ['synchronize', 'edited', 'ready_for_review', 'review_request_removed']) {
    assert.equal(factsOf('pull_request', { action, pull_request: withReviewer, repository: repo })[0].review_requested, undefined, action);
  }
  assert.equal(factsOf('pull_request', { action: 'review_requested', pull_request: withReviewer, repository: repo })[0].review_requested, true);
});

test('M2: a push resets checks to pending', () => {
  assert.equal(factsOf('pull_request', { action: 'synchronize', pull_request: pr(), repository: repo })[0].checks_pending, true);
  assert.equal(factsOf('pull_request', { action: 'edited', pull_request: pr(), repository: repo })[0].checks_pending, undefined);
});

test('M2: a check suite speaks only for PRs on its head commit in its own repo', () => {
  const prsOf = (over, repository) => factsOf('check_suite', suite(over, 'completed', repository))[0]?.prs ?? [];
  assert.deepEqual(prsOf({}), [{ pr_id: '991', number: 42 }]);
  assert.deepEqual(prsOf({ pull_requests: [suitePr({ head: { sha: 'b'.repeat(40), repo: { id: 501 } } })] }), [], 'stale head');
  assert.deepEqual(prsOf({ pull_requests: [{ id: 991, number: 42 }] }), [], 'no head recorded');
  assert.deepEqual(prsOf({ pull_requests: [suitePr({ base: { ref: 'main', repo: { id: 999 } } })] }), [], 'PR of another repo');
  assert.deepEqual(prsOf({}, { id: 900, full_name: 'acme/unrelated' }), [], 'suite in another repo naming our PR');
});

test('M2: conclusions: neutral, skipped and stale say nothing; requested is pending; cancelled fails', () => {
  const checksOf = (over, action) => factsOf('check_suite', suite(over, action))[0]?.checks ?? null;
  for (const c of ['neutral', 'skipped', 'stale', null, '']) assert.equal(checksOf({ conclusion: c }), null, String(c));
  for (const c of ['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled']) assert.equal(checksOf({ conclusion: c }), 'failure', c);
  assert.equal(checksOf({ conclusion: 'success' }), 'success');
  assert.equal(checksOf({ conclusion: null, status: 'queued' }, 'requested'), 'pending');
  assert.equal(checksOf({ conclusion: null, status: 'queued' }, 'rerequested'), 'pending');
});
