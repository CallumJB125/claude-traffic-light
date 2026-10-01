// Read-only migration 029 preview. Never edits cards, keys, runs or links.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export function prefixAudit(db) {
  const groups = db.prepare('SELECT org_id, key_prefix FROM boards GROUP BY org_id, key_prefix HAVING COUNT(*) > 1 ORDER BY org_id, key_prefix').all();
  return { ready: !groups.length, collisions: groups.map((g) => ({ ...g,
    boards: db.prepare(`SELECT b.id, b.name, COUNT(c.id) AS cards FROM boards b LEFT JOIN cards c ON c.board_id = b.id
      WHERE b.org_id = ? AND b.key_prefix = ? GROUP BY b.id ORDER BY b.id`).all(g.org_id, g.key_prefix),
    options: ['An empty board can receive an unused prefix after review.', 'For boards with cards, review a key and external-link migration or a forward-only key allocation policy; preserve historical links.'],
  })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) { console.error('Usage: node hub/board-prefix-audit.js <hub.sqlite>'); process.exitCode = 2; }
  else {
    const db = new DatabaseSync(process.argv[2], { readOnly: true });
    try { const result = prefixAudit(db); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ready ? 0 : 1; }
    finally { db.close(); }
  }
}
