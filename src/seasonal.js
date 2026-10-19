// The seasonal pack: which season a date falls in, and the look that season
// lends the character. Pure; src/seasonal-main.js applies it to the resolved
// look. Dates are local calendar days, inclusive.
const SEASONS = ['newyear', 'valentine', 'spring', 'halloween', 'winter'];

// [season, from month/day, to month/day]; a range may wrap the year end.
const RANGES = [
  ['newyear', [12, 30], [1, 2]],
  ['valentine', [2, 10], [2, 14]],
  ['spring', [3, 20], [4, 20]],
  ['halloween', [10, 24], [10, 31]],
  ['winter', [12, 1], [12, 26]],
];

const ACCENTS = {
  newyear: { costume: 'partyhat', effect: 'fireworks' },
  valentine: { costume: 'heartband', effect: 'hearts' },
  spring: { costume: 'bunny', pet: 'chick', effect: 'petals' },
  halloween: { costume: 'witch', pet: 'ghost', effect: 'bats' },
  winter: { costume: 'santa', pet: 'penguin', effect: 'snow' },
};

const key = (m, d) => m * 100 + d;

function seasonFor(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const k = key(d.getMonth() + 1, d.getDate());
  for (const [season, from, to] of RANGES) {
    const a = key(...from), b = key(...to);
    if (a <= b ? k >= a && k <= b : k >= a || k <= b) return season;
  }
  return null;
}

function seasonalAccent(season) {
  return ACCENTS[season] ? { ...ACCENTS[season] } : {};
}

// On unless the user switched it off (seasonalPack, or the older seasonal toggle).
const enabled = (config) => !!config && config.seasonalPack !== false && config.seasonal !== false;

// Fill the channels no rule owns; a rule that set a channel, even to 'none', keeps it.
function overlay(look, owned = {}, config = {}, date = new Date()) {
  if (!look || !enabled(config)) return look;
  const accent = seasonalAccent(seasonFor(date));
  for (const ch of ['costume', 'pet', 'effect']) {
    if (accent[ch] && !(owned && owned[ch]) && (!look[ch] || look[ch] === 'none')) look[ch] = accent[ch];
  }
  return look;
}

module.exports = { SEASONS, RANGES, ACCENTS, seasonFor, seasonalAccent, enabled, overlay };
