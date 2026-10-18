const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/session-follow.js');

const e = (name, title, state = 'Working', input = false) => ({ id: 'x', owner: { name }, provider: { id: 'codex' }, board: { label: 'App' }, task: { title }, state, input });
const now = 5_000_000;

test('follow: one event per transition into needs-input, finished or failed; same observation never fires twice', () => {
  let s = F.toggle(F.empty(), e('Ana', 'Fix login'));
  let r = F.observe(s, [e('Ana', 'Fix login')], [e('Ana', 'Fix login', 'Needs input', true)], now);
  assert.equal(r.fresh.length, 1);
  assert.equal(F.describe(r.fresh[0]), 'Ana\'s "Fix login" needs input');
  r = F.observe(r.state, [e('Ana', 'Fix login', 'Needs input', true)], [e('Ana', 'Fix login', 'Needs input', true)], now + 1000);
  assert.equal(r.fresh.length, 0);
  r = F.observe(r.state, [e('Ana', 'Fix login', 'Needs input', true)], [e('Ana', 'Fix login', 'Turn failed')], now + 2000);
  assert.equal(r.fresh[0].transition, 'failed');
  assert.equal(r.state.events.length, 2);
});

test('follow: a followed session that leaves the shared list counts as finished; unfollowed sessions never produce events', () => {
  const s = F.toggle(F.empty(), e('Ana', 'Fix login'));
  const r = F.observe(s, [e('Ana', 'Fix login'), e('Ben', 'Other')], [], now);
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fresh[0].transition, 'finished');
  assert.equal(r.fresh[0].owner, 'Ana');
});

test('follow: persistence round-trip, unseen/markSeen and malformed input', () => {
  let s = F.toggle(F.empty(), e('Ana', 'Fix login'));
  s = F.observe(s, [e('Ana', 'Fix login')], [e('Ana', 'Fix login', 'Ended')], now).state;
  const back = F.parse(F.serialize(s));
  assert.deepEqual(back, s);
  assert.equal(F.unseen(back).length, 1);
  assert.equal(F.unseen(F.markSeen(back)).length, 0);
  assert.deepEqual(F.parse('[1'), F.empty());
  assert.equal(F.following(back, e('Ana', 'Fix login')), true);
});
