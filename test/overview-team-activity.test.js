'use strict';
const ORGANISE = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'work-organise.js'), 'utf8'); // views read their state words from it
// Renderer acceptance for the selected shared-session flow. Provider calls and
// tokens here are synthetic; the real main/client authority tests own routing.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const { createTeamHubClient } = require('../src/team-hub-client');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const token = '12000000-0000-4000-8000-000000000001', nextToken = '12000000-0000-4000-8000-000000000002';
const turn = '13000000-0000-4000-8000-000000000001';
const HOSTILE = '<img src=x onerror="globalThis.pwned=1">';
const cap = (available, reason = '') => ({ available, reason });
function entry(id = 'a'.repeat(40)) {
  return { id, kind: 'shared', owner: { name: 'Bob', self: false, initials: 'B' }, scope: 'team', teams: [{ key: 'b'.repeat(32), name: 'Team' }],
    board: { label: 'Board' }, provider: { id: 'codex', label: 'Codex' }, device: { label: 'Bob’s Mac', local: false },
    task: { title: 'Fix login', source: 'human' }, state: 'Working', input: false, freshness: 'recent', ageMs: 1000, observedAt: Date.now() - 1000,
    selfReported: null, provenance: ['shared'], capabilities: Object.fromEntries(['discovery', 'telemetry', 'taskReporting', 'receive', 'reply', 'resume', 'steer', 'interrupt', 'remoteControl'].map(k => [k, cap(true)])),
    interact: { kind: 'team', ref: 'opaque' }, children: [], deliveries: [] };
}
function inspection({ available = true, generation = 1, activeTurn = turn, selection = token, deliveries = [] } = {}) {
  return { ok: true, status: 'ready', selection, state: { provider: { id: 'codex', label: 'Codex' }, capabilities: { newTurn: available, steer: available, interrupt: available }, status: activeTurn ? 'working' : 'ready', generation, activeTurn,
    activity: { label: 'Editing files', phase: 'working', observed_at: Date.now() - 1000, turn }, deliveries },
    capabilities: { send: cap(available && !activeTurn, activeTurn ? 'A turn is running.' : ''), steer: cap(available && !!activeTurn, available ? '' : 'Shared to watch only.'), interrupt: cap(available && !!activeTurn, available ? '' : 'Shared to watch only.') } };
}
function harness({ inspect = inspection(), legacy = false } = {}) {
  let entries = [entry()], current = inspect, inspectCalls = 0, pending = null, actionResult = { ok: true, status: 'acknowledged', delivery: { state: 'acknowledged' } }, dirAt = Date.now();
  const actions = [], messages = [];
  const dom = new JSDOM(read('overview.html'), { runScripts: 'outside-only', pretendToBeVisual: true });
  const doc = dom.window.document, $ = id => doc.getElementById(id);
  dom.window.overviewApi = {
    directory: async req => ({ schema: 1, view: req.view, status: 'complete', observed_at: ++dirAt, notice: '', teams: [{ key: 'b'.repeat(32), name: 'Team', source: 'hub', label: 'Team hub' }, { key: 'c'.repeat(32), name: 'Other', source: 'hub', label: 'Team hub' }], team: req.view === 'team' ? { key: req.team ?? 'b'.repeat(32), name: 'Team' } : null, entries: req.view === 'team' ? entries : [] }),
    ...(!legacy ? { teamInspect: async () => { inspectCalls++; return pending ? pending : structuredClone(current); }, teamAction: async r => { actions.push(structuredClone(r)); return actionResult; } } : {}),
    teamMessage: async r => { messages.push(structuredClone(r)); return { ok: true, status: 'queued' }; },
  };
  dom.window.eval(ORGANISE);dom.window.eval(read('overview-directory.js'));
  dom.window.OverviewDirectory.start({ focusOwned() {}, composeWork() {} });
  const refresh = async () => { await dom.window.OverviewDirectory.refresh(); await tick(); };
  const button = label => [...doc.querySelectorAll('button')].find(b => b.textContent === label && !b.hidden);
  return { dom, doc, $, actions, messages, button, refresh,
    open: async () => { $('tab-team').click(); await tick(); button('Show activity').click(); await tick(); },
    setInspection: v => { current = v; }, setEntries: v => { entries = v; }, setPending: v => { pending = v; }, setAction: v => { actionResult = v; },
    calls: () => inspectCalls, close: () => dom.window.close() };
}

// Ledger 37: the grantee's own client (inspect → interactionDelivery; its cached row → deliveryOf) keeps who stopped a
// turn, bounded, and the conversation panel says so as text, for an interrupted delivery only.
async function granteeRead(deliveries) {
  const SHARE = '11111111-2222-4333-8444-555555555555', SESSION = '10000000-0000-4000-8000-000000000001', AT = 1_800_000_000_000;
  const st = { session: SESSION, generation: 4, activeTurn: null, status: 'ready', provider: { id: 'codex', label: 'Codex' }, capabilities: {}, deliveries: deliveries.map((d, i) => ({ id: `40000000-0000-4000-8000-00000000000${i + 1}`, text: 'hello', by: 'Me', mode: 'new-turn', turn: turn, response: '', notices: [], sentAt: AT - 1, ...d })) };
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', viewer: { id: 'alice', name: 'Alice' }, fetch: async (url) => {
    const body = url.endsWith('/shared') ? { shared: [{ id: SHARE, session: SESSION, scope: 'interact', expires_at: null, team: { id: 'team', name: 'Team' }, owner: { id: 'bob', name: 'Bob' }, online: true }] } : { result: { ok: true, state: st } };
    return { status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) };
  } }, { now: () => AT });
  const v = { id: 'alice', name: 'Alice' };
  const live = (await hub.inspect(v, 'team', SHARE)).state.deliveries;
  const listed = (await hub.sessions(v, 'team'))[0].deliveries;
  return { live, listed };
}
test('ledger 37: the conversation panel says "‹name› stopped this turn." from the real inspect DTO; the client\'s row keeps it, bounded', async () => {
  const { live, listed } = await granteeRead([
    { state: 'interrupted', stoppedBy: `Cara ${HOSTILE}` }, { state: 'completed', stoppedBy: 'Nobody' }, { state: 'interrupted', stoppedBy: 'Z'.repeat(300) }, { state: 'interrupted' }]);
  assert.deepEqual(listed.map((d) => d.stoppedBy), [`Cara ${HOSTILE}`, 'Nobody', 'Z'.repeat(80), null], 'deliveryOf keeps it, bounded; an older host: none');
  const s = harness({ inspect: inspection({ deliveries: live }) });
  try {
    await s.open();
    const items = [...s.doc.querySelector('.team-conversation').querySelectorAll('li.delivery')];
    const said = (li) => [...li.querySelectorAll('.reason')].map((n) => n.textContent).filter((t) => /stopped this turn/.test(t));
    assert.deepEqual(items.map(said), [[`Cara ${HOSTILE} stopped this turn.`], [], [`${'Z'.repeat(80)} stopped this turn.`], []]);
    assert.equal(s.doc.querySelector('img'), null, 'text only');
  } finally { s.close(); }
});

test('watch a selected teammate session: current activity, honest live receipts and response text', async () => {
  const s = harness({ inspect: inspection({ available: false, deliveries: [{ id: 'msg', text: `Question ${HOSTILE}`, by: 'Alice', state: 'queued', response: '' }] }) });
  try {
    await s.open();
    const panel = s.doc.querySelector('.team-activity'); assert.ok(panel);
    assert.match(panel.textContent, /Now: Editing files/);
    assert.match(panel.querySelector('.team-conversation').textContent, /agent has not acknowledged/);
    assert.equal(s.button('Steer current turn').disabled, true);
    assert.equal(panel.querySelector('textarea').disabled, true, 'watch shares cannot draft actions');
    assert.match(panel.textContent, /Shared to watch only/);
    assert.equal(s.doc.querySelector('img'), null);
    s.setInspection(inspection({ available: false, deliveries: [{ id: 'msg', text: `Question ${HOSTILE}`, by: 'Alice', state: 'responding', response: `Actual response ${HOSTILE}` }] }));
    await s.refresh();
    assert.match(panel.querySelector('.delivery-response').textContent, /Actual response <img/);
    assert.equal(s.doc.querySelector('img'), null);
    assert.equal(s.actions.length, 0);
    s.setInspection({ ok: false, status: 'unavailable' }); await s.refresh();
    assert.equal(panel.querySelector('textarea').disabled, true, 'a failed read cannot enable a watch-only draft');
  } finally { s.close(); }
});

test('steering requires exact reviewed target and text, with no automatic resend after uncertainty', async () => {
  const s = harness();
  try {
    await s.open();
    const input = s.doc.querySelector('.team-activity textarea'); input.value = '  Finish the login test first  ';
    s.button('Steer current turn').click();
    assert.equal(s.actions.length, 0, 'review does not dispatch');
    const preview = s.doc.querySelector('.team-action-review'); assert.equal(preview.hidden, false);
    assert.match(preview.textContent, /Bob's Codex session: Fix login/);
    assert.equal(preview.querySelector('.delivery-text').textContent, 'Finish the login test first');
    s.setAction({ ok: false, status: 'unconfirmed', error: 'No provider receipt yet.' });
    s.button('Steer this turn').click(); await tick();
    assert.deepEqual(s.actions, [{ selection: token, operation: 'steer', text: 'Finish the login test first' }]);
    assert.match(input.value, /Finish the login test first/);
    assert.match(s.doc.querySelector('.team-activity .composer').textContent, /Receipt unconfirmed.*do not resend automatically/);
    await s.refresh(); await s.refresh();
    assert.equal(s.actions.length, 1);
    s.setAction({ ok: true, status: 'acknowledged', delivery: { state: 'acknowledged' } });
    s.button('Steer current turn').click(); s.button('Steer this turn').click(); await tick();
    assert.equal(input.value, ''); assert.equal(s.actions.length, 2);
    assert.match(s.doc.querySelector('.team-activity .composer').textContent, /Provider result: acknowledged/);
  } finally { s.close(); }
});

test('a changed live turn invalidates review and keeps the draft, while interrupt carries no text', async () => {
  const s = harness();
  try {
    await s.open();
    const input = s.doc.querySelector('.team-activity textarea'); input.value = 'Keep this draft';
    s.button('Steer current turn').click();
    s.setInspection(inspection({ generation: 2, selection: nextToken, activeTurn: null })); await s.refresh();
    assert.equal(s.doc.querySelector('.team-action-review').hidden, true);
    assert.equal(input.value, 'Keep this draft');
    assert.match(s.doc.querySelector('.team-activity .composer').textContent, /session moved on/);
    assert.equal(s.actions.length, 0);
    s.button('Send a message').click(); s.button('Send message').click(); await tick();
    assert.deepEqual(s.actions[0], { selection: nextToken, operation: 'send', text: 'Keep this draft' });
    s.setInspection(inspection()); await s.refresh(); input.value = 'Never send this for interrupt';
    s.button('Interrupt current turn').click(); s.button('Interrupt this turn').click(); await tick();
    assert.deepEqual(s.actions[1], { selection: token, operation: 'interrupt', text: '' });
    assert.equal(input.value, 'Never send this for interrupt');
  } finally { s.close(); }
});

test('revocation and team selection erase selected private text, even with a late inspection', async () => {
  const s = harness({ inspect: inspection({ deliveries: [{ id: 'm', text: 'Private shared text', by: null, state: 'completed', response: 'Private response' }] }) });
  try {
    await s.open(); s.doc.querySelector('.team-activity textarea').value = 'Private draft';
    let resolve; s.setPending(new Promise(r => { resolve = r; }));
    await s.refresh();
    s.setEntries([]); await s.refresh(); resolve(inspection()); await tick();
    assert.equal(s.doc.querySelector('.team-activity'), null);
    assert.equal(s.doc.body.textContent.includes('Private response'), false);
    s.setPending(null); s.setEntries([entry()]); await s.refresh(); s.button('Show activity').click(); await tick();
    const input = s.doc.querySelector('.team-activity textarea'); input.value = 'Draft on team one';
    s.$('team-pick').value = 'c'.repeat(32); s.$('team-pick').dispatchEvent(new s.dom.window.Event('change'));
    assert.equal(input.value, '', 'detached input is cleared immediately');
    assert.equal(s.doc.querySelector('.team-activity'), null);
    await tick();
  } finally { s.close(); }
});

test('unsupported connections show directory reports and retain the existing task-inbox message route', async () => {
  const s = harness({ legacy: true });
  try {
    await s.open();
    assert.match(s.doc.querySelector('.team-activity').textContent, /Live conversation is unavailable/);
    assert.equal(s.doc.querySelector('.team-activity .composer').hidden, true);
    s.button('Message').click(); await tick();
    const composer = s.doc.querySelector('.dir-entry > .composer'); assert.ok(composer);
    composer.querySelector('textarea').value = 'Task inbox message'; composer.querySelector('button').click(); await tick();
    assert.deepEqual(s.messages, [{ id: 'a'.repeat(40), text: 'Task inbox message' }]);
  } finally { s.close(); }
});

test('normal directory rows show safe current activity and label old reports honestly', async () => {
  const s = harness();
  try {
    const row = entry(); row.activity = { label: 'Searching', phase: 'working', observedAt: Date.now() - 1000, freshness: 'recent', ageMs: 1000 };
    s.setEntries([row]); s.$('tab-team').click(); await tick();
    assert.match(s.doc.querySelector('.dir-activity').textContent, /Now: Searching · 1s ago/);
    row.activity.observedAt = Date.now() - 100_000; await s.refresh();
    assert.match(s.doc.querySelector('.dir-activity').textContent, /Last reported: Searching/);
    row.activity = { label: 'Raw command /private/project secret', phase: 'working', observedAt: Date.now() }; await s.refresh();
    assert.equal(s.doc.querySelector('.dir-activity').textContent, '', 'arbitrary activity text is never rendered');
    assert.equal(s.doc.body.textContent.includes('/private/project'), false);
  } finally { s.close(); }
});

test('Escape returns to a retained draft, then closes and clears the selected conversation', async () => {
  const s = harness();
  try {
    await s.open();
    assert.equal(s.doc.activeElement, s.doc.querySelector('.team-activity h4'));
    const panel = s.doc.querySelector('.team-activity'), input = panel.querySelector('textarea');
    input.value = 'Private keyboard draft'; s.button('Steer current turn').click();
    const preview = panel.querySelector('.team-action-review'), reviewedText = preview.querySelector('.delivery-text');
    assert.equal(s.doc.activeElement, s.button('Steer this turn'));
    s.doc.activeElement.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(preview.hidden, true); assert.equal(input.value, 'Private keyboard draft'); assert.equal(s.doc.activeElement, input);
    input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(s.doc.querySelector('.team-activity'), null); assert.equal(input.value, ''); assert.equal(reviewedText.textContent, '');
    assert.equal(s.doc.activeElement, s.button('Show activity')); assert.equal(s.button('Show activity').getAttribute('aria-expanded'), 'false');
  } finally { s.close(); }
});

test('temporary live inspection failure keeps the draft and cannot downgrade to legacy Send', async () => {
  const s = harness();
  try {
    await s.open();
    const input = s.doc.querySelector('.team-activity textarea'); input.value = 'Keep my exact draft';
    s.button('Steer current turn').click();
    s.setInspection({ ok: false, status: 'unavailable', error: 'The connection could not be read.' }); await s.refresh();
    assert.equal(s.doc.querySelector('.team-action-review').hidden, true);
    assert.equal(input.value, 'Keep my exact draft'); assert.equal(input.disabled, false);
    assert.equal(s.button('Steer current turn').disabled, true);
    s.button('Message').click(); await tick();
    assert.equal(s.doc.querySelector('.dir-entry > .composer'), null, 'no legacy composer on a live read failure');
    assert.equal(input.value, 'Keep my exact draft'); assert.equal(s.messages.length, 0);
    s.setInspection(inspection()); s.button('Check activity').click(); await tick();
    assert.equal(s.button('Steer current turn').disabled, false);
  } finally { s.close(); }
});

test('steer output is distinct from receipt and does not claim the correction was applied', async () => {
  const s = harness({ inspect: inspection({ deliveries: [{ id: 'steer-message', mode: 'steer', text: 'Use the new title', by: 'Alice', state: 'responding', recorded: true, response: 'Continuing the turn' }] }) });
  try {
    await s.open();
    const delivery = s.doc.querySelector('.team-conversation .delivery');
    assert.equal(delivery.querySelector('.tag').textContent, 'responding');
    assert.match(delivery.textContent, /Sent by Alice \(steer\)/);
    assert.match(delivery.textContent, /provider echoed this exact message text/);
    assert.match(delivery.textContent, /Turn output after this message\. This does not confirm the requested change was applied/);
    assert.equal(delivery.querySelector('.delivery-response').textContent, 'Continuing the turn');
    assert.equal(s.actions.length, 0);
  } finally { s.close(); }
});

test('a busy nonsteering provider permits a local draft and preserves it until Send becomes available', async () => {
  const busy = inspection();
  busy.state.provider = { id: 'claude', label: 'Claude Code' };
  busy.state.capabilities = { newTurn: true, steer: false, interrupt: false };
  busy.capabilities.steer = cap(false, 'This provider does not support steering a running turn.');
  busy.capabilities.interrupt = cap(false, 'This provider does not support interruption.');
  const s = harness({ inspect: busy });
  try {
    await s.open();
    const input = s.doc.querySelector('.team-activity textarea');
    assert.equal(input.disabled, false); assert.equal(s.button('Send a message').disabled, true);
    assert.match(s.doc.querySelector('.team-activity').textContent, /Keep a draft while this turn finishes.*drafts are not queued or sent automatically/);
    input.value = 'Next, verify the login test';
    await s.refresh(); assert.equal(input.value, 'Next, verify the login test'); assert.equal(s.actions.length, 0);
    const idle = inspection({ activeTurn: null, selection: nextToken });
    idle.state.provider = busy.state.provider; idle.state.capabilities = busy.state.capabilities;
    idle.capabilities.steer = busy.capabilities.steer; idle.capabilities.interrupt = busy.capabilities.interrupt;
    s.setInspection(idle); await s.refresh();
    assert.equal(input.value, 'Next, verify the login test'); assert.equal(s.button('Send a message').disabled, false);
    assert.equal(s.actions.length, 0, 'becoming idle never sends the draft');
    s.button('Send a message').click(); s.button('Send message').click(); await tick();
    assert.deepEqual(s.actions, [{ selection: nextToken, operation: 'send', text: 'Next, verify the login test' }]);
  } finally { s.close(); }
});


test('session management filters teammates and projects, exposes attention and explains no matches', async () => {
  const s = harness();
  try {
    const attention = entry(); attention.input = true; attention.board.label = 'Website';
    const stale = entry('d'.repeat(40)); stale.owner.name = 'Cara'; stale.task.title = 'Ship the release'; stale.board.label = 'Desktop'; stale.freshness = 'stale'; stale.ageMs = 120000;
    s.setEntries([attention, stale]); s.$('tab-team').click(); await tick();
    const rows = () => [...s.$('team-list').querySelectorAll('.dir-entry')];
    s.doc.querySelector('[data-team-focus="attention"]').click(); assert.equal(rows().length, 1); assert.match(rows()[0].textContent, /Fix login/);
    s.$('team-clear-filters').click(); s.$('team-project-filter').value = 'Desktop'; s.$('team-project-filter').dispatchEvent(new s.dom.window.Event('change')); assert.equal(rows().length, 1); assert.match(rows()[0].textContent, /Cara/);
    s.$('team-search').value = 'no matching task'; s.$('team-search').dispatchEvent(new s.dom.window.Event('input'));
    assert.equal(rows().length, 0); assert.equal(s.$('team-empty').hidden, false); assert.match(s.$('team-empty-title').textContent, /No sessions match/);
    s.$('team-empty-reset').click(); assert.equal(rows().length, 2); assert.equal(s.$('team-search').value, '');
    s.doc.querySelector('[data-team-focus="stale"]').click(); assert.equal(rows().length, 1); assert.match(rows()[0].textContent, /Ship the release/);
    assert.equal(s.actions.length, 0); assert.equal(s.calls(), 0, 'filtering never inspects or sends to a session');
  } finally { s.close(); }
});
