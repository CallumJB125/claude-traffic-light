'use strict';
// The one model call explain mode makes: the user's own Claude Code CLI
// (`claude -p`, their login and quota), isolated the way src/diff-review.js
// runs it: an empty temporary folder, no tools, settings, MCP servers, slash
// commands or session file, a minimal environment, haiku, a budget cap, and
// the text on stdin, never in argv. One call at a time; a second caller while
// one is out gets {ok:false, reason:'busy'}. Text is scrubbed by the caller.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NONE, prepareNoTool, carryFor } = require('./claude-carry');

const BUDGET_USD = 0.02;
const MAX_IN = 8 * 1024;
const MAX_OUT = 4 * 1024;
const TIMEOUT_MS = 45_000;
const ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR', 'TZ', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];

function buildArgs({ model = 'haiku' } = {}) {
  return ['-p', '--output-format', 'text', '--no-session-persistence',
    '--setting-sources', '', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands',
    '--tools', '', '--permission-mode', 'dontAsk',
    '--model', model, '--max-budget-usd', String(BUDGET_USD)];
}

function findBin() { try { return require('./claude-code-session').findClaudeBin(); } catch { return null; } }

function createRunner({ bin = findBin, env = process.env, spawn = childProcess.spawn, tmpdir = os.tmpdir, timeoutMs = TIMEOUT_MS, carry = carryFor(env) } = {}) {
  let busy = false;
  /** prompt → {ok:true, text} | {ok:false, reason:'busy'|'no-cli'|'empty'|'failed'}. Never throws. */
  async function ask(prompt) {
    if (busy) return { ok: false, reason: 'busy' };
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, reason: 'empty' };
    const exe = typeof bin === 'function' ? bin() : bin;
    if (!exe) return { ok: false, reason: 'no-cli' };
    busy = true;
    let dir = null;
    try {
      // The user's own provider and auth (a no-tool child may hold a key in its env).
      const c = carry ? await prepareNoTool(carry) : NONE;
      if (c.failure) return { ok: false, reason: 'failed' };
      const childEnv = { ...Object.fromEntries(ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])), ...c.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
      dir = fs.mkdtempSync(path.join(tmpdir(), 'plexiform-explain-'));
      return await new Promise((resolve) => {
        let out = '', done = false, child = null;
        const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
        const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, reason: 'failed' }); }, timeoutMs);
        try {
          child = spawn(exe, buildArgs({ model: c.model }), { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); // privacy-flow: explain-mode
        } catch { return finish({ ok: false, reason: 'failed' }); }
        child.on('error', () => finish({ ok: false, reason: 'failed' }));
        child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d; });
        child.on('close', (code) => finish(code === 0 && out.trim() ? { ok: true, text: out.slice(0, MAX_OUT).trim() } : { ok: false, reason: 'failed' }));
        child.stdin.on('error', () => {});
        child.stdin.end(prompt.slice(0, MAX_IN));
      });
    } catch { return { ok: false, reason: 'failed' }; } finally {
      busy = false;
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }
  return { ask, busy: () => busy };
}

module.exports = { createRunner, buildArgs, BUDGET_USD };
