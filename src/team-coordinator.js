'use strict';
// Human-reviewed assignments, not an autonomous agent or a new authority path.
// The directory supplies explicitly shared targets; every effect still consumes
// a generation/turn-bound review from the existing team-session controls.
// Proposals and one-use grants belong to the current Overview document only.
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEAM = /^[0-9a-f]{32}$/, ENTRY = /^[0-9a-f]{40}$/;
const REVIEW_MS = 30_000, RETAIN_MS = 10 * 60_000, MAX_ASSIGNMENTS = 6;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const validString = (v, max) => typeof v === 'string' && !!v.trim() && v.trim().length <= max && !/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const message = v => validString(v, 4000) && Buffer.byteLength(v.trim()) <= 8192;
const fail = (status, error) => ({ ok: false, status, error });
const STALE = 'The team or session changed. Check current sessions and review a new proposal.';
const safeText = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';

function createTeamCoordinator({ inventory: readInventory, inspect, action, current = () => true, actionCurrent = current, now = Date.now }) {
  const proposals = new Map();
  let epoch = 0;
  const permitted = effect => { try { return current() === true && (!effect || actionCurrent() === true); } catch { return false; } };
  const alive = (at, effect = false) => at === epoch && permitted(effect);
  const prune = () => {
    for (const [id, p] of proposals) if (p.createdAt + RETAIN_MS < now() && p.status !== 'dispatching') proposals.delete(id);
    while (proposals.size >= 25) {
      const old = [...proposals].find(([, p]) => p.status !== 'dispatching');
      if (!old) break;
      proposals.delete(old[0]);
    }
  };
  function target(entry) {
    return { id: entry.id, owner: safeText(entry.owner?.name, 200), provider: safeText(entry.provider?.label, 200), task: safeText(entry.task?.title, 400), device: safeText(entry.device?.label, 200) };
  }
  const signature = e => JSON.stringify([target(e), e.provider?.id, e.interact?.kind, e.scope, e.teams?.map(t => t.key)]);
  function reason(e, d) {
    if (!e || e.kind !== 'shared' || e.scope !== 'team' || !e.teams?.some(t => t.key === d.team.key)) return 'Choose a session explicitly shared with this team.';
    if (e.messageContract === 'task-inbox') return 'This run uses its task inbox. Message it from its card.';
    if (e.freshness !== 'recent' || !Number.isFinite(e.observedAt) || e.observedAt > now() || now() - e.observedAt > 90_000) return 'This session report is stale. Check its current activity.';
    if (e.interact?.kind !== 'team' || e.capabilities?.receive?.available !== true) return safeText(e.capabilities?.receive?.reason, 600) || 'The owner has not shared a supported send channel.';
    return '';
  }
  async function directory(team, at) {
    let d;
    try { d = await readInventory({ team }); } catch { return null; }
    if (!alive(at) || !object(d) || d.schema !== 1 || d.view !== 'team' || d.status !== 'complete' || !Array.isArray(d.entries)
      || !Number.isFinite(d.observed_at) || d.observed_at > now() || now() - d.observed_at > 90_000
      || !d.team || !TEAM.test(d.team.key) || team !== null && d.team.key !== team) return null;
    return d;
  }
  async function inventory(request) {
    if (!closed(request, ['team']) || !(request.team === null || typeof request.team === 'string' && TEAM.test(request.team))) return fail('invalid', 'Choose a team.');
    let at = epoch;
    if (!alive(at)) return fail('stale', STALE);
    let d = await directory(request.team, at);
    // Discovering the first selected team can itself retire the old empty
    // route. This read has no proposal or dispatch to preserve; read once
    // through the newly adopted route rather than requiring a second click.
    if (!d && at !== epoch && permitted(false)) { at = epoch; d = await directory(request.team, at); }
    if (!d) return fail('unavailable', 'The complete current team directory is unavailable. Refresh Team sessions.');
    return { ok: true, status: 'ready', team: { key: d.team.key, name: safeText(d.team.name, 200) }, observedAt: d.observed_at,
      entries: d.entries.filter(e => ENTRY.test(e?.id)).map(e => ({ ...target(e), state: safeText(e.state, 80), available: reason(e, d) === '', reason: reason(e, d) })) };
  }
  function project(p, masked = new Set()) {
    return { ok: true, status: p.status, proposal: p.id, title: p.title, team: { ...p.team }, expiresAt: p.expiresAt,
      assignments: p.assignments.map(a => masked.has(a.id) ? { assignment: a.id, name: a.name, target: null, text: '', status: 'unavailable', reason: 'This session is no longer shared with you.', receipt: null, response: '', grant: null }
        : { assignment: a.id, name: a.name, target: { ...a.target }, text: a.text, status: a.status, reason: a.reason, receipt: a.receipt ? { ...a.receipt } : null, response: a.response,
          grant: a.grant ? { operation: 'send', expiresAt: a.grant.expiresAt, state: a.grant.state } : null }) };
  }
  async function propose(request) {
    if (!closed(request, ['team', 'title', 'assignments']) || typeof request.team !== 'string' || !TEAM.test(request.team) || !validString(request.title, 120)
      || !Array.isArray(request.assignments) || request.assignments.length < 1 || request.assignments.length > MAX_ASSIGNMENTS
      || request.assignments.some(a => !closed(a, ['id', 'name', 'text']) || typeof a.id !== 'string' || !ENTRY.test(a.id) || !validString(a.name, 80) || /[\r\n]/.test(a.name) || !message(a.text))
      || new Set(request.assignments.map(a => a.id)).size !== request.assignments.length || new Set(request.assignments.map(a => a.name.trim().toLowerCase())).size !== request.assignments.length) return fail('invalid', 'Name up to six different session assignments and write their exact messages.');
    const at = epoch;
    if (!alive(at)) return fail('stale', STALE);
    const d = await directory(request.team, at);
    if (!d) return fail('stale', STALE);
    const createdAt = now(), assignments = [];
    for (const input of request.assignments) {
      const e = d.entries.find(e => e.id === input.id);
      if (!e) return fail('stale', STALE);
      let why = reason(e, d), read = null;
      if (!why) {
        try { read = await inspect({ id: e.id }); } catch { /* no provider effect */ }
        if (!alive(at)) return fail('stale', STALE);
        if (!read?.ok || !UUID.test(read.selection) || read.state?.status !== 'ready' || read.state?.activeTurn !== null || read.capabilities?.send?.available !== true) why = safeText(read?.capabilities?.send?.reason || read?.error, 600) || 'This session is busy or its live send channel is unavailable.';
      }
      assignments.push({ id: crypto.randomUUID(), entry: e.id, name: input.name.trim(), text: input.text.trim(), target: target(e), signature: signature(e), selection: why ? null : read.selection,
        status: why ? 'blocked' : 'review', reason: why, receipt: null, response: '', grant: null });
    }
    if (!alive(at) || createdAt + REVIEW_MS < now()) return fail('stale', STALE);
    prune();
    const p = { id: crypto.randomUUID(), title: request.title.trim(), team: { key: d.team.key, name: safeText(d.team.name, 200) }, createdAt, expiresAt: createdAt + REVIEW_MS, assignments, status: 'review' };
    proposals.set(p.id, p);
    return project(p);
  }
  async function confirm(request) {
    if (!closed(request, ['proposal', 'grants']) || !UUID.test(request.proposal) || !Array.isArray(request.grants) || !request.grants.length || request.grants.length > MAX_ASSIGNMENTS
      || request.grants.some(g => !closed(g, ['assignment', 'operation']) || !UUID.test(g.assignment) || g.operation !== 'send')
      || new Set(request.grants.map(g => g.assignment)).size !== request.grants.length) return fail('invalid', 'Approve the named assignments you reviewed.');
    const at = epoch, p = proposals.get(request.proposal);
    if (!p || p.status !== 'review' || p.expiresAt < now() || !alive(at, true)) return fail('stale', STALE);
    const chosen = request.grants.map(g => p.assignments.find(a => a.id === g.assignment));
    if (chosen.some(a => !a || a.status !== 'review' || !a.selection)) return fail('invalid', 'Only available reviewed assignments can be approved.');
    // Consume before the first await; a repeated click cannot reuse a grant.
    p.status = 'dispatching';
    for (const a of p.assignments) if (a.status === 'review') a.status = chosen.includes(a) ? 'checking' : 'not-selected';
    const d = await directory(p.team.key, at);
    for (const a of chosen) {
      const e = d?.entries.find(e => e.id === a.entry);
      const fresh = () => alive(at, true) && p.expiresAt >= now();
      if (!fresh() || !e || reason(e, d) || signature(e) !== a.signature) {
        a.status = 'refused'; a.reason = STALE; a.selection = null; continue;
      }
      a.grant = { expiresAt: p.expiresAt, state: 'used' };
      let result;
      try { result = await action({ selection: a.selection, operation: 'send', text: a.text }, { current: fresh }); }
      catch { result = fail('unconfirmed', 'No receipt yet. The provider may have acted; do not resend automatically.'); }
      a.selection = null;
      if (!alive(at, true)) { a.status = 'unconfirmed'; a.reason = 'The view changed after dispatch may have started. Inspect the session before sending again.'; continue; }
      const receipt = result?.delivery;
      if (result?.ok === true && object(receipt) && validString(receipt.id, 100)) {
        a.status = 'sent'; a.reason = ''; a.receipt = { id: receipt.id, state: safeText(receipt.state, 80) || 'unknown' };
        // Only a later exact-receipt inspection supplies comparison output.
      } else { a.status = ['stale', 'forbidden', 'busy', 'unavailable', 'invalid'].includes(result?.status) ? 'refused' : 'unconfirmed'; a.reason = safeText(result?.error, 600) || 'No correlated receipt was returned. Inspect the session before sending again.'; }
    }
    p.status = 'sent';
    return alive(at) ? project(p) : fail('unconfirmed', 'The view changed. Inspect the sessions before sending again.');
  }
  async function results(request) {
    if (!closed(request, ['proposal']) || !UUID.test(request.proposal)) return fail('invalid', 'Choose a proposal.');
    const at = epoch, p = proposals.get(request.proposal);
    if (!p || p.createdAt + RETAIN_MS < now() || !alive(at)) return fail('stale', STALE);
    const d = await directory(p.team.key, at);
    if (!d) return fail('stale', STALE);
    const masked = new Set();
    for (const a of p.assignments) {
      const e = d.entries.find(e => e.id === a.entry);
      if (!e || signature(e) !== a.signature || e.kind !== 'shared') { masked.add(a.id); a.response = ''; continue; }
      if (!a.receipt) continue;
      let read;
      try { read = await inspect({ id: a.entry }); } catch { /* keep receipt, never retry */ }
      if (!alive(at)) return fail('stale', STALE);
      if (!read?.ok) { masked.add(a.id); a.response = ''; continue; }
      const delivery = read.state?.deliveries?.find(d => d.id === a.receipt.id);
      a.response = delivery ? safeText(delivery.response, 16000) : '';
      if (delivery) a.receipt.state = safeText(delivery.state, 80) || 'unknown';
      a.reason = delivery ? '' : 'The correlated receipt is no longer in this session’s reported history. Open its activity to inspect it.';
    }
    return alive(at) ? project(p, masked) : fail('stale', STALE);
  }
  function cancel(request) {
    if (!closed(request, ['proposal']) || !UUID.test(request.proposal)) return fail('invalid', 'Choose a proposal.');
    const p = proposals.get(request.proposal);
    if (!permitted(true) || !p || p.status !== 'review') return fail('stale', 'This proposal has already been used or retired.');
    proposals.delete(p.id);
    return { ok: true, status: 'cancelled' };
  }
  return { inventory, propose, confirm, results, cancel, invalidate() { epoch++; proposals.clear(); } };
}
module.exports = { createTeamCoordinator, REVIEW_MS, MAX_ASSIGNMENTS };
