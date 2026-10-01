// Read-only scan of one home folder for the setup sources in registry.js.
// It opens files for reading and runs a few listing commands (brew leaves,
// npm ls -g); it never writes, never follows a link out of the home folder,
// and checks every path against blocklist.js before touching it.
//
// Links are resolved here, one hop at a time: each component of a path, and
// each link target, is checked against the blocklist before it is stat'ed,
// so neither a link inside a folder (~/.config/gh -> ~/.aws) nor a link into
// a blocked folder reaches or even probes it. A file is read through a
// no-follow descriptor whose device and inode must match what was checked;
// a file with more than one hard link is skipped (its other name may be
// blocked).
//
// Everything that touches the machine is injectable, so tests run against a
// temp HOME with a fake exec and never see the real one.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SOURCES } = require('./registry.js');
const { blockedReason, tildePath, SKIP_DIRS, SSH_CONFIG, DIRS } = require('./blocklist.js');
const { formatOf } = require('./scrub.js');

const MAX_FILE = 256 * 1024;
// ~/.claude.json grows with project history; only mcpServers leaves it.
const MAX_EXTRACT = 16 * 1024 * 1024;
const MAX_FILES_PER_SOURCE = 200;
const MAX_DEPTH = 5;
const MAX_LINKS = 40;
const EXEC_TIMEOUT_MS = 10_000;

const PARSERS = {
  lines: (out) => out.split('\n').map((s) => s.trim()).filter(Boolean).map((name) => ({ name })),
  'npm-ls': (out) => Object.entries(JSON.parse(out).dependencies || {}).map(([name, d]) => ({ name, version: d.version || null })),
  'vscode-extensions': (out) => JSON.parse(out).map((e) => ({ name: e.identifier?.id, version: e.version || null })).filter((e) => e.name),
  'claude-plugins': (out) => Object.keys(JSON.parse(out).plugins || {}).map((name) => ({ name })),
};

// Listing commands come from the registry and nowhere else.
const EXEC_ALLOWED = new Set(SOURCES.flatMap((s) => (s.items || []).filter((i) => i.from === 'exec').map((i) => i.cmd.join(' '))));
for (const s of SOURCES) {
  for (const i of s.items || []) {
    if (!PARSERS[i.parse || 'lines']) throw new Error(`registry: ${s.id} uses unknown parser ${i.parse}`);
  }
}

function defaultExec(cmd) {
  const win = process.platform === 'win32';
  // npm is npm.cmd on Windows, and a .cmd runs only through the shell (the args are fixed registry strings).
  const run = (file) => execFileSync(file, cmd.slice(1), { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024, shell: win && file.endsWith('.cmd') }); // privacy-flow: borrow-scan-list
  const tryRun = (file) => {
    try { return run(file); } catch (e) {
      // npm ls exits 1 on peer-dependency warnings with the full listing on stdout.
      if (typeof e.status === 'number' && e.stdout) return e.stdout;
      throw e;
    }
  };
  try {
    return tryRun(win && cmd[0] === 'npm' ? 'npm.cmd' : cmd[0]);
  } catch (e) {
    // An app started from the Dock has a minimal PATH without Homebrew's bin.
    if (e.code !== 'ENOENT' || win) throw e;
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
      const file = path.join(dir, cmd[0]);
      if (fs.existsSync(file)) return tryRun(file);
    }
    throw e;
  }
}

const whyExecFailed = (e) => (e && e.code === 'ENOENT' ? null : e && (e.code === 'ETIMEDOUT' || e.signal) ? 'timed out' : 'command failed');

/**
 * @param {object} o
 * @param {string} o.home          the home folder to scan (tests: a temp dir)
 * @param {string} [o.platform]    process.platform by default
 * @param {object} [o.fsApi]       fs by default
 * @param {Function|null} [o.exec] (argv[]) → stdout; null skips listing commands
 * @param {string[]} [o.only]      source ids to scan (default: every non-opt-in source)
 * @param {string[]} [o.optIn]     opt-in source ids the person picked
 */
function scan({ home, platform = process.platform, fsApi = fs, exec = defaultExec, only = null, optIn = [] } = {}) {
  if (!home) throw new Error('scan: home is required');
  const homeAbs = path.resolve(home);
  const lookedAt = [];
  const look = (p, result, reason) => { const e = reason ? { path: p, result, reason } : { path: p, result }; lookedAt.push(e); return e; };
  let homeReal;
  try { homeReal = fsApi.realpathSync(homeAbs); } catch {
    look('~', 'absent');
    return { platform, sources: [], lookedAt, neverRead: DIRS.slice() };
  }
  const inHome = (p) => tildePath(p, homeReal, platform) ?? tildePath(p, homeAbs, platform);

  // Walk "~/…" from the real home, one component at a time. Every prefix
  // and every link target is blocklist-checked before it is lstat'ed.
  function readable(t, opts) {
    const why = blockedReason(t, opts);
    if (why) return { why };
    const todo = t.slice(2).split('/').filter(Boolean);
    let cur = homeReal;
    let hops = 0;
    let st = null;
    try {
      while (todo.length) {
        const seg = todo.shift();
        if (seg === '.') continue;
        const next = seg === '..' ? path.dirname(cur) : path.join(cur, seg);
        const tt = inHome(next);
        if (!tt) return { why: 'link points outside the home folder' };
        // Before any link, each prefix is an ancestor of `t`, already checked
        // with it (a blocked folder blocks everything under it).
        const w = hops > 0 ? blockedReason(tt, opts) : null;
        if (w) return { why: w };
        try { st = fsApi.lstatSync(next); } catch { return { absent: true }; }
        if (st.isSymbolicLink()) {
          if (++hops > MAX_LINKS) return { why: 'too many links' };
          const target = fsApi.readlinkSync(next);
          if (path.isAbsolute(target)) {
            const tt2 = inHome(path.resolve(target));
            if (!tt2) return { why: 'link points outside the home folder' };
            cur = homeReal;
            todo.unshift(...tt2.slice(2).split('/').filter(Boolean));
          } else {
            todo.unshift(...target.split(platform === 'win32' ? /[/\\]/ : '/').filter(Boolean));
          }
          continue;
        }
        cur = next;
      }
    } catch {
      return { why: 'could not be read' };
    }
    if (!st) return { absent: true };
    return { st, real: cur };
  }

  // Read through a no-follow descriptor, and only the file that was checked.
  function readChecked(real, st, max) {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const fd = fsApi.openSync(real, flags);
    try {
      const fst = fsApi.fstatSync(fd);
      if (fst.dev !== st.dev || fst.ino !== st.ino || !fst.isFile()) return { why: 'changed while it was being read' };
      if (fst.nlink > 1) return { why: 'has other hard links' };
      if (fst.size > max) return { big: true };
      const buf = Buffer.alloc(fst.size);
      let at = 0;
      while (at < buf.length) {
        const n = fsApi.readSync(fd, buf, at, buf.length - at, at);
        if (n <= 0) break;
        at += n;
      }
      return { buf: buf.subarray(0, at) };
    } finally {
      fsApi.closeSync(fd);
    }
  }

  function readFile(t, opts, { max = MAX_FILE, quiet = false, format, sensitiveKeys } = {}) {
    const r = readable(t, opts);
    if (r.why) { look(t, 'skipped', r.why); return null; }
    if (r.absent) { look(t, 'absent'); return null; }
    if (!r.st.isFile()) { look(t, 'skipped', 'not a file'); return null; }
    if (r.st.nlink > 1) { look(t, 'skipped', 'has other hard links'); return null; }
    const tooBig = `larger than ${max >= 1024 * 1024 ? `${max / 1024 / 1024} MB` : `${max / 1024} KB`}`;
    if (r.st.size > max) { look(t, 'skipped', tooBig); return null; }
    let got;
    try { got = readChecked(r.real, r.st, max); } catch { look(t, 'skipped', 'could not be read'); return null; }
    if (got.why) { look(t, 'skipped', got.why); return null; }
    if (got.big) { look(t, 'skipped', tooBig); return null; }
    if (got.buf.includes(0)) { look(t, 'skipped', 'binary file'); return null; }
    if (!quiet) look(t, 'read');
    const rec = { path: t, bytes: got.buf.length, content: got.buf.toString('utf8'), format: format || formatOf(t) };
    if (sensitiveKeys) rec.sensitiveKeys = sensitiveKeys;
    return rec;
  }

  function readDir(t, opts, meta, acc, depth = 0, top = null) {
    const r = readable(t, opts);
    if (r.why) { look(t, 'skipped', r.why); return; }
    if (r.absent) { if (depth === 0) look(t, 'absent'); return; }
    if (!r.st.isDirectory()) return;
    if (depth === 0) top = { entry: look(t, 'read'), withheld: 0 };
    let names;
    try { names = fsApi.readdirSync(r.real).sort(); } catch { look(t, 'skipped', 'could not be listed'); return; }
    for (const name of names) {
      if (acc.count >= MAX_FILES_PER_SOURCE) {
        if (!acc.capped) { acc.capped = true; look(t, 'skipped', `more than ${MAX_FILES_PER_SOURCE} files in this setup; the rest were not read`); }
        break;
      }
      if (SKIP_DIRS.has(name)) continue;
      const child = `${t}/${name}`;
      const cr = readable(child, opts);
      // A blocked file is not listed by name: its name came from readdir, and
      // "never read" includes never showing it as detected. Only a count is.
      if (cr.why) { top.withheld++; continue; }
      if (cr.absent) continue;
      if (cr.st.isDirectory()) {
        if (depth + 1 < MAX_DEPTH) readDir(child, opts, meta, acc, depth + 1, top);
        else look(child, 'skipped', `more than ${MAX_DEPTH} folders deep`);
        continue;
      }
      const f = readFile(child, opts, meta);
      if (f) { acc.files.push(f); acc.count++; }
    }
    if (depth === 0 && top.withheld) top.entry.reason = `${top.withheld} file${top.withheld === 1 ? '' : 's'} withheld: the name looks sensitive`;
  }

  // ~/.claude.json holds account and per-project state next to the MCP
  // servers: only the named keys ever leave this function.
  function extract(t, keys, opts) {
    const f = readFile(t, opts, { max: MAX_EXTRACT, quiet: true });
    if (!f) return null;
    let json;
    try { json = JSON.parse(f.content); } catch { look(t, 'skipped', 'not valid JSON'); return null; }
    const picked = {};
    for (const k of keys) if (json && typeof json === 'object' && Object.hasOwn(json, k)) picked[k] = json[k];
    if (!Object.keys(picked).length) { look(t, 'skipped', `no ${keys.join(', ')} in it`); return null; }
    look(t, 'read', `only ${keys.join(', ')} is used`);
    const content = `${JSON.stringify(picked, null, 2)}\n`;
    return { path: `${t}#${keys.join(',')}`, bytes: Buffer.byteLength(content), content, format: 'json' };
  }

  function listItems(spec, opts) {
    if (spec.from === 'file') {
      const f = readFile(spec.path, opts);
      if (!f) return [];
      try { return PARSERS[spec.parse](f.content).map((i) => ({ kind: spec.kind, ...i })); } catch { look(spec.path, 'skipped', 'could not parse'); return []; }
    }
    const line = spec.cmd.join(' ');
    if (!exec || !EXEC_ALLOWED.has(line)) return [];
    let out;
    try { out = exec(spec.cmd); } catch (e) {
      const why = whyExecFailed(e);
      if (why) look(`$ ${line}`, 'skipped', why); else look(`$ ${line}`, 'absent');
      return [];
    }
    let items;
    try { items = PARSERS[spec.parse || 'lines'](String(out)).map((i) => ({ kind: spec.kind, ...i })); } catch {
      look(`$ ${line}`, 'skipped', 'could not parse its output');
      return [];
    }
    look(`$ ${line}`, 'read');
    return items;
  }

  const forPlatform = (list) => (list || []).filter((e) => typeof e === 'string' || !e.platforms || e.platforms.includes(platform)).map((e) => (typeof e === 'string' ? e : e.path));

  const sources = [];
  for (const src of SOURCES) {
    if (only && !only.includes(src.id)) continue;
    if (src.optIn && !optIn.includes(src.id)) continue;
    if (!src.platforms.includes(platform)) { sources.push({ id: src.id, area: src.area, label: src.label, detected: false, skipped: `not available on ${platform}`, files: [], items: [] }); continue; }
    const opts = { sshConfig: (src.allowBlocked || []).includes(SSH_CONFIG) && optIn.includes(src.id) };
    const files = [];
    for (const t of forPlatform(src.files)) { const f = readFile(t, opts, { format: src.format?.[t], sensitiveKeys: src.sensitiveKeys }); if (f) files.push(f); }
    const acc = { files: [], count: 0, capped: false };
    for (const t of forPlatform(src.dirs)) readDir(t, opts, { sensitiveKeys: src.sensitiveKeys }, acc);
    files.push(...acc.files);
    for (const [t, keys] of Object.entries(src.extract || {})) { const f = extract(t, keys, opts); if (f) files.push(f); }
    const items = (src.items || []).flatMap((i) => listItems(i, opts));
    sources.push({
      id: src.id, area: src.area, label: src.label, detected: files.length > 0 || items.length > 0,
      merge: src.merge, runsAtShellStart: !!src.runsAtShellStart, runsCode: !!src.runsCode,
      files, items,
    });
  }

  return { platform, sources, lookedAt, neverRead: DIRS.slice() };
}

module.exports = { scan, EXEC_ALLOWED, PARSERS };
