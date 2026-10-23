'use strict';
// A stand-in for the `codex` CLI's `mcp add | get | remove` (codex-cli
// 0.163's JSON shape and messages), keeping its servers in
// $CODEX_HOME/fake-mcp.json. FAKE_CODEX_MODE: "drop" (add says yes, keeps
// nothing), "timeout" (hangs), "fail" (every call exits 2). Every call is
// appended to $CODEX_HOME/fake-calls.log. Never a model call.
const fs = require('node:fs');
const path = require('node:path');

function write(dir) {
  const bin = path.join(dir, 'codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire(${JSON.stringify(__filename)}).main(process.argv.slice(2));\n`, { mode: 0o755 });
  return bin;
}

function main(argv) {
  const home = process.env.CODEX_HOME;
  const store = path.join(home, 'fake-mcp.json');
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, 'fake-calls.log'), `${JSON.stringify(argv)}\n`);
  const mode = process.env.FAKE_CODEX_MODE || '';
  if (mode === 'timeout') { setTimeout(() => {}, 60_000); return; }
  if (mode === 'fail') { process.stderr.write('boom\n'); process.exit(2); }
  let servers = {};
  try { servers = JSON.parse(fs.readFileSync(store, 'utf8')); } catch { /* none yet */ }
  const [group, verb, name, ...rest] = argv;
  if (group !== 'mcp') process.exit(2);
  if (verb === 'get') {
    if (!servers[name]) { process.stderr.write(`Error: No MCP server named '${name}' found.\n`); process.exit(1); }
    const s = servers[name];
    process.stdout.write(JSON.stringify({ name, enabled: true, disabled_reason: null, transport: { type: 'stdio', command: s.command, args: s.args, env: s.env, env_vars: [], cwd: null }, enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null }, null, 2));
    return;
  }
  if (verb === 'add') {
    const sep = rest.indexOf('--');
    const env = {};
    for (let i = 0; i < sep; i += 1) if (rest[i] === '--env') { const [k, ...v] = rest[i + 1].split('='); env[k] = v.join('='); i += 1; }
    const [command, ...args] = rest.slice(sep + 1);
    if (mode !== 'drop') servers[name] = { command, args, env };
    fs.writeFileSync(store, JSON.stringify(servers));
    process.stdout.write(`Added global MCP server '${name}'.\n`);
    return;
  }
  if (verb === 'remove') {
    if (!servers[name]) { process.stdout.write(`No MCP server named '${name}' found.\n`); return; }
    delete servers[name];
    fs.writeFileSync(store, JSON.stringify(servers));
    process.stdout.write(`Removed global MCP server '${name}'.\n`);
    return;
  }
  process.exit(2);
}

const calls = (home) => { try { return fs.readFileSync(path.join(home, 'fake-calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const servers = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'fake-mcp.json'), 'utf8')); } catch { return {}; } };

module.exports = { write, main, calls, servers };
