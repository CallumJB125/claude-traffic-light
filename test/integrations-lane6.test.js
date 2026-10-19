'use strict';

// Wave 2 lane 6: create-ticket drafting/sending, the interrupt gate, Slack
// presence sync (debounce, restore, no client) and the digest's notify hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CreateTicket = require('../src/create-ticket.js');
const Gate = require('../src/interrupt-gate.js');
const Presence = require('../src/slack-presence.js');
const { createDelivery } = require('../src/digest-delivery.js');

const SECRET = 'sk-ant-api03-' + 'A'.repeat(90);
const DOC = [
  '<!-- plexiform-handover v1 -->',
  '# Session handover',
  `- First prompt: fix the login bug, token is ${SECRET}`,
  '- Latest prompt: (not seen)',
  '- Working folder: /Users/alice/work/app',
  `Notes: GITHUB_TOKEN=ghp_${'b'.repeat(36)} and alice@example.com`,
].join('\n');

test('draft: a secret, a home path and an email in the handover never reach the draft', () => {
  const d = CreateTicket.draftFrom(DOC, { home: '/Users/alice', user: 'alice' });
  const all = `${d.title}\n${d.description}`;
  assert.ok(!all.includes(SECRET), 'api key');
  assert.ok(!all.includes('sk-ant-api03'), 'api key prefix');
  assert.ok(!all.includes('ghp_'), 'github token');
  assert.ok(!all.includes('/Users/alice'), 'home path');
  assert.ok(!all.includes('alice@example.com'), 'email');
  assert.match(d.title, /fix the login bug/);
  assert.ok(d.title.length <= CreateTicket.TITLE_MAX && d.description.length <= CreateTicket.BODY_MAX);
  assert.equal(CreateTicket.draftFrom(''), null);
});

function fakeHub({ creates = true, viewer = false } = {}) {
  const sent = [];
  const client = {
    me: async () => ({ ok: true, teams: [{ id: 'team1', name: 'Acme', role: viewer ? 'viewer' : 'member' }] }),
    integrations: async () => ({ ok: true, connections: [{ id: 'conn1', provider: 'linear', status: 'active', creates_issues: creates }, { id: 'conn2', provider: 'slack', status: 'active', creates_issues: true }] }),
    createIssue: async (team, id, body) => { sent.push({ team, id, body }); return { ok: true, issue: { key: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1' } }; },
  };
  return { sent, client };
}

test('create ticket: only Linear/Jira connections that create issues are offered; only the approved text is sent', async () => {
  const { sent, client } = fakeHub();
  const t = CreateTicket.create({ hubs: () => ['https://hub'], clientFor: () => client, handoverText: () => DOC, home: '/Users/alice', user: 'alice' });
  const d = await t.draft({ sessionId: 's1' });
  assert.equal(d.ok, true);
  assert.equal(d.targets.length, 1);
  assert.match(d.targets[0].label, /Create Linear issue \(Acme\)/);
  assert.deepEqual(t.available(), ['Linear']);
  assert.equal(sent.length, 0, 'drafting sends nothing');
  const r = await t.send(d.targets[0].ref, 'My edited title', 'My edited body');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://linear.app/acme/issue/ENG-1');
  assert.deepEqual(sent, [{ team: 'team1', id: 'conn1', body: { title: 'My edited title', description: 'My edited body' } }]);
  assert.equal((await t.send('nope', 't', 'd')).ok, false);
});

test('create ticket: no capable connection, or a viewer, means no button and no draft', async () => {
  for (const opts of [{ creates: false }, { viewer: true }]) {
    const { client } = fakeHub(opts);
    const t = CreateTicket.create({ hubs: () => ['https://hub'], clientFor: () => client, handoverText: () => DOC });
    const d = await t.draft({ sessionId: 's1' });
    assert.equal(d.ok, false);
    assert.deepEqual(t.available(), []);
  }
});

test('interrupt gate: quiet or busy holds; otherwise interruptible', () => {
  let quiet = null, busy = false;
  const g = Gate.create({ quiet: () => quiet, busy: () => busy });
  assert.equal(g.isInterruptible(), true);
  busy = true;
  assert.equal(g.isInterruptible(), false);
  assert.equal(g.why(), 'busy');
  busy = false; quiet = 'snooze';
  assert.equal(g.why(), 'quiet:snooze');
  const broken = Gate.create({ quiet: () => { throw new Error('x'); }, busy: () => { throw new Error('y'); } });
  assert.equal(broken.isInterruptible(), true);
});

test('slack presence: no client → needs_user_scope and nothing sent', async () => {
  const p = Presence.create({ client: null });
  assert.equal(p.state().status, 'off');
  assert.equal((await p.setEnabled(true)).status, 'needs_user_scope');
  assert.equal(await p.update({ sessions: [{ signal: 'tool-use' }] }), false);
});

test('slack presence: debounced to one change per 2 minutes, and turning it off restores the earlier status', async () => {
  let t = 0;
  const calls = [];
  let saved = null;
  const client = { getStatus: async () => ({ text: 'Lunch', emoji: ':taco:' }), setStatus: async (s) => { calls.push(s); } };
  const p = Presence.create({ client, now: () => t, store: { get: () => saved, set: (v) => { saved = v; } } });
  await p.setEnabled(true);
  assert.deepEqual(saved, { text: 'Lunch', emoji: ':taco:' });
  assert.equal(await p.update({ sessions: [{ signal: 'tool-use' }] }), true);
  assert.deepEqual(calls.at(-1), Presence.STATUSES.working);
  t += 30_000;
  assert.equal(await p.update({ sessions: [{ signal: 'permission-ask' }] }), false, 'within 2 minutes: held');
  t += 90_000;
  assert.equal(await p.flush(), true, 'the held change goes once the gap has passed');
  assert.deepEqual(calls.at(-1), Presence.STATUSES.waiting);
  t += 200_000;
  assert.equal(await p.update({ sessions: [{ signal: 'permission-ask' }] }), false, 'no change, nothing sent');
  assert.equal(calls.length, 2);
  await p.setEnabled(false);
  assert.deepEqual(calls.at(-1), { text: 'Lunch', emoji: ':taco:' });
  assert.equal(saved, null);
  assert.equal(Presence.presenceOf({ busy: true, sessions: [{ signal: 'tool-use' }] }), 'away');
  assert.equal(Presence.presenceOf({ sessions: [] }), 'away');
});

test('digest: the notification waits while not interruptible, and is not marked sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane6-digest-'));
  fs.writeFileSync(path.join(dir, 'digest.json'), JSON.stringify({ period: 'day', time: '00:00', notify: true }));
  let ok = false, shown = 0;
  const d = createDelivery({ dir, seal: (s) => Buffer.from(s), unseal: (b) => b.toString(), fetch: async () => ({ ok: true }), digest: async () => ({ slack: 'x' }), notify: () => { shown += 1; }, interruptible: () => ok, now: () => new Date(2026, 9, 19, 12).getTime() });
  assert.deepEqual(await d.tick(), []);
  assert.equal(shown, 0);
  ok = true;
  assert.deepEqual(await d.tick(), ['notify']);
  assert.equal(shown, 1);
});
