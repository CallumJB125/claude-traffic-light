// First-run data: the BOARD_DEV_SEED fixture (CONTRACT §4.1), the
// production BOARD_BOOTSTRAP admin (org + board + owner) when no member exists
// and the BOARD_AUTH=local owner (D35).

import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { normalizeRemoteUrl } from '../shared/scope.js';
import { emailOnlyIdentity, EMAIL_ONLY, LOCAL_ONLY } from './views.js';

export function seedDev(hub, { repoUrl = null } = {}) {
  const db = hub.db;
  const now = hub.iso();
  hub.txn(() => {
    let org = db.get("SELECT * FROM orgs WHERE name = 'dev'");
    if (!org) {
      org = { id: randomUUID(), name: 'dev', created_at: now };
      db.insert('orgs', org);
    }
    let board = db.get("SELECT * FROM boards WHERE org_id = ? AND key_prefix = 'DEV'", org.id);
    if (!board) {
      board = { id: randomUUID(), org_id: org.id, name: 'DEV', key_prefix: 'DEV' };
      db.insert('boards', board);
    }
    for (const [login, gid, role] of [['alice', -1, 'owner'], ['bob', -2, 'member']]) {
      if (!db.get('SELECT 1 AS x FROM members WHERE org_id = ? AND github_login = ?', org.id, login)) {
        db.insert('members', { id: randomUUID(), org_id: org.id, github_id: gid, github_login: login, email: `${login}@dev.local`, display_name: login[0].toUpperCase() + login.slice(1), role, created_at: now });
      }
    }
    const canonical = normalizeRemoteUrl(repoUrl);
    if (canonical) {
      let repo = db.get('SELECT * FROM repos WHERE org_id = ? AND canonical_url = ?', org.id, canonical);
      if (!repo) {
        repo = { id: randomUUID(), org_id: org.id, canonical_url: canonical, short_name: canonical.split('/').pop() };
        db.insert('repos', repo);
      }
      db.run('INSERT OR IGNORE INTO board_repos (board_id, repo_id) VALUES (?, ?)', board.id, repo.id);
    }
  });
}

// BOARD_BOOTSTRAP="email" (Access one-time PIN, no GitHub identity) or
// "github_login,github_id,email"; BOARD_BOOTSTRAP_BOARD="Name:PREFIX".
export function bootstrapAdmin(hub, spec, boardSpec = 'Team:BRD') {
  const db = hub.db;
  if (db.get('SELECT 1 AS x FROM members LIMIT 1')) return false;
  const parts = String(spec).split(',').map((s) => s.trim());
  let login;
  let gid;
  let email;
  if (parts.length === 1 && /^[^\s@]+@[^\s@]+$/.test(parts[0])) {
    email = parts[0];
    ({ github_login: login, github_id: gid } = emailOnlyIdentity(email));
  } else {
    [login, gid, email] = parts;
    if (!login || !Number.isSafeInteger(Number(gid)) || !email) throw new Error('BOARD_BOOTSTRAP must be "email" or "github_login,github_id,email"');
  }
  const [name, prefix] = String(boardSpec).split(':');
  const now = hub.iso();
  hub.txn(() => {
    const org = { id: randomUUID(), name: name || 'Team', created_at: now };
    db.insert('orgs', org);
    db.insert('boards', { id: randomUUID(), org_id: org.id, name: name || 'Team', key_prefix: (prefix || 'BRD').toUpperCase() });
    db.insert('members', { id: randomUUID(), org_id: org.id, github_id: Number(gid), github_login: login, email, display_name: login.startsWith(EMAIL_ONLY) ? email.split('@')[0] : login, role: 'owner', created_at: now });
  });
  hub.log.info('bootstrap admin created', { email_only: login.startsWith(EMAIL_ONLY) });
  return true;
}

// BOARD_AUTH=local: on a DB with no members, one org, board "My board" and an
// email-less owner every local request maps to. → that owner's member id.
export function seedLocal(hub, boardSpec = 'Me:ME') {
  const db = hub.db;
  const existing = db.meta('local_member');
  if (existing) {
    if (!hub.activeMember(existing)) throw new Error('local owner missing or removed');
    return existing;
  }
  if (db.get('SELECT 1 AS x FROM members LIMIT 1')) throw new Error('BOARD_AUTH=local needs a database it created (this one already has members)');
  let user;
  try { user = userInfo().username; } catch { user = process.env.USER || process.env.USERNAME || 'me'; }
  const [name, prefix] = String(boardSpec).split(':');
  const now = hub.iso();
  const id = randomUUID();
  hub.txn(() => {
    const org = { id: randomUUID(), name: name || 'Me', created_at: now };
    db.insert('orgs', org);
    db.insert('boards', { id: randomUUID(), org_id: org.id, name: 'My board', key_prefix: (prefix || 'ME').toUpperCase() });
    db.insert('members', { id, org_id: org.id, github_id: -1, github_login: `${LOCAL_ONLY}${user}`, email: null, display_name: user, role: 'owner', created_at: now });
    db.setMeta('local_member', id);
  });
  hub.log.info('local owner created');
  return id;
}
