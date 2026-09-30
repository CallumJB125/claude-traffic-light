// Workspaces: the board on this Mac ("local") plus every team the member is in
// on each team hub they signed in to (a workspace is {hub origin, team id}).
// Stored in userData as plain JSON: origins, team ids and names only; the
// device token for a hub lives sealed in its own file (index.js), never here.
//
// `access` entries are the hidden fallback for a hub that still runs behind
// Cloudflare Access (answers /api/health with auth:'access' or redirects to
// its login): their session cookie lives in the hub's own partition.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCAL = Object.freeze({ id: 'local', name: 'My board', kind: 'local' });
const TEAM_ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Only https hubs (a team hub always sits behind TLS); a bare host is taken
 * as https. Path, query and credentials are dropped: a hub is an origin.
 * `allowOrigins` lets exact extra origins through (the dev-only mock hub on
 * loopback); nothing else on http or loopback ever passes.
 */
function normalizeHubUrl(input, { allowOrigins = [] } = {}) {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('Enter the team hub address, like buddy.example.com');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('That is not a web address.'); }
  if (u.username || u.password) throw new Error('Leave the user name and password out of the address.');
  if (allowOrigins.includes(u.origin)) return u.origin;
  if (u.protocol !== 'https:') throw new Error('Team hubs must use https://');
  if (!u.hostname.includes('.') || /^(localhost|127\.|0\.|\[?::1)/i.test(u.hostname)) throw new Error('Use the team hub’s public address.');
  return u.origin;
}

// Loopback, RFC 1918, link-local and CGNAT (RFC 6598) IPv4 literals. IPv6
// literals never pass normalizeHubUrl (their host has no dot).
function isPrivateHost(hostname) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * A hub named by a link (deep link, pasted invite) rather than typed: also
 * never a private or local address, so a link can't point the app at a
 * service on the member's own network. Checked on the literal only; a public
 * name that resolves privately is left to the member's confirm step.
 */
function normalizeLinkHub(input, { allowOrigins = [] } = {}) {
  const origin = normalizeHubUrl(input, { allowOrigins });
  if (!allowOrigins.includes(origin) && isPrivateHost(new URL(origin).hostname)) throw new Error('Use the team hub’s public address.');
  return origin;
}

const hostOf = (origin) => new URL(origin).host;
const teamWsId = (origin, teamId) => `team:${hostOf(origin)}:${teamId}`;
const accessWsId = (origin) => `access:${hostOf(origin)}`;
// Names for a hub's files and partitions: a hash, so no host spelling (ports,
// IDNs, look-alike punctuation) can collide with another hub's.
const hubKey = (origin) => crypto.createHash('sha256').update(String(origin)).digest('hex').slice(0, 16);
// One partition per hub, whatever team is showing: switching team is the same
// page with a different ?org=, and the bearer header is set per partition.
const partitionFor = (origin) => `persist:board-${hubKey(origin)}`;
// The Integrations sign-in window's partition, per hub, so signing out of one
// hub clears only its provider cookies.
const integrationPartitionFor = (origin) => `persist:integration-auth-${hubKey(origin)}`;

// The Access login pages for a hub: <team>.cloudflareaccess.com, learned from
// the hub's own redirect when connecting.
function accessTeamFromLocation(location) {
  try {
    const h = new URL(location).hostname;
    const m = /^([a-z0-9-]+)\.cloudflareaccess\.com$/i.exec(h);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

/** The teams in a `GET /api/account` answer, cleaned: ids we can put in a URL, short names. */
function teamsFromAccount(account) {
  const list = Array.isArray(account?.teams) ? account.teams : [];
  return list.filter((t) => t && TEAM_ID_RE.test(String(t.id ?? '')) && typeof t.name === 'string').map((t) => ({
    id: String(t.id), name: t.name.trim().slice(0, 60) || 'Team', role: ['owner', 'admin', 'member', 'guest'].includes(t.role) ? t.role : 'member',
  }));
}

/**
 * The switcher's list: this Mac, then each signed-in hub's teams (in hub
 * order, then by name), then any Access-fallback hubs.
 */
function buildWorkspaceList({ hubs = [], teams = {}, access = [], signedIn = () => true }) {
  const out = [LOCAL];
  const multi = hubs.filter((h) => signedIn(h) && (teams[h] ?? []).length).length > 1;
  for (const hub of hubs) {
    if (!signedIn(hub)) continue;
    const list = [...(teams[hub] ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const t of list) out.push({ id: teamWsId(hub, t.id), kind: 'team', hub, teamId: t.id, name: t.name, role: t.role, group: multi ? hostOf(hub) : null });
  }
  for (const a of access) out.push({ id: accessWsId(a.url), kind: 'access', url: a.url, name: a.name, accessTeam: a.accessTeam });
  return out;
}

function createWorkspaceStore(file, { allowOrigins = [], signedIn = () => true } = {}) {
  const norm = (u) => normalizeHubUrl(u, { allowOrigins });
  const isOrigin = (u) => { try { return norm(u) === u; } catch { return false; } };
  let data = { active: 'local', hubs: [], teams: {}, access: [], lastHub: null, presence: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.version === 2) {
      const hubs = (Array.isArray(raw.hubs) ? raw.hubs : []).filter(isOrigin);
      const teams = {};
      for (const h of hubs) teams[h] = teamsFromAccount({ teams: raw.teams?.[h] });
      const access = (Array.isArray(raw.access) ? raw.access : []).filter((t) => isOrigin(t?.url) && typeof t.name === 'string')
        .map((t) => ({ url: t.url, name: t.name.slice(0, 60), accessTeam: t.accessTeam && /^[a-z0-9-]+$/.test(t.accessTeam) ? t.accessTeam : null }));
      const presence = {};
      for (const h of hubs) if (raw.presence?.[h] === true) presence[h] = true;
      data = { hubs, teams, access, presence, active: raw.active, lastHub: hubs.includes(raw.lastHub) ? raw.lastHub : (hubs.at(-1) ?? null) };
    } else if (Array.isArray(raw.teams)) {
      // v1: [{name, url, accessTeam}], one entry per hub, from before accounts
      // existed: every entry passed the old probe as an Access hub, including
      // those saved with no Access team (it answered 200 while signed in), so
      // all of them stay Access workspaces.
      const v1 = raw.teams.filter((t) => isOrigin(t?.url) && typeof t.name === 'string');
      const access = v1.map((t) => ({ url: t.url, name: t.name.slice(0, 60), accessTeam: t.accessTeam && /^[a-z0-9-]+$/.test(t.accessTeam) ? t.accessTeam : null }));
      const was = v1.find((t) => `team:${hostOf(t.url)}` === raw.active);
      data = { hubs: [], teams: {}, access, presence: {}, active: was ? accessWsId(was.url) : 'local', lastHub: null };
    }
  } catch { /* first run or unreadable: local only */ }

  const list = () => buildWorkspaceList({ hubs: data.hubs, teams: data.teams, access: data.access, signedIn });
  if (!list().some((w) => w.id === data.active)) data.active = 'local';

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, active: data.active, lastHub: data.lastHub, hubs: data.hubs, teams: data.teams, access: data.access, presence: data.presence }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const get = (id) => list().find((w) => w.id === id) ?? null;

  return {
    list,
    get,
    active: () => get(data.active) ?? LOCAL,
    // The stored id even while its hub is signed out (and so missing from list()).
    activeId: () => data.active,
    hubs: () => data.hubs.slice(),
    lastHub: () => data.lastHub,
    knows: (origin) => data.hubs.includes(origin),
    setActive(id) {
      if (!get(id)) return false;
      data.active = id;
      save();
      return true;
    },
    /** Remember a hub (after its first sign-in) and make it the default for the next one. */
    addHub(origin) {
      const o = norm(origin);
      if (!data.hubs.includes(o)) data.hubs.push(o);
      data.teams[o] ??= [];
      data.lastHub = o;
      save();
      return o;
    },
    /** Replace a hub's cached teams from GET /api/account. Returns true if anything changed. */
    setTeams(origin, account) {
      if (!data.hubs.includes(origin)) return false;
      const next = teamsFromAccount(account);
      const changed = JSON.stringify(next) !== JSON.stringify(data.teams[origin] ?? []);
      data.teams[origin] = next;
      if (!get(data.active)) data.active = 'local';
      if (changed) save();
      return changed;
    },
    /** Signed out of a hub: its teams leave the switcher; the hub stays known for next time. */
    forgetTeams(origin) {
      if (!data.teams[origin]?.length) return;
      data.teams[origin] = [];
      if (!get(data.active)) data.active = 'local';
      save();
    },
    addAccess({ url, name, accessTeam = null }) {
      const origin = norm(url);
      const entry = { url: origin, name: String(name || hostOf(origin)).trim().slice(0, 60), accessTeam };
      data.access = [...data.access.filter((a) => a.url !== origin), entry];
      data.active = accessWsId(origin);
      save();
      return get(data.active);
    },
    removeAccess(id) {
      const before = data.access.length;
      data.access = data.access.filter((a) => accessWsId(a.url) !== id);
      if (data.active === id) data.active = 'local';
      if (data.access.length !== before) save();
      return data.access.length !== before;
    },
    /** "Share my live sessions with the team", per hub; off unless turned on. */
    sharesPresence: (origin) => data.presence[origin] === true,
    setSharesPresence(origin, on) {
      if (!data.hubs.includes(origin)) return false;
      if (on) data.presence[origin] = true; else delete data.presence[origin];
      save();
      return true;
    },
    /** Pick a workspace after a list change (e.g. a team just created or joined). */
    activateTeam(origin, teamId) { return this.setActive(teamWsId(origin, teamId)); },
  };
}

module.exports = { createWorkspaceStore, buildWorkspaceList, teamsFromAccount, normalizeHubUrl, normalizeLinkHub, isPrivateHost, accessTeamFromLocation, partitionFor, integrationPartitionFor, hubKey, teamWsId, accessWsId, hostOf, LOCAL };
