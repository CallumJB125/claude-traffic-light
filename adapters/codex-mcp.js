'use strict';
// Codex's MCP registration, through Codex's own CLI (`codex mcp add | get |
// remove`), never by editing config.toml: Codex owns that format, and
// ChatGPT.app rewrites the same file (plan-agent-awareness §3.9).
//
// Async only (main calls it). The binary comes from findCodexBin(), so a
// Dock-launched app whose PATH lacks Homebrew still finds it. CODEX_HOME in
// `env` points a dev run or a test at a sandbox, never the person's own.
const path = require('path');

const NAME = 'plexiform-bus';
const TIMEOUT_MS = 5000;
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

// `codex mcp get --json` → { command, args, env } (stdio only), or null for anything else.
function specOf(json) {
  const t = json && typeof json === 'object' ? json.transport : null;
  if (!t || t.type !== 'stdio' || typeof t.command !== 'string' || !Array.isArray(t.args)) return null;
  const env = t.env && typeof t.env === 'object' && !Array.isArray(t.env) ? t.env : {};
  return { command: t.command, args: t.args.map(String), env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) };
}

const sameSpec = (a, b) => !!a && !!b && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args)
  && JSON.stringify(Object.entries(a.env).sort()) === JSON.stringify(Object.entries(b.env).sort());

function addArgs(spec) {
  const env = Object.entries(spec.env).sort().flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  return ['mcp', 'add', NAME, ...env, '--', spec.command, ...spec.args];
}

function create({ bin, env = process.env, execFile = require('child_process').execFile, timeoutMs = TIMEOUT_MS }) {
  const childEnv = { ...env, PATH: [...String(env.PATH || '').split(path.delimiter).filter(Boolean), ...EXTRA_PATH].filter((p, i, a) => a.indexOf(p) === i).join(path.delimiter) };
  const run = (args) => new Promise((resolve) => {
    if (!bin) return resolve({ code: null, stdout: '', stderr: 'codex not found', missing: true });
    try {
      execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: childEnv }, (err, stdout, stderr) => { // privacy-flow: agent-bus-tools-local
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!(err && (err.killed || err.signal)), missing: !!(err && err.code === 'ENOENT') });
      });
    } catch (e) { resolve({ code: null, stdout: '', stderr: String(e && e.message), missing: true }); }
  });
  return {
    name: NAME,
    // → { ok, spec | null } ; ok:false when Codex could not answer (missing, timeout, unreadable).
    async get() {
      const r = await run(['mcp', 'get', NAME, '--json']);
      if (r.code === 0) {
        try { return { ok: true, spec: specOf(JSON.parse(r.stdout)), raw: true }; } catch { return { ok: false, error: 'unreadable' }; }
      }
      if (r.code === 1 && /No MCP server named/i.test(r.stderr + r.stdout)) return { ok: true, spec: null };
      return { ok: false, error: r.missing ? 'missing' : r.timedOut ? 'timeout' : 'failed' };
    },
    async add(spec) {
      const r = await run(addArgs(spec));
      return r.code === 0 ? { ok: true } : { ok: false, error: r.missing ? 'missing' : r.timedOut ? 'timeout' : 'failed' };
    },
    async remove() {
      const r = await run(['mcp', 'remove', NAME]);
      return r.code === 0 ? { ok: true } : { ok: false, error: r.missing ? 'missing' : r.timedOut ? 'timeout' : 'failed' };
    },
  };
}

module.exports = { create, specOf, sameSpec, addArgs, NAME, TIMEOUT_MS };
