'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { detectEndpoint, createDetector, isLoopbackUrl } = require('../src/local-model-detect');
const { localModelCard } = require('../src/local-model-card');
const { validateEndpointInput, createEndpointStore } = require('../src/local-model-endpoints');
const { createLocalModels } = require('../src/local-models');
const { sessionCard } = require('../src/session-card-view');
const { createSessionDirectory } = require('../src/session-directory');

const OLLAMA = { id: 'ollama', label: 'Ollama (this computer)', url: 'http://127.0.0.1:11434', kind: 'ollama' };
const LMSTUDIO = { id: 'lmstudio', label: 'LM Studio (this computer)', url: 'http://127.0.0.1:1234', kind: 'openai' };
const json = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) });
const refused = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };

test('detect: Ollama tags and OpenAI /models are read from loopback only', async () => {
  const seen = [];
  const fetch = async (url, opts) => { seen.push([url, opts.redirect]); return url.endsWith('/api/tags') ? json({ models: [{ name: 'llama3.2' }, { model: 'qwen2.5' }, { name: 'llama3.2' }] }) : json({ data: [{ id: 'phi-3' }] }); };
  const a = await detectEndpoint(OLLAMA, { fetch });
  assert.deepEqual({ reachable: a.reachable, models: a.models, error: a.error, id: a.endpoint.id }, { reachable: true, models: ['llama3.2', 'qwen2.5'], error: null, id: 'ollama' });
  const b = await detectEndpoint(LMSTUDIO, { fetch });
  assert.deepEqual(b.models, ['phi-3']);
  assert.deepEqual(seen, [['http://127.0.0.1:11434/api/tags', 'manual'], ['http://127.0.0.1:1234/v1/models', 'manual']]);
  let called = false;
  const lan = await detectEndpoint({ ...OLLAMA, url: 'http://192.168.1.5:11434' }, { fetch: async () => { called = true; return json({}); } });
  assert.equal(called, false); assert.equal(lan.reachable, false);
  assert.equal(isLoopbackUrl('http://localhost:11434'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1:1234'), true);
});

test('detect: refused, timeout, HTTP error and a non-list body say so in plain words', async () => {
  const r1 = await detectEndpoint(OLLAMA, { fetch: refused });
  assert.equal(r1.reachable, false); assert.match(r1.error, /Nothing is answering on port 11434\. Ollama is not running\./);
  const keep = setTimeout(() => {}, 1000); // AbortSignal.timeout does not hold the event loop open
  const r2 = await detectEndpoint(LMSTUDIO, { fetch: async (_u, o) => new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))), timeoutMs: 30 });
  clearTimeout(keep);
  assert.match(r2.error, /did not answer within 0\.03 seconds/);
  assert.match((await detectEndpoint(OLLAMA, { fetch: async () => json({}, 404) })).error, /HTTP 404/);
  assert.match((await detectEndpoint(OLLAMA, { fetch: async () => ({ status: 200, text: async () => '<html>' }) })).error, /not with a model list/);
  assert.match((await detectEndpoint(OLLAMA, { fetch: async () => json({ nope: 1 }) })).error, /not with a model list/);
});

test('detector backs off a port that keeps failing the same way, and resets on success', async () => {
  let t = 0, calls = 0, up = false;
  const fetch = async () => { calls++; if (!up) refused(); return json({ models: [{ name: 'm' }] }); };
  const d = createDetector({ fetch, now: () => t, endpoints: [OLLAMA], base: 1000, max: 8000 });
  await d.probe(OLLAMA); assert.equal(calls, 1);
  t = 500; await d.probe(OLLAMA); assert.equal(calls, 1, 'not due yet: last result reused');
  t = 1000; await d.probe(OLLAMA); assert.equal(calls, 2); assert.equal(d.gap('ollama'), 2000);
  t = 2500; await d.probe(OLLAMA); assert.equal(calls, 2);
  up = true; t = 3000; const r = await d.probe(OLLAMA); assert.equal(calls, 3); assert.equal(r.reachable, true); assert.equal(d.gap('ollama'), 1000);
  await d.probe(OLLAMA, { force: true }); assert.equal(calls, 4);
});

test('card: running with models, not running, and no models pulled each give one next step', () => {
  const card = localModelCard({
    endpoints: [{ id: 'ollama', label: 'Ollama (this computer)', kind: 'ollama', source: 'discovered', host: '127.0.0.1:11434', reachable: true, error: null }],
    models: [{ provider: 'local-ollama-abc', model: 'llama3.2', endpoint: 'ollama', reachable: true }],
    detected: [{ id: 'ollama', label: 'Ollama (this computer)', kind: 'ollama', reachable: true, error: null }, { id: 'lmstudio', label: 'LM Studio (this computer)', kind: 'openai', reachable: false, error: 'Nothing is answering on port 1234. LM Studio is not running.' }, { id: 'local-8000', label: 'x', kind: 'openai', reachable: false, error: 'no' }],
  });
  assert.equal(card.headline, '1 local model ready on this computer.');
  assert.deepEqual(card.backends.map((b) => [b.id, b.health]), [['ollama', 'reachable'], ['lmstudio', 'not-running']]);
  assert.deepEqual(card.backends[0].models, [{ provider: 'local-ollama-abc', model: 'llama3.2', label: 'Start a session with llama3.2' }]);
  assert.equal(card.backends[0].next, null);
  assert.match(card.backends[1].healthText, /^Not running\. Nothing is answering/);
  assert.match(card.backends[1].next.text, /LM Studio/);
  assert.equal(card.defaultProvider, 'local-ollama-abc');
  assert.deepEqual(card.picker, [{ provider: 'local-ollama-abc', label: 'llama3.2 · Ollama (this computer)' }]);

  const empty = localModelCard({ endpoints: [{ id: 'ollama', label: 'Ollama', kind: 'ollama', source: 'discovered', reachable: true, error: null }], models: [], detected: [] });
  assert.equal(empty.backends[0].health, 'no-models');
  assert.deepEqual(empty.backends[0].next, { text: 'Pull a model first, for example:', command: 'ollama pull llama3.2' });
  assert.match(empty.headline, /no models yet/);

  const none = localModelCard({ endpoints: [], models: [], detected: [{ id: 'ollama', label: 'Ollama', kind: 'ollama', reachable: false, error: 'Nothing is answering on port 11434. Ollama is not running.' }] });
  assert.equal(none.backends[0].next.command, 'ollama serve');
  assert.match(none.headline, /No local model server is running/);
  assert.equal(none.defaultProvider, null);
  assert.deepEqual(localModelCard(null).backends, []);
});

test('createLocalModels reports every fixed loopback port in detected, answering or not', async () => {
  const adapters = {};
  const probe = async (e) => (e.id === 'ollama' ? { reachable: true, models: ['llama3.2'], error: null } : { reachable: false, models: [], error: 'down' });
  const lm = createLocalModels({ adapters, config: {}, probe });
  const o = await lm.refresh();
  assert.deepEqual(o.detected.map((d) => [d.id, d.reachable]), [['ollama', true], ['lmstudio', false], ['local-8000', false], ['local-8888', false]]);
  const card = localModelCard(o);
  assert.equal(card.picker.length, 1);
  assert.equal(adapters[card.defaultProvider].model, 'llama3.2');
});

test('custom endpoint validation: loopback, LAN and host names typed by the person; public IPs and junk refused', () => {
  const ok = (url, extra = {}) => validateEndpointInput({ label: 'Box', url, kind: 'openai', ...extra });
  assert.equal(ok('http://127.0.0.1:8080/').lan, false);
  assert.equal(ok('http://127.0.0.1:8080/').endpoint.url, 'http://127.0.0.1:8080');
  assert.equal(ok('http://192.168.1.20:8080').lan, true);
  assert.equal(ok('http://100.95.1.2:11434').ok, true);
  assert.equal(ok('https://gpu-box.local:8443/v1').endpoint.url, 'https://gpu-box.local:8443/v1');
  assert.equal(ok('http://8.8.8.8:80').ok, false);
  assert.match(ok('http://8.8.8.8').error, /not on this computer, your local network or your tailnet/);
  assert.match(ok('ftp://127.0.0.1').error, /http:\/\/ or https:\/\//);
  assert.match(ok('http://u:p@127.0.0.1').error, /user name and password/);
  assert.match(ok('http://127.0.0.1/?k=1').error, /\? and #/);
  assert.match(ok('not a url').error, /not a valid address/);
  assert.match(ok('http://169.254.169.254').error, /not on this computer/);
  assert.match(validateEndpointInput({ label: '', url: 'http://127.0.0.1', kind: 'openai' }).error, /name/);
  assert.match(validateEndpointInput({ label: 'x', url: 'http://127.0.0.1', kind: 'gpt' }).error, /Ollama or OpenAI/);
  assert.match(ok('http://127.0.0.1', { apiKey: 'has space' }).error, /API key/);
  assert.equal(ok('http://127.0.0.1').endpoint.id, 'custom-box');
  assert.equal(validateEndpointInput({ label: 'Box', url: 'http://127.0.0.1', kind: 'openai' }, { existing: [{ id: 'custom-box' }] }).endpoint.id, 'custom-box-2');
  assert.match(validateEndpointInput({ id: 'custom-gone', label: 'Box', url: 'http://127.0.0.1', kind: 'openai' }).error, /no longer saved/);
});

test('custom endpoint store: the API key goes to secure storage, never to local-models.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-store-'));
  const file = path.join(dir, 'local-models.json'), keysFile = path.join(dir, 'local-model-keys.json');
  fs.writeFileSync(file, JSON.stringify({ discovery: true, endpoints: [{ id: 'hand', url: 'http://127.0.0.1:9', kind: 'ollama' }] }));
  const secure = { available: () => true, encrypt: (t) => Buffer.from(`enc:${t}`), decrypt: (b) => b.toString().replace(/^enc:/, '') };
  const store = createEndpointStore({ file, keysFile, secure });
  const r = store.save({ id: null, label: 'GPU box', url: 'http://192.168.1.20:8000', kind: 'openai', apiKey: 'sk-secret-123', clearKey: false });
  assert.equal(r.ok, true); assert.equal(r.lan, true);
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /sk-secret-123/);
  const cfg = JSON.parse(raw);
  assert.equal(cfg.discovery, true); assert.equal(cfg.endpoints[0].id, 'hand');
  assert.deepEqual(cfg.endpoints[1], { id: 'custom-gpu-box', label: 'GPU box', url: 'http://192.168.1.20:8000', kind: 'openai', custom: true, apiKeyStored: true });
  assert.doesNotMatch(fs.readFileSync(keysFile, 'utf8'), /sk-secret-123/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keysFile).mode & 0o777, 0o600);
  assert.equal(store.secretFor('custom-gpu-box'), 'sk-secret-123');
  assert.deepEqual(store.list(), [{ id: 'custom-gpu-box', label: 'GPU box', url: 'http://192.168.1.20:8000', kind: 'openai', keyStored: true, lan: true }]);

  // Edit without a key keeps it; clearKey forgets it.
  assert.equal(store.save({ id: 'custom-gpu-box', label: 'GPU', url: 'http://192.168.1.20:8000', kind: 'openai', apiKey: null, clearKey: false }).endpoint.keyStored, true);
  assert.equal(store.save({ id: 'custom-gpu-box', label: 'GPU', url: 'http://192.168.1.20:8000', kind: 'openai', apiKey: null, clearKey: true }).endpoint.keyStored, false);
  assert.equal(store.secretFor('custom-gpu-box'), null);

  // No secure storage: a key is refused and nothing changes.
  const before = fs.readFileSync(file, 'utf8');
  const locked = createEndpointStore({ file, keysFile, secure: { available: () => false } });
  assert.match(locked.save({ id: null, label: 'Other', url: 'http://127.0.0.1:8001', kind: 'openai', apiKey: 'k', clearKey: false }).error, /Secure storage is unavailable/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  // The stored key reaches the endpoint as a bearer token through createLocalModels.
  store.save({ id: 'custom-gpu-box', label: 'GPU', url: 'http://127.0.0.1:8000', kind: 'openai', apiKey: 'sk-2', clearKey: false });
  const seen = [];
  const lm = createLocalModels({ adapters: {}, configFile: file, discovery: [], secretFor: store.secretFor, probe: async (e, opts) => { seen.push([e.id, e.apiKeyStored, opts.secretFor?.(e.id)]); return { reachable: true, models: [], error: null }; } });
  await lm.refresh();
  assert.deepEqual(seen.find((s) => s[0] === 'custom-gpu-box'), ['custom-gpu-box', true, 'sk-2']);

  assert.equal(store.remove('custom-gpu-box').ok, true);
  assert.equal(store.list().length, 0);
  assert.equal(JSON.parse(fs.readFileSync(keysFile, 'utf8'))['custom-gpu-box'], undefined);
  assert.equal(store.remove('hand').ok, false, 'hand-written endpoints are not removed from the card');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sessions show the model: widget card, directory row', () => {
  const card = sessionCard({ sessionId: 's1', cwd: '/x/proj', signal: 'tool', tool: 'Read', model: 'llama3.2' }, { now: 0 });
  assert.equal(card.model, 'llama3.2');
  assert.match(card.state, /llama3\.2$/);
  assert.equal(sessionCard({ sessionId: 's2', cwd: '/x/p', signal: 'tool' }).model, null);
  const mine = createSessionDirectory({ now: () => 0 }).mine({ work: [], meta: new Map(), owned: [{ state: { session: '11111111-1111-4111-8111-111111111111', generation: 1, provider: { id: 'local-ollama-abc', label: 'llama3.2 · Ollama (this computer)', model: 'llama3.2' }, ownership: 'plexiform-owned', label: 'Started by Plexiform', status: 'ready', activeTurn: null, capabilities: {}, deliveries: [], board: null }, leaf: null }], shares: [] });
  const row = mine.find((e) => e.provider?.id === 'local-ollama-abc');
  assert.ok(row, 'owned local session is listed');
  assert.equal(row.provider.model, 'llama3.2');
  assert.equal(row.provider.kind, 'local');
});

test('interaction IPC: card on local-models, endpoint save/remove only from the foreground Overview', async () => {
  const { createInteractionMain } = require('../src/interaction-main');
  const contents = { id: 1, mainFrame: {}, isDestroyed: () => false, send() {} };
  const ctx = { contents, generation: 1, document: 1, foreground: true };
  const calls = [];
  const store = { list: () => [{ id: 'custom-a' }], save: (r) => { calls.push(['save', r]); return { ok: true, endpoint: { id: 'custom-a' }, lan: false }; }, remove: (id) => { calls.push(['remove', id]); return { ok: true }; }, secretFor: () => null };
  let refreshed = 0;
  const local = { refresh: async (o) => { if (o?.force) refreshed++; return { endpoints: [], models: [], detected: [{ id: 'ollama', label: 'Ollama', kind: 'ollama', reachable: false, error: 'down' }], checkedAt: 1 }; } };
  const main = createInteractionMain({ context: () => (ctx.foreground ? ctx : null), readContext: () => ctx, adapters: {}, owned: null, workspace: () => null, localModels: local, endpointStore: store });
  const handlers = new Map();
  main.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const e = { sender: contents, senderFrame: contents.mainFrame };
  const o = await handlers.get('interaction:local-models')(e);
  assert.equal(o.card.backends[0].health, 'not-running');
  assert.deepEqual(await handlers.get('interaction:local-endpoints')(e), [{ id: 'custom-a' }]);
  assert.equal((await handlers.get('interaction:local-endpoint-save')(e, { label: 'a' })).ok, true);
  assert.equal(refreshed, 1);
  ctx.foreground = false;
  assert.equal((await handlers.get('interaction:local-endpoint-remove')(e, { id: 'custom-a' })).status, 'forbidden');
  ctx.foreground = true;
  assert.equal((await handlers.get('interaction:local-endpoint-remove')(e, { id: 'custom-a' })).ok, true);
  assert.deepEqual(calls, [['save', { label: 'a' }], ['remove', 'custom-a']]);
  assert.equal((await handlers.get('interaction:local-endpoints')({ sender: {}, senderFrame: {} })), null);
  assert.equal((await main.detectLocalModels()).card.headline, 'No local model server is running. Start Ollama or LM Studio to use a model on this computer.');
  main.close();
});
