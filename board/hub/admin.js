#!/usr/bin/env node
// Operator erasure for BOARD_AUTH=accounts (CONTRACT D73), run on the hub host
// with the hub's own environment:
//   node hub/admin.js delete-user <email>
//   node hub/admin.js delete-team <slug>
// The same transaction as DELETE /api/account and DELETE /api/teams/:id,
// without the email step-up: for a hub with no mailer (and, until the OAuth
// re-auth step-up lands, no other way to confirm). It opens the database file
// directly: stop the hub first, or rely on its 5 s busy_timeout (sockets of a
// running hub then close at their next credential check).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { silentLogger } from './log.js';
import { Accounts, canonEmail } from './identity/accounts.js';
import { Teams } from './identity/teams.js';
import { Invites } from './identity/invites.js';

const USAGE = 'usage: node hub/admin.js delete-user <email> | delete-team <slug>';

/** → exit code. `config` replaces loadConfig() (tests). */
export function runAdmin(argv, { config = null, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const [cmd, arg] = argv;
  if (!['delete-user', 'delete-team'].includes(cmd) || !arg) { err(USAGE); return 2; }
  let cfg;
  try { cfg = config ?? loadConfig(); } catch (e) { err(`invalid configuration: ${e.message}`); return 2; }
  if (cfg.auth !== 'accounts') { err('admin.js works on a BOARD_AUTH=accounts hub only'); return 2; }
  // openDb would create an empty database: no file here means this is not the hub host.
  if (!existsSync(cfg.dbPath)) { err(`no hub database at ${cfg.dbPath}: run this on the hub host with the hub's BOARD_DATA_DIR / BOARD_DB`); return 2; }
  const db = openDb(cfg.dbPath);
  try {
    const hub = new Hub({ db, config: cfg, log: silentLogger });
    hub.accounts = new Accounts(hub, { mailer: null });
    hub.teams = new Teams(hub, { accounts: hub.accounts });
    hub.invites = new Invites(hub, { accounts: hub.accounts, teams: hub.teams });
    if (cmd === 'delete-user') {
      const email = canonEmail(arg);
      const user = db.get(`SELECT u.* FROM users u WHERE u.deleted_at IS NULL AND (u.primary_email = ?
        OR u.id IN (SELECT user_id FROM identities WHERE provider = 'email' AND subject = ?))`, email, email);
      if (!user) { err('no live account with that address'); return 1; }
      hub.accounts.eraseUser(user, { by: 'operator' });
      out(JSON.stringify({ ok: true, deleted_user: user.id }));
    } else {
      const org = db.get('SELECT * FROM orgs WHERE slug = ? AND deleted_at IS NULL', arg);
      if (!org) { err('no live team with that slug'); return 1; }
      const r = hub.teams.deleteTeam(org, {});
      out(JSON.stringify({ ok: true, deleted_team: org.id, purge_after: r.purge_after }));
    }
    return 0;
  } catch (e) {
    err(`${e.code ?? 'ERROR'}: ${e.message}${e.extra?.sole_owner_of ? ` (${e.extra.sole_owner_of.map((o) => o.name).join(', ')})` : ''}`);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = runAdmin(process.argv.slice(2));
