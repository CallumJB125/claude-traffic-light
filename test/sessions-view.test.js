'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../sessions.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../sessions.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = overrides => ({ status: 'complete', observed_at: Date.now(), omitted: 0, activity: { configured: true, observed: true, latest_age_ms: 1000 }, sessions: [], ...overrides });
function setup(api) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  let hidden = false; const intervals = [];
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  dom.window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  dom.window.sessionsApi = api; dom.window.eval(script);
  return { dom, document: dom.window.document, intervals, hide(value) { hidden = value; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); } };
}
test('DOM renders only text metadata, with explicit stale and child reported state', async () => {
  const fixture = setup({ state: async () => state({ sessions: [{ provider: 'Codex', project: '<img src=x onerror=alert(1)>', status: 'Turn stopped', freshness: 'stale', age_ms: 100000, lifecycle: true, children: [{ label: 'Codex subagent 1', status: 'Working' }] }] }) });
  try { await tick(); assert.equal(fixture.document.querySelectorAll('#content img').length, 0); const text = fixture.document.getElementById('content').textContent;
    assert.match(text, /Stale/); assert.match(text, /Turn stopped/); assert.match(text, /Codex subagent 1 · Working/); assert.match(text, /<img/);
  } finally { fixture.dom.window.close(); }
});
test('configured without delivery explains the supported hooks handoff instead of claiming activity', async () => {
  const fixture = setup({ state: async () => state({ activity: { configured: true, observed: false, latest_age_ms: null } }) });
  try { await tick(); assert.match(fixture.document.getElementById('activity-status').textContent, /Codex \/hooks/); assert.match(fixture.document.getElementById('content').textContent, /No local sessions/); }
  finally { fixture.dom.window.close(); }
});
test('hiding clears old activity, pauses polling and refuses an earlier pending reply', async () => {
  let resolveOld, count = 0;
  const fixture = setup({ state: () => { count++; return count === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(state({ sessions: [{ provider: 'Codex', project: 'fresh', status: 'Working', freshness: 'recent', age_ms: 0, children: [] }] })); } });
  try {
    fixture.hide(true); fixture.intervals[0](); assert.equal(count, 1);
    resolveOld(state({ sessions: [{ provider: 'Codex', project: 'old-private-view', status: 'Working', freshness: 'recent', children: [] }] })); await tick();
    assert.equal(fixture.document.getElementById('content').textContent, ''); fixture.hide(false); await tick();
    assert.match(fixture.document.getElementById('content').textContent, /fresh/); assert.doesNotMatch(fixture.document.body.textContent, /old-private-view/);
  } finally { fixture.dom.window.close(); }
});
test('out-of-order refresh cannot replace a newer result and a rejected refresh clears old sessions', async () => {
  const pending = [];
  const fixture = setup({ state: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const row = project => state({ sessions: [{ provider: 'Codex', project, status: 'Working', freshness: 'recent', children: [] }] });
  try {
    fixture.document.getElementById('refresh').click(); pending[1].resolve(row('new')); await tick(); pending[0].resolve(row('old')); await tick();
    assert.match(fixture.document.getElementById('content').textContent, /new/); assert.doesNotMatch(fixture.document.getElementById('content').textContent, /old/);
    fixture.intervals[0](); pending[2].reject(new Error('private failure')); await tick(); assert.equal(fixture.document.getElementById('content').textContent, '');
    assert.match(fixture.document.getElementById('status').textContent, /unavailable/); assert.doesNotMatch(fixture.document.body.textContent, /private failure/);
  } finally { fixture.dom.window.close(); }
});
test('settings refusal stays truthful and the settings button is restored', async () => {
  let opened = 0;
  const fixture = setup({ state: async () => state(), settings: async () => { opened++; return false; } });
  try { await tick(); fixture.document.getElementById('settings').click(); await tick(); assert.equal(opened, 1); assert.equal(fixture.document.getElementById('settings').disabled, false); assert.match(fixture.document.getElementById('status').textContent, /settings are unavailable/); }
  finally { fixture.dom.window.close(); }
});
