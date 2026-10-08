'use strict';
// Real local HTTP/MCP transport with a fixture terminal client. No Claude/model
// process, provider credential, transcript or outside network is used.
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { createClaudeChannelSession, writeClaudeChannelConfig } = require('../src/claude-channel-session');
const { run, endpoint } = require('../src/claude-channel-server');
const { createInteractionHub } = require('../src/session-interaction');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { z } = require('zod');
const channelSchema = z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.object({ message_id: z.string() }) }) });

async function fixture(t, options = {}) {
  const adapter = createClaudeChannelSession({ ackMs: 100, ...options });
  const origin = await adapter.start(); t.after(() => adapter.stop());
  const grant = adapter.createGrant({ cwd: '/synthetic/project', title: 'Fixture terminal' });
  const call = async (route, value, extra = {}) => {
    const response = await fetch(origin + route, {
      method: value === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(4000),
      headers: { authorization: `Bearer ${grant.env.PLEXIFORM_CLAUDE_CHANNEL_TOKEN}`, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const connected = await call('/connect', { protocol: 1 }); assert.equal(connected.status, 200);
  const linked = (route, value, extra) => call(route, value, { 'x-plexiform-link': connected.value.link, ...extra });
  return { adapter, origin, grant, call, linked, link: connected.value.link };
}

test('terminal channel: write alone is unconfirmed; exact provider accept and reply provide receipt', async t => {
  const f = await fixture(t), id = crypto.randomUUID(), received = [];
  f.adapter.on(e => received.push(e));
  const sending = f.adapter.send({ target: f.grant.target, text: 'selected terminal only', clientId: id });
  let settled = false; sending.then(() => { settled = true; });
  const next = await f.linked('/next');
  assert.deepEqual(next.value, { message_id: id, content: 'selected terminal only' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.deepEqual(received, []);
  assert.equal((await f.linked('/accept', { message_id: id, text: 'altered text' })).status, 409);
  assert.equal((await f.linked('/reply', { message_id: id, text: 'premature' })).status, 409);
  assert.equal((await f.linked('/accept', { message_id: id, text: 'selected terminal only' })).status, 200);
  assert.deepEqual(await sending, { turnId: id, mode: 'new-turn' });
  assert.equal(received.find(e => e.kind === 'input-recorded').text, 'selected terminal only');
  assert.equal((await f.linked('/accept', { message_id: id, text: 'selected terminal only' })).status, 409, 'receipt cannot be replayed');
  assert.equal((await f.linked('/reply', { message_id: id, text: 'answer' })).status, 200);
  assert.equal(received.find(e => e.kind === 'message').text, 'answer');
  assert.equal(received.find(e => e.kind === 'turn-completed').status, 'completed');
  assert.equal((await f.linked('/reply', { message_id: id, text: 'replayed answer' })).status, 409);
  await assert.rejects(f.adapter.send({ target: f.grant.target, text: 'replayed id', clientId: id }), e => e.code !== 'DELIVERY_UNCONFIRMED', 'reused ID is rejected before a send deadline');
});

test('terminal channel: wrong token, browser origin, wrong link, duplicate connection and unknown route are refused', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/next', undefined, { authorization: `Bearer ${'f'.repeat(64)}` })).status, 403);
  assert.equal((await f.linked('/next', undefined, { origin: 'https://hostile.example' })).status, 403);
  // Fetch normalizes Host, so use actual HTTP to exercise the rebinding guard.
  const hostile = await new Promise((resolve, reject) => {
    const req = http.request(f.origin + '/next', { headers: { host: 'hostile.example', authorization: `Bearer ${f.grant.env.PLEXIFORM_CLAUDE_CHANNEL_TOKEN}`, 'x-plexiform-link': f.link } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostile, 403);
  assert.equal((await f.linked('/next', undefined, { 'x-plexiform-link': 'f'.repeat(64) })).status, 403);
  assert.equal((await f.call('/connect', { protocol: 1 })).status, 409);
  assert.equal((await f.linked('/next?target=another')).status, 404);
  assert.equal((await f.linked('/permission', { allow: true })).status, 404);
  await assert.rejects(f.adapter.send({ target: crypto.randomUUID(), clientId: crypto.randomUUID(), text: 'wrong target' }));
});

test('terminal channel: another valid grant cannot accept or reply to the selected target', async t => {
  const f = await fixture(t), second = f.adapter.createGrant({ cwd: '/synthetic/other' });
  const token = second.env.PLEXIFORM_CLAUDE_CHANNEL_TOKEN;
  const other = async (route, value, link = null) => {
    const response = await fetch(f.origin + route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(link ? { 'x-plexiform-link': link } : {}) }, body: JSON.stringify(value) });
    return { status: response.status, value: await response.json() };
  };
  const b = await other('/connect', { protocol: 1 }), id = crypto.randomUUID();
  const sent = f.adapter.send({ target: f.grant.target, text: 'A only', clientId: id });
  await f.linked('/next');
  assert.equal((await other('/accept', { message_id: id, text: 'A only' }, b.value.link)).status, 409);
  assert.equal((await other('/reply', { message_id: id, text: 'foreign answer' }, b.value.link)).status, 409);
  await f.linked('/accept', { message_id: id, text: 'A only' }); await sent;
  assert.equal((await f.linked('/reply', { message_id: crypto.randomUUID(), text: 'wrong message' })).status, 409);
  await f.linked('/reply', { message_id: id, text: 'A reply' });
});

test('terminal channel: unconfigured terminals are absent; expiry, revocation and late receipts fail closed', async t => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock, grantMs: 50 });
  f.adapter.createGrant({ cwd: '/synthetic/not-opted-in' });
  assert.equal(f.adapter.discover().length, 1);
  clock += 51;
  assert.equal((await f.linked('/next')).status, 403); assert.deepEqual(f.adapter.discover(), []);
  await assert.rejects(f.adapter.attach({ target: f.grant.target }));
  const g = await fixture(t, { ackMs: 10 }), id = crypto.randomUUID();
  const sending = g.adapter.send({ target: g.grant.target, text: 'no provider receipt', clientId: id });
  const rejected = assert.rejects(sending, e => e.code === 'DELIVERY_UNCONFIRMED');
  await g.linked('/next'); await rejected;
  assert.equal((await g.linked('/accept', { message_id: id, text: 'no provider receipt' })).status, 403);
  await assert.rejects(g.adapter.send({ target: g.grant.target, text: 'unsafe retry', clientId: crypto.randomUUID() }));
  assert.deepEqual(g.adapter.discover(), []);
  g.adapter.revoke(g.grant.target);
  assert.equal((await g.linked('/next')).status, 403);
});

test('terminal channel: lease and response bounds, closed schemas and steering remain enforced', async t => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock, leaseMs: 50 });
  await assert.rejects(f.adapter.send({ target: f.grant.target, text: 'steer', clientId: crypto.randomUUID(), expectedTurnId: crypto.randomUUID() }));
  const id = crypto.randomUUID(), sent = f.adapter.send({ target: f.grant.target, text: 'bounds', clientId: id });
  await f.linked('/next');
  assert.equal((await f.linked('/accept', { message_id: id, text: 'bounds', target: 'arbitrary' })).status, 409);
  await f.linked('/accept', { message_id: id, text: 'bounds' }); await sent;
  assert.equal((await f.linked('/reply', { message_id: id, text: 'x'.repeat(16_001) })).status, 409);
  clock += 51; assert.deepEqual(f.adapter.discover(), []);
});

test('terminal channel: genuine MCP transport carries channel capability and correlated tools into interaction hub', async t => {
  const adapter = createClaudeChannelSession({ ackMs: 1000 }); await adapter.start(); t.after(() => adapter.stop());
  const grant = adapter.createGrant({ cwd: '/synthetic/mcp-project' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-terminal', version: '1.0.0' }, { capabilities: {} });
  const values = []; client.setNotificationHandler(channelSchema, n => values.push(n.params));
  const serving = run({ env: grant.env, transport: serverTransport });
  await client.connect(clientTransport); const channel = await serving;
  t.after(async () => { await channel.close(); await client.close(); });
  assert.deepEqual(client.getServerCapabilities().experimental, { 'claude/channel': {} });
  assert.equal(Object.hasOwn(client.getServerCapabilities().experimental, 'claude/channel/permission'), false);
  const hub = createInteractionHub({ adapters: { 'claude-channel': adapter }, boardCurrent: () => true });
  const actor = 'fixture-overview', discovery = await hub.discover({ provider: 'claude-channel' }, actor);
  assert.equal(discovery.threads.length, 1);
  const attached = await hub.attach({ provider: 'claude-channel', handle: discovery.threads[0].handle }, actor);
  assert.equal(attached.ok, true);
  const send = hub.send({ session: attached.state.session, generation: 1, text: 'real MCP fixture message' }, actor);
  const cutoff = Date.now() + 2000; while (!values.length && Date.now() < cutoff) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(values.length, 1); const value = values[0];
  assert.equal(value.content, 'real MCP fixture message');
  const accept = await client.callTool({ name: 'plexiform_accept', arguments: { message_id: value.meta.message_id, text: value.content } });
  assert.equal(accept.isError, undefined); const acknowledged = await send; assert.equal(acknowledged.ok, true);
  assert.equal(acknowledged.delivery.recorded, true);
  const response = await client.callTool({ name: 'plexiform_reply', arguments: { message_id: value.meta.message_id, text: 'fixture reply' } }); assert.equal(response.isError, undefined);
  const state = hub.state({ session: attached.state.session }, actor);
  assert.equal(state.deliveries[0].state, 'completed'); assert.equal(state.deliveries[0].response, 'fixture reply');
  assert.equal((await client.callTool({ name: 'permission', arguments: { allow: true } })).isError, true);
});

test('terminal channel server only contacts closed loopback origins', () => {
  const valid = { PLEXIFORM_CLAUDE_CHANNEL_ORIGIN: 'http://127.0.0.1:1234', PLEXIFORM_CLAUDE_CHANNEL_TOKEN: 'a'.repeat(64) };
  assert.equal(endpoint(valid), valid.PLEXIFORM_CLAUDE_CHANNEL_ORIGIN);
  for (const origin of ['https://outside.example', 'https://127.0.0.1:1234', 'http://127.0.0.1', 'http://localhost:1234', 'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234/?query=x', 'http://user:secret@127.0.0.1:1234']) assert.throws(() => endpoint({ ...valid, PLEXIFORM_CLAUDE_CHANNEL_ORIGIN: origin }));
});

test('terminal channel: config is private, exclusive and contains no capability in the UI recipe', async t => {
  const f = await fixture(t);
  const temporaryBase = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryBase, 'plexiform-channel-config-'));
  assert.equal(path.dirname(directory), temporaryBase);
  fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = { grant: f.grant, directory, command: process.execPath, args: ['/synthetic/channel-server.js'] };
  const recipe = writeClaudeChannelConfig(input), stat = fs.lstatSync(recipe.file);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.uid, process.getuid()); assert.equal(stat.nlink, 1);
  const config = JSON.parse(fs.readFileSync(recipe.file, 'utf8'));
  assert.deepEqual(config.mcpServers.plexiform.env, f.grant.env);
  assert.equal(JSON.stringify(recipe).includes(f.grant.env.PLEXIFORM_CLAUDE_CHANNEL_TOKEN), false);
  assert.deepEqual(recipe.claudeArgs, ['--mcp-config', recipe.file, '--dangerously-load-development-channels', 'server:plexiform']);
  const electron = writeClaudeChannelConfig({ ...input, grant: { ...f.grant, target: crypto.randomUUID() }, electronRunAsNode: true });
  assert.equal(JSON.parse(fs.readFileSync(electron.file, 'utf8')).mcpServers.plexiform.env.ELECTRON_RUN_AS_NODE, '1');
  assert.throws(() => writeClaudeChannelConfig(input), /EEXIST/);
  assert.throws(() => writeClaudeChannelConfig({ ...input, platform: 'win32' }));
  fs.chmodSync(directory, 0o755); assert.throws(() => writeClaudeChannelConfig({ ...input, grant: { ...f.grant, target: crypto.randomUUID() } }));
  fs.chmodSync(directory, 0o700); const link = directory + '-link';
  fs.symlinkSync(directory, link); t.after(() => fs.unlinkSync(link));
  assert.throws(() => writeClaudeChannelConfig({ ...input, directory: link }));
});

test('terminal channel: closing an attachment revokes inbound capability without killing its terminal', async t => {
  const f = await fixture(t);
  f.adapter.release({ target: f.grant.target });
  assert.deepEqual(f.adapter.discover(), []);
  assert.equal((await f.linked('/next')).status, 403);
  await assert.rejects(f.adapter.attach({ target: f.grant.target }));
});

test('terminal channel: revocation during an incomplete body cannot accept or reply', async t => {
  const f = await fixture(t), id = crypto.randomUUID();
  const sent = f.adapter.send({ target: f.grant.target, text: 'must revoke', clientId: id });
  const rejected = assert.rejects(sent, e => e.code === 'DELIVERY_UNCONFIRMED'); await f.linked('/next');
  let req;
  const result = new Promise((resolve, reject) => {
    req = http.request(f.origin + '/accept', { method: 'POST', headers: { authorization: `Bearer ${f.grant.env.PLEXIFORM_CLAUDE_CHANNEL_TOKEN}`, 'x-plexiform-link': f.link, 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
    req.write('{"message_id":');
  });
  // Let the HTTP handler await the incomplete body before revoking. The body
  // remains unfinished throughout, so the check must run again after it ends.
  await new Promise(resolve => setTimeout(resolve, 20)); f.adapter.revoke(f.grant.target);
  req.end(JSON.stringify(id) + ',"text":"must revoke"}');
  assert.equal(await result, 403); await rejected;
});

test('terminal channel: written notification remains unconfirmed on revoke, expired lease or app stop', async t => {
  for (const reason of ['revoke', 'lease', 'stop']) {
    let clock = 1000;
    const f = await fixture(t, { now: () => clock, leaseMs: 50 });
    const id = crypto.randomUUID(), sent = f.adapter.send({ target: f.grant.target, clientId: id, text: reason });
    const rejected = assert.rejects(sent, e => e.code === 'DELIVERY_UNCONFIRMED');
    await f.linked('/next');
    if (reason === 'stop') f.adapter.stop();
    else if (reason === 'lease') { clock += 51; assert.deepEqual(f.adapter.discover(), []); }
    else f.adapter.revoke(f.grant.target);
    await rejected;
    assert.deepEqual(f.adapter.discover(), []);
  }
});

test('terminal channel: accepted but disconnected reply is failed, never completed successfully', async t => {
  const f = await fixture(t), events = [], id = crypto.randomUUID();
  f.adapter.on(e => events.push(e));
  const sent = f.adapter.send({ target: f.grant.target, clientId: id, text: 'accepted before disconnect' });
  await f.linked('/next'); await f.linked('/accept', { message_id: id, text: 'accepted before disconnect' }); await sent;
  f.adapter.revoke(f.grant.target);
  assert.equal(events.find(e => e.kind === 'turn-completed').status, 'failed');
  assert.match(events.find(e => e.kind === 'turn-completed').error, /terminal may still be working/);
  assert.equal(events.some(e => e.kind === 'message'), false);
});
