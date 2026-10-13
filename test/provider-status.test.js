
'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const Provider = require('../src/provider-status'); const Help = require('../help'); const Rules = require('../rules');
const now = Date.parse('2026-10-02T08:00:00Z');
const row = (source, extra = {}) => ({ source, signal: 'tool-use', updatedAt: new Date(now - 1000).toISOString(), sessionId: 'private-id', cwd: '/private/path', tool: 'private tool', prompt: 'private chat', ...extra });
const snap = sessions => Provider.snapshot({ sessions, now });
test('multi-provider reporting is named from closed labels and outputs no raw local session fields', () => {
  const result = snap([row('codex'), row('claude-code'), row('cursor'), row('gemini'), row('provider private name')]);
  assert.deepEqual(result.providers.map(p => p.provider), ['Claude', 'Codex', 'Cursor', 'Gemini', 'Local AI']);
  assert.ok(result.providers.every(p => p.state === 'working' && p.recent === 1));
  for (const secret of ['private-id', '/private/path', 'private tool', 'private chat', 'provider private name']) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.match(result.detail, /not a check that work succeeded/);
});
test('stale missing future and invalid report timestamps never count as current work', () => {
  const result = snap([row('codex', { updatedAt: new Date(now - 90001).toISOString() }), row('cursor', { updatedAt: undefined }), row('gemini', { updatedAt: 'bad' }), row('claude', { updatedAt: new Date(now + 1).toISOString() })]);
  assert.equal(result.providers.find(p => p.provider === 'Codex').state, 'stale');
  assert.ok(result.providers.every(p => p.state !== 'working' && p.recent === 0));
  assert.equal(snap([row('codex', { updatedAt: new Date(now - 90000).toISOString() })]).providers[0].state, 'working');
});
test('remote and device-backed sources are excluded from local provider claims', () => {
  for (const marker of [{ remote: true }, { device: 'private remote' }, { sessionId: 'remote:x' }]) assert.equal(snap([row('codex', marker)]).providers.length, 0);
  assert.equal(snap([]).headline, 'No local AI activity reported');
});
test('actual lifecycle parent report controls children and closed turn attribution', () => {
  const closed = row('codex', { codexLifecycle: 1, codexHookAt: new Date(now - 1000).toISOString(), codexClosedTurn: true, codexAgents: [{ status: 'working' }] });
  assert.equal(snap([closed]).providers[0].state, 'turn stopped');
  assert.equal(snap([closed]).providers[0].working_agents, 0, 'closed parent cannot claim current child work');
  assert.equal(snap([{ ...closed, codexClosedTurn: false }]).providers[0].working_agents, 1);
  assert.equal(snap([{ ...closed, codexHookAt: new Date(now - 100000).toISOString() }]).providers[0].state, 'stale');
  assert.equal(snap([{ ...closed, codexHookAt: undefined }]).providers[0].state, 'unknown');
  assert.equal(snap([{ ...closed, codexAgents: [{ status: 'done' }, { status: ['working'] }] }]).providers[0].state, 'turn stopped');
  assert.equal(snap([row('codex', { signal: 'stop', codexAgents: [{ status: 'working' }] })]).providers[0].state, 'turn stopped', 'unbound child list does not prove lifecycle work');
});
test('offline and unavailable projections do not invent live reports; bounded census stays explicit', () => {
  assert.match(Provider.snapshot({ sessions: [row('codex')], online: false, now }).headline, /^Offline — Codex last reported$/);
  assert.equal(Provider.snapshot({ sessions: [], available: false, now }).headline, 'AI activity unavailable');
  assert.equal(Provider.snapshot({ sessions: {}, now }).headline, 'AI activity unavailable');
  const many = snap(Array.from({ length: 105 }, () => row('codex'))); assert.equal(many.providers[0].sessions, 100); assert.equal(many.omitted, 5);
});
test('provider state preserves needs-input priority and actual report provenance across a provider', () => {
  const result = snap([row('codex'), row('codex', { signal: 'permission-ask' }), row('cursor', { signal: 'stop' })]);
  assert.equal(result.providers.find(p => p.provider === 'Codex').state, 'needs input');
  assert.equal(result.providers.find(p => p.provider === 'Cursor').state, 'turn stopped');
});
test('Help provider headline never mutates even default-looking human rule names text actions or look', () => {
  const rule = Rules.normalizeRule({ id: 'working', name: 'Claude is working', when: { signal: ['tool-use'] }, then: { lamp: 'green', pose: 'banner', text: 'MY HUMAN SIGN', clicks: { click: { action: 'url', arg: 'https://example.test/human' } } } });
  const session = row('codex'); const resolved = Rules.resolve([rule], [session], now);
  const state = { ...resolved, firedNames: ['Claude is working'], reason: 'session', sessions: [session] };
  const before = JSON.stringify({ rule, state });
  const help = Help.explain(state, [rule], { providerStatus: snap([session]) });
  assert.equal(help.headline, 'Codex: working');
  assert.ok(help.why.some(w => w.label === 'Rule' && w.value === '“Claude is working”'));
  assert.ok(help.why.some(w => w.label === 'Sign' && w.value === '“MY HUMAN SIGN”'));
  assert.equal(JSON.stringify({ rule, state }), before);
});
test('manual preview and travel explanations retain exact existing headline and report separate provider status', () => {
  for (const reason of ['manual', 'preview', 'travel']) {
    const h = Help.explain({ reason, look: { name: 'Human custom state' }, sessions: [] }, [], { providerStatus: snap([row('codex')]) });
    assert.equal(h.headline, 'Human custom state'); assert.equal(h.providerStatus.headline, 'Codex: working');
  }
});

const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path'); const { fromPage } = require('../src/utility-pages');
test('actual aggregate handler projection retains exact main-frame authority and unchanged rule look names', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const begin = source.indexOf("utilityHandle('get-aggregate-status'"); const end = source.indexOf('\n});', begin) + 4;
  const owner = { mainFrame: {}, isDestroyed: () => false }; let calls = 0, fn;
  const state = { reason: 'session', sessions: [row('codex')], look: { name: 'Human', clicks: { human: true } }, firedNames: ['Human'] };
  vm.runInNewContext(source.slice(begin, end), { utilityHandle: (_channel, guard, handler) => { fn = e => guard(e) ? handler(e) : null; },
    widgetOnly: e => fromPage(e, owner), widgetConfigSender: () => false,
    aggregateState: () => { calls++; return state; }, widgetMuzzle: () => null, ProviderStatus: Provider, localSessions: a => a, online: true });
  for (const e of [{}, { sender: owner, senderFrame: {} }, { sender: {}, senderFrame: owner.mainFrame }]) assert.equal(fn(e), null);
  assert.equal(calls, 0);
  const result = fn({ sender: owner, senderFrame: owner.mainFrame });
  assert.equal(result.look.name, 'Human'); assert.equal(result.look.clicks, state.look.clicks); assert.equal(result.firedNames, state.firedNames);
  assert.equal(result.providerStatus.providers[0].provider, 'Codex'); assert.equal(state.providerStatus, undefined);
});
test('actual widget tooltip quotes original owner while manual state is retained', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'widget.js'), 'utf8');
  const begin = source.indexOf('  const count = data.sessions'); const end = source.indexOf('\n}', begin);
  for (const reason of ['session', 'manual', 'preview', 'travel']) {
    const data = { reason, sessions: [], firedNames: ['Claude is working'], providerStatus: { headline: 'Codex: working' }, look: { name: 'Human sign' } };
    const tooltip = {};
    vm.runInNewContext(source.slice(begin, end), { data, look: data.look, tooltip, TOOLTIP_MAX: 90 });
    assert.ok(tooltip.textContent.includes('Claude is working'));
    assert.equal(tooltip.textContent.includes('Codex: working'), reason === 'session');
    if (reason === 'session') assert.match(tooltip.textContent, /Rule “Claude is working”/);
  }
});

test('compaction reports a concrete provider state and never an undefined headline', () => {
  const result = snap([row('claude', { signal: 'compact' })]);
  assert.equal(result.providers[0].state, 'compacting'); assert.equal(result.headline, 'Claude: compacting');
});

test('provider confidence and last-seen metadata stay bounded and honest offline', () => {
  const fresh = snap([row('claude')]);
  assert.equal(fresh.available, true); assert.equal(fresh.online, true); assert.equal(fresh.latest_age_ms, 1000);
  const offline = Provider.snapshot({ sessions: [row('claude')], online: false, now });
  assert.equal(offline.online, false); assert.equal(offline.latest_age_ms, 1000);
  const unavailable = Provider.snapshot({ available: false, now });
  assert.equal(unavailable.available, false); assert.equal(unavailable.latest_age_ms, null);
});
