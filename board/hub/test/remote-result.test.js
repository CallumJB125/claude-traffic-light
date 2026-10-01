import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { remoteRig, grant, oauth, business } from './remote-helpers.js';
import { communicationRig } from './communication-helpers.js';
import { RemoteActions } from '../remote/actions.js';
import { MAX_RESULT_BYTES, boundedResult, toolResult } from '../remote/result.js';
const large = error => error.code === 'PAYLOAD_TOO_LARGE';
const bytes = value => Buffer.byteLength(JSON.stringify(value));
async function mcp(f) { const q = await oauth(f); return f.authority.token(q.body).access_token; }
async function rpc(f, token, name, args) {
  const res = await fetch(f.h.base + '/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'bounded-result', method: 'tools/call', params: { name, arguments: args } }) });
  const text = await res.text(); assert.equal(res.status, 200, text);
  assert.ok(Buffer.byteLength(text) <= MAX_RESULT_BYTES); return JSON.parse(text).result;
}
function refused(result) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
  const error = JSON.parse(result.content[0].text).error; assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
  assert.match(error.message, /Narrow the query or open the task/); assert.match(error.message, /request_id/);
}
async function packetRig(t) {
  const f = await communicationRig(t); f.h.hub.config.publicUrl = f.h.base;
  f.authority = f.h.hub.remoteAuthority; f.actions = new RemoteActions(f.h.hub);
  const g = await grant(f), id = f.sender.run.card_id;
  const attached = await f.sender.client.rpc(f.sender.run, 'board_attach_evidence', { kind: 'log', ref: 'https://synthetic.test/log', summary: 'Observed synthetic evidence' });
  assert.equal(attached.ok, true, JSON.stringify(attached.error));
  const evidence = attached.result.evidence_id;
  const args = { card_id: id, request_id: randomUUID(), expected_version: 0, expected_fence: f.h.hub.card(id).fence,
    data: { brief: 'Bounded packet', decisions: [], progress: '', nextAction: '', artifacts: Array.from({ length: 32 }, () => ({ kind: 'evidence', id: evidence })), reportedChecks: [] } };
  return { f, g, id, evidence, args };
}
function grow(f, evidence, summary = 'a'.repeat(1000), ref = 'https://synthetic.test/' + 'a'.repeat(1000 - 'https://synthetic.test/'.length)) {
  f.db.run('UPDATE evidence SET summary=?,ref=? WHERE id=?', summary, ref, evidence);
}
function broadcasts(f) {
  let count = 0; const original = f.h.hub.broadcastCard.bind(f.h.hub);
  f.h.hub.broadcastCard = (...args) => { count++; return original(...args); };
  return () => count;
}

test('encoded UTF8 result boundary and complete MCP escaping/envelope are bounded without truncation', () => {
  const exact = 'a'.repeat(MAX_RESULT_BYTES - 2); assert.equal(bytes(exact), MAX_RESULT_BYTES); assert.equal(boundedResult(exact), exact);
  assert.throws(() => boundedResult(exact + 'a'), large);
  assert.throws(() => boundedResult('é'.repeat(MAX_RESULT_BYTES / 2)), large);
  const escaped = { text: '\\'.repeat(20_000) }; assert.ok(bytes(escaped) < MAX_RESULT_BYTES);
  assert.ok(bytes({ jsonrpc: '2.0', id: 'actual-id', result: toolResult(escaped) }) > MAX_RESULT_BYTES);
  assert.throws(() => boundedResult(escaped, 'actual-id'), large);
  assert.deepEqual(boundedResult({ text: 'small' }, 'actual-id'), { text: 'small' });
});

test('real card read refuses accumulated comments without partial data or effects', async t => {
  const f = await remoteRig(t), g = await grant(f), token = await mcp(f);
  for (let i = 0; i < 8; i++) {
    const r = await f.as(f.users.amember, 'POST', `/api/cards/${f.A.card}/comments`, { body: 'a'.repeat(10_000) }); assert.equal(r.status, 200, r.text);
  }
  const before = business(f);
  await assert.rejects(f.actions.call(g.token, 'integration', 'plexiform_get_card', { card_id: f.A.card }), large);
  refused(await rpc(f, token, 'plexiform_get_card', { card_id: f.A.card })); assert.equal(business(f), before);
});

test('oversized packet write rolls back packet, journal, durable receipt and scheduled broadcast', async t => {
  const { f, g, id, evidence, args } = await packetRig(t); grow(f, evidence);
  const before = business(f), count = broadcasts(f);
  await assert.rejects(f.actions.call(g.token, 'integration', 'plexiform_write_packet', args), large);
  assert.equal(business(f), before); assert.equal(count(), 0); assert.equal(f.h.hub.post.length, 0);
  assert.equal(f.db.get('SELECT count(*) n FROM task_packets WHERE card_id=?', id).n, 0);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_actions WHERE request_id=?', args.request_id).n, 0);
  grow(f, evidence, 'Small evidence', 'https://synthetic.test/log');
  const retry = await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args);
  assert.equal(retry.packet.version, 1); assert.equal(f.db.get('SELECT count(*) n FROM remote_actions WHERE request_id=?', args.request_id).n, 1);
});

test('real MCP envelope limit refuses a write whose projection fits, before receipt or packet commit', async t => {
  const { f, id, evidence, args } = await packetRig(t), token = await mcp(f);
  grow(f, evidence, 'a'.repeat(600), 'https://synthetic.test/' + 'b'.repeat(578));
  const before = business(f), count = broadcasts(f); refused(await rpc(f, token, 'plexiform_write_packet', args));
  assert.equal(business(f), before); assert.equal(count(), 0);
  // The same material fits the independent encoded-JSON API result limit.
  const scope = f.authority.authenticate(token, 'mcp');
  const accepted = await f.actions.call(token, 'mcp', 'plexiform_write_packet', args);
  assert.equal(accepted.packet.version, 1); assert.ok(bytes(accepted) < MAX_RESULT_BYTES);
  assert.ok(bytes({ jsonrpc: '2.0', id: 'bounded-result', result: toolResult(accepted) }) > MAX_RESULT_BYTES);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_actions WHERE grant_id=?', scope.grant.id).n, 1);
});

test('oversized sealed packet read and durable replay preserve original packet bytes, hash and receipt', async t => {
  const { f, g, id, evidence, args } = await packetRig(t), token = await mcp(f);
  const original = await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args);
  const stored = f.db.get('SELECT * FROM task_packets WHERE id=?', original.packet.id);
  grow(f, evidence); const before = business(f), count = broadcasts(f);
  for (const [name, input] of [['plexiform_read_packet', { card_id: id }], ['plexiform_write_packet', args]]) {
    await assert.rejects(f.actions.call(g.token, 'integration', name, input), large);
  }
  refused(await rpc(f, token, 'plexiform_read_packet', { card_id: id }));
  assert.equal(business(f), before); assert.equal(count(), 0); assert.deepEqual(f.db.get('SELECT * FROM task_packets WHERE id=?', stored.id), stored);
  grow(f, evidence, 'Small again', 'https://synthetic.test/log');
  const replay = await f.actions.call(g.token, 'integration', 'plexiform_write_packet', args);
  assert.equal(replay.packet.id, stored.id); assert.equal(replay.packet.content_hash, stored.content_hash);
  assert.deepEqual(replay.packet.data, JSON.parse(stored.data)); assert.equal(f.db.get('SELECT count(*) n FROM remote_actions WHERE request_id=?', args.request_id).n, 1);
});

test('actual MCP durable retry rechecks the current envelope and retains its sole committed receipt on refusal', async t => {
  const { f, id, evidence, args } = await packetRig(t), token = await mcp(f);
  const first = await rpc(f, token, 'plexiform_write_packet', args), stored = f.db.get('SELECT * FROM task_packets WHERE id=?', first.structuredContent.packet.id);
  grow(f, evidence, 'a'.repeat(600), 'https://synthetic.test/' + 'b'.repeat(578));
  const before = business(f), count = broadcasts(f);
  refused(await rpc(f, token, 'plexiform_write_packet', args)); assert.equal(business(f), before); assert.equal(count(), 0);
  refused(await rpc(f, token, 'plexiform_read_packet', { card_id: id })); assert.equal(business(f), before);
  assert.deepEqual(f.db.get('SELECT * FROM task_packets WHERE id=?', stored.id), stored);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_actions WHERE request_id=?', args.request_id).n, 1);
});
