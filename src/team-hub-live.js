const { createTeamHubClient } = require('./team-hub-client');

function createLiveTeamHub({ identity, fetch }) {
  let cur = null;
  return {
    current() {
      let id = null;
      try { id = identity(); } catch { id = null; }
      if (!id || typeof id.origin !== 'string' || typeof id.userId !== 'string' || !id.userId || typeof id.token !== 'function') { cur = null; return null; }
      const key = `${id.origin}\n${id.userId}`;
      if (cur?.key === key) return cur.client;
      let client = null;
      try { client = createTeamHubClient({ baseUrl: id.origin, token: id.token, fetch, viewerId: id.userId }); } catch { client = null; }
      cur = client ? { key, client } : null;
      return client;
    },
    close() { cur = null; },
  };
}

module.exports = { createLiveTeamHub };
