'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTeamHubClient } = require('../src/team-hub-client');
const { createLiveTeamHub } = require('../src/team-hub-live');
const NOW = 1_800_000_000_000;
const RUN = '11111111-2222-4333-8444-555555555555', MSG = '21111111-2222-4333-8444-555555555555', THREAD = '31111111-2222-4333-8444-555555555555', RID = '41111111-2222-4333-8444-555555555555';
const row = () => ({ ref: RUN, owner: { id: 'm-bob', user_id: 'u-bob', name: 'Bob', self: false }, board: { id: 'board-1', name: 'Engineering' }, card: { id: 'card-1', key: 'E-12', title: 'Improve Overview', fence: 4, repo_id: 'repo-1' }, provider: { id: 'claude', label: 'injected' }, state: 'running', online: true, hb_age_ms: 1000, input_needed: false, canSend: true });
const directory = () => ({ schema: 1, status: 'complete', team: { id: 'team-1', name: 'Engineering' }, principal: { user_id: 'u-ana', member_id: 'm-ana', role: 'member' }, observed_at: NOW, message_contract: 'task-inbox', sessions: [row()] });
const message = () => ({ id: MSG, thread_id: THREAD, card_id: 'card-1', repo_id: 'repo-1', fence: 4, kind: 'coordination', request_id: RID, body: 'Hello Bob', for_agent: false, auto_resume: false, grants_execution: false,
  author: { kind: 'member', member_id: 'm-ana', account_id: 'u-ana', name: 'Ana', identity_source: 'staff_credential' },
  deliveries: [{ recipient_run_id: RUN, recipient_card_id: 'card-1', recipient_member_id: 'm-bob', fence: 4, current_recipient: true, state: 'pending', received_at: null, acknowledged_at: null, receipt_connection_current: false, acknowledgement_source: null }] });
function rig() {
  const s = { now: NOW, dto: directory(), calls: [], messages: [], post: message(), postStatus: 200, directoryStatus: 200, afterDirectory: null };
  const json = (status, body) => ({ status, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
  const fetch = async (url, init) => {
    s.calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/shared')) return json(200, { shared: [] });
    if (url.endsWith('/account')) return json(200, { user: { id: 'u-ana' }, teams: [{ id: 'team-1', name: 'Engineering', token: 'SECRET' }] });
    if (url.endsWith('/team-session-directory')) { s.afterDirectory?.(); return json(s.directoryStatus, s.dto); }
    if (init.method === 'POST') { if (s.postStatus === 'throw') throw new Error('credential SECRET'); return json(s.postStatus, { message: s.post }); }
    return json(200, { messages: s.messages, auto_resume: false });
  };
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', viewerId: 'u-ana', token: () => 'SECRET', fetch, boardDirectory: true }, { now: () => s.now, pollMs: 20, timeoutMs: 500, deadlineMs: 1000 });
  return { s, hub, fetch };
}
async function chosen(hub) { return (await hub.sessions(hub.viewer(), 'team-1'))[0]; }
const posts = s => s.calls.filter(c => c.init.method === 'POST');

test('teams with zero explicit shares discover all current account teams; live wiring enables board discovery', async () => {
  const { hub, fetch } = rig();
  assert.deepEqual(await hub.teams(), [{ id: 'team-1', name: 'Engineering' }]);
  const live = createLiveTeamHub({ identity: () => ({ origin: 'https://hub.test', userId: 'u-ana', token: () => 'SECRET' }), fetch });
  assert.deepEqual(await live.current().teams(), [{ id: 'team-1', name: 'Engineering' }]);
  live.close();
});

test('board rows are closed metadata, opaque routing refs, current observed heartbeat; own user identity preserved', async () => {
  const { hub, s } = rig();
  Object.assign(s.dto.sessions[0], { token: 'SECRET', cwd: '/private/project', native_session_id: 'provider-private', children: [{ task: 'private' }] });
  const r = await chosen(hub);
  assert.match(r.ref, /^board-run:[0-9a-f]{64}$/);
  assert.equal(r.boardRunId, RUN, 'main-only dedupe seam');
  assert.equal(r.owner.id, 'u-bob'); assert.equal(r.owner.self, false);
  assert.equal(r.provider.label, 'Claude Code'); assert.equal(r.observed_at, NOW - 1000);
  assert.equal(r.messageContract, 'task-inbox'); assert.match(r.notice, /Queued is not received/);
  const serialized = JSON.stringify(r);
  for (const bad of ['SECRET', '/private/project', 'provider-private', 'repo-1', 'card-1', 'm-bob', 'm-ana']) assert.equal(serialized.includes(bad), false, bad);
  s.dto.sessions[0].owner.user_id = 'u-ana';
  assert.equal((await chosen(hub)).owner.self, true);
});

test('server response clock may advance during the awaited HTTP request', async () => {
  const { s, hub } = rig();
  s.afterDirectory = () => { s.now += 100; s.dto.observed_at = s.now; };
  const received = await hub.sessions(hub.viewer(), 'team-1');
  assert.equal(received.length, 1, 'a legitimate advancing server response remains discoverable');
  assert.equal(received[0].online, true);
});

test('principal, selected team, role, schema, contract and future clocks refuse hostile directory', async () => {
  for (const mutate of [d => d.principal.user_id = 'u-bob', d => d.team.id = 'other-team', d => d.principal.role = 'superadmin', d => d.schema = 2, d => d.message_contract = 'typing', d => d.observed_at = NOW + 1]) {
    const { s, hub } = rig(); mutate(s.dto);
    const rows = await hub.sessions(hub.viewer(), 'team-1');
    assert.equal(rows.length, 0); assert.equal(rows.partial, true);
  }
});

test('viewer is watch-only even when the hostile session claims canSend', async () => {
  const { s, hub } = rig(); s.dto.principal.role = 'viewer';
  const r = await chosen(hub); assert.equal(r.share.scope, 'watch');
  const out = await hub.send(hub.viewer(), 'team-1', r.ref, 'Hello Bob', RID);
  assert.equal(out.ok, false); assert.equal(posts(s).length, 0);
});

test('elapsed receiver time expires heartbeat at 45 seconds; unknown heartbeat never grants send', async () => {
  for (const [age, elapsed] of [[44_000, 2000], [45_001, 0], [null, 0], [-1, 0], [Infinity, 0]]) {
    const { s, hub } = rig(); s.dto.sessions[0].hb_age_ms = age; s.now += elapsed;
    const r = await chosen(hub); assert.equal(r.online, false);
    const out = await hub.send(hub.viewer(), 'team-1', r.ref, 'Hello Bob', RID);
    assert.equal(out.ok, false); assert.equal(posts(s).length, 0);
  }
});

test('send refreshes membership and exact current run/card/board/repo/fence/owner/provider pins', async () => {
  const changes = [d => d.sessions[0].ref = MSG, d => d.sessions[0].card.id = 'other-card', d => d.sessions[0].board.id = 'other-board', d => d.sessions[0].card.repo_id = 'other-repo', d => d.sessions[0].card.fence++, d => d.sessions[0].owner.user_id = 'other-user', d => d.sessions[0].owner.id = 'other-member', d => d.principal.member_id = 'replacement-member', d => d.sessions[0].provider.id = 'codex', d => d.sessions[0].state = 'done', d => d.sessions = []];
  for (const change of changes) {
    const { s, hub } = rig(), r = await chosen(hub); change(s.dto);
    const out = await hub.send(hub.viewer(), 'team-1', r.ref, 'Hello Bob', RID);
    assert.equal(out.ok, false); assert.equal(posts(s).length, 0);
  }
  const { s, hub } = rig(), r = await chosen(hub); s.directoryStatus = 403;
  assert.equal((await hub.send(hub.viewer(), 'team-1', r.ref, 'Hello Bob', RID)).ok, false); assert.equal(posts(s).length, 0);
});

test('one fenced task inbox POST uses selected-team header, board scope and target run; never provider typing', async () => {
  const { s, hub } = rig(), r = await chosen(hub);
  const out = await hub.send(hub.viewer(), 'team-1', r.ref, 'Hello Bob', RID);
  assert.equal(out.ok, true); assert.equal(out.status, 'queued'); assert.equal(out.delivery.state, 'queued');
  const call = posts(s)[0]; assert.equal(posts(s).length, 1);
  assert.equal(call.url, 'https://hub.test/api/cards/card-1/messages?board_id=board-1');
  assert.equal(call.init.headers['X-Board-Team'], 'team-1'); assert.equal(call.init.redirect, 'error');
  assert.deepEqual(call.body, { request_id: RID, expected_fence: 4, kind: 'coordination', body: 'Hello Bob', recipient_run_ids: [RUN] });
  assert.equal(JSON.stringify(out).includes(RUN), false); assert.equal(JSON.stringify(out).includes(MSG), false);
});

test('POST response must match exact request, text and sender; old or substituted receipt stays unconfirmed', async () => {
  for (const change of [m => m.request_id = MSG, m => m.body = 'Old text', m => m.author.account_id = 'other-user', m => m.author.member_id = 'other-member', m => m.author.kind = 'run', m => m.author.identity_source = 'remote_grant', m => m.card_id = 'other-card', m => m.deliveries[0].recipient_run_id = MSG]) {
    const { s, hub } = rig(), r = await chosen(hub); change(s.post);
    const out = await hub.send(hub.viewer(), 'team-1', r.ref, 'Hello Bob', RID);
    assert.equal(out.ok, false); assert.equal(out.status, 'unconfirmed'); assert.equal(posts(s).length, 1); assert.match(out.reason, /Do not resend/);
  }
});

test('lost or 5xx POST response may already be durably queued; never retry or claim refused', async () => {
  for (const status of ['throw', 500, 0]) {
    const { s, hub } = rig(), r = await chosen(hub); s.postStatus = status;
    const out = await hub.send(hub.viewer(), 'team-1', r.ref, 'Hello Bob', RID);
    assert.equal(out.status, 'unconfirmed'); assert.equal(posts(s).length, 1); assert.match(out.reason, /Do not resend/); assert.equal(JSON.stringify(out).includes('SECRET'), false);
  }
});

test('journal requires current transport receipt and agent ack; replies correlate exact target/thread/message', async () => {
  const { s, hub } = rig(), r = await chosen(hub); await hub.send(hub.viewer(), 'team-1', r.ref, 'Hello Bob', RID);
  const m = message(); s.messages = [m];
  const current = async () => (await chosen(hub)).deliveries[0];
  assert.equal((await current()).state, 'queued');
  const d = m.deliveries[0]; Object.assign(d, { state: 'received', received_at: '2026-10-03T10:00:00Z', receipt_connection_current: true });
  assert.equal((await current()).state, 'recorded');
  Object.assign(d, { state: 'acknowledged', acknowledged_at: '2026-10-03T10:01:00Z', acknowledgement_source: 'agent_reported' });
  assert.equal((await current()).state, 'acknowledged');
  d.acknowledgement_source = 'transport'; assert.equal((await current()).state, 'recorded', 'transport receipt is not an agent acknowledgement');
  d.acknowledgement_source = null; assert.equal((await current()).state, 'recorded', 'missing agent provenance cannot acknowledge');
  d.acknowledgement_source = 'agent_reported';
  d.receipt_connection_current = false; assert.equal((await current()).state, 'queued'); d.receipt_connection_current = true;
  const reply = { ...message(), id: RID, reply_to: MSG, body: 'Acknowledged', author: { kind: 'run', run_id: RUN, member_id: 'm-bob', account_id: 'u-bob', identity_source: 'hub_run', provider: 'claude' } };
  s.messages.push(reply); assert.equal((await current()).state, 'replied'); assert.equal((await current()).response, 'Acknowledged');
  for (const mutate of [r => r.reply_to = THREAD, r => r.thread_id = RID, r => r.author.run_id = THREAD, r => r.author.account_id = 'other-account', r => r.repo_id = 'other-repo', r => r.fence++, r => r.author.identity_source = 'staff_credential']) {
    const bad = structuredClone(reply); mutate(bad); s.messages = [m, bad]; assert.equal((await current()).state, 'acknowledged'); assert.equal((await current()).response, '');
  }
});

test('partial and malformed subsets stay marked partial; 200 board rows max, no huge journal fanout', async () => {
  const { s, hub } = rig(); s.dto.status = 'partial'; assert.equal((await hub.sessions(hub.viewer(), 'team-1')).partial, true);
  s.dto.status = 'complete'; s.dto.sessions.push({ ...row(), ref: 'not-a-run' }); assert.equal((await hub.sessions(hub.viewer(), 'team-1')).partial, true);
  s.dto.sessions = Array.from({ length: 210 }, (_, i) => ({ ...row(), ref: `${String(i).padStart(8, '0')}-2222-4333-8444-555555555555` }));
  const out = await hub.sessions(hub.viewer(), 'team-1'); assert.equal(out.length, 200); assert.equal(out.partial, true);
  assert.equal(s.calls.some(c => c.url.includes('/messages')), false, 'receipt history is read only for client-sent targets');
});

test('poll announces queued→agent acknowledged on an unchanged board directory, then stops', async () => {
  const { s, hub } = rig(), r = await chosen(hub); await hub.send(hub.viewer(), 'team-1', r.ref, 'Hello Bob', RID);
  s.messages = [message()]; let changes = 0; const off = hub.onChange(() => changes++);
  await new Promise(resolve => setTimeout(resolve, 70)); const before = changes;
  Object.assign(s.messages[0].deliveries[0], { state: 'acknowledged', receipt_connection_current: true, acknowledgement_source: 'agent_reported', acknowledged_at: '2026-10-03T10:01:00Z' });
  await new Promise(resolve => setTimeout(resolve, 70)); assert.ok(changes > before);
  off(); await new Promise(resolve => setTimeout(resolve, 25)); const count = s.calls.length;
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(s.calls.length, count);
});

test('receipt refresh rotates one journal per snapshot across many sent targets', async () => {
  const { s, hub } = rig();
  s.dto.sessions = Array.from({ length: 3 }, (_, i) => ({ ...row(), ref: `${String(i + 10).padStart(8, '0')}-2222-4333-8444-555555555555`, card: { ...row().card, id: `card-${i + 10}` } }));
  const rows = await hub.sessions(hub.viewer(), 'team-1');
  for (let i = 0; i < rows.length; i++) {
    const target = s.dto.sessions[i]; s.post = message(); s.post.card_id = target.card.id;
    Object.assign(s.post.deliveries[0], { recipient_run_id: target.ref, recipient_card_id: target.card.id });
    assert.equal((await hub.send(hub.viewer(), 'team-1', rows[i].ref, 'Hello Bob', RID)).ok, true);
  }
  s.calls.length = 0;
  for (let i = 0; i < 3; i++) await hub.sessions(hub.viewer(), 'team-1');
  const reads = s.calls.filter(c => c.init.method === 'GET' && c.url.includes('/messages'));
  assert.equal(reads.length, 3, 'one journal per refresh, not all three every time');
  assert.equal(new Set(reads.map(c => c.url)).size, 3, 'all sent targets eventually refresh');
});
