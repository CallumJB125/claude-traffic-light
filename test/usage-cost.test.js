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

test('Auto-answer is shown unless PLEXIFORM_SHOW_AUTOANSWER=0, says nothing answers yet, and Usage & cost links to it', () => {
  assert.match(html, /id="view-auto"[^>]*\bhidden\b/, 'hidden until the view script decides');
  assert.match(read('lights-preload.js'), /showAutoAnswer: process\.env\.PLEXIFORM_SHOW_AUTOANSWER !== '0'/);
  assert.match(view, /v === 'auto' && !window\.lightsApi\.showAutoAnswer/);
  assert.match(html, /Rules are saved here but nothing answers automatically yet\./);
  assert.match(html, /<button type="button" class="btn ghost" id="budget-auto" hidden>Auto-answer rules<\/button>/);
  assert.match(view, /\$\('budget-auto'\)\.hidden = !window\.lightsApi\.showAutoAnswer;/);
  assert.match(view, /\$\('budget-auto'\)\.addEventListener\('click', \(\) => window\.lightsApi\.openAutoAnswer\(\)\)/);
  assert.match(read('main.js'), /utilityHandle\('usage:open-auto-answer', analyticsSender, \(\) => \{ if \(process\.env\.PLEXIFORM_SHOW_AUTOANSWER === '0'\) return false; showLightsView\('auto'\); return true; \}\);/);
  const SRC = require('../src/auto-rules.js');
  assert.equal(typeof SRC.matchRule, 'function');
  assert.doesNotMatch(read('main.js'), /AutoRules\.matchRule\(/, 'nothing answers from the rules yet: the tab is a rule editor only');
});

test('Usage & cost is one sidebar entry with tabs, links to the Usage optimiser, and names its two heatmaps apart', () => {
  const { SECTIONS, pageById } = require('../buddy-window/pages.js');
  assert.deepEqual(SECTIONS.find((s) => s.id === 'usage').pages, ['usage', 'stats', 'clients']);
  assert.deepEqual(SECTIONS.find((s) => s.id === 'optimiser').pages, ['optimiser'], 'the optimiser is its own entry, Usage & Burst');
  assert.equal(pageById('stats').unlisted, true, 'Time is a tab, not a second sub-nav entry');
  assert.match(html, /id="budget-optimiser"/);
  assert.match(view, /\$\('budget-optimiser'\)\.addEventListener\('click', \(\) => window\.lightsApi\.openOptimiser\(\)\)/);
  assert.match(read('main.js'), /utilityHandle\('usage:open-optimiser', analyticsSender, \(\) => \{ openBuddy\('optimiser'\); return true; \}\);/);
  assert.doesNotMatch(read('usage-view.js'), /'When you work'/);
  assert.match(html, /When you work/);
});
