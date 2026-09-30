// How a hook command reaches Buddy's own code. The hook scripts run as Node,
// and a packaged app has a Node on board: its own binary with
// ELECTRON_RUN_AS_NODE=1. That is used whenever the app's binary path is known,
// so a machine without `node` on PATH still lights up. Only a dev run (no
// packaged binary) falls back to plain `node`, and says so via `runtime.node`.
//
// Command forms:
//   shell string, macOS/Linux: ELECTRON_RUN_AS_NODE=1 "<exe>" "<script>" <args>
//   shell string, Windows:     "<data>\bin\buddy-hook.cmd" "<script>" <args>
//   argv array (any OS):       ["<data>/bin/buddy-hook[.cmd]", "<script>", ...args]
//   dev fallback:              node "<script>" <args>  /  ["node", "<script>", ...args]
//
// Windows gets the .cmd shim for shell strings too: `set VAR=1&& …` only
// parses in cmd.exe, while a quoted path to a .cmd runs from cmd.exe and from
// the Git Bash that Claude Code uses for hooks on Windows alike.
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
  return `#!/bin/sh\n# Claude Buddy hook runner: the app's own binary, running as Node.\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(rt.execPath)} "$@"\n`;
}

// Written only when missing or different; returns the path, or null when the
// runtime needs no wrapper (dev fallback).
function ensureWrapper(rt, fsImpl = fs) {
  if (rt.node) return null;
  const file = wrapperPath(rt);
  const text = wrapperText(rt);
  let cur = null;
  try { cur = fsImpl.readFileSync(file, 'utf8'); } catch { /* first write */ }
  if (cur !== text) {
    fsImpl.mkdirSync(pathFor(rt).dirname(file), { recursive: true });
    fsImpl.writeFileSync(file, text, { mode: 0o755 });
  }
  if (!isWin(rt)) { try { fsImpl.chmodSync(file, 0o755); } catch { /* best effort */ } }
  return file;
}

// Whether a shell-string install needs the wrapper file on disk.
const shellNeedsWrapper = (rt) => !rt.node && isWin(rt);

// False when the installed command form runs through a wrapper that is no
// longer on disk (argv forms always do; shell strings only on Windows).
function wrapperPresent(rt, { argv = false } = {}, fsImpl = fs) {
  if (!(argv ? !rt.node : shellNeedsWrapper(rt))) return true;
  try { return fsImpl.existsSync(wrapperPath(rt)); } catch { return false; }
}

function shellCommand(rt, scriptPath, args = []) {
  const tail = args.length ? ` ${args.join(' ')}` : '';
  if (rt.node) return `node "${scriptPath}"${tail}`;
  if (isWin(rt)) return `"${wrapperPath(rt)}" "${scriptPath}"${tail}`;
  return `ELECTRON_RUN_AS_NODE=1 "${rt.execPath}" "${scriptPath}"${tail}`;
}

function argvCommand(rt, scriptPath, args = []) {
  return [rt.node ? 'node' : wrapperPath(rt), scriptPath, ...args];
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
  if (!text.trim()) return {};
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not a JSON object`);
  return data;
}

// Atomic: a temp file beside it with the same mode, renamed over it, so an
// agent reading its settings mid-write never sees half a file. A symlinked
// config (dotfiles) is written through, never replaced by a plain file.
function writeJsonConfig(link, data, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(link), { recursive: true });
  let file = link;
  try { file = fsImpl.realpathSync(link); } catch { /* new file */ }
  let mode;
  try { mode = fsImpl.statSync(file).mode & 0o777; } catch { /* new file: default mode */ }
  const tmp = `${file}.buddy-tmp.${process.pid}.${Date.now().toString(36)}`;
  fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2), mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
  try {
    if (mode !== undefined) fsImpl.chmodSync(tmp, mode);
    fsImpl.renameSync(tmp, file);
  } catch (err) {
    try { fsImpl.unlinkSync(tmp); } catch {}
    throw err;
  }
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

module.exports = { stripMatcherHooks, readJsonConfig, writeJsonConfig, backupOnce, make, script, wrapperPath, wrapperText, ensureWrapper, shellNeedsWrapper, wrapperPresent, shellCommand, argvCommand, runsScript, pathFor };
