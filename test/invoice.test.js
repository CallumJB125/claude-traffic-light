const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Usage = require('../usage.js');
const Clients = require('../src/clients.js');
const Invoice = require('../src/invoice.js');
const E = require('../src/entitlements');
const { registerAll, PACKAGES } = require('../src/paid-wiring');

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime();
const MIN = 60000;
let n = 0;
const turn = (over) => ({ id: `t${n++}`, ts: NOW - 3600000, sessionId: 's1aaaaaaaa', cwd: '/work/acme/api', project: 'api', model: 'claude-sonnet-4-5', modelKey: 'sonnet', subagent: false, input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300, cacheWrite1h: 0, ...over });
const TURNS = [
  turn({}), turn({ ts: NOW - 3600000 + 5 * MIN, output: 900 }),
  turn({ sessionId: 's2bbbbbbbb', cwd: '/work/acme/web', project: 'web', model: 'claude-opus-4-5', modelKey: 'opus', ts: NOW - 7200000 }),
  turn({ sessionId: 's3cccccccc', cwd: '/work/other/thing', project: 'thing', ts: NOW - 5400000 }),
  turn({ sessionId: 's4dddddddd', cwd: '/work/acme/api', project: 'api', ts: new Date(2026, 7, 3).getTime() }),
  turn({ sessionId: 's5eeeeeeee', model: 'mystery-1', modelKey: null }),
];
const store = () => Clients.normalize({ clients: [{ id: 'acme', name: 'Acme', rate: { markupPct: 20, hourlyRate: 100, sessionFee: 5 } }], mappings: [{ path: '/work/acme', clientId: 'acme' }] });
const ent = (plan) => ({ has: (k) => (plan !== 'free' && ['billing.pdf', 'billing.rateCards'].includes(k)) || k === 'billing.csv', limits: () => ({ 'billing.months': plan === 'free' ? 1 : Infinity }), plan: () => plan });
const month = { from: new Date(2026, 9, 1).getTime(), to: NOW };

test('folder mapping attributes sessions, deepest folder wins, the rest is Unmapped', () => {
  const s = Clients.normalize({ clients: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], mappings: [{ path: '/work/acme', clientId: 'a' }, { path: '/work/acme/web/', clientId: 'b' }] });
  const of = Clients.clientResolver(s, 'linux');
  assert.equal(of('/work/acme/api').id, 'a');
  assert.equal(of('/work/acme/web/src').id, 'b');
  assert.equal(of('/work/acmeco'), null);
  assert.equal(of(null), null);
  const inv = Invoice.buildInvoice({ turns: TURNS, clientOf: Clients.clientResolver(store(), 'linux'), ...month });
  assert.deepEqual(inv.byClient.map((b) => b.name).sort(), ['Acme', 'Unmapped']);
  assert.ok(inv.lines.some((l) => l.client === 'Unmapped' && l.project === 'thing'));
  assert.equal(inv.unpricedTurns, 1);
});

test('totals reconcile with the Usage page for the same range', () => {
  const inv = Invoice.buildInvoice({ turns: TURNS, clientOf: Clients.clientResolver(store(), 'linux'), from: new Date(2026, 9, 1).getTime(), to: NOW, useRates: false });
  const usage = Usage.summarise(TURNS, { days: 15, now: NOW });
  assert.ok(Math.abs(inv.totals.cost - usage.total.cost) < 1e-3);
  const byProject = Object.fromEntries(usage.byProject.map((p) => [p.name, p.cost]));
  for (const p of ['api', 'web', 'thing']) {
    const mine = inv.lines.filter((l) => l.project === p).reduce((a, l) => a + l.cost, 0);
    assert.ok(Math.abs(mine - byProject[p]) < 1e-3, p);
  }
  assert.equal(inv.unpricedTurns, usage.unknown.turns);
});

test('rate cards add markup, hours and a session fee; useRates false bills at cost', () => {
  const inv = Invoice.buildInvoice({ turns: TURNS, clientOf: Clients.clientResolver(store(), 'linux'), ...month, clientId: 'acme' });
  const l = inv.lines.find((x) => x.project === 'api' && x.kind === 'usage');
  assert.equal(l.billed, Math.round(l.cost * 1.2 * 100) / 100);
  const time = inv.lines.find((x) => x.kind === 'time' && x.session === 's1aaaaaa');
  assert.equal(time.hours, 0.08);
  assert.equal(time.billed, Math.round((100 * 0.08 + 5) * 100) / 100);
  const plain = Invoice.buildInvoice({ turns: TURNS, clientOf: Clients.clientResolver(store(), 'linux'), ...month, clientId: 'acme', useRates: false });
  assert.ok(plain.lines.every((x) => x.kind === 'usage' && Math.abs(x.billed - x.cost) < 0.006));
});

test('subscription mode says API-equivalent estimate in the CSV and the PDF page; api mode says actual', () => {
  const args = { turns: TURNS, clientOf: Clients.clientResolver(store(), 'linux'), ...month };
  const sub = Invoice.buildInvoice({ ...args, mode: 'subscription' });
  const api = Invoice.buildInvoice({ ...args, mode: 'api' });
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'invoice-template.html'), 'utf8');
  assert.match(Invoice.toCsv(sub), /API-equivalent estimate/);
  assert.match(Invoice.renderHtml(sub, tpl), /API-equivalent estimate[\s\S]*not billed per token/);
  assert.doesNotMatch(Invoice.toCsv(api), /estimate/);
  assert.match(Invoice.toCsv(api), /Actual API usage/);
});

test('CSV cells are formula-safe and quoted', () => {
  const evil = Clients.normalize({ clients: [{ id: 'x', name: '=HYPERLINK("http://x")' }, { id: 'y', name: '+1,2' }], mappings: [{ path: '/work/acme', clientId: 'x' }, { path: '/work/other', clientId: 'y' }] });
  const t = [turn({ project: '@cmd', cwd: '/work/acme/q' }), turn({ cwd: '/work/other/z', sessionId: 'zz' })];
  const csv = Invoice.toCsv(Invoice.buildInvoice({ turns: t, clientOf: Clients.clientResolver(evil, 'linux'), ...month }));
  assert.match(csv, /^'=HYPERLINK\(""http:\/\/x""\)|\r\n"'=HYPERLINK\(""http:\/\/x""\)"/m);
  assert.match(csv, /"'\+1,2"/);
  assert.match(csv, /,'@cmd,/);
  for (const row of csv.split('\r\n').slice(1)) assert.ok(!/(^|,)[=+\-@]/.test(row.replace(/"[^"]*"/g, '""')), row);
  assert.equal(Invoice.csvCell('\t=1'), "'\t=1");
});

test('HTML escapes every value and has no script or network reference', () => {
  const evil = Clients.normalize({ clients: [{ id: 'x', name: '<script>alert(1)</script>' }], mappings: [{ path: '/work/acme', clientId: 'x' }] });
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'invoice-template.html'), 'utf8');
  const html = Invoice.renderHtml(Invoice.buildInvoice({ turns: TURNS, clientOf: Clients.clientResolver(evil, 'linux'), ...month }), tpl);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(tpl, /https?:|<script|@import|url\(/);
  assert.doesNotMatch(html, /\{\{/);
});

test('PDF is printed from a local file with scripting off and non-file requests cancelled', async () => {
  const calls = { cancel: [], loaded: null, opts: null, destroyed: false };
  class FakeWin {
    constructor(o) { calls.opts = o; this.webContents = { session: { webRequest: { onBeforeRequest: (fn) => { fn({ url: 'https://evil.example/x' }, (r) => calls.cancel.push(r.cancel)); fn({ url: 'file:///a.html' }, (r) => calls.cancel.push(r.cancel)); } } }, printToPDF: async () => Buffer.from('%PDF-fake') }; }
    async loadFile(f) { calls.loaded = f; assert.ok(fs.existsSync(f)); }
    destroy() { calls.destroyed = true; }
  }
  const buf = await Invoice.toPdf('<html></html>', { BrowserWindow: FakeWin });
  assert.equal(buf.toString(), '%PDF-fake');
  assert.equal(calls.opts.webPreferences.javascript, false);
  assert.deepEqual(calls.cancel, [true, false]);
  assert.ok(calls.destroyed);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!fs.existsSync(calls.loaded));
});

test('free plan keeps the current month and no rate cards; plus has full history', () => {
  const free = Clients.invoiceFor({ turns: TURNS, store: store(), req: { from: 0, to: NOW, clientId: null }, ent: ent('free'), mode: 'api', now: NOW, platform: 'linux' });
  assert.equal(free.clamped, true);
  assert.equal(free.from, new Date(2026, 9, 1).getTime());
  assert.ok(!free.lines.some((l) => l.date.startsWith('2026-08')));
  assert.ok(free.lines.every((l) => l.kind === 'usage' && Math.abs(l.billed - l.cost) < 0.006));
  const plus = Clients.invoiceFor({ turns: TURNS, store: store(), req: { from: 0, to: NOW, clientId: null }, ent: ent('plus'), mode: 'api', now: NOW, platform: 'linux' });
  assert.equal(plus.clamped, false);
  assert.ok(plus.lines.some((l) => l.date.startsWith('2026-08')));
  assert.ok(plus.lines.some((l) => l.kind === 'time'));
});

test('the mapping persists locally, is validated, and register() gates IPC by page', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clients-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  Clients.save(root, { clients: [{ id: 'acme', name: 'Acme', rate: { markupPct: -5, hourlyRate: 'x' } }, { id: '../bad', name: 'Bad' }], mappings: [{ path: '/a', clientId: 'acme' }, { path: '/b', clientId: 'nope' }] });
  const back = Clients.load(root);
  assert.deepEqual(back.clients.map((c) => c.id), ['acme']);
  assert.deepEqual(back.clients[0].rate, { markupPct: 0, hourlyRate: 0, sessionFee: 0 });
  assert.equal(back.mappings.length, 1);
  assert.equal(fs.statSync(path.join(root, Clients.FILE)).mode & 0o077, 0);
  E.configure({ root });
  const handlers = new Map();
  const ctx = { ipcMain: { handle: (c, f) => handlers.set(c, f) }, rootDir: root, entitlements: E, fromPage: (e, id) => e.page === id, log() {} };
  Clients.register(ctx);
  assert.equal(await handlers.get('clients:state')({ page: 'usage' }), null);
  const st = await handlers.get('clients:state')({ page: 'clients' });
  assert.equal(st.plan, 'free');
  assert.equal(st.pdf, false);
  assert.equal(st.months, 1);
  assert.deepEqual((await handlers.get('clients:export')({ page: 'clients' }, {}, 'pdf')), { ok: false, reason: 'plan' });
});

test('paid wiring finds the module and registers it', () => {
  const only = PACKAGES.filter((p) => p[0] === 'client-billing');
  const res = registerAll({ ipcMain: { handle() {} }, rootDir: os.tmpdir(), fromPage: () => false, log() {} }, only);
  assert.equal(res.find((r) => r.name === 'client-billing').status, 'ok');
});

test('nothing in the billing modules reaches the network', () => {
  for (const f of ['src/clients.js', 'src/invoice.js', 'clients-local.js', 'clients-preload.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|require\(['"](?:node:)?(?:https?|net|tls|dns)['"]\)|loadURL|\bnet\.request/, f);
  }
});
