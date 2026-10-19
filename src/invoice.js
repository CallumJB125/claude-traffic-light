// Client invoices from the per-turn usage usage.js reads out of transcripts.
// Pure except toPdf, which prints a local HTML file with Electron and never
// loads anything over the network.
//
// Honesty: a subscriber is not billed per token, so their cost is the same
// API-list-price estimate the Usage page shows, labelled as such on every
// line, in the CSV and on the PDF. API-key users get "actual" only in the
// sense that it is their recorded tokens at list prices; tax is theirs to add.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { costOf } = require('../usage.js');

const ESTIMATE = 'API-equivalent estimate';
const ACTUAL = 'Actual API usage';
const GAP_MS = 30 * 60 * 1000;
const UNMAPPED = { id: '__unmapped', name: 'Unmapped' };

const basisOf = (mode) => (mode === 'subscription' ? ESTIMATE : ACTUAL);
const cents = (n) => Math.round(n * 100) / 100;
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Turns in [from, to] grouped to sessions, each attributed to a client.
 * `clientOf(cwd)` → {id, name, rate} | null. Turns with no price (a model
 * Plexiform cannot price) are counted in `unpricedTurns`, as the Usage page does.
 */
function buildInvoice({ turns, clientOf, from, to, mode = 'api', clientId = null, useRates = true, now = Date.now() }) {
  const sessions = new Map();
  let unpricedTurns = 0;
  for (const t of turns) {
    if (t.ts < from || t.ts > to) continue;
    const cost = costOf(t);
    if (cost == null) { unpricedTurns += 1; continue; }
    const c = clientOf(t.cwd) || { ...UNMAPPED, rate: null };
    if (clientId && c.id !== clientId) continue;
    const key = `${c.id}\u0000${t.sessionId || 'unknown'}`;
    let s = sessions.get(key);
    if (!s) { s = { client: c, sessionId: t.sessionId || 'unknown', project: t.project || '', cwd: t.cwd || '', first: t.ts, last: t.ts, tsList: [], byModel: new Map() }; sessions.set(key, s); }
    s.first = Math.min(s.first, t.ts);
    s.last = Math.max(s.last, t.ts);
    s.tsList.push(t.ts);
    const m = s.byModel.get(t.model || 'unknown') || { turns: 0, input: 0, output: 0, cache: 0, cost: 0 };
    m.turns += 1; m.input += t.input; m.output += t.output; m.cache += t.cacheRead + t.cacheWrite; m.cost += cost;
    s.byModel.set(t.model || 'unknown', m);
  }
  const lines = [];
  for (const s of [...sessions.values()].sort((a, b) => a.first - b.first || (a.client.name < b.client.name ? -1 : 1))) {
    const rate = useRates ? s.client.rate : null;
    const markup = rate?.markupPct || 0;
    const sid = String(s.sessionId).slice(0, 8);
    for (const [model, m] of [...s.byModel].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push({ kind: 'usage', clientId: s.client.id, client: s.client.name, date: dayOf(s.first), session: sid, project: s.project, model: String(model).replace(/^claude-/, ''), turns: m.turns, input: m.input, output: m.output, cache: m.cache, cost: m.cost, billed: cents(m.cost * (1 + markup / 100)), hours: 0 });
    }
    const ts = s.tsList.sort((a, b) => a - b);
    let ms = 0;
    for (let i = 1; i < ts.length; i += 1) if (ts[i] - ts[i - 1] <= GAP_MS) ms += ts[i] - ts[i - 1];
    const hours = Math.round((ms / 3600000) * 100) / 100;
    const fee = cents((rate?.hourlyRate || 0) * hours + (rate?.sessionFee || 0));
    if (fee > 0) lines.push({ kind: 'time', clientId: s.client.id, client: s.client.name, date: dayOf(s.first), session: sid, project: s.project, model: 'Time and session fee', turns: 0, input: 0, output: 0, cache: 0, cost: 0, billed: fee, hours });
  }
  const totals = lines.reduce((a, l) => ({ cost: a.cost + l.cost, billed: cents(a.billed + l.billed), tokens: a.tokens + l.input + l.output + l.cache, hours: Math.round((a.hours + l.hours) * 100) / 100 }), { cost: 0, billed: 0, tokens: 0, hours: 0 });
  const byClient = new Map();
  for (const l of lines) {
    const b = byClient.get(l.clientId) || { id: l.clientId, name: l.client, cost: 0, billed: 0, tokens: 0, hours: 0 };
    b.cost += l.cost; b.billed = cents(b.billed + l.billed); b.tokens += l.input + l.output + l.cache; b.hours = Math.round((b.hours + l.hours) * 100) / 100;
    byClient.set(l.clientId, b);
  }
  return { basis: basisOf(mode), mode, currency: 'USD', from, to, generatedAt: now, lines, totals, byClient: [...byClient.values()].sort((a, b) => b.billed - a.billed), unpricedTurns, usedRates: !!useRates };
}

// A cell that starts with = + - @ or a control character is read as a formula by spreadsheets.
const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r\n]/.test(v) ? `'${v}` : v);
const csvCell = (v) => { const s = String(safe(v) ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const HEADER = ['Client', 'Date', 'Session', 'Project', 'Line', 'Turns', 'Input tokens', 'Output tokens', 'Cache tokens', 'Hours', 'Cost USD', 'Billed USD', 'Basis'];

function toCsv(inv) {
  const rows = inv.lines.map((l) => [l.client, l.date, l.session, l.project, l.model, l.turns, l.input, l.output, l.cache, l.hours, l.cost.toFixed(4), l.billed.toFixed(2), inv.basis]);
  rows.push(['Total', '', '', '', '', '', '', '', inv.totals.tokens, inv.totals.hours, inv.totals.cost.toFixed(4), inv.totals.billed.toFixed(2), inv.basis]);
  return [HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Number(n).toFixed(2)}`;
const dayRange = (inv) => `${dayOf(inv.from)} to ${dayOf(inv.to)}`;

/** Fills invoice-template.html. Every value is escaped; the template has no script. */
function renderHtml(inv, template, { title = 'Client invoice' } = {}) {
  const rows = inv.lines.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.client)}</td><td>${esc(l.project)}</td><td>${esc(l.model)}</td><td class="n">${l.input + l.output + l.cache}</td><td class="n">${l.hours || ''}</td><td class="n">${l.cost.toFixed(2)}</td><td class="n">${l.billed.toFixed(2)}</td></tr>`).join('\n');
  const clients = inv.byClient.map((b) => `<tr><td>${esc(b.name)}</td><td class="n">${b.cost.toFixed(2)}</td><td class="n">${b.billed.toFixed(2)}</td></tr>`).join('\n');
  const estimate = inv.mode === 'subscription';
  const note = estimate
    ? 'This is an API-equivalent estimate: the cost column is what these tokens would cost at list API prices. A subscription is not billed per token, so it is not an amount anyone was charged.'
    : 'Cost is the recorded token counts priced at list API rates. Check it against your provider invoice before sending.';
  const extra = inv.unpricedTurns ? ` ${inv.unpricedTurns} turn(s) on a model Plexiform cannot price are left out.` : '';
  const map = { TITLE: esc(title), PERIOD: esc(dayRange(inv)), BASIS: esc(inv.basis), NOTE: esc(note + extra + ' Tax is not included.'), ROWS: rows, CLIENTS: clients, COST: usd(inv.totals.cost), BILLED: usd(inv.totals.billed), GENERATED: esc(new Date(inv.generatedAt).toISOString().slice(0, 10)) };
  return template.replace(/\{\{([A-Z]+)\}\}/g, (_, k) => (k in map ? map[k] : ''));
}

/**
 * HTML → PDF bytes with Electron's printToPDF. The page is a local file with
 * scripting off and every non-file request cancelled, so nothing goes out.
 */
async function toPdf(html, { BrowserWindow, tmpDir = os.tmpdir() }) {
  const file = path.join(tmpDir, `plexiform-invoice-${crypto.randomBytes(6).toString('hex')}.html`);
  await fs.promises.writeFile(file, html, { mode: 0o600 });
  let win = null;
  try {
    win = new BrowserWindow({ show: false, webPreferences: { javascript: false, spellcheck: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'invoice-offline' } });
    win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('file:') }));
    await win.loadFile(file);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
  } finally {
    try { win?.destroy(); } catch { /* already gone */ }
    fs.promises.unlink(file).catch(() => {});
  }
}

module.exports = { ESTIMATE, ACTUAL, UNMAPPED, HEADER, buildInvoice, toCsv, renderHtml, toPdf, safe, csvCell, basisOf };
