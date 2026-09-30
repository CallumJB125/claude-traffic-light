// GitHub webhook signature, replay key and fact mapping (the pure half of
// the GitHub connector), with fixtures shaped like GitHub's payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, sign, dedupeKey, factsOf } from '../integrations/github/webhook.js';

const SECRET = ['whsec', 'test-0123456789abcdef'].join('-');
const repo = { full_name: 'acme/app' };
const pr = (over = {}) => ({
  id: 991, number: 42, html_url: 'https://github.com/acme/app/pull/42', draft: false, merged: false, updated_at: '2026-10-01T10:00:00Z',
  head: { ref: 'board/BDL-12-r3', sha: 'a'.repeat(40), repo }, base: { ref: 'main', repo }, requested_reviewers: [], merged_by: null, ...over,
});
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

test('unhandled event types are refused before anything runs', () => {
  assert.equal(deliver('push', { ref: 'x', repository: repo }).ok, false);
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
  const fork = pr({ head: { ref: 'board/BDL-12-r3', sha: 'c'.repeat(40), repo: { full_name: 'mallory/app' } } });
  const f = factsOf('pull_request', { action: 'opened', pull_request: fork, repository: repo })[0];
  assert.equal(f.branch, null);
  const merged = factsOf('pull_request', { action: 'closed', pull_request: { ...fork, merged: true }, repository: repo })[0];
  assert.equal(merged.branch, null);
});

test('reviews and check suites map to status facts', () => {
  const r = factsOf('pull_request_review', { action: 'submitted', review: { id: 1, state: 'CHANGES_REQUESTED', user: { login: 'tonde' }, submitted_at: 't' }, pull_request: pr(), repository: repo })[0];
  assert.deepEqual([r.kind, r.review, r.by], ['pr.review', 'changes_requested', 'tonde']);
  const c = factsOf('check_suite', { action: 'completed', check_suite: { id: 7, head_sha: 'a'.repeat(40), conclusion: 'failure', pull_requests: [{ id: 991, number: 42 }], updated_at: 't' }, repository: repo })[0];
  assert.deepEqual([c.kind, c.checks, c.prs], ['pr.checks', 'failure', [{ pr_id: '991', number: 42 }]]);
});

test('hostile field values are clipped or dropped', () => {
  const f = factsOf('pull_request', { action: 'closed', pull_request: pr({ merged: true, merged_by: { login: 'x; rm -rf /' }, html_url: 'javascript:alert(1)', number: -3 }), repository: repo })[0];
  assert.equal(f.by, null);
  assert.equal(f.url, null);
  assert.equal(f.number, null);
  assert.deepEqual(factsOf('pull_request', { action: 'opened', pull_request: pr() }), [], 'no repository → nothing');
});
