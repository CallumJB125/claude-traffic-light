'use strict';
// Local-model adapters for the session interaction contract. A local-model
// session is a conversation Plexiform owns: the backend (vLLM, LM Studio,
// llama.cpp server, litellm via the OpenAI chat API, or Ollama's native API)
// is stateless, so Plexiform keeps the bounded history and replays it each turn.
//
// Network policy: only loopback, RFC1918 and Tailscale (100.64/10,
// fd7a:115c:a1e0::/48) addresses are reachable by default. Anything else needs
// `allowPublic: true` on that endpoint in the user's config. Hostnames are
// resolved once and the connection is pinned to the checked address (no DNS
// rebinding); redirects are never followed. Discovery probes only fixed
// loopback ports, read-only. API keys are never stored: an endpoint may name
// an environment variable (`apiKeyEnv`) that is read at request time.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const http = require('node:http'); // privacy-flow: local-models
const https = require('node:https'); // privacy-flow: local-models
const dns = require('node:dns'); // privacy-flow: local-models
const net = require('node:net'); // privacy-flow: local-models

const LIMITS = Object.freeze({
  headersMs: 60_000, idleMs: 60_000, turnMs: 10 * 60_000, probeMs: 1500,
  responseBytes: 1024 * 1024, lineBytes: 256 * 1024, probeBytes: 256 * 1024,
  historyMessages: 40, historyBytes: 64 * 1024, targets: 16, modelsPerEndpoint: 32, endpoints: 16,
});
const KINDS = ['openai', 'ollama'];
const MAX_ENTRIES = 128;
// Fixed loopback ports for read-only discovery; nothing on the LAN is scanned.
const DISCOVERY = Object.freeze([
  { id: 'ollama', label: 'Ollama (this computer)', url: 'http://127.0.0.1:11434', kind: 'ollama' },
  { id: 'lmstudio', label: 'LM Studio (this computer)', url: 'http://127.0.0.1:1234', kind: 'openai' },
  { id: 'local-8000', label: 'OpenAI-compatible :8000 (this computer)', url: 'http://127.0.0.1:8000', kind: 'openai' },
  { id: 'local-8888', label: 'OpenAI-compatible :8888 (this computer)', url: 'http://127.0.0.1:8888', kind: 'openai' },
]);

const ALLOWED = new net.BlockList();
for (const [a, p] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]]) ALLOWED.addSubnet(a, p, 'ipv4');
ALLOWED.addAddress('::1', 'ipv6'); ALLOWED.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
// Never reachable, even with opt-in: unspecified, link-local (cloud metadata), multicast.
const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['255.255.255.255', 32]]) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2002::', 16], ['::ffff:0:0:0', 96]]) BLOCKED.addSubnet(a, p, 'ipv6');
// IPv4-compatible ::a.b.c.d (everything in ::/96 except ::1 loopback) can carry a metadata address.
BLOCKED.addRange('::2', '::ffff:ffff', 'ipv6');

function addressAllowed(address, allowPublic = false) {
  const ip = String(address).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  const family = net.isIP(ip);
  if (!family) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (BLOCKED.check(ip, type)) return false;
  return allowPublic === true || ALLOWED.check(ip, type);
}

class RefusedError extends Error {}
function parseEndpointUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new RefusedError('Invalid endpoint URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new RefusedError('Unsupported endpoint URL');
  return u;
}
// Resolve once, check every address, then pin the socket to the checked one.
async function resolvePinned(u, allowPublic, lookup = dns.promises.lookup) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { throw new RefusedError('Endpoint host did not resolve'); }
  }
  if (!addresses.length || !addresses.every((a) => addressAllowed(a.address, allowPublic))) throw new RefusedError('Endpoint is not on this computer, your local network or your tailnet');
  return addresses[0];
}

// One HTTP exchange under the policy: no redirects, headers timeout, abortable.
async function openRequest(url, { method = 'GET', headers = {}, body = null, allowPublic = false, headersMs = LIMITS.headersMs, signal, lookup } = {}) {
  const u = parseEndpointUrl(url);
  const pinned = await resolvePinned(u, allowPublic, lookup);
  if (signal?.aborted) throw new Error('aborted');
  return new Promise((resolve, reject) => {
    const pin = (_h, opts, cb) => (opts?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family));
    const req = (u.protocol === 'https:' ? https : http).request({ // privacy-flow: local-models
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname,
      method, agent: false, lookup: pin,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    });
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v); };
    const onAbort = () => { req.destroy(); done(reject, new Error('aborted')); };
    const timer = setTimeout(() => { req.destroy(); done(reject, new Error('Endpoint did not answer in time')); }, headersMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => done(reject, e instanceof RefusedError ? e : new Error('Endpoint connection failed')));
    req.on('response', (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); req.destroy(); return done(reject, new RefusedError('Endpoint redirect refused')); }
      if (res.statusCode !== 200) { res.destroy(); return done(reject, new Error(`Endpoint answered HTTP ${res.statusCode}`)); }
      done(resolve, { res, req });
    });
    req.end(body ?? undefined);
  });
}

// `ms` is a deadline over the whole body: a server that sends headers and then drips bytes cannot hold the read open.
async function readCapped(res, max, ms = 0) {
  let size = 0; const chunks = [];
  const timer = ms ? setTimeout(() => res.destroy(new Error('Endpoint read timed out')), ms) : null;
  try {
    for await (const c of res) { size += c.length; if (size > max) { res.destroy(); throw new Error('Response too large'); } chunks.push(c); }
  } finally { clearTimeout(timer); }
  return Buffer.concat(chunks).toString('utf8');
}
function apiBase(endpoint) {
  const base = endpoint.url.replace(/\/+$/, '');
  return endpoint.kind === 'openai' && !/\/v1$/.test(base) ? `${base}/v1` : base;
}
function authHeaders(endpoint, env) {
  const key = endpoint.apiKeyEnv ? env[endpoint.apiKeyEnv] : null;
  return typeof key === 'string' && key ? { authorization: `Bearer ${key}` } : {};
}

// Read-only model listing with a short timeout.
async function probeEndpoint(endpoint, { env = process.env, limits = LIMITS, lookup } = {}) {
  const url = endpoint.kind === 'ollama' ? `${apiBase(endpoint)}/api/tags` : `${apiBase(endpoint)}/models`;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), limits.probeMs);
  try {
    const { res } = await openRequest(url, { headers: { accept: 'application/json', ...authHeaders(endpoint, env) }, allowPublic: endpoint.allowPublic === true, headersMs: limits.probeMs, signal: ctl.signal, lookup });
    const body = JSON.parse(await readCapped(res, limits.probeBytes, limits.probeMs));
    const raw = endpoint.kind === 'ollama' ? body?.models?.map((m) => m?.name ?? m?.model) : body?.data?.map((m) => m?.id);
    const models = [...new Set((Array.isArray(raw) ? raw : []).filter((m) => typeof m === 'string' && m && m.length <= 200))].slice(0, limits.modelsPerEndpoint);
    return { reachable: true, models, error: null };
  } catch (e) {
    return { reachable: false, models: [], error: e instanceof RefusedError ? e.message : 'Not reachable' };
  } finally { clearTimeout(t); }
}

// Line framing for SSE (OpenAI) and NDJSON (Ollama). Returns per-line results.
function streamParser(kind) {
  return (line) => {
    if (kind === 'ollama') {
      const o = JSON.parse(line);
      if (o?.error) return { error: String(o.error) };
      return { text: typeof o?.message?.content === 'string' ? o.message.content : '', done: o?.done === true };
    }
    if (line.startsWith(':') || /^(event|id|retry):/.test(line)) return { text: '' };
    if (!line.startsWith('data:')) throw new Error('malformed');
    const data = line.slice(5).trim();
    if (data === '[DONE]') return { text: '', done: true };
    const o = JSON.parse(data);
    if (o?.error) return { error: String(o.error.message ?? o.error) };
    const c = o?.choices?.[0];
    return { text: typeof c?.delta?.content === 'string' ? c.delta.content : '', finished: typeof c?.finish_reason === 'string' };
  };
}

// One adapter per endpoint+model. `profile` may be updated by the registry.
function createLocalModelAdapter({ profile, model, label, env = process.env, now = Date.now, limits = LIMITS, lookup }) {
  const events = new EventEmitter();
  const targets = new Map();
  let stopped = false;
  const emit = (e) => events.emit('event', e);

  function trim(history) {
    const bytes = () => history.reduce((n, m) => n + Buffer.byteLength(m.content), 0);
    while (history.length > limits.historyMessages || (history.length > 2 && bytes() > limits.historyBytes)) history.splice(0, 2);
    // The last pair is always kept, but one huge reply must not push the replayed history past the byte limit.
    for (let guard = 0; bytes() > limits.historyBytes && guard < 8; guard++) {
      const big = history.reduce((a, m) => (Buffer.byteLength(m.content) > Buffer.byteLength(a.content) ? m : a), history[0]);
      const over = bytes() - limits.historyBytes;
      big.content = Buffer.from(big.content).subarray(0, Math.max(256, Buffer.byteLength(big.content) - over)).toString('utf8');
    }
  }
  function release(target, kind = 'closed') {
    const t = targets.get(target);
    if (!t) return;
    t.busy?.ctl.abort(); targets.delete(target);
    if (kind) emit({ kind, target });
  }
  function open() {
    if (stopped) throw new Error('Local model adapter stopped');
    const target = `local-${crypto.randomUUID()}`;
    targets.set(target, { history: [], busy: null, lastUsed: null });
    // Bounded: evict the oldest idle conversation (it reports closed).
    if (targets.size > limits.targets) { const old = [...targets].find(([, t]) => !t.busy); if (old) release(old[0]); }
    return Promise.resolve({ target });
  }

  async function send({ target, text, expectedTurnId = null }) {
    const t = targets.get(target);
    if (stopped || !t) throw new Error('Unknown conversation');
    if (expectedTurnId) throw new Error('Local models cannot be steered');
    if (t.busy) throw new Error('A turn is running');
    const p = adapter.profile;
    const turnId = crypto.randomUUID(), ctl = new AbortController();
    const user = { role: 'user', content: text };
    const messages = [...(p.system ? [{ role: 'system', content: p.system }] : []), ...t.history, user];
    const url = p.kind === 'ollama' ? `${apiBase(p)}/api/chat` : `${apiBase(p)}/chat/completions`;
    const body = JSON.stringify({ model, messages, stream: true });
    t.busy = { turnId, ctl };
    let res;
    try {
      ({ res } = await openRequest(url, { method: 'POST', body, headers: { accept: p.kind === 'ollama' ? 'application/x-ndjson' : 'text/event-stream', ...authHeaders(p, env) }, allowPublic: p.allowPublic === true, headersMs: limits.headersMs, signal: ctl.signal, lookup }));
    } catch (e) { if (t.busy?.turnId === turnId) t.busy = null; throw e; }
    if (targets.get(target) !== t || t.busy?.turnId !== turnId) { res.destroy(); throw new Error('Conversation closed'); }
    t.lastUsed = now();
    emit({ kind: 'turn-started', target, turnId });
    consume({ t, target, turnId, ctl, res, user, kind: p.kind });
    return { turnId, mode: 'new-turn' };
  }

  function consume({ t, target, turnId, ctl, res, user, kind }) {
    const parse = streamParser(kind);
    const json = kind === 'openai' && /application\/json/i.test(res.headers['content-type'] ?? '');
    let buffer = '', total = 0, reply = '', complete = false, ended = false, idle = null;
    const finish = (status, error = null) => {
      if (ended) return; ended = true;
      clearTimeout(idle); clearTimeout(turnTimer); ctl.signal.removeEventListener('abort', onAbort); res.destroy();
      if (t.busy?.turnId === turnId) t.busy = null;
      if (status === 'completed' && targets.get(target) === t) { t.history.push(user, { role: 'assistant', content: reply }); trim(t.history); }
      emit({ kind: 'turn-completed', target, turnId, status, error });
    };
    const onAbort = () => finish('interrupted');
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => finish('failed', 'The model stopped responding'), limits.idleMs); };
    const turnTimer = setTimeout(() => finish('failed', 'The turn took too long'), limits.turnMs);
    ctl.signal.addEventListener('abort', onAbort, { once: true });
    const line = (raw) => {
      const l = raw.replace(/\r$/, '');
      if (!l.trim()) return;
      let r;
      try { r = parse(l); } catch { return finish('failed', 'The model sent a malformed stream'); }
      if (r.error) return finish('failed', r.error.slice(0, 300));
      if (r.text) { reply += r.text; emit({ kind: 'delta', target, turnId, text: r.text }); }
      if (r.finished) complete = true;
      if (r.done) { complete = true; finish('completed'); }
    };
    arm();
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      if (ended) return;
      total += Buffer.byteLength(chunk);
      if (total > limits.responseBytes) return finish('failed', 'The response was too large');
      arm();
      buffer += chunk;
      if (json) return;
      let nl;
      while (!ended && (nl = buffer.indexOf('\n')) >= 0) { const l = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); line(l); }
      if (!ended && Buffer.byteLength(buffer) > limits.lineBytes) finish('failed', 'The model sent a malformed stream');
    });
    res.on('end', () => {
      if (ended) return;
      if (json) {
        // A server that ignored stream:true answers with one completion.
        let text = null;
        try { text = JSON.parse(buffer)?.choices?.[0]?.message?.content; } catch { /* malformed */ }
        if (typeof text !== 'string') return finish('failed', 'The model sent a malformed reply');
        reply = text; emit({ kind: 'message', target, turnId, text });
        return finish('completed');
      }
      if (buffer.trim()) line(buffer);
      if (!ended) finish(complete ? 'completed' : 'failed', complete ? null : 'The stream ended early');
    });
    res.on('error', () => finish('failed', 'The connection to the model was lost'));
  }

  async function interrupt({ target, turnId }) {
    const t = targets.get(target);
    if (!t?.busy || t.busy.turnId !== turnId) throw new Error('No such running turn');
    t.busy.ctl.abort();
    return true;
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const id of [...targets.keys()]) release(id, null);
    emit({ kind: 'exit' });
  }

  const adapter = {
    provider: 'local-model', label, model, profile,
    capabilities: Object.freeze({ newTurn: true, steer: false, interrupt: true, ack: 'http-stream', echo: 'none', stream: true, existingSessions: false }),
    // release: the hub ended this session; drop its history without a 'closed' event.
    open, send, interrupt, stop, release: ({ target }) => release(target, null),
    conversations: () => targets.size,
    on: (fn) => { events.on('event', fn); return () => events.off('event', fn); },
    alive: () => !stopped,
    idle: () => targets.size === 0,
    lastUsed: () => Math.max(0, ...[...targets.values()].map((t) => t.lastUsed ?? 0)) || null,
  };
  return adapter;
}

// Endpoint config: { discovery?: boolean, endpoints?: [{ id, label?, url, kind, apiKeyEnv?, allowPublic?, system? }] }
function validEndpoint(e) {
  if (!e || typeof e !== 'object' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(e.id) || !KINDS.includes(e.kind) || typeof e.url !== 'string' || e.url.length > 300) return null;
  try { parseEndpointUrl(e.url); } catch { return null; }
  if (e.label != null && (typeof e.label !== 'string' || e.label.length > 60)) return null;
  if (e.system != null && (typeof e.system !== 'string' || e.system.length > 4000)) return null;
  if (e.apiKeyEnv != null && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(e.apiKeyEnv)) return null;
  return { id: e.id, label: e.label || e.id, url: e.url, kind: e.kind, apiKeyEnv: e.apiKeyEnv ?? null, allowPublic: e.allowPublic === true, system: e.system ?? '' };
}
function readConfig(file) {
  if (!file) return {};
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; }
}

// Registers one interaction adapter per reachable endpoint+model into the
// shared `adapters` map (provider id `local-<endpoint>-<hash>`), keeps the same
// adapter object across refreshes so live conversations keep their history.
function createLocalModels({ adapters, configFile = null, config = null, discovery = DISCOVERY, env = process.env, now = Date.now, limits = LIMITS, lookup, probe = probeEndpoint, maxAgeMs = 15_000 } = {}) {
  const entries = new Map(); // provider id -> { adapter, endpoint, model, source, listed }
  const status = new Map();  // endpoint id -> { endpoint, source, reachable, error, checkedAt }
  let refreshing = null, checkedAt = 0;

  function endpointsNow() {
    const c = config ?? readConfig(configFile);
    const configured = (Array.isArray(c.endpoints) ? c.endpoints : []).map(validEndpoint).filter(Boolean).slice(0, limits.endpoints);
    const seen = new Set(configured.map((e) => e.id)), urls = new Set(configured.map((e) => e.url.replace(/\/+$/, '')));
    const found = c.discovery === false ? [] : discovery.filter((e) => !seen.has(e.id) && !urls.has(e.url)).map((e) => ({ ...validEndpoint(e), source: 'discovered' }));
    return [...configured.map((e) => ({ ...e, source: 'configured' })), ...found];
  }
  const providerId = (endpoint, model) => `local-${endpoint.id}-${crypto.createHash('sha256').update(model).digest('hex').slice(0, 10)}`;

  async function run() {
    const list = endpointsNow();
    const results = await Promise.all(list.map((e) => probe(e, { env, limits, lookup })));
    const ids = new Set(list.map((e) => e.id));
    for (const id of status.keys()) if (!ids.has(id)) status.delete(id);
    for (const entry of entries.values()) entry.listed = false;
    let added = 0;
    list.forEach((endpoint, i) => {
      const r = results[i];
      status.set(endpoint.id, { endpoint, source: endpoint.source, reachable: r.reachable, error: r.error, checkedAt: now() });
      for (const model of r.models) {
        const id = providerId(endpoint, model);
        let entry = entries.get(id);
        if (!entry) {
          // A hostile endpoint listing fresh names forever cannot grow the registry without bound.
          if (entries.size + added >= MAX_ENTRIES) continue;
          added++;
          const label = `${model} · ${endpoint.label}`.slice(0, 120);
          const adapter = createLocalModelAdapter({ profile: endpoint, model, label, env, now, limits, lookup });
          entry = { adapter, model };
          Object.defineProperty(adapter, 'available', { enumerable: true, get: () => entry.listed && status.get(entry.endpoint.id)?.reachable === true });
          Object.defineProperty(adapter, 'reason', { enumerable: true, get: () => (status.get(entry.endpoint.id)?.reachable ? 'Model no longer listed' : 'Not reachable') });
          entries.set(id, entry);
          adapters[id] = adapter;
        }
        entry.endpoint = endpoint; entry.adapter.profile = endpoint; entry.listed = true;
      }
    });
    // Models an endpoint no longer lists are dropped once nothing is using them.
    for (const [id, entry] of [...entries]) {
      // Only when the endpoint answered without listing the model; an unreachable endpoint keeps its models, reported unavailable.
      if (!entry.listed && status.get(entry.endpoint.id)?.reachable === true && entry.adapter.idle()) { entries.delete(id); delete adapters[id]; try { entry.adapter.stop?.(); } catch { /* idle */ } }
    }
    checkedAt = now();
    return overview();
  }
  function refresh({ force = false } = {}) {
    if (!force && checkedAt && now() - checkedAt < maxAgeMs) return Promise.resolve(overview());
    refreshing ??= run().finally(() => { refreshing = null; });
    return refreshing;
  }
  // For Overview: no URLs' credentials, no keys; only whether a key env is set.
  function overview() {
    const endpoints = [...status.values()].filter((s) => s.source === 'configured' || s.reachable).map((s) => ({
      id: s.endpoint.id, label: s.endpoint.label, kind: s.endpoint.kind, source: s.source, reachable: s.reachable, error: s.error, checkedAt: s.checkedAt,
      host: parseEndpointUrl(s.endpoint.url).host, publicOptIn: s.endpoint.allowPublic, keyFromEnv: s.endpoint.apiKeyEnv ? { name: s.endpoint.apiKeyEnv, set: !!env[s.endpoint.apiKeyEnv], plainHttp: /^http:/i.test(s.endpoint.url) && !/^http:\/\/(127\.|\[::1\]|localhost)/i.test(s.endpoint.url) } : null,
    }));
    const models = [...entries].filter(([, e]) => status.has(e.endpoint.id)).map(([provider, e]) => ({
      provider, model: e.model, endpoint: e.endpoint.id, endpointLabel: e.endpoint.label, reachable: e.adapter.available, lastUsed: e.adapter.lastUsed(),
    }));
    return { endpoints, models, checkedAt };
  }
  return { refresh, overview };
}

module.exports = { createLocalModels, createLocalModelAdapter, probeEndpoint, openRequest, addressAllowed, DISCOVERY, LIMITS };
