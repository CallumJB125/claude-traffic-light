const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/seasonal.js');
const SeasonalMain = require('../src/seasonal-main.js');
const Rules = require('../rules.js');

const day = (m, d, y = 2026) => new Date(y, m - 1, d, 12);

test('seasonFor: each range, its edges and the year wrap', () => {
  assert.equal(S.seasonFor(day(12, 30)), 'newyear');
  assert.equal(S.seasonFor(day(1, 1)), 'newyear');
  assert.equal(S.seasonFor(day(1, 2)), 'newyear');
  assert.equal(S.seasonFor(day(1, 3)), null);
  assert.equal(S.seasonFor(day(2, 9)), null);
  assert.equal(S.seasonFor(day(2, 10)), 'valentine');
  assert.equal(S.seasonFor(day(2, 14)), 'valentine');
  assert.equal(S.seasonFor(day(3, 20)), 'spring');
  assert.equal(S.seasonFor(day(4, 20)), 'spring');
  assert.equal(S.seasonFor(day(4, 21)), null);
  assert.equal(S.seasonFor(day(10, 19)), null);
  assert.equal(S.seasonFor(day(10, 24)), 'halloween');
  assert.equal(S.seasonFor(day(10, 31)), 'halloween');
  assert.equal(S.seasonFor(day(12, 1)), 'winter');
  assert.equal(S.seasonFor(day(12, 26)), 'winter');
  assert.equal(S.seasonFor(day(12, 27)), null);
  assert.equal(S.seasonFor(day(7, 4)), null);
  assert.equal(S.seasonFor(new Date('nope')), null);
});

test('seasonalAccent: every value is in the rules catalogue, so the rig can draw it', () => {
  for (const season of S.SEASONS) {
    const a = S.seasonalAccent(season);
    assert.ok(Object.keys(a).length, season);
    if (a.costume) assert.ok(Rules.COSTUMES.includes(a.costume), `${season} costume ${a.costume}`);
    if (a.pet) assert.ok(Rules.PETS.includes(a.pet), `${season} pet ${a.pet}`);
    if (a.effect) assert.ok(Rules.EFFECTS.includes(a.effect), `${season} effect ${a.effect}`);
  }
  assert.deepEqual(S.seasonalAccent(null), {});
  assert.deepEqual(S.seasonalAccent('easter'), {});
});

test('overlay fills only channels no rule owns, and only while the pack is on', () => {
  const look = () => ({ costume: 'none', pet: 'none', effect: 'none' });
  const hw = day(10, 30);
  assert.deepEqual(S.overlay(look(), {}, {}, hw), { costume: 'witch', pet: 'ghost', effect: 'bats' });
  assert.deepEqual(S.overlay({ costume: 'crown', pet: 'none', effect: 'none' }, { costume: 'r1', pet: 'r2' }, {}, hw), { costume: 'crown', pet: 'none', effect: 'bats' }, 'a rule that set a channel, even to none, keeps it');
  assert.deepEqual(S.overlay(look(), {}, { seasonalPack: false }, hw), look());
  assert.deepEqual(S.overlay(look(), {}, { seasonal: false }, hw), look(), 'the older toggle still opts out');
  assert.deepEqual(S.overlay(look(), {}, {}, day(7, 1)), look(), 'out of season changes nothing');
});

test('seasonal-main applies the overlay to the look main resolved', () => {
  const look = { costume: 'none', pet: 'none', effect: 'none' };
  SeasonalMain.apply(look, {}, { seasonalPack: true }, day(12, 10).getTime());
  assert.deepEqual(look, { costume: 'santa', pet: 'penguin', effect: 'snow' });
});
