const { createTeamHubClient } = require('./team-hub-client');

const RECHECK_MS = 15_000;

function createLiveTeamHub({ identity, fetch, recheckMs = RECHECK_MS }) {
  let cur = null, closed = false, timer = null, sub = null, last;
  const listeners = new Set();
  const fire = () => { for (const l of [...listeners]) { try { l(); } catch { /* a listener must never break the hub */ } } };
  const unsub = () => { if (sub) { try { sub.off(); } catch { /* already gone */ } sub = null; } };
  // Follows the CURRENT client so an account switch or sign-out moves the poll with it.
  function sync() {
    const client = live.current();
    if (client === last) return;
    const switched = last !== undefined;
    last = client;
    unsub();
    if (client) { try { sub = { off: client.onChange(fire) }; } catch { sub = null; } }
    if (switched) fire();
  }
  const stop = () => { unsub(); last = undefined; if (timer) { clearInterval(timer); timer = null; } };
  const live = {
    current() {
      let id = null;
      try { id = identity(); } catch { id = null; }
      if (!id || typeof id.origin !== 'string' || typeof id.userId !== 'string' || !id.userId || typeof id.token !== 'function') { cur = null; return null; }
      const key = `${id.origin}\n${id.userId}`;
      if (cur?.key === key) return cur.client;
      let client = null;
      // An account switch leaves this client alive until the next sync, so it must not borrow the new account's token.
      const token = () => { let now = null; try { now = identity(); } catch { now = null; } return now && now.origin === id.origin && now.userId === id.userId ? id.token() : ''; };
      try { client = createTeamHubClient({ baseUrl: id.origin, token, fetch, viewerId: id.userId, boardDirectory: true }); } catch { client = null; }
      cur = client ? { key, client } : null;
      return client;
    },
    onChange(cb) {
      if (typeof cb !== 'function') throw new Error('onChange needs a function');
      if (closed) return () => {};
      listeners.add(cb);
      if (!timer) { timer = setInterval(sync, recheckMs); timer.unref?.(); }
      sync();
      return () => { listeners.delete(cb); if (!listeners.size) stop(); };
    },
    close() { closed = true; listeners.clear(); stop(); cur = null; },
  };
  return live;
}

module.exports = { createLiveTeamHub };
