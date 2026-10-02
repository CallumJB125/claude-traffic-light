'use strict';
// Private main construction only. This wrapper supplies no CLI, filesystem
// writer or guessed native implementation. ROOT must supply the separately
// reviewed signed native adapter and its current attestation/receipt verifier.
const { closed, canonical, SHA, hash } = require('./index-verify');
const path = require('node:path');
const J = require('./journal-codec');
const adapters = new WeakSet();
const KINDS = Object.freeze(['inventory', 'stage', 'install-disabled', 'inspect', 'restore', 'journal-create', 'journal-append', 'journal-read', 'journal-list']);
const fail = () => { throw new Error('Native plugin adapter is unavailable'); };
function observation(value) {
  if (!closed(value, ['profile_root', 'platform', 'os_user', 'generation', 'foreground', 'host_hash', 'account']) || typeof value.profile_root !== 'string' || value.profile_root.length > 4096 || !value.profile_root.startsWith('/') || value.profile_root === '/' || /[\p{C}]/u.test(value.profile_root) || path.posix.normalize(value.profile_root) !== value.profile_root || value.platform !== 'darwin' || typeof value.os_user !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.os_user) || !Number.isSafeInteger(value.generation) || value.generation < 0 || value.foreground !== true || !SHA.test(value.host_hash ?? '')) fail();
  const a = value.account;
  if (a !== null && (!closed(a, ['user_id', 'team_id', 'member_id', 'device_id', 'generation']) || ![a.user_id, a.team_id, a.member_id, a.device_id].every(x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(x)) || !Number.isSafeInteger(a.generation) || a.generation < 0)) fail();
  return JSON.parse(canonical(value));
}
function createNativePluginAdapter(options) {
  if (!closed(options, ['observe', 'attest', 'begin', 'verifyReceipt', 'wrapping'], ['fixture']) || !['observe', 'attest', 'begin', 'verifyReceipt'].every(k => typeof options[k] === 'function') || !options.wrapping || !['available', 'wrap', 'unwrap'].every(k => typeof options.wrapping[k] === 'function') || (options.fixture !== undefined && options.fixture !== true)) fail();
  const fixture = options.fixture === true;
  const api = Object.freeze({
    fixture,
    observe() {
      const attested = options.attest();
      if (!closed(attested, ['kind', 'protocol', 'helper_hash', 'roots_hash', 'current']) || attested.kind !== (fixture ? 'synthetic-plugin-fixture' : 'darwin-native-plugin') || attested.protocol !== 1 || !SHA.test(attested.helper_hash ?? '') || !SHA.test(attested.roots_hash ?? '') || attested.current !== true) fail();
      return observation(options.observe());
    },
    begin(kind, input, guard, cutoff) {
      if (!KINDS.includes(kind) || typeof guard !== 'function' || guard() !== true || !Number.isFinite(cutoff)) fail();
      api.observe();
      // These requests are minted by the transaction controller, never IPC.
      const ticket = options.begin(Object.freeze({ kind, input: copyInput(input), cutoff }), guard);
      if (!closed(ticket, ['result', 'cancel', 'exited', 'reaped']) || !ticket.result || typeof ticket.result.then !== 'function' || !ticket.reaped || typeof ticket.reaped.then !== 'function' || typeof ticket.cancel !== 'function' || typeof ticket.exited !== 'function') fail();
      return ticket;
    },
    verifyReceipt(kind, value, input) {
      return KINDS.includes(kind) && options.verifyReceipt(kind, value, input) === true;
    },
    wrapping: options.wrapping,
  });
  adapters.add(api); return api;
}
function copyInput(value, depth = 0) {
  if (depth > 40) fail();
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return Object.freeze(value.map(item => copyInput(item, depth + 1)));
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail();
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyInput(v, depth + 1)])));
  }
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return value;
  fail();
}
function isNativePluginAdapter(value) { return adapters.has(value); }
function inspection(value) {
  if (!closed(value, ['status', 'package_hash', 'cache_hash', 'config_enabled', 'foreign_hash', 'receipt_hash', 'owned', 'live_dependents']) || !['exact', 'changed', 'missing', 'unknown'].includes(value.status) || ![value.package_hash, value.cache_hash, value.foreign_hash, value.receipt_hash].every(v => SHA.test(v ?? '')) || typeof value.config_enabled !== 'boolean' || typeof value.owned !== 'boolean' || !Number.isSafeInteger(value.live_dependents) || value.live_dependents < 0 || value.live_dependents > 1000) fail();
  return JSON.parse(canonical(value));
}
function inventory(value) {
  if (!closed(value, ['items', 'receipt_hash']) || !SHA.test(value.receipt_hash ?? '') || !Array.isArray(value.items) || value.items.length > 1000) fail();
  const identities = new Set();
  for (const item of value.items) {
    if (!closed(item, ['metadata', 'inspection'])) fail(); J.metadataValid(item.metadata); inspection(item.inspection);
    const id = item.metadata.descriptor.name + '@' + item.metadata.marketplace;
    if (identities.has(id)) fail(); identities.add(id);
  }
  return JSON.parse(canonical(value));
}
module.exports = { KINDS, createNativePluginAdapter, isNativePluginAdapter, observation, inspection, inventory, identityHash: hash };
