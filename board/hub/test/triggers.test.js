// Event triggers (069; docs/event-triggers.md): rules are admin-only, off by
// default and audited; a week of dry run comes before "enable for real";
// every event → action path through the real registry with recorded GitHub
// fixtures and a hand-made signed Sentry body; the closed action list; the
// per-rule rate limit; event-id dedupe and the loop guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { branchName } from '../../shared/fence.js';
import { sign } from '../integrations/github/webhook.js';
import { createSentryConnector } from '../integrations/sentry/index.js';
import { TRIGGER_ACTIONS, TRIGGER_NEVER, DRY_RUN_MS, validateRule, ruleSentence } from '../../shared/triggers.js';
import { githubTriggerEvents, sentryTriggerEvents } from '../trigger-events.js';
import { startHub, until } from './helpers.js';

const FIXTURES = new URL('./fixtures/github/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const KEY = 'BDL-9001';
const WEEK = DRY_RUN_MS;

async function rig(fn) {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const reg = h.app.integrations;
    const secret = randomBytes(24).toString('hex');
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'github', external_id: '77', display_name: 'acme', scopes: [],
      secrets: { app_private_key: randomBytes(32).toString('base64'), webhook_secret: secret } });
    // A card in review whose finished run pushed board/BDL-9001-r1 from main.
    const t = h.hub.iso();
    const cardId = randomUUID(), rid = randomUUID(), runId = randomUUID();
    h.db.run("INSERT INTO cards (id, board_id, key, title, repo_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 'T', ?, ?, ?, ?)", cardId, h.ids.board, KEY, h.ids.repo, h.ids.alice, t, t);
    h.db.run("INSERT INTO dispatches (request_id, card_id, dispatched_by, state, created_at) VALUES (?, ?, ?, 'claimed', ?)", rid, cardId, h.ids.alice, t);
    h.db.run("INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, branch, started_at, ended_at) VALUES (?, ?, 1, ?, ?, ?, 'claude_cli', ?, 'main', ?, ?, ?)",
      runId, cardId, h.ids.alice, h.ids.alice, rid, h.ids.repo, branchName(KEY, 1), t, t);
    let n = 0;
    const send = (event, body) => {
      const rawBody = Buffer.from(JSON.stringify(body));
      return reg.webhook(conn.id, { headers: { 'x-hub-signature-256': sign(secret, rawBody), 'x-github-event': event, 'x-github-delivery': randomUUID() }, rawBody });
    };
    // Each call a distinct delivery of the same PR (a new update time).
    const prEvent = (action, over = {}) => {
      const p = fixture('pull_request.opened.json');
      n += 1;
      return { ...p, action, pull_request: { ...p.pull_request, updated_at: `2026-10-0${1 + (n % 8)}T10:00:${String(n % 60).padStart(2, '0')}Z`, ...over } };
    };
    const api = (cookie, method, path, body) => h.api(cookie, method, path, method === 'GET' ? undefined : { request_id: randomUUID(), ...body });
    const make = async (rule, cookie = alice) => {
      const r = await api(cookie, 'POST', '/api/triggers', rule);
      assert.equal(r.status, 200, r.text);
      return r.body.trigger;
    };
    const mode = (id, m, extra = {}, cookie = alice) => api(cookie, 'POST', `/api/triggers/${id}/mode`, { mode: m, ...extra });
    const enable = async (id) => {
      assert.equal((await mode(id, 'dry_run')).status, 200);
      h.clock.advance(WEEK + 1000);
      const on = await mode(id, 'on', { confirm: true });
      assert.equal(on.status, 200, on.text);
      return on.body.trigger;
    };
    const firings = (id) => h.db.all('SELECT * FROM event_trigger_firings WHERE trigger_id = ? ORDER BY id', id);
    await fn({ h, alice, bob, reg, conn, cardId, runId, send, prEvent, api, make, mode, enable, firings });
  } finally {
    await h.destroy();
  }
}

const runsAndDispatches = (h) => h.db.get('SELECT (SELECT COUNT(*) FROM runs) + (SELECT COUNT(*) FROM dispatches) AS n').n;

test('rules: admin-only, off by default, plain sentences, and every change audited', () => rig(async ({ h, alice, bob, api, make, mode, firings, send, prEvent }) => {
  const rule = { event: 'github.pr.opened', filters: { repo: 'acme/app' }, action: 'request_ai_review' };
  assert.equal((await api(bob, 'POST', '/api/triggers', rule)).status, 403, 'members cannot create triggers');
  const t = await make(rule);
  assert.equal(t.mode, 'off');
  assert.equal(t.sentence, 'When a pull request is opened in acme/app, ask the AI to review it and comment');
  const listed = await api(bob, 'GET', '/api/triggers');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.can_edit, false);
  assert.deepEqual(listed.body.triggers.map((x) => x.id), [t.id]);
  assert.equal((await mode(t.id, 'dry_run', {}, bob)).status, 403);
  assert.equal((await api(bob, 'DELETE', `/api/triggers/${t.id}`)).status, 403);

  assert.equal((await send('pull_request', prEvent('opened'))).status, 200);
  assert.deepEqual(firings(t.id), [], 'a rule that is off never fires');

  assert.equal((await mode(t.id, 'dry_run')).status, 200);
  assert.equal((await mode(t.id, 'off')).status, 200);
  assert.equal((await api(alice, 'DELETE', `/api/triggers/${t.id}`)).status, 200);
  assert.equal((await api(alice, 'GET', '/api/triggers')).body.triggers.length, 0);
  const audit = h.db.all("SELECT actor, action, target, detail FROM audit WHERE action LIKE 'trigger.%' ORDER BY id");
  assert.deepEqual(audit.map((a) => [a.actor, a.action, a.target]), [
    [h.ids.alice, 'trigger.create', t.id], [h.ids.alice, 'trigger.mode', t.id], [h.ids.alice, 'trigger.mode', t.id], [h.ids.alice, 'trigger.delete', t.id]]);
  assert.deepEqual(JSON.parse(audit[1].detail), { from: 'off', to: 'dry_run' });
  assert.throws(() => h.db.run("UPDATE event_triggers SET action = 'add_comment' WHERE id = ?", t.id), /never changed/);
}));

test('allow-list: anything but the five actions is refused, and no action can dispatch, move or run anything', () => rig(async ({ h, api, alice }) => {
  assert.deepEqual([...TRIGGER_ACTIONS], ['create_card', 'add_comment', 'request_ai_review', 'notify_member', 'label_card']);
  for (const action of [...TRIGGER_NEVER, 'start_run', 'dispatch_card', 'run_ai', '__proto__']) {
    const r = await api(alice, 'POST', '/api/triggers', { event: 'github.pr.opened', action });
    assert.equal(r.status, 400, `${action} must be refused`);
  }
  for (const bad of [
    { event: 'github.push', action: 'add_comment', params: { text: 'x' } },
    { event: 'card.moved_to_review', action: 'create_card', params: { board_id: h.ids.board } },
    { event: 'github.pr.opened', action: 'label_card', params: { label: 'via:github' } },
    { event: 'github.pr.opened', action: 'add_comment', params: { text: 'x', for_agent: true } },
    { event: 'sentry.issue.new', filters: { repo: 'acme/app' }, action: 'add_comment', params: { text: 'x' } },
    { event: 'github.pr.opened', action: 'create_card', params: { board_id: 'not-our-board' } },
    { event: 'github.pr.opened', action: 'notify_member', params: { member_id: randomUUID() } },
    { event: 'github.pr.opened', action: 'request_ai_review', max_per_hour: 1000 },
  ]) assert.equal((await api(alice, 'POST', '/api/triggers', bad)).status, 400, JSON.stringify(bad));
  assert.throws(() => h.db.run(`INSERT INTO event_triggers (id, org_id, event, action, created_by, created_at, updated_at) VALUES (?, ?, 'github.pr.opened', 'dispatch', ?, 'x', 'x')`, randomUUID(), h.ids.org, h.ids.alice), /CHECK/);
  assert.deepEqual(h.hub.triggers.plan({ action: 'dispatch', enabled_by: h.ids.alice, org_id: h.ids.org, params: '{}' }, {}), { ok: false, detail: 'action_not_allowed' });
}));

test('dry run: logs "would" without acting; enabling for real needs a week of dry run and a confirmation', () => rig(async ({ h, alice, h: { db }, cardId, send, prEvent, make, mode, firings, api }) => {
  const t = await make({ event: 'github.pr.opened', action: 'add_comment', params: { text: 'Please add a changelog entry.' } });
  assert.equal((await mode(t.id, 'on', { confirm: true })).status, 409, 'off → on is refused');
  assert.equal((await mode(t.id, 'dry_run')).status, 200);
  assert.equal((await send('pull_request', prEvent('opened'))).status, 200);
  assert.deepEqual(firings(t.id).map((f) => [f.mode, f.result, f.detail, f.card_id, f.subject]), [['dry_run', 'would', 'add_comment', cardId, 'acme/app#12']]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM comments WHERE card_id = ?', cardId).n, 0, 'a dry run writes nothing');
  const early = await mode(t.id, 'on', { confirm: true });
  assert.equal(early.status, 409);
  assert.match(early.text, /DRY_RUN_FIRST/);
  h.clock.advance(WEEK + 1000);
  assert.equal((await mode(t.id, 'on')).status, 400, 'enabling for real needs confirm: true');
  assert.equal((await mode(t.id, 'on', { confirm: true })).status, 200);
  assert.equal((await send('pull_request', prEvent('reopened'))).status, 200);
  const c = db.all('SELECT * FROM comments WHERE card_id = ?', cardId);
  assert.equal(c.length, 1);
  assert.equal(c[0].body, 'Please add a changelog entry.\nhttps://github.com/acme/app/pull/12');
  assert.deepEqual([c[0].source, c[0].trusted, c[0].for_agent], ['integration', 0, 0], 'untrusted and never for the agent');
  assert.equal(firings(t.id).at(-1).result, 'done');
  const j = db.get("SELECT actor_kind, actor_id FROM journal WHERE kind = 'comment.create' ORDER BY seq DESC LIMIT 1");
  assert.deepEqual({ ...j }, { actor_kind: 'integration', actor_id: `trigger:${t.id}` });
  const log = await api(alice, 'GET', '/api/triggers/activity');
  assert.deepEqual(log.body.firings.map((f) => f.result), ['done', 'would']);
}));

test('github.pr.opened → create_card: one card per event on the chosen board, text kept out of the journal', () => rig(async ({ h, send, prEvent, make, enable, firings }) => {
  const before = runsAndDispatches(h);
  const t = await make({ event: 'github.pr.opened', filters: { repo: 'acme/app', branch: 'board/*' }, action: 'create_card', params: { board_id: h.ids.board } });
  await enable(t.id);
  const ev = prEvent('opened');
  assert.equal((await send('pull_request', ev)).status, 200);
  assert.equal((await send('pull_request', ev)).body.duplicate, true);
  const cards = h.db.all("SELECT * FROM cards WHERE labels LIKE '%via:trigger%'");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Pull request: acme/app#12 Add retry to the ingest worker');
  assert.equal(cards[0].column_name, 'todo');
  assert.equal(firings(t.id)[0].card_id, cards[0].id);
  const create = h.db.get("SELECT actor_kind, payload FROM journal WHERE card_id = ? AND kind = 'card.create'", cards[0].id);
  assert.equal(create.actor_kind, 'integration');
  assert.doesNotMatch(create.payload, /ingest worker/);
  // The same event id replayed straight into the engine is still one firing.
  const [again] = githubTriggerEvents('pull_request', ev, { connectionId: firings(t.id)[0].event_id.split(':')[1] });
  await h.hub.triggers.ingest({ ...again, org_id: h.ids.org });
  assert.equal(firings(t.id).length, 1);
  assert.equal(h.db.all("SELECT * FROM cards WHERE labels LIKE '%via:trigger%'").length, 1);
  assert.equal(runsAndDispatches(h), before, 'nothing dispatched or run');
}));

test('filters: repo, branch pattern and label narrow a rule; fork PRs never trigger', () => rig(async ({ h, send, prEvent, make, mode, firings }) => {
  const other = await make({ event: 'github.pr.opened', filters: { repo: 'acme/api' }, action: 'add_comment', params: { text: 'x' } });
  const branch = await make({ event: 'github.pr.opened', filters: { branch: 'release/*' }, action: 'add_comment', params: { text: 'x' } });
  const label = await make({ event: 'github.pr.opened', filters: { label: 'Needs-Review' }, action: 'add_comment', params: { text: 'x' } });
  for (const t of [other, branch, label]) assert.equal((await mode(t.id, 'dry_run')).status, 200);
  await send('pull_request', prEvent('opened'));
  assert.deepEqual([other, branch, label].map((t) => firings(t.id).length), [0, 0, 0]);
  await send('pull_request', prEvent('opened', { labels: [{ name: 'needs-review' }] }));
  assert.deepEqual([other, branch, label].map((t) => firings(t.id).length), [0, 0, 1]);
  const fork = fixture('pull_request.opened.fork.json');
  assert.deepEqual(githubTriggerEvents('pull_request', fork, { connectionId: 'c' }), []);
}));

test('github.pr.review_requested → label_card on the PR’s card', () => rig(async ({ h, cardId, send, prEvent, make, enable, firings }) => {
  await send('pull_request', prEvent('opened'));
  const t = await make({ event: 'github.pr.review_requested', action: 'label_card', params: { label: 'needs-review' } });
  await enable(t.id);
  await send('pull_request', prEvent('review_requested'));
  assert.deepEqual(JSON.parse(h.card(cardId).labels), ['needs-review']);
  assert.equal(firings(t.id)[0].result, 'done');
  await send('pull_request', prEvent('review_requested'));
  assert.deepEqual(firings(t.id).map((f) => [f.result, f.detail]), [['done', 'label_card'], ['skipped', 'already_labelled']]);
}));

test('github.checks.failed → notify_member through the hub notification path', () => rig(async ({ h, bob, cardId, send, prEvent, make, enable, firings }) => {
  await send('pull_request', prEvent('opened'));
  const t = await make({ event: 'github.checks.failed', filters: { repo: 'acme/app' }, action: 'notify_member', params: { member_id: h.ids.bob } });
  assert.equal(t.sentence, 'When checks fail on a pull request in acme/app, notify Bob');
  await enable(t.id);
  const suite = fixture('check_suite.completed.json');
  await send('check_suite', { ...suite, check_suite: { ...suite.check_suite, conclusion: 'success' } });
  assert.equal(firings(t.id).length, 0, 'passing checks are not an event');
  await send('check_suite', { ...suite, check_suite: { ...suite.check_suite, conclusion: 'failure', updated_at: '2026-10-01T10:09:00Z' } });
  assert.equal(firings(t.id)[0].result, 'done');
  const n = h.hub.notifications.at(-1);
  assert.deepEqual([n.rule, n.card_id, n.to], ['trigger', cardId, [h.ids.bob]]);
  assert.ok(h.db.get("SELECT 1 AS x FROM journal WHERE kind = 'card.notify' AND card_id = ? AND actor_id = ?", cardId, `trigger:${t.id}`));
  const alerts = await h.api(bob, 'GET', `/api/boards/${h.ids.board}/alerts`);
  if (alerts.status === 200) assert.ok(alerts.body.notifications.some((x) => x.id === n.id));
}));

test('card.moved_to_review → request_ai_review: the read-only reviewer is asked; nothing else runs', () => rig(async ({ h, alice, cardId, runId, make, enable, firings, api }) => {
  const s = JSON.parse(h.hub.board(h.ids.board).settings ?? '{}');
  h.db.run('UPDATE boards SET settings = ? WHERE id = ?', JSON.stringify({ ...s, ai_review: { enabled: true, disclosure_ack: true } }), h.ids.board);
  const t = await make({ event: 'card.moved_to_review', filters: { repo: 'acme/app', branch: 'board/BDL-*' }, action: 'request_ai_review' });
  await enable(t.id);
  const before = runsAndDispatches(h);
  const r = await api(alice, 'PATCH', `/api/cards/${cardId}`, { version: h.card(cardId).version, column: 'in_review' });
  assert.equal(r.status, 200, r.text);
  await until(() => firings(t.id).length === 1);
  assert.equal(firings(t.id)[0].result, 'done');
  const reviews = h.db.all('SELECT * FROM card_reviews WHERE card_id = ?', cardId);
  assert.deepEqual(reviews.map((x) => [x.run_id, x.status]), [[runId, 'pending']]);
  assert.match(h.db.get('SELECT body FROM comments WHERE card_id = ?', cardId).body, /never edits code/);
  assert.equal(h.card(cardId).column_name, 'in_review');
  assert.equal(runsAndDispatches(h), before, 'a review request is not a run or a dispatch');
}));

test('sentry.issue.new → label_card on the issue’s card, through the wrapped Sentry connector', () => rig(async ({ h, alice, make, enable, firings }) => {
  h.app.integrations.register(h.hub.triggers.observe(createSentryConnector({ now: () => h.clock.wall() })));
  const secret = randomBytes(24).toString('base64url');
  const conn = (await h.api(alice, 'POST', '/api/integrations/sentry/token', { request_id: randomUUID(), token: secret })).body.connection;
  assert.equal((await h.api(alice, 'PATCH', `/api/integrations/${conn.id}`, { request_id: randomUUID(), config: { default_board_id: h.ids.board } })).status, 200);
  const t = await make({ event: 'sentry.issue.new', action: 'label_card', params: { label: 'incident' } });
  assert.equal(t.sentence, 'When Sentry reports a new issue, label its card “incident”');
  await enable(t.id);
  const id = '4242424242';
  const iso = (ms) => new Date(ms).toISOString().replace('Z', '000+00:00');
  const body = { action: 'created', installation: { uuid: randomUUID() }, data: { issue: {
    id, web_url: `https://example-org.sentry.io/issues/${id}/`, shortId: 'PY-1', title: 'TypeError', culprit: 'app/views.py in handler', level: 'error', status: 'unresolved',
    project: { id: '1', slug: 'python' }, metadata: { type: 'TypeError', value: 'x' }, count: '1', userCount: 1, firstSeen: iso(h.clock.wall() - 60_000), lastSeen: iso(h.clock.wall()) } } };
  const raw = Buffer.from(JSON.stringify(body));
  const headers = { 'content-type': 'application/json', 'sentry-hook-resource': 'issue', 'request-id': randomUUID(),
    'sentry-hook-signature': createHmac('sha256', secret).update(raw).digest('hex'), 'sentry-hook-timestamp': String(Math.floor(Date.now() / 1000)) };
  const res = await h.app.integrations.webhook(conn.id, { headers, rawBody: raw });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const card = h.db.get("SELECT * FROM cards WHERE labels LIKE '%via:sentry%'");
  assert.ok(JSON.parse(card.labels).includes('incident'));
  assert.deepEqual(firings(t.id).map((f) => [f.result, f.subject]), [['done', `python ${id}`]]);
  assert.deepEqual(sentryTriggerEvents({ ...body, action: 'resolved' }, { connectionId: 'c', now: h.clock.wall() }), [], 'only new issues are events');
}));

test('rate limit: at most max_per_hour actions per rule, then rate_limited until the hour passes', () => rig(async ({ h, send, prEvent, make, mode, enable, firings }) => {
  const t = await make({ event: 'github.pr.opened', action: 'add_comment', params: { text: 'x' }, max_per_hour: 2 });
  assert.equal((await mode(t.id, 'dry_run')).status, 200);
  for (let i = 0; i < 4; i += 1) await send('pull_request', prEvent('reopened'));
  assert.deepEqual(firings(t.id).map((f) => f.result), ['would', 'would', 'rate_limited', 'rate_limited']);
  h.clock.advance(3_600_001);
  await send('pull_request', prEvent('reopened'));
  assert.equal(firings(t.id).at(-1).result, 'would');
  const def = await make({ event: 'github.pr.opened', action: 'add_comment', params: { text: 'y' } });
  assert.equal(def.max_per_hour, 10, 'the default is 10 an hour');
  const one = await make({ event: 'card.moved_to_review', action: 'add_comment', params: { text: 'z' }, max_per_hour: 1 });
  await enable(one.id);
  const cardId = h.db.get('SELECT id FROM cards WHERE key = ?', KEY).id;
  const ev = (id) => h.hub.triggers.ingest({ type: 'card.moved_to_review', id, org_id: h.ids.org, card_id: cardId, subject: KEY });
  await Promise.all([ev('journal:a'), ev('journal:b')]);
  assert.deepEqual(firings(one.id).map((f) => f.result).sort(), ['done', 'rate_limited'], 'firings still running count toward the limit');
}));

test('loop guard: what a trigger wrote, or anything raised inside a firing, never triggers again', () => rig(async ({ h, alice, cardId, make, enable, firings, api }) => {
  const t = await make({ event: 'card.moved_to_review', action: 'label_card', params: { label: 'seen' } });
  await enable(t.id);
  const tr = h.hub.triggers;
  await tr.onJournal({ seq: 1e9, kind: 'card.update', card_id: cardId, actor_kind: 'integration', actor_id: `trigger:${t.id}`, payload: { fields: { column_name: ['todo', 'in_review'] } } });
  await tr.firing.run({ trigger_id: t.id }, () => tr.ingest({ type: 'card.moved_to_review', id: 'journal:echo', org_id: h.ids.org, card_id: cardId, subject: KEY }));
  assert.deepEqual(firings(t.id), []);
  const r = await api(alice, 'PATCH', `/api/cards/${cardId}`, { version: h.card(cardId).version, column: 'in_review' });
  assert.equal(r.status, 200, r.text);
  await until(() => firings(t.id).length === 1);
  // The label it wrote is a card.update by trigger:<id>; let the bus deliver it, then nothing more fires.
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(firings(t.id).map((f) => f.result), ['done']);
  assert.deepEqual(JSON.parse(h.card(cardId).labels), ['seen']);
}));

test('safety at fire time: a removed enabler, a deleted team, and validation in the shared model', () => rig(async ({ h, send, prEvent, make, enable, firings }) => {
  const t = await make({ event: 'github.pr.opened', action: 'add_comment', params: { text: 'x' } });
  await enable(t.id);
  h.db.run('UPDATE event_triggers SET enabled_by = ? WHERE id = ?', h.ids.bob, t.id);
  await send('pull_request', prEvent('opened'));
  assert.deepEqual(firings(t.id).map((f) => [f.result, f.detail]), [['skipped', 'actor_unavailable']], 'an enabler who is no longer an admin acts for nobody');
  h.db.run('UPDATE orgs SET deleted_at = ? WHERE id = ?', h.hub.iso(), h.ids.org);
  assert.equal(h.db.get('SELECT mode FROM event_triggers WHERE id = ?', t.id).mode, 'off', 'deleting a team switches its triggers off');
  assert.throws(() => validateRule({ event: 'github.pr.opened', action: 'add_comment', params: { text: '' } }), /comment/);
  assert.equal(ruleSentence({ event: 'github.pr.opened', action: 'request_ai_review', filters: { repo: 'acme/api' } }), 'When a pull request is opened in acme/api, ask the AI to review it and comment');
}));
