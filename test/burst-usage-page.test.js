'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'burst-usage.js'), 'utf8');
const VIEW = { source: 'Claude Burst', empty: true, range: '7d', providers: [], repos: [], planRequests: 0, note: 'n' };

async function render(reply) {
  const dom = new JSDOM('<div id="usage-history"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.lightsApi = { burstUsage: async () => reply };
  dom.window.eval(SRC);
  await new Promise((r) => setTimeout(r, 20));
  return dom.window.document.getElementById('burst-usage');
}

test('Through Burst: 14-day bars by slot and per-repository compaction savings, no plan dollars', async () => {
  const history = {
    days: [{ day: '2026-10-05', requests: 0, secondaryRequests: 0, primaryUsd: 0, secondaryUsd: 0 }, { day: '2026-10-06', requests: 40, secondaryRequests: 4, primaryUsd: 9, secondaryUsd: 0.25 }],
    repos: [{ repo: 'plexiform', usd: 2, savedUsd: 0.5, netSavedUsd: 0.5, compacted: true, requests: 40 }, { repo: 'pricey', usd: 2, savedUsd: 0, netSavedUsd: -1.63, compacted: true, requests: 9 }, { repo: 'quiet', usd: 1, savedUsd: 0, netSavedUsd: 0, compacted: false, requests: 3 }],
  };
  const sec = await render({ view: VIEW, codex: null, history, nextPollMs: 0 });
  assert.equal(sec.hidden, false);
  const strip = sec.querySelector('.burst-days');
  assert.equal(strip.children.length, 2);
  assert.match(strip.getAttribute('aria-label'), /40 requests .* 4 requests to backup/);
  assert.match(sec.textContent, /plexiform: \$0\.50 saved/);
  assert.match(sec.textContent, /pricey: cost \$1\.63 more than it saved/);
  assert.match(sec.textContent, /No backup-provider spend in the last 7 days/);
  assert.doesNotMatch(sec.textContent, /quiet|\$9/);
  assert.match(sec.textContent, /Claude Burst's own log .* not from Plexiform's reading of your transcripts/);
});

test('Through Burst: unpriced requests are counted next to the dollars', async () => {
  const sec = await render({ view: { ...VIEW, unpricedRequests: 7620, totalRequests: 17533 }, codex: null, history: null, nextPollMs: 0 });
  assert.match(sec.textContent, /7,620 of 17,533 requests could not be priced/);
  const none = await render({ view: VIEW, codex: null, history: null, nextPollMs: 0 });
  assert.doesNotMatch(none.textContent, /could not be priced/);
});

test('Through Burst: no history, no chart; no Burst, section hidden', async () => {
  const sec = await render({ view: VIEW, codex: null, history: null, nextPollMs: 0 });
  assert.equal(sec.querySelector('.burst-days'), null);
  const none = await render({ view: null, nextPollMs: 0 });
  assert.equal(none.hidden, true);
  assert.equal(none.children.length, 0);
});
