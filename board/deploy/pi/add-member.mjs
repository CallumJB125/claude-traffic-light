// Seed email-only (Access one-time PIN) members on the hub host, before any
// owner can sign in to do it over POST /api/members. Joins the only org.
//   sudo -u buddyhub node deploy/pi/add-member.mjs a@x.com [b@y.com …]
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { emailOnlyIdentity } from '../../hub/views.js';

const dataDir = process.env.BOARD_DATA_DIR || '/var/lib/buddy-hub';
const db = new DatabaseSync(process.env.BOARD_DB || join(dataDir, 'board.db'));
db.exec('PRAGMA busy_timeout = 5000');

const orgs = db.prepare('SELECT id FROM orgs').all();
if (orgs.length !== 1) throw new Error(`expected exactly one org, found ${orgs.length} (start the hub with BOARD_BOOTSTRAP first)`);
const orgId = orgs[0].id;
const owner = db.prepare("SELECT id FROM members WHERE org_id = ? AND role = 'owner' LIMIT 1").get(orgId);

for (const raw of process.argv.slice(2)) {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`not an address: ${raw}`);
  if (db.prepare('SELECT 1 FROM members WHERE org_id = ? AND lower(email) = ?').get(orgId, email)) {
    console.log(`exists ${email}`);
    continue;
  }
  const { github_login, github_id } = emailOnlyIdentity(email);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, github_id, github_login, email, email.split('@')[0], 'member', now);
  db.prepare('INSERT INTO audit (actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(owner?.id ?? null, 'member.create', id, 'deploy/pi/add-member.mjs', now);
  console.log(`added ${email}`);
}
db.close();
