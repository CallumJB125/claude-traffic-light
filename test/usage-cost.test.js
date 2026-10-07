const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('lights.html');
const view = read('lights-view.js');

test('Usage & cost: Overview and Time tabs share one range control', () => {
  assert.match(html, /id="ut-mix"[^>]*>Overview</);
  assert.match(html, /id="ut-stats"[^>]*>Time</);
  assert.equal((html.match(/aria-label="Range"/g) || []).length, 1);
  assert.doesNotMatch(read('usage-view.js'), /RANGES/);
});

test("today's cost is drawn once: Overview owns it, Time does not repeat it", () => {
  assert.match(html, /id="mix-today-cost"/);
  assert.doesNotMatch(html, /id="today-cost"/);
  assert.doesNotMatch(view, /today-cost/);
  assert.doesNotMatch(view, /\$\{usd\(today\)\} today/);
});

test('the daily limit is set inline and written through the same spend keys as Preferences', () => {
  for (const id of ['budget-daily', 'budget-weekly', 'budget-warn', 'budget-save']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(view, /saveSpendLimits\(\{ dailyBudget/);
  const main = read('main.js');
  assert.match(main, /'save-spend-limits', analyticsSender/);
  assert.match(main, /dailyBudget: n\(v && v\.dailyBudget/);
});

test('no empty state mentions npm or ccusage', () => {
  for (const f of ['lights.html', 'lights-view.js', 'usage-view.js']) assert.doesNotMatch(read(f), /npm i|ccusage/, f);
  assert.match(html, /No AI activity in the last 7 days/);
  assert.match(html, /id="mix-connect"/);
});

test('Auto-answer is hidden unless PLEXIFORM_SHOW_AUTOANSWER=1', () => {
  assert.match(html, /id="view-auto"[^>]*\bhidden\b/);
  assert.match(read('lights-preload.js'), /showAutoAnswer: process\.env\.PLEXIFORM_SHOW_AUTOANSWER === '1'/);
  assert.match(view, /v === 'auto' && !window\.lightsApi\.showAutoAnswer/);
});
