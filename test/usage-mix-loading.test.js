const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'lights-view.js'), 'utf8');
const body = src.slice(src.indexOf('async function renderMix()'), src.indexOf('// Follows the hooks'));
function run(modelMix) {
  const els = {};
  const $ = (id) => (els[id] ??= { hidden: false, textContent: '' });
  const renderMix = new Function('$', 'window', 'renderUsageHistory', 'paintMixWindow', `${body}; return renderMix;`)($, { lightsApi: { modelMix } }, () => {}, () => {});
  return renderMix().then(() => els);
}
test('Reading transcripts… clears when the usage read finishes, with data, with none, or on failure', async () => {
  const week = { turns: 3 };
  assert.equal((await run(async () => ({ today: week, week, recommendation: 'x' })))['mix-loading'].hidden, true);
  const none = await run(async () => ({ today: { turns: 0 }, week: { turns: 0 } }));
  assert.equal(none['mix-loading'].hidden, true); assert.equal(none['mix-empty'].hidden, false);
  const failed = await run(async () => { throw new Error('boom'); });
  assert.equal(failed['mix-loading'].hidden, true); assert.equal(failed['mix-empty'].hidden, false);
  assert.equal((await run(async () => null))['mix-loading'].hidden, true);
});

test('A10: turns on models with no price are activity: never "No AI activity", and no Connect button', async () => {
  const zero = { turns: 0 };
  const gw = await run(async () => ({ today: zero, week: zero, unpricedWeek: 18 }));
  assert.equal(gw['mix-empty'].hidden, false);
  assert.match(gw['mix-empty-text'].textContent, /^18 turns in the last 7 days, all on models with no price/);
  assert.doesNotMatch(gw['mix-empty-text'].textContent, /No AI activity/);
  assert.equal(gw['mix-connect'].hidden, true);
  const none = await run(async () => ({ today: zero, week: zero, unpricedWeek: 0 }));
  assert.equal(none['mix-empty-text'].textContent, 'No AI activity in the last 7 days.');
  assert.equal(none['mix-connect'].hidden, false);
});

test('A10: unpricedTurns counts the 7-day window modelMix leaves out, and modelMix itself is unchanged', () => {
  const MM = require('../src/model-mix.js');
  const now = new Date(2026, 9, 19, 14).getTime();
  const t = (ts, modelKey) => ({ ts, modelKey, input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
  const turns = [t(now - 1000, 'unpriced'), t(now - 2 * 86400000, 'unpriced'), t(now - 30 * 86400000, 'unpriced'), t(now - 1000, 'sonnet')];
  assert.equal(MM.unpricedTurns(turns, { now }), 2);
  assert.equal(Object.hasOwn(MM.modelMix(turns, { now }).week, 'unpriced'), false);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /utilityHandle\('model-mix'[^\n]*unpricedWeek: require\('\.\/src\/model-mix\.js'\)\.unpricedTurns\(turns\)/);
});
