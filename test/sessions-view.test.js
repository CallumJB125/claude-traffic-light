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
  let hidden = false; const intervals = [], timeouts = [];
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  dom.window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  dom.window.setTimeout = callback => { timeouts.push(callback); return timeouts.length; };
  dom.window.clearTimeout = () => {};
  dom.window.sessionsApi = api; dom.window.eval(script);
  return { dom, document: dom.window.document, intervals, timeouts, hide(value) { hidden = value; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); } };
}
test('DOM renders only text metadata, with explicit stale and child reported state', async () => {
  const fixture = setup({ state: async () => state({ sessions: [{ provider: 'Codex', project: '<img src=x onerror=alert(1)>', status: 'Turn stopped', freshness: 'stale', age_ms: 100000, lifecycle: true, children: [{ label: 'Codex subagent 1', status: 'Working' }] }] }) });
  try { await tick(); assert.equal(fixture.document.querySelectorAll('#content img').length, 0); const text = fixture.document.getElementById('content').textContent;
    assert.match(text, /Stale/); assert.match(text, /Turn stopped/); assert.match(text, /Codex subagent 1 · Last reported: Working/); assert.match(text, /<img/);
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

test('a hung refresh expires old Working rows and a late reply cannot restore them', async () => {
  let calls = 0, resolveLate;
  const fixture = setup({ state: () => ++calls === 1 ? Promise.resolve(state({ sessions: [{ provider: 'Claude Code', project: 'old-working', status: 'Working', freshness: 'recent', age_ms: 0, children: [] }] })) : new Promise(resolve => { resolveLate = resolve; }) });
  try {
    await tick(); assert.match(fixture.document.getElementById('content').textContent, /Reported: Working/);
    fixture.intervals[0](); fixture.timeouts.at(-1)(); await tick();
    assert.equal(fixture.document.getElementById('content').textContent, '');
    assert.match(fixture.document.getElementById('status').textContent, /unavailable/);
    resolveLate(state({ sessions: [{ provider: 'Claude Code', project: 'late', status: 'Working', freshness: 'recent', children: [] }] })); await tick();
    assert.equal(fixture.document.getElementById('content').textContent, '');
  } finally { fixture.dom.window.close(); }
});
const withActions = (extra = {}) => ({ provider: 'Codex', project: 'app', status: 'Working', freshness: 'recent', age_ms: 1000, children: [], actions: { handle: 'h1', card: null, share: { on: false } }, ...extra });
const SETUP = { boards: [{ key: 'b1', label: 'My board (stays on this computer)', kind: 'local' }], repos: [{ handle: 'f1', label: 'app', remote: 'github.com/o/app' }], ais: [{ id: 'claude', label: 'Claude', ready: true, note: '' }], scopeRule: 'RULE SENTENCE', sessionCount: 1 };
const click = (fixture, el) => el.dispatchEvent(new fixture.dom.window.Event('click', { bubbles: true }));
const byText = (fixture, text) => [...fixture.document.querySelectorAll('button')].find(b => b.textContent === text);

test('empty state explains how sessions get in with the three actions; the Add panel is open, and folds once sessions exist', async () => {
  const empty = setup({ state: async () => state() });
  try { await tick(); const c = empty.document.getElementById('content').textContent;
    assert.match(c, /Connect the tool → sessions appear here and on your widget → link the repo to share with your team → make a card to track it\./);
    assert.equal(empty.document.getElementById('add').open, true);
    assert.ok(byText(empty, 'Connect a tool') && byText(empty, 'Link a repo to a board') && byText(empty, 'Start a session here'));
  } finally { empty.dom.window.close(); }
  const full = setup({ state: async () => state({ sessions: [withActions()] }) });
  try { await tick(); assert.equal(full.document.getElementById('add').open, false); assert.doesNotMatch(full.document.getElementById('content').textContent, /How sessions get in/); } finally { full.dom.window.close(); }
});
test('Add panel: connect opens the AI tools page; link shows the sharing rule and links the chosen repo and board; start passes AI and prompt', async () => {
  const calls = [];
  const fixture = setup({ state: async () => state(), setup: async () => SETUP, connect: async () => { calls.push(['connect']); return { ok: true }; },
    linkRepo: async (f, b) => { calls.push(['link', f, b]); return { ok: true, text: 'Linked github.com/o/app. RULE SENTENCE' }; }, start: async (f, ai, p) => { calls.push(['start', f, ai, p]); return { ok: true, text: 'Started' }; } });
  try {
    await tick(); const d = fixture.document;
    click(fixture, d.getElementById('add-connect')); await tick(); assert.deepEqual(calls[0], ['connect']);
    click(fixture, d.getElementById('add-link')); await tick(); await tick();
    assert.match(d.getElementById('panel-link').textContent, /RULE SENTENCE/);
    click(fixture, [...d.querySelectorAll('#panel-link button')].find(b => b.textContent === 'Link repo')); await tick();
    assert.deepEqual(calls[1], ['link', 'f1', 'b1']); assert.match(d.getElementById('panel-link').textContent, /Linked github.com\/o\/app/);
    click(fixture, d.getElementById('add-start')); await tick(); await tick();
    d.querySelector('#panel-start textarea').value = 'fix it';
    click(fixture, [...d.querySelectorAll('#panel-start button')].find(b => b.textContent === 'Start')); await tick();
    assert.deepEqual(calls[2], ['start', 'f1', 'claude', 'fix it']);
  } finally { fixture.dom.window.close(); }
});
test('session rows offer Make a card, Attach to card and Link repo; an open panel survives the 5 second refresh', async () => {
  const calls = [];
  const fixture = setup({ state: async () => state({ sessions: [withActions({ actions: { handle: 'h1', card: { label: 'APP-1 Fix it', how: 'attached' }, share: { on: false } } })] }), setup: async () => SETUP,
    makeCard: async (h, b) => { calls.push(['card', h, b]); return { ok: true, text: 'Card made from this session.' }; },
    searchCards: async () => [{ ref: 'r1', card_key: 'APP-2', title: 'Other', board: 'My board' }], attach: async (h, r) => { calls.push(['attach', h, r]); return { ok: true, text: 'Attached' }; },
    linkFromSession: async () => ({ folder: 'f1', label: 'app' }), share: async (h, on) => { calls.push(['share', h, on]); return { ok: true }; } });
  try {
    await tick(); const d = fixture.document, c = d.getElementById('content');
    assert.match(c.textContent, /Attached to APP-1 Fix it \(saved on this computer only\)/);
    assert.ok(byText(fixture, 'Make a card') && byText(fixture, 'Attach to card…') && byText(fixture, 'Link repo to board'));
    click(fixture, byText(fixture, 'Make a card')); await tick(); await tick();
    fixture.intervals[0](); await tick(); assert.ok(c.querySelector('.row-panel'), 'refresh does not wipe an open panel');
    click(fixture, byText(fixture, 'Make card')); await tick(); assert.deepEqual(calls[0], ['card', 'h1', 'b1']);
    click(fixture, byText(fixture, 'Attach to card…')); await tick(); await tick();
    click(fixture, byText(fixture, 'Search')); await tick(); await tick();
    click(fixture, byText(fixture, 'APP-2 Other (My board)')); await tick(); assert.deepEqual(calls[1], ['attach', 'h1', 'r1']);
    const box = c.querySelector('.row-actions input[type=checkbox]'); box.checked = true; box.dispatchEvent(new fixture.dom.window.Event('change')); await tick(); assert.deepEqual(calls[2], ['share', 'h1', true]);
    click(fixture, byText(fixture, 'Link repo to board')); await tick(); await tick(); await tick(); assert.match(c.textContent, /RULE SENTENCE/);
  } finally { fixture.dom.window.close(); }
});
