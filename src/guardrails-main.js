'use strict';
// Project guardrails (src/guardrails.js decides; this file feeds it and shows
// the results). After each checkpointed turn (src/checkpoints.js 'turn-end')
// it scans what the turn added and the files it touched for secrets, secrets
// the browser would receive, database rules that only look locked (per-project
// opt-in) and .env files git would share. While a permission request asks for
// something that can't be taken back, the lamp turns red, Home shows an
// "Approve with care" card, and a restore point is saved before you answer
// (when restore points are on).
//
// Everything stays on this computer: findings hold the file, line, kind and a
// redacted preview, never a secret; .env files are listed by name and never
// read. The only thing that can leave is the "Make a new key" link, opened in
// your browser when you click it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const G = require('./guardrails.js');
const CheckpointGit = require('./checkpoint-git.js');

const DIR = 'guardrails';
const MAX_FILE = 1 << 20;
const RESOLVED_SHOWN_MS = 24 * 3600e3;
const MAX_FINDINGS = 500;
const DANGER_KEEP_MS = 10 * 60e3;

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const project = (top) => (top ? path.basename(String(top).replace(/[\\/]+$/, '')) : 'a project');
const inside = (root, p) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

/**
 * git: src/checkpoint-git.js instance. checkpoints(): the checkpoints instance or null.
 * → {onTurnEnd, scanRepo, list, act, applyLamp, dangers, config}
 */
function createGuardrails({ rootDir, git = CheckpointGit.createGit(), checkpoints = () => null, confirm = async () => true, openLink = async () => {}, notify = () => {}, now = Date.now, log = () => {} }) {
  const dir = path.join(rootDir, DIR);
  const findingsFile = path.join(dir, 'findings.json');
  const configFile = path.join(dir, 'config.json');
  const saltFile = path.join(dir, 'salt');
  let salt = null;
  function saltOf() {
    if (salt) return salt;
    try { salt = fs.readFileSync(saltFile, 'utf8').trim(); } catch { /* first run */ }
    if (!salt || salt.length < 32) { salt = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(saltFile, salt, { mode: 0o600 }); }
    return salt;
  }
  const config = () => { const c = readJson(configFile, {}); return { dbRepos: Array.isArray(c.dbRepos) ? c.dbRepos : [], dbDeclined: Array.isArray(c.dbDeclined) ? c.dbDeclined : [], dbOffers: c.dbOffers && typeof c.dbOffers === 'object' ? c.dbOffers : {} }; };
  const setConfig = (c) => writeJson(configFile, c);
  const load = () => readJson(findingsFile, { findings: {} }).findings ?? {};
  function save(all) {
    const entries = Object.entries(all).sort((a, b) => (b[1].lastSeen ?? 0) - (a[1].lastSeen ?? 0)).slice(0, MAX_FINDINGS);
    writeJson(findingsFile, { findings: Object.fromEntries(entries) });
  }

  async function readWorking(top, file) {
    const abs = path.join(top, file);
    if (!inside(top, abs) || G.isEnvFile(file)) return null;
    try { const st = fs.statSync(abs); if (!st.isFile() || st.size > MAX_FILE) return null; return fs.readFileSync(abs, 'utf8'); } catch { return null; }
  }
  const asLines = (file, text) => text.split('\n').map((t, i) => ({ file, line: i + 1, text: t }));

  async function envLists(top) {
    const spec = [':(glob)**/.env', ':(glob)**/.env.*'];
    const z = (s) => s.split('\0').filter(Boolean);
    const [tracked, exposed] = await Promise.all([
      git.run(top, ['ls-files', '-z', '--cached', '--', ...spec], { timeoutMs: 10000 }).then(z).catch(() => []),
      git.run(top, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...spec], { timeoutMs: 10000 }).then(z).catch(() => []),
    ]);
    return { tracked, exposed };
  }

  /** Rescans `files` (relative to top) as they are now, plus the repo's .env files. attrib: id → turn info from a diff. */
  async function scanRepo(top, files, { attrib = new Map(), dbFiles = [] } = {}) {
    const s = saltOf();
    const c = config();
    const dbOn = c.dbRepos.includes(top);
    const scanned = [];
    for (const file of files) {
      const text = await readWorking(top, file);
      if (text == null) continue;
      const lines = asLines(file, text);
      scanned.push(...G.secretFindings(lines, { salt: s, repo: top }), ...G.browserFindings(lines, { salt: s, repo: top }));
      if (dbOn) scanned.push(...G.dbFindings(lines, { salt: s, repo: top }));
    }
    for (const f of scanned) { const a = attrib.get(f.id); if (a) Object.assign(f, a, { title: f.title.replace(/^A change/, `Turn ${a.turn}`) }); }
    const env = G.envFindings(await envLists(top), { salt: s, repo: top });
    let all = load();
    const set = new Set(files);
    all = G.reconcile(all, scanned, { repo: top, types: dbOn ? ['secret', 'browser', 'db'] : ['secret', 'browser'], files: set, now: now() });
    all = G.reconcile(all, env, { repo: top, types: ['env'], now: now() });
    if (dbFiles.length && !dbOn && !c.dbDeclined.includes(top) && !c.dbOffers[top]) { c.dbOffers[top] = now(); setConfig(c); }
    save(all);
    notify();
    return Object.values(all).filter((f) => f.repo === top);
  }

  async function onTurnEnd({ sessionId, top, turn, before, after }) {
    if (!top || !after) return;
    let changed = [];
    const attrib = new Map();
    if (before) {
      try { changed = (await git.diffFiles(top, before, after)).filter((f) => f.status !== 'D').map((f) => f.path); } catch { changed = []; }
      try {
        const diff = await git.diffText(top, before, after);
        const added = G.addedLines(diff);
        const s = saltOf();
        for (const f of [...G.secretFindings(added, { salt: s, repo: top, turn, sessionId }), ...G.browserFindings(added, { salt: s, repo: top, turn, sessionId }), ...G.dbFindings(added, { salt: s, repo: top, turn, sessionId })]) attrib.set(f.id, { turn, sessionId });
      } catch (e) { log(`[guardrails] diff: ${e?.code || 'failed'}`); }
    }
    const known = Object.values(load()).filter((f) => f.repo === top && f.file && f.status !== 'resolved' && f.type !== 'env').map((f) => f.file);
    const dbFiles = changed.filter((f) => G.DB_FILE.test(f));
    await scanRepo(top, [...new Set([...changed, ...known])], { attrib, dbFiles });
  }

  // ── commands you can't take back ──
  const dangerById = new Map(); // request id → {id, sessionId, cwd, shape, target, at, saved}
  function snapshotEnabled() { return readJson(path.join(rootDir, 'checkpoints.json'), {})?.enabled === true; }
  async function saveRestorePoint(d) {
    if (!snapshotEnabled()) { d.saved = 'off'; notify(); return; }
    try {
      const repo = await git.repoOf(d.cwd);
      if (repo.skip) { d.saved = 'not-git'; notify(); return; }
      const { safetyRef } = require('./checkpoints.js');
      const sha = await git.snapshot(repo, { message: 'plexiform checkpoint safety' });
      await git.updateRef(repo.top, safetyRef(d.sessionId, now()), sha);
      d.saved = 'yes';
    } catch (e) { d.saved = 'failed'; log(`[guardrails] restore point: ${e?.code || 'failed'}`); }
    notify();
  }
  /** Danger for the pending requests; saves a restore point the first time each is seen. */
  function dangers(requests) {
    const live = new Set();
    for (const r of Array.isArray(requests) ? requests : []) {
      if (!r || typeof r.id !== 'string') continue;
      live.add(r.id);
      if (dangerById.has(r.id)) continue;
      let d = null;
      try { d = G.destructive(r.tool, r.toolInput); } catch { d = null; }
      if (!d) { dangerById.set(r.id, null); continue; }
      const entry = { id: r.id, sessionId: String(r.sessionId || 'default'), cwd: typeof r.cwd === 'string' ? r.cwd : '', ...d, at: now(), saved: 'pending' };
      dangerById.set(r.id, entry);
      void saveRestorePoint(entry);
    }
    for (const [id, d] of dangerById) if (!live.has(id) && (!d || now() - d.at > DANGER_KEEP_MS)) dangerById.delete(id);
    return [...dangerById.entries()].filter(([id, d]) => d && live.has(id)).map(([, d]) => d);
  }
  let lastRequests = [];
  /** Turns the lamp red while something can't be taken back, or a new leak hasn't been seen. */
  function applyLamp(look, requests) {
    lastRequests = Array.isArray(requests) ? requests : [];
    if (!look) return look;
    const fresh = Object.values(load()).some((f) => f.status === 'new' && (f.type === 'secret' || f.type === 'browser'));
    if (dangers(lastRequests).length || fresh) look.lamp = 'red';
    return look;
  }

  // ── Home ──
  const SAVED = { yes: 'A restore point was saved first, so you can undo it from What changed.', off: 'Turn on restore points (What changed) to have one saved before commands like this.', 'not-git': 'This folder is not a git project, so no restore point could be saved.', failed: 'A restore point could not be saved.', pending: 'Saving a restore point…' };
  function list() {
    const all = load();
    const t = now();
    const cards = Object.values(all)
      .filter((f) => f.status === 'new' || f.status === 'open' || (f.status === 'resolved' && t - (f.resolvedAt ?? 0) < RESOLVED_SHOWN_MS))
      .sort((a, b) => (a.status === 'resolved') - (b.status === 'resolved') || (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
      .map((f) => ({ id: f.id, type: f.type, status: f.status, title: f.title, fix: f.fix, preview: f.preview || '', project: project(f.repo), canRotate: !!f.rotate && f.status !== 'resolved', canRestore: !!f.turn && !!f.sessionId && f.status !== 'resolved' && f.type !== 'env' }));
    let changed = false;
    for (const f of Object.values(all)) if (f.status === 'new') { f.status = 'open'; changed = true; }
    if (changed) { save(all); notify(); }
    const c = config();
    const offers = Object.keys(c.dbOffers).filter((top) => !c.dbRepos.includes(top) && !c.dbDeclined.includes(top))
      .map((top) => ({ id: `db:${crypto.createHash('sha256').update(top).digest('hex').slice(0, 16)}`, project: project(top), title: `${project(top)} has database rules`, fix: 'Plexiform can check them after each AI turn for rules that look locked but let anyone in. It only reads the rule files, on this computer.' }));
    const careful = dangers(lastRequests).map((d) => ({ id: `danger:${crypto.createHash('sha256').update(d.id).digest('hex').slice(0, 16)}`, title: `Approve with care: ${d.shape}`, target: d.target, project: project(d.cwd), note: SAVED[d.saved] ?? '' }));
    return { findings: cards, offers, careful };
  }

  async function act(id, action) {
    if (typeof id !== 'string' || id.length > 100) return { ok: false };
    const c = config();
    if (id.startsWith('db:')) {
      const top = Object.keys(c.dbOffers).find((t) => `db:${crypto.createHash('sha256').update(t).digest('hex').slice(0, 16)}` === id);
      if (!top) return { ok: false };
      delete c.dbOffers[top];
      if (action === 'db-on') c.dbRepos = [...new Set([...c.dbRepos, top])];
      else if (action === 'db-off') c.dbDeclined = [...new Set([...c.dbDeclined, top])];
      else return { ok: false };
      setConfig(c);
      if (action === 'db-on') {
        let files = [];
        try { files = (await git.run(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)supabase/migrations/*.sql', ':(glob)**/firestore.rules', ':(glob)**/storage.rules'], { timeoutMs: 10000 })).split('\0').filter(Boolean); } catch { files = []; }
        await scanRepo(top, files);
      }
      notify();
      return { ok: true };
    }
    const all = load();
    const f = all[id];
    if (!f) return { ok: false };
    if (action === 'dismiss') { f.status = 'dismissed'; save(all); notify(); return { ok: true }; }
    if (action === 'recheck') { await scanRepo(f.repo, [f.file].filter(Boolean)); return { ok: true }; }
    if (action === 'rotate') { if (!f.rotate || G.rotateUrl(f.kind) !== f.rotate) return { ok: false }; await openLink(f.rotate); return { ok: true }; }
    if (action === 'restore') {
      const cps = checkpoints();
      if (!cps || !f.turn || !f.sessionId) return { ok: false, error: 'Restore points are not on for this project.' };
      if (!(await confirm({ project: project(f.repo), turn: f.turn }))) return { ok: false, cancelled: true };
      const r = await cps.restore(f.sessionId, { turn: f.turn, which: 'before' }).catch(() => ({ ok: false, reason: 'failed' }));
      if (r.ok) await scanRepo(f.repo, [f.file].filter(Boolean));
      return r.ok ? { ok: true, note: `Files are back to how they were before turn ${f.turn}. The key may already have been seen, so still make a new one.` } : { ok: false, error: r.reason === 'busy' ? 'An AI is working in that project right now. Try again when it stops.' : 'That restore point is gone.' };
    }
    return { ok: false };
  }

  return { onTurnEnd, scanRepo, list, act, applyLamp, dangers, config };
}

let instance = null;
/** computeState's hook (main.js): mutates look like seasonal-main does. */
function applyLamp(look, requests) {
  if (!instance) return look;
  try { return instance.applyLamp(look, requests); } catch { return look; }
}

function install({ ipcMain, dialog, shell, BrowserWindow, rootDir, allowed, broadcast = () => {}, log = () => {} }) {
  const Checkpoints = require('./checkpoints.js');
  let pending = null;
  const notify = () => { if (pending) return; pending = setTimeout(() => { pending = null; try { broadcast(); } catch { /* window gone */ } }, 100); };
  instance = createGuardrails({
    rootDir, log, notify,
    checkpoints: () => Checkpoints.events.instance ?? null,
    openLink: (url) => shell.openExternal(url), // privacy-flow: guardrails-rotate-link
    confirm: async ({ project: p, turn }) => {
      const r = await dialog.showMessageBox(BrowserWindow?.getFocusedWindow?.() ?? undefined, { type: 'warning', buttons: ['Cancel', 'Restore files'], defaultId: 0, cancelId: 0, noLink: true, message: `Put the files in ${p} back to how they were before turn ${turn}?`, detail: 'Everything that turn and later turns changed in your files is undone. Plexiform saves the files as they are now first, so you can undo this from What changed.' });
      return r.response === 1;
    },
  });
  Checkpoints.events.on('turn-end', (t) => { instance.onTurnEnd(t).catch((e) => log(`[guardrails] scan: ${e?.message ?? e}`)); });
  ipcMain.handle('guardrails:list', (e) => (allowed(e) ? instance.list() : null));
  ipcMain.handle('guardrails:act', (e, id, action) => (allowed(e) && typeof action === 'string' ? instance.act(id, action) : { ok: false }));
  return instance;
}

module.exports = { createGuardrails, install, applyLamp };
