'use strict';
// Keeps the remote interaction host (src/remote-interaction.js) matching the
// preference and the active team hub's sign-in. main.js calls sync() on every
// change (preference ticked or unticked, sign-in, sign-out, account switch).
//
// - The token the instance was built with is kept as a VALUE: after an account
//   switch the identity's token getter answers for the NEW account, so the old
//   instance's role reset must use the old one.
// - The old instance is disabled (role back to 'client') before the new one
//   enables, one change at a time, in order.
// - A role reset the hub never acknowledged (offline when unticked) is
//   retried with backoff while this process runs, and remembered in the
//   non-secret config ({origin, userId}, never the token) so the next start
//   resets it with that account's current sign-in.
// - release() (app quit) resets the role with a short bound, so a Mac that is
//   off does not leave a host slot open for its token.
// - attach(host, {origin, userId, token}) → {stop} (optional: session messaging)
//   runs only while a host is connected with the hub: it starts when the host
//   connects (also later, after retrying), stops when the host ends up
//   replaced, held, refused, signed out or off, and is stopped before that
//   host is disabled or closed. `token` is the identity's getter, so a
//   refreshed sign-in is picked up.

const STOPPED = new Set(['replaced', 'held', 'refused', 'signed-out', 'off']);
const RESET = { baseMs: 2000, maxMs: 5 * 60_000, timeoutMs: 5000, quitTimeoutMs: 1500 };

function createInteractionHostSync({
  want, identity, createHost, connect, resetRole, fetch, attach = null,
  pending: { get: getPending, set: setPending }, log = () => {}, timers = { setTimeout, clearTimeout }, reset = {},
}) {
  const R = { ...RESET, ...reset };
  let current = null; // {host, origin, userId, token}
  let key = null;
  let chain = Promise.resolve();
  let retry = null;   // {timer, origin, userId, token, attempts}
  let started = false;

  const keyOf = (id) => (id ? `${id.origin}\n${id.userId}` : null);
  const same = (a, b) => a && b && a.origin === b.origin && a.userId === b.userId;

  function cancelRetry() { if (retry) { timers.clearTimeout(retry.timer); retry = null; } }

  // A reset the hub did not take: keep trying with the sign-in it was for.
  function owe(target) {
    setPending({ origin: target.origin, userId: target.userId });
    cancelRetry();
    retry = { ...target, attempts: 0, timer: null };
    arm();
  }
  function arm() {
    const r = retry;
    const wait = Math.min(R.maxMs, R.baseMs * 2 ** Math.min(r.attempts, 16));
    r.timer = timers.setTimeout(async () => {
      if (retry !== r) return;
      r.attempts++;
      const ok = await resetRole({ baseUrl: r.origin, token: r.token, fetch, timeoutMs: R.timeoutMs }).catch(() => false);
      if (retry !== r) return;
      if (ok) { retry = null; setPending(null); log('[remote-interaction] hosting turned off on the hub'); return; }
      arm();
    }, wait);
    r.timer?.unref?.();
  }

  function detach(c) { const a = c?.attached; if (c) c.attached = null; try { a?.stop(); } catch (e) { log(`[remote-interaction] ${e.message}`); } }

  async function stop(prev) {
    detach(prev);
    const ok = await prev.host.disable({ baseUrl: prev.origin, token: prev.token, fetch, timeoutMs: R.timeoutMs }).catch(() => false);
    prev.host.close();
    if (!ok) owe(prev);
  }

  // Next start: a reset owed from last time, with that account's sign-in now.
  function settlePending(id) {
    const p = getPending();
    if (!p) return;
    const now = identity();
    if (!now || now.origin !== p.origin) return; // not the active hub yet: try when it is
    if (now.userId !== p.userId) { setPending(null); return; } // that sign-in was signed out (revoked)
    if (same(id, p)) { setPending(null); return; } // hosting again: enable sets the role
    const token = now.token();
    if (token) owe({ origin: p.origin, userId: p.userId, token });
  }

  function sync() {
    let id = null;
    try { id = want() ? identity() : null; } catch { id = null; }
    const k = keyOf(id);
    if (k === key && started) return chain;
    started = true;
    key = k;
    const prev = current;
    current = null;
    let token = null;
    try { token = id ? id.token() : null; } catch { token = null; }
    if (id && token) {
      // Hosting this sign-in again: an older reset for it is moot.
      if (retry && same(retry, id)) { cancelRetry(); setPending(null); }
      current = { host: createHost(id), origin: id.origin, userId: id.userId, token };
    }
    const next = current;
    const follow = (st) => {
      if (!attach || current !== next) return;
      if (st === 'connected') { if (!next.attached) next.attached = attach(next.host, { origin: next.origin, userId: next.userId, token: id.token }); }
      else if (STOPPED.has(st)) detach(next);
    };
    chain = chain.then(async () => {
      if (prev) await stop(prev);
      settlePending(id);
      if (next && current === next) {
        next.host.onState?.(follow);
        const st = await connect(next.host, { baseUrl: next.origin, token: id.token, fetch });
        follow(st?.state);
      }
    }).catch((e) => log(`[remote-interaction] ${e.message}`));
    return chain;
  }

  /** App quit: turn hosting off on the hub within quitTimeoutMs; remember it if not told. */
  async function release() {
    const prev = current;
    current = null; key = null;
    cancelRetry();
    if (!prev) return;
    detach(prev);
    const ok = await prev.host.disable({ baseUrl: prev.origin, token: prev.token, fetch, timeoutMs: R.quitTimeoutMs }).catch(() => false);
    prev.host.close();
    if (!ok) setPending({ origin: prev.origin, userId: prev.userId });
  }

  function close() { cancelRetry(); detach(current); current?.host.close(); current = null; key = null; }

  return { sync, release, close, host: () => current?.host ?? null, origin: () => current?.origin ?? null, active: () => !!current, settled: () => chain };
}

module.exports = { createInteractionHostSync, RESET };
