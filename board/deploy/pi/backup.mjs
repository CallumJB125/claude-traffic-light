// Nightly consistent SQLite snapshot (VACUUM INTO works on a live WAL DB),
// keeping the newest 14. Runs as buddyhub from buddy-hub-backup.service.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.env.BOARD_DATA_DIR || '/var/lib/buddy-hub';
const db = process.env.BOARD_DB || path.join(dataDir, 'board.db');
const outDir = path.join(dataDir, 'backups');
const keep = Number(process.env.BACKUP_KEEP || 14);

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(outDir, `board-${stamp}.db`);
const conn = new DatabaseSync(db, { readOnly: true });
conn.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
conn.close();
fs.chmodSync(out, 0o600);

const old = fs.readdirSync(outDir).filter((f) => /^board-.*\.db$/.test(f)).sort().slice(0, -keep);
for (const f of old) fs.unlinkSync(path.join(outDir, f));
console.log(`backup ${out}; pruned ${old.length}`);
