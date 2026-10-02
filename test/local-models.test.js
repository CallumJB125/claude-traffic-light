'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { createInteractionHub } = require('../src/session-interaction');
const { createInteractionMain, CHANNELS } = require('../src/interaction-main');
const { createLocalModels, createLocalModelAdapter, probeEndpoint, addressAllowed, LIMITS } = require('../src/local-models');

const ACTOR = 'overview:1:1';
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

// In-process fake backend. `routes[path](req, res, body)` handles a request.
async function fakeServer(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null, req });
      const h = routes[req.url];
      if (!h) { res.writeHead(404); res.end(); return; }
      h(req, res, body ? JSON.parse(body) : null);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const sse = (res, chunks, { done = true } = {}) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] })}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
};
const openaiRoutes = (extra = {}) => ({
  '/v1/models': (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'tiny-a' }, { id: 'tiny-b' }] })); },
  '/v1/chat/completions': (_q, res, body) => {
    const last = body.messages.at(-1).content;
    if (last === 'HOLD') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'thinking' } }] })}\n\n`); return; }
    sse(res, ['echo:', last]);
  },
  ...extra,
});
const profile = (url, over = {}) => ({ id: 'fake', label: 'Fake', url, kind: 'openai', system: '', allowPublic: false, apiKeyEnv: null, ...over });

async function hubWith(adapter) {
  const hub = createInteractionHub({ adapters: { local: adapter }, boardCurrent: (b) => b === null });
  const s = (await hub.launch({ provider: 'local' }, ACTOR)).state;
  return { hub, s, base: { session: s.session, generation: s.generation } };
}

test('address policy: loopback, RFC1918 and Tailscale only; metadata/link-local never, public only on opt-in', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.113', '100.68.66.98', 'fd7a:115c:a1e0::1']) assert.equal(addressAllowed(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1', 'not-an-ip']) assert.equal(addressAllowed(ip), false, ip);
  for (const ip of ['169.254.169.254', '0.0.0.0', 'fe80::1', '224.0.0.1', '::']) assert.equal(addressAllowed(ip, true), false, `${ip} even with opt-in`);
  assert.equal(addressAllowed('8.8.8.8', true), true);
});

test('FAKE OpenAI-compatible: streamed reply, delivery completes, history replayed with system prompt', async () => {
  const srv = await fakeServer(openaiRoutes());
  const adapter = createLocalModelAdapter({ profile: profile(srv.url, { system: 'be brief' }), model: 'tiny-a', label: 'tiny-a · Fake' });
  const { hub, s, base } = await hubWith(adapter);
  try {
    assert.equal(s.ownership, 'plexiform-owned'); assert.match(s.label, /tiny-a/);
    const sent = await hub.send({ ...base, text: 'one' }, ACTOR);
    assert.equal(sent.status, 'acknowledged');
    const d = await until(() => hub.state({ session: s.session }, ACTOR).deliveries.find((x) => x.state === 'completed'));
    assert.equal(d.response, 'echo:one'); assert.equal(d.recorded, false, 'stateless backends never claim an echo');
    await hub.send({ ...base, text: 'two' }, ACTOR);
    await until(() => hub.state({ session: s.session }, ACTOR).deliveries.filter((x) => x.state === 'completed').length === 2);
    const body = srv.seen.at(-1).body;
    assert.equal(body.model, 'tiny-a'); assert.equal(body.stream, true);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'one' }, { role: 'assistant', content: 'echo:one' }, { role: 'user', content: 'two' }]);
  } finally { hub.stopAll(); await srv.close(); }
});

test('FAKE Ollama native NDJSON: streamed reply and history', async () => {
  const srv = await fakeServer({
    '/api/chat': (_q, res, body) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'ol:' } })}\n`);
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: body.messages.at(-1).content } })}\n`);
      res.end(`${JSON.stringify({ done: true })}\n`);
    },
  });
  const adapter = createLocalModelAdapter({ profile: profile(srv.url, { kind: 'ollama' }), model: 'llama-tiny', label: 'x' });
  const { hub, s, base } = await hubWith(adapter);
  try {
    await hub.send({ ...base, text: 'hey' }, ACTOR);
    const d = await until(() => hub.state({ session: s.session }, ACTOR).deliveries.find((x) => x.state === 'completed'));
    assert.equal(d.response, 'ol:hey');
    assert.equal(srv.seen[0].url, '/api/chat');
  } finally { hub.stopAll(); await srv.close(); }
});

test('interrupt aborts the stream; wrong/stale turn and steer are refused; busy refuses a second turn', async () => {
  const srv = await fakeServer(openaiRoutes());
  const adapter = createLocalModelAdapter({ profile: profile(srv.url), model: 'tiny-a', label: 'x' });
  const { hub, s, base } = await hubWith(adapter);
  try {
    await hub.send({ ...base, text: 'HOLD' }, ACTOR);
    const turn = await until(() => hub.state({ session: s.session }, ACTOR).activeTurn);
    assert.equal((await hub.send({ ...base, text: 'again' }, ACTOR)).status, 'busy');
    assert.equal((await hub.send({ ...base, text: 'steer', expectedTurn: turn }, ACTOR)).status, 'stale', 'no steer for local models');
    assert.equal((await hub.interrupt({ ...base, turn: '00000000-0000-4000-8000-000000000000' }, ACTOR)).status, 'stale');
    assert.equal((await hub.interrupt({ ...base, generation: 99, turn }, ACTOR)).status, 'stale');
    assert.equal((await hub.interrupt({ ...base, turn }, ACTOR)).status, 'interrupt-requested');
    await until(() => hub.state({ session: s.session }, ACTOR).deliveries.some((x) => x.state === 'interrupted'));
    await until(() => srv.seen[0].req.socket.destroyed);
    // An interrupted turn is not added to the replayed history.
    await hub.send({ ...base, text: 'after' }, ACTOR);
    await until(() => hub.state({ session: s.session }, ACTOR).deliveries.some((x) => x.state === 'completed'));
    assert.deepEqual(srv.seen.at(-1).body.messages.map((m) => m.content), ['after']);
    await assert.rejects(adapter.interrupt({ target: 'local-nope', turnId: turn }));
    await assert.rejects(adapter.send({ target: 'local-nope', text: 'x' }), /Unknown conversation/);
  } finally { hub.stopAll(); await srv.close(); }
});

test('two sessions on one model: events and history never cross; wrong actor is refused', async () => {
  const srv = await fakeServer(openaiRoutes());
  const adapter = createLocalModelAdapter({ profile: profile(srv.url), model: 'tiny-a', label: 'x' });
  const hub = createInteractionHub({ adapters: { local: adapter }, boardCurrent: (b) => b === null });
  try {
    const A = (await hub.launch({ provider: 'local' }, ACTOR)).state, B = (await hub.launch({ provider: 'local' }, ACTOR)).state;
    assert.notEqual(hub.targetOf(A.session), hub.targetOf(B.session));
    assert.equal((await hub.send({ session: A.session, generation: 1, text: 'a1' }, 'overview:9:9')).status, 'forbidden');
    await hub.send({ session: A.session, generation: 1, text: 'a1' }, ACTOR);
    await until(() => hub.state({ session: A.session }, ACTOR).deliveries.some((d) => d.state === 'completed'));
    assert.equal(hub.state({ session: B.session }, ACTOR).deliveries.length, 0);
    await hub.send({ session: B.session, generation: 1, text: 'b1' }, ACTOR);
    await until(() => hub.state({ session: B.session }, ACTOR).deliveries.some((d) => d.state === 'completed'));
    assert.deepEqual(srv.seen.at(-1).body.messages.map((m) => m.content), ['b1'], 'B never sees A history');
  } finally { hub.stopAll(); await srv.close(); }
});

test('SSRF: non-allowlisted literal host and public-resolving hostname are refused before any connection', async () => {
  let looked = 0;
  const publicLookup = async () => { looked++; return [{ address: '93.184.216.34', family: 4 }]; };
  const mixedLookup = async () => [{ address: '127.0.0.1', family: 4 }, { address: '93.184.216.34', family: 4 }];
  for (const [url, lookup] of [['http://8.8.8.8:8000', undefined], ['http://169.254.169.254', undefined], ['http://model.example.test:8000', publicLookup], ['http://rebind.example.test:8000', mixedLookup], ['file:///etc/passwd', undefined], ['http://u:p@127.0.0.1:1', undefined]]) {
    const adapter = createLocalModelAdapter({ profile: profile(url), model: 'm', label: 'x', lookup });
    const { target } = await adapter.open();
    await assert.rejects(adapter.send({ target, text: 'secret' }), /not on this computer|Unsupported|Invalid/, url);
    const probe = await probeEndpoint(profile(url), { lookup });
    assert.equal(probe.reachable, false); assert.deepEqual(probe.models, []);
    adapter.stop();
  }
  assert(looked >= 1);
  // Opt-in is explicit and per endpoint; metadata ranges stay closed even then.
  const a = createLocalModelAdapter({ profile: profile('http://169.254.169.254', { allowPublic: true }), model: 'm', label: 'x' });
  await assert.rejects(a.send({ target: (await a.open()).target, text: 'x' }), /not on this computer/);
});

test('redirect to a disallowed host is refused and never followed', async () => {
  let followed = false;
  const target = http.createServer((_q, res) => { followed = true; res.end(); });
  const srv = await fakeServer({
    '/v1/chat/completions': (_q, res) => { res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data' }); res.end(); },
    '/v1/models': (_q, res) => { res.writeHead(302, { location: 'http://8.8.8.8/v1/models' }); res.end(); },
  });
  const adapter = createLocalModelAdapter({ profile: profile(srv.url), model: 'm', label: 'x' });
  try {
    await assert.rejects(adapter.send({ target: (await adapter.open()).target, text: 'x' }), /redirect refused/);
    assert.equal((await probeEndpoint(profile(srv.url))).reachable, false);
    assert.equal(followed, false); assert.equal(srv.seen.length, 2);
  } finally { adapter.stop(); target.close(); await srv.close(); }
});

test('oversized stream, overlong line, malformed SSE, early end and HTTP errors fail the turn cleanly', async () => {
  const big = 'x'.repeat(2048);
  const srv = await fakeServer({
    '/v1/chat/completions': (_q, res, body) => {
      const mode = body.messages.at(-1).content;
      if (mode === 'big') { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (let i = 0; i < 50; i++) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: big } }] })}\n\n`); res.end(); }
      else if (mode === 'line') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${'y'.repeat(10_000)}`); }
      else if (mode === 'junk') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('<html>not sse</html>\n'); }
      else if (mode === 'badjson') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {nope\n\n'); }
      else if (mode === 'short') sse(res, ['partial'], { done: false });
      else if (mode === 'err') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ error: { message: 'model not loaded' } })}\n\n`); }
      else { res.writeHead(500); res.end('boom'); }
    },
  });
  const limits = { ...LIMITS, responseBytes: 32 * 1024, lineBytes: 4096 };
  const adapter = createLocalModelAdapter({ profile: profile(srv.url), model: 'm', label: 'x', limits });
  const { hub, s, base } = await hubWith(adapter);
  try {
    const expect = { big: /too large/, line: /malformed/, junk: /malformed/, badjson: /malformed/, short: /ended early/, err: /model not loaded/ };
    for (const [mode, re] of Object.entries(expect)) {
      assert.equal((await hub.send({ ...base, text: mode }, ACTOR)).status, 'acknowledged', mode);
      const d = await until(() => hub.state({ session: s.session }, ACTOR).deliveries.find((x) => x.text === mode && x.state === 'failed'));
      assert.match(d.error, re, mode);
    }
    assert.equal((await hub.send({ ...base, text: 'http500' }, ACTOR)).status, 'unavailable', 'non-200 is never acknowledged');
    assert.equal(hub.state({ session: s.session }, ACTOR).status, 'ready');
    // None of the failed turns entered the replayed history.
    srv.seen.length = 0;
    await hub.send({ ...base, text: 'short' }, ACTOR);
    await until(() => srv.seen.length === 1);
    assert.deepEqual(srv.seen[0].body.messages.map((m) => m.content), ['short']);
  } finally { hub.stopAll(); await srv.close(); }
});

test('headers timeout and idle timeout end the turn', async () => {
  const srv = await fakeServer({
    '/v1/chat/completions': (_q, res, body) => {
      if (body.messages.at(-1).content === 'silent') return; // never answers
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); // then stalls
    },
  });
  const adapter = createLocalModelAdapter({ profile: profile(srv.url), model: 'm', label: 'x', limits: { ...LIMITS, headersMs: 100, idleMs: 100 } });
  const { hub, s, base } = await hubWith(adapter);
  try {
    assert.equal((await hub.send({ ...base, text: 'silent' }, ACTOR)).status, 'unavailable');
    await hub.send({ ...base, text: 'stall' }, ACTOR);
    const d = await until(() => hub.state({ session: s.session }, ACTOR).deliveries.find((x) => x.state === 'failed'));
    assert.match(d.error, /stopped responding/);
  } finally { hub.stopAll(); await srv.close(); }
});

test('closing a session mid-stream aborts the request and releases its history', async () => {
  const srv = await fakeServer(openaiRoutes());
  const adapter = createLocalModelAdapter({ profile: profile(srv.url), model: 'm', label: 'x' });
  const { hub, s, base } = await hubWith(adapter);
  try {
    await hub.send({ ...base, text: 'HOLD' }, ACTOR);
    await until(() => hub.state({ session: s.session }, ACTOR).activeTurn);
    assert.equal(adapter.conversations(), 1);
    assert.equal((await hub.close(base, ACTOR)).status, 'closed');
    await until(() => srv.seen[0].req.socket.destroyed);
    assert.equal(adapter.conversations(), 0);
    assert.equal((await hub.send({ ...base, text: 'late' }, ACTOR)).status, 'stale');
  } finally { hub.stopAll(); await srv.close(); }
});

test('history is bounded by message count and bytes', async () => {
  const srv = await fakeServer(openaiRoutes());
  const adapter = createLocalModelAdapter({ profile: profile(srv.url), model: 'm', label: 'x', limits: { ...LIMITS, historyMessages: 4 } });
  const { hub, s, base } = await hubWith(adapter);
  try {
    for (let i = 0; i < 4; i++) {
      await hub.send({ ...base, text: `m${i}` }, ACTOR);
      await until(() => hub.state({ session: s.session }, ACTOR).deliveries.filter((x) => x.state === 'completed').length === i + 1);
    }
    assert.deepEqual(srv.seen.at(-1).body.messages.map((m) => m.content), ['m1', 'echo:m1', 'm2', 'echo:m2', 'm3']);
  } finally { hub.stopAll(); await srv.close(); }
});

test('registry: discovery + config register reachable models honestly, no keys in overview, stable adapters', async () => {
  const srv = await fakeServer(openaiRoutes());
  const ollama = await fakeServer({ '/api/tags': (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'qwen:0.5b' }] })); } });
  const adapters = {};
  const config = { endpoints: [
    { id: 'spark', label: 'My Spark', url: `${srv.url}/v1`, kind: 'openai', apiKeyEnv: 'FAKE_LITELLM_KEY', system: 'hi' },
    { id: 'gone', label: 'Offline box', url: 'http://127.0.0.1:9', kind: 'openai' },
    { id: 'public', url: 'http://8.8.8.8:8000', kind: 'openai' },
    { id: 'BAD id', url: 'http://127.0.0.1:1', kind: 'openai' },
  ] };
  const discovery = [{ id: 'ollama', label: 'Ollama', url: ollama.url, kind: 'ollama' }, { id: 'lm', label: 'LM Studio', url: 'http://127.0.0.1:9', kind: 'openai' }];
  const env = { FAKE_LITELLM_KEY: 'sk-super-secret' };
  const reg = createLocalModels({ adapters, config, discovery, env });
  try {
    const o = await reg.refresh();
    assert.deepEqual(o.endpoints.map((e) => [e.id, e.reachable]).sort(), [['gone', false], ['ollama', true], ['public', false], ['spark', true]], 'unreachable discovered endpoints are hidden; configured ones shown honestly');
    assert.match(o.endpoints.find((e) => e.id === 'public').error, /not on this computer/);
    assert.deepEqual(o.models.map((m) => m.model).sort(), ['qwen:0.5b', 'tiny-a', 'tiny-b']);
    assert(!JSON.stringify(o).includes('sk-super-secret'));
    assert.deepEqual(o.endpoints.find((e) => e.id === 'spark').keyFromEnv, { name: 'FAKE_LITELLM_KEY', set: true });
    assert.equal(srv.seen[0].headers.authorization, 'Bearer sk-super-secret');
    const hub = createInteractionHub({ adapters, boardCurrent: (b) => b === null });
    const caps = hub.capabilities();
    assert.equal(caps.length, 3); assert(caps.every((c) => c.available && c.ownership === 'plexiform-owned' && c.capabilities.steer === false));
    const tinyA = o.models.find((m) => m.model === 'tiny-a');
    const sess = (await hub.launch({ provider: tinyA.provider }, ACTOR)).state;
    await hub.send({ session: sess.session, generation: 1, text: 'yo' }, ACTOR);
    await until(() => hub.state({ session: sess.session }, ACTOR).deliveries.some((d) => d.state === 'completed'));
    assert.equal(srv.seen.at(-1).url, '/v1/chat/completions');
    assert.equal(srv.seen.at(-1).body.messages[0].content, 'hi');
    const adapterBefore = adapters[tinyA.provider];
    const o2 = await reg.refresh({ force: true });
    assert.equal(adapters[tinyA.provider], adapterBefore, 'same adapter across refreshes');
    assert.ok(o2.models.find((m) => m.provider === tinyA.provider).lastUsed);
    hub.stopAll();
    // Endpoint goes away: its models stay registered but report unavailable and cannot launch.
    await srv.close();
    const o3 = await reg.refresh({ force: true });
    assert.equal(o3.models.find((m) => m.model === 'tiny-b').reachable, false);
    const hub2 = createInteractionHub({ adapters, boardCurrent: (b) => b === null });
    assert.equal((await hub2.launch({ provider: o3.models.find((m) => m.model === 'tiny-b').provider }, ACTOR)).status, 'unavailable');
  } finally { await ollama.close(); }
});

test('IPC: local-models channel needs the Overview frame and returns the registry overview', async () => {
  const contents = { id: 1, isDestroyed: () => false, mainFrame: {}, send() {} };
  const handlers = new Map();
  let refreshed = 0;
  const main = createInteractionMain({ context: () => ({ contents, generation: 1, document: 1, foreground: true }), adapters: {}, workspace: () => null, localModels: { refresh: async () => { refreshed++; return { endpoints: [], models: [] }; } } });
  main.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  assert.equal(await handlers.get(CHANNELS.localModels)({ sender: {}, senderFrame: {} }), null);
  assert.equal(refreshed, 0);
  assert.deepEqual(await handlers.get(CHANNELS.localModels)({ sender: contents, senderFrame: contents.mainFrame }), { endpoints: [], models: [] });
  main.close();
});
