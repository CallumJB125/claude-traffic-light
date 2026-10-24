'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../sessions.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../sessions.js'), 'utf8');
const menuScript = fs.readFileSync(path.join(__dirname, '../continue-menu.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = overrides => ({ status: 'complete', observed_at: Date.now(), omitted: 0, activity: { configured: true, observed: true, latest_age_ms: 1000 }, sessions: [], ...overrides });
function setup(api) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  let hidden = false; const intervals = [], timeouts = [];
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  dom.window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  dom.window.setTimeout = callback => { timeouts.push(callback); return timeouts.length; };
  dom.window.clearTimeout = () => {};
  dom.window.sessionsApi = { onContinue() {}, ...api }; dom.window.eval(menuScript); dom.window.eval(script);
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
test('unconfigured and unreadable Codex activity point at the AI tools page, never a missing settings pane', async () => {
  for (const configured of [false, undefined]) {
    const fixture = setup({ state: async () => state({ activity: { configured } }) });
    try { await tick(); const t = fixture.document.getElementById('activity-status').textContent; assert.match(t, /AI tools page/); assert.doesNotMatch(t, /Activity settings/); }
    finally { fixture.dom.window.close(); }
  }
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
test('the Codex button opens AI tools; a refusal stays truthful and the button is restored', async () => {
  let opened = 0;
  const fixture = setup({ state: async () => state(), aiTools: async () => { opened++; return false; } });
  try { await tick(); const b = fixture.document.getElementById('codex-aitools'); assert.equal(b.textContent, 'Open Codex in AI tools'); b.click(); await tick(); assert.equal(opened, 1); assert.equal(b.disabled, false); assert.match(fixture.document.getElementById('status').textContent, /AI tools page could not be opened/); }
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

test('handover row shows its status and Write now asks main for that session only', async () => {
  const calls = [];
  const row = (handover) => ({ provider: 'Codex', project: 'app', status: 'Turn stopped', freshness: 'stale', age_ms: 100000, children: [], handover });
  const fixture = setup({ state: async () => state({ sessions: [row({ key: 'codex-t1', updated: 'Handover: not written yet', note: 'written at the next refresh', ready: false, canWrite: true }), row({ key: 'codex-t2', updated: 'Handover: not written yet', note: 'session excluded', ready: false, canWrite: false })] }), handover: async (action, key) => { calls.push([action, key]); return { ok: true }; } });
  try {
    await tick();
    const rows = fixture.document.querySelectorAll('.handover-row');
    assert.match(rows[0].textContent, /Handover: not written yet \(written at the next refresh\)/);
    const buttons = [...fixture.document.querySelectorAll('.handover-row button')].filter(b => b.textContent === 'Write now');
    assert.equal(buttons.length, 1, 'no Write now for an excluded session');
    buttons[0].click(); await tick();
    assert.deepEqual(calls, [['write', 'codex-t1']]);
    assert.equal(buttons[0].textContent, 'Written');
  } finally { fixture.dom.window.close(); }
});
test('a row with a ready handover offers Continue in…: the menu lists what main found, and a pick sends only the key and tool id', async () => {
  const calls = [];
  const fixture = setup({
    state: async () => state({ sessions: [{ provider: 'Codex', project: 'p', status: 'Working', freshness: 'recent', age_ms: 1000, handover: { key: 'codex-abc', updated: 'Handover: updated just now', ready: true, canWrite: true } }] }),
    continueMenu: async () => ({ ok: true, choices: [{ id: 'gemini', label: 'Gemini CLI', mode: 'copy' }, { id: 'copy', label: 'Copy as prompt', mode: 'copy' }] }),
    continueIn: async (key, to) => { calls.push([key, to]); return { ok: true, mode: 'copied', note: 'Copied as a prompt. Paste it into Gemini CLI.' }; },
  });
  try {
    await tick();
    const trigger = [...fixture.document.querySelectorAll('#content button')].find(b => b.textContent === 'Continue in…');
    assert.ok(trigger); assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
    trigger.click(); await tick(); await tick();
    const items = [...fixture.document.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(items.map(i => i.querySelector('.continue-label').textContent), ['Gemini CLI', 'Copy as prompt', 'Hand off to another AI…']);
    items[0].click(); await tick(); await tick();
    assert.deepEqual(calls, [['codex-abc', 'gemini']]);
    assert.match(fixture.document.getElementById('content').textContent, /Paste it into Gemini CLI/);
    assert.equal(fixture.document.querySelectorAll('[role="menu"]').length, 0);
  } finally { fixture.dom.window.close(); }
});
test('Hand off to another AI… stays open and lists the tools, and a pick sends the key and tool id to the hand-off', async () => {
  const calls = [];
  const fixture = setup({
    state: async () => state({ sessions: [{ provider: 'Codex', project: 'p', status: 'Working', freshness: 'recent', age_ms: 1000, handover: { key: 'codex-abc', updated: 'Handover: updated just now', ready: true, canWrite: true } }] }),
    continueMenu: async () => ({ ok: true, choices: [{ id: 'gemini', label: 'Gemini CLI', mode: 'copy' }, { id: 'copy', label: 'Copy as prompt', mode: 'copy' }] }),
    continueIn: async () => { throw new Error('not a hand-off'); },
    continueHandoff: async (key, to) => { calls.push([key, to]); return { ok: false, cancelled: true }; },
  });
  try {
    await tick();
    [...fixture.document.querySelectorAll('#content button')].find(b => b.textContent === 'Continue in…').click(); await tick(); await tick();
    const more = [...fixture.document.querySelectorAll('[role="menuitem"]')].find(i => i.textContent.startsWith('Hand off'));
    more.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true })); await tick();
    const items = [...fixture.document.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(items.map(i => i.querySelector('.continue-label').textContent), ['Gemini CLI']);
    items[0].dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true })); await tick(); await tick();
    assert.deepEqual(calls, [['codex-abc', 'gemini']]);
    assert.match(fixture.document.getElementById('content').textContent, /Cancelled\. Nothing was shared\./);
    assert.equal(fixture.document.querySelectorAll('[role="menu"]').length, 0);
  } finally { fixture.dom.window.close(); }
});

test('a newer exact-session selection event takes precedence over a late initial selection query', async () => {
  let receiveSelection, resolveInitial;
  const rows = ['first', 'second'].map(id => withActions({ project: id,
    handover: { key: `codex-${id}`, updated: 'Handover: not written yet', note: 'Synthetic recorded session', ready: false, canWrite: false } }));
  const fixture = setup({ state: async () => state({ sessions: rows }),
    onSelection: callback => { receiveSelection = callback; },
    selection: () => new Promise(resolve => { resolveInitial = resolve; }) });
  try {
    await tick(); receiveSelection('codex-second'); await tick();
    const selected = () => fixture.document.querySelector('#content .session[aria-current="true"]');
    assert.equal(selected()?.dataset.sessionKey, 'codex-second');
    assert.equal(fixture.document.activeElement, selected());
    resolveInitial('codex-first'); await tick();
    assert.equal(selected()?.dataset.sessionKey, 'codex-second', 'a stale startup reply must not redirect the selected session');
    assert.equal(fixture.document.querySelectorAll('#content .session[aria-current="true"]').length, 1);
    assert.equal(fixture.document.activeElement, selected());
  } finally { fixture.dom.window.close(); }
});

test('an exact-session selection focuses the requested existing row without discarding another row editor', async () => {
  let receiveSelection;
  const rows = ['first', 'second'].map(id => withActions({ project: id, actions: { handle: id },
    handover: { key: `codex-${id}`, updated: 'Handover: not written yet', note: 'Synthetic recorded session', ready: false, canWrite: false } }));
  const fixture = setup({ state: async () => state({ sessions: rows }), setup: async () => SETUP,
    onSelection: callback => { receiveSelection = callback; }, selection: async () => 'codex-first' });
  try {
    await tick();
    const first = fixture.document.querySelector('[data-session-key="codex-first"]');
    [...first.querySelectorAll('button')].find(button => button.textContent === 'Make a card').click(); await tick();
    const editor = first.querySelector('.row-panel'), chosenBoard = editor.querySelector('select');
    assert.ok(editor); chosenBoard.value = 'b1';
    receiveSelection('codex-second'); await tick();
    const selected = fixture.document.querySelector('#content .session[aria-current="true"]');
    assert.equal(selected?.dataset.sessionKey, 'codex-second');
    assert.equal(fixture.document.activeElement, selected);
    assert.equal(fixture.document.querySelectorAll('#content .session[aria-current="true"]').length, 1);
    assert.equal(first.hasAttribute('aria-current'), false);
    assert.equal(first.querySelector('.row-panel'), editor, 'preserve the open editor and its current selection');
    assert.equal(editor.querySelector('select').value, 'b1');
  } finally { fixture.dom.window.close(); }
});


test('session management filters local reports and the start shortcut only prepares its form', async () => {
  let starts = 0;
  const f = setup({ state: async () => state({ sessions: [withActions(), withActions({provider:'Claude Code',project:'website',freshness:'stale',actions:null})] }), setup: async () => SETUP, start: async () => { starts++; return {ok:true}; } });
  try {
    await tick(); const d=f.document, shown=()=>[...d.querySelectorAll('#content .session')].filter(x=>!x.hidden);
    d.getElementById('session-provider').value='Claude Code'; d.getElementById('session-provider').dispatchEvent(new f.dom.window.Event('change')); assert.equal(shown().length,1); assert.match(shown()[0].textContent,/website/);
    d.getElementById('session-search').value='nothing'; d.getElementById('session-search').dispatchEvent(new f.dom.window.Event('input')); assert.equal(shown().length,0); assert.equal(d.getElementById('session-filter-empty').hidden,false);
    d.getElementById('session-empty-reset').click(); assert.equal(shown().length,2);
    d.getElementById('start-session-shortcut').click(); await tick(); await tick(); assert.equal(d.getElementById('panel-start').hidden,false); assert.ok(d.querySelector('#panel-start textarea')); assert.equal(starts,0);
  } finally { f.dom.window.close(); }
});
test('PR 7 routing strip: hidden with no rows; a question\'s buttons save the pick and reload; Change and Link reveal a picker', async () => {
  const empty = setup({ state: async () => state(), routing: async () => ({ rows: [] }) });
  try { await tick(); assert.equal(empty.document.getElementById('routing').hidden, true); } finally { empty.dom.window.close(); }
  const older = setup({ state: async () => state() });
  try { await tick(); assert.equal(older.document.getElementById('routing').hidden, true, 'a preload without routing shows nothing'); } finally { older.dom.window.close(); }

  const calls = [];
  let rows = [
    { repo: 'github.com/org/app', short: 'app', state: 'ask', text: 'app is linked to A / Core and A / Web. Where should its new work go?', note: null, choices: [{ key: 'k1', label: 'Core' }, { key: 'local', label: 'Keep on My board' }], change: [{ key: 'k1', label: 'A / Core', current: false }, { key: 'local', label: 'My board (private)', current: true }], link: null, ask: null },
    { repo: 'github.com/org/site', short: 'site', state: 'single', text: 'site → A / Core <img src=x onerror=alert(1)>', note: 'Its only team board, so new work goes there.', choices: null, change: [{ key: 'k2', label: 'A / Core', current: true }, { key: 'local', label: 'My board (private)', current: false }], link: null, ask: null },
    { repo: 'github.com/org/new', short: 'new', state: 'unlinked', text: 'new → My board (private)', note: 'Put it on a team board?', choices: [{ key: 'local', label: 'Keep on My board' }], change: [], link: [{ key: 'b1', label: 'A / Core' }], ask: null },
  ];
  const fixture = setup({ state: async () => state(), routing: async () => { calls.push(['routing']); return { rows }; },
    routeChoose: async (repo, key) => { calls.push(['choose', repo, key]); return { ok: true }; }, routeLink: async (repo, board) => { calls.push(['link', repo, board]); return { ok: false, text: 'Only a team owner or admin can link a repository.' }; } });
  try {
    await tick(); await tick();
    const box = fixture.document.getElementById('routing');
    assert.equal(box.hidden, false);
    const items = [...box.querySelectorAll('.routing-row')];
    assert.equal(items.length, 3);
    assert.match(items[0].textContent, /Where should its new work go\?/);
    assert.equal(box.querySelectorAll('img').length, 0, 'text only');
    // The question: one button per board plus Keep on My board.
    const keep = [...items[0].querySelectorAll('button')].find(b => b.textContent === 'Keep on My board');
    rows = [{ ...rows[0], state: 'set', text: 'app → My board (private)', choices: null }];
    keep.click(); await tick(); await tick();
    assert.deepEqual(calls.filter(c => c[0] === 'choose'), [['choose', 'github.com/org/app', 'local']]);
    assert.equal(calls.filter(c => c[0] === 'routing').length, 2, 'reloads after a save');
    assert.equal(box.querySelectorAll('.routing-row').length, 1);
    // A set row: Change reveals the picker with the current board selected.
    const row = box.querySelector('.routing-row'), pick = row.querySelector('.routing-pick');
    assert.equal(pick.hidden, true);
    [...row.querySelectorAll('button')].find(b => b.textContent === 'Change').click();
    assert.equal(pick.hidden, false); assert.equal(pick.querySelector('select').value, 'local');
  } finally { fixture.dom.window.close(); }

  // Link on an unlinked row: the picker shows at once; a refusal is said, not hidden.
  const linkCalls = [];
  const linking = setup({ state: async () => state(), routing: async () => ({ rows: [rows[0] && { repo: 'github.com/org/new', short: 'new', state: 'unlinked', text: 'new → My board (private)', note: 'Put it on a team board?', choices: [{ key: 'local', label: 'Keep on My board' }], change: [], link: [{ key: 'b1', label: 'A / Core' }], ask: null }] }),
    routeLink: async (repo, board) => { linkCalls.push([repo, board]); return { ok: false, text: 'Only a team owner or admin can link a repository.' }; } });
  try {
    await tick(); await tick();
    const row = linking.document.querySelector('.routing-row');
    assert.equal(row.querySelector('.routing-pick').hidden, false);
    [...row.querySelectorAll('button')].find(b => b.textContent === 'Link').click(); await tick(); await tick();
    assert.deepEqual(linkCalls, [['github.com/org/new', 'b1']]);
    assert.match(linking.document.getElementById('routing-status').textContent, /Only a team owner or admin/);
  } finally { linking.dom.window.close(); }
});
test('PR 7 routing strip: Ask an admin sends the chosen team and says what happened', async () => {
  const calls = [];
  const fixture = setup({ state: async () => state(), routing: async () => ({ rows: [{ repo: 'github.com/org/new', short: 'new', state: 'unlinked', text: 'new → My board (private)', note: 'Put it on a team board? Only a team admin can link it, so Plexiform can ask them for you.', choices: [{ key: 'local', label: 'Keep on My board' }], change: [], link: null, ask: [{ key: 't1', label: 'Acme' }, { key: 't2', label: 'Beta' }] }] }),
    routeAsk: async (repo, team) => { calls.push([repo, team]); return { ok: true, text: 'Asked Beta’s admins to put new on a team board.' }; } });
  try {
    await tick(); await tick();
    const row = fixture.document.querySelector('.routing-row');
    row.querySelector('.routing-ask select').value = 't2';
    [...row.querySelectorAll('button')].find(b => b.textContent === 'Ask an admin').click(); await tick(); await tick();
    assert.deepEqual(calls, [['github.com/org/new', 't2']]);
    assert.match(fixture.document.getElementById('routing-status').textContent, /Asked Beta’s admins/);
  } finally { fixture.dom.window.close(); }
});
