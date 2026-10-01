'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process'); // privacy-flow: native-board-config
const { promisify } = require('node:util');
const Runtime = require('../adapters/runtime');
const exec = promisify(execFile);
const NAME = 'plexiform-board';

function configPath(target, home = os.homedir(), platform = process.platform) {
  if (target === 'codex') return path.join(home, '.codex', 'config.toml');
  if (target === 'claude-code') return path.join(home, '.claude.json');
  if (target === 'claude-desktop' && platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (target === 'claude-desktop' && platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  throw new Error('This app connection is not available on this platform.');
}

function launch({ execPath, appPath, grantPath }) {
  return { command: execPath, args: [path.join(appPath, 'native-board', 'server.js')], env: { ELECTRON_RUN_AS_NODE: '1', PLEXIFORM_BOARD_GRANT: grantPath } };
}
function isOurs(entry, grantPath) {
  return !!entry && Array.isArray(entry.args) && entry.args.some((a) => typeof a === 'string' && a.replaceAll('\\', '/').endsWith('/native-board/server.js')) && entry.env?.PLEXIFORM_BOARD_GRANT === grantPath;
}
function readJson(file) {
  let text = null; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new Error('The app configuration could not be read.'); }
  let data; try { data = text === null ? {} : JSON.parse(text); } catch { throw new Error('The app configuration is not valid JSON; it was left unchanged.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data.mcpServers != null && (typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)))) throw new Error('The app configuration is invalid; it was left unchanged.');
  return { text, data };
}
function jsonEdit(opts, change) {
  const file = configPath(opts.target, opts.home, opts.platform);
  for (let i = 0; i < 3; i += 1) {
    const mtime = Runtime.mtimeOf(file);
    const { text, data } = readJson(file);
    if (!change(data)) return false;
    const next = text === null ? `${JSON.stringify(data, null, 2)}\n` : Runtime.jsonTextLike(text, data);
    if (Runtime.writeTextAtomic(file, next, fs, mtime, { newMode: 0o600 })) return true;
  }
  throw new Error('The app configuration changed during setup. Try again.');
}
function findCodex({ home = os.homedir(), platform = process.platform, searchPath = process.env.PATH ?? '' } = {}) {
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  const dirs = [path.join(home, '.local', 'bin'), '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS', '/Applications/Codex.app/Contents/Resources', ...searchPath.split(path.delimiter).filter((d) => path.isAbsolute(d))];
  return dirs.map((d) => path.join(d, name)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }) ?? null;
}
async function cli(opts, args) {
  const bin = opts.codexPath ?? findCodex(opts);
  if (!bin) throw new Error('Install Codex or the ChatGPT desktop app to connect its local sessions.');
  const home = opts.home ?? os.homedir();
  // Config commands only: no model invocation, inherited API key or app token.
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  // Codex refuses an explicitly supplied CODEX_HOME that does not exist.
  // Inspecting a fresh install must stay read-only; setup creates it only
  // after the person has chosen Connect boards.
  if (args[1] === 'get' && !fs.existsSync(env.CODEX_HOME)) return { stdout: 'null' };
  if (args[1] === 'add') fs.mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  try { return await (opts.exec ?? exec)(bin, args, { env, timeout: 10000, maxBuffer: 256 * 1024, windowsHide: true }); }
  catch (err) { if (args[1] === 'get' && /No MCP server|not found/i.test(err.stderr ?? '')) return { stdout: 'null' }; throw new Error('Codex could not update its MCP configuration. It was not replaced by Plexiform.'); }
}
async function get(opts) {
  if (opts.target !== 'codex') return readJson(configPath(opts.target, opts.home, opts.platform)).data.mcpServers?.[NAME] ?? null;
  let result; try { result = JSON.parse((await cli(opts, ['mcp', 'get', NAME, '--json'])).stdout); } catch { throw new Error('Codex MCP configuration could not be read.'); }
  return result?.transport ?? null;
}
async function check(opts) {
  const cur = await get(opts);
  if (cur && !isOurs(cur, opts.grantPath)) throw new Error('An MCP server named plexiform-board already exists. Plexiform left it unchanged.');
  return cur;
}
async function install(opts) {
  const cur = await check(opts);
  const same = cur && cur.command === opts.entry.command && JSON.stringify(cur.args) === JSON.stringify(opts.entry.args) && Object.entries(opts.entry.env).every(([k, v]) => cur.env?.[k] === v);
  if (same) return { changed: false };
  if (opts.target === 'codex') {
    const args = ['mcp', 'add', NAME, ...Object.entries(opts.entry.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', opts.entry.command, ...opts.entry.args];
    await cli(opts, args);
  } else jsonEdit(opts, (data) => {
    const current = data.mcpServers?.[NAME];
    if (current && !isOurs(current, opts.grantPath)) throw new Error('Another app installed this server during setup. It was left unchanged.');
    data.mcpServers = { ...(data.mcpServers ?? {}), [NAME]: opts.entry }; return true;
  });
  return { changed: true };
}
async function uninstall(opts) {
  const cur = await get(opts);
  if (!isOurs(cur, opts.grantPath)) return { changed: false };
  if (opts.target === 'codex') await cli(opts, ['mcp', 'remove', NAME]);
  else jsonEdit(opts, (data) => { if (!isOurs(data.mcpServers?.[NAME], opts.grantPath)) return false; delete data.mcpServers[NAME]; return true; });
  return { changed: true };
}
async function status(opts) {
  const file = configPath(opts.target, opts.home, opts.platform);
  try { const cur = await get(opts); return { target: opts.target, path: file, installed: isOurs(cur, opts.grantPath), conflict: !!cur && !isOurs(cur, opts.grantPath) }; }
  catch (err) { return { target: opts.target, path: file, installed: false, error: err.message }; }
}
module.exports = { NAME, configPath, launch, isOurs, check, install, uninstall, status, findCodex };
