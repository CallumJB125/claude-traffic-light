import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions, mentionQuery, mentionMatches, applyMention, segmentMentions, MAX_MENTIONS } from '../mentions.js';

const members = [
  { id: 'm-alice', display_name: 'Alice', email: 'alice.w@example.test', github_login: 'alicew' },
  { id: 'm-ana', display_name: 'Ana', email: 'ana@example.test' },
  { id: 'm-ana-lima', display_name: 'Ana Lima', email: 'alima@example.test' },
  { id: 'm-bob', display_name: 'Bob', email: null },
];

test('parseMentions: display name and email local part, case-insensitive, with offsets', () => {
  assert.deepEqual(parseMentions('@alice look', members), [{ member_id: 'm-alice', start: 0, end: 6 }]);
  assert.deepEqual(parseMentions('cc @ALICE.W please', members), [{ member_id: 'm-alice', start: 3, end: 11 }]);
  assert.deepEqual(parseMentions('ping @alicew', members), [{ member_id: 'm-alice', start: 5, end: 12 }]);
  assert.deepEqual(parseMentions('@nobody', members), []);
  assert.deepEqual(parseMentions('', members), []);
  assert.deepEqual(parseMentions('@alice', []), []);
});

test('parseMentions: the longest name wins, word boundaries hold, emails are not mentions', () => {
  assert.deepEqual(parseMentions('@Ana Lima and @ana', members).map((m) => m.member_id), ['m-ana-lima', 'm-ana']);
  assert.deepEqual(parseMentions('@anatomy', members), [], 'a longer word is not a prefix match');
  assert.deepEqual(parseMentions('mail alice@example.test', members), [], 'an address is not a mention');
  assert.deepEqual(parseMentions('(@bob)', members), [{ member_id: 'm-bob', start: 1, end: 5 }]);
});

test('parseMentions: one entry per member, at most ten', () => {
  assert.deepEqual(parseMentions('@bob @bob @Bob', members).map((m) => m.member_id), ['m-bob']);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, display_name: `user${i}` }));
  const body = many.map((m) => `@${m.display_name}`).join(' ');
  const found = parseMentions(body, many);
  assert.equal(found.length, MAX_MENTIONS);
  assert.deepEqual(found.map((m) => m.member_id), many.slice(0, 10).map((m) => m.id));
});

test('mentionQuery, mentionMatches and applyMention drive the composer picker', () => {
  assert.deepEqual(mentionQuery('hey @al', 7), { start: 4, query: 'al' });
  assert.equal(mentionQuery('hey @al done', 12), null, 'a space ends the query');
  assert.equal(mentionQuery('mail me@al', 10), null, 'inside an address');
  assert.equal(mentionQuery('plain', 5), null);
  assert.deepEqual(mentionMatches('a', members).map((m) => m.member_id), ['m-alice', 'm-ana-lima', 'm-ana']);
  assert.deepEqual(mentionMatches('', members, { limit: 2 }).length, 2);
  assert.deepEqual(mentionMatches('zz', members), []);
  assert.deepEqual(applyMention('hey @al there', 4, 7, members[0]), { text: 'hey @Alice  there', caret: 11 });
});

test('segmentMentions re-derives chip spans from stored ids; stale ids fall back to text', () => {
  const web = members.map((m) => ({ member_id: m.id, name: m.display_name, login: m.github_login ?? null }));
  assert.deepEqual(segmentMentions('@alice look', ['m-alice'], web), [{ mention: 'm-alice', text: '@alice' }, { text: ' look' }]);
  assert.deepEqual(segmentMentions('@alice look', [], web), [{ text: '@alice look' }]);
  assert.deepEqual(segmentMentions('@gone look', ['m-gone'], web), [{ text: '@gone look' }]);
  assert.deepEqual(segmentMentions('', ['m-alice'], web), [{ text: '' }]);
});
