// Local backups of the user's own settings, kept OUTSIDE the data folder so
// deleting ~/.claude-traffic-light does not take them too (2026-09-29: a
// deleted data folder lost a tester-grade set of rules and router config).
//
// One snapshot = one directory named by its ISO timestamp:
//   <backups>/<id>/manifest.json   { v, createdAt, appVersion, reason, files:[{name,sha256,size}] }
//   <backups>/<id>/files/<name>    copies of the allow-listed files
// Written into `.tmp-<id>` and renamed, so a crash never leaves a directory
// that looks complete. Every path comes from the caller; nothing here knows
// about Electron, so it is unit-testable against temp dirs.
const nodeFs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400000;
const DEFAULTS = {
  debounceMs: 60 * 1000,
  dailyMs: DAY,
  maxAgeMs: 30 * DAY,
  maxBytes: 200 * 1024 * 1024,
  keepNewest: 5,
  keepBeforeRestoreMs: 7 * DAY,
};
const REASONS = ['save', 'before-restore', 'manual', 'daily'];

// The allow-list. Anything not matched here is never copied, so a new secret
// file added to the data folder is excluded by default. `match` is tested
// against the posix path below the data folder.
const SOURCES = [
  { dir: '', match: /^config\.json$/, label: 'Your settings, rules, presets, templates and auto-answer rules',
    why: 'Everything you configured lives in this one file; it is what was lost on 2026-09-29.' },
  { dir: 'cameos', match: /^cameos\/(index\.json|[A-Za-z0-9_-]+\.png)$/, label: 'Your faces (cameo photos)',
    why: 'Photos you added cannot be recreated by Plexiform, and the rules that wear them point at them.' },
  { dir: 'usage/daily', match: /^usage\/daily\/\d{4}-\d{2}(\.ids)?\.json$/, label: 'Your usage history',
    why: 'Claude Code deletes old transcripts, so this record is the only copy; token counts and project paths, no prompts.' },
];

// Named here so a reader (and the tests) can see what is left out on purpose.
const EXCLUDED = [
  { name: 'token', why: 'the local signal secret; a copied backup must not carry a live credential' },
  { name: 'approval-secret.json', why: 'the approval-counter signing secret' },
  { name: 'approval-counts.json', why: 'live counters derived from that secret' },
  { name: 'devices.json / remote.json', why: 'paired-device keys' },
  { name: 'hub token and team-hub account files', why: 'account credentials, sealed to this machine' },
  { name: 'requests/, sessions/, owned/', why: 'live state about running agents, stale within minutes' },
  { name: 'app.log, *.port, *.lock', why: 'logs and process state' },
  { name: 'window-bounds.json, manual-override.json', why: 'where a window sits, not something to restore' },
  { name: 'stats.json, spend-snapshot.json, git-signals.json', why: 'derived and rebuilt on their own' },
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');
const idOf = (ms) => new Date(ms).toISOString().replace(/:/g, '-');
const idToMs = (id) => Date.parse(id.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, '$1:$2:$3').replace(/-\d+$/, ''));
const isSnapshotDir = (n) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(-\d+)?$/.test(n);
const allowed = (name) => typeof name === 'string' && !name.includes('..') && SOURCES.some((s) => s.match.test(name));

function create({
  dataDir, backupsDir, fs = nodeFs, now = Date.now, appVersion = '0.0.0',
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; }, clearTimer = clearTimeout,
  log = () => {}, ...limits
}) {
  const cfg = { ...DEFAULTS, ...limits };
  let lastSaveAt = 0;
  let pending = null;

  const ensureDir = (dir) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); };

  function collect() {
    const out = [];
    for (const src of SOURCES) {
      const abs = path.join(dataDir, src.dir);
      let names = [];
      try { names = fs.readdirSync(abs); } catch { continue; }
      for (const n of names.sort()) {
        const name = src.dir ? `${src.dir}/${n}` : n;
        if (!src.match.test(name)) continue;
        try {
          const buf = fs.readFileSync(path.join(dataDir, name));
          out.push({ name, buf, sha256: sha256(buf), size: buf.length });
        } catch { /* vanished or unreadable: not backed up this time */ }
      }
    }
    return out;
  }

  const readManifest = (id) => {
    const m = JSON.parse(fs.readFileSync(path.join(backupsDir, id, 'manifest.json'), 'utf8'));
    if (!m || m.v !== 1 || !Array.isArray(m.files) || !Number.isFinite(Date.parse(m.createdAt))) throw new Error('unreadable manifest');
    for (const f of m.files) if (!f || !allowed(f.name) || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isFinite(f.size)) throw new Error('manifest lists a file it should not');
    return m;
  };

  function verify(id) {
    let m;
    try { m = readManifest(id); } catch (err) { return { ok: false, problems: [`the backup's index is damaged (${err.message})`], manifest: null }; }
    const problems = [];
    for (const f of m.files) {
      let buf;
      try { buf = fs.readFileSync(path.join(backupsDir, id, 'files', f.name)); } catch { problems.push(`${f.name} is missing`); continue; }
      if (buf.length !== f.size) problems.push(`${f.name} is cut short`);
      else if (sha256(buf) !== f.sha256) problems.push(`${f.name} has been changed or corrupted`);
    }
    return { ok: !problems.length, problems, manifest: m };
  }

  function ids() {
    let names = [];
    try { names = fs.readdirSync(backupsDir); } catch { return []; }
    return names.filter(isSnapshotDir).sort().reverse();
  }

  function dirSize(id) {
    let total = 0;
    const walk = (d) => {
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else { try { total += fs.statSync(p).size; } catch { /* gone */ } }
      }
    };
    walk(path.join(backupsDir, id));
    return total;
  }

  function list() {
    return ids().map((id) => {
      const v = verify(id);
      return {
        id,
        createdAt: v.manifest ? v.manifest.createdAt : new Date(idToMs(id) || 0).toISOString(),
        reason: v.manifest && REASONS.includes(v.manifest.reason) ? v.manifest.reason : null,
        appVersion: v.manifest ? v.manifest.appVersion : null,
        size: dirSize(id),
        files: v.manifest ? v.manifest.files.length : 0,
        damaged: !v.ok,
        problems: v.problems,
      };
    });
  }

  function newestManifest() {
    for (const id of ids()) { try { return { id, manifest: readManifest(id) }; } catch { /* damaged: look further back */ } }
    return null;
  }

  const sameAs = (files, manifest) => files.length === manifest.files.length
    && files.every((f) => manifest.files.some((m) => m.name === f.name && m.sha256 === f.sha256));

  function snapshot(reason, { force = false, protect = [] } = {}) {
    if (!REASONS.includes(reason)) throw new Error(`unknown reason: ${reason}`);
    const files = collect();
    if (!force) {
      if (!files.length) return { taken: false, why: 'nothing-to-back-up' };
      const last = newestManifest();
      if (last && sameAs(files, last.manifest)) return { taken: false, why: 'unchanged', id: last.id };
    }
    ensureDir(backupsDir);
    const ms = now();
    let id = idOf(ms);
    for (let n = 1; fs.existsSync(path.join(backupsDir, id)); n++) id = `${idOf(ms)}-${n}`;
    const tmp = path.join(backupsDir, `.tmp-${id}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'files'), { recursive: true, mode: 0o700 });
    for (const f of files) {
      const dest = path.join(tmp, 'files', f.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, f.buf, { mode: 0o600 });
    }
    const manifest = { v: 1, createdAt: new Date(ms).toISOString(), appVersion, reason, files: files.map(({ name, sha256: h, size }) => ({ name, sha256: h, size })) };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, path.join(backupsDir, id));
    try { prune({ protect: [...protect, id] }); } catch (err) { log(`[backups] prune failed: ${err.message}`); }
    return { taken: true, id, reason, files: files.length };
  }

  function prune({ protect = [] } = {}) {
    let names = [];
    try { names = fs.readdirSync(backupsDir); } catch { return { removed: [] }; }
    for (const n of names) if (n.startsWith('.tmp-')) fs.rmSync(path.join(backupsDir, n), { recursive: true, force: true });
    const t = now();
    const all = ids().map((id) => {
      let manifest = null;
      try { manifest = readManifest(id); } catch { /* damaged */ }
      return { id, at: manifest ? Date.parse(manifest.createdAt) : idToMs(id), reason: manifest && manifest.reason, size: dirSize(id) };
    });
    const keep = new Set(protect);
    all.slice(0, cfg.keepNewest).forEach((s) => keep.add(s.id));
    for (const s of all) if (s.reason === 'before-restore' && t - s.at < cfg.keepBeforeRestoreMs) keep.add(s.id);
    const removed = [];
    const drop = (s) => { fs.rmSync(path.join(backupsDir, s.id), { recursive: true, force: true }); removed.push(s.id); };
    const left = all.filter((s) => {
      if (!keep.has(s.id) && t - s.at > cfg.maxAgeMs) { drop(s); return false; }
      return true;
    });
    let total = left.reduce((n, s) => n + s.size, 0);
    for (let i = left.length - 1; i >= 0 && total > cfg.maxBytes; i--) {
      if (keep.has(left[i].id)) continue;
      total -= left[i].size;
      drop(left[i]);
    }
    return { removed };
  }

  // A save is reported here; at most one snapshot per debounceMs, and a save
  // inside the window schedules the one that will cover it.
  function onSave() {
    const t = now();
    if (t - lastSaveAt >= cfg.debounceMs) {
      lastSaveAt = t;
      if (pending) { clearTimer(pending); pending = null; }
      return run('save');
    }
    if (!pending) {
      pending = setTimer(() => { pending = null; lastSaveAt = now(); run('save'); }, cfg.debounceMs - (t - lastSaveAt));
    }
    return { taken: false, why: 'deferred' };
  }

  // On quit, so the last save inside a debounce window is not lost.
  function flush() {
    if (!pending) return;
    clearTimer(pending);
    pending = null;
    run('save');
  }

  function run(reason, opts) {
    try { return snapshot(reason, opts); } catch (err) {
      log(`[backups] ${reason} snapshot failed: ${err.message}`);
      return { taken: false, why: 'error', error: err.message };
    }
  }

  function dailyCheck() {
    const last = newestManifest();
    if (last && now() - Date.parse(last.manifest.createdAt) < cfg.dailyMs) return { taken: false, why: 'recent' };
    return run('daily');
  }

  const label = (name) => {
    if (name === 'config.json') return 'Your settings and rules';
    if (name === 'cameos/index.json') return 'The list of your faces';
    if (/^cameos\//.test(name)) return `Face photo ${name.slice(7, -4)}`;
    const m = /^usage\/daily\/(\d{4}-\d{2})(\.ids)?\.json$/.exec(name);
    return m ? `Usage history for ${m[1]}${m[2] ? ' (counting detail)' : ''}` : name;
  };

  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

  function diff(id) {
    const v = verify(id);
    if (!v.ok) return { error: 'This backup is damaged, so it cannot be compared.', problems: v.problems };
    const current = new Map(collect().map((f) => [f.name, f]));
    const files = [];
    for (const f of v.manifest.files) {
      const now_ = current.get(f.name);
      if (!now_) files.push({ name: f.name, label: label(f.name), status: 'missing-now', say: `${label(f.name)}: not on this computer now (the backup has it)` });
      else if (now_.sha256 !== f.sha256) files.push({ name: f.name, label: label(f.name), status: 'changed', say: `${label(f.name)}: different from the backup` });
    }
    const inBackup = new Set(v.manifest.files.map((f) => f.name));
    for (const name of current.keys()) {
      if (!inBackup.has(name)) files.push({ name, label: label(name), status: 'only-now', say: `${label(name)}: added since this backup (a restore leaves it alone)` });
    }
    const configKeys = [];
    const was = readJson(path.join(backupsDir, id, 'files', 'config.json'));
    const is = current.has('config.json') ? readJson(path.join(dataDir, 'config.json')) : null;
    if (was && typeof was === 'object' && files.some((f) => f.name === 'config.json')) {
      const cur = is && typeof is === 'object' ? is : {};
      for (const key of [...new Set([...Object.keys(was), ...Object.keys(cur)])].sort()) {
        const a = JSON.stringify(was[key]);
        const b = JSON.stringify(cur[key]);
        if (a === b) continue;
        const status = !(key in cur) ? 'missing-now' : !(key in was) ? 'only-now' : 'changed';
        configKeys.push({ key, status, say: status === 'missing-now' ? `${key}: gone now, the backup has it` : status === 'only-now' ? `${key}: added since this backup` : `${key}: different from the backup` });
      }
    }
    return { id, createdAt: v.manifest.createdAt, files, configKeys, same: !files.length };
  }

  const writeAtomic = (file, buf) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.restore-tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  // `files`: names to restore (default: every file in the snapshot, or none
  // when only `configKeys` is given).
  // `configKeys`: restore just these top-level keys of config.json and leave
  // the rest of it as it is now; ignored when config.json itself is listed.
  function restore(id, { files, configKeys } = {}) {
    const v = verify(id);
    if (!v.ok) return { error: 'This backup is damaged, so it was not restored.', problems: v.problems };
    const have = new Set(v.manifest.files.map((f) => f.name));
    const wantKeys = Array.isArray(configKeys) && configKeys.length ? configKeys.map(String) : null;
    let names = Array.isArray(files) ? files.filter((n) => have.has(n)) : wantKeys ? [] : [...have];
    if (Array.isArray(files) && files.some((n) => !have.has(n))) return { error: 'That file is not in this backup.' };
    if (wantKeys && !names.includes('config.json')) {
      if (!have.has('config.json')) return { error: 'This backup has no settings file.' };
    }
    if (!names.length && !wantKeys) return { error: 'Nothing was chosen to restore.' };
    // A restore must itself be undoable, even if it changes nothing.
    const before = snapshot('before-restore', { force: true, protect: [id] });
    const restored = [];
    for (const name of names) {
      writeAtomic(path.join(dataDir, name), fs.readFileSync(path.join(backupsDir, id, 'files', name)));
      restored.push(name);
    }
    const keysDone = [];
    if (wantKeys && !names.includes('config.json')) {
      const was = readJson(path.join(backupsDir, id, 'files', 'config.json')) || {};
      const cur = readJson(path.join(dataDir, 'config.json')) || {};
      for (const k of wantKeys) {
        if (k === '__proto__') continue;
        if (Object.prototype.hasOwnProperty.call(was, k)) cur[k] = was[k]; else delete cur[k];
        keysDone.push(k);
      }
      writeAtomic(path.join(dataDir, 'config.json'), Buffer.from(JSON.stringify(cur, null, 2)));
    }
    return { restored, configKeys: keysDone, beforeRestoreId: before.id, usage: restored.some((n) => n.startsWith('usage/')) };
  }

  return { snapshot, list, verify, diff, restore, prune, onSave, flush, dailyCheck, dir: backupsDir };
}

module.exports = { create, SOURCES, EXCLUDED, DEFAULTS, REASONS, allowed };
