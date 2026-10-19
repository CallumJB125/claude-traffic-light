'use strict';
// Custom OpenAI-compatible / Ollama endpoints the person adds in the Local
// models card (plan "more features" wave 2, lane 7). Endpoints go into
// local-models.json (the file src/local-models.js already reads); an API key
// never does: it is encrypted with the OS secure storage
// (buddy-window/secure-storage.js) into local-model-keys.json, 0600, and is
// only decrypted in main when a request to that endpoint needs it.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net'); // privacy-flow: local-models
const { addressAllowed, DISCOVERY } = require('./local-models');

const MAX = 16;
const KINDS = ['openai', 'ollama'];
const LOOPBACK = (host) => host === 'localhost' || host === '::1' || /^127\./.test(host);

// → { ok, endpoint, lan } or { ok:false, error } in plain words.
function validateEndpointInput(input, { existing = [] } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!input || typeof input !== 'object') return fail('Fill in the endpoint details.');
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > 60) return fail('Give it a name of up to 60 characters.');
  if (!KINDS.includes(input.kind)) return fail('Choose Ollama or OpenAI-compatible.');
  const raw = typeof input.url === 'string' ? input.url.trim() : '';
  if (!raw || raw.length > 300) return fail('Enter the server address, for example http://127.0.0.1:8080.');
  let u;
  try { u = new URL(raw); } catch { return fail('That is not a valid address. It should look like http://127.0.0.1:8080.'); }
  if (!['http:', 'https:'].includes(u.protocol)) return fail('The address must start with http:// or https://.');
  if (u.username || u.password) return fail('Leave the user name and password out of the address; use the API key field.');
  if (u.search || u.hash) return fail('Leave ? and # parts out of the address.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !addressAllowed(host)) return fail('That address is not on this computer, your local network or your tailnet. Plexiform only adds those here.');
  if (!net.isIP(host) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host)) return fail('That host name is not valid.');
  const key = input.apiKey == null ? '' : String(input.apiKey);
  if (key.length > 400 || /[\s\0]/.test(key)) return fail('The API key looks wrong: no spaces, at most 400 characters.');
  let id = typeof input.id === 'string' && input.id ? input.id : null;
  if (id && !existing.some((e) => e.id === id)) return fail('That endpoint is no longer saved. Refresh and try again.');
  if (!id) {
    const base = `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'endpoint'}`;
    const taken = new Set([...existing.map((e) => e.id), ...DISCOVERY.map((e) => e.id)]);
    id = base; for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  }
  const url = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  return { ok: true, endpoint: { id, label, url, kind: input.kind }, apiKey: key || null, clearKey: input.clearKey === true, lan: !LOOPBACK(host) };
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const readJson = (file) => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

// secure: createSecureStorage(safeStorage) — encrypt(text) → Buffer, decrypt(Buffer) → text, available().
function createEndpointStore({ file, keysFile, secure }) {
  const cache = new Map();
  const config = () => readJson(file);
  const endpoints = () => (Array.isArray(config().endpoints) ? config().endpoints : []).filter((e) => e && typeof e === 'object' && typeof e.id === 'string');
  const list = () => endpoints().filter((e) => e.custom === true).map((e) => ({ id: e.id, label: e.label, url: e.url, kind: e.kind, keyStored: e.apiKeyStored === true, lan: (() => { try { return !LOOPBACK(new URL(e.url).hostname.replace(/^\[|\]$/g, '')); } catch { return true; } })() }));
  function save(input) {
    const all = endpoints();
    const v = validateEndpointInput(input, { existing: all.filter((e) => e.custom === true) });
    if (!v.ok) return v;
    const old = all.find((e) => e.id === v.endpoint.id);
    if (!old && all.length >= MAX) return { ok: false, error: `At most ${MAX} endpoints can be saved.` };
    const keys = readJson(keysFile);
    let stored = old?.apiKeyStored === true && !v.clearKey;
    if (v.apiKey) {
      if (!secure?.available?.()) return { ok: false, error: 'Secure storage is unavailable, so the API key cannot be saved. Nothing was changed.' };
      keys[v.endpoint.id] = secure.encrypt(v.apiKey).toString('base64');
      stored = true;
    } else if (!stored) delete keys[v.endpoint.id];
    const entry = { ...v.endpoint, custom: true, ...(stored ? { apiKeyStored: true } : {}) };
    const next = { ...config(), endpoints: old ? all.map((e) => (e.id === entry.id ? entry : e)) : [...all, entry] };
    writePrivate(keysFile, keys);
    writePrivate(file, next);
    cache.delete(entry.id);
    return { ok: true, endpoint: list().find((e) => e.id === entry.id), lan: v.lan };
  }
  function remove(id) {
    const all = endpoints();
    if (typeof id !== 'string' || !all.some((e) => e.id === id && e.custom === true)) return { ok: false, error: 'That endpoint is no longer saved.' };
    const keys = readJson(keysFile);
    delete keys[id];
    writePrivate(keysFile, keys);
    writePrivate(file, { ...config(), endpoints: all.filter((e) => e.id !== id) });
    cache.delete(id);
    return { ok: true };
  }
  // Main-only: the decrypted key for one endpoint, or null.
  function secretFor(id) {
    if (cache.has(id)) return cache.get(id);
    const b64 = readJson(keysFile)[id];
    let key = null;
    if (typeof b64 === 'string' && b64) { try { key = secure.decrypt(Buffer.from(b64, 'base64')); } catch { key = null; } }
    cache.set(id, key);
    return key;
  }
  return { list, save, remove, secretFor };
}

module.exports = { validateEndpointInput, createEndpointStore };
