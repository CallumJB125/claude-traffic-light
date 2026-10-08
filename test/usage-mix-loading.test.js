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
