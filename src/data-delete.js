// Delete my data. The Settings page only asks: requestDeletion() checks the
// typed "delete" and writes which stores to remove into the data folder,
// and main quits and relaunches. The next start calls runPendingDeletion()
// before any store is opened, so nothing is mid-write: the quit has already
// closed the board database, stopped the task runner and flushed the rest.
// Only top-level entries that src/data-inventory.js names right then are
// removed. A link is removed as a link and never entered, a root that is a
// link (or an AI tool's folder, or home) is refused, and every removal is
// checked to be inside its root. A receipt of what went, and when, is left
// in deletion-receipts/: store names, counts and sizes, no paths or content.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Inventory = require('./data-inventory.js');
const { NOT_COVERED } = require('./data-export.js');

const CONFIRM_WORD = 'delete';
const receiptsDir = (dataDir) => path.join(dataDir, Inventory.RECEIPTS);
const pendingFile = (dataDir) => path.join(dataDir, Inventory.PENDING);

function knownIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && Inventory.byId.has(id)))];
}

/** Checks the typed confirmation and records the stores to delete at the next start. */
function requestDeletion({ ids, confirm, dataDir, now = Date.now(), pid = process.pid }) {
  if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== CONFIRM_WORD) return { error: `Type ${CONFIRM_WORD} to confirm.` };
  const chosen = knownIds(ids);
  if (!chosen.length) return { error: 'Choose at least one kind of data.' };
  const problem = Inventory.rootProblem(dataDir);
  if (problem) return { error: `The data folder is ${problem}; nothing was changed.` };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = pendingFile(dataDir);
  const tmp = `${file}.${pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, ids: chosen, requestedAt: new Date(now).toISOString(), pid }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ok: true, ids: chosen };
}

function cancelDeletion({ dataDir }) {
  try { fs.unlinkSync(pendingFile(dataDir)); return true; } catch { return false; }
}

function removeTree(p, root, tally) {
  if (!Inventory.inside(p, root) || p === root) throw new Error('outside its folder');
  const st = fs.lstatSync(p);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    for (const n of fs.readdirSync(p)) removeTree(path.join(p, n), root, tally);
    fs.rmdirSync(p);
    return;
  }
  fs.unlinkSync(p);
  tally.files++;
  tally.bytes += st.size;
}

/** Removes the chosen stores now. Callers make sure nothing has them open. */
function deleteStores({ ids, home = os.homedir(), ...opts }) {
  const roots = Inventory.rootsOf(opts);
  const rows = new Map(Inventory.inventory({ ...opts, home }).map((r) => [r.id, r]));
  return knownIds(ids).map((id) => {
    const store = Inventory.byId.get(id);
    const row = rows.get(id);
    const out = { id, label: store.label, status: 'deleted', files: 0, bytes: 0, failed: 0 };
    const root = roots[store.root];
    const problem = root ? Inventory.rootProblem(root, home) : 'not on this computer';
    if (problem) return { ...out, status: 'refused', reason: problem };
    if (!row.paths.length) return { ...out, status: 'nothing there' };
    const resolvedRoot = path.resolve(root);
    for (const p of row.paths) {
      const abs = path.resolve(p);
      if (path.dirname(abs) !== resolvedRoot) { out.failed++; continue; }
      try { removeTree(abs, resolvedRoot, out); } catch { out.failed++; }
    }
    if (store.all) { try { fs.rmdirSync(resolvedRoot); } catch { /* not empty, or already gone */ } }
    if (out.failed) out.status = out.files ? 'partly deleted' : 'not deleted';
    return out;
  });
}

function stamp(ms) { return new Date(ms).toISOString().replace(/[:.]/g, '-'); }

function receiptOf({ requestedAt, deletedAt, results }) {
  return {
    receipt: 'Plexiform data deletion',
    requestedAt,
    deletedAt,
    stores: results.map((r) => ({ id: r.id, label: r.label, status: r.status, files: r.files, bytes: r.bytes, ...(r.failed ? { failed: r.failed } : {}), ...(r.reason ? { reason: r.reason } : {}) })),
    notCovered: NOT_COVERED,
    note: 'This receipt names only the kinds of data deleted, when, and how much. It holds no personal content and no file paths.',
  };
}

function writeReceipt({ dataDir, receipt, now }) {
  const dir = receiptsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `deletion-${stamp(now)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

function lockPid(userDataDir) {
  if (!userDataDir) return null;
  try { const t = fs.readlinkSync(path.join(userDataDir, 'SingletonLock')); return Number(t.slice(t.lastIndexOf('-') + 1)) || null; } catch { return null; }
}

/**
 * At start, before stores open: runs a deletion asked for last time.
 * {ran:false} when none is waiting, {waiting:true} while another copy of the
 * app still runs, else {ran:true, receipt, results}.
 */
function runPendingDeletion({ now = Date.now(), pid = process.pid, isAlive = pidAlive, ...opts }) {
  const dataDir = opts.dataDir;
  if (!dataDir) return { ran: false };
  const file = pendingFile(dataDir);
  let plan;
  try {
    if (!fs.lstatSync(file).isFile()) return { ran: false };
    plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return { ran: false }; }
  const other = [plan?.pid, lockPid(opts.userDataDir)].find((p) => p && p !== pid && isAlive(p));
  if (other) return { ran: false, waiting: true };
  try { fs.unlinkSync(file); } catch { return { ran: false }; }
  if (!plan || plan.v !== 1) return { ran: false };
  const results = deleteStores({ ...opts, ids: plan.ids });
  const receipt = receiptOf({ requestedAt: typeof plan.requestedAt === 'string' ? plan.requestedAt.slice(0, 40) : null, deletedAt: new Date(now).toISOString(), results });
  let receiptFile = null;
  try { receiptFile = writeReceipt({ dataDir, receipt, now }); } catch { /* the deletion stands without its receipt */ }
  return { ran: true, receipt, receiptFile, results };
}

/** The newest receipt, for Settings to show; null when there is none. */
function lastReceipt({ dataDir }) {
  const dir = receiptsDir(dataDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^deletion-[\dTZ-]+\.json$/.test(n)).sort(); } catch { return null; }
  for (const n of names.reverse()) {
    try {
      const f = path.join(dir, n);
      if (!fs.lstatSync(f).isFile()) continue;
      return { ...JSON.parse(fs.readFileSync(f, 'utf8')), file: f };
    } catch { /* unreadable: try the next */ }
  }
  return null;
}

function pending({ dataDir }) {
  try { return JSON.parse(fs.readFileSync(pendingFile(dataDir), 'utf8')); } catch { return null; }
}

module.exports = { CONFIRM_WORD, requestDeletion, cancelDeletion, deleteStores, runPendingDeletion, receiptOf, writeReceipt, lastReceipt, pending, removeTree };
