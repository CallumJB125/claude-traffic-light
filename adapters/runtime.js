// How a hook command reaches Buddy's own code. The hook scripts run as Node,
// and a packaged app has a Node on board: its own binary with
// ELECTRON_RUN_AS_NODE=1. That is used whenever the app's binary path is known,
// so a machine without `node` on PATH still lights up. Only a dev run (no
// packaged binary) falls back to plain `node`, and says so via `runtime.node`.
//
// Command forms:
//   shell string, macOS/Linux: ELECTRON_RUN_AS_NODE=1 "<exe>" "<script>" <args>
//   shell string, Windows:     "<data>\bin\buddy-hook.cmd" "<script>" <args>
//   argv array, macOS/Linux:   ["<data>/bin/buddy-hook", "<script>", ...args]
//   argv array, Windows:       ["<exe>", "--buddy-hook", "<script>", ...args]
//   dev fallback:              node "<script>" <args>  /  ["node", "<script>", ...args]
//
// Windows gets the .cmd shim for shell strings too: `set VAR=1&& …` only
// parses in cmd.exe, while a quoted path to a .cmd runs from cmd.exe and from
// the Git Bash that Claude Code uses for hooks on Windows alike. An argv
// array is different: the .cmd would put it through cmd.exe's parsing again,
// which mangles the JSON Codex passes as the last argument (BatBadBut), so on
// Windows it runs the exe itself with --buddy-hook (src/buddy-hook-runner.js).
//
// Dependency-free (path, fs): the packaged hooks require it from
// Resources/adapters with plain ELECTRON_RUN_AS_NODE.
const fs = require('fs');
const path = require('path');

// runtime: { execPath: string|null, platform, dataDir, hooksDir }.
// execPath null means "no app binary": the explicit dev fallback to `node`.
function make({ execPath = null, platform = process.platform, dataDir, hooksDir }) {
  return { execPath: execPath || null, platform, dataDir, hooksDir, node: !execPath };
}

const pathFor = (rt) => (rt.platform === 'win32' ? path.win32 : path.posix);
const isWin = (rt) => rt.platform === 'win32';

function script(rt, name) {
  return pathFor(rt).join(rt.hooksDir, name);
}

function wrapperPath(rt) {
  return pathFor(rt).join(rt.dataDir, 'bin', isWin(rt) ? 'buddy-hook.cmd' : 'buddy-hook');
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function wrapperText(rt) {
  if (isWin(rt)) return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${rt.execPath}" %*\r\n`;
  return `#!/bin/sh\n# Plexiform hook runner: the app's own binary, running as Node.\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(rt.execPath)} "$@"\n`;
}

// Written only when missing or different, atomically: a hook firing mid-write
// must never exec half a script. Returns the path, or null when the runtime
// needs no wrapper (dev fallback).
function ensureWrapper(rt, fsImpl = fs) {
  if (rt.node) return null;
  const file = wrapperPath(rt);
  const text = wrapperText(rt);
  let cur = null;
  try { cur = fsImpl.readFileSync(file, 'utf8'); } catch { /* first write */ }
  if (cur !== text) {
    fsImpl.mkdirSync(pathFor(rt).dirname(file), { recursive: true });
    writeTextAtomic(file, text, fsImpl, undefined, { newMode: 0o755 });
  }
  if (!isWin(rt)) { try { fsImpl.chmodSync(file, 0o755); } catch { /* best effort */ } }
  return file;
}

// Whether a shell-string / argv install needs the wrapper file on disk.
const shellNeedsWrapper = (rt) => !rt.node && isWin(rt);
const argvNeedsWrapper = (rt) => !rt.node && !isWin(rt);

// False when the installed command form runs through a wrapper (argv forms
// off Windows, shell strings on Windows) that is gone or no longer runs
// this binary: the wrapper's path never changes, so a reinstall to another
// folder or a moved AppImage leaves a matching command and a stale wrapper.
function wrapperPresent(rt, { argv = false } = {}, fsImpl = fs) {
  if (!(argv ? argvNeedsWrapper(rt) : shellNeedsWrapper(rt))) return true;
  try { return fsImpl.readFileSync(wrapperPath(rt), 'utf8') === wrapperText(rt); } catch { return false; }
}

function shellCommand(rt, scriptPath, args = []) {
  const tail = args.length ? ` ${args.join(' ')}` : '';
  if (rt.node) return `node "${scriptPath}"${tail}`;
  if (isWin(rt)) return `"${wrapperPath(rt)}" "${scriptPath}"${tail}`;
  return `ELECTRON_RUN_AS_NODE=1 "${rt.execPath}" "${scriptPath}"${tail}`;
}

function argvCommand(rt, scriptPath, args = []) {
  if (rt.node) return ['node', scriptPath, ...args];
  if (isWin(rt)) return [rt.execPath, '--buddy-hook', scriptPath, ...args];
  return [wrapperPath(rt), scriptPath, ...args];
}

// A command string one of Buddy's scripts runs in, whatever form or app path
// installed it: old `node "…/set-status.js" …`, the ELECTRON_RUN_AS_NODE form,
// or the Windows shim. `names` are script basenames.
function runsScript(command, names) {
  const c = String(command || '');
  return names.some((n) => new RegExp(`[\\\\/]${n.replace(/\./g, '\\.')}"( |$)`).test(c));
}

// Agent config files: a missing file is empty, an unparsable one aborts the
// install rather than being written over.
function readJsonConfig(file, fsImpl = fs) {
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  return parseJsonConfig(text, file);
}

const BOM = '\ufeff';

function parseJsonConfig(text, file) {
  const body = String(text).startsWith(BOM) ? String(text).slice(1) : String(text);
  if (!body.trim()) return {};
  const data = JSON.parse(body);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not a JSON object`);
  return data;
}

const mtimeOf = (file, fsImpl = fs) => { try { return fsImpl.statSync(file).mtimeMs; } catch { return null; } };

// Atomic: a temp file beside it with the same mode, renamed over it, so an
// agent reading its settings mid-write never sees half a file. A symlinked
// config (dotfiles) is written through, never replaced by a plain file.
// readAt (the mtime when it was read): if another program has written the
// file since, nothing is written and this returns false, for the caller to
// read it again. A read-only file is refused (temp plus rename would replace
// it regardless). newMode: the mode for a file that doesn't exist yet.
function writeTextAtomic(link, text, fsImpl = fs, readAt, { newMode } = {}) {
  fsImpl.mkdirSync(path.dirname(link), { recursive: true });
  let file = link;
  try { file = fsImpl.realpathSync(link); } catch { /* new file */ }
  let mode = newMode;
  let exists = false;
  try { mode = fsImpl.statSync(file).mode & 0o777; exists = true; } catch { /* new file */ }
  if (exists && !(mode & 0o200)) throw new Error(`${file} is read-only`);
  const tmp = `${file}.buddy-tmp.${process.pid}.${Date.now().toString(36)}`;
  fsImpl.writeFileSync(tmp, text, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
  try {
    if (mode !== undefined) fsImpl.chmodSync(tmp, mode);
    if (readAt !== undefined && mtimeOf(file, fsImpl) !== readAt) { fsImpl.unlinkSync(tmp); return false; }
    fsImpl.renameSync(tmp, file);
  } catch (err) {
    try { fsImpl.unlinkSync(tmp); } catch {}
    throw err;
  }
  return true;
}

function writeJsonConfig(link, data, fsImpl = fs, readAt) {
  return writeTextAtomic(link, JSON.stringify(data, null, 2), fsImpl, readAt);
}

// data as JSON in the style of `original`: its indentation (tabs or N
// spaces), line endings, BOM and final newline (or its absence).
function jsonTextLike(original, data) {
  const s = String(original || '');
  const ind = s.match(/^([ \t]+)\S/m);
  const eol = s.includes('\r\n') ? '\r\n' : '\n';
  const body = JSON.stringify(data, null, ind ? (ind[1][0] === '\t' ? '\t' : ind[1].length) : 2).replace(/\n/g, eol);
  return (s.startsWith(BOM) ? BOM : '') + body + (/\n$/.test(s) ? eol : '');
}

// `<file>.buddy-backup`, once: never replaced, so it stays the file as it was
// before Buddy first changed it.
function backupOnce(file, fsImpl = fs) {
  try { fsImpl.copyFileSync(file, `${file}.buddy-backup`, fs.constants.COPYFILE_EXCL); } catch {}
}

// Claude Code and Gemini share one hooks shape:
// { Event: [{ matcher, hooks: [{ type, command }] }] }. Drops every command
// `isOurs` claims and any group or event left empty; foreign entries stay.
function stripMatcherHooks(hooks, isOurs) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((h) => ({ ...h, hooks: (h.hooks || []).filter((hh) => !isOurs(hh.command)) }))
      .filter((h) => h.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

// The rename's re-point of the same shape: each event's first entry `isOurs`
// claims becomes that event's wanted hook where it stands, the rest of ours
// go, and an event with none of ours gets its wanted hook appended. Events,
// groups and foreign hooks keep their order. wanted: [[event, hook]].
function repointMatcherHooks(hooks, isOurs, wanted) {
  const want = new Map(wanted);
  const done = new Set();
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((h) => ({ ...h, hooks: (h.hooks || []).flatMap((hh) => {
        if (!isOurs(hh.command)) return [hh];
        if (!want.has(event) || done.has(event)) return [];
        done.add(event);
        return [want.get(event)];
      }) }))
      .filter((h) => h.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  for (const [event, hook] of want) if (!done.has(event)) out[event] = (out[event] || []).concat([{ matcher: '', hooks: [hook] }]);
  return out;
}

module.exports = { stripMatcherHooks, repointMatcherHooks, jsonTextLike, readJsonConfig, parseJsonConfig, writeJsonConfig, writeTextAtomic, mtimeOf, backupOnce, make, script, wrapperPath, wrapperText, ensureWrapper, shellNeedsWrapper, argvNeedsWrapper, wrapperPresent, shellCommand, argvCommand, runsScript, pathFor };
