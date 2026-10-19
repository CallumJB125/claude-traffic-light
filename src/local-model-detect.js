'use strict';
// Auto-detect for local models (plan "more features" wave 2, lane 7). Pure:
// the caller injects `fetch` and the clock. It asks only the fixed loopback
// endpoints in DISCOVERY for their model list, with a short timeout, and never
// probes any other host on its own; a LAN endpoint is probed only when the
// person typed it (src/local-models.js, configured endpoints).
//
// An endpoint that keeps failing the same way is asked less often
// (src/probe-backoff.js): 15 s doubling to 5 min. A success or a different
// failure starts again at 15 s.
const { createProbeBackoff } = require('./probe-backoff');
const { DISCOVERY } = require('./local-models');

const TIMEOUT_MS = 1500;
const MAX_MODELS = 32;
const MAX_BYTES = 256 * 1024;

function isLoopbackUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === 'http:' && !u.username && !u.password && u.hostname === '127.0.0.1';
}

const portOf = (url) => { try { return new URL(url).port || '80'; } catch { return '?'; } };
const appName = (e) => (e.id === 'ollama' ? 'Ollama' : e.id === 'lmstudio' ? 'LM Studio' : 'An OpenAI-compatible server');

// A failure in words a person can act on.
function plainError(err, endpoint, timeoutMs) {
  const code = err?.cause?.code || err?.code;
  if (code === 'ECONNREFUSED') return `Nothing is answering on port ${portOf(endpoint.url)}. ${appName(endpoint)} is not running.`;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || code === 'ETIMEDOUT') return `It did not answer within ${+(timeoutMs / 1000).toFixed(2)} seconds.`;
  if (err?.status) return `It answered with an error (HTTP ${err.status}).`;
  if (err?.badBody) return 'It answered, but not with a model list.';
  return `Could not reach port ${portOf(endpoint.url)} on this computer.`;
}

// One read-only probe → { endpoint, reachable, models[], error }.
async function detectEndpoint(endpoint, { fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const out = (reachable, models, error) => ({ endpoint: { id: endpoint.id, label: endpoint.label, url: endpoint.url, kind: endpoint.kind }, reachable, models, error });
  if (!isLoopbackUrl(endpoint.url)) return out(false, [], 'Only this computer (127.0.0.1) is checked automatically.');
  const base = endpoint.url.replace(/\/+$/, '');
  const url = endpoint.kind === 'ollama' ? `${base}/api/tags` : `${/\/v1$/.test(base) ? base : `${base}/v1`}/models`;
  try {
    const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); // privacy-flow: local-models
    if (res.status !== 200) throw Object.assign(new Error('http'), { status: res.status });
    let body;
    try {
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('large');
      body = JSON.parse(text);
    } catch { throw Object.assign(new Error('body'), { badBody: true }); }
    const raw = endpoint.kind === 'ollama' ? body?.models?.map((m) => m?.name ?? m?.model) : body?.data?.map((m) => m?.id);
    if (!Array.isArray(raw)) throw Object.assign(new Error('body'), { badBody: true });
    const models = [...new Set(raw.filter((m) => typeof m === 'string' && m && m.length <= 200))].slice(0, MAX_MODELS);
    return out(true, models, null);
  } catch (e) {
    return out(false, [], plainError(e, endpoint, timeoutMs));
  }
}

// Keeps the last result per endpoint and skips a probe its backoff says is not due.
function createDetector({ fetch, now = Date.now, endpoints = DISCOVERY, timeoutMs = TIMEOUT_MS, base = 15_000, max = 5 * 60_000 } = {}) {
  const loopback = endpoints.filter((e) => isLoopbackUrl(e.url));
  const state = new Map(loopback.map((e) => [e.id, { backoff: createProbeBackoff({ base, max }), last: null }]));
  async function probe(endpoint, { force = false } = {}) {
    const s = state.get(endpoint.id);
    if (!s || !isLoopbackUrl(endpoint.url)) return detectEndpoint(endpoint, { fetch, timeoutMs });
    if (!force && s.last && !s.backoff.due(now())) return s.last;
    const r = await detectEndpoint(endpoint, { fetch, timeoutMs });
    s.backoff.probed(r.reachable ? { ok: true } : { ok: false, why: r.error }, now());
    s.last = r;
    return r;
  }
  return {
    probe,
    detectAll: ({ force = false } = {}) => Promise.all(loopback.map((e) => probe(e, { force }))),
    last: () => loopback.map((e) => state.get(e.id).last).filter(Boolean),
    gap: (id) => state.get(id)?.backoff.gap ?? null,
  };
}

module.exports = { detectEndpoint, createDetector, isLoopbackUrl, plainError, TIMEOUT_MS };
