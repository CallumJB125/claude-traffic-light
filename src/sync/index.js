// Encrypted sync, desktop side (W3-C): the paid-wiring.js package entry.
// register(ctx) serves the Sync page (sync.html) and, only while sync is
// turned on here, syncs every 15 minutes with the signed-in team hub.
//
// What syncs: memory-index session rows (tool, session id, repo, branch,
// title, times, cost), checkpoint session summaries (repo name, source,
// times) and handover documents, all through src/secret-patterns.js first
// (log.js). Never raw transcripts (the log refuses them unless a caller
// opts in; nothing here does). Sync needs Plus or Team (has('sync')); when a
// plan lapses this computer still downloads (read-only) and stops uploading.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createSyncClient } = require('./client');

const EVERY_MS = 15 * 60_000;
const FIRST_MS = 60_000;
const MAX_HANDOVERS = 100;
const MAX_HANDOVER_BYTES = 64 * 1024;
const MAX_SESSIONS = 500;

/** JSON files in one 0700 directory, each 0600, written atomically. */
function fileStore(dir) {
  const file = (k) => path.join(dir, `${k}.json`);
  return {
    load(k) { try { return JSON.parse(fs.readFileSync(file(k), 'utf8')); } catch { return null; } },
    save(k, v) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch { /* not ours to fix */ }
      const tmp = `${file(k)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
      fs.renameSync(tmp, file(k));
    },
  };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Put this computer's current syncable docs into the log (unchanged ones make no op). */
function collect(rootDir, lg) {
  // Memory index: session rows only, never turn text.
  const idx = path.join(rootDir, 'memory', 'index.db');
  if (fs.existsSync(idx)) {
    let db = null;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(idx, { readOnly: true });
      for (const r of db.prepare('SELECT tool, sid, repo, branch, title, started, ended, cost FROM sessions ORDER BY started DESC LIMIT ?').all(MAX_SESSIONS)) {
        lg.put(`memory:${r.tool}:${r.sid}`.slice(0, 300), 'memory', { ...r });
      }
    } catch { /* the index is busy or missing: next round */ } finally { try { db?.close(); } catch { /* closed */ } }
  }
  // Checkpoints: one summary per session (repo folder name, never the path).
  const cps = readJson(path.join(rootDir, 'checkpoints', 'index.json'))?.sessions ?? {};
  for (const [sid, s] of Object.entries(cps)) {
    if (!s || typeof s !== 'object') continue;
    lg.put(`checkpoint:${sid}`.slice(0, 300), 'checkpoint', { sid, repo: s.top ? path.basename(s.top) : undefined, source: s.source, updatedAt: s.updatedAt, skip: s.skip ?? undefined });
  }
  // Handover documents (markdown the app already wrote), newest first.
  const dir = path.join(rootDir, 'handovers');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { names = []; }
  const docs = names.map((n) => { try { return { n, st: fs.statSync(path.join(dir, n)) }; } catch { return null; } })
    .filter((d) => d && d.st.isFile() && d.st.size <= MAX_HANDOVER_BYTES).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, MAX_HANDOVERS);
  for (const { n, st } of docs) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    const key = n.slice(0, -3);
    const title = /^#\s+(.+)$/m.exec(text)?.[1];
    lg.put(`handover:${key}`.slice(0, 300), 'handover', { key, title, updatedAt: Math.round(st.mtimeMs), text });
  }
}

const deviceLabel = () => ({ darwin: 'Mac', win32: 'Windows PC', linux: 'Linux PC' }[process.platform] ?? 'Computer');

function register(ctx) {
  const { ipcMain, rootDir, entitlements: E, fromPage = () => false, onQuit = () => {}, log = () => {} } = ctx;
  if (!ipcMain || !rootDir || !E) return null;
  const store = fileStore(path.join(rootDir, 'sync'));
  const settings = () => ({ enabled: false, ...(store.load('settings') ?? {}) });
  const identity = () => ctx.buddy?.()?.interactionHostIdentity?.() ?? null;
  const client = createSyncClient({ identity, fetch: (...a) => globalThis.fetch(...a), store, deviceName: deviceLabel() }); // privacy-flow: sync
  let last = null;
  let running = null;

  const round = () => {
    if (running) return running;
    running = client.syncNow({ collect: E.has('sync') ? (lg) => collect(rootDir, lg) : null })
      .then((r) => (last = { ok: true, ...r }))
      .catch((e) => { log(`[sync] ${e?.code ?? 'error'}: ${e?.message ?? e}`); return (last = { ok: false, code: e?.code ?? 'error', message: e?.message ?? String(e), at: Date.now() }); })
      .finally(() => { running = null; });
    return running;
  };
  // Only while turned on here and signed in: never a request otherwise.
  const tick = () => { if (settings().enabled && identity()) round(); };
  const first = setTimeout(tick, FIRST_MS); first.unref?.();
  const every = setInterval(tick, EVERY_MS); every.unref?.();
  onQuit(() => { clearTimeout(first); clearInterval(every); });

  const fromSync = (e) => { try { return fromPage(e, 'sync'); } catch { return false; } };
  const wrap = (fn) => async (e, ...args) => {
    if (!fromSync(e)) return null;
    try { return await fn(...args); } catch (err) {
      return { ok: false, code: err?.code ?? 'error', message: err?.message ?? String(err) };
    }
  };
  const view = async () => {
    const s = settings();
    const out = { entitled: E.has('sync'), plan: E.plan?.() ?? 'free', signedIn: !!identity(), enabled: s.enabled, local: client.local(), last, hub: null };
    if (s.enabled && out.signedIn) out.hub = await client.state().catch((e) => ({ error: e?.code ?? 'error', message: e?.message }));
    return out;
  };
  ipcMain.handle('sync:state', wrap(view));
  ipcMain.handle('sync:enable', wrap(async () => {
    if (!E.has('sync')) return { ok: false, code: 'PLAN_REQUIRED', message: 'Sync needs Plus or Team.' };
    const r = await client.enable();
    store.save('settings', { ...settings(), enabled: true });
    if (r.ok) round();
    return r;
  }));
  ipcMain.handle('sync:disable', wrap(async () => { store.save('settings', { ...settings(), enabled: false }); return { ok: true }; }));
  ipcMain.handle('sync:recover', wrap(async (code) => { const r = await client.recover(String(code ?? '')); store.save('settings', { ...settings(), enabled: true }); round(); return r; }));
  ipcMain.handle('sync:approve', wrap(async (id) => client.approve(String(id ?? ''))));
  ipcMain.handle('sync:revoke', wrap(async (id) => client.revoke(String(id ?? ''))));
  ipcMain.handle('sync:new-code', wrap(async () => client.newRecoveryCode()));
  ipcMain.handle('sync:now', wrap(async () => round()));
  return { client, round, collect: (lg) => collect(rootDir, lg) };
}

module.exports = { register, collect, fileStore };
