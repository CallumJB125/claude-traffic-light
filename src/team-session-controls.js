'use strict';
// A review token is authority for one exact inspected session generation/turn,
// never a provider identifier or permission supplied by the renderer.
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[0-9a-f]{40}$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const fail = (status, error) => ({ ok: false, status, error });
const STALE = 'This session or turn changed. Review its current activity before acting.';
const UNKNOWN = 'The view changed while sending. Inspect the receipt before sending again; the provider may have acted.';
const validState = s => object(s) && Number.isSafeInteger(s.generation) && s.generation >= 0
  && (s.activeTurn === null || typeof s.activeTurn === 'string' && UUID.test(s.activeTurn))
  && ['ready', 'working', 'compacting', 'ended'].includes(s.status) && object(s.capabilities) && Array.isArray(s.deliveries);

function createTeamSessionControls({ resolve, current = () => true, actionCurrent = current, now = Date.now }) {
  const selections = new Map();
  const pending = new Set();
  let epoch = 0;
  const alive = generation => generation === epoch && current() === true;
  const targetCurrent = target => { try { return typeof target?.isCurrent !== 'function' || target.isCurrent() === true; } catch { return false; } };
  const same = (a, b) => a && b && a.hub === b.hub && a.viewer.id === b.viewer.id && a.team === b.team && a.ref === b.ref && a.scope === b.scope;
  const capabilities = (target, s) => {
    const canAct = target.scope === 'interact', live = s.status !== 'ended';
    const available = (yes, reason) => ({ available: yes === true, reason: yes ? '' : reason });
    const why = reason => !canAct ? 'Shared with you to watch only.' : !live ? 'This session has ended.' : reason;
    return {
      send: available(canAct && live && s.status === 'ready' && s.activeTurn === null && s.capabilities.newTurn !== false, why('A turn is running. Steer it where supported, or wait for it to finish.')),
      steer: available(canAct && live && s.status === 'working' && s.activeTurn !== null && s.capabilities.steer === true, why(s.capabilities.steer ? 'No current turn is available to steer.' : 'This provider does not support steering a running turn.')),
      interrupt: available(canAct && live && s.status === 'working' && s.activeTurn !== null && s.capabilities.interrupt === true, why(s.capabilities.interrupt ? 'No current turn is available to interrupt.' : 'This provider does not support interruption.')),
    };
  };
  async function inspect(request) {
    if (!closed(request, ['id']) || typeof request.id !== 'string' || !ID.test(request.id)) return fail('invalid', 'Choose a shared session.');
    const generation = epoch;
    if (!alive(generation)) return fail('stale', STALE);
    let target, out;
    try {
      target = await resolve(request.id, false);
      if (!alive(generation)) return fail('stale', STALE);
      if (!target?.hub || typeof target.hub.inspect !== 'function') return target?.error ? target : fail('unsupported', 'This session uses its board task inbox. Open its card or use Message.');
      out = await target.hub.inspect(target.viewer, target.team, target.ref);
    } catch { return fail('unavailable', 'The shared session could not be read.'); }
    if (!alive(generation) || !targetCurrent(target)) return fail('stale', STALE);
    if (!out?.ok) return out ?? fail('unavailable', 'The shared session could not be read.');
    if (!validState(out.state)) return fail('unavailable', 'The shared session returned an unreadable state.');
    const selection = crypto.randomUUID();
    selections.set(selection, { id: request.id, target, generation: out.state.generation, turn: out.state.activeTurn, expires: now() + 45_000 });
    for (const [key, value] of selections) if (value.expires < now()) selections.delete(key);
    while (selections.size > 300) selections.delete(selections.keys().next().value);
    return { ok: true, status: 'ready', selection, state: out.state, capabilities: capabilities(target, out.state) };
  }
  // A main-owned caller may impose a narrower grant lifetime. It never comes
  // from the renderer request, and must remain current through every await and
  // the host's final dispatch check, rather than borrowing this token's TTL.
  async function action(request, { current: grantCurrent = () => true } = {}) {
    const grantValid = () => { try { return grantCurrent() === true; } catch { return false; } };
    if (!closed(request, ['selection', 'operation', 'text']) || typeof request.selection !== 'string' || !UUID.test(request.selection)
      || !['send', 'steer', 'interrupt'].includes(request.operation) || typeof request.text !== 'string' || request.text.includes('\0')
      || (request.operation === 'interrupt' ? request.text !== '' : !request.text.trim() || request.text.trim().length > 4000 || Buffer.byteLength(request.text.trim()) > 8192)) return fail('invalid', 'Check the selected action and message.');
    const selected = selections.get(request.selection), generation = epoch;
    if (!selected || selected.expires < now() || !alive(generation) || !actionCurrent() || !grantValid()) return fail('stale', STALE);
    // Consume before the first await. A double-click or replay cannot dispatch twice.
    selections.delete(request.selection);
    if ([...pending].some(target => same(target, selected.target))) return fail('busy', 'An action on this session is awaiting a receipt. Inspect it before sending again.');
    const lock = selected.target;
    pending.add(lock);
    try {
    const fresh = () => alive(generation) && actionCurrent() === true && grantValid() && selected.expires >= now() && targetCurrent(selected.target);
    let target, state;
    try {
      target = await resolve(selected.id, true);
      if (!fresh() || !same(selected.target, target)) return fail('stale', STALE);
      if (target.scope !== 'interact') return fail('forbidden', 'Shared with you to watch only.');
      if (typeof target.hub.act !== 'function') return fail('unsupported', 'This session has no live action channel.');
      const out = await target.hub.inspect(target.viewer, target.team, target.ref);
      if (!fresh()) return fail('stale', STALE);
      if (!out?.ok) return out ?? fail('unavailable', 'The shared session could not be read.');
      state = out.state;
      if (!validState(state) || state.generation !== selected.generation || state.activeTurn !== selected.turn) return fail('stale', STALE);
      const cap = capabilities(target, state)[request.operation];
      if (!cap.available) return fail('unavailable', cap.reason);
    } catch { return fail('unavailable', 'The shared session could not be checked.'); }
    if (!fresh()) return fail('stale', STALE);
    let out;
    try {
      out = await target.hub.act(target.viewer, target.team, target.ref, {
        operation: request.operation, generation: selected.generation, turn: selected.turn,
        ...(request.operation === 'interrupt' ? {} : { text: request.text.trim() }),
      }, crypto.randomUUID(), fresh);
    } catch { return fail('unconfirmed', 'No receipt yet. The provider may have acted. Inspect this session before sending again.'); }
    // Never leak a reply into a retired document/account, or invite a retry
    // merely because focus changed after a request may have reached the host.
    if (!fresh()) return fail('unconfirmed', UNKNOWN);
    return object(out) ? out : fail('unconfirmed', 'No receipt yet. Inspect this session before sending again.');
    } finally { pending.delete(lock); }
  }
  return { inspect, action, invalidate() { epoch++; selections.clear(); } };
}

module.exports = { createTeamSessionControls };
