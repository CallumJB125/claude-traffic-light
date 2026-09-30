// Workspaces: the board on this Mac ("local") plus any team hubs the member
// connected to. Stored in userData as plain JSON: URLs and names only; the
// Access cookie lives in the hub's own session partition, never here.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCAL = Object.freeze({ id: 'local', name: 'My board', kind: 'local' });

/**
 * Only https hubs (a team hub always sits behind TLS); a bare host is taken
 * as https. Path, query and credentials are dropped: a workspace is an origin.
 */
function normalizeHubUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('Enter the team hub address, like buddy.example.com');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('That is not a web address.'); }
  if (u.protocol !== 'https:') throw new Error('Team hubs must use https://');
  if (u.username || u.password) throw new Error('Leave the user name and password out of the address.');
  if (!u.hostname.includes('.') || /^(localhost|127\.|0\.|\[?::1)/i.test(u.hostname)) throw new Error('Use the team hub’s public address.');
  return u.origin;
}

const idFor = (origin) => `team:${new URL(origin).host}`;
const partitionFor = (origin) => `persist:board-${new URL(origin).host}`;

// The Access login pages for a hub: <team>.cloudflareaccess.com, learned from
// the hub's own redirect when connecting.
function accessTeamFromLocation(location) {
  try {
    const h = new URL(location).hostname;
    const m = /^([a-z0-9-]+)\.cloudflareaccess\.com$/i.exec(h);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

function createWorkspaceStore(file) {
  let data = { active: 'local', teams: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const teams = Array.isArray(raw.teams) ? raw.teams.filter((t) => {
      try { return normalizeHubUrl(t.url) === t.url && typeof t.name === 'string'; } catch { return false; }
    }).map((t) => ({ id: idFor(t.url), name: t.name.slice(0, 60), url: t.url, accessTeam: t.accessTeam && /^[a-z0-9-]+$/.test(t.accessTeam) ? t.accessTeam : null, kind: 'team' })) : [];
    data = { teams, active: teams.some((t) => t.id === raw.active) ? raw.active : 'local' };
  } catch { /* first run or unreadable: local only */ }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ active: data.active, teams: data.teams.map(({ name, url, accessTeam }) => ({ name, url, accessTeam })) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    list: () => [LOCAL, ...data.teams],
    active: () => (data.active === 'local' ? LOCAL : data.teams.find((t) => t.id === data.active) ?? LOCAL),
    get: (id) => (id === 'local' ? LOCAL : data.teams.find((t) => t.id === id) ?? null),
    setActive(id) {
      if (id !== 'local' && !data.teams.some((t) => t.id === id)) return false;
      data.active = id;
      save();
      return true;
    },
    /** Add (or update) a team hub and make it active. */
    add({ url, name, accessTeam = null }) {
      const origin = normalizeHubUrl(url);
      const id = idFor(origin);
      const entry = { id, name: String(name || new URL(origin).host).trim().slice(0, 60), url: origin, accessTeam, kind: 'team' };
      data.teams = [...data.teams.filter((t) => t.id !== id), entry];
      data.active = id;
      save();
      return entry;
    },
    remove(id) {
      const before = data.teams.length;
      data.teams = data.teams.filter((t) => t.id !== id);
      if (data.active === id) data.active = 'local';
      if (data.teams.length !== before) save();
      return data.teams.length !== before;
    },
  };
}

module.exports = { createWorkspaceStore, normalizeHubUrl, accessTeamFromLocation, partitionFor, idFor, LOCAL };
