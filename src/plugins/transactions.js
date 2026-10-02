'use strict';
// Main-only transaction kernel. No filesystem writer, Codex CLI invocation,
// renderer authority or provider connection is implemented here.
const crypto = require('node:crypto'), path = require('node:path');
const { closed, canonical, hash, compatible } = require('./index-verify');
const { readBounded } = require('./source-verify');
const A = require('./native-adapter-contract'), J = require('./journal-codec');
const queues = new Map(), unobserved = new Set(), MAX_HANDLES = 32, TTL = 10 * 60 * 1000, BUDGET = 60000, REAP = 250;
const unavailable = reason => ({ ok: false, status: 'unavailable', reason });
const fail = () => { throw new Error('Plugin transaction is unavailable'); };
const clone = value => JSON.parse(canonical(value));
function ownedHash(v) { return hash({ status: v.status, package_hash: v.package_hash, cache_hash: v.cache_hash, config_enabled: v.config_enabled, owned: v.owned }); }
function exact(v, m) { return v.status === 'exact' && v.package_hash === m.descriptor.package_sha256 && v.config_enabled === m.enabled && v.owned === true; }
function reviewFiles(proof) {
  let bytes = 0; return proof.descriptor.files.map(file => {
    bytes += file.bytes; if (bytes > 1024 * 1024) fail();
    const read = readBounded(path.join(proof.source.root, file.path), 1024 * 1024);
    if (read.identity !== proof.source.files.find(f => f.path === file.path)?.identity || hash(read.bytes) !== file.sha256) fail();
    return { path: file.path, sha256: file.sha256, text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) };
  });
}
function createPluginTransactions(options = {}) {
  if (!closed(options, ['planner', 'adapter', 'confirm'], ['now', 'clock']) || typeof options.confirm !== 'function' || typeof options.planner?.plan !== 'function' || typeof options.planner?.takeForTransaction !== 'function') throw new Error('Private main dependencies are required');
  const { planner, adapter, confirm } = options, now = options.now ?? Date.now, clock = options.clock ?? (() => performance.now());
  if (typeof now !== 'function' || typeof clock !== 'function') fail();
  let generation = 0, closedState = false; const plans = new Map(), recoveries = new Map(), active = new Set();
  function pending() { for (const ticket of unobserved) { try { if (ticket.exited() === true) { unobserved.delete(ticket); active.delete(ticket); } } catch {} } return unobserved.size > 0; }
  function observe() { if (closedState || pending() || !A.isNativePluginAdapter(adapter)) fail(); return adapter.observe(); }
  function live(capture, token, proof = null) {
    try { return !closedState && token === generation && canonical(adapter.observe()) === canonical(capture) && (!proof || proof.current() === true); } catch { return false; }
  }
  const cutoff = () => clock() + BUDGET;
  async function wait(promise, end) {
    const remaining = end - clock(); if (remaining <= 0) fail(); let timer;
    try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Plugin deadline exceeded')), remaining); })]); }
    finally { clearTimeout(timer); }
  }
  // Crypto/confirmation promises have no native target writer. Still retain an
  // unresolved crypto wait in the same truthful renewal gate until it settles.
  async function cryptoWait(promise, guard, end, dispose = () => {}) {
    let settled = false, abandoned = false;
    const finished = Promise.resolve(promise).then(value => { if (abandoned) dispose(value); return value; }).finally(() => { settled = true; });
    const ticket = { exited: () => settled, cancel() {}, reaped: finished.catch(() => {}) }; active.add(ticket); unobserved.add(ticket);
    try { const value = await wait(finished, end); if (!guard()) { dispose(value); fail(); } return value; }
    catch (error) { abandoned = true; throw error; }
    finally { if (settled) { active.delete(ticket); unobserved.delete(ticket); } }
  }
  async function native(kind, input, guard, end) {
    if (!guard() || clock() >= end) fail(); const ticket = adapter.begin(kind, input, guard, end); active.add(ticket); unobserved.add(ticket);
    let value, error;
    try { value = await wait(ticket.result, end); if (!guard() || clock() >= end || !closed(value, ['receipt_hash', 'payload']) || !J.shaValid(value.receipt_hash) || adapter.verifyReceipt(kind, value, input) !== true) fail(); }
    catch (e) { error = e; }
    try { ticket.cancel(); } catch { error ??= new Error('Plugin cancellation failed'); }
    try { if (ticket.exited() !== true) await wait(ticket.reaped, Math.min(end, clock() + REAP)); } catch { error ??= new Error('Plugin exit was not observed'); }
    if (ticket.exited() === true) { active.delete(ticket); unobserved.delete(ticket); } else error ??= new Error('Plugin exit was not observed');
    if (error) throw error; if (!guard() || clock() >= end) fail(); return value;
  }
  async function serial(profile, guard, end, job) {
    const entry = queues.get(profile) ?? { tail: Promise.resolve(), pending: 0 }; if (entry.pending >= MAX_HANDLES) fail();
    queues.set(profile, entry); const previous = entry.tail; let release; entry.tail = new Promise(resolve => { release = resolve; }); entry.pending++;
    try { await wait(previous, end); if (!guard() || pending()) fail(); return await job(); }
    finally { // Do not release successors ahead of an unfinished predecessor.
      previous.finally(() => { release(); entry.pending--; if (!entry.pending && queues.get(profile) === entry) queues.delete(profile); });
    }
  }
  function prune() { for (const map of [plans, recoveries]) for (const [id, e] of map) if (e.expires <= now() || !live(e.capture, e.token, e.proof)) map.delete(id); }
  async function ask(kind, planHash, summary, guard) {
    const answer = await confirm(Object.freeze({ kind, plan_hash: planHash, summary: clone(summary) }));
    if (!guard() || !closed(answer, ['approved', 'plan_hash']) || answer.approved !== true || answer.plan_hash !== planHash) fail();
  }
  async function append(state, phase, receiptHash, guard, end) {
    const event = { phase, receipt_hash: receiptHash }, bytes = J.next(state, event);
    const result = await native('journal-append', { id: state.context.id, profile_hash: state.context.profile_hash, expected_previous: state.previous, sequence: state.sequence, bytes }, guard, end);
    if (!closed(result.payload, ['bytes_hash']) || result.payload.bytes_hash !== hash(bytes)) fail(); J.published(state, bytes, event);
  }
  async function inspect(metadata, guard, end) {
    const result = await native('inspect', { metadata: clone(metadata) }, guard, end), value = A.inspection(result.payload);
    if (value.receipt_hash !== result.receipt_hash) fail(); return value;
  }
  async function inventory(guard, end) {
    const result = await native('inventory', {}, guard, end), value = A.inventory(result.payload);
    if (value.receipt_hash !== result.receipt_hash) fail(); return value;
  }
  async function readJournal(id, profileHash, guard, end) {
    const result = await native('journal-read', { id, profile_hash: profileHash }, guard, end), p = result.payload;
    if (!closed(p, ['header', 'records', 'census_hash']) || !Buffer.isBuffer(p.header) || !Array.isArray(p.records) || p.records.length > J.LIMITS.events || !p.records.every(Buffer.isBuffer) || !J.shaValid(p.census_hash) || p.census_hash !== hash({ header: hash(p.header), records: p.records.map(hash) })) fail();
    return p;
  }
  async function unwrapJournal(id, capture, guard, end) {
    const profileHash = hash(capture.profile_root), data = await readJournal(id, profileHash, guard, end);
    const state = await cryptoWait(J.recover({ ...data, id, profile_hash: profileHash, wrapping: adapter.wrapping, current: guard }), guard, end, J.close);
    if (state.context.owner_hash !== hash({ profile: capture.profile_root, os_user: capture.os_user })) { J.close(state); fail(); }
    return { state, census_hash: data.census_hash };
  }
  function retained(id) { return { ok: false, status: 'needs_review', transaction_id: id, retained: true, reason: 'Effects or recovery publication are not verified; inspect the retained transaction.' }; }
  const api = {
    get pendingReap() { return pending(); },
    async plan(descriptorId, request = { operation: 'install', scope: 'user' }) {
      let capture, proof; const token = generation;
      try {
        capture = observe(); prune();
        if (!closed(request, ['operation', 'scope']) || !['install', 'update'].includes(request.operation) || request.scope !== 'user' || plans.size >= MAX_HANDLES) fail();
        const end = cutoff(), initialGuard = () => live(capture, token);
        const publicRead = await cryptoWait(planner.plan(descriptorId, { scope: 'user' }), initialGuard, end); if (!live(capture, token) || publicRead?.ok !== true) fail();
        proof = await cryptoWait(planner.takeForTransaction(publicRead.plan.id), initialGuard, end);
        if (!proof || !closed(proof, ['descriptor', 'source', 'binding', 'index_hash', 'expires_at', 'current', 'recheck']) || !J.shaValid(proof.index_hash) || !Number.isSafeInteger(proof.expires_at) || typeof proof.current !== 'function' || typeof proof.recheck !== 'function' || !live(capture, token, proof) || proof.binding.profile_root !== capture.profile_root || hash(proof.binding.host) !== capture.host_hash || canonical(proof.binding.account) !== canonical(capture.account) || proof.descriptor.components.mcp.length || !proof.descriptor.components.skills.length || ![proof.binding.config.sha256, proof.binding.cache.sha256, proof.binding.host.binary_sha256, proof.source.package_hash, proof.source.descriptor_hash].every(J.shaValid) || !proof.source.files.every(f => J.shaValid(f.sha256))) fail();
        const guard = () => live(capture, token, proof);
        const result = await serial(capture.profile_root, guard, end, async () => { if (!(await cryptoWait(proof.recheck(), guard, end)) || !guard()) fail(); const items = await inventory(guard, end); const files = reviewFiles(proof); if (!(await cryptoWait(proof.recheck(), guard, end)) || !guard()) fail(); return { items, files }; });
        const sameName = result.items.items.filter(i => i.metadata.descriptor.name === proof.descriptor.name); if (sameName.length > 1) fail();
        const old = sameName[0] ?? null;
        if (old && old.inspection.status === 'exact' && old.metadata.descriptor.package_sha256 === proof.descriptor.package_sha256) return { ok: true, status: 'already_present', owned_by_this_transaction: false, undo_available: false, install_available: false };
        if ((request.operation === 'install' && old) || (request.operation === 'update' && (!old || !exact(old.inspection, old.metadata)))) fail();
        if (old && (old.metadata.descriptor.components.mcp.length || old.metadata.descriptor.id !== proof.descriptor.id || old.metadata.descriptor.catalog_id !== proof.descriptor.catalog_id || old.metadata.descriptor.source.attribution !== proof.descriptor.source.attribution || old.metadata.descriptor.source.path !== proof.descriptor.source.path || old.metadata.descriptor.version === proof.descriptor.version || !compatible(proof.descriptor.version, old.metadata.descriptor.version))) fail();
        const after = { descriptor: clone(proof.descriptor), marketplace: `plexiform-${proof.descriptor.package_sha256.slice(0, 24)}`, enabled: false }; J.metadataValid(after);
        const dto = { operation: request.operation, name: after.descriptor.name, version: after.descriptor.version, source: after.descriptor.source.attribution, scope: 'user', disabled: true, wrapping_status: 'uninspected', package_hash: after.descriptor.package_sha256, index_hash: proof.index_hash, files: result.files, capabilities: [...after.descriptor.capabilities], before: old ? { version: old.metadata.descriptor.version, package_hash: old.metadata.descriptor.package_sha256, enabled: old.metadata.enabled } : null, config_review: { plugin: `${after.descriptor.name}@${after.marketplace}`, enabled: false }, expires_at: Math.min(proof.expires_at, now() + TTL) };
        const planHash = hash(dto), handle = crypto.randomUUID(); plans.set(handle, { capture, token, proof, after, before: old?.metadata ?? null, inventory_hash: hash(result.items), dto, plan_hash: planHash, expires: dto.expires_at });
        return { ok: true, status: 'review_required', fixture: adapter.fixture, install_available: true, plan: { handle, plan_hash: planHash, ...clone(dto) } };
      } catch { return unavailable('source-authority-or-native-adapter-unavailable'); }
    },
    async apply(handle, request) {
      const e = typeof handle === 'string' && J.uuidValid(handle) ? plans.get(handle) : null; if (e) plans.delete(handle);
      let id = null, state;
      try {
        observe(); if (!e || e.expires <= now() || !closed(request, ['plan_hash', 'reviewed_files', 'reviewed_config']) || request.plan_hash !== e.plan_hash || request.reviewed_files !== true || request.reviewed_config !== true || !live(e.capture, e.token, e.proof)) fail();
        const guard = () => live(e.capture, e.token, e.proof);
        await ask(e.before ? 'plugin-update' : 'plugin-install', e.plan_hash, e.dto, guard);
        const end = cutoff(); return await serial(e.capture.profile_root, guard, end, async () => {
          if (!(await cryptoWait(e.proof.recheck(), guard, end)) || !guard() || hash(await inventory(guard, end)) !== e.inventory_hash) fail();
          const context = { id: crypto.randomUUID(), profile_hash: hash(e.capture.profile_root), owner_hash: hash({ profile: e.capture.profile_root, os_user: e.capture.os_user }), plan_hash: e.plan_hash };
          const prepared = await cryptoWait(J.prepare({ context, manifest: { schema: 1, operation: e.before ? 'update' : 'install', created_at: now(), index_hash: e.proof.index_hash, after: e.after, before: e.before }, wrapping: adapter.wrapping, current: guard }), guard, end, value => J.close(value?.state)); state = prepared.state;
          // Only publication attempts may have an unknown durable effect. An
          // unavailable wrapping bridge has not created a recovery record.
          id = context.id;
          const created = await native('journal-create', { id, profile_hash: context.profile_hash, bytes: prepared.header }, guard, end);
          if (!closed(created.payload, ['bytes_hash']) || created.payload.bytes_hash !== hash(prepared.header)) fail();
          const staged = await native('stage', { id, after: e.after, before: e.before, source: e.proof.source }, guard, end);
          if (!closed(staged.payload, ['package_hash', 'backup_hash']) || staged.payload.package_hash !== e.after.descriptor.package_sha256 || (e.before ? staged.payload.backup_hash !== e.before.descriptor.package_sha256 : staged.payload.backup_hash !== null)) fail();
          await append(state, 'staged', staged.receipt_hash, guard, end);
          if (!(await cryptoWait(e.proof.recheck(), guard, end)) || !guard() || hash(await inventory(guard, end)) !== e.inventory_hash) fail();
          await append(state, 'install_intent', hash({ after: e.after, before: e.before, inventory: e.inventory_hash }), guard, end);
          const installed = await native('install-disabled', { id, after: e.after, before: e.before, expected_inventory: e.inventory_hash }, guard, end);
          if (!closed(installed.payload, ['package_hash', 'disabled']) || installed.payload.package_hash !== e.after.descriptor.package_sha256 || installed.payload.disabled !== true) fail();
          await append(state, 'observed', installed.receipt_hash, guard, end);
          const verified = await inspect(e.after, guard, end); if (!exact(verified, e.after)) fail();
          await append(state, 'verified', verified.receipt_hash, guard, end);
          return { ok: true, status: 'verified', transaction_id: id, disabled: true, fixture: adapter.fixture };
        });
      } catch { return id ? retained(id) : unavailable('expired-changed-denied-or-native-unavailable'); }
      finally { J.close(state); }
    },
    async listLocked() {
      try {
        const capture = observe(), token = generation, guard = () => live(capture, token), end = cutoff();
        const result = await native('journal-list', { profile_hash: hash(capture.profile_root) }, guard, end), p = result.payload;
        if (!closed(p, ['ids']) || !Array.isArray(p.ids) || p.ids.length > 1000 || new Set(p.ids).size !== p.ids.length || !p.ids.every(id => J.uuidValid(id))) fail();
        return { ok: true, status: 'locked', transactions: p.ids.map(id => ({ id, status: 'locked', undo_available: false })), fixture: adapter.fixture };
      } catch { return unavailable('native-adapter-or-locked-list-unavailable'); }
    },
    async recover(id) {
      let state;
      try {
        if (!J.uuidValid(id)) fail();
        const capture = observe(), token = generation; prune(); if (recoveries.size >= MAX_HANDLES) fail();
        const guard = () => live(capture, token), recoveryHash = hash({ id, profile_hash: hash(capture.profile_root), kind: 'plugin-recovery' });
        await ask('plugin-recovery', recoveryHash, { transaction_id: id, action: 'Inspect encrypted local recovery metadata and current owned targets.' }, guard);
        const end = cutoff(); return await serial(capture.profile_root, guard, end, async () => {
          const data = await unwrapJournal(id, capture, guard, end); state = data.state;
          const v = await inspect(state.manifest.after, guard, end);
          if (state.phase !== 'verified' || !exact(v, state.manifest.after)) return retained(id);
          const handle = crypto.randomUUID(), inspectionHash = hash({ id, previous: state.previous, owned: ownedHash(v) });
          const summary = { name: state.manifest.after.descriptor.name, version: state.manifest.after.descriptor.version, source: state.manifest.after.descriptor.source.attribution, before: state.manifest.before ? { version: state.manifest.before.descriptor.version, package_hash: state.manifest.before.descriptor.package_sha256, enabled: state.manifest.before.enabled } : null };
          recoveries.set(handle, { capture, token, id, previous: state.previous, owned_hash: ownedHash(v), inspection_hash: inspectionHash, summary, expires: now() + TTL });
          return { ok: true, status: 'inspected', fixture: adapter.fixture, recovery: { handle, transaction_id: id, inspection_hash: inspectionHash, ...summary, undo_available: true, expires_at: now() + TTL } };
        });
      } catch { return unavailable('recovery-denied-changed-or-native-unavailable'); } finally { J.close(state); }
    },
    async undo(handle, request) {
      const e = typeof handle === 'string' && J.uuidValid(handle) ? recoveries.get(handle) : null; if (e) recoveries.delete(handle); let state;
      try {
        observe(); if (!e || e.expires <= now() || !closed(request, ['inspection_hash']) || request.inspection_hash !== e.inspection_hash || !live(e.capture, e.token)) fail();
        const guard = () => live(e.capture, e.token);
        await ask('plugin-undo', e.inspection_hash, { transaction_id: e.id, ...e.summary, action: 'Conditionally restore only unchanged owned plugin targets, preserving current foreign bytes.' }, guard);
        const end = cutoff(); return await serial(e.capture.profile_root, guard, end, async () => {
          const data = await unwrapJournal(e.id, e.capture, guard, end); state = data.state;
          if (state.phase !== 'verified' || state.previous !== e.previous) fail();
          const fresh = await inspect(state.manifest.after, guard, end); if (!exact(fresh, state.manifest.after) || ownedHash(fresh) !== e.owned_hash) fail();
          await append(state, 'undo_intent', fresh.receipt_hash, guard, end);
          const result = await native('restore', { id: e.id, after: state.manifest.after, before: state.manifest.before, expected_receipt: fresh.receipt_hash, retain_marketplace: fresh.live_dependents > 0 }, guard, end);
          if (!closed(result.payload, ['restored', 'retained_marketplace']) || result.payload.restored !== true || typeof result.payload.retained_marketplace !== 'boolean' || (fresh.live_dependents > 0 && !result.payload.retained_marketplace)) fail();
          const verified = await inspect(state.manifest.before ?? state.manifest.after, guard, end);
          if (state.manifest.before ? !exact(verified, state.manifest.before) : verified.status !== 'missing') fail();
          await append(state, 'undone', verified.receipt_hash, guard, end);
          return { ok: true, status: 'undone', transaction_id: e.id, retained_marketplace: result.payload.retained_marketplace, fixture: adapter.fixture };
        });
      } catch { return e ? retained(e.id) : unavailable('expired-changed-denied-or-native-unavailable'); } finally { J.close(state); }
    },
    invalidate() { generation++; plans.clear(); recoveries.clear(); planner.invalidate?.(); for (const t of active) { try { t.cancel(); } catch {} } let available = false; try { available = A.isNativePluginAdapter(adapter) && !!adapter.observe(); } catch {} return available ? { ok: true, status: 'invalidated', pending_reap: pending() } : { ...unavailable('native-adapter-unavailable'), pending_reap: pending() }; },
    close() { closedState = true; const result = api.invalidate(); return result.ok ? { ok: true, status: 'closed', pending_reap: pending() } : result; },
  };
  return Object.freeze(api);
}
module.exports = { createPluginTransactions, ownedHash, BUDGET, REAP };
