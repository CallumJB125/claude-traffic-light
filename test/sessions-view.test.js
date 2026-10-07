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

// WP3: What's in context, Files, Message and the shared-worktree banner.
const SID = '0f6e3c1a-2b4d-4e5f-8a9b-0c1d2e3f4a5b';
const PREVIEW = 'PREVIEW-CONVERSATION-TEXT';
const ctxRow = (extra = {}) => ({ provider: 'Claude Code', project: 'app', status: 'Working', freshness: 'recent', age_ms: 1000, children: [], session: SID, context: { engine: 'claude' }, ...extra });
const inspected = () => ({ session: SID, engine: 'claude', totalTokens: 30000, reportedTokens: 30000, estimate: false, groups: [
  { group: 'Tool results', tokens: 30000, more: 0, items: [{ id: 'a1b2c3d4e5f60718', name: 'Read src/a.js', turn: 2, tokens: 20000, flags: ['large and 1 prompts old'], removable: true, removed: false, preview: PREVIEW },
    { id: '0123456789abcdef', name: 'Read src/b.js', turn: 1, tokens: 10000, flags: [], removable: true, removed: true }] }] });
const plain = v => JSON.parse(JSON.stringify(v));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

test('What\'s in context from Burst: names and sizes, never a preview; each action is one burst-action call, cancel says nothing changed', async () => {
  const calls = [];
  let answer = { ok: false, cancelled: true };
  const fixture = setup({ state: async () => state({ sessions: [ctxRow({ burst: { compaction: { compactions: 2, savedUsd: 1, netUsd: 1, savedTokens: 9 } } })] }),
    burstView: async (name, args) => { calls.push(['view', name, args]); return { view: inspected() }; },
    contextBreakdown: async () => { calls.push(['breakdown']); return { view: null }; },
    burstAction: async (id, args) => { calls.push(['action', id, args]); return answer; } });
  try {
    await tick(); click(fixture, byText(fixture, 'What’s in context')); await settle();
    const c = fixture.document.getElementById('content');
    assert.match(c.textContent, /From Burst: 30k tokens/);
    assert.match(c.textContent, /Read src\/a\.js · 20k · prompt 2/);
    assert.match(c.textContent, /large and 1 prompts old/);
    assert.ok(!fixture.document.body.innerHTML.includes(PREVIEW), 'a preview never reaches the page');
    assert.deepEqual(plain(calls[0]), ['view', 'inspect', { session: SID, engine: 'claude' }]);
    assert.equal(calls.filter(x => x[0] === 'breakdown').length, 0);

    click(fixture, byText(fixture, 'Leave out')); await settle();
    assert.deepEqual(plain(calls.filter(x => x[0] === 'action')), [['action', 'inspect-remove', { session: SID, id: 'a1b2c3d4e5f60718', engine: 'claude' }]]);
    assert.match(c.textContent, /Cancelled\. Nothing was changed\./);
    assert.equal(calls.filter(x => x[0] === 'view').length, 1, 'a cancelled action does not reload');

    answer = { ok: true, data: null };
    click(fixture, byText(fixture, 'Put back')); await settle();
    assert.deepEqual(plain(calls.filter(x => x[0] === 'action').at(-1)), ['action', 'inspect-remove', { session: SID, id: '0123456789abcdef', engine: 'claude', restore: true }]);
    assert.equal(calls.filter(x => x[0] === 'view').length, 2, 'a confirmed action reloads the drawer');

    click(fixture, byText(fixture, 'Send full history again')); await settle();
    assert.deepEqual(plain(calls.filter(x => x[0] === 'action').at(-1)), ['action', 'compaction-drop', { session: SID }]);
    assert.equal(calls.filter(x => x[0] === 'action').length, 3);
    fixture.intervals[0](); await tick(); assert.ok(c.querySelector('.row-panel.context'), 'refresh keeps the drawer open');
  } finally { fixture.dom.window.close(); }
});

test('without Burst a Claude Code session falls back to its transcript breakdown, with no actions', async () => {
  const fixture = setup({ state: async () => state({ sessions: [ctxRow()] }),
    burstView: async () => ({ view: null, error: 'Burst is not answering.' }),
    contextBreakdown: async (s) => (s === SID ? { view: { total: { bytes: 8000, tokens: 12000 }, reportedInputTokens: 12000, estimate: false, groups: [{ group: 'Tool results', bytes: 8000, tokens: 2000 }, { group: 'System prompt, tools and instruction files', bytes: 0, tokens: 10000 }] } } : { view: null }),
    burstAction: async () => { throw new Error('no actions here'); } });
  try {
    await tick(); click(fixture, byText(fixture, 'What’s in context')); await settle();
    const t = fixture.document.getElementById('content').textContent;
    assert.match(t, /Estimated from this session’s transcript on this computer: 12k tokens/);
    assert.match(t, /Tool results · 2k tokens/);
    assert.ok(!byText(fixture, 'Leave out') && !byText(fixture, 'Send full history again'));
  } finally { fixture.dom.window.close(); }
});

test('Files: master and shared files; Hand on is one coord-release call; Message routes owned sessions locally and others to Burst', async () => {
  const calls = [];
  const coordination = { masterOf: ['/r/a.js'], more: 0, shared: 1, files: [{ path: '/r/a.js', master: true, others: ['Docs'] }, { path: '/r/c.js', master: false, masterName: 'Fix login' }] };
  const fixture = setup({ state: async () => state({ sessions: [ctxRow({ context: null, message: 'burst', burst: { coordination } }), ctxRow({ project: 'mine', context: null, session: 'owned-1', message: 'owned' })] }),
    burstView: async () => ({ view: null }),
    burstAction: async (id, args) => { calls.push([id, args]); return { ok: true }; },
    messageOwned: async (s, t) => { calls.push(['owned', s, t]); return { ok: true }; } });
  try {
    await tick(); const d = fixture.document, c = d.getElementById('content');
    assert.match(c.textContent, /\/r\/a\.jsMaster · also changed by Docs/);
    assert.match(c.textContent, /\/r\/c\.jsShared · Fix login is master/);
    assert.equal(d.getElementById('coord').hidden, false);
    click(fixture, byText(fixture, 'Hand on')); await settle();
    assert.deepEqual(plain(calls), [['coord-release', { release: '/r/a.js' }]]);

    const [burstSection, ownedSection] = c.querySelectorAll('section.session');
    click(fixture, [...burstSection.querySelectorAll('button')].find(b => b.textContent === 'Message')); await tick();
    burstSection.querySelector('textarea').value = '  please commit  ';
    click(fixture, [...burstSection.querySelectorAll('button')].find(b => b.textContent === 'Send')); await settle();
    assert.deepEqual(plain(calls.at(-1)), ['coord-message', { session: SID, message: 'please commit' }]);

    click(fixture, [...ownedSection.querySelectorAll('button')].find(b => b.textContent === 'Message')); await tick();
    ownedSection.querySelector('textarea').value = 'hello';
    click(fixture, [...ownedSection.querySelectorAll('button')].find(b => b.textContent === 'Send')); await settle();
    assert.deepEqual(plain(calls.at(-1)), ['owned', 'owned-1', 'hello']);
    assert.equal(calls.length, 3);
  } finally { fixture.dom.window.close(); }
});

test('coordination tile reads the chosen window and lists unresolved issues', async () => {
  const asked = [];
  const fixture = setup({ state: async () => state({ sessions: [ctxRow({ context: null, burst: { coordination: { masterOf: [], more: 0, shared: 0, files: [] } } })] }),
    burstView: async (name, args) => { asked.push([name, args]); return { view: { sessions: [], files: [], metrics: { days: args.days, totals: { shared: 3, refused: 1, held: 0, stopped: 1, errors: 0 }, unresolved: 1, issues: [{ at: '2026-10-07 09:00:00', kind: 'stopped', text: 'x', pending: ['/r/c.js'], files: [], resolved: false }] } } }; } });
  try {
    await tick(); const d = fixture.document, tile = d.getElementById('coord');
    assert.equal(tile.hidden, false);
    d.getElementById('coord-days').value = '7'; d.getElementById('coord-days').dispatchEvent(new fixture.dom.window.Event('change')); await settle();
    assert.deepEqual(plain(asked), [['coordination', { days: 7 }]]);
    assert.match(d.getElementById('coord-body').textContent, /3 shared · 1 refused/);
    assert.match(d.getElementById('coord-body').textContent, /Stopped with uncommitted files: \/r\/c\.js/);
  } finally { fixture.dom.window.close(); }
});

test('shared working tree banner and row note', async () => {
  const fixture = setup({ state: async () => state({ shared: [{ project: 'app', sessions: 2, dirty: 3 }], sessions: [ctxRow({ context: null, session: undefined, sharedTree: 'app' })] }) });
  try {
    await tick(); const t = fixture.document.getElementById('content').textContent;
    assert.match(t, /2 sessions share this working tree: app, with 3 uncommitted files\./);
    assert.match(t, /Shares its working tree with another live session \(app\)/);
    assert.equal(fixture.document.getElementById('coord').hidden, true);
  } finally { fixture.dom.window.close(); }
});
