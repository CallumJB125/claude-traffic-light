// Client billing: which folders belong to which client, and the invoice built
// from those sessions' spend. The mapping lives only in clients.json in the
// data folder; nothing here touches the network. Paid wiring calls register().
//
// Free: CSV for the current month, no rate cards. Plus: full history, PDF and
// rate cards (entitlements billing.pdf / billing.rateCards / limits billing.months).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Usage = require('../usage.js');
const Invoice = require('./invoice.js');

const FILE = 'clients.json';
const MAX_CLIENTS = 200;
const MAX_MAPPINGS = 1000;
const USAGE_TTL_MS = 60 * 1000;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };

/** A folder path in the form used to compare two paths; macOS and Windows are case-insensitive. */
function norm(p, platform = process.platform) {
  let s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return '';
  if (platform === 'darwin' || platform === 'win32') s = s.toLowerCase();
  return s;
}

function normalize(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const seen = new Set();
  const clients = [];
  for (const c of Array.isArray(s.clients) ? s.clients : []) {
    const id = str(c?.id, 40);
    const name = str(c?.name, 80);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !name || seen.has(id) || id === Invoice.UNMAPPED.id) continue;
    seen.add(id);
    clients.push({ id, name, rate: { markupPct: num(c.rate?.markupPct, 0, 1000), hourlyRate: num(c.rate?.hourlyRate, 0, 1e5), sessionFee: num(c.rate?.sessionFee, 0, 1e6) } });
    if (clients.length >= MAX_CLIENTS) break;
  }
  const mappings = [];
  for (const m of Array.isArray(s.mappings) ? s.mappings : []) {
    const p = str(m?.path, 1024);
    if (p && seen.has(m?.clientId) && !mappings.some((x) => norm(x.path) === norm(p))) mappings.push({ path: p, clientId: m.clientId });
    if (mappings.length >= MAX_MAPPINGS) break;
  }
  return { version: 1, clients, mappings };
}

function load(root) {
  try { return normalize(JSON.parse(fs.readFileSync(path.join(root, FILE), 'utf8'))); } catch { return normalize(null); }
}

function save(root, store) {
  const clean = normalize(store);
  const file = path.join(root, FILE);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return clean;
}

/** cwd → {id, name, rate} of the client whose mapped folder holds it (the deepest mapping wins), or null. */
function clientResolver(store, platform = process.platform) {
  const byId = new Map(store.clients.map((c) => [c.id, c]));
  const maps = store.mappings.map((m) => ({ p: norm(m.path, platform), c: byId.get(m.clientId) })).filter((m) => m.p && m.c).sort((a, b) => b.p.length - a.p.length);
  return (cwd) => {
    const p = norm(cwd, platform);
    if (!p) return null;
    return maps.find((m) => p === m.p || p.startsWith(`${m.p}/`))?.c ?? null;
  };
}

/**
 * The range the plan allows. Free keeps only the current calendar month (limits billing.months);
 * a plan with no limit passes the request through. → {from, to, clamped}.
 */
function allowedRange({ from, to }, { months, now = Date.now() }) {
  let f = Number.isFinite(from) ? from : 0;
  const t = Math.min(Number.isFinite(to) ? to : now, now);
  if (!Number.isFinite(months)) return { from: f, to: t, clamped: false };
  const d = new Date(now);
  const floor = new Date(d.getFullYear(), d.getMonth() - (months - 1), 1).getTime();
  const clamped = f < floor;
  if (clamped) f = floor;
  return { from: f, to: t, clamped };
}

// Nothing in a transcript says whether a turn was billed per token, so the
// invoice says "Actual API usage" only when the user chose "API" under
// Preferences > Spend. Unset (the default) is labelled an estimate: the same
// list-price numbers, without claiming anyone was charged them.
function modeOf(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))?.spend?.mode === 'api' ? 'api' : 'subscription'; } catch { return 'subscription'; }
}

/** The invoice for a request, shaped by what the entitlements allow. */
function invoiceFor({ turns, store, req, ent, mode, now = Date.now(), platform }) {
  const range = allowedRange(req, { months: ent.limits()['billing.months'], now });
  const inv = Invoice.buildInvoice({ turns, clientOf: clientResolver(store, platform), from: range.from, to: range.to, mode, clientId: req.clientId || null, useRates: ent.has('billing.rateCards'), now });
  return { ...inv, clamped: range.clamped };
}

function register(ctx) {
  const { ipcMain, rootDir, entitlements: ent, fromPage, log } = ctx;
  const cache = new Map();
  let memo = { at: 0, turns: [] };
  const turnsFor = async (from) => {
    if (Date.now() - memo.at < USAGE_TTL_MS && memo.since <= from) return memo.turns;
    const root = process.env.CLAUDE_TRAFFIC_LIGHT_PROJECTS;
    const r = await Usage.readTurns({ since: from, cache, ...(root ? { root } : {}) });
    memo = { at: Date.now(), turns: r.turns, since: from };
    return r.turns;
  };
  const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => (fromPage(e, 'clients') ? fn(e, ...args) : null));
  const state = () => ({ store: load(rootDir), plan: ent.plan(), pdf: ent.has('billing.pdf'), rateCards: ent.has('billing.rateCards'), months: Number.isFinite(ent.limits()['billing.months']) ? ent.limits()['billing.months'] : null, mode: modeOf(rootDir) });
  const reqOf = (r) => ({ from: Number(r?.from), to: Number(r?.to), clientId: str(r?.clientId, 40) || null });
  const build = async (r) => {
    const req = reqOf(r);
    const range = allowedRange(req, { months: ent.limits()['billing.months'] });
    return invoiceFor({ turns: await turnsFor(range.from), store: load(rootDir), req, ent, mode: modeOf(rootDir) });
  };

  handle('clients:state', () => state());
  handle('clients:save', (e, store) => { save(rootDir, store); return state(); });
  handle('clients:folders', async () => {
    const turns = await turnsFor(Date.now() - 90 * 86400000);
    const seen = new Map();
    for (const t of turns) if (t.cwd) seen.set(t.cwd, Math.max(seen.get(t.cwd) || 0, t.ts));
    return [...seen].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([cwd]) => cwd);
  });
  handle('clients:pick-folder', async (e) => {
    const { dialog, BrowserWindow } = require('electron');
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || undefined, { title: 'Choose the project folder', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('clients:preview', async (e, r) => {
    const inv = await build(r);
    return { basis: inv.basis, mode: inv.mode, from: inv.from, to: inv.to, clamped: inv.clamped, totals: inv.totals, byClient: inv.byClient, unpricedTurns: inv.unpricedTurns, lines: inv.lines.slice(0, 200), lineCount: inv.lines.length, usedRates: inv.usedRates };
  });
  handle('clients:export', async (e, r, format) => {
    const { dialog, BrowserWindow } = require('electron');
    const pdf = format === 'pdf';
    if (pdf && !ent.has('billing.pdf')) return { ok: false, reason: 'plan' };
    if (!pdf && format !== 'csv') return { ok: false, reason: 'format' };
    const inv = await build(r);
    const win = BrowserWindow.fromWebContents(e.sender) || undefined;
    const name = `plexiform-invoice-${new Date(inv.from).toISOString().slice(0, 10)}.${pdf ? 'pdf' : 'csv'}`;
    const pick = await dialog.showSaveDialog(win, { title: pdf ? 'Save invoice PDF' : 'Save invoice CSV', defaultPath: name, filters: [pdf ? { name: 'PDF', extensions: ['pdf'] } : { name: 'CSV', extensions: ['csv'] }] });
    if (pick.canceled || !pick.filePath) return { ok: false, reason: 'canceled' };
    if (pdf) {
      const template = fs.readFileSync(path.join(__dirname, '..', 'invoice-template.html'), 'utf8');
      await fs.promises.writeFile(pick.filePath, await Invoice.toPdf(Invoice.renderHtml(inv, template), { BrowserWindow, tmpDir: os.tmpdir() }));
    } else {
      await fs.promises.writeFile(pick.filePath, Invoice.toCsv(inv));
    }
    log?.(`[clients] exported ${format} (${inv.lines.length} lines)`);
    return { ok: true, path: pick.filePath };
  });
}

module.exports = { register, normalize, load, save, clientResolver, allowedRange, invoiceFor, modeOf, norm, FILE };
