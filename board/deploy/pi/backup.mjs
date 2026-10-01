// Nightly paired snapshot. Also used by the matching code/env/data cutover.
import path from 'node:path';
import { createBackup, snapshot, stageRestore, validateBackup } from './backup-lib.mjs';

const dataDir = process.env.BOARD_DATA_DIR || '/var/lib/buddy-hub';
const db = process.env.BOARD_DB || path.join(dataDir, 'board.db');
const [mode, source, destination, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('unexpected backup arguments');
let result;
if (!mode) result = createBackup({ dataDir, db, keep: Number(process.env.BACKUP_KEEP || 14) });
else if (mode === '--snapshot' && source && !destination) {
  const m = snapshot({ dataDir, db, destination: source }); result = { bundle: source, artifact_count: m.artifacts.length };
} else if (mode === '--verify' && source && !destination) {
  const m = validateBackup(source); result = { verified: true, artifact_count: m.artifacts.length };
} else if (mode === '--stage-restore' && source && destination) {
  const m = stageRestore({ bundle: source, destination }); result = { prepared: destination, artifact_count: m.artifacts.length };
} else throw new Error('usage: backup.mjs [--snapshot DIR | --verify DIR | --stage-restore BACKUP NEW_DIR]');
console.log(JSON.stringify(result));
