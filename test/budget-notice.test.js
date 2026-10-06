// The budget notice's pure half: strict validation of the runner's event,
// dedupe per run, the cap, clearing, the text and the board fragment.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/budget-notice.js');

const ev = (o = {}) => ({ type: 'run.budget_reached', run_id: 'run_1', card_id: 'card-9', spent_usd: 4.8, budget_usd: 5, card_key: 'PLX-123', ...o });

test('accepts a well-formed event, with or without card_key', () => {
  assert.deepEqual(B.classify(ev()).notice, { runId: 'run_1', cardId: 'card-9', spent: 4.8, budget: 5, cardKey: 'PLX-123' });
  assert.equal(B.classify(ev({ card_key: undefined })).notice.cardKey, null);
  assert.ok(B.classify(ev({ spent_usd: 0, budget_usd: 1000000 })));
});

test('rejects anything off-contract', () => {
  const bad = [
    null, 'x', [], {}, ev({ type: 'run.other' }), ev({ type: undefined }),
    ev({ run_id: '' }), ev({ run_id: 5 }), ev({ run_id: 'a b' }), ev({ run_id: 'a'.repeat(65) }), ev({ run_id: '<b>' }),
    ev({ card_id: 'a/b' }), ev({ card_id: 'a'.repeat(65) }), ev({ card_id: undefined }),
    ev({ spent_usd: -1 }), ev({ spent_usd: NaN }), ev({ spent_usd: Infinity }), ev({ spent_usd: '4' }),
    ev({ budget_usd: -0.01 }), ev({ budget_usd: undefined }),
    ev({ card_key: 'PLX_1' }), ev({ card_key: 'PLX' }), ev({ card_key: '1PLX-1' }), ev({ card_key: 'A'.repeat(17) + '-1' }), ev({ card_key: 'PLX-1234567890' }), ev({ spent_usd: 1000001 }), ev({ card_key: 7 }), ev({ card_key: '<img>' }),
  ];
  for (const b of bad) assert.equal(B.classify(b), null, JSON.stringify(b));
});

test('a repeat of the same run does not add a second notice', () => {
  const n = B.createNotices();
  assert.equal(n.handle(ev()).added, true);
  const again = n.handle(ev());
  assert.deepEqual([again.added, again.changed], [false, false]);
  assert.equal(n.list().length, 1);
  assert.equal(n.handle(ev({ spent_usd: 5 })).changed, true);
  assert.equal(n.list()[0].spent, 5);
});

test('caps at ten, dropping the oldest, newest first', () => {
  const n = B.createNotices();
  for (let i = 0; i < 12; i++) n.handle(ev({ run_id: `r${i}` }));
  const ids = n.list().map((x) => x.runId);
  assert.equal(ids.length, 10);
  assert.equal(ids[0], 'r11');
  assert.equal(ids[9], 'r2');
});

test('dismiss, run.resumed and run.ended drop only that run', () => {
  const n = B.createNotices();
  for (const r of ['a', 'b', 'c', 'd']) n.handle(ev({ run_id: r }));
  n.dismiss('a');
  assert.equal(n.handle({ type: 'run.resumed', run_id: 'b' }).changed, true);
  assert.equal(n.handle({ type: 'run.ended', run_id: 'c' }).changed, true);
  assert.equal(n.handle({ type: 'run.ended', run_id: 'zzz' }).changed, false);
  assert.equal(n.handle({ type: 'run.ended', run_id: 'bad id' }).changed, false);
  assert.deepEqual(n.list().map((x) => x.runId), ['d']);
});

test('text names the card when there is a key', () => {
  assert.equal(B.text(B.classify(ev()).notice), 'Your run on PLX-123 reached its budget ($4.80 of $5.00)');
  assert.equal(B.text(B.classify(ev({ card_key: undefined })).notice), 'Your Tackle with AI run reached its budget ($4.80 of $5.00)');
});

test('the fragment is base64url JSON {v:1, card_id}', () => {
  const f = B.fragment(B.classify(ev()).notice);
  assert.match(f, /^plexiform-budget=[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(f.split('=')[1], 'base64url').toString()), { v: 1, card_id: 'card-9' });
});

test('notify once per stop: a resumed run that hits a new budget notifies again', () => {
  const n = B.createNotices();
  assert.equal(n.handle(ev()).notify, true);
  assert.equal(n.handle(ev()).notify, false);
  n.handle({ type: 'run.resumed', run_id: 'run_1' });
  assert.equal(n.handle(ev({ budget_usd: 10, spent_usd: 9.9 })).notify, true);
});

test('the notified set is bounded', () => {
  const n = B.createNotices();
  for (let i = 0; i < 500; i++) n.handle(ev({ run_id: `r${i}` }));
  assert.ok(n.notifiedSize() <= 100);
});

test('a dismissed run stays gone when the runner re-emits it, until it resumes or ends', () => {
  const n = B.createNotices();
  n.handle(ev());
  n.dismiss('run_1');
  const again = n.handle(ev());
  assert.deepEqual([again.added, again.changed, again.notify], [false, false, false]);
  assert.equal(n.list().length, 0);
  n.handle({ type: 'run.ended', run_id: 'run_1' });
  assert.equal(n.handle(ev()).notify, true);
});

test('a 64-char card_id still gives an acceptable fragment', () => {
  const f = B.fragment(B.classify(ev({ card_id: 'a'.repeat(64) })).notice);
  assert.match(f, /^plexiform-budget=[A-Za-z0-9_-]{1,512}$/);
});
