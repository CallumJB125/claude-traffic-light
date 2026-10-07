// Optional second look at a finished AI turn: the turn's diff goes to the
// user's own Claude Code CLI (`claude -p`, their login and quota) and the short
// reply is kept beside the checkpoint. Off by default; needs the
// checkpoints.review entitlement; every run carries --max-budget-usd.
// The CLI runs in an empty temporary folder with no tools, settings, MCP
// servers, slash commands or session file, and a minimal environment.
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findClaudeBin } = require('./claude-code-session');

const MODELS = Object.freeze(['haiku', 'sonnet', 'opus']);
const DEFAULT_BUDGET = 0.05;
const MAX_BUDGET = 0.5;
const DEFAULTS = Object.freeze({ enabled: false, model: 'haiku', maxBudgetUsd: DEFAULT_BUDGET });
const MAX_DIFF = 60 * 1024;
const MAX_OUT = 32 * 1024;
const TIMEOUT_MS = 120_000;
const ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR', 'TZ', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];
const PROMPT = 'You are reviewing a change an AI coding agent just made. Point out likely bugs, risky edits, '
  + 'deleted work or secrets in the diff below. Reply in at most 8 short bullet points, or "Looks fine." if nothing stands out.\n\n';

/** Settings as stored → settings as used: unknown model falls back, the budget is always set and capped. */
function normalize(s = {}) {
  const budget = Number(s?.maxBudgetUsd);
  return {
    enabled: s?.enabled === true,
    model: MODELS.includes(s?.model) ? s.model : DEFAULTS.model,
    maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? Math.min(budget, MAX_BUDGET) : DEFAULT_BUDGET,
  };
}

function buildArgs({ model, maxBudgetUsd }) {
  const s = normalize({ model, maxBudgetUsd });
  return ['-p', '--output-format', 'text', '--no-session-persistence',
    '--setting-sources', '', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands',
    '--tools', '', '--permission-mode', 'dontAsk',
    '--model', s.model, '--max-budget-usd', String(s.maxBudgetUsd)];
}

/**
 * → {ok:true, text} | {ok:false, reason: 'off'|'not-entitled'|'no-cli'|'empty'|'failed'}.
 * Never throws. The diff goes on stdin, never in argv.
 */
async function review({ diff, settings, entitled, bin = findClaudeBin(), env = process.env, spawn = childProcess.spawn, timeoutMs = TIMEOUT_MS }) {
  const s = normalize(settings);
  if (!s.enabled) return { ok: false, reason: 'off' };
  if (!entitled) return { ok: false, reason: 'not-entitled' };
  if (!bin) return { ok: false, reason: 'no-cli' };
  if (typeof diff !== 'string' || !diff.trim()) return { ok: false, reason: 'empty' };
  const body = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated]\n` : diff;
  const childEnv = { ...Object.fromEntries(ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-review-')); } catch { return { ok: false, reason: 'failed' }; }
  try {
    return await new Promise((resolve) => {
      let out = '', done = false, timer = null;
      const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      let child;
      try {
        child = spawn(bin, buildArgs(s), { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); // privacy-flow: diff-review
      } catch { return finish({ ok: false, reason: 'failed' }); }
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, reason: 'failed' }); }, timeoutMs);
      child.on('error', () => finish({ ok: false, reason: 'failed' }));
      child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d; });
      child.on('close', (code) => finish(code === 0 && out.trim() ? { ok: true, text: out.slice(0, MAX_OUT).trim() } : { ok: false, reason: 'failed' }));
      child.stdin.on('error', () => {});
      child.stdin.end(PROMPT + body);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { review, normalize, buildArgs, DEFAULTS, MODELS, MAX_BUDGET };
