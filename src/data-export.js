// Export my data: copies every exportable store from src/data-inventory.js
// into a new folder the person picked, as JSON, JSONL, CSV and text, with
// credentials and tokens redacted (src/scrub.js redactSecretsPass, which
// runs the shared src/secret-patterns.js list) and a README.txt saying what
// is in it and what is not. Databases become one JSONL file per table.
// Key files, sealed sign-ins and anything that is not text or a picture are
// left out and listed. Nothing here talks to the network.
'use strict';

const fs = require('fs');
const path = require('path');
const { redactSecretsPass } = require('./scrub.js');
const Inventory = require('./data-inventory.js');

const R = '[redacted]';
const SECRET_KEY = /^(?:.*[_-])?(?:token|secret|password|passwd|passphrase|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|cookie|authorization|auth|session[_-]?key|bearer|signing[_-]?key|hmac)(?:[_-].*)?$|^(?:access|refresh|id|auth|device|api)Token$|^(?:secret|seed|salt)s?$/i;
const SECRET_FILE = /^(?:token|port|identity\.json|entitlement\.json|keys?\.json|credentials?\.json)$|secret|\.(?:token|pem|key|p12|sealed|sock)$/i;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.avif', '.bmp']);
const DB_EXT = new Set(['.db', '.sqlite', '.sqlite3']);
const DB_SIDE = /\.(?:db|sqlite3?)-(?:wal|shm|journal)$/;
const MAX_FILE = 64 * 1024 * 1024;

const redactText = (s) => redactSecretsPass(s);

function redactDeep(v, key = '') {
  if (key && typeof v === 'string' && v && SECRET_KEY.test(key)) return R;
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x, k);
    return out;
  }
  return v;
}

const isSecretFile = (name) => SECRET_FILE.test(name);

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells) => cells.map(csvCell).join(',');

const LOG_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[(\w+)\] (?:\[([^\]\n]{1,60})\] )?(.*)$/;

/** The activity log (app.log.old then app.log) as CSV: time, level, source, message. */
function activityCsv(dataDir) {
  const rows = [csvRow(['time', 'level', 'source', 'message'])];
  for (const f of ['app.log.old', 'app.log']) {
    let text = '';
    try {
      const st = fs.lstatSync(path.join(dataDir, f));
      if (!st.isFile()) continue;
      text = fs.readFileSync(path.join(dataDir, f), 'utf8');
    } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const m = LOG_LINE.exec(line);
      rows.push(m ? csvRow([m[1], m[2], m[3] || '', redactText(m[4])]) : csvRow(['', '', '', redactText(line)]));
    }
  }
  return `${rows.join('\n')}\n`;
}

function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
}

function exportDb(src, destBase, stats) {
  const { DatabaseSync } = require('node:sqlite');
  let db = null;
  try {
    db = new DatabaseSync(src, { readOnly: true });
    const all = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
    const virtual = all.filter((t) => /^CREATE VIRTUAL/i.test(t.sql || '')).map((t) => t.name);
    const tables = all.map((t) => t.name).filter((n) => !n.startsWith('sqlite_') && !virtual.some((v) => n.startsWith(`${v}_`)));
    for (const t of tables) {
      const out = `${destBase}.${t.replace(/[^\w.-]/g, '_')}.jsonl`;
      fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(out, 'wx', 0o600);
      try {
        for (const row of db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}"`).iterate()) {
          const clean = {};
          for (const [k, v] of Object.entries(row)) clean[k] = v instanceof Uint8Array ? `[${v.length} bytes]` : redactDeep(v, k);
          fs.writeSync(fd, `${JSON.stringify(clean)}\n`);
        }
      } finally { fs.closeSync(fd); }
      stats.files++;
    }
  } catch (err) {
    stats.skipped.push({ name: path.basename(src), why: `database could not be read (${err.code || 'busy'})` });
  } finally { try { db?.close(); } catch { /* closed */ } }
}

function exportFile(src, dest, name, stats) {
  const ext = path.extname(name).toLowerCase();
  if (isSecretFile(name)) { stats.skipped.push({ name, why: 'a key or token' }); return; }
  if (DB_SIDE.test(name)) return;
  const st = fs.lstatSync(src);
  if (!st.isFile()) { stats.skipped.push({ name, why: st.isSymbolicLink() ? 'a link, not followed' : 'not a file' }); return; }
  if (st.size > MAX_FILE) { stats.skipped.push({ name, why: 'larger than 64 MB' }); return; }
  if (DB_EXT.has(ext)) { exportDb(src, dest, stats); return; }
  if (IMAGE_EXT.has(ext)) { fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 }); fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL); stats.files++; stats.bytes += st.size; return; }
  const buf = fs.readFileSync(src);
  const looksText = !buf.subarray(0, 8192).includes(0);
  if (!looksText) { stats.skipped.push({ name, why: 'not text or a picture' }); return; }
  const text = buf.toString('utf8');
  let out;
  if (ext === '.json') {
    try { out = `${JSON.stringify(redactDeep(JSON.parse(text)), null, 2)}\n`; } catch { out = redactText(text); }
  } else if (ext === '.jsonl' || ext === '.ndjson') {
    out = text.split('\n').map((l) => { if (!l.trim()) return l; try { return JSON.stringify(redactDeep(JSON.parse(l))); } catch { return redactText(l); } }).join('\n');
  } else {
    out = redactText(text);
  }
  writeFile(dest, out);
  stats.files++;
  stats.bytes += Buffer.byteLength(out);
}

function copyTree(src, dest, stats) {
  let st;
  try { st = fs.lstatSync(src); } catch { return; }
  const name = path.basename(src);
  if (st.isSymbolicLink()) { stats.skipped.push({ name, why: 'a link, not followed' }); return; }
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(src).sort()) copyTree(path.join(src, n), path.join(dest, n), stats);
    return;
  }
  try { exportFile(src, dest, name, stats); } catch (err) { stats.skipped.push({ name, why: `could not be read (${err.code || 'error'})` }); }
}

function folderName(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `Plexiform data export ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const NOT_COVERED = [
  'Data on a team hub (cards, handovers, activity and your account there). Delete it from Account > Delete account, or ask the team’s owner.',
  'Your AI tools’ own histories and settings (~/.claude, ~/.codex, ~/.gemini, Cursor). Plexiform reads them but they are not Plexiform’s to export or delete.',
  'Your code repositories.',
];

function readme({ now, appVersion, included, excluded, skipped }) {
  const lines = [
    'Plexiform data export',
    '=====================',
    '',
    `Made ${new Date(now).toISOString()}${appVersion ? ` by Plexiform ${appVersion}` : ''}, on this computer. Nothing was sent anywhere.`,
    '',
    'Credentials, tokens, passwords and keys found in the files were replaced with [redacted] or <redacted:kind>.',
    'Databases are exported as one JSONL file per table (one JSON object per line).',
    'audit/activity-log.csv is the activity log as a spreadsheet: time, level, source, message.',
    '',
    'Included',
    '--------',
  ];
  for (const s of included) lines.push(`- ${s.label} (folder ${s.id}/): ${s.files} file${s.files === 1 ? '' : 's'}, ${size(s.bytes)}. ${s.detail}`);
  if (!included.length) lines.push('- Nothing: no data was found.');
  lines.push('', 'Not included', '------------');
  for (const s of excluded) lines.push(`- ${s.label}: ${s.why}`);
  if (skipped.length) lines.push(`- ${skipped.length} single file${skipped.length === 1 ? '' : 's'} left out: keys and tokens, links, files that are not text or pictures, or files larger than 64 MB. They are listed in skipped.txt.`);
  lines.push('', 'Not held by Plexiform on this computer', '--------------------------------------');
  for (const s of NOT_COVERED) lines.push(`- ${s}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Writes a new folder inside `outDir` and returns {dir, stores, skipped}.
 * `opts` are src/data-inventory.js roots.
 */
async function exportData({ outDir, now = Date.now(), appVersion = '', ...opts }) {
  if (!outDir || !path.isAbsolute(outDir)) throw new Error('Choose a folder to export to.');
  const rows = Inventory.inventory(opts);
  for (const root of Object.values(Inventory.rootsOf(opts))) if (root && Inventory.inside(path.resolve(outDir), path.resolve(root))) throw new Error('Choose a folder outside Plexiform’s own folders.');
  let dir = path.join(outDir, folderName(now));
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(outDir, `${folderName(now)} (${i})`);
  fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
  const included = [], excluded = [], skipped = [];
  for (const r of rows) {
    if (!r.paths.length) continue;
    if (!r.exportable) { excluded.push({ label: r.label, why: r.kind === 'secret' ? 'keys and sign-ins are never exported.' : r.kind === 'cache' ? 'browser caches and cookies, not your content.' : 'not exported; it can still be deleted.' }); continue; }
    const stats = { files: 0, bytes: 0, skipped: [] };
    for (const p of r.paths) {
      copyTree(p, path.join(dir, r.id, path.basename(p)), stats);
      await new Promise((res) => setImmediate(res));
    }
    for (const s of stats.skipped) skipped.push({ store: r.id, ...s });
    included.push({ id: r.id, label: r.label, detail: r.detail, files: stats.files, bytes: stats.bytes });
  }
  const dataDir = Inventory.rootsOf(opts).data;
  if (dataDir && !Inventory.rootProblem(dataDir, opts.home)) writeFile(path.join(dir, 'audit', 'activity-log.csv'), activityCsv(dataDir));
  if (skipped.length) writeFile(path.join(dir, 'skipped.txt'), `${skipped.map((s) => `${s.store}: ${redactText(s.name)} (${s.why})`).join('\n')}\n`);
  writeFile(path.join(dir, 'README.txt'), readme({ now, appVersion, included, excluded, skipped }));
  return { dir, stores: included, excluded, skipped: skipped.length };
}

module.exports = { exportData, activityCsv, redactDeep, isSecretFile, csvRow, readme, NOT_COVERED, SECRET_KEY };
