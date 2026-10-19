const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/summary-share.js');
const { repoKey } = require('../src/burst-handover.js');

const root = '/Users/callum/code/app';
const replay = { summary: 'Ran 12 tool calls, edited 3 files under /Users/callum/code/app/src, tests passed.', model: { project: 'app' } };
const cards = [{ id: 'c1', kind: 'checklist', title: 'Release checks', items: [{ id: 'i1', label: 'Lint', done: true }, { id: 'i2', label: 'Tests', done: false }] }, { id: 'c2', kind: 'metric', title: 'Cost', value: '0.42', unit: 'USD', note: '' }];
const session = { adapter: 'codex', sessionId: 'thread-123', task: 'Fix login', author: 'Ana' };

test('summary share: the bundle holds the scrubbed summary, data-only cards and provenance without the raw session id', () => {
  const b = S.buildBundle({ replay, cards, session, home: '/Users/callum', user: 'callum', now: Date.UTC(2026, 9, 18) });
  assert.match(b.text, /^# Session summary · app · 2026-10-18/);
  assert.match(b.text, /By Ana using codex on "Fix login"/);
  assert.doesNotMatch(b.text, /thread-123|\/Users\/callum/);
  assert.match(b.text, /Release checks: 1\/2 done/);
  assert.match(b.text, /Cost: 0\.42 USD/);
  assert.equal(b.cards.length, 2);
  assert.equal(b.provenance.session.length, 16);
});

test('summary share: invalid cards are dropped, not sent; repo not opted in or no hub sends nothing', async () => {
  const b = S.buildBundle({ replay, cards: [{ id: 'bad', kind: 'script', title: 'x' }], session });
  assert.deepEqual(b.cards, []);
  const sent = [];
  const notShared = await S.share({ root, bundle: b, shared: {}, send: p => { sent.push(p); return { ok: true }; } });
  assert.equal(notShared.ok, false); assert.equal(notShared.reason, 'not-shared'); assert.equal(sent.length, 0);
  const noHub = await S.share({ root, bundle: b, shared: { [repoKey(root)]: true }, send: null });
  assert.equal(noHub.reason, 'no-hub');
});

test('summary share: an opted-in repo posts one durable system section and reports hub refusals and unconfirmed receipts', async () => {
  const b = S.buildBundle({ replay, cards, session });
  const shared = { [repoKey(root)]: true }, sent = [];
  const ok = await S.share({ root, bundle: b, shared, send: p => { sent.push(p); return { ok: true }; } });
  assert.equal(ok.ok, true);
  assert.equal(sent[0].section, 'summary'); assert.equal(sent[0].written_by, 'system'); assert.equal(sent[0].cards.length, 2); assert.equal(sent[0].provenance.author, 'Ana');
  const refused = await S.share({ root, bundle: b, shared, send: () => ({ ok: false, error: 'viewer role' }) });
  assert.equal(refused.reason, 'refused');
  const lost = await S.share({ root, bundle: b, shared, send: () => { throw new Error('net'); } });
  assert.equal(lost.reason, 'unconfirmed');
});
