// First-run data: the BOARD_DEV_SEED fixture (CONTRACT §4.1) and the
// production BOARD_BOOTSTRAP admin (org + board + owner) when no member exists.

import { randomUUID } from 'node:crypto';
import { normalizeRemoteUrl } from '../shared/scope.js';

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

// BOARD_BOOTSTRAP="github_login,github_id,email" and BOARD_BOOTSTRAP_BOARD="Name:PREFIX".
export function bootstrapAdmin(hub, spec, boardSpec = 'Team:BRD') {
  const db = hub.db;
  if (db.get('SELECT 1 AS x FROM members LIMIT 1')) return false;
  const [login, gid, email] = String(spec).split(',').map((s) => s.trim());
  if (!login || !Number.isSafeInteger(Number(gid)) || !email) throw new Error('BOARD_BOOTSTRAP must be "github_login,github_id,email"');
  const [name, prefix] = String(boardSpec).split(':');
  const now = hub.iso();
  hub.txn(() => {
    const org = { id: randomUUID(), name: name || 'Team', created_at: now };
    db.insert('orgs', org);
    db.insert('boards', { id: randomUUID(), org_id: org.id, name: name || 'Team', key_prefix: (prefix || 'BRD').toUpperCase() });
    db.insert('members', { id: randomUUID(), org_id: org.id, github_id: Number(gid), github_login: login, email, display_name: login, role: 'owner', created_at: now });
  });
  hub.log.info('bootstrap admin created', { github_login: login });
  return true;
}
